//! The coordinator of a segmented attempt and its workers.
//!
//! The coordinator keeps as many connections as the transfer may hold on
//! each source (`DownloadManager::allowance_on`, the authority first, then
//! mirrors in turn), capped by "Most connections per download" and by the
//! ramp: it adds one connection per gain window while the total speed rises
//! by at least 10%, and gives the last one back for 30 s when it does not.
//! A connection running below half the median speed for `recycle_after` is
//! reopened on the host's next address. Workers write through the writer
//! and compare overlapping bytes with what other requests wrote (lead-in,
//! tail and final checks), so a file never mixes two versions of itself.

use super::stats::{self, Meter, STATS_EVERY};
use super::writer::{self, Block, Writer, BLOCK};
use super::{
    Job, MirrorPlan, Plan, Ranges, SegEnd, SegSource, CLOSE_GRACE, FIRST_TICK, MAX_CONNECTIONS,
    PROBE_MIN_LEFT, SAVE_EVERY, TICK,
};
use crate::downloads::manager::HoldPurpose;
use crate::downloads::transfer::{self, Pace};
use crate::downloads::{mirrors, probe, shared};
use crate::error::CoreError;
use crate::model::{
    ConnectionStat, CopyRef, Limiting, MirrorDropReason, OneConnectionReason, RequestHeaders,
    SourceRole, TransferNote, TransferStats,
};
use bytes::Bytes;
use futures::future::BoxFuture;
use futures::stream::{BoxStream, FuturesUnordered, StreamExt};
use futures::FutureExt;
use parking_lot::Mutex;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::StatusCode;
use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// The body of an answer.
pub type Body = BoxStream<'static, reqwest::Result<Bytes>>;

/// Connections a split starts with before the ramp adds more.
const FIRST_TARGET: usize = 2;
/// How much an added connection must raise the total speed to stay.
const GAIN: f64 = 1.1;
/// How long the ramp adds nothing after a connection gained too little.
const LINE_HOLD: Duration = Duration::from_secs(30);
/// A connection is never replaced in its first seconds (slow start).
const RECYCLE_MIN_AGE: Duration = Duration::from_secs(5);
/// Nor more often than this.
const RECYCLE_EVERY: Duration = Duration::from_secs(30);
/// A refusal this soon after a probe closed its connections is the panel
/// still counting them, not the account's limit.
const AFTER_PROBE: Duration = Duration::from_secs(3);
/// Bytes a comparison involving a mirror needs outside the sample windows
/// (inside them the mirror was already compared).
const MIN_OUTSIDE: i64 = 4 * 1024;
/// Stream failures after which a mirror leaves the transfer.
const MIRROR_FAILURES: u32 = 3;
/// An extra connection of the authority that could not be opened (no
/// connection, no answer in time) is asked for again after this, doubled
/// for each failure in a row.
const RETRY_BASE: Duration = Duration::from_secs(1);
/// Failures in a row to open one, after which the attempt ends and its
/// run retries it.
const OPEN_FAILURES: u32 = 4;
/// How often a transfer that may use mirrors and has none looks again.
const FIND_EVERY: Duration = Duration::from_secs(60);

/// One source's connection details, shared by its workers.
struct Conn {
    id: String,
    /// Index in [`Ranges::sources`].
    idx: u16,
    url: String,
    headers: RequestHeaders,
    client: reqwest::Client,
    host: String,
    validator: Option<String>,
    /// Where the last answer came from after redirects, and its client.
    pinned: Mutex<Option<(String, reqwest::Client)>>,
}

impl Conn {
    /// Its requests carry the authority's validator: what they get is the
    /// file, no comparison needed.
    fn validated(&self) -> bool {
        self.idx == 0 && self.validator.is_some()
    }
}

/// A source as the coordinator tracks it, aligned with
/// [`Ranges::sources`].
struct Src {
    /// None for a source the sidecar lists that this attempt has not
    /// reached (a mirror of an earlier run).
    conn: Option<Arc<Conn>>,
    copy: Option<CopyRef>,
    mirror: bool,
    /// Left the transfer (refused, failed, or its bytes differed).
    dropped: bool,
    /// Had a connection in this attempt.
    used: bool,
    /// Its allowance fell to zero and the note says so.
    fell: bool,
    failures: u32,
    /// No new connection before this: the last could not be opened.
    retry_at: Option<Instant>,
    /// Next address of the host to reopen a slow connection on.
    cursor: usize,
    /// Slow connections closed and waiting to reopen: address index and
    /// when.
    reopen: Vec<(usize, Instant)>,
    /// Bytes its ended connections served.
    bytes: i64,
}

impl Src {
    fn new(copy: Option<CopyRef>) -> Self {
        Self {
            conn: None,
            copy,
            mirror: false,
            dropped: false,
            used: false,
            fell: false,
            failures: 0,
            retry_at: None,
            cursor: 1,
            reopen: Vec::new(),
            bytes: 0,
        }
    }

    fn usable(&self) -> Option<&Arc<Conn>> {
        self.conn.as_ref().filter(|_| !self.dropped)
    }

    fn id(&self) -> String {
        match (&self.conn, &self.copy) {
            (Some(c), _) => c.id.clone(),
            (None, Some(copy)) => copy.item_ref.source_id.clone(),
            (None, None) => String::new(),
        }
    }
}

/// A worker to start.
struct Start {
    seg: usize,
    src: usize,
    /// The attempt's open answer, for the segment it serves.
    stream: Option<Body>,
    /// A final check of `len` bytes at `at` instead of a fetch.
    verify: Option<(i64, i64)>,
    /// Reopening a slow connection: the address index, and when.
    addr: Option<(usize, Instant)>,
}

impl Start {
    fn fetch(seg: usize, src: usize, stream: Option<Body>) -> Self {
        Self {
            seg,
            src,
            stream,
            verify: None,
            addr: None,
        }
    }
}

/// A worker that runs.
struct Running {
    wid: u64,
    src: usize,
    retire: CancellationToken,
    meter: Arc<Meter>,
    verify: bool,
    /// Being closed to reopen on another address.
    recycle: bool,
    recycled_at: Option<Instant>,
    slow_since: Option<Instant>,
}

struct Ended {
    wid: u64,
    seg: usize,
    src: usize,
    meter: Arc<Meter>,
    result: Result<WorkerEnd, WorkerError>,
}

enum WorkerEnd {
    /// Its segment is written (or its check done).
    Finished,
    /// Asked to give its connection back, its segment was discarded, or
    /// its stream stopped short of an end that moved on; its segment is
    /// free again.
    Retired,
}

enum WorkerError {
    /// The disk.
    Failed(CoreError),
    /// The stream broke off: an error, an early end, nothing for the idle
    /// limit.
    Dropped(CoreError),
    /// The server refused the request (an HTTP error status).
    Refused(CoreError),
    /// The request got no answer: no connection, or no headers in time.
    Unreachable(CoreError),
    /// The answer was not the range asked for.
    Changed(String),
    /// Overlapping bytes differ from what source `other` wrote.
    Mismatch { other: u16 },
}

/// What the workers share.
struct Cx<'a> {
    job: &'a Job<'a>,
    plan: Arc<Mutex<Plan>>,
    /// Taken (dropped) once the workers are done, so the writer ends.
    tx: Mutex<Option<writer::Sender>>,
    total: i64,
    /// Requests read past their segment's end for the tail check: the
    /// authority has no validator, or mirrors take part.
    tails: AtomicBool,
    /// Addresses of the host a pinned request could not connect to:
    /// skipped when a connection is reopened.
    dead: Mutex<Vec<SocketAddr>>,
}

/// Bytes on disk a worker compares an answer's bytes with.
#[derive(Clone, Copy)]
struct Ref {
    seg: usize,
    src: u16,
    at: i64,
    len: i64,
    epoch: u64,
}

/// How many connections each source gets now.
struct Desired {
    per: Vec<usize>,
    /// What all sources allow together, capped.
    room: usize,
    cap: usize,
}

/// The ramp: how many connections the transfer tries to hold.
struct Ramp {
    target: usize,
    at: Instant,
    bytes: i64,
    conns: usize,
    /// The speed before the last added connection, while it is judged.
    before: Option<f64>,
    hold: Option<Instant>,
    /// The speed the line gave when an added connection gained too little.
    line: Option<i64>,
    /// Whether the last added connection gained enough.
    gained: Option<bool>,
}

impl Ramp {
    fn new(bytes: i64) -> Self {
        Self {
            target: FIRST_TARGET,
            at: Instant::now(),
            bytes,
            conns: 0,
            before: None,
            hold: None,
            line: None,
            gained: None,
        }
    }

    fn restart(&mut self, now: Instant, bytes: i64, conns: usize) {
        self.at = now;
        self.bytes = bytes;
        self.conns = conns;
    }

