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
//! sent back over a one-shot channel. Tauri runs the closure inline when the
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

use iptv_core::player::{Bounds, ChildWindowFactory};
use iptv_core::{CoreError, CoreResult};
use std::sync::mpsc::sync_channel;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, IsWindow, LoadCursorW, RegisterClassExW,
    SetWindowPos, CS_HREDRAW, CS_VREDRAW, HTTRANSPARENT, HWND_TOP, IDC_ARROW, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, WM_NCHITTEST, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
};

/// Label of the window mpv is embedded in (tauri.conf.json).
const MAIN_WINDOW: &str = "main";

/// Window class shared by every mpv host window.
const CLASS_NAME: PCWSTR = w!("TsrustIptvMpvHost");

/// How long a caller waits for the main thread before giving up.
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);

/// Class registration result, computed once per process.
static CLASS: OnceLock<Result<(), String>> = OnceLock::new();

/// Creates, moves, and destroys mpv's child window inside the main window.
pub struct MpvWindowFactory {
    app: AppHandle,
}

impl MpvWindowFactory {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    /// Runs `f` on the main thread with the main window's HWND and scale
    /// factor, and returns its result.
    fn on_main<T, F>(&self, what: &'static str, f: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(HWND, f64) -> CoreResult<T> + Send + 'static,
    {
        let (tx, rx) = sync_channel::<CoreResult<T>>(1);
        let app = self.app.clone();
        self.app
            .run_on_main_thread(move || {
                let result = main_window(&app).and_then(|(parent, scale)| f(parent, scale));
                let _ = tx.send(result);
            })
            .map_err(|e| other(format!("{what}: main thread unavailable: {e}")))?;
        rx.recv_timeout(MAIN_THREAD_TIMEOUT).map_err(|_| {
            CoreError::Timeout(format!("{what}: the main window did not respond in time"))
        })?
    }
}

impl ChildWindowFactory for MpvWindowFactory {
    fn create(&self, bounds: Bounds) -> CoreResult<isize> {
        self.on_main("create mpv window", move |parent, scale| {
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
            .map_err(|e| win_err("SetWindowPos", e))?;
            Ok(hwnd.0 as isize)
        })
    }

    fn set_bounds(&self, hwnd: isize, bounds: Bounds) -> CoreResult<()> {
        self.on_main("move mpv window", move |_parent, scale| {
            let hwnd = HWND(hwnd as *mut core::ffi::c_void);
            // SAFETY: IsWindow accepts any value.
            if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                return Err(CoreError::NotFound(
                    "the mpv window no longer exists".into(),
                ));
            }
            let (x, y, w, h) = scaled(bounds, scale);
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
        })
    }

    fn destroy(&self, hwnd: isize) -> CoreResult<()> {
        self.on_main("destroy mpv window", move |_parent, _scale| {
            let hwnd = HWND(hwnd as *mut core::ffi::c_void);
            // SAFETY: IsWindow accepts any value; DestroyWindow runs on the
            // owning thread. Already-gone windows are not an error.
            unsafe {
                if !IsWindow(Some(hwnd)).as_bool() {
                    return Ok(());
                }
                DestroyWindow(hwnd).map_err(|e| win_err("DestroyWindow", e))
            }
        })
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
                    style: CS_HREDRAW | CS_VREDRAW,
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

/// Paints black (class brush) and lets mouse hit-testing fall through our
/// host window; mpv's own video window inside it handles its area.
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    // SAFETY: forwarding the unmodified message to the default procedure.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn win_err(call: &str, e: windows::core::Error) -> CoreError {
    other(format!("{call} failed: {e}"))
}

/// iptv-tauri has no `anyhow` dependency, so window failures surface as
/// `CoreError::Io`.
fn other(msg: String) -> CoreError {
    CoreError::Io(std::io::Error::other(msg))
}
