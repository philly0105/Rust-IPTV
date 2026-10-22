//! A scriptable provider for download tests (`downloads_segments.rs`,
//! `downloads_conn_limit.rs`, `downloads_stress.rs`): files whose every byte
//! is known ([`content`]), `Range` and `If-Range` answered the way panels
//! answer them, a speed cap per connection, an account limit counted per open
//! body (with the lag a panel takes to notice a closed one), and faults a test
//! turns on at random (refusals, 503s, bodies that stall or drop) or scripts
//! (a response head held back, a segment request refused just as the open
//! stream reaches it).
//!
//! Files are served at `/f/<id>`, the account at `/player_api.php` (any
//! credentials; `max_connections` is [`Panel::set_reported`]).

#![allow(dead_code)]

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// `len` bytes of file `file` from `offset`. Files differ from each other,
/// so a `.part` that took another row's bytes is caught too.
pub fn content(file: u32, offset: u64, len: usize) -> Vec<u8> {
    iptv_fixtures::video_bytes((u64::from(file) << 36) + offset, len)
}

/// The first offset where `data` (bytes from `offset` of `file`) differs
/// from what the file holds there.
pub fn first_wrong(file: u32, offset: u64, data: &[u8]) -> Option<u64> {
    const STEP: usize = 1 << 20;
    for (i, piece) in data.chunks(STEP).enumerate() {
        let at = offset + (i * STEP) as u64;
        let want = content(file, at, piece.len());
        if let Some(j) = piece.iter().zip(&want).position(|(a, b)| a != b) {
            return Some(at + j as u64);
        }
    }
    None
}

/// Whether the file at `path` is exactly file `file` of `size` bytes.
pub fn is_exact(file: u32, size: u64, path: &std::path::Path) -> Result<(), String> {
    let got = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if got.len() as u64 != size {
        return Err(format!("{} bytes instead of {size}", got.len()));
    }
    match first_wrong(file, 0, &got) {
        Some(at) => Err(format!("wrong byte at {at} of {size}")),
        None => Ok(()),
    }
}

fn etag(file: u32, size: u64) -> String {
    format!("\"panel-{file}-{size:x}\"")
}

#[derive(Debug, Clone, Copy)]
pub struct Spec {
    pub size: u64,
    /// KiB/s per connection; 0 = as fast as the loopback goes.
    pub kbps: u64,
}

/// Random faults, in per mille of file requests (or of bodies).
#[derive(Debug, Clone, Copy, Default)]
pub struct Faults {
    /// `403` whatever the limit (a panel that miscounts).
    pub refuse: u32,
    /// `503`.
    pub unavailable: u32,
    /// The body stops after a random length and holds the connection open.
    pub stall: u32,
    /// The body ends with an error after a random length.
    pub drop: u32,
}

/// One file request.
#[derive(Debug, Clone)]
pub struct Logged {
    pub file: u32,
    /// The `Range` header's first byte and last byte, when it had one.
    pub range: Option<(u64, Option<u64>)>,
    pub status: u16,
}

#[derive(Default)]
struct Gate {
    held: Notify,
    release: Notify,
}

/// The cut script: the first segment request of `file` that starts past 0
/// waits until the open stream has sent up to a little before its start,
/// is refused there, and the open stream goes on (one chunk across the
/// segment's start) only once the refusal has had time to land.
struct Cut {
    file: u32,
    pause_at: Mutex<Option<u64>>,
    at_pause: Notify,
    release: Notify,
    fired: std::sync::atomic::AtomicBool,
    /// The open stream stopped at the pause point (it had not passed it).
    paused: std::sync::atomic::AtomicBool,
}

/// How far before the refused segment's start the open stream pauses: not a
/// multiple of any read size, so the next chunk the client reads crosses it.
const CUT_LEAD: u64 = 1000;

struct Shared {
    files: Mutex<HashMap<u32, Spec>>,
    /// Bodies open at once before a request is refused (0: no limit).
    enforced: AtomicUsize,
    reported: AtomicUsize,
    open: Arc<AtomicUsize>,
    peak: AtomicUsize,
    lag_ms: AtomicU64,
    faults: Mutex<Faults>,
    rng: Mutex<u64>,
    outage_until: Mutex<Option<Instant>>,
    log: Mutex<Vec<Logged>>,
    hold_head: Mutex<Option<Arc<Gate>>>,
    cut: Mutex<Option<Arc<Cut>>>,
    counts: Mutex<HashMap<&'static str, u64>>,
}

