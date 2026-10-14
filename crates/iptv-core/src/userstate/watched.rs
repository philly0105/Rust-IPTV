//! Watched lookups (Run 2 contract C4). A movie or series is watched when it
//! has an item-level `playback_positions` row (`episode_id = ''`) with
//! `watched = 1`; Run 1's `WatchlistEntry.watched` shares the definition.
//!
//! Movies get the row by finishing (`position_set` at [`super::COMPLETE_RATIO`])
//! or by "Mark as watched"; a series only by "Mark series as watched"
//! (`userstate.setWatched` without an episode id). Watched episodes never make
//! their series watched. The VOD grids read this for the tick on posters
//! (`positions.watchedContains`, one call per loaded page), and "Hide watched"
//! filters the same rows in SQL ([`crate::catalog::vodfilter`]).

use crate::error::{CoreError, CoreResult, RpcError};
use crate::model::ItemRef;
use crate::rpc::RpcRouter;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::HashSet;

/// Most refs one `positions.watchedContains` call may ask about.
pub const MAX_REFS: usize = 500;

/// Refs among the input that are watched, in input order with duplicates
/// collapsed (1..=500 refs at the RPC).
pub fn watched_contains(conn: &Connection, refs: &[ItemRef]) -> CoreResult<Vec<ItemRef>> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM playback_positions WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = '' AND watched = 1",
    )?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in refs {
        if !seen.insert(r) {
            continue;
        }
        if stmt.exists(params![r.source_id, r.content_type.as_str(), r.item_id])? {
            out.push(r.clone());
        }
    }
    Ok(out)
}

/// [`ItemRef::key`] strings of the watched refs among the input.
pub fn watched_set(conn: &Connection, refs: &[ItemRef]) -> CoreResult<HashSet<String>> {
    Ok(watched_contains(conn, refs)?
        .iter()
        .map(ItemRef::key)
        .collect())
}

/// 1..=[`MAX_REFS`] refs, else invalid.
pub fn validate_refs(refs: &[ItemRef]) -> CoreResult<()> {
    if refs.is_empty() {
        return Err(CoreError::Invalid(
            "positions.watchedContains needs at least one ref".into(),
        ));
    }
    if refs.len() > MAX_REFS {
        return Err(CoreError::Invalid(format!(
            "positions.watchedContains takes at most {MAX_REFS} refs, got {}",
            refs.len()
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Refs {
    refs: Vec<ItemRef>,
}

/// Registers `positions.watchedContains`.
pub fn register(r: &mut RpcRouter) {
    r.add("positions.watchedContains", |state, a: Refs| async move {
        validate_refs(&a.refs)?;
        let v = state.db_call(move |c| watched_contains(c, &a.refs)).await?;
        Ok::<Vec<ItemRef>, RpcError>(v)
    });
}
