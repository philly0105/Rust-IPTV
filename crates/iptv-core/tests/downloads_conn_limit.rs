//! DL-1: downloads follow the source account's connection limit. Against the
//! mock's `limit<N>` Xtream accounts, which refuse a file beyond N open
//! bodies with `403 Max connections reached`, the way panels do.

use iptv_core::model::{Download, DownloadStatus, WaitReason};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::path::Path;
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
    iptv_core::xtream::init(state.clone()).await.unwrap();
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

    /// Size and speed of every file the `limit<N>` accounts serve.
    async fn files(&self, size: u64, kbps: u64) {
        reqwest::get(
            self.srv
                .url(&format!("/__mock/limited-vod?size={size}&kbps={kbps}")),
        )
        .await
        .unwrap();
    }

    /// An Xtream source on the mock account `user`, with its account status
    /// cached the way every sync caches it.
    async fn source(&self, user: &str) -> String {
        let id = format!("xt-{user}");
        let cfg = json!({
            "serverUrl": self.srv.xtream_url(),
            "username": user,
            "password": iptv_fixtures::XTREAM_PASSWORD,
        })
        .to_string();
        let id2 = id.clone();
        self.state
            .db_call(move |conn| {
                conn.execute(
                    "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', 'Mock Xtream', ?2)",
                    rusqlite::params![id2, cfg],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let status = iptv_core::account::status(&self.state, &id, true)
            .await
            .unwrap()
            .unwrap();
        assert!(status.max_connections.is_some());
        id
    }

    fn movie_url(&self, user: &str, item: u32) -> String {
        let pass = iptv_fixtures::XTREAM_PASSWORD;
        self.srv
            .url(&format!("/xtream/movie/{user}/{pass}/{item}.mp4"))
    }

    async fn start(&self, sid: &str, user: &str, item: u32) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": sid, "contentType": "movie", "itemId": item.to_string()},
                    "title": format!("Movie {item}"),
                    "url": self.movie_url(user, item),
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    async fn get(&self, id: i64) -> Download {
        serde_json::from_value(self.ok("downloads.get", json!({"id": id})).await).unwrap()
    }

    async fn list(&self) -> Vec<Download> {
        serde_json::from_value(self.ok("downloads.list", Value::Null).await).unwrap()
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
                d.waiting,
                d.error_message
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn stats(&self) -> Value {
        reqwest::get(self.srv.url("/__mock/stats"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn playback(&self, client: &str, sources: &[&str]) {
        self.ok(
            "downloads.playback",
            json!({"clientId": client, "sourceIds": sources}),
        )
        .await;
    }
}

fn is_mock_content(p: &Path) -> bool {
    let got = std::fs::read(p).unwrap();
    got == iptv_fixtures::video_bytes(0, got.len())
}

#[test]
fn the_budget_keeps_one_connection_for_playback() {
    use iptv_core::downloads::manager::download_budget;
    // No limit (M3U, Stalker, unknown): today's two, whatever plays.
    assert_eq!(download_budget(None, 0, 0), 2);
    assert_eq!(download_budget(Some(0), 3, 1), 2);
    // One connection: downloads only while nothing else uses it.
    assert_eq!(download_budget(Some(1), 0, 0), 1);
    assert_eq!(download_budget(Some(1), 1, 0), 0);
    assert_eq!(download_budget(Some(1), 0, 1), 0);
    // More: all but one, and never what playback and recordings take.
    assert_eq!(download_budget(Some(2), 0, 0), 1);
    assert_eq!(download_budget(Some(2), 1, 0), 1);
    assert_eq!(download_budget(Some(2), 1, 1), 0);
    assert_eq!(download_budget(Some(4), 0, 0), 3);
    assert_eq!(download_budget(Some(4), 2, 0), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_one_connection_account_downloads_a_season_one_file_at_a_time() {
    let c = ctx().await;
    c.files(512 * 1024, 2048).await;
    let sid = c.source("limit1").await;
    let mut ids = Vec::new();
    for item in 101..107 {
        ids.push(c.start(&sid, "limit1", item).await.id);
    }
    let deadline = Instant::now() + WAIT;
    let mut said_connection = false;
    loop {
        let list = c.list().await;
        let running = list
            .iter()
            .filter(|d| d.status == DownloadStatus::Downloading)
            .count();
        assert!(
            running <= 1,
            "{running} transfers on a 1-connection account"
        );
        assert!(
            list.iter().all(|d| d.status != DownloadStatus::Failed),
            "{:?}",
            list.iter().map(|d| &d.error_message).collect::<Vec<_>>()
        );
        // The rows behind the running one say they wait for its connection,
        // never for playback.
        for d in list.iter().filter(|d| d.status == DownloadStatus::Queued) {
            let reason = d.waiting.as_ref().map(|w| w.reason);
            assert_ne!(reason, Some(WaitReason::Playback));
            said_connection |= reason == Some(WaitReason::Connection);
        }
        if list.iter().all(|d| d.status == DownloadStatus::Completed) {
            break;
        }
        assert!(Instant::now() < deadline, "season never finished");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(said_connection);
    for id in ids {
        let d = c.get(id).await;
        assert!(is_mock_content(Path::new(&d.file_path.unwrap())));
    }
    assert_eq!(c.stats().await["requests"]["refused_streams"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn playback_takes_the_connection_from_a_download_and_gives_it_back() {
    let c = ctx().await;
    c.files(4 * 1024 * 1024, 1024).await;
    let sid = c.source("limit1").await;
    let d = c.start(&sid, "limit1", 101).await;
    c.wait_until(d.id, "made progress", |d| {
        d.status == DownloadStatus::Downloading && d.bytes_downloaded > 256 * 1024
    })
    .await;

    // The player starts on the same source: the download yields first.
    c.playback("player-1", &[&sid]).await;
    let waiting = c.get(d.id).await;
    assert_eq!(waiting.status, DownloadStatus::Queued);
    assert_eq!(
        waiting.waiting.as_ref().map(|w| w.reason),
        Some(WaitReason::Playback)
    );
    let kept = waiting.bytes_downloaded;
    assert!(kept > 0);
    let part = format!("{}.part", waiting.file_path.clone().unwrap());
    assert_eq!(std::fs::metadata(&part).unwrap().len(), kept as u64);
    // The player's own request finds the connection free.
    let play = reqwest::get(c.movie_url("limit1", 200)).await.unwrap();
    assert!(play.status().is_success(), "{}", play.status());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);

    // Playback stops: the download resumes from its .part and completes.
    drop(play);
    c.playback("player-1", &[]).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
    assert_eq!(c.stats().await["requests"]["refused_streams"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_row_the_user_paused_stays_paused_when_playback_ends() {
    let c = ctx().await;
    c.files(4 * 1024 * 1024, 1024).await;
    let sid = c.source("limit1").await;
    let d = c.start(&sid, "limit1", 101).await;
    c.wait_until(d.id, "started", |d| d.status == DownloadStatus::Downloading)
        .await;
    c.playback("player-1", &[&sid]).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);
    c.ok("downloads.pause", json!({"id": d.id})).await;
    c.playback("player-1", &[]).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Paused);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_playback_report_that_is_not_renewed_lapses() {
    let c = ctx().await;
    c.files(1024 * 1024, 1024).await;
    iptv_core::downloads::set_playback_lease(&c.state, Duration::from_millis(500));
    let sid = c.source("limit1").await;
    // A player reports playback and then goes away without a word.
    c.playback("crashed-tab", &[&sid]).await;
    let d = c.start(&sid, "limit1", 101).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recording_on_the_source_holds_its_connection() {
    let c = ctx().await;
    c.files(2 * 1024 * 1024, 1024).await;
    let sid = c.source("limit1").await;
    // A recording on the source holds its one connection.
    let recording = iptv_core::downloads::hold_recording(&c.state, &sid).await;
    let d = c.start(&sid, "limit1", 101).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let queued = c.get(d.id).await;
    assert_eq!(queued.status, DownloadStatus::Queued);
    assert_eq!(
        queued.waiting.as_ref().map(|w| w.reason),
        Some(WaitReason::Connection)
    );
    drop(recording);
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_two_connection_account_runs_one_download_and_a_four_runs_three() {
    let c = ctx().await;
    c.files(1024 * 1024, 1024).await;
    for (user, most) in [("limit2", 1), ("limit4", 3)] {
        let sid = c.source(user).await;
        let mut ids = Vec::new();
        for item in 101..105 {
            ids.push(c.start(&sid, user, item).await.id);
        }
        let mut peak = 0;
        loop {
            let list = c.list().await;
            let mine: Vec<&Download> = list
                .iter()
                .filter(|d| d.item_ref.source_id == sid)
                .collect();
            let running = mine
                .iter()
                .filter(|d| d.status == DownloadStatus::Downloading)
                .count();
            peak = peak.max(running);
            assert!(running <= most, "{user}: {running} at once");
            if mine.iter().all(|d| d.status == DownloadStatus::Completed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(peak, most, "{user} used its budget");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refusal_with_working_credentials_waits_for_a_free_connection() {
    let c = ctx().await;
    // Throttled, so the other device's stream stays open until dropped.
    c.files(1024 * 1024, 256).await;
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_millis(300),
        Duration::from_secs(3600),
    );
    let sid = c.source("limit1").await;
    // Another device in the household holds the account's one connection.
    let other = reqwest::get(c.movie_url("limit1", 300)).await.unwrap();
    assert!(other.status().is_success());
    let d = c.start(&sid, "limit1", 101).await;
    let waiting = c
        .wait_until(d.id, "waited", |d| {
            d.waiting
                .as_ref()
                .is_some_and(|w| w.reason == WaitReason::Connection && w.until.is_some())
        })
        .await;
    assert_eq!(waiting.status, DownloadStatus::Queued);
    assert!(waiting.error_message.is_none());
    drop(other);
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
}
