//! Check 10 (SC8): the loopback remote control drives channel changes and
//! rejects non-loopback hosts and foreign origins.

use iptv_core::events::{AppEvent, BroadcastSink};
use iptv_core::model::RemoteStatus;
use iptv_core::remote;
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast::Receiver;

struct Fixture {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    events: Receiver<AppEvent>,
    base: String,
    port: u16,
    http: reqwest::Client,
}

async fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(64);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let info = remote::start_on(state.clone(), 0).await.unwrap();
    assert_ne!(info.port, 0);
    assert_eq!(info.url, format!("http://127.0.0.1:{}", info.port));
    Fixture {
        _tmp: tmp,
        state,
        events,
        base: format!("{}/api/remote-control", info.url),
        port: info.port,
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap(),
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

fn assert_no_command(rx: &mut Receiver<AppEvent>) {
    while let Ok(ev) = rx.try_recv() {
        assert_ne!(
            ev.kind, "remote.command",
            "unexpected command: {:?}",
            ev.payload
        );
    }
}

/// Sends a raw HTTP/1.1 request so the Host header is exactly what we write.
async fn raw(port: u16, request: &str) -> u16 {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    s.write_all(request.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next().unwrap_or_default();
    line.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or_else(|| panic!("bad response: {text}"))
}

#[tokio::test]
async fn channel_up_emits_remote_command() {
    let mut f = fixture().await;
    let res = f
        .http
        .post(format!("{}/channel/up", f.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        next_command(&mut f.events).await,
        json!({"command": "channelUp"})
    );

    let res = f
        .http
        .post(format!("{}/channel/down", f.base))
        .header("Origin", format!("http://127.0.0.1:{}", f.port))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        next_command(&mut f.events).await,
        json!({"command": "channelDown"})
    );

    let res = f
        .http
        .post(format!("{}/channel/select", f.base))
        .header("Origin", format!("http://localhost:{}", f.port))
        .json(&json!({"number": 12}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        next_command(&mut f.events).await,
        json!({"command": "selectNumber", "number": 12})
    );

    let res = f
        .http
        .post(format!("{}/channel/select-id", f.base))
        .json(&json!({"id": "src1|abc"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        next_command(&mut f.events).await,
        json!({"command": "selectId", "id": "src1|abc"})
    );

    for (body, expected) in [
        (json!({"delta": 0.05}), json!({"command": "volumeUp"})),
        (json!({"delta": -0.05}), json!({"command": "volumeDown"})),
        (
            json!({"level": 0.4}),
            json!({"command": "setVolume", "level": 0.4}),
        ),
        (json!({"mute": true}), json!({"command": "mute"})),
    ] {
        let res = f
            .http
            .post(format!("{}/volume", f.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{body}");
        assert_eq!(next_command(&mut f.events).await, expected, "{body}");
    }

    // Invalid input is rejected without emitting anything.
    for (path, body) in [
        ("/channel/select", json!({"number": 0})),
        ("/channel/select", json!({})),
        ("/channel/select-id", json!({"id": "no-separator"})),
        ("/volume", json!({})),
        ("/volume", json!({"level": 250})),
    ] {
        let res = f
            .http
            .post(format!("{}{}", f.base, path))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "{path} {body}");
    }
    let res = f
        .http
        .post(format!("{}/channel/up", f.base))
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "up ignores its body");
    next_command(&mut f.events).await;
    assert_no_command(&mut f.events);
    remote::stop(f.state.clone()).await.unwrap();
}

#[tokio::test]
async fn foreign_origin_is_forbidden() {
    let mut f = fixture().await;
    for origin in [
        "http://evil.example".to_string(),
        "null".to_string(),
        format!("http://127.0.0.1:{}", f.port.wrapping_add(1)),
        format!("https://127.0.0.1:{}", f.port),
        format!("http://[::1]:{}", f.port),
    ] {
        let res = f
            .http
            .post(format!("{}/channel/up", f.base))
            .header("Origin", &origin)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 403, "{origin}");
        assert!(res.headers().get("access-control-allow-origin").is_none());
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"], "forbidden");
    }
    // GETs are guarded too (status must not leak to other sites).
    let res = f
        .http
        .get(format!("{}/status", f.base))
        .header("Origin", "http://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    assert_no_command(&mut f.events);
    remote::stop(f.state.clone()).await.unwrap();
}

#[tokio::test]
async fn non_loopback_host_is_forbidden() {
    let mut f = fixture().await;
    let p = f.port;
    let req = |host: &str| {
        format!(
            "POST /api/remote-control/channel/up HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    };
    assert_eq!(raw(p, &req("192.168.1.5")).await, 403);
    assert_eq!(raw(p, &req(&format!("192.168.1.5:{p}"))).await, 403);
    assert_eq!(raw(p, &req("evil.example")).await, 403);
    assert_eq!(raw(p, &req("localhost.evil.example")).await, 403);
    assert_no_command(&mut f.events);

    for host in [
        format!("127.0.0.1:{p}"),
        format!("localhost:{p}"),
        "localhost".into(),
        "[::1]".into(),
    ] {
        assert_eq!(raw(p, &req(&host)).await, 200, "{host}");
        assert_eq!(next_command(&mut f.events).await["command"], "channelUp");
    }
    remote::stop(f.state.clone()).await.unwrap();
}

#[tokio::test]
async fn status_and_channels_round_trip() {
    let f = fixture().await;
    let mut router = RpcRouter::new();
    remote::rpc::register(&mut router);

    let empty: Value = f
        .http
        .get(format!("{}/status", f.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(empty["isLive"], false);
    assert!(empty.get("updatedAt").is_none());

    let status = RemoteStatus {
        source_name: Some("Demo".into()),
        is_live: true,
        channel_name: Some("BBC One".into()),
        channel_number: Some(1),
        epg_now: Some("News".into()),
        volume: Some(0.5),
        muted: Some(false),
        can_volume: true,
    };
    router
        .dispatch(
            f.state.clone(),
            "remote.reportStatus",
            json!({"status": status}),
        )
        .await
        .unwrap();
    let res = f
        .http
        .get(format!("{}/status", f.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "no-store");
    let got: Value = res.json().await.unwrap();
    assert!(got["updatedAt"].as_str().unwrap().ends_with('Z'));
    let back: RemoteStatus = serde_json::from_value(got.clone()).unwrap();
    assert_eq!(back, status);
    assert_eq!(got["channelName"], "BBC One");
    assert_eq!(got["canVolume"], true);

    let channels: Vec<Value> = (1..=30)
        .map(|i| json!({"id": format!("s|{i}"), "name": format!("Channel {i}"), "number": i}))
        .collect();
    router
        .dispatch(
            f.state.clone(),
            "remote.publishChannels",
            json!({"channels": channels}),
        )
        .await
        .unwrap();
    let all: Value = f
        .http
        .get(format!("{}/channels", f.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(all["channels"].as_array().unwrap().len(), 30);
    assert_eq!(all["total"], 30);
    let found: Value = f
        .http
        .get(format!("{}/channels?q=channel%202&limit=5", f.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // "Channel 2", "Channel 20".."Channel 29" match; the page holds five.
    assert_eq!(found["total"], 11);
    assert_eq!(found["channels"].as_array().unwrap().len(), 5);
    assert_eq!(found["channels"][0]["id"], "s|2");

    // With a published list, unknown ids are refused.
    let res = f
        .http
        .post(format!("{}/channel/select-id", f.base))
        .json(&json!({"id": "s|999"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    // Asking to unmute while the reported status is unmuted is a no-op.
    let res: Value = f
        .http
        .post(format!("{}/volume", f.base))
        .json(&json!({"mute": false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(res["commands"], json!([]));

    remote::stop(f.state.clone()).await.unwrap();
}

#[tokio::test]
async fn index_page_is_served() {
    let f = fixture().await;
    let res = f
        .http
        .get(format!("http://127.0.0.1:{}/", f.port))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    assert!(res.headers().contains_key("content-security-policy"));
    let html = res.text().await.unwrap();
    assert!(html.contains("/api/remote-control"));
    assert!(!html.contains("https://cdn"), "no CDN assets");
    let res = f
        .http
        .get(format!("http://127.0.0.1:{}/nope", f.port))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    remote::stop(f.state.clone()).await.unwrap();
}

#[tokio::test]
async fn rpc_lifecycle_and_registration() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(8);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    remote::rpc::register(&mut router);
    for name in remote::rpc::COMMANDS {
        assert!(router.contains(name), "{name} not registered");
    }
    assert_eq!(
        router
            .names()
            .iter()
            .filter(|n| n.starts_with("remote."))
            .count(),
        5
    );

    let st = router
        .dispatch(state.clone(), "remote.status", Value::Null)
        .await
        .unwrap();
    assert_eq!(st, json!({"running": false, "port": 7310}));

    // Port 0 in settings picks a free port (never the real 7310 in tests).
    state.settings.write().remote_control.port = 0;
    let started = router
        .dispatch(state.clone(), "remote.start", Value::Null)
        .await
        .unwrap();
    let url = started["url"].as_str().unwrap().to_string();
    let st = router
        .dispatch(state.clone(), "remote.status", Value::Null)
        .await
        .unwrap();
    assert_eq!(st["running"], true);
    assert_eq!(st["url"], url);
    let port = st["port"].as_u64().unwrap() as u16;
    assert_eq!(url, format!("http://127.0.0.1:{port}"));

    // Starting again is idempotent.
    let again = router
        .dispatch(state.clone(), "remote.start", Value::Null)
        .await
        .unwrap();
    assert_eq!(again["url"], url);

    // A port held by someone else is a Conflict with a next step.
    let busy = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let busy_port = busy.local_addr().unwrap().port();
    let err = remote::start_on(state.clone(), busy_port)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("already in use") || err.to_string().contains("reserved"),
        "{err}"
    );
    // The failed switch leaves the running server untouched.
    let st = router
        .dispatch(state.clone(), "remote.status", Value::Null)
        .await
        .unwrap();
    assert_eq!(st["running"], true);
    assert_eq!(st["port"], port);
    drop(busy);

    router
        .dispatch(state.clone(), "remote.stop", Value::Null)
        .await
        .unwrap();
    let st = router
        .dispatch(state.clone(), "remote.status", Value::Null)
        .await
        .unwrap();
    assert_eq!(st["running"], false);
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
    // Stopping twice is fine.
    router
        .dispatch(state, "remote.stop", Value::Null)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_busy_port_at_startup_is_retried_until_it_frees_up() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(8);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let busy = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = busy.local_addr().unwrap().port();
    {
        let mut settings = state.settings.write();
        settings.remote_control.enabled = true;
        settings.remote_control.port = port;
    }
    assert!(remote::init(state.clone()).await.is_err());
    assert_eq!(remote::hub(&state).running_port(), None);
    drop(busy);

    // The watcher tries again without any settings change.
    let deadline = tokio::time::Instant::now() + remote::START_RETRY + Duration::from_secs(5);
    while remote::hub(&state).running_port().is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the remote server never started once the port was free"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(remote::hub(&state).running_port(), Some(port));
    remote::stop(state.clone()).await.unwrap();
}