    /// Judges the last added connection once it ran a gain window, and
    /// adds another while the sources have room.
    fn tick(&mut self, now: Instant, bytes: i64, conns: usize, room: usize, window: Duration) {
        if self.hold.is_some_and(|t| now >= t) {
            self.hold = None;
            self.line = None;
            // The line is judged again by the next added connection; until
            // then nothing holds a probe back.
            self.gained = None;
        }
        if self.before.is_some() && conns < self.target && room < self.target {
            // The allowance dipped before the added connection ran.
            self.before = None;
        }
        if conns != self.conns {
            self.restart(now, bytes, conns);
            return;
        }
        let age = now.duration_since(self.at);
        if age < window || window.is_zero() && age.is_zero() {
            return;
        }
        let rate = (bytes - self.bytes).max(0) as f64 / age.as_secs_f64().max(0.001);
        if let Some(before) = self.before.filter(|_| conns >= self.target) {
            self.before = None;
            if rate >= before * GAIN {
                self.gained = Some(true);
            } else {
                // The line, not the connections, sets the speed: the last
                // one goes back, and none is added for a while.
                self.gained = Some(false);
                self.target = (self.target - 1).max(1);
                self.hold = Some(now + LINE_HOLD);
                self.line = Some(before.round() as i64);
                self.restart(now, bytes, conns);
                return;
            }
        }
        if self.before.is_none()
            && conns >= self.target
            && self.target < room
            && self.hold.is_none()
        {
            self.before = Some(rate);
            self.target += 1;
        }
        self.restart(now, bytes, conns);
    }
}

