//! Loopback media proxy for desktop inline playback.
//!
//! The webview fetches streams directly, so per-playlist request headers
//! (User-Agent, Referer, Origin) never reach the server and plain `http:`
//! streams may be blocked. This serves `iptv-server`'s `/api/proxy` route
//! (same SSRF guard, header injection, Range pass-through, and HLS rewriting)
//! on `127.0.0.1:<random port>` inside the app process.
//!
//! It also serves the image cache route next to it (`/<token>/api/img`, the
//! same `iptv_server::img::handler` as server mode's `/api/img`): posters and
//! logos load from `data_dir/image-cache` after the first view, with
//! `X-Image-Cache: hit|miss` (exposed to the webview through CORS).
//!
//! Local recordings and downloads play from here too
//! (`/<token>/api/recordings/{id}/{name}` and `/<token>/api/files/{id}/{name}`,
//! server mode's `/api/recordings/{id}` and `/api/files/{id}` handlers):
//! `ServeFile` streams the file and honours Range, where the asset protocol
//! read a file requested without Range whole into memory. `recordings.playSource`
//! and `myvideos.playSource` return these URLs on desktop; `{name}` only
//! carries the file's extension for the player and is ignored.
//!
//! Hardening, since any local program or web page can reach a loopback port:
//! - `guard::api_guard` with the default `AllowedHosts`: the `Host` header
//!   must be `localhost`, a `*.localhost` name or an IP literal, which
//!   defeats DNS rebinding.
//! - Requests carrying an `Origin` must come from the app's own webview
//!   origin; CORS headers are sent only to that origin, so other pages
//!   cannot read proxied responses.
//! - `allow_private_targets` is on: the user's own LAN streams (a local
//!   tvheadend, a NAS) must play, exactly as they would in mpv.
//! - `allow_cross_site` is on: the webview's origin (`http://tauri.localhost`)
//!   is cross-site to `127.0.0.1`, and Edge/WebView2 sends
//!   `Sec-Fetch-Site: cross-site` on every `<img>`, `<video>` and `fetch` it
//!   makes here (measured), so server mode's refusal of that header would
//!   block the app itself. The token below does that job instead.
//! - Every request must carry the per-launch secret as its first path segment
//!   (`/<token>/api/proxy`, 403 otherwise). Only `app.info.proxyBase` reveals
//!   it, so a local program or a no-cors `<img>`/`<video>` request from a web
//!   page that finds the port cannot use the proxy. The HLS rewriter writes
//!   the token into the URIs of rewritten playlists
//!   (`ServerOptions::proxy_path`), so segment and key requests keep working
//!   and playlists still stream line by line.

use axum::extract::{Path, Request, State};
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
use iptv_server::{files, guard, img, proxy, recordings, Server, ServerOptions};
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

/// A fresh per-launch proxy secret (160 random bits, hex).
pub fn new_token() -> String {
    iptv_core::stalker::protocol::random_hex40()
}

/// Refuses requests without the per-launch token in the path.
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
    next.run(req).await
}

/// A completed download (server mode's `/api/files/{id}`); `name` is ignored.
async fn download_file(
    state: State<Server>,
    Path((id, _name)): Path<(String, String)>,
    req: Request,
) -> Response {
    files::handler(state, Path(id), req).await
}

/// A recording or a loose file in the recordings folder (server mode's
/// `/api/recordings/{id}`); `name` is ignored.
async fn recording_file(
    state: State<Server>,
    Path((id, _name)): Path<(String, String)>,
    req: Request,
) -> Response {
    recordings::handler(state, Path(id), req).await
}

