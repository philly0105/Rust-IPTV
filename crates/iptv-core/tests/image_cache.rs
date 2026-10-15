//! Image cache (Run 3 contract C2, check 3): disk hits across app restarts,
//! single flight, LRU eviction under a small cap, clear, refusal of
//! non-images and oversized bodies, the server-mode guard, failure memory,
//! type sniffing, source headers, the startup reconcile and self-repair of a
//! data dir migrated while slot 0017 was a placeholder.

use axum::body::Body;
use axum::extract::{Path as AxPath, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::error::CoreError;
use iptv_core::events::NoopSink;
use iptv_core::http::ServerMode;
use iptv_core::imagecache::{
    self, cache_key, normalize_url, CachedImage, ImageErrorKind, MAX_IMAGE_BYTES,
};
use iptv_core::AppState;
use iptv_fixtures::{spawn_mock, MockHandle};
use iptv_mock::images::poster_url;
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
/// The User-Agent the stub's `/gated/*` images require.
const GATE_AGENT: &str = "SourceAgent/2.0";

async fn new_state(dir: &Path) -> Arc<AppState> {
    AppState::new(dir.to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap()
}

/// Upstream requests the mock has seen for `path`.
async fn mock_hits(mock: &MockHandle, path: &str) -> u64 {
    let stats: serde_json::Value = reqwest::get(mock.url("/__mock/stats"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    stats["requests"][path].as_u64().unwrap_or(0)
}

/// Every regular file under the cache folder, temp files included.
fn cache_files(data_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let root = data_dir.join(imagecache::DIR_NAME);
    let Ok(subs) = std::fs::read_dir(&root) else {
        return out;
    };
    for sub in subs.flatten() {
        if sub.path().is_dir() {
            for f in std::fs::read_dir(sub.path()).unwrap().flatten() {
                out.push(f.path());
            }
        } else {
            out.push(sub.path());
        }
    }
    out.sort();
    out
}

fn key_of(url: &str) -> String {
    cache_key(&normalize_url(url).unwrap())
}

/// A PNG-looking body of exactly `size` bytes.
fn png(size: usize) -> Vec<u8> {
    let mut body = PNG_MAGIC.to_vec();
    body.resize(size.max(PNG_MAGIC.len()), 7);
    body
}

#[derive(Deserialize)]
struct SizeQuery {
    size: Option<usize>,
}

/// A stub image server with a request counter per path.
struct Stub {
    base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
    agents: Arc<Mutex<Vec<String>>>,
}

impl Stub {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().get(path).copied().unwrap_or(0)
    }
}

#[derive(Clone)]
struct StubState {
    hits: Arc<Mutex<HashMap<String, usize>>>,
    agents: Arc<Mutex<Vec<String>>>,
}

async fn count(State(s): State<StubState>, req: Request, next: axum::middleware::Next) -> Response {
    *s.hits
        .lock()
        .entry(req.uri().path().to_owned())
        .or_default() += 1;
    if let Some(ua) = req.headers().get(header::USER_AGENT) {
        s.agents
            .lock()
            .push(String::from_utf8_lossy(ua.as_bytes()).into_owned());
    }
    next.run(req).await
}

fn typed(ct: &'static str, body: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, ct)], body).into_response()
}

async fn spawn_stub() -> Stub {
    let st = StubState {
        hits: Arc::default(),
        agents: Arc::default(),
    };
    let app = Router::new()
        .route(
            "/png/{name}",
            get(|Query(q): Query<SizeQuery>| async move {
                typed("image/png", png(q.size.unwrap_or(1000)))
            }),
        )
        .route(
            "/slow/{name}",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(400)).await;
                typed("image/png", png(2000))
            }),
        )
        .route(
            "/octet/{name}",
            get(|| async { typed("application/octet-stream", png(1500)) }),
        )
        .route(
            "/untyped.png",
            get(|| async { Response::new(Body::from(png(1200))) }),
        )
        .route(
            "/html-labelled.png",
            get(|| async {
                typed(
                    "image/png",
                    b"<!DOCTYPE html><html><body>Session expired</body></html>".to_vec(),
                )
            }),
        )
        .route(
            "/json",
            get(|| async { typed("application/json", b"{\"ok\":true}".to_vec()) }),
        )
        .route(
            "/big.png",
            get(|| async { typed("image/png", png(MAX_IMAGE_BYTES as usize + 1)) }),
        )
        .route(
            "/big-chunked.png",
            get(|| async {
                // No Content-Length: the cap is enforced while reading.
                let chunk = bytes::Bytes::from(png(1024 * 1024));
                let chunks = (0..11).map(move |_| Ok::<_, std::io::Error>(chunk.clone()));
                Response::builder()
                    .header(header::CONTENT_TYPE, "image/png")
                    .body(Body::from_stream(futures::stream::iter(chunks)))
                    .unwrap()
            }),
        )
        .route(
            "/empty.png",
            get(|| async { typed("image/png", Vec::new()) }),
        )
        .route(
            "/status/{code}",
            get(|AxPath(code): AxPath<u16>| async move {
                StatusCode::from_u16(code).unwrap().into_response()
            }),
        )
        .route(
            // An image host that wants the provider's User-Agent; slow, so
            // a second caller arrives while the first fetch is running.
            "/gated/{name}",
            get(|headers: axum::http::HeaderMap| async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                if headers
                    .get(header::USER_AGENT)
                    .is_some_and(|v| v == GATE_AGENT)
                {
                    typed("image/png", png(1800))
                } else {
                    StatusCode::FORBIDDEN.into_response()
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(st.clone(), count));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Stub {
        base: format!("http://127.0.0.1:{port}"),
        hits: st.hits,
        agents: st.agents,
    }
}

async fn set_last_access(state: &Arc<AppState>, url: &str, at: i64) {
    let key = key_of(url);
    let n = state
        .db_call(move |c| {
            Ok(c.execute(
                "UPDATE image_cache SET last_access = ?2 WHERE key = ?1",
                rusqlite::params![key, at],
            )?)
        })
        .await
        .unwrap();
    assert_eq!(n, 1, "row exists");
}

async fn last_access(state: &Arc<AppState>, url: &str) -> i64 {
    let key = key_of(url);
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT last_access FROM image_cache WHERE key = ?1",
                [key],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap()
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// (a) ------------------------------------------------------------------------

#[tokio::test]
async fn a_second_get_is_a_disk_hit_even_from_a_new_app_state() {
    let mock = spawn_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let url = poster_url(&mock.base, "dune-part-two");
    let path = "/img/poster/dune-part-two.svg";
    let first: CachedImage;
    {
        let state = new_state(dir.path()).await;
        first = imagecache::get(&state, &url, None).await.unwrap();
        assert!(!first.hit, "the first get fetches");
        assert_eq!(first.content_type, "image/svg+xml");
        assert_eq!(mock_hits(&mock, path).await, 1);
        let key = key_of(&url);
        assert_eq!(
            first.path,
            dir.path()
                .join(imagecache::DIR_NAME)
                .join(&key[..2])
                .join(&key)
        );
        let on_disk = std::fs::read(&first.path).unwrap();
        assert_eq!(on_disk.len() as u64, first.bytes);
        assert!(on_disk.starts_with(b"<svg"), "bytes stored as received");

        let again = imagecache::get(&state, &url, None).await.unwrap();
        assert!(again.hit);
        assert_eq!(again.path, first.path);
        assert_eq!(mock_hits(&mock, path).await, 1);

        let stats = imagecache::stats(&state).await.unwrap();
        assert_eq!((stats.files, stats.bytes), (1, first.bytes));
    }
    // A restart: a new AppState on the same data dir reads the disk.
    let state = new_state(dir.path()).await;
    let after = imagecache::get(&state, &url, None).await.unwrap();
    assert!(after.hit, "served from disk after a restart");
    assert_eq!(after.path, first.path);
    assert_eq!(after.content_type, "image/svg+xml");
    assert_eq!(mock_hits(&mock, path).await, 1);
    // The fragment never reaches the server, so it shares the entry.
    let frag = imagecache::get(&state, &format!("{url}#x"), None)
        .await
        .unwrap();
    assert!(frag.hit);
    assert_eq!(mock_hits(&mock, path).await, 1);
}

// (b) ------------------------------------------------------------------------

#[tokio::test]
async fn b_concurrent_gets_share_one_fetch() {
    let mock = spawn_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = poster_url(&mock.base, "single-flight");
    let all = futures::future::join_all((0..10).map(|_| imagecache::get(&state, &url, None))).await;
    let images: Vec<CachedImage> = all.into_iter().map(Result::unwrap).collect();
    assert_eq!(mock_hits(&mock, "/img/poster/single-flight.svg").await, 1);
    assert!(images.iter().all(|i| i.path == images[0].path));
    assert!(images.iter().any(|i| !i.hit), "one of them fetched");

    // The same with a slow upstream, so every caller joins the running fetch.
    let stub = spawn_stub().await;
    let slow = stub.url("/slow/a.png");
    let all =
        futures::future::join_all((0..10).map(|_| imagecache::get(&state, &slow, None))).await;
    for r in all {
        let img = r.unwrap();
        assert!(!img.hit, "joined an unfinished fetch");
        assert_eq!(img.bytes, 2000);
    }
    assert_eq!(stub.hits("/slow/a.png"), 1);
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!(stats.files, 2);
}

// (c) ------------------------------------------------------------------------

#[tokio::test]
async fn c_a_small_cap_evicts_least_recently_accessed_first() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    // 1 MiB (below the settings minimum, set directly for the test).
    state.settings.write().image_cache_max_mb = 1;
    let cap = 1024 * 1024;
    let size = 300_000;
    let url = |n: &str| stub.url(&format!("/png/{n}?size={size}"));

    for n in ["a", "b", "c"] {
        imagecache::get(&state, &url(n), None).await.unwrap();
    }
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!(
        (stats.files, stats.bytes, stats.max_bytes),
        (3, 900_000, cap)
    );
    // Least recently accessed first: a, then c, then b.
    set_last_access(&state, &url("a"), 1_000).await;
    set_last_access(&state, &url("b"), 3_000).await;
    set_last_access(&state, &url("c"), 2_000).await;

    // d takes the total to 1.2 MB > 1 MiB: evict down to 90 % (943,718).
    imagecache::get(&state, &url("d"), None).await.unwrap();
    let stats = imagecache::stats(&state).await.unwrap();
    assert!(stats.bytes <= cap, "{stats:?}");
    assert!(stats.bytes <= cap / 100 * 90, "{stats:?}");
    assert_eq!(stats.files, 3);
    assert!(!state_has(&state, &url("a")).await, "a was the oldest");
    for n in ["b", "c", "d"] {
        assert!(state_has(&state, &url(n)).await, "{n} kept");
    }

    // e evicts c (2,000), the oldest left; b (3,000) stays.
    imagecache::get(&state, &url("e"), None).await.unwrap();
    let stats = imagecache::stats(&state).await.unwrap();
    assert!(stats.bytes <= cap, "{stats:?}");
    assert!(!state_has(&state, &url("c")).await);
    for n in ["b", "d", "e"] {
        assert!(state_has(&state, &url(n)).await, "{n} kept");
    }
    // The files on disk match the index exactly.
    let files = cache_files(dir.path());
    assert_eq!(files.len(), 3, "{files:?}");
    let on_disk: u64 = files
        .iter()
        .map(|f| std::fs::metadata(f).unwrap().len())
        .sum();
    assert_eq!(on_disk, stats.bytes);

    // An evicted image is fetched again on demand.
    let back = imagecache::get(&state, &url("a"), None).await.unwrap();
    assert!(!back.hit);
    assert_eq!(stub.hits("/png/a"), 2);

    // Lowering the cap is applied by the next stats call.
    imagecache::stats(&state).await.unwrap();
    state.settings.write().image_cache_max_mb = 0;
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes, stats.max_bytes), (0, 0, 0));
    assert!(cache_files(dir.path()).is_empty());
}

