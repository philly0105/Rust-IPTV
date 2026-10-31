//! The portal guide behind `stalker.epg` and `stalker.catchupUrl`.
//!
//! - The bulk `get_epg_info` answer is kept mapped: every time shape a
//!   portal sends gives the same programmes, under the row's own channel id
//!   and guide shift.
//! - Day tables read for the ribbon or the archive are kept for a few
//!   minutes: starting catch-up right after reads no table again, a
//!   programme added since is still found, a table cut short by an error is
//!   not kept, and forgetting the source drops them. A portal that serves
//!   the tables only under `itv` is asked there first once it answered.
//! - A `create_link` the portal never answers fails after one deadline, not
//!   three.

use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration as Days, NaiveDate, Utc};
use iptv_core::events::BroadcastSink;
use iptv_core::model::{ContentType, ItemRef, StalkerSourceConfig};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, RpcError, RpcErrorCode};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk-guide";
/// Programmes a day table lists: 00:00 to 20:00 UTC, half an hour each,
/// ten a page.
const SHOWS: i64 = 40;
const PER_PAGE: i64 = 10;

#[derive(Default)]
struct Portal {
    calls: Mutex<HashMap<String, u64>>,
    /// Day tables only under `itv` (`epg` answers an error).
    itv_only: AtomicBool,
    /// Page 2 of today's table answers an error page, once.
    fail_today_page2: AtomicBool,
    /// Start (unix seconds) of one more programme, listed in its day's table.
    extra: AtomicI64,
}

impl Portal {
    fn count(&self, key: &str) -> u64 {
        self.calls.lock().unwrap().get(key).copied().unwrap_or(0)
    }

    fn tables(&self) -> u64 {
        self.count("epg.get_simple_data_table") + self.count("itv.get_simple_data_table")
    }
}

