//! Picture quality of live channels, for the Live TV quality filter
//! (`liveMinQuality`, `liveHideUntagged`).
//!
//! The quality is read from the provider's channel name with the failover
//! matcher's marker rules ([`matcher::quality`]: SD/480p/576p, HD/720p,
//! FHD/1080p, UHD/4K/8K/2160p), so a user rename (`channel_edits`) does not
//! change it. Since migration 0022 it is stored with each item as a code
//! (`items.quality`, copied to `items_rank`): [`UNSET`] until computed,
//! [`UNTAGGED`] for a name without a marker, then 1 SD to 4 UHD. The catalog
//! writer stores [`code`] for live rows and [`UNTAGGED`] for every other
//! type: radio, movies and series are never filtered. Live rows written
//! before the migration get theirs from [`backfill`] at boot; until then
//! readers treat them as untagged.
//!
//! Readers filter with [`QualityFilter`] and the clauses built from it
//! ([`live_clause`], [`mixed_clause`]). Thresholds are integer literals, so
//! each setting is one cached statement.

use crate::error::CoreResult;
use crate::live::matcher::{self, Quality};
use crate::model::Settings;
use rusqlite::{params, Connection, TransactionBehavior};

/// `items.quality` of a row whose quality is not computed yet (written
/// before migration 0022). Readers treat it as untagged.
pub const UNSET: i64 = -1;
/// `items.quality` of a name without a quality marker, and of every row that
/// is not a live channel.
pub const UNTAGGED: i64 = 0;

/// Live rows one [`backfill`] transaction updates.
const BACKFILL_BATCH: usize = 5_000;

/// Stored code of a detected quality (0 when the name has no tag).
pub fn code(q: Option<Quality>) -> i64 {
    match q {
        None => UNTAGGED,
        Some(Quality::Sd) => 1,
        Some(Quality::Hd) => 2,
        Some(Quality::Fhd) => 3,
        Some(Quality::Uhd) => 4,
    }
}

/// The Live TV quality filter of the current settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QualityFilter {
    /// Lowest quality a tagged channel may have.
    pub min: Quality,
    /// Channels whose name has no quality tag are hidden too.
    pub hide_untagged: bool,
}

impl QualityFilter {
    /// None while `live_min_quality` is None (filter off).
    pub fn from_settings(s: &Settings) -> Option<QualityFilter> {
        s.live_min_quality.map(|min| QualityFilter {
            min,
            hide_untagged: s.live_hide_untagged,
        })
    }

    /// Whether a channel of this detected quality stays visible (live
    /// alternates, tests).
    pub fn keeps(&self, q: Option<Quality>) -> bool {
        match q {
            Some(q) => q >= self.min,
            None => !self.hide_untagged,
        }
    }

    /// Same rule on a stored code (-1 and 0 count as untagged).
    pub fn keeps_code(&self, code: i64) -> bool {
        if code <= UNTAGGED {
            !self.hide_untagged
        } else {
            code >= self.min_code()
        }
    }

    /// The bare condition on `{alias}.quality`, or None when it keeps every
    /// row (min SD and not hide_untagged).
    pub fn condition(&self, alias: &str) -> Option<String> {
        let min = self.min_code();
        if self.hide_untagged {
            Some(format!("{alias}.quality >= {min}"))
        } else if min > 1 {
            Some(format!("{alias}.quality NOT BETWEEN 1 AND {}", min - 1))
        } else {
            None
        }
    }

    fn min_code(&self) -> i64 {
        code(Some(self.min))
    }
}

/// " AND <condition>" for statements that read only live rows; "" when off.
pub fn live_clause(f: Option<QualityFilter>, alias: &str) -> String {
    match f.and_then(|f| f.condition(alias)) {
        Some(c) => format!(" AND {c}"),
        None => String::new(),
    }
}

