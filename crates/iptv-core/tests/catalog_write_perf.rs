//! Timings of the largest catalog writes, all inside the write lock: a
//! refresh that rewrites the only source (200k channels), a movie refresh
//! next to a larger live source, and removing a source that is most of the
//! catalog. Each run checks the search index and `items_rank` afterwards.
//!
//! Timing only, so every test is ignored:
//! `cargo test --release -p iptv-core --test catalog_write_perf -- --ignored --nocapture --test-threads 1`

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{self, CatalogWriter, ItemRow};
use iptv_core::model::ContentType;
use iptv_core::sources::store;
use rusqlite::Connection;
use std::time::Instant;
use support::*;

const CHANNELS: u64 = 200_000;
const MOVIES: u64 = 180_000;
const KEPT_MOVIES: u64 = 50_000;

fn channels(source: &str, salt: &str, n: u64) -> impl Iterator<Item = ItemRow> {
    let source = source.to_string();
    let salt = salt.to_string();
    (0..n).map(move |i| ItemRow {
        source_id: source.clone(),
        content_type: ContentType::Live,
        item_id: format!("{salt}{i}"),
        category_id: format!("g{}", i % 2_000),
        title: format!("Channel {salt}{i} HD"),
        number: Some(i as i64 + 1),
        url: Some(format!("http://stream.example/{salt}{i}.ts")),
        position: i as i64,
        ..Default::default()
    })
}

fn movies(source: &str, salt: &str, n: u64) -> impl Iterator<Item = ItemRow> {
    let source = source.to_string();
    let salt = salt.to_string();
    (0..n).map(move |i| ItemRow {
        source_id: source.clone(),
        content_type: ContentType::Movie,
        item_id: format!("{salt}{i}"),
        category_id: format!("c{}", i % 400),
        title: format!("Movie {salt}{i} ({})", 1950 + i % 70),
        rating: Some((i % 100) as f64 / 10.0),
        added: Some(format!("2026-01-{:02}T00:00:00Z", 1 + i % 28)),
        position: i as i64,
        ..Default::default()
    })
}

/// The search index passes SQLite's own check and holds one entry per row
/// of `items`, and `items_rank` matches `items`.
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

fn wal_mb(env: &Env) -> f64 {
    let wal = env
        .dir
        .path()
        .join(format!("{}-wal", iptv_core::db::DB_FILE));
    std::fs::metadata(wal).map_or(0.0, |m| m.len() as f64 / 1e6)
}

/// A refresh of the only source in the library: every row of `items` is
/// replaced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "timing only; run with --release -- --ignored --nocapture"]
async fn rewriting_the_only_source() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    env.state
        .db_call(|c| {
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Live,
                &[],
                &mut channels("s1", "a", CHANNELS),
            )?;
            iptv_core::db::checkpoint_truncate(c);
            let started = Instant::now();
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Live,
                &[],
                &mut channels("s1", "b", CHANNELS),
            )?;
            eprintln!(
                "catalog_write_perf: rewrite of the only source ({CHANNELS} channels) in {:?}",
                started.elapsed()
            );
            assert_search_rows(c);
            let old: i64 = c.query_row(
                "SELECT count(*) FROM items_fts WHERE items_fts MATCH '\"a17\"'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(old, 0, "no search entry of the old catalog survives");

            // The step the rewrite saves, alone: emptying the search index
            // and the ranking rows entry by entry, as a rewrite that keeps
            // other rows does, against at once. Both rolled back.
            for (label, statements) in [
                (
                    "entry by entry",
                    [
                        "INSERT INTO items_fts (items_fts, rowid, title) SELECT 'delete', rowid, title FROM items WHERE source_id = 's1' AND content_type = 'live'",
                        "DELETE FROM items_rank WHERE id IN (SELECT rowid FROM items WHERE source_id = 's1' AND content_type = 'live')",
                    ],
                ),
                (
                    "at once",
                    [
                        "INSERT INTO items_fts (items_fts) VALUES ('delete-all')",
                        "DELETE FROM items_rank",
                    ],
                ),
            ] {
                let tx = c.transaction()?;
                let started = Instant::now();
                for sql in statements {
                    tx.execute(sql, [])?;
                }
                eprintln!(
                    "catalog_write_perf: emptying the search index of {CHANNELS} channels {label} in {:?}",
                    started.elapsed()
                );
            }
            Ok(())
        })
        .await
        .unwrap();
}

/// A movie refresh of one source next to another source's larger live
/// catalog: the refresh touches more rows than it keeps only once its new
/// rows are counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "timing only; run with --release -- --ignored --nocapture"]
async fn a_movie_refresh_beside_a_larger_live_source() {
    let env = env().await;
    bare_source(&env.state, "live").await;
    bare_source(&env.state, "vod").await;
    env.state
        .db_call(|c| {
            catalog::replace_catalog(
                c,
                "live",
                ContentType::Live,
                &[],
                &mut channels("live", "a", CHANNELS),
            )?;
            catalog::replace_catalog(
                c,
                "vod",
                ContentType::Movie,
                &[],
                &mut movies("vod", "a", MOVIES),
            )?;
            iptv_core::db::checkpoint_truncate(c);
            let started = Instant::now();
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            {
                // As the Xtream and Stalker syncs call it: with the number
                // of rows they offer.
                let mut w = CatalogWriter::begin_with(
                    &tx,
                    "vod",
                    &[ContentType::Movie],
                    None,
                    Some(MOVIES),
                )?;
                let begun = started.elapsed();
                for row in movies("vod", "b", MOVIES) {
                    w.insert(&row)?;
                }
                w.finish(&[(ContentType::Movie, Vec::new())])?;
                eprintln!("catalog_write_perf: movie refresh, begin took {begun:?}");
            }
            tx.commit()?;
            eprintln!(
                "catalog_write_perf: movie refresh ({MOVIES} movies beside {CHANNELS} channels) in {:?}",
                started.elapsed()
            );
            assert_search_rows(c);
            Ok(())
        })
        .await
        .unwrap();
}

/// Removing a 200k-channel source, alone and next to 50k movies of another
/// source.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "timing only; run with --release -- --ignored --nocapture"]
async fn removing_a_large_source() {
    for kept in [0, KEPT_MOVIES] {
        let env = env().await;
        bare_source(&env.state, "big").await;
        bare_source(&env.state, "small").await;
        let started = env
            .state
            .db_call(move |c| {
                catalog::replace_catalog(
                    c,
                    "big",
                    ContentType::Live,
                    &[],
                    &mut channels("big", "a", CHANNELS),
                )?;
                catalog::replace_catalog(
                    c,
                    "small",
                    ContentType::Movie,
                    &[],
                    &mut movies("small", "a", kept),
                )?;
                iptv_core::db::checkpoint_truncate(c);
                let started = Instant::now();
                store::delete(c, "big")?;
                Ok(started.elapsed())
            })
            .await
            .unwrap();
        eprintln!(
            "catalog_write_perf: removing {CHANNELS} channels beside {kept} other rows in {started:?}, WAL {:.0} MB",
            wal_mb(&env)
        );
        env.state
            .db_call(move |c| {
                assert_search_rows(c);
                let n: i64 = c.query_row("SELECT count(*) FROM items", [], |r| r.get(0))?;
                assert_eq!(n as u64, kept);
                Ok(())
            })
            .await
            .unwrap();
    }
}
