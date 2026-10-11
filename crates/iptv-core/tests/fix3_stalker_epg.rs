//! Fix wave 3 (review round 3, R3 F1/F2): `stalker.epg` on portals that
//! answer slowly. An empty short EPG uses one cached bulk guide per source
//! and never turns into a timeout; a slow archive read keeps the short EPG
//! and the day tables read before the deadline.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use iptv_core::events::BroadcastSink;
use iptv_core::model::StalkerSourceConfig;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, RpcError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk1";

/// A tiny portal: counts calls per `type.action` and answers after the
/// configured delays.
#[derive(Default)]
struct Portal {
    calls: Mutex<HashMap<String, u64>>,
    /// Delay of every request, in ms.
    each_ms: AtomicU64,
    /// Extra delay of `get_epg_info`, in ms.
    bulk_ms: AtomicU64,
    /// `get_short_epg` answers `[]`.
    short_empty: bool,
}

impl Portal {
    fn count(&self, key: &str) -> u64 {
        self.calls.lock().unwrap().get(key).copied().unwrap_or(0)
    }
}

fn programme(name: &str, start: i64, stop: i64) -> Value {
    json!({"name": name, "start_timestamp": start, "stop_timestamp": stop})
}

async fn portal_php(
    State(p): State<Arc<Portal>>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let key = format!("{}.{}", get("type"), get("action"));
    *p.calls.lock().unwrap().entry(key.clone()).or_default() += 1;
    tokio::time::sleep(Duration::from_millis(p.each_ms.load(Ordering::SeqCst))).await;
    let now = chrono::Utc::now().timestamp();
    let js = match key.as_str() {
        "itv.get_short_epg" if p.short_empty => json!([]),
        "itv.get_short_epg" => {
            let ch = get("ch_id");
            json!([programme(&format!("Now on {ch}"), now - 600, now + 3000)])
        }
        "itv.get_epg_info" => {
            tokio::time::sleep(Duration::from_millis(p.bulk_ms.load(Ordering::SeqCst))).await;
            json!({"data": {
                "1004": [programme("Bulk 1004", now - 600, now + 3000)],
                "1005": [programme("Bulk 1005", now - 600, now + 3000)],
            }})
        }
        // Five one-programme pages per day, from 08:00 UTC.
        "epg.get_simple_data_table" => {
            let date = chrono::NaiveDate::parse_from_str(&get("date"), "%Y-%m-%d").unwrap();
            let page: i64 = get("p").parse().unwrap_or(1);
            let start =
                date.and_hms_opt(8, 0, 0).unwrap().and_utc().timestamp() + (page - 1) * 3600;
            json!({"total_items": 5, "max_page_items": 1, "data": [
                programme(&format!("Archive {date} #{page}"), start, start + 3600)
            ]})
        }
        _ => json!([]),
    };
    Json(json!({ "js": js }))
}

async fn spawn_portal(port: u16, portal: Arc<Portal>) {
    let app = Router::new()
        .route("/stalker/portal.php", get(portal_php))
        .with_state(portal);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
}

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
}

impl Env {
    async fn call(&self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        self.router.dispatch(self.state.clone(), cmd, args).await
    }
}

/// A source synced against the portal on `port`, with its session cached
/// (no handshake needed).
async fn env_on(port: u16) -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(4096);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    let cfg: StalkerSourceConfig = serde_json::from_value(json!({
        "portalUrl": format!("http://127.0.0.1:{port}/stalker/c/"),
        "macAddress": MAC,
        "isFullPortal": true,
    }))
    .unwrap();
    let session = json!({
        "endpoint": format!("http://127.0.0.1:{port}/stalker/portal.php"),
        "token": "cached-token",
        "random": "0".repeat(40),
        "identity": iptv_core::stalker::session::identity_fingerprint(&cfg),
    })
    .to_string();
    let cfg = serde_json::to_string(&cfg).unwrap();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'stalker', 'Slow portal', ?2)",
                rusqlite::params![SID, cfg],
            )?;
            c.execute(
                "INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
                rusqlite::params![iptv_core::stalker::session::token_key(SID), session],
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
    }
}

fn live(id: &str) -> Value {
    json!({"sourceId": SID, "contentType": "live", "itemId": id})
}

fn titles(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap().to_string())
        .collect()
}

