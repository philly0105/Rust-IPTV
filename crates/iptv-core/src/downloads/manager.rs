//! Queue runtime: the queue, per-source connection budgets, per-task stop
//! tokens. Stored in `state.extensions["downloads"]`. The order (running ids,
//! then the queue) is saved in `app_state` so `init` restores it.
//!
//! Each source gets a connection budget ([`download_budget`]): its account's
//! limit minus one connection kept for playback, never more than playback
//! and recordings on that source leave, and [`MAX_CONCURRENT`] when the
//! account reports no limit. The core learns what plays from the players
//! (`downloads.playback`, a lease each player renews), from the media proxy
//! ([`open_stream`]) and from recordings ([`hold_recording`]). When playback
//! needs a connection a download holds, the newest download from that source
//! yields: it stops like a pause, keeps its `.part`, and waits at the front
//! of the queue until the connection is free again.

use super::store;
use super::transfer::{self, Outcome};
use crate::error::{CoreError, CoreResult};
use crate::model::{DownloadStatus, DownloadWait, WaitReason};
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Extension key of the runtime.
pub const EXT_KEY: &str = "downloads";
/// Connections downloads from one source may use when its account reports
/// no limit (M3U and Stalker sources, an unknown or unlimited account).
pub const MAX_CONCURRENT: usize = 2;
/// How long a player's `downloads.playback` report counts unless renewed.
pub const PLAYBACK_LEASE: Duration = Duration::from_secs(90);
/// How long a source still counts as playing after its last proxied
/// request: an HLS player fetches segments one by one, with gaps.
pub const STREAM_LINGER: Duration = Duration::from_secs(30);
/// Longest wait for downloads to let go of a connection playback needs.
const MAKE_ROOM_WAIT: Duration = Duration::from_secs(2);
/// Extra wait after a download let go: the panel notices the closed
/// connection a moment after the client closed it, and a stream asking
/// sooner can still be refused.
const YIELD_GRACE: Duration = Duration::from_millis(300);
/// How long a source waits after refusing or failing a download, by step
/// in a row, in multiples of [`WAIT_BASE`]: 15 s, 30 s, 1, 2, 5, then
/// 10 min.
const WAIT_STEPS: [u32; 6] = [1, 2, 4, 8, 20, 40];
const WAIT_BASE: Duration = Duration::from_secs(15);
/// How long a row keeps waiting for its source (without new bytes) before
/// it fails.
pub const WAIT_LIMIT: Duration = Duration::from_secs(2 * 3600);
/// How long an RPC waits for a running transfer to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts at the `queued -> downloading` claim within one run. The claim
/// waits for the database, which a long import or guide save can hold.
pub const CLAIM_ATTEMPTS: u32 = 3;
/// How long an id whose claims all failed waits before it is queued again.
const CLAIM_RETRY: Duration = Duration::from_secs(30);

/// Why a running transfer was asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Keep the `.part`, status `paused`.
    Pause,
    /// Delete the `.part`, status `canceled`.
    Cancel,
    /// Row is about to be removed: keep everything, the caller cleans up.
    Detach,
    /// Playback or a recording on the same source needs the connection:
    /// keep the `.part`, back to `queued` at the front of the queue. Never a
    /// user pause, and any user stop overrides it.
    Yield,
}

/// Control block of one running transfer.
pub struct TaskCtl {
    pub token: CancellationToken,
    reason: Mutex<Option<StopReason>>,
    /// Live byte count (the DB is written every few seconds only).
    pub bytes: AtomicI64,
    done: tokio::sync::watch::Sender<bool>,
    /// Start order among running transfers.
    seq: u64,
    /// Source the transfer downloads from.
    pub source: String,
    /// Connections the transfer holds open.
    connections: AtomicUsize,
}

impl TaskCtl {
    fn new(seq: u64, source: String) -> Self {
        Self {
            token: CancellationToken::new(),
            reason: Mutex::new(None),
            bytes: AtomicI64::new(0),
            done: tokio::sync::watch::channel(false).0,
            seq,
            source,
            connections: AtomicUsize::new(1),
        }
    }

    fn connections(&self) -> usize {
        self.connections.load(Ordering::Relaxed)
    }

    /// Asks the transfer to give its connections back ([`StopReason::Yield`]),
    /// unless a stop was already requested (a user's pause or cancel wins).
    fn request_yield(&self) {
        let mut reason = self.reason.lock();
        if reason.is_none() {
            *reason = Some(StopReason::Yield);
            self.token.cancel();
        }
    }

