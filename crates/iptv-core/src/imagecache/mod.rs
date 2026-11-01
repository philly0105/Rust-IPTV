//! `imagecache` module (Run 3 contract C2): posters, logos and backdrops kept
//! on disk under `data_dir/image-cache/<first 2 hex>/<sha256(url) hex>`, with
//! an index table (migration `0017_image_cache.sql`), a size cap from
//! `settings.imageCacheMaxMb` and least-recently-used eviction. The server's
//! `/api/img` route and the desktop loopback proxy's `/<token>/api/img` serve
//! it through `iptv-server`'s `img::handler`.
//!
//! Request flow ([`fetch`], wrapped by [`get`]):
//! 1. The URL is normalised (absolute http(s), no user info, no fragment) and
//!    hashed into the cache key.
//! 2. In server mode the SSRF guard checks it first, trusting only the
//!    requesting source's own `host:port`. This check needs no DNS: it
//!    refuses private and loopback IP literals and `localhost` names, and
//!    those stay refused even when the cache holds the image. A host name
//!    that resolves to a private address is refused by the guarded client's
//!    resolver only when it is fetched, so a copy cached through a trusted
//!    source is also served to a request that names no source. That reveals
//!    nothing new: any caller may name any `sourceId`.
//! 3. A row whose file is on disk with the recorded size is a hit (read-only;
//!    `last_access` is written at most once a minute per key).
//! 4. Otherwise one fetch per URL and scope ([`flight_scope`]: the trusted
//!    authority under the guard, and the source's request headers) runs as a
//!    detached task (single flight); concurrent callers share its outcome.
//!    Before it asks the host it takes an upstream slot: at most
//!    [`UPSTREAM_PER_HOST`] fetches go to one `host:port` at once and
//!    [`UPSTREAM_MAX`] in all, so a parallel wall neither floods a provider's
//!    host nor downloads more than a few bodies at once. The host's slot
//!    goes back once the body is in, so resizing and writing it never hold
//!    the host up; the slot of all goes back once the body is written, so
//!    no more than [`UPSTREAM_MAX`] fetched bodies wait in memory at once.
//!    The body is checked (image type, at most [`MAX_IMAGE_BYTES`]), written
//!    to a temp name and renamed into place, and the callers are answered.
//!    The index row is written in the background: a catalog import holds
//!    the write lock for its whole save, and a poster must not wait for it.
//!    Until the row commits, lookups serve the file from its pending entry
//!    and the writer keeps it from eviction and clear. Failures are
//!    remembered per URL and scope for [`FAILURE_TTL`], so a broken poster
//!    wall does not refetch on every scroll. A host that stops answering
//!    altogether is skipped for a while, per scope too ([`breaker`]).
//!
//! Width hints (`fetch_sized`, `/api/img?...&w=<px>`): a request with a
//! hint gets a copy no wider than the hint's bucket ([`resize::bucket`]),
//! stored under its own key ([`variant_key`]) with its own row, so the cap
//! counts what the grids actually show. A variant is made from the cached
//! original when there is one (full-size files cached before hints existed
//! are reused this way, then age out by LRU since the UI stops asking for
//! them), else from the smallest cached variant wider than it (a logo shown
//! in the list and in the guide, a poster in a rail and in a grid), else from
//! one upstream fetch whose original is not kept. An image
//! the resizer leaves alone (SVG, GIF, WebP, animated PNG, already narrow
//! enough, see [`resize`]) is stored and served as the original, and the
//! decision is remembered in memory so later hints skip the decode. The
//! upstream fetch for a variant asks for JPEG and PNG by name and leaves
//! WebP and AVIF out of its `Accept`, so a host that picks the format from
//! the request sends one the resizer can shrink.
//!
//! Warming ([`warm`], `images.warm`): the browser opens about six connections
//! to the image route, and a request that misses holds one for its whole
//! upstream fetch, so a cold wall used to be fetched six (server mode: four)
//! at a time. The UI names the pictures it has queued, and each one that is
//! not cached is checked like a request (the guard included) and queued
//! here; queued warms start while fewer than [`WARM_PER_HOST`] of the host's
//! slots and [`WARM_MAX`] of all are taken, the newest batch first. A
//! picture's own request then joins the running fetch or finds the file.
//! Requests may take the slots above the warms' share, so several users of
//! one server are not held to one browser's pace, and a request that waits
//! for a slot always gets the next free one before any warm: the pictures a
//! user scrolled to never wait behind the warms of a screen they left.
//!
//! Every index write goes through one writer task ([`store`]) that batches
//! them into a single transaction, so fifty posters loading during a catalog
//! import hold one pooled connection waiting on the write lock, not fifty.
//! The writer owns the running byte total and evicts down to 90 % of the cap
//! after an insert takes it over. It re-reads the table's total on every
//! `images.stats` and at least once a minute while inserting, so several
//! processes sharing one data dir stay under the cap together.

pub mod rpc;

mod breaker;
mod fetch;
pub mod resize;
mod store;

use crate::db::{self, DbPool};
use crate::error::{CoreError, CoreResult, RpcError};
use crate::http::{self, Authority, TargetError};
use crate::logging::redact_url;
use crate::model::{RequestHeaders, Settings};
use crate::state::AppState;
use breaker::{Admit, Breakers};
use futures::future::{BoxFuture, FutureExt, Shared};
use futures::StreamExt;
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::{Lookup, Op};
use tokio::sync::{mpsc, oneshot, OnceCell, OwnedSemaphorePermit, Semaphore};
use url::Url;

/// Folder under the data dir that holds the cached files.
pub const DIR_NAME: &str = "image-cache";
/// Largest image body accepted (10 MB); a bigger one is refused as Invalid.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// How long a failed fetch is remembered per URL (and [`flight_scope`]).
pub const FAILURE_TTL: Duration = Duration::from_secs(10 * 60);
/// Minimum seconds between two `last_access` writes of one key.
pub const TOUCH_INTERVAL_SECS: i64 = 60;
/// Eviction stops once the total is at most this share of the cap.
pub const EVICT_TARGET_PERCENT: u64 = 90;
/// Longest image URL accepted.
pub const MAX_URL_LEN: usize = 8 * 1024;
/// Deadline for one upstream fetch, response head and body together.
pub const FETCH_DEADLINE: Duration = Duration::from_secs(60);
/// Deadline for an upstream image's response head, connecting included.
/// Shorter than [`http::HEADER_TIMEOUT`]: a poster host that accepts the
/// connection and never answers held the picture, and the request waiting on
/// it, for 15 s. It also ends a host that does not take the connection: the
/// client's own [`http::CONNECT_TIMEOUT`] is longer. A shorter connect
/// timeout would cut the DNS lookup too (reqwest counts it as connecting), so
/// a resolver that takes 5 s would fail every image.
pub const HEAD_TIMEOUT: Duration = Duration::from_secs(8);
/// [`set_head_timeout_for_tests`]'s value in ms; 0 means [`HEAD_TIMEOUT`].
static HEAD_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
/// Remembered failures kept at most (expired ones are pruned first).
const MAX_FAILURES: usize = 4096;
/// Variant keys remembered as "serve the original" at most.
const MAX_KEPT: usize = 65_536;
/// Upstream fetches at once to one `host:port`, for every caller together.
/// Requests come at most six at a time from each browser, so this is only
/// reached by several users of one server, and stays low enough for a
/// provider's panel that also serves the streams and may count connections.
pub const UPSTREAM_PER_HOST: usize = 16;
/// Of a host's [`UPSTREAM_PER_HOST`] slots, warms start only while fewer
/// than this many are taken: a little above the browser's six connections,
/// so a warmed wall fills faster than the browser alone would fetch it.
pub const WARM_PER_HOST: usize = 8;
/// Upstream fetches at once in all. Each holds its whole body in memory (up
/// to [`MAX_IMAGE_BYTES`]) while it downloads.
pub const UPSTREAM_MAX: usize = 32;
/// Of the [`UPSTREAM_MAX`] slots, warms start only while fewer than this
/// many are taken.
pub const WARM_MAX: usize = 16;
/// Pictures one [`warm`] takes at most, and warms queued at most: about
/// one settled screen of posters or logos with the rows just past its edge.
pub const WARM_MAX_ITEMS: usize = 48;
/// Pictures of one [`warm`] checked at once (each check reads the index on
/// the blocking pool, which shares the database pool with the UI's RPCs).
const WARM_CHECKS: usize = 4;
/// Hosts with an upstream slot count kept at most; a full map keeps only
/// the hosts with a fetch running or waiting.
const MAX_SLOT_HOSTS: usize = 1024;
/// Extension key of the runtime singleton.
const EXT_KEY: &str = "imagecache";

