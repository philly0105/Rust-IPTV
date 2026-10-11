//! `GET /api/proxy?url=<enc>&sourceId=<id>`: streaming media proxy.
//!
//! Flow: validate the target ([`target`]), load the source's request headers
//! from `sources.config_json`, fetch with the client's `Range`/`If-Range`,
//! follow redirects manually (each hop re-validated), then either stream the
//! body through untouched (status, type, length, range headers preserved) or,
//! for HLS playlists, stream it through [`hls::HlsRewriter`].
//!
//! `ua`, `referer` and `origin` query parameters override the source's
//! headers (per-channel `#EXTVLCOPT` headers) and are carried into rewritten
//! playlists.
//!
//! Responses are served from the app's origin, so upstream content must never
//! run as a page: every response carries `Content-Security-Policy: sandbox;
//! default-src 'none'` and `nosniff`, and a content type outside the media
//! allowlist ([`is_media_type`]) is replaced by `application/octet-stream`
//! with `Content-Disposition: attachment`.

pub mod hls;
pub mod target;

use crate::api::error_response_with;
use crate::Server;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures::stream::{self, BoxStream, StreamExt};
use iptv_core::http::{
    backoff_delay, default_user_agent, status_error, CONNECT_TIMEOUT, HEADER_TIMEOUT, READ_TIMEOUT,
};
use iptv_core::model::RequestHeaders;
use iptv_core::{AppState, CoreResult, RpcError};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use std::io;
use std::sync::Arc;
use target::{find_blocked, Authority, NetGuard, TargetError};
use url::Url;

/// CSP of every proxy and file response: never a document with script.
pub const SANDBOX_CSP: &str = "sandbox; default-src 'none'";

/// Redirect hops followed per request.
pub const MAX_REDIRECTS: usize = 5;
/// Attempts for the initial upstream request (connect errors and timeouts only).
pub const ATTEMPTS: u32 = 3;
/// Bytes read before deciding whether an untyped response is a playlist.
const SNIFF_BYTES: usize = 16;

/// Proxy client and the guard policy (shared with the core's guarded client).
pub struct Proxy {
    client: reqwest::Client,
    guard: Arc<NetGuard>,
}

impl Proxy {
    pub fn new(guard: Arc<NetGuard>) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(default_user_agent())
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            // Redirects are followed by hand so every hop is validated.
            .redirect(reqwest::redirect::Policy::none())
            // Pass bytes through as-is: decompression would break Range and lengths.
            .gzip(false)
            .brotli(false)
            .dns_resolver(guard.resolver())
            .build()
            .expect("proxy HTTP client builds with static configuration");
        Self { client, guard }
    }
}

/// Query string of `/api/proxy`.
#[derive(Debug, Deserialize)]
pub struct ProxyQuery {
    pub url: Option<String>,
    #[serde(rename = "sourceId")]
    pub source_id: Option<String>,
    /// User-Agent override (per-channel headers).
    pub ua: Option<String>,
    /// Referer override.
    pub referer: Option<String>,
    /// Origin override.
    pub origin: Option<String>,
}

/// Source headers with the non-empty query overrides applied.
pub fn merge_headers(source: &RequestHeaders, q: &ProxyQuery) -> RequestHeaders {
    let pick = |o: &Option<String>, base: &Option<String>| {
        o.as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .or_else(|| base.clone())
    };
    RequestHeaders {
        user_agent: pick(&q.ua, &source.user_agent),
        referrer: pick(&q.referer, &source.referrer),
        origin: pick(&q.origin, &source.origin),
    }
}

/// What the proxy needs from a source row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SourceAccess {
    pub headers: RequestHeaders,
    /// `host:port` of the M3U URL, Xtream server or Stalker portal.
    pub authority: Option<Authority>,
}

/// Extracts headers and host from a `sources.config_json` value (C3).
pub fn source_access(kind: &str, config_json: &str) -> SourceAccess {
    let v: serde_json::Value = serde_json::from_str(config_json).unwrap_or_default();
    let headers = v
        .get("headers")
        .and_then(|h| serde_json::from_value(h.clone()).ok())
        .unwrap_or_default();
    SourceAccess {
        headers,
        authority: iptv_core::http::source_config_authority(kind, config_json),
    }
}

