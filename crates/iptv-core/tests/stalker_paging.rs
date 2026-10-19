//! IN-4: Stalker list walks. The pages after the first go out a few at a
//! time instead of one after another, the channel fallback follows the
//! portal's total instead of stopping at 400 pages (5,600 channels), and a
//! VOD grid page with a known page size sends its portal pages in one wave.
//! ST-3: a refresh whose answers did not change keeps the catalog.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use iptv_core::events::BroadcastSink;
use iptv_core::model::StalkerSourceConfig;
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk1";
/// Channels served by the paged fallback: past the old 5,600 cap.
const CHANNELS: usize = 6_000;
/// Radio stations: 22 pages of 14.
const STATIONS: usize = 300;
/// Movies: 3 pages of 14 cover a 42-row grid page.
const MOVIES: usize = 100;
const PAGE: usize = 14;

/// A portal without `get_all_channels` that counts calls per `type.action`
/// and the most list pages in flight at once.
#[derive(Default)]
struct Portal {
    /// Channels served by the paged fallback.
    channels: AtomicUsize,
    calls: Mutex<HashMap<String, u64>>,
    inflight: AtomicUsize,
    max_inflight: AtomicUsize,
}

impl Portal {
    fn count(&self, key: &str) -> u64 {
        self.calls.lock().unwrap().get(key).copied().unwrap_or(0)
    }
}

fn page_of(total: usize, page: usize, row: impl Fn(usize) -> Value) -> Value {
    let data: Vec<Value> = ((page - 1) * PAGE..(page * PAGE).min(total))
        .map(row)
        .collect();
    json!({"total_items": total, "max_page_items": PAGE, "data": data})
}

fn channel(i: usize) -> Value {
    let cmd = format!("ffrt http://x/{i}");
    json!({"id": i.to_string(), "name": format!("Channel {i}"), "cmd": cmd})
}

fn station(i: usize) -> Value {
    json!({"id": i.to_string(), "name": format!("Station {i}"), "cmd": format!("http://x/r{i}")})
}

fn movie(i: usize) -> Value {
    json!({"id": i.to_string(), "name": format!("Movie {i}"), "cmd": format!("/m/{i}.mp4")})
}

async fn portal_php(
    State(p): State<Arc<Portal>>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let key = format!("{}.{}", get("type"), get("action"));
    *p.calls.lock().unwrap().entry(key.clone()).or_default() += 1;
    let page = get("p").parse::<usize>().unwrap_or(1).max(1);
    let listed = key.ends_with(".get_ordered_list");
    if listed {
        let now = p.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        p.max_inflight.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    let js = match key.as_str() {
        "itv.get_ordered_list" => page_of(p.channels.load(Ordering::SeqCst), page, channel),
        "radio.get_ordered_list" => page_of(STATIONS, page, station),
        "vod.get_ordered_list" => page_of(MOVIES, page, movie),
        "series.get_ordered_list" => json!({"total_items": 0, "max_page_items": PAGE, "data": []}),
        // Disabled on this portal: the import pages through the list.
        _ => json!([]),
    };
    if listed {
        p.inflight.fetch_sub(1, Ordering::SeqCst);
    }
    Json(json!({ "js": js }))
}

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    portal: Arc<Portal>,
}

impl Env {
    async fn ok(&self, cmd: &str, args: Value) -> Value {
        match self.router.dispatch(self.state.clone(), cmd, args).await {
            Ok(v) => v,
            Err(e) => panic!("{cmd} failed: {:?} {}", e.code, e.message),
        }
    }

    async fn count_rows(&self, content_type: &'static str) -> i64 {
        self.state
            .db_call(move |c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = ?2",
                    rusqlite::params![SID, content_type],
                    |r| r.get::<_, i64>(0),
                )?)
            })
            .await
            .unwrap()
    }
}

/// A source on a fresh portal serving `channels` channels, with its session
/// cached (no handshake).
async fn env(channels: usize) -> Env {
    let portal = Arc::new(Portal::default());
    portal.channels.store(channels, Ordering::SeqCst);
    let app = Router::new()
        .route("/stalker/portal.php", get(portal_php))
        .with_state(portal.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

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
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'stalker', 'Paged portal', ?2)",
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
        portal,
    }
}

#[tokio::test]
async fn sync_walks_every_page_a_few_at_a_time() {
    let e = env(CHANNELS).await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;

    // Every channel, past the old 400-page cap, in the portal's order.
    assert_eq!(e.count_rows("live").await, CHANNELS as i64);
    assert_eq!(e.count_rows("radio").await, STATIONS as i64);
    assert_eq!(
        e.portal.count("itv.get_ordered_list"),
        CHANNELS.div_ceil(PAGE) as u64
    );
    assert_eq!(
        e.portal.count("radio.get_ordered_list"),
        STATIONS.div_ceil(PAGE) as u64
    );
    assert!(
        e.portal.max_inflight.load(Ordering::SeqCst) > 1,
        "pages were fetched one after another"
    );
}

#[tokio::test]
async fn a_known_page_size_sends_a_grid_page_in_one_wave() {
    let e = env(CHANNELS).await;
    let args = json!({"sourceId": SID, "query": {"offset": 0, "limit": 42}});
    let first = e.ok("stalker.movies", args.clone()).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 42);
    assert_eq!(first["total"], MOVIES);
    assert_eq!(e.portal.count("vod.get_ordered_list"), 3);

    // The portal confirmed 14 rows a page: the next grid page asks for its
    // three portal pages at once, and asks for each only once.
    e.portal.max_inflight.store(0, Ordering::SeqCst);
    let again = e.ok("stalker.movies", args).await;
    assert_eq!(again["items"], first["items"]);
    assert_eq!(e.portal.count("vod.get_ordered_list"), 6);
    assert_eq!(e.portal.max_inflight.load(Ordering::SeqCst), 3);

    // The last grid page stops at the total.
    let last = e
        .ok(
            "stalker.movies",
            json!({"sourceId": SID, "query": {"offset": 84, "limit": 42}}),
        )
        .await;
    assert_eq!(last["items"].as_array().unwrap().len(), MOVIES - 84);
}

/// ST-3: Stalker refreshes always rewrote live and radio. Unchanged answers
/// now keep the catalog and report `unchanged`; changed answers, or rows
/// that went missing, write it again.
#[tokio::test]
async fn unchanged_answers_keep_the_catalog() {
    let e = env(50).await;
    let first = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(first["channels"], 50 + STATIONS);
    assert!(first.get("unchanged").is_none(), "{first}");

    let again = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(again["unchanged"], true, "{again}");
    assert_eq!(again["channels"], 50 + STATIONS);
    assert_eq!(e.count_rows("live").await, 50);

    // A new channel on the portal: written again.
    e.portal.channels.store(51, Ordering::SeqCst);
    let changed = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert!(changed.get("unchanged").is_none(), "{changed}");
    assert_eq!(e.count_rows("live").await, 51);

    // Rows missing from the catalog: written again, though the portal's
    // answers are the stored ones.
    e.state
        .db_call(|c| {
            c.execute(
                "DELETE FROM items WHERE source_id = ?1 AND content_type = 'radio'",
                [SID],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let repaired = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert!(repaired.get("unchanged").is_none(), "{repaired}");
    assert_eq!(e.count_rows("radio").await, STATIONS as i64);
}
