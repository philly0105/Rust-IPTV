//! Channel editing (Run 2 contract C2): hide or rename individual live and
//! radio channels. Edits live in `channel_edits` (migration 0013), keyed by
//! the stable catalog id rather than a foreign key to `items`, so they
//! survive the catalog rewrite of every refresh; removing the source removes
//! them through the cascade.
//!
//! Readers use the SQL builders here next to the parental hide-mode clauses
//! (`parental::filter`), in the same three shapes:
//!
//! - [`scoped`]: one source and content type, many rows (catalog pages and
//!   their counts, neighbors, the zap list): one non-correlated
//!   `i.rowid NOT IN (...)` set per statement.
//! - [`item_set`]: any source, many rows (global search): one
//!   non-correlated `i.rowid NOT IN (...)` set over every hidden row. (A
//!   row-value `(source_id, content_type, item_id) NOT IN (...)` measured
//!   20x slower on a 45k-match search: SQLite rescans the set per row.)
//! - [`VISIBLE_PREDICATE`] / [`by_ref`]: few rows (channel by number,
//!   favorites, history): a correlated primary-key probe per row.
//!
//! Each builder first asks one indexed `EXISTS` whether anything is hidden
//! and returns an empty clause when not, so a source without edits pays
//! nothing per row. Renames are applied on read ([`apply_names`],
//! [`apply_snapshot_names`]); the provider name stays in `items.title`, so
//! EPG matching, the FTS index and sorting by name keep using it.
//! See `docs/architecture/channel-edits.md`.

pub mod rpc;

use crate::error::{CoreError, CoreResult};
use crate::lists::MAX_ID_CHARS;
use crate::model::{Channel, ContentType, ItemRef, ItemSnapshot};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

/// Event emitted after every write, payload `{ sourceId: string }`.
pub const CHANGED_EVENT: &str = "channels.changed";

/// SQL predicate for an `items i` alias: true when the item is not hidden by
/// a channel edit.
pub const VISIBLE_PREDICATE: &str = "NOT EXISTS (SELECT 1 FROM channel_edits e WHERE e.source_id = i.source_id AND e.content_type = i.content_type AND e.item_id = i.item_id AND e.hidden = 1)";

/// Longest custom name, in characters (after trimming).
pub const MAX_NAME_CHARS: usize = 120;

/// Most refs one `channels.setHidden` call accepts.
pub const MAX_REFS: usize = 500;

/// One channel edit (`channels.edits`, `channels.rename`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEdit {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub original_name: String,
    pub updated_at: String,
}

/// True for the content types a channel edit can target.
pub fn is_channel_type(ct: ContentType) -> bool {
    matches!(ct, ContentType::Live | ContentType::Radio)
}

// ---------------------------------------------------------------------------
// Cost-rule probes (one indexed EXISTS each)
// ---------------------------------------------------------------------------

/// True when the source has a hidden channel of `content_type`
/// (`idx_channel_edits_hidden`).
pub fn has_hidden(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<bool> {
    if !is_channel_type(content_type) {
        return Ok(false);
    }
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND hidden = 1)",
        )?
        .query_row(params![source_id, content_type.as_str()], |r| r.get(0))?)
}

/// True when the source has a hidden channel of any type.
pub fn source_has_hidden(conn: &Connection, source_id: &str) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM channel_edits WHERE source_id = ?1 AND hidden = 1)",
        )?
        .query_row([source_id], |r| r.get(0))?)
}

/// True when any source has a hidden channel.
pub fn any_hidden(conn: &Connection) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM channel_edits WHERE hidden = 1)")?
        .query_row([], |r| r.get(0))?)
}

/// True when the source has a renamed channel of `content_type`
/// (`idx_channel_edits_named`).
pub fn has_names(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<bool> {
    if !is_channel_type(content_type) {
        return Ok(false);
    }
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND name IS NOT NULL)",
        )?
        .query_row(params![source_id, content_type.as_str()], |r| r.get(0))?)
}

/// True when any source has a renamed channel.
pub fn any_names(conn: &Connection) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM channel_edits WHERE name IS NOT NULL)")?
        .query_row([], |r| r.get(0))?)
}

// ---------------------------------------------------------------------------
// Reader clauses
// ---------------------------------------------------------------------------

