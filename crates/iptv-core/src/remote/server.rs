//! HTTP side of the remote control: access guard (loopback, and LAN with
//! pairing sessions), embedded UI, JSON API.

use super::{hub, lan, pairing, RemoteChannel, RemoteHub, MAX_CHANNELS};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::connect_info::{ConnectInfo, MockConnectInfo};
use axum::extract::rejection::QueryRejection;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

/// The remote web UI: one self-contained HTML file (inline CSS and JS).
const INDEX_HTML: &str = include_str!("remote-ui/index.html");

/// Request bodies are tiny JSON objects.
const BODY_LIMIT: usize = 16 * 1024;

/// Largest channel number accepted by `channel/select`.
const MAX_CHANNEL_NUMBER: i64 = 999_999;

const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
connect-src 'self'; img-src 'self' data: http: https:; base-uri 'none'; form-action 'none'; \
frame-ancestors 'none'";

#[derive(Clone)]
struct Ctx {
    state: Arc<AppState>,
    hub: Arc<RemoteHub>,
    port: u16,
    /// LAN addresses this server listens on (empty: loopback only).
    lan: Arc<[Ipv4Addr]>,
}

/// Builds the remote control router for a server bound to `127.0.0.1:port`
/// only. Exposed for tests and for hosts that want to mount it elsewhere; the
/// guard compares `Origin` against this `port`.
pub fn router(state: Arc<AppState>, port: u16) -> Router {
    router_with_lan(state, port, Vec::new())
}

/// Like [`router`], for a server that also listens on `lan` (same port).
/// Requests from those addresses need a paired session. Tests mount this on a
/// loopback listener with `MockConnectInfo` to simulate LAN peers.
pub fn router_with_lan(state: Arc<AppState>, port: u16, lan: Vec<Ipv4Addr>) -> Router {
    let ctx = Ctx {
        hub: hub(&state),
        state,
        port,
        lan: lan.into(),
    };
    let api = Router::new()
        .route("/status", get(get_status))
        .route("/channels", get(get_channels))
        .route("/health", get(health))
        .route("/pair", post(pair))
        .route("/channel/up", post(channel_up))
        .route("/channel/down", post(channel_down))
        .route("/channel/select", post(channel_select))
        .route("/channel/select-id", post(channel_select_id))
        .route("/volume", post(volume))
        .route("/playback/toggle", post(playback_toggle))
        .route("/playback/stop", post(playback_stop))
        // Paths of the old IPTVnator remote API, kept so existing clients work.
        .route("/channel/select-number", post(channel_select))
        .route("/volume/up", post(volume_up))
        .route("/volume/down", post(volume_down))
        .route("/volume/toggle-mute", post(volume_toggle_mute));

    Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .nest("/api/remote-control", api)
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

/// True for `127.0.0.1`, `localhost` and `[::1]`, each with or without a
/// numeric port. Anything else (LAN addresses, other names, rebinding hosts)
/// is rejected.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let (name, port) = if let Some(rest) = host.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return false;
        };
        let after = &rest[end + 1..];
        let port = match after {
            "" => None,
            p => match p.strip_prefix(':') {
                Some(p) => Some(p),
                None => return false,
            },
        };
        if &rest[..end] != "::1" {
            return false;
        }
        return port.is_none_or(valid_port);
    } else {
        match host.split_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (host, None),
        }
    };
    let name_ok = name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost");
    name_ok && port.is_none_or(valid_port)
}

fn valid_port(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 5
        && p.bytes().all(|b| b.is_ascii_digit())
        && p.parse::<u16>().is_ok()
}

fn origin_allowed(origin: &str, port: u16) -> bool {
    origin == format!("http://127.0.0.1:{port}") || origin == format!("http://localhost:{port}")
}

