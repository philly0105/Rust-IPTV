//! Custom channel lists (Run 2 contract C3): user-named lists that mix live
//! and radio channels from several sources, shown as groups in Live and as
//! dashboard rails.
//!
//! Storage is `custom_lists` and `custom_list_items` (migration
//! `0014_custom_lists.sql`). An item is keyed by its [`ItemRef`] and keeps a
//! title / logo snapshot taken when it was added, so a channel the provider
//! drops stays in the list (shown greyed out, `available: false`) instead of
//! vanishing on the next refresh.
//!
//! Order: `position` ascending, `rowid` breaking ties. New lists and new
//! items go at the end. Every write keeps positions distinct.
//!
//! What `lists.items` leaves out: channels hidden by a channel edit
//! ([`crate::channeledit::VISIBLE_PREDICATE`]) and, while parental hide mode
//! is on, channels that are locked, in a locked category or in an adult
//! category. The rows stay stored; `itemCount` counts what `lists.items`
//! returns, unavailable channels included. Custom names apply on read.
//!
//! Limits: [`MAX_LISTS`] lists, [`MAX_ITEMS`] channels per list, names of
//! 1..=[`MAX_NAME_CHARS`] characters, unique without regard to case
//! (Unicode lower case, which is stricter than the index's ASCII `NOCASE`).
//!
//! Removing a list or a source removes its items through the cascades;
//! [`forget_source`] then announces the change.
//!
//! The functions here are synchronous and take a `&Connection` so the backup
//! module can call [`export_lists`] / [`import_lists`] inside its own
//! transaction; the RPC layer ([`rpc`]) runs them through
//! [`AppState::db_call`] and emits [`CHANGED_EVENT`] after every write.

pub mod rpc;

use crate::channeledit;
use crate::error::{CoreError, CoreResult};
use crate::model::{Channel, ContentType, ItemRef, ItemSnapshot};
use crate::parental::Hide;
use crate::state::AppState;
use crate::userstate::{normalize_ts_str, now_ts};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;

/// Event emitted after every write and when a source removal cascades items
/// away, payload `{}`.
pub const CHANGED_EVENT: &str = "lists.changed";

/// Most lists one install holds. Creating another is `invalid`.
pub const MAX_LISTS: i64 = 50;
/// Most channels one list holds. Adding beyond it is `invalid`.
pub const MAX_ITEMS: i64 = 2_000;
/// Longest list name, in characters, after trimming.
pub const MAX_NAME_CHARS: usize = 60;
/// Longest accepted `sourceId` / `itemId`, in characters.
pub const MAX_ID_CHARS: usize = 2_048;
/// Stored titles are cut to this many characters.
pub const MAX_TEXT_CHARS: usize = 500;
/// Logo URLs longer than this are dropped (the row keeps no logo).
pub const MAX_URL_CHARS: usize = 4_096;
/// A list id from a backup longer than this is replaced with a fresh one.
const MAX_LIST_ID_CHARS: usize = 128;

/// One list, as `lists.list` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomList {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub on_dashboard: bool,
    /// Channels `lists.items` returns for this list right now.
    pub item_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One channel of a list, as `lists.items` returns it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomListEntry {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    /// The stored title and logo (`posterUrl`).
    pub snapshot: ItemSnapshot,
    /// The catalog channel, custom name applied; absent when unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<Channel>,
    /// False when the provider no longer lists the channel.
    pub available: bool,
    /// Sort key in list order (ascending, may have gaps).
    pub position: i64,
    pub added_at: String,
}

/// A channel to add: `{ ref, snapshot }` (TS `RefWithSnapshot`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub snapshot: ItemSnapshot,
}

/// One list in a backup file (manifest-level `tsrustCustomLists`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomListBackup {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub on_dashboard: bool,
    pub created_at: String,
    pub items: Vec<CustomListItemBackup>,
}

/// One list item in a backup file; `source_exported_id` is the source id
/// written as the entry's `exportedId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomListItemBackup {
    pub source_exported_id: String,
    pub content_type: ContentType,
    pub item_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub position: i64,
    pub added_at: String,
}

/// Starts the module. Nothing runs in the background: source removal is
/// announced by [`forget_source`], which `sources::remove` calls.
pub async fn init(_state: Arc<AppState>) -> CoreResult<()> {
    Ok(())
}

/// Announces [`CHANGED_EVENT`] after a source was removed, when any list
/// exists (its items of that source went with the source's cascade, so the
/// counts and rails may be stale). Called from `sources::remove` after the
/// source row is gone; never fails the removal.
pub async fn forget_source(state: &AppState, source_id: &str) {
    let any = state
        .db_call(|c| {
            Ok(
                c.query_row("SELECT EXISTS(SELECT 1 FROM custom_lists)", [], |r| {
                    r.get::<_, bool>(0)
                })?,
            )
        })
        .await;
    match any {
        Ok(false) => {}
        Ok(true) => state.emit(CHANGED_EVENT, serde_json::json!({})),
        Err(err) => {
            tracing::warn!(%err, source_id, "custom lists: could not check lists after source removal");
            state.emit(CHANGED_EVENT, serde_json::json!({}));
        }
    }
}

