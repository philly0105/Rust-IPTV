//! Loopback media proxy for desktop inline playback.
//!
//! The webview fetches streams directly, so per-playlist request headers
//! (User-Agent, Referer, Origin) never reach the server and plain `http:`
//! streams may be blocked. This serves `iptv-server`'s `/api/proxy` route
//! (same SSRF guard, header injection, Range pass-through, and HLS rewriting)
//! on `127.0.0.1:<random port>` inside the app process.
//!
//! Hardening, since any local program or web page can reach a loopback port:
//! - `loopback_host_only`: the `Host` header must be a loopback name, which
//!   defeats DNS rebinding.
//! - Requests carrying an `Origin` must come from the app's own webview
//!   origin; CORS headers are sent only to that origin, so other pages
//!   cannot read proxied responses.
//! - `allow_private_targets` is on: the user's own LAN streams (a local
//!   tvheadend, a NAS) must play, exactly as they would in mpv.
//! - Every request must carry the per-launch secret as its first path segment
//!   (`/<token>/api/proxy`, 403 otherwise). Only `app.info.proxyBase` reveals
//!   it, so a local program or a no-cors `<img>`/`<video>` request from a web
//!   page that finds the port cannot use the proxy. The HLS rewriter emits
//!   root-relative `/api/proxy?` URIs; `require_token` prefixes the token onto
//!   them so segment and key requests keep working.

use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{
    HeaderName, HeaderValue, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ORIGIN,
    RANGE,
};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use iptv_server::{guard, proxy, Server, ServerOptions};
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Origins the app's webview can have (production on Windows/Linux/macOS,
/// and the Vite dev server).
pub const WEBVIEW_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

fn origin_allowed(origin: &[u8]) -> bool {
    WEBVIEW_ORIGINS.iter().any(|o| o.as_bytes() == origin)
}

/// Refuses requests whose `Origin` is some other web page.
async fn webview_origin_only(req: Request, next: Next) -> Response {
    if let Some(origin) = req.headers().get(ORIGIN) {
        if !origin_allowed(origin.as_bytes()) {
            return (
                StatusCode::FORBIDDEN,
                "the media proxy only serves the Tsrust IPTV window",
            )
                .into_response();
        }
    }
    next.run(req).await
}

/// Largest rewritten playlist the token layer buffers (VOD playlists with
/// thousands of segments stay well under this).
const MAX_PLAYLIST_BYTES: usize = 32 * 1024 * 1024;

/// A fresh per-launch proxy secret (160 random bits, hex).
pub fn new_token() -> String {
    iptv_core::stalker::protocol::random_hex40()
}

/// Copies `haystack`, replacing every `needle` with `with`.
fn replace_all(haystack: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(haystack.len() + haystack.len() / 8);
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(needle) {
            out.extend_from_slice(with);
            i += needle.len();
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    out
}

/// Refuses requests without the per-launch token in the path and keeps the
/// token on the proxy URIs inside rewritten HLS playlists.
async fn require_token(token: Arc<str>, req: Request, next: Next) -> Response {
    let ok = req
        .uri()
        .path()
        .strip_prefix('/')
        .and_then(|p| p.strip_prefix(&*token))
        .is_some_and(|rest| rest.starts_with('/'));
    if !ok {
        return (StatusCode::FORBIDDEN, "missing or wrong media proxy token").into_response();
    }
    let resp = next.run(req).await;
    let playlist = resp
        .headers()
        .get(CONTENT_TYPE)
        .is_some_and(|ct| ct.as_bytes() == b"application/vnd.apple.mpegurl");
    if !playlist {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_PLAYLIST_BYTES).await {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(%err, "proxied playlist unreadable or too large");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let prefixed = format!("/{token}/api/proxy?");
    let out = replace_all(&bytes, b"/api/proxy?", prefixed.as_bytes());
    parts.headers.remove(CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(out))
}

/// The proxy-only router; every route sits under `/<token>/api`.
pub fn router(state: Arc<AppState>, token: &str) -> Router {
    let (events, _) = tokio::sync::broadcast::channel(1);
    // Default allowed hosts: loopback names and IP literals only.
    let opts = ServerOptions {
        allow_private_targets: true,
        ..ServerOptions::new(std::path::PathBuf::new())
    };
    let server = Server::new(state, Arc::new(RpcRouter::new()), events, opts);
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|o: &HeaderValue, _| {
            origin_allowed(o.as_bytes())
        }))
        .allow_methods([Method::GET, Method::HEAD])
        .allow_headers([RANGE, HeaderName::from_static("if-range")])
        .expose_headers([CONTENT_RANGE, CONTENT_LENGTH, ACCEPT_RANGES, CONTENT_TYPE]);
    let api =
        Router::new()
            .route("/proxy", get(proxy::handler))
            .layer(middleware::from_fn_with_state(
                server.clone(),
                guard::api_guard,
            ));
    let token: Arc<str> = Arc::from(token);
    Router::new()
        .nest(&format!("/{token}/api"), api)
        .with_state(server)
        .layer(middleware::from_fn(webview_origin_only))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            require_token(Arc::clone(&token), req, next)
        }))
        .layer(cors)
}

