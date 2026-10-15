//! End-to-end `stalker.*` flows against `iptv_fixtures::spawn_mock()` (C13
//! Stalker portal at `/stalker/portal.php`, MAC `00:1A:79:00:00:01`).

use iptv_core::events::BroadcastSink;
use iptv_core::model::StalkerSourceConfig;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppEvent, AppState, RpcError, RpcErrorCode};
use iptv_fixtures::MockHandle;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk1";

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    events: Receiver<AppEvent>,
    mock: MockHandle,
}

impl Env {
    async fn call(&self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        self.router.dispatch(self.state.clone(), cmd, args).await
    }

    async fn ok(&self, cmd: &str, args: Value) -> Value {
        match self.call(cmd, args).await {
            Ok(v) => v,
            Err(e) => panic!("{cmd} failed: {:?} {}", e.code, e.message),
        }
    }

    async fn cached_token(&self) -> Option<Value> {
        self.state
            .db_call(|c| {
                Ok(c.query_row(
                    "SELECT value FROM app_state WHERE key = 'stalker_token:stk1'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok())
            })
            .await
            .unwrap()
            .map(|s| serde_json::from_str(&s).unwrap())
    }

    fn drain_events(&mut self) -> Vec<AppEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = self.events.try_recv() {
            out.push(ev);
        }
        out
    }
}

fn config(mock: &MockHandle, path: &str, mac: &str, full: bool) -> StalkerSourceConfig {
    serde_json::from_value(json!({
        "portalUrl": mock.url(path),
        "macAddress": mac,
        "isFullPortal": full,
    }))
    .unwrap()
}

async fn env_with(path: &str, full: bool) -> Env {
    let mock = iptv_fixtures::spawn_mock().await;
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(4096);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    let cfg = serde_json::to_string(&config(&mock, path, MAC, full)).unwrap();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'stalker', 'Mock portal', ?2)",
                rusqlite::params![SID, cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    iptv_core::stalker::rpc::register(&mut router);
    Env {
        _tmp: tmp,
        state,
        router,
        events,
        mock,
    }
}

async fn env() -> Env {
    // The browser-style `/c` URL a user pastes; discovery finds portal.php.
    env_with("/stalker/c", true).await
}

fn r(ct: &str, id: &str) -> Value {
    json!({"sourceId": SID, "contentType": ct, "itemId": id})
}

async fn count(state: &AppState, sql: &'static str) -> i64 {
    state
        .db_call(move |c| Ok(c.query_row(sql, [], |r| r.get::<_, i64>(0))?))
        .await
        .unwrap()
}

#[tokio::test]
async fn sync_imports_live_and_radio_and_vod_categories_only() {
    let mut e = env().await;
    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(summary, json!({"channels": 35, "movies": 30, "series": 10}));

    let st = &e.state;
    assert_eq!(
        count(
            st,
            "SELECT count(*) FROM items WHERE source_id='stk1' AND content_type='live'"
        )
        .await,
        30
    );
    assert_eq!(count(st, "SELECT count(*) FROM items WHERE source_id='stk1' AND content_type='radio' AND is_radio=1").await, 5);
    assert_eq!(count(st, "SELECT count(*) FROM items WHERE source_id='stk1' AND content_type IN ('movie','series')").await, 0);
    assert!(
        count(
            st,
            "SELECT count(*) FROM categories WHERE source_id='stk1' AND content_type='live'"
        )
        .await
            >= 2
    );
    assert!(
        count(
            st,
            "SELECT count(*) FROM categories WHERE source_id='stk1' AND content_type='movie'"
        )
        .await
            >= 1
    );
    assert!(
        count(
            st,
            "SELECT count(*) FROM categories WHERE source_id='stk1' AND content_type='series'"
        )
        .await
            >= 1
    );
    assert_eq!(
        count(st, "SELECT count(*) FROM categories WHERE category_id='*'").await,
        0
    );
    // Archive and absolute logos.
    assert!(
        count(
            st,
            "SELECT count(*) FROM items WHERE item_id='1001' AND archive_hours > 0"
        )
        .await
            == 1
    );
    assert_eq!(
        count(
            st,
            "SELECT count(*) FROM items WHERE content_type='live' AND logo_url NOT LIKE 'http%'"
        )
        .await,
        0
    );
    assert!(count(st, "SELECT count(*) FROM sources WHERE id='stk1' AND last_refresh_at IS NOT NULL AND last_error IS NULL").await == 1);

    // Token cached under stalker_token:<sourceId> with the discovered endpoint.
    let cached = e.cached_token().await.expect("token cached");
    assert_eq!(cached["token"], "mock-token-1");
    assert_eq!(cached["endpoint"], e.mock.url("/stalker/portal.php"));

    let events = e.drain_events();
    let phases: Vec<String> = events
        .iter()
        .filter(|ev| ev.kind == "import.progress")
        .map(|ev| ev.payload["phase"].as_str().unwrap_or_default().to_string())
        .collect();
    // L1-sources-home-10: every run opens with `connecting`, before its first request.
    assert_eq!(phases.first().map(String::as_str), Some("connecting"));
    assert_eq!(phases.get(1).map(String::as_str), Some("fetching"));
    assert_eq!(phases.last().map(String::as_str), Some("done"));
    assert!(events.iter().any(|ev| ev.kind == "sources.changed"));
    // Secrets never leave in events.
    for ev in &events {
        let text = ev.payload.to_string();
        assert!(
            !text.contains(MAC) && !text.contains("mock-token"),
            "{text}"
        );
    }
}

#[tokio::test]
async fn rpc_sync_records_remote_totals_and_emits_one_done() {
    let mut e = env().await;
    iptv_core::sources::rpc::register(&mut e.router);
    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(summary, json!({"channels": 35, "movies": 30, "series": 10}));

    // sources.list shows the portal's movie/series totals (VOD is not stored
    // locally, so these come from set_remote_counts in sources::run_import).
    let list = e.ok("sources.list", json!({})).await;
    let src = list
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == SID)
        .expect("source listed")
        .clone();
    // channelCount is live only; radio stations are in radioCount.
    assert_eq!(
        src["channelCount"].as_i64().unwrap() + src["radioCount"].as_i64().unwrap(),
        35,
        "{src}"
    );
    assert!(src["radioCount"].as_i64().unwrap() > 0, "{src}");
    assert_eq!(src["movieCount"], 30, "{src}");
    assert_eq!(src["seriesCount"], 10, "{src}");
    assert!(src["lastRefreshAt"].is_string(), "{src}");
    assert!(src.get("lastError").is_none_or(Value::is_null), "{src}");

