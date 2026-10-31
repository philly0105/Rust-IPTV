//! Memory and time of the Stalker paths that hold big portal answers: a
//! 20k-channel import (changed, then unchanged), the bulk guide kept for
//! rows without a short EPG, the movie and series row cache, and the day
//! tables a catch-up start reads after the ribbon.
//!
//! The binary counts heap bytes with its own global allocator (live and
//! peak), so the memory numbers are exact and the same in debug and
//! release. The portal is served from pre-built bytes, so its own heap
//! stays out of the counts. Ignored by default; run one at a time:
//! `cargo test -p iptv-core --release --test stalker_perf -- --ignored --test-threads=1 --nocapture`

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use iptv_core::events::BroadcastSink;
use iptv_core::model::{ContentType, ItemRef, StalkerSourceConfig};
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);

fn grew(by: isize) {
    let now = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            grew(layout.size() as isize);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            grew(layout.size() as isize);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            grew(new_size as isize - layout.size() as isize);
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn live() -> isize {
    LIVE.load(Ordering::Relaxed)
}

/// Resets the peak to the live heap and returns it.
fn reset_peak() -> isize {
    let now = live();
    PEAK.store(now, Ordering::Relaxed);
    now
}

fn mb(bytes: isize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

const MAC: &str = "00:1A:79:00:00:01";
const SID: &str = "stk-perf";
const CHANNELS: usize = 20_000;
const PROGRAMMES: usize = 5;

/// A Ministra `get_all_channels` row: about 45 keys and one `cmds` entry.
fn channel_json(i: usize, out: &mut String) {
    let archive = if i.is_multiple_of(4) { "1" } else { "0" };
    write!(
        out,
        r#"{{"id":"{i}","name":"Channel {i} HD","number":"{n}","censored":"0","cmd":"ffrt http://localhost/ch/{i}_","cost":"0","count":"0","status":1,"hd":"1","tv_genre_id":"{g}","base_ch":"1","xmltv_id":"ch{i}.example","service_id":"","bonus_ch":"0","volume_correction":"0","mc_cmd":"","enable_tv_archive":"{archive}","wowza_tmp_link":"0","wowza_dvr":"0","use_http_tmp_link":"0","monitoring_status":"1","enable_monitoring":"0","enable_wowza_load_balancing":"0","cmd_1":"","cmd_2":"","cmd_3":"","logo":"http://logo.example/{i}.png","correct_time":"0","nimble_dvr":"0","allow_pvr":"0","allow_local_pvr":"0","allow_remote_pvr":"0","modified":"2024-01-01 00:00:00","allow_local_timeshift":"1","nginx_secure_link":"0","tv_archive_duration":"168","locked":0,"lock":0,"fav":0,"archive":{archive},"genres_str":"","cur_playing":"[No channel info]","epg":[],"open":1,"cmds":[{{"id":"{i}","ch_id":"{i}","priority":"0","url":"ffrt http://localhost/ch/{i}_","status":"1","use_http_tmp_link":"0","wowza_tmp_link":"0","user_agent_filter":"","use_load_balancing":"0","changed":"2024-01-01 00:00:00","enable_monitoring":"0","enable_balancer_monitoring":"0","nginx_secure_link":"0","flussonic_tmp_link":"0"}}],"use_load_balancing":0,"pvr":0}}"#,
        n = i + 1,
        g = 1 + i % 20,
    )
    .unwrap();
}

/// A Ministra programme as `get_epg_info` sends it: about 20 keys.
fn programme_json(ch: usize, k: usize, start: i64, out: &mut String) {
    let stop = start + 3600;
    write!(
        out,
        r#"{{"id":"{id}","ch_id":"{ch}","time":"2026-10-31 10:00:00","time_to":"2026-10-31 11:00:00","duration":3600,"name":"Programme {k} on {ch}","descr":"An hour of programming on channel {ch}: news, weather and a look at what happens next in the region and beyond.","real_id":"{ch}_{start}","category":"News","director":"","actor":"","start_timestamp":{start},"stop_timestamp":{stop},"t_time":"10:00","t_time_to":"11:00","mark_memo":0,"mark_archive":0,"open":1,"display_duration":3600}}"#,
        id = ch * 10 + k,
    )
    .unwrap();
}

fn channel_list(n: usize) -> Bytes {
    let mut s = String::with_capacity(n * 1600);
    s.push('[');
    for i in 0..n {
        if i > 0 {
            s.push(',');
        }
        channel_json(i, &mut s);
    }
    s.push(']');
    Bytes::from(s)
}

fn bulk_epg(n: usize, now: i64) -> Bytes {
    let mut s = String::with_capacity(n * PROGRAMMES * 520);
    s.push_str(r#"{"js":{"data":{"#);
    for ch in 0..n {
        if ch > 0 {
            s.push(',');
        }
        write!(s, r#""{ch}":["#).unwrap();
        for k in 0..PROGRAMMES {
            if k > 0 {
                s.push(',');
            }
            programme_json(ch, k, now - 1800 + k as i64 * 3600, &mut s);
        }
        s.push(']');
    }
    s.push_str("}}}");
    Bytes::from(s)
}

#[derive(Default)]
struct Portal {
    channels: Bytes,
    bulk: Bytes,
    calls: Mutex<HashMap<String, u64>>,
    /// Delay of every request, in ms.
    each_ms: AtomicU64,
    seq: AtomicU64,
}

impl Portal {
    fn count(&self, key: &str) -> u64 {
        self.calls.lock().unwrap().get(key).copied().unwrap_or(0)
    }

    fn total(&self) -> u64 {
        self.calls.lock().unwrap().values().sum()
    }
}

fn json_response(v: Value) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
}

/// Serves pre-built parts without copying them.
fn parts_response(parts: Vec<Bytes>) -> Response {
    let len: usize = parts.iter().map(Bytes::len).sum();
    let stream = futures::stream::iter(parts.into_iter().map(Ok::<_, std::io::Error>));
    (
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn portal_php(
    State(p): State<Arc<Portal>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let key = format!("{}.{}", get("type"), get("action"));
    *p.calls.lock().unwrap().entry(key.clone()).or_default() += 1;
    let delay = p.each_ms.load(Ordering::SeqCst);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let page: usize = get("p").parse().unwrap_or(1).max(1);
    match key.as_str() {
        "itv.get_genres" => json_response(json!({"js": (1..=20)
            .map(|g| json!({"id": g.to_string(), "title": format!("Genre {g}")}))
            .collect::<Vec<_>>()})),
        "itv.get_all_channels" => {
            // Real portals add a debug line that changes on every answer.
            let n = p.seq.fetch_add(1, Ordering::SeqCst);
            let head = format!(
                r#"{{"js":{{"total_items":{c},"max_page_items":{c},"selected_item":0,"cur_page":0,"data":"#,
                c = CHANNELS
            );
            let tail = format!(r#"}},"text":"generated in: 0.{n:04}s; query counter: {n}"}}"#);
            parts_response(vec![
                Bytes::from(head),
                p.channels.clone(),
                Bytes::from(tail),
            ])
        }
        "radio.get_ordered_list" => {
            let data: Vec<Value> = ((page - 1) * 14..(page * 14).min(20))
                .map(|i| json!({"id": format!("r{i}"), "name": format!("Radio {i}"), "cmd": format!("http://radio.example/{i}")}))
                .collect();
            json_response(json!({"js": {"total_items": 20, "max_page_items": 14, "data": data}}))
        }
        "vod.get_categories" | "series.get_categories" => json_response(json!({"js": [
            {"id": "*", "title": "All"}, {"id": "1", "title": "Action"}, {"id": "2", "title": "Drama"}
        ]})),
        "vod.get_ordered_list" | "series.get_ordered_list" => {
            json_response(json!({"js": {"total_items": 4200, "max_page_items": 14, "data": []}}))
        }
        "itv.get_short_epg" => json_response(json!({"js": []})),
        "itv.get_epg_info" => parts_response(vec![p.bulk.clone()]),
        // A day of 48 half-hour programmes, 10 a page.
        "epg.get_simple_data_table" => {
            let date = chrono::NaiveDate::parse_from_str(&get("date"), "%Y-%m-%d").unwrap();
            let day = date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
            let data: Vec<Value> = ((page - 1) * 10..(page * 10).min(48))
                .map(|k| {
                    let start = day + k as i64 * 1800;
                    json!({"id": format!("{}", start), "name": format!("Show {k}"),
                        "start_timestamp": start, "stop_timestamp": start + 1800})
                })
                .collect();
            json_response(json!({"js": {"total_items": 48, "max_page_items": 10, "data": data}}))
        }
        "tv_archive.create_link" => {
            json_response(json!({"js": {"cmd": "http://stream.example/archive/1.ts"}}))
        }
        _ => json_response(json!({"js": []})),
    }
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
}

async fn env(portal: Portal) -> Env {
    let portal = Arc::new(portal);
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
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'stalker', 'Big portal', ?2)",
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

/// Longest gap between the ticks of a 10 ms interval on this (single
/// threaded) runtime while `fut` runs: how long the runtime was blocked.
async fn with_stall<T>(fut: impl std::future::Future<Output = T>) -> (T, Duration) {
    let worst = Arc::new(Mutex::new(Duration::ZERO));
    let ticker = {
        let worst = worst.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last = Instant::now();
            loop {
                tick.tick().await;
                let gap = last.elapsed();
                last = Instant::now();
                let mut w = worst.lock().unwrap();
                *w = (*w).max(gap);
            }
        })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    *worst.lock().unwrap() = Duration::ZERO;
    let out = fut.await;
    ticker.abort();
    let w = *worst.lock().unwrap();
    (out, w)
}

#[tokio::test]
#[ignore]
async fn channel_import_heap_and_stall() {
    let list = channel_list(CHANNELS);
    eprintln!(
        "stalker_perf: get_all_channels list {:.1} MB",
        list.len() as f64 / 1048576.0
    );
    let e = env(Portal {
        channels: list,
        ..Default::default()
    })
    .await;
    for round in ["changed", "unchanged"] {
        let base = reset_peak();
        let t0 = Instant::now();
        let (res, stall) = with_stall(e.ok("stalker.sync", json!({"sourceId": SID}))).await;
        let took = t0.elapsed();
        let peak = PEAK.load(Ordering::Relaxed) - base;
        assert_eq!(res["channels"], CHANNELS + 20, "{res}");
        let unchanged = res["unchanged"] == true;
        assert_eq!(unchanged, round == "unchanged", "{res}");
        eprintln!(
            "stalker_perf: {round} import of {CHANNELS} channels: {took:?}, peak heap +{:.1} MB, longest runtime stall {stall:?}",
            mb(peak)
        );
    }
}

#[tokio::test]
#[ignore]
async fn bulk_guide_heap() {
    let now = chrono::Utc::now().timestamp();
    let bulk = bulk_epg(CHANNELS, now);
    eprintln!(
        "stalker_perf: get_epg_info answer {:.1} MB",
        bulk.len() as f64 / 1048576.0
    );
    let e = env(Portal {
        bulk,
        ..Default::default()
    })
    .await;
    let row = |id: &str| json!({"ref": {"sourceId": SID, "contentType": "live", "itemId": id}, "limit": 3});
    let base = reset_peak();
    let t0 = Instant::now();
    let (got, stall) = with_stall(e.ok("stalker.epg", row("7"))).await;
    let took = t0.elapsed();
    assert_eq!(got.as_array().map(Vec::len), Some(3), "{got}");
    let peak = PEAK.load(Ordering::Relaxed) - base;
    let kept = live() - base;
    eprintln!(
        "stalker_perf: bulk guide for {CHANNELS} channels x {PROGRAMMES}: first row {took:?}, peak heap +{:.1} MB, kept +{:.1} MB, longest runtime stall {stall:?}",
        mb(peak),
        mb(kept)
    );
    // Rows served from the cached guide.
    let t1 = Instant::now();
    for id in 0..200 {
        let got = e.ok("stalker.epg", row(&id.to_string())).await;
        assert_eq!(got.as_array().map(Vec::len), Some(3));
    }
    eprintln!(
        "stalker_perf: 200 rows from the cached guide in {:?}",
        t1.elapsed()
    );
    assert_eq!(e.portal.count("itv.get_epg_info"), 1);
}

/// A Ministra movie row: about 64 keys.
fn movie_row(i: usize) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(i.to_string()));
    m.insert("name".into(), json!(format!("Movie number {i}")));
    m.insert("o_name".into(), json!(format!("Original title {i}")));
    m.insert("description".into(), json!("A long description of the film that runs for a few sentences, as portals send it: the plot, the cast, and where it was shot. ".repeat(3)));
    m.insert("cmd".into(), json!(format!("/media/{i}.mpg")));
    m.insert(
        "screenshot_uri".into(),
        json!(format!("http://img.example/screen/{i}.jpg")),
    );
    m.insert("actors".into(), json!("Actor One, Actor Two, Actor Three"));
    m.insert("director".into(), json!("Some Director"));
    m.insert("genres_str".into(), json!("Action, Drama"));
    m.insert("category_id".into(), json!("1"));
    m.insert("year".into(), json!("2019"));
    m.insert("rating_imdb".into(), json!("6.5"));
    for k in 0..52 {
        m.insert(
            format!("field_{k:02}"),
            json!(if k % 2 == 0 { "0" } else { "" }),
        );
    }
    Value::Object(m)
}

#[tokio::test]
#[ignore]
async fn row_cache_heap() {
    let e = env(Portal::default()).await;
    // What the rows take as parsed trees, as listings hand them over.
    let base = live();
    let rows: Vec<Value> = (0..5000).map(movie_row).collect();
    let trees = live() - base;
    let text: usize = rows.iter().map(|r| r.to_string().len()).sum();
    drop(rows);

    let rt = iptv_core::stalker::Runtime::get(&e.state);
    let base = live();
    for i in 0..5000 {
        rt.remember(
            &ItemRef::new(SID, ContentType::Movie, i.to_string()),
            iptv_core::stalker::CachedItem {
                raw: movie_row(i),
                category_name: Some("Action".into()),
                category_id: Some("1".into()),
            },
        );
    }
    let kept = live() - base;
    eprintln!(
        "stalker_perf: 5000 movie rows ({:.1} MB as JSON, {:.1} MB as trees): the row cache holds {:.1} MB",
        text as f64 / 1048576.0,
        mb(trees),
        mb(kept)
    );
    let t0 = Instant::now();
    for i in 0..5000 {
        let hit = iptv_core::stalker::cached_item(
            &e.state,
            &ItemRef::new(SID, ContentType::Movie, i.to_string()),
        )
        .await
        .unwrap();
        assert!(hit.raw.get("id").is_some());
    }
    eprintln!("stalker_perf: 5000 cache reads in {:?}", t0.elapsed());
}

#[tokio::test]
#[ignore]
async fn catchup_after_the_ribbon() {
    let e = env(Portal {
        channels: channel_list(8),
        ..Default::default()
    })
    .await;
    e.ok("stalker.sync", json!({"sourceId": SID})).await;
    e.portal.each_ms.store(300, Ordering::SeqCst);
    let live = json!({"sourceId": SID, "contentType": "live", "itemId": "0"});
    let now = chrono::Utc::now();
    let from =
        (now - chrono::Duration::hours(30)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let before = e.portal.total();
    let t0 = Instant::now();
    let ribbon = e
        .ok(
            "stalker.epg",
            json!({"ref": live, "limit": 10, "from": from}),
        )
        .await;
    eprintln!(
        "stalker_perf: ribbon with a 30 h lookback: {} requests in {:?}",
        e.portal.total() - before,
        t0.elapsed()
    );
    // A programme from yesterday, as the ribbon listed it.
    let start = ribbon
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["start"].as_str().unwrap().to_string())
        .find(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .with_timezone(&chrono::Utc)
                < now - chrono::Duration::hours(20)
        })
        .expect("a past programme");
    let (tables, links) = (
        e.portal.count("epg.get_simple_data_table") + e.portal.count("itv.get_simple_data_table"),
        e.portal.count("tv_archive.create_link"),
    );
    let t1 = Instant::now();
    e.ok(
        "stalker.catchupUrl",
        json!({"ref": live, "start": start, "durationMinutes": 30}),
    )
    .await;
    eprintln!(
        "stalker_perf: catch-up start after the ribbon: {} table requests + {} create_link in {:?}",
        e.portal.count("epg.get_simple_data_table") + e.portal.count("itv.get_simple_data_table")
            - tables,
        e.portal.count("tv_archive.create_link") - links,
        t1.elapsed()
    );
}
