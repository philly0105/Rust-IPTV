//! `settings.*` and `window.*` through the router: merge-patch update,
//! validation, persistence across restarts, `settings.changed`, window state.

use iptv_core::error::RpcErrorCode;
use iptv_core::events::AppEvent;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::settings::rpc::register(&mut r);
    r
}

/// Server-mode state (`is_desktop = false`).
async fn app(dir: &Path) -> (Arc<AppState>, Receiver<AppEvent>) {
    app_mode(dir, false).await
}

/// Desktop-mode state: player paths and folders are editable.
async fn desktop(dir: &Path) -> (Arc<AppState>, Receiver<AppEvent>) {
    app_mode(dir, true).await
}

async fn app_mode(dir: &Path, is_desktop: bool) -> (Arc<AppState>, Receiver<AppEvent>) {
    let (sink, rx) = BroadcastSink::channel(256);
    let state = AppState::new(dir.to_path_buf(), Arc::new(sink), is_desktop)
        .await
        .unwrap();
    (state, rx)
}

async fn call(
    r: &RpcRouter,
    s: &Arc<AppState>,
    cmd: &str,
    args: Value,
) -> Result<Value, iptv_core::error::RpcError> {
    r.dispatch(s.clone(), cmd, args).await
}

fn changed_events(rx: &mut Receiver<AppEvent>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if ev.kind == "settings.changed" {
            out.push(ev.payload);
        }
    }
    out
}

#[tokio::test]
async fn registers_every_command() {
    let r = router();
    for name in [
        "settings.get",
        "settings.update",
        "settings.reset",
        "settings.detectPlayers",
        "window.getState",
        "window.setState",
    ] {
        assert!(r.contains(name), "{name} not registered");
    }
}

#[tokio::test]
async fn update_merges_persists_and_emits() {
    let dir = tempfile::tempdir().unwrap();
    let r = router();
    {
        let (s, mut rx) = app(dir.path()).await;
        let before = call(&r, &s, "settings.get", Value::Null).await.unwrap();
        assert_eq!(before["language"], "en");

        let after = call(
            &r,
            &s,
            "settings.update",
            json!({"patch": {"language": "de", "remoteControl": {"port": 9000}, "epgUrls": ["http://a/epg.xml", "http://a/epg.xml"]}}),
        )
        .await
        .unwrap();
        assert_eq!(after["language"], "de");
        assert_eq!(after["remoteControl"]["port"], 9000);
        // Nested merge keeps sibling keys.
        assert_eq!(
            after["remoteControl"]["enabled"],
            before["remoteControl"]["enabled"]
        );
        assert_eq!(after["epgUrls"], json!(["http://a/epg.xml"]));
        assert_eq!(after["theme"], before["theme"]);
        assert_eq!(s.settings_snapshot().language, "de");

        let events = changed_events(&mut rx);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["language"], "de");

        // A no-op patch writes nothing and emits nothing.
        call(
            &r,
            &s,
            "settings.update",
            json!({"patch": {"language": "de"}}),
        )
        .await
        .unwrap();
        assert!(changed_events(&mut rx).is_empty());
    }
    // Restart: the stored settings are loaded.
    let (s, _rx) = app(dir.path()).await;
    let got = call(&r, &s, "settings.get", json!({})).await.unwrap();
    assert_eq!(got["language"], "de");
    assert_eq!(got["remoteControl"]["port"], 9000);
}