/// " AND ({alias}.content_type <> 'live' OR <condition>)" for statements
/// that mix types; "" when off.
pub fn mixed_clause(f: Option<QualityFilter>, alias: &str) -> String {
    match f.and_then(|f| f.condition(alias)) {
        Some(c) => format!(" AND ({alias}.content_type <> 'live' OR {c})"),
        None => String::new(),
    }
}

/// Stores the code of every live row still at [`UNSET`] (catalogs written
/// before migration 0022), source by source, in IMMEDIATE transactions of
/// [`BACKFILL_BATCH`] rows so user writes interleave. Names are read and
/// matched outside the write lock; a row a catalog rewrite has replaced
/// since is skipped (the writer stored its code). Other types keep
/// [`UNSET`] until their next rewrite: no reader filters them. Returns the
/// number of rows stored. Runs in the background at boot (`catalog::init`).
pub fn backfill(conn: &mut Connection) -> CoreResult<usize> {
    let sources: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM sources")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut done = 0;
    for source_id in sources {
        let pending: Vec<(i64, i64)> = {
            let mut stmt = conn.prepare_cached(
                "SELECT rowid, title FROM items WHERE source_id = ?1 AND content_type = 'live' AND quality = -1",
            )?;
            let rows = stmt.query_map([&source_id], |r| {
                let title: String = r.get(1)?;
                Ok((r.get(0)?, code(matcher::quality(&title))))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        for batch in pending.chunks(BACKFILL_BATCH) {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut set = tx.prepare_cached(
                    "UPDATE items SET quality = ?2 WHERE rowid = ?1 AND content_type = 'live' AND quality = -1",
                )?;
                for (rowid, q) in batch {
                    done += set.execute(params![rowid, q])?;
                }
            }
            tx.commit()?;
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUALITIES: [Quality; 4] = [Quality::Sd, Quality::Hd, Quality::Fhd, Quality::Uhd];

    /// Every minimum with both toggles, as the settings give them.
    fn filters() -> Vec<QualityFilter> {
        let mut out = Vec::new();
        for min in QUALITIES {
            for hide in [false, true] {
                let s = Settings {
                    live_min_quality: Some(min),
                    live_hide_untagged: hide,
                    ..Settings::default()
                };
                out.extend(QualityFilter::from_settings(&s));
            }
        }
        assert_eq!(out.len(), 8);
        out
    }

    #[test]
    fn codes_follow_the_quality_order() {
        assert_eq!(code(None), UNTAGGED);
        let codes: Vec<i64> = QUALITIES.iter().map(|q| code(Some(*q))).collect();
        assert_eq!(codes, [1, 2, 3, 4]);
    }

    #[test]
    fn the_filter_is_off_without_a_minimum() {
        let mut s = Settings {
            live_hide_untagged: true,
            ..Settings::default()
        };
        assert_eq!(QualityFilter::from_settings(&s), None, "toggle only");
        s.live_min_quality = Some(Quality::Fhd);
        let want = QualityFilter {
            min: Quality::Fhd,
            hide_untagged: true,
        };
        assert_eq!(QualityFilter::from_settings(&s), Some(want));
        assert_eq!(live_clause(None, "i"), "");
        assert_eq!(mixed_clause(None, "i"), "");
        // A minimum of SD hides nothing tagged: no clause unless untagged
        // channels are hidden.
        let sd = QualityFilter {
            min: Quality::Sd,
            hide_untagged: false,
        };
        assert_eq!(sd.condition("i"), None);
        assert_eq!(live_clause(Some(sd), "i"), "");
        assert!((-1..=4).all(|c| sd.keeps_code(c)));
    }

    #[test]
    fn keeps_and_keeps_code_agree() {
        for f in filters() {
            assert_eq!(f.keeps(None), f.keeps_code(UNTAGGED), "{f:?}");
            assert_eq!(f.keeps(None), f.keeps_code(UNSET), "{f:?}");
            for q in QUALITIES {
                let c = code(Some(q));
                assert_eq!(f.keeps(Some(q)), f.keeps_code(c), "{f:?} {q:?}");
            }
        }
        let fhd = QualityFilter {
            min: Quality::Fhd,
            hide_untagged: false,
        };
        assert!(!fhd.keeps(Some(Quality::Hd)));
        assert!(fhd.keeps(Some(Quality::Uhd)));
        assert!(fhd.keeps(None), "untagged channels stay by default");
        let strict = QualityFilter {
            hide_untagged: true,
            ..fhd
        };
        assert!(!strict.keeps(None));
        assert!(strict.keeps(Some(Quality::Fhd)));
    }

    /// The SQL condition keeps exactly the codes `keeps_code` keeps, for
    /// every code, minimum and toggle, evaluated by SQLite; the mixed clause
    /// keeps every row of the other types.
    #[test]
    fn sql_conditions_match_keeps_code() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (content_type TEXT, quality INTEGER)")
            .unwrap();
        for ct in ["live", "radio", "movie", "series"] {
            for q in -1..=4 {
                conn.execute("INSERT INTO t VALUES (?1, ?2)", params![ct, q])
                    .unwrap();
            }
        }
        let codes = |sql: &str| -> Vec<(String, i64)> {
            let mut stmt = conn.prepare(sql).unwrap();
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)));
            rows.unwrap().collect::<Result<_, _>>().unwrap()
        };
        let all = codes("SELECT * FROM t ORDER BY rowid");
        for f in filters() {
            let live = codes(&format!(
                "SELECT * FROM t AS i WHERE i.content_type = 'live'{} ORDER BY rowid",
                live_clause(Some(f), "i")
            ));
            let want: Vec<(String, i64)> = all
                .iter()
                .filter(|(ct, q)| ct == "live" && f.keeps_code(*q))
                .cloned()
                .collect();
            assert_eq!(live, want, "{f:?}: {:?}", f.condition("i"));

            let mixed = codes(&format!(
                "SELECT * FROM t AS i WHERE 1{} ORDER BY rowid",
                mixed_clause(Some(f), "i")
            ));
            let want: Vec<(String, i64)> = all
                .iter()
                .filter(|(ct, q)| ct != "live" || f.keeps_code(*q))
                .cloned()
                .collect();
            assert_eq!(mixed, want, "{f:?}");
        }
    }

    /// Live rows written before migration 0022 get their code; other types
    /// and rows the writer already stored are left alone, and `items_rank`
    /// follows.
    #[test]
    fn backfill_stores_live_codes() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}'), ('t', 'm3u', 'T', '{}');
             INSERT INTO items(source_id, content_type, item_id, category_id, title) VALUES
               ('s', 'live', '1', 'g', 'UK: Sky Sports 1 FHD'),
               ('s', 'live', '2', 'g', 'BBC One HD'),
               ('s', 'live', '3', 'g', '4K | Sky Cinema'),
               ('s', 'live', '4', 'g', 'Film4 +1'),
               ('s', 'radio', '5', 'g', 'Radio HD'),
               ('s', 'movie', '6', 'g', 'Heat 4K'),
               ('t', 'live', '7', 'g', 'Channel 5 SD');
             INSERT INTO items(source_id, content_type, item_id, category_id, title, quality) VALUES
               ('t', 'live', '8', 'g', 'Stored HD', 0);",
        )
        .unwrap();
        assert_eq!(backfill(&mut conn).unwrap(), 5);
        let stored = |id: &str| -> (i64, i64) {
            conn.query_row(
                "SELECT i.quality, r.quality FROM items i JOIN items_rank r ON r.id = i.rowid WHERE i.item_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        for (id, want) in [
            ("1", 3),
            ("2", 2),
            ("3", 4),
            ("4", UNTAGGED),
            ("5", UNSET),
            ("6", UNSET),
            ("7", 1),
            ("8", UNTAGGED),
        ] {
            assert_eq!(stored(id), (want, want), "item {id}");
        }
        assert_eq!(backfill(&mut conn).unwrap(), 0, "nothing left");
    }
}
