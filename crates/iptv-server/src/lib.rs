//! Tsrust IPTV server mode (SPEC C12).
//!
//! Hosts the same core as the desktop shell behind HTTP so the UI runs as a
//! self-hosted PWA:
//!
//! - `POST /api/rpc/{cmd}`: JSON RPC with the C1 status mapping.
//! - `GET /api/events`: WebSocket broadcast of [`AppEvent`]s with ping/pong
//!   keepalive and a per-client lag policy.
//! - `GET /api/health`: `{ok, version}`.
//! - `GET /api/proxy?url=&sourceId=[&ua=&referer=&origin=]`: streaming media
//!   proxy that injects the source's (or the overridden) request headers,
//!   passes Range through, refuses private targets, rewrites HLS playlists so
//!   every URI goes back through the proxy, and serves only media types
//!   (anything else as a sandboxed attachment).
//! - `GET /api/files/{downloadId}`: Range-capable serving of completed downloads.
//! - `GET /api/img?url=&sourceId=`: posters, logos and backdrops through the
//!   core's disk image cache ([`img`]), with `X-Image-Cache: hit|miss`, a
//!   week of browser caching and the same sandbox headers as the proxy.
//! - Everything else: the built UI (`dist/`) with SPA fallback and cache headers.
//!
//! RPC replies and the built UI are compressed for clients that accept it
//! ([`compression`]: brotli or gzip at level 4, bodies of 1 KiB or more;
//! precompressed `.br`/`.gz` files next to the assets win when present).
//! The event socket, the media proxy, downloads, recordings and images are
//! never compressed: they are streams, ranges or already-compressed media.
//!
//! The binary (`main.rs`) parses the CLI and calls [`router`]; integration
//! tests build a [`Server`] directly.

pub mod api;
pub mod files;
pub mod guard;
pub mod img;
pub mod proxy;
// recording:
pub mod recordings;
pub mod static_files;

use axum::extract::DefaultBodyLimit;
use axum::handler::Handler;
use axum::http::Request;
use axum::middleware;
use axum::routing::{any, get, post};
use axum::Router;
use iptv_core::events::AppEvent;
use iptv_core::http::NetGuard;
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, watch};
use tower_http::compression::predicate::{NotForContentType, Predicate, SizeAbove};
use tower_http::compression::{CompressionLayer, CompressionLevel, DefaultPredicate};
use tower_http::trace::{DefaultOnFailure, DefaultOnResponse, TraceLayer};
use tower_http::LatencyUnit;
use tracing::Level;

/// Default listening port (C12).
pub const DEFAULT_PORT: u16 = 7180;
/// Capacity of the event broadcast channel. A WebSocket client that falls
/// further behind than this is told how many events it missed.
pub const EVENT_CAPACITY: usize = 1024;
/// Max request body for `/api/rpc` (backup imports and pasted playlists are large).
pub const BODY_LIMIT: usize = 256 * 1024 * 1024;
/// Smallest reply body worth compressing.
pub const COMPRESS_MIN_BYTES: u16 = 1024;
/// Brotli and gzip level: about 9x smaller JSON for a fraction of a
/// millisecond per 100 KB (level 11 costs tens of ms for a few % more).
pub const COMPRESS_LEVEL: i32 = 4;

/// Brotli/gzip for RPC replies and the built UI. Skipped for bodies under
/// [`COMPRESS_MIN_BYTES`], images (SVG aside), event streams, fonts (WOFF2
/// is already compressed), replies that carry a `Content-Encoding` (the
/// precompressed assets) and ranges.
pub fn compression() -> CompressionLayer<impl Predicate> {
    let when = DefaultPredicate::new()
        .and(SizeAbove::new(COMPRESS_MIN_BYTES))
        .and(NotForContentType::const_new("font/"))
        .and(NotForContentType::const_new("application/font-woff"));
    CompressionLayer::new()
        .quality(CompressionLevel::Precise(COMPRESS_LEVEL))
        .compress_when(when)
}

/// Runtime options that are not part of the core state.
#[derive(Debug, Clone)]
pub struct ServerOptions {
    /// Built UI directory (contains `index.html` and `assets/`).
    pub static_dir: PathBuf,
    /// Let `/api/proxy` and the core's fetches (downloads, playlists, XMLTV)
    /// reach loopback, private and link-local addresses for any source. Off
    /// by default; a source's own `host:port` is always reachable.
    pub allow_private_targets: bool,
    /// `Host` names accepted on `/api` besides loopback names and IP
    /// literals (blocks DNS rebinding whatever the bind address).
    pub allowed_hosts: guard::AllowedHosts,
    /// Skip [`guard::api_guard`]'s `Sec-Fetch-Site: cross-site` refusal. Only
    /// the desktop loopback proxy sets it: its webview (`http://tauri.localhost`)
    /// is cross-site to `127.0.0.1`, so Chromium labels every request it makes
    /// there `cross-site`, and the proxy authenticates requests with its
    /// per-launch path token and webview-origin check instead. Server mode
    /// keeps the refusal (off by default).
    pub allow_cross_site: bool,
}