#[tokio::test]
async fn update_validates() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = desktop(dir.path()).await;
    let r = router();
    for patch in [
        json!({"remoteControl": {"port": 80}}),
        json!({"remoteControl": {"port": 70000}}),
        json!({"language": "xx"}),
        json!({"mpvPath": dir.path().join("missing-mpv.exe").to_string_lossy()}),
        json!({"downloadsDir": dir.path().join("missing-dir").to_string_lossy()}),
        json!({"recordingsDir": dir.path().join("missing-rec").to_string_lossy()}),
        json!({"lastRoute": "no-slash"}),
        json!({"theme": 5}),
        json!({"epgOffsetMinutes": 721}),
        json!({"epgOffsetMinutes": -721}),
        json!({"vodMinRating": 11}),
        json!({"vodMinRating": -0.5}),
        json!({"stripCountryPrefix": "yes"}),
        // appearance:
        json!({"accent": "neon"}),
        json!({"density": "cozy"}),
        json!({"uiScale": 0.85}),
        json!({"uiScale": 1.3}),
        json!({"uiScale": "1.1"}),
        json!({"oledBlack": "yes"}),
        json!({"zapBanner": 0}),
        json!({"dashboardRails": {"myList": "no"}}),
    ] {
        let err = call(&r, &s, "settings.update", json!({ "patch": patch.clone() }))
            .await
            .expect_err(&format!("{patch} should be rejected"));
        assert_eq!(err.code, RpcErrorCode::Invalid, "{patch}: {}", err.message);
    }
    assert!(call(&r, &s, "settings.update", json!({"patch": [1]}))
        .await
        .is_err());
    assert!(changed_events(&mut rx).is_empty());

    // Existing paths are accepted; null clears.
    let downloads = dir.path().join("dl");
    std::fs::create_dir_all(&downloads).unwrap();
    let got = call(
        &r,
        &s,
        "settings.update",
        json!({"patch": {"downloadsDir": downloads.to_string_lossy(), "language": "ZHTW"}}),
    )
    .await
    .unwrap();
    assert_eq!(got["downloadsDir"], json!(downloads.to_string_lossy()));
    assert_eq!(got["language"], "zhtw");
    let got = call(
        &r,
        &s,
        "settings.update",
        json!({"patch": {"downloadsDir": null}}),
    )
    .await
    .unwrap();
    assert!(got.get("downloadsDir").is_none_or(Value::is_null));
}

#[tokio::test]
async fn reset_restores_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = app(dir.path()).await;
    let r = router();
    let defaults = call(&r, &s, "settings.get", Value::Null).await.unwrap();
    call(
        &r,
        &s,
        "settings.update",
        json!({"patch": {"language": "fr", "showCaptions": true}}),
    )
    .await
    .unwrap();
    let reset = call(&r, &s, "settings.reset", Value::Null).await.unwrap();
    assert_eq!(reset, defaults);
    assert_eq!(changed_events(&mut rx).len(), 2);
    drop(s);
    let (s, _rx) = app(dir.path()).await;
    assert_eq!(
        call(&r, &s, "settings.get", Value::Null).await.unwrap(),
        defaults
    );
}

#[tokio::test]
async fn window_state_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let r = router();
    {
        let (s, _rx) = app(dir.path()).await;
        assert_eq!(
            call(&r, &s, "window.getState", Value::Null).await.unwrap(),
            Value::Null
        );
        let ws = json!({"x": -1200, "y": 40, "width": 1280, "height": 800, "maximized": true});
        call(&r, &s, "window.setState", json!({ "state": ws.clone() }))
            .await
            .unwrap();
        assert_eq!(
            call(&r, &s, "window.getState", Value::Null).await.unwrap(),
            ws
        );
        let err = call(
            &r,
            &s,
            "window.setState",
            json!({"state": {"width": 0, "height": 800}}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Invalid);
    }
    let (s, _rx) = app(dir.path()).await;
    let got = call(&r, &s, "window.getState", Value::Null).await.unwrap();
    assert_eq!(got["width"], 1280);
    assert_eq!(got["maximized"], true);
}

#[tokio::test]
async fn detect_players_returns_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (s, _rx) = app(dir.path()).await;
    let got = call(&router(), &s, "settings.detectPlayers", Value::Null)
        .await
        .unwrap();
    assert!(got.is_object(), "{got}");
}

#[tokio::test]
async fn empty_string_paths_clear_without_validation() {
    let dir = tempfile::tempdir().unwrap();
    let (s, _rx) = desktop(dir.path()).await;
    let r = router();
    let exe = dir.path().join("mpv.exe");
    std::fs::write(&exe, b"").unwrap();
    let got = call(
        &r,
        &s,
        "settings.update",
        json!({"patch": {"mpvPath": exe.to_string_lossy(), "vlcPath": exe.to_string_lossy()}}),
    )
    .await
    .unwrap();
    assert_eq!(got["mpvPath"], json!(exe.to_string_lossy()));
    // The UI clears a path by sending "" (also after the file is gone).
    std::fs::remove_file(&exe).unwrap();
    let got = call(
        &r,
        &s,
        "settings.update",
        json!({"patch": {"mpvPath": "", "vlcPath": "  "}}),
    )
    .await
    .unwrap();
    assert!(got.get("mpvPath").is_none_or(Value::is_null), "{got}");
    assert!(got.get("vlcPath").is_none_or(Value::is_null), "{got}");
    assert_eq!(s.settings_snapshot().mpv_path, None);
}

