//! `player` module (B9): external mpv/VLC launch, player detection, and the
//! embedded mpv session (Windows: `mpv.exe --wid=<child HWND>` driven over
//! the JSON IPC named pipe).
//!
//! Layout:
//! - [`detect`]: finds mpv and VLC (settings, `vendor/mpv`, PATH, Program
//!   Files, scoop, choco, Homebrew, /Applications).
//! - [`args`]: command-line building (external players and embedded mpv) and
//!   the quote-aware splitter for `settings.mpvArgs` / `settings.vlcArgs`.
//! - [`external`]: detached external launch plus the `player.external` watcher.
//! - [`ipc`]: transport-agnostic mpv JSON IPC client (newline-delimited JSON,
//!   `request_id` correlation, property observers).
//! - [`mpv_state`]: pure reducers from IPC events to [`MpvState`].
//! - [`embedded`]: the embedded session lifecycle (`mpv.*` commands).
//! - [`rpc`]: `player.*` and `mpv.*` registrations.
//! - [`stats`]: the `mpv.stats` snapshot (stream info overlay).
//!
//! The items between the "contract" markers are shared with `settings`
//! (B2) and `iptv-tauri` and keep their signatures (amendment A1).

pub mod args;
pub mod detect;
pub mod embedded;
pub mod external;
pub mod ipc;
pub mod mpv_state;
pub mod rpc;
pub mod stats;

use crate::error::{CoreError, CoreResult};
use crate::model::{PlayerKind, PlayerSource, Settings};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub use detect::DetectEnv;
pub use embedded::{kill_embedded, shutdown, MPV_EXT_KEY};

// ---- contract (A1) --------------------------------------------------------

/// Child window rectangle in CSS pixels (the factory scales by the window's
/// scale factor).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Creates and manages the native child window mpv renders into
/// (implemented by `iptv-tauri/src/mpv_window.rs` on Windows).
pub trait ChildWindowFactory: Send + Sync {
    /// Creates a child window and returns its HWND.
    fn create(&self, bounds: Bounds) -> CoreResult<isize>;
    fn set_bounds(&self, hwnd: isize, bounds: Bounds) -> CoreResult<()>;
    /// Cuts `holes` (relative to the window, CSS px) out of the window so the
    /// webview under them shows through; an empty list restores the full window.
    fn set_holes(&self, _hwnd: isize, _holes: Vec<Bounds>) -> CoreResult<()> {
        Ok(())
    }
    fn destroy(&self, hwnd: isize) -> CoreResult<()>;
}

/// `AppState.extensions` key of the window factory.
pub const WINDOW_FACTORY_KEY: &str = "mpv_window_factory";

/// Sized wrapper so a `dyn ChildWindowFactory` can live in
/// `AppState.extensions` (`AppState::ext` downcasts to a sized type).
pub struct WindowFactoryHandle(pub Arc<dyn ChildWindowFactory>);

/// Error for a player program that could not be started: a missing or
/// non-runnable executable is `engine_missing` (C12), anything else stays an
/// I/O error.
pub fn spawn_error(err: std::io::Error, message: String) -> crate::error::CoreError {
    use std::io::ErrorKind;
    /// Windows `ERROR_BAD_EXE_FORMAT`: the file is not a valid program.
    const BAD_EXE_FORMAT: i32 = 193;
    /// Windows `ERROR_EXE_MACHINE_TYPE_MISMATCH`: a program for another CPU,
    /// or (Windows 11) a non-PE file named `.exe`.
    const EXE_MACHINE_TYPE_MISMATCH: i32 = 216;
    match err.kind() {
        ErrorKind::NotFound | ErrorKind::PermissionDenied => {
            crate::error::CoreError::EngineMissing(message)
        }
        _ if cfg!(windows)
            && matches!(
                err.raw_os_error(),
                Some(BAD_EXE_FORMAT | EXE_MACHINE_TYPE_MISMATCH)
            ) =>
        {
            crate::error::CoreError::EngineMissing(message)
        }
        kind => crate::error::CoreError::Io(std::io::Error::new(kind, message)),
    }
}

/// Registers the window factory (called by iptv-tauri at boot).
pub fn set_window_factory(state: &AppState, factory: Arc<dyn ChildWindowFactory>) {
    state.set_ext(WINDOW_FACTORY_KEY, Arc::new(WindowFactoryHandle(factory)));
}

/// The registered window factory, if running in the desktop shell.
pub fn window_factory(state: &AppState) -> Option<Arc<dyn ChildWindowFactory>> {
    state
        .ext::<WindowFactoryHandle>(WINDOW_FACTORY_KEY)
        .map(|h| Arc::clone(&h.0))
}

/// The source mpv or VLC is handed. Desktop: a `kind: file` source that
/// `recordings.playSource` or `myvideos.playSource` pointed at the loopback
/// proxy is turned back into the file's path: they read local files
/// themselves, and an external player outlives the app and its proxy. The
/// core chose that path, so it plays even on a network share. Every other
/// source came from the UI and comes back unchanged once
/// [`args::validate_play_url`] accepts it, which keeps a playlist line from
/// pointing a player at a `file:` URL or a network path.
pub async fn with_local_file(
    state: &Arc<AppState>,
    source: &PlayerSource,
) -> CoreResult<PlayerSource> {
    let mut out = source.clone();
    match proxied_file(state, source).await? {
        Some(path) => out.url = path.to_string_lossy().into_owned(),
        None => args::validate_play_url(source)?,
    }
    Ok(out)
}

