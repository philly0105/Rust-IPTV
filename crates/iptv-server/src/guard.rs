//! Request guards for `/api` and response hardening headers.
//!
//! Server mode has no login, so the API must not be reachable from other web
//! origins in the user's browser:
//!
//! - State-changing requests and WebSocket upgrades carrying an `Origin` must
//!   come from the same host (blocks CSRF via `text/plain` form posts and
//!   cross-site WebSocket hijacking). `Sec-Fetch-Site: cross-site` is refused.
//! - The `Host` header must be an allowed name ([`AllowedHosts`]) whatever
//!   the bind address, which defeats DNS rebinding (`evil.example` resolving
//!   to 127.0.0.1 or to the server's LAN address). IP literals are always
//!   accepted: a page can only reach the server under an IP literal when the
//!   user opened it there, so the browser treats it as its own origin.

use crate::api::error_response_with;
use crate::Server;
use axum::extract::{Request, State};
use axum::http::header::{HOST, ORIGIN, UPGRADE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use iptv_core::RpcError;
use std::net::IpAddr;

/// CSP of the app's own responses (the SPA). Proxy and file responses carry
/// [`crate::proxy::SANDBOX_CSP`] instead.
pub const SITE_CSP: &str = "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' blob: data: https: http:; connect-src 'self' ws: wss: https: http:; frame-src https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

/// Host names the `Host` header of an `/api` request may carry.
///
/// Always allowed: `localhost`, `*.localhost` and every IP literal. Extra
/// names come from `--allowed-hosts` / `IPTV_ALLOWED_HOSTS` (comma list; `*`
/// turns the check off) and, when the server binds beyond loopback, the
/// machine's host name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowedHosts {
    names: Vec<String>,
    any: bool,
}

impl AllowedHosts {
    /// Parses a comma-separated list (`tv.example.com, nas.local`, or `*`).
    /// Ports are ignored; only the host part is compared.
    pub fn parse(list: &str) -> Self {
        let mut out = Self::default();
        for item in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if item == "*" {
                out.any = true;
            } else {
                out.add(item);
            }
        }
        out
    }

    /// Adds one host name.
    pub fn add(&mut self, name: &str) {
        let (host, _) = split_host_port(name);
        let host = host.trim_end_matches('.').to_owned();
        if !host.is_empty() && !self.names.contains(&host) {
            self.names.push(host);
        }
    }

    /// True when the check is off (`*`).
    pub fn allows_any(&self) -> bool {
        self.any
    }

    /// Extra names (beyond loopback and IP literals).
    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// True when a request with this `Host` header may use the API.
    pub fn allows(&self, authority: &str) -> bool {
        if self.any || is_loopback_host(authority) {
            return true;
        }
        let (host, _) = split_host_port(authority);
        let host = host.trim_end_matches('.');
        !host.is_empty() && (host.parse::<IpAddr>().is_ok() || self.names.iter().any(|n| n == host))
    }

    /// Adds this machine's host name (and its `.local` mDNS form), read from
    /// `HOSTNAME`, `COMPUTERNAME` or `/etc/hostname`.
    pub fn add_machine_hostname(&mut self) {
        let name = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .ok()
            .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
            .map(|n| n.trim().to_ascii_lowercase())
            .filter(|n| !n.is_empty());
        if let Some(n) = name {
            self.add(&format!("{n}.local"));
            self.add(&n);
        }
    }
}

/// Middleware applied to every `/api` route.
pub async fn api_guard(State(s): State<Server>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = request_host(headers, req.uri());

    if !s.opts.allowed_hosts.allows(host.unwrap_or("")) {
        return forbidden(
            "This host name is not allowed. Open the app via localhost or the server's IP address, or add the name to --allowed-hosts (IPTV_ALLOWED_HOSTS) on the server.",
        );
    }

    // Every method: GET routes (`/api/proxy`, `/api/files/{id}`) would
    // otherwise let any web page embed them (`<video src=...>`) to probe the
    // library or use the proxy as a relay. Browsers that predate
    // Sec-Fetch-Site still get the Origin check below on state changes.
    if headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("cross-site"))
    {
        return forbidden("cross-site requests are not allowed");
    }
    let state_changing = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let upgrade = headers.contains_key(UPGRADE);
    if state_changing || upgrade {
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

/// Adds hardening headers to every response that lacks them, including the
/// site CSP (proxy and file responses already carry the sandbox CSP).
pub async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.entry("x-content-type-options")
        .or_insert(HeaderValue::from_static("nosniff"));
    h.entry("x-frame-options")
        .or_insert(HeaderValue::from_static("SAMEORIGIN"));
    h.entry("content-security-policy")
        .or_insert(HeaderValue::from_static(SITE_CSP));
    h.entry("referrer-policy")
        .or_insert(HeaderValue::from_static("same-origin"));
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
    fn allowed_hosts() {
        let none = AllowedHosts::default();
        assert!(none.allows("localhost:7180"));
        assert!(none.allows("127.0.0.1:7180"));
        assert!(none.allows("192.168.1.20:7180"));
        assert!(none.allows("[fd00::1]:7180"));
        assert!(!none.allows("rebind.evil.example:7180"));
        assert!(!none.allows(""));

        let list = AllowedHosts::parse(" TV.Example.com:443 , nas.local ,");
        assert_eq!(list.names(), ["tv.example.com", "nas.local"]);
        assert!(list.allows("tv.example.com"));
        assert!(list.allows("NAS.local.:7180"));
        assert!(!list.allows("example.com"));

        assert!(AllowedHosts::parse("*").allows("anything.example"));
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
