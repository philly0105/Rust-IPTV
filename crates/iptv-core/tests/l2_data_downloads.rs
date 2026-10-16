//! L2-guide-library-12: a resumed download takes the next free slot ahead of
//! downloads queued after it, instead of going to the back of the queue.

use iptv_core::model::{Download, DownloadStatus};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(60);

struct Ctx {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    srv: iptv_fixtures::MockHandle,
}

async fn ctx() -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(65_536);
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

    async fn start(&self, item: &str) -> i64 {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": "src", "contentType": "movie", "itemId": item},
                    "title": format!("Film {item}"),
                    "url": self.srv.url("/files/video.bin"),
                }),
            )
            .await;
        serde_json::from_value::<Download>(v).unwrap().id
    }

    async fn status(&self, id: i64) -> DownloadStatus {
        serde_json::from_value::<Download>(self.ok("downloads.get", json!({"id": id})).await)
            .unwrap()
            .status
    }

    async fn wait_status(&self, id: i64, want: DownloadStatus) {
        let deadline = Instant::now() + WAIT;
        while self.status(id).await != want {
            assert!(
                Instant::now() < deadline,
                "download {id} never became {want:?}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resumed_download_goes_ahead_of_later_ones() {
    let c = ctx().await;
    // Slow transfers (20 MB at 1 MB/s) keep both slots busy.
    iptv_core::downloads::set_rate_limit(&c.state, Some(1024 * 1024));
    let first = c.start("1").await;
    let second = c.start("2").await;
    c.wait_status(first, DownloadStatus::Downloading).await;
    c.wait_status(second, DownloadStatus::Downloading).await;

    // Pause the first, then queue two more: one takes the freed slot.
    c.ok("downloads.pause", json!({"id": first})).await;
    assert_eq!(c.status(first).await, DownloadStatus::Paused);
    let later_a = c.start("3").await;
    let later_b = c.start("4").await;
    c.wait_status(later_a, DownloadStatus::Downloading).await;
    assert_eq!(c.status(later_b).await, DownloadStatus::Queued);

    // Resumed while both slots are busy: it waits at the head of the queue.
    c.ok("downloads.resume", json!({"id": first})).await;
    assert_eq!(c.status(first).await, DownloadStatus::Queued);

    // The next free slot is the resumed download's, not the later one's.
    c.ok("downloads.cancel", json!({"id": second})).await;
    c.wait_status(first, DownloadStatus::Downloading).await;
    assert_eq!(c.status(later_b).await, DownloadStatus::Queued);

    for id in [first, later_a, later_b] {
        c.ok("downloads.cancel", json!({"id": id})).await;
    }
}
