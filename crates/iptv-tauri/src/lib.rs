//! Tsrust IPTV desktop shell (SPEC C1, Tauri side).
//!
//! The shell is thin: it builds `AppState` under the platform app-data dir,
//! exposes one `rpc` command that forwards to `iptv_core::rpc::RpcRouter`, and
//! bridges core events to the webview as `app-event`. Plugins: dialog,
//! opener, deep-link (`iptv://`), single-instance, window-state, and (feature
//! `updater`) the updater. A tray icon offers Show / Quit.
//!
//! On Windows, `mpv_window` provides the child window embedded mpv renders
//! into. `proxy` serves a loopback media proxy so inline playback can send
//! per-playlist headers, and `memory` trims idle memory. On exit the shell
//! kills embedded mpv, stops the remote control server, and checkpoints the
//! SQLite WAL.

mod boot;
mod early_boot;
mod geometry;
#[cfg(windows)]
mod helper_windows;
#[cfg(windows)]
mod memory;
#[cfg(windows)]
mod mpv_window;
mod pip_state;
#[cfg(windows)]
mod pip_window;
mod proxy;
mod quit_flush;

use iptv_core::events::{AppEvent, EventSink};
use iptv_core::logging::LogGuard;
use iptv_core::rpc::app::{deliver_deep_links, set_desktop_info, DesktopInfo};
use iptv_core::rpc::{build_router, init_all, RpcRouter};
use iptv_core::{AppState, RpcError, RpcErrorCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Name of the webview event carrying `AppEvent` JSON.
pub const APP_EVENT: &str = "app-event";

/// Forwards core events to the webview.
struct TauriSink(AppHandle);

/// The event sink of a state opened before the app handle exists
/// (`early_boot`): events go to the webview once `setup` connects it. Nothing
/// emits before then; the core modules start after the gate opens.
#[derive(Default)]
pub(crate) struct LateSink(std::sync::OnceLock<TauriSink>);

impl LateSink {
    fn connect(&self, handle: &AppHandle) {
        let _ = self.0.set(TauriSink(handle.clone()));
    }
}

impl EventSink for LateSink {
    fn emit(&self, event: AppEvent) {
        match self.0.get() {
            Some(sink) => sink.emit(event),
            None => tracing::debug!(kind = %event.kind, "event before the window existed dropped"),
        }
    }
}

impl EventSink for TauriSink {
    fn emit(&self, event: AppEvent) {
        if event.kind == "settings.changed" {
            for key in ["downloadsDir", "recordingsDir"] {
                if let Some(dir) = event.payload.get(key).and_then(|v| v.as_str()) {
                    allow_media_dir(&self.0, std::path::Path::new(dir));
                }
            }
        }
        // recording: a reminder set to switch brings the window forward.
        if event.kind == "reminders.fire"
            && event.payload.get("action").and_then(|v| v.as_str()) == Some("switch")
        {
            show_main(&self.0);
        }
        if let Err(err) = self.0.emit(APP_EVENT, &event) {
            tracing::warn!(kind = %event.kind, %err, "failed to emit app event");
        }
    }
}

/// Keeps the log writer alive for the life of the app.
struct LogGuardState {
    _guard: parking_lot::Mutex<Option<LogGuard>>,
}

/// `invoke('pip_window', { on, restore, aspect })`: picture-in-picture window
/// behaviour. `restore` (on enter) is the normal geometry to put back if the
/// app quits while in PiP (`pip_state`); turning PiP off forgets it. On
/// Windows it also locks the aspect ratio (`aspect`, the video's width /
/// height, when the player knows it) and makes the video follow resizes.
#[tauri::command]
fn pip_window(
    window: tauri::WebviewWindow,
    pip: tauri::State<'_, pip_state::PipState>,
    on: bool,
    restore: Option<pip_state::NormalGeometry>,
    aspect: Option<f64>,
) -> Result<(), String> {
    match (on, restore) {
        (true, Some(geometry)) => pip.begin(geometry),
        (true, None) => {}
        (false, _) => pip.end(),
    }
    #[cfg(windows)]
    return pip_window::set(window, on, aspect);
    #[cfg(not(windows))]
    {
        let _ = (window, aspect);
        Ok(())
    }
}

/// `invoke('pip_aspect', { aspect })`: while PiP is on, re-lock the window to
/// a new video shape (the webview resizes it right after). False when PiP is
/// off or the aspect is out of range.
#[tauri::command]
fn pip_aspect(aspect: f64) -> bool {
    #[cfg(windows)]
    return pip_window::set_aspect(aspect);
    #[cfg(not(windows))]
    {
        let _ = aspect;
        false
    }
}

/// Longest tray label kept (characters); a translation is never this long.
const TRAY_LABEL_MAX: usize = 64;

/// A tray label from the webview: trimmed, control characters dropped, capped
/// in length, and `fallback` when nothing is left.
fn tray_text(input: Option<&str>, fallback: &str) -> String {
    let clean: String = input
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(TRAY_LABEL_MAX)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        fallback.to_string()
    } else {
        clean.to_string()
    }
}

