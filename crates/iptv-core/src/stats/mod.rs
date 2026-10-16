//! Watch statistics (Run 2 contract C7): seconds watched per day and item in
//! `watch_log` (migration `0016_watch_log.sql`), reported by the UI's
//! `useWatchStatsReporter` and summarised for the stats page.
//!
//! Recording: the reporter sends one `stats.record` per flush (at most every
//! 30 s, on source change, on stop and on pagehide) with the client-local day
//! at flush time. [`record`] adds the seconds to the `(day, ref)` row and
//! refreshes its title and poster snapshot. A row never holds more than a
//! day's worth of seconds ([`MAX_DAY_SECONDS`]), so two windows reporting the
//! same item cannot push a day past 24 h. Episodes count under their series
//! ref, because `PlayerSource.ref` is the series ref.
//!
//! Days are client-local dates (`YYYY-MM-DD`). The core only checks that a
//! recorded day lies within [`DAY_SLACK`] days of its own UTC date, which
//! covers every time zone and a midnight flush that arrives late.
//!
//! Retention: rows older than [`RETENTION_DAYS`] days (by the core's UTC
//! date) are pruned at init and on the first `stats.record` of each UTC day.
//! Removing a source removes its rows through `ON DELETE CASCADE`.
//!
//! Summary: [`summary`] returns exactly 7 or 30 zero-filled days ending at
//! the client's `today`, split into live (live + radio) and VOD (movie +
//! series) seconds, plus the top channels and titles of that range. The top
//! lists follow parental hide mode (contract C2 of Run 1): while it is active,
//! locked titles and channels, and those in locked or adult categories, are
//! left out of them. The per-day totals still count every second, so the
//! chart stays honest without naming what was watched. Channel renames (Run 2
//! C2) apply to top channel titles.
//!
//! The functions here are synchronous and take a `&Connection` so the backup
//! module can call [`export_log`] / [`import_log`] inside its own
//! transaction; the RPC layer ([`rpc`]) runs them through
//! [`AppState::db_call`]. There is no change event: the stats page refetches
//! on focus and every 60 s, and `stats.clear` invalidates locally.

pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ItemRef};
use crate::parental::Hide;
use crate::state::AppState;
use crate::userstate::{normalize_ts_str, now_ts};
use chrono::{Days, NaiveDate, Utc};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;

/// Most seconds one `stats.record` call may add (the reporter flushes at
/// least every 30 s, so this leaves room for a slow flush).
pub const MAX_RECORD_SECONDS: i64 = 300;
/// A recorded day must lie within this many days of the core's UTC date.
pub const DAY_SLACK: i64 = 2;
/// Rows whose day is more than this many days before the core's UTC date
/// are pruned.
pub const RETENTION_DAYS: u64 = 90;
/// A row never holds more seconds than a day has.
pub const MAX_DAY_SECONDS: i64 = 86_400;
/// Longest accepted title, in characters, after trimming.
pub const MAX_TITLE_CHARS: usize = 300;
/// Longest accepted `sourceId` / `itemId`, in characters.
pub const MAX_ID_CHARS: usize = 2_048;
/// Poster URLs longer than this are dropped (the row keeps no poster).
pub const MAX_URL_CHARS: usize = 4_096;
/// The ranges `stats.summary` accepts, in days.
pub const SUMMARY_RANGES: [u32; 2] = [7, 30];
/// Top list length when `stats.summary` gets no `top`.
pub const TOP_DEFAULT: i64 = 10;
/// Longest accepted top list.
pub const TOP_MAX: i64 = 50;

/// One watch log row in a backup file (per-entry `userState.tsrustWatchLog`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchLogBackup {
    pub day: String,
    pub content_type: ContentType,
    pub item_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    pub seconds: i64,
    pub last_at: String,
}

/// One day of [`WatchStats`]; `seconds = live_seconds + vod_seconds`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatsDay {
    pub day: String,
    pub seconds: i64,
    pub live_seconds: i64,
    pub vod_seconds: i64,
}

