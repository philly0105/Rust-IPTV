//! Keeps user state attached to M3U items whose id changed on re-import.
//!
//! An M3U item id hashes the stream URL and the name ([`super::item_id`]), so
//! a provider that rotates the token in its URLs, or a changed line password,
//! gives every row a new id. Inside the import transaction, every table that
//! stores item ids is rewritten from a vanished id to the new id of the row
//! with the same identity: `tvg-id` + name when the entry has a `tvg-id`,
//! otherwise name + group. Only unique matches move (one old row and one new
//! row with that identity, of the same content type); anything ambiguous is
//! left alone rather than guessed.

use crate::catalog::ItemRow;
use crate::error::CoreResult;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

/// Tables keyed by `(source_id, content_type, item_id)`.
const REF_TABLES: [&str; 13] = [
    "favorites",
    "recent",
    "playback_positions",
    "downloads",
    "reminders",
    "recordings",
    "watchlist",
    "channel_edits",
    "custom_list_items",
    "recording_rules",
    "watch_log",
    "epg_channel_map",
    "parental_locks",
];

/// `(content_type, item_id)`.
type Ref = (String, String);

/// Identity of an item that survives a URL change.
fn identity(content_type: &str, tvg_id: Option<&str>, title: &str, category_id: &str) -> String {
    match tvg_id.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tvg) => format!("{content_type}\u{1}t\u{1}{tvg}\u{1}{title}"),
        None => format!("{content_type}\u{1}g\u{1}{category_id}\u{1}{title}"),
    }
}

/// Inserts `id` under `key`, marking the key ambiguous (`None`) on a repeat.
fn index(map: &mut HashMap<String, Option<String>>, key: String, id: &str) {
    map.entry(key)
        .and_modify(|v| *v = None)
        .or_insert_with(|| Some(id.to_string()));
}

/// The catalog of a source before a re-import, limited to what a remap needs.
/// Empty (and free) when no user table references an item of the source.
#[derive(Default)]
pub(crate) struct Remapper {
    /// Referenced old ids and their identity.
    referenced: HashMap<Ref, String>,
    /// Every old id (a new id equal to one of these is not "new").
    old_ids: HashSet<Ref>,
    /// Identity -> the one old id with it (`None`: more than one).
    old_by_key: HashMap<String, Option<String>>,
    /// Identity -> the one new id with it (`None`: more than one).
    new_by_key: HashMap<String, Option<String>>,
    new_ids: HashSet<Ref>,
    /// Old rows before the import (also tells a first import apart).
    pub old_rows: u64,
}

