//! L2 cross-core-perf: a large catalog rewrite drops the secondary indexes of
//! `items` and builds them again before its commit (one sort instead of a
//! b-tree update per row and index), and rows whose category is declared
//! first get their final English-only verdict on insert. These tests pin the
//! result: the same indexes, the same verdicts as the per-row rule, the
//! same live channel quality codes as the matcher, query plans still on the
//! covering indexes, and a failed rewrite rolls the dropped indexes back
//! with the rows.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::language::is_non_english;
use iptv_core::catalog::quality::code;
use iptv_core::catalog::{self, CatalogWriter, CategoryRow, ItemRow, BULK_MIN_ROWS};
use iptv_core::live::matcher;
use iptv_core::model::ContentType;
use rusqlite::Connection;
use std::collections::BTreeSet;
use support::*;

/// More rows than the bulk threshold.
const N: u64 = BULK_MIN_ROWS + 1_500;

fn categories() -> Vec<CategoryRow> {
    ["FR | Films", "UK | Films", "Films", "Кино"]
        .iter()
        .enumerate()
        .map(|(i, name)| CategoryRow {
            category_id: format!("c{i}"),
            name: (*name).into(),
            position: i as i64,
        })
        .collect()
}

/// Movies with untagged, tagged and foreign-script titles spread over the
/// four declared categories and one undeclared id (a fallback category).
fn movies(source: &str, salt: &str) -> Vec<ItemRow> {
    (0..N)
        .map(|i| {
            let title = match i % 4 {
                0 => format!("Movie {salt}{i}"),
                1 => format!("FR - Film {salt}{i}"),
                2 => format!("Фильм {salt}{i}"),
                _ => format!("EN - Night {salt}{i}"),
            };
            let category = if i % 97 == 0 {
                "undeclared".to_string()
            } else {
                format!("c{}", i % 4)
            };
            ItemRow {
                source_id: source.into(),
                content_type: ContentType::Movie,
                item_id: format!("{salt}{i}"),
                category_id: category,
                title,
                rating: Some((i % 10) as f64),
                year: Some(1990 + (i % 30) as i64),
                position: i as i64,
                ..Default::default()
            }
        })
        .collect()
}

fn item_indexes(c: &Connection) -> Vec<(String, String)> {
    let mut stmt = c
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' AND sql IS NOT NULL ORDER BY name",
        )
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Every stored verdict of `source` equals the per-row rule.
fn assert_verdicts(c: &Connection, source: &str) {
    let mut stmt = c
        .prepare(
            "SELECT i.title, c.name, i.non_english FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE i.source_id = ?1",
        )
        .unwrap();
    let rows: Vec<(String, Option<String>, bool)> = stmt
        .query_map([source], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len() as u64, N, "{source}: every row written");
    let wrong: Vec<_> = rows
        .iter()
        .filter(|(t, cat, v)| is_non_english(t, cat.as_deref()) != *v)
        .take(5)
        .collect();
    assert!(
        wrong.is_empty(),
        "{source}: stored verdicts off the rule: {wrong:?}"
    );
    let hidden = rows.iter().filter(|r| r.2).count();
    assert!(
        hidden > 0 && hidden < rows.len(),
        "{source}: a mixed catalog"
    );
}

fn plan(c: &Connection, sql: &str) -> String {
    let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join(" | ")
}

/// Writes `source` through the writer with its categories declared first
/// (the Xtream and M3U path).
fn write_declared(c: &mut Connection, source: &str, rows: &[ItemRow]) {
    let tx = c.transaction().unwrap();
    {
        let mut w = CatalogWriter::begin(&tx, source, &[ContentType::Movie], None).unwrap();
        w.declare_categories(ContentType::Movie, &categories());
        for r in rows {
            w.insert(r).unwrap();
        }
        w.finish(&[(ContentType::Movie, categories())]).unwrap();
    }
    tx.commit().unwrap();
}

