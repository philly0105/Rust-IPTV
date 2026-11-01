//! The channel list of a Stalker import is kept as the portal's JSON text
//! until the catalog is written. An unchanged answer is recognised from the
//! list's own text (a debug line that changes on every answer does not
//! count), every shape of the list and every value type a portal sends map
//! to the same rows, and a refused or broken list answer is handled as
//! before: one fresh login, or the paged fallback. The radio walk, the
//! category lists and the totals keep at most a few requests out to the
//! portal, and the import says it waits for the movie and series side only
//! when it does.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::events::BroadcastSink;
use iptv_core::model::StalkerSourceConfig;
use iptv_core::rpc::RpcRouter;
use iptv_core::stalker::sync::PORTAL_REQUESTS;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk-lists";

#[derive(Default)]
struct Portal {
    /// The `js` value of `get_all_channels`, as JSON text.
    channels: Mutex<String>,
    /// Answer to `get_all_channels` while the request carries the cached
    /// token (a session the portal no longer accepts).
    refusal: Mutex<Option<String>>,
    calls: Mutex<HashMap<String, u64>>,
    seq: AtomicU64,
    /// Pages of 14 stations the radio list has (one station when 0).
    radio_pages: AtomicU64,
    /// How long each `type.action` takes to answer.
    delays: Mutex<HashMap<String, Duration>>,
    /// Requests being answered now, and the most at once.
    in_flight: AtomicU64,
    most_in_flight: AtomicU64,
}

impl Portal {
    fn count(&self, key: &str) -> u64 {
        self.calls.lock().unwrap().get(key).copied().unwrap_or(0)
    }

    fn delay(&self, key: &str, by: Duration) {
        self.delays.lock().unwrap().insert(key.to_string(), by);
    }
}

/// One request being answered, counted in `in_flight` until it is dropped.
struct Answering<'a>(&'a Portal);

impl<'a> Answering<'a> {
    fn new(p: &'a Portal) -> Self {
        let now = p.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        p.most_in_flight.fetch_max(now, Ordering::SeqCst);
        Self(p)
    }
}

impl Drop for Answering<'_> {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

fn text(body: String) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

async fn portal_php(
    State(p): State<Arc<Portal>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let key = format!("{}.{}", get("type"), get("action"));
    let _answering = Answering::new(&p);
    let delay = p.delays.lock().unwrap().get(&key).copied();
    if let Some(delay) = delay {
        tokio::time::sleep(delay).await;
    }
    answer(&p, &headers, &q, key)
}

fn answer(p: &Portal, headers: &HeaderMap, q: &HashMap<String, String>, key: String) -> Response {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    *p.calls.lock().unwrap().entry(key.clone()).or_default() += 1;
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let js = match key.as_str() {
        "stb.handshake" => json!({"token": "fresh-token", "random": "0".repeat(40)}),
        "stb.get_profile" => json!({"id": "1", "status": 0}),
        "itv.get_genres" => json!([{"id": "1", "title": "News"}, {"id": "2", "title": "Sport"}]),
        "itv.get_all_channels" => {
            if bearer == "Bearer cached-token" {
                if let Some(body) = p.refusal.lock().unwrap().clone() {
                    return text(body);
                }
            }
            // Real portals add a debug line that changes on every answer.
            let n = p.seq.fetch_add(1, Ordering::SeqCst);
            let list = p.channels.lock().unwrap().clone();
            return text(format!(
                r#"{{"js":{list},"text":"generated in: 0.00{n}s; query counter: {n}"}}"#
            ));
        }
        "radio.get_ordered_list" => match p.radio_pages.load(Ordering::SeqCst) {
            0 => json!({"total_items": 1, "max_page_items": 14, "data": [
                {"id": "r1", "name": "Radio One", "cmd": "http://radio.example/1"}
            ]}),
            pages => {
                let page: u64 = get("p").parse().unwrap_or(1);
                let data: Vec<Value> = (0..14)
                    .map(|i| {
                        let id = (page - 1) * 14 + i;
                        json!({"id": format!("r{id}"), "name": format!("Radio {id}"), "cmd": format!("http://radio.example/{id}")})
                    })
                    .collect();
                json!({"total_items": pages * 14, "max_page_items": 14, "data": data})
            }
        },
        "vod.get_categories" | "series.get_categories" => {
            json!([{"id": "*", "title": "All"}, {"id": "5", "title": "Films"}])
        }
        "vod.get_ordered_list" | "series.get_ordered_list" => {
            json!({"total_items": 42, "max_page_items": 14, "data": []})
        }
        // The paged fallback: two channels.
        "itv.get_ordered_list" => json!({"total_items": 2, "max_page_items": 14, "data": [
            {"id": "p1", "name": "Paged One", "cmd": "http://paged.example/1"},
            {"id": "p2", "name": "Paged Two", "cmd": "http://paged.example/2"}
        ]}),
        _ => json!([]),
    };
    text(json!({ "js": js }).to_string())
}

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    portal: Arc<Portal>,
    events: tokio::sync::broadcast::Receiver<iptv_core::AppEvent>,
}

