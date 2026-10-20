//! Guide slice: `epg.shortEpg` (cached Xtream fallback), `catchup.programs`
//! (Xtream archive table), the M3U catch-up override on channel rows, and the
//! backup round trip of the override and `epgShortFallback`.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::backup::{self, ImportMode};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

const USER: &str = "demo";
const PASS: &str = "secret";

async fn call(r: &RpcRouter, state: &Arc<AppState>, cmd: &str, args: Value) -> Value {
    match r.dispatch(state.clone(), cmd, args).await {
        Ok(v) => v,
        Err(e) => panic!("{cmd} failed: {:?} {}", e.code, e.message),
    }
}

async fn api_hits(mock: &iptv_fixtures::MockHandle) -> u64 {
    let v: Value = reqwest::get(mock.url("/__mock/stats"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Stats are keyed by path; only the panel API matters here.
    v["requests"]
        .as_object()
        .and_then(|m| {
            m.iter()
                .find(|(k, _)| k.contains("player_api"))
                .and_then(|(_, n)| n.as_u64())
        })
        .unwrap_or(0)
}

async fn xtream_source(state: &Arc<AppState>, server_url: &str) -> String {
    let id = format!("xt-{}", uuid::Uuid::new_v4().simple());
    let cfg = json!({"serverUrl": server_url, "username": USER, "password": PASS}).to_string();
    let id2 = id.clone();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', 'Mock', ?2)",
                rusqlite::params![id2, cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    id
}

fn live(sid: &str, id: &str) -> Value {
    json!({"sourceId": sid, "contentType": "live", "itemId": id})
}

fn secs(v: &Value) -> i64 {
    chrono::DateTime::parse_from_rfc3339(v.as_str().unwrap())
        .unwrap()
        .timestamp()
}

#[tokio::test]
async fn short_epg_is_cached_deduplicated_and_switchable() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = support::env().await;
    let state = env.state.clone();
    let sid = xtream_source(&state, &format!("{}/xtream", mock.base)).await;
    let r = build_router();
    let now = chrono::Utc::now().timestamp();

    let before = api_hits(&mock).await;
    let epg = call(
        &r,
        &state,
        "epg.shortEpg",
        json!({"ref": live(&sid, "101"), "limit": 3}),
    )
    .await;
    let list = epg.as_array().unwrap();
    assert!(!list.is_empty() && list.len() <= 3, "{epg}");
    for p in list {
        assert!(secs(&p["end"]) > now, "only programmes that have not ended");
        assert!(secs(&p["start"]) < secs(&p["end"]));
        // Decoded, not base64.
        assert!(!p["title"].as_str().unwrap().ends_with('='), "{p}");
    }
    assert_eq!(api_hits(&mock).await, before + 1);

    // Cached: no second panel call, a larger limit is sliced from the same answer.
    let again = call(
        &r,
        &state,
        "epg.shortEpg",
        json!({"ref": live(&sid, "101"), "limit": 6}),
    )
    .await;
    assert!(again.as_array().unwrap().len() >= list.len());
    assert_eq!(api_hits(&mock).await, before + 1);

    // Concurrent requests for one channel share one panel call.
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let state = state.clone();
        let args = json!({"ref": live(&sid, "102")});
        tasks.push(tokio::spawn(async move {
            build_router()
                .dispatch(state, "epg.shortEpg", args)
                .await
                .unwrap()
        }));
    }
    for t in tasks {
        assert!(!t.await.unwrap().as_array().unwrap().is_empty());
    }
    assert_eq!(api_hits(&mock).await, before + 2);

    // Unknown channel: an empty answer, not an error.
    let none = call(
        &r,
        &state,
        "epg.shortEpg",
        json!({"ref": live(&sid, "999999")}),
    )
    .await;
    assert_eq!(none, json!([]));

    // Setting off: nothing is fetched.
    call(
        &r,
        &state,
        "settings.update",
        json!({"patch": {"epgShortFallback": false}}),
    )
    .await;
    let hits = api_hits(&mock).await;
    let off = call(
        &r,
        &state,
        "epg.shortEpg",
        json!({"ref": live(&sid, "103")}),
    )
    .await;
    assert_eq!(off, json!([]));
    assert_eq!(api_hits(&mock).await, hits);
}

#[tokio::test]
async fn archive_programs_come_from_the_panel_table() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = support::env().await;
    let state = env.state.clone();
    let sid = xtream_source(&state, &format!("{}/xtream", mock.base)).await;
    let r = build_router();

    let now = chrono::Utc::now();
    let from = (now - chrono::Duration::hours(20)).to_rfc3339();
    let to = (now - chrono::Duration::hours(2)).to_rfc3339();
    let before = api_hits(&mock).await;
    let list = call(
        &r,
        &state,
        "catchup.programs",
        json!({"ref": live(&sid, "101"), "from": from, "to": to}),
    )
    .await;
    let list = list.as_array().unwrap().clone();
    assert!(list.len() > 3, "{list:?}");
    let (f, t) = (secs(&json!(from)), secs(&json!(to)));
    for p in &list {
        assert!(
            secs(&p["end"]) > f && secs(&p["start"]) < t,
            "overlaps the range"
        );
    }
    // Sorted by start.
    assert!(list
        .windows(2)
        .all(|w| secs(&w[0]["start"]) <= secs(&w[1]["start"])));

    // Another day of the same channel reuses the cached table.
    let from2 = (now - chrono::Duration::hours(1)).to_rfc3339();
    let to2 = (now + chrono::Duration::hours(6)).to_rfc3339();
    call(
        &r,
        &state,
        "catchup.programs",
        json!({"ref": live(&sid, "101"), "from": from2, "to": to2}),
    )
    .await;
    assert_eq!(api_hits(&mock).await, before + 1);

    // Bad ranges are refused.
    let err = r
        .dispatch(
            state.clone(),
            "catchup.programs",
            json!({"ref": live(&sid, "101"), "from": "x", "to": to}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);
}

/// GPT review (provider-guides-ignore-shifts): the source's guide shift
/// ("moves every programme of this source") left the panel's own guide
/// alone. The short EPG and the archive table now move by the channel's
/// shift, after their caches.
#[tokio::test]
async fn provider_guides_follow_the_guide_shift() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = support::env().await;
    let state = env.state.clone();
    let sid = xtream_source(&state, &format!("{}/xtream", mock.base)).await;
    let r = build_router();
    let now = chrono::Utc::now();
    let range = json!({
        "ref": live(&sid, "101"),
        "from": (now - chrono::Duration::days(7)).to_rfc3339(),
        "to": (now + chrono::Duration::days(7)).to_rfc3339()
    });
    let short = json!({"ref": live(&sid, "101"), "limit": 10});
    let plain_archive = call(&r, &state, "catchup.programs", range.clone()).await;
    let plain_short = call(&r, &state, "epg.shortEpg", short.clone()).await;

    let id = sid.clone();
    state
        .db_call(move |c| {
            c.execute(
                r#"UPDATE sources SET epg_json = '{"shiftMinutes":60}' WHERE id = ?1"#,
                [&id],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let starts = |v: &Value| -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| secs(&p["start"]))
            .collect()
    };
    // Both answers come from the caches: only the shift moved them.
    let archive = starts(&call(&r, &state, "catchup.programs", range).await);
    let expected: Vec<i64> = starts(&plain_archive).iter().map(|s| s + 3600).collect();
    assert!(!expected.is_empty());
    assert_eq!(archive, expected);
    let moved = starts(&call(&r, &state, "epg.shortEpg", short).await);
    let plain = starts(&plain_short);
    assert!(!plain.is_empty());
    for s in plain {
        assert!(moved.contains(&(s + 3600)), "{s} not moved: {moved:?}");
    }
}

#[tokio::test]
async fn m3u_sources_get_no_provider_guide() {
    let env = support::env().await;
    let src = support::add_text(
        &env.state,
        "T",
        "#EXTM3U\n#EXTINF:-1 group-title=\"A\",One\nhttp://h/one.ts\n",
    )
    .await;
    let r = build_router();
    let page = call(
        &r,
        &env.state,
        "catalog.channels",
        json!({"sourceId": src.id}),
    )
    .await;
    let item = &page["items"][0]["ref"];
    let epg = call(&r, &env.state, "epg.shortEpg", json!({"ref": item})).await;
    assert_eq!(epg, json!([]));
    let now = chrono::Utc::now();
    let progs = call(
        &r,
        &env.state,
        "catchup.programs",
        json!({"ref": item, "from": (now - chrono::Duration::hours(3)).to_rfc3339(), "to": now.to_rfc3339()}),
    )
    .await;
    assert_eq!(progs, json!([]));
}

const PLAYLIST: &str = "#EXTM3U\n\
#EXTINF:-1 group-title=\"A\",Plain\nhttp://h/plain.ts\n\
#EXTINF:-1 catchup=\"append\" catchup-days=\"2\" catchup-source=\"?utc={utc}\" group-title=\"A\",Arc\nhttp://h/arc.ts\n\
#EXTINF:-1 radio=\"true\" group-title=\"R\",Radio\nhttp://h/radio.mp3\n";

async fn channel(r: &RpcRouter, state: &Arc<AppState>, sid: &str, name: &str) -> Value {
    let page = call(r, state, "catalog.channels", json!({"sourceId": sid})).await;
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("{name} missing"))
        .clone()
}

