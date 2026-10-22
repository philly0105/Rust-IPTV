//! Provider guide fallback and catch-up archive support.
//!
//! - `epg.shortEpg`: an Xtream channel's now/next from the panel
//!   (`get_short_epg`), for channels without XMLTV programmes. Cached per
//!   `(source, stream)`, deduplicated and rate-limited; empty when the
//!   `epgShortFallback` setting is off or the source is not Xtream. Like
//!   `catchup.programs`, moved by the channel's guide shift
//!   ([`crate::epg::channel_shift`]) after the cache.
//! - `catchup.table`: an Xtream channel's full archive table
//!   (`get_simple_data_table`), for reuse across the guide timeline.
//! - `catchup.programs`: the same table filtered to a time range, for the
//!   archive browser when XMLTV has nothing for that day.
//! - [`m3u`]: the per-source M3U catch-up override and URL builder.

pub mod cache;
pub mod m3u;
pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, EpgProgram, ItemRef, SourceKind};
use crate::state::AppState;
use cache::ProgramCache;
use std::sync::Arc;
use std::time::Duration;

/// How long a short-EPG answer is reused (it also expires when it has ended).
pub const SHORT_EPG_TTL: Duration = Duration::from_secs(20 * 60);
/// Programmes asked from the panel per short-EPG call; callers slice it.
pub const SHORT_EPG_FETCH: i64 = 10;
/// Most programmes returned by `epg.shortEpg`.
pub const SHORT_EPG_MAX: usize = 10;
/// How long an archive table is reused.
pub const ARCHIVE_TTL: Duration = Duration::from_secs(20 * 60);

const EXT_KEY: &str = "catchup_runtime";

pub struct Runtime {
    pub short: ProgramCache,
    pub archive: ProgramCache,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            // Three panel calls at a time across every source; a visible list
            // of 30 rows fills in a few seconds without flooding the panel.
            short: ProgramCache::new(SHORT_EPG_TTL, 3, 4000, true),
            archive: ProgramCache::new(ARCHIVE_TTL, 2, 200, false),
        }
    }
}

pub fn runtime(state: &AppState) -> Arc<Runtime> {
    state.ext_or_insert_with::<Runtime>(EXT_KEY, || Arc::new(Runtime::default()))
}

/// Drops every cached short-EPG and archive answer of a source: its server
/// or account changed (stream ids may now mean other channels), or it was
/// removed or replaced by a restore. No-op before the runtime exists.
pub fn forget_source(state: &AppState, source_id: &str) {
    if let Some(rt) = state.ext::<Runtime>(EXT_KEY) {
        rt.short.forget_source(source_id);
        rt.archive.forget_source(source_id);
    }
}

async fn source_kind(state: &Arc<AppState>, source_id: &str) -> CoreResult<Option<SourceKind>> {
    let id = source_id.to_string();
    state
        .db_call(move |c| Ok(crate::sources::store::find(c, &id)?.map(|s| s.kind)))
        .await
}

fn secs(iso: &str) -> Option<i64> {
    crate::xtream::meta::parse_instant(iso).map(|d| d.timestamp())
}

