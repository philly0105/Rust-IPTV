//! L2-perf-core-2: writes that wait for an import's write lock hold their
//! pooled connection while they wait; a burst of user writes (through
//! `AppState::db_write`, as the user-write RPCs do) must still leave
//! connections for reads.
//!
//! DB-1: the user-write RPCs moved behind that gate (lists, stats, channel
//! edits, favorites) and background writes (`AppState::writer`, as the TMDB
//! cache uses) do the same.

use iptv_core::events::BroadcastSink;
use iptv_core::AppState;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reads_do_not_queue_behind_ten_waiting_writes() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(16);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    // An import's save: the write lock held, and long waits allowed.
    let holder = rusqlite::Connection::open(state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();

    // The measured burst: 10 user writes during the save.
    let writers: Vec<_> = (0..10)
        .map(|i| {
            let st = state.clone();
            tokio::spawn(async move {
                st.db_write(move |c| {
                    c.execute(
                        "INSERT INTO app_state(key, value) VALUES (?1, 'x')",
                        [format!("w{i}")],
                    )?;
                    Ok(())
                })
                .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let started = Instant::now();
    let n: i64 = state
        .db_call(|c| Ok(c.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?))
        .await
        .unwrap();
    let waited = started.elapsed();
    assert_eq!(n, 0);
    assert!(
        waited < Duration::from_secs(1),
        "a read queued behind the waiting writes for {waited:?}"
    );

    holder.execute_batch("COMMIT").unwrap();
    for w in writers {
        w.await.unwrap().unwrap();
    }
    drop(long);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gated_rpcs_and_background_writes_leave_reads_free() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(256);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    state
        .db_call(|c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('s1', 'm3u', 'S', '{}')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let router = Arc::new(iptv_core::rpc::build_router());
    let holder = rusqlite::Connection::open(state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();

    let calls = [
        ("lists.create", json!({"name": "One"})),
        ("lists.create", json!({"name": "Two"})),
        ("stats.clear", json!({})),
        ("channels.reset", json!({"sourceId": "s1"})),
        ("favorites.reorder", json!({"refs": []})),
    ];
    let writers: Vec<_> = calls
        .into_iter()
        .map(|(cmd, args)| {
            let (st, r) = (state.clone(), router.clone());
            tokio::spawn(async move { r.dispatch(st, cmd, args).await })
        })
        .collect();
    for i in 0..5 {
        state.writer().spawn("test", move |c| {
            c.execute(
                "INSERT INTO app_state(key, value) VALUES (?1, 'x')",
                [format!("bg{i}")],
            )?;
            Ok(())
        });
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    let started = Instant::now();
    let n: i64 = state
        .db_call(|c| Ok(c.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?))
        .await
        .unwrap();
    let waited = started.elapsed();
    assert_eq!(n, 1);
    assert!(
        waited < Duration::from_secs(1),
        "a read queued behind the waiting writes for {waited:?}"
    );

    holder.execute_batch("COMMIT").unwrap();
    for w in writers {
        w.await.unwrap().unwrap();
    }
    state.flush_background_writes().await;
    drop(long);
}
