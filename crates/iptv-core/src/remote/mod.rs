//! Remote control (SPEC C4 remote section, check 10 / SC8).
//!
//! A small axum server bound to `127.0.0.1:{settings.remoteControl.port}` serves
//! the embedded remote web UI (`remote-ui/index.html`) and a JSON API under
//! `/api/remote-control/*`. Loopback requests are accepted only with a loopback
//! `Host` and either no `Origin` or the server's own origin, so other web pages
//! (and DNS-rebinding attacks) cannot drive the player.
//!
//! LAN mode (`settings.remoteLanEnabled`, desktop only) also listens on the
//! machine's private IPv4 addresses ([`lan`]). Requests from the network must
//! use one of those addresses as `Host` and carry a session cookie obtained by
//! pairing ([`pairing`]): the phone scans a QR code holding a one-time code and
//! trades it for a per-device session.
//!
//! The server never touches playback itself. Commands become `remote.command`
//! app events (C1); the UI's player store applies them and reports back with
//! `remote.reportStatus` / `remote.publishChannels`, which this module keeps in
//! memory for the remote page to poll.
//!
//! Runtime state lives in one [`RemoteHub`] stored at
//! `state.extensions["remote"]`; it owns the graceful-shutdown handle of the
//! running server.

pub mod lan;
pub mod pairing;
pub mod rpc;
mod server;

use crate::error::{CoreError, CoreResult};
use crate::model::{RemoteControlSettings, RemoteStatus};
use crate::state::AppState;
use lan::LanAddr;
use pairing::{DeviceInfo, PairLimiter, Pairing, QrSvg, Sessions};
use parking_lot::{Mutex, RwLock};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub use server::{check_access, is_loopback_host, router, router_with_lan, Denied, Zone};

/// Key of the [`RemoteHub`] in `AppState::extensions`.
pub const EXT_KEY: &str = "remote";

/// Most channels kept from `remote.publishChannels`.
pub const MAX_CHANNELS: usize = 20_000;

/// How long `stop` waits for open connections to drain before aborting.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// How often the settings watcher looks for `remoteControl` changes.
const SETTINGS_POLL: Duration = Duration::from_secs(1);

/// How often (in settings ticks) LAN mode re-reads the network addresses, so
/// a new Wi-Fi address is picked up without a restart.
const LAN_RESCAN_TICKS: u32 = 30;

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

/// A LAN address the server listens on, with the remote URL there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddressStatus {
    pub ip: String,
    pub interface: String,
    pub url: String,
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
    // remote: LAN mode
    /// LAN addresses in use (LAN mode on and running), best first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lan_addresses: Vec<LanAddressStatus>,
    /// Why LAN mode is on but not (fully) listening.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan_error: Option<String>,
}

/// Address of a running server, returned by [`start_on`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub port: u16,
}

/// Result of `remote.pairingCode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    /// `http://<lan-ip>:<port>/?pair=<code>`.
    pub url: String,
    /// The LAN address in `url`.
    pub address: String,
    pub expires_at: String,
    pub expires_in_secs: u64,
    pub qr: QrSvg,
}

struct Running {
    port: u16,
    /// LAN mode was asked for when this server started.
    lan_requested: bool,
    /// LAN addresses actually bound.
    lan: Vec<LanAddr>,
    lan_error: Option<String>,
    shutdown: watch::Sender<bool>,
    /// One serve task per listener; the loopback one is first.
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// Latest status and channel list reported by the app, plus the server handle
/// and the pairing state.
#[derive(Default)]
pub struct RemoteHub {
    status: RwLock<Option<(RemoteStatus, String)>>,
    channels: RwLock<(Arc<Vec<RemoteChannel>>, Option<String>)>,
    running: Mutex<Option<Running>>,
    /// Serializes start/stop so concurrent calls cannot double-bind.
    lifecycle: tokio::sync::Mutex<()>,
    // remote: LAN pairing
    pairing: Mutex<Pairing>,
    limiter: Mutex<PairLimiter>,
    /// `None` until loaded from the database.
    sessions: Mutex<Option<Sessions>>,
    /// Serializes writes so an older snapshot never lands after a newer one.
    persist_lock: tokio::sync::Mutex<()>,
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
        if g.as_ref()
            .is_some_and(|r| r.tasks.first().is_none_or(|t| t.is_finished()))
        {
            *g = None;
        }
        g.as_ref().map(|r| r.port)
    }

