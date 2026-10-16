//! Native child window that embedded mpv renders into (Windows).
//!
//! [`MpvWindowFactory`] implements `iptv_core::player::ChildWindowFactory`:
//! it creates a black `WS_CHILD` window inside the main Tauri window, and
//! `iptv-core` starts `mpv.exe --wid=<that hwnd>`. mpv then creates its own
//! video window inside ours, so moving or destroying ours moves or removes
//! the video.
//!
//! Threading: a window belongs to the thread that created it, and only that
//! thread may destroy it, so every Win32 call is marshalled to the main
//! (event loop) thread with `AppHandle::run_on_main_thread` and the result is
//! handed back through a [`Handoff`]. A caller that stops waiting (the main
//! thread was busy past the timeout) marks the hand-off abandoned, and a late
//! result is cleaned up on the main thread instead: a window created after
//! the caller gave up is destroyed, not leaked. Tauri runs the closure inline when the
//! caller already is the main thread, so this never deadlocks. Callers in
//! `iptv-core` invoke the factory from `spawn_blocking`, never from an async
//! worker.
//!
//! Coordinates arrive in CSS pixels relative to the webview (which fills the
//! main window's client area) and are multiplied by the window's scale factor.
//!
//! Registration (integration agent, `lib.rs` setup):
//! `iptv_core::player::set_window_factory(&state, Arc::new(mpv_window::MpvWindowFactory::new(handle.clone())));`
#![cfg(windows)]

use crate::geometry;
use iptv_core::player::{Bounds, ChildWindowFactory};
use iptv_core::{AppEvent, CoreError, CoreResult};
use parking_lot::{Condvar, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, GetMonitorInfoW, GetStockObject,
    MonitorFromPoint, MonitorFromWindow, ScreenToClient, SetWindowRgn, BLACK_BRUSH, HBRUSH,
    HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST, RGN_DIFF,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{DragDetect, ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetAncestor, GetClientRect, GetCursorPos,
    GetWindow, GetWindowRect, IsWindow, KillTimer, LoadCursorW, RegisterClassExW, SetCursor,
    SetTimer, SetWindowPos, WindowFromPoint, CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, GA_ROOT, GW_CHILD,
    HTCLIENT, HWND_TOP, IDC_ARROW, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, WM_CAPTURECHANGED, WM_DESTROY, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WM_SIZE, WM_TIMER,
    WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
};

/// `MK_LBUTTON` in a mouse message's `wparam`: the left button is down.
const MK_LBUTTON: usize = 0x0001;

/// Label of the window mpv is embedded in (tauri.conf.json).
const MAIN_WINDOW: &str = "main";

/// Window class shared by every mpv host window.
pub(crate) const CLASS_NAME: PCWSTR = w!("TsrustIptvMpvHost");

/// How long a caller waits for the main thread before giving up.
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);

/// Class registration result, computed once per process.
static CLASS: OnceLock<Result<(), String>> = OnceLock::new();

/// App handle for the window procedure, which turns clicks into app events.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Creates, moves, and destroys mpv's child window inside the main window.
pub struct MpvWindowFactory {
    app: AppHandle,
}

impl MpvWindowFactory {
    pub fn new(app: tauri::AppHandle) -> Self {
        let _ = APP.set(app.clone());
        Self { app }
    }