/// The panel's programmes for an Xtream channel that have not ended yet on
/// the guide clock (at most `limit`, default 4). Empty when the fallback is
/// off or the channel is not on an Xtream source.
///
/// The guide clock is `now - epgOffsetMinutes`: with a positive offset the UI
/// shows as airing a programme that ended up to that long ago in real time,
/// so it must still be returned.
pub async fn short_epg(
    state: &Arc<AppState>,
    r: &ItemRef,
    limit: Option<usize>,
) -> CoreResult<Vec<EpgProgram>> {
    if !state.settings_snapshot().epg_short_fallback
        || !matches!(r.content_type, ContentType::Live | ContentType::Radio)
        || source_kind(state, &r.source_id).await? != Some(SourceKind::Xtream)
    {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(4).clamp(1, SHORT_EPG_MAX);
    let key = (r.source_id.clone(), r.item_id.clone());
    let list = runtime(state)
        .short
        .get_or_fetch(key, || {
            crate::xtream::service::short_epg(state, r, Some(SHORT_EPG_FETCH))
        })
        .await?;
    // The channel's guide shift moves the panel's programmes (the cache keeps
    // them as the panel sent them) before the guide clock picks.
    let shift = crate::epg::channel_shift(state, r).await?;
    let list: Vec<EpgProgram> = list
        .iter()
        .cloned()
        .map(|p| crate::epg::shifted(p, shift))
        .collect();
    let offset = i64::from(state.settings_snapshot().epg_offset_minutes);
    Ok(not_ended(
        &list,
        chrono::Utc::now().timestamp(),
        offset,
        limit,
    ))
}

/// The first `limit` programmes still airing or upcoming at `now - offset`.
fn not_ended(list: &[EpgProgram], now: i64, offset_minutes: i64, limit: usize) -> Vec<EpgProgram> {
    let guide_now = now - offset_minutes.clamp(-720, 720) * 60;
    list.iter()
        .filter(|p| secs(&p.end).is_some_and(|e| e > guide_now))
        .take(limit)
        .cloned()
        .collect()
}

/// The panel's complete archive table for an Xtream live channel, with its
/// channel guide shift applied. Empty for other source kinds.
pub async fn table(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<Vec<EpgProgram>> {
    if r.content_type != ContentType::Live
        || source_kind(state, &r.source_id).await? != Some(SourceKind::Xtream)
    {
        return Ok(Vec::new());
    }
    let key = (r.source_id.clone(), r.item_id.clone());
    let list = runtime(state)
        .archive
        .get_or_fetch(key, || crate::xtream::service::simple_data_table(state, r))
        .await?;
    // Moved by the channel's guide shift before the range picks.
    let shift = crate::epg::channel_shift(state, r).await?;
    Ok(list
        .iter()
        .cloned()
        .map(|p| crate::epg::shifted(p, shift))
        .collect())
}

/// The panel's archive programmes of an Xtream live channel overlapping
/// `[from, to)`. Empty for other source kinds.
pub async fn programs(
    state: &Arc<AppState>,
    r: &ItemRef,
    from: &str,
    to: &str,
) -> CoreResult<Vec<EpgProgram>> {
    let (Some(from), Some(to)) = (secs(from), secs(to)) else {
        return Err(CoreError::invalid("from and to must be ISO dates"));
    };
    if to <= from {
        return Err(CoreError::invalid("to must be after from"));
    }
    Ok(table(state, r)
        .await?
        .into_iter()
        .filter(
            |p| matches!((secs(&p.start), secs(&p.end)), (Some(s), Some(e)) if e > from && s < to),
        )
        .collect())
}

#[cfg(test)]
mod offset_tests {
    use super::*;

    fn prog(start: &str, end: &str) -> EpgProgram {
        EpgProgram {
            channel_id: "c".into(),
            start: start.into(),
            end: end.into(),
            title: start.into(),
            description: None,
            category: None,
            icon: None,
        }
    }

    #[test]
    fn a_positive_offset_keeps_the_programme_the_guide_shows_as_airing() {
        let list = [
            prog("2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z"),
            prog("2026-10-12T10:00:00Z", "2026-10-12T11:00:00Z"),
            prog("2026-10-12T11:00:00Z", "2026-10-12T12:00:00Z"),
        ];
        // Real now 10:10; with +30 min the guide clock reads 09:40.
        let now = secs("2026-10-12T10:10:00Z").unwrap();
        let shifted = not_ended(&list, now, 30, 4);
        assert_eq!(
            shifted.len(),
            3,
            "the 09:00 programme still airs on the guide clock"
        );
        assert_eq!(shifted[0].start, "2026-10-12T09:00:00Z");
        let plain = not_ended(&list, now, 0, 4);
        assert_eq!(plain[0].start, "2026-10-12T10:00:00Z");
        // A negative offset moves the guide clock forward.
        let ahead = not_ended(&list, now, -60, 4);
        assert_eq!(ahead[0].start, "2026-10-12T11:00:00Z");
        assert_eq!(not_ended(&list, now, 30, 1).len(), 1);
    }
}
