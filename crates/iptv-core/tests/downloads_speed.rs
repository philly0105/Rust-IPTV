//! Speed lab: what the download speed work gains, measured end to end
//! against `dl_panel` panels that behave like the user's providers (about
//! 6 MiB/s per connection, accounts that report 1 connection, a 24 MiB/s
//! line shared by every provider, panels that send no validator, panels that
//! kick the oldest connection).
//!
//! Each scenario prints one line, `SCn: before X.X MB/s, after Y.Y MB/s,
//! ratio Z.ZZ` (MB here is MiB, the unit the panels' caps are set in), then
//! asserts what the spec promises: the ratio, byte-exact output, and that no
//! panel ever saw more connections than it allows. Run with
//! `cargo test -p iptv-core --test downloads_speed -- --nocapture` to see the
//! numbers.
//!
//! - SC1: one file from four accounts with identical copies fills the line.
//! - SC2: a provider without ETag or Last-Modified still splits.
//! - SC3: a copy that differs is never used; a copy that differs only where a
//!   fingerprint does not look is caught by the overlap checks; a file that
//!   changes under a no-validator split restarts on one connection.
//! - SC4: connection-limit probes against a panel that refuses, one that
//!   allows 3, and one that kicks the oldest connection.
//! - SC5: a season queued on one account runs on four at once.
//! - `writer_keeps_up`: the loopback download rate, asserted at 100 MB/s in
//!   release builds only (debug builds generate the panel's bytes too slowly
//!   to say anything about the writer).
//!
//! Timings are shortened through the test hooks (ramp window, probe step),
//! and sizes are what the spec names except where a comment says otherwise;
//! ratios, never absolute rates, are asserted in debug builds.

mod dl_panel;

use dl_panel::{
    add_movie, add_series, add_xtream_source, movie_ref, variant_content, LimitMode, Line, Panel,
    PanelOptions, Validators, Variant,
};
use iptv_core::downloads::shared::{self, MirrorRecord, Verdict};
use iptv_core::model::{
    ConnectionLimitMode, CopyRef, Download, DownloadStatus, OneConnectionReason, Settings,
    SourceConnectionLimit, TransferNote, TransferStats,
};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;
/// Longest any one transfer may take before the scenario fails.
const WAIT: Duration = Duration::from_secs(240);
/// The ramp window the lab runs with (1 s in the app): connections are added
/// sooner, so short scenarios reach their plateau early.
const GAIN_WINDOW: Duration = Duration::from_millis(400);
/// How long the lab's probes hold each extra connection (3 s in the app).
const PROBE_STEP: Duration = Duration::from_millis(300);
const WEEK: Duration = Duration::from_secs(7 * 24 * 3600);

/// What the events showed about each row.
#[derive(Default)]
struct Seen {
    /// Most connections each row reported at once.
    connections: HashMap<i64, usize>,
    /// Most sources each row drew on at once.
    sources: HashMap<i64, usize>,
    /// Every distinct note each row's stats carried, in arrival order.
    notes: HashMap<i64, Vec<TransferNote>>,
    /// Stats events received per row.
    stats: HashMap<i64, usize>,
}

impl Seen {
    fn connections(&mut self, id: i64, n: usize) {
        let e = self.connections.entry(id).or_default();
        *e = (*e).max(n);
    }

    fn sources(&mut self, id: i64, n: usize) {
        let e = self.sources.entry(id).or_default();
        *e = (*e).max(n);
    }

    fn stats(&mut self, s: &TransferStats) {
        *self.stats.entry(s.id).or_default() += 1;
        self.connections(s.id, s.connections.len());
        self.sources(
            s.id,
            s.sources.iter().filter(|src| src.connections > 0).count(),
        );
        let notes = self.notes.entry(s.id).or_default();
        for n in &s.notes {
            if !notes.contains(n) {
                notes.push(n.clone());
            }
        }
    }
}

/// One app with the downloads RPC, and a task reading its events.
struct Lab {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    seen: Arc<Mutex<Seen>>,
    collector: tokio::task::JoinHandle<()>,
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.collector.abort();
    }
}

/// One finished transfer.
#[derive(Debug, Clone)]
struct Run {
    download: Download,
    bytes: u64,
    secs: f64,
}

impl Run {
    fn mbps(&self) -> f64 {
        mbps(self.bytes, self.secs)
    }

    fn path(&self) -> &Path {
        Path::new(
            self.download
                .file_path
                .as_deref()
                .expect("a finished row has a file"),
        )
    }
}

fn mbps(bytes: u64, secs: f64) -> f64 {
    bytes as f64 / MIB as f64 / secs.max(1e-6)
}

/// Prints the scenario line every speed scenario ends with, before its
/// assertions, so a failing run still shows its numbers.
fn report(sc: &str, before: f64, after: f64, what: &str) -> f64 {
    let ratio = after / before.max(1e-6);
    println!("{sc}: before {before:.1} MB/s, after {after:.1} MB/s, ratio {ratio:.2} ({what})");
    ratio
}