    /// Runs `f` on the main thread with the main window's HWND and scale
    /// factor, and returns its result. When the caller already gave up
    /// waiting, a late success goes to `discard`, still on the main thread.
    fn on_main<T, F, D>(&self, what: &'static str, f: F, discard: D) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(HWND, f64) -> CoreResult<T> + Send + 'static,
        D: FnOnce(T) + Send + 'static,
    {
        let handoff = Handoff::new();
        let late = Arc::clone(&handoff);
        let app = self.app.clone();
        self.app
            .run_on_main_thread(move || {
                let result = main_window(&app).and_then(|(parent, scale)| f(parent, scale));
                if let Some(Ok(value)) = late.deliver(result) {
                    discard(value);
                }
            })
            .map_err(|e| other(format!("{what}: main thread unavailable: {e}")))?;
        handoff.wait(MAIN_THREAD_TIMEOUT).unwrap_or_else(|| {
            Err(CoreError::Timeout(format!(
                "{what}: the main window did not respond in time"
            )))
        })
    }
}

impl ChildWindowFactory for MpvWindowFactory {
    fn create(&self, bounds: Bounds) -> CoreResult<isize> {
        self.on_main(
            "create mpv window",
            move |parent, scale| {
                register_class()?;
                let (x, y, w, h) = scaled(bounds, scale);
                // SAFETY: called on the thread that owns `parent`; the class was
                // registered above; all pointers are valid for the call.
                let hwnd = unsafe {
                    let instance: HINSTANCE =
                        GetModuleHandleW(None).map(Into::into).unwrap_or_default();
                    CreateWindowExW(
                        WS_EX_NOPARENTNOTIFY,
                        CLASS_NAME,
                        w!("Tsrust IPTV video"),
                        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                        x,
                        y,
                        w,
                        h,
                        Some(parent),
                        None,
                        Some(instance),
                        None,
                    )
                }
                .map_err(|e| win_err("CreateWindowExW", e))?;
                // Above the webview, without stealing focus from it.
                // SAFETY: `hwnd` was just created on this thread.
                let placed = unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_TOP),
                        x,
                        y,
                        w,
                        h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    )
                };
                if let Err(e) = placed {
                    destroy_child(hwnd.0 as isize);
                    return Err(win_err("SetWindowPos", e));
                }
                Ok(hwnd.0 as isize)
            },
            destroy_child,
        )
    }

    fn set_bounds(&self, hwnd: isize, bounds: Bounds) -> CoreResult<()> {
        self.on_main(
            "move mpv window",
            move |parent, scale| {
                let hwnd = HWND(hwnd as *mut core::ffi::c_void);
                // SAFETY: IsWindow accepts any value.
                if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                    return Err(CoreError::NotFound(
                        "the mpv window no longer exists".into(),
                    ));
                }
                let on_screen = bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
                let (x, y, w, h) = if on_screen && crate::pip_window::is_on() {
                    // PiP sizes the video natively on every WM_SIZE; a measurement
                    // the webview took a frame ago would make it jump back.
                    let mut r = RECT::default();
                    // SAFETY: `parent` is the live main window.
                    let _ = unsafe { GetClientRect(parent, &mut r) };
                    (0, 0, r.right.max(1), r.bottom.max(1))
                } else {
                    scaled(bounds, scale)
                };
                // SAFETY: `hwnd` is a live window owned by this (main) thread.
                unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_TOP),
                        x,
                        y,
                        w,
                        h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    )
                }
                .map_err(|e| win_err("SetWindowPos", e))
            },
            |()| (),
        )
    }

    fn set_holes(&self, hwnd: isize, holes: Vec<Bounds>) -> CoreResult<()> {
        self.on_main(
            "cut mpv window",
            move |_parent, scale| {
                let hwnd = HWND(hwnd as *mut core::ffi::c_void);
                // SAFETY: IsWindow accepts any value.
                if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                    return Err(CoreError::NotFound(
                        "the mpv window no longer exists".into(),
                    ));
                }
                if holes.is_empty() {
                    // SAFETY: a null region restores the full window.
                    unsafe { SetWindowRgn(hwnd, None, true) };
                    return Ok(());
                }
                // SAFETY: regions are created and combined here; SetWindowRgn takes
                // ownership of `region` on success, so only the hole regions and a
                // region the system rejected are deleted.
                unsafe {
                    let region = CreateRectRgn(0, 0, 1 << 15, 1 << 15);
                    for hole in holes {
                        let (x, y, w, h) = scaled(hole, scale);
                        let cut = CreateRectRgn(x, y, x + w, y + h);
                        CombineRgn(Some(region), Some(region), Some(cut), RGN_DIFF);
                        let _ = DeleteObject(HGDIOBJ(cut.0));
                    }
                    if SetWindowRgn(hwnd, Some(region), true) == 0 {
                        let _ = DeleteObject(HGDIOBJ(region.0));
                        return Err(other("SetWindowRgn failed".to_string()));
                    }
                }
                Ok(())
            },
            |()| (),
        )
    }

    fn destroy(&self, hwnd: isize) -> CoreResult<()> {
        self.on_main(
            "destroy mpv window",
            move |_parent, _scale| {
                let hwnd = HWND(hwnd as *mut core::ffi::c_void);
                // SAFETY: IsWindow accepts any value; DestroyWindow runs on the
                // owning thread. Already-gone windows are not an error.
                unsafe {
                    if !IsWindow(Some(hwnd)).as_bool() {
                        return Ok(());
                    }
                    DestroyWindow(hwnd).map_err(|e| win_err("DestroyWindow", e))
                }
            },
            |()| (),
        )
    }
}

