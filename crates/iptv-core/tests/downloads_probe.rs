//! Connection-limit probes, learned limits, per-source allowances and queue
//! spreading, against `dl_panel` providers added as Xtream sources.
//!
//! The probes run here on a `TaskCtl::detached` control block, the test
//! holding the transfer's own stream itself (a reader task reports its
//! early end with `note_drop`, the way the engine does), so they do not
//! depend on the engine calling them.

mod dl_panel;

use dl_panel::{add_movie, add_xtream_source, is_exact, movie_ref, LimitMode, Panel};
use iptv_core::downloads::manager::{self, HoldPurpose, TaskCtl};
use iptv_core::downloads::shared::{
    self, mirror_key, write_record, Fingerprint, MirrorRecord, ProbeOutcome, Verdict, VerdictEntry,
};
use iptv_core::downloads::{probe, DownloadManager};
use iptv_core::model::{
    ConnectionLimitMode, CopyRef, Download, DownloadStatus, LimitKind, SourceConnectionLimit,
    TransferNote,
};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(90);
const MIB: u64 = 1024 * 1024;
/// The probed file: large enough for a probe (32 MiB from its end) and slow
/// enough that every body stays open while a round runs.
const BIG: u64 = 64 * MIB;
const WEEK: Duration = Duration::from_secs(7 * 24 * 3600);

struct Ctx {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    mgr: Arc<DownloadManager>,
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
    iptv_core::downloads::set_probe_timing(&state, Duration::from_millis(200), WEEK);
    let mgr = manager::manager(&state);
    Ctx {
        _tmp: tmp,
        state,
        router,
        mgr,
    }
}

