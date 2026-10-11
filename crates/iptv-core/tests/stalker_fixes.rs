//! Review fixes for the Stalker slice: row cache across resync/restart,
//! archived EPG with `from`, catch-up window checks, unreachable portals,
//! wrong and grandfathered MACs, and portal totals that fail to load.

use iptv_core::events::BroadcastSink;
use iptv_core::model::StalkerSourceConfig;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, RpcError, RpcErrorCode};
use iptv_fixtures::MockHandle;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk1";

struct Env {
    tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
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
}

fn config_for(portal_url: String, mac: &str) -> StalkerSourceConfig {
    serde_json::from_value(json!({
        "portalUrl": portal_url,
        "macAddress": mac,
        "isFullPortal": true,
    }))
    .unwrap()
}

fn router() -> RpcRouter {
    let mut router = RpcRouter::new();
    iptv_core::stalker::rpc::register(&mut router);
    iptv_core::sources::rpc::register(&mut router);
    iptv_core::backup::rpc::register(&mut router);
    router
}

async fn new_state(dir: &std::path::Path) -> Arc<AppState> {
    let (sink, _events) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    state
}

async fn env_at(portal_url: Option<String>, mac: &str) -> Env {
    let mock = iptv_fixtures::spawn_mock().await;
    let tmp = tempfile::tempdir().unwrap();
    let state = new_state(tmp.path()).await;
    let url = portal_url.unwrap_or_else(|| mock.url("/stalker/c"));
    let cfg = serde_json::to_string(&config_for(url, mac)).unwrap();
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
    Env {
        tmp,
        state,
        router: router(),
        mock,
    }
}

