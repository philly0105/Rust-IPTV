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
    Ok(match cached_table(state, r).await? {
        Some((list, shift)) => select(&list, shift, None),
        None => Vec::new(),
    })
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
    Ok(match cached_table(state, r).await? {
        Some((list, shift)) => select(&list, shift, Some((from, to))),
        None => Vec::new(),
    })
}

/// The cached archive table of an Xtream live channel (as the panel sent
/// it) and the channel's guide shift in seconds; `None` for other kinds.
async fn cached_table(
    state: &Arc<AppState>,
    r: &ItemRef,
) -> CoreResult<Option<(Arc<Vec<EpgProgram>>, i64)>> {
    if r.content_type != ContentType::Live
        || source_kind(state, &r.source_id).await? != Some(SourceKind::Xtream)
    {
        return Ok(None);
    }
    let key = (r.source_id.clone(), r.item_id.clone());
    let list = runtime(state)
        .archive
        .get_or_fetch(key, || crate::xtream::service::simple_data_table(state, r))
        .await?;
    let shift = crate::epg::channel_shift(state, r).await?;
    Ok(Some((list, shift)))
}

/// The programmes of a cached table overlapping `range` (all of them
/// without one), moved by the channel's guide `shift` before the range
/// picks. Each programme is matched by reference on the times it will have
/// once moved ([`shifted_secs`]), and only the ones kept are cloned and
/// moved: cloning and moving the whole table (up to 5000 programmes with
/// descriptions) for a one-day range threw nearly all of it away (R2-3).
fn select(list: &[EpgProgram], shift: i64, range: Option<(i64, i64)>) -> Vec<EpgProgram> {
    list.iter()
        .filter(|p| {
            range.is_none_or(|(from, to)| {
                matches!(
                    (shifted_secs(&p.start, shift), shifted_secs(&p.end, shift)),
                    (Some(s), Some(e)) if e > from && s < to
                )
            })
        })
        .map(|p| crate::epg::shifted(p.clone(), shift))
        .collect()
}

/// [`secs`] of `time` once [`crate::epg::shifted`] has moved it by `shift`,
/// without writing the moved string: an RFC 3339 time moves (and is read
/// back as the same instant in the years RFC 3339 can write, else through
/// the string `shifted` writes), anything else stays as it is.
fn shifted_secs(time: &str, shift: i64) -> Option<i64> {
    if shift == 0 {
        return secs(time);
    }
    match chrono::DateTime::parse_from_rfc3339(time.trim()) {
        Ok(t) => {
            let moved = t.timestamp().saturating_add(shift);
            match chrono::DateTime::from_timestamp(moved, 0) {
                Some(d) if (0..=9999).contains(&chrono::Datelike::year(&d)) => Some(moved),
                _ => secs(&crate::epg::query::to_rfc3339(moved)),
            }
        }
        Err(_) => secs(time),
    }
}

#[cfg(test)]
mod offset_tests {
    use super::*;

    pub(super) fn prog(start: &str, end: &str) -> EpgProgram {
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

#[cfg(test)]
mod select_tests {
    use super::offset_tests::prog;
    use super::*;

    /// The table answer before R2-3: every programme cloned and moved.
    fn table_before(list: &[EpgProgram], shift: i64) -> Vec<EpgProgram> {
        list.iter()
            .cloned()
            .map(|p| crate::epg::shifted(p, shift))
            .collect()
    }

    /// The programs answer before R2-3: the moved table, then the range.
    fn programs_before(list: &[EpgProgram], shift: i64, from: i64, to: i64) -> Vec<EpgProgram> {
        table_before(list, shift)
            .into_iter()
            .filter(|p| {
                matches!((secs(&p.start), secs(&p.end)), (Some(s), Some(e)) if e > from && s < to)
            })
            .collect()
    }

    /// R2-3: picking by reference before cloning gives byte-identical
    /// answers to moving the whole table first, for every shift and range,
    /// including times `shifted` leaves alone (unix seconds, other text),
    /// other offsets, padding, and a move past the year 9999.
    #[test]
    fn select_matches_moving_the_whole_table_first() {
        let list: Vec<EpgProgram> = [
            ("2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z"),
            ("2026-10-12T10:00:00Z", "2026-10-12T11:30:00Z"),
            ("2026-10-12T13:00:00+02:00", "2026-10-12T14:00:00+02:00"),
            (" 2026-10-12T12:00:00Z ", "2026-10-12T12:45:00Z"),
            ("1791801000", "1791804600"),
            ("2026-10-12T15:00:00Z", "1791824400"),
            ("soon", "2026-10-12T16:00:00Z"),
            ("2026-10-12T16:00:00Z", "later"),
            ("9999-12-31T22:00:00Z", "9999-12-31T23:30:00Z"),
            ("0000-01-01T01:00:00Z", "0000-01-01T02:00:00Z"),
        ]
        .iter()
        .map(|(s, e)| prog(s, e))
        .collect();
        let day = secs("2026-10-12T00:00:00Z").unwrap();
        let h = 3600;
        let ranges = [
            (day, day + 86_400),
            (day + 9 * h, day + 10 * h),
            (day + 10 * h + 1, day + 11 * h),
            (day + 11 * h, day + 12 * h),
            (day + 15 * h, day + 17 * h),
            (secs("9999-12-31T00:00:00Z").unwrap(), i64::MAX),
            (i64::MIN, secs("0001-01-01T00:00:00Z").unwrap()),
            (i64::MIN, i64::MAX),
        ];
        for shift in [0, h, -90 * 60, 12 * h, -12 * h, 3 * h] {
            assert_eq!(
                select(&list, shift, None),
                table_before(&list, shift),
                "table, shift {shift}"
            );
            for (from, to) in ranges {
                assert_eq!(
                    select(&list, shift, Some((from, to))),
                    programs_before(&list, shift, from, to),
                    "shift {shift}, range {from}..{to}"
                );
            }
        }
        // The pick is not empty for the cases that matter.
        assert_eq!(
            select(&list, h, Some((day + 10 * h, day + 11 * h))).len(),
            2
        );
    }
}