/// True when the cache holds `url` (index row and file).
async fn state_has(state: &Arc<AppState>, url: &str) -> bool {
    let key = key_of(url);
    let row: bool = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM image_cache WHERE key = ?1",
                [&key],
                |r| r.get::<_, i64>(0),
            )? == 1)
        })
        .await
        .unwrap();
    let key = key_of(url);
    let file = state
        .data_dir
        .join(imagecache::DIR_NAME)
        .join(&key[..2])
        .join(&key)
        .exists();
    assert_eq!(row, file, "row and file agree for {url}");
    row
}

#[tokio::test]
async fn hits_move_last_access_forward_at_most_once_a_minute() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/png/touch");
    imagecache::get(&state, &url, None).await.unwrap();
    let fresh = last_access(&state, &url).await;
    assert!((unix_now() - fresh).abs() < 5);

    // A hit within the minute writes nothing.
    set_last_access(&state, &url, unix_now() - 30).await;
    let before = last_access(&state, &url).await;
    assert!(imagecache::get(&state, &url, None).await.unwrap().hit);
    imagecache::stats(&state).await.unwrap(); // barrier: queued writes are applied
    assert_eq!(last_access(&state, &url).await, before);

    // A hit on an entry last read long ago moves it forward.
    set_last_access(&state, &url, 1_000).await;
    assert!(imagecache::get(&state, &url, None).await.unwrap().hit);
    imagecache::stats(&state).await.unwrap();
    assert!(last_access(&state, &url).await >= unix_now() - 5);
    assert_eq!(stub.hits("/png/touch"), 1);
}

