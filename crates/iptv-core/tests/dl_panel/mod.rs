//! A scriptable provider for download tests (`downloads_segments.rs`,
//! `downloads_conn_limit.rs`, `downloads_stress.rs`, `downloads_speed.rs`):
//! files whose every byte is known ([`content`]), `Range` and `If-Range`
//! answered the way panels answer them, a speed cap per connection, an
//! account limit counted per open body (with the lag a panel takes to notice
//! a closed one), and faults a test turns on at random (refusals, 503s,
//! bodies that stall or drop) or scripts (a response head held back, a
//! segment request refused just as the open stream reaches it).
//!
//! Built with [`Panel::with`] ([`PanelOptions`]), a panel also models what
//! separates real panels from each other:
//!
//! - **Validators** ([`Validators`]): ETag (the default), Last-Modified,
//!   both, or none at all, in which case `If-Range` is ignored.
//! - **Limit mode** ([`LimitMode`]): past `set_enforced`, refuse with 403
//!   (the default) or accept and end the oldest open body (kick-oldest).
//! - **Copies** ([`Variant`]): a file may differ from the canonical bytes
//!   everywhere, or only outside the three fingerprint windows.
//! - **Redirects** ([`Redirect`]): `/movie/` and `/series/` answer 302 to
//!   `/edge/{id}?t=<token>` on the same listener or a second one; a token
//!   past its lifetime answers 403.
//! - **A shared line** ([`Line`]): one byte budget pacing every body of every
//!   panel given the same line.
//!
//! Routes:
//!
//! - `/f/{id}`: file `id`, never redirected.
//! - `/movie/{u}/{p}/{id}.{ext}` and `/series/{u}/{p}/{id}.{ext}`: file `id`
//!   (any credentials and extension), redirected when the panel redirects.
//! - `/edge/{id}?t=<token>`: where a redirect points.
//! - `/player_api.php`: the account (any credentials; `max_connections` is
//!   [`Panel::set_reported`]), `action=get_vod_info` and
//!   `action=get_series_info&series_id=N` ([`Panel::series`]).
//!
//! [`add_xtream_source`], [`add_movie`] and [`add_series`] put a panel into
//! an `AppState` as an Xtream source with catalog rows, so the app's own
//! lookups (same-title copies, stream URLs, account limits) find it.

#![allow(dead_code)]

mod api;
mod catalog;
mod line;
mod variant;

// Each test binary uses its own share of these.
#[allow(unused_imports)]
pub use catalog::{
    add_movie, add_series, add_xtream_source, movie_ref, series_ref, PASSWORD, USERNAME,
};
pub use line::Line;
#[allow(unused_imports)]
pub use variant::{inside_samples, sample_offsets, variant_content, Variant, SAMPLE_LEN};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

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

/// The strong ETag of `variant`'s copy of `file`. The canonical copy's tag
/// is the same on every panel, as on panels behind one origin; a copy with
/// other bytes has another tag.
fn etag(file: u32, size: u64, variant: Variant) -> String {
    match variant {
        Variant::Same => format!("\"panel-{file}-{size:x}\""),
        Variant::Differs => format!("\"panel-{file}-{size:x}-d\""),
        Variant::DiffersOutsideSamples => format!("\"panel-{file}-{size:x}-o\""),
    }
}

/// The Last-Modified date of `variant`'s copy of `file` (an HTTP-date,
/// fixed per file, size and variant).
fn last_modified(file: u32, size: u64, variant: Variant) -> String {
    const BASE: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z
    let salt = match variant {
        Variant::Same => 0,
        Variant::Differs => 3_600,
        Variant::DiffersOutsideSamples => 7_200,
    };
    let secs = BASE + i64::from(file % 300) * 86_400 + (size % 86_400) as i64 + salt;
    chrono::DateTime::from_timestamp(secs, 0)
        .expect("a 2026 date")
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

#[derive(Debug, Clone, Copy)]
pub struct Spec {
    pub size: u64,
    /// KiB/s per connection; 0 = as fast as the loopback goes.
    pub kbps: u64,
}

/// Which validators a panel sends with a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Validators {
    /// A strong `ETag`; `If-Range` must match it.
    #[default]
    ETag,
    /// `Last-Modified` only; `If-Range` must match the date exactly.
    LastModified,
    /// Both; `If-Range` may match either.
    Both,
    /// Neither, and `If-Range` is ignored: every `Range` is served (the
    /// provider that kept the user's downloads on one connection).
    None,
}