/// One image served from the cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedImage {
    /// The cached file (bytes exactly as received).
    pub path: PathBuf,
    /// Stored `Content-Type` (`image/*` only).
    pub content_type: String,
    /// File size in bytes.
    pub bytes: u64,
    /// True when the bytes came from disk without an upstream fetch.
    pub hit: bool,
}

/// `images.stats` / `images.clear` result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCacheStats {
    /// Bytes on disk.
    pub bytes: u64,
    /// Cached files.
    pub files: u64,
    /// The cap: `settings.imageCacheMaxMb` in bytes.
    pub max_bytes: u64,
}

/// The cache cap in bytes for `settings` (`imageCacheMaxMb` MiB).
pub fn max_bytes(settings: &Settings) -> u64 {
    u64::from(settings.image_cache_max_mb) * 1024 * 1024
}

/// What went wrong with one image; the HTTP routes answer with
/// [`ImageError::http_status`], and [`get`] maps it onto [`CoreError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageErrorKind {
    /// Not an absolute http(s) URL (400).
    BadUrl,
    /// Refused by the server-mode SSRF guard (403).
    Forbidden,
    /// The upstream answered 404 or 410 (404).
    NotFound,
    /// The upstream sent something other than an image (415).
    NotImage,
    /// The body is larger than [`MAX_IMAGE_BYTES`] (502).
    TooLarge,
    /// Any other upstream failure: status, connection, a stalled body (502).
    Upstream,
    /// The host did not take the connection or send a response head in time
    /// (502). Counts toward its host's breaker (`breaker.rs`).
    NoAnswer,
    /// Not fetched: the host's breaker is open after it stopped
    /// answering (502). It says nothing about this image, so it is not
    /// remembered.
    HostDown,
    /// The caller stopped waiting for the upstream fetch
    /// ([`fetch_sized_within`]); the fetch goes on and stores the image
    /// (504). It is the caller's limit, not the image's failure, so it is
    /// never remembered.
    Pending,
    /// Local disk or database failure (500); never remembered.
    Local,
}

/// An image request failure with a user-facing message (no full URLs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageError {
    pub kind: ImageErrorKind,
    pub message: String,
}

impl ImageError {
    fn new(kind: ImageErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn bad_url(message: impl Into<String>) -> Self {
        Self::new(ImageErrorKind::BadUrl, message)
    }

    fn upstream(message: impl Into<String>) -> Self {
        Self::new(ImageErrorKind::Upstream, message)
    }

    fn not_image(message: impl Into<String>) -> Self {
        Self::new(ImageErrorKind::NotImage, message)
    }

    fn host_down(host: &str) -> Self {
        Self::new(
            ImageErrorKind::HostDown,
            format!("{host} stopped answering, so its images are skipped for a few minutes."),
        )
    }

    fn pending(host: &str) -> Self {
        Self::new(
            ImageErrorKind::Pending,
            format!("{host} is slow to answer; the image is still being fetched."),
        )
    }

    fn too_large() -> Self {
        Self::new(
            ImageErrorKind::TooLarge,
            format!(
                "The image is larger than {} MB, so it is not cached.",
                MAX_IMAGE_BYTES / (1024 * 1024)
            ),
        )
    }

    fn local(err: CoreError) -> Self {
        Self::new(ImageErrorKind::Local, core_message(err))
    }

    /// HTTP status of `/api/img` for this failure (C2).
    pub fn http_status(&self) -> u16 {
        match self.kind {
            ImageErrorKind::BadUrl => 400,
            ImageErrorKind::Forbidden => 403,
            ImageErrorKind::NotFound => 404,
            ImageErrorKind::NotImage => 415,
            ImageErrorKind::TooLarge
            | ImageErrorKind::Upstream
            | ImageErrorKind::NoAnswer
            | ImageErrorKind::HostDown => 502,
            ImageErrorKind::Pending => 504,
            ImageErrorKind::Local => 500,
        }
    }
}

impl fmt::Display for ImageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ImageError {}

impl From<ImageError> for CoreError {
    /// The C2 mapping: non-image -> Unsupported, too large -> Invalid,
    /// upstream 404 -> NotFound, other upstream failures -> Network, a caller
    /// that stopped waiting -> Timeout.
    fn from(e: ImageError) -> Self {
        match e.kind {
            ImageErrorKind::BadUrl | ImageErrorKind::Forbidden | ImageErrorKind::TooLarge => {
                CoreError::Invalid(e.message)
            }
            ImageErrorKind::NotFound => CoreError::NotFound(e.message),
            ImageErrorKind::NotImage => CoreError::Unsupported(e.message),
            ImageErrorKind::Upstream | ImageErrorKind::NoAnswer | ImageErrorKind::HostDown => {
                CoreError::Network(e.message)
            }
            ImageErrorKind::Pending => CoreError::Timeout(e.message),
            ImageErrorKind::Local => CoreError::Io(std::io::Error::other(e.message)),
        }
    }
}

impl From<ImageError> for RpcError {
    fn from(e: ImageError) -> Self {
        CoreError::from(e).into()
    }
}

impl From<TargetError> for ImageError {
    fn from(e: TargetError) -> Self {
        match e {
            TargetError::Invalid(m) => Self::new(ImageErrorKind::BadUrl, m),
            TargetError::Forbidden(m) => Self::new(ImageErrorKind::Forbidden, m),
        }
    }
}

/// The message of `err` without its kind prefix, redacted.
fn core_message(err: CoreError) -> String {
    RpcError::from(err).message
}

/// Parses and normalises an image URL: absolute http(s) with a host, no user
/// info, at most [`MAX_URL_LEN`] bytes; the fragment is dropped (it never
/// reaches the server, so it must not split the cache).
pub fn normalize_url(raw: &str) -> Result<Url, ImageError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(ImageError::bad_url("The image address is empty."));
    }
    if raw.len() > MAX_URL_LEN {
        return Err(ImageError::bad_url(format!(
            "The image address is longer than {MAX_URL_LEN} characters."
        )));
    }
    let mut url = Url::parse(raw)
        .map_err(|e| ImageError::bad_url(format!("The image address is not a valid URL ({e}).")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ImageError::bad_url(
            "Only http and https images can be cached.",
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(ImageError::bad_url("The image address has no host."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ImageError::bad_url(
            "Image addresses with a user name or password are not cached.",
        ));
    }
    url.set_fragment(None);
    Ok(url)
}

/// Cache key of a normalised URL: lowercase sha256 hex of its string form.
pub fn cache_key(url: &Url) -> String {
    hex::encode(Sha256::digest(url.as_str().as_bytes()))
}

/// Cache key of the `width`-px variant of a normalised URL. The URL never
/// holds a fragment ([`normalize_url`] drops it), so `#w=` cannot collide
/// with another image's key.
pub fn variant_key(url: &Url, width: u32) -> String {
    hex::encode(Sha256::digest(variant_label(url, width).as_bytes()))
}

/// What a variant's index row records as its URL.
fn variant_label(url: &Url, width: u32) -> String {
    format!("{}#w={width}", url.as_str())
}

/// The cached file of `key` under the cache folder `dir`.
pub fn file_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(&key[..2]).join(key)
}

/// True for a cache file name (64 lowercase hex characters).
fn is_key(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// What a source contributes to an image fetch.
#[derive(Debug, Clone, Default)]
struct SourceAccess {
    headers: RequestHeaders,
    /// The source's own `host:port`, trusted by the server-mode guard.
    trusted: Option<Authority>,
}

/// A source's headers and authority (empty when `id` is unknown, so a stale
/// `sourceId` still loads the image, just without the source's trust).
async fn load_source(state: &AppState, id: Option<&str>) -> Result<SourceAccess, ImageError> {
    let Some(id) = id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(SourceAccess::default());
    };
    let id = id.to_owned();
    let row = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT kind, config_json FROM sources WHERE id = ?1",
                [&id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?)
        })
        .await
        .map_err(ImageError::local)?;
    Ok(match row {
        Some((kind, json)) => {
            let headers = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v.get("headers").cloned())
                .and_then(|h| serde_json::from_value(h).ok())
                .unwrap_or_default();
            SourceAccess {
                headers,
                trusted: http::source_config_authority(&kind, &json),
            }
        }
        None => SourceAccess::default(),
    })
}