/// The proxy-only router; every route sits under `/<token>/api`.
pub fn router(state: Arc<AppState>, token: &str) -> Router {
    let (events, _) = tokio::sync::broadcast::channel(1);
    // Default allowed hosts: loopback names and IP literals only. The webview
    // (`http://tauri.localhost`) is cross-site to `127.0.0.1`, so WebView2
    // sends `Sec-Fetch-Site: cross-site` on every request it makes here; the
    // token and `webview_origin_only` authenticate them instead.
    let opts = ServerOptions {
        allow_private_targets: true,
        allow_cross_site: true,
        proxy_path: format!("/{token}/api/proxy"),
        ..ServerOptions::new(std::path::PathBuf::new())
    };
    let server = Server::new(state, Arc::new(RpcRouter::new()), events, opts);
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|o: &HeaderValue, _| {
            origin_allowed(o.as_bytes())
        }))
        .allow_methods([Method::GET, Method::HEAD])
        .allow_headers([RANGE, HeaderName::from_static("if-range")])
        .expose_headers([
            CONTENT_RANGE,
            CONTENT_LENGTH,
            ACCEPT_RANGES,
            CONTENT_TYPE,
            img::X_IMAGE_CACHE,
        ]);
    let api = Router::new()
        .route("/proxy", get(proxy::handler))
        .route("/img", get(img::handler))
        .route("/files/{id}/{name}", get(download_file))
        .route("/recordings/{id}/{name}", get(recording_file))
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

/// Base URLs of the running proxy (both carry the same per-launch token).
pub struct ProxyBases {
    /// `http://127.0.0.1:<port>/<token>/api/proxy`: streams and local media.
    pub proxy: String,
    /// `http://127.0.0.1:<port>/<token>/api/img` on a second listener.
    /// Chromium opens at most 6 HTTP/1.1 connections per host and port, and
    /// a multiview wall of MPEG-TS tiles holds 4 of them open, so posters and
    /// logos get a port of their own.
    pub images: String,
}

/// Binds two `127.0.0.1:0` listeners and serves the proxy on both on the
/// Tauri runtime, with a fresh per-launch token.
pub fn start(state: Arc<AppState>) -> std::io::Result<ProxyBases> {
    let streams = bind_loopback()?;
    let images = bind_loopback()?;
    let port = streams.local_addr()?.port();
    let image_port = images.local_addr()?.port();
    let token = new_token();
    let app = router(state, &token);
    serve(streams, app.clone());
    serve(images, app);
    tracing::info!(port, image_port, "loopback media proxy listening");
    Ok(ProxyBases {
        proxy: format!("http://127.0.0.1:{port}/{token}/api/proxy"),
        images: format!("http://127.0.0.1:{image_port}/{token}/api/img"),
    })
}

fn bind_loopback() -> std::io::Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

