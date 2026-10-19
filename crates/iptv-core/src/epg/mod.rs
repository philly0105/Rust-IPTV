//! EPG: XMLTV ingestion, storage, channel resolution and guide queries (SPEC C4 epg, C3 epg tables).
//!
//! - [`xmltv`]: streaming quick-xml parser (gzip, entities, CDATA, offsets, missing stop).
//! - [`fetch`]: remote download to a temp file (source headers, ETag), local paths, gzip sniffing.
//! - [`store`]: `epg_*` tables, staging + atomic swap per url, configured-url merge.
//! - [`ingest`]: refresh of one url, background runtime (per-url lock, 2 at once), scheduler.
//! - [`resolve`]: item -> XMLTV channel id (manual > item id > name).
//! - [`query`]: now/next, programme ranges, grid, channel search.
//!
//! See `docs/architecture/epg.md`.

pub mod fetch;
pub mod ingest;
pub mod query;
pub mod resolve;
pub mod rpc;
// guide: programme search over an FTS5 index (Run 2 C5).
pub mod search;
pub mod store;
pub mod xmltv;

pub use ingest::{refresh_now, runtime, spawn_refresh, EpgRuntime, IngestStats};
pub use query::ChannelMatch;
pub use resolve::{Resolution, Via};
pub use search::{GuideSearchHit, SearchRequest};

use crate::error::{CoreError, CoreResult};
use crate::model::{EpgNowNext, EpgProgram, EpgSourceStatus, ItemRef};
use crate::state::AppState;
use rusqlite::params;
use std::collections::HashMap;
use std::sync::Arc;

/// Most refs accepted by `epg.nowNext` / `epg.grid` in one call.
pub const MAX_REFS: usize = 2_000;
/// Default and maximum `epg.channelsSearch` result sizes.
pub const SEARCH_DEFAULT_LIMIT: usize = 50;
pub const SEARCH_MAX_LIMIT: usize = 500;

/// Starts the EPG runtime: cleans leftovers of an interrupted import, then
/// refreshes never-fetched or stale (> 12 h) enabled urls 10 s after boot and
/// keeps checking every 30 s (newly added urls, failed urls after 30 min).
///
/// A guide search index missing at startup (a database upgraded to
/// migration 0015) is built in the background ([`search`]).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    ingest::start(state.clone(), ingest::BOOT_DELAY).await?;
    search::spawn_startup_build(&state);
    Ok(())
}

/// `epg.sources`: every configured url with its status.
pub async fn sources(state: &AppState) -> CoreResult<Vec<EpgSourceStatus>> {
    let settings = state.settings_snapshot().epg_urls;
    state
        .db_call(move |c| {
            let configured = store::configured_urls(c, &settings)?;
            store::list_status(c, &configured)
        })
        .await
}

/// `epg.refresh`: one url (must be configured) or every enabled url, in the background.
pub async fn refresh(state: Arc<AppState>, url: Option<String>) -> CoreResult<()> {
    match url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        Some(url) => {
            if ingest::configured(&state, &url).await?.is_none() {
                return Err(CoreError::NotFound(
                    "this EPG URL is not configured; add it in Settings > EPG or to a source"
                        .into(),
                ));
            }
            ingest::spawn_refresh(state, &url);
        }
        None => {
            ingest::spawn_refresh_all(state).await?;
        }
    }
    Ok(())
}

fn check_refs(refs: &[ItemRef]) -> CoreResult<()> {
    if refs.len() > MAX_REFS {
        return Err(CoreError::Invalid(format!(
            "at most {MAX_REFS} refs per call, got {}",
            refs.len()
        )));
    }
    Ok(())
}

/// Resolves each ref once, sharing the directory snapshot: its XMLTV
/// channel id and guide shift in seconds ([`query::item_shift`]).
fn resolve_many(
    conn: &rusqlite::Connection,
    rt: &EpgRuntime,
    refs: &[ItemRef],
) -> CoreResult<Vec<Option<(String, i64)>>> {
    let dir = resolve::directory(conn, rt)?;
    let mut source_shifts = HashMap::new();
    refs.iter()
        .map(|r| match resolve::resolve(conn, &dir, r)?.epg_channel_id {
            Some(id) => {
                let source = query::cached_source_shift(conn, &mut source_shifts, &r.source_id)?;
                Ok(Some((id, query::item_shift_with(conn, r, source)?)))
            }
            None => Ok(None),
        })
        .collect()
}

/// Largest `epg.nowNext` `offsetMinutes` accepted (the `epgOffsetMinutes` setting range).
pub const MAX_OFFSET_MINUTES: i32 = 720;