impl Env {
    async fn ok(&self, cmd: &str, args: Value) -> Value {
        match self.router.dispatch(self.state.clone(), cmd, args).await {
            Ok(v) => v,
            Err(e) => panic!("{cmd} failed: {:?} {}", e.code, e.message),
        }
    }

    async fn sync(&self) -> Value {
        self.ok("stalker.sync", json!({"sourceId": SID})).await
    }

    /// Every live row as the catalog stores it, in position order.
    async fn live_rows(&self) -> Vec<Value> {
        self.state
            .db_call(|c| {
                let mut stmt = c.prepare(
                    "SELECT item_id, title, category_id, number, logo_url, epg_channel_id,
                            archive_hours, extra_json, position
                       FROM items WHERE source_id = ?1 AND content_type = 'live'
                      ORDER BY position",
                )?;
                let rows = stmt.query_map([SID], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "title": r.get::<_, String>(1)?,
                        "category": r.get::<_, String>(2)?,
                        "number": r.get::<_, Option<i64>>(3)?,
                        // Without the portal's origin, which differs per test portal.
                        "logo": r.get::<_, Option<String>>(4)?
                            .map(|l| url::Url::parse(&l).unwrap().path().to_string()),
                        "epg": r.get::<_, Option<String>>(5)?,
                        "archive": r.get::<_, Option<i64>>(6)?,
                        "extra": serde_json::from_str::<Value>(&r.get::<_, String>(7)?).unwrap(),
                        "position": r.get::<_, i64>(8)?,
                    }))
                })?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .await
            .unwrap()
    }
}

async fn env(channels: &str) -> Env {
    let portal = Arc::new(Portal::default());
    *portal.channels.lock().unwrap() = channels.to_string();
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
    let (sink, events) = BroadcastSink::channel(4096);
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
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'stalker', 'Lists portal', ?2)",
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
        events,
    }
}

