//! `userstate` module (B2): favorites, recently viewed, and playback positions.
//!
//! Storage is the C3 tables `favorites`, `recent`, and `playback_positions`.
//! Each row is keyed by an [`ItemRef`] (plus `episode_id` for positions) and
//! carries an [`ItemSnapshot`] as JSON so lists render without joining the
//! catalog, and survive a catalog refresh that drops the item.
//!
//! The functions here are synchronous and take a `&Connection` so the backup
//! module can reuse them inside its own transactions; the RPC layer
//! (`rpc.rs`) runs them through [`AppState::db_call`].
//!
//! Timestamps are written as RFC 3339 UTC with millisecond precision
//! (`2026-10-11T02:30:00.123Z`) so lexical order equals time order even for
//! several writes in the same second.

pub mod rpc;
// vod: watched lookups for posters and "Hide watched" (Run 2 C4).
pub mod watched;

use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, FavoriteEntry, ItemRef, ItemSnapshot, PlaybackPosition, RecentEntry,
};
use crate::parental::Hide;
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::Value;
use std::str::FromStr;
use std::sync::Arc;

/// Recent entries kept per source; older ones are trimmed on insert.
pub const RECENT_CAP_PER_SOURCE: i64 = 200;
/// A position at or beyond this fraction of the duration counts as finished:
/// the row becomes a watched row at the end of the item (see [`position_set`]).
pub const COMPLETE_RATIO: f64 = 0.95;
/// Default and maximum `recent.list` page.
pub const RECENT_DEFAULT_LIMIT: i64 = 100;
pub const RECENT_MAX_LIMIT: i64 = 1000;
/// Default and maximum `positions.continueWatching` size.
pub const CONTINUE_DEFAULT_LIMIT: i64 = 20;
pub const CONTINUE_MAX_LIMIT: i64 = 200;

// ---------------------------------------------------------------------------
// Time helpers (shared with backup)
// ---------------------------------------------------------------------------

/// Current UTC time, RFC 3339 with milliseconds.
///
/// Strictly increasing within the process: two calls in the same millisecond
/// get consecutive milliseconds, so "newest first" lists (recent, positions,
/// continue watching) never tie on a live write. Rows that still tie (imported
/// timestamps) fall back to `rowid DESC`.
pub fn now_ts() -> String {
    static LAST_MS: parking_lot::Mutex<i64> = parking_lot::Mutex::new(0);
    let ms = {
        let mut last = LAST_MS.lock();
        let ms = chrono::Utc::now().timestamp_millis().max(*last + 1);
        *last = ms;
        ms
    };
    chrono::DateTime::from_timestamp_millis(ms)
        .map(fmt_ts)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn fmt_ts(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Normalizes a timestamp from untrusted input (backup files, old rows) to the
/// stored format. Accepts RFC 3339, SQLite `YYYY-MM-DD HH:MM:SS[.fff]` (UTC),
/// and unix time as number or numeric string (seconds, or milliseconds when
/// larger than 1e11). Returns `None` when nothing usable is found.
pub fn normalize_ts(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => n.as_f64().and_then(from_unix),
        Value::String(s) => normalize_ts_str(s),
        _ => None,
    }
}

/// String form of [`normalize_ts`].
pub fn normalize_ts_str(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(fmt_ts(dt.with_timezone(&chrono::Utc)));
    }
    for f in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Some(fmt_ts(dt.and_utc()));
        }
    }
    s.parse::<f64>().ok().and_then(from_unix)
}