/// Tray menu and tooltip text in the app's language.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayLabels {
    show: String,
    quit: String,
    tooltip: String,
}

impl TrayLabels {
    fn english() -> Self {
        Self::from_parts(None, None, None)
    }

    fn from_parts(show: Option<&str>, quit: Option<&str>, tooltip: Option<&str>) -> Self {
        Self {
            show: tray_text(show, "Show Tsrust IPTV"),
            quit: tray_text(quit, "Quit"),
            tooltip: tray_text(tooltip, "Tsrust IPTV"),
        }
    }
}

fn tray_menu<R: tauri::Runtime, M: Manager<R>>(
    app: &M,
    labels: &TrayLabels,
) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", &labels.show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// `invoke('tray_labels', { show, quit, tooltip })`: rebuilds the tray menu
/// in the UI language (called at startup and on every language change).
/// Missing or blank labels keep the English text.
#[tauri::command]
fn tray_labels(
    app: AppHandle,
    show: Option<String>,
    quit: Option<String>,
    tooltip: Option<String>,
) -> Result<(), String> {
    let labels = TrayLabels::from_parts(show.as_deref(), quit.as_deref(), tooltip.as_deref());
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "the tray icon is not available".to_string())?;
    let menu = tray_menu(&app, &labels).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(&labels.tooltip))
        .map_err(|e| e.to_string())
}

// recording:
/// `invoke('native_notify', { title, body })`: a system notification for a
/// guide reminder (the webview sends the translated text). Control
/// characters are dropped and the text is capped.
#[tauri::command]
fn native_notify(app: AppHandle, title: String, body: Option<String>) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let clean = |s: &str, max: usize| -> String {
        s.chars().filter(|c| !c.is_control()).take(max).collect()
    };
    let mut builder = app.notification().builder().title(clean(&title, 120));
    if let Some(body) = body
        .as_deref()
        .map(|b| clean(b, 240))
        .filter(|b| !b.is_empty())
    {
        builder = builder.body(body);
    }
    builder.show().map_err(|e| e.to_string())
}

/// `invoke('pip_window_saved')`: the pre-PiP geometry while PiP is on, so a
/// reloaded webview can bring the window back.
#[tauri::command]
fn pip_window_saved(
    pip: tauri::State<'_, pip_state::PipState>,
) -> Option<pip_state::NormalGeometry> {
    pip.saved()
}

/// `AppState` once `boot_state` has built it (`boot`).
type StateGate = boot::BootGate<Arc<AppState>>;

