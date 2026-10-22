//! DL-1: downloads follow the source account's connection limit. Against the
//! mock's `limit<N>` Xtream accounts, which refuse a file beyond N open
//! bodies with `403 Max connections reached`, the way panels do, and
//! `dl_panel` where a test needs to hold a response head back.

mod dl_panel;

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
        self.start_url(sid, item, &self.movie_url(user, item)).await
    }

    async fn start_url(&self, sid: &str, item: u32, url: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": sid, "contentType": "movie", "itemId": item.to_string()},
                    "title": format!("Movie {item}"),
                    "url": url,
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    /// Caches an account status allowing `n` connections for a source with
    /// no row of its own (a download from `dl_panel`).
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

/// Holds the SQLite write lock from a separate connection for `hold`, the
/// way an import's save does.
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
async fn a_download_yielding_to_playback_closes_its_connection_before_saving() {
    let c = ctx().await;
    c.files(4 * 1024 * 1024, 512).await;
    let sid = c.source("limit1").await;
    let d = c.start(&sid, "limit1", 101).await;
    c.wait_until(d.id, "made progress", |d| {
        d.status == DownloadStatus::Downloading && d.bytes_downloaded > 256 * 1024
    })
    .await;
    // An import holds the write lock: the yielding download cannot save its
    // progress for longer than playback waits for it.
    let lock = hold_write_lock(&c.state, Duration::from_secs(4));
    c.playback("player-1", &[&sid]).await;
    let play = reqwest::get(c.movie_url("limit1", 200)).await.unwrap();
    assert!(play.status().is_success(), "{}", play.status());
    drop(play);
    lock.join().unwrap();
    c.playback("player-1", &[]).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_download_asked_to_yield_while_its_size_waits_for_the_database_lets_go() {
    let c = ctx().await;
    c.limit("src", 1).await;
    let panel = dl_panel::Panel::spawn(3).await;
    panel.file(1, 8 * 1024 * 1024, 1024);
    let head = panel.hold_next_head();
    let d = c.start_url("src", 1, &panel.url(1)).await;
    head.held().await;
    // An import takes the write lock just before the answer arrives, so the
    // download waits to record the file's size with the answer in hand.
    let lock = hold_write_lock(&c.state, Duration::from_secs(4));
    head.release();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(panel.open(), 1);
    let asked = Instant::now();
    c.playback("player-1", &["src"]).await;
    // The player connects now: the account's one connection must be free.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        panel.open(),
        0,
        "the download still held its connection {:?} after playback asked for it",
        asked.elapsed()
    );
    lock.join().unwrap();
    c.playback("player-1", &[]).await;
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    dl_panel::is_exact(1, 8 * 1024 * 1024, Path::new(&done.file_path.unwrap())).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stream_kept_for_a_split_is_let_go_when_playback_asks_meanwhile() {
    let c = ctx().await;
    c.limit("src", 3).await;
    let panel = dl_panel::Panel::spawn(4).await;
    panel.file(1, 64 * 1024 * 1024, 4096);
    // Playback on the source keeps the file on one connection until its
    // report lapses, half a second in.
    iptv_core::downloads::set_playback_lease(&c.state, Duration::from_millis(500));
    c.playback("player-1", &["src"]).await;
    let d = c.start_url("src", 1, &panel.url(1)).await;
    c.wait_until(d.id, "made progress", |d| {
        d.status == DownloadStatus::Downloading && d.bytes_downloaded > 512 * 1024
    })
    .await;
    let lock = hold_write_lock(&c.state, Duration::from_secs(8));
    // Within a second of the lapse the stream is kept for the split while
    // the attempt's progress waits for the database.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(panel.open(), 1, "still on its one stream");
    assert_eq!(panel.log().len(), 1, "no segment asked for yet");
    // Three players on the account: downloads get none of its connections.
    let asked = Instant::now();
    c.playback("player-1", &["src", "src", "src"]).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        panel.open(),
        0,
        "the download still held its connection {:?} after playback asked for it",
        asked.elapsed()
    );
    lock.join().unwrap();
    c.ok("downloads.cancel", json!({"id": d.id})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_player_that_switches_away_keeps_its_connection_until_its_stream_closes() {
    let c = ctx().await;
    c.files(1024 * 1024, 1024).await;
    let sid = c.source("limit1").await;
    // Embedded mpv plays a movie from the source.
    c.playback("player-1", &[&sid]).await;
    let play = reqwest::get(c.movie_url("limit1", 200)).await.unwrap();
    assert!(play.status().is_success());
    let d = c.start(&sid, "limit1", 101).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);
    // The user zaps to another source: mpv lets the old stream go once the
    // report for the new one is answered, and the panel notices a little
    // later still.
    c.playback("player-1", &["elsewhere"]).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(play);
    let done = c
        .wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
    assert_eq!(
        c.stats().await["requests"]["refused_streams"],
        Value::Null,
        "the download asked while the player's stream was still open"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recording_that_ends_keeps_its_connection_a_moment() {
    let c = ctx().await;
    c.files(1024 * 1024, 1024).await;
    let sid = c.source("limit1").await;
    let recording = iptv_core::downloads::hold_recording(&c.state, &sid).await;
    let stream = reqwest::get(c.movie_url("limit1", 300)).await.unwrap();
    assert!(stream.status().is_success());
    let d = c.start(&sid, "limit1", 101).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);
    // The recording ends; the panel still counts its connection a moment.
    drop(recording);
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(stream);
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert_eq!(c.stats().await["requests"]["refused_streams"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recording_that_ends_while_a_player_stays_keeps_its_connection_a_moment() {
    let c = ctx().await;
    c.files(2 * 1024 * 1024, 1024).await;
    let sid = c.source("limit2").await;
    // Embedded mpv plays one channel of the account while a recording
    // takes the other connection.
    c.playback("player-1", &[&sid]).await;
    let play = reqwest::get(c.movie_url("limit2", 200)).await.unwrap();
    assert!(play.status().is_success());
    let recording = iptv_core::downloads::hold_recording(&c.state, &sid).await;
    let stream = reqwest::get(c.movie_url("limit2", 300)).await.unwrap();
    assert!(stream.status().is_success());
    let d = c.start(&sid, "limit2", 101).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);
    // The recording ends; the panel still counts its connection a moment,
    // beside the player's.
    drop(recording);
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(stream);
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert_eq!(c.stats().await["requests"]["refused_streams"], Value::Null);
    drop(play);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wall_tile_that_goes_keeps_its_connection_a_moment() {
    let c = ctx().await;
    c.files(2 * 1024 * 1024, 1024).await;
    let sid = c.source("limit2").await;
    // Two wall tiles on the account's two connections, loaded directly.
    c.playback("wall", &[&sid, &sid]).await;
    let tile_1 = reqwest::get(c.movie_url("limit2", 200)).await.unwrap();
    let tile_2 = reqwest::get(c.movie_url("limit2", 201)).await.unwrap();
    assert!(tile_1.status().is_success() && tile_2.status().is_success());
    let d = c.start(&sid, "limit2", 101).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Queued);
    // One tile goes: the wall reports the other alone, and the closed
    // tile's stream lets go a moment later.
    c.playback("wall", &[&sid]).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(tile_2);
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
    assert_eq!(c.stats().await["requests"]["refused_streams"], Value::Null);
    drop(tile_1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_proxied_player_that_stops_is_not_counted_twice() {
    let c = ctx().await;
    c.files(2 * 1024 * 1024, 256).await;
    let sid = c.source("limit3").await;
    // A player plays through the media proxy: its report and the proxy's
    // stream are one connection, and downloads get the other two.
    c.playback("player-1", &[&sid]).await;
    let proxied = iptv_core::downloads::open_stream(&c.state, &sid).await;
    let a = c.start(&sid, "limit3", 101).await;
    let b = c.start(&sid, "limit3", 102).await;
    for d in [&a, &b] {
        c.wait_until(d.id, "started", |d| d.status == DownloadStatus::Downloading)
            .await;
    }
    // The player stops: the proxy still holds its stream for a moment,
    // and that is the connection the report let go, not another one.
    c.playback("player-1", &[]).await;
    for d in [&a, &b] {
        assert_eq!(
            c.get(d.id).await.status,
            DownloadStatus::Downloading,
            "a download yielded to a stream counted twice"
        );
    }
    drop(proxied);
    c.ok("downloads.cancel", json!({"id": a.id})).await;
    c.ok("downloads.cancel", json!({"id": b.id})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_row_that_yielded_after_new_bytes_starts_its_wait_over() {
    let c = ctx().await;
    c.files(4 * 1024 * 1024, 256).await;
    // A row fails after 3 s of waiting without new bytes.
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_millis(200),
        Duration::from_secs(3),
    );
    let sid = c.source("limit1").await;
    // Another device holds the account's connection: the download is
    // refused and waits.
    let other = reqwest::get(c.movie_url("limit1", 300)).await.unwrap();
    let d = c.start(&sid, "limit1", 101).await;
    c.wait_until(d.id, "was refused", |d| {
        d.waiting
            .as_ref()
            .is_some_and(|w| w.reason == WaitReason::Connection && w.until.is_some())
    })
    .await;
    drop(other);
    c.wait_until(d.id, "made progress", |d| {
        d.status == DownloadStatus::Downloading && d.bytes_downloaded > 256 * 1024
    })
    .await;
    // The user watches for longer than the wait limit; the download yields
    // with new bytes, and the other device is back meanwhile.
    c.playback("player-1", &[&sid]).await;
    let other = reqwest::get(c.movie_url("limit1", 300)).await.unwrap();
    assert!(other.status().is_success());
    tokio::time::sleep(Duration::from_secs(4)).await;
    c.playback("player-1", &[]).await;
    // Refused once more: that is the start of a new wait, not 2 h of one.
    c.wait_until(d.id, "was refused again", |d| {
        assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
        d.waiting
            .as_ref()
            .is_some_and(|w| w.reason == WaitReason::Connection && w.until.is_some())
    })
    .await;
    drop(other);
    let done = c
        .wait_until(d.id, "completed", |d| {
            assert_ne!(d.status, DownloadStatus::Failed, "{:?}", d.error_message);
            d.status == DownloadStatus::Completed
        })
        .await;
    assert!(is_mock_content(Path::new(&done.file_path.unwrap())));
}

/// Starts a download whose three claims fail (the database busy), so it
/// sits in the claim's backoff for about a second.
async fn in_claim_backoff(c: &Ctx) -> (String, Download) {
    c.files(1024 * 1024, 1024).await;
    let sid = c.source("limit1").await;
    iptv_core::downloads::fail_next_claims(&c.state, 3, Duration::from_millis(300));
    let d = c.start(&sid, "limit1", 101).await;
    (sid, d)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_download_yielding_while_its_claim_is_retried_comes_back() {
    let c = ctx().await;
    let (sid, d) = in_claim_backoff(&c).await;
    c.playback("player-1", &[&sid]).await;
    c.playback("player-1", &[]).await;
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_download_paused_or_canceled_while_its_claim_is_retried_stays_so() {
    let c = ctx().await;
    let (_, d) = in_claim_backoff(&c).await;
    c.ok("downloads.pause", json!({"id": d.id})).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(c.get(d.id).await.status, DownloadStatus::Paused);
    c.ok("downloads.resume", json!({"id": d.id})).await;
    c.wait_until(d.id, "completed", |d| d.status == DownloadStatus::Completed)
        .await;

    let c = ctx().await;
    let (_, d) = in_claim_backoff(&c).await;
    c.ok("downloads.cancel", json!({"id": d.id})).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let canceled = c.get(d.id).await;
    assert_eq!(canceled.status, DownloadStatus::Canceled);
    assert_eq!(canceled.file_path, None, "its .part is gone");
}