/// One channel or title in a top list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatsTop {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    pub seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
}

/// `stats.summary` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStats {
    /// Oldest first; the last entry is `today`.
    pub days: Vec<WatchStatsDay>,
    pub total_seconds: i64,
    /// Live and radio.
    pub top_channels: Vec<WatchStatsTop>,
    /// Movies and series.
    pub top_titles: Vec<WatchStatsTop>,
}

// ---------------------------------------------------------------------------
// Validation and cleaning
// ---------------------------------------------------------------------------

/// Parses a strict `YYYY-MM-DD` date (zero-padded, a real calendar day).
pub fn parse_day(field: &str, s: &str) -> CoreResult<NaiveDate> {
    let bad = || CoreError::invalid(format!("{field} must be a date written YYYY-MM-DD"));
    let b = s.as_bytes();
    let shape = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !shape {
        return Err(bad());
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| bad())
}

/// `YYYY-MM-DD` of a date, as stored in `watch_log.day`.
pub fn fmt_day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// The core's UTC date.
pub fn utc_today() -> NaiveDate {
    Utc::now().date_naive()
}

/// The oldest day [`prune`] keeps, given the core's UTC date.
pub fn oldest_kept(today_utc: NaiveDate) -> NaiveDate {
    today_utc
        .checked_sub_days(Days::new(RETENTION_DAYS))
        .unwrap_or(NaiveDate::MIN)
}

/// Content types counted as live time (the rest is VOD).
pub fn is_live(ct: ContentType) -> bool {
    matches!(ct, ContentType::Live | ContentType::Radio)
}

fn validate_ref(r: &ItemRef) -> CoreResult<()> {
    if r.source_id.trim().is_empty() || r.item_id.trim().is_empty() {
        return Err(CoreError::invalid(
            "ref.sourceId and ref.itemId are required",
        ));
    }
    if r.source_id.chars().count() > MAX_ID_CHARS || r.item_id.chars().count() > MAX_ID_CHARS {
        return Err(CoreError::invalid(format!(
            "ref.sourceId and ref.itemId must be at most {MAX_ID_CHARS} characters"
        )));
    }
    Ok(())
}

fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((end, _)) => s[..end].trim_end().to_string(),
        None => s.to_string(),
    }
}

/// A trimmed, non-blank poster URL short enough to load; anything else is
/// dropped rather than cut, since a cut URL never loads.
fn clean_poster(p: Option<&str>) -> Option<String> {
    p.map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= MAX_URL_CHARS)
        .map(str::to_string)
}

/// Maps a foreign-key failure (unknown source) to `NotFound`.
fn map_fk(err: rusqlite::Error, source_id: &str) -> CoreError {
    if let rusqlite::Error::SqliteFailure(e, _) = &err {
        if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY {
            return CoreError::not_found(format!("source {source_id} does not exist"));
        }
    }
    CoreError::Db(err)
}

fn parse_ref(row: &Row<'_>, base: usize) -> rusqlite::Result<ItemRef> {
    let source_id: String = row.get(base)?;
    let ct: String = row.get(base + 1)?;
    let item_id: String = row.get(base + 2)?;
    let content_type = ContentType::from_str(&ct).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            base + 1,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            )),
        )
    })?;
    Ok(ItemRef {
        source_id,
        content_type,
        item_id,
    })
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// One `stats.record` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record<'a> {
    pub item_ref: &'a ItemRef,
    pub title: &'a str,
    pub poster_url: Option<&'a str>,
    pub seconds: i64,
    pub day: &'a str,
}