/// The single IPC entry point: `invoke('rpc', { cmd, args })`. Calls made
/// while the database is still opening wait for it.
#[tauri::command]
async fn rpc(
    boot: tauri::State<'_, StateGate>,
    router: tauri::State<'_, Arc<RpcRouter>>,
    cmd: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, RpcError> {
    let Some(state) = boot.get().await else {
        return Err(RpcError::new(
            RpcErrorCode::Internal,
            "Tsrust IPTV did not finish starting.",
        ));
    };
    let router = Arc::clone(&router);
    router
        .dispatch(state, &cmd, args.unwrap_or(serde_json::Value::Null))
        .await
}

/// Logs deep links (action names only: an `add` link's query can carry
/// playlist credentials) and hands them to the core queue or the live event.
fn log_and_deliver_deep_links(state: &AppState, via: &str, urls: Vec<String>) {
    let actions: Vec<&str> = urls
        .iter()
        .map(|u| {
            u.trim_start_matches("iptv:")
                .trim_start_matches('/')
                .split(['/', '?', '#'])
                .next()
                .unwrap_or("")
        })
        .collect();
    tracing::info!(via, count = urls.len(), ?actions, "deep links received");
    deliver_deep_links(state, urls);
}

/// Lets the webview play files from `dir` through the asset protocol
/// (`convertFileSrc`), so My Videos works from a custom downloads folder.
/// The static scope covers only `$APPDATA/downloads`; everything else is
/// granted here. The scope only grows: files completed in an earlier folder
/// stay playable.
fn allow_media_dir(app: &AppHandle, dir: &std::path::Path) {
    let dir = dir.as_os_str().to_string_lossy();
    let dir = dir.trim();
    if dir.is_empty() {
        return;
    }
    if let Err(err) = app.asset_protocol_scope().allow_directory(dir, true) {
        tracing::warn!(%err, "could not add the downloads folder to the asset scope");
    }
}

/// Grants the asset scope the app needs at startup: the downloads and
/// recordings folders, plus the folder of every file recorded in the
/// `downloads` table (downloads finished under an earlier downloads folder).
async fn allow_known_media_dirs(app: AppHandle, state: Arc<AppState>) {
    allow_media_dir(&app, &iptv_core::downloads::dir(&state));
    allow_media_dir(&app, &iptv_core::player::embedded::recordings_dir(&state));
    let parents = state
        .db_call(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT file_path FROM downloads WHERE file_path IS NOT NULL AND file_path <> ''",
            )?;
            let paths = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(Result::ok)
                .filter_map(|p| {
                    std::path::Path::new(&p)
                        .parent()
                        .map(std::path::Path::to_path_buf)
                })
                .collect::<std::collections::BTreeSet<_>>();
            Ok(paths)
        })
        .await;
    match parents {
        Ok(dirs) => {
            for dir in dirs {
                allow_media_dir(&app, &dir);
            }
        }
        Err(err) => tracing::warn!(%err, "could not read download folders for the asset scope"),
    }
    // recording: folders of recorded parts (an earlier recordings folder).
    match iptv_core::recording::known_dirs(&state).await {
        Ok(dirs) => {
            for dir in dirs {
                allow_media_dir(&app, &dir);
            }
        }
        Err(err) => tracing::warn!(%err, "could not read recording folders for the asset scope"),
    }
}

/// A state file written by an older build (or the window-state plugin alone)
/// after a quit in fullscreen holds the monitor's size as the window size.
/// Open such a window maximized over a normal default size instead, so its
/// title bar shows and "restore" gives a usable window. Newer builds write
/// the pre-fullscreen geometry on exit (`pip_state`).
fn unstick_fullscreen_size(w: &tauri::WebviewWindow) {
    let (Ok(Some(monitor)), Ok(size)) = (w.current_monitor(), w.outer_size()) else {
        return;
    };
    if w.is_maximized().unwrap_or(false)
        || size.width < monitor.size().width
        || size.height < monitor.size().height
    {
        return;
    }
    let _ = w.set_size(tauri::LogicalSize::new(1280.0, 800.0));
    let _ = w.center();
    let _ = w.maximize();
}

/// Invisible resize border Windows 10/11 adds around a framed window, in
/// logical px (7 px at 100 % plus a pixel of rounding).
const FRAME_SLACK: f64 = 8.0;

/// Moves the (still hidden) restored window fully onto the monitors that
/// exist now: the plugin only checks that one corner of the saved rectangle
/// is on some monitor, and keeps a saved size larger than the monitor it
/// lands on (a window saved on a 4K monitor that is now unplugged).
fn fit_restored_window(w: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(outer), Ok(inner), Ok(monitors)) = (
        w.outer_position(),
        w.outer_size(),
        w.inner_size(),
        w.available_monitors(),
    ) else {
        return;
    };
    let primary = w.primary_monitor().ok().flatten();
    let mut ordered: Vec<&tauri::Monitor> = Vec::with_capacity(monitors.len());
    if let Some(p) = &primary {
        ordered.extend(monitors.iter().filter(|m| m.position() == p.position()));
    }
    ordered.extend(monitors.iter().filter(|m| {
        primary
            .as_ref()
            .is_none_or(|p| m.position() != p.position())
    }));
    let areas: Vec<geometry::Rect> = ordered
        .iter()
        .map(|m| {
            let a = m.work_area();
            geometry::Rect::new(
                a.position.x,
                a.position.y,
                i32::try_from(a.size.width).unwrap_or(i32::MAX),
                i32::try_from(a.size.height).unwrap_or(i32::MAX),
            )
        })
        .collect();
    let scale = w.scale_factor().unwrap_or(1.0);
    let slack = (FRAME_SLACK
        * if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        })
    .round() as i32;
    let rect = geometry::Rect::new(
        pos.x,
        pos.y,
        i32::try_from(outer.width).unwrap_or(i32::MAX),
        i32::try_from(outer.height).unwrap_or(i32::MAX),
    );
    let placed = geometry::place_on_screen(rect, &areas, slack);
    // Read before any move: tao's setters clear it.
    let maximized = w.is_maximized().unwrap_or(false);
    let resize = match geometry::fit_move(rect, placed, maximized) {
        geometry::FitMove::Stay => return,
        geometry::FitMove::Native => {
            if move_hidden_natively(w, placed) {
                tracing::info!(
                    from = ?(rect.x, rect.y, rect.width, rect.height),
                    to = ?(placed.x, placed.y, placed.width, placed.height),
                    "restored maximized window was off screen; moved it onto a monitor"
                );
                return;
            }
            placed.width != rect.width || placed.height != rect.height
        }
        geometry::FitMove::Tao { resize } => resize,
    };
    tracing::info!(
        from = ?(rect.x, rect.y, rect.width, rect.height),
        to = ?(placed.x, placed.y, placed.width, placed.height),
        "restored window was off screen; moved it onto a monitor"
    );
    let _ = w.set_position(tauri::PhysicalPosition::new(placed.x, placed.y));
    if resize {
        let frame_w = outer.width.saturating_sub(inner.width);
        let frame_h = outer.height.saturating_sub(inner.height);
        let width = u32::try_from(placed.width)
            .unwrap_or(0)
            .saturating_sub(frame_w)
            .max(1);
        let height = u32::try_from(placed.height)
            .unwrap_or(0)
            .saturating_sub(frame_h)
            .max(1);
        let _ = w.set_size(tauri::PhysicalSize::new(width, height));
    }
}

