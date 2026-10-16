//! B9 review round 1: TMDB key redaction in server mode.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::{AppState, BroadcastSink};
use serde_json::json;
use std::sync::Arc;
use support::{drain, env};

fn router() -> iptv_core::rpc::RpcRouter {
    let mut r = iptv_core::rpc::RpcRouter::new();
    iptv_core::settings::rpc::register(&mut r);
    r
}

const KEY: &str = "abcdefghijklmnop1234";
const MASKED: &str = "\u{2022}\u{2022}\u{2022}\u{2022}1234";

/// Server mode: `settings.get`, `settings.update` and `settings.changed`
/// never carry the TMDB key in clear; resending the mask or omitting the key
/// keeps the stored one, and `null` still clears it.
#[tokio::test]
async fn server_mode_masks_the_tmdb_key() {
    let mut env = env().await; // is_desktop = false (server mode)
    let r = router();
    let st = env.state.clone();
    let reply = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": { "tmdb": { "apiKey": KEY } } }),
        )
        .await
        .unwrap();
    assert_eq!(reply["tmdb"]["apiKey"], MASKED, "{reply}");
    let events = drain(&mut env.events);
    let changed = events
        .iter()
        .rev()
        .find(|e| e.kind == "settings.changed")
        .expect("settings.changed");
    assert_eq!(changed.payload["tmdb"]["apiKey"], MASKED);
    assert!(!changed.payload.to_string().contains(KEY));
    let got = r
        .dispatch(st.clone(), "settings.get", json!(null))
        .await
        .unwrap();
    assert_eq!(got["tmdb"]["apiKey"], MASKED);
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));

    // The UI resends the whole tmdb object, mask included.
    let mut tmdb = got["tmdb"].clone();
    tmdb["enabled"] = json!(!got["tmdb"]["enabled"].as_bool().unwrap_or(false));
    r.dispatch(
        st.clone(),
        "settings.update",
        json!({ "patch": { "tmdb": tmdb } }),
    )
    .await
    .unwrap();
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));
    // Omitted: kept.
    r.dispatch(
        st.clone(),
        "settings.update",
        json!({ "patch": { "tmdb": { "language": "de-DE" } } }),
    )
    .await
    .unwrap();
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));
    // A new key replaces it; null clears it.
    r.dispatch(
        st.clone(),
        "settings.update",
        json!({ "patch": { "tmdb": { "apiKey": "zyxwvutsrqponmlk9876" } } }),
    )
    .await
    .unwrap();
    assert_eq!(
        st.settings_snapshot().tmdb.api_key.as_deref(),
        Some("zyxwvutsrqponmlk9876")
    );
    let cleared = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": { "tmdb": { "apiKey": null } } }),
        )
        .await
        .unwrap();
    assert!(
        cleared["tmdb"].get("apiKey").is_none_or(|v| v.is_null()),
        "{cleared}"
    );
    assert_eq!(st.settings_snapshot().tmdb.api_key, None);
}

/// The desktop app is unchanged: it sees its own key.
#[tokio::test]
async fn desktop_sees_the_tmdb_key() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(100);
    let st: Arc<AppState> = AppState::new(dir.path().to_path_buf(), Arc::new(sink), true)
        .await
        .unwrap();
    let r = router();
    let reply = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": { "tmdb": { "apiKey": KEY } } }),
        )
        .await
        .unwrap();
    assert_eq!(reply["tmdb"]["apiKey"], KEY);
    let got = r
        .dispatch(st.clone(), "settings.get", json!(null))
        .await
        .unwrap();
    assert_eq!(got["tmdb"]["apiKey"], KEY);
}

/// Review round 2: in server mode, Reset then Undo (which resends the
/// pre-reset settings, mask included) keeps the TMDB key. A reset keeps the
/// key (L2-settings-9), and a mask of some other key does not replace it.
#[tokio::test]
async fn server_mode_reset_then_undo_restores_the_tmdb_key() {
    let env = env().await; // server mode
    let r = router();
    let st = env.state.clone();
    let before = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": { "tmdb": { "apiKey": KEY, "language": "de-DE" } } }),
        )
        .await
        .unwrap();
    assert_eq!(before["tmdb"]["apiKey"], MASKED);

    // A reset keeps the key (L2-settings-9); a wrong mask does not replace it.
    r.dispatch(st.clone(), "settings.reset", json!(null))
        .await
        .unwrap();
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));
    let mut wrong = before.clone();
    wrong["tmdb"]["apiKey"] = json!("\u{2022}\u{2022}\u{2022}\u{2022}9999");
    r.dispatch(
        st.clone(),
        "settings.update",
        json!({ "patch": { "tmdb": wrong["tmdb"].clone() } }),
    )
    .await
    .unwrap();
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));

    // Undo: the whole pre-reset document goes back as the patch.
    r.dispatch(st.clone(), "settings.reset", json!(null))
        .await
        .unwrap();
    let reply = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": before.clone() }),
        )
        .await
        .unwrap();
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));
    assert_eq!(reply["tmdb"]["apiKey"], MASKED);
    assert_eq!(
        st.settings_snapshot().tmdb.language.as_deref(),
        Some("de-DE")
    );
}
