//! `watchlist` module (contract C3): My List, a user-ordered list of movies
//! and series to watch later.
//!
//! Storage is the `watchlist` table (migration `0012_watchlist.sql`): one row
//! per item, keyed by its [`ItemRef`], with a title / subtitle / poster
//! snapshot taken when the item was added, so the list renders without the
//! catalog and survives a refresh that drops the item. Only movies and series
//! can be added; live and radio refs are rejected as `invalid`.
//!
//! Order: `position` ascending is the user's order. A new entry takes
//! `MIN(position) - 1`, so the latest add sits on top until the user
//! reorders. Rows that tie (imported ones) fall back to `added_at DESC`, then
//! `rowid DESC`.
//!
//! Watched state is not stored here. [`list`] reads it from the item-level
//! playback row (`episode_id = ''`, `watched = 1`), which is the row
//! `userstate.setWatched` writes when called without an episode id. For a
//! series that row means the whole series was marked watched; episode rows do
//! not count, because the core does not know a series' full episode list.
//!
//! Parental hide mode (contract C2) applies to `watchlist.list`: while it is
//! active, titles that are locked, in a locked category, or in an adult
//! category are left out, as `favorites.list` does. The rows stay stored and
//! come back on unlock; backups always carry every row.
//!
//! Removing a source removes its rows through `ON DELETE CASCADE` on
//! `source_id`, so `sources::store::delete` needs no extra step.
//!
//! The functions here are synchronous and take a `&Connection` so the backup
//! module can call [`export_entries`] / [`import_entries`] inside its own
//! transaction; the RPC layer ([`rpc`]) runs them through
//! [`AppState::db_call`] and emits [`CHANGED_EVENT`] after every write.

pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ItemRef, ItemSnapshot};
use crate::parental::Hide;
use crate::state::AppState;
use crate::userstate::{normalize_ts_str, now_ts};
use rusqlite::{params, Connection, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;

pub use crate::model::WatchlistEntry;

/// Event emitted after every My List write; payload `{}`.
pub const CHANGED_EVENT: &str = "watchlist.changed";

/// Most entries My List holds. Adding beyond it fails with `conflict`; a
/// backup import stops adding at it.
pub const MAX_ENTRIES: i64 = 5_000;
/// Most refs one `watchlist.contains` or `watchlist.reorder` call accepts.
pub const MAX_REFS: usize = 5_000;
/// Longest accepted `sourceId` / `itemId`, in characters.
pub const MAX_ID_CHARS: usize = 2_048;
/// Stored titles and subtitles are cut to this many characters.
pub const MAX_TEXT_CHARS: usize = 500;
/// Poster URLs longer than this are dropped (the row keeps no poster).
pub const MAX_URL_CHARS: usize = 4_096;

/// One My List row in a backup file (the Tsrust extension block of the
/// backup format, see `docs/architecture/backup.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistBackupEntry {
    pub source_id: String,
    pub content_type: ContentType,
    pub item_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    pub added_at: String,
    pub position: i64,
}

// ---------------------------------------------------------------------------
// Validation and cleaning
// ---------------------------------------------------------------------------

/// True for the content types My List holds.
pub fn accepts(content_type: ContentType) -> bool {
    matches!(content_type, ContentType::Movie | ContentType::Series)
}

fn check_type(content_type: ContentType, field: &str) -> CoreResult<()> {
    if accepts(content_type) {
        return Ok(());
    }
    Err(CoreError::invalid(format!(
        "{field} must be movie or series; My List does not hold {} items",
        content_type.as_str()
    )))
}

/// A ref My List can store: non-blank ids of a sane length, movie or series.
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
    check_type(r.content_type, "ref.contentType")
}

fn validate_refs(refs: &[ItemRef]) -> CoreResult<()> {
    if refs.len() > MAX_REFS {
        return Err(CoreError::invalid(format!(
            "refs must hold at most {MAX_REFS} items"
        )));
    }
    refs.iter().try_for_each(validate_ref)
}