async fn lab() -> Lab {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, mut events) = BroadcastSink::channel(65_536);
    let state = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    iptv_core::downloads::init(state.clone()).await.unwrap();
    iptv_core::downloads::set_ramp_timing(&state, GAIN_WINDOW, Duration::from_secs(10));
    iptv_core::downloads::set_probe_timing(&state, PROBE_STEP, WEEK);
    let mut router = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut router);
    let seen = Arc::new(Mutex::new(Seen::default()));
    let sink_seen = Arc::clone(&seen);
    let collector = tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            let ev = match events.recv().await {
                Ok(ev) => ev,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return,
            };
            match ev.kind.as_str() {
                "downloads.stats" => {
                    if let Ok(s) = serde_json::from_value::<TransferStats>(ev.payload) {
                        sink_seen.lock().stats(&s);
                    }
                }
                "downloads.progress" => {
                    let Some(id) = ev.payload["id"].as_i64() else {
                        continue;
                    };
                    let mut seen = sink_seen.lock();
                    if let Some(n) = ev.payload["connections"].as_u64() {
                        seen.connections(id, n as usize);
                    }
                    if let Some(n) = ev.payload["sources"].as_u64() {
                        seen.sources(id, n as usize);
                    }
                }
                _ => {}
            }
        }
    });
    Lab {
        _tmp: tmp,
        state,
        router,
        seen,
        collector,
    }
}

