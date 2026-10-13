//! LAN mode of the remote control: pairing, sessions, rate limiting, and the
//! Host/Origin guard for network peers.
//!
//! No test binds a non-loopback address. The router is served on
//! `127.0.0.1:0` and `MockConnectInfo` makes it see a LAN peer; requests carry
//! the LAN `Host` the phone would send.

use axum::extract::connect_info::MockConnectInfo;
use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::remote;
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast::Receiver;

const LAN_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 5);
const PHONE: &str = "192.168.1.20:51000";
const IPHONE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async fn desktop_state(dir: &Path) -> (Arc<AppState>, Receiver<AppEvent>) {
    let (sink, rx) = BroadcastSink::channel(64);
    // Desktop state so the pairing commands run. LAN mode stays off in the
    // settings, so nothing here ever starts a real LAN listener.
    let state = AppState::new(dir.to_path_buf(), Arc::new(sink), true)
        .await
        .unwrap();
    assert!(!state.settings.read().remote_lan_enabled);
    (state, rx)
}

struct Server {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Serves the LAN-aware router on loopback; every request appears to come
/// from `peer`.
async fn serve_as(state: &Arc<AppState>, peer: &str) -> Server {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer: SocketAddr = peer.parse().unwrap();
    let app =
        remote::router_with_lan(state.clone(), port, vec![LAN_IP]).layer(MockConnectInfo(peer));
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Server {
        port,
        shutdown: Some(tx),
    }
}

struct Resp {
    status: u16,
    head: String,
    body: Value,
}

impl Resp {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case(name)
                .then(|| v.trim().to_string())
        })
    }
}

/// Raw HTTP/1.1 so `Host`, `Origin` and `Cookie` are exactly what we write.
async fn raw(port: u16, method: &str, path: &str, headers: &[(&str, String)], body: &str) -> Resp {
    let mut req = format!("{method} {path} HTTP/1.1\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    // Bodies are small JSON; chunked framing is not used for fixed bodies.
    let body = serde_json::from_str(body.trim()).unwrap_or(Value::Null);
    Resp {
        status,
        head: head.to_string(),
        body,
    }
}

fn lan_host(port: u16) -> (&'static str, String) {
    ("Host", format!("{LAN_IP}:{port}"))
}

fn lan_origin(port: u16) -> (&'static str, String) {
    ("Origin", format!("http://{LAN_IP}:{port}"))
}

async fn pair(port: u16, code: &str) -> Resp {
    raw(
        port,
        "POST",
        "/api/remote-control/pair",
        &[
            lan_host(port),
            lan_origin(port),
            ("User-Agent", IPHONE_UA.into()),
            ("Content-Type", "application/json".into()),
        ],
        &json!({ "code": code }).to_string(),
    )
    .await
}

fn cookie_of(r: &Resp) -> String {
    let set = r.header("set-cookie").expect("Set-Cookie");
    assert!(set.contains("HttpOnly"), "{set}");
    assert!(set.contains("SameSite=Strict"), "{set}");
    // Scoped to the API (R-remote-F7).
    assert!(set.contains("Path=/api/remote-control;"), "{set}");
    set.split(';').next().unwrap().to_string()
}

fn assert_no_command(rx: &mut Receiver<AppEvent>) {
    while let Ok(ev) = rx.try_recv() {
        assert_ne!(
            ev.kind, "remote.command",
            "unexpected command: {:?}",
            ev.payload
        );
    }
}

async fn next_command(rx: &mut Receiver<AppEvent>) -> Value {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("no event within 2 s")
            .unwrap();
        if ev.kind == "remote.command" {
            return ev.payload;
        }
    }
}