fn serve(listener: std::net::TcpListener, app: Router) {
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
        call_with(app, origin, host, uri, &[]).await
    }

    async fn call_with(
        app: &Router,
        origin: Option<&str>,
        host: &str,
        uri: &str,
        headers: &[(&str, &str)],
    ) -> Response {
        use tower::ServiceExt;
        let mut req = axum::http::Request::builder().uri(uri).header("host", host);
        if let Some(o) = origin {
            req = req.header(ORIGIN, o);
        }
        for (name, value) in headers {
            req = req.header(*name, *value);
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

        // Only the proxy, image and local media routes exist.
        let r = call(&app, None, "127.0.0.1:1", &format!("/{T}/api/rpc/app.info")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn image_route_caches_behind_the_token_and_exposes_the_cache_header() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 2 3\"/>";
        let upstream = Router::new().route(
            "/poster.svg",
            get(move || async move { ([(CONTENT_TYPE, "image/svg+xml")], svg) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let (_dir, app) = app().await;
        let q = format!("url=http%3A%2F%2F127.0.0.1%3A{port}%2Fposter.svg");
        let path = format!("/{T}/api/img?{q}");
        for expected in ["miss", "hit"] {
            let r = call(&app, Some("http://tauri.localhost"), "127.0.0.1:1", &path).await;
            assert_eq!(r.status(), StatusCode::OK, "{expected}");
            assert_eq!(r.headers()[CONTENT_TYPE], "image/svg+xml");
            assert_eq!(r.headers()["x-image-cache"], expected);
            assert_eq!(r.headers()["content-security-policy"], proxy::SANDBOX_CSP);
            assert_eq!(
                r.headers()["access-control-allow-origin"],
                "http://tauri.localhost"
            );
            let exposed = r.headers()["access-control-expose-headers"]
                .to_str()
                .unwrap()
                .to_ascii_lowercase();
            assert!(exposed.contains("x-image-cache"), "{exposed}");
            let body = axum::body::to_bytes(r.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(body, svg.as_bytes());
        }

        // A no-cors <img> from the webview (no Origin) works too.
        let r = call(&app, None, "127.0.0.1:1", &path).await;
        assert_eq!(r.status(), StatusCode::OK);
        // Without the launch token, or from another page: refused.
        let r = call(&app, None, "127.0.0.1:1", &format!("/api/img?{q}")).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = call(&app, Some("https://evil.example"), "127.0.0.1:1", &path).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        // Bad URL: 400 from the handler.
        let r = call(&app, None, "127.0.0.1:1", &format!("/{T}/api/img?url=nope")).await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn cross_site_webview_requests_are_served_but_server_mode_refuses_them() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 2 3\"/>";
        let upstream = Router::new().route(
            "/poster.svg",
            get(move || async move { ([(CONTENT_TYPE, "image/svg+xml")], svg) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let q = format!("url=http%3A%2F%2F127.0.0.1%3A{port}%2Fposter.svg");
        let cross = [("sec-fetch-site", "cross-site")];

        // What WebView2 sends from http://tauri.localhost: a crossorigin
        // <img>/<video> or fetch (Origin) and a plain <img> (no Origin).
        let (_dir, app) = app().await;
        let img = format!("/{T}/api/img?{q}");
        for origin in [Some("http://tauri.localhost"), None] {
            let r = call_with(&app, origin, "127.0.0.1:1", &img, &cross).await;
            assert_eq!(r.status(), StatusCode::OK, "{origin:?}");
        }
        // The proxy route too: the handler answers (bad url -> 400), not the guard.
        let r = call_with(
            &app,
            Some("http://tauri.localhost"),
            "127.0.0.1:1",
            &format!("/{T}/api/proxy?url=not-a-url"),
            &cross,
        )
        .await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        // The token and origin checks still apply.
        let r = call_with(&app, None, "127.0.0.1:1", &format!("/api/img?{q}"), &cross).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = call_with(
            &app,
            Some("https://evil.example"),
            "127.0.0.1:1",
            &img,
            &cross,
        )
        .await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);

        // Server mode keeps refusing cross-site requests on the same route.
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(iptv_core::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        let (events, _) = tokio::sync::broadcast::channel(1);
        let mut opts = ServerOptions::new(dir.path().join("dist"));
        opts.allow_private_targets = true;
        let server =
            iptv_server::router(Server::new(state, Arc::new(RpcRouter::new()), events, opts));
        let path = format!("/api/img?{q}");
        let r = call_with(&server, None, "127.0.0.1:1", &path, &cross).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = call_with(&server, None, "127.0.0.1:1", &path, &[]).await;
        assert_eq!(r.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn local_recordings_stream_with_range_behind_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(iptv_core::events::NoopSink),
            true,
        )
        .await
        .unwrap();
        let folder = iptv_core::player::embedded::recordings_dir(&state);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("clip.ts"), b"0123456789").unwrap();
        // `recordings.library` id of a loose file: `f.` + the hex of its name.
        let id = "636c69702e7473";
        let app = router(state, T);
        let path = format!("/{T}/api/recordings/f.{id}/media.ts");

        // mpegts.js and <video> ask for ranges; only that slice is read.
        let r = call_with(
            &app,
            Some("http://tauri.localhost"),
            "127.0.0.1:1",
            &path,
            &[("range", "bytes=2-5")],
        )
        .await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[CONTENT_TYPE], "video/mp2t");
        assert_eq!(r.headers()[CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(
            r.headers()["access-control-allow-origin"],
            "http://tauri.localhost"
        );
        let body = axum::body::to_bytes(r.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"2345");

        // Without Range: the whole file, streamed with its length.
        let r = call(&app, None, "127.0.0.1:1", &path).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[CONTENT_LENGTH], "10");

        // Without the launch token: refused. An unknown download: 404.
        let bare = format!("/api/recordings/f.{id}/media.ts");
        let r = call(&app, None, "127.0.0.1:1", &bare).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let missing = format!("/{T}/api/files/999/media.ts");
        let r = call(&app, None, "127.0.0.1:1", &missing).await;
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