impl Lab {
    async fn ok(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

    async fn get(&self, id: i64) -> Download {
        serde_json::from_value(self.ok("downloads.get", json!({"id": id})).await).unwrap()
    }

    async fn list(&self) -> Vec<Download> {
        serde_json::from_value(self.ok("downloads.list", Value::Null).await).unwrap()
    }

    /// Applies `change` to the settings through the app's own save.
    async fn settings(&self, change: impl FnOnce(&mut Settings)) {
        let mut next = self.state.settings_snapshot();
        change(&mut next);
        iptv_core::settings::save(&self.state, next).await.unwrap();
    }

    /// An Xtream source on `panel` (call `set_reported` first).
    async fn source(&self, id: &str, panel: &Panel) -> String {
        add_xtream_source(&self.state, id, panel).await
    }

    async fn start_movie(&self, source: &str, item: u32, title: &str, url: &str) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": source, "contentType": "movie", "itemId": item.to_string()},
                    "title": title,
                    "url": url,
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    async fn start_episode(
        &self,
        source: &str,
        series: u32,
        episode: u32,
        title: &str,
        url: &str,
    ) -> Download {
        let v = self
            .ok(
                "downloads.start",
                json!({
                    "ref": {"sourceId": source, "contentType": "series", "itemId": series.to_string()},
                    "episodeId": episode.to_string(),
                    "title": title,
                    "url": url,
                }),
            )
            .await;
        serde_json::from_value(v).unwrap()
    }

    /// Notes what a row shows right now (connections, sources).
    fn sample(&self, d: &Download) {
        let mut seen = self.seen.lock();
        if let Some(n) = d.connections {
            seen.connections(d.id, n);
        }
        if let Some(n) = d.sources {
            seen.sources(d.id, n);
        }
        if let Some(s) = &d.stats {
            seen.stats(s);
        }
    }

    /// Waits until row `id` completes; a row that fails ends the scenario.
    async fn finish(&self, id: i64) -> Download {
        let deadline = Instant::now() + WAIT;
        loop {
            let d = self.get(id).await;
            self.sample(&d);
            match d.status {
                DownloadStatus::Completed => return d,
                DownloadStatus::Failed | DownloadStatus::Canceled => {
                    panic!("download {id} ended {:?}: {:?}", d.status, d.error_message)
                }
                _ => {}
            }
            assert!(
                Instant::now() < deadline,
                "download {id} never completed: {:?}, {} bytes, {:?} connections, {:?}",
                d.status,
                d.bytes_downloaded,
                d.connections,
                d.error_message
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Downloads movie `item` of `source` (`size` bytes) and times it from
    /// the request to completion.
    async fn run_movie(&self, source: &str, item: u32, title: &str, url: &str, size: u64) -> Run {
        let began = Instant::now();
        let d = self.start_movie(source, item, title, url).await;
        let download = self.finish(d.id).await;
        Run {
            download,
            bytes: size,
            secs: began.elapsed().as_secs_f64(),
        }
    }

    fn max_connections(&self, id: i64) -> usize {
        self.seen.lock().connections.get(&id).copied().unwrap_or(1)
    }

    fn max_sources(&self, id: i64) -> usize {
        self.seen.lock().sources.get(&id).copied().unwrap_or(1)
    }

    fn notes(&self, id: i64) -> Vec<TransferNote> {
        self.seen.lock().notes.get(&id).cloned().unwrap_or_default()
    }

    /// `downloads.connectionLimits`' entry for `source`.
    async fn limit(&self, source: &str) -> Option<SourceConnectionLimit> {
        let all: Vec<SourceConnectionLimit> =
            serde_json::from_value(self.ok("downloads.connectionLimits", Value::Null).await)
                .unwrap();
        all.into_iter().find(|l| l.source_id == source)
    }

    /// The mirror record stored under `copy`'s key.
    async fn mirror_record(&self, copy: &CopyRef) -> Option<MirrorRecord> {
        let key = shared::mirror_key(copy);
        self.state
            .db_call(move |c| shared::read_record::<MirrorRecord>(c, &key))
            .await
            .unwrap()
    }

    /// The newest verdict on `other` in `copy`'s record.
    async fn verdict(&self, copy: &CopyRef, other: &str) -> Option<Verdict> {
        let record = self.mirror_record(copy).await?;
        record
            .verdicts
            .iter()
            .filter(|v| v.copy.source_id() == other)
            .max_by(|a, b| a.checked_at.cmp(&b.checked_at))
            .map(|v| v.verdict)
    }
}

/// Whether the file at `path` is exactly `variant`'s copy of `file`.
fn is_variant(file: u32, variant: Variant, size: u64, path: &Path) -> Result<(), String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len != size {
        return Err(format!("{len} bytes instead of {size}"));
    }
    let mut buf = vec![0u8; MIB as usize];
    let mut at = 0u64;
    while at < size {
        let n = (size - at).min(MIB) as usize;
        f.read_exact(&mut buf[..n]).map_err(|e| e.to_string())?;
        let want = variant_content(file, variant, size, at, n);
        if let Some(j) = buf[..n].iter().zip(&want).position(|(a, b)| a != b) {
            return Err(format!(
                "byte {} is not the {variant:?} copy's",
                at + j as u64
            ));
        }
        at += n as u64;
    }
    Ok(())
}

fn assert_exact(file: u32, size: u64, run: &Run) {
    if let Err(e) = dl_panel::is_exact(file, size, run.path()) {
        panic!("file {file}: {e}");
    }
}

/// Successful range requests for `file` that start past byte 0: the split.
fn split_requests(panel: &Panel, file: u32) -> usize {
    panel
        .log()
        .iter()
        .filter(|l| l.file == file && l.status == 206 && l.range.is_some_and(|(a, _)| a > 0))
        .count()
}

/// Whether `panel` served any bytes of `file` with a 206.
fn served_ranges(panel: &Panel, file: u32) -> bool {
    panel
        .log()
        .iter()
        .any(|l| l.file == file && l.status == 206)
}

fn movie_copy(source: &str, item: u32) -> CopyRef {
    CopyRef::new(movie_ref(source, item), None)
}

// ---------------------------------------------------------------------------
// SC1
// ---------------------------------------------------------------------------

/// SC1: four accounts allowing one connection each, every one with a
/// byte-identical copy, 6 MiB/s per connection and a 24 MiB/s line shared by
/// all of them. One account alone gives one connection's speed; the four
/// together fill the line.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc1_four_identical_copies_fill_the_line() {
    const SIZE: u64 = 200 * MIB;
    const BASELINE: u64 = 64 * MIB;
    const KBPS: u64 = 6 * 1024;
    let lab = lab().await;
    let line = Line::new(24 * MIB);
    let mut panels = Vec::new();
    let mut sources = Vec::new();
    for i in 0..4u64 {
        let p = Panel::with(PanelOptions {
            seed: 100 + i,
            line: Some(line.clone()),
            ..PanelOptions::default()
        })
        .await;
        p.set_enforced(1);
        p.set_reported(1);
        p.file(1, SIZE, KBPS);
        p.file(2, BASELINE, KBPS);
        let sid = lab.source(&format!("sc1-{i}"), &p).await;
        add_movie(&lab.state, &sid, 1, "Speed Lab (2024)", Some(2024), "mp4").await;
        add_movie(
            &lab.state,
            &sid,
            2,
            "Lab Baseline (2023)",
            Some(2023),
            "mp4",
        )
        .await;
        panels.push(p);
        sources.push(sid);
    }
    let all = sources.clone();
    lab.settings(|s| {
        s.download_probe_disabled = all;
        s.download_use_mirrors = false;
    })
    .await;

    let before = lab
        .run_movie(
            &sources[0],
            2,
            "Lab Baseline",
            &panels[0].movie_url(2),
            BASELINE,
        )
        .await;
    lab.settings(|s| s.download_use_mirrors = true).await;
    let after = lab
        .run_movie(&sources[0], 1, "Speed Lab", &panels[0].movie_url(1), SIZE)
        .await;
    let ratio = report(
        "SC1",
        before.mbps(),
        after.mbps(),
        &format!(
            "64 MiB on one account, then 200 MiB over {} sources and {} connections",
            lab.max_sources(after.download.id),
            lab.max_connections(after.download.id)
        ),
    );

    assert_exact(2, BASELINE, &before);
    assert_exact(1, SIZE, &after);
    for (i, p) in panels.iter().enumerate() {
        assert!(
            p.peak() <= 1,
            "panel {i} saw {} connections at once",
            p.peak()
        );
    }
    let serving = panels.iter().filter(|p| served_ranges(p, 1)).count();
    assert!(
        serving >= 3,
        "only {serving} of 4 panels served ranges of the file"
    );
    assert!(ratio >= 3.0, "SC1 ratio {ratio:.2} is below 3.0");
}

// ---------------------------------------------------------------------------
// SC2
// ---------------------------------------------------------------------------

/// SC2: a provider that answers Range with a total but sends neither ETag
/// nor Last-Modified, on an account allowing 4 (3 for downloads: one stays
/// free for playback). The baseline keeps the source on one connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc2_a_provider_without_validators_still_splits() {
    const SIZE: u64 = 200 * MIB;
    // The single-connection baseline runs on a smaller file: 200 MiB at one
    // connection's 6 MiB/s would add half a minute and change nothing.
    const BASELINE: u64 = 64 * MIB;
    const KBPS: u64 = 6 * 1024;
    let lab = lab().await;
    let p = Panel::with(PanelOptions {
        seed: 200,
        validators: Validators::None,
        ..PanelOptions::default()
    })
    .await;
    p.set_reported(4);
    p.set_enforced(4);
    p.file(1, SIZE, KBPS);
    p.file(2, BASELINE, KBPS);
    let sid = lab.source("sc2", &p).await;
    add_movie(
        &lab.state,
        &sid,
        1,
        "No Validator (2024)",
        Some(2024),
        "mp4",
    )
    .await;
    add_movie(&lab.state, &sid, 2, "One Pipe (2023)", Some(2023), "mp4").await;
    let only = vec![sid.clone()];
    lab.settings(|s| {
        s.download_probe_disabled = only.clone();
        s.download_single_connection = only;
    })
    .await;

    let before = lab
        .run_movie(&sid, 2, "One Pipe", &p.movie_url(2), BASELINE)
        .await;
    lab.settings(|s| s.download_single_connection = Vec::new())
        .await;
    let after = lab
        .run_movie(&sid, 1, "No Validator", &p.movie_url(1), SIZE)
        .await;
    let ratio = report(
        "SC2",
        before.mbps(),
        after.mbps(),
        &format!(
            "no ETag or Last-Modified, {} connections",
            lab.max_connections(after.download.id)
        ),
    );

    assert_exact(2, BASELINE, &before);
    assert_exact(1, SIZE, &after);
    assert_eq!(split_requests(&p, 2), 0, "the baseline split");
    let splits = split_requests(&p, 1);
    assert!(splits >= 2, "only {splits} range requests past byte 0");
    assert!(p.peak() <= 4, "the panel saw {} connections", p.peak());
    assert!(ratio >= 2.5, "SC2 ratio {ratio:.2} is below 2.5");
}

// ---------------------------------------------------------------------------
// SC3
// ---------------------------------------------------------------------------

/// Two accounts with one connection each, `mirror_variant` being what the
/// second holds of file 1 (`size` bytes at `kbps` on both). Returns the lab,
/// the panels and the source ids (authority first).
async fn two_copies(
    tag: &str,
    size: u64,
    kbps: u64,
    mirror_variant: Variant,
) -> (Lab, [Panel; 2], [String; 2]) {
    let lab = lab().await;
    let a = Panel::spawn(300).await;
    let b = Panel::spawn(301).await;
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, kbps);
    b.file_variant(1, size, kbps, mirror_variant);
    let sa = lab.source(&format!("{tag}-a"), &a).await;
    let sb = lab.source(&format!("{tag}-b"), &b).await;
    for s in [&sa, &sb] {
        add_movie(&lab.state, s, 1, "Two Copies (2022)", Some(2022), "mp4").await;
    }
    let both = vec![sa.clone(), sb.clone()];
    lab.settings(|s| s.download_probe_disabled = both).await;
    (lab, [a, b], [sa, sb])
}