#[tokio::test]
async fn lan_peer_needs_a_session() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, mut rx) = desktop_state(tmp.path()).await;
    let s = serve_as(&state, PHONE).await;
    let p = s.port;

    // The page itself loads (it shows the pairing screen).
    let r = raw(p, "GET", "/", &[lan_host(p)], "").await;
    assert_eq!(r.status, 200);

    for (method, path) in [
        ("GET", "/api/remote-control/status"),
        ("GET", "/api/remote-control/channels"),
        ("GET", "/api/remote-control/health"),
        ("POST", "/api/remote-control/channel/up"),
        ("POST", "/api/remote-control/volume/toggle-mute"),
        ("GET", "/nope"),
    ] {
        let r = raw(p, method, path, &[lan_host(p)], "").await;
        assert_eq!(r.status, 401, "{method} {path}");
        assert_eq!(r.body["error"], "unpaired");
    }
    // A made-up cookie is refused and cleared.
    let r = raw(
        p,
        "POST",
        "/api/remote-control/channel/up",
        &[lan_host(p), ("Cookie", "tsr_remote=forged".into())],
        "",
    )
    .await;
    assert_eq!(r.status, 401);
    assert!(r.header("set-cookie").unwrap().contains("Max-Age=0"));
    // Cleared on the API path and on `/` (cookies from older builds).
    assert!(r.head.contains("Path=/api/remote-control; Max-Age=0"));
    assert!(r.head.contains("Path=/; Max-Age=0"));
    assert_no_command(&mut rx);
}

#[tokio::test]
async fn pairing_round_trip_revoke_and_reset() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, mut rx) = desktop_state(tmp.path()).await;
    let s = serve_as(&state, PHONE).await;
    let p = s.port;

    let code = remote::mint_pairing_code(&state);
    let r = pair(p, &code).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    let cookie = cookie_of(&r);
    let token = cookie.trim_start_matches("tsr_remote=").to_string();

    // The code worked once.
    let again = pair(p, &code).await;
    assert_eq!(again.status, 401);
    assert_eq!(again.body["error"], "invalid_code");

    // The session drives the player and reads the status.
    let with = |extra: (&'static str, String)| vec![lan_host(p), ("Cookie", cookie.clone()), extra];
    let r = raw(
        p,
        "POST",
        "/api/remote-control/channel/up",
        &with(lan_origin(p)),
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(next_command(&mut rx).await["command"], "channelUp");
    let r = raw(
        p,
        "GET",
        "/api/remote-control/status",
        &[lan_host(p), ("Cookie", cookie.clone())],
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["isLive"], false);

    // Stored: a hash only, never the token.
    let stored: String = state
        .conn()
        .unwrap()
        .query_row(
            "SELECT value FROM app_state WHERE key = 'remote_paired_devices'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!stored.contains(&token));

    // Listed with a fixed-name summary of the user agent.
    let devices = remote::devices(&state).await.unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name.browser, "Safari");
    assert_eq!(devices[0].name.os.as_deref(), Some("iPhone"));

    // Revoke: the phone is unpaired at once.
    remote::revoke_device(&state, &devices[0].id).await.unwrap();
    let r = raw(
        p,
        "POST",
        "/api/remote-control/channel/up",
        &with(lan_origin(p)),
        "",
    )
    .await;
    assert_eq!(r.status, 401);
    assert!(remote::revoke_device(&state, &devices[0].id).await.is_err());

    // Two phones, then Reset pairing revokes both and the open code.
    let c1 = cookie_of(&pair(p, &remote::mint_pairing_code(&state)).await);
    let c2 = cookie_of(&pair(p, &remote::mint_pairing_code(&state)).await);
    let open_code = remote::mint_pairing_code(&state);
    assert_eq!(remote::devices(&state).await.unwrap().len(), 2);
    remote::reset_pairing(&state).await.unwrap();
    for c in [c1, c2] {
        let r = raw(
            p,
            "GET",
            "/api/remote-control/status",
            &[lan_host(p), ("Cookie", c)],
            "",
        )
        .await;
        assert_eq!(r.status, 401);
    }
    assert_eq!(pair(p, &open_code).await.status, 401);
    assert!(remote::devices(&state).await.unwrap().is_empty());
    assert_no_command(&mut rx);
}

#[tokio::test]
async fn sessions_survive_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let cookie = {
        let (state, _rx) = desktop_state(tmp.path()).await;
        let s = serve_as(&state, PHONE).await;
        let r = pair(s.port, &remote::mint_pairing_code(&state)).await;
        assert_eq!(r.status, 200);
        cookie_of(&r)
    };
    // A new app state over the same data dir (the desktop app restarted).
    let (state, _rx) = desktop_state(tmp.path()).await;
    assert_eq!(remote::devices(&state).await.unwrap().len(), 1);
    let s = serve_as(&state, PHONE).await;
    let p = s.port;
    let r = raw(
        p,
        "GET",
        "/api/remote-control/status",
        &[lan_host(p), ("Cookie", cookie)],
        "",
    )
    .await;
    assert_eq!(r.status, 200);
}

