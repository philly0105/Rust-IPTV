//! `/api/rpc/{cmd}`, `/api/events`, `/api/health`, and the API 404.

use crate::Server;
use axum::body::Bytes;
use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use iptv_core::events::AppEvent;
use iptv_core::{AppState, RpcError};
use std::time::Duration;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::{Instant, MissedTickBehavior};

/// Interval between server pings on an event socket.
pub const PING_INTERVAL: Duration = Duration::from_secs(20);
/// A socket that sends nothing (not even a pong) for this long is closed.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// A single frame that cannot be written within this time marks the client
/// as stuck; the socket is closed so the broadcast buffer is not pinned.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// Event sent to one client after it fell behind the broadcast buffer.
/// Payload: `{skipped: number}`. The UI should refetch what it shows.
pub const LAGGED_EVENT: &str = "events.lagged";

/// JSON error response with the C1 status mapping.
pub fn error_response(err: RpcError) -> Response {
    let status =
        StatusCode::from_u16(err.code.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    error_response_with(status, err)
}

/// JSON error response with an explicit status.
pub fn error_response_with(status: StatusCode, err: RpcError) -> Response {
    (status, Json(err)).into_response()
}

/// `GET /api/health -> {ok, version}`.
pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": AppState::version() }))
}

/// Any unknown `/api/*` route.
pub async fn not_found() -> Response {
    error_response(RpcError::not_found("unknown API route"))
}

/// `POST /api/rpc/{cmd}`: body is the JSON args (empty body means `null`).
pub async fn rpc(State(s): State<Server>, Path(cmd): Path<String>, body: Bytes) -> Response {
    let args = if body.iter().all(u8::is_ascii_whitespace) {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                return error_response(RpcError::invalid(format!(
                    "request body is not valid JSON: {e}"
                )))
            }
        }
    };
    if let Err(e) = server_policy(&s.app, &cmd, &args) {
        tracing::info!(%cmd, message = %e.message, "rpc refused in server mode");
        return error_response(e);
    }
    let started = Instant::now();
    let result = if cancels_on_disconnect(&cmd) {
        // Read-only: a superseded query the UI aborted stops its SQL.
        iptv_core::state::cancel_on_drop(s.rpc.dispatch(s.app.clone(), &cmd, args)).await
    } else {
        dispatch_detached(&s, cmd.clone(), args).await
    };
    let ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(v) => {
            tracing::debug!(%cmd, ms, "rpc ok");
            Json(v).into_response()
        }
        Err(e) => {
            // The message is safe to log; args (which may hold passwords) are not.
            tracing::info!(%cmd, ms, code = ?e.code, message = %e.message, "rpc error");
            error_response(e)
        }
    }
}

/// Read-only queries the UI supersedes and aborts while the user scrolls or
/// types (the guide grid above all). They run inline under
/// [`iptv_core::state::cancel_on_drop`]: when the client goes away, axum
/// drops the call and its SQLite statement is interrupted instead of running
/// on for nobody (L2-perf-desktop-6). Every other command, and every write,
/// runs detached ([`dispatch_detached`]).
pub const CANCEL_ON_DISCONNECT: &[&str] = &[
    "epg.grid",
    "epg.programs",
    "epg.search",
    "epg.nowNext",
    "epg.channelsSearch",
    "catalog.search",
    "catalog.channels",
    "catalog.movies",
    "catalog.series",
    "catalog.categories",
    "catalog.yearFacets",
];

/// True for a command in [`CANCEL_ON_DISCONNECT`].
pub fn cancels_on_disconnect(cmd: &str) -> bool {
    CANCEL_ON_DISCONNECT.contains(&cmd)
}

