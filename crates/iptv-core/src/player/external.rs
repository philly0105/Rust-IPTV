//! External player launch (`player.openExternal`).
//!
//! The player is spawned detached from our console and process group with
//! null stdio, so it outlives the app and never blocks on a pipe. A watcher
//! task waits for the exit and emits `player.external` (`started`, then
//! `exited` with the exit code).
//!
//! With `settings.playerReuseInstance` (default) a new launch first closes
//! the previous external player this app started, so zapping does not pile
//! up player windows.

use super::args::{mpv_external_args, validate_play_url, vlc_external_args};
use super::detect::{find_mpv, find_vlc, DetectEnv};
use crate::error::{CoreError, CoreResult};
use crate::model::PlayerSource;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};

/// `AppState.extensions` key of the [`ExternalTracker`].
pub const EXTERNAL_EXT_KEY: &str = "player_external";

/// How long a reused launch waits for the previous player to close.
const REUSE_KILL_WAIT: Duration = Duration::from_secs(3);

/// The external player this app started last, while it runs.
#[derive(Default)]
pub struct ExternalTracker {
    running: parking_lot::Mutex<Option<RunningPlayer>>,
    /// Serializes close-previous + spawn + track: two launches at once would
    /// both find nothing to close and leave one player running untracked.
    launch: tokio::sync::Mutex<()>,
}

struct RunningPlayer {
    pid: u32,
    kill: oneshot::Sender<()>,
    exited: watch::Receiver<bool>,
}

fn tracker(state: &AppState) -> Arc<ExternalTracker> {
    state.ext_or_insert_with(EXTERNAL_EXT_KEY, || Arc::new(ExternalTracker::default()))
}

/// Pid of the running external player this app started, if any.
pub fn running_pid(state: &AppState) -> Option<u32> {
    tracker(state).running.lock().as_ref().map(|r| r.pid)
}

/// Closes the previous external player this app started (if it still runs)
/// and waits briefly for it to exit. Returns true when one was running.
async fn close_previous(state: &AppState) -> bool {
    let prev = tracker(state).running.lock().take();
    let Some(mut prev) = prev else {
        return false;
    };
    if *prev.exited.borrow() {
        return false;
    }
    tracing::info!(pid = prev.pid, "closing the external player");
    let _ = prev.kill.send(());
    let _ = tokio::time::timeout(REUSE_KILL_WAIT, prev.exited.wait_for(|e| *e)).await;
    true
}

/// `player.stopExternal`: terminates the external player this app launched
/// last and forgets it. `false` when none is running.
pub async fn stop_external(state: &AppState) -> bool {
    close_previous(state).await
}

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

/// Builds the argv (without the program) for `player`. VLC gets
/// `--one-instance --playlist-enqueue` when `settings.playerReuseInstance`.
pub fn build_args(
    player: ExternalPlayer,
    source: &PlayerSource,
    settings: &crate::model::Settings,
) -> Vec<String> {
    match player {
        ExternalPlayer::Mpv => mpv_external_args(source, &settings.mpv_args),
        ExternalPlayer::Vlc => {
            vlc_external_args(source, &settings.vlc_args, settings.player_reuse_instance)
        }
    }
}

/// Launches `player` for `source` and returns its pid.
pub async fn open_external(
    state: &Arc<AppState>,
    player: ExternalPlayer,
    source: &PlayerSource,
) -> CoreResult<u32> {
    let local = super::with_local_file(state, source).await?;
    let source = &local;
    validate_play_url(source)?;
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
        CoreError::EngineMissing(format!(
            "{} was not found. Install it or set its path in Settings > Players.",
            player.display_name()
        ))
    })?;

    let args = build_args(player, source, &settings);
    let tracker_arc = tracker(state);
    let _launch = tracker_arc.launch.lock().await;
    if settings.player_reuse_instance {
        close_previous(state).await;
    }
    let mut child = spawn_detached(&program, &args).map_err(|e| {
        let msg = format!(
            "could not start {} ({}): {e}. Check the path in Settings > Players.",
            player.display_name(),
            program.display()
        );
        super::spawn_error(e, msg)
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

    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
    let (exited_tx, exited_rx) = watch::channel(false);
    let replaced = tracker(state).running.lock().replace(RunningPlayer {
        pid,
        kill: kill_tx,
        exited: exited_rx,
    });
    // Without reuse an older player keeps running; it is simply no longer
    // the tracked one.
    drop(replaced);

    let watcher_state = Arc::clone(state);
    tokio::spawn(async move {
        let waited = tokio::select! {
            r = child.wait() => r,
            Ok(()) = &mut kill_rx => {
                let _ = child.start_kill();
                child.wait().await
            }
        };
        let exit_code = match waited {
            Ok(status) => status.code(),
            Err(e) => {
                tracing::warn!(error = %e, pid, "waiting for external player failed");
                None
            }
        };
        exited_tx.send_replace(true);
        {
            let t = tracker(&watcher_state);
            let mut running = t.running.lock();
            if running.as_ref().is_some_and(|r| r.pid == pid) {
                *running = None;
            }
        }
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