fn from_unix(n: f64) -> Option<String> {
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let ms = if n > 1e11 { n } else { n * 1000.0 } as i64;
    chrono::DateTime::from_timestamp_millis(ms).map(fmt_ts)
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

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

/// Parses a stored snapshot. Unknown keys (backup provenance such as
/// `portalItem`) are ignored; unreadable JSON falls back to a minimal snapshot.
fn parse_snapshot(json: Option<&str>, r: &ItemRef) -> Option<ItemSnapshot> {
    let json = json?;
    match serde_json::from_str::<ItemSnapshot>(json) {
        Ok(s) => Some(s),
        Err(_) => Some(fallback_snapshot(r)),
    }
}

fn fallback_snapshot(r: &ItemRef) -> ItemSnapshot {
    ItemSnapshot {
        title: r.item_id.clone(),
        subtitle: None,
        poster_url: None,
        content_type: r.content_type,
    }
}

fn validate_ref(r: &ItemRef) -> CoreResult<()> {
    if r.source_id.trim().is_empty() || r.item_id.trim().is_empty() {
        return Err(CoreError::invalid(
            "ref.sourceId and ref.itemId are required",
        ));
    }
    Ok(())
}

fn validate_snapshot(s: &ItemSnapshot) -> CoreResult<()> {
    if s.title.trim().is_empty() {
        return Err(CoreError::invalid("snapshot.title is required"));
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

/// Favorites ordered by `position`, then `added_at`. `source_id = None` lists
/// all sources. Every stored row, as stored (reorder and backup use it).
pub fn favorites_list(
    conn: &Connection,
    source_id: Option<&str>,
) -> CoreResult<Vec<FavoriteEntry>> {
    favorites_read(conn, source_id, None, false)
}

/// The `favorites.list` reader: [`favorites_list`] without the entries
/// parental hide mode drops (`hide`) and without channels hidden by a
/// channel edit, with custom channel names in the snapshot titles (C2).
pub fn favorites_list_filtered(
    conn: &Connection,
    source_id: Option<&str>,
    hide: Option<Hide>,
) -> CoreResult<Vec<FavoriteEntry>> {
    favorites_read(conn, source_id, hide, true)
}

fn favorites_read(
    conn: &Connection,
    source_id: Option<&str>,
    hide: Option<Hide>,
    edits: bool,
) -> CoreResult<Vec<FavoriteEntry>> {
    let locked = match hide {
        Some(h) => crate::parental::filter::by_ref(conn, "f", h)?,
        None => String::new(),
    };
    let edited = if edits {
        crate::channeledit::by_ref(conn, "f")?
    } else {
        String::new()
    };
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT f.source_id, f.content_type, f.item_id, f.added_at, f.position, f.snapshot_json
         FROM favorites f WHERE (?1 IS NULL OR f.source_id = ?1){locked}{edited}
         ORDER BY f.position ASC, f.added_at ASC, f.rowid ASC"
    ))?;
    let rows = stmt.query_map(params![source_id], |row| {
        let r = parse_ref(row, 0)?;
        let added_at: String = row.get(3)?;
        let position: i64 = row.get(4)?;
        let snap: String = row.get(5)?;
        Ok((r, added_at, position, snap))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (r, added_at, position, snap) = row?;
        let snapshot = parse_snapshot(Some(&snap), &r).unwrap_or_else(|| fallback_snapshot(&r));
        out.push(FavoriteEntry {
            item_ref: r,
            added_at: crate::db::to_rfc3339(&added_at),
            position,
            snapshot,
        });
    }
    if edits {
        crate::channeledit::apply_snapshot_names(
            conn,
            out.iter_mut().map(|e| (&e.item_ref, &mut e.snapshot)),
        )?;
    }
    Ok(out)
}

/// True when `r` is a favorite.
pub fn is_favorite(conn: &Connection, r: &ItemRef) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT 1 FROM favorites WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .exists(params![r.source_id, r.content_type.as_str(), r.item_id])?)
}

/// Adds or updates a favorite with a raw snapshot JSON document. New rows go
/// to the end (`position = max + 1`) unless `position` is given; an existing
/// row keeps its position and `added_at` and gets the new snapshot.
/// Returns true when a new row was inserted.
pub fn favorite_upsert_json(
    conn: &Connection,
    r: &ItemRef,
    snapshot_json: &str,
    added_at: Option<&str>,
    position: Option<i64>,
) -> CoreResult<bool> {
    let existed = is_favorite(conn, r)?;
    if existed {
        conn.execute(
            "UPDATE favorites SET snapshot_json = ?4
             WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
            params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                snapshot_json
            ],
        )?;
        return Ok(false);
    }
    let position = match position {
        Some(p) => p,
        None => conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM favorites",
            [],
            |row| row.get(0),
        )?,
    };
    let added_at = added_at.map(str::to_string).unwrap_or_else(now_ts);
    // ON CONFLICT: a concurrent toggle may have inserted the row since the
    // check above (each RPC runs on its own pooled connection).
    conn.execute(
        "INSERT INTO favorites(source_id, content_type, item_id, added_at, position, snapshot_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET snapshot_json = excluded.snapshot_json",
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            added_at,
            position,
            snapshot_json
        ],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    Ok(true)
}

/// Toggles a favorite. Returns the new state (`true` = now a favorite).
///
/// The remove-or-insert runs in one IMMEDIATE transaction: two toggles of the
/// same ref on separate pooled connections then serialize, so one turns it on
/// and the other off instead of both reporting the same state.
pub fn favorite_toggle(
    conn: &mut Connection,
    r: &ItemRef,
    snapshot: &ItemSnapshot,
) -> CoreResult<bool> {
    validate_ref(r)?;
    let json = serde_json::to_string(snapshot)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = if favorite_remove(&tx, r)? {
        false
    } else {
        validate_snapshot(snapshot)?;
        favorite_upsert_json(&tx, r, &json, None, None)?;
        true
    };
    tx.commit()?;
    Ok(now)
}

