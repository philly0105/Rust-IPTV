//! L3-perf-core-3 (also L3-guide-library-2, XA-13): `epg.search` at the
//! scale the loop 3 hunters measured. Two sources share one guide:
//!
//! - a large M3U source: 44,000 live channels on 400 guide channels (110
//!   channels per guide id, as `/m3u/large.m3u` makes them) and 1,000
//!   radio channels the guide does not know;
//! - an Xtream-like source: 20,000 live channels on 40 guide ids.
//!
//! The guide: 440 channels x 240 hourly programmes (105,600; one day in the
//! past, nine ahead), where "news" matches about 15,800 and "the" about
//! 26,400, plus a second feed repeating some slots and a disabled feed.
//! Searched with the default limit over a 14-day window from now.
//!
//! Before loop 3 a search read and sorted every hit's programme row and
//! read every channel row of the source: 80-100 ms p50 and 150 ms p95 for
//! "news", 180 ms p50 and 290 ms p95 for "the" on the user-scale database.
//! Budget: p95 under 50 ms (release). The assertion allows 50 % on top for
//! a machine loaded by other builds (75 ms); debug builds allow four
//! times that. A query without hits must stay under 5 ms (40 ms debug).
//!
//! The results are checked against an independent model of the fixture
//! (top `limit` by start, then channel number) and against the scan path
//! the search uses while the index is stale.

use iptv_core::epg::search::{self, GuideSearchHit, SearchRequest};
use iptv_core::{AppState, BroadcastSink};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

const M3U: &str = "m3u-large";
const XTREAM: &str = "xtream-large";
const CONFIG: &str = r#"{"origin":"text"}"#;
const EPG_JSON: &str = r#"{"detectedUrls":[],"manualUrls":[],"disabledUrls":[]}"#;
const FEED: &str = "http://guide/large.xml";
const SECOND_FEED: &str = "http://guide/second.xml";
const OFF_FEED: &str = "http://guide/off.xml";
const HOUR: i64 = 3600;
const SPAN: i64 = 14 * 86_400;
const M3U_GUIDES: usize = 400;
const XTREAM_GUIDES: usize = 40;
const M3U_LIVE: usize = 44_000;
const M3U_RADIO: usize = 1_000;
const XTREAM_LIVE: usize = 20_000;
const SLOTS: i64 = 240;
const RUNS: usize = 21;

#[cfg(not(debug_assertions))]
const P95_LIMIT_MS: f64 = 75.0;
#[cfg(debug_assertions)]
const P95_LIMIT_MS: f64 = 300.0;
#[cfg(not(debug_assertions))]
const NO_HIT_LIMIT_MS: f64 = 5.0;
#[cfg(debug_assertions)]
const NO_HIT_LIMIT_MS: f64 = 40.0;

/// Programme titles: 3 of 20 have a word starting with "news", 5 with "the".
const TITLES: [&str; 20] = [
    "World News Today",
    "The Great Bake Off",
    "Morning Show",
    "The Evening News",
    "Garden Time",
    "Football Live",
    "The Late Film",
    "Cooking Hour",
    "Market Watch",
    "Nature Trails",
    "News at Ten",
    "Comedy Club",
    "The History Hour",
    "Quiz Night",
    "Travel Diaries",
    "Science Now",
    "Drama Special",
    "Family Movie",
    "Weather Update",
    "The Music Show",
];

/// Guide channel ids: the M3U source's 400, then the Xtream source's 40.
fn guide_id(k: usize) -> String {
    if k < M3U_GUIDES {
        format!("gen-{k:04}.tv")
    } else {
        format!("xt{}.uk", k - M3U_GUIDES)
    }
}

fn title(k: usize, n: i64) -> &'static str {
    TITLES[(k * 7 + n as usize) % TITLES.len()]
}

