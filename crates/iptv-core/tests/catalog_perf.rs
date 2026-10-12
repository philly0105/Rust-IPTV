//! SC9 / check 8: a 50k-channel playlist parses, imports, loads and answers
//! every catalog query the live and search screens run within a time budget.
//!
//! The bar is release-mode: loading a list page and answering a search in
//! under 100 ms ([`QUERY_BUDGET`]). `cargo test` runs the dev profile, where
//! this crate is unoptimized (dependencies, SQLite included, get opt-level 1),
//! so parse and import budgets are the release ones times [`DEBUG_SCALE`] (6).
//! Query budgets are NOT scaled: measured on a 2026 desktop, both profiles
//! answer every query in under 45 ms except the capped 20k-row zap list, and
//! the regressions this guards (a missing index: 129 ms for the deep page in
//! release) must fail in a plain `cargo test` too.
//! Each query budget is per call, measured after a warm-up call so it
//! reflects scrolling and typing, not the first SQLite page-in.
//!
//! Run (the real bar): `cargo test --release -p iptv-core --test catalog_perf`
//! Debug (scaled):      `cargo test -p iptv-core --test catalog_perf`

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::ContentType;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use support::*;

const CHANNELS: usize = 50_000;
const GROUPS: usize = 250;

/// Debug budgets are the release budgets times this.
#[cfg(debug_assertions)]
const DEBUG_SCALE: u32 = 6;
#[cfg(not(debug_assertions))]
const DEBUG_SCALE: u32 = 1;

const PARSE_BUDGET: Duration = Duration::from_millis(600 * DEBUG_SCALE as u64);
const IMPORT_BUDGET: Duration = Duration::from_secs(5 * DEBUG_SCALE as u64);
/// One RPC call (a list page, a search keystroke): under the 100 ms
/// "instant" threshold, in both profiles.
const QUERY_BUDGET: Duration = Duration::from_millis(100);

