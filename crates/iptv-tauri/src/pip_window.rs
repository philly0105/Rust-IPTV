//! Picture-in-picture behaviour the webview cannot provide (Windows).
//!
//! While PiP is on, the main window is subclassed so that:
//! - `WM_SIZING` keeps the frame at the video's aspect ratio (passed in by
//!   the player; else the ratio the window had when PiP started), whichever
//!   edge or corner is dragged;
//! - `WM_SIZE` resizes the mpv host window to the new client area at once.
//!   Without this the video waits for the webview to re-measure and send
//!   `mpv.setBounds`, and visibly trails the frame while it is dragged.
//! - any other size change (Aero Snap half-tiling, a DPI change, a resize
//!   from code) keeps the ratio too (`WM_WINDOWPOSCHANGING`), and the window
//!   cannot be maximized (Win+Up, snapping to the top edge): PiP stays a
//!   small floating window.
//!
//! Turning PiP on twice is harmless (`SetWindowSubclass` with the same proc
//! and id only updates the reference data) and so is turning it off twice
//! (`RemoveWindowSubclass` then reports failure, which is ignored). If the
//! window is destroyed while PiP is on, the subclass removes itself on
//! `WM_NCDESTROY`, as comctl32 requires.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetWindowRect, IsIconic, IsZoomed, PostMessageW, SetWindowPos, SC_MAXIMIZE,
    SC_RESTORE, SIZE_MAXIMIZED, SIZE_MINIMIZED, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    WINDOWPOS, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT,
    WMSZ_TOPRIGHT, WM_NCDESTROY, WM_SIZE, WM_SIZING, WM_SYSCOMMAND, WM_WINDOWPOSCHANGING,
};

use crate::geometry;
use crate::mpv_window::CLASS_NAME;

const SUBCLASS_ID: usize = 0x7069_7077; // "pipw"

/// Width / height locked while PiP is on (f64 bits).
static ASPECT: AtomicU64 = AtomicU64::new(0);

/// Whether the subclass is installed (PiP on).
static ON: AtomicBool = AtomicBool::new(false);

/// True while PiP is on: the video fills the client area and dragging it
/// moves the window (`mpv_window`).
pub fn is_on() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Narrowest and widest aspect ratio PiP locks to; anything outside is a bad
/// measurement (a 1 px tall video before the first frame) and is ignored.
const MIN_ASPECT: f64 = 0.25;
const MAX_ASPECT: f64 = 4.0;

/// The ratio to lock: the video's when the player knows it, else the
/// window's own (which the player already sized to the video, or 16:9).
fn lock_aspect(video: Option<f64>, window: Option<(i32, i32)>) -> Option<f64> {
    let valid = |a: f64| a.is_finite() && (MIN_ASPECT..=MAX_ASPECT).contains(&a);
    video.filter(|a| valid(*a)).or_else(|| {
        window
            .filter(|(_, h)| *h > 0)
            .map(|(w, h)| f64::from(w) / f64::from(h))
            .filter(|a| valid(*a))
    })
}

/// Re-locks the ratio while PiP is on (the video changed shape, a zap from
/// 16:9 to 4:3). The webview resizes the window to it next, and
/// `WM_WINDOWPOSCHANGING` keeps the new ratio from then on. False when PiP is
/// off or `aspect` is out of range.
pub fn set_aspect(aspect: f64) -> bool {
    if !is_on() || lock_aspect(Some(aspect), None).is_none() {
        return false;
    }
    ASPECT.store(aspect.to_bits(), Ordering::Relaxed);
    true
}