// ---------------------------------------------------------------------------
// Validation and cleaning
// ---------------------------------------------------------------------------

/// True for the content types a custom list holds.
pub fn accepts(content_type: ContentType) -> bool {
    matches!(content_type, ContentType::Live | ContentType::Radio)
}

fn validate_ids(r: &ItemRef, field: &str) -> CoreResult<()> {
    if r.source_id.trim().is_empty() || r.item_id.trim().is_empty() {
        return Err(CoreError::invalid(format!(
            "{field}.sourceId and {field}.itemId are required"
        )));
    }
    if r.source_id.chars().count() > MAX_ID_CHARS || r.item_id.chars().count() > MAX_ID_CHARS {
        return Err(CoreError::invalid(format!(
            "{field}.sourceId and {field}.itemId must be at most {MAX_ID_CHARS} characters"
        )));
    }
    Ok(())
}

/// A ref a list can store: non-blank ids of a sane length, live or radio.
fn validate_ref(r: &ItemRef, field: &str) -> CoreResult<()> {
    validate_ids(r, field)?;
    if accepts(r.content_type) {
        return Ok(());
    }
    Err(CoreError::invalid(format!(
        "{field}.contentType must be live or radio; custom lists do not hold {} items",
        r.content_type.as_str()
    )))
}

fn check_ref_count(n: usize, field: &str) -> CoreResult<()> {
    if n > MAX_ITEMS as usize {
        return Err(CoreError::invalid(format!(
            "{field} must hold at most {MAX_ITEMS} entries"
        )));
    }
    Ok(())
}

/// A list name as stored: trimmed, 1..=[`MAX_NAME_CHARS`] characters, no
/// control characters. `invalid` otherwise.
pub fn clean_name(name: &str) -> CoreResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::invalid("name is required"));
    }
    if name.chars().any(char::is_control) {
        return Err(CoreError::invalid(
            "name must not contain control characters",
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(CoreError::invalid(format!(
            "name must be at most {MAX_NAME_CHARS} characters"
        )));
    }
    Ok(name.to_string())
}

/// The case-insensitive identity of a name (Unicode lower case).
fn name_key(name: &str) -> String {
    name.to_lowercase()
}

fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((end, _)) => s[..end].trim_end().to_string(),
        None => s.to_string(),
    }
}

fn clean_title(title: &str) -> Option<String> {
    let t = title.trim();
    (!t.is_empty()).then(|| cut(t, MAX_TEXT_CHARS))
}

/// A blank or over-long logo URL becomes `None`; a cut URL never loads.
fn clean_logo(url: Option<&str>) -> Option<String> {
    url.map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= MAX_URL_CHARS)
        .map(str::to_string)
}

/// A validated item ready to insert.
#[derive(Debug, Clone)]
struct Clean {
    r: ItemRef,
    title: String,
    logo: Option<String>,
}