/// Channels with every value type a portal sends, as JSON text (so a
/// duplicated key can be written). Ids in the order a keyed `data` sorts.
const CHANNELS: [(&str, &str); 8] = [
    (
        "k1",
        r#"{"id": 101, "name": " News One ", "number": "7", "cmd": "ffrt http://tv.example/101", "tv_genre_id": 1, "xmltv_id": "news.one", "logo": "/logos/101.png", "tv_archive": "1", "tv_archive_duration": "48", "use_http_tmp_link": "0", "use_load_balancing": null, "censored": 0, "cmds": [{"id": "1"}], "status": 1}"#,
    ),
    (
        "k2",
        r#"{"id": "102", "number": 0, "cmd": "http://tv.example/102.m3u8", "tv_genre_id": "99", "enable_tv_archive": true, "tv_archive_duration": "0", "use_http_tmp_link": true, "censored": "1", "logo": 5}"#,
    ),
    (
        "k3",
        r#"{"id": "103", "name": "First", "name": "Second", "cmd": "http://tv.example/103", "tv_genre_id": "2", "number": 3.0}"#,
    ),
    ("k4", r#"{"id": "101", "name": "Duplicate id"}"#),
    (
        "k5",
        r#"{"id": "105", "name": "Odd flags", "tv_archive": [], "censored": {}, "use_load_balancing": "false", "number": "12abc", "xmltv_id": 77}"#,
    ),
    ("k6", r#""not a channel""#),
    ("k7", r#"null"#),
    (
        "k8",
        r#"{"id": "108", "name": "Last", "cmd": "http://tv.example/108", "tv_genre_id": " 2 ", "enable_tv_archive": "0", "tv_archive": 0, "number": "-4"}"#,
    ),
];

fn as_array() -> String {
    let items: Vec<&str> = CHANNELS.iter().map(|(_, v)| *v).collect();
    format!("[{}]", items.join(","))
}

fn as_data_array() -> String {
    format!(
        r#"{{"total_items": 8, "max_page_items": 8, "data": {}}}"#,
        as_array()
    )
}

fn as_keyed_data() -> String {
    let items: Vec<String> = CHANNELS
        .iter()
        .map(|(k, v)| format!(r#""{k}": {v}"#))
        .collect();
    format!(r#"{{"total_items": 8, "data": {{{}}}}}"#, items.join(","))
}

#[tokio::test]
async fn every_list_shape_maps_the_same_rows() {
    let mut seen: Vec<Vec<Value>> = Vec::new();
    for shape in [as_array(), as_data_array(), as_keyed_data()] {
        let e = env(&shape).await;
        let summary = e.sync().await;
        // Five channels (one duplicate id, two non-objects) and the radio.
        assert_eq!(summary["channels"], 6, "{summary}");
        seen.push(e.live_rows().await);
    }
    assert_eq!(seen[0], seen[1], "js array and data array");
    assert_eq!(seen[0], seen[2], "data array and data keyed by id");

    let rows = &seen[0];
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["101", "102", "103", "105", "108"]);
    let by_id = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap().clone();

    let one = by_id("101");
    assert_eq!(one["title"], "News One");
    assert_eq!(one["number"], 7);
    assert_eq!(one["category"], "1");
    assert_eq!(one["epg"], "news.one");
    assert_eq!(one["archive"], 48);
    assert!(
        one["logo"].as_str().unwrap().ends_with("/logos/101.png"),
        "{one}"
    );
    assert_eq!(
        one["extra"],
        json!({"cmd": "ffrt http://tv.example/101", "useHttpTmpLink": false})
    );

    let two = by_id("102");
    assert_eq!(two["title"], "Channel 102");
    assert_eq!(two["number"], Value::Null);
    assert_eq!(two["category"], "uncategorized");
    assert_eq!(two["logo"], Value::Null);
    assert_eq!(two["archive"], 24);
    assert_eq!(
        two["extra"],
        json!({"cmd": "http://tv.example/102.m3u8", "useHttpTmpLink": true, "censored": true})
    );

    // A duplicated key reads its last value, as a parsed answer does.
    let three = by_id("103");
    assert_eq!(three["title"], "Second");
    assert_eq!(three["number"], 3);
    assert_eq!(three["category"], "2");

    let five = by_id("105");
    assert_eq!(five["archive"], 24, "an array flag is on");
    assert_eq!(five["number"], Value::Null);
    assert_eq!(five["epg"], "77");
    assert_eq!(
        five["extra"],
        json!({"useLoadBalancing": false, "censored": true})
    );

    let eight = by_id("108");
    assert_eq!(eight["archive"], Value::Null);
    assert_eq!(eight["number"], Value::Null);
    assert_eq!(eight["category"], "2");
}

#[tokio::test]
async fn an_unchanged_list_is_recognised_from_its_text() {
    let e = env(&as_data_array()).await;
    let first = e.sync().await;
    assert!(first.get("unchanged").is_none(), "{first}");
    assert_eq!(first["movies"], 42);

    // The envelope's debug line changed; the list did not.
    let again = e.sync().await;
    assert_eq!(again["unchanged"], true, "{again}");
    assert_eq!(again["channels"], 6);
    assert_eq!(again["movies"], 42);
    assert_eq!(again["series"], 42);
    assert_eq!(e.portal.count("itv.get_all_channels"), 2);
    assert_eq!(e.portal.count("vod.get_ordered_list"), 2, "totals asked");

    // One channel renamed: written again.
    let renamed = as_data_array().replace("Odd flags", "Renamed");
    *e.portal.channels.lock().unwrap() = renamed;
    let changed = e.sync().await;
    assert!(changed.get("unchanged").is_none(), "{changed}");
    let rows = e.live_rows().await;
    assert!(rows.iter().any(|r| r["title"] == "Renamed"), "{rows:?}");
}

#[tokio::test]
async fn a_refused_list_logs_in_again_once() {
    for refusal in [
        r#"{"js":{"error":"Invalid token"}}"#,
        "Authorization failed.",
    ] {
        let e = env(&as_array()).await;
        *e.portal.refusal.lock().unwrap() = Some(refusal.to_string());
        let summary = e.sync().await;
        assert_eq!(summary["channels"], 6, "{refusal}: {summary}");
        assert_eq!(e.portal.count("stb.handshake"), 1, "{refusal}");
        assert_eq!(e.portal.count("itv.get_all_channels"), 2, "{refusal}");
        assert_eq!(e.portal.count("itv.get_ordered_list"), 0, "{refusal}");
    }
}

#[tokio::test]
async fn a_broken_list_answer_falls_back_to_paging() {
    // Cut short, an empty list, and a list under an unexpected member.
    for js in [r#"[{"id": "1""#, "[]", r#"{"items": [{"id": "1"}]}"#] {
        let e = env(js).await;
        let summary = e.sync().await;
        assert_eq!(summary["channels"], 3, "{js}: {summary}");
        let rows = e.live_rows().await;
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["p1", "p2"], "{js}");
        assert!(e.portal.count("itv.get_ordered_list") >= 1, "{js}");
    }
}

/// The progress messages the import sent so far.
fn messages(e: &mut Env) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(event) = e.events.try_recv() {
        if event.kind == "import.progress" {
            if let Some(m) = event.payload["message"].as_str() {
                out.push(m.to_string());
            }
        }
    }
    out
}

#[tokio::test]
async fn the_radio_walk_categories_and_totals_keep_a_few_requests_out() {
    let e = env(&as_array()).await;
    // Radio's first page answers first, while both category lists and both
    // totals are still out: the walk's next pages must wait for turns.
    e.portal.radio_pages.store(6, Ordering::SeqCst);
    e.portal
        .delay("radio.get_ordered_list", Duration::from_millis(40));
    for key in [
        "vod.get_categories",
        "series.get_categories",
        "vod.get_ordered_list",
        "series.get_ordered_list",
    ] {
        e.portal.delay(key, Duration::from_millis(250));
    }
    let summary = e.sync().await;
    assert_eq!(summary["channels"], 5 + 6 * 14, "{summary}");
    assert_eq!(e.portal.count("radio.get_ordered_list"), 6);
    let most = e.portal.most_in_flight.load(Ordering::SeqCst);
    assert!(
        most as usize <= PORTAL_REQUESTS,
        "{most} requests were out to the portal at once"
    );
}

#[tokio::test]
async fn the_wait_for_movie_and_series_categories_is_named_only_while_it_lasts() {
    const VOD_GROUPS: &str = "Loading movie and series categories";
    // The radio walk ends last: the categories were in long before.
    let mut e = env(&as_array()).await;
    e.portal.radio_pages.store(3, Ordering::SeqCst);
    e.portal
        .delay("radio.get_ordered_list", Duration::from_millis(150));
    e.sync().await;
    let seen = messages(&mut e);
    assert!(seen.iter().any(|m| m == "Loading radio"), "{seen:?}");
    assert!(!seen.iter().any(|m| m == VOD_GROUPS), "{seen:?}");

    // The radio walk ends first: the import then waits for the categories.
    let mut e = env(&as_array()).await;
    e.portal
        .delay("vod.get_categories", Duration::from_millis(300));
    e.sync().await;
    let seen = messages(&mut e);
    let radio = seen.iter().position(|m| m == "Loading radio");
    let groups = seen.iter().position(|m| m == VOD_GROUPS);
    assert!(radio.is_some() && groups > radio, "{seen:?}");
}