/// R-remote-F3: when the stored device list cannot be read, phones get 503
/// and keep their cookie, pairing waits, and the list is not overwritten.
#[tokio::test]
async fn unreadable_device_list_is_kept_and_retried() {
    let tmp = tempfile::tempdir().unwrap();
    let cookie = {
        let (state, _rx) = desktop_state(tmp.path()).await;
        let s = serve_as(&state, PHONE).await;
        let r = pair(s.port, &remote::mint_pairing_code(&state)).await;
        assert_eq!(r.status, 200);
        cookie_of(&r)
    };
    let (state, _rx) = desktop_state(tmp.path()).await;
    let hide = |sql: &str| state.conn().unwrap().execute(sql, []).unwrap();
    hide("ALTER TABLE app_state RENAME TO app_state_hidden");
    let s = serve_as(&state, PHONE).await;
    let p = s.port;
    let headers = [lan_host(p), ("Cookie", cookie.clone())];
    let status = || raw(p, "GET", "/api/remote-control/status", &headers, "");
    let r = status().await;
    assert_eq!(r.status, 503, "{:?}", r.body);
    assert!(r.header("set-cookie").is_none());
    assert!(r.header("retry-after").is_some());
    let code = remote::mint_pairing_code(&state);
    assert_eq!(pair(p, &code).await.status, 503);
    assert!(remote::devices(&state).await.is_err());

    // The database recovers: the stored phone works again, nothing was lost,
    // and the code was not used up by the refused attempt.
    hide("ALTER TABLE app_state_hidden RENAME TO app_state");
    assert_eq!(status().await.status, 200);
    assert_eq!(remote::devices(&state).await.unwrap().len(), 1);
    assert_eq!(pair(p, &code).await.status, 200);
    assert_eq!(remote::devices(&state).await.unwrap().len(), 2);
}

#[tokio::test]
async fn wrong_codes_are_rate_limited() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, _rx) = desktop_state(tmp.path()).await;
    let s = serve_as(&state, PHONE).await;
    let p = s.port;
    let good = remote::mint_pairing_code(&state);
    for i in 0..remote::pairing::PAIR_FAILS_PER_PEER {
        let r = pair(p, &format!("guess{i}")).await;
        assert_eq!(r.status, 401, "attempt {i}");
    }
    let r = pair(p, "guess-more").await;
    assert_eq!(r.status, 429);
    assert_eq!(r.body["error"], "rate_limited");
    assert!(r.header("retry-after").is_some());
    // Locked out even with the right code until the window passes.
    assert_eq!(pair(p, &good).await.status, 429);
    assert!(remote::devices(&state).await.unwrap().is_empty());
    // Malformed bodies are refused before they reach the limiter's count.
    let r = raw(
        p,
        "POST",
        "/api/remote-control/pair",
        &[lan_host(p), ("Content-Type", "application/json".into())],
        "{",
    )
    .await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn lan_host_and_origin_guard_blocks_rebinding() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, mut rx) = desktop_state(tmp.path()).await;
    let s = serve_as(&state, PHONE).await;
    let p = s.port;
    let path = "/api/remote-control/channel/up";
    let host = |h: String| vec![("Host", h)];

    // DNS rebinding: the attacker's page sends its own name as Host.
    for h in [
        "evil.example".to_string(),
        format!("evil.example:{p}"),
        format!("192.168.1.5.nip.io:{p}"),
        format!("localhost:{p}"),
        format!("127.0.0.1:{p}"),
        // An address we do not listen on, or another port.
        format!("192.168.1.6:{p}"),
        format!("{LAN_IP}:{}", p.wrapping_add(1)),
        LAN_IP.to_string(),
        format!("0x{:x}:{p}", u32::from(LAN_IP)),
        format!("192.168.001.005:{p}"),
        format!("[::ffff:{LAN_IP}]:{p}"),
    ] {
        let r = raw(p, "POST", path, &host(h.clone()), "").await;
        assert_eq!(r.status, 403, "{h}");
        assert_eq!(r.body["error"], "forbidden");
    }
    // Foreign or mismatched origins.
    for o in [
        "http://evil.example".to_string(),
        "null".to_string(),
        format!("https://{LAN_IP}:{p}"),
        format!("http://{LAN_IP}:{}", p.wrapping_add(1)),
        format!("http://127.0.0.1:{p}"),
        format!("http://192.168.1.6:{p}"),
    ] {
        let r = raw(p, "POST", path, &[lan_host(p), ("Origin", o.clone())], "").await;
        assert_eq!(r.status, 403, "{o}");
    }
    // Our own origin passes the guard and then needs a session.
    let r = raw(p, "POST", path, &[lan_host(p), lan_origin(p)], "").await;
    assert_eq!(r.status, 401);
    assert_no_command(&mut rx);
}