// (d) ------------------------------------------------------------------------

#[tokio::test]
async fn d_clear_leaves_no_files_and_no_bytes() {
    let mock = spawn_mock().await;
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let poster = poster_url(&mock.base, "to-clear");
    imagecache::get(&state, &poster, None).await.unwrap();
    for n in ["x", "y"] {
        imagecache::get(&state, &stub.url(&format!("/png/{n}")), None)
            .await
            .unwrap();
    }
    assert_eq!(imagecache::stats(&state).await.unwrap().files, 3);
    // A remembered failure is forgotten by Clear too.
    let missing = stub.url("/status/404");
    imagecache::get(&state, &missing, None).await.unwrap_err();

    let stats = imagecache::clear(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (0, 0));
    assert_eq!(stats.max_bytes, 500 * 1024 * 1024);
    assert!(
        cache_files(dir.path()).is_empty(),
        "{:?}",
        cache_files(dir.path())
    );
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (0, 0));

    // After a clear the next get fetches again.
    let again = imagecache::get(&state, &poster, None).await.unwrap();
    assert!(!again.hit);
    assert_eq!(mock_hits(&mock, "/img/poster/to-clear.svg").await, 2);
    imagecache::get(&state, &missing, None).await.unwrap_err();
    assert_eq!(stub.hits("/status/404"), 2);
}

