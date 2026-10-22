//! Image hosts that accept the connection and never answer: the image head
//! deadline. The route's own wait for a sized poster is tested in
//! `iptv-server` (`img_stops_waiting_for_a_sized_miss_*` in `server.rs`).
//!
//! Every test here runs with a short head deadline
//! ([`imagecache::set_head_timeout_for_tests`], process-wide, which is why
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

/// The head deadline these tests run with.
const HEAD: Duration = Duration::from_millis(500);

type Hits = Arc<Mutex<HashMap<String, usize>>>;

/// A local image host: `/hang/*` accepts the request and never answers,
/// `/ok/*` sends a small PNG.
struct Upstream {
    base: String,
    hits: Hits,
}

impl Upstream {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().get(path).copied().unwrap_or(0)
    }
}

async fn count(State(hits): State<Hits>, req: Request, next: axum::middleware::Next) -> Response {
    *hits.lock().entry(req.uri().path().to_owned()).or_default() += 1;
    next.run(req).await
}

async fn spawn_upstream() -> Upstream {
    let hits = Hits::default();
    let app = Router::new()
        .route(
            "/hang/{name}",
            get(|| async {
                futures::future::pending::<()>().await;
                "never"
            }),
        )
        .route(
            "/ok/{name}",
            get(|| async {
                let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
                png.resize(800, 7);
                ([(header::CONTENT_TYPE, "image/png")], png).into_response()
            }),
        )
        .layer(axum::middleware::from_fn_with_state(hits.clone(), count));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Upstream {
        base: format!("http://127.0.0.1:{port}"),
        hits,
    }
}

async fn new_state() -> (tempfile::TempDir, Arc<AppState>) {
    imagecache::set_head_timeout_for_tests(HEAD);
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
        assert_eq!(err.kind, ImageErrorKind::Upstream, "{err:?}");
        assert!(err.message.contains("did not answer"), "{err:?}");
        // Before, the shared 15 s head deadline applied.
        assert!(took >= HEAD && took < HEAD * 4, "{server_mode}: {took:?}");
        assert_eq!(up.hits(&path), 1);
    }
}