impl Validators {
    fn etag(self) -> bool {
        matches!(self, Validators::ETag | Validators::Both)
    }

    fn last_modified(self) -> bool {
        matches!(self, Validators::LastModified | Validators::Both)
    }
}

/// What a panel does with a request past [`Panel::set_enforced`] open bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LimitMode {
    /// `403` (what most panels do).
    #[default]
    Refuse,
    /// Accepts it and ends the oldest open body ([`Panel::kicked`] counts
    /// them): its slot is free at once, and its client reads what was
    /// already sent, then an error. Bodies inside their close lag are not
    /// open any more, so a request that finds only those is still refused.
    KickOldest,
}

/// How a panel sends `/movie/` and `/series/` requests to where the bytes are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Redirect {
    /// `302` to `/edge/{id}?t=<token>` on the panel's own listener.
    SameHost { token_ttl: Duration },
    /// `302` to `/edge/{id}?t=<token>` on a second listener (another port:
    /// another origin), like a CDN edge.
    EdgeHost { token_ttl: Duration },
}

impl Redirect {
    fn token_ttl(self) -> Duration {
        match self {
            Redirect::SameHost { token_ttl } | Redirect::EdgeHost { token_ttl } => token_ttl,
        }
    }
}

/// How [`Panel::with`] builds a panel. `Default` is what [`Panel::spawn`]
/// builds (with seed 0).
#[derive(Debug, Clone, Default)]
pub struct PanelOptions {
    /// Drives the random faults.
    pub seed: u64,
    pub validators: Validators,
    pub limit_mode: LimitMode,
    pub redirect: Option<Redirect>,
    /// A line shared with other panels; `None`: only the per-connection caps.
    pub line: Option<Line>,
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

/// One file request (redirects and refused edge tokens included).
#[derive(Debug, Clone)]
pub struct Logged {
    pub file: u32,
    /// The `Range` header's first byte and last byte, when it had one.
    pub range: Option<(u64, Option<u64>)>,
    pub status: u16,
    /// `"f"`, `"movie"`, `"series"` or `"edge"`.
    pub route: &'static str,
    /// The address of the listener that answered.
    pub local: IpAddr,
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

/// Redirect tokens kept before expired ones are swept.
const TOKENS_KEPT: usize = 4096;

/// `(season, episode, file id)` of one episode of [`Panel::series`].
type EpisodeFile = (i64, i64, u32);

/// One open body, as the limit sees it.
struct OpenBody {
    /// Ends the body (kick-oldest, or the panel going away).
    kill: CancellationToken,
    /// Its slot no longer counts (the body ended, or was kicked).
    released: AtomicBool,
}

impl OpenBody {
    /// Gives the slot back now; false when it already was.
    fn release(&self, open: &AtomicUsize) -> bool {
        let first = !self.released.swap(true, Ordering::SeqCst);
        if first {
            open.fetch_sub(1, Ordering::SeqCst);
        }
        first
    }
}

struct Shared {
    files: Mutex<HashMap<u32, Spec>>,
    /// Files whose copy here is not the canonical one.
    variants: Mutex<HashMap<u32, Variant>>,
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
    validators: Mutex<Validators>,
    limit_mode: Mutex<LimitMode>,
    redirect: Option<Redirect>,
    line: Option<Line>,
    /// `http://127.0.0.1:<port>` of the panel itself.
    base: String,
    /// Where redirects point: `base`, or the edge listener's.
    edge_base: Option<String>,
    /// Redirect token -> (file, expiry).
    tokens: Mutex<HashMap<String, (u32, Instant)>>,
    /// Series id -> its episodes, in the order given.
    series: Mutex<BTreeMap<u32, Vec<EpisodeFile>>>,
    /// Open bodies by opening order (oldest first), for kick-oldest. Also
    /// the lock every slot is taken under.
    bodies: Mutex<BTreeMap<u64, Arc<OpenBody>>>,
    next_body: AtomicU64,
    /// Requests answered per listener address.
    served_on: Mutex<HashMap<IpAddr, u64>>,
    /// Cancelled when the panel is dropped: every listener stops and every
    /// open body ends.
    shutdown: CancellationToken,
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