/// Parses an IPv4-literal `Host` (`a.b.c.d` or `a.b.c.d:port`). Names, IPv6,
/// and odd forms (`0x7f.1`, leading zeros, trailing dots) return `None`.
fn parse_ipv4_host(host: &str) -> Option<(Ipv4Addr, Option<u16>)> {
    let (ip, port) = match host.split_once(':') {
        Some((ip, p)) => {
            if !valid_port(p) {
                return None;
            }
            (ip, Some(p.parse::<u16>().ok()?))
        }
        None => (host, None),
    };
    // `Ipv4Addr::from_str` accepts only four plain decimal octets.
    Some((ip.parse::<Ipv4Addr>().ok()?, port))
}

/// True when `host` is one of `lan` with the bound `port` (a missing port
/// means 80). This is the DNS-rebinding check for LAN requests: a rebinding
/// page sends its own domain name as `Host`, never our IP literal.
fn lan_host_ok(host: &str, port: u16, lan: &[Ipv4Addr]) -> bool {
    parse_ipv4_host(host.trim()).is_some_and(|(ip, p)| lan.contains(&ip) && p.unwrap_or(80) == port)
}

/// Which side of the guard a request came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    /// From this computer, to a loopback host.
    Loopback,
    /// From the local network, to one of our LAN addresses. Needs a session.
    Lan,
}

/// Why a request was refused (403).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    /// The peer is neither loopback nor a private LAN address (or unknown).
    Peer,
    /// `Host` is not acceptable for this peer.
    Host,
    /// `Origin` is present and foreign.
    Origin,
}

impl Denied {
    fn message(self) -> &'static str {
        match self {
            Denied::Peer => "requests are accepted only from this computer or, with LAN access on, from the local network",
            Denied::Host => "requests must use a loopback host (127.0.0.1 or localhost) or this computer's network address",
            Denied::Origin => "cross-origin requests are not allowed",
        }
    }
}

/// The access decision, as a pure function of the peer address, `Host`,
/// `Origin`, the bound port and the bound LAN addresses.
///
/// - Loopback peers must use a loopback `Host`; `Origin`, when present, must
///   be `http://127.0.0.1:{port}` or `http://localhost:{port}`.
/// - Other peers must be private IPv4 (RFC 1918 / link-local), LAN mode must
///   be listening (`lan` not empty), `Host` must be one of `lan` as an IP
///   literal with our port, and `Origin`, when present, must be `http://` plus
///   such a host. The caller then requires a paired session.
pub fn check_access(
    peer: Option<IpAddr>,
    host: Option<&str>,
    origin: Option<&str>,
    port: u16,
    lan: &[Ipv4Addr],
) -> Result<Zone, Denied> {
    let peer = peer.ok_or(Denied::Peer)?;
    let peer = match peer {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(peer, IpAddr::V4),
        v4 => v4,
    };
    if peer.is_loopback() {
        if !host.is_some_and(is_loopback_host) {
            return Err(Denied::Host);
        }
        if origin.is_some_and(|o| !origin_allowed(o, port)) {
            return Err(Denied::Origin);
        }
        return Ok(Zone::Loopback);
    }
    if lan.is_empty() || lan::lan_ipv4(peer).is_none() {
        return Err(Denied::Peer);
    }
    if !host.is_some_and(|h| lan_host_ok(h, port, lan)) {
        return Err(Denied::Host);
    }
    if let Some(o) = origin {
        let ok = o
            .strip_prefix("http://")
            .is_some_and(|h| lan_host_ok(h, port, lan));
        if !ok {
            return Err(Denied::Origin);
        }
    }
    Ok(Zone::Lan)
}

/// Request extension set by the guard.
#[derive(Debug, Clone, Copy)]
struct Peer {
    zone: Zone,
    ip: IpAddr,
}

/// Paths a LAN client may reach without a session: the page (it shows the
/// pairing screen) and the pairing exchange.
fn open_without_session(path: &str) -> bool {
    matches!(path, "/" | "/index.html" | "/api/remote-control/pair")
}