/// Destroys a child window this thread created, if it still exists (main
/// thread). Used for windows nobody will own: created after the caller
/// timed out, or half set up.
fn destroy_child(hwnd: isize) {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: IsWindow accepts any value; DestroyWindow runs on the thread
    // that created the window.
    unsafe {
        if IsWindow(Some(hwnd)).as_bool() {
            if let Err(e) = DestroyWindow(hwnd) {
                tracing::warn!(error = %e, "could not destroy an abandoned mpv window");
            }
        }
    }
}

/// One result passed from the main thread to a caller that waits a bounded
/// time. Once the caller gives up, [`Handoff::deliver`] hands the result back
/// so the main thread can undo it; the check and the store happen under one
/// lock, so a result is never both kept and lost.
struct Handoff<T> {
    slot: Mutex<HandoffSlot<T>>,
    ready: Condvar,
}

struct HandoffSlot<T> {
    value: Option<T>,
    abandoned: bool,
}

impl<T> Handoff<T> {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            slot: Mutex::new(HandoffSlot {
                value: None,
                abandoned: false,
            }),
            ready: Condvar::new(),
        })
    }

    /// Main thread: hands `value` to the waiter. Returns it back when the
    /// waiter already gave up, for the caller to clean up.
    fn deliver(&self, value: T) -> Option<T> {
        let mut slot = self.slot.lock();
        if slot.abandoned {
            return Some(value);
        }
        slot.value = Some(value);
        self.ready.notify_one();
        None
    }

    /// Waits up to `timeout` for the value. `None` means it did not arrive,
    /// and any later delivery is handed back to its sender.
    fn wait(&self, timeout: Duration) -> Option<T> {
        let mut slot = self.slot.lock();
        if slot.value.is_none() {
            let _ = self
                .ready
                .wait_while_for(&mut slot, |s| s.value.is_none(), timeout);
        }
        let value = slot.value.take();
        if value.is_none() {
            slot.abandoned = true;
        }
        value
    }
}

/// The main window's HWND and scale factor (main thread).
fn main_window(app: &AppHandle) -> CoreResult<(HWND, f64)> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| CoreError::NotFound("the main window is not open".into()))?;
    let raw = window
        .hwnd()
        .map_err(|e| other(format!("main window handle unavailable: {e}")))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    // Rebuild from the raw pointer so a different `windows` version inside
    // tauri can never cause a type mismatch.
    Ok((HWND(raw.0), scale))
}

/// CSS px -> physical px, with a 1x1 minimum so the window stays valid.
fn scaled(b: Bounds, scale: f64) -> (i32, i32, i32, i32) {
    let px = |v: i32| (f64::from(v) * scale).round() as i32;
    (px(b.x), px(b.y), px(b.width).max(1), px(b.height).max(1))
}

fn register_class() -> CoreResult<()> {
    CLASS
        .get_or_init(|| {
            // SAFETY: plain Win32 class registration with static strings and
            // a stock brush; runs once on the main thread.
            unsafe {
                let instance: HINSTANCE =
                    GetModuleHandleW(None).map(Into::into).unwrap_or_default();
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: instance,
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                    lpszClassName: CLASS_NAME,
                    ..Default::default()
                };
                if RegisterClassExW(&class) == 0 {
                    let err = GetLastError();
                    if err != ERROR_CLASS_ALREADY_EXISTS {
                        return Err(format!("RegisterClassExW failed: {err:?}"));
                    }
                }
            }
            Ok(())
        })
        .clone()
        .map_err(other)
}

