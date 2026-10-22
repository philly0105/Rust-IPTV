//! DL-1 through the HTTP API: a stream opened through `/api/proxy` for a
//! source counts as playback, so a download holding the only connection of
//! that source's account yields before the proxy asks the provider, and
//! resumes once the stream is closed.

use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::model::{DownloadStatus, WaitReason};
use iptv_core::rpc::build_router;
use iptv_core::AppState;
use iptv_server::{Server, ServerOptions};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_proxied_stream_takes_the_connection_from_a_download() {
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let (tx, _) = broadcast::channel::<AppEvent>(64);
    let app = AppState::new(
        tmp.path().join("data"),
        Arc::new(BroadcastSink(tx.clone())),
        false,
    )
    .await
    .unwrap();
    let server = Server::new(app, Arc::new(build_router()), tx, ServerOptions::new(dist));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = iptv_server::router(server.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let app = server.app.clone();
    iptv_core::downloads::init(app.clone()).await.unwrap();
    iptv_core::xtream::init(app.clone()).await.unwrap();

    // A 1-connection Xtream account on the mock, its status cached as a sync
    // caches it, and 4 MiB files at 1 MiB/s.
    let mock = iptv_fixtures::spawn_mock().await;
    reqwest::get(mock.url("/__mock/limited-vod?size=4194304&kbps=1024"))
        .await
        .unwrap();
    let (user, pass) = ("limit1", iptv_fixtures::XTREAM_PASSWORD);
    let config =
        serde_json::json!({"serverUrl": mock.xtream_url(), "username": user, "password": pass})
            .to_string();
    app.db_call(move |c| {
        c.execute(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('xt', 'xtream', 'xt', ?1)",
            [&config],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    iptv_core::account::status(&app, "xt", true).await.unwrap();

    let d = iptv_core::downloads::start(
        &app,
        iptv_core::downloads::StartRequest {
            item_ref: Some(iptv_core::model::ItemRef::new(
                "xt",
                iptv_core::model::ContentType::Movie,
                "101",
            )),
            title: "Movie 101".into(),
            url: mock.url(&format!("/xtream/movie/{user}/{pass}/101.mp4")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while iptv_core::downloads::get(&app, d.id)
        .await
        .unwrap()
        .bytes_downloaded
        == 0
    {
        assert!(Instant::now() < deadline, "download never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The player opens a movie through the proxy for the same source.
    let mut u = url::Url::parse(&format!("{base}/api/proxy")).unwrap();
    u.query_pairs_mut()
        .append_pair(
            "url",
            &mock.url(&format!("/xtream/movie/{user}/{pass}/200.mp4")),
        )
        .append_pair("sourceId", "xt");
    let stream = reqwest::get(u).await.unwrap();
    assert!(stream.status().is_success(), "{}", stream.status());
    let queued = iptv_core::downloads::get(&app, d.id).await.unwrap();
    assert_eq!(queued.status, DownloadStatus::Queued);
    assert_eq!(queued.waiting.map(|w| w.reason), Some(WaitReason::Playback));

    // Closing the stream gives the connection back (after the linger an HLS
    // player's gaps between segments need).
    drop(stream);
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let d = iptv_core::downloads::get(&app, d.id).await.unwrap();
        if d.status == DownloadStatus::Completed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "download never resumed: {:?}",
            d.status
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
