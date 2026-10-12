//! SC7 / check 8 (B8): a 10k-channel playlist parses, imports and answers
//! every catalog query the live and search screens run within a time budget.
//!
//! Budgets are for debug builds (what `cargo test` runs); release builds get
//! tighter ones. Each query budget is per call, measured after a warm-up call
//! so it reflects scrolling and typing, not the first SQLite page-in.
//!
//! Run: `cargo test -p iptv-core --test catalog_perf`

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::ContentType;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use support::*;

const CHANNELS: usize = 10_000;
const GROUPS: usize = 50;

#[cfg(debug_assertions)]
const PARSE_BUDGET: Duration = Duration::from_secs(2);
#[cfg(not(debug_assertions))]
const PARSE_BUDGET: Duration = Duration::from_millis(250);
#[cfg(debug_assertions)]
const IMPORT_BUDGET: Duration = Duration::from_secs(15);
#[cfg(not(debug_assertions))]
const IMPORT_BUDGET: Duration = Duration::from_secs(2);
/// One RPC call. A frame at 60 Hz is 16 ms; a list page or a search
/// keystroke must stay well under the 100 ms "instant" threshold in release.
#[cfg(debug_assertions)]
const QUERY_BUDGET: Duration = Duration::from_millis(400);
#[cfg(not(debug_assertions))]
const QUERY_BUDGET: Duration = Duration::from_millis(60);

#[test]
fn parse_10k_entries_within_budget() {
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
async fn queries_on_10k_channels_stay_fast() {
    let env = env().await;
    let started = Instant::now();
    let src = add_text(&env.state, "big", &gen_m3u(CHANNELS, GROUPS)).await;
    let took = started.elapsed();
    eprintln!("catalog_perf: imported {CHANNELS} channels in {took:?}");
    assert_eq!(src.channel_count, CHANNELS as i64);
    assert!(took < IMPORT_BUDGET, "import took {took:?}");

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
            |v| assert_eq!(v.as_array().unwrap().len(), CHANNELS),
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
        // The zap list returns every row by design; give it 4x.
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
}