fn peer_addr(req: &Request) -> Option<SocketAddr> {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0)
        .or_else(|| {
            req.extensions()
                .get::<MockConnectInfo<SocketAddr>>()
                .map(|c| c.0)
        })
}

async fn guard(State(ctx): State<Ctx>, mut req: Request, next: Next) -> Response {
    let peer = peer_addr(&req).map(|a| a.ip());
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_owned()));
    // A non-UTF-8 Origin can never match.
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .map(|v| v.to_str().unwrap_or("\u{0}").to_owned());
    let zone = match check_access(peer, host.as_deref(), origin.as_deref(), ctx.port, &ctx.lan) {
        Ok(z) => z,
        Err(d) => {
            tracing::warn!(method = %req.method(), path = req.uri().path(), reason = ?d, "remote control: request rejected");
            return forbidden(d.message());
        }
    };
    if zone == Zone::Lan && !open_without_session(req.uri().path()) {
        // The device list could not be read (database busy at startup):
        // answer 503 and keep the phone's cookie rather than unpairing it.
        if super::load_sessions(&ctx.state).await.is_err() {
            return unavailable();
        }
        let cookie_header = req
            .headers()
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find_map(pairing::session_from_cookie)
            .map(str::to_owned);
        match cookie_header
            .as_deref()
            .and_then(|t| ctx.hub.touch_session(t))
        {
            None => return unpaired(cookie_header.is_some()),
            Some(true) => {
                let state = Arc::clone(&ctx.state);
                tokio::spawn(async move {
                    if let Err(err) = super::persist_sessions(&state).await {
                        tracing::warn!(%err, "remote control: cannot save device last-seen time");
                    }
                });
            }
            Some(false) => {}
        }
    }
    if let Some(ip) = peer {
        req.extensions_mut().insert(Peer { zone, ip });
    }
    let mut res = next.run(req).await;
    harden(res.headers_mut());
    res
}

/// 401 for a LAN request without a valid session. A stale cookie is cleared.
fn unpaired(had_cookie: bool) -> Response {
    let mut res = error(
        StatusCode::UNAUTHORIZED,
        "unpaired",
        "this phone is not paired; scan the QR code in Settings > Remote on the desktop app",
    );
    if had_cookie {
        for c in pairing::clear_cookies() {
            if let Ok(v) = HeaderValue::from_str(&c) {
                res.headers_mut().append(header::SET_COOKIE, v);
            }
        }
    }
    harden(res.headers_mut());
    res
}

/// 503 while the paired devices cannot be read. The cookie is kept.
fn unavailable() -> Response {
    let mut res = error(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "the app could not read its paired phones; try again in a moment",
    );
    res.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
    harden(res.headers_mut());
    res
}

fn harden(h: &mut HeaderMap) {
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
}

fn forbidden(message: &str) -> Response {
    let mut res = error(StatusCode::FORBIDDEN, "forbidden", message);
    harden(res.headers_mut());
    res
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PairBody {
    code: Option<String>,
}

async fn pair(
    State(ctx): State<Ctx>,
    peer: Option<Extension<Peer>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(Extension(peer)) = peer else {
        return forbidden(Denied::Peer.message());
    };
    if peer.zone == Zone::Loopback {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid",
            "pairing is only for phones on the local network; this computer needs none",
        );
    }
    let body: PairBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return bad_json(e),
    };
    let code = body.code.unwrap_or_default();
    if code.len() > 128 {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid",
            "pairing code is too long",
        );
    }
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // Pairing adds to the stored device list, so it must be loaded first.
    if super::load_sessions(&ctx.state).await.is_err() {
        return unavailable();
    }
    match ctx.hub.try_pair(peer.ip, &code, ua) {
        Err(wait) => {
            tracing::warn!("remote control: pairing rate limited");
            let secs = wait.as_secs().max(1);
            let mut res = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "rate_limited",
                    "message": format!("too many wrong codes; try again in {secs} s"),
                    "retryAfter": secs
                })),
            )
                .into_response();
            if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
                res.headers_mut().insert(header::RETRY_AFTER, v);
            }
            res
        }
        Ok(None) => {
            tracing::info!("remote control: pairing code refused");
            error(
                StatusCode::UNAUTHORIZED,
                "invalid_code",
                "this pairing code is wrong, used or expired; scan the current QR code in Settings > Remote",
            )
        }
        Ok(Some(token)) => {
            tracing::info!("remote control: phone paired");
            if let Err(err) = super::persist_sessions(&ctx.state).await {
                tracing::warn!(%err, "remote control: cannot save the paired device");
            }
            let mut res = Json(json!({ "ok": true })).into_response();
            if let Ok(v) = HeaderValue::from_str(&pairing::session_cookie(&token)) {
                res.headers_mut().insert(header::SET_COOKIE, v);
            }
            res
        }
    }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