    fn counted(&self, what: &str) -> u64 {
        self.counts.lock().get(what).copied().unwrap_or(0)
    }

    fn variant(&self, file: u32) -> Variant {
        self.variants.lock().get(&file).copied().unwrap_or_default()
    }

    fn outage(&self) -> bool {
        self.outage_until
            .lock()
            .is_some_and(|until| Instant::now() < until)
    }
}

/// The state of one listener's routes.
struct Listener {
    shared: Arc<Shared>,
    ip: IpAddr,
}

type Ctx = State<Arc<Listener>>;

pub struct Panel {
    pub base: String,
    shared: Arc<Shared>,
}

impl Drop for Panel {
    fn drop(&mut self) {
        self.shared.shutdown.cancel();
    }
}

impl Panel {
    /// Starts a panel on a free loopback port, on the current runtime.
    /// `seed` drives its random faults.
    pub async fn spawn(seed: u64) -> Panel {
        Panel::with(PanelOptions {
            seed,
            ..PanelOptions::default()
        })
        .await
    }

    /// Starts a panel built from `opts` on a free loopback port (and, for
    /// [`Redirect::EdgeHost`], its edge on another), on the current runtime.
    pub async fn with(opts: PanelOptions) -> Panel {
        let listener = bind(IpAddr::V4(Ipv4Addr::LOCALHOST), 0).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let edge = match opts.redirect {
            Some(Redirect::EdgeHost { .. }) => {
                Some(bind(IpAddr::V4(Ipv4Addr::LOCALHOST), 0).await.unwrap())
            }
            _ => None,
        };
        let edge_base = match (&opts.redirect, &edge) {
            (Some(_), Some(l)) => Some(format!("http://{}", l.local_addr().unwrap())),
            (Some(_), None) => Some(base.clone()),
            (None, _) => None,
        };
        let shared = Arc::new(Shared {
            files: Mutex::new(HashMap::new()),
            variants: Mutex::new(HashMap::new()),
            enforced: AtomicUsize::new(0),
            reported: AtomicUsize::new(0),
            open: Arc::new(AtomicUsize::new(0)),
            peak: AtomicUsize::new(0),
            lag_ms: AtomicU64::new(0),
            faults: Mutex::new(Faults::default()),
            rng: Mutex::new(opts.seed | 1),
            outage_until: Mutex::new(None),
            log: Mutex::new(Vec::new()),
            hold_head: Mutex::new(None),
            cut: Mutex::new(None),
            counts: Mutex::new(HashMap::new()),
            validators: Mutex::new(opts.validators),
            limit_mode: Mutex::new(opts.limit_mode),
            redirect: opts.redirect,
            line: opts.line,
            base: base.clone(),
            edge_base,
            tokens: Mutex::new(HashMap::new()),
            series: Mutex::new(BTreeMap::new()),
            bodies: Mutex::new(BTreeMap::new()),
            next_body: AtomicU64::new(0),
            served_on: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
        });
        serve(
            listener,
            panel_routes(&shared, IpAddr::V4(Ipv4Addr::LOCALHOST)),
            &shared,
        );
        if let Some(edge) = edge {
            serve(
                edge,
                edge_routes(&shared, IpAddr::V4(Ipv4Addr::LOCALHOST)),
                &shared,
            );
        }
        Panel { base, shared }
    }

    /// Also answers on `ip` at the panel's own port (for example 127.0.0.2,
    /// so a host name that resolves to two loopback addresses reaches the
    /// panel on both). Fails where the system has no such address (macOS
    /// has only 127.0.0.1 unless aliased).
    pub async fn listen_also(&self, ip: IpAddr) -> std::io::Result<SocketAddr> {
        let listener = bind(ip, self.port()).await?;
        let addr = listener.local_addr()?;
        serve(listener, panel_routes(&self.shared, ip), &self.shared);
        Ok(addr)
    }

    /// The panel's port.
    pub fn port(&self) -> u16 {
        self.base
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .expect("base ends with a port")
    }