/// Timer that hides the cursor over the video after it has rested.
const CURSOR_TIMER: usize = 0x6375; // "cu"

/// How long the cursor must rest over fullscreen video before it hides; the
/// same delay as the player chrome (`HIDE_AFTER_MS` in PlayerSurface.tsx).
const CURSOR_IDLE_MS: u32 = 2600;

/// How close (logical px) a dragged PiP window must come to a work-area edge
/// to dock against it.
const SNAP_DISTANCE: i32 = 16;

/// The cursor is hidden over the video (fullscreen, resting).
static CURSOR_HIDDEN: AtomicBool = AtomicBool::new(false);

/// Last cursor position seen over the video (screen px), to ignore the
/// synthetic `WM_MOUSEMOVE`s Windows sends when nothing moved.
static LAST_CURSOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);

/// A PiP drag in progress.
#[derive(Clone, Copy)]
struct Drag {
    /// The main window being moved.
    root: isize,
    /// Its top-left corner when the drag started (screen px).
    window: (i32, i32),
    /// The cursor when the drag started (screen px).
    cursor: (i32, i32),
}

static DRAG: Mutex<Option<Drag>> = Mutex::new(None);

/// Client coordinates packed in a mouse message's `lparam` (signed: they are
/// negative left of or above the window).
fn lparam_point(lparam: LPARAM) -> POINT {
    POINT {
        x: i32::from(lparam.0 as u16 as i16),
        y: i32::from((lparam.0 >> 16) as u16 as i16),
    }
}

