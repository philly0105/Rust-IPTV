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

#[cfg(windows)]
mod memory;
#[cfg(windows)]
mod mpv_window;
mod proxy;

use iptv_core::events::{AppEvent, EventSink};
use iptv_core::logging::LogGuard;
use iptv_core::rpc::app::{deliver_deep_links, set_desktop_info, DesktopInfo};
use iptv_core::rpc::{build_router, init_all, RpcRouter};
use iptv_core::{AppState, RpcError};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Name of the webview event carrying `AppEvent` JSON.
pub const APP_EVENT: &str = "app-event";

/// Forwards core events to the webview.
struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: AppEvent) {
        if event.kind == "settings.changed" {
            for key in ["downloadsDir", "recordingsDir"] {
                if let Some(dir) = event.payload.get(key).and_then(|v| v.as_str()) {
                    allow_media_dir(&self.0, std::path::Path::new(dir));
                }
            }
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

/// The single IPC entry point: `invoke('rpc', { cmd, args })`.
#[tauri::command]
async fn rpc(
    state: tauri::State<'_, Arc<AppState>>,
    router: tauri::State<'_, Arc<RpcRouter>>,
    cmd: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, RpcError> {
    let state = Arc::clone(&state);
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
}

/// Brings the main window to the front.
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Tsrust IPTV", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Tsrust IPTV")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
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

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = app.path().app_data_dir()?;
    let guard = match iptv_core::logging::init(&data_dir) {
        Ok(g) => Some(g),
        Err(err) => {
            eprintln!("logging disabled: {err}");
            None
        }
    };
    app.manage(LogGuardState {
        _guard: parking_lot::Mutex::new(guard),
    });

    let sink: Arc<dyn EventSink> = Arc::new(TauriSink(handle.clone()));
    let state = match tauri::async_runtime::block_on(AppState::new(data_dir.clone(), sink, true)) {
        Ok(s) => s,
        Err(err) => {
            tracing::error!(error = %err, data_dir = %data_dir.display(), "app state failed to initialize");
            fatal_dialog(&format!("{err}\n\nData folder: {}", data_dir.display()));
            return Err(Box::new(err));
        }
    };

    #[cfg(windows)]
    iptv_core::player::set_window_factory(
        &state,
        Arc::new(crate::mpv_window::MpvWindowFactory::new(handle.clone())),
    );

    tauri::async_runtime::spawn(allow_known_media_dirs(handle.clone(), Arc::clone(&state)));

    // Loopback media proxy for inline playback with per-playlist headers.
    let proxy_base = match proxy::start(Arc::clone(&state)) {
        Ok(base) => Some(base),
        Err(err) => {
            tracing::error!(%err, "loopback media proxy unavailable; header streams play without headers");
            None
        }
    };
    set_desktop_info(
        &state,
        DesktopInfo {
            proxy_base,
            updater_available: cfg!(feature = "updater"),
        },
    );

    app.manage(Arc::clone(&state));
    app.manage(Arc::new(build_router()));

    // Deep links (`iptv://...`) arrive here on first launch and, through
    // single-instance, from later launches. Until the UI has pulled
    // `app.pendingDeepLinks` once they are queued in AppState; after that they
    // go out live as `deeplink.open`. Scheme registration happens in the NSIS
    // installer; we deliberately do not call `register_all()` at runtime (it
    // writes to the registry).
    {
        let state = Arc::clone(&state);
        app.deep_link().on_open_url(move |event| {
            let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
            log_and_deliver_deep_links(&state, "open", urls);
        });
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        log_and_deliver_deep_links(
            &state,
            "launch",
            urls.iter().map(|u| u.to_string()).collect(),
        );
    }

    #[cfg(all(
        feature = "updater",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    app.add_capability(include_str!("../capabilities-updater/updater.json"))?;

    tauri::async_runtime::spawn(async move {
        if let Err(err) = init_all(state).await {
            tracing::error!(error = %err, "module init failed");
        }
    });

    build_tray(app)?;

    // The window is created hidden (tauri.conf.json `visible: false`) so the
    // window-state plugin can restore its size and position first; showing it
    // now avoids the visible jump from the default geometry.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }

    // Release pages touched only while booting.
    #[cfg(windows)]
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        memory::trim_working_set();
    });
    Ok(())
}

/// Background windows ask WebView2 for its low memory target and trim the
/// app's working set; focus restores the normal target.
fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    #[cfg(windows)]
    {
        let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
            return;
        };
        match event {
            WindowEvent::Focused(false) => {
                memory::set_webview_memory_low(&webview, true);
                memory::trim_working_set();
            }
            WindowEvent::Focused(true) => memory::set_webview_memory_low(&webview, false),
            WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
                memory::set_webview_memory_low(&webview, true);
                memory::trim_working_set();
            }
            _ => {}
        }
    }
    #[cfg(not(windows))]
    let _ = (window, event);
}

/// Entry point used by `main.rs`.
pub fn run() {
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
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
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
        .invoke_handler(tauri::generate_handler![rpc])
        .on_window_event(on_window_event)
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("error while building Tsrust IPTV");

    let mut cleaned_up = false;
    app.run(move |app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) && !cleaned_up {
            cleaned_up = true;
            shutdown(app);
        }
    });
}

/// Exit cleanup: kill embedded mpv (synchronously, so it never outlives the
/// app), stop the remote control server, and fold the SQLite WAL back into
/// the database file. Downloads need no flush: every state change is already
/// in SQLite and `downloads::init` re-queues interrupted transfers on the
/// next start.
fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let state = Arc::clone(&state);
    iptv_core::player::kill_embedded(&state);
    let stop = iptv_core::remote::stop(Arc::clone(&state));
    let stopped = tauri::async_runtime::block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(2), stop).await
    });
    if !matches!(stopped, Ok(Ok(()))) {
        tracing::warn!("remote control did not stop cleanly on exit");
    }
    checkpoint_wal(&state);
    tracing::info!("shutdown complete");
}

/// `PRAGMA wal_checkpoint(TRUNCATE)` on a pooled connection, so the next
/// start opens a compact database and a copied data folder is complete
/// without its `-wal` file. The pool itself closes with the process (it lives
/// in `AppState`, which Tauri's managed state owns until exit).
fn checkpoint_wal(state: &AppState) {
    let result = state.conn().and_then(|conn| {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(Into::into)
    });
    match result {
        Ok((busy, log, done)) => {
            tracing::info!(
                busy,
                log_frames = log,
                checkpointed = done,
                "WAL checkpointed"
            )
        }
        Err(err) => tracing::warn!(%err, "WAL checkpoint on exit failed"),
    }
}