async fn index() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, CSP),
        ],
        INDEX_HTML,
    )
        .into_response()
}

async fn not_found(method: Method) -> Response {
    if method == Method::GET || method == Method::HEAD {
        error(StatusCode::NOT_FOUND, "not_found", "no such page")
    } else {
        error(StatusCode::NOT_FOUND, "not_found", "no such endpoint")
    }
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

async fn get_status(State(ctx): State<Ctx>) -> Response {
    let mut v = match ctx.hub.status() {
        Some((status, at)) => {
            let mut v = serde_json::to_value(status).unwrap_or_else(|_| json!({}));
            v["updatedAt"] = Value::String(at);
            v
        }
        None => json!({ "isLive": false, "canVolume": false }),
    };
    let (channels, _) = ctx.hub.channels();
    v["channelCount"] = json!(channels.len());
    Json(v).into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ChannelsQuery {
    q: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

async fn get_channels(
    State(ctx): State<Ctx>,
    query: Result<Query<ChannelsQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(ChannelsQuery { q, offset, limit })) = query else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid",
            "offset and limit must be whole numbers",
        );
    };
    let (all, updated_at) = ctx.hub.channels();
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(MAX_CHANNELS).min(MAX_CHANNELS);
    let needle = q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let (total, page): (usize, Vec<&RemoteChannel>) = match needle {
        None => (all.len(), all.iter().skip(offset).take(limit).collect()),
        Some(needle) => {
            let lower = needle.to_lowercase();
            let digits = needle.bytes().all(|b| b.is_ascii_digit());
            let matches = |c: &&RemoteChannel| {
                c.name.to_lowercase().contains(&lower)
                    || (digits && c.number.is_some_and(|n| n.to_string().starts_with(needle)))
            };
            let total = all.iter().filter(matches).count();
            (
                total,
                all.iter()
                    .filter(matches)
                    .skip(offset)
                    .take(limit)
                    .collect(),
            )
        }
    };
    Json(json!({ "channels": page, "total": total, "updatedAt": updated_at })).into_response()
}

async fn health() -> Response {
    Json(json!({
        "app": "tsrust-iptv",
        "version": AppState::version(),
        "ready": true,
        "protocolVersion": 2
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `remote.command` payload (C1).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandEvent<'a> {
    command: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    level: Option<f64>,
}

impl CommandEvent<'_> {
    fn plain(command: &'static str) -> Self {
        Self {
            command,
            number: None,
            id: None,
            level: None,
        }
    }
}

fn emit(ctx: &Ctx, ev: CommandEvent<'_>) {
    tracing::debug!(command = ev.command, "remote control command");
    ctx.state.emit("remote.command", &ev);
}

fn accepted(commands: &[&str]) -> Response {
    Json(json!({ "ok": true, "commands": commands })).into_response()
}

/// Parses an optional JSON body; an empty body reads as `{}`.
fn parse_body<T: DeserializeOwned>(body: &Bytes) -> Result<T, serde_json::Error> {
    let text: &[u8] = if body.iter().all(u8::is_ascii_whitespace) {
        b"{}"
    } else {
        body
    };
    serde_json::from_slice(text)
}

fn bad_json(e: serde_json::Error) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "invalid",
        &format!("invalid JSON body: {e}"),
    )
}