/// Paints black (class brush), keeps mpv's video window filling ours, and
/// handles the mouse over the video:
/// - a click is `mpv.click`, a double click `mpv.dblclick` (app events);
/// - the wheel is `mpv.wheel` `{ delta }` in notches, up positive (volume);
/// - a right click is `mpv.contextmenu` `{ x, y }` in CSS px relative to the
///   webview, where the player opens its video menu;
/// - in PiP, a press that turns into a drag moves the (frameless) main
///   window instead, docking against work-area edges and never leaving the
///   monitor the cursor is on. This is our own drag rather than the system
///   caption drag, which would let Aero Snap maximize or half-tile the PiP
///   window;
/// - in fullscreen the cursor hides after resting over the video, like the
///   player chrome does, and comes back on the next move or click.
///
/// mpv disables its own embedded window, so the mouse lands here.
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_LBUTTONDOWN => {
            show_cursor(hwnd);
            if crate::pip_window::is_on() {
                let mut pt = lparam_point(lparam);
                // SAFETY: plain window calls on the thread that owns `hwnd`.
                unsafe {
                    let _ = ClientToScreen(hwnd, &mut pt);
                    if DragDetect(hwnd, pt).as_bool() {
                        begin_drag(hwnd, pt);
                        return LRESULT(0);
                    }
                }
            }
            emit("mpv.click");
            return LRESULT(0);
        }
        WM_LBUTTONDBLCLK => {
            show_cursor(hwnd);
            emit("mpv.dblclick");
            return LRESULT(0);
        }
        WM_MOUSEWHEEL => {
            show_cursor(hwnd);
            if let Some(delta) = wheel_notches(wparam) {
                emit_with("mpv.wheel", serde_json::json!({ "delta": delta }));
            }
            return LRESULT(0);
        }
        // Swallowed so the release alone opens the menu, as in other players.
        WM_RBUTTONDOWN => {
            show_cursor(hwnd);
            return LRESULT(0);
        }
        WM_RBUTTONUP => {
            show_cursor(hwnd);
            if let Some((x, y)) = webview_point(hwnd, lparam_point(lparam)) {
                emit_with("mpv.contextmenu", serde_json::json!({ "x": x, "y": y }));
            }
            // Not forwarded: DefWindowProc would follow with WM_CONTEXTMENU.
            return LRESULT(0);
        }
        WM_MOUSEMOVE => {
            if DRAG.lock().is_some() {
                // The button can come up between DragDetect and SetCapture;
                // never move the window without it held.
                if wparam.0 & MK_LBUTTON == 0 {
                    end_drag();
                } else {
                    drag_to_cursor();
                }
                return LRESULT(0);
            }
            cursor_moved(hwnd);
        }
        WM_LBUTTONUP => {
            if DRAG.lock().is_some() {
                end_drag();
                return LRESULT(0);
            }
        }
        WM_CAPTURECHANGED => {
            *DRAG.lock() = None;
        }
        WM_TIMER if wparam.0 == CURSOR_TIMER => {
            // SAFETY: our own timer on our own window.
            unsafe {
                let _ = KillTimer(Some(hwnd), CURSOR_TIMER);
            }
            if should_hide_cursor(hwnd) {
                CURSOR_HIDDEN.store(true, Ordering::Relaxed);
                // SAFETY: SetCursor(None) only hides the cursor.
                unsafe {
                    SetCursor(None);
                }
            }
            return LRESULT(0);
        }
        WM_SETCURSOR
            if CURSOR_HIDDEN.load(Ordering::Relaxed) && (lparam.0 & 0xffff) as u32 == HTCLIENT =>
        {
            // SAFETY: SetCursor(None) only hides the cursor.
            unsafe {
                SetCursor(None);
            }
            return LRESULT(1);
        }
        WM_DESTROY => {
            // SAFETY: our own timer on our own window.
            unsafe {
                let _ = KillTimer(Some(hwnd), CURSOR_TIMER);
            }
            CURSOR_HIDDEN.store(false, Ordering::Relaxed);
            *LAST_CURSOR.lock() = None;
            *DRAG.lock() = None;
        }
        WM_SIZE => {
            let w = (lparam.0 & 0xffff) as i32;
            let h = ((lparam.0 >> 16) & 0xffff) as i32;
            // mpv only notices a parent resize later; resize its window now so
            // the video tracks the frame. Async: it belongs to mpv's process.
            // SAFETY: GetWindow/SetWindowPos accept any window handle; the
            // timer is our own.
            unsafe {
                // Entering fullscreen resizes us without moving the mouse:
                // let a resting cursor hide anyway.
                SetTimer(Some(hwnd), CURSOR_TIMER, CURSOR_IDLE_MS, None);
                if let Ok(video) = GetWindow(hwnd, GW_CHILD) {
                    let _ = SetWindowPos(
                        video,
                        None,
                        0,
                        0,
                        w.max(1),
                        h.max(1),
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                    );
                }
            }
        }
        _ => {}
    }
    // SAFETY: forwarding the unmodified message to the default procedure.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Starts moving the main window with the mouse (PiP). `pt` is the press
/// position in screen px.
fn begin_drag(hwnd: HWND, pt: POINT) {
    // SAFETY: plain window calls on the thread that owns `hwnd`.
    unsafe {
        let root = GetAncestor(hwnd, GA_ROOT);
        let mut r = RECT::default();
        if root.is_invalid() || GetWindowRect(root, &mut r).is_err() {
            return;
        }
        *DRAG.lock() = Some(Drag {
            root: root.0 as isize,
            window: (r.left, r.top),
            cursor: (pt.x, pt.y),
        });
        SetCapture(hwnd);
    }
    drag_to_cursor();
}

