//! L2-settings-9: `settings.reset` keeps the guide addresses (`epgUrls`) and
//! the TMDB key, in the desktop app and in server mode.

use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::json;
use std::sync::Arc;

const KEY: &str = "abcdefghijklmnop1234";
const MASKED: &str = "\u{2022}\u{2022}\u{2022}\u{2022}1234";

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::settings::rpc::register(&mut r);
    r
}

#[tokio::test]
async fn reset_keeps_epg_urls_and_the_tmdb_key() {
    for desktop in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (sink, _rx) = BroadcastSink::channel(256);
        let st = AppState::new(dir.path().to_path_buf(), Arc::new(sink), desktop)
            .await
            .unwrap();
        let r = router();
        r.dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": {
                "epgUrls": ["http://127.0.0.1:9/guide.xml"],
                "theme": "dark",
                "tmdb": { "enabled": true, "apiKey": KEY, "language": "de-DE" }
            } }),
        )
        .await
        .unwrap_or_else(|e| panic!("settings.update failed: {}", e.message));

        let reply = r
            .dispatch(st.clone(), "settings.reset", json!(null))
            .await
            .unwrap();
        let after = st.settings_snapshot();
        assert_eq!(
            after.epg_urls,
            ["http://127.0.0.1:9/guide.xml"],
            "desktop={desktop}"
        );
        assert_eq!(
            after.tmdb.api_key.as_deref(),
            Some(KEY),
            "desktop={desktop}"
        );
        // The rest resets, `tmdb.enabled` and `tmdb.language` included.
        let defaults = iptv_core::model::Settings::default();
        assert_eq!(after.theme, defaults.theme);
        assert_eq!(after.tmdb.enabled, defaults.tmdb.enabled);
        assert_eq!(after.tmdb.language, defaults.tmdb.language);
        // Server clients still see only the mask.
        let shown = if desktop { KEY } else { MASKED };
        assert_eq!(reply["tmdb"]["apiKey"], shown, "{reply}");
        assert_eq!(reply["epgUrls"], json!(["http://127.0.0.1:9/guide.xml"]));
    }
}

/// Server mode: Undo after a reset resends the pre-reset document with the
/// mask; the key, kept by the reset, stays, and the other fields come back.
#[tokio::test]
async fn server_mode_undo_after_reset_keeps_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(256);
    let st = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let r = router();
    let before = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": { "tmdb": { "apiKey": KEY, "language": "de-DE" } } }),
        )
        .await
        .unwrap();
    assert_eq!(before["tmdb"]["apiKey"], MASKED);
    r.dispatch(st.clone(), "settings.reset", json!(null))
        .await
        .unwrap();
    // A mask of some other key changes nothing.
    let mut wrong = before["tmdb"].clone();
    wrong["apiKey"] = json!("\u{2022}\u{2022}\u{2022}\u{2022}9999");
    r.dispatch(
        st.clone(),
        "settings.update",
        json!({ "patch": { "tmdb": wrong } }),
    )
    .await
    .unwrap();
    assert_eq!(st.settings_snapshot().tmdb.api_key.as_deref(), Some(KEY));
    r.dispatch(st.clone(), "settings.update", json!({ "patch": before }))
        .await
        .unwrap();
    let s = st.settings_snapshot();
    assert_eq!(s.tmdb.api_key.as_deref(), Some(KEY));
    assert_eq!(s.tmdb.language.as_deref(), Some("de-DE"));
}
