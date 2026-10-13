//! `player.*` and `mpv.*` RPC commands (SPEC C4).

use super::external::{open_external, stop_external, ExternalPlayer};
use super::{capabilities, detect, embedded, Bounds, DetectedPlayers, PlayerCapabilities};
use crate::error::RpcError;
use crate::model::{MpvState, PlayerSource};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Every command this module registers, in C4 order.
pub const COMMANDS: &[&str] = &[
    "player.capabilities",
    "player.detect",
    "player.openExternal",
    "player.stopExternal",
    "mpv.attach",
    "mpv.load",
    "mpv.command",
    "mpv.setProperty",
    "mpv.setBounds",
    "mpv.detach",
    "mpv.state",
    "mpv.record",
    "mpv.stats",
];

/// External and embedded players run on the user's machine, so only the
/// desktop app may launch or detect them; in server mode a browser on
/// another machine must never start processes on the host.
fn ensure_desktop(state: &AppState) -> Result<(), RpcError> {
    if state.is_desktop {
        Ok(())
    } else {
        Err(RpcError::unsupported("Players run only in the desktop app"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenExternalArgs {
    player: ExternalPlayer,
    source: PlayerSource,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenExternalResult {
    pid: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopExternalResult {
    stopped: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundsArgs {
    bounds: Bounds,
    /// Rects inside `bounds` (relative to its top-left, CSS px) cut out of the
    /// window so DOM chrome under them shows over the video.
    #[serde(default)]
    holes: Vec<Bounds>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachArgs {
    bounds: Bounds,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    muted: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordArgs {
    start: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadArgs {
    source: PlayerSource,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandArgs {
    cmd: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPropertyArgs {
    name: String,
    #[serde(default)]
    value: Value,
}

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("player.capabilities", |state, _: ()| async move {
        let caps: PlayerCapabilities = tokio::task::spawn_blocking(move || capabilities(&state))
            .await
            .map_err(|e| RpcError::internal(format!("player detection failed: {e}")))?;
        Ok::<_, RpcError>(caps)
    });

    r.add("player.detect", |state, _: ()| async move {
        ensure_desktop(&state)?;
        let settings = state.settings_snapshot();
        let found: DetectedPlayers = tokio::task::spawn_blocking(move || detect(&settings))
            .await
            .map_err(|e| RpcError::internal(format!("player detection failed: {e}")))?;
        Ok::<_, RpcError>(found)
    });

    r.add(
        "player.openExternal",
        |state, a: OpenExternalArgs| async move {
            ensure_desktop(&state)?;
            let pid = open_external(&state, a.player, &a.source).await?;
            Ok::<_, RpcError>(OpenExternalResult { pid })
        },
    );

    r.add("player.stopExternal", |state, _: ()| async move {
        ensure_desktop(&state)?;
        let stopped = stop_external(&state).await;
        Ok::<_, RpcError>(StopExternalResult { stopped })
    });

    r.add("mpv.attach", |state, a: AttachArgs| async move {
        ensure_desktop(&state)?;
        let opts = embedded::AttachOptions {
            volume: a.volume,
            muted: a.muted,
        };
        let st: MpvState = embedded::attach(&state, a.bounds, opts).await?;
        Ok::<_, RpcError>(st)
    });

    r.add("mpv.load", |state, a: LoadArgs| async move {
        ensure_desktop(&state)?;
        embedded::load(&state, &a.source).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.command", |state, a: CommandArgs| async move {
        ensure_desktop(&state)?;
        Ok::<_, RpcError>(embedded::command(&state, a.cmd).await?)
    });

    r.add("mpv.setProperty", |state, a: SetPropertyArgs| async move {
        ensure_desktop(&state)?;
        embedded::set_property(&state, &a.name, a.value).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.setBounds", |state, a: BoundsArgs| async move {
        ensure_desktop(&state)?;
        embedded::set_bounds(&state, a.bounds, a.holes).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.detach", |state, _: ()| async move {
        ensure_desktop(&state)?;
        embedded::detach(&state).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.state", |state, _: ()| async move {
        ensure_desktop(&state)?;
        embedded::ensure_platform()?;
        Ok::<_, RpcError>(embedded::state(&state))
    });

    r.add("mpv.record", |state, a: RecordArgs| async move {
        ensure_desktop(&state)?;
        Ok::<_, RpcError>(embedded::record(&state, a.start).await?)
    });

    // player: stream info overlay (polled while its panel is open).
    r.add("mpv.stats", |state, _: ()| async move {
        ensure_desktop(&state)?;
        Ok::<_, RpcError>(embedded::stats(&state).await?)
    });
}
