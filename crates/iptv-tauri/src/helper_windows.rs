//! The app's hidden helper windows quit the app when closed (Windows).
//!
//! Closing the app from outside (`taskkill` without `/F`, an installer or
//! the Restart Manager) posts `WM_CLOSE` to the process's top-level windows,
//! and the main window is not the only one. The single-instance plugin's
//! `<identifier>-siw` and tao's event target are top-level `WS_VISIBLE`
//! popups that hand `WM_CLOSE` to `DefWindowProc`, which destroys them. With
//! the main window minimized only those were closed: the app kept running
//! without its single-instance window, so the next launch found no window to
//! hand over to and started a second instance.
//!
//! Each helper window is subclassed so `WM_CLOSE` quits the app instead,
//! through the same save-then-exit path as the main window's X
//! (`quit_flush::quit`). The subclass removes itself on `WM_NCDESTROY`, as
//! comctl32 requires.
#![cfg(windows)]

use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, GetClassNameW, WM_CLOSE, WM_NCDESTROY,
};

const SUBCLASS_ID: usize = 0x6865_6c70; // "help"

/// Class of tao's event target window (tao 0.37 `event_loop.rs`).
const TAO_EVENT_TARGET: &str = "Tao Thread Event Target";
/// Class of the tray icon's message window (tray-icon 0.25).
const TRAY_ICON: &str = "tray_icon_app";

/// The app the production close action quits.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Subclasses the helper windows on this thread (the event loop's, which owns
/// them; call from `setup`). Returns how many were subclassed.
pub fn install(app: &AppHandle) -> usize {
    let _ = APP.set(app.clone());
    // tauri-plugin-single-instance names its class `<identifier>-sic` (no
    // `semver` feature).
    let single_instance = format!("{}-sic", app.config().identifier);
    let classes = [single_instance.as_str(), TAO_EVENT_TARGET, TRAY_ICON];
    let mut done = 0;
    for hwnd in thread_windows() {
        if class_name(hwnd).is_some_and(|c| classes.contains(&c.as_str()))
            && subclass(hwnd, quit_app)
        {
            done += 1;
        }
    }
    done
}

/// Quits like the main window's X: hide it at once, save, then exit. Off the
/// window procedure, so Tauri runs it through the event loop as usual.
fn quit_app() {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tracing::info!("helper window closed from outside; quitting");
    tauri::async_runtime::spawn(async move {
        if let Some(w) = app.get_webview_window(crate::pip_state::MAIN_WINDOW) {
            let _ = w.hide();
        }
        crate::quit_flush::quit(&app);
    });
}

/// Installs the subclass that turns `WM_CLOSE` into `on_close`. Must run on
/// the thread that owns `hwnd`.
fn subclass(hwnd: HWND, on_close: fn()) -> bool {
    // SAFETY: `subclass_proc` matches SUBCLASSPROC and lives for the whole
    // process; the reference data is a plain fn pointer.
    unsafe {
        SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, on_close as usize).as_bool()
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    match msg {
        WM_CLOSE => {
            // SAFETY: `data` is the fn pointer `subclass` stored.
            let on_close = unsafe { std::mem::transmute::<usize, fn()>(data) };
            on_close();
            LRESULT(0)
        }
        WM_NCDESTROY => {
            // SAFETY: removing our own subclass on the owning thread.
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
        }
        // SAFETY: plain forwarding to the next window procedure.
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// Top-level windows of the current thread.
fn thread_windows() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the Vec below, alive for the enumeration.
        unsafe { (*(lparam.0 as *mut Vec<HWND>)).push(hwnd) };
        true.into()
    }
    let mut out: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `out`, which outlives the call.
    unsafe {
        let _ = EnumThreadWindows(
            GetCurrentThreadId(),
            Some(collect),
            LPARAM(&mut out as *mut Vec<HWND> as isize),
        );
    }
    out
}

fn class_name(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    // SAFETY: the buffer is valid for its length.
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, IsWindow, PeekMessageW,
        PostMessageW, RegisterClassExW, SetWindowLongPtrW, TranslateMessage, GWL_STYLE, MSG,
        PM_REMOVE, WINDOW_EX_STYLE, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT, WS_OVERLAPPED, WS_POPUP, WS_VISIBLE,
    };

    static CLOSES: AtomicUsize = AtomicUsize::new(0);

    fn count_close() {
        CLOSES.fetch_add(1, Ordering::SeqCst);
    }

    unsafe extern "system" fn plain_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        // Like the plugin's and tao's: everything it does not handle,
        // WM_CLOSE included, goes to DefWindowProc (which destroys it).
        unsafe { DefWindowProcW(hwnd, msg, w, l) }
    }

    /// A helper window built like the single-instance plugin's.
    fn helper_window() -> HWND {
        unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(plain_proc),
                hInstance: instance.into(),
                lpszClassName: w!("com.philly.tsrustiptv.test-sic"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE
                    | WS_EX_TRANSPARENT
                    | WS_EX_LAYERED
                    | WS_EX_TOOLWINDOW
                    | WINDOW_EX_STYLE(0),
                w!("com.philly.tsrustiptv.test-sic"),
                w!("com.philly.tsrustiptv.test-siw"),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_VISIBLE | WS_POPUP).0 as isize);
            hwnd
        }
    }

    fn pump() {
        let mut msg = MSG::default();
        // SAFETY: a plain message pump on this thread.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    #[test]
    fn closing_the_single_instance_window_quits_instead_of_destroying_it() {
        let hwnd = helper_window();
        assert_eq!(
            class_name(hwnd).as_deref(),
            Some("com.philly.tsrustiptv.test-sic")
        );
        assert!(
            thread_windows().contains(&hwnd),
            "found as a top-level window of this thread"
        );
        assert!(subclass(hwnd, count_close));
        // What `taskkill` without /F does.
        unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).unwrap() };
        pump();
        assert_eq!(CLOSES.load(Ordering::SeqCst), 1, "the close quits the app");
        assert!(
            unsafe { IsWindow(Some(hwnd)) }.as_bool(),
            "the window survives, so a second launch still finds it"
        );
        // Destroying it (the plugin does on exit) removes the subclass cleanly.
        unsafe { DestroyWindow(hwnd).unwrap() };
        assert!(!unsafe { IsWindow(Some(hwnd)) }.as_bool());
    }
}
