//! Watched lookups (Run 2 contract C4). A movie or series is watched when it
//! has an item-level `playback_positions` row (`episode_id = ''`) with
//! `watched = 1`; Run 1's `WatchlistEntry.watched` shares the definition.
//!
//! Movies get the row by finishing (`position_set` at [`super::COMPLETE_RATIO`])
//! or by "Mark as watched". A series gets it by "Mark series as watched"
//! (`userstate.setWatched` without an episode id), and also when an episode
//! write leaves every episode the provider lists watched ([`sync_series_mark`],
//! the same rule as the detail page's `seriesWatchedWrite`): finishing the last
//! episode in the player, a mark from Recently watched or the remote.
//! Unmarking any episode clears the series row. The VOD grids read this for
//! the tick on posters (`positions.watchedContains`, one call per loaded
//! page), and "Hide watched" filters the same rows in SQL
//! ([`crate::catalog::vodfilter`]).

use crate::error::{CoreError, CoreResult, RpcError};
use crate::model::{ContentType, ItemRef};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// Most refs one `positions.watchedContains` call may ask about.
pub const MAX_REFS: usize = 500;

/// Longest wait for a series' episode list from the provider when a watched
/// episode may complete the series (the list is usually cached from the
/// detail page; after a long episode it may have expired).
const EPISODE_LIST_TIMEOUT: Duration = Duration::from_secs(4);

/// What an episode write did to its episode, for [`sync_series_mark`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpisodeMark {
    /// The episode is now watched (finished, or marked).
    Watched,
    /// The episode was marked unwatched.
    Unmarked,
}

/// Keeps a series' own watched row in step with its episodes after a write
/// to episode `episode_id` of `r`: once every episode the provider lists is
/// watched the series row is set (the poster tick and "Hide watched"), and
/// unmarking an episode clears it. Not a series, or the episode list cannot
/// be had (provider down, too slow): nothing changes. Errors are the
/// database's only.
pub async fn sync_series_mark(
    state: &Arc<AppState>,
    r: &ItemRef,
    episode_id: &str,
    mark: EpisodeMark,
) -> CoreResult<()> {
    if r.content_type != ContentType::Series || episode_id.trim().is_empty() {
        return Ok(());
    }
    let key = r.clone();
    if mark == EpisodeMark::Unmarked {
        return state
            .db_call(move |c| {
                c.execute(
                    "DELETE FROM playback_positions
                     WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3
                       AND episode_id = '' AND watched = 1",
                    params![key.source_id, key.content_type.as_str(), key.item_id],
                )?;
                Ok(())
            })
            .await;
    }
    let (kind, marked) = state
        .db_call(move |c| {
            let kind: Option<String> = c
                .query_row(
                    "SELECT kind FROM sources WHERE id = ?1",
                    [&key.source_id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok((
                kind,
                !watched_contains(c, std::slice::from_ref(&key))?.is_empty(),
            ))
        })
        .await?;
    if marked {
        return Ok(());
    }
    let Some(ids) = episode_ids(state, r, kind.as_deref()).await else {
        return Ok(());
    };
    let key = r.clone();
    state
        .db_call(move |c| {
            if all_watched(c, &key, &ids)? {
                super::set_watched(c, &key, None, true)?;
            }
            Ok(())
        })
        .await
}

/// True when `ids` is not empty and every one has a watched episode row.
fn all_watched(conn: &Connection, r: &ItemRef, ids: &[String]) -> CoreResult<bool> {
    if ids.is_empty() {
        return Ok(false);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT episode_id FROM playback_positions
         WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id <> '' AND watched = 1",
    )?;
    let watched = stmt
        .query_map(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(ids.iter().all(|id| watched.contains(id)))
}

/// Every episode id the provider lists for series `r` (a source of `kind`),
/// from the in-memory series cache when it has it, else from the provider
/// within [`EPISODE_LIST_TIMEOUT`]; for an m3u source, from the series row.
/// `None` when unknown.
async fn episode_ids(
    state: &Arc<AppState>,
    r: &ItemRef,
    kind: Option<&str>,
) -> Option<Vec<String>> {
    let seasons = match kind? {
        "xtream" => {
            let rt = crate::xtream::meta::runtime(state);
            match crate::xtream::meta::cached_series(&rt, &r.source_id, &r.item_id) {
                Some(raw) => crate::xtream::service::build_seasons(r, &raw),
                None => {
                    let detail = tokio::time::timeout(
                        EPISODE_LIST_TIMEOUT,
                        crate::xtream::service::series_detail(state, r),
                    )
                    .await
                    .ok()?
                    .ok()?;
                    if detail.provider_details_unavailable {
                        return None;
                    }
                    detail.seasons
                }
            }
        }
        "stalker" => {
            tokio::time::timeout(
                EPISODE_LIST_TIMEOUT,
                crate::stalker::vod::series_detail(state, r),
            )
            .await
            .ok()?
            .ok()?
            .seasons
        }
        // The importer stored the episodes in the series row.
        "m3u" => crate::m3u::series::series_detail(state, r).await.ok()?.seasons,
        _ => return None,
    };
    let ids: Vec<String> = seasons
        .into_iter()
        .flat_map(|s| s.episodes.into_iter().map(|e| e.id))
        .collect();
    (!ids.is_empty()).then_some(ids)
}

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
