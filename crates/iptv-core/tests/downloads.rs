//! Check 9 (SC7): download manager against the C13 mock range server
//! (`iptv_fixtures::spawn_mock()`: `/files/video.bin`, `/files/flaky.bin`,
//! `/files/nolen.bin`; byte `i` of every file is `iptv_fixtures::video_byte(i)`).

use iptv_core::model::{ContentType, Download, DownloadStatus, ItemRef};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppEvent, AppState, BroadcastSink, RpcErrorCode};
use reqwest::header;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

const WAIT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// Starts the mock and checks the Range contract the transfer relies on.
async fn mock() -> iptv_fixtures::MockHandle {
    let mock = iptv_fixtures::spawn_mock().await;
    let probe = reqwest::Client::new()
        .get(mock.url("/files/video.bin"))
        .header(header::RANGE, "bytes=0-0")
        .send()
        .await
        .expect("mock reachable");
    assert_eq!(
        probe.status(),
        StatusCode::PARTIAL_CONTENT,
        "iptv-mock /files/video.bin must answer Range requests"
    );
    mock
}

struct Ctx {
    _tmp: tempfile::TempDir,
    data_dir: PathBuf,
    state: Arc<AppState>,
    router: RpcRouter,
    events: broadcast::Receiver<AppEvent>,
    srv: iptv_fixtures::MockHandle,
}

async fn ctx() -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let (sink, events) = BroadcastSink::channel(65_536);
    let state = AppState::new(data_dir.clone(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::downloads::init(state.clone()).await.unwrap();
    let mut router = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut router);
    Ctx {
        _tmp: tmp,
        data_dir,
        state,
        router,
        events,
        srv: mock().await,
    }
}

impl Ctx {
    async fn call(&self, cmd: &str, args: Value) -> Result<Value, iptv_core::RpcError> {
        self.router.dispatch(self.state.clone(), cmd, args).await
    }