#[tokio::test]
async fn save_validates_persists_and_emits() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = desktop(dir.path()).await;
    let downloads = dir.path().join("videos");
    std::fs::create_dir_all(&downloads).unwrap();

    let mut next = s.settings_snapshot();
    next.downloads_dir = Some(downloads.to_string_lossy().into_owned());
    let saved = iptv_core::settings::save(&s, next.clone()).await.unwrap();
    assert_eq!(saved.downloads_dir, next.downloads_dir);
    assert_eq!(s.settings_snapshot().downloads_dir, next.downloads_dir);
    assert_eq!(changed_events(&mut rx).len(), 1);

    // Unchanged: no event.
    iptv_core::settings::save(&s, saved.clone()).await.unwrap();
    assert!(changed_events(&mut rx).is_empty());

    // Invalid: rejected, cache untouched.
    let mut bad = saved.clone();
    bad.downloads_dir = Some(dir.path().join("missing").to_string_lossy().into_owned());
    assert!(iptv_core::settings::save(&s, bad).await.is_err());
    assert_eq!(s.settings_snapshot(), saved);

    drop(s);
    let (s, _rx) = app(dir.path()).await;
    assert_eq!(s.settings_snapshot().downloads_dir, next.downloads_dir);
}

#[tokio::test]
async fn new_fields_have_documented_defaults_and_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let r = router();
    {
        let (s, _rx) = desktop(dir.path()).await;
        let got = call(&r, &s, "settings.get", Value::Null).await.unwrap();
        assert_eq!(got["stripCountryPrefix"], false);
        assert_eq!(got["epgOffsetMinutes"], 0);
        assert_eq!(got["playerReuseInstance"], true);
        assert_eq!(got["showExternalBar"], true);
        assert_eq!(got["vodMinRating"], 0.0);
        assert!(
            got.get("recordingsDir").is_some_and(Value::is_null),
            "{got}"
        );

        let rec = dir.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let got = call(
            &r,
            &s,
            "settings.update",
            json!({"patch": {
                "stripCountryPrefix": true,
                "epgOffsetMinutes": -90,
                "playerReuseInstance": false,
                "showExternalBar": false,
                "vodMinRating": 6.5,
                "recordingsDir": format!("  {}  ", rec.to_string_lossy()),
            }}),
        )
        .await
        .unwrap();
        assert_eq!(got["recordingsDir"], json!(rec.to_string_lossy()));
        assert_eq!(got["epgOffsetMinutes"], -90);
    }
    // Persisted across a restart.
    let (s, _rx) = desktop(dir.path()).await;
    let snap = s.settings_snapshot();
    assert!(snap.strip_country_prefix);
    assert_eq!(snap.epg_offset_minutes, -90);
    assert!(!snap.player_reuse_instance);
    assert!(!snap.show_external_bar);
    assert_eq!(snap.vod_min_rating, 6.5);
    assert!(snap.recordings_dir.is_some());

    // Older stored JSON without the new keys reads with the defaults.
    let old: iptv_core::model::Settings =
        serde_json::from_value(json!({"language": "de"})).unwrap();
    assert!(old.player_reuse_instance && old.show_external_bar);
    assert_eq!(old.recordings_dir, None);
}