// (e) ------------------------------------------------------------------------

#[tokio::test]
async fn e_non_images_and_oversized_bodies_are_refused_and_not_stored() {
    let mock = spawn_mock().await;
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;

    // An expired panel's HTML login page.
    let err = imagecache::get(&state, &mock.url("/fail/login.m3u"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Unsupported(_)), "{err:?}");
    let err = imagecache::fetch(&state, &stub.url("/json"), None)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::NotImage);
    assert_eq!(err.http_status(), 415);
    // A web page labelled image/png.
    let err = imagecache::fetch(&state, &stub.url("/html-labelled.png"), None)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::NotImage);

    // Over 10 MB, announced by Content-Length or only found while reading.
    for path in ["/big.png", "/big-chunked.png"] {
        let err = imagecache::get(&state, &stub.url(path), None)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{path}: {err:?}");
        let err = imagecache::fetch(&state, &stub.url(path), None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ImageErrorKind::TooLarge, "{path}");
        assert_eq!(err.http_status(), 502);
    }

    // An empty body and an upstream error are refused as network failures.
    let err = imagecache::get(&state, &stub.url("/empty.png"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Network(_)), "{err:?}");
    let err = imagecache::get(&state, &stub.url("/status/500"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Network(_)), "{err:?}");
    let err = imagecache::get(&state, &mock.url("/fail/404.m3u"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    // Not an http(s) URL.
    for bad in ["ftp://127.0.0.1/a.png", "/img/poster/x.svg", ""] {
        let err = imagecache::get(&state, bad, None).await.unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad}: {err:?}");
    }

    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (0, 0));
    assert!(
        cache_files(dir.path()).is_empty(),
        "no file and no temp file left: {:?}",
        cache_files(dir.path())
    );
}

#[tokio::test]
async fn failures_are_remembered_instead_of_refetched() {
    let mock = spawn_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = mock.url("/fail/404.m3u");
    for _ in 0..3 {
        let err = imagecache::fetch(&state, &url, None).await.unwrap_err();
        assert_eq!(err.kind, ImageErrorKind::NotFound);
        assert_eq!(err.http_status(), 404);
    }
    assert_eq!(mock_hits(&mock, "/fail/404.m3u").await, 1);
    let login = mock.url("/fail/login.m3u");
    for _ in 0..3 {
        imagecache::get(&state, &login, None).await.unwrap_err();
    }
    assert_eq!(mock_hits(&mock, "/fail/login.m3u").await, 1);
}

#[tokio::test]
async fn generic_types_are_sniffed_and_stored_as_the_real_type() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let img = imagecache::get(&state, &stub.url("/octet/p.png"), None)
        .await
        .unwrap();
    assert_eq!(img.content_type, "image/png");
    let img = imagecache::get(&state, &stub.url("/untyped.png"), None)
        .await
        .unwrap();
    assert_eq!(img.content_type, "image/png");
    // The stored type survives a hit.
    let hit = imagecache::get(&state, &stub.url("/octet/p.png"), None)
        .await
        .unwrap();
    assert!(hit.hit);
    assert_eq!(hit.content_type, "image/png");
}