impl Ctx {
    async fn ok(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

    /// A panel reporting `reported` connections and enforcing `enforced`
    /// (0: none), added as Xtream source `id` with movies `files`, each
    /// `size` bytes at `kbps` per connection.
    async fn panel(
        &self,
        id: &str,
        reported: usize,
        enforced: usize,
        files: &[u32],
        size: u64,
        kbps: u64,
    ) -> Panel {
        let panel = Panel::spawn(7).await;
        panel.set_reported(reported);
        panel.set_enforced(enforced);
        add_xtream_source(&self.state, id, &panel).await;
        for f in files {
            panel.file(*f, size, kbps);
            add_movie(&self.state, id, *f, &format!("Movie {f}"), None, "mp4").await;
        }
        panel
    }

    async fn endpoint(&self, source: &str, file: u32) -> shared::Endpoint {
        shared::resolve(&self.state, &CopyRef::new(movie_ref(source, file), None))
            .await
            .unwrap()
    }

    async fn probe(&self, ctl: &TaskCtl, ep: &shared::Endpoint) -> Option<ProbeOutcome> {
        probe::probe(&self.state, &self.mgr, ctl, ep, BIG as i64).await
    }

    async fn limits(&self) -> Vec<SourceConnectionLimit> {
        iptv_core::downloads::connection_limits(&self.state)
            .await
            .unwrap()
    }

    async fn limit(&self, source: &str) -> SourceConnectionLimit {
        self.limits()
            .await
            .into_iter()
            .find(|l| l.source_id == source)
            .unwrap_or_else(|| panic!("{source} is not listed"))
    }

    async fn start(&self, source: &str, file: u32, url: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": source, "contentType": "movie", "itemId": file.to_string()},
                    "title": format!("Movie {file} on {source}"),
                    "url": url,
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

    async fn completed(&self, id: i64) -> Download {
        self.wait_until(id, "completed", |d| d.status == DownloadStatus::Completed)
            .await
    }

    /// Writes `copy`'s mirror record: its fingerprint (`total` bytes) and a
    /// fresh `verdict` for each of `others`.
    async fn verdicts(&self, copy: CopyRef, total: i64, others: Vec<CopyRef>, verdict: Verdict) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let record = MirrorRecord {
            version: 1,
            fingerprint: Some(Fingerprint {
                total,
                validator: None,
                samples: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
                checked_at: now.clone(),
            }),
            verdicts: others
                .into_iter()
                .map(|c| VerdictEntry {
                    copy: c,
                    verdict,
                    total: Some(total),
                    validator: None,
                    checked_at: now.clone(),
                })
                .collect(),
            copy,
        };
        self.state
            .db_write(move |c| write_record(c, &mirror_key(&record.copy), &record))
            .await
            .unwrap();
    }

    /// Asks the queue to look again (an empty playback report pumps it).
    async fn pump(&self) {
        iptv_core::downloads::set_playback(&self.state, "nobody", Vec::new()).await;
    }
}

/// Opens the transfer's own stream of `url` and reads it on a task, which
/// reports an early end of it (error or EOF) on `ctl`, the way the engine
/// does. Abort the returned task to close the stream.
async fn hold_stream(url: &str, ctl: Arc<TaskCtl>, source: &str) -> tokio::task::JoinHandle<()> {
    let mut resp = reqwest::get(url).await.unwrap();
    assert!(resp.status().is_success(), "main stream: {}", resp.status());
    let source = source.to_string();
    tokio::spawn(async move {
        loop {
            match resp.chunk().await {
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => {
                    ctl.note_drop(&source);
                    return;
                }
            }
        }
    })
}

/// Waits until `f` holds, failing with `what` after a few seconds.
async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < deadline, "never {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn file_of(d: &Download) -> &Path {
    Path::new(d.file_path.as_deref().expect("a completed row has a file"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refusing_panel_is_probed_once_a_week() {
    let c = ctx().await;
    let panel = c.panel("xr", 1, 1, &[1], BIG, 512).await;
    let ctl = TaskCtl::detached("xr");
    let main = hold_stream(&panel.movie_url(1), ctl.clone(), "xr").await;
    let ep = c.endpoint("xr", 1).await;

    assert_eq!(c.probe(&ctl, &ep).await, Some(ProbeOutcome::Refused));
    assert_eq!(panel.counts().get("refused").copied().unwrap_or(0), 1);
    let l = c.limit("xr").await;
    assert_eq!(
        (l.learned, l.mode),
        (Some(1), Some(ConnectionLimitMode::Refuse))
    );
    assert_eq!(l.reported, Some(1));
    assert!(l.probed_at.is_some() && l.next_probe_at.is_some());
    assert!(!l.probing && !l.disabled);
    assert!(matches!(
        ctl.recent_notes().last(),
        Some(TransferNote::ProbeRefused { source_id }) if source_id == "xr"
    ));
    // Learning the reported limit raises nothing.
    assert_eq!(c.mgr.effective_limit("xr"), (Some(1), LimitKind::Reported));

    // Not again before the week is out.
    assert!(!probe::probe_due(&c.state, &c.mgr, &ctl, "xr"));
    assert_eq!(c.probe(&ctl, &ep).await, None);
    assert_eq!(panel.counts().get("refused").copied().unwrap_or(0), 1);

    // A week later it is due again, and the record keeps both rounds.
    iptv_core::downloads::age_connection_limit(&c.state, "xr", WEEK + Duration::from_secs(60))
        .await
        .unwrap();
    assert!(probe::probe_due(&c.state, &c.mgr, &ctl, "xr"));
    assert_eq!(c.probe(&ctl, &ep).await, Some(ProbeOutcome::Refused));
    assert_eq!(panel.counts().get("refused").copied().unwrap_or(0), 2);
    let record: shared::LimitRecord = c
        .state
        .db_call(|conn| shared::read_record(conn, &shared::limit_key("xr")))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.history.len(), 2);
    assert!(record
        .history
        .iter()
        .all(|s| s.outcome == ProbeOutcome::Refused && s.connections == 2));
    main.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panel_allowing_three_is_learned_and_used_in_full() {
    let c = ctx().await;
    const FILE: u32 = 2;
    const SIZE: u64 = 24 * MIB;
    let panel = c.panel("xa", 1, 3, &[1], BIG, 512).await;
    panel.file(FILE, SIZE, 2048);
    add_movie(&c.state, "xa", FILE, "Movie 2", None, "mp4").await;
    let ctl = TaskCtl::detached("xa");
    let main = hold_stream(&panel.movie_url(1), ctl.clone(), "xa").await;
    let ep = c.endpoint("xa", 1).await;

    assert_eq!(c.probe(&ctl, &ep).await, Some(ProbeOutcome::Refused));
    let l = c.limit("xa").await;
    assert_eq!((l.reported, l.learned), (Some(1), Some(3)));
    assert_eq!(l.mode, Some(ConnectionLimitMode::Refuse));
    assert!(l.probed_at.is_some());
    assert!(matches!(
        ctl.recent_notes().last(),
        Some(TransferNote::ProbeAccepted { limit: 3, .. })
    ));
    assert_eq!(c.mgr.effective_limit("xa"), (Some(3), LimitKind::Learned));
    // The round closed every connection it opened.
    eventually("probe connections closed", || panel.open() == 1).await;
    main.abort();
    eventually("main stream closed", || panel.open() == 0).await;
    let refused = panel.counts().get("refused").copied().unwrap_or(0);

    // A learned 3 keeps no connection free: the download uses all three.
    let d = c.start("xa", FILE, &panel.movie_url(FILE)).await;
    let mut most = 0;
    let done = loop {
        let now = c.get(d.id).await;
        most = most.max(now.connections.unwrap_or(1));
        if now.status == DownloadStatus::Completed {
            break now;
        }
        assert!(
            !matches!(
                now.status,
                DownloadStatus::Failed | DownloadStatus::Canceled
            ),
            "{:?}",
            now.error_message
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(most, 3, "the download reached the learned limit");
    assert_eq!(panel.peak(), 3);
    assert_eq!(
        panel.counts().get("refused").copied().unwrap_or(0),
        refused,
        "the download never asked past the learned limit"
    );
    is_exact(FILE, SIZE, file_of(&done)).unwrap();

    // Reset forgets it: back to the reported limit, and due again.
    c.ok("downloads.resetConnectionLimit", json!({"sourceId": "xa"}))
        .await;
    let l = c.limit("xa").await;
    assert_eq!((l.learned, l.mode, l.probed_at), (None, None, None));
    assert_eq!(c.mgr.effective_limit("xa"), (Some(1), LimitKind::Reported));
    assert!(probe::probe_due(&c.state, &c.mgr, &ctl, "xa"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panel_ending_the_oldest_connection_is_learned_as_kick_oldest() {
    let c = ctx().await;
    let panel = c.panel("xk", 1, 1, &[1], BIG, 512).await;
    panel.set_limit_mode(LimitMode::KickOldest);
    iptv_core::downloads::set_probe_timing(&c.state, Duration::from_millis(600), WEEK);
    let ctl = TaskCtl::detached("xk");
    let main = hold_stream(&panel.movie_url(1), ctl.clone(), "xk").await;
    let ep = c.endpoint("xk", 1).await;

    assert_eq!(c.probe(&ctl, &ep).await, Some(ProbeOutcome::KickedOldest));
    assert!(panel.kicked() >= 1);
    assert_eq!(
        ctl.drops("xk"),
        1,
        "the transfer's stream was the one ended"
    );
    let l = c.limit("xk").await;
    assert_eq!(
        (l.learned, l.mode),
        (Some(1), Some(ConnectionLimitMode::KickOldest))
    );
    assert!(matches!(
        ctl.recent_notes().last(),
        Some(TransferNote::ProbeKickedOldest { source_id }) if source_id == "xk"
    ));
    eventually("probe connections closed", || panel.open() == 0).await;
    main.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn playback_aborts_a_probe_and_nothing_is_recorded() {
    let c = ctx().await;
    let panel = c.panel("xp", 1, 0, &[1], BIG, 512).await;
    iptv_core::downloads::set_probe_timing(&c.state, Duration::from_secs(5), WEEK);
    let ctl = TaskCtl::detached("xp");
    let main = hold_stream(&panel.movie_url(1), ctl.clone(), "xp").await;
    let ep = c.endpoint("xp", 1).await;

    let round = {
        let (state, mgr, ctl, ep) = (c.state.clone(), c.mgr.clone(), ctl.clone(), ep.clone());
        tokio::spawn(async move { probe::probe(&state, &mgr, &ctl, &ep, BIG as i64).await })
    };
    eventually("the probe opened a connection", || panel.open() == 2).await;
    assert!(c.limit("xp").await.probing);
    let asked = Instant::now();
    // The report returns once the probe let go of its connections.
    iptv_core::downloads::set_playback(&c.state, "player", vec!["xp".into()]).await;
    assert_eq!(round.await.unwrap(), Some(ProbeOutcome::Aborted));
    assert!(asked.elapsed() < Duration::from_secs(3));
    assert!(!c.mgr.is_tracked(0));
    let l = c.limit("xp").await;
    assert_eq!((l.learned, l.mode, l.probing), (None, None, false));
    eventually("probe connection closed", || panel.open() == 1).await;
    // Never while something plays or records there.
    assert!(!probe::probe_due(&c.state, &c.mgr, &ctl, "xp"));
    iptv_core::downloads::set_playback(&c.state, "player", Vec::new()).await;
    let rec = iptv_core::downloads::hold_recording(&c.state, "xp").await;
    assert!(!probe::probe_due(&c.state, &c.mgr, &ctl, "xp"));
    drop(rec);
    main.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_source_with_probes_disabled_is_never_probed() {
    let c = ctx().await;
    let panel = c.panel("xd", 1, 3, &[1], BIG, 512).await;
    c.state.settings.write().download_probe_disabled = vec!["xd".into()];
    let ctl = TaskCtl::detached("xd");
    let main = hold_stream(&panel.movie_url(1), ctl.clone(), "xd").await;
    let ep = c.endpoint("xd", 1).await;
    let requests = panel.log().len();
    assert!(!probe::probe_due(&c.state, &c.mgr, &ctl, "xd"));
    assert_eq!(c.probe(&ctl, &ep).await, None);
    assert_eq!(panel.log().len(), requests, "no probe request");
    let l = c.limit("xd").await;
    assert!(l.disabled);
    assert_eq!(l.learned, None);

    // A record learned before probes were disabled no longer counts.
    c.state.settings.write().download_probe_disabled.clear();
    assert_eq!(c.probe(&ctl, &ep).await, Some(ProbeOutcome::Refused));
    assert_eq!(c.mgr.effective_limit("xd"), (Some(3), LimitKind::Learned));
    c.state.settings.write().download_probe_disabled = vec!["xd".into()];
    assert_eq!(c.mgr.effective_limit("xd"), (Some(1), LimitKind::Reported));
    main.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connection_limits_list_every_xtream_source_in_camel_case() {
    let c = ctx().await;
    let panel = c.panel("xl", 2, 2, &[1], BIG, 512).await;
    let _other = c.panel("xm", 0, 0, &[], BIG, 512).await;
    let ctl = TaskCtl::detached("xl");
    let main = hold_stream(&panel.movie_url(1), ctl.clone(), "xl").await;
    let ep = c.endpoint("xl", 1).await;
    assert_eq!(c.probe(&ctl, &ep).await, Some(ProbeOutcome::Refused));
    main.abort();

    let list = c.ok("downloads.connectionLimits", Value::Null).await;
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 2);
    let probed = &list[0];
    assert_eq!(probed["sourceId"], "xl");
    assert_eq!(probed["reported"], 2);
    assert_eq!(probed["learned"], 2);
    assert_eq!(probed["mode"], "refuse");
    assert!(probed["probedAt"].is_string() && probed["nextProbeAt"].is_string());
    assert_eq!(
        (probed["probing"].clone(), probed["disabled"].clone()),
        (json!(false), json!(false))
    );
    let fresh = &list[1];
    assert_eq!(fresh["sourceId"], "xm");
    assert_eq!(
        fresh.as_object().unwrap().keys().collect::<HashSet<_>>(),
        ["sourceId", "probing", "disabled"]
            .iter()
            .map(|k| k.to_string())
            .collect::<HashSet<_>>()
            .iter()
            .collect(),
        "an unlimited, unprobed source lists no limit"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mirror_allowance_follows_each_source() {
    let c = ctx().await;
    let _a = c.panel("ma", 1, 0, &[], BIG, 512).await;
    let _b = c.panel("mb", 3, 0, &[], BIG, 512).await;
    let ctl = TaskCtl::detached("ma");
    // The limit is read on first use; until then, nothing.
    eventually("mb's limit read", || c.mgr.allowance_on(&ctl, "mb") == 2).await;
    assert_eq!(c.mgr.effective_limit("mb"), (Some(3), LimitKind::Reported));
    assert_eq!(c.mgr.spare_on("ma", "mb"), 2);

    // Playback there takes it all.
    iptv_core::downloads::set_playback(&c.state, "player", vec!["mb".into()]).await;
    assert_eq!(c.mgr.allowance_on(&ctl, "mb"), 0);
    iptv_core::downloads::set_playback(&c.state, "player", Vec::new()).await;
    // A recording too (and the release grace after it).
    let rec = iptv_core::downloads::hold_recording(&c.state, "mb").await;
    assert_eq!(c.mgr.allowance_on(&ctl, "mb"), 0);
    drop(rec);
    // A hold takes one of the two.
    eventually("the recording's grace ended", || {
        c.mgr.allowance_on(&ctl, "mb") == 2
    })
    .await;
    let hold = c.mgr.try_hold("mb", HoldPurpose::Verify).unwrap();
    assert_eq!(c.mgr.allowance_on(&ctl, "mb"), 1);
    drop(hold);
    assert_eq!(c.mgr.allowance_on(&ctl, "mb"), 2);
    // A refused mirror connection: none for two minutes, holds neither.
    c.mgr.mirror_refused("mb");
    assert_eq!(c.mgr.allowance_on(&ctl, "mb"), 0);
    assert!(c.mgr.try_hold("mb", HoldPurpose::Fingerprint).is_none());
    // The row's own source is not a mirror of it.
    assert_eq!(c.mgr.allowance_on(&ctl, "ma"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn four_one_connection_sources_run_four_files_at_once() {
    let c = ctx().await;
    const SIZE: u64 = 2 * MIB;
    let mut panels = Vec::new();
    for (i, id) in ["s1", "s2", "s3", "s4"].iter().enumerate() {
        let file = i as u32 + 1;
        panels.push((id, file, c.panel(id, 1, 1, &[file], SIZE, 256).await));
    }
    let mut ids = Vec::new();
    for (id, file, panel) in &panels {
        ids.push(c.start(id, *file, &panel.movie_url(*file)).await.id);
    }
    let deadline = Instant::now() + WAIT;
    loop {
        let running = c
            .list()
            .await
            .iter()
            .filter(|d| d.status == DownloadStatus::Downloading)
            .count();
        if running == 4 {
            break;
        }
        assert!(Instant::now() < deadline, "never four at once ({running})");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for ((_, file, panel), id) in panels.iter().zip(ids) {
        let d = c.completed(id).await;
        is_exact(*file, SIZE, file_of(&d)).unwrap();
        assert!(panel.peak() <= 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queue_spreads_over_sources_with_identical_copies() {
    let c = ctx().await;
    const SIZE: u64 = 2 * MIB;
    let files: Vec<u32> = (1..=6).collect();
    // The rows are all on A. Until the engine downloads a spread run's own
    // copy, it reads the row's URL, so A takes every connection.
    let a = c.panel("sa", 1, 0, &files, SIZE, 256).await;
    for id in ["sb", "sc", "sd"] {
        c.panel(id, 1, 1, &files, SIZE, 256).await;
    }
    for f in &files {
        let copies = ["sb", "sc", "sd"]
            .iter()
            .map(|s| CopyRef::new(movie_ref(s, *f), None))
            .collect();
        c.verdicts(
            CopyRef::new(movie_ref("sa", *f), None),
            SIZE as i64,
            copies,
            Verdict::Identical,
        )
        .await;
    }
    let mut ids = Vec::new();
    for f in &files {
        ids.push(c.start("sa", *f, &a.movie_url(*f)).await.id);
    }
    let deadline = Instant::now() + WAIT;
    let mut served = HashSet::new();
    let mut most = 0;
    loop {
        let list = c.list().await;
        let running: Vec<&Download> = list
            .iter()
            .filter(|d| d.status == DownloadStatus::Downloading)
            .collect();
        most = most.max(running.len());
        served.extend(running.iter().filter_map(|d| d.served_by.clone()));
        if list.iter().all(|d| d.status == DownloadStatus::Completed) {
            break;
        }
        assert!(Instant::now() < deadline, "the queue never finished");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(most, 4, "one file per source");
    assert_eq!(
        served,
        ["sb", "sc", "sd"]
            .iter()
            .map(|s| s.to_string())
            .collect::<HashSet<_>>()
    );
    for (f, id) in files.iter().zip(ids) {
        let d = c.get(id).await;
        assert_eq!(d.origin, None, "identical copies never become an origin");
        is_exact(*f, SIZE, file_of(&d)).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn equivalent_copies_take_only_fresh_rows_and_only_when_allowed() {
    let c = ctx().await;
    const SIZE: u64 = 4 * MIB;
    let files = [1, 2, 3];
    let a = c.panel("ea", 1, 0, &files, SIZE, 256).await;
    c.panel("eb", 1, 1, &files, SIZE, 256).await;
    for f in [2, 3] {
        c.verdicts(
            CopyRef::new(movie_ref("ea", f), None),
            SIZE as i64,
            vec![CopyRef::new(movie_ref("eb", f), None)],
            Verdict::Equivalent,
        )
        .await;
    }
    let first = c.start("ea", 1, &a.movie_url(1)).await;
    c.wait_until(first.id, "started", |d| {
        d.status == DownloadStatus::Downloading
    })
    .await;
    let second = c.start("ea", 2, &a.movie_url(2)).await;
    // Equivalent copies are off by default: it waits for its own source.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let d = c.get(second.id).await;
    assert_eq!((d.status, d.origin.clone()), (DownloadStatus::Queued, None));

    // Allowed, the fresh row starts on the equivalent copy, which becomes
    // its origin.
    c.state.settings.write().download_allow_equivalent = true;
    c.pump().await;
    let d = c
        .wait_until(second.id, "spread", |d| {
            d.status == DownloadStatus::Downloading
        })
        .await;
    let copy = CopyRef::new(movie_ref("eb", 2), None);
    assert_eq!(d.served_by.as_deref(), Some("eb"));
    assert_eq!(d.origin, Some(copy.clone()));

    // A row with bytes of its own never switches copies.
    let third = c.start("ea", 3, &a.movie_url(3)).await;
    c.state
        .db_write(move |conn| {
            conn.execute(
                "UPDATE downloads SET bytes_downloaded = 4096 WHERE id = ?1",
                [third.id],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    // Cancelling and starting again resets the second row: no origin.
    c.ok("downloads.cancel", json!({"id": second.id})).await;
    c.state.settings.write().download_allow_equivalent = false;
    c.start("ea", 2, &a.movie_url(2)).await;
    let d = c.get(second.id).await;
    assert_eq!(d.origin, None, "a reset clears the origin");
    c.state.settings.write().download_allow_equivalent = true;
    c.pump().await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let d = c.get(third.id).await;
    assert_eq!(d.origin, None);
    assert_ne!(d.served_by.as_deref(), Some("eb"));
    c.ok("downloads.cancel", json!({"id": first.id})).await;
}