/// Runs `ranges` to completion over as many connections as the transfer may
/// hold, re-read every [`TICK`]. `first` is the open answer of the attempt
/// and the offset it serves from.
pub async fn run(
    job: Job<'_>,
    ranges: Ranges,
    first: Option<(Body, i64)>,
    mut progress: impl FnMut(i64, i64),
) -> SegEnd {
    let job = &job;
    let (state, ctl, mgr) = (job.state, job.ctl, job.mgr);
    let total = ranges.total;
    let mut srcs: Vec<Src> = ranges
        .sources
        .iter()
        .map(|s| Src::new(s.copy.clone()))
        .collect();
    let pinned = match &job.pinned {
        Some(url) => Some((
            url.clone(),
            crate::http::source_client(state, &ctl.source, url).await,
        )),
        None => None,
    };
    srcs[0].copy = Some(job.copy.clone());
    srcs[0].used = true;
    srcs[0].conn = Some(Arc::new(Conn {
        id: ctl.source.clone(),
        idx: 0,
        url: job.url.clone(),
        headers: job.headers.clone(),
        client: job.client.clone(),
        host: job.host.clone(),
        validator: ranges.sources[0].validator.clone(),
        pinned: Mutex::new(pinned),
    }));
    let tails =
        ranges.sources[0].validator.is_none() || ranges.sources.len() > 1 || job.mirrors.is_some();
    let plan = Arc::new(Mutex::new(Plan::new(ranges)));
    let (writer, tx) = Writer::start(job.part.clone(), Arc::clone(&plan));
    let cx = Cx {
        job,
        plan: Arc::clone(&plan),
        tx: Mutex::new(Some(tx)),
        total,
        tails: AtomicBool::new(tails),
        dead: Mutex::new(Vec::new()),
    };
    let cx = &cx;
    let server_mode = crate::http::is_server_mode(state);

    let mut workers: FuturesUnordered<BoxFuture<'_, Ended>> = FuturesUnordered::new();
    let mut running: Vec<Running> = Vec::new();
    let all = CancellationToken::new();
    let mut next_wid = 0u64;
    let mut first = first.and_then(|(stream, at)| {
        let mut p = plan.lock();
        let i = p
            .ranges
            .segments
            .iter()
            .position(|s| s.pos == at && s.pos < s.end)?;
        p.taken[i] = true;
        Some((i, stream))
    });
    // The segment the attempt's open answer serves: it reads on past its
    // end when the segment after it is given back.
    let mut open_ended = first.as_ref().map(|(i, _)| *i);
    // When a connection of the transfer last closed.
    let mut closed_at: Option<Instant> = None;
    // The plan is on disk before any segment writes past what the `.part`
    // already holds (a `.part` with holes and no sidecar would resume from
    // its length), and before anything writes over discarded bytes.
    let mut saved_plan = 0;
    let mut must_save = false;
    let mut last_save = Instant::now();
    // The save in flight. Its sync can take a while on a slow disk, and the
    // workers only run while this loop polls them, so the loop never waits
    // for it: a periodic save is skipped meanwhile, and the next save starts
    // once it lands (two would share the temporary file).
    let mut saving: Option<JoinHandle<io::Result<()>>> = None;
    // Workers that start once the plan save in flight lands. Meanwhile the
    // loop goes on retiring workers and watching the stop token.
    let mut pending: Vec<Start> = Vec::new();
    let began = plan.lock().ranges.done();
    let mut reported = false;
    let mut failure: Option<WorkerError> = None;
    let mut stopping = false;
    let mut ramp = Ramp::new(0);
    let mut finding: Option<BoxFuture<'_, Vec<Found>>> =
        job.mirrors.as_ref().map(|m| find_mirrors(cx, m).boxed());
    // When the last mirror search ended.
    let mut searched = Instant::now();
    let mut probing: Option<BoxFuture<'_, ()>> = None;
    let mut probe_ended: Option<Instant> = None;
    let mut last_stats = Instant::now();
    let mut stats_received = 0i64;
    // The provider refused an extra connection: the rest goes over one.
    let mut refused = false;

    macro_rules! fail {
        ($e:expr) => {{
            if failure.is_none() {
                failure = Some($e);
            }
            stopping = true;
            all.cancel();
            pending.clear();
            finding = None;
            probing = None;
        }};
    }

    loop {
        if !stopping {
            let want = desired(cx, &srcs, ramp.target);
            let mut starting: Vec<Start> = Vec::new();
            if pending.is_empty() {
                starting.extend(first.take().map(|(seg, s)| Start::fetch(seg, 0, Some(s))));
                let (complete, verified) = {
                    let p = plan.lock();
                    (p.ranges.complete(), p.ranges.verified())
                };
                if complete && !verified {
                    // The last comparisons: a fetch from the authority for
                    // every segment no other request confirmed.
                    while count(&running, 0) + starting.len() < want.per[0] {
                        let mut p = plan.lock();
                        let Some(seg) = (0..p.ranges.segments.len()).find(|&i| {
                            let s = p.ranges.segments[i];
                            !p.taken[i] && !s.checked && s.pos > s.start
                        }) else {
                            break;
                        };
                        match verify_window(&p, seg, total) {
                            Some((at, len)) => {
                                p.taken[seg] = true;
                                starting.push(Start {
                                    verify: Some((at, len)),
                                    ..Start::fetch(seg, 0, None)
                                });
                            }
                            None => {
                                // A mirror's piece too small to compare
                                // outside the samples: the authority
                                // fetches it again.
                                p.reset(seg);
                                must_save = true;
                            }
                        }
                    }
                } else if !complete {
                    loop {
                        let mut added = false;
                        let now = Instant::now();
                        for (i, src) in srcs.iter_mut().enumerate() {
                            let Some(conn) = src.usable() else { continue };
                            if src.retry_at.is_some_and(|t| now < t) {
                                continue;
                            }
                            let have =
                                count(&running, i) + starting.iter().filter(|s| s.src == i).count();
                            if have >= want.per[i] {
                                continue;
                            }
                            let validated = conn.validated();
                            let Some(seg) = plan.lock().pick(i as u16, validated) else {
                                continue;
                            };
                            src.used = true;
                            starting.push(Start {
                                addr: src.reopen.pop(),
                                ..Start::fetch(seg, i, None)
                            });
                            added = true;
                        }
                        if !added {
                            break;
                        }
                    }
                }
            }
            let segments = plan.lock().ranges.segments.len();
            if !starting.is_empty() && (segments != saved_plan || must_save) {
                saved_plan = segments;
                must_save = false;
                last_save = Instant::now();
                let snapshot = plan.lock().ranges.clone();
                saving = Some(spawn_save(job, snapshot, saving.take()));
                pending = std::mem::take(&mut starting);
            }
            let wait = grace(closed_at);
            for st in starting {
                workers.push(start(
                    cx,
                    st,
                    &srcs,
                    wait,
                    &all,
                    &mut next_wid,
                    &mut running,
                ));
            }
            // "Use identical copies" turned off: the mirrors leave now.
            if !state.settings.read().download_use_mirrors {
                finding = None;
                for i in 1..srcs.len() {
                    if srcs[i].mirror && !srcs[i].dropped {
                        let (id, used) = (srcs[i].id(), srcs[i].used);
                        drop_source(&mut srcs, &mut running, i);
                        if used {
                            ctl.push_note(TransferNote::MirrorDropped {
                                source_id: id,
                                reason: MirrorDropReason::Unavailable,
                            });
                        }
                    }
                }
            }
            // Retire the newest workers of a source over its share: within
            // one tick of its allowance falling (playback wins).
            for (i, src) in srcs.iter_mut().enumerate() {
                while count(&running, i) > want.per[i] {
                    let k = running
                        .iter()
                        .rposition(|r| r.src == i)
                        .expect("a worker on the source");
                    running.remove(k).retire.cancel();
                }
                if src.mirror && src.used && !src.dropped {
                    let allowed = src
                        .conn
                        .as_ref()
                        .is_some_and(|c| mgr.allowance_on(ctl, &c.id) > 0);
                    if !allowed && !src.fell {
                        src.fell = true;
                        let reason = match mgr.limit_reason(ctl, &src.id()) {
                            Some(Limiting::Playback { .. }) => MirrorDropReason::Playback,
                            _ => MirrorDropReason::Queue,
                        };
                        ctl.push_note(TransferNote::MirrorDropped {
                            source_id: src.id(),
                            reason,
                        });
                    } else if allowed {
                        src.fell = false;
                    }
                }
            }
            hold(cx, &srcs, &running);
        }

        let tick = if reported { TICK } else { FIRST_TICK };
        tokio::select! {
            biased;
            _ = ctl.token.cancelled(), if !stopping => {
                stopping = true;
                all.cancel();
                pending.clear();
                finding = None;
                probing = None;
            }
            saved = async { saving.as_mut().expect("a plan save in flight").await },
                if !pending.is_empty() =>
            {
                saving = None;
                match saved.map_err(io::Error::other).and_then(|r| r) {
                    Ok(()) => {
                        // What the transfer may hold now: playback may have
                        // asked for connections meanwhile.
                        let want = desired(cx, &srcs, ramp.target);
                        let wait = grace(closed_at);
                        for st in std::mem::take(&mut pending) {
                            let usable = srcs[st.src].usable().is_some();
                            if usable && count(&running, st.src) < want.per[st.src] {
                                workers.push(start(cx, st, &srcs, wait, &all, &mut next_wid, &mut running));
                            } else {
                                plan.lock().taken[st.seg] = false;
                                if let Some(addr) = st.addr {
                                    srcs[st.src].reopen.push(addr);
                                }
                            }
                        }
                        hold(cx, &srcs, &running);
                    }
                    Err(e) => {
                        // Without the sidecar a split `.part` could not
                        // resume: end the attempt before anything writes.
                        for st in std::mem::take(&mut pending) {
                            plan.lock().taken[st.seg] = false;
                        }
                        fail!(WorkerError::Failed(CoreError::Io(e)));
                    }
                }
            }
            // With no worker left, an empty set would answer at once.
            ended = workers.next(), if !workers.is_empty() || pending.is_empty() => match ended {
                Some(Ended { wid, seg, src, meter, result }) => {
                    let entry = running
                        .iter()
                        .position(|r| r.wid == wid)
                        .map(|k| running.remove(k));
                    srcs[src].bytes += meter.bytes();
                    closed_at = Some(Instant::now());
                    if open_ended == Some(seg) {
                        open_ended = None;
                    }
                    match result {
                        Ok(_) => {
                            if entry.is_some_and(|e| e.recycle) {
                                let s = &mut srcs[src];
                                s.reopen.push((s.cursor, Instant::now()));
                                s.cursor += 1;
                            }
                            srcs[src].failures = 0;
                        }
                        Err(WorkerError::Mismatch { other }) => {
                            let me = src as u16;
                            if me == 0 && other == 0 {
                                fail!(WorkerError::Changed(
                                    "overlapping bytes of two requests differ".into()
                                ));
                            } else {
                                discard(cx, &mut srcs, &mut running, me, other);
                                // The discarded bytes leave the sidecar before
                                // anything writes over them.
                                must_save = true;
                                last_save = Instant::now();
                                let snapshot = plan.lock().ranges.clone();
                                saving = Some(spawn_save(job, snapshot, saving.take()));
                            }
                        }
                        Err(WorkerError::Failed(err)) => fail!(WorkerError::Failed(err)),
                        Err(e) if src != 0 => {
                            // A mirror that refuses, fails or answers
                            // something else leaves; the transfer goes on.
                            let id = srcs[src].id();
                            let reason = match &e {
                                WorkerError::Refused(err) => {
                                    tracing::info!(id = job.id, error = %err, "a mirror refused a connection");
                                    mgr.mirror_refused(&id);
                                    Some(MirrorDropReason::Refused)
                                }
                                WorkerError::Dropped(_) | WorkerError::Unreachable(_) => {
                                    if matches!(e, WorkerError::Dropped(_)) {
                                        ctl.note_drop(&id);
                                    }
                                    srcs[src].failures += 1;
                                    (srcs[src].failures >= MIRROR_FAILURES)
                                        .then_some(MirrorDropReason::Failed)
                                }
                                _ => {
                                    // It answered with another file: the pair
                                    // is verified again before it is used.
                                    if let Some(mirror) = srcs[src].copy.clone() {
                                        let (state, item) = (Arc::clone(state), job.copy.clone());
                                        tokio::spawn(async move {
                                            mirrors::record_mismatch(&state, &item, &mirror, false).await;
                                        });
                                    }
                                    Some(MirrorDropReason::Failed)
                                }
                            };
                            if let Some(reason) = reason {
                                drop_source(&mut srcs, &mut running, src);
                                ctl.push_note(TransferNote::MirrorDropped { source_id: id, reason });
                            }
                        }
                        Err(WorkerError::Dropped(err)) if probing.is_some() => {
                            // A kick-oldest panel ends the oldest connection
                            // (one of these) when the probe opens one more:
                            // the probe reads the drop as the kick, and the
                            // segment is asked for again.
                            tracing::info!(id = job.id, error = %err, "a connection ended while a probe ran; trying again");
                            ctl.note_drop(&ctl.source);
                        }
                        Err(WorkerError::Unreachable(err))
                            if !running.is_empty() && srcs[0].failures + 1 < OPEN_FAILURES =>
                        {
                            // An extra connection could not be opened (a
                            // network hiccup, a slow answer): the others go
                            // on, and it is asked for again after a while.
                            let s = &mut srcs[0];
                            s.failures += 1;
                            let delay = RETRY_BASE * 2u32.pow(s.failures - 1);
                            s.retry_at = Some(Instant::now() + delay);
                            tracing::info!(id = job.id, error = %err, ?delay, "a connection could not be opened; asking again");
                        }
                        Err(WorkerError::Refused(err))
                            if probe_ended.is_some_and(|t| t.elapsed() <= AFTER_PROBE) =>
                        {
                            // The panel still counts the probe's connections:
                            // the segment is asked for again after the grace.
                            tracing::info!(id = job.id, error = %err, "a connection was refused right after a probe; trying again");
                        }
                        Err(WorkerError::Refused(err)) if !running.is_empty() => {
                            // The account has fewer free connections than
                            // its limit says (another device holds one):
                            // the rest goes over one connection. A refused
                            // segment that follows the open answer's goes
                            // back to it, so that stream reads on and no
                            // new request is needed.
                            tracing::info!(id = job.id, error = %err, "the provider refused another connection; going on with one");
                            if !job.one_connection.swap(true, Ordering::Relaxed) {
                                ctl.push_note(TransferNote::OneConnection {
                                    reason: OneConnectionReason::Refused,
                                });
                            }
                            ctl.set_one_connection(true);
                            refused = true;
                            let mut p = plan.lock();
                            let gone = p.ranges.segments[seg];
                            if let Some(o) = open_ended.filter(|o| {
                                gone.pos == gone.start && p.ranges.segments[*o].end == gone.start
                            }) {
                                p.ranges.segments[o].end = gone.end;
                                p.ranges.segments[seg].end = gone.start;
                            }
                        }
                        Err(e) => {
                            if matches!(e, WorkerError::Dropped(_)) {
                                ctl.note_drop(&ctl.source);
                            }
                            fail!(e);
                        }
                    }
                }
                None => {
                    if stopping || plan.lock().ranges.verified() {
                        break;
                    }
                    // Nothing runs and nothing could start: look again in
                    // a moment.
                    tokio::time::sleep(tick).await;
                }
            },
            found = async { finding.as_mut().expect("a mirror search").await },
                if finding.is_some() =>
            {
                finding = None;
                searched = Instant::now();
                if attach(cx, &mut srcs, found) {
                    must_save = true;
                }
            }
            _ = async { probing.as_mut().expect("a probe").await }, if probing.is_some() => {
                probing = None;
                probe_ended = Some(Instant::now());
            }
            _ = tokio::time::sleep(tick) => {}
        }

        if let Some(e) = writer.failed() {
            if !stopping {
                fail!(WorkerError::Failed(CoreError::Io(e)));
            }
        }
        let (done, snapshot) = {
            let p = plan.lock();
            (p.ranges.done(), p.ranges.clone())
        };
        ctl.bytes.store(done, Ordering::Relaxed);
        progress(done, total);
        reported |= done > began;
        if pending.is_empty()
            && last_save.elapsed() >= SAVE_EVERY
            && saving.as_ref().is_none_or(|s| s.is_finished())
        {
            last_save = Instant::now();
            saving = Some(spawn_save(job, snapshot, saving.take()));
        }
        let now = Instant::now();
        let received = srcs.iter().map(|s| s.bytes).sum::<i64>()
            + running.iter().map(|r| r.meter.bytes()).sum::<i64>();
        if !stopping {
            let want = desired(cx, &srcs, ramp.target);
            ramp.tick(
                now,
                received,
                running.len(),
                want.room,
                mgr.ramp_timing().gain_window,
            );
        }
        if now.duration_since(last_stats) >= STATS_EVERY {
            for r in &running {
                r.meter.sample(now);
            }
            if !stopping && !server_mode {
                recycle(cx, &mut running, now);
            }
            // Settings and refusals apply live: the same check `desired`
            // makes.
            let may = transfer::may_split(
                state,
                &ctl.source,
                ctl,
                job.one_connection.load(Ordering::Relaxed),
            );
            if !stopping
                && may
                && probing.is_none()
                && ramp.gained != Some(false)
                && total - done >= PROBE_MIN_LEFT
            {
                if let Some(ep) = &job.authority {
                    if probe::probe_due(state, mgr, ctl, &ctl.source) {
                        probing =
                            Some(probe::probe(state, mgr, ctl, ep, total).map(|_| ()).boxed());
                    }
                }
            }
            // No mirror serves the transfer: copies that were busy or
            // unknown may be free now.
            if let Some(m) = &job.mirrors {
                if !stopping
                    && may
                    && finding.is_none()
                    && now.duration_since(searched) >= FIND_EVERY
                    && total - done > PROBE_MIN_LEFT
                    && state.settings.read().download_use_mirrors
                    && !srcs.iter().any(|s| s.mirror && s.usable().is_some())
                {
                    finding = Some(find_mirrors(cx, m).boxed());
                }
            }
            let secs = now.duration_since(last_stats).as_secs_f64().max(0.001);
            let speed = ((received - stats_received) as f64 / secs).round().max(0.0) as i64;
            let s = breakdown(cx, &srcs, &running, &ramp, refused, speed);
            stats::publish(state, ctl, s);
            last_stats = now;
            stats_received = received;
        }
        if stopping && workers.is_empty() {
            break;
        }
    }
    drop(finding);
    drop(probing);
    // The transfer holds its one connection again.
    for s in &srcs {
        if let Some(c) = &s.conn {
            ctl.set_held(&c.id, usize::from(c.idx == 0));
        }
    }
    // Before the sidecar is removed or saved for the last time, so an older
    // snapshot never lands after it.
    settle_save(job.id, saving.take()).await;
    drop(workers);
    // The last sender: the writer writes what is queued, syncs and closes
    // the `.part`.
    cx.tx.lock().take();
    let flushed = writer.finish().await;

    let ranges = plan.lock().ranges.clone();
    let done = ranges.done();
    let part = job.part.clone();
    if let Some(WorkerError::Changed(why)) = &failure {
        tracing::info!(
            id = job.id,
            why,
            "segment answer did not match; restarting with one connection"
        );
        ctl.push_note(TransferNote::OneConnection {
            reason: OneConnectionReason::Changed,
        });
        ctl.set_one_connection(true);
        let _ = tokio::task::spawn_blocking(move || {
            // The sidecar goes only once the `.part` is empty.
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&part)?;
            super::remove(&part);
            Ok::<_, io::Error>(())
        })
        .await;
        return SegEnd::Changed;
    }
    match flushed {
        Err(e) => {
            if failure.is_none() {
                failure = Some(WorkerError::Failed(CoreError::Io(e)));
            }
        }
        Ok(()) if ranges.verified() => {
            let _ = tokio::task::spawn_blocking(move || super::remove(&part)).await;
            return SegEnd::Done(total);
        }
        Ok(()) => {}
    }
    settle_save(job.id, Some(spawn_save(job, ranges, None))).await;
    match failure {
        Some(
            WorkerError::Failed(err)
            | WorkerError::Refused(err)
            | WorkerError::Dropped(err)
            | WorkerError::Unreachable(err),
        ) => SegEnd::Error { err, bytes: done },
        _ => SegEnd::Stopped(done),
    }
}