/// `AND` clause dropping hidden channels from rows of `items i` of one source
/// and content type, or nothing when that source and type hide none. `src`
/// and `ty` are the statement's placeholders (or literals) for the source id
/// and type, as in `parental::filter::scoped`.
///
/// The set is rowids, like the parental and English-only sets: the rowid is
/// in every index, so a `count(*)` over the source stays an index-only scan.
/// It is built once per statement from `idx_channel_edits_hidden` and
/// primary-key probes into `items`.
pub fn scoped(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    src: &str,
    ty: &str,
) -> CoreResult<String> {
    if !has_hidden(conn, source_id, content_type)? {
        return Ok(String::new());
    }
    Ok(format!(
        " AND i.rowid NOT IN (SELECT h.rowid FROM channel_edits e CROSS JOIN items h ON h.source_id = e.source_id AND h.content_type = e.content_type AND h.item_id = e.item_id WHERE e.source_id = {src} AND e.content_type = {ty} AND e.hidden = 1)"
    ))
}

/// `AND` clause dropping hidden channels from rows of `items i` of any
/// source (global search), or nothing when no channel is hidden. The set
/// holds the hidden rows of every source; `source_id` only narrows the
/// `EXISTS` probe when the statement is limited to one source.
pub fn item_set(conn: &Connection, source_id: Option<&str>) -> CoreResult<String> {
    let any = match source_id {
        Some(s) => source_has_hidden(conn, s)?,
        None => any_hidden(conn)?,
    };
    if !any {
        return Ok(String::new());
    }
    Ok(" AND i.rowid NOT IN (SELECT h.rowid FROM channel_edits e CROSS JOIN items h ON h.source_id = e.source_id AND h.content_type = e.content_type AND h.item_id = e.item_id WHERE e.hidden = 1)".to_string())
}

/// `AND` [`VISIBLE_PREDICATE`] for statements over `items i` that look at
/// few rows of one source, or nothing when the source hides no channel.
pub fn item_row(conn: &Connection, source_id: &str) -> CoreResult<String> {
    if !source_has_hidden(conn, source_id)? {
        return Ok(String::new());
    }
    Ok(format!(" AND {VISIBLE_PREDICATE}"))
}

/// `AND` clause dropping hidden channels from user-state rows (alias `a`
/// with `source_id`, `content_type` and `item_id`), or nothing when no
/// channel is hidden. A correlated primary-key probe per row.
pub fn by_ref(conn: &Connection, a: &str) -> CoreResult<String> {
    if !any_hidden(conn)? {
        return Ok(String::new());
    }
    Ok(format!(
        " AND NOT EXISTS (SELECT 1 FROM channel_edits e WHERE e.source_id = {a}.source_id AND e.content_type = {a}.content_type AND e.item_id = {a}.item_id AND e.hidden = 1)"
    ))
}

/// Rowids of the items of one source and type whose custom name matches the
/// LIKE pattern `pat` (a placeholder; use `catalog::like_pattern`). For
/// `i.rowid IN (...)` in catalog search; callers check [`has_names`] first.
pub fn named_rowids(src: &str, ty: &str, pat: &str) -> String {
    format!(
        "SELECT h.rowid FROM channel_edits e CROSS JOIN items h ON h.source_id = e.source_id AND h.content_type = e.content_type AND h.item_id = e.item_id WHERE e.source_id = {src} AND e.content_type = {ty} AND e.name IS NOT NULL AND e.name LIKE {pat} ESCAPE '\\'"
    )
}