fn ts(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn build(c: &mut Connection, base: i64) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    for (id, kind) in [(M3U, "m3u"), (XTREAM, "xtream")] {
        tx.execute(
            "INSERT INTO sources(id, kind, name, position, config_json, epg_json) VALUES (?1, ?2, ?1, 0, ?3, ?4)",
            params![id, kind, CONFIG, EPG_JSON],
        )?;
    }
    for (url, enabled) in [(FEED, 1), (SECOND_FEED, 1), (OFF_FEED, 0)] {
        tx.execute(
            "INSERT INTO epg_sources(url, enabled, origin, status) VALUES (?1, ?2, 'settings', 'ok')",
            params![url, enabled],
        )?;
    }
    {
        let mut chan = tx.prepare(
            "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, ?2, ?3)",
        )?;
        let mut prog = tx.prepare(
            "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description, category)
             VALUES (?1, ?2, ?3, ?4, ?5, 'A description of the programme, as long as guides write them.', 'Talk')",
        )?;
        for k in 0..M3U_GUIDES + XTREAM_GUIDES {
            let id = guide_id(k);
            chan.execute(params![FEED, id, format!("Guide Channel {k}")])?;
            for n in 0..SLOTS {
                let s = base + n * HOUR;
                prog.execute(params![FEED, id, s, s + HOUR, title(k, n)])?;
            }
        }
        // The second feed repeats the first two days of 50 channels (the
        // first feed's row wins each slot); the disabled one never counts.
        for k in 0..50 {
            let id = guide_id(k);
            for n in 0..48 {
                let s = base + n * HOUR;
                prog.execute(params![SECOND_FEED, id, s, s + HOUR, title(k, n)])?;
                prog.execute(params![OFF_FEED, id, s, s + HOUR, "News of the Day"])?;
            }
        }
    }
    {
        let mut item = tx.prepare(
            "INSERT INTO items(source_id, content_type, item_id, category_id, title, number, logo_url, epg_channel_id, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6)",
        )?;
        for n in 0..M3U_LIVE {
            item.execute(params![
                M3U,
                "live",
                format!("m{n}"),
                format!("cat{}", n % 50),
                format!("Metro Channel HD {n:05}"),
                n as i64 + 1,
                format!("http://logo/{n}.png"),
                guide_id(n % M3U_GUIDES),
            ])?;
        }
        for n in 0..M3U_RADIO {
            item.execute(params![
                M3U,
                "radio",
                format!("r{n}"),
                "radio",
                format!("Radio Station {n}"),
                (M3U_LIVE + n) as i64 + 1,
                None::<String>,
                None::<String>,
            ])?;
        }
        for n in 0..XTREAM_LIVE {
            item.execute(params![
                XTREAM,
                "live",
                format!("{}", 1_000_000 + n),
                format!("{}", 100 + n % 150),
                format!("US Channel {n}"),
                n as i64 + 1,
                None::<String>,
                guide_id(M3U_GUIDES + n % XTREAM_GUIDES),
            ])?;
        }
    }
    tx.commit()
}

/// Every query word starts a word of the title (case-insensitive).
fn matches(title: &str, query: &str) -> bool {
    let words: Vec<String> = title
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .collect();
    query
        .split_whitespace()
        .all(|q| words.iter().any(|w| w.starts_with(&q.to_lowercase())))
}

/// The expected `(item id, start)` of each hit: every live channel on a
/// guide channel with a matching programme overlapping `[from, from +
/// SPAN)`, by start, then channel number (unique here), first `limit`.
fn model(source: &str, query: &str, base: i64, from: i64, limit: usize) -> Vec<(String, i64)> {
    let (channels, guides, offset): (usize, usize, usize) = if source == M3U {
        (M3U_LIVE, M3U_GUIDES, 0)
    } else {
        (XTREAM_LIVE, XTREAM_GUIDES, M3U_GUIDES)
    };
    let mut out: Vec<(String, i64)> = Vec::new();
    for n in 0..SLOTS {
        let s = base + n * HOUR;
        if s + HOUR <= from || s >= from + SPAN {
            continue;
        }
        let mut at: Vec<usize> = Vec::new();
        for g in (0..guides).filter(|g| matches(title(offset + g, n), query)) {
            at.extend((g..channels).step_by(guides));
        }
        at.sort_unstable();
        out.extend(at.into_iter().map(|ch| {
            let id = if source == M3U {
                format!("m{ch}")
            } else {
                format!("{}", 1_000_000 + ch)
            };
            (id, s)
        }));
        if out.len() >= limit {
            break;
        }
    }
    out.truncate(limit);
    out
}

async fn search(
    state: &AppState,
    source: &str,
    query: &str,
    from: i64,
    limit: i64,
) -> Vec<GuideSearchHit> {
    search::search(
        state,
        SearchRequest {
            source_id: source.into(),
            query: query.into(),
            from: Some(ts(from)),
            to: Some(ts(from + SPAN)),
            limit: Some(limit),
        },
    )
    .await
    .unwrap()
}