    let events = e.drain_events();
    let phases: Vec<&str> = events
        .iter()
        .filter(|ev| ev.kind == "import.progress")
        .map(|ev| ev.payload["phase"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        phases.iter().filter(|p| **p == "done").count(),
        1,
        "{phases:?}"
    );
    assert!(!phases.contains(&"error"), "{phases:?}");
    assert_eq!(phases.last(), Some(&"done"));
    let done = events
        .iter()
        .find(|ev| ev.kind == "import.progress" && ev.payload["phase"] == "done")
        .unwrap();
    assert_eq!(done.payload["total"], 75);
    assert_eq!(
        events
            .iter()
            .filter(|ev| ev.kind == "sources.changed")
            .count(),
        1
    );

    // sources.refresh goes through the same path: still exactly one done.
    e.ok("sources.refresh", json!({"id": SID})).await;
    let events = e.drain_events();
    let dones = events
        .iter()
        .filter(|ev| ev.kind == "import.progress" && ev.payload["phase"] == "done")
        .count();
    assert_eq!(dones, 1);
}

#[tokio::test]
async fn rpc_sync_failure_records_last_error_and_emits_one_error() {
    // A MAC the mock portal does not know fails the handshake.
    let mut e = env().await;
    iptv_core::sources::rpc::register(&mut e.router);
    let cfg =
        serde_json::to_string(&config(&e.mock, "/stalker/c", "00:1A:79:FF:FF:FF", true)).unwrap();
    e.state
        .db_call(move |c| {
            c.execute(
                "UPDATE sources SET config_json = ?1 WHERE id = ?2",
                rusqlite::params![cfg, SID],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    e.drain_events();
    let err = e.call("stalker.sync", json!({"sourceId": SID})).await;
    assert!(err.is_err());
    let list = e.ok("sources.list", json!({})).await;
    let src = &list.as_array().unwrap()[0];
    assert!(src["lastError"].is_string(), "{src}");
    let events = e.drain_events();
    let phases: Vec<&str> = events
        .iter()
        .filter(|ev| ev.kind == "import.progress")
        .map(|ev| ev.payload["phase"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        phases.iter().filter(|p| **p == "error").count(),
        1,
        "{phases:?}"
    );
    assert!(!phases.contains(&"done"), "{phases:?}");
    // The MAC never leaks through the error text.
    for ev in &events {
        let text = ev.payload.to_string().to_ascii_uppercase();
        assert!(!text.contains("FF:FF:FF"), "{text}");
    }
    assert!(
        !src["lastError"]
            .as_str()
            .unwrap()
            .to_ascii_uppercase()
            .contains("FF:FF:FF"),
        "{src}"
    );
}

#[tokio::test]
async fn sync_rejects_a_non_stalker_source_without_recording() {
    let e = env().await;
    e.state
        .db_call(|c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('m1', 'm3u', 'List', '{}')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let err = e
        .call("stalker.sync", json!({"sourceId": "m1"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    let err = e
        .call("stalker.sync", json!({"sourceId": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    assert_eq!(
        count(
            &e.state,
            "SELECT count(*) FROM sources WHERE id='m1' AND last_error IS NOT NULL"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn movies_map_offset_and_limit_onto_portal_pages() {
    let e = env().await;
    let page = e
        .ok(
            "stalker.movies",
            json!({"sourceId": SID, "query": {"offset": 10, "limit": 10}}),
        )
        .await;
    assert_eq!(page["total"], 30);
    assert_eq!(page["offset"], 10);
    let ids: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["ref"]["itemId"].as_str().unwrap())
        .collect();
    let want: Vec<String> = (5011..=5020).map(|i| i.to_string()).collect();
    assert_eq!(ids, want, "items 10..20 span portal pages 1 and 2");
    let first = &page["items"][0];
    assert_eq!(first["ref"]["contentType"], "movie");
    assert!(first["posterUrl"]
        .as_str()
        .unwrap()
        .starts_with("http://127.0.0.1"));
    assert!(first["durationSeconds"].as_i64().unwrap() > 0);

    let tail = e
        .ok(
            "stalker.movies",
            json!({"sourceId": SID, "query": {"offset": 28, "limit": 10}}),
        )
        .await;
    assert_eq!(tail["items"].as_array().unwrap().len(), 2);
    let past = e
        .ok(
            "stalker.movies",
            json!({"sourceId": SID, "query": {"offset": 60, "limit": 10}}),
        )
        .await;
    assert_eq!(past["items"].as_array().unwrap().len(), 0);

    // Search by a known title.
    let title = first["title"].as_str().unwrap().to_string();
    let found = e
        .ok(
            "stalker.search",
            json!({"sourceId": SID, "query": title, "contentType": "movie"}),
        )
        .await;
    assert!(found["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["ref"]["itemId"] == "5011"));
    let err = e
        .call(
            "stalker.search",
            json!({"sourceId": SID, "query": "x", "contentType": "live"}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
}

#[tokio::test]
async fn hide_mode_drops_locked_portal_titles_from_pages_and_search() {
    let mut e = env().await;
    iptv_core::parental::rpc::register(&mut e.router);
    let ids = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["ref"]["itemId"].as_str().unwrap().to_string())
            .collect()
    };
    let window = json!({"sourceId": SID, "query": {"offset": 0, "limit": 10}});
    let before = e.ok("stalker.movies", window.clone()).await;
    assert!(ids(&before).contains(&"5001".to_string()));
    let title = before["items"][0]["title"].as_str().unwrap().to_string();
    let search = json!({"sourceId": SID, "query": title, "contentType": "movie"});
    assert!(ids(&e.ok("stalker.search", search.clone()).await).contains(&"5001".to_string()));

    // A PIN turns parental controls on in Hide mode (the default); lock one portal title.
    e.ok("parental.setPin", json!({"newPin": "2468"})).await;
    e.ok(
        "parental.setLocked",
        json!({"target": {"sourceId": SID, "contentType": "movie", "kind": "item", "targetId": "5001", "name": "Locked"}, "locked": true}),
    )
    .await;
    let after = e.ok("stalker.movies", window).await;
    assert!(!ids(&after).contains(&"5001".to_string()));
    assert_eq!(ids(&after).len(), ids(&before).len() - 1);
    // The portal's count stays: it cannot say what later pages hide.
    assert_eq!(after["total"], before["total"]);
    assert!(!ids(&e.ok("stalker.search", search).await).contains(&"5001".to_string()));
}

#[tokio::test]
async fn vod_detail_and_stream_url() {
    let e = env().await;
    e.ok(
        "stalker.movies",
        json!({"sourceId": SID, "query": {"offset": 0, "limit": 14}}),
    )
    .await;
    let detail = e
        .ok("stalker.vodDetail", json!({"ref": r("movie", "5003")}))
        .await;
    assert_eq!(detail["item"]["ref"]["itemId"], "5003");
    assert!(!detail["cast"].as_array().unwrap().is_empty());
    assert!(detail["director"].is_string());

    let src = e
        .ok("stalker.streamUrl", json!({"ref": r("movie", "5003")}))
        .await;
    assert_eq!(src["url"], e.mock.url("/xtream/movie/demo/secret/203.mp4"));
    assert_eq!(src["kind"], "direct");
    assert_eq!(src["isLive"], false);
}

#[tokio::test]
async fn series_detail_and_episode_stream_url() {
    let e = env().await;
    let page = e
        .ok(
            "stalker.series",
            json!({"sourceId": SID, "query": {"offset": 0, "limit": 20}}),
        )
        .await;
    assert_eq!(page["total"], 10);
    assert_eq!(page["items"][0]["ref"]["contentType"], "series");
    let detail = e
        .ok("stalker.seriesDetail", json!({"ref": r("series", "7001")}))
        .await;
    let seasons = detail["seasons"].as_array().unwrap();
    assert_eq!(seasons.len(), 2);
    assert_eq!(seasons[1]["number"], 2);
    assert_eq!(seasons[1]["episodes"].as_array().unwrap().len(), 3);
    let ep = &seasons[1]["episodes"][2];
    assert_eq!(ep["episode"], 3);
    let episode_id = ep["id"].as_str().unwrap().to_string();

    let src = e
        .ok(
            "stalker.streamUrl",
            json!({"ref": r("series", "7001"), "episodeId": episode_id}),
        )
        .await;
    assert_eq!(
        src["url"],
        e.mock.url("/xtream/series/demo/secret/3006.mp4")
    );
    assert_eq!(src["episodeId"], episode_id);
    assert!(src["subtitle"].as_str().unwrap().starts_with("S02E03"));

    let err = e
        .call("stalker.streamUrl", json!({"ref": r("series", "7001")}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
}

#[tokio::test]
async fn live_stream_epg_and_catchup() {
    let e = env().await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    let src = e
        .ok("stalker.streamUrl", json!({"ref": r("live", "1001")}))
        .await;
    assert_eq!(src["url"], e.mock.url("/xtream/live/demo/secret/101.m3u8"));
    assert_eq!(src["kind"], "hls");
    assert_eq!(src["isLive"], true);
    // Same host as the portal: MAG identity headers travel with the stream.
    assert!(src["headers"]["userAgent"]
        .as_str()
        .unwrap()
        .contains("MAG200"));

    let radio = e
        .ok("stalker.streamUrl", json!({"ref": r("radio", "2001")}))
        .await;
    assert_eq!(radio["isRadio"], true);
    assert!(radio["url"]
        .as_str()
        .unwrap()
        .starts_with("http://127.0.0.1"));

    let epg = e
        .ok("stalker.epg", json!({"ref": r("live", "1001"), "limit": 4}))
        .await;
    let progs = epg.as_array().unwrap();
    assert!(!progs.is_empty() && progs.len() <= 4);
    assert!(progs
        .windows(2)
        .all(|w| w[0]["start"].as_str() <= w[1]["start"].as_str()));

    let start = (chrono::Utc::now() - chrono::Duration::hours(3))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let cu = e
        .ok(
            "stalker.catchupUrl",
            json!({"ref": r("live", "1001"), "start": start, "durationMinutes": 30}),
        )
        .await;
    assert!(
        cu["url"]
            .as_str()
            .unwrap()
            .contains("/xtream/timeshift/demo/secret/"),
        "{cu}"
    );
    // The program id came from get_simple_data_table, so the timeshift URL
    // carries the requested day.
    let year = &start[..4];
    assert!(
        cu["url"].as_str().unwrap().contains(&format!("/{year}-")),
        "{cu}"
    );
    assert_eq!(cu["isLive"], false);
    // A channel without archive refuses catch-up.
    let err = e
        .call(
            "stalker.catchupUrl",
            json!({"ref": r("live", "1030"), "start": start, "durationMinutes": 30}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Unsupported);
}

#[tokio::test]
async fn expired_token_rehandshakes_once() {
    let e = env().await;
    e.ok(
        "stalker.movies",
        json!({"sourceId": SID, "query": {"offset": 0, "limit": 5}}),
    )
    .await;
    // Portal invalidates the token: the next call re-handshakes and succeeds.
    let resp = e
        .state
        .http
        .post(e.mock.url("/stalker/_control/expire"))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let page = e
        .ok(
            "stalker.movies",
            json!({"sourceId": SID, "query": {"offset": 0, "limit": 5}}),
        )
        .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 5);
    assert_eq!(e.cached_token().await.unwrap()["token"], "mock-token-2");
}

#[tokio::test]
async fn stale_cached_token_is_replaced() {
    let e = env().await;
    let identity = iptv_core::stalker::session::identity_fingerprint(&config(
        &e.mock,
        "/stalker/c",
        MAC,
        true,
    ));
    let stale = json!({"endpoint": e.mock.url("/stalker/portal.php"), "token": "stale-token", "identity": identity}).to_string();
    e.state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO app_state (key, value) VALUES ('stalker_token:stk1', ?1)",
                [stale],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let page = e
        .ok(
            "stalker.series",
            json!({"sourceId": SID, "query": {"offset": 0, "limit": 3}}),
        )
        .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 3);
    assert_eq!(e.cached_token().await.unwrap()["token"], "mock-token-1");
}

#[tokio::test]
async fn token_free_panel_setting_still_connects() {
    // isFullPortal=false: probes without a token, and repairs with a handshake
    // when the portal turns out to require one (the C13 mock always does).
    let e = env_with("/stalker/portal.php", false).await;
    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(summary["channels"], 35);
}

#[tokio::test]
async fn account_info_and_connection_test() {
    let e = env().await;
    let info = e.ok("stalker.accountInfo", json!({"sourceId": SID})).await;
    assert_eq!(info["mac"], MAC);
    assert_eq!(info["tariff"], "Mock Premium");
    assert!(info["expDate"].is_string());
    assert!(info["raw"].is_object());
    let raw = info["raw"].to_string();
    assert!(!raw.contains("mock-token"));

    let ok = e
        .ok(
            "stalker.test",
            json!({"config": config(&e.mock, "/stalker/c/", MAC, true)}),
        )
        .await;
    assert_eq!(ok["ok"], true, "{ok}");
    assert_eq!(ok["name"], "Mock STB");

    let wrong_mac = "00:1A:79:00:00:99";
    let bad = e
        .ok(
            "stalker.test",
            json!({"config": config(&e.mock, "/stalker/c", wrong_mac, true)}),
        )
        .await;
    assert_eq!(bad["ok"], false);
    let msg = bad["message"].as_str().unwrap();
    assert!(msg.contains("not registered"), "{msg}");
    assert!(
        !msg.to_uppercase().contains("00:1A:79:00:00:99"),
        "MAC must not appear: {msg}"
    );

    let nowhere = e
        .ok(
            "stalker.test",
            json!({"config": config(&e.mock, "/nowhere", MAC, true)}),
        )
        .await;
    assert_eq!(nowhere["ok"], false);
    assert!(
        nowhere["message"]
            .as_str()
            .unwrap()
            .contains("No Stalker portal answered"),
        "{nowhere}"
    );

    let invalid = e
        .ok(
            "stalker.test",
            json!({"config": {"portalUrl": "portal", "macAddress": MAC}}),
        )
        .await;
    assert_eq!(invalid["ok"], false);
}

#[tokio::test]
async fn unknown_source_and_wrong_kind_errors() {
    let e = env().await;
    let err = e
        .call(
            "stalker.movies",
            json!({"sourceId": "missing", "query": {}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    let err = e
        .call("stalker.vodDetail", json!({"ref": r("live", "1001")}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    // A detail for an item never listed in this process and not in user state.
    let err = e
        .call("stalker.vodDetail", json!({"ref": r("movie", "999999")}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
}