/// Removes a favorite. Returns true when a row was deleted.
pub fn favorite_remove(conn: &Connection, r: &ItemRef) -> CoreResult<bool> {
    let n = conn.execute(
        "DELETE FROM favorites WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        params![r.source_id, r.content_type.as_str(), r.item_id],
    )?;
    Ok(n > 0)
}

/// The subset of `refs` that are favorites, in input order (duplicates collapsed).
pub fn favorites_contains(conn: &Connection, refs: &[ItemRef]) -> CoreResult<Vec<ItemRef>> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM favorites WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
    )?;
    let mut seen = std::collections::HashSet::new();
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

/// Rewrites `position` so `refs` appear in the given order. With `source_id`,
/// refs from other sources are ignored. Favorites `favorites.list` shows
/// (under `hide`) but `refs` leaves out follow the listed ones in their
/// previous order. Favorites it does not show (parental hide mode, a channel
/// hidden by a channel edit) and `refs` leaves out keep their slots, as
/// `lists.reorderItems` does, so they come back in place when shown again.
pub fn favorites_reorder(
    conn: &mut Connection,
    source_id: Option<&str>,
    refs: &[ItemRef],
    hide: Option<Hide>,
) -> CoreResult<()> {
    use std::collections::HashSet;
    // IMMEDIATE: it reads before it writes, and a DEFERRED transaction
    // fails with SQLITE_BUSY when another write commits in between.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let stored: Vec<ItemRef> = favorites_list(&tx, source_id)?
            .into_iter()
            .map(|f| f.item_ref)
            .collect();
        let shown: HashSet<ItemRef> = favorites_list_filtered(&tx, source_id, hide)?
            .into_iter()
            .map(|f| f.item_ref)
            .collect();
        let present: HashSet<&ItemRef> = stored.iter().collect();
        // A ref listed twice keeps its first place; refs that are not
        // favorites (or of another source) are ignored.
        let mut seen = HashSet::new();
        let listed: Vec<&ItemRef> = refs
            .iter()
            .filter(|r| present.contains(r))
            .filter(|r| seen.insert(*r))
            .collect();
        // The order the caller sees: the listed refs, then the other shown
        // favorites in their previous order.
        let moves = |r: &ItemRef| seen.contains(r) || shown.contains(r);
        let mut order = listed.iter().copied().chain(
            stored
                .iter()
                .filter(|r| !seen.contains(*r) && shown.contains(*r)),
        );
        let mut set = tx.prepare_cached(
            "UPDATE favorites SET position = ?4 WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?;
        for (i, slot) in stored.iter().enumerate() {
            let r = if moves(slot) {
                order.next().unwrap_or(slot)
            } else {
                slot
            };
            set.execute(params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                i as i64
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Recent
// ---------------------------------------------------------------------------

/// Recently viewed, newest first. Every stored row, as stored.
pub fn recent_list(
    conn: &Connection,
    source_id: Option<&str>,
    limit: Option<i64>,
) -> CoreResult<Vec<RecentEntry>> {
    recent_read(conn, source_id, limit, None, false)
}

/// The `recent.list` reader: [`recent_list`] without the entries parental
/// hide mode drops (`hide`) and without channels hidden by a channel edit,
/// with custom channel names in the snapshot titles (C2).
pub fn recent_list_filtered(
    conn: &Connection,
    source_id: Option<&str>,
    limit: Option<i64>,
    hide: Option<Hide>,
) -> CoreResult<Vec<RecentEntry>> {
    recent_read(conn, source_id, limit, hide, true)
}

fn recent_read(
    conn: &Connection,
    source_id: Option<&str>,
    limit: Option<i64>,
    hide: Option<Hide>,
    edits: bool,
) -> CoreResult<Vec<RecentEntry>> {
    let limit = limit
        .unwrap_or(RECENT_DEFAULT_LIMIT)
        .clamp(1, RECENT_MAX_LIMIT);
    let locked = match hide {
        Some(h) => crate::parental::filter::by_ref(conn, "r", h)?,
        None => String::new(),
    };
    let edited = if edits {
        crate::channeledit::by_ref(conn, "r")?
    } else {
        String::new()
    };
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT r.source_id, r.content_type, r.item_id, r.viewed_at, r.snapshot_json
         FROM recent r WHERE (?1 IS NULL OR r.source_id = ?1){locked}{edited}
         ORDER BY r.viewed_at DESC, r.rowid DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![source_id, limit], |row| {
        Ok((
            parse_ref(row, 0)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (r, viewed_at, snap) = row?;
        let snapshot = parse_snapshot(Some(&snap), &r).unwrap_or_else(|| fallback_snapshot(&r));
        out.push(RecentEntry {
            item_ref: r,
            viewed_at: crate::db::to_rfc3339(&viewed_at),
            snapshot,
        });
    }
    if edits {
        crate::channeledit::apply_snapshot_names(
            conn,
            out.iter_mut().map(|e| (&e.item_ref, &mut e.snapshot)),
        )?;
    }
    Ok(out)
}

/// Upserts a history row from imported data and trims the source's history
/// to [`RECENT_CAP_PER_SOURCE`]. An existing row keeps the newer timestamp;
/// without `viewed_at` a new row gets now and an existing row keeps its own,
/// so importing the same backup twice changes nothing.
pub fn recent_upsert_json(
    conn: &Connection,
    r: &ItemRef,
    snapshot_json: &str,
    viewed_at: Option<&str>,
) -> CoreResult<()> {
    let known = viewed_at.is_some();
    let viewed_at = viewed_at.map(str::to_string).unwrap_or_else(now_ts);
    conn.execute(
        "INSERT INTO recent(source_id, content_type, item_id, viewed_at, snapshot_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
           viewed_at = CASE WHEN ?6 THEN MAX(recent.viewed_at, excluded.viewed_at) ELSE recent.viewed_at END,
           snapshot_json = excluded.snapshot_json",
        params![r.source_id, r.content_type.as_str(), r.item_id, viewed_at, snapshot_json, known],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    recent_trim(conn, &r.source_id)?;
    Ok(())
}

/// Deletes all but the newest [`RECENT_CAP_PER_SOURCE`] entries of a source.
pub fn recent_trim(conn: &Connection, source_id: &str) -> CoreResult<usize> {
    Ok(conn.execute(
        "DELETE FROM recent WHERE source_id = ?1 AND rowid NOT IN (
           SELECT rowid FROM recent WHERE source_id = ?1
           ORDER BY viewed_at DESC, rowid DESC LIMIT ?2)",
        params![source_id, RECENT_CAP_PER_SOURCE],
    )?)
}

/// `recent.add`: records a view now.
pub fn recent_add(conn: &Connection, r: &ItemRef, snapshot: &ItemSnapshot) -> CoreResult<()> {
    recent_add_at(conn, r, snapshot, None)
}

/// How far in the future a caller-supplied `viewedAt` may be (clock skew
/// between the UI and the core); anything later is refused.
pub const VIEWED_AT_MAX_SKEW: chrono::Duration = chrono::Duration::days(1);

/// Parses a caller-supplied `viewedAt` (C7): strict RFC 3339 with an offset,
/// stored in UTC with milliseconds. Garbage and dates more than
/// [`VIEWED_AT_MAX_SKEW`] in the future are `Invalid`.
pub fn parse_viewed_at(raw: &str, field: &str) -> CoreResult<String> {
    let dt = chrono::DateTime::parse_from_rfc3339(raw.trim())
        .map_err(|_| {
            CoreError::invalid(format!(
                "{field} must be an RFC 3339 date and time (e.g. 2026-10-12T08:30:00Z), got {:?}",
                raw.chars().take(40).collect::<String>()
            ))
        })?
        .with_timezone(&chrono::Utc);
    if dt > chrono::Utc::now() + VIEWED_AT_MAX_SKEW {
        return Err(CoreError::invalid(format!("{field} is in the future")));
    }
    Ok(fmt_ts(dt))
}

/// `recent.add` with an optional `viewedAt` (C7): when present the entry
/// gets that time (Recent undo restores the original date); otherwise now.
/// Either way the stored time replaces the existing one.
pub fn recent_add_at(
    conn: &Connection,
    r: &ItemRef,
    snapshot: &ItemSnapshot,
    viewed_at: Option<&str>,
) -> CoreResult<()> {
    validate_ref(r)?;
    validate_snapshot(snapshot)?;
    // A fresh view always moves the entry to the top, even when an imported
    // timestamp was in the future: use plain replacement of viewed_at.
    let now = match viewed_at {
        Some(raw) => parse_viewed_at(raw, "viewedAt")?,
        None => now_ts(),
    };
    conn.execute(
        "INSERT INTO recent(source_id, content_type, item_id, viewed_at, snapshot_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
           viewed_at = excluded.viewed_at, snapshot_json = excluded.snapshot_json",
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            now,
            serde_json::to_string(snapshot)?
        ],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    recent_trim(conn, &r.source_id)?;
    Ok(())
}

/// Removes one recent entry.
pub fn recent_remove(conn: &Connection, r: &ItemRef) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM recent WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        params![r.source_id, r.content_type.as_str(), r.item_id],
    )?;
    Ok(())
}

/// Clears history for one source or all.
pub fn recent_clear(conn: &Connection, source_id: Option<&str>) -> CoreResult<usize> {
    Ok(conn.execute(
        "DELETE FROM recent WHERE (?1 IS NULL OR source_id = ?1)",
        params![source_id],
    )?)
}

// ---------------------------------------------------------------------------
// Playback positions
// ---------------------------------------------------------------------------

/// Input of [`position_set`].
#[derive(Debug, Clone)]
pub struct PositionInput {
    pub item_ref: ItemRef,
    pub episode_id: Option<String>,
    pub position_seconds: i64,
    pub duration_seconds: Option<i64>,
    /// Raw snapshot JSON; `None` keeps the stored snapshot.
    pub snapshot_json: Option<String>,
    /// Explicit timestamp (backup import, C14 undo); `None` = now. When set,
    /// an existing row is replaced only if this is newer.
    pub updated_at: Option<String>,
    /// Store the row as watched (backup import). `false` keeps the stored flag.
    pub watched: bool,
}

fn ep_key(episode_id: Option<&str>) -> &str {
    episode_id.map(str::trim).unwrap_or("")
}

fn position_from_row(row: &Row<'_>) -> rusqlite::Result<PlaybackPosition> {
    let r = parse_ref(row, 0)?;
    let ep: String = row.get(3)?;
    let snap: Option<String> = row.get(7)?;
    let snapshot = parse_snapshot(snap.as_deref(), &r);
    let updated_at: String = row.get(6)?;
    Ok(PlaybackPosition {
        episode_id: (!ep.is_empty()).then_some(ep),
        position_seconds: row.get(4)?,
        duration_seconds: row.get(5)?,
        updated_at: crate::db::to_rfc3339(&updated_at),
        snapshot,
        watched: row.get::<_, i64>(8)? != 0,
        item_ref: r,
    })
}

const POSITION_COLS: &str = "source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json, watched";

/// One saved position.
pub fn position_get(
    conn: &Connection,
    r: &ItemRef,
    episode_id: Option<&str>,
) -> CoreResult<Option<PlaybackPosition>> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {POSITION_COLS} FROM playback_positions
             WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = ?4"
        ))?
        .query_row(
            params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                ep_key(episode_id)
            ],
            position_from_row,
        )
        .optional()?)
}