    /// Where redirects point (`None` without [`PanelOptions::redirect`]):
    /// the panel's own base for [`Redirect::SameHost`], the edge
    /// listener's for [`Redirect::EdgeHost`].
    pub fn edge_base(&self) -> Option<String> {
        self.shared.edge_base.clone()
    }

    pub fn url(&self, file: u32) -> String {
        format!("{}/f/{file}", self.base)
    }

    /// The Xtream movie URL of file `id`, as `xtream::service::stream_url`
    /// builds it for an `mp4` row of a source added by [`add_xtream_source`].
    pub fn movie_url(&self, id: u32) -> String {
        format!("{}/movie/{USERNAME}/{PASSWORD}/{id}.mp4", self.base)
    }

    /// The Xtream episode URL of file `id` (episode ids are file ids).
    pub fn episode_url(&self, id: u32) -> String {
        format!("{}/series/{USERNAME}/{PASSWORD}/{id}.mp4", self.base)
    }

    /// Serves the canonical file `file` (also resets its variant).
    pub fn file(&self, file: u32, size: u64, kbps: u64) {
        self.file_variant(file, size, kbps, Variant::Same);
    }

    /// Serves `variant`'s copy of file `file`. Calling it again for a file
    /// already served swaps its bytes for requests from then on (bodies
    /// already open keep theirs): the provider changing a file mid-download.
    pub fn file_variant(&self, file: u32, size: u64, kbps: u64, variant: Variant) {
        self.shared.files.lock().insert(file, Spec { size, kbps });
        let mut variants = self.shared.variants.lock();
        match variant {
            Variant::Same => variants.remove(&file),
            v => variants.insert(file, v),
        };
    }

    pub fn set_speed(&self, file: u32, kbps: u64) {
        if let Some(s) = self.shared.files.lock().get_mut(&file) {
            s.kbps = kbps;
        }
    }

    /// Validators sent from the next request on.
    pub fn set_validators(&self, v: Validators) {
        *self.shared.validators.lock() = v;
    }

    /// What happens past the limit, from the next request on.
    pub fn set_limit_mode(&self, m: LimitMode) {
        *self.shared.limit_mode.lock() = m;
    }

    /// The series `get_series_info&series_id=series_id` describes:
    /// `(season, episode, file id)` per episode. Episode ids are the file
    /// ids, so [`Panel::episode_url`] serves each. Replaces an earlier call.
    pub fn series(&self, series_id: u32, episodes: &[(i64, i64, u32)]) {
        self.shared
            .series
            .lock()
            .insert(series_id, episodes.to_vec());
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

    /// Bodies ended by kick-oldest.
    pub fn kicked(&self) -> u64 {
        self.shared.counted("kicked")
    }

    /// `302`s sent.
    pub fn redirects(&self) -> u64 {
        self.shared.counted("redirected")
    }

    /// Edge requests refused because their token had expired.
    pub fn expired(&self) -> u64 {
        self.shared.counted("expired")
    }

    /// Requests (files and `player_api.php`) answered on the listener at `ip`.
    pub fn requests_on(&self, ip: IpAddr) -> u64 {
        self.shared.served_on.lock().get(&ip).copied().unwrap_or(0)
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

async fn bind(ip: IpAddr, port: u16) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind((ip, port)).await
}

fn serve(listener: tokio::net::TcpListener, app: Router, shared: &Shared) {
    let stop = shared.shutdown.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await;
    });
}

fn panel_routes(shared: &Arc<Shared>, ip: IpAddr) -> Router {
    let mut app = Router::new()
        .route("/f/{file}", get(plain_file))
        .route("/movie/{u}/{p}/{name}", get(movie))
        .route("/series/{u}/{p}/{name}", get(episode))
        .route("/player_api.php", get(api::player_api));
    if matches!(shared.redirect, Some(Redirect::SameHost { .. })) {
        app = app.route("/edge/{file}", get(edge));
    }
    app.with_state(Arc::new(Listener {
        shared: Arc::clone(shared),
        ip,
    }))
}

fn edge_routes(shared: &Arc<Shared>, ip: IpAddr) -> Router {
    Router::new()
        .route("/edge/{file}", get(edge))
        .with_state(Arc::new(Listener {
            shared: Arc::clone(shared),
            ip,
        }))
}

impl Listener {
    fn note_request(&self) {
        *self.shared.served_on.lock().entry(self.ip).or_default() += 1;
    }