async fn channel_up(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("channelUp"));
    accepted(&["channelUp"])
}

async fn channel_down(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("channelDown"));
    accepted(&["channelDown"])
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SelectNumberBody {
    number: Option<Value>,
}

/// Accepts a JSON integer or a numeric string.
fn as_channel_number(v: &Value) -> Option<i64> {
    let n = match v {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))?,
        Value::String(s) => s.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    (1..=MAX_CHANNEL_NUMBER).contains(&n).then_some(n)
}

async fn channel_select(State(ctx): State<Ctx>, body: Bytes) -> Response {
    let body: SelectNumberBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return bad_json(e),
    };
    let Some(number) = body.number.as_ref().and_then(as_channel_number) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid",
            &format!("number must be a whole channel number between 1 and {MAX_CHANNEL_NUMBER}"),
        );
    };
    emit(
        &ctx,
        CommandEvent {
            number: Some(number),
            ..CommandEvent::plain("selectNumber")
        },
    );
    accepted(&["selectNumber"])
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SelectIdBody {
    #[serde(alias = "channelId")]
    id: Option<String>,
}

async fn channel_select_id(State(ctx): State<Ctx>, body: Bytes) -> Response {
    let body: SelectIdBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return bad_json(e),
    };
    let id = body.id.as_deref().map(str::trim).unwrap_or_default();
    let well_formed = id.len() <= 1024
        && id
            .split_once('|')
            .is_some_and(|(s, i)| !s.is_empty() && !i.is_empty());
    if !well_formed {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid",
            "id must look like \"<sourceId>|<itemId>\"",
        );
    }
    let (channels, _) = ctx.hub.channels();
    if !channels.is_empty() && !channels.iter().any(|c| c.id == id) {
        return error(
            StatusCode::NOT_FOUND,
            "not_found",
            "that channel is not in the published list; open the live view on the desktop app and try again",
        );
    }
    emit(
        &ctx,
        CommandEvent {
            id: Some(id),
            ..CommandEvent::plain("selectId")
        },
    );
    accepted(&["selectId"])
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct VolumeBody {
    delta: Option<f64>,
    level: Option<f64>,
    mute: Option<bool>,
}

/// Volume levels are 0..1 (HTML media scale). Values in (1, 100] are read as
/// percentages so `{level: 40}` also works.
fn normalize_level(level: f64) -> Option<f64> {
    if !level.is_finite() || level < 0.0 {
        return None;
    }
    let l = if level > 1.0 { level / 100.0 } else { level };
    (l <= 1.0).then_some((l * 1000.0).round() / 1000.0)
}

async fn volume(State(ctx): State<Ctx>, body: Bytes) -> Response {
    let body: VolumeBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return bad_json(e),
    };
    if body.delta.is_none() && body.level.is_none() && body.mute.is_none() {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid",
            "send at least one of delta, level, or mute",
        );
    }
    let level = match body.level {
        None => None,
        Some(l) => match normalize_level(l) {
            Some(l) => Some(l),
            None => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid",
                    "level must be between 0 and 1 (or 0 and 100 as a percentage)",
                )
            }
        },
    };
    if body.delta.is_some_and(|d| !d.is_finite()) {
        return error(StatusCode::BAD_REQUEST, "invalid", "delta must be a number");
    }

    let mut sent: Vec<&str> = Vec::new();
    if let Some(level) = level {
        emit(
            &ctx,
            CommandEvent {
                level: Some(level),
                ..CommandEvent::plain("setVolume")
            },
        );
        sent.push("setVolume");
    } else if let Some(delta) = body.delta {
        let cmd = if delta > 0.0 {
            Some("volumeUp")
        } else if delta < 0.0 {
            Some("volumeDown")
        } else {
            None
        };
        if let Some(cmd) = cmd {
            emit(&ctx, CommandEvent::plain(cmd));
            sent.push(cmd);
        }
    }
    if let Some(want_muted) = body.mute {
        // `mute` toggles in the player. Skip it when the last reported status
        // already matches, so `{mute: true}` is idempotent.
        let is_muted = ctx.hub.status().and_then(|(s, _)| s.muted);
        if is_muted != Some(want_muted) {
            emit(&ctx, CommandEvent::plain("mute"));
            sent.push("mute");
        }
    }
    accepted(&sent)
}

