//! Tsrust IPTV desktop shell (SPEC C1, Tauri side).
//!
//! The shell is thin: it builds `AppState` under the platform app-data dir,
//! exposes one `rpc` command that forwards to `iptv_core::rpc::RpcRouter`, and
//! bridges core events to the webview as `app-event`. Plugins: dialog, shell,
//! opener, notification, deep-link (`iptv://`), single-instance, window-state,
//! and (feature `updater`) the updater. A tray icon offers Show / Quit.
//!
//! On Windows, `mpv_window` provides the child window embedded mpv renders
//! into. On exit the shell kills embedded mpv and stops the remote control
//! server so neither outlives the app.

#[cfg(windows)]
mod mpv_window;

use iptv_core::events::{AppEvent, EventSink};
use iptv_core::logging::LogGuard;
use iptv_core::rpc::{build_router, init_all, RpcRouter};
use iptv_core::{AppState, RpcError};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Name of the webview event carrying `AppEvent` JSON.
pub const APP_EVENT: &str = "app-event";

/// Forwards core events to the webview.
struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: AppEvent) {
        if event.kind == "settings.changed" {
            if let Some(dir) = event.payload.get("downloadsDir").and_then(|v| v.as_str()) {
                allow_media_dir(&self.0, std::path::Path::new(dir));
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

/// Lets the webview play files from `dir` through the asset protocol
/// (`convertFileSrc`), so My Videos works from a custom downloads folder.
/// The scope only grows: files completed in an earlier folder stay playable.
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

    allow_media_dir(&handle, &iptv_core::downloads::dir(&state));

    app.manage(Arc::clone(&state));
    app.manage(Arc::new(build_router()));

    // Deep links (`iptv://...`) arrive here on first launch and, through
    // single-instance, from later launches. The UI listens for `deeplink.open`.
    // Scheme registration happens in the NSIS installer; we deliberately do not
    // call `register_all()` at runtime (it writes to the registry).
    {
        let state = Arc::clone(&state);
        app.deep_link().on_open_url(move |event| {
            let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
            state.emit("deeplink.open", serde_json::json!({ "urls": urls }));
        });
    }
    // Cold start through a link: the webview is not listening yet during
    // setup, so re-emit the launch URLs once the shell has had time to mount.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        let urls: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
        if !urls.is_empty() {
            let state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                state.emit("deeplink.open", serde_json::json!({ "urls": urls }));
            });
        }
    }

    tauri::async_runtime::spawn(async move {
        if let Err(err) = init_all(state).await {
            tracing::error!(error = %err, "module init failed");
        }
    });

    build_tray(app)?;
    Ok(())
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    // I: updater. Enable with `--features updater` only after adding to
    // tauri.conf.json: "plugins": { "updater": { "pubkey": "<minisign public key>",
    // "endpoints": ["https://<host>/latest.json"] } } and
    // "bundle": { "createUpdaterArtifacts": true }, plus "updater:default" in
    // capabilities/default.json. Signed feeds are a non-goal for v1.
    #[cfg(all(
        feature = "updater",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![rpc])
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
/// app) and stop the remote control server. Downloads need no flush: every
/// state change is already in SQLite and `downloads::init` re-queues
/// interrupted transfers on the next start.
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
    tracing::info!("shutdown complete");
}
