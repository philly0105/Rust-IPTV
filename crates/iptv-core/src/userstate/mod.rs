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

use crate::error::{CoreError, CoreResult};
use crate::model::{
    ContentType, FavoriteEntry, ItemRef, ItemSnapshot, PlaybackPosition, RecentEntry,
};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::str::FromStr;
use std::sync::Arc;

/// Recent entries kept per source; older ones are trimmed on insert.
pub const RECENT_CAP_PER_SOURCE: i64 = 200;
/// A position at or beyond this fraction of the duration counts as finished
/// and is deleted.
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

/// Favorites ordered by `position`, then `added_at`. `source_id = None` lists all sources.
pub fn favorites_list(
    conn: &Connection,
    source_id: Option<&str>,
) -> CoreResult<Vec<FavoriteEntry>> {
    let mut stmt = conn.prepare_cached(
        "SELECT source_id, content_type, item_id, added_at, position, snapshot_json
         FROM favorites WHERE (?1 IS NULL OR source_id = ?1)
         ORDER BY position ASC, added_at ASC, rowid ASC",
    )?;
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
    if is_favorite(conn, r)? {
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
    conn.execute(
        "INSERT INTO favorites(source_id, content_type, item_id, added_at, position, snapshot_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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
pub fn favorite_toggle(
    conn: &Connection,
    r: &ItemRef,
    snapshot: &ItemSnapshot,
) -> CoreResult<bool> {
    validate_ref(r)?;
    if favorite_remove(conn, r)? {
        return Ok(false);
    }
    validate_snapshot(snapshot)?;
    favorite_upsert_json(conn, r, &serde_json::to_string(snapshot)?, None, None)?;
    Ok(true)
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
/// refs from other sources are ignored. Favorites not listed keep their
/// relative order after the listed ones.
pub fn favorites_reorder(
    conn: &mut Connection,
    source_id: Option<&str>,
    refs: &[ItemRef],
) -> CoreResult<()> {
    let tx = conn.transaction()?;
    {
        let listed: Vec<&ItemRef> = refs
            .iter()
            .filter(|r| source_id.is_none_or(|s| r.source_id == s))
            .collect();
        let mut set = tx.prepare_cached(
            "UPDATE favorites SET position = ?4 WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?;
        for (i, r) in listed.iter().enumerate() {
            set.execute(params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                i as i64
            ])?;
        }
        // Push the unlisted ones of the same scope behind the listed block,
        // keeping their previous relative order.
        let listed_set: std::collections::HashSet<&ItemRef> = listed.iter().copied().collect();
        let rest: Vec<ItemRef> = favorites_list(&tx, source_id)?
            .into_iter()
            .map(|f| f.item_ref)
            .filter(|r| !listed_set.contains(r))
            .collect();
        let base = listed.len() as i64;
        for (i, r) in rest.iter().enumerate() {
            set.execute(params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                base + i as i64
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Recent
// ---------------------------------------------------------------------------

/// Recently viewed, newest first.
pub fn recent_list(
    conn: &Connection,
    source_id: Option<&str>,
    limit: Option<i64>,
) -> CoreResult<Vec<RecentEntry>> {
    let limit = limit
        .unwrap_or(RECENT_DEFAULT_LIMIT)
        .clamp(1, RECENT_MAX_LIMIT);
    let mut stmt = conn.prepare_cached(
        "SELECT source_id, content_type, item_id, viewed_at, snapshot_json
         FROM recent WHERE (?1 IS NULL OR source_id = ?1)
         ORDER BY viewed_at DESC, rowid DESC LIMIT ?2",
    )?;
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
    validate_ref(r)?;
    validate_snapshot(snapshot)?;
    // A fresh view always moves the entry to the top, even when an imported
    // timestamp was in the future: use plain replacement of viewed_at.
    let now = now_ts();
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
    /// Explicit timestamp (backup import); `None` = now.
    pub updated_at: Option<String>,
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
        item_ref: r,
    })
}

const POSITION_COLS: &str = "source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json";

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

/// True when a position counts as watched to the end.
pub fn is_complete(position_seconds: i64, duration_seconds: Option<i64>) -> bool {
    matches!(duration_seconds, Some(d) if d > 0 && position_seconds as f64 >= COMPLETE_RATIO * d as f64)
}

/// Saves a position, or deletes it when it reached [`COMPLETE_RATIO`] of the
/// duration. Returns true when a row is stored afterwards.
pub fn position_set(conn: &Connection, p: &PositionInput) -> CoreResult<bool> {
    validate_ref(&p.item_ref)?;
    if p.position_seconds < 0 {
        return Err(CoreError::invalid("positionSeconds must be >= 0"));
    }
    let duration = p.duration_seconds.filter(|d| *d > 0);
    let r = &p.item_ref;
    let ep = ep_key(p.episode_id.as_deref());
    if is_complete(p.position_seconds, duration) {
        position_remove(conn, r, Some(ep))?;
        return Ok(false);
    }
    let updated_at = p.updated_at.clone().unwrap_or_else(now_ts);
    conn.execute(
        "INSERT INTO playback_positions(source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(source_id, content_type, item_id, episode_id) DO UPDATE SET
           position_seconds = excluded.position_seconds,
           duration_seconds = COALESCE(excluded.duration_seconds, playback_positions.duration_seconds),
           updated_at = excluded.updated_at,
           snapshot_json = COALESCE(excluded.snapshot_json, playback_positions.snapshot_json)",
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            ep,
            p.position_seconds,
            duration,
            updated_at,
            p.snapshot_json
        ],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    Ok(true)
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

/// Newest unfinished positions, one per item (the latest episode of a series),
/// each with a snapshot: the stored one, else built from the catalog row,
/// else a minimal fallback.
pub fn continue_watching(
    conn: &Connection,
    limit: Option<i64>,
) -> CoreResult<Vec<PlaybackPosition>> {
    let limit = limit
        .unwrap_or(CONTINUE_DEFAULT_LIMIT)
        .clamp(1, CONTINUE_MAX_LIMIT);
    let mut stmt = conn.prepare_cached(
        "WITH ranked AS (
           SELECT p.*, p.rowid AS rid, ROW_NUMBER() OVER (
             PARTITION BY p.source_id, p.content_type, p.item_id
             ORDER BY p.updated_at DESC, p.rowid DESC) AS rn
           FROM playback_positions p
           WHERE p.position_seconds > 0
         )
         SELECT k.source_id, k.content_type, k.item_id, k.episode_id, k.position_seconds,
                k.duration_seconds, k.updated_at, k.snapshot_json,
                i.title, COALESCE(i.poster_url, i.logo_url)
         FROM ranked k
         LEFT JOIN items i ON i.source_id = k.source_id AND i.content_type = k.content_type AND i.item_id = k.item_id
         WHERE k.rn = 1
         ORDER BY k.updated_at DESC, k.rid DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        let mut p = position_from_row(row)?;
        if p.snapshot.is_none() {
            let title: Option<String> = row.get(8)?;
            let poster: Option<String> = row.get(9)?;
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
        assert!(favorite_toggle(&c, &r("s1", "a"), &snap("A")).unwrap());
        assert!(favorite_toggle(&c, &r("s2", "b"), &snap("B")).unwrap());
        assert!(favorite_toggle(&c, &r("s1", "c"), &snap("C")).unwrap());
        let ids: Vec<_> = favorites_list(&c, None)
            .unwrap()
            .into_iter()
            .map(|f| f.item_ref.item_id)
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
        favorites_reorder(&mut c, Some("s1"), &[r("s1", "c"), r("s1", "a")]).unwrap();
        let ids: Vec<_> = favorites_list(&c, Some("s1"))
            .unwrap()
            .into_iter()
            .map(|f| f.item_ref.item_id)
            .collect();
        assert_eq!(ids, ["c", "a"]);
        assert!(!favorite_toggle(&c, &r("s1", "c"), &snap("C")).unwrap());
        let got = favorites_contains(&c, &[r("s1", "a"), r("s1", "c"), r("s1", "a")]).unwrap();
        assert_eq!(got, vec![r("s1", "a")]);
        let err = favorite_toggle(&c, &r("nope", "x"), &snap("X")).unwrap_err();
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
        // >= 95 % deletes.
        assert!(!position_set(&c, &p("show", Some("e2"), 950, Some(1000))).unwrap());
        assert!(position_get(
            &c,
            &ItemRef::new("s2", ContentType::Series, "show"),
            Some("e2")
        )
        .unwrap()
        .is_none());
        assert!(position_set(&c, &p("show", Some("e1"), -1, None)).is_err());
    }
}
