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
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

/// Tables keyed by `(source_id, content_type, item_id)`.
const REF_TABLES: [&str; 14] = [
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
    "epg_channel_shift",
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

/// Hash of an [`identity`]. A collision only makes a key look shared, and
/// shared keys are left alone.
fn identity_hash(key: &str) -> u64 {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    h.finish()
}

/// Hash of a `(content_type, item_id)` pair.
fn ref_hash(content_type: &str, item_id: &str) -> u64 {
    let mut h = DefaultHasher::new();
    content_type.hash(&mut h);
    item_id.hash(&mut h);
    h.finish()
}

/// Inserts `id` under `key`, marking the key ambiguous (`None`) on a repeat.
fn index(map: &mut HashMap<String, Option<String>>, key: String, id: &str) {
    map.entry(key)
        .and_modify(|v| *v = None)
        .or_insert_with(|| Some(id.to_string()));
}

/// The catalog of a source before a re-import, limited to what a remap needs.
/// Empty (and free) when no user table references an item of the source.
///
/// Only the referenced ids and their identities are kept as strings. Every
/// other row adds two hashes: its id and its identity's count (IN-5; maps of
/// every old and new row cost about 120 MB at 200k entries).
#[derive(Default)]
pub(crate) struct Remapper {
    /// Referenced old ids, their identity and its [`identity_hash`].
    referenced: HashMap<Ref, (String, u64)>,
    /// [`ref_hash`] of the referenced ids: a cheap first test per new row.
    referenced_hashes: HashSet<u64>,
    /// [`ref_hash`] of every old id (a new id equal to one of these is not
    /// "new"; a collision only skips a move).
    old_ids: HashSet<u64>,
    /// [`identity_hash`] -> old rows with it.
    old_counts: HashMap<u64, u32>,
    /// The referenced identities.
    wanted: HashSet<String>,
    /// Referenced identity -> the one new id with it (`None`: more than one).
    new_by_key: HashMap<String, Option<String>>,
    /// Referenced ids the import wrote again.
    kept: HashSet<Ref>,
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
            let key_hash = identity_hash(&key);
            *me.old_counts.entry(key_hash).or_default() += 1;
            me.old_ids.insert(ref_hash(&ct, &id));
            let r = (ct, id);
            if referenced.contains(&r) {
                me.referenced_hashes.insert(ref_hash(&r.0, &r.1));
                me.wanted.insert(key.clone());
                me.referenced.insert(r, (key, key_hash));
            }
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
        if self.referenced_hashes.contains(&ref_hash(ct, &row.item_id)) {
            let r = (ct.to_string(), row.item_id.clone());
            if self.referenced.contains_key(&r) {
                self.kept.insert(r);
            }
        }
        let key = identity(
            ct,
            row.epg_channel_id.as_deref(),
            &row.title,
            &row.category_id,
        );
        if self.wanted.contains(&key) {
            index(&mut self.new_by_key, key, &row.item_id);
        }
    }

    /// `(content_type, old id, new id)` for every referenced id that vanished
    /// and has exactly one successor.
    fn pairs(&self) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for ((ct, old), (key, key_hash)) in &self.referenced {
            if self.kept.contains(&(ct.clone(), old.clone())) {
                continue;
            }
            // The referenced row is one of the old rows with its identity:
            // it is the only one when the count is 1.
            if self.old_counts.get(key_hash) != Some(&1) {
                continue;
            }
            let Some(Some(new)) = self.new_by_key.get(key) else {
                continue;
            };
            if self.old_ids.contains(&ref_hash(ct, new)) {
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