/// Moves the hidden window's outer rectangle to `r` with one `SetWindowPos`,
/// which neither shows it nor clears tao's maximized flag (`FitMove::Native`).
/// False where there is no native move (not Windows, no handle).
fn move_hidden_natively(w: &tauri::WebviewWindow, r: geometry::Rect) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };
        let Ok(raw) = w.hwnd() else {
            return false;
        };
        let hwnd = raw.0 as isize;
        w.run_on_main_thread(move || {
            // SAFETY: the main window's handle, on its owning thread; no
            // SWP_SHOWWINDOW, so a hidden window stays hidden.
            unsafe {
                let _ = SetWindowPos(
                    HWND(hwnd as *mut core::ffi::c_void),
                    None,
                    r.x,
                    r.y,
                    r.width,
                    r.height,
                    SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE,
                );
            }
        })
        .is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = (w, r);
        false
    }
}

/// How long the hidden main window waits for its first page load before it
/// is shown anyway (a page that never loads must not leave the app invisible).
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(4);

/// First showing of the main window and its one-time `windowStart` mode.
static WINDOW: WindowGate = WindowGate::new();

/// Tracks the first showing of the main window apart from applying the saved
/// `windowStart` mode: the fallback timer can show the window before the
/// state is open, and the mode then applies once the boot has the state
/// (`apply_late_start`).
struct WindowGate {
    shown: AtomicBool,
    start_applied: AtomicBool,
}

impl WindowGate {
    const fn new() -> Self {
        Self {
            shown: AtomicBool::new(false),
            start_applied: AtomicBool::new(false),
        }
    }

    /// Marks the window shown; true the first time.
    fn first_show(&self) -> bool {
        !self.shown.swap(true, Ordering::SeqCst)
    }

    /// Marks the window shown (tray, second launch).
    fn mark_shown(&self) {
        self.shown.store(true, Ordering::SeqCst);
    }

    /// Claims applying the start mode; true for the first caller only.
    fn claim_start(&self) -> bool {
        !self.start_applied.swap(true, Ordering::SeqCst)
    }

    /// The state has just opened: true (and claimed) when the window is
    /// already showing and the start mode has not been applied.
    fn late_start(&self) -> bool {
        self.shown.load(Ordering::SeqCst) && self.claim_start()
    }
}

/// How long after the page has loaded the window is shown anyway when the UI
/// never asks (`reveal_window`): a page that failed before its first render.
const PAGE_REVEAL_FALLBACK: std::time::Duration = std::time::Duration::from_millis(1500);

/// `invoke('reveal_window')`: the UI has committed its first frame, so the
/// window opens on the painted shell. Showing at page load instead put the
/// show and focus (about 30 ms on the event-loop thread) right where the
/// page's first IPC calls waited for that thread, which held up the first
/// render; the webview paints while the window is still hidden.
#[tauri::command]
fn reveal_window(app: AppHandle) {
    reveal_main(&app);
}

