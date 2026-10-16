//! Quitting (tray Quit, or closing the main window with X or Alt+F4) lets the
//! webview save first. `app.exit` tears the webview down
//! without `pagehide`, so a seek in the last few seconds (the player saves
//! every 5 s) would be lost. Quit emits `app.flush`, the webview saves and
//! answers with `flush_done`, and the app exits then, or after
//! `FLUSH_DEADLINE` when no answer comes (a hung or reloading page).

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use iptv_core::events::AppEvent;

/// Longest the quit waits for the webview's saves (the webview gives up on
/// its own savers after 2.5 s and acks; with nothing to save it acks at once).
pub const FLUSH_DEADLINE: Duration = Duration::from_secs(3);

/// One quit at a time: the first Quit arms it, `flush_done` releases it.
#[derive(Default)]
pub struct FlushGate {
    quitting: AtomicBool,
    waiter: Mutex<Option<Sender<()>>>,
}

impl FlushGate {
    /// Starts a quit; None when one is already under way (Quit clicked twice).
    pub fn arm(&self) -> Option<Receiver<()>> {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        *self.waiter.lock() = Some(tx);
        Some(rx)
    }

    /// The webview has saved. A stray ack with no quit waiting does nothing.
    pub fn ack(&self) {
        if let Some(tx) = self.waiter.lock().take() {
            let _ = tx.send(());
        }
    }
}

/// Waits for the ack or the deadline; true when the webview answered in time.
pub fn wait(rx: &Receiver<()>, deadline: Duration) -> bool {
    rx.recv_timeout(deadline).is_ok()
}

/// Quit: ask the webview to save, then exit (never blocking the main thread).
/// A second call while the first is waiting does nothing.
pub fn quit(app: &AppHandle) {
    let Some(gate) = app.try_state::<FlushGate>() else {
        app.exit(0);
        return;
    };
    let Some(rx) = gate.arm() else {
        return;
    };
    if let Err(err) = app.emit(
        crate::APP_EVENT,
        AppEvent::new("app.flush", serde_json::json!({})),
    ) {
        tracing::warn!(%err, "could not ask the webview to save before quitting");
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if !wait(&rx, FLUSH_DEADLINE) {
            tracing::warn!("webview did not confirm its save before quitting");
        }
        app.exit(0);
    });
}

/// Whether a window's close request is taken over by the save-then-exit:
/// when it is the last open window (closing it ends the app; there is no
/// close-to-tray). That holds while a quit is already waiting too, so a second
/// X does not cut the save short. `app.exit` never sends CloseRequested (it
/// asks the event loop to exit), so the exit at the end is not held.
pub fn takes_over_close(open_windows: usize) -> bool {
    open_windows <= 1
}

/// The main window's X or Alt+F4. Returns true when the close was taken over:
/// the caller prevents it, the window is hidden at once so the close looks
/// instant, and `quit` exits once the webview has saved (or at
/// `FLUSH_DEADLINE`, so a hung webview still exits).
pub fn on_close_requested(window: &tauri::Window) -> bool {
    let app = window.app_handle();
    if app.try_state::<FlushGate>().is_none() || !takes_over_close(app.webview_windows().len()) {
        return false;
    }
    if let Err(err) = window.hide() {
        tracing::warn!(%err, "could not hide the window while saving before quit");
    }
    quit(app);
    true
}

/// `invoke('flush_done')`: the webview has saved after `app.flush`.
#[tauri::command]
pub fn flush_done(gate: tauri::State<'_, FlushGate>) {
    gate.ack();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_last_window_saves_first_and_a_second_close_does_not_cut_the_save() {
        assert!(takes_over_close(1));
        assert!(
            !takes_over_close(2),
            "another window stays open, so the app does not exit"
        );
        // First X: the quit arms. Second X while it waits: still taken over
        // (prevented), and `quit` does not arm again, so the first wait goes on.
        let gate = FlushGate::default();
        let rx = gate.arm().expect("first close starts the quit");
        assert!(takes_over_close(1));
        assert!(gate.arm().is_none());
        // The deadline still ends a quit nobody acks (a hung webview).
        assert!(!wait(&rx, Duration::from_millis(20)));
    }

    #[test]
    fn rust_waits_longer_than_the_webview_budget() {
        // window.ts QUIT_FLUSH_BUDGET_MS = 2500: the webview acks before Rust gives up.
        assert!(FLUSH_DEADLINE >= Duration::from_millis(2500 + 400));
    }
    use std::time::Instant;

    #[test]
    fn an_ack_releases_the_quit_at_once() {
        let gate = FlushGate::default();
        let rx = gate.arm().expect("first quit arms");
        gate.ack();
        let start = Instant::now();
        assert!(wait(&rx, Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn no_ack_times_out_at_the_deadline() {
        let gate = FlushGate::default();
        let rx = gate.arm().expect("first quit arms");
        let start = Instant::now();
        assert!(!wait(&rx, Duration::from_millis(50)));
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn a_second_quit_does_not_arm_again_and_stray_acks_are_harmless() {
        let gate = FlushGate::default();
        gate.ack(); // nothing waiting
        let rx = gate.arm().expect("first quit arms");
        assert!(gate.arm().is_none());
        gate.ack();
        gate.ack();
        assert!(wait(&rx, Duration::from_millis(10)));
    }

    #[test]
    fn an_ack_from_another_thread_wakes_the_waiter() {
        let gate = std::sync::Arc::new(FlushGate::default());
        let rx = gate.arm().expect("first quit arms");
        let g = std::sync::Arc::clone(&gate);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            g.ack();
        });
        assert!(wait(&rx, Duration::from_secs(5)));
        t.join().unwrap();
    }
}