async fn playback_toggle(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("togglePlay"));
    accepted(&["togglePlay"])
}

async fn playback_stop(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("stop"));
    accepted(&["stop"])
}

async fn volume_up(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("volumeUp"));
    accepted(&["volumeUp"])
}

async fn volume_down(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("volumeDown"));
    accepted(&["volumeDown"])
}

async fn volume_toggle_mute(State(ctx): State<Ctx>) -> Response {
    emit(&ctx, CommandEvent::plain("mute"));
    accepted(&["mute"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts() {
        for ok in [
            "127.0.0.1",
            "127.0.0.1:7310",
            "localhost",
            "LOCALHOST:80",
            "[::1]",
            "[::1]:7310",
        ] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in [
            "",
            "192.168.1.5",
            "192.168.1.5:7310",
            "127.0.0.2",
            "localhost.evil.example",
            "evil.example",
            "127.0.0.1:",
            "127.0.0.1:99999",
            "127.0.0.1:80:80",
            "[::1",
            "[::1]x",
            "[::2]:80",
            "localhost:abc",
            "0.0.0.0",
        ] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
    }

    #[test]
    fn origins() {
        assert!(origin_allowed("http://127.0.0.1:7310", 7310));
        assert!(origin_allowed("http://localhost:7310", 7310));
        assert!(!origin_allowed("http://localhost:7311", 7310));
        assert!(!origin_allowed("https://127.0.0.1:7310", 7310));
        assert!(!origin_allowed("null", 7310));
        assert!(!origin_allowed("http://evil.example", 7310));
    }

    #[test]
    fn access_decisions() {
        let lan = [Ipv4Addr::new(192, 168, 1, 5), Ipv4Addr::new(10, 0, 0, 7)];
        let ip = |s: &str| Some(s.parse::<IpAddr>().unwrap());
        let p = 7310;
        // Loopback peer: unchanged rules, LAN mode or not.
        for l in [&lan[..], &[]] {
            assert_eq!(
                check_access(ip("127.0.0.1"), Some("127.0.0.1:7310"), None, p, l),
                Ok(Zone::Loopback)
            );
            assert_eq!(
                check_access(
                    ip("::1"),
                    Some("[::1]:7310"),
                    Some("http://localhost:7310"),
                    p,
                    l
                ),
                Ok(Zone::Loopback)
            );
            assert_eq!(
                check_access(ip("127.0.0.1"), Some("192.168.1.5:7310"), None, p, l),
                Err(Denied::Host)
            );
            assert_eq!(
                check_access(
                    ip("127.0.0.1"),
                    Some("localhost"),
                    Some("http://evil.example"),
                    p,
                    l
                ),
                Err(Denied::Origin)
            );
            assert_eq!(
                check_access(ip("127.0.0.1"), None, None, p, l),
                Err(Denied::Host)
            );
        }
        // LAN peer, LAN mode on.
        assert_eq!(
            check_access(ip("192.168.1.20"), Some("192.168.1.5:7310"), None, p, &lan),
            Ok(Zone::Lan)
        );
        assert_eq!(
            check_access(
                ip("10.0.0.9"),
                Some("10.0.0.7:7310"),
                Some("http://10.0.0.7:7310"),
                p,
                &lan
            ),
            Ok(Zone::Lan)
        );
        assert_eq!(
            check_access(
                ip("::ffff:192.168.1.20"),
                Some("192.168.1.5:7310"),
                None,
                p,
                &lan
            ),
            Ok(Zone::Lan)
        );
        // LAN mode off: LAN peers are refused outright.
        assert_eq!(
            check_access(ip("192.168.1.20"), Some("192.168.1.5:7310"), None, p, &[]),
            Err(Denied::Peer)
        );
        // Public, CGNAT, unknown peers.
        for peer in ["8.8.8.8", "100.64.1.1", "2001:db8::1", "fe80::1"] {
            assert_eq!(
                check_access(ip(peer), Some("192.168.1.5:7310"), None, p, &lan),
                Err(Denied::Peer),
                "{peer}"
            );
        }
        assert_eq!(
            check_access(None, Some("127.0.0.1"), None, p, &lan),
            Err(Denied::Peer)
        );
        // Rebinding and wrong hosts.
        for h in [
            "evil.example",
            "evil.example:7310",
            "localhost:7310",
            "127.0.0.1:7310",
            "192.168.1.6:7310",
            "192.168.1.5:7311",
            "192.168.1.5",
            "192.168.1.5:",
            "192.168.001.5:7310",
            "3232235781:7310",
            "0xc0a80105:7310",
            "[::ffff:192.168.1.5]:7310",
            "192.168.1.5.:7310",
        ] {
            assert_eq!(
                check_access(ip("192.168.1.20"), Some(h), None, p, &lan),
                Err(Denied::Host),
                "{h}"
            );
        }
        assert_eq!(
            check_access(ip("192.168.1.20"), None, None, p, &lan),
            Err(Denied::Host)
        );
        // Origins.
        for o in [
            "null",
            "http://evil.example",
            "https://192.168.1.5:7310",
            "http://192.168.1.5:7311",
            "http://192.168.1.5",
            "http://localhost:7310",
            "http://192.168.1.5:7310/",
        ] {
            assert_eq!(
                check_access(
                    ip("192.168.1.20"),
                    Some("192.168.1.5:7310"),
                    Some(o),
                    p,
                    &lan
                ),
                Err(Denied::Origin),
                "{o}"
            );
        }
        // Port 80 servers may omit the port.
        assert_eq!(
            check_access(
                ip("192.168.1.20"),
                Some("192.168.1.5"),
                Some("http://192.168.1.5"),
                80,
                &lan
            ),
            Ok(Zone::Lan)
        );
    }

    #[test]
    fn open_paths() {
        assert!(open_without_session("/"));
        assert!(open_without_session("/api/remote-control/pair"));
        assert!(!open_without_session("/api/remote-control/status"));
        assert!(!open_without_session("/api/remote-control/pair/x"));
    }

    #[test]
    fn numbers_and_levels() {
        assert_eq!(as_channel_number(&json!(12)), Some(12));
        assert_eq!(as_channel_number(&json!("7")), Some(7));
        assert_eq!(as_channel_number(&json!(3.0)), Some(3));
        assert_eq!(as_channel_number(&json!(3.5)), None);
        assert_eq!(as_channel_number(&json!(0)), None);
        assert_eq!(as_channel_number(&json!(-4)), None);
        assert_eq!(as_channel_number(&json!(null)), None);
        assert_eq!(normalize_level(0.5), Some(0.5));
        assert_eq!(normalize_level(40.0), Some(0.4));
        assert_eq!(normalize_level(1.0), Some(1.0));
        assert_eq!(normalize_level(101.0), None);
        assert_eq!(normalize_level(-0.1), None);
        assert_eq!(normalize_level(f64::NAN), None);
    }
}
