//! Idle memory trimming (Windows).
//!
//! Most of the desktop footprint is WebView2 (browser, GPU, renderer, and
//! utility processes), not the app. Two levers the app controls:
//!
//! - `ICoreWebView2_19::MemoryUsageTargetLevel`: `Low` while the window is
//!   in the background asks WebView2 to drop caches and trim its processes;
//!   `Normal` again on focus.
//! - `SetProcessWorkingSetSize(-1, -1)` on the app process after startup and
//!   on blur, which releases pages touched only during boot.
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