/// The scope of a fetch: callers in different scopes never share a flight, a
/// remembered failure or a host breaker (the disk entry is shared: it is
/// keyed by URL only).
/// Two things split it:
/// - with the server-mode guard active (`guarded`), the source's trusted
///   authority, since it changes what may be fetched;
/// - the source's request headers as [`http::apply_source_headers`] sends
///   them (trimmed, blanks dropped), since an image host that wants the
///   provider's User-Agent or Referer refuses a request without them, and
///   that refusal must not reach the callers that send them.
fn flight_scope(guarded: bool, trusted: Option<&Authority>, headers: &RequestHeaders) -> String {
    let mut scope = match trusted {
        Some(auth) if guarded => auth.to_string(),
        _ => String::new(),
    };
    let sent = [&headers.user_agent, &headers.referrer, &headers.origin]
        .map(|h| h.as_deref().map(str::trim).unwrap_or_default());
    if sent.iter().any(|v| !v.is_empty()) {
        let mut hash = Sha256::new();
        for value in sent {
            hash.update(value.as_bytes());
            hash.update([0u8]);
        }
        scope.push_str("#h=");
        scope.push_str(&hex::encode(&hash.finalize()[..8]));
    }
    scope
}

/// Outcome of one flight, shared by every caller that joined it.
#[derive(Debug, Clone)]
struct Done {
    image: CachedImage,
    /// False when the flight found the image already stored (no fetch).
    fetched: bool,
}

type FlightResult = Result<Done, ImageError>;

/// One in-progress fetch.
struct Flight {
    id: u64,
    fut: Shared<BoxFuture<'static, FlightResult>>,
}

/// Flights by `"<key>|<scope>"` ([`flight_scope`]); shared with the writer,
/// which must not delete the files of running fetches.
type Flights = Arc<Mutex<HashMap<String, Flight>>>;

/// A stored file whose index row is queued but not committed yet.
#[derive(Clone)]
struct PendingRow {
    /// The flight that wrote the file (a later flight's entry replaces it).
    flight: u64,
    content_type: String,
    bytes: u64,
}

/// Pending rows by cache key; shared with the writer, which keeps their
/// files from eviction and clear and drops each entry once the batch
/// holding its row is done.
type PendingRows = Arc<Mutex<HashMap<String, PendingRow>>>;

/// What one fetch needs.
struct Job {
    url: Url,
    /// The key stored under: [`cache_key`], or [`variant_key`] with `width`.
    key: String,
    /// `Some(bucket)` for a variant: `key` is its variant key.
    width: Option<u32>,
    /// [`flight_scope`]: splits the flights, the failure memory and the
    /// host breakers.
    scope: String,
    headers: RequestHeaders,
    client: reqwest::Client,
}

impl Job {
    /// Its key in [`Flights`] and the failure memory.
    fn flight_key(&self) -> String {
        format!("{}|{}", self.key, self.scope)
    }
}

/// The upstream slots one fetch holds: one of its host's
/// ([`UPSTREAM_PER_HOST`]) and one of all ([`UPSTREAM_MAX`]).
struct Slots {
    _host: Option<OwnedSemaphorePermit>,
    _all: Option<OwnedSemaphorePermit>,
}

impl Slots {
    /// Gives the host's slot back and keeps the one of all.
    fn release_host(&mut self) {
        self._host = None;
    }
}

/// The runtime singleton (stored in `AppState::extensions`). It holds no
/// `Arc<AppState>`, so it never keeps the state alive; dropping the state
/// drops the writer's sender, and the writer exits once its queue drains.
struct ImageCache {
    pool: DbPool,
    /// `AppState::db_background`'s gate, for the writer's batches.
    background_gate: Arc<Semaphore>,
    db_path: PathBuf,
    dir: PathBuf,
    settings: Arc<RwLock<Settings>>,
    tx: mpsc::UnboundedSender<Op>,
    /// Taken by [`Self::ready`] when it starts the writer.
    rx: Mutex<Option<mpsc::UnboundedReceiver<Op>>>,
    ready: OnceCell<()>,
    flights: Flights,
    pending: PendingRows,
    failures: Mutex<HashMap<String, (Instant, ImageError)>>,
    /// Keys whose `last_access` write was queued, with the time it was.
    touched: Mutex<HashMap<String, i64>>,
    /// Variant keys (first 64 bits) whose image the resizer leaves alone:
    /// they are served from the original's entry.
    kept: Mutex<HashSet<u64>>,
    next_flight: AtomicU64,
    /// Resizes running at once ([`resize_slots`]): a poster wall's first
    /// view queued one per poster, all decoding at the same time.
    resizes: Arc<Semaphore>,
    /// Image hosts that stopped answering.
    breakers: Mutex<Breakers>,
    /// Upstream slots per `host:port` ([`UPSTREAM_PER_HOST`] each).
    host_slots: Mutex<HashMap<Authority, Arc<Semaphore>>>,
    /// Upstream slots in all ([`UPSTREAM_MAX`]).
    upstream: Arc<Semaphore>,
    /// Warmed pictures waiting for a free upstream slot, newest batch first
    /// (at most [`WARM_MAX_ITEMS`]).
    warms: Mutex<VecDeque<Job>>,
}

/// Resizes at once: every core but one, so a poster wall's first view leaves
/// a core for the UI and playback.
fn resize_slots() -> usize {
    std::thread::available_parallelism()
        .map_or(1, |n| n.get().saturating_sub(1))
        .max(1)
}

/// The cache of `state`, created on first use (tests and the server
/// harness do not run `init`).
fn cache(state: &AppState) -> Arc<ImageCache> {
    state.ext_or_insert_with(EXT_KEY, || {
        let (tx, rx) = mpsc::unbounded_channel();
        Arc::new(ImageCache {
            pool: state.db.clone(),
            background_gate: state.background_gate(),
            db_path: state.db_path(),
            dir: state.data_dir.join(DIR_NAME),
            settings: state.settings.clone(),
            tx,
            rx: Mutex::new(Some(rx)),
            ready: OnceCell::new(),
            flights: Arc::default(),
            pending: Arc::default(),
            failures: Mutex::default(),
            touched: Mutex::default(),
            kept: Mutex::default(),
            next_flight: AtomicU64::new(1),
            resizes: Arc::new(Semaphore::new(resize_slots())),
            breakers: Mutex::default(),
            host_slots: Mutex::default(),
            upstream: Arc::new(Semaphore::new(UPSTREAM_MAX)),
            warms: Mutex::default(),
        })
    })
}

