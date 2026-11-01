//! Heap the mapped rows of an Xtream sync hold: a changed sync keeps every
//! mapped row of every changed list (live, movies, series) until the one
//! catalog write, so the bytes a row holds set the sync's peak memory, and
//! the write frees each row once it is in, before the index build.
//!
//! The test binary counts live heap bytes with its own global allocator, so
//! the numbers are exact and the same in debug and release.

use axum::extract::Query;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use bytes::Bytes;
use iptv_core::events::{AppEvent, EventSink};
use iptv_core::rpc::RpcRouter;
use iptv_core::xtream::raw::{RawLive, RawSeries, RawVod};
use iptv_core::xtream::sync::{live_row, series_row, vod_row};
use iptv_core::AppState;
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Arc;

struct Counting;

static LIVE_BYTES: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE_BYTES.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            LIVE_BYTES.fetch_add(
                new_size as isize - layout.size() as isize,
                Ordering::Relaxed,
            );
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const ROWS: usize = 5_000;

/// One test at a time: each reads the one heap counter.
static HEAP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn live_raw(i: usize) -> RawLive {
    serde_json::from_value(json!({
        "num": i + 1, "name": format!("UK: Channel {i} HD"), "stream_type": "live",
        "stream_id": i + 1, "stream_icon": format!("http://logo.example/{i}.png"),
        "epg_channel_id": format!("channel{i}.uk"), "added": "1700000000",
        "category_id": format!("{}", i % 300), "category_ids": [i % 300],
        "tv_archive": i.is_multiple_of(3), "tv_archive_duration": if i.is_multiple_of(3) { 7 } else { 0 },
        "is_adult": 0, "custom_sid": ""
    }))
    .unwrap()
}

fn vod_json(i: usize) -> Value {
    json!({
        "num": i + 1, "name": format!("Movie {i} (2019)"), "stream_type": "movie",
        "stream_id": i + 1, "stream_icon": format!("http://img.example/p/{i}.jpg"),
        "rating": "6.5", "rating_5based": 3.25, "added": "1700000000",
        "category_id": format!("{}", i % 400), "category_ids": [i % 400],
        "container_extension": "mkv", "is_adult": 0, "tmdb": format!("{}", 1000 + i)
    })
}

fn vod_raw(i: usize) -> RawVod {
    serde_json::from_value(vod_json(i)).unwrap()
}

fn series_raw(i: usize) -> RawSeries {
    serde_json::from_value(json!({
        "num": i + 1, "name": format!("Show {i}"), "series_id": i + 1,
        "cover": format!("http://img.example/c/{i}.jpg"),
        "plot": "A family of four moves to a quiet town where nothing is as it seems, and every neighbour keeps a secret that the youngest daughter is set on finding out before the summer ends.",
        "genre": "Drama, Mystery / Thriller", "releaseDate": "2018-03-01",
        "last_modified": "1700000000", "rating": "8.2", "rating_5based": 4.1,
        "backdrop_path": [format!("http://img.example/b/{i}.jpg")],
        "category_id": format!("{}", i % 100), "category_ids": [i % 100],
        "tmdb": format!("{}", 5000 + i)
    }))
    .unwrap()
}

/// Heap bytes per mapped row beyond the row itself, for `ROWS` raw rows.
fn held_per_row<R, F: Fn(usize) -> R, M: Fn(R) -> Option<iptv_core::catalog::ItemRow>>(
    raw: F,
    map: M,
) -> isize {
    let base = LIVE_BYTES.load(Ordering::Relaxed);
    let raws: Vec<R> = (0..ROWS).map(raw).collect();
    // The raw rows are consumed: whatever of their heap the rows did not
    // take over is freed by now, and so is their Vec.
    let rows: Vec<_> = raws.into_iter().filter_map(map).collect();
    assert_eq!(rows.len(), ROWS);
    let row_vec = (rows.capacity() * std::mem::size_of_val(&rows[0])) as isize;
    let held = LIVE_BYTES.load(Ordering::Relaxed) - base - row_vec;
    drop(rows);
    held / ROWS as isize
}

/// The rows carry their extra fields as JSON text (`extra_json`), not as a
/// map: a map of a few keys held about 0.6 KB more per row (792 B a live
/// row, 758 B a movie, 1,102 B a series with its plot), about 100 MB at the
/// write of a 50k live, 100k movie, 20k series panel.
#[test]
fn mapped_xtream_rows_hold_little_heap() {
    let _heap = HEAP.blocking_lock();
    let live = held_per_row(live_raw, |r| live_row("source-0000-0000", 0, r));
    let vod = held_per_row(vod_raw, |r| vod_row("source-0000-0000", 0, r));
    let series = held_per_row(series_raw, |r| series_row("source-0000-0000", 0, r));
    eprintln!(
        "xtream_row_memory: heap held per mapped row: live {live} B, movie {vod} B, series {series} B (row itself {} B)",
        std::mem::size_of::<iptv_core::catalog::ItemRow>()
    );
    assert!(live < 400, "live row holds {live} B");
    assert!(vod < 400, "movie row holds {vod} B");
    assert!(series < 700, "series row holds {series} B");
}