/// Workers of source `src` that run.
fn count(running: &[Running], src: usize) -> usize {
    running.iter().filter(|r| r.src == src).count()
}

/// How long a new request waits after a connection closed.
fn grace(closed_at: Option<Instant>) -> Duration {
    closed_at.map_or(Duration::ZERO, |t| CLOSE_GRACE.saturating_sub(t.elapsed()))
}

/// Connections per source now: the authority's allowance first, then the
/// mirrors' in turn, within the ramp's target and "Most connections per
/// download". "Connections per download: 1", a speed cap and a refused
/// connection keep one (resuming a split file one segment after another)
/// and no mirrors.
fn desired(cx: &Cx<'_>, srcs: &[Src], target: usize) -> Desired {
    let (state, ctl, mgr) = (cx.job.state, cx.job.ctl, cx.job.mgr);
    let one = cx.job.one_connection.load(Ordering::Relaxed);
    let may = transfer::may_split(state, &ctl.source, ctl, one);
    let (cap, single, use_mirrors) = {
        let settings = state.settings.read();
        let cap = match settings.download_max_connections {
            0 => MAX_CONNECTIONS,
            n => usize::from(n).min(MAX_CONNECTIONS),
        };
        (
            cap,
            settings.download_single_connection.clone(),
            settings.download_use_mirrors,
        )
    };
    let wants: Vec<usize> = srcs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if i == 0 {
                return if may {
                    mgr.allowance_on(ctl, &ctl.source).max(1)
                } else {
                    1
                };
            }
            match s.usable() {
                Some(c) if may && use_mirrors => {
                    let n = mgr.allowance_on(ctl, &c.id);
                    if single.contains(&c.id) {
                        n.min(1)
                    } else {
                        n
                    }
                }
                _ => 0,
            }
        })
        .collect();
    let room = wants.iter().sum::<usize>().min(cap).max(1);
    let mut left = target.min(room).max(1);
    let mut per = vec![0; srcs.len()];
    per[0] = wants[0].min(left);
    left -= per[0];
    while left > 0 {
        let mut added = false;
        for i in 1..srcs.len() {
            if left > 0 && per[i] < wants[i] {
                per[i] += 1;
                left -= 1;
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    Desired { per, room, cap }
}

/// Records the connections the transfer holds on each source; a queued
/// download of a source may start when they went down. The authority keeps
/// at least the one connection the run started with, even while only
/// mirrors fetch: the manager counts a running transfer against its own
/// source (`preempt`), so a row started there meanwhile would only be asked
/// to yield again, over and over, until this one ends.
fn hold(cx: &Cx<'_>, srcs: &[Src], running: &[Running]) {
    let ctl = cx.job.ctl;
    let before = ctl.connections.load(Ordering::Relaxed);
    for (i, s) in srcs.iter().enumerate() {
        let Some(c) = &s.conn else { continue };
        let n = count(running, i);
        let n = if i == 0 { n.max(1) } else { n };
        ctl.set_held(&c.id, n);
    }
    if ctl.connections.load(Ordering::Relaxed) < before {
        cx.job.mgr.released();
    }
}

/// Starts worker `st`.
fn start<'a>(
    cx: &'a Cx<'a>,
    st: Start,
    srcs: &[Src],
    wait: Duration,
    all: &CancellationToken,
    next_wid: &mut u64,
    running: &mut Vec<Running>,
) -> BoxFuture<'a, Ended> {
    let conn = Arc::clone(srcs[st.src].conn.as_ref().expect("a connected source"));
    let retire = all.child_token();
    let meter = Meter::new(&conn.host);
    *next_wid += 1;
    let wid = *next_wid;
    running.push(Running {
        wid,
        src: st.src,
        retire: retire.clone(),
        meter: Arc::clone(&meter),
        verify: st.verify.is_some(),
        recycle: false,
        recycled_at: st.addr.map(|(_, t)| t),
        slow_since: None,
    });
    let Start {
        seg,
        src,
        stream,
        verify: check,
        addr,
    } = st;
    async move {
        let result = match check {
            Some((at, len)) => verify(cx, seg, &conn, at, len, &retire, &meter).await,
            None => {
                let addr = addr.map(|(k, _)| k);
                fetch(cx, seg, &conn, stream, wait, &retire, &meter, addr).await
            }
        };
        cx.plan.lock().taken[seg] = false;
        Ended {
            wid,
            seg,
            src,
            meter,
            result,
        }
    }
    .boxed()
}

/// Source `src` leaves the transfer: its workers are retired.
fn drop_source(srcs: &mut [Src], running: &mut Vec<Running>, src: usize) {
    srcs[src].dropped = true;
    running.retain(|r| {
        if r.src == src {
            r.retire.cancel();
            false
        } else {
            true
        }
    });
}

/// Overlapping bytes of `me` and `other` differ and one of them is a
/// mirror: every segment a mirror side served starts over from the
/// authority, and that mirror leaves the transfer.
fn discard(cx: &Cx<'_>, srcs: &mut [Src], running: &mut Vec<Running>, me: u16, other: u16) {
    let job = cx.job;
    let mut sides = vec![me, other];
    sides.dedup();
    for side in sides.into_iter().filter(|s| *s != 0) {
        let opposite = if side == me { other } else { me };
        {
            let mut p = cx.plan.lock();
            for i in 0..p.ranges.segments.len() {
                if p.ranges.segments[i].src == side {
                    p.reset(i);
                }
            }
        }
        let i = usize::from(side);
        drop_source(srcs, running, i);
        let id = srcs[i].id();
        tracing::warn!(id = job.id, source = %id, "a mirror's bytes differ from the file; dropping it");
        if let Some(mirror) = srcs[i].copy.clone() {
            let (state, item) = (Arc::clone(job.state), job.copy.clone());
            tokio::spawn(async move {
                mirrors::record_mismatch(&state, &item, &mirror, opposite == 0).await;
            });
        }
        job.ctl
            .push_note(TransferNote::MirrorMismatch { source_id: id });
    }
}