    fn log(&self, file: u32, range: Option<(u64, Option<u64>)>, status: u16, route: &'static str) {
        self.shared.log.lock().push(Logged {
            file,
            range,
            status,
            route,
            local: self.ip,
        });
    }
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

/// The file id of an Xtream stream name (`123.mp4`, `123`).
fn file_id(name: &str) -> Option<u32> {
    name.rsplit_once('.')
        .map_or(name, |(id, _)| id)
        .parse()
        .ok()
}

async fn plain_file(State(l): Ctx, Path(id): Path<u32>, headers: HeaderMap) -> Response {
    serve_file(&l, id, &headers, "f").await
}

async fn movie(
    State(l): Ctx,
    Path((_, _, name)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    vod(&l, &name, &headers, "movie").await
}

async fn episode(
    State(l): Ctx,
    Path((_, _, name)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    vod(&l, &name, &headers, "series").await
}

/// A `/movie/` or `/series/` request: the file, or a redirect to it.
async fn vod(l: &Arc<Listener>, name: &str, headers: &HeaderMap, route: &'static str) -> Response {
    let Some(id) = file_id(name) else {
        l.note_request();
        return (StatusCode::NOT_FOUND, "no such stream").into_response();
    };
    let s = &l.shared;
    let Some(redirect) = s.redirect else {
        return serve_file(l, id, headers, route).await;
    };
    l.note_request();
    let range = parse_range(headers);
    let resp = if !s.files.lock().contains_key(&id) {
        (StatusCode::NOT_FOUND, "no such file").into_response()
    } else if s.outage() {
        status(StatusCode::SERVICE_UNAVAILABLE, s, "unavailable")
    } else {
        let token = format!("{:016x}", s.next());
        let now = Instant::now();
        {
            let mut tokens = s.tokens.lock();
            if tokens.len() >= TOKENS_KEPT {
                tokens.retain(|_, (_, until)| *until > now);
            }
            tokens.insert(token.clone(), (id, now + redirect.token_ttl()));
        }
        s.count("redirected");
        let edge = s.edge_base.as_deref().unwrap_or(&s.base);
        let mut r = StatusCode::FOUND.into_response();
        r.headers_mut().insert(
            header::LOCATION,
            HeaderValue::from_str(&format!("{edge}/edge/{id}?t={token}")).unwrap(),
        );
        r
    };
    l.log(id, range, resp.status().as_u16(), route);
    resp
}

/// `/edge/{id}?t=<token>`: the file, while the token lives.
async fn edge(
    State(l): Ctx,
    Path(id): Path<u32>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let s = &l.shared;
    let token = q.get("t").and_then(|t| s.tokens.lock().get(t).copied());
    let refused = match token {
        Some((file, _)) if file != id => Some("badToken"),
        Some((_, until)) if Instant::now() >= until => Some("expired"),
        Some(_) => None,
        None => Some("badToken"),
    };
    if let Some(why) = refused {
        l.note_request();
        let resp = status(StatusCode::FORBIDDEN, s, why);
        l.log(id, parse_range(&headers), resp.status().as_u16(), "edge");
        return resp;
    }
    serve_file(&l, id, &headers, "edge").await
}

async fn serve_file(
    l: &Arc<Listener>,
    id: u32,
    headers: &HeaderMap,
    route: &'static str,
) -> Response {
    l.note_request();
    let s = &l.shared;
    let Some(spec) = s.files.lock().get(&id).copied() else {
        return (StatusCode::NOT_FOUND, "no such file").into_response();
    };
    let range = parse_range(headers);
    let resp = answer(s, id, spec, headers, range).await;
    l.log(id, range, resp.status().as_u16(), route);
    resp
}

async fn answer(
    s: &Arc<Shared>,
    id: u32,
    spec: Spec,
    headers: &HeaderMap,
    range: Option<(u64, Option<u64>)>,
) -> Response {
    let gate = s.hold_head.lock().take();
    if let Some(gate) = gate {
        gate.held.notify_one();
        gate.release.notified().await;
    }
    let variant = s.variant(id);
    let validators = *s.validators.lock();
    let tag = etag(id, spec.size, variant);
    let modified = last_modified(id, spec.size, variant);
    let same = validators == Validators::None
        || headers.get(header::IF_RANGE).is_none_or(|v| {
            v.to_str().is_ok_and(|v| {
                let v = v.trim();
                (validators.etag() && v == tag) || (validators.last_modified() && v == modified)
            })
        });
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

    if s.outage() {
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
        variant,
        total: spec.size,
        pos: start,
        end: last + 1,
        kbps: spec.kbps,
        stall_at,
        drop_at,
        cut: cut.filter(|_| start == 0),
        line: s.line.clone(),
        kill: slot.body.kill.clone(),
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
    if validators.etag() {
        h.insert(header::ETAG, HeaderValue::from_str(&tag).unwrap());
    }
    if validators.last_modified() {
        h.insert(
            header::LAST_MODIFIED,
            HeaderValue::from_str(&modified).unwrap(),
        );
    }
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

/// One open body: counts against the limit until dropped (plus the lag) or
/// kicked.
struct Slot {
    shared: Arc<Shared>,
    id: u64,
    body: Arc<OpenBody>,
    lag: Duration,
}

impl Slot {
    /// A slot under the limit, kicking the oldest open body first when the
    /// panel kicks. Slots are only ever taken under the `bodies` lock, so
    /// the count never overshoots the limit; they are given back without it.
    fn take(s: &Arc<Shared>) -> Option<Slot> {
        let mut bodies = s.bodies.lock();
        let max = s.enforced.load(Ordering::SeqCst);
        if max != 0
            && s.open.load(Ordering::SeqCst) >= max
            && *s.limit_mode.lock() == LimitMode::KickOldest
        {
            if let Some((_, oldest)) = bodies.pop_first() {
                oldest.release(&s.open);
                oldest.kill.cancel();
                s.count("kicked");
            }
        }
        if max != 0 && s.open.load(Ordering::SeqCst) >= max {
            return None;
        }
        let before = s.open.fetch_add(1, Ordering::SeqCst);
        s.peak.fetch_max(before + 1, Ordering::SeqCst);
        let id = s.next_body.fetch_add(1, Ordering::SeqCst);
        let body = Arc::new(OpenBody {
            kill: s.shutdown.child_token(),
            released: AtomicBool::new(false),
        });
        bodies.insert(id, Arc::clone(&body));
        Some(Slot {
            shared: Arc::clone(s),
            id,
            body,
            lag: Duration::from_millis(s.lag_ms.load(Ordering::SeqCst)),
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.shared.bodies.lock().remove(&self.id);
        if self.body.released.load(Ordering::SeqCst) {
            // Kicked: the panel let go of it already.
            return;
        }
        if self.lag.is_zero() {
            self.body.release(&self.shared.open);
            return;
        }
        let lag = self.lag;
        let body = Arc::clone(&self.body);
        let open = Arc::clone(&self.shared.open);
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn(async move {
                    tokio::time::sleep(lag).await;
                    body.release(&open);
                });
            }
            Err(_) => {
                body.release(&open);
            }
        }
    }
}

struct Body {
    file: u32,
    variant: Variant,
    total: u64,
    pos: u64,
    end: u64,
    kbps: u64,
    stall_at: Option<u64>,
    drop_at: Option<u64>,
    cut: Option<Arc<Cut>>,
    line: Option<Line>,
    /// Kick-oldest or the panel going away.
    kill: CancellationToken,
    began: Instant,
    sent: u64,
    _slot: Slot,
}

impl Body {
    async fn next(&mut self) -> Option<std::io::Result<Bytes>> {
        if self.pos >= self.end {
            return None;
        }
        let kill = self.kill.clone();
        let step = tokio::select! {
            biased;
            () = kill.cancelled() => None,
            step = self.step() => Some(step),
        };
        match step {
            Some(step) => step,
            None => {
                // The panel closed the connection under it.
                self.pos = self.end;
                Some(Err(std::io::Error::other("panel: connection closed")))
            }
        }
    }

    async fn step(&mut self) -> Option<std::io::Result<Bytes>> {
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
        if let Some(line) = &self.line {
            line.pass(n).await;
        }
        let bytes = variant_content(self.file, self.variant, self.total, self.pos, n as usize);
        self.pos += n;
        self.sent += n;
        Some(Ok(Bytes::from(bytes)))
    }
}