/// SC3a: a copy of the same size whose bytes differ fails verification and
/// serves nothing past its fingerprint.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc3_differing_mirror_is_never_used() {
    const SIZE: u64 = 32 * MIB;
    const KBPS: u64 = 8 * 1024;
    let (lab, [a, b], [sa, sb]) = two_copies("sc3a", SIZE, KBPS, Variant::Differs).await;
    let run = lab
        .run_movie(&sa, 1, "Two Copies", &a.movie_url(1), SIZE)
        .await;
    report(
        "SC3a",
        mbps(KBPS * 1024, 1.0),
        run.mbps(),
        "before: one connection's cap; the differing copy adds nothing",
    );

    assert_exact(1, SIZE, &run);
    let mirror: Vec<_> = b.log().into_iter().filter(|l| l.file == 1).collect();
    assert!(
        mirror.len() <= 3,
        "the differing copy got {} requests: {mirror:?}",
        mirror.len()
    );
    for l in &mirror {
        let len = l.range.and_then(|(a, b)| Some(b? + 1 - a));
        assert_eq!(
            len,
            Some(shared::SAMPLE_LEN as u64),
            "not a fingerprint request: {l:?}"
        );
    }
    assert!(
        !lab.notes(run.download.id)
            .iter()
            .any(|n| matches!(n, TransferNote::MirrorAdded { source_id } if *source_id == sb)),
        "the differing copy was added as a mirror"
    );
    assert_eq!(
        lab.verdict(&movie_copy(&sa, 1), &sb).await,
        Some(Verdict::Differs),
        "no differs verdict stored under the authority's record"
    );
    assert!(a.peak() <= 1 && b.peak() <= 1);
}