#[tokio::test]
async fn a_source_contributes_its_headers() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let config = serde_json::json!({
        "url": stub.url("/list.m3u"),
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
    imagecache::get(&state, &stub.url("/png/ua"), Some("s1"))
        .await
        .unwrap();
    assert_eq!(stub.agents.lock().last().unwrap(), "SourceAgent/2.0");
    // An unknown source id still loads the image (no headers, no trust).
    imagecache::get(&state, &stub.url("/png/ua2"), Some("gone"))
        .await
        .unwrap();
    assert_ne!(stub.agents.lock().last().unwrap(), "SourceAgent/2.0");
}

#[tokio::test]
async fn callers_with_other_source_headers_share_no_fetch_and_no_failure() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let config = serde_json::json!({
        "url": stub.url("/list.m3u"),
        "headers": {"userAgent": GATE_AGENT}
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

    // A surface without the source starts first and is refused; the
    // source's request arrives while that fetch runs and must not join it.
    let gated = stub.url("/gated/a.png");
    let (bare, with) = tokio::join!(imagecache::fetch(&state, &gated, None), async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        imagecache::fetch(&state, &gated, Some("s1")).await
    });
    assert_eq!(bare.unwrap_err().kind, ImageErrorKind::Upstream);
    let with = with.unwrap();
    assert!(!with.hit);
    assert_eq!(with.bytes, 1800);
    assert_eq!(stub.hits("/gated/a.png"), 2);

    // A remembered refusal of the bare request does not block the source.
    let other = stub.url("/gated/b.png");
    let err = imagecache::fetch(&state, &other, None).await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::Upstream);
    assert!(
        !imagecache::fetch(&state, &other, Some("s1"))
            .await
            .unwrap()
            .hit
    );
    // Once stored, the image is a disk hit for every caller.
    assert!(imagecache::fetch(&state, &other, None).await.unwrap().hit);
    assert_eq!(stub.hits("/gated/b.png"), 2);
}

#[tokio::test]
async fn two_processes_on_one_data_dir_stay_under_the_cap_together() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    // The desktop app and an `iptv-server --data-dir` on its data dir: each
    // has its own writer, and each running total counts its own inserts.
    let desktop = new_state(dir.path()).await;
    let server = new_state(dir.path()).await;
    for s in [&desktop, &server] {
        s.settings.write().image_cache_max_mb = 1;
    }
    let cap = 1024 * 1024;
    // Both start before either inserts (each process loads the table's
    // total at boot): a writer started later would count the other's rows.
    for s in [&desktop, &server] {
        imagecache::stats(s).await.unwrap();
    }
    let url = |n: &str| stub.url(&format!("/png/{n}?size=300000"));
    for n in ["d1", "d2"] {
        imagecache::get(&desktop, &url(n), None).await.unwrap();
    }
    for n in ["s1", "s2"] {
        imagecache::get(&server, &url(n), None).await.unwrap();
    }
    // 1.2 MB in the table, 600 kB in either running total: no insert
    // evicted. images.stats reads the table's own total and evicts.
    let stats = imagecache::stats(&desktop).await.unwrap();
    assert!(stats.bytes <= cap / 100 * 90, "{stats:?}");
    assert_eq!((stats.files, stats.bytes), (3, 900_000));
    assert_eq!(cache_files(dir.path()).len(), 3);
    let seen = imagecache::stats(&server).await.unwrap();
    assert_eq!((seen.files, seen.bytes), (3, 900_000));
}

// (f) ------------------------------------------------------------------------

