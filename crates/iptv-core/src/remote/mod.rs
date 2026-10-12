//! Loopback remote control (SPEC C4 remote section, check 10 / SC8).
//!
//! A small axum server bound to `127.0.0.1:{settings.remoteControl.port}` serves
//! the embedded remote web UI (`remote-ui/index.html`) and a JSON API under
//! `/api/remote-control/*`. Requests are accepted only with a loopback `Host`
//! and either no `Origin` or the server's own origin, so other web pages (and
//! DNS-rebinding attacks) cannot drive the player.
//!
//! The server never touches playback itself. Commands become `remote.command`
//! app events (C1); the UI's player store applies them and reports back with
//! `remote.reportStatus` / `remote.publishChannels`, which this module keeps in
//! memory for the remote page to poll.
//!
//! Runtime state lives in one [`RemoteHub`] stored at
//! `state.extensions["remote"]`; it owns the graceful-shutdown handle of the
//! running server.

pub mod rpc;
mod server;

use crate::error::{CoreError, CoreResult};
use crate::model::{RemoteControlSettings, RemoteStatus};
use crate::state::AppState;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::oneshot;

pub use server::{is_loopback_host, router};

/// Key of the [`RemoteHub`] in `AppState::extensions`.
pub const EXT_KEY: &str = "remote";

/// Most channels kept from `remote.publishChannels`.
pub const MAX_CHANNELS: usize = 20_000;

/// How long `stop` waits for open connections to drain before aborting.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// How often the settings watcher looks for `remoteControl` changes.
const SETTINGS_POLL: Duration = Duration::from_secs(1);

/// One entry of the published live-channel list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChannel {
    /// `${sourceId}|${itemId}`.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
}

/// Result of `remote.status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Bound port while running, else the configured port.
    pub port: u16,
}

/// Address of a running server, returned by [`start_on`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub port: u16,
}

struct Running {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

/// Latest status and channel list reported by the app, plus the server handle.
#[derive(Default)]
pub struct RemoteHub {
    status: RwLock<Option<(RemoteStatus, String)>>,
    channels: RwLock<(Arc<Vec<RemoteChannel>>, Option<String>)>,
    running: Mutex<Option<Running>>,
    /// Serializes start/stop so concurrent calls cannot double-bind.
    lifecycle: tokio::sync::Mutex<()>,
}

impl RemoteHub {
    /// Latest status with its `updatedAt` (RFC 3339), if any was reported.
    pub fn status(&self) -> Option<(RemoteStatus, String)> {
        self.status.read().clone()
    }

    /// Stores a status snapshot, stamped now.
    pub fn set_status(&self, status: RemoteStatus) {
        *self.status.write() = Some((status, now()));
    }

    /// Published channels and when they were published.
    pub fn channels(&self) -> (Arc<Vec<RemoteChannel>>, Option<String>) {
        let g = self.channels.read();
        (Arc::clone(&g.0), g.1.clone())
    }

    /// Replaces the channel list. Drops entries without an id, trims names, and
    /// keeps at most [`MAX_CHANNELS`]. Returns the stored count.
    pub fn set_channels(&self, channels: Vec<RemoteChannel>) -> usize {
        let total = channels.len();
        let list: Vec<RemoteChannel> = channels
            .into_iter()
            .filter_map(|mut c| {
                c.id = c.id.trim().to_string();
                if c.id.is_empty() {
                    return None;
                }
                c.name = c.name.trim().to_string();
                if c.name.is_empty() {
                    c.name = c.id.clone();
                }
                c.logo_url = c.logo_url.filter(|u| !u.trim().is_empty());
                Some(c)
            })
            .take(MAX_CHANNELS)
            .collect();
        if total > MAX_CHANNELS {
            tracing::info!(total, kept = MAX_CHANNELS, "remote channel list capped");
        }
        let n = list.len();
        *self.channels.write() = (Arc::new(list), Some(now()));
        n
    }

