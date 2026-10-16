//! `channels.*` RPC commands (Run 2 contract C2). A write that changes a
//! row emits [`super::CHANGED_EVENT`] once per source it touched; a no-op
//! (hiding a hidden channel, renaming to the current name, resetting a
//! source with no edits) emits nothing.

use super::ChannelEdit;
use crate::error::RpcError;
use crate::model::ItemRef;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;
use serde_json::json;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &[
    "channels.edits",
    "channels.setHidden",
    "channels.rename",
    "channels.reset",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditsArgs {
    source_id: String,
    #[serde(default)]
    hidden_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetHiddenArgs {
    refs: Vec<ItemRef>,
    hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    /// `null` (or a missing key) and `""` reset to the provider name.
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceArgs {
    source_id: String,
}

fn changed(state: &AppState, source_id: &str) {
    state.emit(super::CHANGED_EVENT, json!({ "sourceId": source_id }));
}

/// Registers every `channels.*` command.
pub fn register(r: &mut RpcRouter) {
    r.add("channels.edits", |state, a: EditsArgs| async move {
        let v = state
            .db_call(move |c| super::list(c, &a.source_id, a.hidden_only))
            .await?;
        Ok::<Vec<ChannelEdit>, RpcError>(v)
    });
    r.add("channels.setHidden", |state, a: SetHiddenArgs| async move {
        let sources = state
            .db_call(move |c| super::set_hidden(c, &a.refs, a.hidden))
            .await?;
        for s in &sources {
            changed(&state, s);
        }
        Ok::<(), RpcError>(())
    });
    r.add("channels.rename", |state, a: RenameArgs| async move {
        let source_id = a.item_ref.source_id.clone();
        let (row, did) = state
            .db_call(move |c| super::rename(c, &a.item_ref, a.name.as_deref()))
            .await?;
        if did {
            changed(&state, &source_id);
        }
        Ok::<Option<ChannelEdit>, RpcError>(row)
    });
    r.add("channels.reset", |state, a: SourceArgs| async move {
        let source_id = a.source_id.clone();
        let n = state
            .db_call(move |c| super::reset(c, &a.source_id))
            .await?;
        if n > 0 {
            changed(&state, &source_id);
        }
        Ok::<(), RpcError>(())
    });
}