/// SC3b: a copy that matches the fingerprint windows but differs everywhere
/// else passes verification; the overlap checks catch it, its bytes are
/// discarded, and the file completes byte-exact from the authority.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc3_planted_mismatch_is_caught() {
    const SIZE: u64 = 32 * MIB;
    const KBPS: u64 = 4 * 1024;
    let (lab, [a, b], [sa, sb]) =
        two_copies("sc3b", SIZE, KBPS, Variant::DiffersOutsideSamples).await;
    let run = lab
        .run_movie(&sa, 1, "Two Copies", &a.movie_url(1), SIZE)
        .await;
    report(
        "SC3b",
        mbps(KBPS * 1024, 1.0),
        run.mbps(),
        "before: one connection's cap; the planted copy is caught and dropped",
    );

    assert_exact(1, SIZE, &run);
    let notes = lab.notes(run.download.id);
    assert!(
        notes
            .iter()
            .any(|n| matches!(n, TransferNote::MirrorMismatch { source_id } if *source_id == sb)),
        "no mirrorMismatch note for the planted copy: {notes:?}"
    );
    assert!(
        served_ranges(&b, 1)
            && b.log().iter().any(|l| l.file == 1
                && l.range
                    .is_some_and(|(a, z)| z.is_none_or(|z| z + 1 - a > shared::SAMPLE_LEN as u64))),
        "the planted copy never served a segment, so nothing was caught"
    );
    assert_eq!(
        lab.verdict(&movie_copy(&sa, 1), &sb).await,
        Some(Verdict::Differs),
        "the planted copy's verdict did not become differs"
    );
    assert!(a.peak() <= 1 && b.peak() <= 1);
}