/// Binds `127.0.0.1:0` and serves the proxy on the Tauri runtime. Returns
/// the base URL (`http://127.0.0.1:<port>/<token>/api/proxy`) with a fresh
/// per-launch token.
pub fn start(state: Arc<AppState>) -> std::io::Result<String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = new_token();
    let app = router(state, &token);
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(err) => {
                tracing::error!(%err, "loopback proxy could not start");
                return;
            }
        };
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!(%err, "loopback proxy stopped");
        }
    });
    tracing::info!(port, "loopback media proxy listening");
    Ok(format!("http://127.0.0.1:{port}/{token}/api/proxy"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_webview_origins_are_allowed() {
        assert!(origin_allowed(b"http://tauri.localhost"));
        assert!(origin_allowed(b"tauri://localhost"));
        assert!(!origin_allowed(b"https://evil.example"));
        assert!(!origin_allowed(b"http://tauri.localhost.evil.example"));
        assert!(!origin_allowed(b"null"));
    }

    async fn call(app: &Router, origin: Option<&str>, host: &str, uri: &str) -> Response {
        use tower::ServiceExt;
        let mut req = axum::http::Request::builder().uri(uri).header("host", host);
        if let Some(o) = origin {
            req = req.header(ORIGIN, o);
        }
        app.clone()
            .oneshot(req.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap()
    }

    const T: &str = "0123456789abcdef0123456789abcdef01234567";

    async fn app() -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(iptv_core::events::NoopSink),
            true,
        )
        .await
        .unwrap();
        (dir, router(state, T))
    }

    #[test]
    fn tokens_are_fresh_hex() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 40);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn replace_all_prefixes_every_proxy_uri() {
        let out = replace_all(
            b"#EXTM3U
/api/proxy?url=a
URI=\"/api/proxy?url=k\"
",
            b"/api/proxy?",
            b"/T/api/proxy?",
        );
        assert_eq!(
            out,
            b"#EXTM3U
/T/api/proxy?url=a
URI=\"/T/api/proxy?url=k\"
"
            .to_vec()
        );
    }

    #[tokio::test]
    async fn guards_origin_host_and_sends_cors_only_to_the_webview() {
        let (_dir, app) = app().await;
        let p = |q: &str| format!("/{T}/api/proxy?{q}");

        // Another web page: refused outright.
        let r = call(
            &app,
            Some("https://evil.example"),
            "127.0.0.1:1",
            &p("url=http%3A%2F%2F127.0.0.1%3A9%2Fa.m3u8"),
        )
        .await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        assert!(r.headers().get("access-control-allow-origin").is_none());

        // DNS rebinding (non-loopback Host): refused by the server guard.
        let r = call(&app, None, "evil.example:1", &p("url=x")).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);

        // The webview: reaches the proxy handler (bad url -> 400) with CORS.
        let r = call(
            &app,
            Some("http://tauri.localhost"),
            "127.0.0.1:1",
            &p("url=not-a-url"),
        )
        .await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            r.headers().get("access-control-allow-origin").unwrap(),
            "http://tauri.localhost"
        );

        // Only the proxy route exists.
        let r = call(&app, None, "127.0.0.1:1", &format!("/{T}/api/rpc/app.info")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn requests_without_the_launch_token_are_refused() {
        let (_dir, app) = app().await;
        let q = "url=http%3A%2F%2F127.0.0.1%3A9%2Fa.m3u8&ua=X";
        for path in [
            format!("/api/proxy?{q}"),
            format!("/{}/api/proxy?{q}", "f".repeat(40)),
            format!("/{T}x/api/proxy?{q}"),
            format!("/{}/api/proxy?{q}", &T[..39]),
            format!("/{T}"),
        ] {
            // No Origin: a local program or a no-cors <img>/<video> request.
            let r = call(&app, None, "127.0.0.1:1", &path).await;
            assert_eq!(r.status(), StatusCode::FORBIDDEN, "{path}");
            // Even from the webview origin.
            let r = call(&app, Some("http://tauri.localhost"), "127.0.0.1:1", &path).await;
            assert_eq!(r.status(), StatusCode::FORBIDDEN, "{path}");
        }
    }

    #[tokio::test]
    async fn rewritten_playlists_keep_the_token_on_proxy_uris() {
        let upstream = Router::new().route(
            "/live.m3u8",
            get(|| async {
                (
                    [(CONTENT_TYPE, "application/vnd.apple.mpegurl")],
                    "#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"
#EXTINF:4,
seg1.ts
",
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let (_dir, app) = app().await;
        let target = format!("http%3A%2F%2F127.0.0.1%3A{port}%2Flive.m3u8");
        let r = call(
            &app,
            None,
            "127.0.0.1:1",
            &format!("/{T}/api/proxy?url={target}"),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        let body = axum::body::to_bytes(r.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        let uris: Vec<&str> = text.lines().filter(|l| l.contains("api/proxy?")).collect();
        assert_eq!(uris.len(), 2, "{text}");
        for line in uris {
            assert!(line.contains(&format!("/{T}/api/proxy?url=")), "{line}");
            assert!(
                !line.contains("\"/api/proxy?") && !line.starts_with("/api/proxy?"),
                "{line}"
            );
        }
    }
}
