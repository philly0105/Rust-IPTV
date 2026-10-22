//! Download timings against the C13 mock, for the performance notes in
//! `docs/architecture/downloads.md`. Every test here is `#[ignore]`d: run
//! them with `cargo test -p iptv-core --test downloads_perf -- --ignored
//! --nocapture` and read the printed numbers. They only use what the shipped
//! code exposes, so the same file measures a build before a change.

use iptv_core::model::{Download, DownloadStatus};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Ctx {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    srv: iptv_fixtures::MockHandle,
}

async fn ctx() -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(1024);
    let state = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::downloads::init(state.clone()).await.unwrap();
    let mut router = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut router);
    Ctx {
        _tmp: tmp,
        state,
        router,
        srv: iptv_fixtures::spawn_mock().await,
    }
}

impl Ctx {
    async fn ok(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

    async fn start(&self, item: &str, path: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": "src", "contentType": "movie", "itemId": item},
                    "title": format!("item {item}"),
                    "url": self.srv.url(path),
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    async fn wait_status(&self, id: i64, status: DownloadStatus, limit: Duration) -> Download {
        let deadline = Instant::now() + limit;
        loop {
            let d: Download =
                serde_json::from_value(self.ok("downloads.get", json!({"id": id})).await).unwrap();
            if d.status == status {
                return d;
            }
            assert!(
                Instant::now() < deadline,
                "download {id} stuck in {:?}",
                d.status
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

/// DL-3: a 20 MiB download whose body stalls once at 5 MiB, with the
/// shipped idle limits (before: the client's 60 s read timeout).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement"]
async fn measure_stall_once() {
    let c = ctx().await;
    let started = Instant::now();
    let d = c.start("1", "/files/flaky.bin?key=measure&stall=1").await;
    let done = c
        .wait_status(d.id, DownloadStatus::Completed, Duration::from_secs(300))
        .await;
    let path = done.file_path.unwrap();
    let got = std::fs::read(&path).unwrap();
    assert_eq!(got, iptv_fixtures::video_bytes(0, got.len()));
    eprintln!(
        "DL-3 stall once at 5 MiB of 20 MiB: completed in {:.1} s",
        started.elapsed().as_secs_f64()
    );
}

/// DL-3: a server that accepts the connection and never sends a response
/// head (`/fail/hang.m3u`), timed from start to Failed (before: 5 attempts
/// at the client's 60 s read timeout).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement"]
async fn measure_hang_to_failed() {
    let c = ctx().await;
    let started = Instant::now();
    let d = c.start("1", "/fail/hang.m3u").await;
    c.wait_status(d.id, DownloadStatus::Failed, Duration::from_secs(400))
        .await;
    eprintln!(
        "DL-3 no response head: failed after {:.1} s",
        started.elapsed().as_secs_f64()
    );
}

/// DL-5: ten 2 MiB downloads at 1 MiB/s (about 2 s each, two at a time)
/// are queued ahead of the one the user wants, which then gets Download
/// next (`downloads.prioritize`; a build without it answers an error and
/// the row waits its turn). Times start to that row's transfer starting.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement"]
async fn measure_download_next() {
    let c = ctx().await;
    for i in 0..10 {
        c.start(
            &format!("q{i}"),
            &format!("/files/video.bin?size=2097152&kbps=1024&n={i}"),
        )
        .await;
    }
    let started = Instant::now();
    let wanted = c
        .start("wanted", "/files/video.bin?size=2097152&kbps=1024&n=x")
        .await;
    let prioritized = c
        .router
        .dispatch(
            c.state.clone(),
            "downloads.prioritize",
            json!({"id": wanted.id}),
        )
        .await
        .is_ok();
    c.wait_status(
        wanted.id,
        DownloadStatus::Downloading,
        Duration::from_secs(120),
    )
    .await;
    eprintln!(
        "DL-5 wanted row behind 10 queued (Download next: {prioritized}): started after {:.1} s",
        started.elapsed().as_secs_f64()
    );
}

/// DL-1: a six-episode season queued on a 1-connection Xtream account (the
/// mock's `limit1`, which refuses a second open file with 403), 8 MiB files
/// at 4 MiB/s. Prints how many complete and fail, the file requests, the
/// refused ones and the wall time. Then, with one download running, a player
/// starts on the same source (reporting it through `downloads.playback`
/// where the build has it) and opens a movie: prints the status it gets.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement"]
async fn measure_one_connection_season() {
    let c = ctx().await;
    iptv_core::xtream::init(c.state.clone()).await.unwrap();
    reqwest::get(c.srv.url("/__mock/limited-vod?size=8388608&kbps=4096"))
        .await
        .unwrap();
    let (user, pass) = ("limit1", iptv_fixtures::XTREAM_PASSWORD);
    let cfg =
        json!({"serverUrl": c.srv.xtream_url(), "username": user, "password": pass}).to_string();
    c.state
        .db_call(move |conn| {
            conn.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('xt', 'xtream', 'xt', ?1)",
                [&cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    iptv_core::account::status(&c.state, "xt", true)
        .await
        .unwrap();
    let start = |item: u32| {
        json!({
            "ref": {"sourceId": "xt", "contentType": "movie", "itemId": item.to_string()},
            "title": format!("Episode {item}"),
            "url": c.srv.url(&format!("/xtream/movie/{user}/{pass}/{item}.mp4")),
        })
    };
    let started = Instant::now();
    let mut ids = Vec::new();
    for item in 101..107 {
        let d: Download =
            serde_json::from_value(c.ok("downloads.start", start(item)).await).unwrap();
        ids.push(d.id);
    }
    let (mut completed, mut failed);
    loop {
        (completed, failed) = (0, 0);
        for id in &ids {
            let d: Download =
                serde_json::from_value(c.ok("downloads.get", json!({"id": id})).await).unwrap();
            match d.status {
                DownloadStatus::Completed => completed += 1,
                DownloadStatus::Failed => failed += 1,
                _ => {}
            }
        }
        if completed + failed == ids.len() || started.elapsed() > Duration::from_secs(120) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let stats: Value = reqwest::get(c.srv.url("/__mock/stats"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let file_requests: u64 = stats["requests"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| k.starts_with("/xtream/movie/"))
        .map(|(_, v)| v.as_u64().unwrap_or(0))
        .sum();
    eprintln!(
        "DL-1 season of 6 on a 1-connection account: {completed} completed, {failed} failed, {file_requests} file requests, {} refused, {:.1} s",
        stats["requests"]["refused_streams"].as_u64().unwrap_or(0),
        started.elapsed().as_secs_f64()
    );

    let d: Download = serde_json::from_value(c.ok("downloads.start", start(150)).await).unwrap();
    c.wait_status(d.id, DownloadStatus::Downloading, Duration::from_secs(30))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let reported = c
        .router
        .dispatch(
            c.state.clone(),
            "downloads.playback",
            json!({"clientId": "player", "sourceIds": ["xt"]}),
        )
        .await
        .is_ok();
    let play = reqwest::get(c.srv.url(&format!("/xtream/movie/{user}/{pass}/200.mp4")))
        .await
        .unwrap();
    eprintln!(
        "DL-1 player opens a movie while a download runs (reported: {reported}): HTTP {}",
        play.status().as_u16()
    );
}

/// DL-M1: eight 4 MiB downloads at 1 MiB/s (two at a time), and after 5 s
/// the file server answers 503 for 30 s. Shipped timings throughout. Prints
/// how many complete and fail, and the wall time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement"]
async fn measure_outage_mid_queue() {
    let c = ctx().await;
    let started = Instant::now();
    let mut ids = Vec::new();
    for i in 0..8 {
        let d = c
            .start(
                &format!("o{i}"),
                &format!("/files/video.bin?size=4194304&kbps=1024&n={i}"),
            )
            .await;
        ids.push(d.id);
    }
    tokio::time::sleep(Duration::from_secs(5)).await;
    reqwest::get(c.srv.url("/__mock/outage?ms=30000"))
        .await
        .unwrap();
    let (mut completed, mut failed);
    loop {
        (completed, failed) = (0, 0);
        for id in &ids {
            let d: Download =
                serde_json::from_value(c.ok("downloads.get", json!({"id": id})).await).unwrap();
            match d.status {
                DownloadStatus::Completed => completed += 1,
                DownloadStatus::Failed => failed += 1,
                _ => {}
            }
        }
        if completed + failed == ids.len() || started.elapsed() > Duration::from_secs(200) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!(
        "DL-M1 30 s outage in a queue of 8: {completed} completed, {failed} failed, {:.1} s",
        started.elapsed().as_secs_f64()
    );
}
