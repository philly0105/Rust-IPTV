//! Mock IPTV servers for tests and e2e (SPEC C13).
//!
//! One axum router serves every provider the app talks to:
//! - `/xtream/...`  Xtream Codes (`player_api.php`, `xmltv.php`, HLS, VOD,
//!   timeshift). Credentials `demo` / `secret`. See [`xtream`].
//! - `/stalker/...` Stalker / Ministra portal. MAC `00:1A:79:00:00:01`,
//!   token `mock-token-1`. See [`stalker`].
//! - `/m3u/...` and `/xmltv/...` playlists and guides, including streamed
//!   large variants and the 10k-channel fixture `/m3u/10k.m3u`. See
//!   [`playlists`].
//! - `/fail/...` failure modes for tests: slow, stalled and drip-fed bodies,
//!   401/403/404/503 and any status, empty, malformed and broken playlists,
//!   an HTML login page, an endless video stream, an HLS stream playlist,
//!   malformed XMLTV. See [`failures`] for the full table.
//! - `/live/timed.ts?seconds=N` a live TS stream that ends after N s (for
//!   recording tests). See [`live`].
//! - `/files/...` download targets with Range, a flaky one and a chunked one.
//!   See [`files`].
//! - `/media/...`, `/img/...` sample media and generated artwork.
//! - `/health`, `/echo/headers`, `/__mock/stats`, `/__mock/reset`.
//!
//! Every response carries `Access-Control-Allow-Origin: *`.
//!
//! URLs inside payloads use the configured base (see [`router_with_base`]);
//! with [`router`] the base is derived from each request's `Host` header.

pub mod catalog;
pub mod failures;
pub mod files;
pub mod gen;
pub mod images;
pub mod live;
pub mod media;
pub mod playlists;
pub mod stalker;
pub mod xtream;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use axum::extract::{FromRequest, FromRequestParts, Query, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

pub use files::{video_bytes, FLAKY_DROP_AFTER, NOLEN_LEN, VIDEO_BIN_LEN};
pub use gen::DEFAULT_BASE;

/// Shared state of one router instance.
pub struct MockState {
    /// Configured base URL without trailing slash; empty means "use Host".
    base: String,
    /// Keys of `/files/flaky.bin` that have already failed once.
    pub(crate) flaky_seen: Mutex<HashSet<String>>,
    /// Stalker token generation (token is `mock-token-<n>`).
    pub(crate) stalker_generation: AtomicU32,
    /// Request counts per path.
    stats: Mutex<BTreeMap<String, u64>>,
}

impl MockState {
    fn new(base: String) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            flaky_seen: Mutex::new(HashSet::new()),
            stalker_generation: AtomicU32::new(1),
            stats: Mutex::new(BTreeMap::new()),
        }
    }
}

/// Base URL for payload links: the configured base, else `http://<Host>`.
pub struct Base(pub String);

impl FromRequestParts<Arc<MockState>> for Base {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<MockState>,
    ) -> Result<Self, Self::Rejection> {
        if !state.base.is_empty() {
            return Ok(Base(state.base.clone()));
        }
        let host = parts
            .headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .or_else(|| parts.uri.authority().map(|a| a.as_str()))
            .unwrap_or("127.0.0.1");
        Ok(Base(format!("http://{host}")))
    }
}

/// Query parameters merged with an urlencoded POST body (body wins).
pub struct Params(pub HashMap<String, String>);

impl<S: Send + Sync> FromRequest<S> for Params {
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let mut map: HashMap<String, String> =
            Query::<HashMap<String, String>>::try_from_uri(req.uri())
                .map(|q| q.0)
                .unwrap_or_default();
        if req.method() == Method::POST {
            let is_form = req
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/x-www-form-urlencoded"));
            let body = axum::body::Bytes::from_request(req, state)
                .await
                .map_err(IntoResponse::into_response)?;
            if is_form || !body.is_empty() {
                if let Ok(form) = serde_urlencoded_pairs(&body) {
                    map.extend(form);
                }
            }
        }
        Ok(Params(map))
    }
}