    /// LAN addresses the running server listens on.
    pub fn lan_addrs(&self) -> Vec<LanAddr> {
        self.running
            .lock()
            .as_ref()
            .map(|r| r.lan.clone())
            .unwrap_or_default()
    }

    /// Validates a session token and stamps the device's `last_seen`.
    /// `Some(true)` when that should be written to the database.
    pub(crate) fn touch_session(&self, token: &str) -> Option<bool> {
        self.sessions
            .lock()
            .as_mut()?
            .touch(token, chrono::Utc::now(), Instant::now())
    }

    /// Paired devices (empty until loaded).
    pub fn devices(&self) -> Vec<DeviceInfo> {
        self.sessions
            .lock()
            .as_ref()
            .map(Sessions::list)
            .unwrap_or_default()
    }

    /// Checks the rate limit, then uses up the pairing code and creates a
    /// session. `Ok(Some(token))` on success, `Ok(None)` for a wrong or
    /// expired code, `Err(retry_after)` while rate limited. The caller loads
    /// the sessions first; while they are not loaded the code is left unused
    /// and `Ok(None)` is returned, so a stored device list is never replaced
    /// by a fresh one.
    pub(crate) fn try_pair(
        &self,
        peer: std::net::IpAddr,
        code: &str,
        user_agent: &str,
    ) -> Result<Option<String>, Duration> {
        let mono = Instant::now();
        self.limiter.lock().check(peer, mono)?;
        let mut g = self.sessions.lock();
        let Some(sessions) = g.as_mut() else {
            return Ok(None);
        };
        if !self.pairing.lock().consume(code, mono) {
            drop(g);
            self.limiter.lock().record_failure(peer, mono);
            return Ok(None);
        }
        Ok(Some(sessions.add(user_agent, chrono::Utc::now(), mono)))
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
/// on another port or with another LAN setup; a no-op when nothing changed.
pub async fn start(state: Arc<AppState>) -> CoreResult<ServerInfo> {
    let port = state.settings.read().remote_control.port;
    start_on(state, port).await
}

/// Starts the server on `127.0.0.1:port` (`0` picks a free port, used by
/// tests) and, in LAN mode on the desktop, on the private network addresses
/// with the same port. Already running with the same port and LAN setup:
/// returns the current address.
pub async fn start_on(state: Arc<AppState>, port: u16) -> CoreResult<ServerInfo> {
    let hub = hub(&state);
    let _guard = hub.lifecycle.lock().await;

    let want_lan = state.is_desktop && state.settings.read().remote_lan_enabled;
    let candidates = if want_lan {
        lan::select_lan_addrs(lan::interface_addrs())
    } else {
        Vec::new()
    };

    let current = hub.running_port().and_then(|p| {
        hub.running
            .lock()
            .as_ref()
            .map(|r| (p, r.lan_requested, r.lan.iter().map(|a| a.ip).collect()))
    });
    let target = match (port, &current) {
        (0, Some((p, ..))) => *p,
        _ => port,
    };
    let plan = lan::plan_binds(target, want_lan, state.is_desktop, candidates);
    let planned: Vec<Ipv4Addr> = plan.lan.iter().map(|a| a.ip).collect();

    if let Some(cur) = &current {
        if unchanged(cur, target, want_lan, &planned) {
            return Ok(ServerInfo {
                url: url_for(cur.0),
                port: cur.0,
            });
        }
    }
    if want_lan {
        // An error is logged; the guard retries the load on the next request.
        let _ = load_sessions(&state).await;
    }

    let port_changes = current.as_ref().is_some_and(|(p, ..)| *p != target);
    // Same port, new LAN setup: free the port first. A new port binds first,
    // so when it is unavailable the old server keeps running.
    if current.is_some() && !port_changes {
        stop_locked(&hub).await;
    }
    let listener = tokio::net::TcpListener::bind(plan.loopback)
        .await
        .map_err(|e| bind_error(target, e))?;
    if port_changes {
        stop_locked(&hub).await;
    }
    let bound = listener.local_addr()?.port();

    let mut lan_listeners = Vec::new();
    let mut lan_bound = Vec::new();
    let mut failures = Vec::new();
    for a in &plan.lan {
        match tokio::net::TcpListener::bind((a.ip, bound)).await {
            Ok(l) => {
                lan_listeners.push(l);
                lan_bound.push(a.clone());
            }
            Err(e) => failures.push(format!("{}: {e}", a.ip)),
        }
    }
    let lan_error = if !want_lan {
        None
    } else if plan.lan.is_empty() {
        Some(
            "no private network address found; connect this computer to Wi-Fi or Ethernet"
                .to_string(),
        )
    } else if !failures.is_empty() {
        Some(format!("could not listen on {}", failures.join("; ")))
    } else {
        None
    };
    if let Some(err) = &lan_error {
        tracing::warn!(error = %err, "remote control: LAN access incomplete");
    }

    let app = server::router_with_lan(
        Arc::clone(&state),
        bound,
        lan_bound.iter().map(|a| a.ip).collect(),
    );
    let (tx, rx) = watch::channel(false);
    let mut tasks = Vec::new();
    for l in std::iter::once(listener).chain(lan_listeners) {
        let mut rx = rx.clone();
        let svc = app
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();
        tasks.push(tokio::spawn(async move {
            let addr = l.local_addr().ok();
            let serve = axum::serve(l, svc).with_graceful_shutdown(async move {
                let _ = rx.wait_for(|stop| *stop).await;
            });
            if let Err(err) = serve.await {
                tracing::error!(%err, ?addr, "remote control server stopped with an error");
            }
        }));
    }
    let lan_count = lan_bound.len();
    *hub.running.lock() = Some(Running {
        port: bound,
        lan_requested: want_lan,
        lan: lan_bound,
        lan_error,
        shutdown: tx,
        tasks,
    });
    if lan_count > 0 {
        tracing::info!(
            port = bound,
            lan_addresses = lan_count,
            "remote control listening on 127.0.0.1 and the local network"
        );
    } else {
        tracing::info!(port = bound, "remote control listening on 127.0.0.1");
    }
    Ok(ServerInfo {
        url: url_for(bound),
        port: bound,
    })
}

/// True when the running server `(port, lan requested, LAN addresses bound)`
/// already matches the wanted setup. Compared with the addresses actually
/// bound, not the ones planned, so addresses that failed to bind are tried
/// again by Retry (`remote.start`) and by the 30 s rescan.
fn unchanged(
    cur: &(u16, bool, Vec<Ipv4Addr>),
    target: u16,
    want_lan: bool,
    planned: &[Ipv4Addr],
) -> bool {
    cur.0 == target && cur.1 == want_lan && cur.2 == planned
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
    let _ = running.shutdown.send(true);
    let port = running.port;
    let all = futures::future::join_all(running.tasks.iter_mut());
    match tokio::time::timeout(SHUTDOWN_GRACE, all).await {
        Ok(_) => tracing::info!(port, "remote control stopped"),
        Err(_) => {
            for t in &running.tasks {
                t.abort();
            }
            for t in running.tasks {
                let _ = t.await;
            }
            tracing::warn!(
                port,
                "remote control connections did not drain; server aborted"
            );
        }
    }
}

/// `remote.status`.
pub fn server_status(state: &AppState) -> ServerStatus {
    let hub = hub(state);
    match hub.running_port() {
        Some(port) => {
            let g = hub.running.lock();
            let (lan, lan_error) = g
                .as_ref()
                .map(|r| (r.lan.clone(), r.lan_error.clone()))
                .unwrap_or_default();
            ServerStatus {
                running: true,
                url: Some(url_for(port)),
                port,
                lan_addresses: lan
                    .into_iter()
                    .map(|a| LanAddressStatus {
                        ip: a.ip.to_string(),
                        url: lan::lan_url(a.ip, port),
                        interface: a.interface,
                    })
                    .collect(),
                lan_error,
            }
        }
        None => ServerStatus {
            running: false,
            url: None,
            port: state.settings.read().remote_control.port,
            lan_addresses: Vec::new(),
            lan_error: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Pairing (LAN mode)
// ---------------------------------------------------------------------------

fn require_desktop(state: &AppState) -> CoreResult<()> {
    if state.is_desktop {
        Ok(())
    } else {
        Err(CoreError::Unsupported(
            "phone pairing is part of the desktop app; server mode has no LAN remote".into(),
        ))
    }
}

/// Reads the paired devices from `app_state` once. On a database error the
/// list stays unloaded (and is not written), so the next call tries again
/// instead of an empty list replacing the stored devices.
pub(crate) async fn load_sessions(state: &Arc<AppState>) -> CoreResult<()> {
    let hub = hub(state);
    if hub.sessions.lock().is_some() {
        return Ok(());
    }
    let stored = state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                [pairing::DEVICES_KEY],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
        })
        .await;
    let sessions = match stored {
        Ok(Some(text)) => Sessions::from_json(&text),
        Ok(None) => Sessions::default(),
        Err(err) => {
            tracing::warn!(%err, "remote control: cannot read paired devices; will retry");
            return Err(err);
        }
    };
    let mut g = hub.sessions.lock();
    if g.is_none() {
        *g = Some(sessions);
    }
    Ok(())
}

/// Writes the current device list to `app_state`. The snapshot is taken
/// under the persist lock, so the last write always holds the latest state.
pub(crate) async fn persist_sessions(state: &Arc<AppState>) -> CoreResult<()> {
    let hub = hub(state);
    let _w = hub.persist_lock.lock().await;
    let Some(json) = hub.sessions.lock().as_ref().map(Sessions::to_json) else {
        return Ok(());
    };
    state
        .db_call(move |conn| {
            conn.execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                [pairing::DEVICES_KEY, json.as_str()],
            )?;
            Ok(())
        })
        .await
}

/// `remote.pairingCode`: the current one-time code as a URL and QR code for
/// `address` (one of the LAN addresses; default the best one).
pub fn pairing_code(state: &AppState, address: Option<&str>) -> CoreResult<PairingInfo> {
    require_desktop(state)?;
    let hub = hub(state);
    let Some(port) = hub.running_port() else {
        return Err(CoreError::Conflict(
            "the remote control is not running; turn it on in Settings > Remote".into(),
        ));
    };
    let addrs = hub.lan_addrs();
    let Some(first) = addrs.first() else {
        return Err(CoreError::Conflict(
            "LAN access is off or this computer has no private network address".into(),
        ));
    };
    let ip = address
        .and_then(|a| addrs.iter().find(|x| x.ip.to_string() == a.trim()))
        .unwrap_or(first)
        .ip;
    let (code, left) = hub.pairing.lock().current_or_new(Instant::now());
    let url = format!("{}/?pair={code}", lan::lan_url(ip, port));
    let qr = pairing::qr_svg(&url)
        .ok_or_else(|| CoreError::Other(anyhow::anyhow!("pairing link does not fit a QR code")))?;
    let expires = chrono::Utc::now() + chrono::Duration::from_std(left).unwrap_or_default();
    Ok(PairingInfo {
        url,
        address: ip.to_string(),
        expires_at: expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        expires_in_secs: left.as_secs(),
        qr,
    })
}

/// The current pairing code without the URL or QR code. For tests, which
/// serve the router on loopback and never start a real LAN listener.
#[doc(hidden)]
pub fn mint_pairing_code(state: &AppState) -> String {
    hub(state).pairing.lock().current_or_new(Instant::now()).0
}

/// `remote.devices`.
pub async fn devices(state: &Arc<AppState>) -> CoreResult<Vec<DeviceInfo>> {
    require_desktop(state)?;
    load_sessions(state).await?;
    Ok(hub(state).devices())
}

/// `remote.revokeDevice`.
pub async fn revoke_device(state: &Arc<AppState>, id: &str) -> CoreResult<()> {
    require_desktop(state)?;
    load_sessions(state).await?;
    let removed = hub(state)
        .sessions
        .lock()
        .as_mut()
        .is_some_and(|s| s.revoke(id));
    if !removed {
        return Err(CoreError::NotFound("that device is not paired".into()));
    }
    tracing::info!("remote control: device revoked");
    persist_sessions(state).await
}

/// `remote.resetPairing`: revokes every device and the current code.
pub async fn reset_pairing(state: &Arc<AppState>) -> CoreResult<()> {
    require_desktop(state)?;
    load_sessions(state).await?;
    let hub = hub(state);
    hub.pairing.lock().revoke();
    if let Some(s) = hub.sessions.lock().as_mut() {
        s.clear();
    }
    tracing::info!("remote control: pairing reset; all devices revoked");
    persist_sessions(state).await
}

// ---------------------------------------------------------------------------
// Settings watcher
// ---------------------------------------------------------------------------

/// The settings the watcher follows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Watched {
    rc: RemoteControlSettings,
    lan: bool,
}

impl Watched {
    fn read(state: &AppState) -> Self {
        let s = state.settings.read();
        Self {
            rc: s.remote_control.clone(),
            lan: s.remote_lan_enabled,
        }
    }
}

/// Starts the server when `settings.remoteControl.enabled`, then watches the
/// settings cache and follows later changes to `enabled`, `port` and
/// `remoteLanEnabled` (the settings module refreshes the cache on
/// `settings.update`). Explicit `remote.start` / `remote.stop` calls are
/// respected until the settings change again.
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let initial = Watched::read(&state);
    let result = if initial.rc.enabled {
        start_on(Arc::clone(&state), initial.rc.port)
            .await
            .map(|_| ())
    } else {
        Ok(())
    };
    spawn_settings_watcher(Arc::downgrade(&state), initial, result.is_err());
    result
}