/// An identical copy found for the transfer, with its client.
struct Found {
    mirror: mirrors::Mirror,
    client: reqwest::Client,
}

/// The copies identical to the authority's, once its fingerprint is known.
async fn find_mirrors(cx: &Cx<'_>, m: &MirrorPlan) -> Vec<Found> {
    let job = cx.job;
    let fp = match &m.fingerprint {
        Some(fp) => fp.clone(),
        None => {
            // The cached fingerprint no longer matched the file: read it
            // again over a held connection, unless an earlier search of
            // this transfer already did.
            let validator = cx.plan.lock().ranges.sources[0].validator.clone();
            let key = m.item.clone();
            let cached = job
                .state
                .db_call(move |c| mirrors::cached_fingerprint(c, &key))
                .await
                .ok()
                .flatten()
                .filter(|fp| mirrors::still_matches(fp, cx.total, validator.as_deref()));
            if let Some(fp) = cached {
                return search(cx, m, &fp).await;
            }
            let Some(ep) = job.authority.as_ref() else {
                return Vec::new();
            };
            let Some(_hold) = job.mgr.try_hold(&job.ctl.source, HoldPurpose::Fingerprint) else {
                return Vec::new();
            };
            let Ok(fp) = mirrors::fingerprint(job.state, ep).await else {
                return Vec::new();
            };
            let (copy, cached) = (m.item.clone(), fp.clone());
            if let Err(e) = job
                .state
                .db_call(move |c| mirrors::store_fingerprint(c, &copy, &cached))
                .await
            {
                tracing::warn!(id = job.id, error = %e, "could not cache a fingerprint");
            }
            fp
        }
    };
    search(cx, m, &fp).await
}

/// The copies identical to the authority's, by its fingerprint `fp`.
async fn search(cx: &Cx<'_>, m: &MirrorPlan, fp: &shared::Fingerprint) -> Vec<Found> {
    let job = cx.job;
    if fp.total != cx.total {
        return Vec::new();
    }
    let exclude = [job.ctl.source.clone()];
    let found = mirrors::identical_copies(job.state, job.mgr, &m.item, fp, &exclude).await;
    let mut out = Vec::with_capacity(found.len());
    for mirror in found {
        let client = crate::http::source_client(
            job.state,
            &mirror.endpoint.copy.item_ref.source_id,
            &mirror.endpoint.url,
        )
        .await;
        out.push(Found { mirror, client });
    }
    out
}

/// Adds the mirrors found to the transfer. True when a mirror the sidecar
/// knew changed its file and its bytes were discarded.
fn attach(cx: &Cx<'_>, srcs: &mut Vec<Src>, found: Vec<Found>) -> bool {
    let ctl = cx.job.ctl;
    let mut discarded = false;
    for f in found {
        let copy = f.mirror.endpoint.copy.clone();
        let id = copy.item_ref.source_id.clone();
        if id == ctl.source
            || srcs
                .iter()
                .any(|s| s.conn.as_ref().is_some_and(|c| c.id == id))
        {
            continue;
        }
        let validator = f.mirror.fingerprint.validator.clone();
        let idx = {
            let mut p = cx.plan.lock();
            match p
                .ranges
                .sources
                .iter()
                .position(|s| s.copy.as_ref() == Some(&copy))
            {
                Some(k) if k > 0 => {
                    if p.ranges.sources[k].validator != validator {
                        // The mirror's file changed since it served these
                        // bytes.
                        for i in 0..p.ranges.segments.len() {
                            if usize::from(p.ranges.segments[i].src) == k {
                                p.reset(i);
                                discarded = true;
                            }
                        }
                        p.ranges.sources[k].validator = validator.clone();
                    }
                    k
                }
                _ => {
                    if p.ranges.sources.len() > usize::from(u16::MAX) {
                        continue;
                    }
                    p.ranges.sources.push(SegSource {
                        copy: Some(copy.clone()),
                        validator: validator.clone(),
                    });
                    srcs.push(Src::new(Some(copy.clone())));
                    p.ranges.sources.len() - 1
                }
            }
        };
        let ep = &f.mirror.endpoint;
        let s = &mut srcs[idx];
        s.copy = Some(copy);
        s.mirror = true;
        s.conn = Some(Arc::new(Conn {
            id: id.clone(),
            idx: idx as u16,
            url: ep.url.clone(),
            headers: ep.headers.clone(),
            client: f.client,
            host: host_of(&ep.url),
            validator,
            pinned: Mutex::new(None),
        }));
        cx.tails.store(true, Ordering::Relaxed);
        tracing::info!(id = cx.job.id, source = %id, "an identical copy joins the download");
        ctl.push_note(TransferNote::MirrorAdded { source_id: id });
    }
    discarded
}

/// Marks a connection below half the median speed for `recycle_after` (at
/// most one a second) to close and reopen on the host's next address.
fn recycle(cx: &Cx<'_>, running: &mut [Running], now: Instant) {
    let speeds: Vec<i64> = running
        .iter()
        .filter(|r| !r.verify)
        .map(|r| r.meter.speed())
        .collect();
    if speeds.len() < 2 {
        return;
    }
    let median = stats::median(&speeds) as f64;
    let after = cx.job.mgr.ramp_timing().recycle_after;
    let mut chosen = None;
    for r in running.iter_mut().filter(|r| !r.verify && !r.recycle) {
        let slow = r.meter.age() >= RECYCLE_MIN_AGE
            && r.recycled_at
                .is_none_or(|t| now.duration_since(t) >= RECYCLE_EVERY)
            && (r.meter.speed() as f64) < 0.5 * median;
        if !slow {
            r.slow_since = None;
            continue;
        }
        let since = *r.slow_since.get_or_insert(now);
        if chosen.is_none() && now.duration_since(since) >= after {
            chosen = Some(r.wid);
        }
    }
    if let Some(r) = chosen.and_then(|wid| running.iter_mut().find(|r| r.wid == wid)) {
        tracing::info!(id = cx.job.id, "replacing a slow connection");
        r.recycle = true;
        r.retire.cancel();
    }
}

/// The transfer's breakdown for `downloads.stats`.
fn breakdown(
    cx: &Cx<'_>,
    srcs: &[Src],
    running: &[Running],
    ramp: &Ramp,
    refused: bool,
    speed: i64,
) -> TransferStats {
    let (state, ctl, mgr) = (cx.job.state, cx.job.ctl, cx.job.mgr);
    let connections = running
        .iter()
        .map(|r| {
            let (host, address) = r.meter.peer();
            ConnectionStat {
                source_id: srcs[r.src].id(),
                host,
                address,
                bytes_per_second: r.meter.speed(),
                bytes: r.meter.bytes(),
                age_ms: r.meter.age().as_millis().min(i64::MAX as u128) as i64,
            }
        })
        .collect();
    let sources = srcs
        .iter()
        .enumerate()
        .filter(|(i, s)| *i == 0 || (s.conn.is_some() && !s.dropped))
        .map(|(i, s)| {
            let mine = running.iter().filter(|r| r.src == i);
            let speed = mine.clone().map(|r| r.meter.speed()).sum();
            let bytes = s.bytes + mine.clone().map(|r| r.meter.bytes()).sum::<i64>();
            let role = if i == 0 {
                SourceRole::Primary
            } else {
                SourceRole::Mirror
            };
            stats::source_stat(mgr, &s.id(), role, mine.count(), speed, bytes)
        })
        .collect();
    let want = desired(cx, srcs, ramp.target);
    let mut found = stats::settings_reasons(state, ctl, &ctl.source);
    let (complete, can_grow) = {
        let p = cx.plan.lock();
        (p.ranges.complete(), p.can_grow())
    };
    if !complete && !can_grow && running.len() < want.room {
        found.push(Limiting::SmallFile);
    }
    if running.len() >= want.cap {
        found.push(Limiting::MaxConnections {
            max: want.cap as i64,
        });
    }
    if refused {
        found.push(Limiting::Refused {
            source_id: ctl.source.clone(),
        });
    }
    for s in srcs.iter().filter(|s| s.usable().is_some()) {
        found.extend(mgr.limit_reason(ctl, &s.id()));
    }
    if let Some(bps) = ramp.line {
        found.push(Limiting::Line {
            bytes_per_second: bps,
        });
    }
    // Every usable source is at its allowance. With connections on several
    // sources no one account explains the speed: each connection's speed
    // does, ahead of the accounts' limits. On one source its account limit
    // stays the answer.
    let several = running.iter().any(|r| r.src != running[0].src);
    if (found.is_empty() || several) && !running.is_empty() && running.len() >= want.room {
        let speeds: Vec<i64> = running.iter().map(|r| r.meter.speed()).collect();
        found.push(Limiting::PerConnection {
            bytes_per_second: stats::median(&speeds),
        });
    }
    TransferStats {
        id: cx.job.id,
        bytes_per_second: speed,
        connections,
        sources,
        limiting: stats::first(found),
        notes: ctl.recent_notes(),
    }
}

