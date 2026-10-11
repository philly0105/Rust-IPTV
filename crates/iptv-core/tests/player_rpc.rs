//! `player.*` / `mpv.*` registration and behaviour through the router.
//!
//! The embedded end-to-end test drives a real mpv (`--vo=null --ao=null`,
//! lavfi test source) when one is detectable on Windows, and skips with a
//! note otherwise.

use iptv_core::error::RpcErrorCode;
use iptv_core::events::AppEvent;
use iptv_core::player::{self, Bounds, ChildWindowFactory};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink, CoreResult};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

const EXPECTED: [&str; 10] = [
    "mpv.attach",
    "mpv.command",
    "mpv.detach",
    "mpv.load",
    "mpv.setBounds",
    "mpv.setProperty",
    "mpv.state",
    "player.capabilities",
    "player.detect",
    "player.openExternal",
];

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    player::rpc::register(&mut r);
    r
}

async fn app() -> (tempfile::TempDir, Arc<AppState>, Receiver<AppEvent>) {
    let dir = tempfile::tempdir().unwrap();
    let (sink, rx) = BroadcastSink::channel(1024);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    (dir, state, rx)
}

#[test]
fn registers_exactly_the_c4_names() {
    let r = router();
    assert_eq!(r.names(), EXPECTED.to_vec());
    let mut listed = player::rpc::COMMANDS.to_vec();
    listed.sort_unstable();
    assert_eq!(listed, EXPECTED.to_vec());
    for name in EXPECTED {
        assert!(r.contains(name), "{name} not registered");
    }
}

#[tokio::test]
async fn capabilities_without_window_factory() {
    let (_d, state, _rx) = app().await;
    let caps = router()
        .dispatch(Arc::clone(&state), "player.capabilities", Value::Null)
        .await
        .unwrap();
    assert_eq!(caps["embeddedMpv"], json!(false));
    let reason = caps["reason"].as_str().unwrap();
    if cfg!(windows) {
        assert!(reason.contains("desktop app"), "{reason}");
    } else {
        assert!(reason.contains("only available on Windows"), "{reason}");
    }
}

#[test]
fn unavailable_reasons() {
    use player::embedded_unavailable_reason as r;
    assert!(r(false, true, true).unwrap().contains("Windows"));
    assert!(r(true, true, false).unwrap().contains("desktop"));
    assert!(r(true, false, true).unwrap().contains("vendor"));
    assert_eq!(r(true, true, true), None);
}

#[tokio::test]
async fn detect_returns_camel_case_object() {
    let (_d, state, _rx) = app().await;
    let v = router()
        .dispatch(state, "player.detect", Value::Null)
        .await
        .unwrap();
    assert!(v.is_object());
    for k in v.as_object().unwrap().keys() {
        assert!(k == "mpvPath" || k == "vlcPath", "unexpected key {k}");
    }
}