    async fn ok(&self, cmd: &str, args: Value) -> Value {
        self.call(cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

    async fn start(&self, item: &str, title: &str, path: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": "src", "contentType": "movie", "itemId": item},
                    "title": title,
                    "url": self.srv.url(path),
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    async fn get(&self, id: i64) -> Download {
        serde_json::from_value(self.ok("downloads.get", json!({"id": id})).await).unwrap()
    }

    async fn my_videos(&self) -> Vec<Download> {
        serde_json::from_value(self.ok("myvideos.list", Value::Null).await).unwrap()
    }

    async fn wait_status(&self, id: i64, status: DownloadStatus) -> Download {
        let deadline = Instant::now() + WAIT;
        loop {
            let d = self.get(id).await;
            if d.status == status {
                return d;
            }
            assert!(
                Instant::now() < deadline,
                "download {id} stuck in {:?} (wanted {status:?}): {:?}",
                d.status,
                d.error_message
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Waits for a progress event of `id` with at least `min` bytes.
    async fn wait_progress(&mut self, id: i64, min: i64) -> i64 {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, self.events.recv()).await {
                Ok(Ok(ev)) if ev.kind == "downloads.progress" && ev.payload["id"] == id => {
                    let b = ev.payload["bytesDownloaded"].as_i64().unwrap();
                    assert!(ev.payload["bytesPerSecond"].is_i64());
                    if b >= min {
                        return b;
                    }
                }
                Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Err(e)) => panic!("event channel closed: {e}"),
                Err(_) => panic!("no progress for download {id}"),
            }
        }
    }

    fn drain_events(&mut self) {
        while self.events.try_recv().is_ok() {}
    }

    /// Kinds of the events received since the last drain.
    fn event_kinds(&mut self) -> Vec<String> {
        let mut kinds = Vec::new();
        while let Ok(ev) = self.events.try_recv() {
            kinds.push(ev.kind);
        }
        kinds
    }

    fn downloads_dir(&self) -> PathBuf {
        self.state.downloads_dir()
    }

    /// Requests the mock has served on `path` so far.
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

fn part_of(file_path: &str) -> PathBuf {
    PathBuf::from(format!("{file_path}.part"))
}

fn file_len(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

/// True when the file holds exactly the mock's deterministic bytes.
fn is_mock_content(p: &Path) -> bool {
    let got = std::fs::read(p).unwrap();
    got == iptv_fixtures::video_bytes(0, got.len())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_then_resume_continues_from_byte_offset() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(4 * 1024 * 1024));
    let d = c.start("1", "video", "/files/video.bin").await;
    assert_eq!(d.file_name.as_deref(), Some("video.bin"));
    let file_path = d
        .file_path
        .clone()
        .expect("destination persisted before transfer");
    assert!(part_of(&file_path).is_file(), ".part reserved at start");
    assert!(!Path::new(&file_path).exists(), "final path stays absent");

    c.wait_progress(d.id, 2 * 1024 * 1024).await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    let paused = c.get(d.id).await;
    assert_eq!(paused.status, DownloadStatus::Paused);
    let offset = paused.bytes_downloaded;
    let total = paused.total_bytes.expect("total known from Content-Length");
    assert!(offset > 0 && offset < total, "offset {offset} of {total}");
    assert_eq!(
        file_len(&part_of(&file_path)),
        Some(offset as u64),
        ".part kept on pause"
    );
    assert!(!Path::new(&file_path).exists());

    // Paused stays paused.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.get(d.id).await.bytes_downloaded, offset);

    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.drain_events();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let first_after_resume = c.wait_progress(d.id, 0).await;
    assert!(
        first_after_resume > offset,
        "resume restarted from zero: first progress {first_after_resume} <= offset {offset}"
    );
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(done.file_available, Some(true));
    assert_eq!(done.bytes_downloaded, total);
    assert!(!part_of(&file_path).exists(), ".part renamed away");
    assert_eq!(file_len(Path::new(&file_path)), Some(total as u64));
    assert!(
        is_mock_content(Path::new(&file_path)),
        "byte-exact assembly"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_removes_part() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(2 * 1024 * 1024));
    let d = c.start("1", "video", "/files/video.bin").await;
    let file_path = d.file_path.clone().unwrap();
    c.wait_progress(d.id, 512 * 1024).await;
    assert!(part_of(&file_path).is_file());
    c.ok("downloads.cancel", json!({"id": d.id})).await;
    let canceled = c.get(d.id).await;
    assert_eq!(canceled.status, DownloadStatus::Canceled);
    assert!(!part_of(&file_path).exists(), ".part deleted on cancel");
    assert!(!Path::new(&file_path).exists());
    assert_eq!(canceled.file_path, None);

    // A queued (not yet running) download cancels too, and retry restarts it.
    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.ok("downloads.retry", json!({"id": d.id})).await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(done.file_name.as_deref(), Some("video.bin"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_file_name_twice_gets_numbered() {
    let c = ctx().await;
    let a = c.start("1", "video", "/files/video.bin").await;
    let b = c.start("2", "video", "/files/video.bin").await;
    assert_eq!(a.file_name.as_deref(), Some("video.bin"));
    assert_eq!(b.file_name.as_deref(), Some("video (1).bin"));
    let a = c.wait_status(a.id, DownloadStatus::Completed).await;
    let b = c.wait_status(b.id, DownloadStatus::Completed).await;
    let dir = c.downloads_dir();
    assert_eq!(
        a.file_path.unwrap(),
        dir.join("video.bin").to_string_lossy()
    );
    assert_eq!(
        b.file_path.unwrap(),
        dir.join("video (1).bin").to_string_lossy()
    );
    assert_eq!(
        file_len(&dir.join("video.bin")),
        file_len(&dir.join("video (1).bin"))
    );

    // A third one after both finished: (2).
    let third = c.start("3", "video", "/files/video.bin").await;
    assert_eq!(third.file_name.as_deref(), Some("video (2).bin"));
    c.wait_status(third.id, DownloadStatus::Completed).await;

    // Starting the same item again while its file exists returns it unchanged.
    let again = c.start("1", "video", "/files/video.bin").await;
    assert_eq!(again.id, a.id);
    assert_eq!(again.status, DownloadStatus::Completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn flaky_endpoint_retries_and_completes() {
    let c = ctx().await;
    let d = c.start("1", "flaky", "/files/flaky.bin").await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    let path = done.file_path.unwrap();
    assert_eq!(done.total_bytes, Some(iptv_fixtures::VIDEO_BIN_LEN as i64));
    assert_eq!(
        file_len(Path::new(&path)),
        Some(iptv_fixtures::VIDEO_BIN_LEN)
    );
    const _: () = assert!(iptv_fixtures::VIDEO_BIN_LEN > iptv_fixtures::FLAKY_DROP_AFTER);
    assert!(
        is_mock_content(Path::new(&path)),
        "flaky download byte-exact"
    );
    assert!(!part_of(&path).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_body_reconnects_after_the_idle_limit() {
    let c = ctx().await;
    iptv_core::downloads::set_idle_timeout(&c.state, Some(Duration::from_millis(500)));
    // The first response stops sending after 5 MiB and keeps the connection
    // open; without an idle limit the transfer would sit there for the
    // client's 60 s read timeout.
    let started = Instant::now();
    let d = c
        .start(
            "1",
            "stall",
            "/files/flaky.bin?key=stall-once&stall=1&size=8388608",
        )
        .await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    let took = started.elapsed();
    let path = done.file_path.unwrap();
    assert!(is_mock_content(Path::new(&path)), "resumed byte-exact");
    assert_eq!(file_len(Path::new(&path)), Some(8 * 1024 * 1024));
    assert_eq!(c.requests("/files/flaky.bin").await, 2, "one reconnect");
    assert!(took < Duration::from_secs(15), "stall cost {took:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_server_that_sends_a_few_bytes_then_stalls_is_not_retried_forever() {
    let c = ctx().await;
    iptv_core::downloads::set_idle_timeout(&c.state, Some(Duration::from_millis(300)));
    // A timeout is an outage: after its run the row waits for its source
    // (long here, so the test can look at it).
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_secs(60),
        Duration::from_secs(3600),
    );
    // `stall.m3u` sends 8 bytes with no length and then hangs, so every
    // attempt restarts from zero and re-reads the same 8 bytes: that is not
    // progress, and the run ends after 5 attempts.
    let d = c.start("1", "stall", "/fail/stall.m3u").await;
    let deadline = Instant::now() + WAIT;
    let waiting = loop {
        let d = c.get(d.id).await;
        if d.waiting.is_some() {
            break d;
        }
        assert!(Instant::now() < deadline, "never waited: {:?}", d.status);
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(waiting.status, DownloadStatus::Queued);
    let wait = waiting.waiting.unwrap();
    assert_eq!(wait.reason, iptv_core::model::WaitReason::Provider);
    assert!(wait.until.is_some());
    assert_eq!(
        c.requests("/fail/stall.m3u").await,
        u64::from(iptv_core::downloads::transfer::MAX_ATTEMPTS)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_row_that_waits_too_long_for_its_source_fails_with_the_reason() {
    let c = ctx().await;
    iptv_core::downloads::set_idle_timeout(&c.state, Some(Duration::from_millis(200)));
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_millis(100),
        Duration::from_millis(1500),
    );
    let d = c.start("1", "stall", "/fail/stall.m3u").await;
    let failed = c.wait_status(d.id, DownloadStatus::Failed).await;
    assert!(
        c.requests("/fail/stall.m3u").await
            > u64::from(iptv_core::downloads::transfer::MAX_ATTEMPTS)
    );
    assert!(
        failed
            .error_message
            .as_deref()
            .unwrap_or("")
            .contains("stopped sending data"),
        "{:?}",
        failed.error_message
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_claim_is_retried_instead_of_leaving_the_row_queued() {
    let c = ctx().await;
    // Every claim of the first run fails, so the id goes back in the queue
    // after the retry delay, and the next run's first claim fails as well.
    let attempts = iptv_core::downloads::manager::CLAIM_ATTEMPTS;
    iptv_core::downloads::fail_next_claims(&c.state, attempts + 1, Duration::from_millis(200));
    let d = c.start("1", "claim", "/files/video.bin?size=1048576").await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn download_next_takes_the_next_free_slot_and_keeps_its_place() {
    let c = ctx().await;
    // a frees its slot after about 0.5 s; b holds the other for about 4 s.
    let a = c
        .start("a", "a", "/files/video.bin?size=262144&kbps=512")
        .await;
    let b = c
        .start("b", "b", "/files/video.bin?size=2097152&kbps=512")
        .await;
    let older = c
        .start("c", "c", "/files/video.bin?size=1048576&kbps=1024")
        .await;
    let next = c
        .start("d", "d", "/files/video.bin?size=1048576&kbps=1024")
        .await;
    c.ok("downloads.prioritize", json!({"id": next.id})).await;

    // The saved order (what init restores) lists it ahead of the older row.
    let deadline = Instant::now() + WAIT;
    loop {
        let order = c
            .state
            .db_call(|conn| iptv_core::downloads::store::load_queue_order(conn))
            .await
            .unwrap();
        let at = |id: i64| order.iter().position(|x| *x == id);
        if matches!((at(next.id), at(older.id)), (Some(n), Some(o)) if n < o) {
            break;
        }
        assert!(Instant::now() < deadline, "order never saved: {order:?}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    c.wait_status(next.id, DownloadStatus::Downloading).await;
    assert_eq!(c.get(older.id).await.status, DownloadStatus::Queued);
    assert_eq!(c.get(b.id).await.status, DownloadStatus::Downloading);
    for id in [a.id, b.id, older.id, next.id] {
        c.wait_status(id, DownloadStatus::Completed).await;
    }

    // Only a queued row can move ahead.
    let paused = c
        .start("e", "e", "/files/video.bin?size=1048576&kbps=64")
        .await;
    c.ok("downloads.pause", json!({"id": paused.id})).await;
    let err = c
        .call("downloads.prioritize", json!({"id": paused.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Conflict);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_outage_requeues_rows_and_the_queue_completes_after_it() {
    let c = ctx().await;
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_secs(1),
        Duration::from_secs(3600),
    );
    let mut ids = Vec::new();
    for i in 0..6 {
        let path = format!("/files/video.bin?size=1048576&kbps=1024&n={i}");
        ids.push(c.start(&i.to_string(), "outage", &path).await.id);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Longer than a run's in-task retries (about 4.5 s).
    reqwest::get(c.srv.url("/__mock/outage?ms=6000"))
        .await
        .unwrap();
    let deadline = Instant::now() + WAIT;
    let mut waited = false;
    loop {
        let list: Vec<Download> =
            serde_json::from_value(c.ok("downloads.list", Value::Null).await).unwrap();
        assert!(
            list.iter().all(|d| d.status != DownloadStatus::Failed),
            "{:?}",
            list.iter().map(|d| &d.error_message).collect::<Vec<_>>()
        );
        waited |= list.iter().any(|d| {
            d.waiting
                .as_ref()
                .is_some_and(|w| w.reason == iptv_core::model::WaitReason::Provider)
        });
        if list.iter().all(|d| d.status == DownloadStatus::Completed) {
            break;
        }
        assert!(Instant::now() < deadline, "queue never finished");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(waited, "rows said they wait for the provider");
    for id in ids {
        assert!(is_mock_content(Path::new(
            &c.get(id).await.file_path.unwrap()
        )));
    }
    // A missing file still fails at once: only the source waits.
    let missing = c.start("missing", "missing", "/fail/404.m3u").await;
    c.wait_status(missing.id, DownloadStatus::Failed).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn existing_destination_is_never_overwritten() {
    let mut c = ctx().await;
    let dir = c.downloads_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("video.bin"), b"user file").unwrap();

    let d = c.start("1", "video", "/files/video.bin").await;
    assert_eq!(d.file_name.as_deref(), Some("video (1).bin"));
    c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(std::fs::read(dir.join("video.bin")).unwrap(), b"user file");

    // The recorded destination gets occupied while the download is paused.
    iptv_core::downloads::set_rate_limit(&c.state, Some(4 * 1024 * 1024));
    let p = c.start("2", "movie", "/files/video.bin").await;
    let recorded = p.file_path.clone().unwrap();
    c.wait_progress(p.id, 1024 * 1024).await;
    c.ok("downloads.pause", json!({"id": p.id})).await;
    std::fs::write(&recorded, b"created while paused").unwrap();
    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.ok("downloads.resume", json!({"id": p.id})).await;
    let done = c.wait_status(p.id, DownloadStatus::Completed).await;
    assert_eq!(std::fs::read(&recorded).unwrap(), b"created while paused");
    assert_eq!(done.file_name.as_deref(), Some("movie (1).bin"));
    assert_ne!(done.file_path.as_deref(), Some(recorded.as_str()));
    assert!(done.file_available.unwrap());
    let total = done.total_bytes.unwrap() as u64;
    assert_eq!(
        file_len(Path::new(done.file_path.as_deref().unwrap())),
        Some(total)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nolen_downloads_without_resume() {
    let c = ctx().await;
    let d = c.start("1", "nolen", "/files/nolen.bin").await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    let path = PathBuf::from(done.file_path.unwrap());
    assert_eq!(file_len(&path), Some(iptv_fixtures::NOLEN_LEN));
    assert_eq!(done.total_bytes, Some(iptv_fixtures::NOLEN_LEN as i64));
    assert!(is_mock_content(&path));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_two_transfers_run_at_once() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(1024 * 1024));
    let a = c.start("1", "a", "/files/video.bin").await;
    let b = c.start("2", "b", "/files/video.bin").await;
    let third = c.start("3", "c", "/files/video.bin").await;
    c.wait_progress(a.id, 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let list: Vec<Download> =
        serde_json::from_value(c.ok("downloads.list", Value::Null).await).unwrap();
    let running = list
        .iter()
        .filter(|d| d.status == DownloadStatus::Downloading)
        .count();
    assert_eq!(running, 2, "{list:?}");
    assert_eq!(c.get(third.id).await.status, DownloadStatus::Queued);

    // Pausing a queued row works without it ever starting.
    c.ok("downloads.pause", json!({"id": third.id})).await;
    assert_eq!(c.get(third.id).await.status, DownloadStatus::Paused);
    for id in [a.id, b.id] {
        c.ok("downloads.cancel", json!({"id": id})).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(c.get(third.id).await.status, DownloadStatus::Paused);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_restored_on_init_and_resumes_partial() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(4 * 1024 * 1024));
    let d = c.start("1", "video", "/files/video.bin").await;
    c.wait_progress(d.id, 1024 * 1024).await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    let offset = c.get(d.id).await.bytes_downloaded;
    // Simulate a crash mid-transfer.
    c.state
        .db_call(move |conn| {
            conn.execute(
                "UPDATE downloads SET status = 'downloading' WHERE id = ?1",
                [d.id],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let (sink, mut events) = BroadcastSink::channel(65_536);
    let state2 = AppState::new(c.data_dir.clone(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::downloads::init(state2.clone()).await.unwrap();
    let deadline = Instant::now() + WAIT;
    let mut first = None;
    loop {
        let d2 = iptv_core::downloads::get(&state2, d.id).await.unwrap();
        while let Ok(ev) = events.try_recv() {
            if ev.kind == "downloads.progress" && first.is_none() {
                first = ev.payload["bytesDownloaded"].as_i64();
            }
        }
        if d2.status == DownloadStatus::Completed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "restored download did not finish"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        first.unwrap_or(i64::MAX) > offset,
        "restored transfer resumed from its .part"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn my_videos_play_source_and_remove() {
    let c = ctx().await;
    let d = c.start("1", "video", "/files/video.bin").await;
    c.wait_status(d.id, DownloadStatus::Completed).await;

    let vids: Vec<Download> =
        serde_json::from_value(c.ok("myvideos.list", Value::Null).await).unwrap();
    assert_eq!(vids.len(), 1);
    assert_eq!(vids[0].file_available, Some(true));

    let src = c.ok("myvideos.playSource", json!({"id": d.id})).await;
    assert_eq!(src["kind"], "file");
    assert_eq!(src["url"], format!("/api/files/{}", d.id));
    assert_eq!(src["isLive"], false);
    assert_eq!(src["title"], "video");

    c.ok(
        "downloads.setPosition",
        json!({"id": d.id, "positionSeconds": 42.4}),
    )
    .await;
    let src = c.ok("myvideos.playSource", json!({"id": d.id})).await;
    assert_eq!(src["resumeSeconds"], 42);

    // Missing file: availability derived on read, status unchanged.
    let path = c.get(d.id).await.file_path.unwrap();
    std::fs::rename(&path, format!("{path}.moved")).unwrap();
    let missing = c.get(d.id).await;
    assert_eq!(missing.status, DownloadStatus::Completed);
    assert_eq!(missing.file_available, Some(false));
    let err = c
        .call("myvideos.playSource", json!({"id": d.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    std::fs::rename(format!("{path}.moved"), &path).unwrap();

    // Server mode cannot reveal.
    let err = c
        .call("downloads.reveal", json!({"id": d.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Unsupported);

    // remove without deleteFile keeps the media; with deleteFile removes it.
    c.ok("downloads.remove", json!({"id": d.id, "deleteFile": false}))
        .await;
    assert!(Path::new(&path).is_file());
    let d2 = c.start("2", "video", "/files/video.bin").await;
    let d2 = c.wait_status(d2.id, DownloadStatus::Completed).await;
    let p2 = d2.file_path.unwrap();
    assert_ne!(p2, path);
    c.ok("downloads.remove", json!({"id": d2.id, "deleteFile": true}))
        .await;
    assert!(!Path::new(&p2).exists());
    let err = c
        .call("downloads.get", json!({"id": d2.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_dir_validates_and_applies() {
    let c = ctx().await;
    let default_dir = c.ok("downloads.dir", Value::Null).await;
    assert_eq!(
        PathBuf::from(default_dir["path"].as_str().unwrap()),
        c.data_dir.join("downloads")
    );

    let missing = c.data_dir.join("nope");
    let err = c
        .call(
            "downloads.setDir",
            json!({"path": missing.to_string_lossy()}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    let err = c
        .call("downloads.setDir", json!({"path": "relative/dir"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);

    let custom = c.data_dir.join("custom");
    std::fs::create_dir_all(&custom).unwrap();
    c.ok(
        "downloads.setDir",
        json!({"path": custom.to_string_lossy()}),
    )
    .await;
    let now = c.ok("downloads.dir", Value::Null).await;
    assert_eq!(PathBuf::from(now["path"].as_str().unwrap()), custom);
    assert_eq!(
        c.state.settings_snapshot().downloads_dir.as_deref(),
        Some(custom.to_string_lossy().as_ref())
    );
    let leftovers = std::fs::read_dir(&custom).unwrap().count();
    assert_eq!(leftovers, 0, "write probe cleaned up");

    let d = c.start("1", "video", "/files/video.bin").await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert!(Path::new(done.file_path.as_deref().unwrap()).starts_with(&custom));

    // Empty path resets to the default.
    c.ok("downloads.setDir", json!({"path": ""})).await;
    assert_eq!(c.state.downloads_dir(), c.data_dir.join("downloads"));
}

#[tokio::test]
async fn start_validates_input() {
    let c = ctx().await;
    let bad = c
        .call(
            "downloads.start",
            json!({"ref": {"sourceId": "s", "contentType": "movie", "itemId": "1"}, "title": "x", "url": "file:///etc/passwd"}),
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, RpcErrorCode::Invalid);
    let bad = c
        .call(
            "downloads.start",
            json!({"ref": {"sourceId": "s", "contentType": "movie", "itemId": "1"}, "title": "  ", "url": "http://x/y.mp4"}),
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, RpcErrorCode::Invalid);
    let _ = ItemRef::new("s", ContentType::Movie, "1");
}

#[test]
fn every_c4_download_command_is_registered() {
    let mut r = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut r);
    let expected = [
        "downloads.list",
        "downloads.get",
        "downloads.start",
        "downloads.pause",
        "downloads.resume",
        "downloads.cancel",
        "downloads.retry",
        "downloads.remove",
        "downloads.reveal",
        "downloads.setDir",
        "downloads.dir",
        "downloads.setPosition",
        "downloads.prioritize",
        "downloads.playback",
        "myvideos.list",
        "myvideos.playSource",
    ];
    for name in expected {
        assert!(r.contains(name), "{name} missing");
    }
    assert_eq!(r.names().len(), expected.len(), "no extra commands");
}

// ---------------------------------------------------------------------------
// Fix round 1: retry, queued pause, availability, remove, setDir, rate limit
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retry_redownloads_completed_item_whose_file_was_deleted() {
    let c = ctx().await;
    let d = c.start("1", "video", "/files/video.bin").await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    let path = PathBuf::from(done.file_path.clone().unwrap());

    // With the file in place, retry is refused and changes nothing.
    let err = c
        .call("downloads.retry", json!({"id": d.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Conflict);
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Completed);

    std::fs::remove_file(&path).unwrap();
    let vids = c.my_videos().await;
    assert_eq!(vids.len(), 1);
    assert_eq!(
        vids[0].file_available,
        Some(false),
        "myvideos.list on a missing file"
    );
    assert_eq!(vids[0].status, DownloadStatus::Completed);

    c.ok("downloads.retry", json!({"id": d.id})).await;
    let again = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(again.id, d.id, "same row");
    assert_eq!(again.file_name.as_deref(), Some("video.bin"), "same name");
    assert_eq!(again.file_path, done.file_path);
    assert_eq!(again.file_available, Some(true));
    assert_eq!(again.bytes_downloaded, iptv_fixtures::VIDEO_BIN_LEN as i64);
    assert!(is_mock_content(&path));
    assert!(!part_of(&path.to_string_lossy()).exists());
    assert_eq!(c.my_videos().await[0].file_available, Some(true));

    // A file replaced by a folder counts as gone too, and the folder is
    // never touched: the re-download takes the next free name.
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(c.get(d.id).await.file_available, Some(false));
    c.ok("downloads.retry", json!({"id": d.id})).await;
    let third = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(third.file_name.as_deref(), Some("video (1).bin"));
    assert!(path.is_dir());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_on_queued_item_never_starts_until_resumed() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(2 * 1024 * 1024));
    let a = c.start("1", "a", "/files/video.bin").await;
    let b = c.start("2", "b", "/files/video.bin").await;
    let q = c.start("3", "q", "/files/video.bin").await;
    c.wait_progress(a.id, 1).await;
    assert_eq!(c.get(q.id).await.status, DownloadStatus::Queued);

    c.ok("downloads.pause", json!({"id": q.id})).await;
    assert_eq!(c.get(q.id).await.status, DownloadStatus::Paused);
    // Idempotent.
    c.ok("downloads.pause", json!({"id": q.id})).await;

    // Both slots free up; the paused row must not be picked up.
    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.wait_status(a.id, DownloadStatus::Completed).await;
    c.wait_status(b.id, DownloadStatus::Completed).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let still = c.get(q.id).await;
    assert_eq!(still.status, DownloadStatus::Paused);
    assert_eq!(still.bytes_downloaded, 0);
    let qpath = still
        .file_path
        .clone()
        .expect("destination reserved at start");
    assert_eq!(
        file_len(&part_of(&qpath)),
        Some(0),
        "reserved .part untouched"
    );

    c.ok("downloads.resume", json!({"id": q.id})).await;
    let done = c.wait_status(q.id, DownloadStatus::Completed).await;
    assert_eq!(done.file_path.as_deref(), Some(qpath.as_str()));
    assert!(is_mock_content(Path::new(&qpath)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remove_with_delete_file_deletes_media_and_part() {
    let mut c = ctx().await;

    // Paused: the .part goes, the final path was never created.
    iptv_core::downloads::set_rate_limit(&c.state, Some(2 * 1024 * 1024));
    let p = c.start("1", "partial", "/files/video.bin").await;
    let ppath = p.file_path.clone().unwrap();
    c.wait_progress(p.id, 256 * 1024).await;
    c.ok("downloads.pause", json!({"id": p.id})).await;
    assert!(file_len(&part_of(&ppath)).unwrap() > 0);
    c.ok("downloads.remove", json!({"id": p.id, "deleteFile": true}))
        .await;
    assert!(!part_of(&ppath).exists(), ".part deleted");
    assert!(!Path::new(&ppath).exists());
    let err = c
        .call("downloads.get", json!({"id": p.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);

    // Running: the transfer stops first, then everything goes.
    let r = c.start("2", "running", "/files/video.bin").await;
    let rpath = r.file_path.clone().unwrap();
    c.wait_progress(r.id, 256 * 1024).await;
    c.ok("downloads.remove", json!({"id": r.id, "deleteFile": true}))
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!part_of(&rpath).exists(), "running .part deleted");
    assert!(!Path::new(&rpath).exists());

    // Completed, with a stray .part next to it: both go.
    iptv_core::downloads::set_rate_limit(&c.state, None);
    let d = c.start("3", "done", "/files/video.bin").await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    let path = done.file_path.unwrap();
    std::fs::write(part_of(&path), b"stray").unwrap();
    c.ok("downloads.remove", json!({"id": d.id, "deleteFile": true}))
        .await;
    assert!(!Path::new(&path).exists(), "media deleted");
    assert!(!part_of(&path).exists(), ".part deleted");
    assert!(c.my_videos().await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remove_without_delete_file_keeps_the_partial_file() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(2 * 1024 * 1024));
    let p = c.start("1", "partial", "/files/video.bin").await;
    let ppath = p.file_path.clone().unwrap();
    c.wait_progress(p.id, 256 * 1024).await;
    c.ok("downloads.pause", json!({"id": p.id})).await;
    let kept = file_len(&part_of(&ppath)).unwrap();
    assert!(kept > 0);
    c.ok("downloads.remove", json!({"id": p.id, "deleteFile": false}))
        .await;
    assert_eq!(file_len(&part_of(&ppath)), Some(kept), ".part kept");
    let err = c
        .call("downloads.get", json!({"id": p.id}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound, "row removed");

    // A new download of the same item reserves its own file.
    let again = c.start("1", "partial", "/files/video.bin").await;
    assert_ne!(again.file_path.as_deref(), Some(ppath.as_str()));
    assert_eq!(
        file_len(&part_of(&ppath)),
        Some(kept),
        "kept .part untouched"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_dir_persists_through_settings_save() {
    let mut c = ctx().await;
    let custom = c.data_dir.join("library");
    std::fs::create_dir_all(&custom).unwrap();
    c.drain_events();
    c.ok(
        "downloads.setDir",
        json!({"path": custom.to_string_lossy()}),
    )
    .await;
    let changed = c
        .event_kinds()
        .iter()
        .filter(|k| *k == "settings.changed")
        .count();
    assert_eq!(changed, 1, "settings.changed emitted once");

    // Same folder again: nothing changes, no event.
    c.ok(
        "downloads.setDir",
        json!({"path": custom.to_string_lossy()}),
    )
    .await;
    assert!(!c.event_kinds().iter().any(|k| k == "settings.changed"));

    // Persisted: a fresh AppState on the same data dir sees it.
    let reopened = AppState::new(c.data_dir.clone(), Arc::new(iptv_core::NoopSink), false)
        .await
        .unwrap();
    assert_eq!(reopened.downloads_dir(), custom);
    drop(reopened);

    // A file is not a folder.
    let file = c.data_dir.join("not-a-dir.txt");
    std::fs::write(&file, b"x").unwrap();
    let err = c
        .call("downloads.setDir", json!({"path": file.to_string_lossy()}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    assert_eq!(
        c.downloads_dir(),
        custom,
        "rejected path leaves settings alone"
    );

    // Reset to the default.
    c.ok("downloads.setDir", json!({"path": "  "})).await;
    assert_eq!(c.downloads_dir(), c.data_dir.join("downloads"));
    assert!(c.state.settings_snapshot().downloads_dir.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rate_limit_change_applies_to_running_transfer() {
    let mut c = ctx().await;
    // 20 MiB at 256 KiB/s would take about 80 s.
    iptv_core::downloads::set_rate_limit(&c.state, Some(256 * 1024));
    let d = c.start("1", "video", "/files/video.bin").await;
    c.wait_progress(d.id, 64 * 1024).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let slow = c.get(d.id).await.bytes_downloaded;
    assert!(
        slow < 2 * 1024 * 1024,
        "limit not applied: {slow} bytes after about 0.5 s"
    );

    let lifted = Instant::now();
    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.wait_status(d.id, DownloadStatus::Completed).await;
    assert!(
        lifted.elapsed() < Duration::from_secs(20),
        "lifting the limit did not speed up the running transfer ({:?})",
        lifted.elapsed()
    );

    // The other way: a cap set mid-transfer slows a running download.
    let e = c
        .start("2", "capped", "/files/video.bin?size=209715200")
        .await;
    c.wait_progress(e.id, 1).await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(128 * 1024));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a = c.get(e.id).await;
    assert_eq!(a.status, DownloadStatus::Downloading);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let b = c.get(e.id).await.bytes_downloaded;
    let moved = b - a.bytes_downloaded;
    assert!(
        moved < 1024 * 1024,
        "cap not applied in flight: {moved} bytes in about 1 s"
    );
    c.ok("downloads.cancel", json!({"id": e.id})).await;
}

/// Holds the SQLite write lock from a separate connection for `hold`, so a
/// stopping transfer cannot persist its final state until it is released.
fn hold_write_lock(state: &AppState, hold: Duration) -> std::thread::JoinHandle<()> {
    let path = state.db_path();
    let (tx, rx) = std::sync::mpsc::channel();
    let h = std::thread::spawn(move || {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        tx.send(()).unwrap();
        std::thread::sleep(hold);
        conn.execute_batch("COMMIT").unwrap();
    });
    rx.recv().unwrap();
    h
}

async fn add_xtream_source(c: &Ctx, password: &str) -> String {
    iptv_core::xtream::init(c.state.clone()).await.unwrap();
    let id = "xt-dl".to_string();
    let cfg = json!({
        "serverUrl": c.srv.xtream_url(),
        "username": iptv_fixtures::XTREAM_USERNAME,
        "password": password,
    })
    .to_string();
    let id2 = id.clone();
    c.state
        .db_call(move |conn| {
            conn.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', 'Mock Xtream', ?2)",
                rusqlite::params![id2, cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    id
}

async fn set_xtream_password(c: &Ctx, sid: &str, password: &str) {
    let cfg = json!({
        "serverUrl": c.srv.xtream_url(),
        "username": iptv_fixtures::XTREAM_USERNAME,
        "password": password,
    })
    .to_string();
    let sid = sid.to_string();
    c.state
        .db_call(move |conn| {
            conn.execute(
                "UPDATE sources SET config_json = ?2 WHERE id = ?1",
                rusqlite::params![sid, cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xtream_retry_after_password_edit_re_resolves_url() {
    let c = ctx().await;
    let sid = add_xtream_source(&c, "old-password").await;
    let user = iptv_fixtures::XTREAM_USERNAME;
    let stale = c
        .srv
        .url(&format!("/xtream/movie/{user}/old-password/101.mp4"));
    let d: Download = serde_json::from_value(
        c.ok(
            "downloads.start",
            json!({
                "ref": {"sourceId": sid, "contentType": "movie", "itemId": "101"},
                "title": "Movie 101",
                "url": stale,
            }),
        )
        .await,
    )
    .unwrap();
    let failed = c.wait_status(d.id, DownloadStatus::Failed).await;
    assert!(
        failed
            .error_message
            .as_deref()
            .unwrap_or("")
            .contains("credentials"),
        "{:?}",
        failed.error_message
    );

    // The user fixes the password on the source; the row still holds the old URL.
    set_xtream_password(&c, &sid, iptv_fixtures::XTREAM_PASSWORD).await;
    assert_eq!(c.get(d.id).await.url, stale);
    c.ok("downloads.retry", json!({"id": d.id})).await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(done.file_available, Some(true));
    assert!(done.bytes_downloaded > 0);
    let pass = iptv_fixtures::XTREAM_PASSWORD;
    assert!(
        done.url.contains(&format!("/{user}/{pass}/101.")),
        "re-resolved URL persisted: {}",
        done.url
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xtream_start_with_stale_url_uses_current_credentials() {
    let c = ctx().await;
    let sid = add_xtream_source(&c, iptv_fixtures::XTREAM_PASSWORD).await;
    let user = iptv_fixtures::XTREAM_USERNAME;
    let d: Download = serde_json::from_value(
        c.ok(
            "downloads.start",
            json!({
                "ref": {"sourceId": sid, "contentType": "movie", "itemId": "7"},
                "title": "Movie 7",
                "url": c.srv.url(&format!("/xtream/movie/{user}/expired/7.mp4")),
            }),
        )
        .await,
    )
    .unwrap();
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(done.file_available, Some(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xtream_catchup_download_keeps_its_archive_url() {
    let c = ctx().await;
    let sid = add_xtream_source(&c, iptv_fixtures::XTREAM_PASSWORD).await;
    // A catch-up programme: a live ref, so re-resolving would give the live stream.
    let url = c.srv.url("/files/video.bin?size=65536");
    let d: Download = serde_json::from_value(
        c.ok(
            "downloads.start",
            json!({
                "ref": {"sourceId": sid, "contentType": "live", "itemId": "1"},
                "episodeId": "catchup:2026-10-18T20:00:00Z",
                "title": "Channel 1",
                "subtitle": "Evening news",
                "url": url,
            }),
        )
        .await,
    )
    .unwrap();
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    assert_eq!(done.url, url, "the archive URL is kept");
    assert_eq!(done.file_available, Some(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_timeout_leaves_row_consistent_and_second_pause_succeeds() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(2 * 1024 * 1024));
    iptv_core::downloads::set_stop_timeout(&c.state, Some(Duration::from_millis(300)));
    let d = c.start("1", "video", "/files/video.bin").await;
    let file_path = d.file_path.clone().unwrap();
    c.wait_progress(d.id, 256 * 1024).await;

    let lock = hold_write_lock(&c.state, Duration::from_millis(1500));
    let err = c
        .call("downloads.pause", json!({"id": d.id}))
        .await
        .expect_err("pause must time out while the final state cannot be written");
    assert_eq!(err.code, RpcErrorCode::Timeout);
    // Not reported as paused before it is; the .part is untouched.
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Downloading);
    assert!(part_of(&file_path).is_file());
    lock.join().unwrap();

    c.ok("downloads.pause", json!({"id": d.id})).await;
    let paused = c.wait_status(d.id, DownloadStatus::Paused).await;
    assert!(paused.bytes_downloaded > 0);
    assert_eq!(
        file_len(&part_of(&file_path)),
        Some(paused.bytes_downloaded as u64)
    );
    // Pausing again is a no-op; resume still works.
    c.ok("downloads.pause", json!({"id": d.id})).await;
    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.ok("downloads.resume", json!({"id": d.id})).await;
    c.wait_status(d.id, DownloadStatus::Completed).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_after_timed_out_pause_ends_canceled() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(2 * 1024 * 1024));
    iptv_core::downloads::set_stop_timeout(&c.state, Some(Duration::from_millis(300)));
    let d = c.start("1", "video", "/files/video.bin").await;
    let file_path = d.file_path.clone().unwrap();
    c.wait_progress(d.id, 256 * 1024).await;

    let lock = hold_write_lock(&c.state, Duration::from_millis(1500));
    let err = c
        .call("downloads.pause", json!({"id": d.id}))
        .await
        .expect_err("pause times out");
    assert_eq!(err.code, RpcErrorCode::Timeout);
    // A cancel issued while the pause is still pending times out too...
    let err = c
        .call("downloads.cancel", json!({"id": d.id}))
        .await
        .expect_err("cancel times out while the lock is held");
    assert_eq!(err.code, RpcErrorCode::Timeout);
    lock.join().unwrap();

    // ...and wins over the pause: the row ends canceled, not paused.
    c.ok("downloads.cancel", json!({"id": d.id})).await;
    let canceled = c.wait_status(d.id, DownloadStatus::Canceled).await;
    assert_eq!(canceled.file_path, None);
    assert!(!part_of(&file_path).exists(), ".part deleted on cancel");
}

/// B9: following the disk-full advice (choose another downloads folder, then
/// retry) continues in the new folder instead of failing again in the old.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_after_changing_the_downloads_folder_continues_there() {
    let mut c = ctx().await;
    iptv_core::downloads::set_rate_limit(&c.state, Some(4 * 1024 * 1024));
    let d = c.start("1", "video", "/files/video.bin").await;
    let old_path = d.file_path.clone().unwrap();
    c.wait_progress(d.id, 1024 * 1024).await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    assert!(part_of(&old_path).is_file());

    let new_dir = c.data_dir.join("elsewhere");
    c.state.settings.write().downloads_dir = Some(new_dir.to_string_lossy().into_owned());
    iptv_core::downloads::set_rate_limit(&c.state, None);
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let done = c.wait_status(d.id, DownloadStatus::Completed).await;
    let new_path = PathBuf::from(done.file_path.clone().unwrap());
    assert!(new_path.starts_with(&new_dir), "{new_path:?}");
    assert!(is_mock_content(&new_path), "byte-exact after the move");
    assert!(!part_of(&old_path).exists(), "old partial moved or removed");
}

/// B9: a start that cannot reserve its file leaves no queued row behind, and
/// the next start (after fixing the folder) runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_start_leaves_no_stuck_row() {
    let c = ctx().await;
    // The downloads "folder" is a file: creating it fails.
    let blocker = c.data_dir.join("not-a-dir");
    std::fs::create_dir_all(&c.data_dir).unwrap();
    std::fs::write(&blocker, b"x").unwrap();
    c.state.settings.write().downloads_dir =
        Some(blocker.join("sub").to_string_lossy().into_owned());
    let args = json!({
        "ref": {"sourceId": "src", "contentType": "movie", "itemId": "9"},
        "title": "video",
        "url": c.srv.url("/files/video.bin"),
    });
    let err = c.call("downloads.start", args.clone()).await.unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Io, "{err:?}");
    let listed = c.ok("downloads.list", Value::Null).await;
    assert_eq!(listed.as_array().map(Vec::len), Some(0), "{listed}");

    c.state.settings.write().downloads_dir = None;
    let d: Download = serde_json::from_value(c.ok("downloads.start", args).await).unwrap();
    c.wait_status(d.id, DownloadStatus::Completed).await;
}

/// D8 (review round 1): two concurrent `downloads.start` calls for the same
/// item both succeed with one row, and the download finishes (no "database
/// is locked", no duplicate or stuck row).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_starts_of_one_item_make_one_row() {
    let c = ctx().await;
    for n in 0..8 {
        let args = json!({
            "ref": {"sourceId": "src", "contentType": "movie", "itemId": format!("c{n}")},
            "title": format!("video {n}"),
            "url": c.srv.url("/files/video.bin"),
        });
        let (a, b) = tokio::join!(
            c.call("downloads.start", args.clone()),
            c.call("downloads.start", args.clone())
        );
        let a: Download = serde_json::from_value(a.expect("first start")).unwrap();
        let b: Download = serde_json::from_value(b.expect("second start")).unwrap();
        assert_eq!(a.id, b.id, "one row per item");
    }
    let listed: Vec<Download> =
        serde_json::from_value(c.ok("downloads.list", Value::Null).await).unwrap();
    assert_eq!(listed.len(), 8, "{listed:?}");
    for d in listed {
        c.wait_status(d.id, DownloadStatus::Completed).await;
    }
}