impl ServerOptions {
    /// Options for serving `static_dir` with the secure defaults.
    pub fn new(static_dir: impl Into<PathBuf>) -> Self {
        Self {
            static_dir: static_dir.into(),
            allow_private_targets: false,
            allowed_hosts: guard::AllowedHosts::default(),
            allow_cross_site: false,
        }
    }
}

/// Shared state of every route.
#[derive(Clone)]
pub struct Server {
    pub app: Arc<AppState>,
    pub rpc: Arc<RpcRouter>,
    /// Sender behind the core's `BroadcastSink`; each WebSocket subscribes.
    pub events: broadcast::Sender<AppEvent>,
    pub proxy: Arc<proxy::Proxy>,
    pub opts: Arc<ServerOptions>,
    shutdown: Arc<watch::Sender<bool>>,
}

impl Server {
    /// Builds the server state. `events` must be the sender wrapped by the
    /// `BroadcastSink` handed to `AppState::new`. Installs server mode on
    /// the core ([`install_server_mode`]) unless the caller already did.
    pub fn new(
        app: Arc<AppState>,
        rpc: Arc<RpcRouter>,
        events: broadcast::Sender<AppEvent>,
        opts: ServerOptions,
    ) -> Self {
        let (shutdown, _) = watch::channel(false);
        let guard = install_server_mode(&app, opts.allow_private_targets);
        Self {
            proxy: Arc::new(proxy::Proxy::new(guard)),
            app,
            rpc,
            events,
            opts: Arc::new(opts),
            shutdown: Arc::new(shutdown),
        }
    }

    /// Signals long-lived handlers (event sockets) to close.
    pub fn begin_shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    /// True once [`Self::begin_shutdown`] ran.
    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// Resolves when shutdown begins.
    pub async fn shutdown_requested(&self) {
        let mut rx = self.shutdown.subscribe();
        // The sender lives as long as `self`, so `wait_for` cannot fail here.
        let _ = rx.wait_for(|v| *v).await;
    }

    /// Number of connected event sockets.
    pub fn event_clients(&self) -> usize {
        self.events.receiver_count()
    }
}

/// Marks `app` as running in server mode (guarded fetches, no file paths,
/// fixed downloads folder) and returns the SSRF guard shared with the proxy.
/// Idempotent; call it before `init_all` so restored downloads are guarded.
pub fn install_server_mode(app: &AppState, allow_private_targets: bool) -> Arc<NetGuard> {
    if let Some(mode) = iptv_core::http::server_mode(app) {
        return mode.guard.clone();
    }
    match iptv_core::http::ServerMode::install(app, allow_private_targets) {
        Some(mode) => mode.guard.clone(),
        // A desktop state (never in the binary): guard the proxy only.
        None => Arc::new(NetGuard::new(allow_private_targets)),
    }
}

/// Builds the full HTTP router.
pub fn router(server: Server) -> Router {
    let api = Router::new()
        .route("/rpc/{cmd}", post(api::rpc).layer(compression()))
        .route("/events", get(api::events))
        .route("/health", get(api::health))
        .route("/proxy", get(proxy::handler))
        .route("/files/{id}", get(files::handler))
        .route("/img", get(img::handler))
        // recording:
        .route("/recordings/{id}", get(recordings::handler))
        .route("/{*rest}", any(api::not_found))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(
            server.clone(),
            guard::api_guard,
        ));

    Router::new()
        .nest("/api", api)
        .fallback(static_files::handler.layer(compression()))
        .with_state(server)
        .layer(middleware::map_response(guard::security_headers))
        .layer(
            TraceLayer::new_for_http()
                // Path only: proxy query strings carry stream URLs with credentials.
                .make_span_with(|req: &Request<_>| {
                    tracing::info_span!("http", method = %req.method(), path = %req.uri().path())
                })
                .on_request(())
                .on_response(
                    DefaultOnResponse::new()
                        .level(Level::DEBUG)
                        .latency_unit(LatencyUnit::Millis),
                )
                .on_failure(DefaultOnFailure::new().level(Level::WARN)),
        )
}