#[tokio::test]
async fn open_external_validates_args() {
    let (_d, state, _rx) = app().await;
    let r = router();
    let err = r
        .dispatch(
            Arc::clone(&state),
            "player.openExternal",
            json!({"player": "winamp", "source": {}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);

    let src = json!({"url": "  ", "kind": "hls", "title": "x", "isLive": true, "isRadio": false});
    let err = r
        .dispatch(
            state,
            "player.openExternal",
            json!({"player": "mpv", "source": src}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
}

#[tokio::test]
async fn mpv_commands_without_session() {
    let (_d, state, _rx) = app().await;
    let r = router();
    let src =
        json!({"url": "http://h/x", "kind": "hls", "title": "x", "isLive": true, "isRadio": false});
    let bounds = json!({"bounds": {"x": 0, "y": 0, "width": 10, "height": 10}});
    if cfg!(windows) {
        // No window factory (server mode): attach explains why.
        let err = r
            .dispatch(Arc::clone(&state), "mpv.attach", bounds.clone())
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Unsupported);
        for (cmd, args) in [
            ("mpv.load", json!({"source": src})),
            ("mpv.command", json!({"cmd": ["get_property", "pause"]})),
            ("mpv.setProperty", json!({"name": "pause", "value": true})),
            ("mpv.setBounds", bounds.clone()),
        ] {
            let err = r.dispatch(Arc::clone(&state), cmd, args).await.unwrap_err();
            assert_eq!(err.code, RpcErrorCode::Conflict, "{cmd}: {err:?}");
        }
        // Detach is idempotent and state reports detached.
        r.dispatch(Arc::clone(&state), "mpv.detach", Value::Null)
            .await
            .unwrap();
        let st = r.dispatch(state, "mpv.state", Value::Null).await.unwrap();
        assert_eq!(st["attached"], json!(false));
        assert_eq!(st["volume"], json!(100.0));
    } else {
        for cmd in ["mpv.attach", "mpv.state", "mpv.detach"] {
            let err = r
                .dispatch(Arc::clone(&state), cmd, bounds.clone())
                .await
                .unwrap_err();
            assert_eq!(err.code, RpcErrorCode::Unsupported, "{cmd}");
        }
    }
}

async fn next_event(
    rx: &mut Receiver<AppEvent>,
    kind: &str,
    timeout: Duration,
    mut pred: impl FnMut(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Ok(ev)) if ev.kind == kind && pred(&ev.payload) => return ev.payload,
            Ok(Ok(_)) => {}
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
            Ok(Err(e)) => panic!("event channel failed: {e}"),
            Err(_) => panic!("timed out waiting for {kind}"),
        }
    }
}

#[cfg(windows)]
#[tokio::test]
async fn open_external_emits_started_and_exited() {
    // whoami.exe rejects mpv's flags and exits at once: a harmless stand-in
    // that exercises spawn, pid, and the exit watcher.
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let fake = std::path::Path::new(&root)
        .join("System32")
        .join("whoami.exe");
    if !fake.is_file() {
        eprintln!("skipping: {} missing", fake.display());
        return;
    }
    let (_d, state, mut rx) = app().await;
    state.settings.write().mpv_path = Some(fake.display().to_string());
    let src = json!({"url": "http://127.0.0.1:9/x.m3u8", "kind": "hls", "title": "Fake \"Title\"", "isLive": true, "isRadio": false,
        "headers": {"userAgent": "UA, 1", "origin": "http://o"}});
    let out = router()
        .dispatch(
            Arc::clone(&state),
            "player.openExternal",
            json!({"player": "mpv", "source": src}),
        )
        .await
        .unwrap();
    let pid = out["pid"].as_u64().unwrap();
    assert!(pid > 0);
    let started = next_event(&mut rx, "player.external", Duration::from_secs(5), |p| {
        p["state"] == "started"
    })
    .await;
    assert_eq!(
        started,
        json!({"state": "started", "player": "mpv", "title": "Fake \"Title\"", "pid": pid})
    );
    let exited = next_event(&mut rx, "player.external", Duration::from_secs(10), |p| {
        p["state"] == "exited"
    })
    .await;
    assert_eq!(exited["pid"], json!(pid));
    assert!(exited["exitCode"].is_i64(), "{exited}");
}

#[tokio::test]
async fn open_external_missing_player_is_not_found() {
    let (_d, state, _rx) = app().await;
    let dir = tempfile::tempdir().unwrap();
    // A configured path that does not exist falls back to search; force a
    // miss for VLC only when the machine has none installed.
    let settings = state.settings_snapshot();
    if player::detect(&settings).vlc_path.is_some() {
        eprintln!("skipping: VLC is installed on this machine");
        return;
    }
    state.settings.write().vlc_path = Some(dir.path().join("nope.exe").display().to_string());
    let src =
        json!({"url": "http://h/x", "kind": "hls", "title": "x", "isLive": true, "isRadio": false});
    let err = router()
        .dispatch(
            state,
            "player.openExternal",
            json!({"player": "vlc", "source": src}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    assert!(
        err.message.contains("Settings > Players"),
        "{}",
        err.message
    );
}

/// Records window calls; hands mpv a dummy HWND (video output is null).
#[derive(Default)]
struct FakeFactory {
    calls: Mutex<Vec<String>>,
}

impl ChildWindowFactory for FakeFactory {
    fn create(&self, b: Bounds) -> CoreResult<isize> {
        self.calls
            .lock()
            .push(format!("create {} {} {} {}", b.x, b.y, b.width, b.height));
        Ok(0)
    }
    fn set_bounds(&self, _hwnd: isize, b: Bounds) -> CoreResult<()> {
        self.calls
            .lock()
            .push(format!("bounds {} {} {} {}", b.x, b.y, b.width, b.height));
        Ok(())
    }
    fn destroy(&self, _hwnd: isize) -> CoreResult<()> {
        self.calls.lock().push("destroy".into());
        Ok(())
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn embedded_session_end_to_end_with_real_mpv() {
    let (dir, state, mut rx) = app().await;
    let Some(mpv) = player::detect(&state.settings_snapshot()).mpv_path else {
        eprintln!("skipping: no mpv found (put one in vendor/mpv or on PATH)");
        return;
    };
    // A real, seekable 60 s file encoded by mpv itself.
    let clip = dir.path().join("clip, test.mkv");
    let status = std::process::Command::new(&mpv)
        .args([
            "--no-config",
            "av://lavfi:testsrc=duration=60:size=160x120:rate=10",
        ])
        .arg(format!("--o={}", clip.display()))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    if !status.success() || !clip.is_file() {
        eprintln!("skipping: this mpv build cannot encode the test clip");
        return;
    }
    state.settings.write().mpv_args = "--vo=null --ao=null".into();
    let factory = Arc::new(FakeFactory::default());
    player::set_window_factory(&state, factory.clone());
    let r = router();

    let caps = r
        .dispatch(Arc::clone(&state), "player.capabilities", Value::Null)
        .await
        .unwrap();
    assert_eq!(caps["embeddedMpv"], json!(true), "{caps}");

    // Attach, then a second attach only moves the window.
    let st = r
        .dispatch(
            Arc::clone(&state),
            "mpv.attach",
            json!({"bounds": {"x": 1, "y": 2, "width": 320, "height": 180}}),
        )
        .await
        .unwrap();
    assert_eq!(st["attached"], json!(true));
    r.dispatch(
        Arc::clone(&state),
        "mpv.attach",
        json!({"bounds": {"x": 5, "y": 6, "width": 640, "height": 360}}),
    )
    .await
    .unwrap();
    assert_eq!(
        *factory.calls.lock(),
        ["create 1 2 320 180", "bounds 5 6 640 360"]
    );

    // Load the clip (a path with a comma and a space) with a resume position.
    let src = json!({
        "url": clip.display().to_string(),
        "kind": "file", "title": "Test, Pattern", "isLive": false, "isRadio": false, "resumeSeconds": 7,
        "headers": {"userAgent": "TsrustTest/1, x", "referrer": "http://r/", "origin": "http://o"}
    });
    r.dispatch(Arc::clone(&state), "mpv.load", json!({"source": src}))
        .await
        .unwrap();
    let loaded = next_event(&mut rx, "mpv.state", Duration::from_secs(15), |p| {
        p["loaded"] == json!(true)
            && p["timePos"].as_f64().unwrap_or(0.0) >= 6.5
            && p["duration"].is_f64()
    })
    .await;
    assert!(
        (loaded["duration"].as_f64().unwrap() - 60.0).abs() < 1.0,
        "{loaded}"
    );
    assert_eq!(loaded["attached"], json!(true));

    // Per-file options reached mpv.
    let ua = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "user-agent"]}),
        )
        .await
        .unwrap();
    assert_eq!(ua, json!("TsrustTest/1, x"));
    let title = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "media-title"]}),
        )
        .await
        .unwrap();
    assert_eq!(title, json!("Test, Pattern"));

    // Properties and commands.
    r.dispatch(
        Arc::clone(&state),
        "mpv.setProperty",
        json!({"name": "pause", "value": true}),
    )
    .await
    .unwrap();
    next_event(&mut rx, "mpv.state", Duration::from_secs(5), |p| {
        p["paused"] == json!(true)
    })
    .await;
    r.dispatch(
        Arc::clone(&state),
        "mpv.setProperty",
        json!({"name": "volume", "value": 40}),
    )
    .await
    .unwrap();
    next_event(&mut rx, "mpv.state", Duration::from_secs(5), |p| {
        p["volume"] == json!(40.0)
    })
    .await;
    r.dispatch(
        Arc::clone(&state),
        "mpv.command",
        json!({"cmd": ["seek", 30, "absolute"]}),
    )
    .await
    .unwrap();
    next_event(&mut rx, "mpv.state", Duration::from_secs(5), |p| {
        p["timePos"].as_f64().unwrap_or(0.0) >= 29.0
    })
    .await;
    let err = r
        .dispatch(Arc::clone(&state), "mpv.command", json!({"cmd": ["quit"]}))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    let err = r
        .dispatch(
            Arc::clone(&state),
            "mpv.setProperty",
            json!({"name": "no-such-prop", "value": 1}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    let st = r
        .dispatch(Arc::clone(&state), "mpv.state", Value::Null)
        .await
        .unwrap();
    assert_eq!(st["paused"], json!(true));
    r.dispatch(
        Arc::clone(&state),
        "mpv.setBounds",
        json!({"bounds": {"x": 0, "y": 0, "width": 100, "height": 50}}),
    )
    .await
    .unwrap();

    // Crash: kill mpv behind our back -> error state, window destroyed.
    let pid = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "pid"]}),
        )
        .await
        .unwrap()
        .as_u64()
        .unwrap();
    let status = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let crashed = next_event(&mut rx, "mpv.state", Duration::from_secs(10), |p| {
        p["attached"] == json!(false)
    })
    .await;
    assert!(
        crashed["error"].as_str().unwrap().contains("unexpectedly"),
        "{crashed}"
    );
    assert_eq!(factory.calls.lock().last().unwrap(), "destroy");
    let st = r
        .dispatch(Arc::clone(&state), "mpv.state", Value::Null)
        .await
        .unwrap();
    assert_eq!(st["attached"], json!(false));
    assert_eq!(
        st["volume"],
        json!(40.0),
        "volume survives for the next attach"
    );

    // Re-attach after the crash, then a clean detach (idempotent).
    let st = r
        .dispatch(
            Arc::clone(&state),
            "mpv.attach",
            json!({"bounds": {"x": 0, "y": 0, "width": 320, "height": 180}}),
        )
        .await
        .unwrap();
    assert_eq!(st["attached"], json!(true));
    assert!(st.get("error").is_none(), "{st}");
    r.dispatch(Arc::clone(&state), "mpv.detach", Value::Null)
        .await
        .unwrap();
    let detached = next_event(&mut rx, "mpv.state", Duration::from_secs(5), |p| {
        p["attached"] == json!(false)
    })
    .await;
    assert!(detached.get("error").is_none(), "{detached}");
    r.dispatch(Arc::clone(&state), "mpv.detach", Value::Null)
        .await
        .unwrap();
    let calls = factory.calls.lock().clone();
    assert_eq!(calls.iter().filter(|c| c.starts_with("create")).count(), 2);
    assert_eq!(calls.iter().filter(|c| *c == "destroy").count(), 2);
}

#[tokio::test]
async fn kill_embedded_without_session_is_noop() {
    let (_d, state, _rx) = app().await;
    player::kill_embedded(&state);
    player::shutdown(&state).await;
}
