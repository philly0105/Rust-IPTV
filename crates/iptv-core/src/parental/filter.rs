//! SQL for hide mode: `AND ...` clauses the catalog and user-state readers
//! append to their `WHERE` while [`super::hide_filter`] returns a [`Hide`].
//!
//! Three shapes, chosen by how many rows the reader looks at:
//!
//! - [`scoped`]: one source and content type, many rows (catalog pages and
//!   their counts, neighbors, the zap list). One non-correlated
//!   `i.rowid NOT IN (...)` set built once per statement, and skipped when
//!   that source and type have nothing locked or adult.
//! - [`item_set`]: any source, many rows (search). One `i.rowid NOT IN`
//!   set over the items of every item lock, locked category and adult
//!   category, built once per statement.
//! - [`item_row`] / [`by_ref`]: few rows (recently added, same title,
//!   channel by number, favorites, history, continue watching). Correlated
//!   primary-key probes per row.
//!
//! Adult category names are matched by the `adult_category(name)` SQL
//! function ([`super::register_sql`]).

use super::Hide;
use crate::error::CoreResult;
use crate::model::ContentType;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

/// True when any lock exists (the correlated clauses are skipped otherwise).
fn any_lock(conn: &Connection) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM parental_locks)")?
        .query_row([], |r| r.get(0))?)
}

/// Clauses for rows of `items i` from one source and content type. `src` and
/// `ty` are the statement's placeholders for that source id and type (for
/// example `?1`, `?2`); `source_id` / `content_type` are their values, used
/// to skip the clauses when nothing of that source and type is locked.
pub fn scoped(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    hide: Hide,
    src: &str,
    ty: &str,
) -> CoreResult<String> {
    let (items, cats, adult): (bool, bool, bool) = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM parental_locks WHERE source_id = ?1 AND content_type = ?2 AND kind = 'item'),
                    EXISTS(SELECT 1 FROM parental_locks WHERE source_id = ?1 AND content_type = ?2 AND kind = 'category'),
                    CASE WHEN ?3 THEN EXISTS(SELECT 1 FROM categories WHERE source_id = ?1 AND content_type = ?2 AND adult_category(name)) ELSE 0 END",
        )?
        .query_row(params![source_id, content_type.as_str(), hide.auto_adult], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    // One set of hidden rowids rather than tests on `i.item_id` and
    // `i.category_id`: the rowid is in every index, so a `count(*)` stays an
    // index-only scan instead of reading all 50k table rows. The set comes
    // from `idx_items_cat` ranges and primary-key probes.
    let mut blocked = Vec::new();
    if cats {
        blocked.push(format!(
            "SELECT target_id FROM parental_locks WHERE source_id = {src} AND content_type = {ty} AND kind = 'category'"
        ));
    }
    if adult {
        blocked.push(format!(
            "SELECT category_id FROM categories WHERE source_id = {src} AND content_type = {ty} AND adult_category(name)"
        ));
    }
    let mut hidden = Vec::new();
    if !blocked.is_empty() {
        hidden.push(format!(
            "SELECT h.rowid FROM items h WHERE h.source_id = {src} AND h.content_type = {ty} AND h.category_id IN ({})",
            blocked.join(" UNION ALL ")
        ));
    }
    if items {
        hidden.push(format!(
            "SELECT h.rowid FROM parental_locks pl CROSS JOIN items h ON h.source_id = pl.source_id AND h.content_type = pl.content_type AND h.item_id = pl.target_id WHERE pl.source_id = {src} AND pl.content_type = {ty} AND pl.kind = 'item'"
        ));
    }
    if hidden.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(
        " AND i.rowid NOT IN ({})",
        hidden.join(" UNION ALL ")
    ))
}

/// Clauses for rows of `items i` from any source, for statements that look
/// at many rows.
pub fn item_set(conn: &Connection, hide: Hide) -> CoreResult<String> {
    // One rowid set, built once per statement, as in `scoped`: a row-value
    // `(source_id, content_type, item_id) NOT IN (...)` is rescanned per
    // row, about 20x slower on a wide search (see `channeledit`). Each part
    // keeps the few locks or adult categories as the outer loop (CROSS
    // JOIN) and finds their items by primary key or `idx_items_cat`.
    let mut hidden = Vec::new();
    if any_lock(conn)? {
        hidden.push(
            "SELECT h.rowid FROM parental_locks pl CROSS JOIN items h ON h.source_id = pl.source_id AND h.content_type = pl.content_type AND h.item_id = pl.target_id WHERE pl.kind = 'item'",
        );
        hidden.push(
            "SELECT h.rowid FROM parental_locks pl CROSS JOIN items h ON h.source_id = pl.source_id AND h.content_type = pl.content_type AND h.category_id = pl.target_id WHERE pl.kind = 'category'",
        );
    }
    if hide.auto_adult {
        hidden.push(
            "SELECT h.rowid FROM categories ac CROSS JOIN items h ON h.source_id = ac.source_id AND h.content_type = ac.content_type AND h.category_id = ac.category_id WHERE adult_category(ac.name)",
        );
    }
    if hidden.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(
        " AND i.rowid NOT IN ({})",
        hidden.join(" UNION ALL ")
    ))
}