/// Shows the main window the first time it is called (the UI rendered, or a
/// fallback timer); later calls do nothing, so reloads never steal focus.
/// The `windowStart` setting applies here: maximized goes through the same
/// hidden maximize as `unstick_fullscreen_size`, fullscreen follows the show.
/// Before the state is open (only the fallback timer can be that early) the
/// window opens as it closed, and the boot applies the mode once the state
/// is open (`apply_late_start`).
fn reveal_main(app: &AppHandle) {
    if !WINDOW.first_show() {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let start = app
            .try_state::<Arc<AppState>>()
            .filter(|_| WINDOW.claim_start())
            .map(|state| state.settings_snapshot().window_start);
        if start == Some(iptv_core::model::WindowStart::Maximized) {
            let _ = w.maximize();
        }
        clear_hidden_maximize(&w);
        let _ = w.show();
        if start == Some(iptv_core::model::WindowStart::Fullscreen) {
            let _ = w.set_fullscreen(true);
        }
        let _ = w.set_focus();
    }
}

/// Applies the saved `windowStart` mode to a main window the fallback timer
/// showed before the state was open, when `reveal_main` could not read it.
/// Does nothing while the window is hidden (its reveal applies the mode) or
/// once the mode was applied.
fn apply_late_start(app: &AppHandle, state: &AppState) {
    if !WINDOW.late_start() {
        return;
    }
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    match state.settings_snapshot().window_start {
        iptv_core::model::WindowStart::Maximized => {
            let _ = w.maximize();
        }
        iptv_core::model::WindowStart::Fullscreen => {
            let _ = w.set_fullscreen(true);
        }
        iptv_core::model::WindowStart::Normal => {}
    }
}

/// Lets a maximize done while the window was hidden take effect when it is
/// shown (`geometry::style_before_show`). Runs on the event-loop thread, ahead
/// of the `show` queued after it, so no style write from tao lands between.
fn clear_hidden_maximize(w: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, IsWindowVisible, SetWindowLongPtrW, GWL_STYLE,
        };
        let Ok(raw) = w.hwnd() else {
            return;
        };
        let hwnd = raw.0 as isize;
        let _ = w.run_on_main_thread(move || {
            let hwnd = HWND(hwnd as *mut core::ffi::c_void);
            // SAFETY: the main window's handle, used on its owning thread; only
            // the style bits tao itself writes are changed.
            unsafe {
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
                let visible = IsWindowVisible(hwnd).as_bool();
                if let Some(next) = geometry::style_before_show(style, visible) {
                    tracing::info!(
                        "hidden window was flagged maximized but not sized; maximizing on show"
                    );
                    SetWindowLongPtrW(hwnd, GWL_STYLE, next as i32 as _);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = w;
}

/// Brings the main window to the front (tray, second launch).
fn show_main(app: &AppHandle) {
    WINDOW.mark_shown();
    if let Some(w) = app.get_webview_window("main") {
        clear_hidden_maximize(&w);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Builds the tray in English; the webview sends the translated labels once
/// its language is known (`tray_labels`).
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let labels = TrayLabels::english();
    let menu = tray_menu(app, &labels)?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(&labels.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => quit_flush::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Shows a native error box when boot fails (the webview cannot report it).
fn fatal_dialog(message: &str) {
    eprintln!("Tsrust IPTV failed to start: {message}");
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text = HSTRING::from(format!("Tsrust IPTV could not start.\n\n{message}"));
        let caption = HSTRING::from("Tsrust IPTV");
        // SAFETY: both strings are valid, NUL-terminated HSTRINGs for the call's duration.
        unsafe {
            MessageBoxW(None, &text, &caption, MB_ICONERROR | MB_OK);
        }
    }
}

/// Starts file logging under `data_dir` (None when it cannot).
pub(crate) fn init_logging(data_dir: &std::path::Path) -> Option<LogGuard> {
    match iptv_core::logging::init(data_dir) {
        Ok(g) => Some(g),
        Err(err) => {
            eprintln!("logging disabled: {err}");
            None
        }
    }
}

fn setup(
    app: &mut tauri::App,
    early: Option<early_boot::EarlyBoot>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = app.path().app_data_dir()?;
    // The database is already opening (`early_boot`) unless this process
    // could not start it, or resolved another folder than Tauri does.
    let early = match early {
        Some(e) if e.data_dir == data_dir => Some(e),
        Some(e) => {
            tracing::warn!(early = %e.data_dir.display(), data_dir = %data_dir.display(), "early boot used another data folder; opening again");
            None
        }
        None => None,
    };
    let (guard, sink, opening) = match early {
        Some(e) => (e.log_guard, e.sink, e.state),
        None => {
            let guard = init_logging(&data_dir);
            let sink = Arc::new(LateSink::default());
            let opening = tauri::async_runtime::spawn(open_state(
                data_dir.clone(),
                Arc::clone(&sink) as Arc<dyn EventSink>,
            ));
            (guard, sink, opening)
        }
    };
    sink.connect(&handle);
    app.manage(LogGuardState {
        _guard: parking_lot::Mutex::new(guard),
    });

    // The database opens on the runtime (`open_state`) instead of blocking
    // this thread: WebView2 can only start and load the page while the event
    // loop runs. `rpc` waits at the gate until the state is ready.
    let gate = StateGate::default();
    let waiter = gate.waiter();
    app.manage(gate);
    app.manage(Arc::new(build_router()));
    app.manage(pip_state::PipState::default());
    app.manage(quit_flush::FlushGate::default());

    // Deep links (`iptv://...`) arrive here on first launch and, through
    // single-instance, from later launches. Until the UI has pulled
    // `app.pendingDeepLinks` once they are queued in AppState; after that they
    // go out live as `deeplink.open`. Scheme registration happens in the NSIS
    // installer; we deliberately do not call `register_all()` at runtime (it
    // writes to the registry).
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
        let waiter = waiter.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(state) = waiter.get().await {
                log_and_deliver_deep_links(&state, "open", urls);
            }
        });
    });
    let launch_links = app
        .deep_link()
        .get_current()
        .ok()
        .flatten()
        .map(|urls| urls.iter().map(|u| u.to_string()).collect());

    tauri::async_runtime::spawn(boot_state(handle.clone(), data_dir, opening, launch_links));

    #[cfg(all(
        feature = "updater",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    app.add_capability(include_str!("../capabilities-updater/updater.json"))?;

    build_tray(app)?;

    // Closing a hidden helper window from outside (taskkill while minimized)
    // quits instead of leaving the app running without single-instance.
    #[cfg(windows)]
    {
        let count = helper_windows::install(&handle);
        tracing::info!(count, "helper windows quit on close");
    }

    // The window is created hidden (tauri.conf.json `visible: false`, and the
    // window-state plugin does not restore visibility) so its geometry can be
    // restored and corrected first. It is shown once the UI has rendered its
    // first frame (`reveal_window`), so there is neither a jump nor a white
    // flash; `on_page_load` in `run` and this timer cover a page that never
    // renders or never loads.
    if let Some(w) = app.get_webview_window("main") {
        unstick_fullscreen_size(&w);
        fit_restored_window(&w);
        observe_window(&w.as_ref().window());
    }
    {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SHOW_FALLBACK).await;
            reveal_main(&handle);
        });
    }

    // Release pages touched only while booting.
    #[cfg(windows)]
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        memory::trim_working_set();
    });
    Ok(())
}