#[tokio::test]
async fn public_and_unlisted_peers_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, _rx) = desktop_state(tmp.path()).await;
    for peer in ["8.8.8.8:4000", "100.64.0.9:4000", "[2001:db8::1]:4000"] {
        let s = serve_as(&state, peer).await;
        let r = raw(s.port, "GET", "/", &[lan_host(s.port)], "").await;
        assert_eq!(r.status, 403, "{peer}");
    }
}

#[tokio::test]
async fn loopback_is_unchanged_and_needs_no_pairing() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, mut rx) = desktop_state(tmp.path()).await;
    let s = serve_as(&state, "127.0.0.1:50000").await;
    let p = s.port;
    let lo = ("Host", format!("127.0.0.1:{p}"));
    let r = raw(
        p,
        "POST",
        "/api/remote-control/channel/up",
        std::slice::from_ref(&lo),
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(next_command(&mut rx).await["command"], "channelUp");
    // A loopback peer cannot use the LAN host either.
    let r = raw(
        p,
        "POST",
        "/api/remote-control/channel/up",
        &[lan_host(p)],
        "",
    )
    .await;
    assert_eq!(r.status, 403);
    // Pairing is pointless on this computer.
    let r = raw(
        p,
        "POST",
        "/api/remote-control/pair",
        &[lo, ("Content-Type", "application/json".into())],
        &json!({"code": remote::mint_pairing_code(&state)}).to_string(),
    )
    .await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn server_mode_has_no_lan_remote() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(8);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    // Even with the setting on, server mode never plans a LAN listener.
    state.settings.write().remote_lan_enabled = true;
    let info = remote::start_on(state.clone(), 0).await.unwrap();
    let st = remote::server_status(&state);
    assert!(st.running);
    assert!(st.lan_addresses.is_empty());
    assert!(st.lan_error.is_none());
    assert_eq!(info.url, format!("http://127.0.0.1:{}", info.port));

    let mut router = RpcRouter::new();
    remote::rpc::register(&mut router);
    for cmd in [
        "remote.pairingCode",
        "remote.devices",
        "remote.resetPairing",
    ] {
        let e = router
            .dispatch(state.clone(), cmd, Value::Null)
            .await
            .unwrap_err();
        assert_eq!(e.code, iptv_core::error::RpcErrorCode::Unsupported, "{cmd}");
    }
    let e = router
        .dispatch(state.clone(), "remote.revokeDevice", json!({"id": "x"}))
        .await
        .unwrap_err();
    assert_eq!(e.code, iptv_core::error::RpcErrorCode::Unsupported);
    remote::stop(state.clone()).await.unwrap();

    // Nothing was stored.
    let v: Option<String> = state
        .conn()
        .unwrap()
        .query_row(
            "SELECT value FROM app_state WHERE key = 'remote_paired_devices'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert!(v.is_none());
}

#[tokio::test]
async fn desktop_pairing_code_needs_lan_running() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, _rx) = desktop_state(tmp.path()).await;
    let mut router = RpcRouter::new();
    remote::rpc::register(&mut router);
    let e = router
        .dispatch(state.clone(), "remote.pairingCode", Value::Null)
        .await
        .unwrap_err();
    assert_eq!(e.code, iptv_core::error::RpcErrorCode::Conflict);
    // Loopback-only server (LAN mode off): still no pairing code.
    remote::start_on(state.clone(), 0).await.unwrap();
    let e = router
        .dispatch(state.clone(), "remote.pairingCode", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, iptv_core::error::RpcErrorCode::Conflict);
    let devices = router
        .dispatch(state.clone(), "remote.devices", Value::Null)
        .await
        .unwrap();
    assert_eq!(devices, json!([]));
    remote::stop(state.clone()).await.unwrap();
}