    /// Bound port of the running server.
    pub fn running_port(&self) -> Option<u16> {
        let mut g = self.running.lock();
        // A server task that died on its own (should not happen) counts as stopped.
        if g.as_ref().is_some_and(|r| r.task.is_finished()) {
            *g = None;
        }
        g.as_ref().map(|r| r.port)
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// URL of the remote UI for a bound port.
pub fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The hub for this app state, created on first use.
pub fn hub(state: &AppState) -> Arc<RemoteHub> {
    state.ext_or_insert_with(EXT_KEY, || Arc::new(RemoteHub::default()))
}

/// Starts the server on `settings.remoteControl.port`. Restarts it when it runs
/// on another port; a no-op when it already runs on that port.
pub async fn start(state: Arc<AppState>) -> CoreResult<ServerInfo> {
    let port = state.settings.read().remote_control.port;
    start_on(state, port).await
}

/// Starts the server on `127.0.0.1:port` (`0` picks a free port, used by tests).
/// Already running on the requested port: returns the current address.
pub async fn start_on(state: Arc<AppState>, port: u16) -> CoreResult<ServerInfo> {
    let hub = hub(&state);
    let _guard = hub.lifecycle.lock().await;

    let current = hub.running_port();
    if let Some(current) = current {
        if port == 0 || port == current {
            return Ok(ServerInfo {
                url: url_for(current),
                port: current,
            });
        }
    }

    // Bind first: when the new port is unavailable the old server keeps running.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| bind_error(port, e))?;
    if current.is_some() {
        stop_locked(&hub).await;
    }
    let bound = listener.local_addr()?.port();
    let app = server::router(Arc::clone(&state), bound);

    let (tx, rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(err) = serve.await {
            tracing::error!(%err, port = bound, "remote control server stopped with an error");
        }
    });
    *hub.running.lock() = Some(Running {
        port: bound,
        shutdown: Some(tx),
        task,
    });
    tracing::info!(port = bound, "remote control listening on 127.0.0.1");
    Ok(ServerInfo {
        url: url_for(bound),
        port: bound,
    })
}

fn bind_error(port: u16, e: std::io::Error) -> CoreError {
    match e.kind() {
        std::io::ErrorKind::AddrInUse => CoreError::Conflict(format!(
            "port {port} is already in use; choose another remote control port in Settings > Remote"
        )),
        std::io::ErrorKind::PermissionDenied => CoreError::Conflict(format!(
            "port {port} is reserved or blocked on this machine; choose another remote control port in Settings > Remote"
        )),
        _ => CoreError::Io(std::io::Error::new(
            e.kind(),
            format!("cannot listen on 127.0.0.1:{port}: {e}"),
        )),
    }
}

/// Stops the server, waiting up to 3 s for open connections. No-op when stopped.
pub async fn stop(state: Arc<AppState>) -> CoreResult<()> {
    let hub = hub(&state);
    let _guard = hub.lifecycle.lock().await;
    stop_locked(&hub).await;
    Ok(())
}

async fn stop_locked(hub: &RemoteHub) {
    let Some(mut running) = hub.running.lock().take() else {
        return;
    };
    if let Some(tx) = running.shutdown.take() {
        let _ = tx.send(());
    }
    let port = running.port;
    match tokio::time::timeout(SHUTDOWN_GRACE, &mut running.task).await {
        Ok(_) => tracing::info!(port, "remote control stopped"),
        Err(_) => {
            running.task.abort();
            let _ = running.task.await;
            tracing::warn!(
                port,
                "remote control connections did not drain; server aborted"
            );
        }
    }
}

/// `remote.status`.
pub fn server_status(state: &AppState) -> ServerStatus {
    match hub(state).running_port() {
        Some(port) => ServerStatus {
            running: true,
            url: Some(url_for(port)),
            port,
        },
        None => ServerStatus {
            running: false,
            url: None,
            port: state.settings.read().remote_control.port,
        },
    }
}

/// Starts the server when `settings.remoteControl.enabled`, then watches the
/// settings cache and follows later changes to `enabled` / `port` (the settings
/// module refreshes the cache on `settings.update`). Explicit `remote.start` /
/// `remote.stop` calls are respected until the settings change again.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let initial = state.settings.read().remote_control.clone();
    let result = if initial.enabled {
        start_on(Arc::clone(&state), initial.port).await.map(|_| ())
    } else {
        Ok(())
    };
    spawn_settings_watcher(Arc::downgrade(&state), initial, result.is_err());
    result
}

/// How often a start that failed (port busy) is tried again while the
/// settings still ask for the server.
pub const START_RETRY: Duration = Duration::from_secs(5);

fn spawn_settings_watcher(
    state: Weak<AppState>,
    mut last: RemoteControlSettings,
    mut start_failed: bool,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SETTINGS_POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_attempt = tokio::time::Instant::now();
        loop {
            tick.tick().await;
            let Some(state) = state.upgrade() else { break };
            let current = state.settings.read().remote_control.clone();
            let changed = current != last;
            // A failed start (another program held the port) is retried until
            // it works or the settings change; an explicit `remote.stop` after
            // a successful start is not undone.
            let retry = !changed
                && start_failed
                && current.enabled
                && last_attempt.elapsed() >= START_RETRY
                && hub(&state).running_port().is_none();
            if !changed && !retry {
                continue;
            }
            last = current.clone();
            last_attempt = tokio::time::Instant::now();
            let outcome = if current.enabled {
                start_on(Arc::clone(&state), current.port).await.map(|_| ())
            } else {
                stop(Arc::clone(&state)).await
            };
            start_failed = current.enabled && outcome.is_err();
            if let Err(err) = outcome {
                if !retry {
                    tracing::warn!(%err, "remote control settings change could not be applied; retrying every {START_RETRY:?}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str, name: &str) -> RemoteChannel {
        RemoteChannel {
            id: id.into(),
            name: name.into(),
            number: None,
            logo_url: Some(" ".into()),
        }
    }

    #[test]
    fn channels_are_sanitized_and_capped() {
        let hub = RemoteHub::default();
        let n = hub.set_channels(vec![ch("  a|1 ", " One "), ch("", "x"), ch("b|2", "  ")]);
        assert_eq!(n, 2);
        let (list, at) = hub.channels();
        assert!(at.is_some());
        assert_eq!(list[0].id, "a|1");
        assert_eq!(list[0].name, "One");
        assert_eq!(list[0].logo_url, None);
        assert_eq!(list[1].name, "b|2");

        let many = (0..MAX_CHANNELS + 50)
            .map(|i| ch(&format!("s|{i}"), "c"))
            .collect();
        assert_eq!(hub.set_channels(many), MAX_CHANNELS);
    }

    #[test]
    fn status_is_stamped() {
        let hub = RemoteHub::default();
        assert!(hub.status().is_none());
        hub.set_status(RemoteStatus {
            is_live: true,
            ..Default::default()
        });
        let (s, at) = hub.status().unwrap();
        assert!(s.is_live);
        assert!(at.ends_with('Z'));
    }
}