async fn env() -> Env {
    env_at(None, MAC).await
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

async fn set_source_config(state: &AppState, cfg: &StalkerSourceConfig) {
    let cfg = serde_json::to_string(cfg).unwrap();
    state
        .db_call(move |c| {
            c.execute(
                "UPDATE sources SET config_json = ?1 WHERE id = ?2",
                rusqlite::params![cfg, SID],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

fn rfc(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------------------
// F1: listed rows survive a resync and a restart
// ---------------------------------------------------------------------------

#[tokio::test]
async fn vod_rows_survive_resync_and_restart() {
    let e = env().await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    e.ok(
        "stalker.movies",
        json!({"sourceId": SID, "query": {"offset": 0, "limit": 14}}),
    )
    .await;
    e.ok(
        "stalker.series",
        json!({"sourceId": SID, "query": {"offset": 0, "limit": 14}}),
    )
    .await;
    let detail = e
        .ok("stalker.vodDetail", json!({"ref": r("movie", "5003")}))
        .await;
    let title = detail["item"]["title"].clone();
    assert!(title.is_string());

    // A resync used to wipe the cache ("This title is no longer cached").
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    e.ok("sources.refresh", json!({"id": SID})).await;
    let again = e
        .ok("stalker.vodDetail", json!({"ref": r("movie", "5003")}))
        .await;
    assert_eq!(again["item"]["title"], title);
    e.ok("stalker.seriesDetail", json!({"ref": r("series", "7002")}))
        .await;

    // A fresh AppState on the same data dir (an app restart): the rows come
    // from `stalker_items`.
    let restarted = Env {
        state: new_state(e.tmp.path()).await,
        router: router(),
        tmp: tempfile::tempdir().unwrap(),
        mock: iptv_fixtures::spawn_mock().await,
    };
    let detail = restarted
        .ok("stalker.vodDetail", json!({"ref": r("movie", "5003")}))
        .await;
    assert_eq!(detail["item"]["title"], title);
    let src = restarted
        .ok("stalker.streamUrl", json!({"ref": r("movie", "5003")}))
        .await;
    assert_eq!(src["url"], e.mock.url("/xtream/movie/demo/secret/203.mp4"));
    let series = restarted
        .ok("stalker.seriesDetail", json!({"ref": r("series", "7002")}))
        .await;
    assert_eq!(series["seasons"].as_array().unwrap().len(), 2);

    // Rows go with their source.
    restarted.ok("sources.remove", json!({"id": SID})).await;
    assert_eq!(
        count(
            &restarted.state,
            "SELECT count(*) FROM stalker_items WHERE source_id='stk1'"
        )
        .await,
        0
    );
}

// ---------------------------------------------------------------------------
// F2 + F9: archived programmes, catch-up window
// ---------------------------------------------------------------------------

#[tokio::test]
async fn epg_from_returns_archived_programmes() {
    let e = env().await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    let now = chrono::Utc::now();
    let from_at = now - chrono::Duration::hours(30);
    let from = rfc(from_at);
    let now_s = rfc(now);
    let progs = e
        .ok(
            "stalker.epg",
            json!({"ref": r("live", "1001"), "limit": 4, "from": from}),
        )
        .await;
    let progs = progs.as_array().unwrap().clone();
    let starts: Vec<String> = progs
        .iter()
        .map(|p| p["start"].as_str().unwrap().to_string())
        .collect();
    assert!(starts.windows(2).all(|w| w[0] < w[1]), "{starts:?}");
    // Past programmes reach back to `from` (mock slots last at most 90 min).
    let earliest = chrono::DateTime::parse_from_rfc3339(&starts[0]).unwrap();
    assert!(
        earliest <= from_at + chrono::Duration::minutes(90),
        "{starts:?}"
    );
    assert!(progs
        .iter()
        .all(|p| p["end"].as_str().unwrap() > from.as_str()));
    let past = progs
        .iter()
        .filter(|p| p["end"].as_str().unwrap() <= now_s.as_str())
        .count();
    assert!(past >= 15, "30 hours of past programmes, got {past}");
    let upcoming = progs.len() - past;
    assert!(
        (1..=4).contains(&upcoming),
        "limit caps upcoming: {upcoming}"
    );

    // A past programme from the list plays as catch-up, subtitled with the
    // matched programme's own start (not the requested time).
    let pick = progs
        .iter()
        .rev()
        .find(|p| p["end"].as_str().unwrap() < now_s.as_str())
        .unwrap();
    let pick_start = chrono::DateTime::parse_from_rfc3339(pick["start"].as_str().unwrap())
        .unwrap()
        .with_timezone(&chrono::Utc);
    let cu = e
        .ok(
            "stalker.catchupUrl",
            json!({
                "ref": r("live", "1001"),
                "start": rfc(pick_start + chrono::Duration::minutes(5)),
                "durationMinutes": 30
            }),
        )
        .await;
    let want = pick_start.format("%Y-%m-%d %H:%M UTC").to_string();
    assert!(
        cu["subtitle"].as_str().unwrap().starts_with(&want),
        "{cu} vs {want}"
    );

    // Without `from` nothing past is returned.
    let plain = e
        .ok("stalker.epg", json!({"ref": r("live", "1001"), "limit": 4}))
        .await;
    assert!(plain
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["end"].as_str().unwrap() > now_s.as_str()));
    let err = e
        .call(
            "stalker.epg",
            json!({"ref": r("live", "1001"), "from": "yesterday"}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
}

#[tokio::test]
async fn catchup_rejects_future_and_out_of_window_starts() {
    let e = env().await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    let future = rfc(chrono::Utc::now() + chrono::Duration::hours(1));
    let err = e
        .call(
            "stalker.catchupUrl",
            json!({"ref": r("live", "1001"), "start": future, "durationMinutes": 30}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid, "{}", err.message);
    let old = rfc(chrono::Utc::now() - chrono::Duration::days(30));
    let err = e
        .call(
            "stalker.catchupUrl",
            json!({"ref": r("live", "1001"), "start": old, "durationMinutes": 30}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid, "{}", err.message);
    assert!(err.message.contains("7 days"), "{}", err.message);
}

// ---------------------------------------------------------------------------
// F3: unreachable portal
// ---------------------------------------------------------------------------

/// A local port with nothing listening on it.
fn closed_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

#[tokio::test]
async fn unreachable_portal_says_so_plainly() {
    let port = closed_port();
    let url = format!("http://127.0.0.1:{port}/c/");
    let e = env_at(Some(url.clone()), MAC).await;
    let want = format!(
        "Could not reach the portal at 127.0.0.1:{port}. Check the URL and your connection, then try again."
    );

    let res = e
        .ok("stalker.test", json!({"config": config_for(url, MAC)}))
        .await;
    assert_eq!(res["ok"], false);
    assert_eq!(res["message"], want.as_str(), "{res}");

    let err = e
        .call("stalker.sync", json!({"sourceId": SID}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Network);
    assert!(err.retryable);
    assert_eq!(err.message, want);
    let list = e.ok("sources.list", json!({})).await;
    assert_eq!(list[0]["lastError"], want.as_str(), "{list}");
}

// ---------------------------------------------------------------------------
// F4 + F5: wrong MAC message, grandfathered MACs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn wrong_mac_message_is_plain() {
    let e = env().await;
    let wrong = "00:1A:79:00:00:99";
    let bad = e
        .ok(
            "stalker.test",
            json!({"config": config_for(e.mock.url("/stalker/c"), wrong)}),
        )
        .await;
    assert_eq!(bad["ok"], false);
    assert_eq!(
        bad["message"],
        "This MAC address is not registered on the portal. Check the MAC or contact your provider. Portal message: Your STB is not registered. Call the provider.",
        "{bad}"
    );
}

#[tokio::test]
async fn grandfathered_mac_is_kept_and_sent_verbatim() {
    let e = env().await;
    let legacy = config_for(e.mock.url("/stalker/c"), "MAG-0001");
    set_source_config(&e.state, &legacy).await;

    // Not rejected locally: the handshake runs and the portal answers.
    let err = e
        .call("stalker.sync", json!({"sourceId": SID}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Auth, "{}", err.message);
    assert!(
        err.message
            .starts_with("This MAC address is not registered on the portal."),
        "{}",
        err.message
    );

    // sources.update keeps the unchanged legacy value while other fields change.
    let mut edited = serde_json::to_value(&legacy).unwrap();
    edited["username"] = json!("someone");
    let updated = e
        .ok(
            "sources.update",
            json!({"id": SID, "patch": {"name": "Renamed", "stalker": edited}}),
        )
        .await;
    assert_eq!(updated["name"], "Renamed");
    let stored = iptv_core::stalker::session::load_config(&e.state, SID)
        .await
        .unwrap();
    assert_eq!(stored.mac_address, "MAG-0001");

    // A newly typed MAC is held to the 12-hex form, and normalized.
    let mut changed = serde_json::to_value(&legacy).unwrap();
    changed["macAddress"] = json!("MAG-0002");
    let err = e
        .call(
            "sources.update",
            json!({"id": SID, "patch": {"stalker": changed.clone()}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    changed["macAddress"] = json!("00-1a-79-00-00-01");
    e.ok(
        "sources.update",
        json!({"id": SID, "patch": {"stalker": changed}}),
    )
    .await;
    let stored = iptv_core::stalker::session::load_config(&e.state, SID)
        .await
        .unwrap();
    assert_eq!(stored.mac_address, MAC);
    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(summary["channels"], 35);

    // A lowercase stored MAC goes on the wire as stored (the mock compares
    // case-insensitively, so the sync works).
    set_source_config(
        &e.state,
        &config_for(e.mock.url("/stalker/c"), "00:1a:79:00:00:01"),
    )
    .await;
    let info = e.ok("stalker.accountInfo", json!({"sourceId": SID})).await;
    assert_eq!(info["mac"], "00:1a:79:00:00:01");

    // backup.import stores a legacy MAC verbatim.
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "exportedAt": "2026-10-01T12:00:00.000Z",
        "includeSecrets": true,
        "playlists": [{
            "portalType": "stalker",
            "exportedId": "legacy",
            "title": "Legacy portal",
            "connection": {
                "portalUrl": "http://legacy.invalid/stalker/portal.php",
                "macAddress": "mag-0001",
                "isFullStalkerPortal": true
            }
        }]
    })
    .to_string();
    e.ok("backup.import", json!({"json": manifest, "mode": "merge"}))
        .await;
    assert_eq!(
        count(
            &e.state,
            "SELECT count(*) FROM sources WHERE kind='stalker' AND json_extract(config_json, '$.macAddress') = 'mag-0001'",
        )
        .await,
        1
    );
}

// ---------------------------------------------------------------------------
// F6: totals that fail to load keep the stored counts
// ---------------------------------------------------------------------------

/// A pass-through proxy to the mock portal that can fail the first-page
/// `vod`/`series` listings (what the importer reads totals from).
async fn spawn_flaky_proxy(upstream: String, fail_totals: Arc<AtomicBool>) -> String {
    use axum::extract::{RawQuery, State};
    use axum::http::{HeaderMap, StatusCode, Uri};
    use axum::response::IntoResponse;

    #[derive(Clone)]
    struct Ctx {
        upstream: String,
        fail: Arc<AtomicBool>,
        http: reqwest::Client,
    }

    async fn forward(
        State(ctx): State<Ctx>,
        uri: Uri,
        RawQuery(q): RawQuery,
        headers: HeaderMap,
    ) -> axum::response::Response {
        let q = q.unwrap_or_default();
        let is_total = (q.contains("type=vod") || q.contains("type=series"))
            && q.contains("action=get_ordered_list")
            && q.contains("sortby=added")
            && !q.contains("movie_id");
        if is_total && ctx.fail.load(Ordering::SeqCst) {
            return (StatusCode::BAD_GATEWAY, "upstream down").into_response();
        }
        let url = format!("{}{}?{}", ctx.upstream, uri.path(), q);
        let mut req = ctx.http.get(url);
        for (k, v) in headers.iter() {
            if k != axum::http::header::HOST {
                req = req.header(k.as_str(), v.as_bytes());
            }
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let ct = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("application/json")
                    .to_string();
                let body = resp.bytes().await.unwrap_or_default();
                (
                    StatusCode::from_u16(status).unwrap(),
                    [(axum::http::header::CONTENT_TYPE, ct)],
                    body,
                )
                    .into_response()
            }
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        }
    }

    let ctx = Ctx {
        upstream,
        fail: fail_totals,
        http: reqwest::Client::new(),
    };
    let app = axum::Router::new().fallback(forward).with_state(ctx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn failed_portal_totals_keep_the_stored_counts() {
    let mock = iptv_fixtures::spawn_mock().await;
    let fail = Arc::new(AtomicBool::new(false));
    let proxy = spawn_flaky_proxy(mock.url(""), fail.clone()).await;
    let e = env_at(Some(format!("{proxy}/stalker/portal.php")), MAC).await;

    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(summary["movies"], 30);
    assert_eq!(summary["series"], 10);

    fail.store(true, Ordering::SeqCst);
    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(summary["channels"], 35);
    assert_eq!(summary["movies"], 30, "previous count kept: {summary}");
    assert_eq!(summary["series"], 10, "previous count kept: {summary}");
    let list = e.ok("sources.list", json!({})).await;
    assert_eq!(list[0]["movieCount"], 30, "{list}");
    assert_eq!(list[0]["seriesCount"], 10, "{list}");
}

// ---------------------------------------------------------------------------
// Round 2: silent portals, cached rows of another portal
// ---------------------------------------------------------------------------

/// A portal that accepts connections and never answers. Connections are
/// held open (not closed) until the test ends.
async fn spawn_silent_portal() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            held.push(sock);
        }
    });
    port
}

/// Caches a session for `SID` against `endpoint`, as a source synced before
/// its portal went silent would have.
async fn cache_session(state: &AppState, cfg: &StalkerSourceConfig, endpoint: &str) {
    let value = json!({
        "endpoint": endpoint,
        "token": "cached-token",
        "random": "0".repeat(40),
        "identity": iptv_core::stalker::session::identity_fingerprint(cfg),
    })
    .to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
                rusqlite::params![iptv_core::stalker::session::token_key(SID), value],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

/// R3 r2 F1: `stalker.epg` on a portal that never answers fails within its
/// overall deadline (20 s, 40 s with `from`) with the slow-portal message,
/// instead of falling back to `get_epg_info` / day tables for minutes and
/// returning `[]`.
#[tokio::test]
async fn silent_portal_epg_fails_within_the_deadline() {
    let port = spawn_silent_portal().await;
    let url = format!("http://127.0.0.1:{port}/stalker/c/");
    let e = env_at(Some(url.clone()), MAC).await;
    cache_session(
        &e.state,
        &config_for(url, MAC),
        &format!("http://127.0.0.1:{port}/stalker/portal.php"),
    )
    .await;
    let want = format!("The portal at 127.0.0.1:{port} did not answer in time. Try again later.");

    let t0 = std::time::Instant::now();
    let short = e.call("stalker.epg", json!({"ref": r("live", "1001"), "limit": 3}));
    let past = e.call(
        "stalker.epg",
        json!({"ref": r("live", "1002"), "limit": 3, "from": rfc(chrono::Utc::now() - chrono::Duration::hours(6))}),
    );
    let short = async {
        let res = short.await;
        (res, t0.elapsed())
    };
    let past = async {
        let res = past.await;
        (res, t0.elapsed())
    };
    let ((short, t_short), (past, t_past)) = tokio::join!(short, past);

    let err = short.expect_err("a silent portal is an error, not []");
    assert_eq!(err.code, RpcErrorCode::Timeout, "{}", err.message);
    assert!(err.retryable);
    assert_eq!(err.message, want);
    assert!(
        t_short >= std::time::Duration::from_secs(19)
            && t_short < std::time::Duration::from_secs(25),
        "short EPG gave up after {t_short:?}"
    );

    let err = past.expect_err("a silent portal is an error, not []");
    assert_eq!(err.code, RpcErrorCode::Timeout, "{}", err.message);
    assert_eq!(err.message, want);
    assert!(
        t_past < std::time::Duration::from_secs(45),
        "EPG with from gave up after {t_past:?}"
    );
}

/// R3 r2 F4: a host that takes the connection and stays silent is reported
/// as slow, not as unreachable.
#[tokio::test]
async fn silent_portal_test_says_it_did_not_answer() {
    let port = spawn_silent_portal().await;
    let url = format!("http://127.0.0.1:{port}/c/");
    let e = env_at(Some(url.clone()), MAC).await;
    let t0 = std::time::Instant::now();
    let res = e
        .ok("stalker.test", json!({"config": config_for(url, MAC)}))
        .await;
    assert_eq!(res["ok"], false);
    assert_eq!(
        res["message"],
        format!("The portal at 127.0.0.1:{port} did not answer in time. Try again later.").as_str(),
        "{res}"
    );
    assert!(t0.elapsed() < std::time::Duration::from_secs(25));
}

/// R3 r2 F6: rows listed from one portal are dropped (memory and
/// `stalker_items`) when the source's portal URL or MAC changes, kept on an
/// unrelated edit, and dropped from memory on removal.
#[tokio::test]
async fn portal_change_and_removal_drop_cached_rows() {
    let e = env().await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    let list_movies = || async {
        e.ok(
            "stalker.movies",
            json!({"sourceId": SID, "query": {"offset": 0, "limit": 14}}),
        )
        .await;
    };
    let rows = || {
        count(
            &e.state,
            "SELECT count(*) FROM stalker_items WHERE source_id='stk1'",
        )
    };
    let rt = iptv_core::stalker::Runtime::get(&e.state);
    let key = format!("{SID}|movie|5003");
    list_movies().await;
    assert!(rows().await > 0);
    assert!(rt.items.contains_key(&key));

    // A rename keeps them.
    e.ok(
        "sources.update",
        json!({"id": SID, "patch": {"name": "Renamed"}}),
    )
    .await;
    assert!(rows().await > 0);
    assert!(rt.items.contains_key(&key));

    // Another portal URL drops them.
    e.ok(
        "sources.update",
        json!({"id": SID, "patch": {"stalker": config_for(e.mock.url("/stalker/portal.php"), MAC)}}),
    )
    .await;
    assert_eq!(rows().await, 0);
    assert!(!rt.items.contains_key(&key));

    // Another MAC drops them too.
    list_movies().await;
    assert!(rows().await > 0);
    e.ok(
        "sources.update",
        json!({"id": SID, "patch": {"stalker": config_for(e.mock.url("/stalker/portal.php"), "00:1A:79:00:00:02")}}),
    )
    .await;
    assert_eq!(rows().await, 0);
    assert!(!rt.items.contains_key(&key));

    // Removal drops what memory remembered.
    e.ok(
        "sources.update",
        json!({"id": SID, "patch": {"stalker": config_for(e.mock.url("/stalker/portal.php"), MAC)}}),
    )
    .await;
    list_movies().await;
    assert!(rt.items.contains_key(&key));
    e.ok("sources.remove", json!({"id": SID})).await;
    assert!(!rt.items.contains_key(&key));
}