/// Builds `AppState` (opens and migrates the database) and starts the
/// loopback media proxy (inline playback with per-playlist headers): the
/// part of the boot that needs no window, so it can run before the webview
/// is built (`early_boot`).
pub(crate) async fn open_state(
    data_dir: std::path::PathBuf,
    sink: Arc<dyn EventSink>,
) -> iptv_core::CoreResult<Arc<AppState>> {
    let state = AppState::new(data_dir, sink, true).await?;
    let bases = match proxy::start(Arc::clone(&state)) {
        Ok(bases) => Some(bases),
        Err(err) => {
            tracing::error!(%err, "loopback media proxy unavailable; header streams play without headers");
            None
        }
    };
    set_desktop_info(
        &state,
        DesktopInfo {
            proxy_base: bases.as_ref().map(|b| b.proxy.clone()),
            image_base: bases.map(|b| b.images),
            updater_available: cfg!(feature = "updater"),
        },
    );
    Ok(state)
}

/// Waits for `open_state` (started beside the webview's first load, or
/// before it), wires the shell to the state, delivers the launch deep links,
/// opens the gate for `rpc`, then starts the core modules.
async fn boot_state(
    handle: AppHandle,
    data_dir: std::path::PathBuf,
    opening: tauri::async_runtime::JoinHandle<iptv_core::CoreResult<Arc<AppState>>>,
    launch_links: Option<Vec<String>>,
) {
    let opened = opening
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()));
    let state = match opened {
        Ok(s) => s,
        Err(err) => {
            tracing::error!(error = %err, data_dir = %data_dir.display(), "app state failed to initialize");
            fatal_dialog(&format!("{err}\n\nData folder: {}", data_dir.display()));
            handle.exit(1);
            return;
        }
    };

    #[cfg(windows)]
    iptv_core::player::set_window_factory(
        &state,
        Arc::new(crate::mpv_window::MpvWindowFactory::new(handle.clone())),
    );

    tauri::async_runtime::spawn(allow_known_media_dirs(handle.clone(), Arc::clone(&state)));

    // `shutdown` finds the state here.
    handle.manage(Arc::clone(&state));
    // The fallback timer may have shown the window before the state opened.
    apply_late_start(&handle, &state);
    if let Some(urls) = launch_links {
        log_and_deliver_deep_links(&state, "launch", urls);
    }
    handle.state::<StateGate>().open(Arc::clone(&state));

    if let Err(err) = init_all(state).await {
        tracing::error!(error = %err, "module init failed");
    }
}

