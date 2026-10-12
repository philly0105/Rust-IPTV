//! Picture-in-picture behaviour the webview cannot provide (Windows).
//!
//! While PiP is on, the main window is subclassed so that:
//! - `WM_SIZING` keeps the frame at the aspect ratio it had when PiP started,
//!   whichever edge or corner is dragged;
//! - `WM_SIZE` resizes the mpv host window to the new client area at once.
//!   Without this the video waits for the webview to re-measure and send
//!   `mpv.setBounds`, and visibly trails the frame while it is dragged.
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
    FindWindowExW, GetWindowRect, SetWindowPos, SIZE_MINIMIZED, SWP_NOACTIVATE, SWP_NOZORDER,
    WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    WM_NCDESTROY, WM_SIZE, WM_SIZING,
};

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

/// Locks the main window's aspect ratio and makes the video follow resizes
/// natively, or undoes both.
pub fn set(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
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
                    if GetWindowRect(hwnd, &mut r).is_ok() && r.bottom > r.top {
                        let aspect = f64::from(r.right - r.left) / f64::from(r.bottom - r.top);
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
}