impl Shared {
    fn roll(&self, per_mille: u32) -> bool {
        per_mille > 0 && self.next() % 1000 < u64::from(per_mille)
    }

    fn next(&self) -> u64 {
        let mut x = self.rng.lock();
        *x ^= *x << 13;
        *x ^= *x >> 7;
        *x ^= *x << 17;
        *x
    }

    fn count(&self, what: &'static str) {
        *self.counts.lock().entry(what).or_default() += 1;
    }
}

pub struct Panel {
    pub base: String,
    shared: Arc<Shared>,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Panel {
    /// Starts a panel on a free loopback port, on the current runtime.
    /// `seed` drives its random faults.
    pub async fn spawn(seed: u64) -> Panel {
        let shared = Arc::new(Shared {
            files: Mutex::new(HashMap::new()),
            enforced: AtomicUsize::new(0),
            reported: AtomicUsize::new(0),
            open: Arc::new(AtomicUsize::new(0)),
            peak: AtomicUsize::new(0),
            lag_ms: AtomicU64::new(0),
            faults: Mutex::new(Faults::default()),
            rng: Mutex::new(seed | 1),
            outage_until: Mutex::new(None),
            log: Mutex::new(Vec::new()),
            hold_head: Mutex::new(None),
            cut: Mutex::new(None),
            counts: Mutex::new(HashMap::new()),
        });
        let app = Router::new()
            .route("/f/{file}", get(file))
            .route("/player_api.php", get(account))
            .with_state(Arc::clone(&shared));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        Panel {
            base,
            shared,
            _shutdown: tx,
        }
    }

    pub fn url(&self, file: u32) -> String {
        format!("{}/f/{file}", self.base)
    }

    pub fn file(&self, file: u32, size: u64, kbps: u64) {
        self.shared.files.lock().insert(file, Spec { size, kbps });
    }

    pub fn set_speed(&self, file: u32, kbps: u64) {
        if let Some(s) = self.shared.files.lock().get_mut(&file) {
            s.kbps = kbps;
        }
    }

    /// Bodies the panel lets this app open at once (0: no limit).
    pub fn set_enforced(&self, n: usize) {
        self.shared.enforced.store(n, Ordering::SeqCst);
    }

    /// What the account check says the account allows.
    pub fn set_reported(&self, n: usize) {
        self.shared.reported.store(n, Ordering::SeqCst);
    }

    /// How long a closed body still counts against the limit.
    pub fn set_lag(&self, lag: Duration) {
        self.shared
            .lag_ms
            .store(lag.as_millis() as u64, Ordering::SeqCst);
    }

    pub fn set_faults(&self, faults: Faults) {
        *self.shared.faults.lock() = faults;
    }

    /// Every file request answers `503` for `d`.
    pub fn outage(&self, d: Duration) {
        *self.shared.outage_until.lock() = Some(Instant::now() + d);
    }

    pub fn open(&self) -> usize {
        self.shared.open.load(Ordering::SeqCst)
    }

    pub fn peak(&self) -> usize {
        self.shared.peak.load(Ordering::SeqCst)
    }

    pub fn log(&self) -> Vec<Logged> {
        self.shared.log.lock().clone()
    }

    pub fn counts(&self) -> HashMap<&'static str, u64> {
        self.shared.counts.lock().clone()
    }

    /// Holds the head of the next file request until the returned gate is
    /// released; `held` resolves once a request waits there.
    pub fn hold_next_head(&self) -> HeldHead {
        let gate = Arc::new(Gate::default());
        *self.shared.hold_head.lock() = Some(Arc::clone(&gate));
        HeldHead(gate)
    }

    /// Arms the cut script for `file` (see [`Cut`]).
    pub fn cut_next_segment(&self, file: u32) {
        *self.shared.cut.lock() = Some(Arc::new(Cut {
            file,
            pause_at: Mutex::new(None),
            at_pause: Notify::new(),
            release: Notify::new(),
            fired: Default::default(),
            paused: Default::default(),
        }));
    }

