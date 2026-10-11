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

/// The proxy-only router.
pub fn router(state: Arc<AppState>) -> Router {
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
    Router::new()
        .nest("/api", api)
        .with_state(server)
        .layer(middleware::from_fn(webview_origin_only))
        .layer(cors)
}

/// Binds `127.0.0.1:0` and serves the proxy on the Tauri runtime. Returns
/// the base URL (`http://127.0.0.1:<port>/api/proxy`).
pub fn start(state: Arc<AppState>) -> std::io::Result<String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let app = router(state);
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
    Ok(format!("http://127.0.0.1:{port}/api/proxy"))
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

    #[tokio::test]
    async fn guards_origin_host_and_sends_cors_only_to_the_webview() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(iptv_core::events::NoopSink),
            true,
        )
        .await
        .unwrap();
        let app = router(state);

        // Another web page: refused outright.
        let r = call(
            &app,
            Some("https://evil.example"),
            "127.0.0.1:1",
            "/api/proxy?url=http%3A%2F%2F127.0.0.1%3A9%2Fa.m3u8",
        )
        .await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        assert!(r.headers().get("access-control-allow-origin").is_none());

        // DNS rebinding (non-loopback Host): refused by the server guard.
        let r = call(&app, None, "evil.example:1", "/api/proxy?url=x").await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);

        // The webview: reaches the proxy handler (bad url -> 400) with CORS.
        let r = call(
            &app,
            Some("http://tauri.localhost"),
            "127.0.0.1:1",
            "/api/proxy?url=not-a-url",
        )
        .await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            r.headers().get("access-control-allow-origin").unwrap(),
            "http://tauri.localhost"
        );

        // Only the proxy route exists.
        let r = call(&app, None, "127.0.0.1:1", "/api/rpc/app.info").await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }
}
