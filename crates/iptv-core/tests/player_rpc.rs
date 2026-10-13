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

const EXPECTED: [&str; 13] = [
    "mpv.attach",
    "mpv.command",
    "mpv.detach",
    "mpv.load",
    "mpv.record",
    "mpv.setBounds",
    "mpv.setProperty",
    "mpv.state",
    "mpv.stats",
    "player.capabilities",
    "player.detect",
    "player.openExternal",
    "player.stopExternal",
];

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    player::rpc::register(&mut r);
    r
}

/// Desktop-mode state (players are desktop-only).
async fn app() -> (tempfile::TempDir, Arc<AppState>, Receiver<AppEvent>) {
    app_mode(true).await
}

async fn app_mode(is_desktop: bool) -> (tempfile::TempDir, Arc<AppState>, Receiver<AppEvent>) {
    let dir = tempfile::tempdir().unwrap();
    let (sink, rx) = BroadcastSink::channel(1024);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), is_desktop)
        .await
        .unwrap();
    (dir, state, rx)
}

/// R5 F1: in server mode a browser (possibly on another machine) must not
/// be able to start or probe processes on the host.
#[tokio::test]
async fn server_mode_refuses_every_player_command() {
    let (_d, state, _rx) = app_mode(false).await;
    let r = router();
    let src =
        json!({"url": "http://h/x", "kind": "hls", "title": "x", "isLive": true, "isRadio": false});
    let bounds = json!({"x": 0, "y": 0, "width": 10, "height": 10});
    for (cmd, args) in [
        ("player.detect", Value::Null),
        (
            "player.openExternal",
            json!({"player": "mpv", "source": src}),
        ),
        (
            "mpv.attach",
            json!({"bounds": bounds, "volume": 50, "muted": false}),
        ),
        ("mpv.load", json!({"source": src})),
        ("mpv.command", json!({"cmd": ["get_property", "pause"]})),
        ("mpv.setProperty", json!({"name": "pause", "value": true})),
        ("mpv.setBounds", json!({"bounds": bounds})),
        ("mpv.detach", Value::Null),
        ("mpv.state", Value::Null),
        ("mpv.record", json!({"start": true})),
        ("mpv.stats", Value::Null),
        ("player.stopExternal", Value::Null),
    ] {
        let err = r.dispatch(Arc::clone(&state), cmd, args).await.unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Unsupported, "{cmd}: {err:?}");
        assert_eq!(err.message, "Players run only in the desktop app", "{cmd}");
    }
    // Capabilities stay readable so the UI can explain why.
    let caps = r
        .dispatch(state, "player.capabilities", Value::Null)
        .await
        .unwrap();
    assert_eq!(caps["embeddedMpv"], json!(false));
}

