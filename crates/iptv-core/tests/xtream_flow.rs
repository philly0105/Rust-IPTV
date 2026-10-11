//! End-to-end xtream flow over RPC against B11's mock (or the embedded stub
//! when the mock does not serve Xtream yet; see `xtream_stub.rs`).

use iptv_core::model::{EpgLinks, Source, SourceKind, StreamFormat};
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

#[path = "xtream_stub.rs"]
mod stub;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    r
}

async fn call(r: &RpcRouter, state: &Arc<AppState>, cmd: &str, args: Value) -> Value {
    match r.dispatch(state.clone(), cmd, args).await {
        Ok(v) => v,
        Err(e) => panic!("{cmd} failed: {:?} {}", e.code, e.message),
    }
}

fn item_ref(sid: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": sid, "contentType": ct, "itemId": id})
}

async fn count(state: &Arc<AppState>, sid: &str, ct: &'static str) -> i64 {
    let sid = sid.to_string();
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM items WHERE source_id = ?1 AND content_type = ?2",
                rusqlite::params![sid, ct],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap()
}

async fn epg_links(state: &Arc<AppState>, sid: &str) -> EpgLinks {
    let sid = sid.to_string();
    let raw: String = state
        .db_call(move |c| {
            Ok(
                c.query_row("SELECT epg_json FROM sources WHERE id = ?1", [&sid], |r| {
                    r.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[tokio::test]
async fn flow_against_mock() {
    let srv = stub::server().await;
    if srv.is_stub {
        eprintln!("note: iptv_fixtures mock has no Xtream routes; using embedded stub");
    }
    run_flow(srv).await;
}

#[tokio::test]
async fn flow_against_embedded_stub() {
    run_flow(stub::stub().await).await;
}

async fn run_flow(srv: stub::Server) {
    let (_dir, state, mut rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, stub::USER, stub::PASS).await;
    let r = router();

    // Sync over RPC.
    let summary = call(&r, &state, "xtream.sync", json!({"sourceId": sid})).await;
    assert_eq!(summary, json!({"channels": 40, "movies": 30, "series": 10}));
    // `radio_streams` entries (Classic FM in the mock) land in the radio type.
    let radio = count(&state, &sid, "radio").await;
    assert_eq!(count(&state, &sid, "live").await + radio, 40);
    if !srv.is_stub {
        assert_eq!(radio, 1);
    }
    assert_eq!(count(&state, &sid, "movie").await, 30);
    assert_eq!(count(&state, &sid, "series").await, 10);

    // Progress and sources.changed were emitted.
    let mut kinds = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        kinds.push(ev.kind);
    }
    assert!(kinds.iter().any(|k| k == "sources.changed"), "{kinds:?}");
    assert!(kinds.iter().any(|k| k.contains("progress")), "{kinds:?}");

    // Source row: refresh recorded, no credentials in catalog rows.
    let sid2 = sid.clone();
    let (refreshed, err, leaked): (Option<String>, Option<String>, i64) = state
        .db_call(move |c| {
            let (l, x) = c.query_row(
                "SELECT last_refresh_at, last_error FROM sources WHERE id = ?1",
                [&sid2],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let leaked: i64 = c.query_row(
                "SELECT COUNT(*) FROM items WHERE source_id = ?1 AND (url IS NOT NULL \
                 OR extra_json LIKE '%demo/secret%' OR extra_json LIKE '%password=secret%')",
                [&sid2],
                |r| r.get(0),
            )?;
            Ok((l, x, leaked))
        })
        .await
        .unwrap();
    assert!(refreshed.is_some());
    assert_eq!(err, None);
    assert_eq!(leaked, 0, "password stored in catalog rows");

    // xmltv.php detected.
    let expected_xmltv = format!("{}/xmltv.php?username=demo&password=secret", srv.server_url);
    assert_eq!(
        epg_links(&state, &sid).await.detected_urls,
        vec![expected_xmltv.clone()]
    );

    // A subset resync keeps other types and does not duplicate the link.
    let s2 = call(
        &r,
        &state,
        "xtream.sync",
        json!({"sourceId": sid, "contentTypes": ["movie"]}),
    )
    .await;
    assert_eq!(s2["movies"], 30);
    assert_eq!(
        epg_links(&state, &sid).await.detected_urls,
        vec![expected_xmltv]
    );
    assert_eq!(
        count(&state, &sid, "live").await + radio,
        40,
        "subset sync must keep other types"
    );

    // Live stream URL follows settings.streamFormat.
    let live = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    assert_eq!(
        live["url"],
        format!("{}/live/demo/secret/101.m3u8", srv.server_url)
    );
    assert_eq!(live["kind"], "hls");
    assert_eq!(live["isLive"], true);
    state.settings.write().stream_format = StreamFormat::Ts;
    let live_ts = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    assert_eq!(
        live_ts["url"],
        format!("{}/live/demo/secret/101.ts", srv.server_url)
    );
    assert_eq!(live_ts["kind"], "direct");
    state.settings.write().stream_format = StreamFormat::M3u8;

    // Movie URL.
    let movie = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "movie", "201")}),
    )
    .await;
    assert_eq!(
        movie["url"],
        format!("{}/movie/demo/secret/201.mp4", srv.server_url)
    );
    assert_eq!(movie["kind"], "direct");
    assert_eq!(movie["isLive"], false);

    // Series detail and episode URL.
    let detail = call(
        &r,
        &state,
        "xtream.seriesDetail",
        json!({"ref": item_ref(&sid, "series", "301")}),
    )
    .await;
    let seasons = detail["seasons"].as_array().unwrap();
    assert_eq!(seasons.len(), 2);
    assert!(seasons
        .iter()
        .all(|s| s["episodes"].as_array().unwrap().len() == 3));
    assert_eq!(seasons[0]["number"], 1);
    let first = &seasons[0]["episodes"][0];
    let ep_id = first["id"].as_str().unwrap().to_string();
    let ext = first["containerExtension"]
        .as_str()
        .unwrap_or("mp4")
        .to_string();
    let ep = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "series", "301"), "episodeId": ep_id}),
    )
    .await;
    assert_eq!(
        ep["url"],
        format!("{}/series/demo/secret/{ep_id}.{ext}", srv.server_url)
    );
    assert_eq!(ep["episodeId"], ep_id);
    assert!(
        ep["subtitle"].as_str().unwrap().starts_with("S01E01"),
        "{}",
        ep["subtitle"]
    );

    // Series without an episode is a clear Invalid error.
    let e = r
        .dispatch(
            state.clone(),
            "xtream.streamUrl",
            json!({"ref": item_ref(&sid, "series", "301")}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.message, "Choose an episode to play.");

    // VOD detail.
    let vod = call(
        &r,
        &state,
        "xtream.vodDetail",
        json!({"ref": item_ref(&sid, "movie", "201")}),
    )
    .await;
    assert_eq!(vod["item"]["ref"]["itemId"], "201");
    assert!(!vod["item"]["title"].as_str().unwrap().is_empty());
    assert!(vod["director"].is_string(), "{vod}");

    // Short EPG: decoded titles, ISO instants.
    let epg = call(
        &r,
        &state,
        "xtream.shortEpg",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    let epg = epg.as_array().unwrap();
    assert!(!epg.is_empty() && epg.len() <= 4, "{epg:?}");
    for p in epg {
        let s = chrono::DateTime::parse_from_rfc3339(p["start"].as_str().unwrap()).unwrap();
        let e = chrono::DateTime::parse_from_rfc3339(p["end"].as_str().unwrap()).unwrap();
        assert!(s < e);
    }
    if srv.is_stub {
        assert_eq!(epg[0]["title"], "Programme 0");
        assert_eq!(epg[0]["description"], "About this programme");
    }

    // Catch-up: server-local stamp, duration in minutes.
    let start = chrono::Utc::now() - chrono::Duration::hours(2);
    let start = start - chrono::Duration::seconds(start.timestamp() % 60);
    let cu = call(
        &r,
        &state,
        "xtream.catchupUrl",
        json!({"ref": item_ref(&sid, "live", "101"), "start": start.to_rfc3339(), "durationMinutes": 30}),
    )
    .await;
    let url = cu["url"].as_str().unwrap();
    assert!(
        url.starts_with(&format!("{}/timeshift/demo/secret/30/", srv.server_url)),
        "{url}"
    );
    assert!(url.ends_with("/101.ts"), "{url}");
    if srv.is_stub {
        // The stub's server clock runs at UTC+1.
        let local = start + chrono::Duration::hours(1);
        assert!(
            url.contains(&local.format("/%Y-%m-%d:%H-%M/").to_string()),
            "{url}"
        );
    }
    let future = (chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339();
    let e = r
        .dispatch(
            state.clone(),
            "xtream.catchupUrl",
            json!({"ref": item_ref(&sid, "live", "101"), "start": future, "durationMinutes": 30}),
        )
        .await
        .unwrap_err();
    assert!(e.message.contains("not aired"), "{}", e.message);

    // Account info and connection test (URL pasted with player_api.php).
    let acc = call(&r, &state, "xtream.accountInfo", json!({"sourceId": sid})).await;
    assert_eq!(acc["status"], "Active");
    assert!(acc["maxConnections"].as_i64().unwrap() >= 1);
    let t = call(
        &r,
        &state,
        "xtream.test",
        json!({"config": {"serverUrl": format!("{}/player_api.php", srv.server_url), "username": "demo", "password": "secret"}}),
    )
    .await;
    assert_eq!(t["ok"], true, "{t}");

    // Importer path (what sources.refresh calls).
    let imp = iptv_core::sources::importer(&state, SourceKind::Xtream).unwrap();
    let source: Source = serde_json::from_value(json!({
        "id": sid, "kind": "xtream", "name": "Mock Xtream", "position": 0, "autoRefresh": false,
        "createdAt": "2026-10-11T00:00:00Z",
        "xtream": {"serverUrl": srv.server_url, "username": "demo", "password": "secret"}
    }))
    .unwrap();
    while rx.try_recv().is_ok() {}
    let s = imp.import(state.clone(), &source).await.unwrap();
    assert_eq!((s.channels, s.movies, s.series), (40, 30, 10));
    // The importer leaves `done` / `error` and `sources.changed` to `sources::run_import`.
    while let Ok(ev) = rx.try_recv() {
        assert_ne!(ev.kind, "sources.changed");
        if ev.kind == "import.progress" {
            let phase = ev.payload["phase"].as_str().unwrap_or_default().to_string();
            assert!(
                phase != "done" && phase != "error",
                "importer emitted {phase}"
            );
        }
    }
}