/// Hidden channels per category id of one source and type, counting only
/// channels the catalog has (empty when nothing is hidden).
pub fn hidden_counts(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<HashMap<String, i64>> {
    if !has_hidden(conn, source_id, content_type)? {
        return Ok(HashMap::new());
    }
    // CROSS JOIN keeps the few edits as the outer loop (see
    // `parental::filter::locked_item_counts`).
    let mut stmt = conn.prepare_cached(
        "SELECT i.category_id, count(*) FROM channel_edits e CROSS JOIN items i ON i.source_id = e.source_id AND i.content_type = e.content_type AND i.item_id = e.item_id WHERE e.source_id = ?1 AND e.content_type = ?2 AND e.hidden = 1 GROUP BY i.category_id",
    )?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Number of hidden channels of one source and type that the catalog has.
pub fn hidden_count(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<i64> {
    if !has_hidden(conn, source_id, content_type)? {
        return Ok(0);
    }
    Ok(conn
        .prepare_cached(
            "SELECT count(*) FROM channel_edits e CROSS JOIN items i ON i.source_id = e.source_id AND i.content_type = e.content_type AND i.item_id = e.item_id WHERE e.source_id = ?1 AND e.content_type = ?2 AND e.hidden = 1",
        )?
        .query_row(params![source_id, content_type.as_str()], |r| r.get(0))?)
}

// ---------------------------------------------------------------------------
// Contract readers
// ---------------------------------------------------------------------------

/// True when the channel is hidden by a channel edit.
pub fn is_hidden(conn: &Connection, r: &ItemRef) -> CoreResult<bool> {
    if !is_channel_type(r.content_type) {
        return Ok(false);
    }
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND hidden = 1)",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get(0),
        )?)
}

/// `(content type, item id)` of every hidden channel of a source.
pub fn hidden_set(
    conn: &Connection,
    source_id: &str,
) -> CoreResult<HashSet<(ContentType, String)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT content_type, item_id FROM channel_edits WHERE source_id = ?1 AND hidden = 1",
    )?;
    let rows = stmt.query_map([source_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = HashSet::new();
    for row in rows {
        let (ct, id) = row?;
        if let Ok(ct) = ct.parse::<ContentType>() {
            out.insert((ct, id));
        }
    }
    Ok(out)
}

/// Custom names of one source by `(content type, item id)` (empty when
/// nothing is renamed; one `idx_channel_edits_named` range).
pub fn names_of(
    conn: &Connection,
    source_id: &str,
) -> CoreResult<HashMap<(ContentType, String), String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT content_type, item_id, name FROM channel_edits WHERE source_id = ?1 AND content_type IN ('live', 'radio') AND name IS NOT NULL",
    )?;
    let rows = stmt.query_map([source_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (ct, id, name) = row?;
        if let Ok(ct) = ct.parse::<ContentType>() {
            out.insert((ct, id), name);
        }
    }
    Ok(out)
}

/// Custom names of one source by (content type, item id).
type SourceNames = HashMap<(ContentType, String), String>;

/// Looks up custom names for refs from any sources: one query per distinct
/// source among the channel refs, none when nothing is renamed anywhere.
fn names_for<'a>(
    conn: &Connection,
    refs: impl Iterator<Item = &'a ItemRef>,
) -> CoreResult<HashMap<String, SourceNames>> {
    let sources: BTreeSet<&str> = refs
        .filter(|r| is_channel_type(r.content_type))
        .map(|r| r.source_id.as_str())
        .collect();
    let mut out = HashMap::new();
    if sources.is_empty() || !any_names(conn)? {
        return Ok(out);
    }
    for s in sources {
        let names = names_of(conn, s)?;
        if !names.is_empty() {
            out.insert(s.to_string(), names);
        }
    }
    Ok(out)
}

/// Applies custom names in place (one query per distinct source in the slice).
pub fn apply_names(conn: &Connection, channels: &mut [Channel]) -> CoreResult<()> {
    if channels.is_empty() {
        return Ok(());
    }
    let names = names_for(conn, channels.iter().map(|c| &c.item_ref))?;
    if names.is_empty() {
        return Ok(());
    }
    for ch in channels.iter_mut() {
        let r = &ch.item_ref;
        if let Some(n) = names
            .get(&r.source_id)
            .and_then(|m| m.get(&(r.content_type, r.item_id.clone())))
        {
            ch.name = n.clone();
        }
    }
    Ok(())
}

/// Applies custom names to the titles of user-state snapshots of live and
/// radio channels (favorites, history), one query per distinct source.
pub fn apply_snapshot_names<'a>(
    conn: &Connection,
    entries: impl IntoIterator<Item = (&'a ItemRef, &'a mut ItemSnapshot)>,
) -> CoreResult<()> {
    let entries: Vec<(&ItemRef, &mut ItemSnapshot)> = entries
        .into_iter()
        .filter(|(r, _)| is_channel_type(r.content_type))
        .collect();
    if entries.is_empty() {
        return Ok(());
    }
    let names = names_for(conn, entries.iter().map(|(r, _)| *r))?;
    if names.is_empty() {
        return Ok(());
    }
    for (r, snap) in entries {
        if let Some(n) = names
            .get(&r.source_id)
            .and_then(|m| m.get(&(r.content_type, r.item_id.clone())))
        {
            snap.title = n.clone();
        }
    }
    Ok(())
}