/// Feeds the main window's current geometry and mode to the normal-geometry
/// tracker (`pip_state`), which fixes the saved state after a quit in
/// fullscreen.
fn observe_window(window: &tauri::Window) {
    if window.label() != pip_state::MAIN_WINDOW {
        return;
    }
    let Some(state) = window.app_handle().try_state::<pip_state::PipState>() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    state.observe(pip_state::WindowSnapshot {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        decorated: window.is_decorated().unwrap_or(true),
    });
}

/// Tracks the normal geometry; minimized windows ask WebView2 for its low
/// memory target and trim the app's working set; focus restores the normal
/// target. A minimized main window tells WebView2 it is hidden (the page
/// stops rendering); restore or focus shows it again.
fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    // Closing the window ends the app: save playback (and other pending work)
    // first, exactly like tray Quit.
    if let WindowEvent::CloseRequested { api, .. } = event {
        if quit_flush::on_close_requested(window) {
            api.prevent_close();
        }
        return;
    }
    if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
        observe_window(window);
    }
    #[cfg(windows)]
    {
        let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
            return;
        };
        let main = window.label() == pip_state::MAIN_WINDOW;
        let minimized = || window.is_minimized().unwrap_or(false);
        if let Some(low) = memory::memory_low_after(event, minimized) {
            memory::set_webview_memory_low(&webview, low);
            if low {
                memory::trim_working_set();
            }
        }
        if main {
            if let Some(visible) = memory::visibility_after(event, minimized) {
                memory::set_webview_visible(&webview, visible);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (window, event);
}

/// Entry point used by `main.rs`.
pub fn run() {
    let context = tauri::generate_context!();
    // Opens the database while Tauri builds the window and WebView2.
    let early = early_boot::start(&context.config().identifier);
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered first.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    }

    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // recording:
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Decorations and fullscreen are not restored: PiP and the player's
        // fullscreen turn the frame off, and the app must always open framed.
        // Visibility is not restored either: the plugin would show the window
        // the moment it is created, before `setup` has corrected its geometry
        // and before the page has painted (`reveal_main`).
        use tauri_plugin_window_state::StateFlags;
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::all()
                        - StateFlags::DECORATIONS
                        - StateFlags::FULLSCREEN
                        - StateFlags::VISIBLE,
                )
                .build(),
        );
    }

    // Updater (feature `updater`): tauri.conf.json carries `plugins.updater`
    // with a placeholder endpoint and an empty pubkey. Before enabling, put the
    // real minisign public key and feed URL there (see README "Updates"). The
    // `updater:default` permission is added at runtime in `setup` because a
    // static capability would not resolve when the feature is off.
    #[cfg(all(
        feature = "updater",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            rpc,
            pip_window,
            pip_window_saved,
            pip_aspect,
            tray_labels,
            reveal_window,
            quit_flush::flush_done,
            // recording:
            native_notify
        ])
        .on_window_event(on_window_event)
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && webview.label() == pip_state::MAIN_WINDOW
            {
                // The UI shows the window after its first render
                // (`reveal_window`); this covers a page that never renders.
                let handle = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(PAGE_REVEAL_FALLBACK).await;
                    reveal_main(&handle);
                });
            }
        })
        .setup(move |app| setup(app, early))
        .build(context)
        .expect("error while building Tsrust IPTV");

    let mut cleaned_up = false;
    app.run(move |app, event| {
        // The window-state plugin has already saved by now (plugins see Exit
        // before this callback); undo the PiP geometry it may have written.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if matches!(event, RunEvent::Exit) {
            pip_state::persist_on_exit(app);
        }
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) && !cleaned_up {
            cleaned_up = true;
            shutdown(app);
        }
    });
}