/// Locks the main window's aspect ratio (the video's, `aspect` = width /
/// height, when given) and makes the video follow resizes natively, or undoes
/// both.
pub fn set(window: tauri::WebviewWindow, on: bool, aspect: Option<f64>) -> Result<(), String> {
    let raw = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd = raw.0 as isize;
    // Subclassing only works on the thread that owns the window.
    window
        .run_on_main_thread(move || {
            let hwnd = HWND(hwnd as *mut core::ffi::c_void);
            // SAFETY: on the owning thread; `subclass_proc` matches SUBCLASSPROC
            // and stays valid for the life of the process.
            unsafe {
                if on {
                    let mut r = RECT::default();
                    let rect = GetWindowRect(hwnd, &mut r)
                        .is_ok()
                        .then(|| (r.right - r.left, r.bottom - r.top));
                    if let Some(aspect) = lock_aspect(aspect, rect) {
                        ASPECT.store(aspect.to_bits(), Ordering::Relaxed);
                    }
                    let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
                } else {
                    let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                }
                ON.store(on, Ordering::Relaxed);
            }
        })
        .map_err(|e| e.to_string())
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_SIZING => {
            let aspect = f64::from_bits(ASPECT.load(Ordering::Relaxed));
            if aspect.is_finite() && aspect > 0.0 {
                // SAFETY: for WM_SIZING, lparam points at the drag RECT.
                let r = unsafe { &mut *(lparam.0 as *mut RECT) };
                fit(r, wparam.0 as u32, aspect);
                return LRESULT(1);
            }
        }
        WM_SIZE => {
            // SAFETY: plain message forwarding and window calls on our thread.
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            let w = (lparam.0 & 0xffff) as i32;
            let h = ((lparam.0 >> 16) & 0xffff) as i32;
            if wparam.0 as u32 == SIZE_MAXIMIZED {
                // Maximized by a path that skips WM_SYSCOMMAND (dragging to
                // the top edge): put the small window back.
                // SAFETY: posting to our own window.
                let _ = unsafe {
                    PostMessageW(
                        Some(hwnd),
                        WM_SYSCOMMAND,
                        WPARAM(SC_RESTORE as usize),
                        LPARAM(0),
                    )
                };
                return result;
            }
            // Minimizing reports a 0x0 client area; leave the video alone and
            // let the restore's WM_SIZE size it again.
            if wparam.0 as u32 != SIZE_MINIMIZED && w > 0 && h > 0 {
                // In PiP the video fills the whole client area.
                if let Ok(host) = unsafe { FindWindowExW(Some(hwnd), None, CLASS_NAME, None) } {
                    let _ = unsafe {
                        SetWindowPos(host, None, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE)
                    };
                }
            }
            return result;
        }
        WM_WINDOWPOSCHANGING => {
            // Let the default handling apply the minimum size first.
            // SAFETY: plain message forwarding on our thread.
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            let aspect = f64::from_bits(ASPECT.load(Ordering::Relaxed));
            // SAFETY: for WM_WINDOWPOSCHANGING, lparam points at a WINDOWPOS
            // the sender reads back after we return.
            let pos = unsafe { &mut *(lparam.0 as *mut WINDOWPOS) };
            // SAFETY: IsIconic/IsZoomed accept any window handle.
            let normal = unsafe { !IsIconic(hwnd).as_bool() && !IsZoomed(hwnd).as_bool() };
            if normal && !pos.flags.contains(SWP_NOSIZE) {
                let (cx, cy) = geometry::enforce_aspect(pos.cx, pos.cy, aspect);
                pos.cx = cx;
                pos.cy = cy;
            }
            return result;
        }
        WM_SYSCOMMAND if (wparam.0 & 0xfff0) as u32 == SC_MAXIMIZE => return LRESULT(0),
        WM_NCDESTROY => {
            // SAFETY: a subclass must be removed before the window is gone;
            // this is the last message the window receives.
            ON.store(false, Ordering::Relaxed);
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
        }
        _ => {}
    }
    // SAFETY: forwards to the next window procedure in the chain.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Reshapes the drag rectangle to `aspect`, keeping the edges the user is not