#[test]
fn parse_50k_entries_within_budget() {
    let text = gen_m3u(CHANNELS, GROUPS);
    let started = Instant::now();
    let (entries, header, stats) = iptv_core::m3u::parse_str(&text);
    let took = started.elapsed();
    eprintln!("catalog_perf: parsed {CHANNELS} entries in {took:?}");
    assert_eq!(entries.len(), CHANNELS);
    assert_eq!(stats.entries as usize, CHANNELS);
    assert!(!header.epg_urls.is_empty());
    assert!(took < PARSE_BUDGET, "parse took {took:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queries_on_50k_channels_stay_fast() {
    let env = env().await;
    let started = Instant::now();
    let src = add_text(&env.state, "big", &gen_m3u(CHANNELS, GROUPS)).await;
    let took = started.elapsed();
    eprintln!("catalog_perf: imported {CHANNELS} channels in {took:?}");
    assert_eq!(src.channel_count, CHANNELS as i64);
    assert!(took < IMPORT_BUDGET, "import took {took:?}");

    // D6 (review round 1): timing alone cannot catch a lost index on a
    // fast machine, so the list page's shape (source, type, ordered by
    // position) must be answered from an index, without a sort pass.
    let plan_sid = src.id.clone();
    let plan: Vec<String> = env
        .state
        .db_call(move |c| {
            let mut stmt = c.prepare(
                "EXPLAIN QUERY PLAN SELECT i.item_id FROM items i \
                 WHERE i.source_id = ?1 AND i.content_type = 'live' \
                 ORDER BY i.position LIMIT 100 OFFSET 49900",
            )?;
            let rows = stmt
                .query_map([plan_sid], |r| r.get::<_, String>(3))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap();
    assert!(
        plan.iter()
            .any(|d| d.contains("USING INDEX") || d.contains("USING COVERING INDEX")),
        "{plan:?}"
    );
    assert!(
        !plan.iter().any(|d| d.contains("TEMP B-TREE")),
        "list page sorts: {plan:?}"
    );

    let r = router();
    let sid = src.id.clone();
    let cats = r
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({"sourceId": sid, "contentType": "live"}),
        )
        .await
        .unwrap();
    let cats = cats.as_array().expect("categories array");
    assert_eq!(cats.len(), GROUPS);
    let group = cats[GROUPS / 2]["id"]
        .as_str()
        .or_else(|| cats[GROUPS / 2]["categoryId"].as_str())
        .expect("category id")
        .to_owned();

    // (label, method, args, check)
    type Check = fn(&Value);
    let calls: Vec<(&str, &str, Value, Check)> = vec![
        (
            "first page",
            "catalog.channels",
            json!({"sourceId": sid}),
            |v| assert_eq!(v["total"], CHANNELS as i64),
        ),
        (
            "deep page (scrolled to the end)",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"offset": CHANNELS - 100, "limit": 100}}),
            |v| assert_eq!(v["items"].as_array().unwrap().len(), 100),
        ),
        (
            "group page",
            "catalog.channels",
            json!({"sourceId": sid, "categoryId": group}),
            |v| assert_eq!(v["total"], (CHANNELS / GROUPS) as i64),
        ),
        (
            "sorted by name, descending",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"sort": "name", "dir": "desc"}}),
            |v| assert_eq!(v["items"].as_array().unwrap().len(), 100),
        ),
        (
            "in-list search",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"search": "Channel 99"}}),
            |v| assert!(v["total"].as_i64().unwrap() >= 11, "{v}"),
        ),
        (
            "in-list search, one letter",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"search": "c"}}),
            |v| assert!(v["total"].as_i64().unwrap() > 0, "{v}"),
        ),
        (
            "global search",
            "catalog.search",
            json!({"query": "Channel 1234"}),
            |v| assert!(!v["live"].as_array().unwrap().is_empty(), "{v}"),
        ),
        (
            "channel by number",
            "catalog.channelByNumber",
            json!({"sourceId": sid, "number": 9_876}),
            |v| assert_eq!(v["name"], "Channel 9875"),
        ),
        (
            "all live channels (zap list)",
            "catalog.allLiveChannels",
            json!({"sourceId": sid}),
            // Capped by design (remote-control publication, see SPEC).
            |v| {
                assert_eq!(
                    v.as_array().unwrap().len(),
                    CHANNELS.min(iptv_core::catalog::ALL_LIVE_CAP)
                )
            },
        ),
    ];

    for (label, method, args, check) in calls {
        // Warm-up, then the timed call.
        let first = r
            .dispatch(env.state.clone(), method, args.clone())
            .await
            .unwrap_or_else(|e| panic!("{label}: {e:?}"));
        check(&first);
        let started = Instant::now();
        let v = r
            .dispatch(env.state.clone(), method, args)
            .await
            .unwrap_or_else(|e| panic!("{label}: {e:?}"));
        let took = started.elapsed();
        check(&v);
        eprintln!("catalog_perf: {label} in {took:?}");
        // The zap list returns up to ALL_LIVE_CAP rows in one call (not a
        // page); give it 4x.
        let budget = if method == "catalog.allLiveChannels" {
            QUERY_BUDGET * 4
        } else {
            QUERY_BUDGET
        };
        assert!(took < budget, "{label} took {took:?} (budget {budget:?})");
    }

    // Neighbors (channel up/down) on a channel in the middle of the list.
    let mid = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": sid, "query": {"offset": CHANNELS / 2, "limit": 1}}),
        )
        .await
        .unwrap();
    let reference = mid["items"][0]["ref"].clone();
    assert_eq!(reference["contentType"], json!(ContentType::Live), "{mid}");
    let _ = r
        .dispatch(
            env.state.clone(),
            "catalog.neighbors",
            json!({"ref": reference}),
        )
        .await
        .unwrap();
    let started = Instant::now();
    let n = r
        .dispatch(
            env.state.clone(),
            "catalog.neighbors",
            json!({"ref": reference}),
        )
        .await
        .unwrap();
    let took = started.elapsed();
    eprintln!("catalog_perf: neighbors in {took:?}");
    assert!(n["next"].is_object() && n["prev"].is_object(), "{n}");
    assert!(took < QUERY_BUDGET, "neighbors took {took:?}");

    // With a hidden category the list filters it out on every page; that
    // path must stay within budget too.
    r.dispatch(
        env.state.clone(),
        "catalog.setCategoryHidden",
        json!({"sourceId": sid, "contentType": "live", "categoryId": group, "hidden": true}),
    )
    .await
    .unwrap();
    let visible = CHANNELS - CHANNELS / GROUPS;
    for (label, args) in [
        ("first page, one group hidden", json!({"sourceId": sid})),
        (
            "deep page, one group hidden",
            json!({"sourceId": sid, "query": {"offset": visible - 100, "limit": 100}}),
        ),
    ] {
        let _ = r
            .dispatch(env.state.clone(), "catalog.channels", args.clone())
            .await
            .unwrap();
        let started = Instant::now();
        let v = r
            .dispatch(env.state.clone(), "catalog.channels", args)
            .await
            .unwrap();
        let took = started.elapsed();
        eprintln!("catalog_perf: {label} in {took:?}");
        assert_eq!(v["total"], visible as i64, "{label}");
        assert_eq!(v["items"].as_array().unwrap().len(), 100, "{label}");
        assert!(took < QUERY_BUDGET, "{label} took {took:?}");
    }
}