/// Runs one RPC on its own task and waits for it. Axum drops a handler's
/// future when the client goes away (a reload, Back, a closed tab); a call
/// awaited inline would stop at its next await point, so `sources.add` or
/// `sources.refresh` left a source with no catalog, no `lastError` and no
/// final progress event (L1-sources-home-3). On its own task the call
/// finishes (and emits its events) whatever the client does, as it does on
/// the desktop.
async fn dispatch_detached(
    s: &Server,
    cmd: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, RpcError> {
    let (rpc, app) = (s.rpc.clone(), s.app.clone());
    let task = tokio::spawn(async move { rpc.dispatch(app, &cmd, args).await });
    match task.await {
        Ok(result) => result,
        Err(err) => {
            tracing::error!(%err, "rpc task failed");
            Err(RpcError::internal("the request failed inside the server"))
        }
    }
}

/// Server-mode rules applied before dispatch. The browser must not make the
/// server read files by path or move where it writes:
///
/// - `sources.add` / `sources.update` with an m3u `origin: 'file'` or a
///   `file://` URL are refused (upload the playlist text instead);
/// - `settings.update` changing `downloadsDir` is refused (the folder is
///   `<data dir>/downloads`; `downloads.setDir` refuses in the core).
pub fn server_policy(app: &AppState, cmd: &str, args: &serde_json::Value) -> Result<(), RpcError> {
    match cmd {
        "sources.add" | "sources.update" => {
            let m3u = if cmd == "sources.add" {
                args.get("m3u")
            } else {
                args.get("patch").and_then(|p| p.get("m3u"))
            };
            let Some(m3u) = m3u else { return Ok(()) };
            let file_origin = m3u.get("origin").and_then(|o| o.as_str()) == Some("file");
            let file_url = m3u
                .get("url")
                .and_then(|u| u.as_str())
                .is_some_and(|u| u.trim().to_ascii_lowercase().starts_with("file:"));
            if file_origin || file_url {
                return Err(RpcError::unsupported(
                    iptv_core::m3u::importer::SERVER_FILE_MESSAGE,
                ));
            }
            Ok(())
        }
        "settings.update" => {
            let Some(next) = args.get("patch").and_then(|p| p.get("downloadsDir")) else {
                return Ok(());
            };
            let next = next.as_str().map(str::trim).filter(|d| !d.is_empty());
            let current = app.settings_snapshot().downloads_dir;
            let current = current.as_deref().map(str::trim).filter(|d| !d.is_empty());
            if next != current {
                return Err(RpcError::unsupported(
                    iptv_core::downloads::SERVER_DIR_MESSAGE,
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `GET /api/events`: upgrades to a WebSocket that receives every AppEvent.
pub async fn events(State(s): State<Server>, ws: WebSocketUpgrade) -> Response {
    if s.is_shutting_down() {
        return error_response_with(
            StatusCode::SERVICE_UNAVAILABLE,
            RpcError::internal("server is shutting down").retryable(true),
        );
    }
    let rx = s.events.subscribe();
    ws.on_upgrade(move |socket| forward_events(socket, rx, s))
}

/// Why an event socket ended (for logs).
#[derive(Debug)]
enum End {
    ClientClosed,
    SendFailed,
    SendTimedOut,
    Idle,
    Shutdown,
    ChannelClosed,
}

async fn send(socket: &mut WebSocket, msg: Message) -> Result<(), End> {
    match tokio::time::timeout(SEND_TIMEOUT, socket.send(msg)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(End::SendFailed),
        Err(_) => Err(End::SendTimedOut),
    }
}

async fn send_event(socket: &mut WebSocket, ev: &AppEvent) -> Result<(), End> {
    match serde_json::to_string(ev) {
        Ok(text) => send(socket, Message::Text(text.into())).await,
        Err(err) => {
            tracing::warn!(kind = %ev.kind, %err, "event failed to serialize; skipped");
            Ok(())
        }
    }
}

async fn forward_events(mut socket: WebSocket, mut rx: broadcast::Receiver<AppEvent>, s: Server) {
    tracing::debug!(clients = s.event_clients(), "event socket open");
    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_seen = Instant::now();
    let shutdown = s.shutdown_requested();
    tokio::pin!(shutdown);

    let end = loop {
        let step: Result<(), End> = tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) => send_event(&mut socket, &ev).await,
                Err(RecvError::Lagged(skipped)) => {
                    // Lag policy: keep the client, tell it what it missed so it can
                    // refetch; a client too slow to take a frame at all is dropped
                    // by SEND_TIMEOUT instead.
                    tracing::warn!(skipped, "event socket lagged behind the broadcast buffer");
                    let notice = AppEvent::new(LAGGED_EVENT, serde_json::json!({ "skipped": skipped }));
                    send_event(&mut socket, &notice).await
                }
                Err(RecvError::Closed) => Err(End::ChannelClosed),
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => Err(End::ClientClosed),
                // Pongs, pings (auto-answered by tungstenite) and client text all count as liveness.
                Some(Ok(_)) => {
                    last_seen = Instant::now();
                    Ok(())
                }
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > IDLE_TIMEOUT {
                    Err(End::Idle)
                } else {
                    send(&mut socket, Message::Ping(Bytes::from_static(b"ka"))).await
                }
            },
            _ = &mut shutdown => Err(End::Shutdown),
        };
        if let Err(end) = step {
            break end;
        }
    };

    let close = match end {
        End::Shutdown | End::ChannelClosed => Some((close_code::AWAY, "server shutting down")),
        End::Idle => Some((close_code::POLICY, "keepalive timeout")),
        End::SendTimedOut => Some((close_code::AGAIN, "client too slow")),
        End::ClientClosed | End::SendFailed => None,
    };
    if let Some((code, reason)) = close {
        let frame = CloseFrame {
            code,
            reason: reason.into(),
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            socket.send(Message::Close(Some(frame))),
        )
        .await;
    }
    tracing::debug!(reason = ?end, "event socket closed");
}
