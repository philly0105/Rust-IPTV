//! Benchmark of the read RPCs the UI sends on its hot paths, on a large
//! library: 200k live channels in 1,000 groups, 150k movies, 30k series,
//! and a guide of 3,000 channels over nine days (876k programmes, a second
//! feed carrying 500 of them around now), with favourites, history, resume
//! positions, My List and a 200-channel custom list. Each call goes through
//! the RPC router and is serialized as a host would; it prints p50 and p95
//! of `SAMPLES` calls after one warm-up call. It asserts nothing (the
//! budgets live in the `*_perf.rs` tests) and is ignored by default: the
//! fixture takes about 40 s in a release build.
//!
//! cargo test -p iptv-core --release --test read_rpc_bench -- --ignored --nocapture
//!
//! Environment: `BENCH=<substring>` runs the matching cases only,
//! `SAMPLES=<n>` (default 30), `BENCH_COLD=1` bumps the guide generation
//! before each call (cold guide caches), `BENCH_PRAGMA="PRAGMA ..."` runs
//! on every pooled connection first, `BENCH_KEEP=<path>` saves the fixture
//! database there (`VACUUM INTO`) for `EXPLAIN QUERY PLAN` sessions,
//! `BENCH_REBUILD=<n>` times `n` rebuilds of the guide search index first.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{replace_catalog, CategoryRow, ItemRow};
use iptv_core::model::ContentType;
use rusqlite::params;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use support::*;

const CHANNELS: usize = 200_000;
const GROUPS: usize = 1_000;
const MOVIES: usize = 150_000;
const SERIES: usize = 30_000;
const GUIDE_CHANNELS: usize = 3_000;
const DAYS: i64 = 7;
const SAMPLES: usize = 30;
const FEED: &str = "http://epg.example/guide.xml";
const FEED2: &str = "http://epg.example/second.xml";

const WORDS: [&str; 16] = [
    "Amber", "Atlas", "Blue", "Bridge", "Cedar", "Comet", "Delta", "Dawn", "Ember", "Echo",
    "Falcon", "Frost", "Garden", "Glass", "Harbor", "Hollow",
];

fn vod_row(sid: &str, ct: ContentType, prefix: &str, i: usize, cats: usize) -> ItemRow {
    let n = WORDS.len();
    ItemRow {
        source_id: sid.to_owned(),
        content_type: ct,
        item_id: format!("{prefix}{i}"),
        category_id: format!("{prefix}c{}", i % cats),
        title: format!(
            "{} {} {} {i}",
            WORDS[i % n],
            WORDS[(i / n) % n],
            WORDS[(i / (n * n)) % n]
        ),
        poster_url: Some(format!("http://img.example/{prefix}/{i}.jpg")),
        rating: (!i.is_multiple_of(11)).then(|| ((i * 37) % 100) as f64 / 10.0),
        added: Some(format!(
            "20{:02}-{:02}-{:02}T{:02}:{:02}:00Z",
            10 + (i * 13) % 16,
            1 + (i * 7) % 12,
            1 + (i * 3) % 28,
            (i * 5) % 24,
            i % 60
        )),
        year: Some(1950 + ((i * 7) % 76) as i64),
        url: Some(format!("http://vod.example/{prefix}/{i}.mkv")),
        container_extension: Some("mkv".into()),
        position: i as i64,
        ..Default::default()
    }
}

fn cats(prefix: &str, n: usize) -> Vec<CategoryRow> {
    (0..n)
        .map(|c| CategoryRow {
            category_id: format!("{prefix}c{c}"),
            name: format!("Category {c}"),
            position: c as i64,
        })
        .collect()
}

fn pct(mut v: Vec<Duration>) -> (f64, f64) {
    v.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    (
        ms(v[v.len() / 2]),
        ms(v[(v.len() * 95 / 100).min(v.len() - 1)]),
    )
}

