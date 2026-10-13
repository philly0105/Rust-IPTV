//! `epg.shortEpg` and `catchup.programs` (guide slice).

use crate::error::RpcError;
use crate::model::ItemRef;
use crate::rpc::RpcRouter;
use serde::Deserialize;

/// Commands this module registers.
pub const COMMANDS: &[&str] = &["epg.shortEpg", "catchup.programs"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortEpgArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgramsArgs {
    #[serde(rename = "ref")]
    item_ref: ItemRef,
    from: String,
    to: String,
}

pub fn register(r: &mut RpcRouter) {
    r.add("epg.shortEpg", |s, a: ShortEpgArgs| async move {
        super::short_epg(&s, &a.item_ref, a.limit)
            .await
            .map_err(RpcError::from)
    });
    r.add("catchup.programs", |s, a: ProgramsArgs| async move {
        super::programs(&s, &a.item_ref, &a.from, &a.to)
            .await
            .map_err(RpcError::from)
    });
}