fn keys(hits: &[GuideSearchHit]) -> Vec<(String, i64)> {
    hits.iter()
        .map(|h| {
            let start = chrono::DateTime::parse_from_rfc3339(&h.program.start)
                .unwrap()
                .timestamp();
            (h.item_ref.item_id.clone(), start)
        })
        .collect()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guide_search_on_large_sources_stays_inside_the_budget() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(4096);
    let state: Arc<AppState> = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let from = now;
    let base = now - now % HOUR - 24 * HOUR;
    let setup = Instant::now();
    state.db_call(move |c| Ok(build(c, base)?)).await.unwrap();
    let insert_ms = setup.elapsed().as_millis();
    let started = Instant::now();
    assert!(state
        .db_call(|c| search::ensure_index(c, true))
        .await
        .unwrap());
    let index_ms = started.elapsed().as_millis();

    // The channel scan reads `idx_items_guide` alone, and each hit its
    // narrow search row by rowid.
    let plans = state
        .db_call(|c| {
            let mut out = Vec::new();
            for sql in [search::CHANNELS_SQL, search::FTS_SQL] {
                let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let args = vec![rusqlite::types::Null; stmt.parameter_count()];
                let plan: Vec<String> = stmt
                    .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))?
                    .collect::<Result<_, _>>()?;
                out.push(plan.join(" | "));
            }
            Ok(out)
        })
        .await
        .unwrap();
    assert!(
        plans[0].contains("USING COVERING INDEX idx_items_guide"),
        "{}",
        plans[0]
    );
    assert!(
        plans[1].contains("SEARCH p USING INTEGER PRIMARY KEY"),
        "{}",
        plans[1]
    );

    let cases = [
        (M3U, "news"),
        (M3U, "the"),
        (XTREAM, "news"),
        (XTREAM, "the"),
    ];
    // Results: the model, at the default limit and the maximum, each hit
    // with its own programme's title.
    let guide_of: HashMap<String, usize> = (0..M3U_GUIDES + XTREAM_GUIDES)
        .map(|k| (guide_id(k), k))
        .collect();
    let mut indexed = Vec::new();
    for (source, query) in cases {
        for limit in [search::DEFAULT_LIMIT, search::MAX_LIMIT] {
            let hits = search(&state, source, query, from, limit).await;
            assert_eq!(hits.len(), limit as usize, "{source} {query} {limit}");
            let got = keys(&hits);
            assert_eq!(
                got,
                model(source, query, base, from, limit as usize),
                "{source} {query} {limit}"
            );
            for (h, (_, start)) in hits.iter().zip(&got) {
                let k = guide_of[&h.program.channel_id];
                assert_eq!(h.program.title, title(k, (start - base) / HOUR));
            }
            indexed.push(hits);
        }
    }

    let mut report = Vec::new();
    for (source, query) in cases {
        // Warm the channel directory, the search memo and the statement cache.
        search(&state, source, query, from, search::DEFAULT_LIMIT).await;
        let mut ms = Vec::with_capacity(RUNS);
        for _ in 0..RUNS {
            let t = Instant::now();
            let hits = search(&state, source, query, from, search::DEFAULT_LIMIT).await;
            ms.push(t.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(hits.len(), 50);
        }
        ms.sort_by(f64::total_cmp);
        report.push((source, query, percentile(&ms, 0.5), percentile(&ms, 0.95)));
    }
    let mut none = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let t = Instant::now();
        assert!(search(&state, M3U, "zzqx", from, 50).await.is_empty());
        none.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    none.sort_by(f64::total_cmp);
    let none_p95 = percentile(&none, 0.95);

    // The scan the search uses while the index is stale gives the same hits.
    state
        .db_call(|c| search::invalidate_index(c))
        .await
        .unwrap();
    let mut scanned = Vec::new();
    for (source, query) in cases {
        for limit in [search::DEFAULT_LIMIT, search::MAX_LIMIT] {
            scanned.push(search(&state, source, query, from, limit).await);
        }
    }
    assert_eq!(scanned, indexed, "the scan and the index agree");

    println!(
        "l3_search_epg: fixture inserted in {insert_ms} ms, index built in {index_ms} ms; p50/p95 ms {}; no hits p95 {none_p95:.2} ms (limits {P95_LIMIT_MS} / {NO_HIT_LIMIT_MS} ms)",
        report
            .iter()
            .map(|(s, q, p50, p95)| format!("{s} '{q}' {p50:.1}/{p95:.1}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for (source, query, _, p95) in &report {
        assert!(
            *p95 < P95_LIMIT_MS,
            "{source} '{query}': p95 {p95:.1} ms (limit {P95_LIMIT_MS} ms)"
        );
    }
    assert!(
        none_p95 < NO_HIT_LIMIT_MS,
        "no hits: p95 {none_p95:.2} ms (limit {NO_HIT_LIMIT_MS} ms)"
    );
}