const TITLES: [&str; 8] = [
    "World News Today",
    "The Great Bake Off",
    "Morning Show",
    "Football Live",
    "The Late Film",
    "Cooking Hour",
    "Market Watch",
    "Nature Trails",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn read_rpcs_on_a_large_library() {
    let env = env().await;
    let state = env.state.clone();
    let r = iptv_core::rpc::build_router();
    let t0 = Instant::now();
    let live = add_text(&state, "live", &gen_m3u(CHANNELS, GROUPS)).await;
    let lsid = live.id.clone();
    let lobby = "#EXTM3U\n#EXTINF:-1 group-title=\"Lobby\",Lobby\nhttp://x/1.ts\n";
    let vod = add_text(&state, "vod", lobby).await;
    let vsid = vod.id.clone();
    let s = vsid.clone();
    state
        .db_call(move |c| {
            replace_catalog(
                c,
                &s,
                ContentType::Movie,
                &cats("m", 400),
                &mut (0..MOVIES).map(|i| vod_row(&s, ContentType::Movie, "m", i, 400)),
            )?;
            replace_catalog(
                c,
                &s,
                ContentType::Series,
                &cats("s", 100),
                &mut (0..SERIES).map(|i| vod_row(&s, ContentType::Series, "s", i, 100)),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let base = now - now % 3600 - 2 * 86_400;
    state
        .db_call(move |c| {
            let tx = c.transaction()?;
            for url in [FEED, FEED2] {
                tx.execute(
                    "INSERT INTO epg_sources(url, enabled, origin, status) VALUES (?1, 1, 'settings', 'ok') ON CONFLICT(url) DO UPDATE SET enabled = 1, status = 'ok'",
                    [url],
                )?;
            }
            {
                let mut chan = tx.prepare(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, ?2, ?3)",
                )?;
                let mut prog = tx.prepare(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description, category)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'A description of the programme, about as long as guides write them, and then some more words.', 'Talk')",
                )?;
                for k in 0..GUIDE_CHANNELS {
                    let id = format!("ch{k}.example");
                    chan.execute(params![FEED, id, format!("Channel {k}")])?;
                    // Half-hour and hour programmes alternating.
                    let mut t = base;
                    let mut n = 0usize;
                    while t < base + (DAYS + 2) * 86_400 {
                        let len = if n.is_multiple_of(2) { 1800 } else { 3600 };
                        prog.execute(params![FEED, id, t, t + len, TITLES[(k + n) % 8]])?;
                        t += len;
                        n += 1;
                    }
                }
                // A second feed with 500 channels, a day either side of now.
                for k in 0..500 {
                    let id = format!("ch{k}.example");
                    chan.execute(params![FEED2, id, format!("Channel {k}")])?;
                    let mut t = base + 86_400;
                    while t < base + 3 * 86_400 {
                        prog.execute(params![FEED2, id, t, t + 3600, "Second"])?;
                        t += 3600;
                    }
                }
            }
            tx.commit()?;
            iptv_core::epg::search::rebuild_index(c)?;
            Ok(())
        })
        .await
        .unwrap();
    iptv_core::epg::runtime(&state).bump();
    eprintln!("fixture in {:?}", t0.elapsed());
    if let Ok(n) = std::env::var("BENCH_REBUILD") {
        let n: usize = n.parse().unwrap_or(5).max(1);
        let times = state
            .db_call(move |c| {
                let mut times = Vec::with_capacity(n);
                for _ in 0..n {
                    let t = Instant::now();
                    iptv_core::epg::search::rebuild_index(c)?;
                    times.push(t.elapsed());
                }
                Ok(times)
            })
            .await
            .unwrap();
        let (p50, p95) = pct(times);
        eprintln!(
            "{:<28} p50 {p50:>8.2} ms  p95 {p95:>8.2} ms",
            "rebuild_index"
        );
    }

    let call = |method: &'static str, args: Value| {
        let r = &r;
        let state = state.clone();
        async move {
            r.dispatch(state, method, args)
                .await
                .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        }
    };
    let id_of = |v: &Value| v["ref"]["itemId"].as_str().unwrap().to_string();
    let first_ids: Vec<String> = call(
        "catalog.channels",
        json!({"sourceId": lsid, "query": {"offset": 0, "limit": 100}}),
    )
    .await["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(id_of)
        .collect();
    let deep_ids: Vec<String> = call(
        "catalog.channels",
        json!({"sourceId": lsid, "query": {"offset": 150_000, "limit": 100}}),
    )
    .await["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(id_of)
        .collect();
    let refs = |ids: &[String], n: usize| -> Value {
        Value::Array(
            ids.iter()
                .take(n)
                .map(|i| json!({"sourceId": lsid, "contentType": "live", "itemId": i}))
                .collect(),
        )
    };
    // User state.
    for (k, id) in first_ids.iter().take(60).enumerate() {
        let rf = json!({"sourceId": lsid, "contentType": "live", "itemId": id});
        call(
            "favorites.toggle",
            json!({"ref": rf, "snapshot": {"title": format!("Channel {k}"), "contentType": "live"}}),
        )
        .await;
        call(
            "recent.add",
            json!({"ref": rf, "snapshot": {"title": format!("Channel {k}"), "contentType": "live"}}),
        )
        .await;
    }
    for i in 0..100 {
        let rf =
            json!({"sourceId": vsid, "contentType": "movie", "itemId": format!("m{}", i * 997)});
        call(
            "positions.set",
            json!({"ref": rf, "positionSeconds": 300.0, "durationSeconds": 5400.0, "snapshot": {"title": "M", "contentType": "movie"}}),
        )
        .await;
        call(
            "watchlist.toggle",
            json!({"ref": rf, "snapshot": {"title": "M", "contentType": "movie"}}),
        )
        .await;
    }
    let items: Vec<Value> = deep_ids
        .iter()
        .chain(first_ids.iter())
        .map(|i| json!({"ref": {"sourceId": lsid, "contentType": "live", "itemId": i}, "snapshot": {"title": "x", "contentType": "live"}}))
        .collect();
    let list = call("lists.create", json!({"name": "L", "items": items})).await;
    let list_id = list["id"].as_str().unwrap_or_default().to_string();

    let from = chrono::DateTime::from_timestamp(now - now % 1800, 0).unwrap();
    let iso =
        |d: chrono::DateTime<chrono::Utc>| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let to24 = iso(from + chrono::Duration::hours(24));
    let to6 = iso(from + chrono::Duration::hours(6));
    let fromi = iso(from);
    let movie_refs: Value = Value::Array(
        (0..60)
            .map(|i| json!({"sourceId": vsid, "contentType": "movie", "itemId": format!("m{}", i * 31)}))
            .collect(),
    );
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    let cases: Vec<(&str, &'static str, Value)> = vec![
        (
            "channels p0 x100",
            "catalog.channels",
            json!({"sourceId": lsid, "query": {"offset": 0, "limit": 100}}),
        ),
        (
            "channels deep x100",
            "catalog.channels",
            json!({"sourceId": lsid, "query": {"offset": 150_000, "limit": 100}}),
        ),
        (
            "channels group x100",
            "catalog.channels",
            json!({"sourceId": lsid, "categoryId": live_cat(&state, &lsid).await, "query": {"offset": 0, "limit": 100}}),
        ),
        (
            "categories live",
            "catalog.categories",
            json!({"sourceId": lsid, "contentType": "live"}),
        ),
        (
            "categories movie",
            "catalog.categories",
            json!({"sourceId": vsid, "contentType": "movie"}),
        ),
        (
            "movies p0 x60",
            "catalog.movies",
            json!({"sourceId": vsid, "query": {"offset": 0, "limit": 60}}),
        ),
        (
            "nowNext 100 matched",
            "epg.nowNext",
            json!({"refs": refs(&first_ids, 100), "withDescription": false}),
        ),
        (
            "nowNext 100 matched desc",
            "epg.nowNext",
            json!({"refs": refs(&first_ids, 100)}),
        ),
        (
            "nowNext 100 unmatched",
            "epg.nowNext",
            json!({"refs": refs(&deep_ids, 100), "withDescription": false}),
        ),
        (
            "grid 40x6h",
            "epg.grid",
            json!({"refs": refs(&first_ids, 40), "from": fromi, "to": to6, "withDescription": false}),
        ),
        (
            "grid 40x24h",
            "epg.grid",
            json!({"refs": refs(&first_ids, 40), "from": fromi, "to": to24, "withDescription": false}),
        ),
        (
            "grid 40x24h desc",
            "epg.grid",
            json!({"refs": refs(&first_ids, 40), "from": fromi, "to": to24}),
        ),
        (
            "programs 1x24h",
            "epg.programs",
            json!({"ref": refs(&first_ids, 1)[0], "from": fromi, "to": to24}),
        ),
        (
            "epg.search news",
            "epg.search",
            json!({"sourceId": lsid, "query": "news"}),
        ),
        (
            "favorites.list",
            "favorites.list",
            json!({"sourceId": lsid}),
        ),
        (
            "favorites.contains 100",
            "favorites.contains",
            json!({"refs": refs(&first_ids, 100)}),
        ),
        ("recent.list", "recent.list", json!({"sourceId": lsid})),
        ("continueWatching", "positions.continueWatching", json!({})),
        ("watchlist.list", "watchlist.list", json!({})),
        ("lists.list", "lists.list", json!({})),
        ("lists.items 200", "lists.items", json!({"id": list_id})),
        (
            "catalog.items 60 live",
            "catalog.items",
            json!({"refs": refs(&first_ids, 60)}),
        ),
        (
            "catalog.items 60 movie",
            "catalog.items",
            json!({"refs": movie_refs}),
        ),
        (
            "recentlyAdded movie",
            "catalog.recentlyAdded",
            json!({"contentType": "movie", "limit": 20}),
        ),
        (
            "recentlyAdded series src",
            "catalog.recentlyAdded",
            json!({"sourceId": vsid, "contentType": "series", "limit": 20}),
        ),
        ("search blue", "catalog.search", json!({"query": "blue"})),
        (
            "search channel 12",
            "catalog.search",
            json!({"query": "channel 12"}),
        ),
        (
            "stats.summary",
            "stats.summary",
            json!({"days": 7, "today": today}),
        ),
        ("sources.list", "sources.list", json!({})),
        ("epg.sources", "epg.sources", json!({})),
    ];
    if let Ok(path) = std::env::var("BENCH_KEEP") {
        let _ = std::fs::remove_file(&path);
        state
            .db_call(move |c| Ok(c.execute("VACUUM INTO ?1", [path])?))
            .await
            .unwrap();
        eprintln!("lsid {lsid} vsid {vsid}");
    }
    let n_samples: usize = std::env::var("SAMPLES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(SAMPLES);
    let filter = std::env::var("BENCH").ok();
    if let Ok(pragma) = std::env::var("BENCH_PRAGMA") {
        let conns: Vec<_> = (0..iptv_core::db::POOL_MAX)
            .map(|_| state.db.get().unwrap())
            .collect();
        for c in &conns {
            c.execute_batch(&pragma).unwrap();
        }
        eprintln!("pragma on {} connections: {pragma}", conns.len());
    }
    for (label, method, args) in cases {
        if let Some(f) = &filter {
            if !label.contains(f.as_str()) {
                continue;
            }
        }
        let v = call(method, args.clone()).await;
        let bytes = serde_json::to_vec(&v).unwrap().len();
        let mut samples = Vec::new();
        let cold = std::env::var("BENCH_COLD").is_ok();
        for _ in 0..n_samples {
            if cold {
                iptv_core::epg::runtime(&state).bump();
            }
            let t = Instant::now();
            let v = call(method, args.clone()).await;
            let _s = serde_json::to_vec(&v).unwrap();
            samples.push(t.elapsed());
        }
        let (p50, p95) = pct(samples);
        eprintln!("{label:<28} p50 {p50:>8.2} ms  p95 {p95:>8.2} ms  {bytes:>9} B");
    }
}

async fn live_cat(state: &std::sync::Arc<iptv_core::AppState>, sid: &str) -> String {
    let sid = sid.to_string();
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT category_id FROM categories WHERE source_id = ?1 AND content_type = 'live' ORDER BY position LIMIT 1 OFFSET 7",
                [sid],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
}