/// R4 F1: hostile playlist URLs never reach a player.
#[tokio::test]
async fn open_external_and_load_refuse_non_media_schemes() {
    let (_d, state, _rx) = app().await;
    let r = router();
    for url in [
        "--log-file=C:/x",
        "--script=//host/share/pwn.lua",
        "av://lavfi:testsrc",
        "edl://x",
    ] {
        let src =
            json!({"url": url, "kind": "hls", "title": "x", "isLive": true, "isRadio": false});
        let err = r
            .dispatch(
                Arc::clone(&state),
                "player.openExternal",
                json!({"player": "mpv", "source": src}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Invalid, "{url}");
        if cfg!(windows) {
            let err = r
                .dispatch(Arc::clone(&state), "mpv.load", json!({"source": src}))
                .await
                .unwrap_err();
            assert_eq!(err.code, RpcErrorCode::Invalid, "mpv.load {url}");
        }
    }
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
    let (_d, state, mut rx) = app().await;
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
        // B9: a failed attach is reported like a crash: an `mpv.state`
        // event and the polled state both carry the error.
        let ev = next_event(&mut rx, "mpv.state", Duration::from_secs(2), |_| true).await;
        assert_eq!(ev["attached"], json!(false));
        assert!(ev["error"].as_str().is_some_and(|e| !e.is_empty()), "{ev}");
        let st = r
            .dispatch(Arc::clone(&state), "mpv.state", Value::Null)
            .await
            .unwrap();
        assert_eq!(st["error"], ev["error"]);
        for (cmd, args) in [
            ("mpv.load", json!({"source": src})),
            ("mpv.command", json!({"cmd": ["get_property", "pause"]})),
            ("mpv.setProperty", json!({"name": "pause", "value": true})),
            ("mpv.setBounds", bounds.clone()),
            ("mpv.record", json!({"start": true})),
            ("mpv.stats", Value::Null),
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
async fn open_external_missing_player_is_engine_missing() {
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
    // C12: not `not_found`, which the UI shows as "this stream no longer exists".
    assert_eq!(err.code, RpcErrorCode::EngineMissing);
    assert!(
        err.message.contains("Settings > Players"),
        "{}",
        err.message
    );
}

/// C12: a configured player file that cannot run is `engine_missing`.
#[cfg(windows)]
#[tokio::test]
async fn open_external_unrunnable_player_is_engine_missing() {
    let (_d, state, _rx) = app().await;
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("mpv.exe");
    std::fs::write(&fake, b"this is not a program").unwrap();
    state.settings.write().mpv_path = Some(fake.display().to_string());
    let src =
        json!({"url": "http://h/x", "kind": "hls", "title": "x", "isLive": true, "isRadio": false});
    let err = router()
        .dispatch(
            state,
            "player.openExternal",
            json!({"player": "mpv", "source": src}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::EngineMissing, "{err:?}");
    assert!(err.message.contains("could not start"), "{}", err.message);
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

/// D14 (review round 1): a configured "mpv" that exits before opening its
/// IPC pipe fails the attach at once with a clear message, and the window
/// is cleaned up.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_reports_mpv_exiting_during_startup() {
    let (_d, state, _rx) = app().await;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let quitter = std::path::Path::new(&root).join(r"System32\whoami.exe");
    assert!(quitter.is_file(), "{}", quitter.display());
    state.settings.write().mpv_path = Some(quitter.display().to_string());
    let factory = Arc::new(FakeFactory::default());
    player::set_window_factory(&state, factory.clone());
    let started = std::time::Instant::now();
    let err = tokio::time::timeout(
        Duration::from_secs(20),
        router().dispatch(
            Arc::clone(&state),
            "mpv.attach",
            json!({"bounds": {"x": 0, "y": 0, "width": 320, "height": 180}}),
        ),
    )
    .await
    .expect("attach must not hang")
    .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid, "{err:?}");
    assert!(
        err.message.contains("exited during startup"),
        "{}",
        err.message
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    let calls = factory.calls.lock().clone();
    assert_eq!(
        calls.last().map(String::as_str),
        Some("destroy"),
        "{calls:?}"
    );
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
    // MPEG-TS like a live stream (stream-record needs packet timestamps).
    let clip = dir.path().join("clip, test.ts");
    let status = std::process::Command::new(&mpv)
        .args([
            "--no-config",
            "av://lavfi:testsrc=duration=60:size=160x120:rate=10",
            // A keyframe every second: stream-record starts at a keyframe.
            "--ovcopts=g=10",
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
    // Small read-ahead so stream-record sees packets after it starts (the
    // whole tiny clip would otherwise already sit in the demuxer cache).
    state.settings.write().mpv_args = format!(
        "--vo=null --ao=null --cache=no --demuxer-readahead-secs=1 --log-file={}",
        dir.path().join("mpv.log").display()
    );
    let factory = Arc::new(FakeFactory::default());
    player::set_window_factory(&state, factory.clone());
    let r = router();

    let caps = r
        .dispatch(Arc::clone(&state), "player.capabilities", Value::Null)
        .await
        .unwrap();
    assert_eq!(caps["embeddedMpv"], json!(true), "{caps}");

    // Attach with the UI's saved volume/mute (R4 F4), then a second attach
    // only moves the window.
    let st = r
        .dispatch(
            Arc::clone(&state),
            "mpv.attach",
            json!({"bounds": {"x": 1, "y": 2, "width": 320, "height": 180}, "volume": 55, "muted": true}),
        )
        .await
        .unwrap();
    assert_eq!(st["attached"], json!(true));
    assert_eq!(st["volume"], json!(55.0), "{st}");
    assert_eq!(st["muted"], json!(true), "{st}");
    assert_eq!(st["recording"], json!(false), "{st}");
    let vol = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "volume"]}),
        )
        .await
        .unwrap();
    assert_eq!(vol, json!(55.0));
    let mute = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "mute"]}),
        )
        .await
        .unwrap();
    assert_eq!(mute, json!(true));
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

    // Stream info snapshot (player slice): what the clip is, never its path.
    let stats = r
        .dispatch(Arc::clone(&state), "mpv.stats", Value::Null)
        .await
        .unwrap();
    assert_eq!(stats["width"], json!(160), "{stats}");
    assert_eq!(stats["height"], json!(120), "{stats}");
    assert!(
        stats["videoCodec"].as_str().is_some_and(|c| !c.is_empty()),
        "{stats}"
    );
    assert_eq!(stats["container"], json!("mpegts"), "{stats}");
    assert!(!stats.to_string().contains("clip"), "{stats}");
    // Audio and subtitle delay (seconds) go through the property allowlist.
    for name in ["audio-delay", "sub-delay"] {
        r.dispatch(
            Arc::clone(&state),
            "mpv.setProperty",
            json!({"name": name, "value": 0.3}),
        )
        .await
        .unwrap();
        let v = r
            .dispatch(
                Arc::clone(&state),
                "mpv.command",
                json!({"cmd": ["get_property", name]}),
            )
            .await
            .unwrap();
        assert!((v.as_f64().unwrap() - 0.3).abs() < 1e-6, "{name}: {v}");
    }

    // Recording (stream-record) into settings.recordingsDir.
    let rec_dir = dir.path().join("rec");
    state.settings.write().recordings_dir = Some(rec_dir.display().to_string());
    let rec = r
        .dispatch(Arc::clone(&state), "mpv.record", json!({"start": true}))
        .await
        .unwrap();
    assert_eq!(rec["recording"], json!(true), "{rec}");
    let rec_path = std::path::PathBuf::from(rec["path"].as_str().unwrap());
    assert_eq!(rec_path.parent().unwrap(), rec_dir);
    let name = rec_path.file_name().unwrap().to_string_lossy().to_string();
    assert!(
        name.starts_with("Test, Pattern-") && name.ends_with(".ts"),
        "{name}"
    );
    let st = r
        .dispatch(Arc::clone(&state), "mpv.state", Value::Null)
        .await
        .unwrap();
    assert_eq!(st["recording"], json!(true));
    assert_eq!(st["recordPath"], rec["path"]);
    let prop = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "stream-record"]}),
        )
        .await
        .unwrap();
    assert_eq!(prop, rec["path"]);
    // The short clip may already sit fully in the demuxer cache, and the
    // recorder only sees packets read after it starts: seek back to the
    // start so packets flow again, then wait for the first bytes.
    r.dispatch(
        Arc::clone(&state),
        "mpv.command",
        json!({"cmd": ["seek", 0, "absolute+exact"]}),
    )
    .await
    .unwrap();
    for _ in 0..50 {
        if std::fs::metadata(&rec_path).map(|m| m.len()).unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let stop = r
        .dispatch(Arc::clone(&state), "mpv.record", json!({"start": false}))
        .await
        .unwrap();
    assert_eq!(stop, json!({"recording": false, "path": null}));
    let prop = r
        .dispatch(
            Arc::clone(&state),
            "mpv.command",
            json!({"cmd": ["get_property", "stream-record"]}),
        )
        .await
        .unwrap();
    assert_eq!(prop, json!(""));
    let mut size = 0;
    for _ in 0..20 {
        size = std::fs::metadata(&rec_path).map(|m| m.len()).unwrap_or(0);
        if size > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        size > 0,
        "recording {} is empty: {}",
        rec_path.display(),
        std::fs::read_to_string(dir.path().join("mpv.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.contains("record") || l.contains("rror"))
            .collect::<Vec<_>>()
            .join(
                "
"
            )
    );

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

/// `playerReuseInstance`: a second external launch closes the first player
/// this app started; with the setting off both keep running.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reuse_instance_closes_previous_external_player() {
    let (_d, state, mut rx) = app().await;
    let Some(mpv) = player::detect(&state.settings_snapshot()).mpv_path else {
        eprintln!("skipping: no mpv found");
        return;
    };
    {
        let mut s = state.settings.write();
        s.mpv_path = Some(mpv);
        // --idle keeps mpv alive after the unreachable URL fails.
        s.mpv_args = "--no-config --idle=yes --vo=null --ao=null --force-window=no".into();
        assert!(s.player_reuse_instance);
    }
    let r = router();
    let src = json!({"url": "http://127.0.0.1:9/x.ts", "kind": "direct", "title": "Reuse", "isLive": true, "isRadio": false});
    let launch = |r: &RpcRouter, state: &Arc<AppState>| {
        let (r, state, src) = (r.clone(), Arc::clone(state), src.clone());
        async move {
            r.dispatch(
                state,
                "player.openExternal",
                json!({"player": "mpv", "source": src}),
            )
            .await
            .unwrap()["pid"]
                .as_u64()
                .unwrap()
        }
    };
    let first = launch(&r, &state).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(player::external::running_pid(&state), Some(first as u32));
    let second = launch(&r, &state).await;
    assert_ne!(first, second);
    next_event(&mut rx, "player.external", Duration::from_secs(10), |p| {
        p["state"] == "exited" && p["pid"] == json!(first)
    })
    .await;
    assert_eq!(player::external::running_pid(&state), Some(second as u32));

    // B9: two launches at once still leave exactly one player running.
    let (a, b) = tokio::join!(launch(&r, &state), launch(&r, &state));
    let tracked = player::external::running_pid(&state).expect("one tracked") as u64;
    assert!(tracked == a || tracked == b);
    let other = if tracked == a { b } else { a };
    for gone in [second, other] {
        next_event(&mut rx, "player.external", Duration::from_secs(10), |p| {
            p["state"] == "exited" && p["pid"] == json!(gone)
        })
        .await;
    }
    let second = tracked;

    // Reuse off: the next launch leaves the running one alone.
    state.settings.write().player_reuse_instance = false;
    let third = launch(&r, &state).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let alive = |pid: u64| {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    };
    assert!(alive(second), "second player must survive with reuse off");
    assert!(alive(third));

    // player.stopExternal ends the tracked (last) player and clears it.
    let out = r
        .dispatch(Arc::clone(&state), "player.stopExternal", Value::Null)
        .await
        .unwrap();
    assert_eq!(out, json!({"stopped": true}));
    next_event(&mut rx, "player.external", Duration::from_secs(10), |p| {
        p["state"] == "exited" && p["pid"] == json!(third)
    })
    .await;
    assert_eq!(player::external::running_pid(&state), None);
    let out = r
        .dispatch(Arc::clone(&state), "player.stopExternal", Value::Null)
        .await
        .unwrap();
    assert_eq!(out, json!({"stopped": false}));
    for pid in [second, third] {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[tokio::test]
async fn stop_external_without_player_reports_false() {
    let (_d, state, _rx) = app().await;
    let out = router()
        .dispatch(state, "player.stopExternal", Value::Null)
        .await
        .unwrap();
    assert_eq!(out, json!({"stopped": false}));
}

/// B9: after a crash only volume and mute survive; the dead stream's rewind
/// window and buffering flag are not reported.
#[test]
fn detached_state_clears_the_dead_stream() {
    use iptv_core::model::{MpvSeekRange, MpvState};
    let live = MpvState {
        attached: true,
        loaded: true,
        paused: false,
        time_pos: 42.0,
        duration: Some(100.0),
        volume: 35.0,
        muted: true,
        fullscreen: true,
        recording: true,
        record_path: Some("C:/r.ts".into()),
        seekable: Some(MpvSeekRange {
            start: 10.0,
            end: 50.0,
        }),
        buffering: Some(true),
        ..MpvState::default()
    };
    let gone = player::embedded::detached_state(live, Some("mpv stopped unexpectedly".into()));
    assert_eq!(
        gone,
        MpvState {
            volume: 35.0,
            muted: true,
            error: Some("mpv stopped unexpectedly".into()),
            ..MpvState::default()
        }
    );
    let v = serde_json::to_value(&gone).unwrap();
    assert!(v.get("seekable").is_none() && v.get("buffering").is_none());
}