/// How often a start that failed (port busy) is tried again while the
/// settings still ask for the server.
pub const START_RETRY: Duration = Duration::from_secs(5);

/// What the watcher does on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Idle,
    /// `start_on(port)`. `why` names the cause for the log.
    Start {
        port: u16,
        why: StartWhy,
    },
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartWhy {
    Settings,
    Retry,
    LanMode,
    Rescan,
}

/// The watcher's decisions, without the I/O (unit tested).
struct Watch {
    last: Watched,
    start_failed: bool,
    last_attempt: Instant,
    ticks: u32,
}

impl Watch {
    fn new(last: Watched, start_failed: bool, now: Instant) -> Self {
        Self {
            last,
            start_failed,
            last_attempt: now,
            ticks: 0,
        }
    }

    /// Decides this tick's action from the settings and the running port.
    fn step(
        &mut self,
        current: &Watched,
        running: Option<u16>,
        is_desktop: bool,
        now: Instant,
    ) -> Step {
        self.ticks = self.ticks.wrapping_add(1);
        let changed = *current != self.last;
        // A failed start (port busy, or a restart that could not rebind) is
        // retried until it works or the settings change; an explicit
        // `remote.stop` after a successful start is not undone.
        let retry = !changed
            && self.start_failed
            && current.rc.enabled
            && now.saturating_duration_since(self.last_attempt) >= START_RETRY
            && running.is_none();
        if retry {
            return Step::Start {
                port: current.rc.port,
                why: StartWhy::Retry,
            };
        }
        if !changed {
            // LAN mode: pick up new or lost network addresses, and retry
            // addresses that failed to bind. `start_on` is a no-op when the
            // bound addresses already match.
            return match running {
                Some(port) if current.lan && is_desktop && self.ticks % LAN_RESCAN_TICKS == 0 => {
                    Step::Start {
                        port,
                        why: StartWhy::Rescan,
                    }
                }
                _ => Step::Idle,
            };
        }
        let lan_only = current.rc == self.last.rc;
        self.last = current.clone();
        if lan_only {
            // Restart in place with the new LAN mode, if running at all.
            return running.map_or(Step::Idle, |port| Step::Start {
                port,
                why: StartWhy::LanMode,
            });
        }
        if current.rc.enabled {
            Step::Start {
                port: current.rc.port,
                why: StartWhy::Settings,
            }
        } else {
            Step::Stop
        }
    }

