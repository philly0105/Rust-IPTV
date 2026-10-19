//! Idle memory trimming (Windows).
//!
//! Most of the desktop footprint is WebView2 (browser, GPU, renderer, and
//! utility processes), not the app. Two levers the app controls:
//!
//! - `ICoreWebView2_19::MemoryUsageTargetLevel`: `Low` while the window is
//!   minimized asks WebView2 to drop caches and trim its processes; `Normal`
//!   again on focus. Not on blur: an unfocused window may still be playing.
//! - `SetProcessWorkingSetSize(-1, -1)` on the app process after startup and
//!   on minimize, which releases pages touched only during boot.
//! - `ICoreWebView2Controller::IsVisible`: false while the window is
//!   minimized, so the page stops rendering.
//!
//! Static Chromium flags that keep the process tree small live in
//! `tauri.conf.json` (`additionalBrowserArgs`).

use tauri::{Runtime, WebviewWindow};

/// Trims the app process's working set (pages stay in the standby list and
/// fault back in cheaply if needed).
pub fn trim_working_set() {
    use windows::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
    // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing;
    // (usize::MAX, usize::MAX) is the documented "trim" request.
    unsafe {
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

/// What the main webview was last told (it starts visible).
static WEBVIEW_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Tells WebView2 whether the main window can be seen
/// (`ICoreWebView2Controller::IsVisible`). Hidden, the page reports
/// `visibilityState = hidden` and Chromium throttles its timers, animation
/// frames and rendering. Chromium cannot find out by itself: native occlusion
/// tracking is off (`tauri.conf.json`). Embedded mpv is a separate child
/// window of the main window and keeps playing. Only changes are sent.
pub fn set_webview_visible<R: Runtime>(window: &WebviewWindow<R>, visible: bool) {
    use std::sync::atomic::Ordering;
    if WEBVIEW_VISIBLE.swap(visible, Ordering::SeqCst) == visible {
        return;
    }
    tracing::debug!(visible, "webview visibility");
    let result = window.with_webview(move |wv| {
        // SAFETY: called on the webview's thread by `with_webview`; the
        // controller is alive for the call.
        if let Err(err) = unsafe { wv.controller().SetIsVisible(visible) } {
            tracing::debug!(%err, "WebView2 visibility not applied");
        }
    });
    if let Err(err) = result {
        tracing::debug!(%err, "with_webview failed");
    }
}

/// What a main-window event means for the webview: hidden once the window is
/// minimized, shown again on any other size change (restore from the taskbar,
/// Alt+Tab, tray) or on focus; `None` for other events. `minimized` is only
/// asked on a size change.
pub fn visibility_after(
    event: &tauri::WindowEvent,
    minimized: impl FnOnce() -> bool,
) -> Option<bool> {
    match event {
        tauri::WindowEvent::Focused(true) => Some(true),
        tauri::WindowEvent::Resized(_) => Some(!minimized()),
        _ => None,
    }
}

/// What a window event means for WebView2's memory target: Low (and a
/// working-set trim) once the window is minimized, Normal again on focus;
/// `None` for other events. Losing focus alone changes nothing: an unfocused
/// window is often still showing video (picture-in-picture, a second
/// monitor), and Low there makes playback and the UI fault back in.
/// `minimized` is only asked on a size change.
pub fn memory_low_after(
    event: &tauri::WindowEvent,
    minimized: impl FnOnce() -> bool,
) -> Option<bool> {
    match event {
        tauri::WindowEvent::Focused(true) => Some(false),
        tauri::WindowEvent::Resized(_) => minimized().then_some(true),
        _ => None,
    }
}

/// Sets WebView2's memory usage target level (`low = true` for Low).
pub fn set_webview_memory_low<R: Runtime>(window: &WebviewWindow<R>, low: bool) {
    let result = window.with_webview(move |wv| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows::core::Interface;
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        // SAFETY: called on the webview's thread by `with_webview`; the
        // controller and its CoreWebView2 are alive for the call.
        let applied = unsafe {
            wv.controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_19>())
                .and_then(|core| core.SetMemoryUsageTargetLevel(level))
        };
        if let Err(err) = applied {
            tracing::debug!(%err, "WebView2 memory target level not applied");
        }
    });
    if let Err(err) = result {
        tracing::debug!(%err, "with_webview failed");
    }
}

#[cfg(test)]
mod tests {
    use super::{memory_low_after, visibility_after};
    use tauri::{PhysicalSize, WindowEvent};

    #[test]
    fn minimizing_hides_the_page_and_restoring_or_focusing_shows_it() {
        let resized = WindowEvent::Resized(PhysicalSize::new(0, 0));
        assert_eq!(
            visibility_after(&resized, || true),
            Some(false),
            "minimized"
        );
        assert_eq!(visibility_after(&resized, || false), Some(true), "restored");
        assert_eq!(
            visibility_after(&WindowEvent::Focused(true), || unreachable!()),
            Some(true)
        );
        assert_eq!(
            visibility_after(&WindowEvent::Focused(false), || unreachable!()),
            None,
            "blur alone keeps it visible"
        );
    }

    #[test]
    fn only_minimizing_lowers_the_memory_target() {
        let resized = WindowEvent::Resized(PhysicalSize::new(0, 0));
        assert_eq!(memory_low_after(&resized, || true), Some(true), "minimized");
        assert_eq!(memory_low_after(&resized, || false), None, "resized");
        assert_eq!(
            memory_low_after(&WindowEvent::Focused(true), || unreachable!()),
            Some(false)
        );
        assert_eq!(
            memory_low_after(&WindowEvent::Focused(false), || unreachable!()),
            None,
            "blur alone keeps the normal target (picture-in-picture, a second monitor)"
        );
    }
}