/// Validates a record against the core's UTC date `today_utc`.
///
/// `seconds` must be 1..=[`MAX_RECORD_SECONDS`], `day` a `YYYY-MM-DD` date
/// within [`DAY_SLACK`] days of `today_utc`, the trimmed title 1..=
/// [`MAX_TITLE_CHARS`] characters, and the ref non-blank. Any of those
/// failing is `invalid`. Returns the trimmed title.
pub fn validate_record<'a>(rec: &Record<'a>, today_utc: NaiveDate) -> CoreResult<&'a str> {
    validate_ref(rec.item_ref)?;
    if !(1..=MAX_RECORD_SECONDS).contains(&rec.seconds) {
        return Err(CoreError::invalid(format!(
            "seconds must be a whole number from 1 to {MAX_RECORD_SECONDS}"
        )));
    }
    let day = parse_day("day", rec.day)?;
    if (day - today_utc).num_days().abs() > DAY_SLACK {
        return Err(CoreError::invalid(format!(
            "day must be within {DAY_SLACK} days of today ({})",
            fmt_day(today_utc)
        )));
    }
    let title = rec.title.trim();
    let chars = title.chars().count();
    if chars == 0 || chars > MAX_TITLE_CHARS {
        return Err(CoreError::invalid(format!(
            "title must be 1 to {MAX_TITLE_CHARS} characters"
        )));
    }
    Ok(title)
}

/// Adds `rec.seconds` to the `(day, ref)` row (creating it), capped at
/// [`MAX_DAY_SECONDS`], and refreshes the title, the poster (kept when the
/// record carries none) and `last_at`. Validation as [`validate_record`];
/// an unknown source is `not_found`.
pub fn record(conn: &Connection, rec: &Record<'_>, today_utc: NaiveDate) -> CoreResult<()> {
    let title = validate_record(rec, today_utc)?;
    let r = rec.item_ref;
    conn.prepare_cached(
        "INSERT INTO watch_log(day, source_id, content_type, item_id, title, poster_url, seconds, last_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(day, source_id, content_type, item_id) DO UPDATE SET
           seconds = MIN(watch_log.seconds + excluded.seconds, ?9),
           title = excluded.title,
           poster_url = COALESCE(excluded.poster_url, watch_log.poster_url),
           last_at = excluded.last_at",
    )?
    .execute(params![
        rec.day,
        r.source_id,
        r.content_type.as_str(),
        r.item_id,
        title,
        clean_poster(rec.poster_url),
        rec.seconds,
        now_ts(),
        MAX_DAY_SECONDS
    ])
    .map_err(|e| map_fk(e, &r.source_id))?;
    Ok(())
}

/// Deletes rows older than [`RETENTION_DAYS`] days before `today_utc`;
/// returns how many went.
pub fn prune(conn: &Connection, today_utc: NaiveDate) -> CoreResult<usize> {
    Ok(conn.execute(
        "DELETE FROM watch_log WHERE day < ?1",
        [fmt_day(oldest_kept(today_utc))],
    )?)
}