/// Longest the exit cleanup may take. It runs on the event-loop thread:
/// waiting there for an import's catalog save (the write lock, up to
/// minutes) left a hidden process behind, and a relaunch in that window
/// was handed to it, so no window appeared (HO-4).
const SHUTDOWN_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// Exit cleanup, within [`SHUTDOWN_BUDGET`]: cancel running imports (each
/// keeps its previous catalog), stop recordings, kill embedded mpv
/// (synchronously, so it never outlives the app), stop the remote control
/// server, and fold the SQLite WAL back into the database file. Downloads
/// need no flush: every state change is already in SQLite and
/// `downloads::init` re-queues interrupted transfers on the next start.
fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let state = Arc::clone(&state);
    let deadline = std::time::Instant::now() + SHUTDOWN_BUDGET;
    let left = || deadline.saturating_duration_since(std::time::Instant::now());
    // Imports first: a catalog save holds the write lock, and the writes
    // below would wait for it. A cancelled save rolls back.
    let cancelled = iptv_core::sources::cancel_all_imports(&state);
    if cancelled > 0 {
        tracing::info!(cancelled, "imports cancelled for exit");
    }
    // recording: stop scheduled recordings and save their final state first.
    let budget = left();
    let recorded = tauri::async_runtime::block_on(async {
        tokio::time::timeout(budget, iptv_core::recording::shutdown(&state)).await
    });
    if recorded.is_err() {
        tracing::warn!("recordings did not stop in time on exit");
    }
    iptv_core::player::kill_embedded(&state);
    let stop = iptv_core::remote::stop(Arc::clone(&state));
    let budget = left().min(std::time::Duration::from_secs(2));
    let stopped =
        tauri::async_runtime::block_on(async { tokio::time::timeout(budget, stop).await });
    if !matches!(stopped, Ok(Ok(()))) {
        tracing::warn!("remote control did not stop cleanly on exit");
    }
    checkpoint_wal(&state, left());
    // Lets the next start skip the large-database background check.
    iptv_core::db::note_clean_shutdown(&state.db_path());
    tracing::info!("shutdown complete");
}

/// `PRAGMA wal_checkpoint(TRUNCATE)` on a pooled connection, so the next
/// start opens a compact database and a copied data folder is complete
/// without its `-wal` file. [`iptv_core::db::checkpoint_truncate`] runs it
/// without the busy handler, so a writer still holding the lock makes it do
/// what it can instead of waiting; the connection wait is bounded by `wait`.
/// The pool itself closes with the process (it lives in `AppState`, which
/// Tauri's managed state owns until exit).
fn checkpoint_wal(state: &AppState, wait: std::time::Duration) {
    match state
        .db
        .get_timeout(wait.max(std::time::Duration::from_millis(100)))
    {
        Ok(conn) => {
            iptv_core::db::checkpoint_truncate(&conn);
            tracing::info!("WAL checkpoint attempted on exit");
        }
        Err(err) => tracing::warn!(%err, "WAL checkpoint on exit skipped"),
    }
}

#[cfg(test)]
mod tests {
    use super::{TrayLabels, WindowGate, TRAY_LABEL_MAX};

    /// GPT review (window-start-skipped): the fallback timer can show the
    /// window before the state is open; the saved mode then applies once the
    /// boot has the state, and only once.
    #[test]
    fn window_start_applies_after_an_early_reveal() {
        // Shown early: the reveal had no state, so the boot applies the mode.
        let early = WindowGate::new();
        assert!(early.first_show());
        assert!(early.late_start());
        assert!(!early.late_start());
        assert!(!early.claim_start());
        // Shown with the state open: the reveal applies it, the boot does not.
        let on_time = WindowGate::new();
        assert!(on_time.first_show());
        assert!(on_time.claim_start());
        assert!(!on_time.late_start());
        // The state first, the window still hidden: left to the reveal.
        let hidden = WindowGate::new();
        assert!(!hidden.late_start());
        assert!(hidden.first_show());
        assert!(hidden.claim_start());
        assert!(!hidden.first_show());
    }

    #[test]
    fn tray_labels_are_trimmed_and_blank_ones_stay_english() {
        let l = TrayLabels::from_parts(Some("  Afficher Tsrust IPTV \n"), Some("   "), None);
        assert_eq!(l.show, "Afficher Tsrust IPTV");
        assert_eq!(l.quit, "Quit");
        assert_eq!(l.tooltip, "Tsrust IPTV");
        assert_eq!(TrayLabels::english().show, "Show Tsrust IPTV");
    }

    #[test]
    fn tray_labels_drop_control_characters_and_are_capped() {
        let long = "x".repeat(TRAY_LABEL_MAX * 3);
        let l = TrayLabels::from_parts(Some("Be\u{7}enden"), Some(&long), Some("\t"));
        assert_eq!(l.show, "Beenden");
        assert_eq!(l.quit.chars().count(), TRAY_LABEL_MAX);
        assert_eq!(l.tooltip, "Tsrust IPTV");
    }
}