/// Runs blocking database work on the blocking pool, recording corruption
/// errors for boot-time recovery like `AppState::db_call`.
async fn blocking<T, F>(pool: &DbPool, db_path: &Path, f: F) -> CoreResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> CoreResult<T> + Send + 'static,
{
    let pool = pool.clone();
    let db_path = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        pool.get()
            .map_err(CoreError::from)
            .and_then(|mut conn| f(&mut conn))
            .inspect_err(|e| {
                db::note_error(&db_path, e);
            })
    })
    .await?
}

impl ImageCache {
    /// Makes sure the table exists, loads the running total and starts the
    /// writer (once; a failure is retried by the next call).
    async fn ready(&self) -> Result<(), ImageError> {
        self.ready
            .get_or_try_init(|| async {
                let total = blocking(&self.pool, &self.db_path, store::prepare)
                    .await
                    .map_err(ImageError::local)?;
                if let Some(rx) = self.rx.lock().take() {
                    let writer = store::Writer {
                        pool: self.pool.clone(),
                        gate: self.background_gate.clone(),
                        db_path: self.db_path.clone(),
                        dir: self.dir.clone(),
                        settings: self.settings.clone(),
                        flights: self.flights.clone(),
                        pending: self.pending.clone(),
                        total,
                        synced_at: Instant::now(),
                    };
                    tokio::spawn(store::run(writer, rx));
                }
                Ok::<(), ImageError>(())
            })
            .await
            .map(|_| ())
    }

    fn send(&self, op: Op) {
        // Fails only when the writer is gone, i.e. the runtime is shutting
        // down; the index then simply misses this write.
        let _ = self.tx.send(op);
    }

    /// The stored image of `key`, if its file is intact: from its pending
    /// entry while its row waits to commit, else from its row. A row whose
    /// file is missing or has the wrong size is dropped (re-verified by the
    /// writer).
    async fn lookup(&self, key: &str) -> Result<Option<CachedImage>, ImageError> {
        if let Some(image) = self.pending_file(key).await {
            return Ok(Some(image));
        }
        let dir = self.dir.clone();
        let k = key.to_owned();
        let found = blocking(&self.pool, &self.db_path, move |c| {
            store::lookup(c, &dir, &k)
        })
        .await
        .map_err(ImageError::local)?;
        match found {
            Lookup::Miss => Ok(None),
            Lookup::Stale => {
                self.send(Op::Forget {
                    keys: vec![key.to_owned()],
                });
                Ok(None)
            }
            Lookup::Hit {
                content_type,
                bytes,
                last_access,
            } => {
                self.touch(key, last_access);
                Ok(Some(CachedImage {
                    path: file_path(&self.dir, key),
                    content_type,
                    bytes,
                    hit: true,
                }))
            }
        }
    }

    /// The file of `key` whose row is still queued, if it is on disk with
    /// the size that was written.
    async fn pending_file(&self, key: &str) -> Option<CachedImage> {
        let PendingRow {
            content_type,
            bytes,
            ..
        } = self.pending.lock().get(key).cloned()?;
        let path = file_path(&self.dir, key);
        let meta = tokio::fs::metadata(&path).await.ok()?;
        (meta.is_file() && meta.len() == bytes).then_some(CachedImage {
            path,
            content_type,
            bytes,
            hit: true,
        })
    }

    /// The first of `keys` that is stored, in the order given, with its
    /// index: [`Self::lookup`] of them all with one query.
    async fn lookup_first(
        &self,
        mut keys: Vec<String>,
    ) -> Result<Option<(usize, CachedImage)>, ImageError> {
        // Files whose rows are still queued come first, as in `lookup`: the
        // writer drops an entry only after its row commits, so an entry gone
        // by now is found by the query below. Only the keys before the first
        // such file are worth a query.
        let mut queued = None;
        for (at, key) in keys.iter().enumerate() {
            if let Some(image) = self.pending_file(key).await {
                queued = Some((at, image));
                break;
            }
        }
        keys.truncate(queued.as_ref().map_or(keys.len(), |(at, _)| *at));
        if keys.is_empty() {
            return Ok(queued);
        }
        let dir = self.dir.clone();
        let asked = keys.clone();
        let found = blocking(&self.pool, &self.db_path, move |c| {
            store::lookup_first(c, &dir, &asked)
        })
        .await
        .map_err(ImageError::local)?;
        let mut stale = Vec::new();
        let mut first = queued;
        for (at, (key, found)) in keys.iter().zip(found).enumerate() {
            match found {
                Lookup::Hit {
                    content_type,
                    bytes,
                    last_access,
                } => {
                    self.touch(key, last_access);
                    first = Some((
                        at,
                        CachedImage {
                            path: file_path(&self.dir, key),
                            content_type,
                            bytes,
                            hit: true,
                        },
                    ));
                    break;
                }
                Lookup::Stale => stale.push(key.clone()),
                Lookup::Miss => {}
            }
        }
        if !stale.is_empty() {
            self.send(Op::Forget { keys: stale });
        }
        Ok(first)
    }

    /// Queues a `last_access` write when the stored one is a minute old and
    /// no write for `key` was queued in the last minute.
    fn touch(&self, key: &str, last_access: i64) {
        let now = unix_now();
        if now - last_access < TOUCH_INTERVAL_SECS {
            return;
        }
        {
            let mut touched = self.touched.lock();
            if touched
                .get(key)
                .is_some_and(|at| now - at < TOUCH_INTERVAL_SECS)
            {
                return;
            }
            if touched.len() >= MAX_FAILURES {
                touched.retain(|_, at| now - *at < TOUCH_INTERVAL_SECS);
            }
            touched.insert(key.to_owned(), now);
        }
        self.send(Op::Touch {
            key: key.to_owned(),
            at: now,
        });
    }

    /// A failure of `flight_key` remembered less than [`FAILURE_TTL`] ago.
    fn remembered(&self, flight_key: &str) -> Option<ImageError> {
        let mut failures = self.failures.lock();
        match failures.get(flight_key) {
            Some((at, err)) if at.elapsed() < FAILURE_TTL => Some(err.clone()),
            Some(_) => {
                failures.remove(flight_key);
                None
            }
            None => None,
        }
    }