fn serde_urlencoded_pairs(body: &[u8]) -> Result<Vec<(String, String)>, ()> {
    let text = std::str::from_utf8(body).map_err(|_| ())?;
    Ok(text
        .split('&')
        .filter(|kv| !kv.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            let dec = |s: &str| {
                percent_encoding::percent_decode_str(&s.replace('+', " "))
                    .decode_utf8_lossy()
                    .into_owned()
            };
            (dec(k), dec(v))
        })
        .collect())
}

/// Router whose payload URLs derive from each request's `Host` header.
pub fn router() -> Router {
    router_with_base(String::new())
}

/// Router whose payload URLs use `base` (for example `http://127.0.0.1:7290`).
/// An empty `base` falls back to the request `Host` header.
pub fn router_with_base(base: String) -> Router {
    let state = Arc::new(MockState::new(base));
    Router::new()
        .route("/health", get(health))
        .route("/echo/headers", get(echo_headers).post(echo_headers))
        .route("/__mock/stats", get(stats))
        .route("/__mock/reset", post(reset).get(reset))
        .route("/img/{kind}/{file}", get(images::image))
        .route("/media/radio.mp3", get(radio))
        .route("/media/sample.mp4", get(sample_mp4))
        .route("/media/sample.webm", get(sample_webm))
        .route("/files/video.bin", get(files::video).head(files::video))
        .route("/files/flaky.bin", get(files::flaky).head(files::flaky))
        .route("/files/nolen.bin", get(files::nolen))
        .merge(xtream::routes())
        .merge(stalker::routes())
        .merge(playlists::routes())
        .merge(failures::routes())
        .merge(live::routes())
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), count))
        .layer(CorsLayer::permissive().expose_headers(tower_http::cors::Any))
        .layer(middleware::map_response(ensure_cors))
        .with_state(state)
}

async fn ensure_cors(mut res: Response) -> Response {
    res.headers_mut()
        .entry(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .or_insert(HeaderValue::from_static("*"));
    res
}

async fn count(State(state): State<Arc<MockState>>, req: Request, next: Next) -> Response {
    *state
        .stats
        .lock()
        .entry(req.uri().path().to_string())
        .or_insert(0) += 1;
    next.run(req).await
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "iptv-mock" }))
}

async fn echo_headers(headers: HeaderMap) -> Json<Value> {
    let map: BTreeMap<String, String> = headers
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    Json(json!({ "headers": map }))
}

async fn stats(State(state): State<Arc<MockState>>) -> Json<Value> {
    let s = state.stats.lock().clone();
    Json(json!({
        "requests": s,
        "stalker_token": stalker::token_for(state.stalker_generation.load(Ordering::SeqCst)),
        "flaky_failed_keys": state.flaky_seen.lock().iter().cloned().collect::<Vec<_>>()
    }))
}

async fn reset(State(state): State<Arc<MockState>>) -> Json<Value> {
    state.stats.lock().clear();
    state.flaky_seen.lock().clear();
    state.stalker_generation.store(1, Ordering::SeqCst);
    Json(json!({ "ok": true }))
}

async fn radio(headers: HeaderMap) -> Response {
    media::serve_static(
        &headers,
        media::RADIO_MP3,
        "audio/mpeg",
        "\"iptv-mock-radio\"",
    )
}

async fn sample_mp4(headers: HeaderMap) -> Response {
    media::serve_static(
        &headers,
        media::SAMPLE_MP4,
        "video/mp4",
        "\"iptv-mock-sample-mp4\"",
    )
}

async fn sample_webm(headers: HeaderMap) -> Response {
    media::serve_static(
        &headers,
        media::SAMPLE_WEBM,
        "video/webm",
        "\"iptv-mock-sample-webm\"",
    )
}

async fn not_found(req: Request) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "not found", "path": req.uri().path() })),
    )
        .into_response()
}