/// The stored part of a snapshot, trimmed and bounded.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    title: String,
    subtitle: Option<String>,
    poster_url: Option<String>,
}

fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((end, _)) => s[..end].trim_end().to_string(),
        None => s.to_string(),
    }
}

/// Trims and bounds a snapshot. `None` when the title is blank. A blank
/// subtitle or poster becomes `None`; an over-long poster URL is dropped
/// rather than cut, since a cut URL never loads.
fn clean_snapshot(
    title: &str,
    subtitle: Option<&str>,
    poster_url: Option<&str>,
) -> Option<Snapshot> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    let subtitle = subtitle
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| cut(s, MAX_TEXT_CHARS));
    let poster_url = poster_url
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= MAX_URL_CHARS)
        .map(str::to_string);
    Some(Snapshot {
        title: cut(title, MAX_TEXT_CHARS),
        subtitle,
        poster_url,
    })
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
// Reads
// ---------------------------------------------------------------------------

/// The list order, shared by every read.
const ORDER_BY: &str = "ORDER BY w.position ASC, w.added_at DESC, w.rowid DESC";

/// My List in the user's order, optionally narrowed to one source and/or one
/// content type (`movie` or `series`; anything else is `invalid`).
///
/// A row without a poster falls back to the catalog's current poster (or
/// logo) for the item. `watched` is true when the item-level playback row is
/// marked watched (see the module docs).
pub fn list(
    conn: &Connection,
    source_id: Option<&str>,
    content_type: Option<ContentType>,
) -> CoreResult<Vec<WatchlistEntry>> {
    list_filtered(conn, source_id, content_type, None)
}

/// [`list`] without the entries parental hide mode drops (`hide`): titles
/// locked themselves, in a locked category, or in an adult category while
/// `autoAdult` is on. `watchlist.list` passes
/// [`crate::parental::hide_filter`]; backups use the unfiltered rows.
pub fn list_filtered(
    conn: &Connection,
    source_id: Option<&str>,
    content_type: Option<ContentType>,
    hide: Option<Hide>,
) -> CoreResult<Vec<WatchlistEntry>> {
    if let Some(ct) = content_type {
        check_type(ct, "contentType")?;
    }
    let locked = match hide {
        Some(h) => crate::parental::filter::by_ref(conn, "w", h)?,
        None => String::new(),
    };
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT w.source_id, w.content_type, w.item_id, w.title, w.subtitle,
                COALESCE(w.poster_url, NULLIF(i.poster_url, ''), NULLIF(i.logo_url, '')),
                w.added_at, COALESCE(p.watched, 0)
         FROM watchlist w
         LEFT JOIN items i
           ON i.source_id = w.source_id AND i.content_type = w.content_type AND i.item_id = w.item_id
         LEFT JOIN playback_positions p
           ON p.source_id = w.source_id AND p.content_type = w.content_type
          AND p.item_id = w.item_id AND p.episode_id = ''
         WHERE (?1 IS NULL OR w.source_id = ?1) AND (?2 IS NULL OR w.content_type = ?2){locked}
         {ORDER_BY}"
    ))?;
    let rows = stmt.query_map(
        params![source_id, content_type.map(|c| c.as_str())],
        |row| {
            let r = parse_ref(row, 0)?;
            Ok(WatchlistEntry {
                snapshot: ItemSnapshot {
                    title: row.get(3)?,
                    subtitle: row.get(4)?,
                    poster_url: row.get(5)?,
                    content_type: r.content_type,
                },
                added_at: crate::db::to_rfc3339(&row.get::<_, String>(6)?),
                watched: row.get::<_, i64>(7)? != 0,
                item_ref: r,
            })
        },
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The refs in My List, in list order.
fn ordered_refs(conn: &Connection) -> CoreResult<Vec<ItemRef>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT w.source_id, w.content_type, w.item_id FROM watchlist w {ORDER_BY}"
    ))?;
    let rows = stmt.query_map([], |row| parse_ref(row, 0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Number of entries in My List.
pub fn count(conn: &Connection) -> CoreResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM watchlist", [], |r| r.get(0))?)
}

/// True when `r` is in My List.
pub fn is_in_list(conn: &Connection, r: &ItemRef) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT 1 FROM watchlist WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .exists(params![r.source_id, r.content_type.as_str(), r.item_id])?)
}