/// Positions at or below this are not offered in Continue Watching: the
/// player only resumes above it (`MIN_RESUME_SECONDS` in the player store).
pub const MIN_RESUME_SECONDS: i64 = 5;

/// Largest accepted position or duration (about 115 days): larger values are
/// a player glitch, not a place to resume from.
pub const MAX_POSITION_SECONDS: i64 = 10_000_000;

/// True when a position counts as watched to the end.
pub fn is_complete(position_seconds: i64, duration_seconds: Option<i64>) -> bool {
    matches!(duration_seconds, Some(d) if d > 0 && position_seconds as f64 >= COMPLETE_RATIO * d as f64)
}

/// Saves a position. Returns true when a row is stored afterwards.
///
/// - Reaching [`COMPLETE_RATIO`] of the duration: the row becomes a watched
///   row with the position at the end, for an episode (C13) and for an
///   item-level row such as a movie (Run 2 C2/C4: the movie then counts as
///   watched for the poster tick, "Hide watched" and My List). Continue
///   Watching skips watched rows and the player does not resume from them.
/// - Below that, a live save (no `updated_at`) above [`MIN_RESUME_SECONDS`]
///   clears an episode's watched flag: the episode is being rewatched, so it
///   is the series' place to resume. A save at or below it (the player's
///   first tick) keeps the flag, because nothing would be resumed from there
///   yet. An item-level row (a movie, empty episode id) always keeps its
///   flag: replaying part of a watched film must not drop the poster tick or
///   bring it back into a "Hide watched" grid. Only `setWatched(false)`
///   clears it; the replay position is stored but not resumed.
/// - With `updated_at` (backup import, C14 undo) an existing row is only
///   overwritten, or deleted, when that time is newer than the stored one,
///   so an older backup never rolls back newer progress. Such writes keep a
///   watched flag (`watched = false` means "not known").
pub fn position_set(conn: &Connection, p: &PositionInput) -> CoreResult<bool> {
    validate_ref(&p.item_ref)?;
    if p.position_seconds < 0 {
        return Err(CoreError::invalid("positionSeconds must be >= 0"));
    }
    if p.position_seconds > MAX_POSITION_SECONDS
        || p.duration_seconds.is_some_and(|d| d > MAX_POSITION_SECONDS)
    {
        return Err(CoreError::invalid(format!(
            "positionSeconds and durationSeconds must be at most {MAX_POSITION_SECONDS}"
        )));
    }
    let r = &p.item_ref;
    let ep = ep_key(p.episode_id.as_deref());
    let dated = p.updated_at.is_some();
    // Players without a finite duration omit it; completion then uses the
    // duration stored by an earlier save, so a finished item still leaves
    // Continue Watching.
    let duration = match p.duration_seconds.filter(|d| *d > 0) {
        Some(d) => Some(d),
        None => position_get(conn, r, Some(ep))?
            .and_then(|stored| stored.duration_seconds)
            .filter(|d| *d > 0),
    };
    let updated_at = p.updated_at.clone().unwrap_or_else(now_ts);
    let complete = is_complete(p.position_seconds, duration);
    if complete {
        // A finished episode stays as a watched row (position at the end):
        // Continue Watching ranks a series by its newest row, so the record
        // that a later episode was finished keeps an older half-watched one
        // from resurfacing (C13). A finished movie stays the same way, as its
        // watched mark (Run 2 C2).
        conn.execute(
            &format!(
                "INSERT INTO playback_positions(source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json, watched)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
                 ON CONFLICT(source_id, content_type, item_id, episode_id) DO UPDATE SET
                   position_seconds = excluded.position_seconds,
                   duration_seconds = excluded.duration_seconds,
                   updated_at = excluded.updated_at,
                   snapshot_json = COALESCE(excluded.snapshot_json, playback_positions.snapshot_json),
                   watched = 1
                 WHERE {NEWER_ONLY}"
            ),
            params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                ep,
                duration.unwrap_or(p.position_seconds),
                duration,
                updated_at,
                p.snapshot_json,
                dated,
            ],
        )
        .map_err(|e| map_fk(e, &r.source_id))?;
        return Ok(true);
    }
    conn.execute(
        &format!(
            "INSERT INTO playback_positions(source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json, watched)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10)
             ON CONFLICT(source_id, content_type, item_id, episode_id) DO UPDATE SET
               position_seconds = excluded.position_seconds,
               duration_seconds = COALESCE(excluded.duration_seconds, playback_positions.duration_seconds),
               updated_at = excluded.updated_at,
               snapshot_json = COALESCE(excluded.snapshot_json, playback_positions.snapshot_json),
               watched = CASE WHEN ?9 OR ?12 OR excluded.position_seconds <= ?11
                 THEN MAX(playback_positions.watched, excluded.watched)
                 ELSE excluded.watched END
             WHERE {NEWER_ONLY}"
        ),
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            ep,
            p.position_seconds,
            duration,
            updated_at,
            p.snapshot_json,
            dated,
            p.watched as i64,
            MIN_RESUME_SECONDS,
            ep.is_empty()
        ],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    Ok(true)
}

