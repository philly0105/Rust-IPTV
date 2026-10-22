//! DL-2: one file over several Range connections ("Connections per
//! download: Auto"), against the mock's `/files/video.bin`, which throttles
//! each response on its own (`kbps`), the way a provider that caps every
//! connection does, and its `limit<N>` Xtream accounts, which refuse a file
//! beyond N open bodies. `dl_panel` serves what the mock cannot: files that
//! differ from each other, and a segment refused just as the open stream
//! reaches it.

mod dl_panel;

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
    events: parking_lot::Mutex<tokio::sync::broadcast::Receiver<iptv_core::AppEvent>>,
}

async fn ctx() -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(65_536);
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
        events: parking_lot::Mutex::new(events),
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
        self.start_titled(source, item, &format!("item {item}"), &self.srv.url(path))
            .await
    }

    async fn start_titled(&self, source: &str, item: &str, title: &str, url: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": source, "contentType": "movie", "itemId": item},
                    "title": title,
                    "url": url,
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

    /// Forgets the events received so far.
    fn drain_events(&self) {
        let mut events = self.events.lock();
        while matches!(
            events.try_recv(),
            Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
        ) {}
    }

    /// Bytes of the next `downloads.progress` event of `id`: where a resumed
    /// transfer starts.
    async fn next_progress(&self, id: i64) -> i64 {
        let deadline = Instant::now() + WAIT;
        loop {
            assert!(Instant::now() < deadline, "no progress for {id}");
            let got = self.events.lock().try_recv();
            match got {
                Ok(ev) if ev.kind == "downloads.progress" && ev.payload["id"] == id => {
                    return ev.payload["bytesDownloaded"].as_i64().unwrap();
                }
                Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
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
async fn a_folder_that_cannot_leave_holes_keeps_one_request() {
    let c = ctx().await;
    c.limit("src", 3).await;
    // FAT or exFAT: a write far past the end would zero-fill the gap.
    iptv_core::downloads::set_no_holes(&c.state, true);
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
        assert!(Instant::now() < deadline, "never completed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The file system is asked once per run: no hand-over a second later
    // that breaks the stream and reconnects.
    assert_eq!(c.requests("/files/video.bin").await, 1);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_dropped_to_one_after_a_refusal_resumes_where_it_paused() {
    let c = ctx().await;
    c.limit("xt", 3).await;
    c.limited_files(16 * MIB, 2048).await;
    let d = c.start("xt", "1", &c.one_connection_movie(101)).await;
    let deadline = Instant::now() + WAIT;
    while c.refused().await == 0 || c.get(d.id).await.bytes_downloaded < (2 * MIB) as i64 {
        assert!(Instant::now() < deadline, "never refused and went on");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    c.ok("downloads.pause", json!({"id": d.id})).await;
    let paused = c.get(d.id).await;
    let part = PathBuf::from(format!("{}.part", paused.file_path.clone().unwrap()));
    // The refused segment was handed back to the open answer's: the plan
    // that records it must still be one a resume trusts.
    assert!(
        matches!(
            iptv_core::downloads::segments::load(&part),
            iptv_core::downloads::segments::Sidecar::Valid(_)
        ),
        "the sidecar after the refusal is valid"
    );
    c.drain_events();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let first = c.next_progress(d.id).await;
    assert!(
        first >= paused.bytes_downloaded,
        "the resume started over: {first} after pausing at {}",
        paused.bytes_downloaded
    );
    let done = c
        .wait_until(d.id, "completed", |d| {
            assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
            d.status == DownloadStatus::Completed
        })
        .await;
    let file_path = done.file_path.unwrap();
    assert!(is_mock_content(Path::new(&file_path)), "byte-exact");
    // One refusal per run: the resumed run tries a second connection again.
    assert!(c.refused().await <= 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_segment_refused_as_the_open_stream_reaches_it_is_not_written_shifted() {
    let c = ctx().await;
    c.limit("src", 3).await;
    let panel = dl_panel::Panel::spawn(1).await;
    let size = 16 * MIB;
    panel.file(1, size, 4096);
    // The tail's request is refused only once the open stream is 1000
    // bytes short of the tail's start, and that stream's next chunk, which
    // crosses it, comes after the refusal has handed the tail back.
    panel.cut_next_segment(1);
    let d = c.start_titled("src", "1", "Movie", &panel.url(1)).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert!(panel.cut_fired(), "the refusal landed at the cut");
    let file_path = done.file_path.unwrap();
    dl_panel::is_exact(1, size, Path::new(&file_path)).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paused_rows_name_is_not_handed_out_while_its_part_is_gone() {
    let c = ctx().await;
    c.limit("src", 3).await;
    let panel = dl_panel::Panel::spawn(2).await;
    let (a_size, b_size) = (24 * MIB, 32 * MIB);
    panel.file(1, a_size, 2048);
    panel.file(2, b_size, 2048);
    let a = c.start_titled("src", "1", "Movie", &panel.url(1)).await;
    c.wait_until(a.id, "used two connections", |d| {
        d.connections == Some(2) && d.bytes_downloaded > (4 * MIB) as i64
    })
    .await;
    c.ok("downloads.pause", json!({"id": a.id})).await;
    let a_path = c.get(a.id).await.file_path.unwrap();
    // The user frees space by deleting the paused partial by hand.
    std::fs::remove_file(format!("{a_path}.part")).unwrap();
    // Another movie with the same title.
    let b = c.start_titled("src", "2", "Movie", &panel.url(2)).await;
    let b_path = b.file_path.clone().unwrap();
    assert_ne!(b_path, a_path, "the paused row keeps its name");
    c.wait_until(b.id, "made progress", |d| {
        d.bytes_downloaded > (2 * MIB) as i64
    })
    .await;
    c.ok("downloads.resume", json!({"id": a.id})).await;
    let b_done = c
        .wait_until(b.id, "completed", |d| {
            assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
            d.status == DownloadStatus::Completed
        })
        .await;
    let a_done = c
        .wait_until(a.id, "completed", |d| {
            assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
            d.status == DownloadStatus::Completed
        })
        .await;
    let (a_file, b_file) = (a_done.file_path.unwrap(), b_done.file_path.unwrap());
    assert_ne!(a_file, b_file);
    dl_panel::is_exact(1, a_size, Path::new(&a_file)).unwrap();
    dl_panel::is_exact(2, b_size, Path::new(&b_file)).unwrap();
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