const MOVIES: usize = 20_000;
const USER: &str = "demo";
const PASS: &str = "secret";

/// An Xtream panel of `MOVIES` movies and nothing else, its list answer
/// built before the test measures anything.
async fn movie_panel() -> (String, tokio::sync::oneshot::Sender<()>) {
    let list = Value::Array((0..MOVIES).map(vod_json).collect());
    let list = Bytes::from(serde_json::to_vec(&list).unwrap());
    let app = Router::new().route(
        "/xtream/player_api.php",
        get(move |Query(q): Query<HashMap<String, String>>| {
            let list = list.clone();
            async move { panel_answer(q.get("action").map_or("", String::as_str), list) }
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });
    (format!("http://127.0.0.1:{port}/xtream"), stop)
}

fn panel_answer(action: &str, movies: Bytes) -> Response {
    let now = chrono::Utc::now().timestamp();
    match action {
        "" => Json(json!({
            "user_info": {
                "username": USER, "password": PASS, "auth": 1, "status": "Active",
                "exp_date": (now + 30 * 86400).to_string(), "max_connections": "1",
                "allowed_output_formats": ["m3u8", "ts"]
            },
            "server_info": {"url": "127.0.0.1", "port": "80", "timestamp_now": now}
        }))
        .into_response(),
        "get_vod_categories" => Json(json!((0..400)
            .map(|c| json!({"category_id": c.to_string(), "category_name": format!("Genre {c}")}))
            .collect::<Vec<_>>()))
        .into_response(),
        "get_vod_streams" => ([("content-type", "application/json")], movies).into_response(),
        _ => Json(json!([])).into_response(),
    }
}

/// Records the live heap when the writer reports that every row is in
/// (`step` "indexing"), right before it builds the indexes.
struct AtIndexing(Arc<AtomicIsize>);

impl EventSink for AtIndexing {
    fn emit(&self, event: AppEvent) {
        if event.kind == "import.progress" && event.payload["step"] == "indexing" {
            self.0
                .store(LIVE_BYTES.load(Ordering::Relaxed), Ordering::Relaxed);
        }
    }
}

/// The catalog write frees each row once it is in: by the time the writer
/// builds the indexes (its slowest step, with SQLite's own sort memory on
/// top) the rows of the sync are gone, instead of waiting for the commit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_catalog_write_frees_the_rows_before_the_index_build() {
    let _heap = HEAP.lock().await;
    let (server_url, _stop) = movie_panel().await;
    let dir = tempfile::tempdir().unwrap();
    let at_indexing = Arc::new(AtomicIsize::new(-1));
    let state = AppState::new(
        dir.path().to_path_buf(),
        Arc::new(AtIndexing(at_indexing.clone())),
        false,
    )
    .await
    .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    let cfg = json!({"serverUrl": server_url, "username": USER, "password": PASS}).to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('xt-mem', 'xtream', 'Movies', ?1)",
                [cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut router);

    // What the mapped rows hold, row and heap, at the start of the write.
    let per_row = held_per_row(vod_raw, |r| vod_row("xt-mem", 0, r))
        + std::mem::size_of::<iptv_core::catalog::ItemRow>() as isize;
    let rows = per_row * MOVIES as isize;

    let base = LIVE_BYTES.load(Ordering::Relaxed);
    let summary = router
        .dispatch(state.clone(), "xtream.sync", json!({"sourceId": "xt-mem"}))
        .await
        .unwrap_or_else(|e| panic!("xtream.sync failed: {:?} {}", e.code, e.message));
    assert_eq!(summary["movies"], MOVIES as u64);
    let at_indexing = at_indexing.load(Ordering::Relaxed);
    assert!(at_indexing >= 0, "no indexing step was reported");
    let held = at_indexing - base;
    eprintln!(
        "xtream_row_memory: {MOVIES} movies, rows {:.1} MB; heap above the start when the index build begins {:.1} MB",
        rows as f64 / 1e6,
        held as f64 / 1e6
    );
    assert!(
        held < rows / 2,
        "{held} B still held when the index build begins, rows are {rows} B"
    );
}
