//! IN-4: Stalker list walks. The pages after the first go out a few at a
//! time instead of one after another, the channel fallback follows the
//! portal's total instead of stopping at 400 pages (5,600 channels), and a
//! VOD grid page with a known page size sends its portal pages in one wave.
//! ST-3: a refresh whose answers did not change keeps the catalog. A page
//! past the real end of a list never fails it.

use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse, Response};
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
    /// `total_items` the channel list reports instead (0: the real count).
    reported_channels: AtomicUsize,
    /// Per list `type`, the first page that answers with an error page.
    fail_from: Mutex<HashMap<String, usize>>,
    calls: Mutex<HashMap<String, u64>>,
    inflight: AtomicUsize,
    max_inflight: AtomicUsize,
    /// Extra delay of every request, in ms, and the most requests of any
    /// kind in flight at once.
    each_ms: AtomicUsize,
    all_inflight: AtomicUsize,
    max_all_inflight: AtomicUsize,
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
) -> Response {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let key = format!("{}.{}", get("type"), get("action"));
    *p.calls.lock().unwrap().entry(key.clone()).or_default() += 1;
    let all = p.all_inflight.fetch_add(1, Ordering::SeqCst) + 1;
    p.max_all_inflight.fetch_max(all, Ordering::SeqCst);
    let each = p.each_ms.load(Ordering::SeqCst) as u64;
    if each > 0 {
        tokio::time::sleep(Duration::from_millis(each)).await;
    }
    p.all_inflight.fetch_sub(1, Ordering::SeqCst);
    let page = get("p").parse::<usize>().unwrap_or(1).max(1);
    let listed = key.ends_with(".get_ordered_list");
    let failing = p.fail_from.lock().unwrap().get(&get("type")).copied();
    if listed && failing.is_some_and(|from| page >= from) {
        return Html("<html>Broken</html>").into_response();
    }
    if listed {
        let now = p.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        p.max_inflight.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    let js = match key.as_str() {
        "itv.get_ordered_list" => {
            let mut js = page_of(p.channels.load(Ordering::SeqCst), page, channel);
            let reported = p.reported_channels.load(Ordering::SeqCst);
            if reported > 0 {
                js["total_items"] = json!(reported);
            }
            js
        }
        "radio.get_ordered_list" => page_of(STATIONS, page, station),
        "vod.get_ordered_list" => page_of(MOVIES, page, movie),
        "series.get_ordered_list" => json!({"total_items": 0, "max_page_items": PAGE, "data": []}),
        // Disabled on this portal: the import pages through the list.
        _ => json!([]),
    };
    if listed {
        p.inflight.fetch_sub(1, Ordering::SeqCst);
    }
    Json(json!({ "js": js })).into_response()
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

/// R5-3: the sync asked genres, channels, radio, both category lists and
/// both totals one after another, 5-6 round trips that need nothing from
/// each other. They now go out together after the session.
#[tokio::test]
async fn sync_asks_its_sections_together() {
    let e = env(30).await;
    e.portal.each_ms.store(300, Ordering::SeqCst);
    let t0 = std::time::Instant::now();
    let summary = e.ok("stalker.sync", json!({"sourceId": SID})).await;
    let took = t0.elapsed();
    assert_eq!(summary["channels"], 30 + STATIONS);
    assert_eq!(summary["movies"], MOVIES);
    // get_genres, get_all_channels, radio page 1, vod and series
    // get_categories, vod and series page 1 for the totals.
    let together = e.portal.max_all_inflight.load(Ordering::SeqCst);
    assert!(together >= 7, "{together} requests in flight at most");
    // One after another: genres, all channels, 1 + 1 channel waves, 1 + 6
    // radio waves, two category lists and one totals wave are 14 waves of
    // 300 ms (4.2 s). Together, the radio walk's 7 waves set the pace.
    assert!(took < Duration::from_millis(3_500), "sync took {took:?}");
}

/// R5-6: the sync's movie total reads page 1 of the VOD list, whose
/// `max_page_items` now seeds the page size, and the sync no longer drops
/// it: the first grid page after a sync goes out in one wave.
#[tokio::test]
async fn a_sync_seeds_the_page_size_for_the_first_grid_page() {
    let e = env(30).await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    // The totals: page 1 of the VOD list once.
    assert_eq!(e.portal.count("vod.get_ordered_list"), 1);
    e.portal.max_inflight.store(0, Ordering::SeqCst);
    let args = json!({"sourceId": SID, "query": {"offset": 0, "limit": 42}});
    let first = e.ok("stalker.movies", args).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 42);
    assert_eq!(e.portal.count("vod.get_ordered_list"), 1 + 3);
    assert_eq!(e.portal.max_inflight.load(Ordering::SeqCst), 3, "one wave");

    // A second sync keeps it.
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    e.portal.max_inflight.store(0, Ordering::SeqCst);
    let args = json!({"sourceId": SID, "query": {"offset": 42, "limit": 42}});
    let next = e.ok("stalker.movies", args).await;
    assert_eq!(next["items"].as_array().unwrap().len(), 42);
    assert_eq!(e.portal.max_inflight.load(Ordering::SeqCst), 3, "one wave");
}

/// GPT review (stalker-pages-beyond-total): with a known page size a grid
/// page asks for all its portal pages at once, before the total is known,
/// and a page past the real end that failed failed the whole grid page.
#[tokio::test]
async fn a_failing_page_past_the_total_does_not_fail_a_grid_page() {
    let e = env(CHANNELS).await;
    e.portal.fail_from.lock().unwrap().insert("vod".into(), 9);
    // The first call learns the page size; the second sends pages 7 to 9
    // in one wave, and page 9 is past the 100 movies.
    let args = json!({"sourceId": SID, "query": {"offset": 84, "limit": 42}});
    for _ in 0..2 {
        let last = e.ok("stalker.movies", args.clone()).await;
        assert_eq!(last["items"].as_array().unwrap().len(), MOVIES - 84);
        assert_eq!(last["total"], MOVIES);
    }
    assert_eq!(e.portal.count("vod.get_ordered_list"), 5);
}

/// GPT review (stalker-empty-page-termination): a list whose total is far
/// too high asked for every page it reported before looking for an empty
/// one, and a failure past the real end failed the import. The walk now
/// stops at the first empty page.
#[tokio::test]
async fn a_stale_total_stops_at_the_first_empty_page() {
    let e = env(30).await;
    let stale = 100 * PAGE;
    e.portal.reported_channels.store(stale, Ordering::SeqCst);
    e.portal.fail_from.lock().unwrap().insert("itv".into(), 5);
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    assert_eq!(e.count_rows("live").await, 30);
    let calls = e.portal.count("itv.get_ordered_list");
    assert!(calls < 20, "{calls} channel pages asked for 3 real ones");
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
