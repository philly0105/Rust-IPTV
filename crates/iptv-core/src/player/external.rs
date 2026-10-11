//! External player launch (`player.openExternal`).
//!
//! The player is spawned detached from our console and process group with
//! null stdio, so it outlives the app and never blocks on a pipe. A watcher
//! task waits for the exit and emits `player.external` (`started`, then
//! `exited` with the exit code).

use super::args::{mpv_external_args, vlc_external_args};
use super::detect::{find_mpv, find_vlc, DetectEnv};
use crate::error::{CoreError, CoreResult};
use crate::model::PlayerSource;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

/// Which external player to launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalPlayer {
    Mpv,
    Vlc,
}

impl ExternalPlayer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mpv => "mpv",
            Self::Vlc => "vlc",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Mpv => "mpv",
            Self::Vlc => "VLC",
        }
    }
}

/// `player.external` event payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEvent {
    pub state: ExternalState,
    pub player: ExternalPlayer,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// `player.external` lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalState {
    Started,
    Exited,
}

/// Builds the argv (without the program) for `player`.
pub fn build_args(
    player: ExternalPlayer,
    source: &PlayerSource,
    settings: &crate::model::Settings,
) -> Vec<String> {
    match player {
        ExternalPlayer::Mpv => mpv_external_args(source, &settings.mpv_args),
        ExternalPlayer::Vlc => vlc_external_args(source, &settings.vlc_args),
    }
}

/// Launches `player` for `source` and returns its pid.
pub async fn open_external(
    state: &Arc<AppState>,
    player: ExternalPlayer,
    source: &PlayerSource,
) -> CoreResult<u32> {
    if source.url.trim().is_empty() {
        return Err(CoreError::invalid("this item has no stream URL to open"));
    }
    let settings = state.settings_snapshot();
    let configured = match player {
        ExternalPlayer::Mpv => settings.mpv_path.clone(),
        ExternalPlayer::Vlc => settings.vlc_path.clone(),
    };
    let program = tokio::task::spawn_blocking(move || {
        let env = DetectEnv::current();
        match player {
            ExternalPlayer::Mpv => find_mpv(configured.as_deref(), &env),
            ExternalPlayer::Vlc => find_vlc(configured.as_deref(), &env),
        }
    })
    .await?
    .ok_or_else(|| {
        CoreError::NotFound(format!(
            "{} was not found. Install it or set its path in Settings > Players.",
            player.display_name()
        ))
    })?;

    let args = build_args(player, source, &settings);
    let mut child = spawn_detached(&program, &args).map_err(|e| {
        CoreError::Io(std::io::Error::new(
            e.kind(),
            format!(
                "could not start {} ({}): {e}. Check the path in Settings > Players.",
                player.display_name(),
                program.display()
            ),
        ))
    })?;
    let pid = child.id().unwrap_or(0);
    // URL omitted on purpose: it may embed portal credentials.
    tracing::info!(player = player.as_str(), pid, "external player started");

    let title = source.title.clone();
    state.emit(
        "player.external",
        ExternalEvent {
            state: ExternalState::Started,
            player,
            title: title.clone(),
            pid: Some(pid),
            exit_code: None,
        },
    );

    let watcher_state = Arc::clone(state);
    tokio::spawn(async move {
        let exit_code = match child.wait().await {
            Ok(status) => status.code(),
            Err(e) => {
                tracing::warn!(error = %e, pid, "waiting for external player failed");
                None
            }
        };
        tracing::info!(
            player = player.as_str(),
            pid,
            exit_code,
            "external player exited"
        );
        watcher_state.emit(
            "player.external",
            ExternalEvent {
                state: ExternalState::Exited,
                player,
                title,
                pid: Some(pid),
                exit_code,
            },
        );
    });

    Ok(pid)
}

fn spawn_detached(program: &Path, args: &[String]) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    if let Some(dir) = program.parent().filter(|d| !d.as_os_str().is_empty()) {
        // mpv/VLC load DLLs and portable config relative to themselves.
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    cmd.spawn()
}