    /// Reason recorded by the first stop request.
    pub fn reason(&self) -> StopReason {
        self.reason.lock().unwrap_or(StopReason::Pause)
    }
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<i64>,
    /// Source of each queued id.
    queued_from: HashMap<i64, String>,
    active: HashMap<i64, Arc<TaskCtl>>,
    /// Next [`TaskCtl::seq`].
    started: u64,
    /// Connection limit per source, from its cached account status.
    limits: HashMap<String, Limit>,
    /// What each player last reported playing (`downloads.playback`).
    leases: HashMap<String, Lease>,
    /// Streams the media proxy holds open, per source.
    streams: HashMap<String, usize>,
    /// Until when a source counts as playing after its last proxied stream.
    lingering: HashMap<String, Instant>,
    /// Recordings running, per source.
    recordings: HashMap<String, usize>,
    /// Sources whose downloads wait before the next attempt, and why.
    blocked: HashMap<String, Block>,
    /// When each queued id started waiting on a blocked source.
    waiting_since: HashMap<i64, Instant>,
    /// Refusals or failures in a row per source, for the backoff step.
    streaks: HashMap<String, u32>,
    /// When the armed wake-up fires.
    wake_at: Option<Instant>,
}

/// A source's connection limit as the runtime knows it.
#[derive(Debug, Clone, Copy)]
enum Limit {
    /// Being read from the cached account status; its ids wait meanwhile.
    Loading,
    /// `max_connections` when the account reports one above zero.
    Known(Option<i64>),
}

struct Lease {
    sources: Vec<String>,
    until: Instant,
}

/// Why and until when downloads from a source wait (the provider refused a
/// connection, or was unreachable).
struct Block {
    until: Instant,
    /// `until` as wall-clock time, for the UI.
    until_wall: chrono::DateTime<chrono::Utc>,
    reason: WaitReason,
}

/// Connections downloads from one source may use right now: the account's
/// limit minus one kept free for playback, and never more than playback and
/// recordings on the source leave. A 1-connection account downloads only
/// while nothing else uses it. With no limit (or an unknown one) downloads
/// keep [`MAX_CONCURRENT`] whatever plays.
pub fn download_budget(limit: Option<i64>, playing: usize, recording: usize) -> usize {
    match limit
        .and_then(|l| usize::try_from(l).ok())
        .filter(|l| *l > 0)
    {
        None => MAX_CONCURRENT,
        Some(limit) => {
            let kept = usize::from(limit >= 2);
            (limit - kept).min(limit.saturating_sub(playing + recording))
        }
    }
}

impl Inner {
    /// Streams playing from `source`: the most any one signal reports (a
    /// player's lease and the proxy see the same playback).
    fn playing(&self, source: &str, now: Instant) -> usize {
        let reported: usize = self
            .leases
            .values()
            .filter(|l| l.until > now)
            .map(|l| l.sources.iter().filter(|s| *s == source).count())
            .sum();
        let proxied = self
            .streams
            .get(source)
            .copied()
            .unwrap_or(0)
            .max(usize::from(
                self.lingering.get(source).is_some_and(|t| *t > now),
            ));
        reported.max(proxied)
    }

    fn recording(&self, source: &str) -> usize {
        self.recordings.get(source).copied().unwrap_or(0)
    }

    /// `None` while the source's limit is still being read.
    fn budget(&self, source: &str, now: Instant) -> Option<usize> {
        match self.limits.get(source)? {
            Limit::Loading => None,
            Limit::Known(limit) => Some(download_budget(
                *limit,
                self.playing(source, now),
                self.recording(source),
            )),
        }
    }

    /// Connections the source's transfers hold, including ones winding down.
    fn used(&self, source: &str) -> usize {
        self.active
            .values()
            .filter(|c| c.source == source)
            .map(|c| c.connections())
            .sum()
    }

    /// Asks the newest transfers of every source over its budget to yield
    /// until the rest fit. Returns their done signals.
    fn preempt(&self, now: Instant) -> Vec<tokio::sync::watch::Receiver<bool>> {
        let mut done = Vec::new();
        let sources: HashSet<&str> = self.active.values().map(|c| c.source.as_str()).collect();
        for source in sources {
            let Some(budget) = self.budget(source, now) else {
                continue;
            };
            let mut running: Vec<&Arc<TaskCtl>> = self
                .active
                .values()
                .filter(|c| c.source == source && !c.token.is_cancelled())
                .collect();
            let mut held: usize = running.iter().map(|c| c.connections()).sum();
            running.sort_by_key(|c| std::cmp::Reverse(c.seq));
            for ctl in running {
                if held <= budget {
                    break;
                }
                tracing::info!(source, "download yields its connection to playback");
                ctl.request_yield();
                held = held.saturating_sub(ctl.connections());
                done.push(ctl.done.subscribe());
            }
        }
        done
    }

    /// Drops reports, lingers and blocks that ran out.
    fn expire(&mut self, now: Instant) {
        self.leases.retain(|_, l| l.until > now);
        self.lingering.retain(|_, t| *t > now);
        self.blocked.retain(|_, b| b.until > now);
    }

    /// The next time a budget can grow while something waits, when no
    /// earlier wake-up is armed for it.
    fn arm_wake(&mut self, now: Instant) -> Option<Instant> {
        if self.queue.is_empty() {
            return None;
        }
        let next = self
            .leases
            .values()
            .map(|l| l.until)
            .chain(self.lingering.values().copied())
            .chain(self.blocked.values().map(|b| b.until))
            .filter(|t| *t > now)
            .min()?;
        if self.wake_at.is_some_and(|w| w > now && w <= next) {
            return None;
        }
        self.wake_at = Some(next);
        Some(next)
    }

