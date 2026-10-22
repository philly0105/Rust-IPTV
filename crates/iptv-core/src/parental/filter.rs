//! SQL for hide mode: `AND ...` clauses the catalog and user-state readers
//! append to their `WHERE` while [`super::hide_filter`] returns a [`Hide`].
//!
//! Three shapes, chosen by how many rows the reader looks at:
//!
//! - [`scoped`]: one source and content type, many rows (catalog pages and
//!   their counts, neighbors, the zap list). Non-correlated sets built once
//!   per statement: `i.category_id NOT IN` the locked and adult category
//!   ids, `i.rowid NOT IN` the items of the item locks. Each is skipped
//!   when that source and type have nothing of its kind.
//! - [`item_set`]: any source, many rows (search). `i.rowid NOT IN` the
//!   items of every item lock, and a category id test against the locked
//!   and adult ids with exact per-source probes only for rows whose id is
//!   among them.
//! - [`item_row`] / [`by_ref`]: few rows (recently added, same title,
//!   channel by number, favorites, history, continue watching). Correlated
//!   primary-key probes per row.
//!
//! Adult category names are matched by the `adult_category(name)` SQL
//! function ([`super::register_sql`]).

use super::Hide;
use crate::catalog::quality::{self, QualityFilter};
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
    // Hidden categories are tested on `i.category_id` against the few
    // locked or adult category ids, a set built once per statement; the
    // category id is in every catalog index (migration 0018), so a
    // `count(*)` stays an index-only scan. Expanding them into the rowids of
    // every item they hold walked each hidden row first: 10-14x slower
    // pages with all 150 movie categories locked. Item locks are few, so
    // they stay a rowid set (primary-key probes per lock).
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
    let mut sql = String::new();
    if !blocked.is_empty() {
        sql.push_str(&format!(
            " AND i.category_id NOT IN ({})",
            blocked.join(" UNION ALL ")
        ));
    }
    if items {
        sql.push_str(&format!(
            " AND i.rowid NOT IN (SELECT h.rowid FROM parental_locks pl CROSS JOIN items h ON h.source_id = pl.source_id AND h.content_type = pl.content_type AND h.item_id = pl.target_id WHERE pl.source_id = {src} AND pl.content_type = {ty} AND pl.kind = 'item')"
        ));
    }
    Ok(sql)
}

/// Which kinds of lock exist, across every source: (item, category).
fn lock_kinds(conn: &Connection) -> CoreResult<(bool, bool)> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM parental_locks WHERE kind = 'item'), EXISTS(SELECT 1 FROM parental_locks WHERE kind = 'category')",
        )?
        .query_row([], |r| Ok((r.get(0)?, r.get(1)?)))?)
}

/// Clauses for rows of `items i` from any source, for statements that look
/// at many rows.
pub fn item_set(conn: &Connection, hide: Hide) -> CoreResult<String> {
    // Item locks: one rowid set built once per statement (a row-value
    // `(source_id, content_type, item_id) NOT IN (...)` is rescanned per
    // row, about 20x slower on a wide search; see `channeledit`), the few
    // locks as the outer loop (CROSS JOIN), their items by primary key.
    // Categories: as in `scoped`, no expansion into every item they hold.
    // A row whose category id is not among the locked or adult ids (a set
    // built once) passes at once; only the others get the exact
    // per-source primary-key probes, since ids repeat across sources.
    let (item_locks, category_locks) = lock_kinds(conn)?;
    let mut sql = String::new();
    if item_locks {
        sql.push_str(
            " AND i.rowid NOT IN (SELECT h.rowid FROM parental_locks pl CROSS JOIN items h ON h.source_id = pl.source_id AND h.content_type = pl.content_type AND h.item_id = pl.target_id WHERE pl.kind = 'item')",
        );
    }
    let mut ids = Vec::new();
    let mut exact = Vec::new();
    if category_locks {
        ids.push("SELECT target_id FROM parental_locks WHERE kind = 'category'");
        exact.push("EXISTS (SELECT 1 FROM parental_locks pl WHERE pl.source_id = i.source_id AND pl.content_type = i.content_type AND pl.kind = 'category' AND pl.target_id = i.category_id)");
    }
    if hide.auto_adult {
        ids.push("SELECT category_id FROM categories WHERE adult_category(name)");
        exact.push("EXISTS (SELECT 1 FROM categories ac WHERE ac.source_id = i.source_id AND ac.content_type = i.content_type AND ac.category_id = i.category_id AND adult_category(ac.name))");
    }
    if !ids.is_empty() {
        sql.push_str(&format!(
            " AND NOT (i.category_id IN ({}) AND ({}))",
            ids.join(" UNION ALL "),
            exact.join(" OR ")
        ));
    }
    Ok(sql)
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
/// English-only filter keeps; with `quality`, which callers pass for live
/// channels only, only channels the Live TV quality filter keeps), so
/// `catalog.categories` can take them out of `itemCount`.
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
    quality: Option<QualityFilter>,
) -> CoreResult<HashMap<String, i64>> {
    let sql = if english_only {
        "SELECT i.category_id, count(*) FROM parental_locks pl CROSS JOIN items i ON i.source_id = pl.source_id AND i.content_type = pl.content_type AND i.item_id = pl.target_id LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE pl.source_id = ?1 AND pl.content_type = ?2 AND pl.kind = 'item' AND non_english(i.title, c.name) = 0"
    } else {
        "SELECT i.category_id, count(*) FROM parental_locks pl CROSS JOIN items i ON i.source_id = pl.source_id AND i.content_type = pl.content_type AND i.item_id = pl.target_id WHERE pl.source_id = ?1 AND pl.content_type = ?2 AND pl.kind = 'item'"
    };
    let quality_sql = quality::live_clause(quality, "i");
    let sql = format!("{sql}{quality_sql} GROUP BY i.category_id");
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
