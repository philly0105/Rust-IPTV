//! L1-settings-1: a backup carries every machine-independent preference.
//! Every settings field is either in `backup::APP_SETTING_KEYS` or in the
//! documented `backup::APP_SETTING_EXCLUDED`, and the exported ones survive
//! export, reset and import.

use iptv_core::backup::{APP_SETTING_EXCLUDED, APP_SETTING_KEYS};
use iptv_core::model::{Settings, VideoPlayer};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

/// A new settings field fails here until it is exported or excluded with a
/// reason. Optional fields serialize only when set, so they are set.
#[test]
fn every_settings_field_is_exported_or_explicitly_excluded() {
    let full = Settings {
        live_player: Some(VideoPlayer::Html5),
        catchup_player: Some(VideoPlayer::Html5),
        vod_player: Some(VideoPlayer::Html5),
        last_route: Some("/live".into()),
        mpv_path: Some("mpv".into()),
        vlc_path: Some("vlc".into()),
        downloads_dir: Some("d".into()),
        recordings_dir: Some("r".into()),
        ..Settings::default()
    };
    let v = serde_json::to_value(&full).unwrap();
    let fields: BTreeSet<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    let exported: BTreeSet<&str> = APP_SETTING_KEYS.iter().copied().collect();
    let excluded: BTreeSet<&str> = APP_SETTING_EXCLUDED.iter().map(|(k, _)| *k).collect();
    assert_eq!(exported.len(), APP_SETTING_KEYS.len(), "duplicate export");
    assert_eq!(
        excluded.len(),
        APP_SETTING_EXCLUDED.len(),
        "duplicate exclusion"
    );
    let both: Vec<_> = exported.intersection(&excluded).collect();
    assert!(both.is_empty(), "exported and excluded: {both:?}");
    let neither: Vec<_> = fields
        .iter()
        .filter(|f| !exported.contains(*f) && !excluded.contains(*f))
        .collect();
    assert!(
        neither.is_empty(),
        "settings fields neither in APP_SETTING_KEYS nor in APP_SETTING_EXCLUDED: {neither:?}"
    );
    let unknown: Vec<_> = exported
        .union(&excluded)
        .filter(|k| !fields.contains(*k))
        .collect();
    assert!(unknown.is_empty(), "not settings fields: {unknown:?}");
    for (k, why) in APP_SETTING_EXCLUDED {
        assert!(!why.trim().is_empty(), "{k} has no reason");
    }
    // docs/architecture/backup.md: these never travel.
    for k in [
        "liveFailover",
        "streamReconnect",
        "remoteLanEnabled",
        "remoteControl",
        "tmdb",
        "mpvPath",
        "downloadsDir",
        "imageCacheMaxMb",
        "tourCompleted",
        "lastSeenVersion",
    ] {
        assert!(excluded.contains(k), "{k} must stay out of backups");
    }
}

/// A non-default value for every exported key.
fn non_defaults() -> Value {
    let mut patch = Map::new();
    let defaults = serde_json::to_value(Settings::default()).unwrap();
    let explicit = json!({
        "language": "de",
        "theme": "dark",
        "startupBehavior": "first-view",
        "coverSize": "large",
        "epgViewMode": "list",
        "streamFormat": "ts",
        "epgOffsetMinutes": 60,
        "vodMinRating": 6.5,
        "liveMinQuality": "fhd",
        "sourceRefreshIntervalHours": 24,
        "accountExpiryWarnDays": 14,
        "recordingPaddingBeforeMinutes": 2,
        "recordingPaddingAfterMinutes": 10,
        "reminderLeadMinutes": 5,
        "reminderAction": "switch",
        "accent": "teal",
        "density": "compact",
        "uiScale": 1.25,
        "subtitleSize": "large",
        "subtitleColor": "yellow",
        "subtitleBackground": "solid",
        "subtitlePosition": 10,
    });
    for k in APP_SETTING_KEYS {
        let value = match (&defaults[k], explicit.get(k)) {
            (_, Some(v)) => v.clone(),
            (Value::Bool(b), None) => json!(!b),
            (Value::Object(o), None) => Value::Object(
                o.iter()
                    .map(|(sub, v)| (sub.clone(), json!(!v.as_bool().unwrap())))
                    .collect(),
            ),
            (other, None) => panic!("{k}: give a non-default value for {other}"),
        };
        assert_ne!(
            value, defaults[k],
            "{k}: the value must differ from the default"
        );
        patch.insert(k.to_string(), value);
    }
    Value::Object(patch)
}

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::backup::rpc::register(&mut r);
    iptv_core::settings::rpc::register(&mut r);
    r
}

#[tokio::test]
async fn every_exported_preference_survives_export_reset_import() {
    for desktop in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (sink, _rx) = BroadcastSink::channel(256);
        let st = AppState::new(dir.path().to_path_buf(), Arc::new(sink), desktop)
            .await
            .unwrap();
        let r = router();
        let patch = non_defaults();
        r.dispatch(st.clone(), "settings.update", json!({ "patch": patch }))
            .await
            .unwrap_or_else(|e| panic!("settings.update failed: {}", e.message));
        let want = serde_json::to_value(st.settings_snapshot()).unwrap();
        for (k, v) in patch.as_object().unwrap() {
            assert_eq!(&want[k], v, "{k} was stored (desktop={desktop})");
        }

        let out = r
            .dispatch(st.clone(), "backup.export", json!({}))
            .await
            .unwrap();
        let backup = out["json"].as_str().unwrap().to_string();
        let manifest: Value = serde_json::from_str(&backup).unwrap();
        for k in APP_SETTING_KEYS {
            assert_eq!(manifest["settings"][k], want[k], "{k} exported");
        }
        for (k, _) in APP_SETTING_EXCLUDED {
            if k != "epgUrls" {
                assert!(manifest["settings"].get(k).is_none(), "{k} not exported");
            }
        }

        r.dispatch(st.clone(), "settings.reset", json!(null))
            .await
            .unwrap();
        let reset = serde_json::to_value(st.settings_snapshot()).unwrap();
        let defaults = serde_json::to_value(Settings::default()).unwrap();
        for k in APP_SETTING_KEYS {
            assert_eq!(reset[k], defaults[k], "{k} reset (desktop={desktop})");
        }

        let rep = r
            .dispatch(
                st.clone(),
                "backup.import",
                json!({ "json": backup, "mode": "merge" }),
            )
            .await
            .unwrap_or_else(|e| panic!("backup.import failed: {}", e.message));
        assert_eq!(rep["warnings"], json!([]), "{rep}");
        let got = serde_json::to_value(st.settings_snapshot()).unwrap();
        for k in APP_SETTING_KEYS {
            assert_eq!(got[k], want[k], "{k} restored (desktop={desktop})");
        }
    }
}