    /// Running ids in start order, then the queue: the order `init` restores.
    fn order(&self) -> Vec<i64> {
        let mut running: Vec<(u64, i64)> = self.active.iter().map(|(id, c)| (c.seq, *id)).collect();
        running.sort_unstable();
        running
            .into_iter()
            .map(|(_, id)| id)
            .chain(self.queue.iter().copied())
            .collect()
    }
}

/// The latest queue order, for the task that saves it.
struct OrderTx(tokio::sync::watch::Sender<Vec<i64>>);

impl Default for OrderTx {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(Vec::new()).0)
    }
}

/// The download queue runtime.
#[derive(Default)]
pub struct DownloadManager {
    inner: Mutex<Inner>,
    /// Bytes per second cap per transfer; 0 = unlimited. Read by running
    /// transfers on every chunk, so changes apply in flight.
    rate_limit: AtomicU64,
    /// Stop wait override in milliseconds; 0 = [`STOP_TIMEOUT`]. Tests only.
    stop_timeout_ms: AtomicU64,
    /// Response-head and body-idle limit override in milliseconds; 0 = the
    /// defaults ([`crate::http::HEADER_TIMEOUT`], [`crate::http::BODY_IDLE_TIMEOUT`]).
    /// Tests only.
    idle_timeout_ms: AtomicU64,
    /// Claims that fail on purpose before a real one runs. Tests only.
    failing_claims: AtomicU32,
    /// [`CLAIM_RETRY`] override in milliseconds; 0 = default. Tests only.
    claim_retry_ms: AtomicU64,
    order: OrderTx,
    /// The state this runtime belongs to, for callers that only have a
    /// `&AppState` (an account check) or outlive a request (a stream hold).
    state: OnceLock<Weak<AppState>>,
    /// Last account check after a refused request, per source: when, and
    /// whether the credentials worked.
    checked: Mutex<HashMap<String, (Instant, bool)>>,
    /// [`WAIT_BASE`] and [`WAIT_LIMIT`] overrides in milliseconds; 0 =
    /// defaults. Tests only.
    wait_base_ms: AtomicU64,
    wait_limit_ms: AtomicU64,
    /// [`PLAYBACK_LEASE`] override in milliseconds; 0 = default. Tests only.
    lease_ms: AtomicU64,
}

/// What a stop request found.
pub enum Stopped {
    /// A running transfer was signalled; await the receiver for completion.
    Running(tokio::sync::watch::Receiver<bool>),
    /// The id was waiting in the queue and has been removed from it.
    Dequeued,
    /// Not known to the runtime.
    Idle,
}

impl DownloadManager {
    /// Bytes-per-second cap applied to each transfer (`None` = unlimited).
    pub fn rate_limit(&self) -> Option<u64> {
        match self.rate_limit.load(Ordering::Relaxed) {
            0 => None,
            n => Some(n),
        }
    }

    pub fn set_rate_limit(&self, bps: Option<u64>) {
        self.rate_limit.store(bps.unwrap_or(0), Ordering::Relaxed);
    }

    /// How long an RPC waits for a running transfer to stop.
    pub fn stop_timeout(&self) -> Duration {
        match self.stop_timeout_ms.load(Ordering::Relaxed) {
            0 => STOP_TIMEOUT,
            ms => Duration::from_millis(ms),
        }
    }

    /// Overrides the stop wait (`None` = default). Used by tests.
    pub fn set_stop_timeout(&self, timeout: Option<Duration>) {
        let ms = timeout.map_or(0, |t| {
            u64::try_from(t.as_millis()).unwrap_or(u64::MAX).max(1)
        });
        self.stop_timeout_ms.store(ms, Ordering::Relaxed);
    }

    /// How long a transfer waits for the response head, and for the next
    /// body chunk, before it reconnects.
    pub fn idle_timeouts(&self) -> (Duration, Duration) {
        match self.idle_timeout_ms.load(Ordering::Relaxed) {
            0 => (crate::http::HEADER_TIMEOUT, crate::http::BODY_IDLE_TIMEOUT),
            ms => (Duration::from_millis(ms), Duration::from_millis(ms)),
        }
    }

    /// Overrides both idle limits (`None` = defaults). Used by tests.
    pub fn set_idle_timeout(&self, timeout: Option<Duration>) {
        let ms = timeout.map_or(0, |t| {
            u64::try_from(t.as_millis()).unwrap_or(u64::MAX).max(1)
        });
        self.idle_timeout_ms.store(ms, Ordering::Relaxed);
    }

    /// Makes the next `failures` claims fail and an id whose claims all
    /// failed come back after `retry` instead of [`CLAIM_RETRY`]. Used by
    /// tests.
    pub fn fail_next_claims(&self, failures: u32, retry: Duration) {
        self.failing_claims.store(failures, Ordering::Relaxed);
        let ms = u64::try_from(retry.as_millis()).unwrap_or(u64::MAX).max(1);
        self.claim_retry_ms.store(ms, Ordering::Relaxed);
    }