/// Saves `ranges` with [`super::save_synced`] once `before` (the save in
/// flight, if any) has landed.
fn spawn_save(
    job: &Job<'_>,
    ranges: Ranges,
    before: Option<JoinHandle<io::Result<()>>>,
) -> JoinHandle<io::Result<()>> {
    let (id, part, slow) = (job.id, job.part.clone(), job.mgr.slow_sync());
    tokio::spawn(async move {
        settle_save(id, before).await;
        tokio::task::spawn_blocking(move || {
            if !slow.is_zero() {
                std::thread::sleep(slow);
            }
            super::save_synced(&part, &ranges)
        })
        .await
        .map_err(io::Error::other)?
    })
}

/// Waits for a save in flight, if any, and logs its failure.
async fn settle_save(id: i64, saving: Option<JoinHandle<io::Result<()>>>) {
    let Some(saving) = saving else { return };
    if let Ok(Err(e)) | Err(e) = saving.await.map_err(io::Error::other) {
        tracing::warn!(id, error = %e, "could not save download ranges");
    }
}

/// The host of `url`, for messages and the breakdown.
fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the server".into())
}

/// The bytes a worker resuming segment `seg` compares first: the last
/// [`shared::OVERLAP`] it wrote, or the end of the finished segment before
/// it.
fn lead_in(p: &Plan, seg: usize) -> Option<Ref> {
    let s = p.ranges.segments[seg];
    if s.pos > s.start {
        let len = shared::OVERLAP.min(s.pos - s.start);
        return Some(Ref {
            seg,
            src: s.src,
            at: s.pos - len,
            len,
            epoch: p.epoch[seg],
        });
    }
    let (j, l) = p
        .ranges
        .segments
        .iter()
        .enumerate()
        .find(|(j, l)| *j != seg && l.end == s.start && l.end > l.start && l.pos == l.end)?;
    let len = shared::OVERLAP.min(l.end - l.start);
    Some(Ref {
        seg: j,
        src: l.src,
        at: s.start - len,
        len,
        epoch: p.epoch[j],
    })
}

/// The bytes past segment `seg`'s `end` its worker compares: the start of
/// what the segment after it wrote, unless both are confirmed already.
fn tail_ref(p: &Plan, seg: usize, end: i64) -> Option<Ref> {
    let (j, n) = p
        .ranges
        .segments
        .iter()
        .enumerate()
        .find(|(j, n)| *j != seg && n.start == end && n.end > n.start)?;
    if n.pos <= n.start || (n.checked && p.ranges.segments[seg].checked) {
        return None;
    }
    Some(Ref {
        seg: j,
        src: n.src,
        at: end,
        len: shared::OVERLAP.min(n.pos - n.start),
        epoch: p.epoch[j],
    })
}

/// Bytes of `at..at + len` outside the three sample windows.
fn outside(total: i64, at: i64, len: i64) -> i64 {
    let mut windows = shared::sample_offsets(total);
    windows.sort_unstable();
    let (end, mut covered, mut reach) = (at + len, 0, at);
    for w in windows {
        let from = w.max(reach);
        let to = (w + shared::SAMPLE_LEN).min(end);
        if to > from {
            covered += to - from;
            reach = to;
        }
    }
    len - covered
}

/// Whether equal bytes of sources `a` and `b` at `at..at + len` confirm
/// them: never a mirror against itself, and a mirror only outside the
/// sample windows it was compared on. The authority against itself counts
/// with or without a validator: it shows the file did not change between
/// the two requests.
fn counts(a: u16, b: u16, total: i64, at: i64, len: i64) -> bool {
    if a == b && a != 0 {
        return false;
    }
    if a == 0 && b == 0 {
        return true;
    }
    outside(total, at, len) >= MIN_OUTSIDE
}

/// The window of segment `seg` a final check fetches, or None when a
/// mirror's piece has too little outside the sample windows.
fn verify_window(p: &Plan, seg: usize, total: i64) -> Option<(i64, i64)> {
    let s = p.ranges.segments[seg];
    let have = s.pos - s.start;
    let len = shared::OVERLAP.min(have);
    let tries = [s.start, s.pos - len, s.start + (have - len) / 2];
    tries
        .into_iter()
        .find(|at| counts(0, s.src, total, *at, len))
        .map(|at| (at, len))
}

/// Records that equal bytes confirmed segment `seg` (served by `src`) and
/// the one `r` names.
fn mark(cx: &Cx<'_>, seg: usize, src: u16, r: &Ref) {
    if r.seg == seg || !counts(src, r.src, cx.total, r.at, r.len) {
        return;
    }
    let mut p = cx.plan.lock();
    if p.epoch[r.seg] == r.epoch {
        p.ranges.segments[seg].checked = true;
        p.ranges.segments[r.seg].checked = true;
    }
}

/// `len` bytes of the `.part` at `at`.
fn read_at(part: &Path, at: i64, len: i64) -> io::Result<Vec<u8>> {
    let file = std::fs::File::open(part)?;
    let mut buf = vec![0u8; len as usize];
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut got = 0;
        while got < buf.len() {
            match file.seek_read(&mut buf[got..], at as u64 + got as u64) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(n) => got += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
    }
    #[cfg(unix)]
    std::os::unix::fs::FileExt::read_exact_at(&file, &mut buf, at as u64)?;
    Ok(buf)
}

/// Compares `got` with the bytes `r` names. None when they are no longer
/// what the plan holds (discarded meanwhile).
async fn compare(cx: &Cx<'_>, r: &Ref, got: &[u8]) -> Result<Option<bool>, WorkerError> {
    let (part, at, len) = (cx.job.part.clone(), r.at, r.len);
    let disk = tokio::task::spawn_blocking(move || read_at(&part, at, len))
        .await
        .map_err(io::Error::other)
        .and_then(|r| r)
        .map_err(|e| WorkerError::Failed(CoreError::Io(e)))?;
    let p = cx.plan.lock();
    let s = p.ranges.segments[r.seg];
    if p.epoch[r.seg] != r.epoch || s.src != r.src || s.pos < r.at + r.len {
        return Ok(None);
    }
    Ok(Some(disk == got))
}

/// A client that connects to address `k` of `url`'s host, and that
/// address. None for an address a request could not connect to before.
async fn pinned_to(cx: &Cx<'_>, url: &str, k: usize) -> Option<(reqwest::Client, SocketAddr)> {
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?.to_string();
    let port = u.port_or_known_default()?;
    let addrs = crate::http::host_addresses(cx.job.state, &host, port).await;
    if addrs.is_empty() {
        return None;
    }
    let addr = addrs[k % addrs.len()];
    if cx.dead.lock().contains(&addr) {
        return None;
    }
    let client = crate::http::pinned_client(cx.job.state, &host, addr)?;
    Some((client, addr))
}

/// Asks `conn` for bytes `from..to`: at the URL its last answer came from,
/// and once more at its own URL when that fails (a redirect's token can
/// expire). None when the worker was retired meanwhile.
#[allow(clippy::too_many_arguments)]
async fn open(
    cx: &Cx<'_>,
    conn: &Conn,
    from: i64,
    to: i64,
    retire: &CancellationToken,
    addr: Option<usize>,
    meter: &Meter,
) -> Result<Option<reqwest::Response>, WorkerError> {
    let pinned = conn.pinned.lock().clone();
    let (url, client) = match &pinned {
        Some((u, c)) => (u.clone(), c.clone()),
        None => (conn.url.clone(), conn.client.clone()),
    };
    let address = match addr {
        Some(k) => pinned_to(cx, &url, k).await,
        None => None,
    };
    meter.set_peer(
        host_of(&url),
        address.as_ref().map(|(_, a)| a.ip().to_string()),
    );
    let answer = tokio::select! {
        _ = retire.cancelled() => return Ok(None),
        r = request(cx, conn, address.as_ref().map_or(&client, |(c, _)| c), &url, from, to) => r,
    };
    // An address of the host that does not answer is skipped from now on,
    // and the request goes the usual way: it says nothing about the
    // provider's limit.
    let answer = match (answer, address) {
        (Err(WorkerError::Unreachable(err)), Some((_, a))) => {
            tracing::info!(id = cx.job.id, address = %a.ip(), error = %err, "an address of the host did not answer; skipping it");
            cx.dead.lock().push(a);
            meter.set_peer(host_of(&url), None);
            tokio::select! {
                _ = retire.cancelled() => return Ok(None),
                r = request(cx, conn, &client, &url, from, to) => r,
            }
        }
        (answer, _) => answer,
    };
    let resp = match answer {
        Ok(resp) => resp,
        Err(e) if pinned.is_some() => {
            let why = match &e {
                WorkerError::Refused(err)
                | WorkerError::Failed(err)
                | WorkerError::Dropped(err)
                | WorkerError::Unreachable(err) => err.to_string(),
                WorkerError::Changed(why) => why.clone(),
                WorkerError::Mismatch { .. } => String::new(),
            };
            tracing::info!(
                id = cx.job.id,
                why,
                "the redirect target failed; asking the original URL again"
            );
            let resp = tokio::select! {
                _ = retire.cancelled() => return Ok(None),
                r = request(cx, conn, &conn.client, &conn.url, from, to) => r?,
            };
            *conn.pinned.lock() = None;
            meter.set_peer(conn.host.clone(), None);
            cx.job.ctl.push_note(TransferNote::UrlRefreshed);
            resp
        }
        Err(e) => return Err(e),
    };
    let landed = resp.url().as_str();
    let current = conn.pinned.lock().as_ref().map(|(u, _)| u.clone());
    if landed != conn.url && current.as_deref() != Some(landed) {
        let landed = landed.to_string();
        let client = crate::http::source_client(cx.job.state, &conn.id, &landed).await;
        *conn.pinned.lock() = Some((landed, client));
    }
    Ok(Some(resp))
}