#[tokio::test]
async fn m3u_override_applies_on_read_and_survives_backup() {
    let env = support::env().await;
    let state = env.state.clone();
    let src = support::add_text(&state, "T", PLAYLIST).await;
    let r = build_router();

    let plain = channel(&r, &state, &src.id, "Plain").await;
    assert!(plain.get("archive").is_none());

    // Shift for every live channel, 3 days.
    let mut m3u = serde_json::to_value(src.m3u.clone().unwrap()).unwrap();
    m3u["catchup"] = json!({"type": "shift", "days": 3});
    call(
        &r,
        &state,
        "sources.update",
        json!({"id": src.id, "patch": {"m3u": m3u}}),
    )
    .await;
    let plain = channel(&r, &state, &src.id, "Plain").await;
    assert_eq!(
        plain["archive"],
        json!({"enabled": true, "durationHours": 72})
    );
    assert_eq!(plain["catchup"], json!({"type": "shift", "days": 3}));
    // Every read path sees it: item, channelByNumber, search.
    let item = call(&r, &state, "catalog.item", json!({"ref": plain["ref"]})).await;
    assert_eq!(item["archive"]["durationHours"], 72, "{item}");
    let found = call(
        &r,
        &state,
        "catalog.search",
        json!({"query": "Plain", "sourceId": src.id}),
    )
    .await;
    assert_eq!(found["live"][0]["catchup"]["type"], "shift", "{found}");
    // Radio rows are left alone.
    let radio = call(
        &r,
        &state,
        "catalog.channels",
        json!({"sourceId": src.id, "radio": true}),
    )
    .await;
    assert!(radio["items"][0].get("archive").is_none());

    // Invalid overrides are refused.
    let mut bad = m3u.clone();
    bad["catchup"] = json!({"type": "rewind"});
    let err = r
        .dispatch(
            state.clone(),
            "sources.update",
            json!({"id": src.id, "patch": {"m3u": bad}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);

    // Backup round trip: the override and the setting come back.
    call(
        &r,
        &state,
        "settings.update",
        json!({"patch": {"epgShortFallback": false}}),
    )
    .await;
    let exported = backup::export(&state, false, None).await.unwrap();
    let manifest: Value = serde_json::from_str(&exported.json).unwrap();
    assert_eq!(manifest["settings"]["epgShortFallback"], false);

    let env2 = support::env().await;
    let st2 = env2.state.clone();
    backup::import(&st2, &exported.json, ImportMode::Merge)
        .await
        .unwrap();
    assert!(!st2.settings_snapshot().epg_short_fallback);
    let sources = call(&r, &st2, "sources.list", json!(null)).await;
    let restored = &sources.as_array().unwrap()[0];
    assert_eq!(
        restored["m3u"]["catchup"],
        json!({"type": "shift", "days": 3}),
        "{restored}"
    );
    let sid2 = restored["id"].as_str().unwrap().to_string();
    let plain = channel(&r, &st2, &sid2, "Plain").await;
    assert_eq!(plain["archive"]["durationHours"], 72);

    // `none` turns catch-up off, also for channels the playlist marks.
    m3u["catchup"] = json!({"type": "none"});
    call(
        &r,
        &state,
        "sources.update",
        json!({"id": src.id, "patch": {"m3u": m3u}}),
    )
    .await;
    let arc = channel(&r, &state, &src.id, "Arc").await;
    assert!(
        arc.get("archive").is_none() && arc.get("catchup").is_none(),
        "{arc}"
    );
}

/// Short-EPG answers cached (the test keeps one source's at a time).
fn cached_short(state: &Arc<AppState>) -> usize {
    iptv_core::catchup::runtime(state).short.len()
}

#[tokio::test]
async fn guide_caches_are_dropped_when_a_source_changes_or_goes() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = support::env().await;
    let state = env.state.clone();
    let server = format!("{}/xtream", mock.base);
    let sid = xtream_source(&state, &server).await;
    let r = build_router();

    call(
        &r,
        &state,
        "epg.shortEpg",
        json!({"ref": live(&sid, "101")}),
    )
    .await;
    assert_eq!(cached_short(&state), 1);
    // Same panel, new account: stream ids may mean other channels now.
    call(
        &r,
        &state,
        "sources.update",
        json!({"id": sid, "patch": {"xtream": {"serverUrl": server, "username": "other", "password": PASS}}}),
    )
    .await;
    assert_eq!(
        cached_short(&state),
        0,
        "an account change drops the answers"
    );

    let sid2 = xtream_source(&state, &server).await;
    call(
        &r,
        &state,
        "epg.shortEpg",
        json!({"ref": live(&sid2, "101")}),
    )
    .await;
    assert_eq!(cached_short(&state), 1);
    call(&r, &state, "sources.remove", json!({"id": sid2})).await;
    assert_eq!(cached_short(&state), 0, "a removed source keeps nothing");
}

#[tokio::test]
async fn live_alternates_carry_the_m3u_catchup_override() {
    let env = support::env().await;
    let state = env.state.clone();
    let a = support::add_text(&state, "A", PLAYLIST).await;
    // Another provider: the same channel at another URL (the same URL is never an alternate).
    let b = support::add_text(&state, "B", &PLAYLIST.replace("http://h/", "http://other/")).await;
    let r = build_router();
    let mut m3u = serde_json::to_value(b.m3u.clone().unwrap()).unwrap();
    m3u["catchup"] = json!({"type": "none"});
    call(
        &r,
        &state,
        "sources.update",
        json!({"id": b.id, "patch": {"m3u": m3u}}),
    )
    .await;

    let arc = channel(&r, &state, &a.id, "Arc").await;
    assert!(
        arc.get("catchup").is_some(),
        "source A keeps the playlist's catch-up"
    );
    let alt = call(&r, &state, "live.alternates", json!({"ref": arc["ref"]})).await;
    let from_b = alt["alternates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["channel"]["ref"]["sourceId"] == b.id.as_str())
        .unwrap_or_else(|| panic!("B's Arc is an alternate: {alt}"));
    assert!(
        from_b["channel"].get("catchup").is_none() && from_b["channel"].get("archive").is_none(),
        "the override turns catch-up off on the failover channel too: {from_b}"
    );
}