    fn claim_retry(&self) -> Duration {
        match self.claim_retry_ms.load(Ordering::Relaxed) {
            0 => CLAIM_RETRY,
            ms => Duration::from_millis(ms),
        }
    }

    /// Live byte count of a running transfer.
    pub fn live_bytes(&self, id: i64) -> Option<i64> {
        self.inner
            .lock()
            .active
            .get(&id)
            .map(|c| c.bytes.load(Ordering::Relaxed))
    }

    /// Why a queued id waits, when it is more than its turn: playback or
    /// other transfers hold its source's connections, or the source is
    /// blocked after a refusal.
    pub fn waiting(&self, id: i64) -> Option<DownloadWait> {
        let inner = self.inner.lock();
        let source = inner.queued_from.get(&id)?;
        let now = Instant::now();
        if let Some(b) = inner.blocked.get(source).filter(|b| b.until > now) {
            return Some(DownloadWait {
                reason: b.reason,
                until: Some(
                    b.until_wall
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                ),
            });
        }
        let Some(Limit::Known(Some(limit))) = inner.limits.get(source).copied() else {
            return None;
        };
        let used = inner.used(source);
        if used < inner.budget(source, now)? {
            return None;
        }
        let without_playback = download_budget(Some(limit), 0, inner.recording(source));
        let reason = if without_playback > used {
            WaitReason::Playback
        } else {
            WaitReason::Connection
        };
        Some(DownloadWait {
            reason,
            until: None,
        })
    }

    /// Shortens the waits after a refusal or outage (the backoff base and
    /// the give-up limit). Used by tests.
    pub fn set_wait_timing(&self, base: Duration, limit: Duration) {
        let ms = |d: Duration| u64::try_from(d.as_millis()).unwrap_or(u64::MAX).max(1);
        self.wait_base_ms.store(ms(base), Ordering::Relaxed);
        self.wait_limit_ms.store(ms(limit), Ordering::Relaxed);
    }

    /// Shortens how long a playback report counts. Used by tests.
    pub fn set_playback_lease(&self, lease: Duration) {
        let ms = u64::try_from(lease.as_millis()).unwrap_or(u64::MAX).max(1);
        self.lease_ms.store(ms, Ordering::Relaxed);
    }

    fn playback_lease(&self) -> Duration {
        match self.lease_ms.load(Ordering::Relaxed) {
            0 => PLAYBACK_LEASE,
            ms => Duration::from_millis(ms),
        }
    }

    fn wait_timing(&self) -> (Duration, Duration) {
        let read = |a: &AtomicU64, d: Duration| match a.load(Ordering::Relaxed) {
            0 => d,
            ms => Duration::from_millis(ms),
        };
        (
            read(&self.wait_base_ms, WAIT_BASE),
            read(&self.wait_limit_ms, WAIT_LIMIT),
        )
    }

    /// Books a run's outcome against its source. A `Requeue` blocks the
    /// source for the next backoff step and keeps the row's waiting clock,
    /// or becomes `Failed` once the row waited [`WAIT_LIMIT`] without new
    /// bytes. Bytes from the source (a completed or progressing run) end
    /// its streak.
    fn settle(&self, id: i64, source: &str, outcome: Outcome) -> Outcome {
        let now = Instant::now();
        let (base, limit) = self.wait_timing();
        let mut inner = self.inner.lock();
        let Outcome::Requeue {
            reason,
            message,
            bytes,
            progressed,
            part,
        } = outcome
        else {
            if matches!(outcome, Outcome::Completed { .. }) {
                inner.streaks.remove(source);
            }
            if !matches!(
                outcome,
                Outcome::Stopped {
                    reason: StopReason::Yield,
                    ..
                }
            ) {
                inner.waiting_since.remove(&id);
            }
            return outcome;
        };
        if progressed {
            inner.streaks.remove(source);
            inner.waiting_since.remove(&id);
        }
        let since = *inner.waiting_since.entry(id).or_insert(now);
        if now.duration_since(since) >= limit {
            inner.waiting_since.remove(&id);
            return Outcome::Failed {
                message,
                bytes,
                keep_part: true,
                part,
            };
        }
        let step = inner.streaks.get(source).copied().unwrap_or(0);
        inner
            .streaks
            .insert(source.to_string(), step.saturating_add(1));
        let factor = WAIT_STEPS[(step as usize).min(WAIT_STEPS.len() - 1)];
        let delay = base.saturating_mul(factor);
        inner.blocked.insert(
            source.to_string(),
            Block {
                until: now + delay,
                until_wall: chrono::Utc::now()
                    + chrono::Duration::from_std(delay).unwrap_or_default(),
                reason,
            },
        );
        Outcome::Requeue {
            reason,
            message,
            bytes,
            progressed,
            part,
        }
    }