impl Remapper {
    /// Reads the source's current catalog. Call before the catalog writer
    /// deletes it, inside the import transaction.
    pub fn before(conn: &Connection, source_id: &str) -> CoreResult<Self> {
        let old_rows: i64 = conn.query_row(
            "SELECT count(*) FROM items WHERE source_id = ?1",
            [source_id],
            |r| r.get(0),
        )?;
        let mut me = Self {
            old_rows: old_rows.max(0) as u64,
            ..Self::default()
        };
        if old_rows == 0 {
            return Ok(me);
        }
        let mut referenced: HashSet<Ref> = HashSet::new();
        for table in REF_TABLES {
            let item_col = if table == "parental_locks" {
                "target_id"
            } else {
                "item_id"
            };
            let filter = if table == "parental_locks" {
                " AND kind = 'item'"
            } else {
                ""
            };
            let mut stmt = conn.prepare(&format!(
                "SELECT DISTINCT content_type, {item_col} FROM {table} WHERE source_id = ?1{filter}"
            ))?;
            let rows = stmt.query_map([source_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            for row in rows {
                referenced.insert(row?);
            }
        }
        {
            let mut stmt =
                conn.prepare("SELECT DISTINCT item_id FROM vod_source_pins WHERE source_id = ?1")?;
            let rows = stmt.query_map([source_id], |r| r.get::<_, String>(0))?;
            for id in rows {
                let id = id?;
                referenced.insert(("movie".into(), id.clone()));
                referenced.insert(("series".into(), id));
            }
        }
        if referenced.is_empty() {
            return Ok(me);
        }
        let mut stmt = conn.prepare(
            "SELECT content_type, item_id, epg_channel_id, title, category_id FROM items WHERE source_id = ?1",
        )?;
        let rows = stmt.query_map([source_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (ct, id, tvg, title, cat) = row?;
            let key = identity(&ct, tvg.as_deref(), &title, &cat);
            index(&mut me.old_by_key, key.clone(), &id);
            let r = (ct, id);
            if referenced.contains(&r) {
                me.referenced.insert(r.clone(), key);
            }
            me.old_ids.insert(r);
        }
        Ok(me)
    }

    /// True when nothing references the old catalog (no work to do).
    fn idle(&self) -> bool {
        self.referenced.is_empty()
    }

    /// Records a row the import wrote.
    pub fn saw(&mut self, row: &ItemRow) {
        if self.idle() {
            return;
        }
        let ct = row.content_type.as_str();
        let key = identity(
            ct,
            row.epg_channel_id.as_deref(),
            &row.title,
            &row.category_id,
        );
        index(&mut self.new_by_key, key, &row.item_id);
        self.new_ids.insert((ct.to_string(), row.item_id.clone()));
    }

    /// `(content_type, old id, new id)` for every referenced id that vanished
    /// and has exactly one successor.
    fn pairs(&self) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for ((ct, old), key) in &self.referenced {
            if self.new_ids.contains(&(ct.clone(), old.clone())) {
                continue;
            }
            let Some(Some(unique_old)) = self.old_by_key.get(key) else {
                continue;
            };
            if unique_old != old {
                continue;
            }
            let Some(Some(new)) = self.new_by_key.get(key) else {
                continue;
            };
            if self.old_ids.contains(&(ct.clone(), new.clone())) {
                continue;
            }
            out.push((ct.clone(), old.clone(), new.clone()));
        }
        out.sort();
        out
    }

    /// Moves every reference of a vanished id to its successor. Rows that
    /// would collide with an existing row of the new id stay as they were.
    /// Returns the number of ids moved.
    pub fn apply(&self, conn: &Connection, source_id: &str) -> CoreResult<usize> {
        if self.idle() {
            return Ok(0);
        }
        let pairs = self.pairs();
        for (ct, old, new) in &pairs {
            for table in REF_TABLES {
                let (item_col, filter) = if table == "parental_locks" {
                    ("target_id", " AND kind = 'item'")
                } else {
                    ("item_id", "")
                };
                conn.prepare_cached(&format!(
                    "UPDATE OR IGNORE {table} SET {item_col} = ?4 WHERE source_id = ?1 AND content_type = ?2 AND {item_col} = ?3{filter}"
                ))?
                .execute(params![source_id, ct, old, new])?;
            }
            if ct == "movie" || ct == "series" {
                conn.prepare_cached(
                    "UPDATE OR IGNORE vod_source_pins SET item_id = ?3 WHERE source_id = ?1 AND item_id = ?2",
                )?
                .execute(params![source_id, old, new])?;
            }
        }
        if !pairs.is_empty() {
            tracing::info!(
                source_id,
                moved = pairs.len(),
                "m3u item ids changed; user state moved to the new ids"
            );
        }
        Ok(pairs.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_prefers_tvg_id_and_falls_back_to_group() {
        assert_eq!(
            identity("live", Some("bbc1.uk"), "BBC One", "g1"),
            identity("live", Some(" bbc1.uk "), "BBC One", "g2")
        );
        assert_ne!(
            identity("live", None, "BBC One", "g1"),
            identity("live", None, "BBC One", "g2")
        );
        assert_eq!(
            identity("live", Some(""), "BBC One", "g1"),
            identity("live", None, "BBC One", "g1")
        );
        assert_ne!(
            identity("live", None, "BBC One", "g1"),
            identity("radio", None, "BBC One", "g1")
        );
    }
}