/// Validates every item (all or nothing) and collapses duplicate refs, the
/// first one winning.
fn clean_items(items: &[NewItem]) -> CoreResult<Vec<Clean>> {
    check_ref_count(items.len(), "items")?;
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for (n, it) in items.iter().enumerate() {
        validate_ref(&it.item_ref, &format!("items[{n}].ref"))?;
        let title = clean_title(&it.snapshot.title)
            .ok_or_else(|| CoreError::invalid(format!("items[{n}].snapshot.title is required")))?;
        if !seen.insert(&it.item_ref) {
            continue;
        }
        out.push(Clean {
            r: it.item_ref.clone(),
            title,
            logo: clean_logo(it.snapshot.poster_url.as_deref()),
        });
    }
    Ok(out)
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

fn no_list(id: &str) -> CoreError {
    CoreError::not_found(format!("list {id} does not exist"))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LIST_ORDER: &str = "ORDER BY l.position ASC, l.created_at ASC, l.rowid ASC";
const ITEM_ORDER: &str = "ORDER BY i.position ASC, i.rowid ASC";

/// Clauses (each starting with ` AND`) over `custom_list_items i` that keep
/// only what `lists.items` shows: not hidden by a channel edit and, with
/// `hide`, not parentally hidden.
fn visible_clause(conn: &Connection, hide: Option<Hide>) -> CoreResult<String> {
    let mut sql = format!(" AND {}", channeledit::VISIBLE_PREDICATE);
    if let Some(h) = hide {
        sql.push_str(&crate::parental::filter::by_ref(conn, "i", h)?);
    }
    Ok(sql)
}

fn select_lists(visible: &str, filter: &str) -> String {
    format!(
        "SELECT l.id, l.name, l.position, l.on_dashboard, l.created_at, l.updated_at,
                (SELECT COUNT(*) FROM custom_list_items i WHERE i.list_id = l.id{visible})
         FROM custom_lists l {filter} {LIST_ORDER}"
    )
}

fn read_list(row: &Row<'_>) -> rusqlite::Result<CustomList> {
    Ok(CustomList {
        id: row.get(0)?,
        name: row.get(1)?,
        position: row.get(2)?,
        on_dashboard: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        item_count: row.get(6)?,
    })
}

/// Every list in the user's order. `hide` is the parental hide filter
/// ([`crate::parental::hide_filter`]); it only changes `itemCount`.
pub fn list(conn: &Connection, hide: Option<Hide>) -> CoreResult<Vec<CustomList>> {
    let visible = visible_clause(conn, hide)?;
    let mut stmt = conn.prepare_cached(&select_lists(&visible, ""))?;
    let rows = stmt.query_map([], read_list)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One list; `not_found` when `id` is unknown.
pub fn get(conn: &Connection, id: &str, hide: Option<Hide>) -> CoreResult<CustomList> {
    let visible = visible_clause(conn, hide)?;
    let mut stmt = conn.prepare_cached(&select_lists(&visible, "WHERE l.id = ?1"))?;
    stmt.query_row([id], read_list)
        .optional()?
        .ok_or_else(|| no_list(id))
}

fn require_list(conn: &Connection, id: &str) -> CoreResult<()> {
    let exists = conn
        .prepare_cached("SELECT 1 FROM custom_lists WHERE id = ?1")?
        .exists([id])?;
    if exists {
        Ok(())
    } else {
        Err(no_list(id))
    }
}

/// The id of the list whose name equals `name` without regard to case,
/// ignoring `except`.
fn find_by_name(conn: &Connection, name: &str, except: Option<&str>) -> CoreResult<Option<String>> {
    let key = name_key(name);
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT l.id, l.name FROM custom_lists l {LIST_ORDER}"
    ))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, n) = row?;
        if Some(id.as_str()) != except && name_key(&n) == key {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn duplicate_name(name: &str) -> CoreError {
    CoreError::Conflict(format!("a list named \"{name}\" already exists"))
}

/// Every ref of a list in list order.
fn ordered_refs(conn: &Connection, id: &str) -> CoreResult<Vec<ItemRef>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT i.source_id, i.content_type, i.item_id FROM custom_list_items i WHERE i.list_id = ?1 {ITEM_ORDER}"
    ))?;
    let rows = stmt.query_map([id], |row| parse_ref(row, 0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every ref of a list in list order, each with whether `lists.items` shows
/// it (see [`visible_clause`]).
fn refs_with_visibility(
    conn: &Connection,
    id: &str,
    hide: Option<Hide>,
) -> CoreResult<Vec<(ItemRef, bool)>> {
    let visible = visible_clause(conn, hide)?;
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT i.source_id, i.content_type, i.item_id, (1{visible})
         FROM custom_list_items i WHERE i.list_id = ?1 {ITEM_ORDER}"
    ))?;
    let rows = stmt.query_map([id], |row| {
        Ok((parse_ref(row, 0)?, row.get::<_, i64>(3)? != 0))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The catalog channel for `r` with custom names and M3U catch-up overrides
/// applied, or `None` when the catalog does not have it.
fn catalog_channels(conn: &Connection, refs: &[&ItemRef]) -> CoreResult<Vec<Option<Channel>>> {
    let mut found = Vec::new();
    let mut slots = Vec::with_capacity(refs.len());
    for r in refs {
        match crate::catalog::get_named(conn, r)? {
            Some(named) => {
                slots.push(Some(found.len()));
                found.push(named.into_channel());
            }
            None => slots.push(None),
        }
    }
    crate::catchup::m3u::apply_overrides(conn, &mut found)?;
    channeledit::apply_names(conn, &mut found)?;
    let mut found: Vec<Option<Channel>> = found.into_iter().map(Some).collect();
    Ok(slots
        .into_iter()
        .map(|s| s.and_then(|i| found[i].take()))
        .collect())
}

/// The channels of a list in list order, without hidden ones (see the module
/// docs). `not_found` when the list does not exist.
pub fn items(conn: &Connection, id: &str, hide: Option<Hide>) -> CoreResult<Vec<CustomListEntry>> {
    require_list(conn, id)?;
    let visible = visible_clause(conn, hide)?;
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT i.source_id, i.content_type, i.item_id, i.title, i.logo_url, i.position, i.added_at
         FROM custom_list_items i WHERE i.list_id = ?1{visible} {ITEM_ORDER}"
    ))?;
    let rows = stmt.query_map([id], |row| {
        let r = parse_ref(row, 0)?;
        Ok(CustomListEntry {
            snapshot: ItemSnapshot {
                title: row.get(3)?,
                subtitle: None,
                poster_url: row.get(4)?,
                content_type: r.content_type,
            },
            item_ref: r,
            channel: None,
            available: false,
            position: row.get(5)?,
            added_at: row.get(6)?,
        })
    })?;
    let mut out: Vec<CustomListEntry> = rows.collect::<Result<_, _>>()?;
    let refs: Vec<&ItemRef> = out.iter().map(|e| &e.item_ref).collect();
    let channels = catalog_channels(conn, &refs)?;
    for (e, ch) in out.iter_mut().zip(channels) {
        e.available = ch.is_some();
        e.channel = ch;
    }
    Ok(out)
}

/// Ids of the lists that hold `r`, in list order. Refs a list can never hold
/// (movies, series) give an empty answer, so a menu may ask about anything.
pub fn containing(conn: &Connection, r: &ItemRef) -> CoreResult<Vec<String>> {
    validate_ids(r, "ref")?;
    if !accepts(r.content_type) {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT l.id FROM custom_lists l
         JOIN custom_list_items i ON i.list_id = l.id
         WHERE i.source_id = ?1 AND i.content_type = ?2 AND i.item_id = ?3 {LIST_ORDER}"
    ))?;
    let rows = stmt.query_map(
        params![r.source_id, r.content_type.as_str(), r.item_id],
        |row| row.get(0),
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The channels before and after `r` in list order, skipping channels that
/// are unavailable or that `lists.items` would leave out. Wraps around at
/// both ends like `catalog.neighbors`; `r` itself is never its own
/// neighbour, so a list with one other playable channel answers it twice
/// and a list with none answers `{}`. `r` itself may be hidden or
/// unavailable. `not_found` when the list does not exist or does not hold
/// `r`.
pub fn neighbors(
    conn: &Connection,
    id: &str,
    r: &ItemRef,
    hide: Option<Hide>,
) -> CoreResult<(Option<Channel>, Option<Channel>)> {
    validate_ids(r, "ref")?;
    require_list(conn, id)?;
    let rows = refs_with_visibility(conn, id, hide)?;
    let Some(cur) = rows.iter().position(|(x, _)| x == r) else {
        return Err(CoreError::not_found(format!(
            "channel {} is not in list {id}",
            r.item_id
        )));
    };
    let n = rows.len();
    let first_playable = |order: &mut dyn Iterator<Item = usize>| -> CoreResult<Option<Channel>> {
        for i in order {
            let (x, visible) = &rows[i];
            if !*visible {
                continue;
            }
            if let Some(Some(ch)) = catalog_channels(conn, &[x])?.pop() {
                return Ok(Some(ch));
            }
        }
        Ok(None)
    };
    let prev = first_playable(&mut (0..cur).rev().chain((cur + 1..n).rev()))?;
    let next = first_playable(&mut (cur + 1..n).chain(0..cur))?;
    Ok((prev, next))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Marks a list as changed now.
fn touch(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE custom_lists SET updated_at = ?2 WHERE id = ?1",
        params![id, now_ts()],
    )?;
    Ok(())
}

fn list_count(conn: &Connection) -> CoreResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM custom_lists", [], |r| r.get(0))?)
}

fn next_list_position(conn: &Connection) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM custom_lists",
        [],
        |r| r.get(0),
    )?)
}