    /// The last account check of `source` when it is younger than
    /// [`crate::account::FORCE_MIN_AGE`]: whether its credentials worked.
    pub fn recent_check(&self, source: &str) -> Option<bool> {
        self.checked
            .lock()
            .get(source)
            .filter(|(at, _)| at.elapsed() < crate::account::FORCE_MIN_AGE)
            .map(|(_, ok)| *ok)
    }

    pub fn note_check(&self, source: &str, ok: bool) {
        self.checked
            .lock()
            .insert(source.to_string(), (Instant::now(), ok));
    }

    /// True while the id is queued in memory or running.
    pub fn is_tracked(&self, id: i64) -> bool {
        let inner = self.inner.lock();
        inner.active.contains_key(&id) || inner.queue.contains(&id)
    }

    /// Stops a running transfer or drops a queued id, atomically. A repeated
    /// request on a transfer that is still winding down (after a `Timeout`)
    /// can escalate the reason: cancel beats remove beats pause, so a cancel
    /// issued after a timed-out pause still ends `canceled`.
    pub fn stop(&self, id: i64, reason: StopReason) -> Stopped {
        let mut inner = self.inner.lock();
        if let Some(ctl) = inner.active.get(&id) {
            {
                let mut current = ctl.reason.lock();
                if current.is_none_or(|c| rank(reason) > rank(c)) {
                    *current = Some(reason);
                }
            }
            ctl.token.cancel();
            return Stopped::Running(ctl.done.subscribe());
        }
        if let Some(pos) = inner.queue.iter().position(|q| *q == id) {
            inner.queue.remove(pos);
            inner.queued_from.remove(&id);
            inner.waiting_since.remove(&id);
            self.publish(&inner);
            return Stopped::Dequeued;
        }
        Stopped::Idle
    }

    /// Hands the current order to the task that saves it (a no-op when it
    /// did not change).
    fn publish(&self, inner: &Inner) {
        let next = inner.order();
        self.order.0.send_if_modified(|saved| {
            let changed = *saved != next;
            if changed {
                *saved = next;
            }
            changed
        });
    }
}

/// Saves the queue order in `app_state` whenever it changes, in its own
/// task: a burst of changes while one write waits for the database ends in
/// one write of the latest order. Ends when the runtime is dropped.
pub fn spawn_order_writer(state: &Arc<AppState>) {
    let mut rx = manager(state).order.0.subscribe();
    let state = Arc::downgrade(state);
    tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let ids = rx.borrow_and_update().clone();
            let Some(state) = state.upgrade() else {
                return;
            };
            if let Err(err) = state
                .db_call(move |c| store::save_queue_order(c, &ids))
                .await
            {
                tracing::warn!(error = %err, "could not save the download queue order");
            }
        }
    });
}

fn rank(r: StopReason) -> u8 {
    match r {
        StopReason::Yield => 0,
        StopReason::Pause => 1,
        StopReason::Detach => 2,
        StopReason::Cancel => 3,
    }
}

/// The runtime singleton (created on first use).
pub fn manager(state: &AppState) -> Arc<DownloadManager> {
    state.ext_or_insert_with(EXT_KEY, || Arc::new(DownloadManager::default()))
}

/// Ties the runtime to its state (`init`), for the callers that only have a
/// `&AppState`.
pub fn bind(state: &Arc<AppState>) {
    let _ = manager(state).state.set(Arc::downgrade(state));
}

/// Pumps the queue of the runtime bound to `state`, if any.
fn kick(state: &AppState) {
    let mgr = manager(state);
    if let Some(state) = mgr.state.get().and_then(Weak::upgrade) {
        pump(&state, &mgr);
    }
}

/// Adds `id` (downloading from `source`) to the queue, no duplicates, and
/// starts transfers up to each source's budget.
pub fn enqueue(state: &Arc<AppState>, id: i64, source: &str) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if !inner.active.contains_key(&id) && !inner.queue.contains(&id) {
            inner.queue.push_back(id);
            inner.queued_from.insert(id, source.to_string());
            mgr.publish(&inner);
        }
    }
    pump(state, &mgr);
}

/// [`enqueue`] at the head of the queue, for a download the user resumes,
/// retries or asks for next, or one that yielded: it takes the next free
/// connection instead of waiting behind the rest. An id already queued
/// moves to the front; a running one is left alone.
pub fn enqueue_front(state: &Arc<AppState>, id: i64, source: &str) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if !inner.active.contains_key(&id) {
            if let Some(pos) = inner.queue.iter().position(|q| *q == id) {
                inner.queue.remove(pos);
            }
            inner.queue.push_front(id);
            inner.queued_from.insert(id, source.to_string());
            mgr.publish(&inner);
        }
    }
    pump(state, &mgr);
}