/// One range request, checked.
async fn request(
    cx: &Cx<'_>,
    conn: &Conn,
    client: &reqwest::Client,
    url: &str,
    from: i64,
    to: i64,
) -> Result<reqwest::Response, WorkerError> {
    let mut req = crate::http::apply_source_headers(client.get(url), &conn.headers)
        .header(ACCEPT_ENCODING, "identity")
        .header(RANGE, format!("bytes={from}-{}", to - 1));
    if let Some(v) = &conn.validator {
        req = req.header(IF_RANGE, v.as_str());
    }
    // No answer is not a refusal: only an HTTP status says the provider
    // turned the connection down.
    let resp = crate::http::send_within(req, cx.job.head_limit)
        .await
        .map_err(|e| match e {
            CoreError::Invalid(_) => WorkerError::Refused(e),
            e => WorkerError::Unreachable(e),
        })?;
    check_range(&resp, from, cx.total)?;
    Ok(resp)
}

/// Hands `buf` to the writer. False when the worker was retired while the
/// writer's queue was full, or the writer is gone: the bytes are not
/// recorded and get fetched again.
async fn hand(
    cx: &Cx<'_>,
    tx: &writer::Sender,
    block: (usize, u64),
    sent: &mut i64,
    buf: &mut Vec<u8>,
    retire: Option<&CancellationToken>,
) -> bool {
    if buf.is_empty() {
        return true;
    }
    let (seg, epoch) = block;
    let data = std::mem::replace(buf, Vec::with_capacity(BLOCK));
    let len = data.len() as i64;
    {
        let mut p = cx.plan.lock();
        if p.epoch[seg] == epoch {
            p.queued[seg] = p.queued[seg].max(*sent + len);
        }
    }
    let block = Block {
        seg,
        at: *sent,
        epoch,
        data,
    };
    let handed = match retire {
        Some(retire) => tokio::select! {
            biased;
            _ = retire.cancelled() => false,
            r = tx.send(block) => r.is_ok(),
        },
        None => tx.send(block).await.is_ok(),
    };
    if handed {
        *sent += len;
    } else {
        // The block never reached the writer: nothing will move `pos` past
        // `sent`, so `queued` must not claim it either (a later worker
        // would never fetch those bytes).
        let mut p = cx.plan.lock();
        if p.epoch[seg] == epoch && p.queued[seg] == *sent + len {
            p.queued[seg] = *sent;
        }
    }
    handed
}