/// Moves the dragged window after the cursor, kept on the work area of the
/// monitor under the cursor and docked against edges it comes close to.
fn drag_to_cursor() {
    let Some(drag) = *DRAG.lock() else {
        return;
    };
    let root = HWND(drag.root as *mut core::ffi::c_void);
    // SAFETY: read-only queries plus a move of our own top-level window.
    unsafe {
        let mut cursor = POINT::default();
        let mut r = RECT::default();
        if GetCursorPos(&mut cursor).is_err() || GetWindowRect(root, &mut r).is_err() {
            return;
        }
        let (x, y) = geometry::drag_position(drag.window, drag.cursor, (cursor.x, cursor.y));
        let mut rect = geometry::Rect::new(x, y, r.right - r.left, r.bottom - r.top);
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let w = info.rcWork;
            let area = geometry::Rect::new(w.left, w.top, w.right - w.left, w.bottom - w.top);
            let dpi = GetDpiForWindow(root);
            let snap = SNAP_DISTANCE * if dpi > 0 { dpi as i32 } else { 96 } / 96;
            rect = geometry::clamp_into(geometry::snap_to_edges(rect, area, snap), area);
        }
        if (rect.x, rect.y) != (r.left, r.top) {
            let _ = SetWindowPos(
                root,
                None,
                rect.x,
                rect.y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

fn end_drag() {
    *DRAG.lock() = None;
    // SAFETY: releasing our own capture.
    unsafe {
        let _ = ReleaseCapture();
    }
}

/// The cursor moved over the video: show it and restart the rest timer.
fn cursor_moved(hwnd: HWND) {
    let mut p = POINT::default();
    // SAFETY: GetCursorPos writes into `p`.
    if unsafe { GetCursorPos(&mut p) }.is_err() {
        return;
    }
    {
        let mut last = LAST_CURSOR.lock();
        if *last == Some((p.x, p.y)) {
            return;
        }
        *last = Some((p.x, p.y));
    }
    show_cursor(hwnd);
}

/// Shows the cursor again and restarts the rest timer.
fn show_cursor(hwnd: HWND) {
    if CURSOR_HIDDEN.swap(false, Ordering::Relaxed) {
        // SAFETY: setting the class cursor back; arrow is a system cursor.
        unsafe {
            if let Ok(arrow) = LoadCursorW(None, IDC_ARROW) {
                SetCursor(Some(arrow));
            }
        }
    }
    // SAFETY: (re)arms our own timer on our own window.
    unsafe {
        SetTimer(Some(hwnd), CURSOR_TIMER, CURSOR_IDLE_MS, None);
    }
}

/// Hide only in fullscreen (the main window covers its monitor), only while
/// the cursor is over the video itself (not over chrome cut out of it), and
/// never mid-drag.
fn should_hide_cursor(hwnd: HWND) -> bool {
    if DRAG.lock().is_some() {
        return false;
    }
    // SAFETY: read-only window and monitor queries.
    unsafe {
        let mut p = POINT::default();
        if GetCursorPos(&mut p).is_err() || WindowFromPoint(p) != hwnd {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let mut r = RECT::default();
        if GetWindowRect(root, &mut r).is_err() {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(MonitorFromWindow(root, MONITOR_DEFAULTTONEAREST), &mut info).as_bool()
        {
            return false;
        }
        let m = info.rcMonitor;
        let window = geometry::Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top);
        let monitor = geometry::Rect::new(m.left, m.top, m.right - m.left, m.bottom - m.top);
        window.contains(&monitor)
    }
}

/// Sends a payload-less app event to the webview.
fn emit(kind: &str) {
    emit_with(kind, serde_json::json!({}));
}

/// Sends an app event with a payload to the webview.
fn emit_with(kind: &str, payload: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(crate::APP_EVENT, AppEvent::new(kind, payload));
    }
}

/// One wheel notch (`WHEEL_DELTA`).
const WHEEL_DELTA: f64 = 120.0;

/// Wheel turn in a `WM_MOUSEWHEEL` `wparam`, in notches (positive = away from
/// the user, "up"). Precision wheels and touchpads send fractions of a notch.
/// `None` for a zero delta.
fn wheel_notches(wparam: WPARAM) -> Option<f64> {
    let raw = (wparam.0 >> 16) as u16 as i16;
    if raw == 0 {
        return None;
    }
    Some((f64::from(raw) / WHEEL_DELTA * 1000.0).round() / 1000.0)
}

/// Physical px in the main window's client area -> CSS px in the webview,
/// which fills that client area. `dpi` 0 (unknown) counts as 96 (100 %).
fn css_point(x: i32, y: i32, dpi: u32) -> (f64, f64) {
    let scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
    let round = |v: i32| (f64::from(v) / scale * 100.0).round() / 100.0;
    (round(x), round(y))
}

/// A point in the host window's client area (physical px), as CSS px relative
/// to the webview.
fn webview_point(hwnd: HWND, mut pt: POINT) -> Option<(f64, f64)> {
    // SAFETY: plain coordinate conversions on live windows of this thread.
    unsafe {
        let root = GetAncestor(hwnd, GA_ROOT);
        if root.is_invalid()
            || !ClientToScreen(hwnd, &mut pt).as_bool()
            || !ScreenToClient(root, &mut pt).as_bool()
        {
            return None;
        }
        Some(css_point(pt.x, pt.y, GetDpiForWindow(root)))
    }
}

fn win_err(call: &str, e: windows::core::Error) -> CoreError {
    other(format!("{call} failed: {e}"))
}

/// iptv-tauri has no `anyhow` dependency, so window failures surface as
/// `CoreError::Io`.
fn other(msg: String) -> CoreError {
    CoreError::Io(std::io::Error::other(msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_positions_left_of_or_above_the_window_stay_negative() {
        let pack = |x: i16, y: i16| LPARAM(((y as u16 as isize) << 16) | x as u16 as isize);
        let p = lparam_point(pack(120, 45));
        assert_eq!((p.x, p.y), (120, 45));
        let p = lparam_point(pack(-3, -40));
        assert_eq!((p.x, p.y), (-3, -40));
        let p = lparam_point(pack(i16::MAX, i16::MIN));
        assert_eq!((p.x, p.y), (32767, -32768));
    }

    #[test]
    fn css_bounds_scale_to_physical_pixels_with_a_minimum_size() {
        let b = Bounds {
            x: 10,
            y: 20,
            width: 0,
            height: 300,
        };
        assert_eq!(scaled(b, 1.5), (15, 30, 1, 450));
        assert_eq!(scaled(b, 1.0), (10, 20, 1, 300));
    }

    #[test]
    fn a_result_in_time_reaches_the_waiter() {
        let h = Handoff::new();
        let sender = Arc::clone(&h);
        let t = std::thread::spawn(move || sender.deliver(7));
        assert_eq!(h.wait(Duration::from_secs(5)), Some(7));
        assert_eq!(t.join().unwrap(), None, "nothing handed back");
    }

    #[test]
    fn a_result_after_the_timeout_goes_back_to_the_sender_for_cleanup() {
        let h = Handoff::<u32>::new();
        assert_eq!(h.wait(Duration::from_millis(10)), None);
        // The window created too late is returned, so the main thread destroys it.
        assert_eq!(h.deliver(42), Some(42));
        assert!(h.slot.lock().value.is_none(), "nothing is left behind");
    }

    #[test]
    fn a_result_stored_just_before_the_wait_is_not_lost() {
        let h = Handoff::new();
        assert_eq!(h.deliver(3), None);
        assert_eq!(h.wait(Duration::ZERO), Some(3));
    }

    #[test]
    fn wheel_turns_are_notches_with_up_positive() {
        let pack = |delta: i16, keys: u16| WPARAM(((delta as u16 as usize) << 16) | keys as usize);
        assert_eq!(wheel_notches(pack(120, 0)), Some(1.0));
        assert_eq!(wheel_notches(pack(-240, 0x0008)), Some(-2.0)); // Ctrl held: keys ignored
        assert_eq!(wheel_notches(pack(30, 0)), Some(0.25)); // precision wheel
        assert_eq!(wheel_notches(pack(i16::MIN, 0)), Some(-273.067));
        assert_eq!(wheel_notches(pack(0, 0x0001)), None);
    }

    #[test]
    fn context_menu_points_become_css_pixels() {
        assert_eq!(css_point(300, 150, 96), (300.0, 150.0));
        assert_eq!(css_point(300, 150, 144), (200.0, 100.0)); // 150 %
        assert_eq!(css_point(301, 151, 120), (240.8, 120.8)); // 125 %
        assert_eq!(css_point(-10, 5, 192), (-5.0, 2.5));
        assert_eq!(css_point(50, 50, 0), (50.0, 50.0)); // DPI unknown
    }
}
