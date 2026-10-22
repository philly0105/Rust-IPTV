//! DL-2: one file over several Range connections ("Connections per
//! download: Auto"), against the mock's `/files/video.bin`, which throttles
//! each response on its own (`kbps`), the way a provider that caps every
//! connection does.

use iptv_core::model::{Download, DownloadStatus};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(60);
const MIB: u64 = 1024 * 1024;

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

    async fn start(&self, source: &str, item: &str, path: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": source, "contentType": "movie", "itemId": item},
                    "title": format!("item {item}"),
                    "url": self.srv.url(path),
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    async fn get(&self, id: i64) -> Download {
        serde_json::from_value(self.ok("downloads.get", json!({"id": id})).await).unwrap()
    }

    async fn wait_until(&self, id: i64, what: &str, done: impl Fn(&Download) -> bool) -> Download {
        let deadline = Instant::now() + WAIT;
        loop {
            let d = self.get(id).await;
            if done(&d) {
                return d;
            }
            assert!(
                Instant::now() < deadline,
                "download {id} never {what}: {:?} {:?} {:?}",
                d.status,
                d.connections,
                d.error_message
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn requests(&self, path: &str) -> u64 {
        let v: Value = reqwest::get(self.srv.url("/__mock/stats"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        v["requests"][path].as_u64().unwrap_or(0)
    }
}

fn is_mock_content(p: &Path) -> bool {
    let got = std::fs::read(p).unwrap();
    got == iptv_fixtures::video_bytes(0, got.len())
}

fn ranges_of(file_path: &str) -> PathBuf {
    PathBuf::from(format!("{file_path}.part.ranges"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auto_splits_a_file_over_free_connections_and_resumes_every_segment() {
    let c = ctx().await;
    let size = 24 * MIB;
    let path = format!("/files/video.bin?size={size}&kbps=2048");
    let d = c.start("src", "1", &path).await;
    // A source with no account limit has two connections; nothing else is
    // queued or playing, so the file takes both.
    let split = c
        .wait_until(d.id, "used two connections", |d| {
            d.connections == Some(2) && d.bytes_downloaded > (2 * MIB) as i64
        })
        .await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    let paused = c.get(d.id).await;
    assert_eq!(paused.status, DownloadStatus::Paused);
    let file_path = paused.file_path.clone().unwrap();
    assert!(
        ranges_of(&file_path).is_file(),
        "the sidecar records the segments"
    );
    assert!(paused.bytes_downloaded >= split.bytes_downloaded);

    c.ok("downloads.resume", json!({"id": d.id})).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    let file_path = done.file_path.unwrap();
    assert_eq!(std::fs::metadata(&file_path).unwrap().len(), size);
    assert!(is_mock_content(Path::new(&file_path)), "byte-exact");
    assert!(!ranges_of(&file_path).exists(), "no sidecar left");
    assert!(!Path::new(&format!("{file_path}.part")).exists());
    // One request per segment and per resumed segment, never a full restart.
    assert!(c.requests("/files/video.bin").await >= 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_changed_file_restarts_with_one_connection_and_stays_byte_exact() {
    let c = ctx().await;
    let size = 24 * MIB;
    let path = format!("/files/video.bin?size={size}&kbps=2048&versioned=1");
    let d = c.start("src", "1", &path).await;
    c.wait_until(d.id, "used two connections", |d| {
        d.connections == Some(2) && d.bytes_downloaded > (2 * MIB) as i64
    })
    .await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    // The provider replaces the file: its ETag changes, so If-Range answers
    // the whole file instead of the segment.
    reqwest::get(c.srv.url("/__mock/etag-bump")).await.unwrap();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    let file_path = done.file_path.unwrap();
    assert_eq!(std::fs::metadata(&file_path).unwrap().len(), size);
    assert!(is_mock_content(Path::new(&file_path)), "byte-exact");
    assert!(!ranges_of(&file_path).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn playback_on_the_source_drops_a_split_download_to_one_connection() {
    let c = ctx().await;
    let path = format!("/files/video.bin?size={}&kbps=1024", 24 * MIB);
    let d = c.start("src", "1", &path).await;
    c.wait_until(d.id, "used two connections", |d| d.connections == Some(2))
        .await;
    c.ok(
        "downloads.playback",
        json!({"clientId": "player", "sourceIds": ["src"]}),
    )
    .await;
    let one = c
        .wait_until(d.id, "dropped to one connection", |d| {
            d.connections.is_none()
        })
        .await;
    assert_eq!(one.status, DownloadStatus::Downloading, "it keeps going");
    c.ok(
        "downloads.playback",
        json!({"clientId": "player", "sourceIds": []}),
    )
    .await;
    c.wait_until(d.id, "took two connections again", |d| {
        d.connections == Some(2)
    })
    .await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_one_connection_setting_keeps_a_file_on_one_connection() {
    let c = ctx().await;
    let mut next = c.state.settings_snapshot();
    next.download_single_connection = vec!["src".into()];
    iptv_core::settings::save(&c.state, next).await.unwrap();
    let path = format!("/files/video.bin?size={}&kbps=4096", 12 * MIB);
    let d = c.start("src", "1", &path).await;
    let deadline = Instant::now() + WAIT;
    loop {
        let d = c.get(d.id).await;
        assert_eq!(d.connections, None, "one connection");
        if d.status == DownloadStatus::Completed {
            assert!(is_mock_content(Path::new(&d.file_path.unwrap())));
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(c.requests("/files/video.bin").await, 1);
}