    fn remember(&self, flight_key: &str, err: &ImageError) {
        let mut failures = self.failures.lock();
        if failures.len() >= MAX_FAILURES {
            failures.retain(|_, (at, _)| at.elapsed() < FAILURE_TTL);
        }
        if failures.len() >= MAX_FAILURES {
            if let Some(oldest) = failures
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                failures.remove(&oldest);
            }
        }
        failures.insert(flight_key.to_owned(), (Instant::now(), err.clone()));
    }

    /// True when the variant `key` is known to be served by the original.
    fn is_kept(&self, key: &str) -> bool {
        short_key(key).is_some_and(|k| self.kept.lock().contains(&k))
    }

    fn keep(&self, key: &str) {
        let Some(k) = short_key(key) else { return };
        let mut kept = self.kept.lock();
        if kept.len() >= MAX_KEPT {
            kept.clear();
        }
        kept.insert(k);
    }

    /// Joins the flight for `job` (same URL and scope) or starts one.
    async fn join_or_start(self: &Arc<Self>, job: Job) -> Result<CachedImage, ImageError> {
        let (fut, resolved) = self.flight(job, None)?;
        let done = fut.await?;
        Ok(CachedImage {
            // Joining a finished flight served bytes already on disk.
            hit: resolved || !done.fetched,
            ..done.image
        })
    }

    /// The flight for `job`: the running one (true with it when it already
    /// finished), or a new detached one that fetches with `slots` when they
    /// were taken for it, else waits for its own. A failure remembered for
    /// the key and scope is returned instead.
    fn flight(
        self: &Arc<Self>,
        job: Job,
        slots: Option<Slots>,
    ) -> Result<(Shared<BoxFuture<'static, FlightResult>>, bool), ImageError> {
        let flight_key = job.flight_key();
        let mut flights = self.flights.lock();
        if let Some(flight) = flights.get(&flight_key) {
            return Ok((flight.fut.clone(), flight.fut.peek().is_some()));
        }
        if let Some(err) = self.remembered(&flight_key) {
            return Err(err);
        }
        let id = self.next_flight.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<FlightResult>();
        let fut = rx
            .map(|r| {
                r.unwrap_or_else(|_| {
                    Err(ImageError::new(
                        ImageErrorKind::Local,
                        "The image fetch stopped unexpectedly.",
                    ))
                })
            })
            .boxed()
            .shared();
        flights.insert(
            flight_key.clone(),
            Flight {
                id,
                fut: fut.clone(),
            },
        );
        tokio::spawn(Arc::clone(self).run_flight(flight_key, id, job, slots, tx));
        Ok((fut, false))
    }

    /// The detached body of one flight: it runs to the end even when every
    /// caller went away, so the next request finds the image stored. Its
    /// upstream slots go back once its body is in (see [`Self::download`])
    /// or when it ends, and a queued warm may go then.
    async fn run_flight(
        self: Arc<Self>,
        flight_key: String,
        id: u64,
        job: Job,
        slots: Option<Slots>,
        tx: oneshot::Sender<FlightResult>,
    ) {
        match self.download(&job, id, slots).await {
            Ok(done) => {
                // The file is in place; its row may still wait for the write
                // lock. A request arriving before it commits finds the
                // pending entry instead of fetching again.
                let _ = tx.send(Ok(done));
                self.end_flight(&flight_key, id, None);
            }
            Err(err) => {
                tracing::debug!(
                    url = %redact_url(job.url.as_str()),
                    kind = ?err.kind,
                    error = %err,
                    "image fetch failed"
                );
                self.end_flight(&flight_key, id, Some(&err));
                let _ = tx.send(Err(err));
            }
        }
        self.pump_warms();
    }

    /// Removes the flight (and remembers its failure, unless it was local or
    /// a breaker's refusal) under the flights lock, so a new caller sees
    /// either the flight or the failure.
    fn end_flight(&self, flight_key: &str, id: u64, failure: Option<&ImageError>) {
        let mut flights = self.flights.lock();
        if let Some(err) =
            failure.filter(|e| !matches!(e.kind, ImageErrorKind::Local | ImageErrorKind::HostDown))
        {
            self.remember(flight_key, err);
        }
        if flights.get(flight_key).is_some_and(|f| f.id == id) {
            flights.remove(flight_key);
        }
    }

    /// Fetches, validates and stores one image for flight `id`, and queues
    /// its index row (pending until the writer's batch is done). A variant
    /// job resizes the cached original when there is one, else the smallest
    /// cached variant wider than it, else the fetched body, and stores only
    /// the result (or only the original, when the resizer leaves it alone).
    /// The upstream fetch uses `slots` when a warm took them, else waits for
    /// its own. It gives the host's slot back once the body is in and the
    /// slot of all once the body is resized and written.
    async fn download(
        self: &Arc<Self>,
        job: &Job,
        id: u64,
        slots: Option<Slots>,
    ) -> Result<Done, ImageError> {
        // An earlier flight may have stored it after the caller looked.
        if let Some(image) = self.lookup(&job.key).await? {
            return Ok(Done {
                image,
                fetched: false,
            });
        }
        let base_key = cache_key(&job.url);
        if let Some(width) = job.width {
            // The original first (the best source), then the wider copies
            // from the smallest up (the cheapest to decode). A picture shown
            // at two sizes is fetched once.
            let sources = std::iter::once(base_key.clone())
                .chain(
                    resize::WIDTH_BUCKETS
                        .iter()
                        .filter(|b| **b > width)
                        .map(|b| variant_key(&job.url, *b)),
                )
                .collect();
            if let Some((at, source)) = self.lookup_first(sources).await? {
                // Evicted between the lookup and the read: fetch it below.
                if let Ok(body) = tokio::fs::read(&source.path).await {
                    if let Some(done) = self.store_variant(job, id, width, body).await? {
                        return Ok(Done {
                            fetched: false,
                            ..done
                        });
                    }
                    // The resizer leaves the original alone: it serves this
                    // width. A wider copy it leaves alone (a re-encode that
                    // would not be smaller) is not marked, since `kept`
                    // sends later requests to the original, which is not
                    // stored: the original is fetched below as on any miss.
                    if at == 0 {
                        self.keep(&job.key);
                        return Ok(Done {
                            image: source,
                            fetched: false,
                        });
                    }
                }
            }
        }
        let host = job.url.host_str().unwrap_or("the image server").to_owned();
        let authority = Authority::of(&job.url);
        // Taken before the breaker is asked and the clock starts: time spent
        // queued behind the host's other fetches is not the host's silence.
        let slots = match slots {
            Some(slots) => slots,
            None => self.upstream_slots(authority.as_ref()).await,
        };
        // Asked only now, so disk hits and variants made from a cached
        // copy never wait on a host's breaker.
        let host_key = authority.map(|a| (a, job.scope.clone()));
        let started = Instant::now();
        let admitted = host_key
            .as_ref()
            .map(|k| self.breakers.lock().admit(k, started));
        if admitted == Some(Admit::Refuse) {
            return Err(ImageError::host_down(&host));
        }
        let fetched = tokio::time::timeout(
            FETCH_DEADLINE,
            fetch::download(
                &job.client,
                &job.url,
                &job.headers,
                &host,
                job.width.is_some(),
            ),
        )
        .await
        .unwrap_or_else(|_| {
            Err(ImageError::upstream(format!(
                "{host} took longer than {} s to send the image.",
                FETCH_DEADLINE.as_secs()
            )))
        });
        if let (Some(host_key), Some(admitted)) = (&host_key, admitted) {
            self.note_host(
                host_key,
                &job.url,
                admitted,
                started,
                fetched.as_ref().err(),
            );
        }
        // The host is done with: a request waiting for one of its slots takes
        // it at once, else a queued warm. The slot of all is held until the
        // body is resized and written, so at most UPSTREAM_MAX fetched bodies
        // (each up to MAX_IMAGE_BYTES) wait in memory at once.
        let mut slots = slots;
        slots.release_host();
        self.pump_warms();
        let stored = self.store_fetched(job, id, &base_key, fetched).await;
        drop(slots);
        self.pump_warms();
        stored
    }

    /// Stores the body [`Self::download`] fetched: as it is, or for a
    /// variant job the resized copy (or the original, when the resizer
    /// leaves it alone).
    async fn store_fetched(
        &self,
        job: &Job,
        id: u64,
        base_key: &str,
        fetched: Result<(String, Vec<u8>), ImageError>,
    ) -> Result<Done, ImageError> {
        let (content_type, body) = fetched?;
        let label = job.url.to_string();
        let Some(width) = job.width else {
            return self.store(&job.key, &label, id, content_type, body).await;
        };
        // Only the copy the caller shows is kept, not the original. The
        // resizer borrows the body and hands it back when it keeps it.
        let (shrunk, body) = self.shrink(body, width).await?;
        match shrunk {
            resize::Shrunk::Resized {
                content_type: small_type,
                body: small,
                ..
            } => {
                let label = variant_label(&job.url, width);
                self.store(&job.key, &label, id, small_type.to_owned(), small)
                    .await
            }
            resize::Shrunk::Keep => {
                self.keep(&job.key);
                self.store(base_key, &label, id, content_type, body).await
            }
        }
    }

    /// Tells the breaker of `host` how a fetch it let through at `started`
    /// ended, and logs once when that trips it.
    fn note_host(
        &self,
        host: &breaker::HostKey,
        url: &Url,
        admitted: Admit,
        started: Instant,
        err: Option<&ImageError>,
    ) {
        let timed_out = err.is_some_and(|e| e.kind == ImageErrorKind::NoAnswer);
        let tripped = self.breakers.lock().record(
            host,
            url.as_str(),
            admitted,
            started,
            timed_out,
            Instant::now(),
        );
        if tripped {
            tracing::info!(
                host = %host.0,
                skip_secs = breaker::open_for().as_secs(),
                "an image host stopped answering; its images fail at once for a while"
            );
        }
    }

    /// The upstream slot count of `host`.
    fn host_slots(&self, host: &Authority) -> Arc<Semaphore> {
        let mut hosts = self.host_slots.lock();
        if let Some(slots) = hosts.get(host) {
            return slots.clone();
        }
        if hosts.len() >= MAX_SLOT_HOSTS {
            // A fetch running or waiting holds a clone of its host's count.
            hosts.retain(|_, slots| Arc::strong_count(slots) > 1);
        }
        let slots = Arc::new(Semaphore::new(UPSTREAM_PER_HOST));
        hosts.insert(host.clone(), slots.clone());
        slots
    }

    /// Waits for an upstream slot of `host`, then for one of all. In that
    /// order, so fetches queued behind one slow host hold no slot that
    /// another host could use. A waiting request gets each freed slot before
    /// a warm does: [`Self::warm_slots`] takes only slots nobody waits for.
    async fn upstream_slots(&self, host: Option<&Authority>) -> Slots {
        // Never closed, so a permit always comes.
        let host = match host {
            Some(host) => self.host_slots(host).acquire_owned().await.ok(),
            None => None,
        };
        let all = self.upstream.clone().acquire_owned().await.ok();
        Slots {
            _host: host,
            _all: all,
        }
    }

    /// [`Self::upstream_slots`] for a warm, without waiting: `None` while
    /// [`WARM_PER_HOST`] of the host's slots or [`WARM_MAX`] of all are
    /// taken, or a waiting request wants them (a slot freed while a request
    /// waits goes straight to it, so none is free then).
    fn warm_slots(&self, host: Option<&Authority>) -> Option<Slots> {
        let host = match host {
            Some(host) => {
                let slots = self.host_slots(host);
                if slots.available_permits() <= UPSTREAM_PER_HOST - WARM_PER_HOST {
                    return None;
                }
                Some(slots.try_acquire_owned().ok()?)
            }
            None => None,
        };
        if !self.warm_room() {
            return None;
        }
        let all = self.upstream.clone().try_acquire_owned().ok()?;
        Some(Slots {
            _host: host,
            _all: Some(all),
        })
    }

    /// Queues the jobs of one [`warm`] ahead of older warms, in their order,
    /// and starts what the free slots allow. The oldest are dropped past
    /// [`WARM_MAX_ITEMS`]: they belong to a screen the user already left.
    fn queue_warms(self: &Arc<Self>, jobs: Vec<Job>) {
        if jobs.is_empty() {
            return;
        }
        {
            let mut warms = self.warms.lock();
            for job in jobs.into_iter().rev() {
                warms.push_front(job);
            }
            warms.truncate(WARM_MAX_ITEMS);
        }
        self.pump_warms();
    }

    /// True while fewer than [`WARM_MAX`] of all upstream slots are taken.
    fn warm_room(&self) -> bool {
        self.upstream.available_permits() > UPSTREAM_MAX - WARM_MAX
    }

    /// Starts queued warms while their share of the upstream slots is free,
    /// first in queue first, passing over a host whose share is taken. A
    /// warm whose image is being fetched already is dropped.
    fn pump_warms(self: &Arc<Self>) {
        loop {
            let (job, slots) = {
                let mut warms = self.warms.lock();
                let mut next = None;
                let mut i = 0;
                while i < warms.len() && self.warm_room() {
                    if self.flights.lock().contains_key(&warms[i].flight_key()) {
                        warms.remove(i);
                        continue;
                    }
                    match self.warm_slots(Authority::of(&warms[i].url).as_ref()) {
                        Some(slots) => {
                            next = warms.remove(i).map(|job| (job, slots));
                            break;
                        }
                        None => i += 1,
                    }
                }
                match next {
                    Some(next) => next,
                    None => return,
                }
            };
            // A remembered failure starts nothing; the slots go back.
            let _ = self.flight(job, Some(slots));
        }
    }

    /// Resizes a cached original for the variant job and stores the copy;
    /// `None` when the resizer leaves the image alone.
    async fn store_variant(
        &self,
        job: &Job,
        id: u64,
        width: u32,
        body: Vec<u8>,
    ) -> Result<Option<Done>, ImageError> {
        let (shrunk, _) = self.shrink(body, width).await?;
        match shrunk {
            resize::Shrunk::Keep => Ok(None),
            resize::Shrunk::Resized {
                content_type, body, ..
            } => {
                let label = variant_label(&job.url, width);
                self.store(&job.key, &label, id, content_type.to_owned(), body)
                    .await
                    .map(Some)
            }
        }
    }

    /// [`resize::shrink`] on the blocking pool, at most [`resize_slots`] at
    /// once; hands `body` back.
    async fn shrink(
        &self,
        body: Vec<u8>,
        width: u32,
    ) -> Result<(resize::Shrunk, Vec<u8>), ImageError> {
        // Never closed, so a permit always comes.
        let _slot = self.resizes.acquire().await.ok();
        tokio::task::spawn_blocking(move || {
            let shrunk = resize::shrink(&body, width);
            (shrunk, body)
        })
        .await
        .map_err(|e| ImageError::local(CoreError::from(e)))
    }

    /// Writes `body` under `key` and queues its index row (`url` is what
    /// the row records).
    async fn store(
        &self,
        key: &str,
        url: &str,
        id: u64,
        content_type: String,
        body: Vec<u8>,
    ) -> Result<Done, ImageError> {
        let bytes = body.len() as u64;
        let path = store::write_file(&self.dir, key, body)
            .await
            .map_err(ImageError::local)?;
        // Before the row is queued: an entry added after its batch was done
        // would never be dropped.
        self.pending.lock().insert(
            key.to_owned(),
            PendingRow {
                flight: id,
                content_type: content_type.clone(),
                bytes,
            },
        );
        self.send(Op::Insert {
            row: store::Row {
                key: key.to_owned(),
                url: url.to_owned(),
                content_type: content_type.clone(),
                bytes,
                at: unix_now(),
            },
            flight: id,
        });
        Ok(Done {
            image: CachedImage {
                path,
                content_type,
                bytes,
                hit: false,
            },
            fetched: true,
        })
    }

    async fn read_stats(&self) -> CoreResult<ImageCacheStats> {
        let (bytes, files) = blocking(&self.pool, &self.db_path, store::totals).await?;
        Ok(ImageCacheStats {
            bytes,
            files,
            max_bytes: max_bytes(&self.settings.read()),
        })
    }

    /// Sends `op` built around a fresh ack and waits for the writer.
    async fn round_trip(
        &self,
        op: impl FnOnce(oneshot::Sender<CoreResult<()>>) -> Op,
    ) -> CoreResult<()> {
        let (tx, rx) = oneshot::channel();
        self.send(op(tx));
        rx.await
            .map_err(|_| CoreError::Other(anyhow::anyhow!("the image cache writer stopped")))?
    }

    /// Startup reconcile: drops rows whose file is gone (or has the wrong
    /// size), deletes files without a row and stale temp files.
    async fn reconcile(&self) {
        let rows = match blocking(&self.pool, &self.db_path, store::all_rows).await {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(error = %err, "image cache reconcile could not read the index");
                return;
            }
        };
        let dir = self.dir.clone();
        match tokio::task::spawn_blocking(move || store::scan(&dir, &rows)).await {
            Ok(report) => {
                if !report.stale.is_empty() {
                    self.send(Op::Forget {
                        keys: report.stale.clone(),
                    });
                }
                if report.stale.len() + report.removed > 0 {
                    tracing::info!(
                        stale_rows = report.stale.len(),
                        removed_files = report.removed,
                        "image cache reconciled"
                    );
                }
            }
            Err(err) => tracing::warn!(%err, "image cache reconcile failed"),
        }
    }
}