/// The file behind a `kind: file` source on the loopback proxy's
/// `recordings` or `files` route; `None` for every other source.
async fn proxied_file(
    state: &Arc<AppState>,
    source: &PlayerSource,
) -> CoreResult<Option<std::path::PathBuf>> {
    if source.kind != PlayerKind::File {
        return Ok(None);
    }
    let Some(api) = crate::rpc::app::desktop_api_base(state) else {
        return Ok(None);
    };
    let Some(rest) = source.url.strip_prefix(&format!("{api}/")) else {
        return Ok(None);
    };
    let mut parts = rest.split('/');
    let path = match (parts.next(), parts.next()) {
        (Some("recordings"), Some(id)) => {
            let target = crate::recording::library::resolve(state, id).await?;
            target.path().to_path_buf()
        }
        (Some("files"), Some(id)) => {
            let id = id
                .parse::<i64>()
                .map_err(|_| CoreError::invalid("not a download id"))?;
            crate::downloads::completed_file(state, id).await?
        }
        _ => return Ok(None),
    };
    Ok(Some(path))
}

/// Result of player detection.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPlayers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mpv_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlc_path: Option<String>,
}

/// Finds mpv and VLC: configured paths first, then `vendor/mpv/mpv.exe`
/// beside the running exe and under the working directory, PATH, Program
/// Files, scoop, choco, and the usual Unix / macOS locations.
/// See [`detect::detect_with`] for the exact order.
pub fn detect(settings: &Settings) -> DetectedPlayers {
    detect::detect_with(settings, &DetectEnv::current())
}

// ---- end contract ---------------------------------------------------------

/// Result of `player.capabilities`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCapabilities {
    pub embedded_mpv: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mpv_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlc_path: Option<String>,
    /// Why embedded mpv is unavailable, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Computes `player.capabilities`. Embedded mpv needs a registered window
/// factory and either mpv.exe (Windows) or libmpv (macOS).
pub fn capabilities(state: &AppState) -> PlayerCapabilities {
    let detected = detect(&state.settings_snapshot());
    let has_factory = window_factory(state).is_some();
    #[cfg(target_os = "macos")]
    let mpv_found = embedded::native_available();
    #[cfg(not(target_os = "macos"))]
    let mpv_found = detected.mpv_path.is_some();
    let reason = embedded_unavailable_reason(
        cfg!(any(windows, target_os = "macos")),
        mpv_found,
        has_factory,
    );
    PlayerCapabilities {
        embedded_mpv: reason.is_none(),
        mpv_path: detected.mpv_path,
        vlc_path: detected.vlc_path,
        reason,
    }
}

/// The user-facing reason embedded mpv cannot run, or `None` when it can.
pub fn embedded_unavailable_reason(
    platform_supported: bool,
    mpv_found: bool,
    has_window_factory: bool,
) -> Option<String> {
    if !platform_supported {
        Some("Embedded mpv is only available on Windows and macOS. Choose mpv or VLC as an external player instead.".into())
    } else if !has_window_factory {
        Some("Embedded mpv needs the desktop app. In the browser, use the built-in player.".into())
    } else if !mpv_found {
        Some(if cfg!(windows) { "mpv.exe was not found. Put mpv in vendor\\mpv\\ beside the app, install it (scoop, choco, PATH), or set its path in Settings > Players." } else if cfg!(target_os = "macos") { "libmpv was not found. Install mpv with Homebrew to use embedded playback." } else { "mpv was not found. Install mpv or set its path in Settings > Players." }.into())
    } else {
        None
    }
}

/// Starts the player runtime. Nothing runs until `mpv.attach`, so this only
/// logs what was detected (paths are not secrets).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let settings = state.settings_snapshot();
    let detected = tokio::task::spawn_blocking(move || detect(&settings)).await?;
    tracing::info!(
        mpv = detected.mpv_path.as_deref().unwrap_or("-"),
        vlc = detected.vlc_path.as_deref().unwrap_or("-"),
        "players detected"
    );
    Ok(())
}

#[cfg(test)]
mod spawn_error_tests {
    use super::spawn_error;
    use crate::error::RpcErrorCode;
    use std::io::{Error, ErrorKind};

    /// C12: a player program that is missing or not runnable is
    /// `engine_missing`, never `not_found` ("this stream no longer exists").
    #[test]
    fn missing_or_blocked_player_is_engine_missing() {
        for kind in [ErrorKind::NotFound, ErrorKind::PermissionDenied] {
            let err = spawn_error(Error::new(kind, "x"), "could not start mpv".into());
            assert_eq!(err.code(), RpcErrorCode::EngineMissing, "{kind:?}");
            let rpc = crate::error::RpcError::from(err);
            assert_eq!(serde_json::to_value(rpc.code).unwrap(), "engine_missing");
        }
        let other = spawn_error(Error::other("x"), "m".into());
        assert_eq!(other.code(), RpcErrorCode::Io);
        #[cfg(windows)]
        for raw in [193, 216] {
            let err = spawn_error(Error::from_raw_os_error(raw), "m".into());
            assert_eq!(err.code(), RpcErrorCode::EngineMissing, "os error {raw}");
        }
    }
}