/// C1 appearance fields: defaults, update over RPC (server mode too: they are
/// not desktop-only), the `settings.changed` payload, persistence, and reset.
#[tokio::test]
async fn appearance_fields_update_persist_and_reset() {
    let dir = tempfile::tempdir().unwrap();
    let r = router();
    {
        let (s, mut rx) = app(dir.path()).await;
        let got = call(&r, &s, "settings.get", Value::Null).await.unwrap();
        assert_eq!(got["accent"], "amber");
        assert_eq!(got["oledBlack"], false);
        assert_eq!(got["density"], "comfortable");
        assert_eq!(got["uiScale"], 1.0);
        assert_eq!(got["zapBanner"], true);
        assert_eq!(got["dashboardRails"]["myList"], true);

        let got = call(
            &r,
            &s,
            "settings.update",
            json!({"patch": {
                "accent": "teal",
                "oledBlack": true,
                "density": "compact",
                "uiScale": 1.1500000000000001,
                "zapBanner": false,
                "dashboardRails": {"myList": false},
            }}),
        )
        .await
        .unwrap();
        assert_eq!(got["accent"], "teal");
        assert_eq!(got["density"], "compact");
        assert_eq!(got["uiScale"], 1.15, "slider noise is rounded away");
        assert_eq!(got["dashboardRails"]["myList"], false);
        assert_eq!(
            got["dashboardRails"]["hero"], true,
            "other rails keep their value"
        );
        let events = changed_events(&mut rx);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["accent"], "teal");
        assert_eq!(events[0]["oledBlack"], true);

        // The range ends are accepted.
        for v in [0.9, 1.25] {
            let got = call(&r, &s, "settings.update", json!({"patch": {"uiScale": v}}))
                .await
                .unwrap();
            assert_eq!(got["uiScale"], v);
        }
        // A rejected value leaves the stored one alone.
        let err = call(
            &r,
            &s,
            "settings.update",
            json!({"patch": {"uiScale": 1.26}}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::Invalid);
        assert!(err.message.contains("uiScale"), "{}", err.message);
        assert_eq!(s.settings_snapshot().ui_scale, 1.25);
    }
    // Persisted across a restart.
    let (s, _rx) = app(dir.path()).await;
    let snap = s.settings_snapshot();
    assert_eq!(snap.accent, iptv_core::model::Accent::Teal);
    assert!(snap.oled_black);
    assert_eq!(snap.density, iptv_core::model::Density::Compact);
    assert_eq!(snap.ui_scale, 1.25);
    assert!(!snap.zap_banner);
    assert!(!snap.dashboard_rails.my_list);

    let reset = call(&r, &s, "settings.reset", Value::Null).await.unwrap();
    assert_eq!(reset["accent"], "amber");
    assert_eq!(reset["uiScale"], 1.0);
    assert_eq!(reset["dashboardRails"]["myList"], true);
}

#[tokio::test]
async fn server_mode_refuses_player_and_folder_settings() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = app(dir.path()).await;
    let r = router();
    let exe = dir.path().join("evil.exe");
    std::fs::write(&exe, b"").unwrap();
    let folder = dir.path().join("f");
    std::fs::create_dir_all(&folder).unwrap();
    for patch in [
        json!({"mpvPath": exe.to_string_lossy()}),
        json!({"vlcPath": exe.to_string_lossy()}),
        json!({"mpvArgs": "--script=evil.lua"}),
        json!({"vlcArgs": "--extraintf=lua"}),
        json!({"downloadsDir": folder.to_string_lossy()}),
        json!({"recordingsDir": folder.to_string_lossy()}),
        // Refused before validation: no hint whether the path exists.
        json!({"mpvPath": dir.path().join("missing.exe").to_string_lossy()}),
        json!({"theme": "dark", "vlcArgs": "x"}),
    ] {
        let err = call(&r, &s, "settings.update", json!({ "patch": patch.clone() }))
            .await
            .expect_err(&format!("{patch} should be refused in server mode"));
        assert_eq!(err.code, RpcErrorCode::Unsupported, "{patch}");
        assert!(
            err.message.contains("only to the desktop app"),
            "{}",
            err.message
        );
    }
    assert!(changed_events(&mut rx).is_empty());
    assert_eq!(s.settings_snapshot(), iptv_core::model::Settings::default());

    // Other fields, and echoing the current (unchanged) values back, still work.
    let mut full = call(&r, &s, "settings.get", Value::Null).await.unwrap();
    full["theme"] = json!("light");
    full["vodMinRating"] = json!(4);
    let got = call(&r, &s, "settings.update", json!({ "patch": full }))
        .await
        .unwrap();
    assert_eq!(got["theme"], "light");
    assert_eq!(got["vodMinRating"], 4.0);

    // `save` refuses the player fields and recordings folder as well.
    let mut next = s.settings_snapshot();
    next.mpv_args = "--evil".into();
    let err = iptv_core::settings::save(&s, next).await.unwrap_err();
    assert!(matches!(err, iptv_core::CoreError::Unsupported(_)), "{err}");
    let mut next = s.settings_snapshot();
    next.recordings_dir = Some(folder.to_string_lossy().into_owned());
    assert!(iptv_core::settings::save(&s, next).await.is_err());
}
