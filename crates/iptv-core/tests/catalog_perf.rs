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

/// Group `g` of the mixed-language playlist: French (hidden by
/// English-only), British (kept), adult (hidden by parental hide mode) or
/// untagged.
fn mixed_group(g: usize) -> String {
    match g % 5 {
        _ if g < 10 => format!("XXX | Adult {g}"),
        0 => format!("FR | Groupe {g}"),
        1 => format!("UK | Group {g}"),
        _ => format!("Group {g}"),
    }
}

/// Channel `i`'s title: a Cyrillic name (hidden unless its group is
/// English), a German tag (hidden), an English tag (kept even in a French
/// group), a "UK:" tag (kept), capitals that are not a tag, or plain words.
/// Over half the titles go through the full title test rather than the
/// clause's `GLOB` shortcut, as in a typical provider list.
fn mixed_title(i: usize) -> String {
    match i % 50 {
        3 => format!("Канал {i}"),
        n if n % 7 == 0 => format!("DE - Channel {i}"),
        n if n % 7 == 1 => format!("EN - Channel {i}"),
        n if n % 7 == 2 => format!("UK: Channel {i}"),
        n if n % 7 == 3 => format!("BBC Channel {i}"),
        _ => format!("Channel {i}"),
    }
}

fn gen_mixed_m3u(n: usize, groups: usize) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(n * 170);
    s.push_str("#EXTM3U\n");
    for i in 0..n {
        let g = i % groups;
        let _ = write!(
            s,
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" tvg-logo=\"http://logo.example/{i}.png\" group-title=\"{}\",{}\nhttp://stream.example/live/{i}.ts\n",
            mixed_group(g),
            mixed_title(i)
        );
    }
    s
}