/// Shortens [`HEAD_TIMEOUT`] for the whole process. Test hook for integration
/// tests with an image host that never answers; the app never calls it.
#[doc(hidden)]
pub fn set_head_timeout_for_tests(timeout: Duration) {
    let ms = u64::try_from(timeout.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    HEAD_TIMEOUT_MS.store(ms, Ordering::Relaxed);
}

/// Shortens how long a host's breaker stays open (`breaker::OPEN_FOR`) for
/// the whole process. Test hook, like [`set_head_timeout_for_tests`].
#[doc(hidden)]
pub fn set_breaker_open_for_tests(open_for: Duration) {
    let ms = u64::try_from(open_for.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    breaker::OPEN_FOR_MS.store(ms, Ordering::Relaxed);
}

/// Takes every resize slot of `state`'s cache until the returned permit is
/// dropped, so a test can hold fetched bodies before their resize. Test
/// hook, like [`set_head_timeout_for_tests`].
#[doc(hidden)]
pub async fn hold_resizes_for_tests(state: &AppState) -> OwnedSemaphorePermit {
    cache(state)
        .resizes
        .clone()
        .acquire_many_owned(resize_slots() as u32)
        .await
        .expect("the resize slots are never closed")
}

fn head_timeout() -> Duration {
    match HEAD_TIMEOUT_MS.load(Ordering::Relaxed) {
        0 => HEAD_TIMEOUT,
        ms => Duration::from_millis(ms),
    }
}

/// The first 64 bits of a cache key (the in-memory "kept" set).
fn short_key(key: &str) -> Option<u64> {
    u64::from_str_radix(key.get(..16)?, 16).ok()
}

/// [`get`] with the failure kind kept, for the HTTP routes (400/403/404/
/// 415/502/500 per C2).
pub async fn fetch(
    state: &Arc<AppState>,
    url: &str,
    source_id: Option<&str>,
) -> Result<CachedImage, ImageError> {
    fetch_sized(state, url, source_id, None).await
}

/// [`fetch`] with a width hint in device pixels: `Some(w)` serves a copy at
/// most [`resize::bucket`]`(w)` px wide (the original when the resizer
/// leaves the image alone, or for hints above the largest bucket).
pub async fn fetch_sized(
    state: &Arc<AppState>,
    url: &str,
    source_id: Option<&str>,
    width: Option<u32>,
) -> Result<CachedImage, ImageError> {
    fetch_sized_within(state, url, source_id, width, None).await
}

/// [`fetch_sized`] that waits at most `wait` for the upstream fetch once the
/// cache missed, then answers [`ImageErrorKind::Pending`]. The fetch runs in
/// its own task and goes on, so it still stores the image (or remembers its
/// failure) for the next request. The guard check and the lookups are not
/// limited: a cached image is never refused this way.
pub async fn fetch_sized_within(
    state: &Arc<AppState>,
    url: &str,
    source_id: Option<&str>,
    width: Option<u32>,
    wait: Option<Duration>,
) -> Result<CachedImage, ImageError> {
    let cache = cache(state);
    let job = match resolve(state, &cache, url, source_id, width).await? {
        Resolved::Stored(image) => return Ok(image),
        Resolved::Missing(job) => job,
    };
    let host = job.url.host_str().unwrap_or("the image server").to_owned();
    let flight = cache.join_or_start(job);
    let Some(wait) = wait else {
        return flight.await;
    };
    tokio::time::timeout(wait, flight)
        .await
        .unwrap_or_else(|_| Err(ImageError::pending(&host)))
}

/// What a request comes to before anything is fetched.
enum Resolved {
    /// On disk (or served by the original), past the guard.
    Stored(CachedImage),
    /// Not stored: the fetch that gets it.
    Missing(Job),
}

/// The guard check and the lookups of [`fetch_sized_within`]: the stored
/// image, or the job that fetches it.
async fn resolve(
    state: &Arc<AppState>,
    cache: &ImageCache,
    url: &str,
    source_id: Option<&str>,
    width: Option<u32>,
) -> Result<Resolved, ImageError> {
    let url = normalize_url(url)?;
    let width = width.and_then(resize::bucket);
    let key = match width {
        Some(w) => variant_key(&url, w),
        None => cache_key(&url),
    };
    cache.ready().await?;
    let mode = http::server_mode(state);
    // Server mode checks the URL against the source's authority first, hit
    // or not. The desktop needs the source row only to fetch, so a hit
    // skips reading it.
    let checked = match &mode {
        Some(mode) => {
            let source = load_source(state, source_id).await?;
            mode.guard.check(&url, source.trusted.as_ref()).await?;
            Some(source)
        }
        None => None,
    };
    if let Some(image) = cache.lookup(&key).await? {
        return Ok(Resolved::Stored(image));
    }
    if width.is_some() && cache.is_kept(&key) {
        if let Some(image) = cache.lookup(&cache_key(&url)).await? {
            return Ok(Resolved::Stored(image));
        }
    }
    let source = match checked {
        Some(source) => source,
        None => load_source(state, source_id).await?,
    };
    // The source-trusting client only for a logo on the source's own
    // host:port; its resolver cannot tell ports apart.
    let trusted = http::trust_for(url.as_str(), source.trusted.as_ref());
    let scope = flight_scope(
        mode.as_ref().is_some_and(|m| !m.guard.allow_private),
        trusted,
        &source.headers,
    );
    let client = http::guarded_client(state, trusted);
    Ok(Resolved::Missing(Job {
        url,
        key,
        width,
        scope,
        headers: source.headers,
        client,
    }))
}

/// One picture for [`warm`]: what a cache-route URL asks for (its `url`,
/// `sourceId` and `w`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmItem {
    pub url: String,
    #[serde(default)]
    pub source_id: Option<String>,
    /// Width hint in device pixels, as the route's `w`.
    #[serde(default)]
    pub w: Option<u32>,
}

/// Gets the upstream fetches of pictures a screen is about to ask for going
/// before their own requests reach the cache. Each item is checked exactly
/// as its request would be (the server-mode guard included, then the
/// lookups), at most [`WARM_MAX_ITEMS`] of them; the ones not stored are
/// queued and start whenever an upstream slot is free. Returns once they are
/// queued, without waiting for any fetch. Failures are dropped: each
/// picture's own request reports them.
pub async fn warm(state: &Arc<AppState>, items: Vec<WarmItem>) {
    let cache = cache(state);
    let jobs: Vec<Job> = futures::stream::iter(items.into_iter().take(WARM_MAX_ITEMS))
        .map(|item| {
            let cache = &cache;
            async move { resolve(state, cache, &item.url, item.source_id.as_deref(), item.w).await }
        })
        .buffered(WARM_CHECKS)
        .filter_map(|resolved| async move {
            match resolved {
                Ok(Resolved::Missing(job)) => Some(job),
                Ok(Resolved::Stored(_)) | Err(_) => None,
            }
        })
        .collect()
        .await;
    cache.queue_warms(jobs);
}

/// Disk hit, or fetch, validate and store. Concurrent calls for one URL share
/// one fetch (single flight).
/// Desktop: `state.http`. Server mode: the guarded client, trusting the
/// source's `host:port` only for an image on exactly it.
/// Non-image content type -> Unsupported; body over [`MAX_IMAGE_BYTES`] ->
/// Invalid; upstream 404 -> NotFound; other failures -> Network.
/// Failures are remembered in memory for 10 min (no refetch storm).
pub async fn get(
    state: &Arc<AppState>,
    url: &str,
    source_id: Option<&str>,
) -> CoreResult<CachedImage> {
    fetch(state, url, source_id).await.map_err(CoreError::from)
}

/// Size and file count of the cache; also evicts down to the cap.
pub async fn stats(state: &Arc<AppState>) -> CoreResult<ImageCacheStats> {
    let cache = cache(state);
    cache.ready().await?;
    cache.round_trip(|ack| Op::Evict { ack }).await?;
    cache.read_stats().await
}

/// Deletes every cached file and index row; returns the (empty) stats.
/// Remembered failures and open host breakers are forgotten too, so Clear
/// also means "try again".
pub async fn clear(state: &Arc<AppState>) -> CoreResult<ImageCacheStats> {
    let cache = cache(state);
    cache.ready().await?;
    cache.failures.lock().clear();
    cache.breakers.lock().clear();
    cache.touched.lock().clear();
    cache.kept.lock().clear();
    // Warms not started yet would fill the cache again right after.
    cache.warms.lock().clear();
    cache.round_trip(|ack| Op::Clear { ack }).await?;
    cache.read_stats().await
}

/// Module init: loads the running byte total from `SUM(bytes)` and starts the
/// background reconcile (rows without a file, files without a row).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let cache = cache(&state);
    cache.ready().await?;
    tokio::spawn(async move { cache.reconcile().await });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_serialize_camel_case_and_cap_follows_settings() {
        let v = serde_json::to_value(ImageCacheStats {
            bytes: 1,
            files: 2,
            max_bytes: 3,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"bytes": 1, "files": 2, "maxBytes": 3})
        );
        assert_eq!(max_bytes(&Settings::default()), 500 * 1024 * 1024);
        let s = Settings {
            image_cache_max_mb: 5000,
            ..Settings::default()
        };
        assert_eq!(max_bytes(&s), 5000 * 1024 * 1024);
    }

    #[test]
    fn urls_normalise_into_stable_keys() {
        let a = normalize_url("  HTTP://Example.COM:80/a/b.png#frag ").unwrap();
        assert_eq!(a.as_str(), "http://example.com/a/b.png");
        let b = normalize_url("http://example.com/a/b.png").unwrap();
        assert_eq!(cache_key(&a), cache_key(&b));
        let key = cache_key(&a);
        assert!(is_key(&key), "{key}");
        assert_ne!(
            cache_key(&normalize_url("http://example.com/a/b.png?x=1").unwrap()),
            key,
            "the query is part of the key"
        );
        let p = file_path(Path::new("cache"), &key);
        assert_eq!(p, Path::new("cache").join(&key[..2]).join(&key));
    }

    #[test]
    fn bad_urls_are_refused_as_bad_url() {
        for raw in [
            "",
            "   ",
            "not a url",
            "/relative/poster.jpg",
            "ftp://example.com/a.png",
            "file:///C:/Windows/win.ini",
            "data:image/png;base64,AAAA",
            "http://user:pass@example.com/a.png",
            "http://user@example.com/a.png",
        ] {
            let err = normalize_url(raw).unwrap_err();
            assert_eq!(err.kind, ImageErrorKind::BadUrl, "{raw}");
            assert_eq!(err.http_status(), 400, "{raw}");
        }
        let long = format!("http://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(
            normalize_url(&long).unwrap_err().kind,
            ImageErrorKind::BadUrl
        );
    }

    #[test]
    fn errors_map_to_the_c2_codes_and_statuses() {
        use crate::error::RpcErrorCode;
        let cases = [
            (ImageErrorKind::BadUrl, 400, RpcErrorCode::Invalid),
            (ImageErrorKind::Forbidden, 403, RpcErrorCode::Invalid),
            (ImageErrorKind::NotFound, 404, RpcErrorCode::NotFound),
            (ImageErrorKind::NotImage, 415, RpcErrorCode::Unsupported),
            (ImageErrorKind::TooLarge, 502, RpcErrorCode::Invalid),
            (ImageErrorKind::Upstream, 502, RpcErrorCode::Network),
            (ImageErrorKind::NoAnswer, 502, RpcErrorCode::Network),
            (ImageErrorKind::HostDown, 502, RpcErrorCode::Network),
            (ImageErrorKind::Pending, 504, RpcErrorCode::Timeout),
        ];
        for (kind, status, code) in cases {
            let err = ImageError::new(kind, "m");
            assert_eq!(err.http_status(), status, "{kind:?}");
            assert_eq!(RpcError::from(err).code, code, "{kind:?}");
        }
        let local = ImageError::new(ImageErrorKind::Local, "disk full");
        assert_eq!(local.http_status(), 500);
        assert!(matches!(CoreError::from(local), CoreError::Io(_)));
        assert_eq!(
            ImageError::from(TargetError::Forbidden("no".into())).kind,
            ImageErrorKind::Forbidden
        );
        assert_eq!(
            ImageError::from(TargetError::Invalid("no".into())).kind,
            ImageErrorKind::BadUrl
        );
    }

    #[test]
    fn the_scope_splits_on_guarded_trust_and_on_the_headers_sent() {
        let none = RequestHeaders::default();
        let ua = |v: &str| RequestHeaders {
            user_agent: Some(v.into()),
            ..RequestHeaders::default()
        };
        let auth = Authority::of(&Url::parse("http://nas.lan:8080/list.m3u").unwrap()).unwrap();

        // No guard, no headers: every caller shares one scope.
        assert_eq!(flight_scope(false, None, &none), "");
        assert_eq!(
            flight_scope(false, Some(&auth), &none),
            "",
            "trust needs the guard"
        );
        assert_eq!(flight_scope(true, Some(&auth), &none), auth.to_string());
        // Blank headers are not sent, so they do not split the scope.
        let blank = RequestHeaders {
            user_agent: Some("  ".into()),
            referrer: Some(String::new()),
            origin: None,
        };
        assert_eq!(flight_scope(false, None, &blank), "");

        // A source that sends headers gets its own scope; the same headers
        // (as sent: trimmed) share it, other headers do not.
        let agent = flight_scope(false, None, &ua("SourceAgent/2.0"));
        assert!(agent.starts_with("#h="), "{agent}");
        assert!(!agent.contains('|'), "the writer splits flight keys on '|'");
        assert_eq!(flight_scope(false, None, &ua(" SourceAgent/2.0 ")), agent);
        assert_ne!(flight_scope(false, None, &ua("Other/1.0")), agent);
        let referrer = RequestHeaders {
            referrer: Some("SourceAgent/2.0".into()),
            ..RequestHeaders::default()
        };
        assert_ne!(
            flight_scope(false, None, &referrer),
            agent,
            "which header holds a value matters"
        );
        let guarded = flight_scope(true, Some(&auth), &ua("SourceAgent/2.0"));
        assert_eq!(guarded, format!("{auth}{agent}"));
    }

    #[test]
    fn cache_file_names_are_64_lowercase_hex() {
        assert!(is_key(&"a".repeat(64)));
        assert!(!is_key(&"A".repeat(64)));
        assert!(!is_key(&"a".repeat(63)));
        assert!(!is_key(&format!("{}.tmp", "a".repeat(60))));
    }
}