/// Starts every queued id whose source has a free connection (in queue
/// order, so one source at its limit never holds up another), asks
/// transfers over their source's budget to yield, and arms a wake-up for
/// the next time a budget can grow. Returns the done signals of the
/// transfers asked to yield.
fn pump(
    state: &Arc<AppState>,
    mgr: &Arc<DownloadManager>,
) -> Vec<tokio::sync::watch::Receiver<bool>> {
    let now = Instant::now();
    let mut starts = Vec::new();
    let mut loads = Vec::new();
    let (yielding, wake) = {
        let mut inner = mgr.inner.lock();
        inner.expire(now);
        let mut i = 0;
        while i < inner.queue.len() {
            let id = inner.queue[i];
            let source = inner.queued_from.get(&id).cloned().unwrap_or_default();
            if !inner.limits.contains_key(&source) {
                inner.limits.insert(source.clone(), Limit::Loading);
                loads.push(source.clone());
            }
            let room = !inner.blocked.contains_key(&source)
                && inner
                    .budget(&source, now)
                    .is_some_and(|b| inner.used(&source) < b);
            if !room {
                i += 1;
                continue;
            }
            inner.queue.remove(i);
            inner.queued_from.remove(&id);
            let ctl = Arc::new(TaskCtl::new(inner.started, source));
            inner.started += 1;
            inner.active.insert(id, ctl.clone());
            starts.push((id, ctl));
        }
        mgr.publish(&inner);
        (inner.preempt(now), inner.arm_wake(now))
    };
    for (id, ctl) in starts {
        tokio::spawn(run_task(state.clone(), mgr.clone(), id, ctl));
    }
    for source in loads {
        tokio::spawn(load_limit(state.clone(), mgr.clone(), source));
    }
    if let Some(at) = wake {
        let state = Arc::downgrade(state);
        tokio::spawn(async move {
            tokio::time::sleep_until(at.into()).await;
            let Some(state) = state.upgrade() else {
                return;
            };
            let mgr = manager(&state);
            mgr.inner.lock().wake_at = None;
            pump(&state, &mgr);
        });
    }
    yielding
}

/// Reads `source`'s connection limit from its cached account status (every
/// Xtream sync and account check refreshes it), then pumps.
async fn load_limit(state: Arc<AppState>, mgr: Arc<DownloadManager>, source: String) {
    let sid = source.clone();
    let limit = state
        .db_call(move |c| crate::account::load(c, &sid))
        .await
        .ok()
        .flatten()
        .and_then(|s| s.max_connections)
        .filter(|m| *m > 0);
    // A status stored meanwhile ([`account_changed`]) is newer than this read.
    if let Some(entry @ Limit::Loading) = mgr.inner.lock().limits.get_mut(&source) {
        *entry = Limit::Known(limit);
    }
    pump(&state, &mgr);
}

/// A new account status was stored: downloads from that source follow its
/// connection limit from now on.
pub fn account_changed(state: &AppState, status: &crate::account::AccountStatus) {
    let limit = status.max_connections.filter(|m| *m > 0);
    manager(state)
        .inner
        .lock()
        .limits
        .insert(status.source_id.clone(), Limit::Known(limit));
    kick(state);
}

/// Waits (up to [`MAKE_ROOM_WAIT`]) for transfers asked to yield to let go,
/// plus [`YIELD_GRACE`].
async fn wait_yielded(done: Vec<tokio::sync::watch::Receiver<bool>>) {
    if done.is_empty() {
        return;
    }
    let all = futures::future::join_all(done.into_iter().map(|mut rx| async move {
        let _ = rx.wait_for(|d| *d).await;
    }));
    let _ = tokio::time::timeout(MAKE_ROOM_WAIT, all).await;
    tokio::time::sleep(YIELD_GRACE).await;
}

/// `downloads.playback`: the sources one player (`client`) is playing from
/// now; empty when it stopped. Downloads over a source's budget yield, and
/// this returns once they let go of their connections (at most
/// [`MAKE_ROOM_WAIT`]). The report lapses after [`PLAYBACK_LEASE`] unless
/// renewed, so a closed window never holds downloads back for long.
pub async fn set_playback(state: &Arc<AppState>, client: &str, sources: Vec<String>) {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        if sources.is_empty() {
            inner.leases.remove(client);
        } else {
            let until = Instant::now() + mgr.playback_lease();
            inner
                .leases
                .insert(client.to_string(), Lease { sources, until });
        }
    }
    wait_yielded(pump(state, &mgr)).await;
}

/// A stream the media proxy has open from a source; it counts as playback
/// until dropped, and for [`STREAM_LINGER`] after.
pub struct StreamHold {
    state: Weak<AppState>,
    source: String,
}

impl Drop for StreamHold {
    fn drop(&mut self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let mgr = manager(&state);
        {
            let mut inner = mgr.inner.lock();
            if let Some(n) = inner.streams.get_mut(&self.source) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    inner.streams.remove(&self.source);
                }
            }
            inner
                .lingering
                .insert(self.source.clone(), Instant::now() + STREAM_LINGER);
        }
        pump_if_running(&state, &mgr);
    }
}

/// [`pump`] from a `Drop`: it spawns tasks, which needs a runtime (gone
/// once the app is shutting down).
fn pump_if_running(state: &Arc<AppState>, mgr: &Arc<DownloadManager>) {
    if tokio::runtime::Handle::try_current().is_ok() {
        pump(state, mgr);
    }
}

