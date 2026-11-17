//! The segmented engine against `dl_panel` (spec 3.9): the split on the
//! first `206`, the per-file connection cap, overlap checks on a file
//! without validators, sidecar v1 and v2 resumes, redirect pinning with a
//! token that expires, reopening a slow connection on the host's next
//! address, and the once-a-second breakdown. Then the review's findings:
//! spread runs never stitch two copies or use a copy that changed, probes
//! and mirrors follow the settings live, a dead address is not a refusal,
//! and the mirror search runs again.

mod dl_panel;

use dl_panel::{
    add_movie, add_xtream_source, movie_ref, Panel, PanelOptions, Redirect, Validators, Variant,
};
use iptv_core::downloads::{mirrors, shared};
use iptv_core::model::{CopyRef, Download, DownloadStatus};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(90);
const MIB: u64 = 1024 * 1024;

struct Ctx {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
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

    async fn start(&self, url: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": "src", "contentType": "movie", "itemId": "1"},
                    "title": "Movie",
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

    async fn completed(&self, id: i64) -> PathBuf {
        let d = self
            .wait_until(id, "completed", |d| {
                d.status == DownloadStatus::Completed || d.status == DownloadStatus::Failed
            })
            .await;
        assert_eq!(d.status, DownloadStatus::Completed, "{:?}", d.error_message);
        PathBuf::from(d.file_path.unwrap())
    }

    async fn pause(&self, id: i64) -> PathBuf {
        self.ok("downloads.pause", json!({"id": id})).await;
        let d = self
            .wait_until(id, "paused", |d| d.status == DownloadStatus::Paused)
            .await;
        PathBuf::from(format!("{}.part", d.file_path.unwrap()))
    }

    /// Caches an account status allowing `n` connections for `src`.
    async fn limit(&self, n: i64) {
        iptv_core::account::record(
            &self.state,
            iptv_core::account::AccountStatus {
                source_id: "src".into(),
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

    fn drain_events(&self) {
        let mut events = self.events.lock();
        while matches!(
            events.try_recv(),
            Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
        ) {}
    }

    /// Events of `kind` for download `id` received within `d`.
    async fn collect(&self, kind: &str, id: i64, d: Duration) -> Vec<Value> {
        let deadline = Instant::now() + d;
        let mut out = Vec::new();
        while Instant::now() < deadline {
            let got = self.events.lock().try_recv();
            match got {
                Ok(ev) if ev.kind == kind && ev.payload["id"] == id => out.push(ev.payload),
                Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        out
    }

    /// Bytes of the next `downloads.progress` event of `id`.
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
}

fn sidecar(part: &Path) -> PathBuf {
    PathBuf::from(format!("{}.ranges", part.display()))
}

fn read_json(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < deadline, "never {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_first_206_splits_the_file_at_once() {
    let c = ctx().await;
    c.limit(3).await;
    let panel = Panel::spawn(11).await;
    let size = 32 * MIB;
    panel.file(1, size, 2048);
    let started = Instant::now();
    let d = c.start(&panel.url(1)).await;
    until("asked for a second range", || panel.log().len() >= 2).await;
    // The 1 s single-stream check would come later.
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "split after {:?}",
        started.elapsed()
    );
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_never_takes_more_than_eight_connections() {
    let c = ctx().await;
    // Nine free connections, but one file uses at most eight.
    c.limit(10).await;
    iptv_core::downloads::manager::manager(&c.state)
        .set_ramp_timing(Duration::from_millis(600), Duration::from_secs(60));
    let panel = Panel::spawn(12).await;
    let size = 128 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.url(1)).await;
    let path = c.completed(d.id).await;
    assert_eq!(panel.peak(), 8, "the ramp reaches the cap and stops there");
    dl_panel::is_exact(1, size, &path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn most_connections_per_download_caps_a_file() {
    let c = ctx().await;
    c.limit(10).await;
    c.state.settings.write().download_max_connections = 3;
    iptv_core::downloads::manager::manager(&c.state)
        .set_ramp_timing(Duration::from_millis(300), Duration::from_secs(60));
    let panel = Panel::spawn(13).await;
    let size = 48 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.url(1)).await;
    let path = c.completed(d.id).await;
    assert_eq!(panel.peak(), 3);
    dl_panel::is_exact(1, size, &path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_without_validators_that_changes_mid_download_is_never_stitched() {
    let c = ctx().await;
    // One connection for the download at first.
    c.limit(2).await;
    let panel = Panel::with(PanelOptions {
        seed: 14,
        validators: Validators::None,
        ..PanelOptions::default()
    })
    .await;
    let size = 24 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.url(1)).await;
    c.wait_until(d.id, "made progress", |d| d.bytes_downloaded > MIB as i64)
        .await;
    // The provider replaces the file: new requests get the new bytes. Then
    // a second connection frees up, and the open stream is split.
    panel.file_variant(1, size, 2048, Variant::Differs);
    c.limit(3).await;
    let path = c.completed(d.id).await;
    // The overlap check caught the change: the file restarted on one
    // connection and holds the new version only.
    let got = std::fs::read(&path).unwrap();
    assert_eq!(got.len() as u64, size);
    let want = dl_panel::variant_content(1, Variant::Differs, size, 0, size as usize);
    assert!(got == want, "the file mixes two versions");
    assert!(panel.log().len() >= 3, "{:?}", panel.log());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_version_1_sidecar_resumes_every_segment() {
    let c = ctx().await;
    c.limit(3).await;
    let panel = Panel::spawn(15).await;
    let size = 24 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.url(1)).await;
    until("split", || panel.log().len() >= 2).await;
    c.wait_until(d.id, "made progress", |d| {
        d.bytes_downloaded > 2 * MIB as i64
    })
    .await;
    let part = c.pause(d.id).await;
    // Rewrite the sidecar the way older builds wrote it.
    let v2 = read_json(&sidecar(&part));
    assert_eq!(v2["version"], 2);
    let segments: Vec<Value> = v2["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| json!({"start": s["start"], "end": s["end"], "pos": s["pos"]}))
        .collect();
    let done: i64 = segments
        .iter()
        .map(|s| s["pos"].as_i64().unwrap() - s["start"].as_i64().unwrap())
        .sum();
    let v1 = json!({
        "total": v2["total"],
        "validator": v2["sources"][0]["validator"],
        "segments": segments,
    });
    std::fs::write(sidecar(&part), serde_json::to_vec(&v1).unwrap()).unwrap();
    let before = panel.log().len();
    c.drain_events();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    assert_eq!(c.next_progress(d.id).await, done, "resumed where it was");
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
    assert!(
        panel.log()[before..]
            .iter()
            .all(|l| l.range.is_some_and(|r| r.0 > 0)),
        "never a restart from zero: {:?}",
        &panel.log()[before..]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bytes_another_source_wrote_are_compared_before_the_file_completes() {
    let c = ctx().await;
    c.limit(3).await;
    let panel = Panel::spawn(16).await;
    let size = 24 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.url(1)).await;
    until("split", || panel.log().len() >= 2).await;
    c.wait_until(d.id, "made progress", |d| {
        d.bytes_downloaded > 4 * MIB as i64
    })
    .await;
    let part = c.pause(d.id).await;
    // Plant a mirror of an earlier run as the source of the second
    // segment's bytes (unchecked).
    let mut v2 = read_json(&sidecar(&part));
    v2["sources"].as_array_mut().unwrap().push(json!({
        "copy": {"ref": {"sourceId": "other", "contentType": "movie", "itemId": "9"}},
        "validator": null,
    }));
    let segs = v2["segments"].as_array_mut().unwrap();
    let k = segs
        .iter()
        .position(|s| s["start"].as_i64().unwrap() > 0 && s["pos"] != s["start"])
        .expect("a second segment with bytes");
    segs[k]["src"] = json!(1);
    segs[k]["checked"] = json!(false);
    let (start, pos) = (
        segs[k]["start"].as_u64().unwrap(),
        segs[k]["pos"].as_u64().unwrap(),
    );
    std::fs::write(sidecar(&part), serde_json::to_vec(&v2).unwrap()).unwrap();
    let before = panel.log().len();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
    // The authority fetched 64 KiB of the planted bytes to compare them.
    let checked = panel.log()[before..].iter().any(|l| {
        l.range
            .is_some_and(|(a, b)| a >= start && a < pos && b == Some(a + 64 * 1024 - 1))
    });
    assert!(
        checked,
        "no check of {start}..{pos}: {:?}",
        &panel.log()[before..]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn segment_requests_follow_the_redirect_and_ask_again_when_its_token_expires() {
    let c = ctx().await;
    c.limit(4).await;
    let panel = Panel::with(PanelOptions {
        seed: 17,
        redirect: Some(Redirect::SameHost {
            token_ttl: Duration::from_millis(500),
        }),
        ..PanelOptions::default()
    })
    .await;
    let size = 32 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.movie_url(1)).await;
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
    let log = panel.log();
    assert!(
        log.iter()
            .any(|l| l.route == "edge" && l.range.is_some_and(|r| r.0 > 0)),
        "segments went to the redirect target: {log:?}"
    );
    assert!(panel.expired() >= 1, "a token expired: {log:?}");
    // The expired token cost a retry, not a connection.
    assert!(panel.peak() >= 3, "peak {}", panel.peak());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_connection_is_reopened_on_the_hosts_next_address() {
    let c = ctx().await;
    // Two connections: the open answer and one segment.
    c.limit(3).await;
    let panel = Panel::spawn(18).await;
    let second = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
    if let Err(e) = panel.listen_also(second).await {
        eprintln!("skipped: 127.0.0.2 cannot be bound here ({e})");
        return;
    }
    let port = panel.port();
    iptv_core::http::set_dns_override(
        &c.state,
        "localhost",
        vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(second, port),
        ],
    );
    iptv_core::downloads::manager::manager(&c.state)
        .set_ramp_timing(Duration::from_secs(1), Duration::from_millis(500));
    let size = 32 * MIB;
    panel.file(1, size, 2048);
    // The open answer is fast and the segment's is slow.
    let head = panel.hold_next_head();
    let d = c.start(&format!("http://localhost:{port}/f/1")).await;
    head.held().await;
    panel.set_speed(1, 64);
    head.release();
    until("split", || panel.log().len() >= 2).await;
    panel.set_speed(1, 2048);
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
    assert!(
        panel.requests_on(second) >= 1,
        "the slow connection reopened on 127.0.0.2: {:?}",
        panel.log()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_split_transfer_publishes_its_breakdown_once_a_second() {
    let c = ctx().await;
    c.limit(3).await;
    let panel = Panel::spawn(19).await;
    let size = 48 * MIB;
    panel.file(1, size, 2048);
    let d = c.start(&panel.url(1)).await;
    until("split", || panel.log().len() >= 2).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    c.drain_events();
    let stats = c
        .collect("downloads.stats", d.id, Duration::from_millis(3500))
        .await;
    assert!(
        (2..=5).contains(&stats.len()),
        "{} breakdowns in 3.5 s",
        stats.len()
    );
    let last = stats.last().unwrap();
    assert_eq!(last["sources"][0]["role"], "primary");
    assert_eq!(last["sources"][0]["sourceId"], "src");
    assert_eq!(last["connections"].as_array().unwrap().len(), 2, "{last}");
    assert!(last["bytesPerSecond"].as_i64().unwrap() > 0, "{last}");
    let progress = c
        .collect("downloads.progress", d.id, Duration::from_millis(600))
        .await;
    assert!(
        progress.iter().any(|p| p["connections"] == 2),
        "{progress:?}"
    );
    let rpc = c.ok("downloads.stats", json!({"id": d.id})).await;
    assert_eq!(rpc["id"], d.id);
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
}

// Review round 1 (amendment A8): spread runs, live settings, dead
// addresses and the mirror search.

/// A context with the Xtream module, for sources with a catalog.
async fn xctx() -> Ctx {
    let c = ctx().await;
    iptv_core::xtream::init(c.state.clone()).await.unwrap();
    c
}

impl Ctx {
    async fn start_movie(&self, source: &str, file: u32, url: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": source, "contentType": "movie", "itemId": file.to_string()},
                    "title": format!("Movie {file}"),
                    "url": url,
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    /// Panels `a` and `b` with movie 1 under the same title, verified
    /// identical (three samples) for the copy on `a`. Returns both sources
    /// and the copy on `a`.
    async fn copies(&self, a: &Panel, b: &Panel, tag: &str) -> (String, String, CopyRef) {
        let sa = add_xtream_source(&self.state, &format!("{tag}-a"), a).await;
        let sb = add_xtream_source(&self.state, &format!("{tag}-b"), b).await;
        for s in [&sa, &sb] {
            add_movie(&self.state, s, 1, "Two Copies (2022)", Some(2022), "mp4").await;
        }
        self.state.settings.write().download_probe_disabled = vec![sa.clone(), sb.clone()];
        let own = CopyRef::new(movie_ref(&sa, 1), None);
        let ep = shared::resolve(&self.state, &own).await.unwrap();
        let fp = mirrors::fingerprint(&self.state, &ep).await.unwrap();
        let (k, f) = (own.clone(), fp.clone());
        self.state
            .db_call(move |c| mirrors::store_fingerprint(c, &k, &f))
            .await
            .unwrap();
        let mgr = iptv_core::downloads::manager::manager(&self.state);
        let found = mirrors::identical_copies(&self.state, &mgr, &own, &fp, &[]).await;
        assert_eq!(found.len(), 1, "the copy on b is verified identical");
        (sa, sb, own)
    }

    async fn identical(&self, own: &CopyRef) -> Vec<CopyRef> {
        let o = own.clone();
        self.state
            .db_call(move |c| mirrors::cached_identical(c, &o))
            .await
            .unwrap()
    }
}

/// The file at `path` is one copy of file 1 throughout: the canonical one
/// or `variant`, never parts of both.
fn one_copy(path: &Path, size: u64, variant: Variant) -> Result<(), String> {
    let Err(e) = dl_panel::is_exact(1, size, path) else {
        return Ok(());
    };
    let got = std::fs::read(path).unwrap();
    if got == dl_panel::variant_content(1, variant, size, 0, size as usize) {
        return Ok(());
    }
    Err(e)
}

/// The row's `.part` was written on A in one stream (no sidecar). A plays
/// and the row is spread to B, whose copy matched the samples of A but
/// differs elsewhere: bytes from B never continue those from A.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_plain_part_is_never_continued_on_a_spread_copy() {
    let c = xctx().await;
    let size = 48 * MIB;
    let (a, b) = (Panel::spawn(40).await, Panel::spawn(41).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
        p.set_validators(Validators::None);
    }
    a.file(1, size, 4 * 1024);
    b.file_variant(1, size, 4 * 1024, Variant::DiffersOutsideSamples);
    let (sa, _sb, _) = c.copies(&a, &b, "plain").await;
    c.state.settings.write().download_single_connection = vec![sa.clone()];
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "reached 12 MiB on A", |d| {
        d.bytes_downloaded >= 12 * MIB as i64
    })
    .await;
    iptv_core::downloads::set_playback(&c.state, "tv", vec![sa.clone()]).await;
    // Spread to B, or kept waiting for A: either way A frees up later.
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline && b.log().iter().all(|l| l.route != "movie") {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    iptv_core::downloads::set_playback(&c.state, "tv", Vec::new()).await;
    let path = c.completed(d.id).await;
    one_copy(&path, size, Variant::DiffersOutsideSamples).unwrap();
}

/// The reverse: a run spread to B streams on one connection, then the row
/// goes home to A. The bytes from B are compared with A before they count.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_spread_single_stream_is_compared_when_the_row_goes_home() {
    let c = xctx().await;
    let size = 48 * MIB;
    let (a, b) = (Panel::spawn(42).await, Panel::spawn(43).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
        p.set_validators(Validators::None);
    }
    a.file(1, size, 4 * 1024);
    b.file_variant(1, size, 4 * 1024, Variant::DiffersOutsideSamples);
    let (sa, sb, _) = c.copies(&a, &b, "home").await;
    c.state.settings.write().download_single_connection = vec![sb.clone()];
    iptv_core::downloads::set_playback(&c.state, "tv", vec![sa.clone()]).await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "reached 12 MiB on B", |d| {
        d.served_by.as_deref() == Some(sb.as_str()) && d.bytes_downloaded >= 12 * MIB as i64
    })
    .await;
    // Playback moves to B: the row yields there, and A is free.
    iptv_core::downloads::set_playback(&c.state, "tv", vec![sb.clone()]).await;
    let path = c.completed(d.id).await;
    iptv_core::downloads::set_playback(&c.state, "tv", Vec::new()).await;
    one_copy(&path, size, Variant::DiffersOutsideSamples).unwrap();
}

/// The file on B changed after the pair was verified. A run spread to B
/// sees another total, drops the verdict of the pair and goes back to the
/// queue; the row ends with the file from A.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_spread_copy_that_changed_since_it_was_verified_is_not_used() {
    let c = xctx().await;
    let (size, grown) = (24 * MIB, 30 * MIB);
    let (a, b) = (Panel::spawn(44).await, Panel::spawn(45).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 8 * 1024);
    b.file(1, size, 8 * 1024);
    let (sa, _sb, own) = c.copies(&a, &b, "changed").await;
    b.file_variant(1, grown, 8 * 1024, Variant::Differs);
    iptv_core::downloads::set_playback(&c.state, "tv", vec![sa.clone()]).await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    let deadline = Instant::now() + WAIT;
    while !c.identical(&own).await.is_empty() {
        let row = c.get(d.id).await;
        assert_ne!(
            row.status,
            DownloadStatus::Completed,
            "completed from B: {row:?}"
        );
        assert!(Instant::now() < deadline, "the verdict stayed: {row:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    iptv_core::downloads::set_playback(&c.state, "tv", Vec::new()).await;
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
}

/// "Use identical copies" turned off while a mirror serves part of the
/// file: the mirror leaves within a few ticks.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn turning_mirrors_off_drops_a_running_mirror() {
    let c = xctx().await;
    let size = 96 * MIB;
    let (a, b) = (Panel::spawn(46).await, Panel::spawn(47).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 3 * 1024);
    b.file(1, size, 3 * 1024);
    let (sa, _sb, _) = c.copies(&a, &b, "off").await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "used the mirror", |d| d.sources == Some(2))
        .await;
    c.state.settings.write().download_use_mirrors = false;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let row = c.get(d.id).await;
    let before = b.log().len();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after = b.log().len();
    let open = b.open();
    c.ok("downloads.cancel", json!({"id": d.id})).await;
    assert_ne!(row.sources, Some(2), "{row:?}");
    assert_eq!(before, after, "the mirror still got requests");
    assert_eq!(open, 0, "the mirror still holds a connection");
}

const WEEK: Duration = Duration::from_secs(7 * 24 * 3600);

/// Requests of the probe of a `size`-byte file 1.
fn probe_requests(panel: &Panel, size: u64) -> usize {
    let at = size - 32 * MIB;
    panel
        .log()
        .iter()
        .filter(|l| l.file == 1 && l.range == Some((at, Some(size - 1))))
        .count()
}

/// Waits until a probe learned the limit of `source`.
async fn learned(c: &Ctx, source: &str) {
    let deadline = Instant::now() + WAIT;
    loop {
        let limits = iptv_core::downloads::connection_limits(&c.state)
            .await
            .unwrap();
        if limits
            .iter()
            .any(|l| l.source_id == source && l.learned.is_some())
        {
            return;
        }
        assert!(Instant::now() < deadline, "never probed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A probing transfer of 96 MiB on a new source `source` (one connection
/// reported), and the panel.
async fn probing(c: &Ctx, source: &str, seed: u64) -> (Panel, Download) {
    iptv_core::downloads::set_probe_timing(&c.state, Duration::from_millis(200), WEEK);
    let panel = Panel::with(PanelOptions {
        seed,
        validators: Validators::None,
        ..PanelOptions::default()
    })
    .await;
    panel.set_reported(1);
    panel.set_enforced(1);
    add_xtream_source(&c.state, source, &panel).await;
    panel.file(1, 96 * MIB, 1024);
    add_movie(&c.state, source, 1, "Movie 1", None, "mp4").await;
    let d = c.start_movie(source, 1, &panel.movie_url(1)).await;
    learned(c, source).await;
    (panel, d)
}

/// Pauses the probing transfer once the probe learned the limit, runs
/// `setup`, makes the retest due and resumes: no probe request follows.
async fn no_probe_after_resume(c: &Ctx, source: &str, seed: u64, setup: impl Fn(&Ctx)) {
    let (panel, d) = probing(c, source, seed).await;
    let part = c.pause(d.id).await;
    assert!(sidecar(&part).exists(), "a sidecar after the split");
    let before = probe_requests(&panel, 96 * MIB);
    setup(c);
    iptv_core::downloads::age_connection_limit(&c.state, source, WEEK + Duration::from_secs(60))
        .await
        .unwrap();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let after = probe_requests(&panel, 96 * MIB);
    c.ok("downloads.cancel", json!({"id": d.id})).await;
    assert_eq!(after, before, "a probe ran: {:?}", panel.log());
}

/// A probe never runs where the transfer may not split: a resumed split
/// file under a global speed cap.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_probe_runs_on_a_resumed_file_under_a_speed_cap() {
    let c = xctx().await;
    no_probe_after_resume(&c, "nr", 48, |c| {
        c.state.settings.write().download_rate_limit_bps = 2 * MIB
    })
    .await;
}

/// The same for a source set to one connection per download.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_probe_runs_on_a_resumed_file_of_a_single_connection_source() {
    let c = xctx().await;
    no_probe_after_resume(&c, "ns", 49, |c| {
        c.state.settings.write().download_single_connection = vec!["ns".into()]
    })
    .await;
}

/// A speed cap set on a running split transfer: the weekly retest that
/// comes due then waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_probe_runs_in_flight_under_a_per_download_speed_cap() {
    let c = xctx().await;
    let (panel, d) = probing(&c, "nq", 50).await;
    c.ok(
        "downloads.setRateLimit",
        json!({"id": d.id, "bytesPerSecond": 2 * MIB}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = probe_requests(&panel, 96 * MIB);
    iptv_core::downloads::age_connection_limit(&c.state, "nq", WEEK + Duration::from_secs(60))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let after = probe_requests(&panel, 96 * MIB);
    c.ok("downloads.cancel", json!({"id": d.id})).await;
    assert_eq!(after, before, "a probe ran: {:?}", panel.log());
}

/// The second address of the host has nothing listening. A slow
/// connection reopened there goes the usual way instead, and the transfer
/// keeps its connections: a dead address is not the provider refusing one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dead_address_is_skipped_and_never_taken_for_a_refusal() {
    let c = ctx().await;
    c.limit(3).await;
    let panel = Panel::spawn(53).await;
    let port = panel.port();
    iptv_core::http::set_dns_override(
        &c.state,
        "localhost",
        vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)), port),
        ],
    );
    iptv_core::downloads::manager::manager(&c.state)
        .set_ramp_timing(Duration::from_secs(1), Duration::from_millis(500));
    let size = 64 * MIB;
    panel.file(1, size, 2048);
    let head = panel.hold_next_head();
    let d = c.start(&format!("http://localhost:{port}/f/1")).await;
    head.held().await;
    panel.set_speed(1, 64);
    head.release();
    until("split", || panel.log().len() >= 2).await;
    // The slow connection is reopened (on the dead address) after about
    // five seconds, and its request goes out after the close grace.
    tokio::time::sleep(Duration::from_secs(4)).await;
    c.drain_events();
    let stats = c
        .collect("downloads.stats", d.id, Duration::from_secs(6))
        .await;
    panel.set_speed(1, 1024);
    let path = c.completed(d.id).await;
    dl_panel::is_exact(1, size, &path).unwrap();
    for s in &stats {
        let notes = s["notes"].as_array().cloned().unwrap_or_default();
        assert!(
            !notes.iter().any(|n| n["kind"] == "oneConnection"),
            "fell to one connection: {notes:?}"
        );
    }
    let last = stats.last().expect("a breakdown");
    assert_eq!(last["connections"].as_array().unwrap().len(), 2, "{last}");
}

/// The mirror search runs again while no mirror serves the transfer: B
/// was busy when the transfer started and is free a while later.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn the_mirror_search_runs_again_while_no_mirror_serves() {
    let c = xctx().await;
    let size = 96 * MIB;
    let (a, b) = (Panel::spawn(54).await, Panel::spawn(55).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 512);
    b.file(1, size, 512);
    let sa = add_xtream_source(&c.state, "again-a", &a).await;
    let sb = add_xtream_source(&c.state, "again-b", &b).await;
    for s in [&sa, &sb] {
        add_movie(&c.state, s, 1, "Busy Copy (2021)", Some(2021), "mp4").await;
    }
    c.state.settings.write().download_probe_disabled = vec![sa.clone(), sb.clone()];
    // B plays: the first search cannot verify its copy.
    iptv_core::downloads::set_playback(&c.state, "tv", vec![sb.clone()]).await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "started", |d| d.bytes_downloaded > MIB as i64)
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_ne!(c.get(d.id).await.sources, Some(2));
    // B is free, and the verdict that it was busy has run out.
    iptv_core::downloads::set_playback(&c.state, "tv", Vec::new()).await;
    mirrors::age_records(&c.state, Duration::from_secs(3 * 3600))
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(80);
    loop {
        let row = c.get(d.id).await;
        if row.sources == Some(2) {
            break;
        }
        assert!(Instant::now() < deadline, "no second search: {row:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    c.ok("downloads.cancel", json!({"id": d.id})).await;
}