/// Upsert guard for [`position_set`]: `?9` is true for a dated write, which
/// replaces the stored row only when it is newer (julianday copes with both
/// stored timestamp formats; an unreadable stored time counts as older).
const NEWER_ONLY: &str = "NOT ?9 OR COALESCE(julianday(excluded.updated_at) > julianday(playback_positions.updated_at), 1)";

/// Marks an item (or one episode) watched or unwatched (`userstate.setWatched`).
///
/// Watched upserts the position row with `watched = 1` and the position at the
/// stored duration when one is known (else the stored position, else 0), so
/// continue watching drops it. Unwatched deletes the row.
pub fn set_watched(
    conn: &Connection,
    r: &ItemRef,
    episode_id: Option<&str>,
    watched: bool,
) -> CoreResult<()> {
    validate_ref(r)?;
    let ep = ep_key(episode_id);
    if !watched {
        return position_remove(conn, r, Some(ep));
    }
    conn.execute(
        "INSERT INTO playback_positions(source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json, watched)
         VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5, NULL, 1)
         ON CONFLICT(source_id, content_type, item_id, episode_id) DO UPDATE SET
           position_seconds = COALESCE(playback_positions.duration_seconds, playback_positions.position_seconds),
           updated_at = excluded.updated_at,
           watched = 1",
        params![r.source_id, r.content_type.as_str(), r.item_id, ep, now_ts()],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    Ok(())
}