/// Deletes every row; returns how many went.
pub fn clear(conn: &Connection) -> CoreResult<usize> {
    Ok(conn.execute("DELETE FROM watch_log", [])?)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Checks `days` (7 or 30) and `top` (1..=[`TOP_MAX`], default
/// [`TOP_DEFAULT`]) and parses `today`; `invalid` otherwise.
pub fn validate_summary(days: u32, today: &str, top: Option<i64>) -> CoreResult<(NaiveDate, i64)> {
    if !SUMMARY_RANGES.contains(&days) {
        return Err(CoreError::invalid("days must be 7 or 30"));
    }
    let today = parse_day("today", today)?;
    let top = top.unwrap_or(TOP_DEFAULT);
    if !(1..=TOP_MAX).contains(&top) {
        return Err(CoreError::invalid(format!(
            "top must be from 1 to {TOP_MAX}"
        )));
    }
    Ok((today, top))
}

/// The stats page summary: `days` (7 or 30) zero-filled days ending at the
/// client's `today`, oldest first; the total of that range; and the top
/// `top` channels (live + radio) and titles (movie + series) of the range,
/// by seconds descending, then title. `hide` is parental hide mode
/// ([`crate::parental::hide_filter`]); it narrows only the top lists (see
/// the module docs).
pub fn summary(
    conn: &Connection,
    days: u32,
    today: &str,
    top: Option<i64>,
    hide: Option<Hide>,
) -> CoreResult<WatchStats> {
    let (today, top) = validate_summary(days, today, top)?;
    let first = today
        .checked_sub_days(Days::new(u64::from(days) - 1))
        .ok_or_else(|| CoreError::invalid("today is out of range"))?;
    let (from, to) = (fmt_day(first), fmt_day(today));

    let mut per_day = std::collections::HashMap::<String, (i64, i64)>::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT day,
                    COALESCE(SUM(CASE WHEN content_type IN ('live', 'radio') THEN seconds END), 0),
                    COALESCE(SUM(CASE WHEN content_type IN ('movie', 'series') THEN seconds END), 0)
             FROM watch_log WHERE day >= ?1 AND day <= ?2 GROUP BY day",
        )?;
        let rows = stmt.query_map([&from, &to], |row| {
            Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
        })?;
        for row in rows {
            let (day, live, vod) = row?;
            per_day.insert(day, (live, vod));
        }
    }
    let days: Vec<WatchStatsDay> = first
        .iter_days()
        .take_while(|d| *d <= today)
        .map(|d| {
            let day = fmt_day(d);
            let (live_seconds, vod_seconds) = per_day.get(&day).copied().unwrap_or((0, 0));
            WatchStatsDay {
                day,
                seconds: live_seconds + vod_seconds,
                live_seconds,
                vod_seconds,
            }
        })
        .collect();
    let total_seconds = days.iter().map(|d| d.seconds).sum();

    let mut top_channels = top_items(conn, &from, &to, "'live', 'radio'", top, hide)?;
    for t in &mut top_channels {
        if let Some(name) = crate::channeledit::custom_name(conn, &t.item_ref)? {
            t.title = name;
        }
    }
    let top_titles = top_items(conn, &from, &to, "'movie', 'series'", top, hide)?;
    Ok(WatchStats {
        days,
        total_seconds,
        top_channels,
        top_titles,
    })
}