/// Clauses for rows of `items i` joined to `categories c` (as in
/// `catalog::SELECT_NAMED`), probed row by row.
pub fn item_row(conn: &Connection, hide: Hide) -> CoreResult<String> {
    let mut sql = String::new();
    if any_lock(conn)? {
        sql.push_str(
            " AND NOT EXISTS (SELECT 1 FROM parental_locks pl WHERE pl.source_id = i.source_id AND pl.content_type = i.content_type AND pl.kind = 'item' AND pl.target_id = i.item_id) \
             AND NOT EXISTS (SELECT 1 FROM parental_locks pl WHERE pl.source_id = i.source_id AND pl.content_type = i.content_type AND pl.kind = 'category' AND pl.target_id = i.category_id)",
        );
    }
    if hide.auto_adult {
        sql.push_str(" AND NOT adult_category(c.name)");
    }
    Ok(sql)
}

/// Clauses for user-state rows (alias `a` with `source_id`, `content_type`
/// and `item_id`): the item's own lock, and its category's lock or adult
/// name when the catalog knows the item's category. That is `items` for
/// everything the catalog stores, and the Stalker row cache
/// (`stalker_items.category_id`) for Stalker movies and series, which the
/// catalog never stores.
pub fn by_ref(conn: &Connection, a: &str, hide: Hide) -> CoreResult<String> {
    let mut homes = vec!["items"];
    if crate::stalker::items_have_categories(conn)? {
        homes.push("stalker_items");
    }
    let mut sql = String::new();
    if any_lock(conn)? {
        sql.push_str(&format!(
            " AND NOT EXISTS (SELECT 1 FROM parental_locks pl WHERE pl.source_id = {a}.source_id AND pl.content_type = {a}.content_type AND pl.kind = 'item' AND pl.target_id = {a}.item_id)"
        ));
        for t in &homes {
            sql.push_str(&format!(
                " AND NOT EXISTS (SELECT 1 FROM {t} pi JOIN parental_locks pl ON pl.source_id = pi.source_id AND pl.content_type = pi.content_type AND pl.kind = 'category' AND pl.target_id = pi.category_id WHERE pi.source_id = {a}.source_id AND pi.content_type = {a}.content_type AND pi.item_id = {a}.item_id)"
            ));
        }
    }
    if hide.auto_adult {
        for t in &homes {
            sql.push_str(&format!(
                " AND NOT EXISTS (SELECT 1 FROM {t} pi JOIN categories pc ON pc.source_id = pi.source_id AND pc.content_type = pi.content_type AND pc.category_id = pi.category_id WHERE pi.source_id = {a}.source_id AND pi.content_type = {a}.content_type AND pi.item_id = {a}.item_id AND adult_category(pc.name))"
            ));
        }
    }
    Ok(sql)
}

/// Category ids locked for one source and content type (`catalog.categories`).
pub fn locked_categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<HashSet<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT target_id FROM parental_locks WHERE source_id = ?1 AND content_type = ?2 AND kind = 'category'",
    )?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Locked items per category id for one source and content type, counting
/// only items the catalog has (and, with `english_only`, only items the
/// English-only filter keeps), so `catalog.categories` can take them out of
/// `itemCount`.
///
/// `CROSS JOIN` keeps the locks as the outer loop (SQLite never reorders
/// it): left to itself the planner walks every item of the source through
/// `idx_items_cat` to get the `GROUP BY` order for free, 250 ms on 50k
/// channels in a debug build instead of one primary-key probe per lock.
pub fn locked_item_counts(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
    english_only: bool,
) -> CoreResult<HashMap<String, i64>> {
    let sql = if english_only {
        "SELECT i.category_id, count(*) FROM parental_locks pl CROSS JOIN items i ON i.source_id = pl.source_id AND i.content_type = pl.content_type AND i.item_id = pl.target_id LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE pl.source_id = ?1 AND pl.content_type = ?2 AND pl.kind = 'item' AND non_english(i.title, c.name) = 0 GROUP BY i.category_id"
    } else {
        "SELECT i.category_id, count(*) FROM parental_locks pl CROSS JOIN items i ON i.source_id = pl.source_id AND i.content_type = pl.content_type AND i.item_id = pl.target_id WHERE pl.source_id = ?1 AND pl.content_type = ?2 AND pl.kind = 'item' GROUP BY i.category_id"
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