/// dragging in place. Side edges adjust the other dimension; corners follow
/// whichever dimension grew more.
fn fit(r: &mut RECT, edge: u32, aspect: f64) {
    let w = f64::from(r.right - r.left);
    let h = f64::from(r.bottom - r.top);
    match edge {
        WMSZ_LEFT | WMSZ_RIGHT => r.bottom = r.top + (w / aspect).round() as i32,
        WMSZ_TOP | WMSZ_BOTTOM => r.right = r.left + (h * aspect).round() as i32,
        _ => {
            let (nw, nh) = if h * aspect > w {
                (h * aspect, h)
            } else {
                (w, w / aspect)
            };
            let (nw, nh) = (nw.round() as i32, nh.round() as i32);
            if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
                r.left = r.right - nw;
            } else {
                r.right = r.left + nw;
            }
            if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
                r.top = r.bottom - nh;
            } else {
                r.bottom = r.top + nh;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::WMSZ_BOTTOMRIGHT;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT {
            left: l,
            top: t,
            right: r,
            bottom: b,
        }
    }

    #[test]
    fn set_aspect_relocks_only_while_pip_is_on_and_in_range() {
        // The only test touching ON/ASPECT, so the statics are not shared with another test.
        ON.store(false, Ordering::Relaxed);
        ASPECT.store((16.0f64 / 9.0).to_bits(), Ordering::Relaxed);
        assert!(!set_aspect(4.0 / 3.0));
        assert_eq!(f64::from_bits(ASPECT.load(Ordering::Relaxed)), 16.0 / 9.0);

        ON.store(true, Ordering::Relaxed);
        assert!(set_aspect(4.0 / 3.0));
        assert_eq!(f64::from_bits(ASPECT.load(Ordering::Relaxed)), 4.0 / 3.0);
        for bad in [0.0, -1.0, 10.0, f64::NAN, f64::INFINITY] {
            assert!(!set_aspect(bad));
        }
        assert_eq!(f64::from_bits(ASPECT.load(Ordering::Relaxed)), 4.0 / 3.0);
        ON.store(false, Ordering::Relaxed);
    }

    #[test]
    fn sides_keep_the_ratio_and_anchor_the_top_left() {
        let mut r = rect(100, 100, 740, 370); // dragged right to 640 wide
        fit(&mut r, WMSZ_RIGHT, 16.0 / 9.0);
        assert_eq!((r.left, r.top, r.right, r.bottom), (100, 100, 740, 460));

        let mut r = rect(100, 100, 580, 460); // dragged down to 360 tall
        fit(&mut r, WMSZ_BOTTOM, 16.0 / 9.0);
        assert_eq!((r.left, r.top, r.right, r.bottom), (100, 100, 740, 460));
    }

    #[test]
    fn corners_follow_the_larger_change_and_anchor_the_opposite_corner() {
        // Top-left dragged mostly up: height wins, bottom-right stays.
        let mut r = rect(80, 0, 580, 370);
        fit(&mut r, WMSZ_TOPLEFT, 16.0 / 9.0);
        assert_eq!((r.right, r.bottom), (580, 370));
        assert_eq!((r.right - r.left, r.bottom - r.top), (658, 370));

        // Bottom-right dragged mostly sideways: width wins.
        let mut r = rect(0, 0, 800, 280);
        fit(&mut r, WMSZ_BOTTOMRIGHT, 16.0 / 9.0);
        assert_eq!((r.left, r.top, r.right, r.bottom), (0, 0, 800, 450));
    }

    #[test]
    fn the_video_aspect_wins_over_the_window_and_bad_values_fall_back() {
        let four_three = 4.0 / 3.0;
        assert_eq!(
            lock_aspect(Some(four_three), Some((480, 270))),
            Some(four_three)
        );
        assert_eq!(lock_aspect(None, Some((480, 270))), Some(480.0 / 270.0));
        for bad in [f64::NAN, f64::INFINITY, 0.0, -1.0, 0.1, 12.0] {
            assert_eq!(
                lock_aspect(Some(bad), Some((480, 270))),
                Some(480.0 / 270.0),
                "{bad}"
            );
        }
        assert_eq!(lock_aspect(None, Some((480, 0))), None);
        assert_eq!(lock_aspect(None, None), None);
        assert_eq!(lock_aspect(Some(9.0 / 16.0), None), Some(9.0 / 16.0));
    }

    #[test]
    fn a_portrait_lock_reshapes_side_drags() {
        let mut r = rect(0, 0, 270, 100);
        fit(&mut r, WMSZ_RIGHT, 9.0 / 16.0);
        assert_eq!((r.right, r.bottom), (270, 480));
    }
}