/// R3 F1: rows whose short EPG answers `[]` share one bulk `get_epg_info`
/// per source. A slow bulk guide gives those rows no programmes (never a
/// timeout), keeps loading in the background, and later rows read it from
/// the cache until `forget_source` drops it.
#[tokio::test]
async fn empty_short_epg_shares_one_cached_bulk_guide() {
    let portal = Arc::new(Portal {
        short_empty: true,
        ..Default::default()
    });
    portal.bulk_ms.store(14_000, Ordering::SeqCst);
    spawn_portal(7205, portal.clone()).await;
    let e = env_on(7205).await;

    let t0 = Instant::now();
    let (a, b) = tokio::join!(
        e.call("stalker.epg", json!({"ref": live("1004"), "limit": 3})),
        e.call("stalker.epg", json!({"ref": live("1005"), "limit": 3})),
    );
    let waited = t0.elapsed();
    let a = a.unwrap_or_else(|err| panic!("an empty short EPG is not an error: {err:?}"));
    let b = b.unwrap_or_else(|err| panic!("an empty short EPG is not an error: {err:?}"));
    assert_eq!(a, json!([]));
    assert_eq!(b, json!([]));
    assert!(waited < Duration::from_secs(13), "rows waited {waited:?}");
    assert_eq!(portal.count("itv.get_short_epg"), 2);
    assert_eq!(
        portal.count("itv.get_epg_info"),
        1,
        "one bulk call per source"
    );

    // The bulk call kept going without its callers and filled the cache.
    tokio::time::sleep(Duration::from_secs(15).saturating_sub(t0.elapsed())).await;
    let t1 = Instant::now();
    let a = e
        .call("stalker.epg", json!({"ref": live("1004"), "limit": 3}))
        .await
        .unwrap();
    let b = e
        .call("stalker.epg", json!({"ref": live("1005"), "limit": 3}))
        .await
        .unwrap();
    assert_eq!(titles(&a), ["Bulk 1004"]);
    assert_eq!(titles(&b), ["Bulk 1005"]);
    assert!(
        t1.elapsed() < Duration::from_secs(2),
        "cached bulk took {:?}",
        t1.elapsed()
    );
    assert_eq!(portal.count("itv.get_epg_info"), 1, "served from the cache");

    // Forgetting the source drops the cached guide.
    portal.bulk_ms.store(0, Ordering::SeqCst);
    iptv_core::stalker::Runtime::get(&e.state).forget_source(SID);
    let a = e
        .call("stalker.epg", json!({"ref": live("1004"), "limit": 3}))
        .await
        .unwrap();
    assert_eq!(titles(&a), ["Bulk 1004"]);
    assert_eq!(portal.count("itv.get_epg_info"), 2);
}

/// R3 F2: on a portal that takes 3 s per request, a 7-day `from` cannot
/// read every day table within the 40 s budget. The call still succeeds
/// with the short EPG and the days read before the deadline.
#[tokio::test]
async fn slow_archive_keeps_short_epg_and_finished_days() {
    let portal = Arc::new(Portal::default());
    portal.each_ms.store(3_000, Ordering::SeqCst);
    spawn_portal(7206, portal.clone()).await;
    let e = env_on(7206).await;

    let from = (chrono::Utc::now() - chrono::Duration::days(7))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let t0 = Instant::now();
    let res = e
        .call(
            "stalker.epg",
            json!({"ref": live("1001"), "limit": 50, "from": from}),
        )
        .await;
    let took = t0.elapsed();
    let res = res.unwrap_or_else(|err| panic!("a slow archive is not an error: {err:?}"));
    let titles = titles(&res);
    assert!(
        titles.iter().any(|t| t == "Now on 1001"),
        "short EPG kept: {titles:?}"
    );
    let archived = titles.iter().filter(|t| t.starts_with("Archive ")).count();
    // Nine day tables of five sequential 3 s pages, three days at a time:
    // about 48 s in all, so the first six days (30 rows) finish in time and
    // the last three do not.
    assert!(archived >= 15, "days read before the deadline: {titles:?}");
    assert!(
        portal.count("epg.get_simple_data_table") < 45,
        "the deadline cut the archive read short"
    );
    assert!(
        took >= Duration::from_secs(39) && took < Duration::from_secs(44),
        "returned after {took:?}"
    );
}
