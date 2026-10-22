//! DL-2: one file over several Range connections ("Connections per
//! download: Auto"), against the mock's `/files/video.bin`, which throttles
//! each response on its own (`kbps`), the way a provider that caps every
//! connection does, and its `limit<N>` Xtream accounts, which refuse a file
//! beyond N open bodies.

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

    /// Caches an account status allowing `n` connections for `source`, the
    /// way every Xtream sync does.
    async fn limit(&self, source: &str, n: i64) {
        iptv_core::account::record(
            &self.state,
            iptv_core::account::AccountStatus {
                source_id: source.into(),
                kind: iptv_core::model::SourceKind::Xtream,
                status: None,
                exp_date: None,
                is_trial: false,
                active_cons: Some(0),
                max_connections: Some(n),
                checked_at: "2026-10-22T00:00:00Z".into(),
                error: None,
            },
        )
        .await;
    }

    /// Size and speed of every file the mock's `limit<N>` accounts serve.
    async fn limited_files(&self, size: u64, kbps: u64) {
        reqwest::get(
            self.srv
                .url(&format!("/__mock/limited-vod?size={size}&kbps={kbps}")),
        )
        .await
        .unwrap();
    }

    /// A movie of the mock's `limit1` Xtream account, which refuses a
    /// second open body.
    fn one_connection_movie(&self, item: u32) -> String {
        let pass = iptv_fixtures::XTREAM_PASSWORD;
        format!("/xtream/movie/limit1/{pass}/{item}.mp4")
    }

    async fn refused(&self) -> u64 {
        let v: Value = reqwest::get(self.srv.url("/__mock/stats"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        v["requests"]["refused_streams"].as_u64().unwrap_or(0)
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
    c.limit("src", 3).await;
    let size = 24 * MIB;
    let path = format!("/files/video.bin?size={size}&kbps=2048");
    let d = c.start("src", "1", &path).await;
    // An account allowing three leaves downloads two; nothing else is
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
    c.limit("src", 3).await;
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
    c.limit("src", 3).await;
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
    c.limit("src", 3).await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_a_source_to_one_connection_reaches_a_split_transfer() {
    let c = ctx().await;
    c.limit("src", 3).await;
    let path = format!("/files/video.bin?size={}&kbps=2048", 24 * MIB);
    let d = c.start("src", "1", &path).await;
    c.wait_until(d.id, "used two connections", |d| d.connections == Some(2))
        .await;
    // The provider objects to parallel downloads: the user picks 1.
    let mut next = c.state.settings_snapshot();
    next.download_single_connection = vec!["src".into()];
    iptv_core::settings::save(&c.state, next).await.unwrap();
    let switched = Instant::now();
    let one = c
        .wait_until(d.id, "dropped to one connection", |d| {
            d.connections.is_none()
        })
        .await;
    let took = switched.elapsed();
    eprintln!("dropped to one connection {took:?} after the setting changed");
    assert!(took < Duration::from_secs(1), "took {took:?}");
    assert_eq!(one.status, DownloadStatus::Downloading, "it keeps going");
    let deadline = Instant::now() + WAIT;
    let done = loop {
        let d = c.get(d.id).await;
        assert_eq!(d.connections, None, "stays on one");
        if d.status == DownloadStatus::Completed {
            break d;
        }
        assert!(Instant::now() < deadline, "never completed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queued_download_gets_the_connection_a_split_one_gives_back() {
    let c = ctx().await;
    c.limit("src", 3).await;
    let path = |n: &str| format!("/files/video.bin?size={}&kbps=1024&n={n}", 24 * MIB);
    let first = c.start("src", "1", &path("1")).await;
    c.wait_until(first.id, "used two connections", |d| {
        d.connections == Some(2)
    })
    .await;
    // The source's two connections are both held: the next download waits
    // only until the split one gives one back (within a tick).
    let second = c.start("src", "2", &path("2")).await;
    let started = Instant::now();
    c.wait_until(second.id, "started", |d| {
        d.status == DownloadStatus::Downloading
    })
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "waited {:?}",
        started.elapsed()
    );
    assert_eq!(c.get(first.id).await.connections, None, "back to one");
    c.ok("downloads.cancel", json!({"id": first.id})).await;
    c.ok("downloads.cancel", json!({"id": second.id})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_source_that_reports_no_limit_keeps_one_connection_per_file() {
    let c = ctx().await;
    // An M3U playlist (no account status) whose provider allows one
    // connection, as many Xtream-backed playlists and Stalker portals do.
    c.limited_files(16 * MIB, 4096).await;
    let d = c.start("m3u", "1", &c.one_connection_movie(101)).await;
    let deadline = Instant::now() + WAIT;
    loop {
        let d = c.get(d.id).await;
        assert_eq!(d.connections, None, "one connection");
        assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
        if d.status == DownloadStatus::Completed {
            assert!(is_mock_content(Path::new(&d.file_path.unwrap())));
            break;
        }
        assert!(Instant::now() < deadline, "never completed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(c.refused().await, 0, "no second connection was tried");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_extra_connection_drops_the_file_to_one_and_it_completes() {
    let c = ctx().await;
    // The account says three (two for downloads), but the panel lets this
    // app open one (another device holds the rest): the extra segment is
    // refused.
    c.limit("xt", 3).await;
    c.limited_files(16 * MIB, 4096).await;
    let d = c.start("xt", "1", &c.one_connection_movie(101)).await;
    let done = c
        .wait_until(d.id, "completed", |d| {
            assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
            d.status == DownloadStatus::Completed
        })
        .await;
    let file_path = done.file_path.unwrap();
    assert_eq!(std::fs::metadata(&file_path).unwrap().len(), 16 * MIB);
    assert!(is_mock_content(Path::new(&file_path)), "byte-exact");
    assert!(!ranges_of(&file_path).exists());
    assert_eq!(c.refused().await, 1, "one refusal, then one connection");
}

/// Splits a 24 MiB file over two connections and pauses it; returns its
/// row and final path.
async fn paused_split(c: &Ctx) -> (Download, String) {
    c.limit("src", 3).await;
    let path = format!("/files/video.bin?size={}&kbps=2048", 24 * MIB);
    let d = c.start("src", "1", &path).await;
    c.wait_until(d.id, "used two connections", |d| {
        d.connections == Some(2) && d.bytes_downloaded > (4 * MIB) as i64
    })
    .await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    let paused = c.get(d.id).await;
    let file_path = paused.file_path.clone().unwrap();
    assert!(ranges_of(&file_path).is_file());
    (paused, file_path)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_split_download_whose_part_was_deleted_starts_over_byte_exact() {
    let c = ctx().await;
    let (d, file_path) = paused_split(&c).await;
    // The user frees space by deleting the big partial, not the small file
    // beside it.
    std::fs::remove_file(format!("{file_path}.part")).unwrap();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    let file_path = done.file_path.unwrap();
    assert_eq!(std::fs::metadata(&file_path).unwrap().len(), 24 * MIB);
    assert!(
        is_mock_content(Path::new(&file_path)),
        "no zero-filled gaps"
    );
    assert!(!ranges_of(&file_path).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_split_download_whose_part_is_shorter_than_its_sidecar_starts_over() {
    let c = ctx().await;
    let (d, file_path) = paused_split(&c).await;
    // Cut short (restored from an older copy, a full disk): the sidecar
    // records bytes the `.part` no longer has.
    std::fs::OpenOptions::new()
        .write(true)
        .open(format!("{file_path}.part"))
        .unwrap()
        .set_len(MIB)
        .unwrap();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    let file_path = done.file_path.unwrap();
    assert_eq!(std::fs::metadata(&file_path).unwrap().len(), 24 * MIB);
    assert!(
        is_mock_content(Path::new(&file_path)),
        "no zero-filled gaps"
    );
}