/// `epg.nowNext`: keyed by `ItemRef::key()`; refs without EPG map to `{}`.
pub async fn now_next(
    state: &AppState,
    refs: Vec<ItemRef>,
) -> CoreResult<HashMap<String, EpgNowNext>> {
    now_next_with_offset(state, refs, 0).await
}

/// `epg.nowNext` with `offsetMinutes` (`settings.epgOffsetMinutes`): the UI shows every
/// programme moved by the offset, so the one airing on screen is the one the raw guide has
/// airing at `now - offset`. Programmes come back without that offset; the UI shifts them for
/// display. A channel's own `tvg-shift` is applied here, in nowNext, programs and grid alike.
pub async fn now_next_with_offset(
    state: &AppState,
    refs: Vec<ItemRef>,
    offset_minutes: i32,
) -> CoreResult<HashMap<String, EpgNowNext>> {
    now_next_opts(state, refs, offset_minutes, true).await
}

/// [`now_next_with_offset`]; `with_description: false` leaves programme
/// descriptions out (`epg.nowNext {withDescription: false}`: lists that never
/// show them get about half the bytes).
pub async fn now_next_opts(
    state: &AppState,
    refs: Vec<ItemRef>,
    offset_minutes: i32,
    with_description: bool,
) -> CoreResult<HashMap<String, EpgNowNext>> {
    check_refs(&refs)?;
    if !(-MAX_OFFSET_MINUTES..=MAX_OFFSET_MINUTES).contains(&offset_minutes) {
        return Err(CoreError::Invalid(format!(
            "offsetMinutes must be between -{MAX_OFFSET_MINUTES} and {MAX_OFFSET_MINUTES}, got {offset_minutes}"
        )));
    }
    let rt = runtime(state);
    let now = chrono::Utc::now().timestamp() - i64::from(offset_minutes) * 60;
    state
        .db_call(move |c| {
            let ids = resolve_many(c, &rt, &refs)?;
            let mut cache: HashMap<(String, i64), EpgNowNext> = HashMap::new();
            let mut out = HashMap::with_capacity(refs.len());
            for (r, id) in refs.iter().zip(ids) {
                let nn = match id {
                    Some(key) => match cache.get(&key) {
                        Some(v) => v.clone(),
                        None => {
                            let v = query::now_next_with(c, &key.0, now, key.1, with_description)?;
                            cache.insert(key, v.clone());
                            v
                        }
                    },
                    None => EpgNowNext::default(),
                };
                out.insert(r.key(), nn);
            }
            Ok(out)
        })
        .await
}

/// `epg.programs`: programmes of one ref overlapping `[from, to)`.
pub async fn programs(
    state: &AppState,
    r: ItemRef,
    from: &str,
    to: &str,
) -> CoreResult<Vec<EpgProgram>> {
    let (f, t) = query::parse_range(from, to)?;
    let rt = runtime(state);
    state
        .db_call(move |c| {
            let id = resolve_many(c, &rt, std::slice::from_ref(&r))?
                .pop()
                .flatten();
            match id {
                Some((id, shift)) => query::programs(c, &id, f, t, shift),
                None => Ok(Vec::new()),
            }
        })
        .await
}

/// `epg.grid`: programmes per ref overlapping `[from, to)`.
pub async fn grid(
    state: &AppState,
    refs: Vec<ItemRef>,
    from: &str,
    to: &str,
) -> CoreResult<HashMap<String, Vec<EpgProgram>>> {
    grid_opts(state, refs, from, to, true).await
}

/// [`grid`]; `with_description: false` leaves programme descriptions out
/// (`epg.grid {withDescription: false}`: the guide shows one description, the
/// selected programme's, and fetches it with `epg.programs`).
pub async fn grid_opts(
    state: &AppState,
    refs: Vec<ItemRef>,
    from: &str,
    to: &str,
    with_description: bool,
) -> CoreResult<HashMap<String, Vec<EpgProgram>>> {
    check_refs(&refs)?;
    let (f, t) = query::parse_range(from, to)?;
    let rt = runtime(state);
    state
        .db_call(move |c| {
            let ids = resolve_many(c, &rt, &refs)?;
            let mut cache: HashMap<(String, i64), Vec<EpgProgram>> = HashMap::new();
            let mut out = HashMap::with_capacity(refs.len());
            for (r, id) in refs.iter().zip(ids) {
                let list = match id {
                    Some(key) => match cache.get(&key) {
                        Some(v) => v.clone(),
                        None => {
                            let v = query::programs_with(c, &key.0, f, t, key.1, with_description)?;
                            cache.insert(key, v.clone());
                            v
                        }
                    },
                    None => Vec::new(),
                };
                out.insert(r.key(), list);
            }
            Ok(out)
        })
        .await
}