/// Every position stored under a ref (a series: one per episode), newest first.
pub fn positions_for_series(conn: &Connection, r: &ItemRef) -> CoreResult<Vec<PlaybackPosition>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {POSITION_COLS} FROM playback_positions
         WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3
         ORDER BY updated_at DESC, rowid DESC"
    ))?;
    let rows = stmt.query_map(
        params![r.source_id, r.content_type.as_str(), r.item_id],
        position_from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Newest unfinished, unwatched positions, one per item, each with a snapshot:
/// the stored one, else built from the catalog row, else a minimal fallback.
///
/// A series is represented by its most recently updated episode row,
/// finished or not (C13). When that row is watched, or at or below
/// [`MIN_RESUME_SECONDS`], the series is left out: an older half-watched
/// episode never resurfaces after a newer one is done or started.
pub fn continue_watching(
    conn: &Connection,
    limit: Option<i64>,
) -> CoreResult<Vec<PlaybackPosition>> {
    continue_watching_filtered(conn, limit, None)
}

/// [`continue_watching`] without the items parental hide mode drops (`hide`).
pub fn continue_watching_filtered(
    conn: &Connection,
    limit: Option<i64>,
    hide: Option<Hide>,
) -> CoreResult<Vec<PlaybackPosition>> {
    let limit = limit
        .unwrap_or(CONTINUE_DEFAULT_LIMIT)
        .clamp(1, CONTINUE_MAX_LIMIT);
    let locked = match hide {
        Some(h) => crate::parental::filter::by_ref(conn, "k", h)?,
        None => String::new(),
    };
    let mut stmt = conn.prepare_cached(&format!(
        "WITH ranked AS (
           SELECT p.*, p.rowid AS rid, ROW_NUMBER() OVER (
             PARTITION BY p.source_id, p.content_type, p.item_id
             ORDER BY p.updated_at DESC, p.rowid DESC) AS rn
           FROM playback_positions p
         )
         SELECT k.source_id, k.content_type, k.item_id, k.episode_id, k.position_seconds,
                k.duration_seconds, k.updated_at, k.snapshot_json, k.watched,
                i.title, COALESCE(i.poster_url, i.logo_url)
         FROM ranked k
         LEFT JOIN items i ON i.source_id = k.source_id AND i.content_type = k.content_type AND i.item_id = k.item_id
         WHERE k.rn = 1 AND k.watched = 0 AND k.position_seconds > ?2{locked}
         ORDER BY k.updated_at DESC, k.rid DESC
         LIMIT ?1"
    ))?;
    let rows = stmt.query_map(params![limit, MIN_RESUME_SECONDS], |row| {
        let mut p = position_from_row(row)?;
        if p.snapshot.is_none() {
            let title: Option<String> = row.get(9)?;
            let poster: Option<String> = row.get(10)?;
            p.snapshot = Some(match title {
                Some(title) => ItemSnapshot {
                    title,
                    subtitle: None,
                    poster_url: poster,
                    content_type: p.item_ref.content_type,
                },
                None => fallback_snapshot(&p.item_ref),
            });
        }
        Ok(p)
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Removes one position (`episode_id = None` targets the item-level row).
pub fn position_remove(conn: &Connection, r: &ItemRef, episode_id: Option<&str>) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM playback_positions
         WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = ?4",
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            ep_key(episode_id)
        ],
    )?;
    Ok(())
}

