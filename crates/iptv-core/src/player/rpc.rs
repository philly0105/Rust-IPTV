//! `player.*` and `mpv.*` RPC commands (SPEC C4).

use super::external::{open_external, ExternalPlayer};
use super::{capabilities, detect, embedded, Bounds, DetectedPlayers, PlayerCapabilities};
use crate::error::RpcError;
use crate::model::{MpvState, PlayerSource};
use crate::rpc::RpcRouter;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Every command this module registers, in C4 order.
pub const COMMANDS: &[&str] = &[
    "player.capabilities",
    "player.detect",
    "player.openExternal",
    "mpv.attach",
    "mpv.load",
    "mpv.command",
    "mpv.setProperty",
    "mpv.setBounds",
    "mpv.detach",
    "mpv.state",
];

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundsArgs {
    bounds: Bounds,
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
        let settings = state.settings_snapshot();
        let found: DetectedPlayers = tokio::task::spawn_blocking(move || detect(&settings))
            .await
            .map_err(|e| RpcError::internal(format!("player detection failed: {e}")))?;
        Ok::<_, RpcError>(found)
    });

    r.add(
        "player.openExternal",
        |state, a: OpenExternalArgs| async move {
            let pid = open_external(&state, a.player, &a.source).await?;
            Ok::<_, RpcError>(OpenExternalResult { pid })
        },
    );

    r.add("mpv.attach", |state, a: BoundsArgs| async move {
        let st: MpvState = embedded::attach(&state, a.bounds).await?;
        Ok::<_, RpcError>(st)
    });

    r.add("mpv.load", |state, a: LoadArgs| async move {
        embedded::load(&state, &a.source).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.command", |state, a: CommandArgs| async move {
        Ok::<_, RpcError>(embedded::command(&state, a.cmd).await?)
    });

    r.add("mpv.setProperty", |state, a: SetPropertyArgs| async move {
        embedded::set_property(&state, &a.name, a.value).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.setBounds", |state, a: BoundsArgs| async move {
        embedded::set_bounds(&state, a.bounds).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.detach", |state, _: ()| async move {
        embedded::detach(&state).await?;
        Ok::<_, RpcError>(())
    });

    r.add("mpv.state", |state, _: ()| async move {
        embedded::ensure_platform()?;
        Ok::<_, RpcError>(embedded::state(&state))
    });
}