/// The custom name of a channel, if it was renamed.
pub fn custom_name(conn: &Connection, r: &ItemRef) -> CoreResult<Option<String>> {
    if !is_channel_type(r.content_type) {
        return Ok(None);
    }
    Ok(conn
        .prepare_cached(
            "SELECT name FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

// ---------------------------------------------------------------------------
// Writers (`channels.*`)
// ---------------------------------------------------------------------------

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
    if !is_channel_type(r.content_type) {
        return Err(CoreError::invalid(format!(
            "only live and radio channels can be edited, not '{}'",
            r.content_type
        )));
    }
    Ok(())
}

fn require_source(conn: &Connection, source_id: &str) -> CoreResult<()> {
    if source_id.trim().is_empty() {
        return Err(CoreError::invalid("sourceId is required"));
    }
    let exists: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM sources WHERE id = ?1)")?
        .query_row([source_id], |r| r.get(0))?;
    if !exists {
        return Err(CoreError::not_found(format!(
            "source {source_id} does not exist"
        )));
    }
    Ok(())
}

/// Provider name of a catalog channel, `None` when the catalog lacks it.
fn provider_name(conn: &Connection, r: &ItemRef) -> CoreResult<Option<String>> {
    Ok(conn
        .prepare_cached(
            "SELECT title FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn has_row(conn: &Connection, r: &ItemRef) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3)",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get(0),
        )?)
}

/// Deletes the row of `r` when it no longer edits anything.
fn drop_if_empty(conn: &Connection, r: &ItemRef) -> CoreResult<()> {
    conn.prepare_cached(
        "DELETE FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND hidden = 0 AND name IS NULL",
    )?
    .execute(params![r.source_id, r.content_type.as_str(), r.item_id])?;
    Ok(())
}

/// Writes `title` (the provider name) back into the titles stored with a
/// channel whose custom name was just cleared. Favorites and history
/// snapshots (relabelled on read by [`apply_snapshot_names`]), custom list
/// items and the watch log keep the name shown when they were saved, which
/// is the custom name while the channel was renamed; with the name gone,
/// nothing relabels them on read any more.
fn restore_titles(conn: &Connection, r: &ItemRef, title: &str) -> CoreResult<()> {
    for table in ["favorites", "recent"] {
        conn.prepare_cached(&format!(
            "UPDATE {table} SET snapshot_json = json_set(snapshot_json, '$.title', ?4)
             WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3
               AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'"
        ))?
        .execute(params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            title
        ])?;
    }
    for table in ["custom_list_items", "watch_log"] {
        conn.prepare_cached(&format!(
            "UPDATE {table} SET title = ?4 WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3"
        ))?
        .execute(params![r.source_id, r.content_type.as_str(), r.item_id, title])?;
    }
    Ok(())
}

const SELECT_EDIT: &str = "SELECT e.source_id, e.content_type, e.item_id, e.hidden, e.name, COALESCE(i.title, e.original_name), e.updated_at FROM channel_edits e LEFT JOIN items i ON i.source_id = e.source_id AND i.content_type = e.content_type AND i.item_id = e.item_id";

fn read_edit(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChannelEdit> {
    let ct: String = row.get(1)?;
    let content_type = ct.parse::<ContentType>().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(e.to_string())),
        )
    })?;
    Ok(ChannelEdit {
        item_ref: ItemRef {
            source_id: row.get(0)?,
            content_type,
            item_id: row.get(2)?,
        },
        hidden: row.get(3)?,
        name: row.get(4)?,
        original_name: row.get(5)?,
        updated_at: crate::db::to_rfc3339(&row.get::<_, String>(6)?),
    })
}

/// The edit row of one channel, if any. `originalName` is the provider's
/// current name while the catalog has the channel, else the stored one.
pub fn edit_of(conn: &Connection, r: &ItemRef) -> CoreResult<Option<ChannelEdit>> {
    Ok(conn
        .prepare_cached(&format!(
            "{SELECT_EDIT} WHERE e.source_id = ?1 AND e.content_type = ?2 AND e.item_id = ?3"
        ))?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            read_edit,
        )
        .optional()?)
}