fn next_item_position(conn: &Connection, id: &str) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1",
        [id],
        |r| r.get(0),
    )?)
}

fn too_many_lists() -> CoreError {
    CoreError::invalid(format!(
        "there can be at most {MAX_LISTS} lists; remove one before creating another"
    ))
}

#[allow(clippy::too_many_arguments)]
fn insert_list(
    conn: &Connection,
    id: &str,
    name: &str,
    position: i64,
    on_dashboard: bool,
    created_at: &str,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO custom_lists(id, name, position, on_dashboard, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, position, on_dashboard, created_at, updated_at],
    )
    .map_err(|e| match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            duplicate_name(name)
        }
        _ => CoreError::Db(e),
    })?;
    Ok(())
}

fn insert_item(
    conn: &Connection,
    list_id: &str,
    c: &Clean,
    position: i64,
    added_at: &str,
) -> CoreResult<()> {
    conn.prepare_cached(
        "INSERT INTO custom_list_items(list_id, source_id, content_type, item_id, title, logo_url, position, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        list_id,
        c.r.source_id,
        c.r.content_type.as_str(),
        c.r.item_id,
        c.title,
        c.logo,
        position,
        added_at
    ])
    .map_err(|e| map_fk(e, &c.r.source_id))?;
    Ok(())
}

/// Appends the items the list does not hold yet, in order. Fails as
/// `invalid` before writing anything when they would take the list past
/// [`MAX_ITEMS`]. Returns how many were added.
fn append_items(conn: &Connection, list_id: &str, items: &[Clean]) -> CoreResult<usize> {
    let existing: HashSet<ItemRef> = ordered_refs(conn, list_id)?.into_iter().collect();
    let new: Vec<&Clean> = items.iter().filter(|c| !existing.contains(&c.r)).collect();
    if (existing.len() + new.len()) as i64 > MAX_ITEMS {
        return Err(CoreError::invalid(format!(
            "a list holds at most {MAX_ITEMS} channels; this one has {} and {} more do not fit",
            existing.len(),
            new.len()
        )));
    }
    let now = now_ts();
    for (pos, c) in (next_item_position(conn, list_id)?..).zip(&new) {
        insert_item(conn, list_id, c, pos, &now)?;
    }
    Ok(new.len())
}

