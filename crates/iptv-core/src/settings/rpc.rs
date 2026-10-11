//! `settings.*` and `window.*` RPC commands (SPEC C4).

use crate::error::RpcError;
use crate::model::{Settings, WindowState};
use crate::player::DetectedPlayers;
use crate::rpc::RpcRouter;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateArgs {
    patch: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetWindowArgs {
    state: WindowState,
}

/// Registers `settings.get|update|reset|detectPlayers` and `window.getState|setState`.
pub fn register(r: &mut RpcRouter) {
    r.add("settings.get", |state, _: ()| async move {
        Ok::<Settings, RpcError>(super::get(&state))
    });
    r.add("settings.update", |state, a: UpdateArgs| async move {
        Ok::<Settings, RpcError>(super::update(&state, a.patch).await?)
    });
    r.add("settings.reset", |state, _: ()| async move {
        Ok::<Settings, RpcError>(super::reset(&state).await?)
    });
    r.add("settings.detectPlayers", |state, _: ()| async move {
        // Detection stats files and may walk PATH: keep it off the async workers.
        let found = tokio::task::spawn_blocking(move || super::detect_players(&state))
            .await
            .map_err(|e| RpcError::internal(format!("player detection failed: {e}")))?;
        Ok::<DetectedPlayers, RpcError>(found)
    });
    r.add("window.getState", |state, _: ()| async move {
        Ok::<Option<WindowState>, RpcError>(super::window_state(&state).await?)
    });
    r.add("window.setState", |state, a: SetWindowArgs| async move {
        super::set_window_state(&state, a.state).await?;
        Ok::<(), RpcError>(())
    });
}
