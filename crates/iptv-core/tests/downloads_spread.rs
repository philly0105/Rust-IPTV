//! Queue spreading against `dl_panel` when a copy lets the row down (review
//! rounds 2 and 3): an adopted copy that changed, an origin on a source the
//! user removes (paused or running), a spread copy that changed, which must
//! never make its source wait, and a copy identical to the row's origin
//! that changed, which is asked once and never again.

mod dl_panel;

use dl_panel::{add_movie, add_xtream_source, movie_ref, Panel, Variant};
use iptv_core::downloads::{mirrors, shared};
use iptv_core::model::{CopyRef, Download, DownloadStatus, TransferNote};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(90);
const MIB: u64 = 1024 * 1024;

struct Ctx {
    _tmp: tempfile::TempDir,
    _events: tokio::sync::broadcast::Receiver<iptv_core::AppEvent>,
    state: Arc<AppState>,
    router: RpcRouter,
}

/// A context with downloads and the Xtream module, for sources with a
/// catalog.
async fn ctx() -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(65_536);
    let state = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::downloads::init(state.clone()).await.unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    let mut router = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut router);
    Ctx {
        _tmp: tmp,
        _events: events,
        state,
        router,
    }
}

impl Ctx {
    async fn ok(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

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
                d.waiting,
                d.error_message
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Waits for `id` to end and returns the row; fails on `Failed`.
    async fn completed(&self, id: i64) -> Download {
        let d = self
            .wait_until(id, "completed", |d| {
                matches!(d.status, DownloadStatus::Completed | DownloadStatus::Failed)
            })
            .await;
        assert_eq!(d.status, DownloadStatus::Completed, "{d:?}");
        d
    }

    async fn pause(&self, id: i64) {
        self.ok("downloads.pause", json!({"id": id})).await;
        self.wait_until(id, "paused", |d| d.status == DownloadStatus::Paused)
            .await;
    }

    /// Panels `a` and `b` with movie 1 under one title on two sources
    /// (probes off, equivalent copies allowed when `equivalent`), and the
    /// copy on `a` checked against `b`. Returns both sources and the copy
    /// on `a`.
    async fn copies(
        &self,
        a: &Panel,
        b: &Panel,
        tag: &str,
        equivalent: bool,
    ) -> (String, String, CopyRef) {
        let sa = add_xtream_source(&self.state, &format!("{tag}-a"), a).await;
        let sb = add_xtream_source(&self.state, &format!("{tag}-b"), b).await;
        for s in [&sa, &sb] {
            add_movie(&self.state, s, 1, "Two Copies (2022)", Some(2022), "mp4").await;
        }
        {
            let mut settings = self.state.settings.write();
            settings.download_probe_disabled = vec![sa.clone(), sb.clone()];
            settings.download_allow_equivalent = equivalent;
        }
        let own = CopyRef::new(movie_ref(&sa, 1), None);
        self.verify(&own).await;
        (sa, sb, own)
    }

    /// Adds a source `name` for `panel` with movie 1 under the title of
    /// [`Ctx::copies`], probes off.
    async fn add_source(&self, panel: &Panel, name: &str) -> String {
        let s = add_xtream_source(&self.state, name, panel).await;
        add_movie(&self.state, &s, 1, "Two Copies (2022)", Some(2022), "mp4").await;
        self.state
            .settings
            .write()
            .download_probe_disabled
            .push(s.clone());
        s
    }

    /// Fingerprints `copy` and checks it against the other sources.
    async fn verify(&self, copy: &CopyRef) {
        let ep = shared::resolve(&self.state, copy).await.unwrap();
        let fp = mirrors::fingerprint(&self.state, &ep).await.unwrap();
        let (k, f) = (copy.clone(), fp.clone());
        self.state
            .db_call(move |c| mirrors::store_fingerprint(c, &k, &f))
            .await
            .unwrap();
        let mgr = iptv_core::downloads::manager::manager(&self.state);
        mirrors::identical_copies(&self.state, &mgr, copy, &fp, &[]).await;
    }

    async fn identical(&self, own: &CopyRef) -> Vec<CopyRef> {
        let o = own.clone();
        self.state
            .db_call(move |c| mirrors::cached_identical(c, &o))
            .await
            .unwrap()
    }

    async fn play(&self, sources: &[&String]) {
        let sources = sources.iter().map(|s| s.to_string()).collect();
        iptv_core::downloads::set_playback(&self.state, "tv", sources).await;
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < deadline, "never {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Movie requests `panel` got for file 1 since `from`.
fn movie_requests(panel: &Panel, from: usize) -> usize {
    panel
        .log()
        .iter()
        .skip(from)
        .filter(|l| l.route == "movie" && l.file == 1)
        .count()
}

fn is_exact(d: &Download, size: u64) {
    let path = PathBuf::from(d.file_path.clone().unwrap());
    dl_panel::is_exact(1, size, &path).unwrap();
}

/// The completed file of `d` is `variant` of file 1, byte for byte.
fn is_variant(d: &Download, size: u64, variant: Variant) {
    let got = std::fs::read(d.file_path.clone().unwrap()).unwrap();
    assert!(
        got == dl_panel::variant_content(1, variant, size, 0, size as usize),
        "the file is not the {variant:?} copy ({} bytes)",
        got.len()
    );
}

/// A fresh row adopted the equivalent copy on B (B became its origin), and
/// B's file changed before the run. The run there starts over from the
/// row's own copy on A instead of waiting for B again and again, says why,
/// and B is never adopted again.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_changed_origin_starts_over_from_its_own_copy() {
    let c = ctx().await;
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_millis(300),
        Duration::from_secs(25),
    );
    let size = 24 * MIB;
    let (a, b) = (Panel::spawn(80).await, Panel::spawn(81).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 4 * 1024);
    b.file_variant(1, size, 4 * 1024, Variant::Differs);
    let (sa, sb, own) = c.copies(&a, &b, "eq", true).await;
    assert!(c.identical(&own).await.is_empty(), "B is only equivalent");
    // B's copy is replaced on the provider.
    b.file_variant(1, 30 * MIB, 4 * 1024, Variant::Differs);
    c.play(&[&sa]).await;
    let checked = b.log().len();
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    until("B asked from byte 0", || {
        b.log()
            .iter()
            .skip(checked)
            .any(|l| l.route == "movie" && l.range.map(|r| r.0) == Some(0))
    })
    .await;
    c.wait_until(d.id, "started over", |r| {
        r.status == DownloadStatus::Queued && r.origin.is_none() && r.bytes_downloaded == 0
    })
    .await;
    let from_b = b.log().len();
    // A is free now.
    c.play(&[]).await;
    let noted = std::cell::Cell::new(false);
    let end = c
        .wait_until(d.id, "ended", |r| {
            let note = r.stats.as_ref().is_some_and(|s| {
                s.notes.iter().any(
                    |n| matches!(n, TransferNote::MirrorMismatch { source_id } if *source_id == sb),
                )
            });
            noted.set(noted.get() || note);
            matches!(r.status, DownloadStatus::Completed | DownloadStatus::Failed)
        })
        .await;
    assert_eq!(end.status, DownloadStatus::Completed, "{end:?}");
    assert_eq!(end.origin, None);
    is_exact(&end, size);
    assert_eq!(movie_requests(&b, from_b), 0, "B was used again");
    assert!(noted.get(), "the run on A never said why it started over");
}

/// A row's origin is on source B and the user removes B while the row is
/// paused: the row starts over from its own copy on A at once, without
/// waiting for B.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_paused_origin_on_a_removed_source_starts_over_from_its_own_copy() {
    let c = ctx().await;
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_secs(60),
        Duration::from_secs(120),
    );
    let size = 24 * MIB;
    let (a, b) = (Panel::spawn(82).await, Panel::spawn(83).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 2 * 1024);
    b.file_variant(1, size, 2 * 1024, Variant::Differs);
    let (sa, sb, _) = c.copies(&a, &b, "rm", true).await;
    c.play(&[&sa]).await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "2 MiB from B", |r| {
        r.served_by.as_deref() == Some(sb.as_str()) && r.bytes_downloaded > 2 * MIB as i64
    })
    .await;
    c.pause(d.id).await;
    iptv_core::sources::remove(&c.state, &sb).await.unwrap();
    let row = c.get(d.id).await;
    assert_eq!(row.origin, None, "{row:?}");
    assert_eq!(row.bytes_downloaded, 0, "{row:?}");
    c.play(&[]).await;
    let started = Instant::now();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    let end = c.completed(d.id).await;
    assert!(started.elapsed() < Duration::from_secs(45), "it waited");
    assert_eq!(end.origin, None);
    is_exact(&end, size);
}