    /// Whether the cut script refused a segment while the open stream
    /// waited just before it.
    pub fn cut_fired(&self) -> bool {
        self.shared
            .cut
            .lock()
            .as_ref()
            .is_some_and(|c| c.fired.load(Ordering::SeqCst) && c.paused.load(Ordering::SeqCst))
    }
}

pub struct HeldHead(Arc<Gate>);

impl HeldHead {
    pub async fn held(&self) {
        self.0.held.notified().await;
    }

    pub fn release(&self) {
        self.0.release.notify_one();
    }
}

async fn account(State(s): State<Arc<Shared>>) -> Response {
    let max = s.reported.load(Ordering::SeqCst);
    let body = serde_json::json!({
        "user_info": {
            "username": "panel",
            "auth": 1,
            "status": "Active",
            "max_connections": max.to_string(),
            "active_cons": "0",
        },
        "server_info": {"url": "127.0.0.1", "timezone": "UTC"},
    });
    axum::Json(body).into_response()
}

/// `bytes=a-b` / `bytes=a-`.
fn parse_range(h: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let v = h.get(header::RANGE)?.to_str().ok()?;
    let (a, b) = v.trim().strip_prefix("bytes=")?.split_once('-')?;
    let a = a.trim().parse().ok()?;
    let b = match b.trim() {
        "" => None,
        b => Some(b.parse().ok()?),
    };
    Some((a, b))
}

fn status(code: StatusCode, s: &Shared, what: &'static str) -> Response {
    s.count(what);
    (code, what).into_response()
}

async fn file(State(s): State<Arc<Shared>>, Path(id): Path<u32>, headers: HeaderMap) -> Response {
    let Some(spec) = s.files.lock().get(&id).copied() else {
        return (StatusCode::NOT_FOUND, "no such file").into_response();
    };
    let tag = etag(id, spec.size);
    let range = parse_range(&headers);
    let resp = answer(&s, id, spec, &tag, &headers, range).await;
    s.log.lock().push(Logged {
        file: id,
        range,
        status: resp.status().as_u16(),
    });
    resp
}

async fn answer(
    s: &Arc<Shared>,
    id: u32,
    spec: Spec,
    tag: &str,
    headers: &HeaderMap,
    range: Option<(u64, Option<u64>)>,
) -> Response {
    let gate = s.hold_head.lock().take();
    if let Some(gate) = gate {
        gate.held.notify_one();
        gate.release.notified().await;
    }
    let same = headers
        .get(header::IF_RANGE)
        .is_none_or(|v| v.to_str().is_ok_and(|v| v.trim() == tag));
    let (start, last) = match range {
        Some((a, _)) if same && a >= spec.size => {
            let mut r = status(StatusCode::RANGE_NOT_SATISFIABLE, s, "unsatisfiable");
            r.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{}", spec.size)).unwrap(),
            );
            return r;
        }
        Some((a, b)) if same => (a, b.unwrap_or(spec.size - 1).min(spec.size - 1)),
        _ => (0, spec.size - 1),
    };
    let partial = range.is_some() && same;

    // The cut script: a segment request past 0 waits for the open stream.
    let cut = s
        .cut
        .lock()
        .clone()
        .filter(|c| c.file == id && !c.fired.load(Ordering::SeqCst));
    if let Some(cut) = &cut {
        if start > CUT_LEAD {
            *cut.pause_at.lock() = Some(start - CUT_LEAD);
            let _ = tokio::time::timeout(Duration::from_secs(30), cut.at_pause.notified()).await;
            // The client reads what was sent and waits for more: the refusal
            // lands while the open stream's reader sits on the old end.
            tokio::time::sleep(Duration::from_millis(200)).await;
            cut.fired.store(true, Ordering::SeqCst);
            let cut = Arc::clone(cut);
            tokio::spawn(async move {
                // Long enough for the refusal to reach the client and be
                // handled before the open stream's next chunk does.
                tokio::time::sleep(Duration::from_millis(300)).await;
                cut.release.notify_one();
            });
            return status(StatusCode::FORBIDDEN, s, "refused");
        }
    }

    if s.outage_until
        .lock()
        .is_some_and(|until| Instant::now() < until)
    {
        return status(StatusCode::SERVICE_UNAVAILABLE, s, "unavailable");
    }
    let faults = *s.faults.lock();
    if s.roll(faults.refuse) {
        return status(StatusCode::FORBIDDEN, s, "refused");
    }
    if s.roll(faults.unavailable) {
        return status(StatusCode::SERVICE_UNAVAILABLE, s, "unavailable");
    }
    let Some(slot) = Slot::take(s) else {
        return status(StatusCode::FORBIDDEN, s, "refused");
    };
    let len = last + 1 - start;
    let cut_at = |frac: u64| start + 1 + frac % len.max(1);
    let stall_at = s.roll(faults.stall).then(|| cut_at(s.next()));
    let drop_at = s.roll(faults.drop).then(|| cut_at(s.next()));
    if stall_at.is_some() {
        s.count("stalled");
    }
    if drop_at.is_some() {
        s.count("dropped");
    }
    let body = Body {
        file: id,
        pos: start,
        end: last + 1,
        kbps: spec.kbps,
        stall_at,
        drop_at,
        cut: cut.filter(|_| start == 0),
        began: Instant::now(),
        sent: 0,
        _slot: slot,
    };
    let stream = futures::stream::unfold(body, |mut b| async move {
        let chunk = b.next().await?;
        Some((chunk, b))
    });
    let mut r = Response::new(axum::body::Body::from_stream(stream));
    *r.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let h = r.headers_mut();
    h.insert(header::ETAG, HeaderValue::from_str(tag).unwrap());
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if partial {
        h.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{last}/{}", spec.size)).unwrap(),
        );
    }
    r
}

