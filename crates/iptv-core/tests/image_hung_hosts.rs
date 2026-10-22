//! Image hosts that accept the connection and never answer: the image head
//! deadline and the per-host breaker. The route's own wait for a sized
//! poster is tested in `iptv-server` (`img_stops_waiting_for_a_sized_miss_*`
//! in `server.rs`).
//!
//! Every test here runs with a short head deadline and breaker open time
//! ([`imagecache::set_head_timeout_for_tests`] and
//! [`imagecache::set_breaker_open_for_tests`], process-wide, which is why
//! these tests have a binary of their own).

use axum::extract::{Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::events::NoopSink;
use iptv_core::http::ServerMode;
use iptv_core::imagecache::{self, ImageErrorKind};
use iptv_core::AppState;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

/// The head deadline these tests run with.
const HEAD: Duration = Duration::from_millis(500);
/// How long a tripped breaker stays open in these tests.
const OPEN: Duration = Duration::from_millis(1000);

type Hits = Arc<Mutex<HashMap<String, usize>>>;

/// A small PNG-looking body.
fn png() -> Response {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(800, 7);
    ([(header::CONTENT_TYPE, "image/png")], png).into_response()
}

/// A local image host: `/hang/*` accepts the request and never answers,
/// `/ok/*` sends a small PNG and `/held/*` sends it once the test adds a
/// permit to `release`.
struct Upstream {
    base: String,
    hits: Hits,
    release: Arc<Semaphore>,
}

impl Upstream {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().get(path).copied().unwrap_or(0)
    }

    /// Waits until a request for `path` reached the host.
    async fn reached(&self, path: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.hits(path) == 0 {
            assert!(Instant::now() < deadline, "{path} never reached the host");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

async fn count(State(hits): State<Hits>, req: Request, next: axum::middleware::Next) -> Response {
    *hits.lock().entry(req.uri().path().to_owned()).or_default() += 1;
    next.run(req).await
}

async fn spawn_upstream() -> Upstream {
    let hits = Hits::default();
    let release = Arc::new(Semaphore::new(0));
    let held = release.clone();
    let app = Router::new()
        .route(
            "/hang/{name}",
            get(|| async {
                futures::future::pending::<()>().await;
                "never"
            }),
        )
        .route("/ok/{name}", get(|| async { png() }))
        .route(
            "/held/{name}",
            get(move || async move {
                held.acquire().await.unwrap().forget();
                png()
            }),
        )
        .layer(axum::middleware::from_fn_with_state(hits.clone(), count));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Upstream {
        base: format!("http://127.0.0.1:{port}"),
        hits,
        release,
    }
}

async fn new_state() -> (tempfile::TempDir, Arc<AppState>) {
    imagecache::set_head_timeout_for_tests(HEAD);
    imagecache::set_breaker_open_for_tests(OPEN);
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    (dir, state)
}

#[tokio::test]
async fn a_host_that_never_answers_fails_after_the_image_head_deadline() {
    let up = spawn_upstream().await;
    for server_mode in [false, true] {
        let (_dir, state) = new_state().await;
        if server_mode {
            // Loopback upstream: the guard must let it through.
            ServerMode::install(&state, true).unwrap();
        }
        let path = format!("/hang/{server_mode}.png");
        let started = Instant::now();
        let err = imagecache::fetch(&state, &up.url(&path), None)
            .await
            .unwrap_err();
        let took = started.elapsed();
        assert_eq!(err.kind, ImageErrorKind::NoAnswer, "{err:?}");
        assert_eq!(err.http_status(), 502);
        assert!(err.message.contains("did not answer"), "{err:?}");
        // Before, the shared 15 s head deadline applied.
        assert!(took >= HEAD && took < HEAD * 4, "{server_mode}: {took:?}");
        assert_eq!(up.hits(&path), 1);
    }
}

/// A poster of `up` at `path` with a width hint, as a grid asks for it.
fn poster(
    state: &Arc<AppState>,
    up: &Upstream,
    path: &str,
) -> impl std::future::Future<Output = Result<imagecache::CachedImage, imagecache::ImageError>>
       + Send
       + 'static {
    let (state, url) = (state.clone(), up.url(path));
    async move { imagecache::fetch_sized(&state, &url, None, Some(192)).await }
}

/// Two posters of `up` that never answer: they trip its breaker.
async fn trip(state: &Arc<AppState>, up: &Upstream) {
    let (a, b) = tokio::join!(
        poster(state, up, "/hang/a.png"),
        poster(state, up, "/hang/b.png")
    );
    for r in [a, b] {
        assert_eq!(r.unwrap_err().kind, ImageErrorKind::NoAnswer);
    }
}

#[tokio::test]
async fn a_host_that_stopped_answering_is_skipped_until_a_probe_gets_an_answer() {
    let up = spawn_upstream().await;
    let healthy = spawn_upstream().await;
    let (_dir, state) = new_state().await;
    trip(&state, &up).await;

    // The host's next poster fails at once, without asking it.
    let started = Instant::now();
    let err = poster(&state, &up, "/hang/c.png").await.unwrap_err();
    let took = started.elapsed();
    assert_eq!(err.kind, ImageErrorKind::HostDown, "{err:?}");
    assert_eq!(err.http_status(), 502);
    assert!(took < Duration::from_millis(100), "{took:?}");
    assert_eq!(up.hits("/hang/c.png"), 0);
    // Another host (same address, another port) is not affected.
    poster(&state, &healthy, "/ok/d.png").await.unwrap();

    // Once the open time is over, one fetch tries the host again, and the
    // others are still refused while it runs.
    tokio::time::sleep(OPEN).await;
    let probe = tokio::spawn(poster(&state, &up, "/held/e.png"));
    up.reached("/held/e.png").await;
    let err = poster(&state, &up, "/ok/f.png").await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::HostDown, "{err:?}");
    assert_eq!(up.hits("/ok/f.png"), 0);

    // The probe gets an answer: the host is asked again, also for pictures
    // refused while it was skipped (a refusal is not remembered per image).
    up.release.add_permits(1);
    probe.await.unwrap().unwrap();
    poster(&state, &up, "/ok/f.png").await.unwrap();
    let err = poster(&state, &up, "/hang/c.png").await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::NoAnswer, "{err:?}");
    assert_eq!(up.hits("/hang/c.png"), 1);
}

#[tokio::test]
async fn clearing_the_cache_asks_a_skipped_host_again() {
    let up = spawn_upstream().await;
    let (_dir, state) = new_state().await;
    trip(&state, &up).await;
    let err = poster(&state, &up, "/ok/g.png").await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::HostDown, "{err:?}");
    imagecache::clear(&state).await.unwrap();
    poster(&state, &up, "/ok/g.png").await.unwrap();
    assert_eq!(up.hits("/ok/g.png"), 1);
}