/// SC3: a provider without validators changes the file while a split
/// download is paused. The resumed segments' lead-in overlap no longer
/// matches the bytes on disk, so the transfer drops its `.part` and starts
/// over on one connection: the result is wholly the new file, never a
/// stitch of both.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc3_no_validator_change_restarts_on_one_connection() {
    const SIZE: u64 = 32 * MIB;
    const KBPS: u64 = 4 * 1024;
    let lab = lab().await;
    let p = Panel::with(PanelOptions {
        seed: 310,
        validators: Validators::None,
        ..PanelOptions::default()
    })
    .await;
    p.set_reported(4);
    p.set_enforced(4);
    p.file(1, SIZE, KBPS);
    let sid = lab.source("sc3c", &p).await;
    add_movie(&lab.state, &sid, 1, "Changing (2021)", Some(2021), "mp4").await;
    let only = vec![sid.clone()];
    lab.settings(|s| s.download_probe_disabled = only).await;

    let began = Instant::now();
    let d = lab.start_movie(&sid, 1, "Changing", &p.movie_url(1)).await;
    // Split, with bytes on disk in more than one segment.
    let deadline = Instant::now() + WAIT;
    loop {
        let now = lab.get(d.id).await;
        lab.sample(&now);
        if lab.max_connections(d.id) >= 2 && now.bytes_downloaded >= (6 * MIB) as i64 {
            break;
        }
        assert!(
            now.status != DownloadStatus::Completed,
            "the file completed before it split"
        );
        assert!(
            Instant::now() < deadline,
            "the no-validator file never split: {:?} connections",
            now.connections
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    lab.ok("downloads.pause", json!({"id": d.id})).await;
    let deadline = Instant::now() + WAIT;
    while lab.get(d.id).await.status != DownloadStatus::Paused {
        assert!(Instant::now() < deadline, "never paused");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let requests_before = p.log().len();
    // The provider swaps the file (same size, other bytes), then the user
    // resumes.
    p.file_variant(1, SIZE, KBPS, Variant::Differs);
    lab.ok("downloads.resume", json!({"id": d.id})).await;
    let done = lab.finish(d.id).await;
    let secs = began.elapsed().as_secs_f64();
    report(
        "SC3c",
        mbps(KBPS * 1024, 1.0),
        mbps(SIZE, secs),
        "before: one connection's cap; after includes the restart",
    );

    let path = Path::new(done.file_path.as_deref().unwrap());
    if let Err(e) = is_variant(1, Variant::Differs, SIZE, path) {
        panic!("the file is not wholly the changed copy (a stitch?): {e}");
    }
    let notes = lab.notes(d.id);
    assert!(
        notes.iter().any(|n| matches!(
            n,
            TransferNote::OneConnection {
                reason: OneConnectionReason::Changed
            }
        )),
        "no oneConnection{{changed}} note: {notes:?}"
    );
    // After the restart the whole file came again, from byte 0.
    let after: Vec<_> = p.log().into_iter().skip(requests_before).collect();
    assert!(
        after
            .iter()
            .any(|l| l.status / 100 == 2 && l.range.is_none_or(|(a, _)| a == 0)),
        "no request from byte 0 after the change: {after:?}"
    );
}

// ---------------------------------------------------------------------------
// SC4
// ---------------------------------------------------------------------------

/// One account on `p` (reported 1) with `files` movies of `size` bytes at
/// `kbps`, each its own title (no mirrors). Probing stays on.
async fn probe_lab(tag: &str, p: &Panel, files: u32, size: u64, kbps: u64) -> (Lab, String) {
    let lab = lab().await;
    p.set_reported(1);
    for f in 1..=files {
        p.file(f, size, kbps);
    }
    let sid = lab.source(tag, p).await;
    for f in 1..=files {
        add_movie(
            &lab.state,
            &sid,
            f,
            &format!("Probe {tag} {f} (2020)"),
            Some(2020),
            "mp4",
        )
        .await;
    }
    (lab, sid)
}

fn refusals(p: &Panel) -> u64 {
    p.counts().get("refused").copied().unwrap_or(0)
}

/// SC4, refuse: the panel allows what it reports (1). The first transfer
/// probes once and is refused; a second within the week does not probe; a
/// third after the record ages past a week probes again.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc4_a_refusing_panel_is_probed_once_a_week() {
    const SIZE: u64 = 64 * MIB;
    const KBPS: u64 = 12 * 1024;
    let p = Panel::spawn(400).await;
    p.set_enforced(1);
    let (lab, sid) = probe_lab("sc4r", &p, 3, SIZE, KBPS).await;

    let first = lab
        .run_movie(&sid, 1, "Probe 1", &p.movie_url(1), SIZE)
        .await;
    let refused_once = refusals(&p);
    let record = lab.limit(&sid).await;
    let second = lab
        .run_movie(&sid, 2, "Probe 2", &p.movie_url(2), SIZE)
        .await;
    let refused_twice = refusals(&p);
    let record_after = lab.limit(&sid).await;
    iptv_core::downloads::age_connection_limit(
        &lab.state,
        &sid,
        Duration::from_secs(8 * 24 * 3600),
    )
    .await
    .unwrap();
    let third = lab
        .run_movie(&sid, 3, "Probe 3", &p.movie_url(3), SIZE)
        .await;
    report(
        "SC4",
        first.mbps(),
        second.mbps(),
        "refusing panel: the transfer that probed, then one within the week",
    );

    for (f, run) in [(1, &first), (2, &second), (3, &third)] {
        assert_exact(f, SIZE, run);
    }
    assert_eq!(
        refused_once, 1,
        "the first transfer's probe was not refused exactly once"
    );
    let record = record.expect("no connection limit listed for the probed source");
    assert_eq!(record.mode, Some(ConnectionLimitMode::Refuse), "{record:?}");
    assert_eq!(record.learned, Some(1), "{record:?}");
    assert!(record.probed_at.is_some() && record.next_probe_at.is_some());
    assert_eq!(
        refused_twice, refused_once,
        "a second transfer within the week probed again"
    );
    assert_eq!(
        record_after.and_then(|r| r.probed_at),
        record.probed_at,
        "the record changed without a probe"
    );
    assert_eq!(
        refusals(&p),
        refused_once + 1,
        "the record aged past a week, but the third transfer did not probe once"
    );
    assert!(p.peak() <= 1);
}

/// SC4, allow 3: the account reports 1, the panel allows 3. The probe
/// learns 3, and (amendment A1: a learned limit keeps no connection for
/// playback) the transfer goes on with 3 connections and never more.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc4_a_panel_allowing_three_is_learned_and_used() {
    const SIZE: u64 = 64 * MIB;
    const BASELINE: u64 = 24 * MIB;
    const KBPS: u64 = 6 * 1024;
    let p = Panel::spawn(410).await;
    p.set_enforced(3);
    let (lab, sid) = probe_lab("sc4a", &p, 1, SIZE, KBPS).await;
    p.file(9, BASELINE, KBPS);
    add_movie(
        &lab.state,
        &sid,
        9,
        "Probe Baseline (2019)",
        Some(2019),
        "mp4",
    )
    .await;

    let only = vec![sid.clone()];
    lab.settings(|s| s.download_probe_disabled = only).await;
    let before = lab
        .run_movie(&sid, 9, "Probe Baseline", &p.movie_url(9), BASELINE)
        .await;
    let peak_before = p.peak();
    lab.settings(|s| s.download_probe_disabled = Vec::new())
        .await;
    let after = lab
        .run_movie(&sid, 1, "Probe 1", &p.movie_url(1), SIZE)
        .await;
    let ratio = report(
        "SC4",
        before.mbps(),
        after.mbps(),
        &format!(
            "panel allowing 3 behind a reported 1: probing off, then on ({} connections)",
            lab.max_connections(after.download.id)
        ),
    );

    assert_exact(9, BASELINE, &before);
    assert_exact(1, SIZE, &after);
    assert_eq!(
        peak_before, 1,
        "without a probe the reported 1 was not kept"
    );
    let record = lab
        .limit(&sid)
        .await
        .expect("no connection limit listed for the probed source");
    assert_eq!(record.learned, Some(3), "{record:?}");
    assert_eq!(record.reported, Some(1), "{record:?}");
    assert_eq!(p.peak(), 3, "the panel never saw 3 connections at once");
    assert!(
        lab.max_connections(after.download.id) >= 3,
        "the transfer itself never ran 3 connections"
    );
    assert!(
        ratio > 1.5,
        "the learned limit did not speed the transfer up (ratio {ratio:.2})"
    );
}

