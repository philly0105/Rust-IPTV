//! Image hosts that are slow to take the connection, or never take it, under
//! the real image deadlines. Linux only: there a listener whose full accept
//! queue is never drained drops further SYNs, and the client sends its SYN
//! again after about 1, 2 or 3, 4 or 7 s (the kernel's SYN backoff). A binary
//! of its own, since `image_hung_hosts` shortens the head deadline for its
//! whole process.

#![cfg(target_os = "linux")]

use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::events::NoopSink;
use iptv_core::http::CONNECT_TIMEOUT;
use iptv_core::imagecache::{self, ImageErrorKind, HEAD_TIMEOUT};
use iptv_core::AppState;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpSocket, TcpStream};

/// A small PNG-looking body.
fn png() -> Response {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(800, 7);
    ([(header::CONTENT_TYPE, "image/png")], png).into_response()
}

/// A loopback listener that takes no connection: its accept queue is full
/// (the returned streams) and nothing accepts. Keep all three alive.
async fn deaf_listener() -> (TcpListener, Vec<TcpStream>, SocketAddr) {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(0).unwrap();
    let addr = listener.local_addr().unwrap();
    let mut queued = Vec::new();
    while queued.len() < 16 {
        let connect = TcpStream::connect(addr);
        match tokio::time::timeout(Duration::from_millis(200), connect).await {
            Ok(Ok(stream)) => queued.push(stream),
            _ => break,
        }
    }
    (listener, queued, addr)
}

async fn new_state() -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    (dir, state)
}

/// A grid poster's request for `name` on `addr`.
async fn poster(
    state: &Arc<AppState>,
    addr: SocketAddr,
    name: &str,
) -> Result<imagecache::CachedImage, imagecache::ImageError> {
    let url = format!("http://{addr}/{name}.png");
    imagecache::fetch_sized(state, &url, None, Some(192)).await
}

#[tokio::test]
async fn a_host_that_takes_the_connection_after_3_s_still_sends_the_image() {
    let (listener, queued, addr) = deaf_listener().await;
    let (_dir, state) = new_state().await;
    // The host starts taking connections after 3.5 s; the client's next SYN
    // gets in. The DNS lookup counts toward the same connect timeout, so this
    // also stands for a resolver that takes that long.
    let late = Duration::from_millis(3500);
    tokio::spawn(async move {
        tokio::time::sleep(late).await;
        let app = Router::new().route("/{name}", get(|| async { png() }));
        axum::serve(listener, app).await.unwrap();
    });
    let started = Instant::now();
    let image = poster(&state, addr, "late").await.unwrap();
    let took = started.elapsed();
    assert!(!image.hit);
    // Image fetches gave up connecting after 3 s before.
    assert!(took >= late && took < HEAD_TIMEOUT, "{took:?}");
    drop(queued);
}

#[tokio::test]
async fn a_host_that_never_takes_the_connection_fails_at_the_head_deadline_and_is_skipped() {
    let (_listener, _queued, addr) = deaf_listener().await;
    let (_dir, state) = new_state().await;
    let started = Instant::now();
    let (a, b) = tokio::join!(poster(&state, addr, "a"), poster(&state, addr, "b"));
    let took = started.elapsed();
    for r in [a, b] {
        let err = r.unwrap_err();
        assert_eq!(err.kind, ImageErrorKind::NoAnswer, "{err:?}");
    }
    // The head deadline covers connecting; the client's own connect timeout
    // is longer.
    assert!(took >= HEAD_TIMEOUT && took < CONNECT_TIMEOUT, "{took:?}");
    // Two images without an answer: the host is skipped, at once.
    let started = Instant::now();
    let err = poster(&state, addr, "c").await.unwrap_err();
    assert_eq!(err.kind, ImageErrorKind::HostDown, "{err:?}");
    assert!(started.elapsed() < Duration::from_millis(100));
}