/// The same with the row running on B when B is removed: the run stops,
/// drops the bytes from B and the row completes from A.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_running_origin_on_a_removed_source_starts_over_from_its_own_copy() {
    let c = ctx().await;
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_secs(60),
        Duration::from_secs(120),
    );
    let size = 24 * MIB;
    let (a, b) = (Panel::spawn(84).await, Panel::spawn(85).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 2 * 1024);
    b.file_variant(1, size, 2 * 1024, Variant::Differs);
    let (sa, sb, _) = c.copies(&a, &b, "rr", true).await;
    c.play(&[&sa]).await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "2 MiB from B", |r| {
        r.served_by.as_deref() == Some(sb.as_str()) && r.bytes_downloaded > 2 * MIB as i64
    })
    .await;
    iptv_core::sources::remove(&c.state, &sb).await.unwrap();
    c.wait_until(d.id, "started over", |r| {
        r.status == DownloadStatus::Queued && r.origin.is_none() && r.bytes_downloaded == 0
    })
    .await;
    c.play(&[]).await;
    let end = c.completed(d.id).await;
    assert_eq!(end.origin, None);
    is_exact(&end, size);
}

/// A run spread to B finds B's file changed since the pair was verified.
/// The copy was at fault, not B: a row of B's own starts there at once,
/// with no wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_respread_never_makes_its_source_wait() {
    let c = ctx().await;
    // A wait would last a minute.
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_secs(60),
        Duration::from_secs(120),
    );
    let size = 24 * MIB;
    let (a, b) = (Panel::spawn(86).await, Panel::spawn(87).await);
    for p in [&a, &b] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 4 * 1024);
    b.file(1, size, 4 * 1024);
    b.file(2, 8 * MIB, 4 * 1024);
    let (sa, sb, own) = c.copies(&a, &b, "rs", false).await;
    assert_eq!(c.identical(&own).await.len(), 1, "B is identical");
    add_movie(&c.state, &sb, 2, "Another Film (2021)", Some(2021), "mp4").await;
    b.file_variant(1, 30 * MIB, 4 * 1024, Variant::Differs);
    c.play(&[&sa]).await;
    let first = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    let deadline = Instant::now() + WAIT;
    while !c.identical(&own).await.is_empty() {
        assert!(Instant::now() < deadline, "the run on B never respread");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    c.wait_until(first.id, "back in the queue", |r| {
        r.status == DownloadStatus::Queued
    })
    .await;
    let second = c.start_movie(&sb, 2, &b.movie_url(2)).await;
    let started = Instant::now();
    let row = c
        .wait_until(second.id, "started on B", |r| {
            r.status != DownloadStatus::Queued
        })
        .await;
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "B waited {:?}: {row:?}",
        started.elapsed()
    );
    c.completed(second.id).await;
    c.play(&[]).await;
    let end = c.completed(first.id).await;
    is_exact(&end, size);
}