/// SC4, kick-oldest: the panel accepts a second connection and ends the
/// oldest (the transfer's own). The probe sees the kick, records limit 1,
/// and the file still completes byte-exact.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc4_a_kick_oldest_panel_is_detected_without_corruption() {
    const SIZE: u64 = 64 * MIB;
    const KBPS: u64 = 12 * 1024;
    let p = Panel::with(PanelOptions {
        seed: 420,
        limit_mode: LimitMode::KickOldest,
        ..PanelOptions::default()
    })
    .await;
    p.set_enforced(1);
    let (lab, sid) = probe_lab("sc4k", &p, 1, SIZE, KBPS).await;
    let run = lab
        .run_movie(&sid, 1, "Probe 1", &p.movie_url(1), SIZE)
        .await;
    report(
        "SC4",
        mbps(KBPS * 1024, 1.0),
        run.mbps(),
        "kick-oldest panel: before is one connection's cap",
    );

    assert_exact(1, SIZE, &run);
    assert!(p.kicked() >= 1, "the panel never kicked a connection");
    let record = lab
        .limit(&sid)
        .await
        .expect("no connection limit listed for the probed source");
    assert_eq!(
        record.mode,
        Some(ConnectionLimitMode::KickOldest),
        "{record:?}"
    );
    assert_eq!(record.learned, Some(1), "{record:?}");
    let notes = lab.notes(run.download.id);
    assert!(
        notes.iter().any(
            |n| matches!(n, TransferNote::ProbeKickedOldest { source_id } if *source_id == sid)
        ),
        "no probeKickedOldest note: {notes:?}"
    );
}

// ---------------------------------------------------------------------------
// SC5
// ---------------------------------------------------------------------------

