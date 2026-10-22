//! L2-perf-core-8: an uncached poster requested while a catalog import holds
//! the SQLite write lock is answered as soon as its file is on disk, not
//! after its index row commits. Until the row lands, later requests (any
//! source) read the file instead of fetching again; once it lands, the
//! index, the byte total, eviction and clear agree with the files on disk.
//!
//! DB-1R: the writer's batches share `AppState::db_background`'s gate with
//! download progress and recording byte counts; `images.stats` skips it.

use axum::extract::{Path as AxPath, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use iptv_core::events::NoopSink;
use iptv_core::imagecache::{self, cache_key, normalize_url};
use iptv_core::AppState;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Well under the 500 ms the old code waited for the row to commit.
const FAST: Duration = Duration::from_millis(250);

#[derive(Deserialize)]
struct SizeQuery {
    size: Option<usize>,
}

/// A local image server counting requests per name.
struct Stub {
    base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Stub {
    fn url(&self, name: &str, size: usize) -> String {
        format!("{}/png/{name}?size={size}", self.base)
    }

    fn hits(&self, name: &str) -> usize {
        self.hits.lock().get(name).copied().unwrap_or(0)
    }
}

async fn spawn_stub() -> Stub {
    let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
    let app = Router::new()
        .route(
            "/png/{name}",
            get(
                |State(hits): State<Arc<Mutex<HashMap<String, usize>>>>,
                 AxPath(name): AxPath<String>,
                 Query(q): Query<SizeQuery>| async move {
                    *hits.lock().entry(name).or_default() += 1;
                    let mut body = b"\x89PNG\r\n\x1a\n".to_vec();
                    body.resize(q.size.unwrap_or(1000).max(body.len()), 7);
                    ([(header::CONTENT_TYPE, "image/png")], body).into_response()
                },
            ),
        )
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Stub {
        base: format!("http://127.0.0.1:{port}"),
        hits,
    }
}

async fn new_state(dir: &Path) -> Arc<AppState> {
    let state = AppState::new(dir.to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    // Starts the cache's writer before anything holds the write lock.
    imagecache::stats(&state).await.unwrap();
    state
}

/// What a catalog import's save does to everybody else: it holds the write
/// lock from its own connection until [`WriteLock::release`].
struct WriteLock(Connection);

impl WriteLock {
    fn take(state: &AppState) -> Self {
        let conn = Connection::open(state.db_path()).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        Self(conn)
    }

    fn release(self) {
        self.0.execute_batch("COMMIT").unwrap();
    }
}

async fn rows(state: &Arc<AppState>) -> u64 {
    state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM image_cache", [], |r| r.get(0))?))
        .await
        .unwrap()
}

async fn has_row(state: &Arc<AppState>, url: &str) -> bool {
    let key = cache_key(&normalize_url(url).unwrap());
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM image_cache WHERE key = ?1",
                [key],
                |r| r.get::<_, i64>(0),
            )? == 1)
        })
        .await
        .unwrap()
}

async fn set_last_access(state: &Arc<AppState>, url: &str, at: i64) {
    let key = cache_key(&normalize_url(url).unwrap());
    state
        .db_call(move |c| {
            Ok(c.execute(
                "UPDATE image_cache SET last_access = ?2 WHERE key = ?1",
                rusqlite::params![key, at],
            )?)
        })
        .await
        .unwrap();
}