    /// Records the outcome of a step's start or stop. Every failed start,
    /// including LAN restarts and rescans, arms the retry.
    fn finished(&mut self, ok: bool, now: Instant) {
        self.last_attempt = now;
        self.start_failed = !ok;
    }
}

fn spawn_settings_watcher(state: Weak<AppState>, last: Watched, start_failed: bool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SETTINGS_POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut w = Watch::new(last, start_failed, Instant::now());
        loop {
            tick.tick().await;
            let Some(state) = state.upgrade() else { break };
            let current = Watched::read(&state);
            let running = hub(&state).running_port();
            let step = w.step(&current, running, state.is_desktop, Instant::now());
            let (outcome, why) = match step {
                Step::Idle => continue,
                Step::Stop => (stop(Arc::clone(&state)).await, None),
                Step::Start { port, why } => (
                    start_on(Arc::clone(&state), port).await.map(|_| ()),
                    Some(why),
                ),
            };
            w.finished(outcome.is_ok(), Instant::now());
            if let Err(err) = outcome {
                match why {
                    Some(StartWhy::Retry) => {}
                    Some(StartWhy::Rescan) => {
                        tracing::warn!(%err, "remote control: LAN address change could not be applied; retrying every {START_RETRY:?}")
                    }
                    Some(StartWhy::LanMode) => {
                        tracing::warn!(%err, "remote control: LAN mode change could not be applied; retrying every {START_RETRY:?}")
                    }
                    _ => {
                        tracing::warn!(%err, "remote control settings change could not be applied; retrying every {START_RETRY:?}")
                    }
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

    fn watched(enabled: bool, lan: bool) -> Watched {
        Watched {
            rc: RemoteControlSettings {
                enabled,
                port: 7310,
            },
            lan,
        }
    }

    /// R-remote-F2: a LAN-mode restart or an address rescan that cannot
    /// rebind arms the same retry as a failed start.
    #[test]
    fn failed_lan_restart_and_rescan_are_retried() {
        let t = Instant::now();
        let lan_start = Step::Start {
            port: 7310,
            why: StartWhy::LanMode,
        };
        let retry = Step::Start {
            port: 7310,
            why: StartWhy::Retry,
        };
        let mut w = Watch::new(watched(true, false), false, t);
        // LAN mode toggled while running: restart in place, which fails.
        assert_eq!(w.step(&watched(true, true), Some(7310), true, t), lan_start);
        w.finished(false, t);
        // Server is down now: retried after START_RETRY, not before.
        let on = watched(true, true);
        assert_eq!(w.step(&on, None, true, t), Step::Idle);
        assert_eq!(w.step(&on, None, true, t + START_RETRY), retry);
        w.finished(true, t + START_RETRY);
        assert_eq!(
            w.step(&on, Some(7310), true, t + START_RETRY * 2),
            Step::Idle
        );

        // A rescan that fails to rebind is retried too.
        let mut w = Watch::new(on.clone(), false, t);
        let mut step = Step::Idle;
        for _ in 0..LAN_RESCAN_TICKS {
            step = w.step(&on, Some(7310), true, t);
        }
        assert_eq!(
            step,
            Step::Start {
                port: 7310,
                why: StartWhy::Rescan
            }
        );
        w.finished(false, t);
        assert_eq!(w.step(&on, None, true, t + START_RETRY), retry);
    }

    #[test]
    fn watcher_follows_settings_and_respects_explicit_stop() {
        let t = Instant::now();
        let mut w = Watch::new(watched(false, false), false, t);
        assert_eq!(w.step(&watched(false, false), None, true, t), Step::Idle);
        assert_eq!(
            w.step(&watched(true, false), None, true, t),
            Step::Start {
                port: 7310,
                why: StartWhy::Settings
            }
        );
        w.finished(true, t);
        // Stopped by `remote.stop` after a good start: left alone.
        let later = t + START_RETRY * 3;
        assert_eq!(w.step(&watched(true, false), None, true, later), Step::Idle);
        assert_eq!(
            w.step(&watched(false, false), None, true, later),
            Step::Stop
        );
        // LAN mode change while stopped: nothing to do.
        assert_eq!(w.step(&watched(false, true), None, true, later), Step::Idle);
        // No rescans in server mode.
        let mut w = Watch::new(watched(true, true), false, t);
        for _ in 0..LAN_RESCAN_TICKS * 2 {
            assert_eq!(
                w.step(&watched(true, true), Some(7310), false, t),
                Step::Idle
            );
        }
    }

    /// R-remote-F1: addresses that failed to bind make the setup "changed",
    /// so Retry and rescans bind them again.
    #[test]
    fn failed_lan_binds_are_not_treated_as_unchanged() {
        let a = Ipv4Addr::new(192, 168, 1, 5);
        let b = Ipv4Addr::new(10, 0, 0, 7);
        assert!(unchanged(&(7310, true, vec![a, b]), 7310, true, &[a, b]));
        assert!(!unchanged(&(7310, true, vec![a]), 7310, true, &[a, b]));
        assert!(!unchanged(&(7310, true, vec![]), 7310, true, &[a]));
        assert!(unchanged(&(7310, true, vec![]), 7310, true, &[]));
        assert!(!unchanged(&(7310, false, vec![]), 7310, true, &[]));
        assert!(!unchanged(&(7311, true, vec![a]), 7310, true, &[a]));
    }

    /// R-remote-F4: a flood of wrong codes from other addresses does not
    /// stop the owner's phone from pairing with the right code.
    #[test]
    fn flood_from_other_peers_does_not_block_a_correct_code() {
        let hub = RemoteHub::default();
        *hub.sessions.lock() = Some(Sessions::default());
        let mut n = 0;
        'flood: for a in 1..=250u8 {
            for _ in 0..pairing::PAIR_FAILS_PER_PEER {
                let peer = std::net::IpAddr::from([192, 168, 2, a]);
                assert_eq!(hub.try_pair(peer, "wrong", ""), Ok(None));
                n += 1;
                if n == pairing::PAIR_FAILS_GLOBAL {
                    break 'flood;
                }
            }
        }
        let attacker = std::net::IpAddr::from([192, 168, 2, 1]);
        assert!(hub.try_pair(attacker, "wrong", "").is_err());
        let phone = std::net::IpAddr::from([192, 168, 1, 30]);
        let (code, _) = hub.pairing.lock().current_or_new(Instant::now());
        assert!(hub.try_pair(phone, &code, "Safari").unwrap().is_some());
        assert_eq!(hub.devices().len(), 1);
    }

    #[test]
    fn try_pair_needs_loaded_sessions() {
        let hub = RemoteHub::default();
        let peer: std::net::IpAddr = "192.168.1.20".parse().unwrap();
        let (code, _) = hub.pairing.lock().current_or_new(Instant::now());
        // Not loaded: refused, and the code is not used up.
        assert_eq!(hub.try_pair(peer, &code, ""), Ok(None));
        assert!(hub.sessions.lock().is_none());
        *hub.sessions.lock() = Some(Sessions::default());
        assert!(hub.try_pair(peer, &code, "").unwrap().is_some());
    }

    #[test]
    fn try_pair_uses_the_code_once_and_rate_limits() {
        let hub = RemoteHub::default();
        *hub.sessions.lock() = Some(Sessions::default());
        let peer: std::net::IpAddr = "192.168.1.20".parse().unwrap();
        let (code, _) = hub.pairing.lock().current_or_new(Instant::now());
        let tok = hub.try_pair(peer, &code, "Safari").unwrap().unwrap();
        assert_eq!(hub.touch_session(&tok), Some(false));
        assert_eq!(hub.try_pair(peer, &code, "Safari"), Ok(None));
        for _ in 1..pairing::PAIR_FAILS_PER_PEER {
            assert_eq!(hub.try_pair(peer, "nope", ""), Ok(None));
        }
        // Locked out, even with a fresh valid code.
        let (code, _) = hub.pairing.lock().current_or_new(Instant::now());
        assert!(hub.try_pair(peer, &code, "").is_err());
        assert_eq!(hub.devices().len(), 1);
    }
}