/// Fetches segment `seg` from `conn` (from `first` when given, else with
/// its own request, sent after `wait`) until it is written, the worker is
/// retired, or it fails. A worker without the authority's validator first
/// compares the bytes before its position, and on reaching the end the
/// bytes after it, with what other requests wrote.
#[allow(clippy::too_many_arguments)]
async fn fetch(
    cx: &Cx<'_>,
    seg: usize,
    conn: &Conn,
    first: Option<Body>,
    wait: Duration,
    retire: &CancellationToken,
    meter: &Meter,
    addr: Option<usize>,
) -> Result<WorkerEnd, WorkerError> {
    let job = cx.job;
    let validated = conn.validated();
    let opened = first.is_some();
    let (pos, end, epoch, lead) = {
        let p = cx.plan.lock();
        let s = p.ranges.segments[seg];
        if s.pos >= s.end {
            return Ok(WorkerEnd::Finished);
        }
        // The open answer goes on from the bytes it already wrote.
        let lead = if opened || validated {
            None
        } else {
            lead_in(&p, seg)
        };
        (s.pos, s.end, p.epoch[seg], lead)
    };
    let lead_len = lead.map_or(0, |r| r.len);
    let tails = opened || !validated || cx.tails.load(Ordering::Relaxed);
    let mut stream = match first {
        Some(s) => s,
        None => {
            if !wait.is_zero() {
                tokio::select! {
                    _ = retire.cancelled() => return Ok(WorkerEnd::Retired),
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            let to = if tails {
                (end + shared::OVERLAP).min(cx.total)
            } else {
                end
            };
            match open(cx, conn, pos - lead_len, to, retire, addr, meter).await? {
                Some(resp) => resp.bytes_stream().boxed(),
                None => return Ok(WorkerEnd::Retired),
            }
        }
    };
    let Some(tx) = cx.tx.lock().clone() else {
        return Ok(WorkerEnd::Retired);
    };
    let mut lead_buf: Vec<u8> = Vec::with_capacity(lead_len as usize);
    // Bytes handed to the writer end here; `buf` holds the next ones.
    let mut sent = pos;
    let mut buf: Vec<u8> = Vec::with_capacity(BLOCK);
    // Bytes past the segment's end, for the tail check.
    let mut spill: Vec<u8> = Vec::new();
    let mut handed_at = Instant::now();
    let mut outcome: Result<WorkerEnd, WorkerError> = Ok(WorkerEnd::Finished);
    // A speed cap set in flight applies at once, shared by the workers until
    // the extra ones are retired.
    let share = || {
        let workers = job.ctl.connections.load(Ordering::Relaxed).max(1) as u64;
        job.ctl
            .rate_limit(job.state.settings.read().download_rate_limit_bps)
            .map(|bps| (bps / workers).max(1))
    };
    let mut pace = Pace::new(share(), pos);
    loop {
        // A split may have moved this segment's end closer; a mismatch
        // elsewhere may have discarded it.
        let (end, now_epoch) = {
            let p = cx.plan.lock();
            (p.ranges.segments[seg].end, p.epoch[seg])
        };
        if now_epoch != epoch {
            outcome = Ok(WorkerEnd::Retired);
            break;
        }
        if lead_buf.len() as i64 >= lead_len && sent + buf.len() as i64 >= end {
            break;
        }
        let next = tokio::select! {
            biased;
            _ = retire.cancelled() => {
                outcome = Ok(WorkerEnd::Retired);
                break;
            }
            n = tokio::time::timeout(job.idle_limit, stream.next()) => n,
        };
        match next {
            Ok(Some(Ok(chunk))) => {
                meter.add(chunk.len());
                let mut data = &chunk[..];
                if (lead_buf.len() as i64) < lead_len {
                    let n = ((lead_len - lead_buf.len() as i64) as usize).min(data.len());
                    lead_buf.extend_from_slice(&data[..n]);
                    data = &data[n..];
                    if lead_buf.len() as i64 == lead_len {
                        let r = lead.expect("a lead-in to compare");
                        match compare(cx, &r, &lead_buf).await {
                            Ok(Some(true)) => mark(cx, seg, conn.idx, &r),
                            Ok(Some(false)) => {
                                outcome = Err(WorkerError::Mismatch { other: r.src });
                                break;
                            }
                            Ok(None) => {
                                outcome = Ok(WorkerEnd::Retired);
                                break;
                            }
                            Err(e) => {
                                outcome = Err(e);
                                break;
                            }
                        }
                    }
                }
                let room = (end - sent - buf.len() as i64).max(0) as usize;
                let n = room.min(data.len());
                buf.extend_from_slice(&data[..n]);
                if data.len() > n {
                    // Bytes past the end: the stream's next byte no longer
                    // belongs where the next write would put it, so this
                    // stream is done even if the end has moved on meanwhile
                    // (a refused segment handed back), and what is left
                    // gets its own request. Without a tail check to make,
                    // the connection goes.
                    spill.extend_from_slice(&data[n..]);
                    if !tails {
                        outcome = Ok(WorkerEnd::Retired);
                    }
                    break;
                }
                if buf.len() >= BLOCK || (!buf.is_empty() && handed_at.elapsed() >= TICK) {
                    if !hand(cx, &tx, (seg, epoch), &mut sent, &mut buf, Some(retire)).await {
                        outcome = Ok(WorkerEnd::Retired);
                        break;
                    }
                    handed_at = Instant::now();
                }
                let at = sent + buf.len() as i64;
                let mut retired = false;
                while let Some(wait) = pace.delay(share(), at, Instant::now()) {
                    tokio::select! {
                        biased;
                        _ = retire.cancelled() => {
                            retired = true;
                            break;
                        }
                        _ = tokio::time::sleep(wait.min(transfer::THROTTLE_SLICE)) => {}
                    }
                }
                if retired {
                    outcome = Ok(WorkerEnd::Retired);
                    break;
                }
            }
            Ok(Some(Err(e))) => {
                outcome = Err(WorkerError::Dropped(crate::http::transport_error(
                    &conn.host, e,
                )));
                break;
            }
            Ok(None) => {
                outcome = Err(WorkerError::Dropped(CoreError::Network(
                    "Transfer ended before the advertised size".into(),
                )));
                break;
            }
            Err(_) => {
                outcome = Err(WorkerError::Dropped(CoreError::Timeout(format!(
                    "{} stopped sending data in the middle of the download (nothing for {} s). Check that the server is online, then try again.",
                    conn.host,
                    job.idle_limit.as_secs()
                ))));
                break;
            }
        }
    }
    // The bytes past the end are compared with the segment after it, when
    // that one holds bytes no comparison confirmed yet.
    let tail = match &outcome {
        Ok(WorkerEnd::Finished) if tails => tail_ref(&cx.plan.lock(), seg, sent + buf.len() as i64),
        _ => None,
    };
    // Otherwise the connection closes before the last bytes are handed
    // over: a full queue can hold that up while playback waits for it.
    let mut stream = tail.map(|_| stream);
    if !matches!(outcome, Err(WorkerError::Mismatch { .. }))
        && !hand(cx, &tx, (seg, epoch), &mut sent, &mut buf, None).await
    {
        outcome = Ok(WorkerEnd::Retired);
    }
    if let (Some(r), Some(body)) = (tail, stream.as_mut()) {
        let need = r.len as usize;
        spill.truncate(need);
        while spill.len() < need {
            let next = tokio::select! {
                biased;
                _ = retire.cancelled() => break,
                n = tokio::time::timeout(job.idle_limit, body.next()) => n,
            };
            match next {
                Ok(Some(Ok(chunk))) => {
                    meter.add(chunk.len());
                    let n = (need - spill.len()).min(chunk.len());
                    spill.extend_from_slice(&chunk[..n]);
                }
                // The segment is written; only the check is lost.
                _ => break,
            }
        }
        drop(stream);
        if spill.len() == need {
            match compare(cx, &r, &spill).await? {
                Some(true) => mark(cx, seg, conn.idx, &r),
                Some(false) => return Err(WorkerError::Mismatch { other: r.src }),
                None => {}
            }
        }
    }
    if matches!(outcome, Ok(WorkerEnd::Finished)) && sent < cx.plan.lock().ranges.segments[seg].end
    {
        // A refused segment was handed back after this stream reached the
        // old end: the rest is free for its own request.
        return Ok(WorkerEnd::Retired);
    }
    outcome
}

/// The final check of segment `seg`: fetches `len` bytes at `at` from the
/// authority and compares them with the `.part`.
async fn verify(
    cx: &Cx<'_>,
    seg: usize,
    conn: &Conn,
    at: i64,
    len: i64,
    retire: &CancellationToken,
    meter: &Meter,
) -> Result<WorkerEnd, WorkerError> {
    let job = cx.job;
    let r = {
        let p = cx.plan.lock();
        Ref {
            seg,
            src: p.ranges.segments[seg].src,
            at,
            len,
            epoch: p.epoch[seg],
        }
    };
    let Some(resp) = open(cx, conn, at, at + len, retire, None, meter).await? else {
        return Ok(WorkerEnd::Retired);
    };
    let mut body = resp.bytes_stream();
    let mut got: Vec<u8> = Vec::with_capacity(len as usize);
    while (got.len() as i64) < len {
        let next = tokio::select! {
            biased;
            _ = retire.cancelled() => return Ok(WorkerEnd::Retired),
            n = tokio::time::timeout(job.idle_limit, body.next()) => n,
        };
        match next {
            Ok(Some(Ok(chunk))) => {
                meter.add(chunk.len());
                got.extend_from_slice(&chunk);
            }
            Ok(Some(Err(e))) => {
                return Err(WorkerError::Dropped(crate::http::transport_error(
                    &conn.host, e,
                )))
            }
            Ok(None) => {
                return Err(WorkerError::Dropped(CoreError::Network(
                    "Transfer ended before the advertised size".into(),
                )))
            }
            Err(_) => {
                return Err(WorkerError::Dropped(CoreError::Timeout(format!(
                    "{} stopped sending data (nothing for {} s).",
                    conn.host,
                    job.idle_limit.as_secs()
                ))))
            }
        }
    }
    drop(body);
    got.truncate(len as usize);
    match compare(cx, &r, &got).await? {
        Some(true) => {
            let mut p = cx.plan.lock();
            if p.epoch[seg] == r.epoch {
                p.ranges.segments[seg].checked = true;
            }
            Ok(WorkerEnd::Finished)
        }
        Some(false) => Err(WorkerError::Mismatch { other: r.src }),
        None => Ok(WorkerEnd::Retired),
    }
}

/// A segment answer must be a `206` for exactly `pos..` of a file of
/// `total` bytes; anything else (a `200` because If-Range saw a change or
/// ranges stopped working, another start or total) is not what the plan
/// holds.
fn check_range(resp: &reqwest::Response, pos: i64, total: i64) -> Result<(), WorkerError> {
    let status = resp.status();
    if status == StatusCode::PARTIAL_CONTENT {
        let range = resp
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(transfer::parse_content_range);
        return match range {
            Some((start, Some(t))) if start == pos && t == total => Ok(()),
            other => Err(WorkerError::Changed(format!(
                "asked for byte {pos} of {total}, got {other:?}"
            ))),
        };
    }
    if status.is_success() || status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Err(WorkerError::Changed(format!(
            "answered {status} to a range"
        )));
    }
    Err(WorkerError::Refused(transfer::http_status_error(status)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: i64 = 1024 * 1024;

    #[test]
    fn comparisons_count_only_against_another_source_or_the_authority() {
        let total = 64 * MIB;
        // Outside the samples (0, 32 MiB and the last 64 KiB).
        let at = 10 * MIB;
        assert!(counts(0, 0, total, at, 4096));
        assert!(counts(1, 0, total, at, 64 * 1024));
        assert!(counts(1, 2, total, at, 64 * 1024));
        assert!(
            !counts(1, 1, total, at, 64 * 1024),
            "a mirror against itself"
        );
        // Inside a sample window a mirror proves nothing new.
        assert!(!counts(1, 0, total, 32 * MIB, 64 * 1024));
        assert!(!counts(0, 1, total, 0, 64 * 1024));
        // 4 KiB outside is enough.
        assert!(counts(1, 0, total, 32 * MIB + 60 * 1024, 8 * 1024));
        assert!(!counts(1, 0, total, 32 * MIB + 62 * 1024, 4 * 1024));
        assert_eq!(outside(total, 32 * MIB - 1024, 4096), 1024);
        assert_eq!(outside(total, 5 * MIB, 4096), 4096);
    }

    #[test]
    fn the_ramp_adds_while_a_connection_gains_and_backs_off_when_it_does_not() {
        let w = Duration::from_secs(1);
        let t0 = Instant::now();
        let mut r = Ramp::new(0);
        r.tick(t0, 0, 2, 8, w);
        // Two connections at 10 MB/s for a window: add a third.
        r.tick(t0 + w, 10_000_000, 2, 8, w);
        assert_eq!(r.target, 3);
        // The third runs and the total rises by 50%: keep it, add a fourth.
        r.tick(t0 + w, 10_000_000, 3, 8, w);
        r.tick(t0 + 2 * w, 25_000_000, 3, 8, w);
        assert_eq!(r.gained, Some(true));
        assert_eq!(r.target, 4);
        // The fourth gains nothing: back to three, held.
        r.tick(t0 + 2 * w, 25_000_000, 4, 8, w);
        r.tick(t0 + 3 * w, 40_000_000, 4, 8, w);
        assert_eq!(r.gained, Some(false));
        assert_eq!(r.target, 3);
        assert_eq!(r.line, Some(15_000_000));
        r.tick(t0 + 3 * w, 40_000_000, 3, 8, w);
        r.tick(t0 + 4 * w, 55_000_000, 3, 8, w);
        assert_eq!(r.target, 3, "held for 30 s");
        // No room: nothing is added.
        let mut r = Ramp::new(0);
        r.tick(t0, 0, 2, 2, w);
        r.tick(t0 + w, 10_000_000, 2, 2, w);
        assert_eq!(r.target, 2);
    }

    #[test]
    fn a_final_check_window_stays_outside_the_samples_for_a_mirror() {
        let total = 64 * MIB;
        let mut ranges = Ranges::new(
            total,
            SegSource {
                copy: None,
                validator: None,
            },
            0,
        );
        ranges.sources.push(SegSource {
            copy: None,
            validator: None,
        });
        let s0 = ranges.segments[0];
        ranges.segments[0] = super::super::Seg {
            end: 32 * MIB,
            pos: 32 * MIB,
            ..s0
        };
        ranges.segments.push(super::super::Seg {
            start: 32 * MIB,
            end: total,
            pos: 32 * MIB + 64 * 1024,
            src: 1,
            checked: false,
        });
        let p = Plan::new(ranges);
        // The authority's piece: from its start.
        assert_eq!(verify_window(&p, 0, total), Some((0, 64 * 1024)));
        // The mirror wrote only the middle sample window: nothing to compare.
        assert_eq!(verify_window(&p, 1, total), None);
    }
}
