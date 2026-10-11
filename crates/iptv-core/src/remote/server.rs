//! HTTP side of the remote control: loopback guard, embedded UI, JSON API.

use super::{hub, RemoteChannel, RemoteHub, MAX_CHANNELS};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::rejection::QueryRejection;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
}

/// Builds the remote control router for a server bound to `127.0.0.1:port`.
/// Exposed for tests and for hosts that want to mount it elsewhere; the
/// loopback guard compares `Origin` against this `port`.
pub fn router(state: Arc<AppState>, port: u16) -> Router {
    let ctx = Ctx {
        hub: hub(&state),
        state,
        port,
    };
    let api = Router::new()
        .route("/status", get(get_status))
        .route("/channels", get(get_channels))
        .route("/health", get(health))
        .route("/channel/up", post(channel_up))
        .route("/channel/down", post(channel_down))
        .route("/channel/select", post(channel_select))
        .route("/channel/select-id", post(channel_select_id))
        .route("/volume", post(volume))
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
// Loopback guard
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

async fn guard(State(ctx): State<Ctx>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_owned()));
    let host_ok = host.as_deref().is_some_and(is_loopback_host);
    if !host_ok {
        tracing::warn!(method = %req.method(), path = req.uri().path(), "remote control: rejected non-loopback Host");
        return forbidden("requests must use a loopback host (127.0.0.1 or localhost)");
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let ok = origin.to_str().is_ok_and(|o| origin_allowed(o, ctx.port));
        if !ok {
            tracing::warn!(method = %req.method(), path = req.uri().path(), "remote control: rejected foreign Origin");
            return forbidden("cross-origin requests are not allowed");
        }
    }
    let mut res = next.run(req).await;
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