/// The `limit` items of the given content types with the most seconds in
/// `from..=to`. Title and poster come from the item's latest row in the
/// range; a missing poster falls back to the item's latest poster anywhere
/// in the log, then to the catalog's poster or logo.
fn top_items(
    conn: &Connection,
    from: &str,
    to: &str,
    types: &str,
    limit: i64,
    hide: Option<Hide>,
) -> CoreResult<Vec<WatchStatsTop>> {
    let locked = match hide {
        Some(h) => crate::parental::filter::by_ref(conn, "w", h)?,
        None => String::new(),
    };
    // With a single MAX() aggregate, SQLite takes the bare `title` and
    // `poster_url` columns from the row holding that maximum: the latest one.
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT g.source_id, g.content_type, g.item_id, g.title, g.total,
                COALESCE(
                  g.poster,
                  (SELECT x.poster_url FROM watch_log x
                    WHERE x.source_id = g.source_id AND x.content_type = g.content_type
                      AND x.item_id = g.item_id AND x.poster_url IS NOT NULL
                    ORDER BY x.last_at DESC LIMIT 1),
                  NULLIF(i.poster_url, ''),
                  NULLIF(i.logo_url, '')),
                s.name
         FROM (
           SELECT w.source_id, w.content_type, w.item_id, SUM(w.seconds) AS total,
                  MAX(w.last_at) AS latest, w.title AS title, w.poster_url AS poster
           FROM watch_log w
           WHERE w.day >= ?1 AND w.day <= ?2 AND w.content_type IN ({types}){locked}
           GROUP BY w.source_id, w.content_type, w.item_id
         ) g
         LEFT JOIN items i
           ON i.source_id = g.source_id AND i.content_type = g.content_type AND i.item_id = g.item_id
         LEFT JOIN sources s ON s.id = g.source_id
         WHERE g.total > 0
         ORDER BY g.total DESC, g.title COLLATE NOCASE ASC, g.title ASC, g.source_id, g.item_id
         LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![from, to, limit], |row| {
        Ok(WatchStatsTop {
            item_ref: parse_ref(row, 0)?,
            title: row.get(3)?,
            seconds: row.get(4)?,
            poster_url: row.get(5)?,
            source_name: row
                .get::<_, Option<String>>(6)?
                .filter(|n| !n.trim().is_empty()),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/// Every watch log row of a source, for `backup.export`, by day, then
/// content type and item id.
pub fn export_log(conn: &Connection, source_id: &str) -> CoreResult<Vec<WatchLogBackup>> {
    let mut stmt = conn.prepare_cached(
        "SELECT day, content_type, item_id, title, poster_url, seconds, last_at
         FROM watch_log WHERE source_id = ?1
         ORDER BY day, content_type, item_id",
    )?;
    let rows = stmt.query_map([source_id], |row| {
        let ct: String = row.get(1)?;
        let content_type = ContentType::from_str(&ct).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    e.to_string(),
                )),
            )
        })?;
        Ok(WatchLogBackup {
            day: row.get(0)?,
            content_type,
            item_id: row.get(2)?,
            title: row.get(3)?,
            poster_url: row.get(4)?,
            seconds: row.get(5)?,
            last_at: crate::db::to_rfc3339(&row.get::<_, String>(6)?),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// What [`import_log`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LogImport {
    /// Rows inserted or changed.
    pub written: usize,
    /// Rows refused by the checks listed on [`import_log`].
    pub skipped: usize,
}

/// Stores backup rows for `source_id` (the entry's source on this install)
/// and returns how many rows were inserted or changed and how many were
/// skipped.
///
/// - Per `(day, ref)` the larger `seconds` wins, so importing the same file
///   twice changes nothing the second time (and writes 0; that is not a
///   skip).
/// - The title and poster follow whichever side has the later `lastAt`; a
///   missing poster is filled from the other side.
/// - Skipped without failing the import: a day that is not `YYYY-MM-DD`, is
///   older than the retention window or later than [`DAY_SLACK`] days after
///   today (a live record could not have it either), a blank or over-long
///   item id, a blank title, and `seconds <= 0`. The item id is stored
///   trimmed, as it was checked. Seconds above a day's worth are capped; titles are cut
///   to [`MAX_TITLE_CHARS`]; an unreadable `lastAt` becomes the import time.
/// - An unknown `source_id` is `not_found`.
///
/// Runs inside a savepoint: on error nothing is changed, and it nests inside
/// the caller's transaction.
pub fn import_log(
    conn: &Connection,
    source_id: &str,
    rows: &[WatchLogBackup],
) -> CoreResult<LogImport> {
    conn.execute_batch("SAVEPOINT stats_import")?;
    match import_inner(conn, source_id, rows) {
        Ok(n) => {
            conn.execute_batch("RELEASE stats_import")?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO stats_import; RELEASE stats_import");
            Err(e)
        }
    }
}

fn import_inner(
    conn: &Connection,
    source_id: &str,
    rows: &[WatchLogBackup],
) -> CoreResult<LogImport> {
    let mut out = LogImport::default();
    if rows.is_empty() {
        return Ok(out);
    }
    if !conn
        .prepare_cached("SELECT 1 FROM sources WHERE id = ?1")?
        .exists([source_id])?
    {
        return Err(CoreError::not_found(format!(
            "source {source_id} does not exist"
        )));
    }
    let today = utc_today();
    let oldest = oldest_kept(today);
    let newest = today
        .checked_add_days(Days::new(DAY_SLACK as u64))
        .unwrap_or(NaiveDate::MAX);
    let mut upsert = conn.prepare_cached(
        "INSERT INTO watch_log(day, source_id, content_type, item_id, title, poster_url, seconds, last_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(day, source_id, content_type, item_id) DO UPDATE SET
           seconds = MAX(watch_log.seconds, excluded.seconds),
           title = CASE WHEN excluded.last_at > watch_log.last_at THEN excluded.title ELSE watch_log.title END,
           poster_url = CASE WHEN excluded.last_at > watch_log.last_at
                             THEN COALESCE(excluded.poster_url, watch_log.poster_url)
                             ELSE COALESCE(watch_log.poster_url, excluded.poster_url) END,
           last_at = MAX(watch_log.last_at, excluded.last_at)
         WHERE excluded.seconds > watch_log.seconds
            OR excluded.last_at > watch_log.last_at
            OR (watch_log.poster_url IS NULL AND excluded.poster_url IS NOT NULL)",
    )?;
    for row in rows {
        let Ok(day) = parse_day("day", &row.day) else {
            out.skipped += 1;
            continue;
        };
        if day < oldest || day > newest || row.seconds <= 0 {
            out.skipped += 1;
            continue;
        }
        let item_id = row.item_id.trim();
        if item_id.is_empty() || item_id.chars().count() > MAX_ID_CHARS {
            out.skipped += 1;
            continue;
        }
        let title = row.title.trim();
        if title.is_empty() {
            out.skipped += 1;
            continue;
        }
        let last_at = normalize_ts_str(&row.last_at).unwrap_or_else(now_ts);
        out.written += upsert.execute(params![
            fmt_day(day),
            source_id,
            row.content_type.as_str(),
            item_id,
            cut(title, MAX_TITLE_CHARS),
            clean_poster(row.poster_url.as_deref()),
            row.seconds.min(MAX_DAY_SECONDS),
            last_at
        ])?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// The UTC date of the last prune, so `stats.record` prunes once per day.
#[derive(Debug, Default)]
pub(crate) struct PruneMark(parking_lot::Mutex<Option<NaiveDate>>);

impl PruneMark {
    /// True when no prune has run yet on `today`.
    pub(crate) fn due(&self, today: NaiveDate) -> bool {
        *self.0.lock() != Some(today)
    }

    pub(crate) fn set(&self, today: NaiveDate) {
        *self.0.lock() = Some(today);
    }
}

/// Extension key of the [`PruneMark`].
pub(crate) const PRUNE_MARK_EXT: &str = "stats.pruneMark";

pub(crate) fn prune_mark(state: &AppState) -> Arc<PruneMark> {
    state.ext_or_insert_with(PRUNE_MARK_EXT, || Arc::new(PruneMark::default()))
}

/// Starts the module: prunes rows older than [`RETENTION_DAYS`] days. Called
/// from [`crate::rpc::init_all`].
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let today = utc_today();
    let n = state.db_call(move |c| prune(c, today)).await?;
    prune_mark(&state).set(today);
    if n > 0 {
        tracing::debug!(rows = n, "pruned old watch log rows");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::db::migrate(&mut c).unwrap();
        c.execute(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s1', 'xtream', 'One', '{}')",
            [],
        )
        .unwrap();
        c
    }

    fn d(s: &str) -> NaiveDate {
        parse_day("day", s).unwrap()
    }

    #[test]
    fn parse_day_is_strict() {
        assert_eq!(
            d("2026-10-14"),
            NaiveDate::from_ymd_opt(2026, 10, 14).unwrap()
        );
        for bad in [
            "",
            "2026-1-14",
            "2026-10-4",
            "2026/10/14",
            "2026-02-30",
            "20261014",
            " 2026-10-14",
            "2026-10-14T00:00",
            "２０２６-10-14",
        ] {
            assert!(parse_day("day", bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn backup_row_and_summary_are_camel_case() {
        let row = WatchLogBackup {
            day: "2026-10-14".into(),
            content_type: ContentType::Live,
            item_id: "7".into(),
            title: "BBC One".into(),
            poster_url: None,
            seconds: 90,
            last_at: "2026-10-14T08:00:00.000Z".into(),
        };
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!(
            v,
            json!({"day": "2026-10-14", "contentType": "live", "itemId": "7", "title": "BBC One",
                   "seconds": 90, "lastAt": "2026-10-14T08:00:00.000Z"})
        );
        assert_eq!(serde_json::from_value::<WatchLogBackup>(v).unwrap(), row);

        let top = WatchStatsTop {
            item_ref: ItemRef::new("s1", ContentType::Movie, "9"),
            title: "Heat".into(),
            poster_url: None,
            seconds: 5,
            source_name: Some("One".into()),
        };
        assert_eq!(
            serde_json::to_value(&top).unwrap(),
            json!({"ref": {"sourceId": "s1", "contentType": "movie", "itemId": "9"},
                   "title": "Heat", "seconds": 5, "sourceName": "One"})
        );
    }

    #[test]
    fn record_caps_a_row_at_one_day_and_keeps_the_poster() {
        let c = conn();
        let today = d("2026-10-14");
        let r = ItemRef::new("s1", ContentType::Live, "7");
        let rec = |title: &'static str, poster: Option<&'static str>| Record {
            item_ref: &r,
            title,
            poster_url: poster,
            seconds: 300,
            day: "2026-10-14",
        };
        record(&c, &rec("BBC", Some("http://logo")), today).unwrap();
        for _ in 0..400 {
            record(&c, &rec(" BBC One ", None), today).unwrap();
        }
        let (secs, title, poster): (i64, String, Option<String>) = c
            .query_row(
                "SELECT seconds, title, poster_url FROM watch_log",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(secs, MAX_DAY_SECONDS);
        assert_eq!(title, "BBC One", "the latest title, trimmed");
        assert_eq!(poster.as_deref(), Some("http://logo"), "kept when absent");
    }

    #[test]
    fn prune_keeps_exactly_the_retention_window() {
        let c = conn();
        let today = d("2026-10-14");
        for day in ["2026-07-15", "2026-07-16", "2026-10-14"] {
            c.execute(
                "INSERT INTO watch_log(day, source_id, content_type, item_id, title, seconds, last_at)
                 VALUES (?1, 's1', 'movie', '1', 'T', 10, '2026-10-14T00:00:00.000Z')",
                [day],
            )
            .unwrap();
        }
        assert_eq!(oldest_kept(today), d("2026-07-16"));
        assert_eq!(prune(&c, today).unwrap(), 1);
        let days: Vec<String> = c
            .prepare("SELECT day FROM watch_log ORDER BY day")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(days, ["2026-07-16", "2026-10-14"]);
    }

    #[test]
    fn import_rolls_back_on_error_and_nests_in_a_transaction() {
        let mut c = conn();
        let row = WatchLogBackup {
            day: fmt_day(utc_today()),
            content_type: ContentType::Movie,
            item_id: "1".into(),
            title: "Heat".into(),
            poster_url: None,
            seconds: 60,
            last_at: "2026-10-14T00:00:00.000Z".into(),
        };
        let tx = c.transaction().unwrap();
        assert_eq!(
            import_log(&tx, "s1", std::slice::from_ref(&row)).unwrap(),
            LogImport {
                written: 1,
                skipped: 0
            }
        );
        tx.rollback().unwrap();
        assert!(export_log(&c, "s1").unwrap().is_empty());

        c.execute_batch("ALTER TABLE watch_log RENAME TO watch_log_old")
            .unwrap();
        assert!(import_log(&c, "s1", &[row]).is_err());
        c.execute_batch("ALTER TABLE watch_log_old RENAME TO watch_log")
            .unwrap();
        assert!(c.is_autocommit(), "no savepoint is left open");
    }
}