/// Creates a list at the end of the order, optionally with channels.
///
/// `invalid`: a blank, over-long or control-character name, a bad item (not
/// live or radio, blank ids or title), more than [`MAX_ITEMS`] items, or a
/// 51st list. `conflict`: another list has the same name without regard to
/// case. `not_found`: an item's source does not exist. Nothing is written on
/// any error.
pub fn create(
    conn: &mut Connection,
    name: &str,
    items: &[NewItem],
    hide: Option<Hide>,
) -> CoreResult<CustomList> {
    let name = clean_name(name)?;
    let items = clean_items(items)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if list_count(&tx)? >= MAX_LISTS {
        return Err(too_many_lists());
    }
    if find_by_name(&tx, &name, None)?.is_some() {
        return Err(duplicate_name(&name));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ts();
    insert_list(&tx, &id, &name, next_list_position(&tx)?, true, &now, &now)?;
    append_items(&tx, &id, &items)?;
    let out = get(&tx, &id, hide)?;
    tx.commit()?;
    Ok(out)
}

/// Renames a list and/or shows or hides its dashboard rail. Returns the list
/// and whether anything changed (a call that sets the current values writes
/// nothing). `invalid` for a bad name, `conflict` when another list has the
/// name, `not_found` for an unknown id. Changing only the case of the
/// list's own name is a rename, not a conflict.
pub fn update(
    conn: &mut Connection,
    id: &str,
    name: Option<&str>,
    on_dashboard: Option<bool>,
    hide: Option<Hide>,
) -> CoreResult<(CustomList, bool)> {
    let name = name.map(clean_name).transpose()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = get(&tx, id, hide)?;
    let mut changed = false;
    if let Some(n) = name.filter(|n| *n != current.name) {
        if find_by_name(&tx, &n, Some(id))?.is_some() {
            return Err(duplicate_name(&n));
        }
        tx.execute(
            "UPDATE custom_lists SET name = ?2 WHERE id = ?1",
            params![id, n],
        )?;
        changed = true;
    }
    if let Some(d) = on_dashboard.filter(|d| *d != current.on_dashboard) {
        tx.execute(
            "UPDATE custom_lists SET on_dashboard = ?2 WHERE id = ?1",
            params![id, d],
        )?;
        changed = true;
    }
    if !changed {
        return Ok((current, false));
    }
    touch(&tx, id)?;
    let out = get(&tx, id, hide)?;
    tx.commit()?;
    Ok((out, true))
}

/// Deletes a list and its items. Returns true when a list was deleted
/// (removing an unknown id is not an error, so a repeated delete is safe).
pub fn remove(conn: &Connection, id: &str) -> CoreResult<bool> {
    Ok(conn.execute("DELETE FROM custom_lists WHERE id = ?1", [id])? > 0)
}

/// Sets the list order. `ids` must name every list exactly once (`invalid`
/// otherwise).
pub fn reorder(conn: &mut Connection, ids: &[String]) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let mut stmt =
            tx.prepare_cached(&format!("SELECT l.id FROM custom_lists l {LIST_ORDER}"))?;
        let current: HashSet<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let given: HashSet<&String> = ids.iter().collect();
        if ids.len() != current.len()
            || given.len() != ids.len()
            || !ids.iter().all(|id| current.contains(id))
        {
            return Err(CoreError::invalid("ids must list every list exactly once"));
        }
        let mut set = tx.prepare_cached("UPDATE custom_lists SET position = ?2 WHERE id = ?1")?;
        for (i, id) in ids.iter().enumerate() {
            set.execute(params![id, i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Appends channels at the end of a list and returns how many were new.
/// Channels already in the list (or repeated in `items`) are ignored.
/// `invalid` for a bad item or when the list would pass [`MAX_ITEMS`];
/// `not_found` for an unknown list or source. Nothing is written on any
/// error.
pub fn add_items(conn: &mut Connection, id: &str, items: &[NewItem]) -> CoreResult<usize> {
    let items = clean_items(items)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_list(&tx, id)?;
    let added = append_items(&tx, id, &items)?;
    if added > 0 {
        touch(&tx, id)?;
        tx.commit()?;
    }
    Ok(added)
}

/// Removes channels from a list and returns how many were there. Refs the
/// list does not hold are ignored. `not_found` for an unknown list.
pub fn remove_items(conn: &mut Connection, id: &str, refs: &[ItemRef]) -> CoreResult<usize> {
    check_ref_count(refs.len(), "refs")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_list(&tx, id)?;
    let mut removed = 0;
    {
        let mut del = tx.prepare_cached(
            "DELETE FROM custom_list_items
             WHERE list_id = ?1 AND source_id = ?2 AND content_type = ?3 AND item_id = ?4",
        )?;
        for r in refs {
            removed += del.execute(params![id, r.source_id, r.content_type.as_str(), r.item_id])?;
        }
    }
    if removed > 0 {
        touch(&tx, id)?;
        tx.commit()?;
    }
    Ok(removed)
}

/// Sets the order of a list's channels, the way `watchlist.reorder` does:
/// the listed refs fill the slots they held before, in the given order, and
/// every channel not listed keeps its slot. So the refs `lists.items`
/// returned are always accepted, and channels it left out (hidden by a
/// channel edit or by parental hide mode) stay where they were; a client may
/// also send just the part it reordered. `invalid` for a ref the list does
/// not hold or a repeated ref; `not_found` for an unknown list.
pub fn reorder_items(conn: &mut Connection, id: &str, refs: &[ItemRef]) -> CoreResult<()> {
    check_ref_count(refs.len(), "refs")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_list(&tx, id)?;
    {
        let stored = ordered_refs(&tx, id)?;
        let present: HashSet<&ItemRef> = stored.iter().collect();
        let mut seen: HashSet<&ItemRef> = HashSet::new();
        for (n, r) in refs.iter().enumerate() {
            if !present.contains(r) {
                return Err(CoreError::invalid(format!("refs[{n}] is not in this list")));
            }
            if !seen.insert(r) {
                return Err(CoreError::invalid(format!("refs[{n}] repeats a channel")));
            }
        }
        let mut listed = refs.iter();
        let mut set = tx.prepare_cached(
            "UPDATE custom_list_items SET position = ?5
             WHERE list_id = ?1 AND source_id = ?2 AND content_type = ?3 AND item_id = ?4",
        )?;
        for (i, r) in stored.iter().enumerate() {
            let r = if seen.contains(r) {
                listed.next().unwrap_or(r)
            } else {
                r
            };
            set.execute(params![
                id,
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                i as i64
            ])?;
        }
    }
    touch(&tx, id)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/// Every list with its items, for `backup.export`, in list order. Positions
/// are indexes (0, 1, 2...) rather than stored values, so a backup does not
/// depend on the stored numbers. `source_exported_id` is the item's source
/// id, which the export writes as that source entry's `exportedId`.
pub fn export_lists(conn: &Connection) -> CoreResult<Vec<CustomListBackup>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT l.id, l.name, l.on_dashboard, l.created_at FROM custom_lists l {LIST_ORDER}"
    ))?;
    let lists: Vec<(String, String, bool, String)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut items = conn.prepare_cached(&format!(
        "SELECT i.source_id, i.content_type, i.item_id, i.title, i.logo_url, i.added_at
         FROM custom_list_items i WHERE i.list_id = ?1 {ITEM_ORDER}"
    ))?;
    let mut out = Vec::with_capacity(lists.len());
    for (position, (id, name, on_dashboard, created_at)) in lists.into_iter().enumerate() {
        let rows = items.query_map([&id], |row| {
            let r = parse_ref(row, 0)?;
            Ok(CustomListItemBackup {
                source_exported_id: r.source_id,
                content_type: r.content_type,
                item_id: r.item_id,
                title: row.get(3)?,
                logo_url: row.get(4)?,
                position: 0,
                added_at: row.get(5)?,
            })
        })?;
        let mut list_items: Vec<CustomListItemBackup> = rows.collect::<Result<_, _>>()?;
        for (i, it) in list_items.iter_mut().enumerate() {
            it.position = i as i64;
        }
        out.push(CustomListBackup {
            id,
            name,
            position: position as i64,
            on_dashboard,
            created_at,
            items: list_items,
        });
    }
    Ok(out)
}

/// Restores lists from a backup. Returns (lists written, items dropped).
///
/// - `replace` deletes every list first; otherwise a backup list merges into
///   the list with the same name (without regard to case), which keeps its
///   place and dashboard flag and gains the items it lacks at the end. Two
///   backup lists with the same name merge the same way.
/// - New lists go after the existing ones in backup order, keep the backup's
///   id when it is free (else get a fresh one), its dashboard flag and its
///   `createdAt` (normalized; the import time when unreadable).
/// - Items are applied in `position` order (file order breaks ties) and
///   mapped through `source_map` (exportedId -> new source id).
/// - Dropped and counted: items whose source is not in the map or no longer
///   exists, items that are not live or radio or have a blank id, items past
///   [`MAX_ITEMS`], and every item of a list that cannot be created (blank
///   name, or [`MAX_LISTS`] reached). Items already in the list are not
///   counted.
/// - A name longer than [`MAX_NAME_CHARS`] is cut; a blank title becomes the
///   item id.
///
/// Runs inside a savepoint: on error nothing is changed, and it nests inside
/// the caller's transaction.
pub fn import_lists(
    conn: &Connection,
    lists: &[CustomListBackup],
    source_map: &HashMap<String, String>,
    replace: bool,
) -> CoreResult<(usize, usize)> {
    conn.execute_batch("SAVEPOINT custom_lists_import")?;
    match import_inner(conn, lists, source_map, replace) {
        Ok(n) => {
            conn.execute_batch("RELEASE custom_lists_import")?;
            Ok(n)
        }
        Err(e) => {
            let _ =
                conn.execute_batch("ROLLBACK TO custom_lists_import; RELEASE custom_lists_import");
            Err(e)
        }
    }
}

/// A backup list name made storable: control characters become spaces, then
/// trimmed and cut to [`MAX_NAME_CHARS`]. `None` when nothing is left.
fn backup_name(name: &str) -> Option<String> {
    let spaced: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let t = spaced.trim();
    (!t.is_empty()).then(|| cut(t, MAX_NAME_CHARS))
}

fn usable_backup_id(conn: &Connection, id: &str) -> CoreResult<bool> {
    if id.trim().is_empty() || id != id.trim() || id.chars().count() > MAX_LIST_ID_CHARS {
        return Ok(false);
    }
    Ok(!conn
        .prepare_cached("SELECT 1 FROM custom_lists WHERE id = ?1")?
        .exists([id])?)
}

fn import_inner(
    conn: &Connection,
    lists: &[CustomListBackup],
    source_map: &HashMap<String, String>,
    replace: bool,
) -> CoreResult<(usize, usize)> {
    if replace {
        conn.execute("DELETE FROM custom_lists", [])?;
    }
    let sources: HashSet<String> = conn
        .prepare("SELECT id FROM sources")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut order: Vec<&CustomListBackup> = lists.iter().collect();
    order.sort_by_key(|l| l.position);
    let mut written: HashSet<String> = HashSet::new();
    let mut dropped = 0usize;
    for l in order {
        let Some(name) = backup_name(&l.name) else {
            dropped += l.items.len();
            continue;
        };
        let (target, created) = match find_by_name(conn, &name, None)? {
            Some(id) => (id, false),
            None => {
                if list_count(conn)? >= MAX_LISTS {
                    dropped += l.items.len();
                    continue;
                }
                let id = if usable_backup_id(conn, &l.id)? {
                    l.id.clone()
                } else {
                    uuid::Uuid::new_v4().to_string()
                };
                let now = now_ts();
                let created_at = normalize_ts_str(&l.created_at).unwrap_or_else(|| now.clone());
                let pos = next_list_position(conn)?;
                insert_list(conn, &id, &name, pos, l.on_dashboard, &created_at, &now)?;
                (id, true)
            }
        };
        let mut items: Vec<&CustomListItemBackup> = l.items.iter().collect();
        items.sort_by_key(|it| it.position);
        let mut existing: HashSet<ItemRef> = ordered_refs(conn, &target)?.into_iter().collect();
        let mut pos = next_item_position(conn, &target)?;
        let mut added = 0usize;
        for it in items {
            let Some(sid) = source_map
                .get(&it.source_exported_id)
                .filter(|s| sources.contains(*s))
            else {
                dropped += 1;
                continue;
            };
            let r = ItemRef::new(sid.clone(), it.content_type, it.item_id.clone());
            if !accepts(r.content_type) || validate_ids(&r, "item").is_err() {
                dropped += 1;
                continue;
            }
            if existing.contains(&r) {
                continue;
            }
            if existing.len() as i64 >= MAX_ITEMS {
                dropped += 1;
                continue;
            }
            let c = Clean {
                title: clean_title(&it.title).unwrap_or_else(|| cut(&r.item_id, MAX_TEXT_CHARS)),
                logo: clean_logo(it.logo_url.as_deref()),
                r,
            };
            let added_at = normalize_ts_str(&it.added_at).unwrap_or_else(now_ts);
            insert_item(conn, &target, &c, pos, &added_at)?;
            existing.insert(c.r);
            pos += 1;
            added += 1;
        }
        if added > 0 && !created {
            touch(conn, &target)?;
        }
        written.insert(target);
    }
    Ok((written.len(), dropped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        db::configure(&mut c).unwrap();
        db::migrate(&mut c).unwrap();
        for s in ["s1", "s2"] {
            c.execute(
                "INSERT INTO sources(id, kind, name, position, created_at, config_json) VALUES (?1,'xtream',?1,0,CURRENT_TIMESTAMP,'{}')",
                [s],
            )
            .unwrap();
        }
        c
    }

    fn item(sid: &str, id: &str) -> NewItem {
        NewItem {
            item_ref: ItemRef::new(sid, ContentType::Live, id),
            snapshot: ItemSnapshot {
                title: format!("Channel {id}"),
                subtitle: None,
                poster_url: Some(format!("http://logo/{id}.png")),
                content_type: ContentType::Live,
            },
        }
    }

    fn code(e: CoreError) -> &'static str {
        match e {
            CoreError::Invalid(_) => "invalid",
            CoreError::Conflict(_) => "conflict",
            CoreError::NotFound(_) => "not_found",
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn names_are_trimmed_bounded_and_unique_without_case() {
        let mut c = conn();
        let a = create(&mut c, "  Sports  ", &[], None).unwrap();
        assert_eq!(a.name, "Sports");
        assert_eq!(a.position, 0);
        assert!(a.on_dashboard);
        assert_eq!(
            code(create(&mut c, "sPoRtS", &[], None).unwrap_err()),
            "conflict"
        );
        assert_eq!(
            code(create(&mut c, "   ", &[], None).unwrap_err()),
            "invalid"
        );
        assert_eq!(
            code(create(&mut c, "a\nb", &[], None).unwrap_err()),
            "invalid"
        );
        let long = "x".repeat(MAX_NAME_CHARS + 1);
        assert_eq!(
            code(create(&mut c, &long, &[], None).unwrap_err()),
            "invalid"
        );
        let max = "é".repeat(MAX_NAME_CHARS);
        assert_eq!(create(&mut c, &max, &[], None).unwrap().name, max);
        // Unicode case folding goes beyond the index's ASCII NOCASE.
        create(&mut c, "Ñandú", &[], None).unwrap();
        assert_eq!(
            code(create(&mut c, "ñANDÚ", &[], None).unwrap_err()),
            "conflict"
        );
        // Case-only rename of the list itself is fine.
        let (renamed, changed) = update(&mut c, &a.id, Some("SPORTS"), None, None).unwrap();
        assert!(changed);
        assert_eq!(renamed.name, "SPORTS");
        let (_, changed) = update(&mut c, &a.id, Some("SPORTS"), Some(true), None).unwrap();
        assert!(!changed, "setting the current values writes nothing");
    }

    #[test]
    fn items_append_dedupe_and_respect_the_limit() {
        let mut c = conn();
        let l = create(&mut c, "Mix", &[item("s1", "1"), item("s1", "1")], None).unwrap();
        assert_eq!(l.item_count, 1, "duplicates in one call collapse");
        let added = add_items(&mut c, &l.id, &[item("s1", "1"), item("s2", "9")]).unwrap();
        assert_eq!(added, 1, "already present is ignored");
        let refs = ordered_refs(&c, &l.id).unwrap();
        assert_eq!(refs[1], ItemRef::new("s2", ContentType::Live, "9"));
        let many: Vec<NewItem> = (0..MAX_ITEMS - 1)
            .map(|i| item("s1", &format!("m{i}")))
            .collect();
        assert_eq!(
            code(add_items(&mut c, &l.id, &many).unwrap_err()),
            "invalid"
        );
        assert_eq!(ordered_refs(&c, &l.id).unwrap().len(), 2, "nothing written");
        let fits: Vec<NewItem> = (0..MAX_ITEMS - 2)
            .map(|i| item("s1", &format!("m{i}")))
            .collect();
        assert_eq!(
            add_items(&mut c, &l.id, &fits).unwrap(),
            (MAX_ITEMS - 2) as usize
        );
        assert_eq!(
            code(add_items(&mut c, &l.id, &[item("s2", "x")]).unwrap_err()),
            "invalid"
        );
        assert_eq!(
            code(add_items(&mut c, &l.id, &[item("nope", "x")]).unwrap_err()),
            "invalid",
            "full list checked first"
        );
        let other = create(&mut c, "Other", &[], None).unwrap();
        assert_eq!(
            code(add_items(&mut c, &other.id, &[item("nope", "x")]).unwrap_err()),
            "not_found"
        );
        assert_eq!(
            code(add_items(&mut c, "missing", &[]).unwrap_err()),
            "not_found"
        );
    }

    #[test]
    fn backup_round_trip_remaps_sources_and_merges_by_name() {
        let mut c = conn();
        let a = create(&mut c, "Mix", &[item("s1", "1"), item("s2", "2")], None).unwrap();
        update(&mut c, &a.id, None, Some(false), None).unwrap();
        create(&mut c, "Empty", &[], None).unwrap();
        let backup = export_lists(&c).unwrap();
        assert_eq!(backup.len(), 2);
        assert_eq!(backup[0].items.len(), 2);
        assert_eq!(backup[0].items[1].source_exported_id, "s2");

        // Replace into a fresh database where only s1 came back, as "n1".
        let fresh = Connection::open_in_memory().unwrap();
        let mut fresh = fresh;
        db::configure(&mut fresh).unwrap();
        db::migrate(&mut fresh).unwrap();
        fresh
            .execute(
                "INSERT INTO sources(id, kind, name, position, created_at, config_json) VALUES ('n1','xtream','n1',0,CURRENT_TIMESTAMP,'{}')",
                [],
            )
            .unwrap();
        let map = HashMap::from([("s1".to_string(), "n1".to_string())]);
        let (written, dropped) = import_lists(&fresh, &backup, &map, true).unwrap();
        assert_eq!((written, dropped), (2, 1));
        let lists = list(&fresh, None).unwrap();
        assert_eq!(lists[0].id, a.id, "the backup id is kept when free");
        assert!(!lists[0].on_dashboard);
        assert_eq!(
            ordered_refs(&fresh, &a.id).unwrap(),
            vec![ItemRef::new("n1", ContentType::Live, "1")]
        );
        // Merging the same file again adds nothing and drops the same item.
        let (written, dropped) = import_lists(&fresh, &backup, &map, false).unwrap();
        assert_eq!((written, dropped), (2, 1));
        assert_eq!(list(&fresh, None).unwrap().len(), 2);
        // A same-name list (other case) merges instead of failing.
        let mut renamed = backup.clone();
        renamed[0].name = "MIX".into();
        renamed[0].id = "other".into();
        import_lists(&fresh, &renamed, &map, false).unwrap();
        assert_eq!(list(&fresh, None).unwrap().len(), 2);
    }
}