async fn load_source(app: &AppState, id: String) -> CoreResult<Option<SourceAccess>> {
    app.db_call(move |conn| {
        Ok(conn
            .query_row(
                "SELECT kind, config_json FROM sources WHERE id = ?1",
                [&id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
            .map(|(kind, json)| source_access(&kind, &json)))
    })
    .await
}

/// Error with its HTTP status.
struct Fail(StatusCode, RpcError);

impl Fail {
    fn coded(err: RpcError) -> Self {
        let status = StatusCode::from_u16(err.code.http_status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Self(status, err)
    }
}

impl From<TargetError> for Fail {
    fn from(e: TargetError) -> Self {
        match e {
            TargetError::Invalid(m) => Self::coded(RpcError::invalid(m)),
            TargetError::Forbidden(m) => Self(StatusCode::FORBIDDEN, RpcError::invalid(m)),
        }
    }
}

/// Route handler.
pub async fn handler(
    State(s): State<Server>,
    method: Method,
    headers: HeaderMap,
    Query(q): Query<ProxyQuery>,
) -> Response {
    let mut res = match proxy(&s, method, &headers, q).await {
        Ok(r) => r,
        Err(Fail(status, err)) => {
            tracing::debug!(%status, message = %err.message, "proxy request refused or failed");
            error_response_with(status, err)
        }
    };
    harden(&mut res);
    res
}

async fn proxy(
    s: &Server,
    method: Method,
    headers: &HeaderMap,
    q: ProxyQuery,
) -> Result<Response, Fail> {
    let raw = q
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| Fail::coded(RpcError::invalid("missing url query parameter")))?;
    let url = Url::parse(raw).map_err(|e| {
        Fail::coded(RpcError::invalid(format!(
            "url is not a valid absolute URL: {e}"
        )))
    })?;
    for (name, value) in [
        ("ua", &q.ua),
        ("referer", &q.referer),
        ("origin", &q.origin),
    ] {
        if value
            .as_deref()
            .is_some_and(|v| HeaderValue::from_str(v.trim()).is_err())
        {
            return Err(Fail::coded(RpcError::invalid(format!(
                "invalid header override: {name} contains characters that are not allowed in an HTTP header"
            ))));
        }
    }
    let source_id = q.source_id.clone().filter(|s| !s.trim().is_empty());

    let access = match &source_id {
        Some(id) => load_source(&s.app, id.clone())
            .await
            .map_err(|e| Fail::coded(e.into()))?
            .ok_or_else(|| Fail::coded(RpcError::not_found(format!("source {id} not found"))))?,
        None => SourceAccess::default(),
    };
    let trusted = access.authority.as_ref();
    if let Some(a) = trusted {
        s.proxy.guard.trust(a);
    }
    let headers_out = merge_headers(&access.headers, &q);

    // Playlists are rewritten whole; never ask for a slice of one.
    let path = url.path().to_ascii_lowercase();
    let forward_range = !(path.ends_with(".m3u8") || path.ends_with(".m3u"));

    let mut current = url;
    let mut hops = 0;
    let resp = loop {
        s.proxy.guard.check(&current, trusted).await?;
        let resp = send(s, &method, &current, &headers_out, headers, forward_range).await?;
        let location = resp
            .status()
            .is_redirection()
            .then(|| resp.headers().get(header::LOCATION))
            .flatten()
            .and_then(|l| l.to_str().ok())
            .and_then(|l| current.join(l).ok());
        match location {
            Some(next) if hops < MAX_REDIRECTS => {
                hops += 1;
                current = next;
            }
            Some(_) => {
                return Err(Fail::coded(RpcError::network(
                    "upstream redirected too many times",
                )))
            }
            None => break resp,
        }
    };

    let status = resp.status();
    if status.is_client_error() || status.is_server_error() {
        let err = RpcError::from(status_error(status, "upstream"))
            .with_details(serde_json::json!({ "upstreamStatus": status.as_u16() }));
        // 4xx pass through so players see 404/403/416; 5xx become 502.
        let code = if status.is_client_error() {
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
        } else {
            StatusCode::BAD_GATEWAY
        };
        return Err(Fail(code, err));
    }

    let params = [
        ("sourceId", source_id.as_deref().unwrap_or("")),
        ("ua", q.ua.as_deref().unwrap_or("").trim()),
        ("referer", q.referer.as_deref().unwrap_or("").trim()),
        ("origin", q.origin.as_deref().unwrap_or("").trim()),
    ];
    let rewriter = hls::HlsRewriter::with_params(current.clone(), &params);
    respond(resp, current, rewriter, method == Method::HEAD).await
}

/// Sends one request, retrying connect failures and timeouts with backoff.
async fn send(
    s: &Server,
    method: &Method,
    url: &Url,
    source_headers: &RequestHeaders,
    client_headers: &HeaderMap,
    forward_range: bool,
) -> Result<reqwest::Response, Fail> {
    let upstream_method = if *method == Method::HEAD {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };
    let mut attempt = 0;
    loop {
        let mut req = s.proxy.client.request(upstream_method.clone(), url.clone());
        req = iptv_core::http::apply_source_headers(req, source_headers);
        if forward_range {
            for name in [header::RANGE, header::IF_RANGE] {
                if let Some(v) = client_headers.get(&name) {
                    req = req.header(name, v.clone());
                }
            }
        }
        let host = url.host_str().unwrap_or("the stream server").to_owned();
        let sent = match tokio::time::timeout(HEADER_TIMEOUT, req.send()).await {
            Ok(r) => r,
            Err(_) if attempt + 1 < ATTEMPTS => {
                tokio::time::sleep(backoff_delay(attempt)).await;
                attempt += 1;
                continue;
            }
            Err(_) => {
                return Err(Fail::coded(RpcError::timeout(format!(
                    "{host} accepted the connection but did not answer within {} s. Check the stream address and that the server is online, then try again.",
                    HEADER_TIMEOUT.as_secs()
                ))))
            }
        };
        match sent {
            Ok(r) => return Ok(r),
            Err(e) => {
                if let Some(blocked) = find_blocked(&e) {
                    return Err(Fail(StatusCode::FORBIDDEN, RpcError::invalid(blocked.0)));
                }
                let transient = e.is_connect() || e.is_timeout();
                if transient && attempt + 1 < ATTEMPTS {
                    tokio::time::sleep(backoff_delay(attempt)).await;
                    attempt += 1;
                    continue;
                }
                let e = e.without_url();
                return Err(if e.is_timeout() {
                    Fail::coded(RpcError::timeout(format!(
                        "{host} did not respond in time. Check the stream address and that the server is online, then try again."
                    )))
                } else {
                    Fail::coded(RpcError::network(format!(
                        "Could not reach {host}. Check the address and that the server is online, then try again. ({e})"
                    )))
                });
            }
        }
    }
}

/// Headers copied from upstream for pass-through responses (the content
/// type goes through [`safe_content_type`]).
const PASS_HEADERS: [HeaderName; 7] = [
    header::CONTENT_LENGTH,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::LAST_MODIFIED,
    header::ETAG,
    header::CACHE_CONTROL,
    header::EXPIRES,
];

/// Content types the proxy passes through: media, playlists, manifests,
/// segments, keys (octet-stream) and images (channel logos).
pub fn is_media_type(ct: &str) -> bool {
    let essence = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("video/")
        || essence.starts_with("audio/")
        || essence.starts_with("image/")
        || matches!(
            essence.as_str(),
            "application/vnd.apple.mpegurl"
                | "application/x-mpegurl"
                | "application/dash+xml"
                | "application/octet-stream"
                | "application/x-mpegts"
        )
}

/// Upstream content type when it is a media type; otherwise
/// `application/octet-stream` and `true` (serve as an attachment).
pub fn safe_content_type(upstream: Option<&HeaderValue>) -> (HeaderValue, bool) {
    match upstream {
        Some(v) if v.to_str().is_ok_and(is_media_type) => (v.clone(), false),
        _ => (HeaderValue::from_static("application/octet-stream"), true),
    }
}

/// Adds the sandbox CSP and `nosniff` to a proxy or file response.
pub fn harden(res: &mut Response) {
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(SANDBOX_CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

fn is_generic_type(ct: &str) -> bool {
    let ct = ct.trim().to_ascii_lowercase();
    ct.is_empty()
        || ct.starts_with("text/plain")
        || ct.starts_with("text/html")
        || ct.starts_with("application/octet-stream")
        || ct.starts_with("binary/octet-stream")
}

async fn respond(
    resp: reqwest::Response,
    final_url: Url,
    rewriter: hls::HlsRewriter,
    head: bool,
) -> Result<Response, Fail> {
    let status = resp.status();
    let upstream = resp.headers().clone();
    let ct = upstream
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let path_says_playlist = final_url.path().to_ascii_lowercase().ends_with(".m3u8");
    let status_code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK);

    let mut body: BoxStream<'static, reqwest::Result<Bytes>> = resp.bytes_stream().boxed();
    let mut prefix: Vec<Bytes> = Vec::new();
    let playlist = if status_code == StatusCode::NOT_MODIFIED {
        false
    } else if hls::is_playlist_content_type(&ct) {
        true
    } else if is_generic_type(&ct) {
        if head {
            path_says_playlist
        } else {
            // Peek at the first bytes without losing them.
            let mut seen = 0;
            while seen < SNIFF_BYTES {
                match body.next().await {
                    Some(Ok(chunk)) => {
                        seen += chunk.len();
                        prefix.push(chunk);
                    }
                    Some(Err(e)) => {
                        return Err(Fail::coded(RpcError::network(format!(
                            "upstream body failed: {}",
                            e.without_url()
                        ))))
                    }
                    None => break,
                }
            }
            let head_bytes: Vec<u8> = prefix.iter().flat_map(|b| b.iter().copied()).collect();
            hls::looks_like_playlist(&head_bytes)
        }
    } else {
        false
    };

    let mut builder = Response::builder();
    let out = if playlist {
        // Never echo the upstream type: `text/html; x=mpegurl` would render
        // as HTML on the app origin.
        let ct_out = HeaderValue::from_static("application/vnd.apple.mpegurl");
        builder = builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, ct_out)
            .header(header::CACHE_CONTROL, "no-cache");
        let body = if head {
            Body::empty()
        } else {
            let input = stream::iter(prefix.into_iter().map(Ok)).chain(body).boxed();
            Body::from_stream(rewrite_stream(input, rewriter))
        };
        builder.body(body)
    } else {
        builder = builder.status(status_code);
        let (ct_out, attachment) = safe_content_type(upstream.get(header::CONTENT_TYPE));
        builder = builder.header(header::CONTENT_TYPE, ct_out);
        if attachment {
            builder = builder.header(header::CONTENT_DISPOSITION, "attachment");
        }
        for name in PASS_HEADERS {
            if let Some(v) = upstream.get(&name) {
                builder = builder.header(name, v.clone());
            }
        }
        let body = if head || status_code == StatusCode::NOT_MODIFIED {
            Body::empty()
        } else {
            let input = stream::iter(prefix.into_iter().map(Ok)).chain(body);
            Body::from_stream(input.map(|r| r.map_err(|e| io::Error::other(e.without_url()))))
        };
        builder.body(body)
    };
    out.map_err(|e| Fail::coded(RpcError::internal(format!("failed to build response: {e}"))))
}

fn rewrite_stream(
    input: BoxStream<'static, reqwest::Result<Bytes>>,
    rewriter: hls::HlsRewriter,
) -> impl futures::Stream<Item = io::Result<Bytes>> + Send + 'static {
    stream::unfold(Some((input, rewriter)), |state| async move {
        let (mut input, mut rw) = state?;
        loop {
            match input.next().await {
                Some(Ok(chunk)) => match rw.push(&chunk) {
                    Ok(out) if out.is_empty() => continue,
                    Ok(out) => return Some((Ok(out), Some((input, rw)))),
                    Err(e) => return Some((Err(e), None)),
                },
                Some(Err(e)) => return Some((Err(io::Error::other(e.without_url())), None)),
                None => {
                    let out = rw.finish();
                    return (!out.is_empty()).then_some((Ok(out), None));
                }
            }
        }
    })
}