#[tokio::test]
async fn f_server_mode_refuses_private_urls_without_a_trusted_source() {
    let mock = spawn_mock().await;
    let url = poster_url(&mock.base, "guarded");
    let path = "/img/poster/guarded.svg";

    // Guarded server: no source -> refused before any request.
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    ServerMode::install(&state, false).unwrap();
    let err = imagecache::fetch(&state, &url, None).await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::Forbidden, "{err:?}");
    assert_eq!(err.http_status(), 403);
    let err = imagecache::get(&state, &url, None).await.unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    // A host name that resolves to loopback is refused at connect time.
    let named = url.replace("127.0.0.1", "localhost");
    let err = imagecache::fetch(&state, &named, None).await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::Forbidden, "{err:?}");
    assert_eq!(mock_hits(&mock, path).await, 0);

    // A source whose own server is the mock is trusted for that host:port.
    let config = serde_json::json!({ "url": mock.url("/m3u/sample.m3u") }).to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('mock', 'm3u', 'Mock', ?1)",
                [config],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let img = imagecache::get(&state, &url, Some("mock")).await.unwrap();
    assert!(!img.hit);
    assert_eq!(mock_hits(&mock, path).await, 1);
    // Cached through the source, still refused without it.
    let err = imagecache::fetch(&state, &url, None).await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::Forbidden);
    assert!(
        imagecache::get(&state, &url, Some("mock"))
            .await
            .unwrap()
            .hit
    );
    assert_eq!(mock_hits(&mock, path).await, 1);

    // --allow-private-targets: no source needed.
    let dir = tempfile::tempdir().unwrap();
    let open = new_state(dir.path()).await;
    ServerMode::install(&open, true).unwrap();
    let img = imagecache::get(&open, &url, None).await.unwrap();
    assert!(!img.hit);
    assert_eq!(mock_hits(&mock, path).await, 2);
}

// Startup ----------------------------------------------------------------------

#[tokio::test]
async fn init_reconciles_rows_and_files() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let (keep, lose) = (stub.url("/png/keep"), stub.url("/png/lose"));
    {
        let state = new_state(dir.path()).await;
        imagecache::get(&state, &keep, None).await.unwrap();
        let lost = imagecache::get(&state, &lose, None).await.unwrap();
        imagecache::stats(&state).await.unwrap();
        std::fs::remove_file(lost.path).unwrap();
    }
    // An old file without a row, an old temp file, and a young orphan that
    // may belong to a fetch in progress.
    let root = dir.path().join(imagecache::DIR_NAME);
    let orphan_key = "f".repeat(64);
    let young_key = "e".repeat(64);
    std::fs::create_dir_all(root.join("ff")).unwrap();
    std::fs::create_dir_all(root.join("ee")).unwrap();
    let orphan = root.join("ff").join(&orphan_key);
    let temp = root.join("ff").join(format!("{orphan_key}.0123.tmp"));
    let young = root.join("ee").join(&young_key);
    for p in [&orphan, &temp, &young] {
        std::fs::write(p, png(100)).unwrap();
    }
    let long_ago = SystemTime::now() - Duration::from_secs(3600);
    for p in [&orphan, &temp] {
        std::fs::File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
    }

    let state = new_state(dir.path()).await;
    imagecache::init(state.clone()).await.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let stats = imagecache::stats(&state).await.unwrap();
        if stats.files == 1 && !orphan.exists() && !temp.exists() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "reconcile did not finish: {stats:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(young.exists(), "a young orphan is left alone");
    assert!(imagecache::get(&state, &keep, None).await.unwrap().hit);
    // The row of the missing file is gone, so it is fetched again.
    assert!(!imagecache::get(&state, &lose, None).await.unwrap().hit);
    assert_eq!(stub.hits("/png/lose"), 2);
}

#[tokio::test]
async fn a_missing_file_behind_a_row_is_refetched() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/png/vanish?size=4000");
    let first = imagecache::get(&state, &url, None).await.unwrap();
    std::fs::remove_file(&first.path).unwrap();
    let again = imagecache::get(&state, &url, None).await.unwrap();
    assert!(!again.hit);
    assert_eq!(std::fs::metadata(&again.path).unwrap().len(), 4000);
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (1, 4000));
    // A file truncated on disk is refetched as well.
    std::fs::write(&again.path, b"\x89PNG").unwrap();
    assert!(!imagecache::get(&state, &url, None).await.unwrap().hit);
    assert_eq!(stub.hits("/png/vanish"), 3);
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!((stats.files, stats.bytes), (1, 4000));
}

#[tokio::test]
async fn a_data_dir_migrated_with_the_placeholder_is_repaired() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    {
        // What a wave-0 build left: version 17 recorded, no table.
        let state = new_state(dir.path()).await;
        state
            .db_call(|c| {
                c.execute_batch("DROP TABLE image_cache;")?;
                Ok(())
            })
            .await
            .unwrap();
    }
    let state = new_state(dir.path()).await;
    let img = imagecache::get(&state, &stub.url("/png/repair"), None)
        .await
        .unwrap();
    assert!(!img.hit);
    assert_eq!(imagecache::stats(&state).await.unwrap().files, 1);
}
