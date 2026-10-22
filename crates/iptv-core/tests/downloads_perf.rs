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