#[tokio::test]
async fn bulk_rewrites_keep_every_index_and_store_exact_verdicts() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    env.state
        .db_call(|c| {
            let before = item_indexes(c);
            assert!(before.len() >= 6, "the 0018 indexes exist: {before:?}");

            // A first import (no rows to replace): the writer goes bulk once
            // it has offered BULK_MIN_ROWS rows, categories not declared.
            let mut rows = movies("s1", "a").into_iter();
            catalog::replace_catalog(c, "s1", ContentType::Movie, &categories(), &mut rows)?;
            assert_eq!(item_indexes(c), before);
            assert_verdicts(c, "s1");
            assert_items_rank(c);

            // A second source as large as the first, categories declared:
            // it touches fewer rows than it would re-sort, so its indexes
            // are updated row by row.
            write_declared(c, "s2", &movies("s2", "b"));
            assert_eq!(item_indexes(c), before);
            assert_verdicts(c, "s2");
            assert_items_rank(c);

            // A refresh of s1 replaces enough rows to drop the indexes in begin.
            write_declared(c, "s1", &movies("s1", "c"));
            assert_eq!(item_indexes(c), before);
            assert_verdicts(c, "s1");
            assert_verdicts(c, "s2");
            assert_items_rank(c);

            for (sort, index) in [
                ("rating DESC, position", "idx_items_rating"),
                ("year DESC, position", "idx_items_year"),
                ("title COLLATE NOCASE, position", "idx_items_title"),
                ("position", "idx_items_pos"),
            ] {
                let p = plan(
                    c,
                    &format!("SELECT rowid FROM items WHERE source_id = 's1' AND content_type = 'movie' AND non_english = 0 ORDER BY {sort} LIMIT 60 OFFSET 20000"),
                );
                assert!(p.contains(index) && !p.contains("TEMP B-TREE"), "{sort}: {p}");
            }
            let counts: i64 = c.query_row(
                "SELECT sum(item_count) FROM categories WHERE source_id = 's1' AND content_type = 'movie'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(counts as u64, N, "category counts read the rebuilt indexes");
            let fts: i64 = c.query_row(
                "SELECT count(*) FROM items_fts WHERE items_fts MATCH 'night'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(fts as u64, 2 * (N / 4), "search finds both sources' rows");
            Ok(())
        })
        .await
        .unwrap();
}

/// `n` plain movies in category c0.
fn plain(source: &str, salt: &str, n: u64) -> Vec<ItemRow> {
    (0..n)
        .map(|i| ItemRow {
            source_id: source.into(),
            content_type: ContentType::Movie,
            item_id: format!("{salt}{i}"),
            category_id: "c0".into(),
            title: format!("Movie {salt}{i}"),
            position: i as i64,
            ..Default::default()
        })
        .collect()
}

/// Whether a rewrite of `source` with `rows` has dropped the indexes of
/// `items` once its last row is in. The rewrite is rolled back.
fn goes_bulk(c: &mut Connection, source: &str, rows: &[ItemRow]) -> bool {
    let tx = c.transaction().unwrap();
    let mut w = CatalogWriter::begin(&tx, source, &[ContentType::Movie], None).unwrap();
    for r in rows {
        w.insert(r).unwrap();
    }
    item_indexes(&tx).is_empty()
}

/// L3 XA-8: once `begin` has deleted the replaced rows, a refresh is weighed
/// against the other sources' rows only (they used to be counted short by
/// the replaced rows, so a refresh smaller than what it keeps went bulk). A
/// refresh that outgrows them, or replaces a large source in full, still
/// goes bulk.
#[tokio::test]
async fn bulk_mode_weighs_a_refresh_against_the_rows_it_keeps() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    env.state
        .db_call(|c| {
            let before = item_indexes(c);
            write_declared(c, "s1", &plain("s1", "a", 26_000));
            write_declared(c, "s2", &plain("s2", "b", 10_000));
            // 10k replaced + 12k new: past BULK_MIN_ROWS, under the 26k rows
            // of s1 a rebuild would sort too.
            assert!(
                !goes_bulk(c, "s2", &plain("s2", "c", 12_000)),
                "a refresh smaller than the rows it keeps updates its indexes"
            );
            assert_eq!(item_indexes(c), before);
            // 10k replaced + 17k new outgrows s1.
            assert!(
                goes_bulk(c, "s2", &plain("s2", "d", 17_000)),
                "a refresh larger than the rows it keeps goes bulk"
            );
            assert_eq!(item_indexes(c), before, "rolled back with the rows");
            // A full refresh of s1 replaces 26k rows against s2's 10k.
            {
                let tx = c.transaction()?;
                let _w = CatalogWriter::begin(&tx, "s1", &[ContentType::Movie], None)?;
                assert!(item_indexes(&tx).is_empty(), "bulk from begin");
            }
            assert_eq!(item_indexes(c), before);
            assert_items_rank(c);
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_failed_bulk_rewrite_rolls_back_rows_and_indexes() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    env.state
        .db_call(|c| {
            let before = item_indexes(c);
            write_declared(c, "s1", &movies("s1", "a"));
            {
                let tx = c.transaction()?;
                let mut w = CatalogWriter::begin(&tx, "s1", &[ContentType::Movie], None)?;
                // begin replaced N rows: the indexes are gone inside the
                // transaction.
                assert!(item_indexes(&tx).is_empty());
                for r in movies("s1", "z").iter().take(100) {
                    w.insert(r)?;
                }
                let live = ItemRow {
                    source_id: "s1".into(),
                    content_type: ContentType::Live,
                    item_id: "x".into(),
                    category_id: "c0".into(),
                    title: "X".into(),
                    ..Default::default()
                };
                assert!(w.insert(&live).is_err(), "a live row in a movie rewrite");
                // Dropped without commit: rolled back.
            }
            assert_eq!(item_indexes(c), before);
            let n: i64 = c.query_row(
                "SELECT count(*) FROM items WHERE source_id = 's1' AND item_id LIKE 'a%'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n as u64, N, "the previous catalog stays");
            assert_verdicts(c, "s1");
            assert_items_rank(c);
            Ok(())
        })
        .await
        .unwrap();
}

/// Live channels with every kind of quality marker, and none.
fn channels(source: &str, salt: &str) -> Vec<ItemRow> {
    (0..N)
        .map(|i| {
            let title = match i % 6 {
                0 => format!("UK: Sports {salt}{i} FHD"),
                1 => format!("News {salt}{i} HD"),
                2 => format!("4K | Cinema {salt}{i}"),
                3 => format!("Kids {salt}{i} SD"),
                4 => format!("Music {salt}{i} 720p"),
                _ => format!("Local {salt}{i}"),
            };
            ItemRow {
                source_id: source.into(),
                content_type: ContentType::Live,
                item_id: format!("{salt}{i}"),
                category_id: format!("c{}", i % 4),
                title,
                position: i as i64,
                ..Default::default()
            }
        })
        .collect()
}

/// Every row of `source` stores the quality code of its name, and every
/// code occurs.
fn assert_qualities(c: &Connection, source: &str) {
    let mut stmt = c
        .prepare("SELECT title, quality FROM items WHERE source_id = ?1")
        .unwrap();
    let rows: Vec<(String, i64)> = stmt
        .query_map([source], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len() as u64, N, "{source}: every row written");
    let wrong: Vec<_> = rows
        .iter()
        .filter(|(t, q)| code(matcher::quality(t)) != *q)
        .take(5)
        .collect();
    assert!(
        wrong.is_empty(),
        "{source}: stored qualities off the matcher: {wrong:?}"
    );
    let codes: BTreeSet<i64> = rows.iter().map(|r| r.1).collect();
    assert_eq!(codes, BTreeSet::from([0, 1, 2, 3, 4]), "{source}");
}

/// Quality filter: a bulk rewrite of live channels stores each row's
/// quality code as a row-by-row one does, the rebuilt indexes still end in
/// `quality` (migration 0022), and a filtered live page and count stay on
/// their covering indexes.
#[tokio::test]
async fn bulk_rewrites_store_live_channel_quality() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    env.state
        .db_call(|c| {
            let before = item_indexes(c);
            for name in [
                "idx_items_cat",
                "idx_items_pos",
                "idx_items_title",
                "idx_items_guide",
            ] {
                let sql = before
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, sql)| sql.as_str());
                assert!(
                    sql.is_some_and(|s| s.contains("quality")),
                    "{name} holds the quality column: {sql:?}"
                );
            }
            // A first import goes bulk once it passes BULK_MIN_ROWS; the
            // refresh replaces enough rows to go bulk in begin.
            for salt in ["a", "b"] {
                let tx = c.transaction()?;
                {
                    let mut w = CatalogWriter::begin(&tx, "s1", &[ContentType::Live], None)?;
                    for r in channels("s1", salt) {
                        w.insert(&r)?;
                    }
                    assert!(item_indexes(&tx).is_empty(), "{salt}: bulk");
                    w.finish(&[(ContentType::Live, Vec::new())])?;
                }
                tx.commit()?;
                assert_eq!(item_indexes(c), before);
                assert_qualities(c, "s1");
                assert_items_rank(c);
            }
            let p = plan(
                c,
                "SELECT rowid FROM items WHERE source_id = 's1' AND content_type = 'live' AND quality >= 3 ORDER BY position LIMIT 60 OFFSET 20000",
            );
            assert!(
                p.contains("COVERING INDEX idx_items_pos") && !p.contains("TEMP B-TREE"),
                "{p}"
            );
            // The rebuilds keep the creation order 0022 chose, so a filtered
            // count still reads the narrow category index, not the title one.
            let p = plan(
                c,
                "SELECT count(*) FROM items WHERE source_id = 's1' AND content_type = 'live' AND non_english = 0 AND quality >= 3",
            );
            assert!(p.contains("COVERING INDEX idx_items_cat"), "{p}");
            Ok(())
        })
        .await
        .unwrap();
}