/// R1 review: `englishOnly` filters by the title and category language. On
/// 50k channels every whole-list call (categories, first and deep pages,
/// sort, one-letter search, the zap list, neighbors) stays within the same
/// budget as without it, alone and together with parental hide mode
/// (10 adult groups, 2 locked groups, 200 locked channels). Totals are
/// checked against the Rust rule, so a faster filter cannot drop or keep
/// the wrong rows.
///
/// Each call is timed after a warm-up call. English-only reads the verdict
/// the catalog writer stored (`items.non_english`, migration 0018), so the
/// warm-up builds no cache (`l2_query_perf` times it with a settings write
/// before every call); the budget is not scaled for debug builds, as above.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn english_only_queries_on_50k_channels_stay_fast() {
    use iptv_core::catalog::language::is_non_english;
    use iptv_core::parental::is_adult_category;
    use std::collections::HashSet;

    let env = env().await;
    let r = iptv_core::rpc::build_router();
    let src = add_text(&env.state, "mixed", &gen_mixed_m3u(CHANNELS, GROUPS)).await;
    assert_eq!(src.channel_count, CHANNELS as i64);
    let sid = src.id.clone();
    let call = |method: &'static str, args: Value| {
        let r = &r;
        let state = env.state.clone();
        async move {
            r.dispatch(state, method, args)
                .await
                .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        }
    };
    // Category ids by name, and the channels to lock (the first channel of
    // groups 20..220: channel k sits in group k % 250).
    let cats = call(
        "catalog.categories",
        json!({"sourceId": sid, "contentType": "live", "includeHidden": true}),
    )
    .await;
    assert_eq!(cats.as_array().unwrap().len(), GROUPS);
    call("settings.update", json!({"patch": {"englishOnly": true}})).await;
    let cat_id = |name: &str| -> String {
        cats.as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("{name} in {cats}"))["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let s2 = sid.clone();
    let titles: Vec<String> = (20..220).map(mixed_title).collect();
    let item_locks: Vec<String> = env
        .state
        .db_call(move |c| {
            let mut stmt = c.prepare(
                "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' AND title = ?2",
            )?;
            titles
                .iter()
                .map(|t| stmt.query_row(rusqlite::params![s2, t], |r| r.get(0)))
                .collect::<Result<Vec<String>, _>>()
                .map_err(Into::into)
        })
        .await
        .unwrap();
    let locked_groups = [12usize, 13];

    // What each mode must show, from the Rust rules.
    let expect = |hide: bool| -> (usize, usize) {
        let mut groups_seen = HashSet::new();
        let mut visible = 0;
        for i in 0..CHANNELS {
            let g = i % GROUPS;
            let name = mixed_group(g);
            if is_non_english(&mixed_title(i), Some(&name)) {
                continue;
            }
            if hide
                && (is_adult_category(&name)
                    || locked_groups.contains(&g)
                    || (20..220).contains(&i))
            {
                continue;
            }
            visible += 1;
            groups_seen.insert(g);
        }
        (visible, groups_seen.len())
    };

    for hide in [false, true] {
        if hide {
            for g in locked_groups {
                let id = cat_id(&mixed_group(g));
                call(
                    "parental.setLocked",
                    json!({"target": {"sourceId": sid, "contentType": "live", "kind": "category", "targetId": id, "name": "g"}, "locked": true}),
                )
                .await;
            }
            for id in &item_locks {
                call(
                    "parental.setLocked",
                    json!({"target": {"sourceId": sid, "contentType": "live", "kind": "item", "targetId": id, "name": "c"}, "locked": true}),
                )
                .await;
            }
            call("parental.setPin", json!({"newPin": "2468"})).await;
        }
        let mode = if hide {
            "englishOnly + hide"
        } else {
            "englishOnly"
        };
        let (visible, group_count) = expect(hide);
        assert!(visible > CHANNELS / 2 && visible < CHANNELS, "{visible}");
        let open_group = cat_id(&mixed_group(GROUPS / 2 + 2));

        type Check = Box<dyn Fn(&Value)>;
        let calls: Vec<(&str, &'static str, Value, Check)> = vec![
            (
                "categories",
                "catalog.categories",
                json!({"sourceId": sid, "contentType": "live"}),
                Box::new(move |v: &Value| assert_eq!(v.as_array().unwrap().len(), group_count)),
            ),
            (
                "first page",
                "catalog.channels",
                json!({"sourceId": sid}),
                Box::new(move |v: &Value| assert_eq!(v["total"], visible as i64)),
            ),
            (
                "deep page",
                "catalog.channels",
                json!({"sourceId": sid, "query": {"offset": visible - 100, "limit": 100}}),
                Box::new(|v: &Value| assert_eq!(v["items"].as_array().unwrap().len(), 100)),
            ),
            (
                "group page",
                "catalog.channels",
                json!({"sourceId": sid, "categoryId": open_group}),
                Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() > 0, "{v}")),
            ),
            (
                "sorted by name, descending",
                "catalog.channels",
                json!({"sourceId": sid, "query": {"sort": "name", "dir": "desc"}}),
                Box::new(move |v: &Value| assert_eq!(v["total"], visible as i64)),
            ),
            (
                "in-list search",
                "catalog.channels",
                json!({"sourceId": sid, "query": {"search": "Channel 99"}}),
                Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() > 0, "{v}")),
            ),
            (
                "in-list search, one letter",
                "catalog.channels",
                json!({"sourceId": sid, "query": {"search": "c"}}),
                Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() > 0, "{v}")),
            ),
            (
                "global search",
                "catalog.search",
                json!({"query": "Channel 1234"}),
                Box::new(|v: &Value| assert!(v["live"].is_array(), "{v}")),
            ),
            (
                "all live channels (zap list)",
                "catalog.allLiveChannels",
                json!({"sourceId": sid}),
                Box::new(move |v: &Value| {
                    assert_eq!(
                        v.as_array().unwrap().len(),
                        visible.min(iptv_core::catalog::ALL_LIVE_CAP)
                    )
                }),
            ),
        ];
        for (label, method, args, check) in calls {
            let first = call(method, args.clone()).await;
            check(&first);
            let started = Instant::now();
            let v = call(method, args).await;
            let took = started.elapsed();
            check(&v);
            eprintln!("catalog_perf: {mode}: {label} in {took:?}");
            let budget = if method == "catalog.allLiveChannels" {
                QUERY_BUDGET * 4
            } else {
                QUERY_BUDGET
            };
            assert!(
                took < budget,
                "{mode}: {label} took {took:?} (budget {budget:?})"
            );
        }

        let mid = call(
            "catalog.channels",
            json!({"sourceId": sid, "query": {"offset": visible / 2, "limit": 1}}),
        )
        .await;
        let reference = mid["items"][0]["ref"].clone();
        let _ = call("catalog.neighbors", json!({"ref": reference})).await;
        let started = Instant::now();
        let n = call("catalog.neighbors", json!({"ref": reference})).await;
        let took = started.elapsed();
        eprintln!("catalog_perf: {mode}: neighbors in {took:?}");
        assert!(n["next"].is_object() && n["prev"].is_object(), "{n}");
        assert!(took < QUERY_BUDGET, "{mode}: neighbors took {took:?}");
    }
}
