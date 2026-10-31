//! Catalog reads on several pooled connections at once, on a 150k-item
//! library (100k movies, 50k channels): the same mix of searches and pages
//! from 1, 2 and 4 tasks, with the per-call p50/p95 and the calls per
//! second. Every call runs on its own pooled connection, so on four cores
//! four tasks should cost each call about what one task does. A lock all
//! connections share (SQLite's process-wide page-cache LRU when the bundled
//! build defines SQLITE_ENABLE_MEMORY_MANAGEMENT) shows up as calls slowing
//! down with every task added. It asserts nothing: it prints the numbers the
//! bundled SQLite's flags were chosen on (`.cargo/config.toml`).
//!
//! Measured 2026-10-31 on a 4-core Linux box, medians of three runs, with
//! the flag the bundled build sets / with it undefined: 87 / 76 calls/s from
//! one task (noise), 70 / 110 from two, 76 / 133 from four; search "blue"
//! p50 with four tasks 108 / 60 ms.
//!
//! Release-only: `cargo test -p iptv-core --release --test db_concurrency_perf -- --ignored --nocapture`

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{replace_catalog, CategoryRow, ItemRow};
use iptv_core::model::ContentType;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;

const MOVIES: usize = 100_000;
const CHANNELS: usize = 50_000;
const CATS: usize = 150;
const ROUNDS: usize = 30;
const WORDS: [&str; 12] = [
    "Amber", "Blue", "Cedar", "Ember", "Frost", "Harbor", "Jade", "North", "Orchard", "River",
    "Silver", "Winter",
];
const CHANNEL_NAMES: [&str; 5] = [
    "News 24",
    "Sky Sports",
    "Family Fun",
    "Kids Club",
    "Music Hits",
];

fn categories(prefix: &str) -> Vec<CategoryRow> {
    (0..CATS)
        .map(|c| CategoryRow {
            category_id: format!("{prefix}c{c}"),
            name: format!("Group {c}"),
            position: c as i64,
        })
        .collect()
}

fn movie(sid: &str, i: usize) -> ItemRow {
    let n = WORDS.len();
    ItemRow {
        source_id: sid.to_owned(),
        content_type: ContentType::Movie,
        item_id: format!("m{i}"),
        category_id: format!("mc{}", i % CATS),
        title: format!(
            "{} {} ({}) {i}",
            WORDS[i % n],
            WORDS[(i / n) % n],
            1990 + i % 36
        ),
        poster_url: Some(format!("http://img.example/m/{i}.jpg")),
        rating: Some(((i * 37) % 100) as f64 / 10.0),
        added: Some(format!(
            "2024-{:02}-{:02}T00:00:00Z",
            1 + i % 12,
            1 + i % 28
        )),
        year: Some(1950 + ((i * 7) % 76) as i64),
        url: Some(format!("http://vod.example/m/{i}.mkv")),
        extra: json!({"plot": "A long plot line that makes the row as wide as a provider's."}),
        position: i as i64,
        ..Default::default()
    }
}

fn channel(sid: &str, i: usize) -> ItemRow {
    ItemRow {
        source_id: sid.to_owned(),
        content_type: ContentType::Live,
        item_id: format!("l{i}"),
        category_id: format!("lc{}", i % CATS),
        title: format!("{} {i:05}", CHANNEL_NAMES[i % CHANNEL_NAMES.len()]),
        number: Some(i as i64 + 1),
        url: Some(format!("http://stream.example/live/{i}.ts")),
        position: i as i64,
        ..Default::default()
    }
}

fn percentiles(mut samples: Vec<Duration>) -> (f64, f64) {
    samples.sort();
    let at = |q: usize| samples[(samples.len() * q).div_ceil(100).max(1) - 1];
    (at(50).as_secs_f64() * 1e3, at(95).as_secs_f64() * 1e3)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "timing only; run with --release -- --ignored --nocapture"]
async fn catalog_reads_on_parallel_connections() {
    let env = env().await;
    let lobby = "#EXTM3U\n#EXTINF:-1 group-title=\"Lobby\",Lobby\nhttp://stream.example/lobby.ts\n";
    let vsid = add_text(&env.state, "vod", lobby).await.id;
    let lsid = add_text(&env.state, "live", lobby).await.id;
    let (v, l) = (vsid.clone(), lsid.clone());
    env.state
        .db_call(move |c| {
            replace_catalog(
                c,
                &v,
                ContentType::Movie,
                &categories("m"),
                &mut (0..MOVIES).map(|i| movie(&v, i)),
            )?;
            replace_catalog(
                c,
                &l,
                ContentType::Live,
                &categories("l"),
                &mut (0..CHANNELS).map(|i| channel(&l, i)),
            )?;
            iptv_core::db::checkpoint_truncate(c);
            Ok(())
        })
        .await
        .unwrap();

    let calls: Arc<Vec<(&str, &str, Value)>> = Arc::new(vec![
        (
            "search \"blue\"",
            "catalog.search",
            json!({"query": "blue", "limit": 61}),
        ),
        (
            "search \"news\"",
            "catalog.search",
            json!({"query": "news", "limit": 61}),
        ),
        (
            "movies by rating @3000",
            "catalog.movies",
            json!({"sourceId": vsid, "query": {"offset": 3000, "limit": 60, "sort": "rating", "dir": "desc"}}),
        ),
        (
            "channels @40000",
            "catalog.channels",
            json!({"sourceId": lsid, "query": {"offset": 40_000, "limit": 100}}),
        ),
    ]);
    let router = Arc::new(iptv_core::rpc::build_router());
    // Warm every connection's cache: the pool hands out up to eight.
    for _ in 0..8 {
        for (_, method, args) in calls.iter() {
            router
                .dispatch(env.state.clone(), method, args.clone())
                .await
                .unwrap();
        }
    }

    for tasks in [1usize, 2, 4] {
        let started = Instant::now();
        let mut handles = Vec::new();
        for t in 0..tasks {
            let (router, state, calls) = (router.clone(), env.state.clone(), calls.clone());
            handles.push(tokio::spawn(async move {
                let mut took = vec![Vec::with_capacity(ROUNDS); calls.len()];
                for round in 0..ROUNDS {
                    // Each task starts the mix at another call, so the tasks
                    // do not run the same query in lockstep.
                    for k in 0..calls.len() {
                        let at = (k + t + round) % calls.len();
                        let (_, method, args) = &calls[at];
                        let started = Instant::now();
                        router
                            .dispatch(state.clone(), method, args.clone())
                            .await
                            .unwrap();
                        took[at].push(started.elapsed());
                    }
                }
                took
            }));
        }
        let mut all = vec![Vec::new(); calls.len()];
        for h in handles {
            for (k, samples) in h.await.unwrap().into_iter().enumerate() {
                all[k].extend(samples);
            }
        }
        let wall = started.elapsed().as_secs_f64();
        let total = tasks * ROUNDS * calls.len();
        for (k, samples) in all.into_iter().enumerate() {
            let (p50, p95) = percentiles(samples);
            eprintln!(
                "db_concurrency_perf: {tasks} task(s) | {:<24} | p50 {p50:>7.2} ms | p95 {p95:>7.2} ms",
                calls[k].0
            );
        }
        eprintln!(
            "db_concurrency_perf: {tasks} task(s) | {total} calls in {wall:.2} s, {:.0} calls/s",
            total as f64 / wall
        );
    }
}
