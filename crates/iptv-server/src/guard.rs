//! Request guards for `/api` and response hardening headers.
//!
//! Server mode has no login, so the API must not be reachable from other web
//! origins in the user's browser:
//!
//! - State-changing requests and WebSocket upgrades carrying an `Origin` must
//!   come from the same host (blocks CSRF via `text/plain` form posts and
//!   cross-site WebSocket hijacking). `Sec-Fetch-Site: cross-site` is refused.
//! - When bound to loopback, the `Host` header must be a loopback name, which
//!   defeats DNS rebinding (`evil.example` resolving to 127.0.0.1).

use crate::api::error_response_with;
use crate::Server;
use axum::extract::{Request, State};
use axum::http::header::{HOST, ORIGIN, UPGRADE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use iptv_core::RpcError;
use std::net::IpAddr;

/// Middleware applied to every `/api` route.
pub async fn api_guard(State(s): State<Server>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = request_host(headers, req.uri());

    if s.opts.loopback_host_only && !is_loopback_host(host.unwrap_or("")) {
        return forbidden(
            "Host header is not a loopback name; open the app via localhost or 127.0.0.1",
        );
    }

    let state_changing = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let upgrade = headers.contains_key(UPGRADE);
    if state_changing || upgrade {
        if headers
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("cross-site"))
        {
            return forbidden("cross-site requests are not allowed");
        }
        if let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) {
            let forwarded = headers
                .get("x-forwarded-host")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(str::trim);
            let ok = host.is_some_and(|h| origin_matches_host(origin, h))
                || forwarded.is_some_and(|h| origin_matches_host(origin, h));
            if !ok {
                return forbidden("cross-origin requests are not allowed");
            }
        }
    }
    next.run(req).await
}

fn forbidden(msg: &str) -> Response {
    error_response_with(StatusCode::FORBIDDEN, RpcError::auth(msg))
}

/// `Host` header, or the URI authority for HTTP/2.
fn request_host<'a>(headers: &'a HeaderMap, uri: &'a axum::http::Uri) -> Option<&'a str> {
    headers
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| uri.authority().map(|a| a.as_str()))
}

/// Splits `host[:port]` / `[v6]:port` into a lowercase host and optional port.
pub fn split_host_port(authority: &str) -> (String, Option<u16>) {
    let authority = authority.trim();
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').unwrap_or((rest, ""));
        let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
        return (host.to_ascii_lowercase(), port);
    }
    match authority.rsplit_once(':') {
        // A bare IPv6 address has several colons and no port.
        Some((h, p)) if !h.contains(':') => (h.to_ascii_lowercase(), p.parse().ok()),
        _ => (authority.to_ascii_lowercase(), None),
    }
}

/// True for `localhost`, `*.localhost`, and loopback IP literals.
pub fn is_loopback_host(authority: &str) -> bool {
    let (host, _) = split_host_port(authority);
    let host = host.trim_end_matches('.');
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// True when the `Origin` (scheme://host[:port]) names the same host and port
/// as the request's `Host` header.
pub fn origin_matches_host(origin: &str, host_header: &str) -> bool {
    let Ok(origin) = url::Url::parse(origin) else {
        return false; // includes the opaque "null" origin
    };
    let Some(origin_host) = origin.host_str() else {
        return false;
    };
    let origin_host = origin_host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let Some(origin_port) = origin.port_or_known_default() else {
        return false;
    };
    let (host, port) = split_host_port(host_header);
    host == origin_host && port.unwrap_or(origin_port) == origin_port
}

/// Adds hardening headers to every response that lacks them.
pub async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.entry("x-content-type-options")
        .or_insert(HeaderValue::from_static("nosniff"));
    h.entry("x-frame-options")
        .or_insert(HeaderValue::from_static("SAMEORIGIN"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_port_split() {
        assert_eq!(
            split_host_port("LocalHost:7180"),
            ("localhost".into(), Some(7180))
        );
        assert_eq!(split_host_port("[::1]:80"), ("::1".into(), Some(80)));
        assert_eq!(split_host_port("::1"), ("::1".into(), None));
        assert_eq!(split_host_port("example.com"), ("example.com".into(), None));
    }

    #[test]
    fn loopback_hosts() {
        assert!(is_loopback_host("127.0.0.1:7180"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("app.localhost:5173"));
        assert!(is_loopback_host("[::1]:7180"));
        assert!(!is_loopback_host("evil.example:7180"));
        assert!(!is_loopback_host("192.168.1.5"));
    }

    #[test]
    fn origin_matching() {
        assert!(origin_matches_host(
            "http://localhost:7180",
            "localhost:7180"
        ));
        assert!(origin_matches_host("http://example.com", "example.com:80"));
        assert!(origin_matches_host("https://example.com", "example.com"));
        assert!(origin_matches_host("http://[::1]:7180", "[::1]:7180"));
        assert!(!origin_matches_host(
            "http://evil.example",
            "localhost:7180"
        ));
        assert!(!origin_matches_host(
            "http://localhost:5173",
            "localhost:7180"
        ));
        assert!(!origin_matches_host("null", "localhost:7180"));
    }
}