/// One open body: counts against the limit until dropped (plus the lag).
struct Slot {
    open: Arc<AtomicUsize>,
    lag: Duration,
}

impl Slot {
    fn take(s: &Shared) -> Option<Slot> {
        let max = s.enforced.load(Ordering::SeqCst);
        let taken = s
            .open
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (max == 0 || n < max).then_some(n + 1)
            })
            .ok()?;
        s.peak.fetch_max(taken + 1, Ordering::SeqCst);
        Some(Slot {
            open: Arc::clone(&s.open),
            lag: Duration::from_millis(s.lag_ms.load(Ordering::SeqCst)),
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let open = Arc::clone(&self.open);
        if self.lag.is_zero() {
            open.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let lag = self.lag;
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn(async move {
                    tokio::time::sleep(lag).await;
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(_) => {
                open.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

struct Body {
    file: u32,
    pos: u64,
    end: u64,
    kbps: u64,
    stall_at: Option<u64>,
    drop_at: Option<u64>,
    cut: Option<Arc<Cut>>,
    began: Instant,
    sent: u64,
    _slot: Slot,
}

impl Body {
    async fn next(&mut self) -> Option<std::io::Result<Bytes>> {
        if self.pos >= self.end {
            return None;
        }
        let rate = self.kbps * 1024;
        let mut n = if rate == 0 {
            64 * 1024
        } else {
            (rate / 50).clamp(16 * 1024, 64 * 1024)
        };
        n = n.min(self.end - self.pos);
        if let Some(at) = self.stall_at {
            if self.pos >= at {
                // Holds the connection with no more bytes until the client
                // gives up on it.
                tokio::time::sleep(Duration::from_secs(600)).await;
                return None;
            }
            n = n.min(at - self.pos);
        }
        if let Some(at) = self.drop_at {
            if self.pos >= at {
                return Some(Err(std::io::Error::other("panel: dropped")));
            }
            n = n.min(at - self.pos);
        }
        if let Some(cut) = self.cut.clone() {
            let pause = *cut.pause_at.lock();
            if let Some(p) = pause.filter(|p| *p >= self.pos) {
                if self.pos == p {
                    cut.paused.store(true, Ordering::SeqCst);
                    cut.at_pause.notify_one();
                    cut.release.notified().await;
                    // One chunk well across the refused segment's start.
                    n = (2 * CUT_LEAD + 64 * 1024).min(self.end - self.pos);
                    self.cut = None;
                } else {
                    n = n.min(p - self.pos);
                }
            }
        }
        if rate > 0 {
            let due = self.began + Duration::from_secs_f64((self.sent + n) as f64 / rate as f64);
            tokio::time::sleep_until(due.into()).await;
        }
        let bytes = content(self.file, self.pos, n as usize);
        self.pos += n;
        self.sent += n;
        Some(Ok(Bytes::from(bytes)))
    }
}
