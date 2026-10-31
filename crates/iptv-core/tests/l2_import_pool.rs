//! L2-perf-core-2: writes that wait for an import's write lock hold their
//! pooled connection while they wait; a burst of user writes (through
//! `AppState::db_write`, as the user-write RPCs do) must still leave
//! connections for reads.
//!
//! DB-1: the user-write RPCs moved behind that gate (lists, stats, channel
//! edits, favorites) and background writes (`AppState::writer`, as the TMDB
//! cache uses) do the same.
//!
//! DB-1R: the periodic background writes (download progress, a recording's
//! byte count, the image cache index) pass a gate of their own
//! (`AppState::db_background`).
//!
//! R1-1: a Stalker login caches its session in the background, so a save
//! never holds the source's session mutex. Download cancel, remove and
//! position, and `sources.add` / `update` / `reorder` pass the user-write
//! gate; import outcomes, account statuses and window geometry pass the
//! background gate (R4-1), and a forced account check answers before its
//! row is stored.

use iptv_core::catalog::{replace_catalog, CategoryRow, ItemRow};
use iptv_core::events::BroadcastSink;
use iptv_core::model::ContentType;
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

/// The worst refresh the audit found (DB-1R): an import holds the write lock
/// and its pooled connection, two guide ingests hold one each, one gated user
/// write waits, and six periodic background writes wait. Before the
/// background gate each of those six parked a connection: ten holders for
/// eight connections, so reads waited for the 15 s checkout timeout. Now the
/// six park one between them and a burst of catalog pages keeps three.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_writes_park_one_connection_between_them() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(16);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    // 2,000 movies in 20 categories, so each page does some work.
    state
        .db_call(|c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('s1', 'xtream', 'S', '{}')",
                [],
            )?;
            let cats: Vec<CategoryRow> = (0..20)
                .map(|k| CategoryRow {
                    category_id: format!("c{k}"),
                    name: format!("Genre {k}"),
                    position: k,
                })
                .collect();
            let mut rows = (0..2_000).map(|i| ItemRow {
                source_id: "s1".into(),
                content_type: ContentType::Movie,
                item_id: format!("m{i}"),
                category_id: format!("c{}", i % 20),
                title: format!("Movie {i}"),
                position: i,
                ..Default::default()
            });
            replace_catalog(c, "s1", ContentType::Movie, &cats, &mut rows)?;
            Ok(())
        })
        .await
        .unwrap();
    let router = Arc::new(iptv_core::rpc::build_router());

    // The import's save: the write lock (on a connection of its own here),
    // long waits allowed, and three pooled connections busy throughout.
    let holder = rusqlite::Connection::open(state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();
    let mut releases = Vec::new();
    let busy: Vec<_> = (0..3)
        .map(|_| {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            releases.push(tx);
            let st = state.clone();
            tokio::spawn(async move {
                st.db_call(move |_| {
                    let _ = rx.recv();
                    Ok(())
                })
                .await
            })
        })
        .collect();
    let user = {
        let st = state.clone();
        tokio::spawn(async move {
            st.db_write(|c| {
                c.execute("INSERT INTO app_state(key, value) VALUES ('user', 'x')", [])?;
                Ok(())
            })
            .await
        })
    };
    let background: Vec<_> = (0..6)
        .map(|i| {
            let st = state.clone();
            tokio::spawn(async move {
                st.db_background(move |c| {
                    c.execute(
                        "INSERT INTO app_state(key, value) VALUES (?1, 'x')",
                        [format!("bg{i}")],
                    )?;
                    Ok(())
                })
                .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Fourteen category pages at once.
    let started = Instant::now();
    let reads: Vec<_> = (0..14)
        .map(|k| {
            let (st, r) = (state.clone(), router.clone());
            tokio::spawn(async move {
                let t = Instant::now();
                let v = r
                    .dispatch(
                        st,
                        "catalog.movies",
                        json!({"sourceId": "s1", "categoryId": format!("c{k}")}),
                    )
                    .await
                    .unwrap();
                (t.elapsed(), v["total"].as_i64())
            })
        })
        .collect();
    let mut slowest = Duration::ZERO;
    for r in reads {
        let (took, total) = r.await.unwrap();
        assert_eq!(total, Some(100));
        slowest = slowest.max(took);
    }
    eprintln!(
        "l2_import_pool: 14 pages with 11 writers parked in {:?}, slowest {slowest:?}",
        started.elapsed()
    );
    assert!(
        slowest < Duration::from_secs(1),
        "a read waited {slowest:?} for a connection"
    );

    holder.execute_batch("COMMIT").unwrap();
    drop(releases);
    for b in busy {
        b.await.unwrap().unwrap();
    }
    user.await.unwrap().unwrap();
    for b in background {
        b.await.unwrap().unwrap();
    }
    drop(long);
}

/// R1-1: a Stalker login while another source's import save holds the
/// write lock. The session row used to be written under the session mutex
/// and waited out the save (up to the 600 s of `long_write`), so every
/// portal call of the source queued behind it. Now the login and the next
/// call answer at once and the row lands after the commit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stalker_login_during_a_save_keeps_the_session_free() {
    let mock = iptv_fixtures::spawn_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(16);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    let cfg = json!({
        "portalUrl": mock.url("/stalker/portal.php"),
        "macAddress": "00:1A:79:00:00:01",
    })
    .to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('stk', 'stalker', 'Portal', ?1)",
                [cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let client = iptv_core::stalker::session::StalkerClient::for_source(&state, "stk")
        .await
        .unwrap();

    let holder = rusqlite::Connection::open(state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();
    let started = Instant::now();
    let (endpoint, token) = tokio::time::timeout(Duration::from_secs(10), client.ensure_session())
        .await
        .expect("the login waited for the save")
        .unwrap();
    let again = tokio::time::timeout(Duration::from_secs(2), client.ensure_session())
        .await
        .expect("the next portal call waited for the session")
        .unwrap();
    assert_eq!(again, (endpoint.clone(), token.clone()));
    eprintln!(
        "l2_import_pool: Stalker login during a save in {:?}",
        started.elapsed()
    );

    holder.execute_batch("COMMIT").unwrap();
    state.flush_background_writes().await;
    let cached: String = state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT value FROM app_state WHERE key = 'stalker_token:stk'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    let cached: serde_json::Value = serde_json::from_str(&cached).unwrap();
    assert_eq!(cached["endpoint"], endpoint.as_str());
    assert_eq!(cached["token"].as_str(), token.as_deref());
    drop(long);
}

/// R1-1, R4-1: the writes that still took a pooled connection of their own
/// while an import saved. Six window geometry saves, two renames, a source
/// reorder and two download positions wait for the save's write lock next
/// to the save and two guide ingests. Ungated, those eleven writers alone
/// filled the eight connections and reads failed at the 15 s checkout
/// timeout. Now they park two between them (one per gate), a burst of
/// catalog pages keeps three, and forced account checks of two panels
/// answer before the save commits.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn newly_gated_writes_leave_reads_free() {
    let mock = iptv_fixtures::spawn_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(256);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    let panel = mock.url("/xtream");
    state
        .db_call(move |c| {
            c.execute(
                r#"INSERT INTO sources (id, kind, name, config_json) VALUES ('s1', 'xtream', 'S', '{"serverUrl":"http://panel.invalid","username":"u","password":"p"}')"#,
                [],
            )?;
            for user in [iptv_mock::xtream::USER_FULL, iptv_mock::xtream::USER_EXPIRING] {
                let cfg = json!({
                    "serverUrl": panel,
                    "username": user,
                    "password": iptv_mock::xtream::PASSWORD,
                })
                .to_string();
                c.execute(
                    "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'xtream', ?1, ?2)",
                    [user, cfg.as_str()],
                )?;
            }
            for i in 1..=2 {
                c.execute(
                    "INSERT INTO downloads (source_id, content_type, item_id, title, url, status) VALUES ('s1', 'movie', ?1, 'Film', 'http://x/film.mp4', 'completed')",
                    [format!("m{i}")],
                )?;
            }
            let cats: Vec<CategoryRow> = (0..20)
                .map(|k| CategoryRow {
                    category_id: format!("c{k}"),
                    name: format!("Genre {k}"),
                    position: k,
                })
                .collect();
            let mut rows = (0..2_000).map(|i| ItemRow {
                source_id: "s1".into(),
                content_type: ContentType::Movie,
                item_id: format!("m{i}"),
                category_id: format!("c{}", i % 20),
                title: format!("Movie {i}"),
                position: i,
                ..Default::default()
            });
            replace_catalog(c, "s1", ContentType::Movie, &cats, &mut rows)?;
            Ok(())
        })
        .await
        .unwrap();
    let router = Arc::new(iptv_core::rpc::build_router());

    // The save holds the write lock; it and two guide ingests hold a pooled
    // connection each.
    let holder = rusqlite::Connection::open(state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();
    let mut releases = Vec::new();
    let busy: Vec<_> = (0..3)
        .map(|_| {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            releases.push(tx);
            let st = state.clone();
            tokio::spawn(async move {
                st.db_call(move |_| {
                    let _ = rx.recv();
                    Ok(())
                })
                .await
            })
        })
        .collect();

    let mut calls: Vec<(&str, serde_json::Value)> = (0..6)
        .map(|i| {
            (
                "window.setState",
                json!({"state": {"width": 1200 + i, "height": 800, "maximized": false}}),
            )
        })
        .collect();
    calls.extend([
        (
            "sources.update",
            json!({"id": "s1", "patch": {"name": "One"}}),
        ),
        (
            "sources.update",
            json!({"id": "s1", "patch": {"name": "Two"}}),
        ),
        ("sources.reorder", json!({"ids": ["s1"]})),
        (
            "downloads.setPosition",
            json!({"id": 1, "positionSeconds": 30}),
        ),
        (
            "downloads.setPosition",
            json!({"id": 2, "positionSeconds": 60}),
        ),
    ]);
    let writers: Vec<_> = calls
        .into_iter()
        .map(|(cmd, args)| {
            let (st, r) = (state.clone(), router.clone());
            tokio::spawn(async move { (cmd, r.dispatch(st, cmd, args).await) })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The player's forced checks answer while the save still runs.
    for user in [
        iptv_mock::xtream::USER_FULL,
        iptv_mock::xtream::USER_EXPIRING,
    ] {
        let t = Instant::now();
        let v = tokio::time::timeout(
            Duration::from_secs(5),
            router.dispatch(
                state.clone(),
                "account.status",
                json!({"sourceId": user, "refresh": true}),
            ),
        )
        .await
        .expect("a forced check waited for the save")
        .unwrap();
        assert_eq!(v["sourceId"], user, "{v}");
        assert!(v.get("error").is_none(), "{v}");
        eprintln!(
            "l2_import_pool: forced check of {user} in {:?}",
            t.elapsed()
        );
    }

    // Fourteen category pages at once.
    let started = Instant::now();
    let reads: Vec<_> = (0..14)
        .map(|k| {
            let (st, r) = (state.clone(), router.clone());
            tokio::spawn(async move {
                let t = Instant::now();
                let v = r
                    .dispatch(
                        st,
                        "catalog.movies",
                        json!({"sourceId": "s1", "categoryId": format!("c{k}")}),
                    )
                    .await
                    .unwrap();
                (t.elapsed(), v["total"].as_i64())
            })
        })
        .collect();
    let mut slowest = Duration::ZERO;
    for r in reads {
        let (took, total) = r.await.unwrap();
        assert_eq!(total, Some(100));
        slowest = slowest.max(took);
    }
    eprintln!(
        "l2_import_pool: 14 pages with 11 newly gated writers parked in {:?}, slowest {slowest:?}",
        started.elapsed()
    );
    assert!(
        slowest < Duration::from_secs(1),
        "a read waited {slowest:?} for a connection"
    );

    holder.execute_batch("COMMIT").unwrap();
    drop(releases);
    for b in busy {
        b.await.unwrap().unwrap();
    }
    for w in writers {
        let (cmd, out) = w.await.unwrap();
        if let Err(e) = out {
            panic!("{cmd} failed: {}", e.message);
        }
    }
    // The checks' rows land after the commit.
    for user in [
        iptv_mock::xtream::USER_FULL,
        iptv_mock::xtream::USER_EXPIRING,
    ] {
        let v = router
            .dispatch(
                state.clone(),
                "account.status",
                json!({"sourceId": user, "refresh": true}),
            )
            .await
            .unwrap();
        assert_eq!(v["sourceId"], user);
        let stored = state
            .db_call(move |c| iptv_core::account::load(c, user))
            .await
            .unwrap();
        assert!(stored.is_some(), "{user} status stored");
    }
    state.flush_background_writes().await;
    drop(long);
}