/// Called by the media proxy before it opens a stream from `source`: the
/// stream counts as playback while the returned hold lives, and downloads
/// holding the connection it needs yield first (this waits up to
/// [`MAKE_ROOM_WAIT`] for them), so the stream's own request does not meet
/// a full account.
pub async fn open_stream(state: &Arc<AppState>, source: &str) -> StreamHold {
    let mgr = manager(state);
    {
        let mut inner = mgr.inner.lock();
        *inner.streams.entry(source.to_string()).or_default() += 1;
        inner
            .lingering
            .insert(source.to_string(), Instant::now() + STREAM_LINGER);
    }
    wait_yielded(pump(state, &mgr)).await;
    StreamHold {
        state: Arc::downgrade(state),
        source: source.to_string(),
    }
}

/// A recording writing from a source; it takes one of the source's
/// connections from downloads until dropped.
pub struct RecordingHold {
    state: Weak<AppState>,
    source: String,
}

impl Drop for RecordingHold {
    fn drop(&mut self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let mgr = manager(&state);
        {
            let mut inner = mgr.inner.lock();
            if let Some(n) = inner.recordings.get_mut(&self.source) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    inner.recordings.remove(&self.source);
                }
            }
        }
        pump_if_running(&state, &mgr);
    }
}

/// Counts a recording from `source` against its downloads' budget until the
/// hold is dropped; downloads over it yield and the recording waits for them
/// (at most [`MAKE_ROOM_WAIT`]).
pub async fn hold_recording(state: &Arc<AppState>, source: &str) -> RecordingHold {
    let mgr = manager(state);
    *mgr.inner
        .lock()
        .recordings
        .entry(source.to_string())
        .or_default() += 1;
    wait_yielded(pump(state, &mgr)).await;
    RecordingHold {
        state: Arc::downgrade(state),
        source: source.to_string(),
    }
}

/// Waits until a signalled transfer has persisted its final state. Returns
/// `Timeout` (retryable) when it is still winding down after
/// [`STOP_TIMEOUT`] (for example a disk write stuck on a network share), so
/// the caller does not report a change that has not happened yet. The stop
/// request stays in force; the task applies it as soon as it can, and the
/// row keeps its `downloading` status until then, so calling again either
/// waits once more or finds the final status.
pub async fn wait_stopped(
    state: &AppState,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> CoreResult<()> {
    let limit = manager(state).stop_timeout();
    match tokio::time::timeout(limit, rx.wait_for(|done| *done)).await {
        // A closed channel means the control block is gone, i.e. stopped.
        Ok(_) => Ok(()),
        Err(_) => {
            tracing::warn!("download did not stop within {limit:?}");
            Err(CoreError::Timeout(
                "The download is still stopping. Try again in a moment.".into(),
            ))
        }
    }
}

/// The conditional `queued -> downloading` claim, retried with backoff a
/// few times when the database is busy or briefly unavailable.
async fn claim(state: &Arc<AppState>, mgr: &DownloadManager, id: i64) -> CoreResult<bool> {
    let mut attempt = 0;
    loop {
        let simulated = mgr
            .failing_claims
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
            .is_ok();
        let claimed = if simulated {
            Err(CoreError::Timeout("simulated claim failure".into()))
        } else {
            state
                .db_call(move |c| {
                    store::transition(
                        c,
                        id,
                        &[DownloadStatus::Queued],
                        DownloadStatus::Downloading,
                        None,
                    )
                })
                .await
        };
        match claimed {
            Err(err) if attempt + 1 < CLAIM_ATTEMPTS => {
                tracing::warn!(id, attempt, error = %err, "could not claim download; retrying");
                tokio::time::sleep(crate::http::backoff_delay(attempt)).await;
                attempt += 1;
            }
            other => return other,
        }
    }
}

async fn run_task(state: Arc<AppState>, mgr: Arc<DownloadManager>, id: i64, ctl: Arc<TaskCtl>) {
    let mut retry_later = false;
    // Bytes and `.part` of a run that goes back to the queue.
    let mut back: Option<(i64, Option<std::path::PathBuf>)> = None;
    match claim(&state, &mgr, id).await {
        Ok(true) => {
            state.emit("downloads.update", serde_json::json!({}));
            // A panic in the transfer must still free the concurrency slot
            // and leave the row in a final state.
            let mut outcome = match futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
                transfer::run(&state, id, &ctl, &mgr),
            ))
            .await
            {
                Ok(outcome) => outcome,
                Err(_) => {
                    tracing::error!(id, "download task panicked");
                    Outcome::Failed {
                        message: "The download stopped because of an internal error. Retry it."
                            .into(),
                        bytes: 0,
                        keep_part: true,
                        part: None,
                    }
                }
            };
            // A stop request can escalate after the transfer returned.
            if let Outcome::Stopped { reason, .. } = &mut outcome {
                *reason = ctl.reason();
            }
            let outcome = mgr.settle(id, &ctl.source, outcome);
            back = match &outcome {
                Outcome::Stopped {
                    reason: StopReason::Yield,
                    bytes,
                    part,
                }
                | Outcome::Requeue { bytes, part, .. } => Some((*bytes, part.clone())),
                _ => None,
            };
            persist_outcome(&state, id, outcome).await;
        }
        Ok(false) => tracing::debug!(id, "download no longer queued; skipping"),
        Err(err) => {
            // The row is still `queued` in the database: dropping the id
            // would leave it waiting with no task until the next launch.
            let delay = mgr.claim_retry();
            tracing::error!(id, error = %err, ?delay, "could not claim download; queueing it again later");
            retry_later = !ctl.token.is_cancelled();
        }
    }
    // A row that yielded or waits for its source goes back to the front of
    // the queue, unless the user stopped it meanwhile: their pause, cancel
    // or remove wins, and is saved before they hear back.
    let mut overruled = None;
    {
        let mut inner = mgr.inner.lock();
        inner.active.remove(&id);
        if let Some(stopped) = back.take() {
            match *ctl.reason.lock() {
                Some(r) if r != StopReason::Yield => overruled = Some((r, stopped)),
                _ => {
                    inner.queue.push_front(id);
                    inner.queued_from.insert(id, ctl.source.clone());
                }
            }
        }
        mgr.publish(&inner);
    }
    if let Some((reason, (bytes, part))) = overruled {
        mgr.inner.lock().waiting_since.remove(&id);
        persist_outcome(
            &state,
            id,
            Outcome::Stopped {
                reason,
                bytes,
                part,
            },
        )
        .await;
    }
    ctl.done.send_replace(true);
    state.emit("downloads.update", serde_json::json!({}));
    if retry_later {
        let (state, delay, source) = (state.clone(), mgr.claim_retry(), ctl.source.clone());
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            enqueue_front(&state, id, &source);
        });
    }
    pump(&state, &mgr);
}