/// A row of A holds bytes of its origin on B (an equivalent copy). C was
/// verified identical to B, then C's file was replaced by one with another
/// total. A and B are busy when the row is resumed: it is spread to C once,
/// finds the change, and then waits for B instead of asking C again and
/// again. It ends with B's copy.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn a_changed_copy_identical_to_the_origin_is_asked_once() {
    let c = ctx().await;
    iptv_core::downloads::set_wait_timing(
        &c.state,
        Duration::from_secs(60),
        Duration::from_secs(120),
    );
    let size = 24 * MIB;
    let (a, b, cc) = (
        Panel::spawn(88).await,
        Panel::spawn(89).await,
        Panel::spawn(90).await,
    );
    for p in [&a, &b, &cc] {
        p.set_reported(1);
        p.set_enforced(1);
    }
    a.file(1, size, 2 * 1024);
    b.file_variant(1, size, 2 * 1024, Variant::Differs);
    cc.file_variant(1, size, 2 * 1024, Variant::Differs);
    let (sa, sb, _) = c.copies(&a, &b, "third", true).await;
    let cb = CopyRef::new(movie_ref(&sb, 1), None);
    c.play(&[&sa]).await;
    let d = c.start_movie(&sa, 1, &a.movie_url(1)).await;
    c.wait_until(d.id, "2 MiB from B", |r| {
        r.served_by.as_deref() == Some(sb.as_str()) && r.bytes_downloaded > 2 * MIB as i64
    })
    .await;
    c.pause(d.id).await;
    assert_eq!(
        c.get(d.id).await.origin.as_ref(),
        Some(&cb),
        "B is the origin"
    );
    let sc = c.add_source(&cc, "third-c").await;
    c.verify(&cb).await;
    assert!(
        c.identical(&cb).await.iter().any(|x| x.source_id() == sc),
        "C is verified identical to the origin"
    );
    // C's file is replaced; A and B are busy.
    cc.file_variant(1, 30 * MIB, 2 * 1024, Variant::Differs);
    c.play(&[&sa, &sb]).await;
    let from_c = cc.log().len();
    c.ok("downloads.resume", json!({"id": d.id})).await;
    tokio::time::sleep(Duration::from_secs(10)).await;
    // One placement: a fingerprint (three samples) and one range.
    let asked = movie_requests(&cc, from_c);
    let ranges = cc
        .log()
        .iter()
        .skip(from_c)
        .filter(|l| l.route == "movie" && l.file == 1)
        .filter(|l| l.range.is_none_or(|(s, e)| e != Some(s + 64 * 1024 - 1)))
        .count();
    assert!(
        ranges <= 1 && asked <= 4,
        "C was asked {asked} times ({ranges} ranges) in 10 s"
    );
    let row = c.get(d.id).await;
    assert_eq!(row.status, DownloadStatus::Queued, "{row:?}");
    assert_eq!(row.origin.as_ref(), Some(&cb), "{row:?}");
    c.play(&[]).await;
    let end = c.completed(d.id).await;
    is_variant(&end, size, Variant::Differs);
}