/// Removes every unfinished position row of an item (all episodes of a
/// series); watched rows are kept (C13 `allEpisodes`). Returns the count.
pub fn position_remove_unfinished(conn: &Connection, r: &ItemRef) -> CoreResult<usize> {
    Ok(conn.execute(
        "DELETE FROM playback_positions
         WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND watched = 0",
        params![r.source_id, r.content_type.as_str(), r.item_id],
    )?)
}

/// No runtime needed.
pub async fn init(_state: Arc<AppState>) -> CoreResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&mut c).unwrap();
        c.execute(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s1','m3u','A','{}'), ('s2','xtream','B','{}')",
            [],
        )
        .unwrap();
        c
    }

    fn r(src: &str, id: &str) -> ItemRef {
        ItemRef::new(src, ContentType::Movie, id)
    }

    fn snap(t: &str) -> ItemSnapshot {
        ItemSnapshot {
            title: t.into(),
            subtitle: None,
            poster_url: None,
            content_type: ContentType::Movie,
        }
    }

    #[test]
    fn timestamps_normalize() {
        assert_eq!(
            normalize_ts(&json!("2024-01-02T03:04:05Z")).unwrap(),
            "2024-01-02T03:04:05.000Z"
        );
        assert_eq!(
            normalize_ts(&json!("2024-01-02 03:04:05")).unwrap(),
            "2024-01-02T03:04:05.000Z"
        );
        assert_eq!(
            normalize_ts(&json!(1_704_164_645_000_i64)).unwrap(),
            "2024-01-02T03:04:05.000Z"
        );
        assert_eq!(
            normalize_ts(&json!("1704164645")).unwrap(),
            "2024-01-02T03:04:05.000Z"
        );
        assert!(normalize_ts(&json!("garbage")).is_none());
        assert!(normalize_ts(&json!(null)).is_none());
    }

    #[test]
    fn favorites_toggle_order_and_reorder() {
        let mut c = conn();
        assert!(favorite_toggle(&mut c, &r("s1", "a"), &snap("A")).unwrap());
        assert!(favorite_toggle(&mut c, &r("s2", "b"), &snap("B")).unwrap());
        assert!(favorite_toggle(&mut c, &r("s1", "c"), &snap("C")).unwrap());
        let ids: Vec<_> = favorites_list(&c, None)
            .unwrap()
            .into_iter()
            .map(|f| f.item_ref.item_id)
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
        favorites_reorder(&mut c, Some("s1"), &[r("s1", "c"), r("s1", "a")], None).unwrap();
        let ids: Vec<_> = favorites_list(&c, Some("s1"))
            .unwrap()
            .into_iter()
            .map(|f| f.item_ref.item_id)
            .collect();
        assert_eq!(ids, ["c", "a"]);
        assert!(!favorite_toggle(&mut c, &r("s1", "c"), &snap("C")).unwrap());
        let got = favorites_contains(&c, &[r("s1", "a"), r("s1", "c"), r("s1", "a")]).unwrap();
        assert_eq!(got, vec![r("s1", "a")]);
        let err = favorite_toggle(&mut c, &r("nope", "x"), &snap("X")).unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn recent_caps_per_source() {
        let c = conn();
        for i in 0..(RECENT_CAP_PER_SOURCE + 15) {
            recent_add(&c, &r("s1", &format!("i{i}")), &snap("x")).unwrap();
        }
        recent_add(&c, &r("s2", "other"), &snap("o")).unwrap();
        let all = recent_list(&c, Some("s1"), Some(1000)).unwrap();
        assert_eq!(all.len() as i64, RECENT_CAP_PER_SOURCE);
        assert_eq!(
            all[0].item_ref.item_id,
            format!("i{}", RECENT_CAP_PER_SOURCE + 14)
        );
        assert_eq!(recent_list(&c, Some("s2"), None).unwrap().len(), 1);
        // Re-adding an old one moves it to the top.
        recent_add(&c, &r("s1", "i20"), &snap("x")).unwrap();
        assert_eq!(
            recent_list(&c, Some("s1"), Some(1)).unwrap()[0]
                .item_ref
                .item_id,
            "i20"
        );
        assert_eq!(
            recent_clear(&c, Some("s1")).unwrap() as i64,
            RECENT_CAP_PER_SOURCE
        );
    }

    #[test]
    fn positions_complete_and_continue() {
        let c = conn();
        let p = |id: &str, ep: Option<&str>, pos, dur| PositionInput {
            item_ref: ItemRef::new("s2", ContentType::Series, id),
            episode_id: ep.map(str::to_string),
            position_seconds: pos,
            duration_seconds: dur,
            snapshot_json: None,
            updated_at: None,
            watched: false,
        };
        assert!(position_set(&c, &p("show", Some("e1"), 100, Some(1000))).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(position_set(&c, &p("show", Some("e2"), 50, Some(1000))).unwrap());
        assert_eq!(
            positions_for_series(&c, &ItemRef::new("s2", ContentType::Series, "show"))
                .unwrap()
                .len(),
            2
        );
        let cw = continue_watching(&c, Some(10)).unwrap();
        assert_eq!(cw.len(), 1, "one card per series");
        assert_eq!(cw[0].episode_id.as_deref(), Some("e2"));
        assert_eq!(cw[0].snapshot.as_ref().unwrap().title, "show");
        // >= 95 % of an episode keeps it as a watched row at the end (C13),
        // and the series leaves Continue Watching instead of falling back to e1.
        assert!(position_set(&c, &p("show", Some("e2"), 950, Some(1000))).unwrap());
        let done = position_get(
            &c,
            &ItemRef::new("s2", ContentType::Series, "show"),
            Some("e2"),
        )
        .unwrap()
        .unwrap();
        assert!(done.watched);
        assert_eq!(done.position_seconds, 1000);
        assert!(continue_watching(&c, Some(10)).unwrap().is_empty());
        // A finished movie (item-level row) becomes a watched row at its
        // end (Run 2 C2) and stays out of Continue Watching.
        let movie = |pos| PositionInput {
            item_ref: ItemRef::new("s2", ContentType::Movie, "m"),
            ..p("x", None, pos, Some(1000))
        };
        assert!(position_set(&c, &movie(100)).unwrap());
        assert_eq!(continue_watching(&c, Some(10)).unwrap().len(), 1);
        assert!(position_set(&c, &movie(990)).unwrap());
        let m = ItemRef::new("s2", ContentType::Movie, "m");
        let done = position_get(&c, &m, None).unwrap().unwrap();
        assert!(done.watched);
        assert_eq!(done.position_seconds, 1000);
        assert_eq!(done.duration_seconds, Some(1000));
        assert!(continue_watching(&c, Some(10)).unwrap().is_empty());
        assert!(position_set(&c, &p("show", Some("e1"), -1, None)).is_err());
    }
}