/// Attempts at saving a run's outcome before giving up (a busy database).
const PERSIST_ATTEMPTS: u32 = 3;

async fn persist_outcome(state: &Arc<AppState>, id: i64, outcome: Outcome) {
    for attempt in 1..=PERSIST_ATTEMPTS {
        match persist_once(state, id, outcome.clone()).await {
            Ok(()) => return,
            Err(err) => {
                tracing::warn!(id, attempt, error = %err, "could not persist download outcome");
                tokio::time::sleep(Duration::from_millis(200 * u64::from(attempt))).await;
            }
        }
    }
    // Never leave the row `downloading` with no task behind it: resume and
    // retry treat that status as running and would do nothing.
    let fallback = state
        .db_call(move |c| {
            store::finish(
                c,
                id,
                DownloadStatus::Failed,
                0,
                Some("The download state could not be saved. Retry the download."),
            )
        })
        .await;
    if let Err(err) = fallback {
        tracing::error!(id, error = %err, "could not persist download outcome");
    }
}

async fn persist_once(state: &Arc<AppState>, id: i64, outcome: Outcome) -> CoreResult<()> {
    state
        .db_call(move |c| {
            match outcome {
                Outcome::Completed {
                    file_name,
                    file_path,
                    bytes,
                } => {
                    tracing::info!(id, bytes, "download completed");
                    store::complete(c, id, &file_name, &file_path, bytes)
                }
                Outcome::Stopped {
                    reason,
                    bytes,
                    part,
                } => match reason {
                    StopReason::Pause | StopReason::Detach => {
                        store::finish(c, id, DownloadStatus::Paused, bytes, None)
                    }
                    StopReason::Yield => store::requeue(c, id, bytes).map(|_| ()),
                    StopReason::Cancel => {
                        if let Some(part) = part {
                            if let Err(e) = super::naming::remove_regular_file(&part) {
                                // Keep the path so a later cancel/remove can retry the cleanup.
                                tracing::warn!(id, error = %e, "could not delete .part on cancel");
                                return store::finish(c, id, DownloadStatus::Canceled, bytes, None);
                            }
                        }
                        store::clear_destination(c, id)?;
                        store::finish(c, id, DownloadStatus::Canceled, 0, None)
                    }
                },
                Outcome::Failed {
                    message,
                    bytes,
                    keep_part,
                    part,
                } => {
                    tracing::warn!(id, bytes, keep_part, message = %message, "download failed");
                    if !keep_part {
                        if let Some(part) = part {
                            if super::naming::remove_regular_file(&part).is_ok() {
                                store::clear_destination(c, id)?;
                                return store::finish(
                                    c,
                                    id,
                                    DownloadStatus::Failed,
                                    0,
                                    Some(&message),
                                );
                            }
                        }
                    }
                    store::finish(c, id, DownloadStatus::Failed, bytes, Some(&message))
                }
                Outcome::Requeue { bytes, .. } => store::requeue(c, id, bytes).map(|_| ()),
            }
        })
        .await
}