/// `channels.edits`: the edits of one source, newest first; `hidden_only`
/// keeps hidden rows. An unknown source has no edits (empty list).
pub fn list(conn: &Connection, source_id: &str, hidden_only: bool) -> CoreResult<Vec<ChannelEdit>> {
    if source_id.trim().is_empty() {
        return Err(CoreError::invalid("sourceId is required"));
    }
    let mut stmt = conn.prepare_cached(&format!(
        "{SELECT_EDIT} WHERE e.source_id = ?1 AND (NOT ?2 OR e.hidden = 1) ORDER BY e.updated_at DESC, e.rowid DESC"
    ))?;
    let rows = stmt.query_map(params![source_id, hidden_only], read_edit)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Recomputes the category and source counts after the hidden set of a
/// source changed (`catalog.categories` `itemCount`, `source_counts`).
fn recount(conn: &Connection, source_id: &str, types: &BTreeSet<ContentType>) -> CoreResult<()> {
    for ct in types {
        crate::catalog::recount_categories(conn, source_id, *ct)?;
    }
    crate::catalog::update_counts(conn, source_id)
}

/// `channels.setHidden`: hides or unhides channels in one transaction and
/// returns the ids of the sources touched (one `channels.changed` each).
///
/// 1..=[`MAX_REFS`] refs (duplicates collapse), live or radio only, else
/// `Invalid`. Hiding needs the channel in the catalog, else `NotFound` and
/// nothing is written. Unhiding never answers `NotFound` (a change to C2
/// asked for by the channel-edit UI): it clears the hidden flag whether or
/// not the provider still lists the channel, so a dropped channel can leave
/// the hidden-channels list, and a ref with no hidden row is a no-op, as is
/// hiding a channel that is already hidden. A row left with nothing to edit
/// is deleted. Only sources with a real change are returned.
pub fn set_hidden(
    conn: &mut Connection,
    refs: &[ItemRef],
    hidden: bool,
) -> CoreResult<Vec<String>> {
    if refs.is_empty() || refs.len() > MAX_REFS {
        return Err(CoreError::invalid(format!(
            "refs must hold 1 to {MAX_REFS} channels"
        )));
    }
    for r in refs {
        validate_ref(r)?;
    }
    let mut seen = HashSet::new();
    let refs: Vec<&ItemRef> = refs.iter().filter(|r| seen.insert(*r)).collect();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = crate::userstate::now_ts();
    let mut touched: BTreeSet<(String, ContentType)> = BTreeSet::new();
    for r in &refs {
        let title = provider_name(&tx, r)?;
        if hidden {
            let Some(title) = title else {
                return Err(not_in_catalog(r));
            };
            // A channel that is already hidden is a no-op (no write, no
            // event), as unhiding one that is not.
            let n = tx
                .prepare_cached(
                    "INSERT INTO channel_edits (source_id, content_type, item_id, hidden, name, original_name, updated_at)
                     VALUES (?1, ?2, ?3, 1, NULL, ?4, ?5)
                     ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
                       hidden = 1, original_name = excluded.original_name, updated_at = excluded.updated_at
                     WHERE channel_edits.hidden = 0",
                )?
                .execute(params![r.source_id, r.content_type.as_str(), r.item_id, title, now])?;
            if n == 0 {
                continue;
            }
        } else {
            // Unhiding never needs the channel in the catalog: a channel
            // the provider has dropped can leave the hidden list, and a ref
            // with no hidden row is a no-op (no write, no event).
            let n = tx
                .prepare_cached(
                    "UPDATE channel_edits SET hidden = 0, original_name = COALESCE(?4, original_name), updated_at = ?5
                     WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND hidden = 1",
                )?
                .execute(params![r.source_id, r.content_type.as_str(), r.item_id, title, now])?;
            if n == 0 {
                continue;
            }
            drop_if_empty(&tx, r)?;
        }
        touched.insert((r.source_id.clone(), r.content_type));
    }
    let sources = recount_touched(&tx, &touched)?;
    tx.commit()?;
    Ok(sources)
}

/// Recounts every touched source; returns the distinct source ids in order.
fn recount_touched(
    conn: &Connection,
    touched: &BTreeSet<(String, ContentType)>,
) -> CoreResult<Vec<String>> {
    let mut by_source: Vec<(String, BTreeSet<ContentType>)> = Vec::new();
    for (s, ct) in touched {
        match by_source.last_mut() {
            Some((last, types)) if last == s => {
                types.insert(*ct);
            }
            _ => by_source.push((s.clone(), BTreeSet::from([*ct]))),
        }
    }
    for (s, types) in &by_source {
        recount(conn, s, types)?;
    }
    Ok(by_source.into_iter().map(|(s, _)| s).collect())
}

/// Trims and checks a custom name: `Ok(None)` resets to the provider name
/// (`None` or `""`), otherwise 1..=[`MAX_NAME_CHARS`] characters after
/// trimming, at least one of them visible (see [`is_invisible`]), with no
/// control character and no line or paragraph separator, else `Invalid`.
pub fn normalize_name(name: Option<&str>) -> CoreResult<Option<String>> {
    let Some(raw) = name else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let name = raw.trim();
    if name.chars().all(is_invisible) {
        return Err(CoreError::invalid("name must not be blank"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(CoreError::invalid(format!(
            "name must be at most {MAX_NAME_CHARS} characters"
        )));
    }
    if name.chars().any(is_line_break) {
        return Err(CoreError::invalid(
            "name must not contain control characters or line breaks",
        ));
    }
    Ok(Some(name.to_string()))
}

/// True for a character that shows nothing on its own: white space, the
/// format characters (Unicode category Cf, such as U+200B ZERO WIDTH SPACE
/// or U+200F RIGHT-TO-LEFT MARK) and the other default-ignorable code
/// points, and the Hangul and Braille blanks. A name made only of these is
/// an empty label, so it counts as blank. Inside a name they are kept:
/// U+200D and the variation selectors join and style emoji.
pub(crate) fn is_invisible(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c as u32,
            0x00AD
                | 0x034F
                | 0x061C
                | 0x115F..=0x1160
                | 0x17B4..=0x17B5
                | 0x180B..=0x180F
                | 0x200B..=0x200F
                | 0x202A..=0x202E
                | 0x2060..=0x206F
                | 0x2800
                | 0x3164
                | 0xFE00..=0xFE0F
                | 0xFEFF
                | 0xFFA0
                | 0xFFF0..=0xFFF8
                | 0x1BCA0..=0x1BCA3
                | 0x1D173..=0x1D17A
                | 0xE0000..=0xE0FFF
        )
}

/// True for a control character (Cc) or U+2028 LINE SEPARATOR / U+2029
/// PARAGRAPH SEPARATOR (Zl, Zp), which break a one-line label.
pub(crate) fn is_line_break(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')
}

/// `NotFound` for a channel missing from the catalog. Long ids are
/// shortened, so a bad request does not echo kilobytes back.
fn not_in_catalog(r: &ItemRef) -> CoreError {
    CoreError::not_found(format!(
        "channel {} not found in source {}; refresh the source",
        short_id(&r.item_id),
        short_id(&r.source_id)
    ))
}

/// `id` cut to 64 characters with an ellipsis, for error messages.
fn short_id(id: &str) -> String {
    const MAX: usize = 64;
    match id.char_indices().nth(MAX) {
        Some((end, _)) => format!("{}...", &id[..end]),
        None => id.to_string(),
    }
}

/// `channels.rename`: sets or clears the custom name of one channel and
/// returns its edit row (`None` when no edit is left) and whether anything
/// changed.
///
/// A name equal to the provider name clears the custom name (the channel
/// then shows the provider name, and follows it if the provider renames
/// it). Clearing a name also puts the provider name back into the titles
/// stored with the channel (favorites, history, lists, watch log). Setting
/// a name needs the channel in the catalog; clearing also works for a
/// dropped channel whose row exists. `NotFound` otherwise. When the custom
/// name already is the requested one nothing is written (the row keeps its
/// `updatedAt`) and the flag is false, so no event goes out.
pub fn rename(
    conn: &mut Connection,
    r: &ItemRef,
    name: Option<&str>,
) -> CoreResult<(Option<ChannelEdit>, bool)> {
    validate_ref(r)?;
    let name = normalize_name(name)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let title = provider_name(&tx, r)?;
    let now = crate::userstate::now_ts();
    if title.is_none() && (name.is_some() || !has_row(&tx, r)?) {
        return Err(not_in_catalog(r));
    }
    let name = name.filter(|n| title.as_deref() != Some(n.as_str()));
    if stored_name(&tx, r)? == name {
        return Ok((edit_of(&tx, r)?, false));
    }
    match &title {
        Some(t) => {
            tx.prepare_cached(
                "INSERT INTO channel_edits (source_id, content_type, item_id, hidden, name, original_name, updated_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)
                 ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
                   name = excluded.name, original_name = excluded.original_name, updated_at = excluded.updated_at",
            )?
            .execute(params![r.source_id, r.content_type.as_str(), r.item_id, name, t, now])?;
        }
        None => {
            tx.prepare_cached(
                "UPDATE channel_edits SET name = NULL, updated_at = ?4 WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
            )?
            .execute(params![r.source_id, r.content_type.as_str(), r.item_id, now])?;
        }
    }
    if name.is_none() {
        // The custom name was cleared: `originalName` is the provider name.
        if let Some(e) = edit_of(&tx, r)? {
            restore_titles(&tx, r, &e.original_name)?;
        }
    }
    drop_if_empty(&tx, r)?;
    let out = edit_of(&tx, r)?;
    tx.commit()?;
    Ok((out, true))
}

/// The custom name stored for `r` (`None` without a row or a name).
fn stored_name(conn: &Connection, r: &ItemRef) -> CoreResult<Option<String>> {
    Ok(conn
        .prepare_cached(
            "SELECT name FROM channel_edits WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        )?
        .query_row(
            params![r.source_id, r.content_type.as_str(), r.item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// `channels.reset`: drops every edit of the source and recounts it, and
/// puts the provider names back into the titles stored with the renamed
/// channels. Returns the number of rows removed; 0 changes nothing (no
/// recount, and the command sends no event).
pub fn reset(conn: &mut Connection, source_id: &str) -> CoreResult<usize> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_source(&tx, source_id)?;
    let renamed: Vec<ChannelEdit> = tx
        .prepare_cached(&format!(
            "{SELECT_EDIT} WHERE e.source_id = ?1 AND e.name IS NOT NULL"
        ))?
        .query_map([source_id], read_edit)?
        .collect::<Result<_, _>>()?;
    for e in &renamed {
        restore_titles(&tx, &e.item_ref, &e.original_name)?;
    }
    let n = tx.execute(
        "DELETE FROM channel_edits WHERE source_id = ?1",
        [source_id],
    )?;
    if n == 0 {
        return Ok(0);
    }
    recount(
        &tx,
        source_id,
        &BTreeSet::from([ContentType::Live, ContentType::Radio]),
    )?;
    tx.commit()?;
    Ok(n)
}

// ---------------------------------------------------------------------------
// Backup (C8)
// ---------------------------------------------------------------------------

/// One channel edit in a backup file (per-entry `userState.tsrustChannelEdits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEditBackup {
    pub content_type: ContentType,
    pub item_id: String,
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub original_name: String,
    pub updated_at: String,
}

/// Every edit of a source, for `backup.export` (stable order).
pub fn export_edits(conn: &Connection, source_id: &str) -> CoreResult<Vec<ChannelEditBackup>> {
    let mut stmt = conn.prepare_cached(
        "SELECT content_type, item_id, hidden, name, original_name, updated_at FROM channel_edits WHERE source_id = ?1 ORDER BY content_type, item_id",
    )?;
    let rows = stmt.query_map([source_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, bool>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (ct, item_id, hidden, name, original_name, updated_at) = row?;
        let Ok(content_type) = ct.parse::<ContentType>() else {
            continue;
        };
        out.push(ChannelEditBackup {
            content_type,
            item_id,
            hidden,
            name,
            original_name,
            updated_at: crate::db::to_rfc3339(&updated_at),
        });
    }
    Ok(out)
}

/// Newer `updated_at` wins over an existing row; returns rows written.
///
/// Entries that cannot be an edit are skipped: a content type other than
/// live or radio, an empty item id, or nothing to edit (not hidden and no
/// usable name; a name that fails [`normalize_name`] is dropped). A missing
/// or unreadable `updatedAt` counts as now. The catalog item is not needed
/// (the source is usually refreshed after the import). Counts of the source
/// are recomputed when anything was written. `NotFound` for an unknown
/// source.
pub fn import_edits(
    conn: &Connection,
    source_id: &str,
    edits: &[ChannelEditBackup],
) -> CoreResult<usize> {
    if edits.is_empty() {
        return Ok(0);
    }
    require_source(conn, source_id)?;
    let mut written = 0;
    let mut types = BTreeSet::new();
    let mut stmt = conn.prepare_cached(
        "INSERT INTO channel_edits (source_id, content_type, item_id, hidden, name, original_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(source_id, content_type, item_id) DO UPDATE SET
           hidden = excluded.hidden, name = excluded.name, original_name = excluded.original_name, updated_at = excluded.updated_at
         WHERE COALESCE(julianday(excluded.updated_at) > julianday(channel_edits.updated_at), 1)",
    )?;
    for e in edits {
        let item_id = e.item_id.trim();
        if !is_channel_type(e.content_type)
            || item_id.is_empty()
            || item_id.chars().count() > MAX_ID_CHARS
        {
            continue;
        }
        let name = normalize_name(e.name.as_deref()).ok().flatten();
        if !e.hidden && name.is_none() {
            continue;
        }
        let original = e.original_name.trim();
        let original = if original.is_empty() {
            name.as_deref().unwrap_or(item_id)
        } else {
            original
        };
        let updated_at = crate::userstate::normalize_ts_str(&e.updated_at)
            .unwrap_or_else(crate::userstate::now_ts);
        let r = ItemRef {
            source_id: source_id.to_string(),
            content_type: e.content_type,
            item_id: item_id.to_string(),
        };
        // A newer hidden-only entry clears a custom name.
        let clears = name.is_none() && stored_name(conn, &r)?.is_some();
        let n = stmt.execute(params![
            source_id,
            e.content_type.as_str(),
            item_id,
            e.hidden,
            name,
            original,
            updated_at
        ])?;
        if n > 0 {
            written += n;
            types.insert(e.content_type);
            if clears {
                if let Some(edit) = edit_of(conn, &r)? {
                    restore_titles(conn, &r, &edit.original_name)?;
                }
            }
        }
    }
    if written > 0 {
        recount(conn, source_id, &types)?;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_and_checked() {
        assert_eq!(normalize_name(None).unwrap(), None);
        assert_eq!(normalize_name(Some("")).unwrap(), None);
        assert_eq!(
            normalize_name(Some("  BBC One HD ")).unwrap().as_deref(),
            Some("BBC One HD")
        );
        assert!(normalize_name(Some("   ")).is_err());
        assert!(normalize_name(Some("a\nb")).is_err());
        let max = "é".repeat(MAX_NAME_CHARS);
        assert_eq!(normalize_name(Some(&max)).unwrap(), Some(max.clone()));
        assert!(normalize_name(Some(&format!("{max}x"))).is_err());
    }

    #[test]
    fn names_need_a_visible_character_and_one_line() {
        for blank in [
            "\u{200B}",
            "\u{200F}",
            " \u{200B}\u{200D}\u{FEFF} ",
            "\u{3164}",
            "\u{2800}",
            "\u{2028}",
        ] {
            assert!(normalize_name(Some(blank)).is_err(), "{blank:?}");
        }
        for broken in ["BBC\u{2028}One", "BBC\u{2029}One", "BBC\u{7}One"] {
            assert!(normalize_name(Some(broken)).is_err(), "{broken:?}");
        }
        // Joiners and variation selectors inside a visible name are kept.
        for kept in [
            "\u{1F468}\u{200D}\u{1F373} Chef",
            "\u{2764}\u{FE0F} Love",
            "x\u{200B}y",
        ] {
            assert_eq!(normalize_name(Some(kept)).unwrap().as_deref(), Some(kept));
        }
    }

    #[test]
    fn long_ids_are_shortened_in_messages() {
        assert_eq!(short_id("abc"), "abc");
        let long = "x".repeat(MAX_ID_CHARS);
        let short = short_id(&long);
        assert_eq!(short.chars().count(), 67, "{short}");
        assert!(short.ends_with("..."));
    }

    #[test]
    fn named_rowids_escapes_like() {
        assert!(named_rowids("?1", "?2", "?3").ends_with("LIKE ?3 ESCAPE '\\'"));
    }
}
