//! B9: the mock portal's failure modes end to end: non-ASCII playlists keep
//! their names, failing Xtream panels give classified errors without the
//! password, and a slow large playlist can be cancelled.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::error::RpcErrorCode;
use iptv_core::sources;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use support::*;

#[tokio::test]
async fn non_ascii_playlist_keeps_names_and_groups() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    let src = sources::add(
        env.state.clone(),
        url_args(&mock.url("/fail/unicode.m3u"), false),
    )
    .await
    .map_err(|e| e.error)
    .unwrap();
    let want = iptv_mock::failures::UNICODE_CHANNELS;
    assert_eq!(src.channel_count, want.len() as i64);

    let r = router();
    let page = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({ "sourceId": src.id, "query": { "limit": 100 } }),
        )
        .await
        .unwrap();
    let names: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    for (_, name) in want {
        assert!(names.contains(&name), "{name} missing from {names:?}");
    }
    let cats = r
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({ "sourceId": src.id, "contentType": "live" }),
        )
        .await
        .unwrap();
    let cat_names: Vec<String> = cats
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str().map(str::to_owned))
        .collect();
    for (group, _) in want {
        assert!(
            cat_names.iter().any(|c| c == group),
            "{group} missing from {cat_names:?}"
        );
    }
    // Search finds a CJK name.
    let hits = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({ "sourceId": src.id, "query": { "search": "\u{7dcf}\u{5408}" } }),
        )
        .await
        .unwrap();
    assert_eq!(hits["total"], 1, "{hits}");
}

async fn add_failing_xtream(mode: &str) -> iptv_core::error::RpcError {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    let mut r = router();
    iptv_core::xtream::rpc::register(&mut r);
    let started = Instant::now();
    let err = r
        .dispatch(
            env.state.clone(),
            "sources.add",
            json!({ "kind": "xtream", "xtream": {
                "serverUrl": mock.url(&format!("/fail/xtream/{mode}")),
                "username": "demo", "password": "secret"
            }}),
        )
        .await
        .expect_err(mode);
    assert!(started.elapsed() < Duration::from_secs(20), "{mode} hung");
    assert!(!err.message.contains("secret"), "{err:?}");
    err
}

#[tokio::test]
async fn failing_xtream_panels_are_classified() {
    for (mode, code) in [
        ("401", RpcErrorCode::Auth),
        ("403", RpcErrorCode::Auth),
        ("404", RpcErrorCode::NotFound),
        ("503", RpcErrorCode::Server),
        ("html", RpcErrorCode::Invalid),
        ("badjson", RpcErrorCode::Invalid),
    ] {
        let err = add_failing_xtream(mode).await;
        assert_eq!(err.code, code, "{mode}: {err:?}");
        assert!(!err.message.is_empty());
    }
}

#[tokio::test]
async fn slow_large_playlist_can_be_cancelled() {
    let mock = iptv_fixtures::spawn_mock().await;
    let mut env = env().await;
    let url = mock.url("/fail/slow-large.m3u?channels=200000&ms=300");
    let st = env.state.clone();
    let add = tokio::spawn(async move {
        router()
            .dispatch(
                st,
                "sources.add",
                json!({ "kind": "m3u", "name": "", "m3u": { "origin": "url", "url": url } }),
            )
            .await
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let id = loop {
        assert!(Instant::now() < deadline, "the add never started");
        let listed = sources::list(&env.state).await.unwrap();
        if let Some(s) = listed
            .first()
            .filter(|s| sources::is_import_running(&env.state, &s.id))
        {
            break s.id.clone();
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    tokio::time::sleep(Duration::from_millis(700)).await;
    let ok = router()
        .dispatch(
            env.state.clone(),
            "sources.cancelImport",
            json!({ "id": id }),
        )
        .await
        .unwrap();
    assert_eq!(ok, json!(true));
    let err = tokio::time::timeout(Duration::from_secs(5), add)
        .await
        .expect("the add kept running after cancelImport")
        .unwrap()
        .expect_err("a cancelled add rejects");
    assert_eq!(err.code, RpcErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("import stopped"), "{err:?}");
    assert!(err.message.contains("cancelled by user"), "{err:?}");
    assert_eq!(
        err.details.as_ref().map(|d| d["sourceId"].clone()),
        Some(Value::from(id.as_str()))
    );
    let events = drain(&mut env.events);
    let last = events
        .iter()
        .rfind(|e| e.kind == "import.progress" && e.payload["sourceId"] == id.as_str())
        .map(|e| e.payload["phase"].clone());
    assert_eq!(last, Some(json!("cancelled")));
    let src = sources::get(&env.state, &id).await.unwrap();
    assert_eq!(src.channel_count, 0, "nothing half-imported was kept");
    assert_eq!(src.last_error, None);
}