/// SC5: a six-episode season queued from one account, with identical copies
/// on three more, every account allowing one connection. Episodes spread
/// over the four accounts and run four at a time.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn sc5_a_season_spreads_over_four_accounts() {
    const SIZE: u64 = 12 * MIB;
    const KBPS: u64 = 3 * 1024;
    const SEASON: u32 = 70;
    const BASE_SERIES: u32 = 80;
    let lab = lab().await;
    let season: Vec<(i64, i64, u32)> = (1..=6).map(|e| (1, e, 100 + e as u32)).collect();
    let baseline: Vec<(i64, i64, u32)> = (1..=2).map(|e| (1, e, 200 + e as u32)).collect();
    let mut panels = Vec::new();
    let mut sources = Vec::new();
    for i in 0..4u64 {
        let p = Panel::spawn(500 + i).await;
        p.set_reported(1);
        p.set_enforced(1);
        for &(_, _, f) in season.iter().chain(&baseline) {
            p.file(f, SIZE, KBPS);
        }
        p.series(SEASON, &season);
        p.series(BASE_SERIES, &baseline);
        let sid = lab.source(&format!("sc5-{i}"), &p).await;
        add_series(&lab.state, &sid, SEASON, "Speed Lab Show").await;
        add_series(&lab.state, &sid, BASE_SERIES, "Baseline Show").await;
        panels.push(p);
        sources.push(sid);
    }
    let all = sources.clone();
    lab.settings(|s| {
        s.download_probe_disabled = all;
        s.download_use_mirrors = false;
    })
    .await;

    // Queues `episodes` of `series` from the first account and waits for
    // all of them; returns the rows, their seconds, and the most that ran
    // at once.
    let queue = |series: u32, name: &'static str, episodes: Vec<(i64, i64, u32)>| {
        let (lab, panel, sid) = (&lab, &panels[0], sources[0].clone());
        async move {
            let began = Instant::now();
            let mut ids = Vec::new();
            for &(s, e, f) in &episodes {
                let d = lab
                    .start_episode(
                        &sid,
                        series,
                        f,
                        &format!("{name} S{s:02}E{e:02}"),
                        &panel.episode_url(f),
                    )
                    .await;
                ids.push((d.id, f));
            }
            let mut most = 0;
            let mut served_by = HashSet::new();
            let deadline = Instant::now() + WAIT;
            loop {
                let rows = lab.list().await;
                let mine: Vec<&Download> = rows
                    .iter()
                    .filter(|d| ids.iter().any(|(id, _)| *id == d.id))
                    .collect();
                for d in &mine {
                    lab.sample(d);
                    if let Some(s) = &d.served_by {
                        served_by.insert(s.clone());
                    }
                    if matches!(d.status, DownloadStatus::Failed | DownloadStatus::Canceled) {
                        panic!(
                            "episode row {} ended {:?}: {:?}",
                            d.id, d.status, d.error_message
                        );
                    }
                }
                let running = mine
                    .iter()
                    .filter(|d| d.status == DownloadStatus::Downloading)
                    .count();
                most = most.max(running);
                if mine.iter().all(|d| d.status == DownloadStatus::Completed) {
                    let rows: Vec<(Download, u32)> = ids
                        .iter()
                        .map(|(id, f)| {
                            (
                                mine.iter().find(|d| d.id == *id).copied().unwrap().clone(),
                                *f,
                            )
                        })
                        .collect();
                    return (rows, began.elapsed().as_secs_f64(), most, served_by);
                }
                assert!(
                    Instant::now() < deadline,
                    "the season never completed: {:?}",
                    mine.iter()
                        .map(|d| (d.id, d.status, d.bytes_downloaded, d.served_by.clone()))
                        .collect::<Vec<_>>()
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    };

    let (base_rows, base_secs, _, _) = queue(BASE_SERIES, "Baseline Show", baseline.clone()).await;
    lab.settings(|s| s.download_use_mirrors = true).await;
    let (rows, secs, most, served_by) = queue(SEASON, "Speed Lab Show", season.clone()).await;
    let ratio = report(
        "SC5",
        mbps(SIZE * base_rows.len() as u64, base_secs),
        mbps(SIZE * rows.len() as u64, secs),
        &format!(
            "season throughput: one account, then {most} episodes at once on {} other accounts",
            served_by.len()
        ),
    );

    for (d, f) in base_rows.iter().chain(&rows) {
        if let Err(e) = dl_panel::is_exact(*f, SIZE, Path::new(d.file_path.as_deref().unwrap())) {
            panic!("episode file {f} (row {}): {e}", d.id);
        }
    }
    for (i, p) in panels.iter().enumerate() {
        assert!(
            p.peak() <= 1,
            "panel {i} saw {} connections at once",
            p.peak()
        );
    }
    assert!(most >= 4, "at most {most} episodes ran at once");
    assert!(
        ratio >= 2.0,
        "the season ran {ratio:.2}x faster than on one account"
    );
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Spec check 15: on loopback with no speed cap and a split over every
/// connection the engine allows, the download rate shows whether the
/// writer keeps up. Release builds must reach 100 MB/s; debug builds only
/// print (the panel's byte generation is the bottleneck there).
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn writer_keeps_up() {
    let size: u64 = if cfg!(debug_assertions) {
        64 * MIB
    } else {
        512 * MIB
    };
    let lab = lab().await;
    let p = Panel::spawn(600).await;
    // 9 reported: a budget of 8, the engine's cap.
    p.set_reported(9);
    p.file(1, size, 0);
    let sid = lab.source("writer", &p).await;
    add_movie(&lab.state, &sid, 1, "Loopback (2026)", Some(2026), "mp4").await;
    let only = vec![sid.clone()];
    lab.settings(|s| s.download_probe_disabled = only).await;
    let run = lab
        .run_movie(&sid, 1, "Loopback", &p.movie_url(1), size)
        .await;
    let rate = run.mbps();
    println!(
        "writer_keeps_up: {} MiB in {:.2} s over {} connections, {rate:.1} MB/s{}",
        size / MIB,
        run.secs,
        lab.max_connections(run.download.id),
        if cfg!(debug_assertions) {
            " (debug build: printed only)"
        } else {
            ""
        }
    );
    assert_exact(1, size, &run);
    if cfg!(not(debug_assertions)) {
        assert!(rate >= 100.0, "the loopback download ran at {rate:.1} MB/s");
    }
}