/// Every cache file (temp files included) with its size.
fn cache_files(data_dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(subs) = std::fs::read_dir(data_dir.join(imagecache::DIR_NAME)) else {
        return out;
    };
    for sub in subs.flatten().filter(|s| s.path().is_dir()) {
        for f in std::fs::read_dir(sub.path()).unwrap().flatten() {
            out.push((f.path(), f.metadata().unwrap().len()));
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn uncached_posters_answer_while_an_import_holds_the_write_lock() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    // A source that sends its own User-Agent: its requests are another
    // flight scope, so they never join the bare requests' fetches.
    let config = serde_json::json!({
        "url": format!("{}/list.m3u", stub.base),
        "headers": {"userAgent": "SourceAgent/2.0"}
    })
    .to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s1', 'm3u', 'S', ?1)",
                [config],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let lock = WriteLock::take(&state);

    // One poster, then a grid of twenty at once.
    let first = stub.url("first", 2000);
    let started = Instant::now();
    let img = imagecache::fetch(&state, &first, None).await.unwrap();
    let took = started.elapsed();
    assert!(!img.hit);
    assert!(took < FAST, "one poster took {took:?} under the write lock");
    assert_eq!(std::fs::metadata(&img.path).unwrap().len(), 2000);

    let grid: Vec<String> = (0..20).map(|i| stub.url(&format!("g{i}"), 3000)).collect();
    let started = Instant::now();
    let all =
        futures::future::join_all(grid.iter().map(|u| imagecache::fetch(&state, u, None))).await;
    let took = started.elapsed();
    for r in all {
        assert!(!r.unwrap().hit);
    }
    assert!(
        took < FAST,
        "twenty posters took {took:?} under the write lock"
    );

    // The rows are still waiting for the lock: this ran the pending path.
    assert_eq!(rows(&state).await, 0, "no row can commit yet");

    // Asked again before its row lands, from the same scope and from the
    // source's: served from disk, not fetched again.
    let started = Instant::now();
    let again = imagecache::fetch(&state, &first, None).await.unwrap();
    assert!(again.hit, "the pending file is a disk hit");
    assert_eq!((again.path.clone(), again.bytes), (img.path.clone(), 2000));
    assert_eq!(again.content_type, "image/png");
    let other_scope = imagecache::fetch(&state, &first, Some("s1")).await.unwrap();
    assert!(other_scope.hit, "another scope reads the pending file too");
    assert!(started.elapsed() < FAST);
    assert_eq!(stub.hits("first"), 1);

    // The import commits: the rows land in the background.
    lock.release();
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (21, 2000 + 20 * 3000));
    assert!(has_row(&state, &first).await);
    let files = cache_files(dir.path());
    assert_eq!(files.len(), 21, "{files:?}");
    assert_eq!(files.iter().map(|(_, n)| n).sum::<u64>(), stats.bytes);

    // From the index now, for every scope; still one upstream request each.
    assert!(imagecache::fetch(&state, &first, None).await.unwrap().hit);
    assert!(
        imagecache::fetch(&state, &first, Some("s1"))
            .await
            .unwrap()
            .hit
    );
    assert!(imagecache::fetch(&state, &grid[7], None).await.unwrap().hit);
    assert_eq!(stub.hits("first"), 1);
    assert_eq!(stub.hits("g7"), 1);
}

#[tokio::test]
async fn rows_that_land_late_keep_eviction_and_clear_exact() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    // 1 MiB (below the settings minimum, set directly for the test).
    state.settings.write().image_cache_max_mb = 1;
    let size = 300_000;
    let url = |n: &str| stub.url(n, size);
    for n in ["a", "b", "c"] {
        imagecache::fetch(&state, &url(n), None).await.unwrap();
    }
    imagecache::stats(&state).await.unwrap();
    set_last_access(&state, &url("a"), 1_000).await;
    set_last_access(&state, &url("b"), 3_000).await;
    set_last_access(&state, &url("c"), 2_000).await;

    // d is stored while the lock is held; its row takes the total over the
    // cap only when it lands, and then the oldest entry (a) goes, file too.
    let lock = WriteLock::take(&state);
    let d = imagecache::fetch(&state, &url("d"), None).await.unwrap();
    assert!(!d.hit);
    // Its file is safe from a stats barrier queued behind its row.
    let barrier = tokio::spawn({
        let state = state.clone();
        async move { imagecache::stats(&state).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!barrier.is_finished(), "the barrier waits for the lock");
    lock.release();
    let stats = barrier.await.unwrap().unwrap();
    assert_eq!((stats.files, stats.bytes), (3, 900_000));
    assert!(!has_row(&state, &url("a")).await, "a was the oldest");
    for n in ["b", "c", "d"] {
        assert!(has_row(&state, &url(n)).await, "{n} kept");
    }
    let files = cache_files(dir.path());
    assert_eq!(files.len(), 3, "{files:?}");
    assert_eq!(files.iter().map(|(_, n)| n).sum::<u64>(), stats.bytes);
    assert!(d.path.exists());

    // A clear queued while a row is pending removes that row and its file
    // once it lands: nothing is left behind, on disk or in the index.
    let lock = WriteLock::take(&state);
    let e = imagecache::fetch(&state, &url("e"), None).await.unwrap();
    assert!(e.path.exists());
    let clear = tokio::spawn({
        let state = state.clone();
        async move { imagecache::clear(&state).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    lock.release();
    let stats = clear.await.unwrap().unwrap();
    assert_eq!((stats.files, stats.bytes), (0, 0));
    assert_eq!(rows(&state).await, 0);
    assert!(
        cache_files(dir.path()).is_empty(),
        "{:?}",
        cache_files(dir.path())
    );
    // And the next request fetches it again.
    assert!(
        !imagecache::fetch(&state, &url("e"), None)
            .await
            .unwrap()
            .hit
    );
    assert_eq!(stub.hits("e"), 2);
}

/// DB-1R: a batch that writes waits at the background gate; `images.stats`
/// sends barriers alone, which only read the total, and skips it. Otherwise
/// stats would wait behind a download's progress write that holds the gate
/// while it waits for an import's write lock.
#[tokio::test]
async fn stats_skips_the_background_gate_and_index_writes_wait_at_it() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;

    // An import holds the write lock, and a progress write holds the gate
    // while it waits for that lock.
    let lock = WriteLock::take(&state);
    let progress = tokio::spawn({
        let state = state.clone();
        async move {
            state
                .db_background(|c| {
                    c.execute("INSERT INTO app_state(key, value) VALUES ('p', 'x')", [])?;
                    Ok(())
                })
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!progress.is_finished(), "the write waits for the lock");
    let started = Instant::now();
    let stats = imagecache::stats(&state).await.unwrap();
    let took = started.elapsed();
    assert!(took < FAST, "images.stats took {took:?} behind the gate");
    assert_eq!((stats.files, stats.bytes), (0, 0));
    lock.release();
    progress.await.unwrap().unwrap();

    // No lock now, but another background write holds the gate: a stored
    // poster answers from its file and its row waits for the gate.
    let (release, held) = std::sync::mpsc::channel::<()>();
    let holder = tokio::spawn({
        let state = state.clone();
        async move {
            state
                .db_background(move |_| {
                    let _ = held.recv();
                    Ok(())
                })
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let url = stub.url("gated", 2000);
    assert!(!imagecache::fetch(&state, &url, None).await.unwrap().hit);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!has_row(&state, &url).await, "the row waits at the gate");
    assert!(imagecache::fetch(&state, &url, None).await.unwrap().hit);
    drop(release);
    holder.await.unwrap().unwrap();
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (1, 2000));
    assert!(has_row(&state, &url).await);
    assert_eq!(stub.hits("gated"), 1);
}