/// `epg.channelsSearch`.
pub async fn channels_search(
    state: &AppState,
    query: String,
    limit: Option<usize>,
) -> CoreResult<Vec<ChannelMatch>> {
    let limit = limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);
    state
        .db_call(move |c| query::channels_search(c, &query, limit))
        .await
}

fn ensure_source(conn: &rusqlite::Connection, source_id: &str) -> CoreResult<()> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM sources WHERE id = ?1", [source_id], |_| {
            Ok(true)
        })
        .unwrap_or(false);
    if exists {
        Ok(())
    } else {
        Err(CoreError::NotFound(format!("source {source_id} not found")))
    }
}

/// `epg.setMapping`: manual override; `None` = explicitly no EPG.
pub async fn set_mapping(
    state: &AppState,
    r: ItemRef,
    epg_channel_id: Option<String>,
) -> CoreResult<()> {
    let id = epg_channel_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    state
        .db_write(move |c| {
            ensure_source(c, &r.source_id)?;
            c.execute(
                "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET epg_channel_id = excluded.epg_channel_id",
                params![r.source_id, r.content_type.as_str(), r.item_id, id],
            )?;
            Ok(())
        })
        .await?;
    state.emit("epg.changed", serde_json::json!({}));
    Ok(())
}

/// `epg.clearMapping`: back to automatic resolution.
pub async fn clear_mapping(state: &AppState, r: ItemRef) -> CoreResult<()> {
    state
        .db_write(move |c| {
            c.execute(
                "DELETE FROM epg_channel_map WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                params![r.source_id, r.content_type.as_str(), r.item_id],
            )?;
            Ok(())
        })
        .await?;
    state.emit("epg.changed", serde_json::json!({}));
    Ok(())
}

/// `epg.setChannelShift`: the channel's own guide shift in minutes, used
/// instead of its `tvg-shift` (its source's shift still adds to it); `None`
/// removes it. At most [`query::MAX_SHIFT_MINUTES`] either way.
pub async fn set_channel_shift(
    state: &AppState,
    r: ItemRef,
    minutes: Option<i32>,
) -> CoreResult<()> {
    if let Some(m) = minutes {
        query::check_shift_minutes(m)?;
    }
    state
        .db_write(move |c| {
            ensure_source(c, &r.source_id)?;
            match minutes {
                Some(m) => c.execute(
                    "INSERT INTO epg_channel_shift(source_id, content_type, item_id, shift_minutes) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET shift_minutes = excluded.shift_minutes",
                    params![r.source_id, r.content_type.as_str(), r.item_id, m],
                )?,
                None => c.execute(
                    "DELETE FROM epg_channel_shift WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                    params![r.source_id, r.content_type.as_str(), r.item_id],
                )?,
            };
            Ok(())
        })
        .await?;
    state.emit("epg.changed", serde_json::json!({}));
    Ok(())
}

/// `epg.resolve`, with the channel's own guide shift (`shiftMinutes`).
pub async fn resolve_ref(state: &AppState, r: ItemRef) -> CoreResult<Resolution> {
    let rt = runtime(state);
    state
        .db_call(move |c| {
            let dir = resolve::directory(c, &rt)?;
            let mut res = resolve::resolve(c, &dir, &r)?;
            res.shift_minutes = query::channel_shift_minutes(c, &r)?;
            Ok(res)
        })
        .await
}

/// `epg.setEnabled`. Enabling a url that has no data yet starts a refresh.
pub async fn set_enabled(state: Arc<AppState>, url: String, enabled: bool) -> CoreResult<()> {
    let url = url.trim().to_string();
    let cfg = ingest::configured(&state, &url).await?.ok_or_else(|| {
        CoreError::NotFound(
            "this EPG URL is not configured; add it in Settings > EPG or to a source".into(),
        )
    })?;
    let needs_data = state
        .db_call(move |c| {
            store::set_enabled(c, &cfg, enabled)?;
            Ok(store::source_row(c, &cfg.url)?
                .is_none_or(|r| r.program_count == 0 && r.status != "fetching"))
        })
        .await?;
    runtime(&state).bump();
    state.emit("epg.changed", serde_json::json!({}));
    if enabled && needs_data {
        ingest::spawn_refresh(state, &url);
    }
    Ok(())
}
