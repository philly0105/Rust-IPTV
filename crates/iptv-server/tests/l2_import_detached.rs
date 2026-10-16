//! L1-sources-home-3: in server mode an import started by `sources.add`
//! finishes even when the browser drops the request (a reload, Back).

use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use iptv_server::{Server, ServerOptions};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_add_survives_the_client_going_away() {
    let mock = iptv_fixtures::spawn_mock().await;
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let (tx, _) = broadcast::channel::<AppEvent>(1024);
    let app = AppState::new(
        tmp.path().join("data"),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await
    .unwrap();
    iptv_core::m3u::init(app.clone()).await.unwrap();
    let server = Server::new(
        app.clone(),
        Arc::new(build_router()),
        tx,
        ServerOptions::new(dist),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let router = iptv_server::router(server);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    // The playlist answers after 1.5 s; the client leaves after 300 ms.
    let body = serde_json::json!({
        "kind": "m3u",
        "name": "Slow",
        "m3u": { "origin": "url", "url": mock.url("/fail/slow.m3u?ms=1500") },
    })
    .to_string();
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "POST /api/rpc/sources.add HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(req.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(sock);

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let listed = iptv_core::sources::list(&app).await.unwrap();
        if let Some(s) = listed.first() {
            if !iptv_core::sources::is_import_running(&app, &s.id) && s.last_refresh_at.is_some() {
                assert!(s.channel_count > 0, "the import finished: {s:?}");
                assert_eq!(s.last_error, None);
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the import stopped with the request: {listed:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
