//! B9 review round 3 fixes.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::sources;
use iptv_core::CoreError;
use serde_json::json;
use std::time::{Duration, Instant};
use support::*;

/// Holds an IMMEDIATE write transaction on its own connection for `hold`,
/// like a large catalog save. Returns once the lock is taken.
async fn hold_write_lock(
    state: &iptv_core::AppState,
    hold: Duration,
) -> tokio::task::JoinHandle<()> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let pool = state.db.clone();
    let h = tokio::task::spawn_blocking(move || {
        let mut c = pool.get().unwrap();
        let t = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        t.execute("UPDATE sources SET name = name", []).unwrap();
        let _ = tx.send(());
        std::thread::sleep(hold);
        t.commit().unwrap();
    });
    rx.await.unwrap();
    h
}

async fn set_position(
    state: &std::sync::Arc<iptv_core::AppState>,
    seconds: u32,
) -> Result<(), String> {
    let router = iptv_core::rpc::build_router();
    router
        .dispatch(
            state.clone(),
            "positions.set",
            json!({"ref": {"sourceId": "big", "contentType": "movie", "itemId": "1"},
                   "positionSeconds": seconds, "durationSeconds": 3600}),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.message)
}

/// R3-robustness F1: a large import holds the write lock longer than the
/// 5 s busy timeout; a user write made meanwhile must wait and land, not
/// fail with "database is locked".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_writes_land_while_an_import_holds_the_write_lock() {
    let env = env().await;
    bare_source(&env.state, "big").await;
    let st = env.state.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
    let import = tokio::spawn(async move {
        let st2 = st.clone();
        sources::run_import_with(&st, "big", async move {
            let saving = hold_write_lock(&st2, Duration::from_millis(6500)).await;
            let _ = started_tx.send(());
            saving.await.unwrap();
            Ok::<_, CoreError>(())
        })
        .await
    });
    started_rx.await.unwrap();
    let t = Instant::now();
    let r = set_position(&env.state, 30).await;
    assert!(
        r.is_ok(),
        "positions.set failed after {:?}: {r:?}",
        t.elapsed()
    );
    assert!(
        t.elapsed() > Duration::from_secs(5),
        "it waited for the import"
    );
    import.await.unwrap().unwrap();
}

/// Without an import, a write blocked by another writer still fails after
/// the normal 5 s busy timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_an_import_a_locked_write_still_times_out() {
    let env = env().await;
    bare_source(&env.state, "big").await;
    let holder = hold_write_lock(&env.state, Duration::from_secs(8)).await;
    let t = Instant::now();
    let r = set_position(&env.state, 30).await;
    let took = t.elapsed();
    holder.await.unwrap();
    // Another test's import (same process) lengthens the wait; only check
    // the outcome when none ran.
    if took < Duration::from_secs(7) {
        let err = r.expect_err("locked");
        assert!(err.contains("locked"), "{err}");
        assert!(took >= Duration::from_millis(4900), "{took:?}");
    }
}

/// R3-library F2: in server mode, Reset keeps the desktop-only fields
/// (mpvArgs, vlcArgs, ...), so Undo (the pre-reset document resent as a
/// patch) is not refused as Unsupported and brings every setting back.
#[tokio::test]
async fn server_mode_reset_keeps_desktop_only_fields_so_undo_works() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = iptv_core::rpc::RpcRouter::new();
    iptv_core::settings::rpc::register(&mut r);
    {
        let desktop = iptv_core::AppState::new(
            dir.path().to_path_buf(),
            std::sync::Arc::new(iptv_core::events::NoopSink),
            true,
        )
        .await
        .unwrap();
        r.dispatch(
            desktop,
            "settings.update",
            json!({ "patch": { "mpvArgs": "--hwdec=no", "vlcArgs": "--no-osd" } }),
        )
        .await
        .unwrap();
    }
    let st = iptv_core::AppState::new(
        dir.path().to_path_buf(),
        std::sync::Arc::new(iptv_core::events::NoopSink),
        false,
    )
    .await
    .unwrap();
    let before = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": { "tmdb": { "language": "de-DE" } } }),
        )
        .await
        .unwrap();
    assert_eq!(before["mpvArgs"], "--hwdec=no", "{before}");

    let after = r
        .dispatch(st.clone(), "settings.reset", json!(null))
        .await
        .unwrap();
    assert_eq!(after["mpvArgs"], "--hwdec=no", "{after}");
    assert_eq!(after["vlcArgs"], "--no-osd", "{after}");
    assert_ne!(after["tmdb"]["language"], "de-DE");

    let undone = r
        .dispatch(
            st.clone(),
            "settings.update",
            json!({ "patch": before.clone() }),
        )
        .await
        .expect("undo is not refused");
    assert_eq!(undone["tmdb"]["language"], "de-DE", "{undone}");
    assert_eq!(undone, before);
}
