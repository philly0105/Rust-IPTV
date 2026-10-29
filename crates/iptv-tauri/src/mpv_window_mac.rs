//! AppKit host for the macOS mpv video window.

use iptv_core::player::{Bounds, ChildWindowFactory};
use iptv_core::{CoreError, CoreResult};
use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

unsafe extern "C" {
    fn iptv_mpv_mac_create(parent: *mut c_void, x: i32, y: i32, w: i32, h: i32) -> *mut c_void;
    fn iptv_mpv_mac_set_bounds(host: *mut c_void, x: i32, y: i32, w: i32, h: i32);
    fn iptv_mpv_mac_set_holes(host: *mut c_void, rects: *const i32, count: usize);
    fn iptv_mpv_mac_destroy(host: *mut c_void);
}

pub struct MpvWindowFactory {
    app: AppHandle,
}

impl MpvWindowFactory {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn on_main<T, F>(&self, operation: &'static str, action: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&AppHandle) -> CoreResult<T> + Send + 'static,
    {
        let app = self.app.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        self.app
            .run_on_main_thread(move || {
                let result = action(&app);
                let _ = tx.send(result);
            })
            .map_err(|e| CoreError::invalid(format!("{operation}: {e}")))?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| CoreError::Timeout(format!("{operation}: main window did not respond")))?
    }
}

impl ChildWindowFactory for MpvWindowFactory {
    fn create(&self, bounds: Bounds) -> CoreResult<isize> {
        self.on_main("create mpv view", move |app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| CoreError::invalid("main window is unavailable"))?;
            let parent = window
                .ns_view()
                .map_err(|e| CoreError::invalid(e.to_string()))?;
            let host = unsafe {
                iptv_mpv_mac_create(parent, bounds.x, bounds.y, bounds.width, bounds.height)
            };
            if host.is_null() {
                return Err(CoreError::invalid("could not create the macOS mpv view"));
            }
            Ok(host as isize)
        })
    }

    fn set_bounds(&self, host: isize, bounds: Bounds) -> CoreResult<()> {
        self.on_main("move mpv view", move |_| {
            unsafe {
                iptv_mpv_mac_set_bounds(
                    host as *mut c_void,
                    bounds.x,
                    bounds.y,
                    bounds.width,
                    bounds.height,
                )
            };
            Ok(())
        })
    }

    fn set_holes(&self, host: isize, holes: Vec<Bounds>) -> CoreResult<()> {
        self.on_main("clip mpv view", move |_| {
            let rects: Vec<i32> = holes
                .iter()
                .flat_map(|b| [b.x, b.y, b.width, b.height])
                .collect();
            unsafe { iptv_mpv_mac_set_holes(host as *mut c_void, rects.as_ptr(), holes.len()) };
            Ok(())
        })
    }

    fn destroy(&self, host: isize) -> CoreResult<()> {
        self.on_main("destroy mpv view", move |_| {
            unsafe { iptv_mpv_mac_destroy(host as *mut c_void) };
            Ok(())
        })
    }
}