fn rfc(ts: i64) -> String {
    DateTime::from_timestamp(ts, 0)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sql_time(ts: i64) -> String {
    DateTime::from_timestamp(ts, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn day_table(p: &Portal, date: NaiveDate, page: i64) -> Value {
    let day = date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let mut rows: Vec<Value> = (0..SHOWS)
        .map(|k| {
            let start = day + k * 1800;
            json!({"id": format!("{date}-{k}"), "name": format!("Show {k}"),
                "start_timestamp": start, "stop_timestamp": start + 1800})
        })
        .collect();
    let extra = p.extra.load(Ordering::SeqCst);
    if extra >= day && extra < day + 86_400 {
        rows.push(json!({"id": "extra", "name": "Added late",
            "start_timestamp": extra, "stop_timestamp": extra + 1800}));
    }
    let total = rows.len() as i64;
    let page_rows: Vec<Value> = rows
        .into_iter()
        .skip(((page - 1) * PER_PAGE) as usize)
        .take(PER_PAGE as usize)
        .collect();
    json!({"total_items": total, "max_page_items": PER_PAGE, "data": page_rows})
}

async fn portal_php(
    State(p): State<Arc<Portal>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let key = format!("{}.{}", get("type"), get("action"));
    *p.calls.lock().unwrap().entry(key.clone()).or_default() += 1;
    let now = Utc::now().timestamp();
    let page: i64 = get("p").parse().unwrap_or(1);
    let js = match key.as_str() {
        "itv.get_genres" => json!([{"id": "1", "title": "News"}]),
        "itv.get_all_channels" => json!((1001..=1005)
            .map(|id| json!({
                "id": id.to_string(), "name": format!("Channel {id}"), "cmd": format!("ffrt http://tv.example/{id}"),
                "tv_genre_id": "1", "enable_tv_archive": "1", "tv_archive_duration": "168",
                "xmltv_id": if id == 1001 { "one.example" } else { "" },
            }))
            .collect::<Vec<_>>()),
        "itv.get_short_epg" => json!([]),
        "itv.get_epg_info" => json!({"data": {
            "1001": [{"name": "Timed", "time": sql_time(now - 600), "time_to": sql_time(now + 3000)}],
            "1002": [{"name": "Lasting", "start_timestamp": now - 600, "duration": 3600}],
            "1003": [{"title": "Marked", "start_timestamp": now - 600, "stop_timestamp": now + 3000,
                      "descr": "<b>Bold</b> words<br/>here"}],
            "1004": "not a list",
            "1005": [
                {"name": "Over", "start_timestamp": now - 7200, "stop_timestamp": now - 3600},
                {"name": "Airing", "start_timestamp": now - 600, "stop_timestamp": now + 3000},
            ],
        }}),
        "epg.get_simple_data_table" if p.itv_only.load(Ordering::SeqCst) => {
            json!({"error": "Unknown action"})
        }
        "epg.get_simple_data_table" | "itv.get_simple_data_table" => {
            let date = NaiveDate::parse_from_str(&get("date"), "%Y-%m-%d").unwrap();
            if page == 2
                && date == Utc::now().date_naive()
                && p.fail_today_page2.swap(false, Ordering::SeqCst)
            {
                return Html("<html>busy</html>").into_response();
            }
            day_table(&p, date, page)
        }
        "tv_archive.create_link" => json!({"cmd": "http://stream.example/archive.ts"}),
        "radio.get_ordered_list" => json!({"total_items": 0, "data": []}),
        "vod.get_ordered_list" | "series.get_ordered_list" => {
            json!({"total_items": 0, "data": []})
        }
        _ => json!([]),
    };
    Json(json!({ "js": js })).into_response()
}

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    portal: Arc<Portal>,
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

    async fn ribbon(&self, id: &str, from: DateTime<Utc>) -> Vec<Value> {
        let from = from.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let v = self
            .ok(
                "stalker.epg",
                json!({"ref": live(id), "limit": 10, "from": from}),
            )
            .await;
        v.as_array().unwrap().clone()
    }

    async fn catch_up(&self, id: &str, start: i64) -> Value {
        self.ok(
            "stalker.catchupUrl",
            json!({"ref": live(id), "start": rfc(start), "durationMinutes": 30}),
        )
        .await
    }
}

fn live(id: &str) -> Value {
    json!({"sourceId": SID, "contentType": "live", "itemId": id})
}

fn config(port: u16) -> StalkerSourceConfig {
    serde_json::from_value(json!({
        "portalUrl": format!("http://127.0.0.1:{port}/stalker/c/"),
        "macAddress": MAC,
        "isFullPortal": true,
    }))
    .unwrap()
}

/// A source on `port` with its session cached (no handshake).
async fn source_on(port: u16) -> (tempfile::TempDir, Arc<AppState>) {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(4096);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    let cfg = config(port);
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
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'stalker', 'Guide portal', ?2)",
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
    (tmp, state)
}

/// A synced source on a fresh portal.
async fn env() -> Env {
    let portal = Arc::new(Portal::default());
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
    let (tmp, state) = source_on(port).await;
    let mut router = RpcRouter::new();
    iptv_core::stalker::rpc::register(&mut router);
    let e = Env {
        _tmp: tmp,
        state,
        router,
        portal,
    };
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    e
}

fn ts(v: &Value, key: &str) -> i64 {
    DateTime::parse_from_rfc3339(v[key].as_str().unwrap())
        .unwrap()
        .timestamp()
}

#[tokio::test]
async fn bulk_guide_rows_map_every_time_shape() {
    let e = env().await;
    let epg = |id: &'static str| {
        let e = &e;
        async move {
            let v = e
                .ok("stalker.epg", json!({"ref": live(id), "limit": 5}))
                .await;
            v.as_array().unwrap().clone()
        }
    };
    let now = Utc::now().timestamp();

    let timed = epg("1001").await;
    assert_eq!(timed.len(), 1, "{timed:?}");
    assert_eq!(timed[0]["title"], "Timed");
    assert_eq!(timed[0]["channelId"], "one.example", "the row's own id");
    assert!((ts(&timed[0], "end") - ts(&timed[0], "start") - 3600).abs() <= 2);

    let lasting = epg("1002").await;
    assert_eq!(lasting.len(), 1, "{lasting:?}");
    assert_eq!(lasting[0]["channelId"], "1002");
    assert_eq!(ts(&lasting[0], "end") - ts(&lasting[0], "start"), 3600);
    assert!((ts(&lasting[0], "start") - (now - 600)).abs() <= 5);

    let marked = epg("1003").await;
    assert_eq!(marked[0]["title"], "Marked");
    assert_eq!(marked[0]["description"], "Bold words here");

    assert_eq!(epg("1004").await, Vec::<Value>::new());

    let airing = epg("1005").await;
    let titles: Vec<&str> = airing
        .iter()
        .map(|p| p["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["Airing"]);
    assert_eq!(e.portal.count("itv.get_epg_info"), 1, "one bulk call");

    // The guide shift moves the cached programmes on every read.
    e.state
        .db_call(|c| {
            c.execute(
                r#"UPDATE sources SET epg_json = '{"shiftMinutes":60}' WHERE id = ?1"#,
                [SID],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let moved = epg("1002").await;
    assert_eq!(ts(&moved[0], "start") - ts(&lasting[0], "start"), 3600);
    assert_eq!(e.portal.count("itv.get_epg_info"), 1);
}

/// The past programme of `ribbon` that started at least `hours_ago` ago.
fn past_start(ribbon: &[Value], hours_ago: i64) -> i64 {
    let before = Utc::now().timestamp() - hours_ago * 3600;
    ribbon
        .iter()
        .map(|p| ts(p, "start"))
        .find(|s| *s < before)
        .expect("a past programme in the ribbon")
}

#[tokio::test]
async fn catch_up_after_the_ribbon_reads_no_table_again() {
    let e = env().await;
    let ribbon = e.ribbon("1002", Utc::now() - Days::hours(30)).await;
    let tables = e.portal.tables();
    assert!(tables > 0);
    let start = past_start(&ribbon, 6);

    let src = e.catch_up("1002", start).await;
    assert_eq!(src["url"], "http://stream.example/archive.ts", "{src}");
    assert_eq!(e.portal.tables(), tables, "the ribbon's tables were reused");
    assert_eq!(e.portal.count("tv_archive.create_link"), 1);

    // The ribbon asked again a moment later reads nothing either.
    e.ribbon("1002", Utc::now() - Days::hours(30)).await;
    assert_eq!(e.portal.tables(), tables);
}

#[tokio::test]
async fn a_programme_added_since_is_read_again() {
    let e = env().await;
    e.ribbon("1002", Utc::now() - Days::hours(30)).await;
    let tables = e.portal.tables();
    // Yesterday at 21:00 UTC: after the last programme the tables list.
    let yesterday = Utc::now().date_naive() - Days::days(1);
    let late = yesterday
        .and_hms_opt(21, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    e.portal.extra.store(late, Ordering::SeqCst);

    let src = e.catch_up("1002", late).await;
    assert!(
        src["subtitle"].as_str().unwrap().contains("Added late"),
        "{src}"
    );
    assert!(e.portal.tables() > tables, "a cached table was read again");
}

#[tokio::test]
async fn a_table_cut_short_is_not_kept() {
    let e = env().await;
    e.portal.fail_today_page2.store(true, Ordering::SeqCst);
    let from = Utc::now() - Days::minutes(30);
    e.ribbon("1003", from).await;
    let tables = e.portal.tables();

    // Only today's table, cut short at page 2, is read again (whole).
    e.ribbon("1003", from).await;
    let pages = (SHOWS + PER_PAGE - 1) / PER_PAGE;
    assert_eq!(e.portal.tables() - tables, pages as u64);
}

#[tokio::test]
async fn forgetting_the_source_drops_its_tables() {
    let e = env().await;
    let from = Utc::now() - Days::hours(30);
    e.ribbon("1004", from).await;
    let first = e.portal.tables();
    e.ribbon("1004", from).await;
    assert_eq!(e.portal.tables(), first);

    iptv_core::stalker::Runtime::get(&e.state).forget_source(SID);
    e.ribbon("1004", from).await;
    assert_eq!(e.portal.tables(), 2 * first);
}

#[tokio::test]
async fn an_itv_only_portal_is_asked_on_itv_once_it_answered() {
    let e = env().await;
    e.portal.itv_only.store(true, Ordering::SeqCst);
    e.ribbon("1005", Utc::now() - Days::minutes(30)).await;
    let asked_epg = e.portal.count("epg.get_simple_data_table");
    assert!(asked_epg >= 1);
    let itv = e.portal.count("itv.get_simple_data_table");

    // Three days ago: a table not read yet goes to `itv` straight away.
    let start = (Utc::now() - Days::days(3))
        .date_naive()
        .and_hms_opt(10, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    e.catch_up("1005", start).await;
    assert_eq!(e.portal.count("epg.get_simple_data_table"), asked_epg);
    assert!(e.portal.count("itv.get_simple_data_table") > itv);
}

/// A host that takes connections and never answers, counting them.
async fn spawn_silent_portal() -> (u16, Arc<AtomicU32>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicU32::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            held.push(sock);
        }
    });
    (port, hits)
}

#[tokio::test]
async fn a_silent_create_link_is_asked_once() {
    let (port, hits) = spawn_silent_portal().await;
    let (_tmp, state) = source_on(port).await;
    let mut router = RpcRouter::new();
    iptv_core::stalker::rpc::register(&mut router);
    let movie = ItemRef::new(SID, ContentType::Movie, "5");
    iptv_core::stalker::Runtime::get(&state).remember(
        &movie,
        iptv_core::stalker::CachedItem {
            raw: json!({"id": "5", "name": "Movie", "cmd": "/media/5.mpg"}),
            category_name: None,
            category_id: None,
        },
    );
    let t0 = Instant::now();
    let err = router
        .dispatch(
            state.clone(),
            "stalker.streamUrl",
            json!({"ref": {"sourceId": SID, "contentType": "movie", "itemId": "5"}}),
        )
        .await
        .expect_err("a silent portal is an error");
    let took = t0.elapsed();
    assert_eq!(err.code, RpcErrorCode::Timeout, "{}", err.message);
    assert_eq!(hits.load(Ordering::SeqCst), 1, "the request was sent again");
    assert!(took < Duration::from_secs(40), "failed after {took:?}");
}