/// The subset of `refs` that are in My List, in input order with duplicates
/// collapsed. Refs that can never be in the list (live, radio, blank ids)
/// are simply not returned, so a mixed grid can ask about all its cards.
/// More than [`MAX_REFS`] refs is `invalid`.
pub fn contains(conn: &Connection, refs: &[ItemRef]) -> CoreResult<Vec<ItemRef>> {
    if refs.len() > MAX_REFS {
        return Err(CoreError::invalid(format!(
            "refs must hold at most {MAX_REFS} items"
        )));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in refs {
        if !accepts(r.content_type) || !seen.insert(r) {
            continue;
        }
        if is_in_list(conn, r)? {
            out.push(r.clone());
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

fn insert_row(
    conn: &Connection,
    r: &ItemRef,
    s: &Snapshot,
    added_at: &str,
    position: i64,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO watchlist(source_id, content_type, item_id, title, subtitle, poster_url, added_at, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            s.title,
            s.subtitle,
            s.poster_url,
            added_at,
            position
        ],
    )
    .map_err(|e| map_fk(e, &r.source_id))?;
    Ok(())
}

fn full_error() -> CoreError {
    CoreError::Conflict(format!(
        "My List is full ({MAX_ENTRIES} titles); remove some before adding more"
    ))
}

/// Adds the item when it is absent, removes it when present, and returns the
/// new state (`true` = now in My List).
///
/// Live and radio refs are `invalid`; adding needs a non-blank
/// `snapshot.title` (`invalid`), a known source (`not_found`) and room in the
/// list (`conflict` at [`MAX_ENTRIES`]). The snapshot's own `contentType` is
/// not checked: the ref decides the type. The remove-or-insert runs in one
/// IMMEDIATE transaction, so two toggles of the same ref on separate pooled
/// connections serialize instead of both reporting the same state.
pub fn toggle(conn: &mut Connection, r: &ItemRef, snapshot: &ItemSnapshot) -> CoreResult<bool> {
    validate_ref(r)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let in_list = if remove(&tx, r)? {
        false
    } else {
        let s = clean_snapshot(
            &snapshot.title,
            snapshot.subtitle.as_deref(),
            snapshot.poster_url.as_deref(),
        )
        .ok_or_else(|| CoreError::invalid("snapshot.title is required"))?;
        if count(&tx)? >= MAX_ENTRIES {
            return Err(full_error());
        }
        let top: i64 = tx.query_row(
            "SELECT COALESCE(MIN(position), 1) - 1 FROM watchlist",
            [],
            |row| row.get(0),
        )?;
        insert_row(&tx, r, &s, &now_ts(), top)?;
        true
    };
    tx.commit()?;
    Ok(in_list)
}

/// Removes an entry. Returns true when a row was deleted (removing an absent
/// item is not an error). Live and radio refs are `invalid`.
pub fn remove(conn: &Connection, r: &ItemRef) -> CoreResult<bool> {
    validate_ref(r)?;
    let n = conn.execute(
        "DELETE FROM watchlist WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        params![r.source_id, r.content_type.as_str(), r.item_id],
    )?;
    Ok(n > 0)
}

/// Rewrites `position` so the listed refs fill the places they held before,
/// in the given order, and every unlisted entry keeps its place. Refs not in
/// My List are ignored and a ref listed twice keeps its first place, so a
/// client may send just the part of the list it reordered, and entries it
/// cannot see (hidden by parental controls, or filtered out on screen) stay
/// where they were. Every ref must be a valid movie or series ref (`invalid`
/// otherwise), at most [`MAX_REFS`].
pub fn reorder(conn: &mut Connection, refs: &[ItemRef]) -> CoreResult<()> {
    validate_refs(refs)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let current = ordered_refs(&tx)?;
        let present: HashSet<&ItemRef> = current.iter().collect();
        let mut seen: HashSet<&ItemRef> = HashSet::new();
        let listed: Vec<&ItemRef> = refs
            .iter()
            .filter(|r| present.contains(r) && seen.insert(*r))
            .collect();
        let mut listed = listed.into_iter();
        // Walk the current order: a listed entry's place takes the next
        // listed ref, an unlisted entry stays put.
        let order: Vec<&ItemRef> = current
            .iter()
            .map(|r| {
                if seen.contains(r) {
                    listed.next().unwrap_or(r)
                } else {
                    r
                }
            })
            .collect();
        let mut set = tx.prepare_cached(
            "UPDATE watchlist SET position = ?4
             WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?;
        for (i, r) in order.into_iter().enumerate() {
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
// Backup
// ---------------------------------------------------------------------------

/// Every My List row, for `backup.export`, in list order. `position` is the
/// row's index in that order (0, 1, 2...), not the stored value, so a backup
/// is the same whatever the stored numbers were and a replace-import followed
/// by an export gives the same entries back.
pub fn export_entries(conn: &Connection) -> CoreResult<Vec<WatchlistBackupEntry>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT w.source_id, w.content_type, w.item_id, w.title, w.subtitle, w.poster_url, w.added_at
         FROM watchlist w {ORDER_BY}"
    ))?;
    let rows = stmt.query_map([], |row| {
        let r = parse_ref(row, 0)?;
        Ok(WatchlistBackupEntry {
            source_id: r.source_id,
            content_type: r.content_type,
            item_id: r.item_id,
            title: row.get(3)?,
            subtitle: row.get(4)?,
            poster_url: row.get(5)?,
            added_at: crate::db::to_rfc3339(&row.get::<_, String>(6)?),
            position: 0,
        })
    })?;
    let mut out: Vec<WatchlistBackupEntry> = rows.collect::<Result<_, _>>()?;
    for (i, e) in out.iter_mut().enumerate() {
        e.position = i as i64;
    }
    Ok(out)
}

/// Stores `entries` from a backup and returns how many of them are now in My
/// List (new rows plus rows that were already there).
///
/// - `replace` clears My List first; otherwise entries merge with what is
///   there.
/// - Entries are applied in `position` order (file order breaks ties), and
///   only the first entry per item counts.
/// - Skipped without failing the import: live/radio entries, blank ids or
///   title, sources this install does not have, and new entries once the list
///   holds [`MAX_ENTRIES`].
/// - Merging keeps an existing row's place, title, subtitle and poster, fills
///   in a missing subtitle or poster from the backup, and keeps the earlier
///   of the two `added_at` values. New rows go after the existing ones, in
///   backup order.
/// - `addedAt` is normalized (RFC 3339, unix time, or SQLite format); an
///   unreadable one becomes the import time.
///
/// Runs inside a savepoint: on error nothing is changed, and it nests inside
/// the caller's transaction.
pub fn import_entries(
    conn: &Connection,
    entries: &[WatchlistBackupEntry],
    replace: bool,
) -> CoreResult<usize> {
    conn.execute_batch("SAVEPOINT watchlist_import")?;
    match import_inner(conn, entries, replace) {
        Ok(n) => {
            conn.execute_batch("RELEASE watchlist_import")?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO watchlist_import; RELEASE watchlist_import");
            Err(e)
        }
    }
}

fn import_inner(
    conn: &Connection,
    entries: &[WatchlistBackupEntry],
    replace: bool,
) -> CoreResult<usize> {
    if replace {
        conn.execute("DELETE FROM watchlist", [])?;
    }
    let mut ordered: Vec<&WatchlistBackupEntry> = entries.iter().collect();
    ordered.sort_by_key(|e| e.position);

    let mut rows = count(conn)?;
    let mut next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist",
        [],
        |row| row.get(0),
    )?;
    let mut source_exists = conn.prepare_cached("SELECT 1 FROM sources WHERE id = ?1")?;
    let mut merge = conn.prepare_cached(
        "UPDATE watchlist SET
           subtitle = COALESCE(subtitle, ?4),
           poster_url = COALESCE(poster_url, ?5),
           added_at = CASE WHEN ?6 < added_at THEN ?6 ELSE added_at END
         WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
    )?;
    let mut known_sources: HashSet<&str> = HashSet::new();
    let mut seen: HashSet<ItemRef> = HashSet::new();
    let mut applied = 0usize;
    for e in ordered {
        let r = ItemRef::new(e.source_id.clone(), e.content_type, e.item_id.clone());
        if validate_ref(&r).is_err() || !seen.insert(r.clone()) {
            continue;
        }
        let Some(s) = clean_snapshot(&e.title, e.subtitle.as_deref(), e.poster_url.as_deref())
        else {
            continue;
        };
        if !known_sources.contains(e.source_id.as_str()) {
            if !source_exists.exists([&e.source_id])? {
                continue;
            }
            known_sources.insert(&e.source_id);
        }
        let added_at = normalize_ts_str(&e.added_at).unwrap_or_else(now_ts);
        if is_in_list(conn, &r)? {
            merge.execute(params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                s.subtitle,
                s.poster_url,
                added_at
            ])?;
            applied += 1;
            continue;
        }
        if rows >= MAX_ENTRIES {
            continue;
        }
        insert_row(conn, &r, &s, &added_at, next)?;
        next += 1;
        rows += 1;
        applied += 1;
    }
    Ok(applied)
}

/// Starts the module runtime (nothing to start). Called from
/// [`crate::rpc::init_all`].
pub async fn init(_state: Arc<AppState>) -> CoreResult<()> {
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
        for id in ["s1", "s2"] {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES (?1, 'xtream', ?1, '{}')",
                [id],
            )
            .unwrap();
        }
        c
    }

    fn movie(id: &str) -> ItemRef {
        ItemRef::new("s1", ContentType::Movie, id)
    }

    fn snap(title: &str) -> ItemSnapshot {
        ItemSnapshot {
            title: title.into(),
            subtitle: None,
            poster_url: None,
            content_type: ContentType::Movie,
        }
    }

    fn ids(c: &Connection) -> Vec<String> {
        list(c, None, None)
            .unwrap()
            .into_iter()
            .map(|e| e.item_ref.item_id)
            .collect()
    }

    #[test]
    fn backup_entry_is_camel_case_and_omits_empty_options() {
        let e = WatchlistBackupEntry {
            source_id: "s1".into(),
            content_type: ContentType::Series,
            item_id: "42".into(),
            title: "Dark".into(),
            subtitle: None,
            poster_url: Some("http://img/p.jpg".into()),
            added_at: "2026-10-13T08:00:00Z".into(),
            position: 3,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(
            v,
            json!({
                "sourceId": "s1", "contentType": "series", "itemId": "42", "title": "Dark",
                "posterUrl": "http://img/p.jpg", "addedAt": "2026-10-13T08:00:00Z", "position": 3
            })
        );
        let back: WatchlistBackupEntry = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn clean_snapshot_trims_bounds_and_drops_blank_parts() {
        assert_eq!(clean_snapshot("  ", Some("x"), None), None);
        let s = clean_snapshot("  Heat ", Some("  "), Some(" http://p ")).unwrap();
        assert_eq!(s.title, "Heat");
        assert_eq!(s.subtitle, None);
        assert_eq!(s.poster_url.as_deref(), Some("http://p"));

        let long = "é".repeat(MAX_TEXT_CHARS + 20);
        let s = clean_snapshot(&long, Some(&long), Some(&"u".repeat(MAX_URL_CHARS + 1))).unwrap();
        assert_eq!(s.title.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(s.subtitle.unwrap().chars().count(), MAX_TEXT_CHARS);
        assert_eq!(
            s.poster_url, None,
            "a cut URL never loads, so it is dropped"
        );
    }

    #[test]
    fn new_entries_go_on_top_and_toggle_twice_removes() {
        let mut c = conn();
        for id in ["1", "2", "3"] {
            assert!(toggle(&mut c, &movie(id), &snap(id)).unwrap());
        }
        assert_eq!(ids(&c), ["3", "2", "1"]);
        assert!(!toggle(&mut c, &movie("2"), &snap("2")).unwrap());
        assert_eq!(ids(&c), ["3", "1"]);
        assert!(toggle(&mut c, &movie("2"), &snap("2")).unwrap());
        assert_eq!(ids(&c), ["2", "3", "1"]);
    }

    #[test]
    fn reorder_fills_the_listed_places_and_keeps_the_rest_in_place() {
        let mut c = conn();
        for id in ["1", "2", "3", "4"] {
            toggle(&mut c, &movie(id), &snap(id)).unwrap();
        }
        // [4, 3, 2, 1] -> 1 and 3 swap the 2nd and 4th places; 9 is not in
        // the list and the repeated 1 keeps its first place.
        reorder(&mut c, &[movie("1"), movie("9"), movie("3"), movie("1")]).unwrap();
        assert_eq!(ids(&c), ["4", "1", "2", "3"]);
        // The whole list sets the whole order.
        reorder(&mut c, &[movie("1"), movie("2"), movie("3"), movie("4")]).unwrap();
        assert_eq!(ids(&c), ["1", "2", "3", "4"]);
        // An add after a reorder still lands on top.
        toggle(&mut c, &movie("5"), &snap("5")).unwrap();
        assert_eq!(ids(&c), ["5", "1", "2", "3", "4"]);
    }

    #[test]
    fn the_list_is_capped() {
        let mut c = conn();
        let tx = c.transaction().unwrap();
        for i in 0..MAX_ENTRIES {
            insert_row(
                &tx,
                &movie(&i.to_string()),
                &clean_snapshot("t", None, None).unwrap(),
                "2026-01-01T00:00:00.000Z",
                i,
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let err = toggle(&mut c, &movie("new"), &snap("New")).unwrap_err();
        assert!(matches!(err, CoreError::Conflict(_)), "{err:?}");
        // Removing still works at the cap.
        assert!(!toggle(&mut c, &movie("0"), &snap("t")).unwrap());
        assert!(toggle(&mut c, &movie("new"), &snap("New")).unwrap());
    }

    #[test]
    fn import_rolls_back_on_error_and_nests_in_a_transaction() {
        let mut c = conn();
        toggle(&mut c, &movie("keep"), &snap("Keep")).unwrap();
        let tx = c.transaction().unwrap();
        let e = WatchlistBackupEntry {
            source_id: "s2".into(),
            content_type: ContentType::Series,
            item_id: "7".into(),
            title: "Dark".into(),
            subtitle: None,
            poster_url: None,
            added_at: "1760342400".into(),
            position: 0,
        };
        assert_eq!(import_entries(&tx, &[e], true).unwrap(), 1);
        tx.rollback().unwrap();
        assert_eq!(ids(&c), ["keep"], "the caller's rollback undoes the import");

        // A failing statement inside the savepoint leaves the table as it was.
        c.execute_batch("ALTER TABLE watchlist RENAME TO watchlist_old")
            .unwrap();
        assert!(import_entries(&c, &[], true).is_err());
        c.execute_batch("ALTER TABLE watchlist_old RENAME TO watchlist")
            .unwrap();
        assert_eq!(ids(&c), ["keep"]);
        assert!(c.is_autocommit(), "no savepoint is left open");
    }
}
