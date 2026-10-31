//! The bulk steps of large catalog writes: a refresh that says how many rows
//! it offers drops the indexes of `items` before its deletes, a rewrite of
//! every row empties the search index and the ranking rows in one step each,
//! and removing a source that is most of the catalog drops the indexes and
//! builds them again over the rows left. Each must leave the same indexes in
//! the same order, a search index that passes SQLite's own check and matches
//! `items`, and complete `items_rank` rows.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{self, CatalogWriter, ItemRow, BULK_MIN_ROWS};
use iptv_core::model::ContentType;
use iptv_core::sources::store;
use iptv_core::CoreError;
use rusqlite::Connection;
use support::*;

/// More rows than the bulk threshold.
const N: u64 = BULK_MIN_ROWS + 1_500;

/// `n` movies of `source` titled "Movie <salt><i>".
fn movies(source: &str, salt: &str, n: u64) -> Vec<ItemRow> {
    (0..n)
        .map(|i| ItemRow {
            source_id: source.into(),
            content_type: ContentType::Movie,
            item_id: format!("{salt}{i}"),
            category_id: format!("c{}", i % 7),
            title: format!("Movie {salt}{i}"),
            rating: Some((i % 10) as f64),
            position: i as i64,
            ..Default::default()
        })
        .collect()
}

fn write(c: &mut Connection, source: &str, rows: Vec<ItemRow>) {
    catalog::replace_catalog(c, source, ContentType::Movie, &[], &mut rows.into_iter()).unwrap();
}

/// The indexes of `items` in creation order (the order decides which of
/// two covering indexes SQLite reads, see `catalog::drop_item_indexes`).
fn item_indexes(c: &Connection) -> Vec<(String, String)> {
    let mut stmt = c
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' AND sql IS NOT NULL ORDER BY rowid",
        )
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Titles with a word starting with `prefix`, through the search index.
fn found(c: &Connection, prefix: &str) -> u64 {
    c.query_row(
        "SELECT count(*) FROM items_fts WHERE items_fts MATCH ?1",
        [format!("\"{prefix}\"*")],
        |r| r.get::<_, i64>(0),
    )
    .unwrap() as u64
}

/// The search index passes SQLite's check against `items` and holds one
/// entry per item, and `items_rank` matches `items`.
fn assert_search_rows(c: &Connection) {
    c.execute(
        "INSERT INTO items_fts(items_fts, rank) VALUES('integrity-check', 1)",
        [],
    )
    .expect("items_fts integrity-check");
    let (items, fts): (i64, i64) = c
        .query_row(
            "SELECT (SELECT count(*) FROM items), (SELECT count(*) FROM items_fts)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(fts, items, "one search entry per item");
    assert_items_rank(c);
}

/// A refresh that says how many rows it offers is weighed with them before
/// its deletes: bulk from `begin` when the deleted and offered rows outgrow
/// the rows it keeps, row by row otherwise. Without a count `begin` weighs
/// the deleted rows alone, as before.
#[tokio::test]
async fn a_refresh_that_names_its_size_goes_bulk_before_its_deletes() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    env.state
        .db_call(|c| {
            let before = item_indexes(c);
            write(c, "s1", movies("s1", "a", 26_000));
            write(c, "s2", movies("s2", "b", 10_000));
            let begun = |c: &mut Connection, expected: Option<u64>| -> bool {
                let tx = c.transaction().unwrap();
                let _w =
                    CatalogWriter::begin_with(&tx, "s2", &[ContentType::Movie], None, expected)
                        .unwrap();
                item_indexes(&tx).is_empty()
            };
            // 10k replaced + 17k offered outgrow the 26k rows of s1.
            assert!(begun(c, Some(17_000)), "bulk from begin");
            // 10k replaced + 12k offered stay under them.
            assert!(!begun(c, Some(12_000)));
            assert!(!begun(c, None), "the deleted rows alone");
            assert_eq!(item_indexes(c), before, "rolled back with the rows");

            let tx = c.transaction()?;
            {
                let mut w = CatalogWriter::begin_with(
                    &tx,
                    "s2",
                    &[ContentType::Movie],
                    None,
                    Some(17_000),
                )?;
                for r in movies("s2", "c", 17_000) {
                    w.insert(&r)?;
                }
                assert_eq!(w.finish(&[(ContentType::Movie, Vec::new())])?, 17_000);
            }
            tx.commit()?;
            assert_eq!(item_indexes(c), before);
            assert_search_rows(c);
            assert_eq!(found(c, "a"), 26_000);
            assert_eq!(found(c, "b"), 0);
            assert_eq!(found(c, "c"), 17_000);
            Ok(())
        })
        .await
        .unwrap();
}

/// A rewrite of every row of `items` empties the search index in one step;
/// next to another source's rows it deletes its own entries one by one, and
/// the other source's titles stay searchable.
#[tokio::test]
async fn rewriting_every_row_keeps_the_search_index_exact() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    env.state
        .db_call(|c| {
            let before = item_indexes(c);
            write(c, "s1", movies("s1", "a", N));
            write(c, "s1", movies("s1", "b", N - 500));
            assert_eq!(item_indexes(c), before);
            assert_search_rows(c);
            assert_eq!(found(c, "a"), 0, "no entry of the old catalog survives");
            assert_eq!(found(c, "b"), N - 500);

            write(c, "s2", movies("s2", "c", 300));
            write(c, "s1", movies("s1", "d", N));
            assert_eq!(item_indexes(c), before);
            assert_search_rows(c);
            assert_eq!(found(c, "b"), 0);
            assert_eq!(found(c, "c"), 300, "the other source's titles stay");
            assert_eq!(found(c, "d"), N);
            Ok(())
        })
        .await
        .unwrap();
}

/// Removing a source: alone, as most of the catalog next to a small source
/// (both bulk), and as a small source next to a large one (row by row). The
/// indexes come back the same and in the same order, and the rows left stay
/// searchable. An unknown source changes nothing.
#[tokio::test]
async fn removing_a_large_source_rebuilds_the_indexes_over_the_rows_left() {
    for (removed, kept) in [(N, 0), (N, 300), (300, N)] {
        let env = env().await;
        bare_source(&env.state, "s1").await;
        bare_source(&env.state, "s2").await;
        env.state
            .db_call(move |c| {
                write(c, "s1", movies("s1", "a", removed));
                if kept > 0 {
                    write(c, "s2", movies("s2", "b", kept));
                }
                let before = item_indexes(c);
                assert!(!before.is_empty());
                store::delete(c, "s1")?;
                let label = format!("{removed} rows removed beside {kept}");
                assert_eq!(item_indexes(c), before, "{label}");
                assert_search_rows(c);
                let left: i64 = c.query_row("SELECT count(*) FROM items", [], |r| r.get(0))?;
                assert_eq!(left as u64, kept, "{label}");
                assert_eq!(found(c, "a"), 0, "{label}");
                assert_eq!(found(c, "b"), kept, "{label}");
                let suspended: i64 =
                    c.query_row("SELECT count(*) FROM fts_suspend", [], |r| r.get(0))?;
                assert_eq!(suspended, 0, "{label}");

                assert!(matches!(
                    store::delete(c, "nope"),
                    Err(CoreError::NotFound(_))
                ));
                assert_eq!(item_indexes(c), before);
                Ok(())
            })
            .await
            .unwrap();
    }
}
