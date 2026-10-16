//! Loop 2 cross-area core fixes (L2-cross-XA):
//! - XA-9 (L2-perf-core-2): user-write RPCs wait for the write gate before
//!   they take a pooled connection, so a burst of them during an import's
//!   save leaves the pool to reads (with 8 connections).
//! - XA-10 (L2-perf-desktop-6): a read made inside `cancel_on_drop` stops its
//!   SQL when its caller goes away; work outside it runs to the end.
//! - XA-11: a `settings.update` that only moves `lastRoute` is not broadcast.
//! - XA-5 (L1-core-11): guide search hits carry the channel's `tvg-shift`.
//! - XA-6 (L2-perf-core-12): an XMLTV ingest leaves an empty WAL.
//! - XA-4 (L1-core-17): a gzip playlist that unpacks past the inline limit
//!   keeps an on-disk copy instead of an inline one.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::rpc::build_router;
use rusqlite::params;
use serde_json::{json, Value};
use std::io::Write as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn movie(id: &str) -> Value {
    json!({"sourceId": "s", "contentType": "movie", "itemId": id})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_write_rpcs_leave_the_pool_to_reads_during_an_import() {
    assert_eq!(iptv_core::db::POOL_MAX, 8);
    let env = support::env().await;
    let state = env.state.clone();
    support::bare_source(&state, "s").await;
    let router = Arc::new(build_router());
    // An import's save: the write lock held, and long waits allowed.
    let holder = rusqlite::Connection::open(state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();

    let mut calls: Vec<(&str, Value)> = Vec::new();
    for i in 0..4 {
        calls.push((
            "favorites.toggle",
            json!({"ref": movie(&format!("f{i}")), "snapshot": {"title": "F", "contentType": "movie"}}),
        ));
        calls.push((
            "recent.add",
            json!({"ref": movie(&format!("r{i}")), "snapshot": {"title": "R", "contentType": "movie"}}),
        ));
        calls.push((
            "positions.set",
            json!({"ref": movie(&format!("p{i}")), "positionSeconds": 60, "durationSeconds": 3600}),
        ));
    }
    calls.push(("settings.update", json!({"patch": {"theme": "light"}})));
    calls.push((
        "settings.update",
        json!({"patch": {"lastRoute": "/dashboard"}}),
    ));
    let writers: Vec<_> = calls
        .into_iter()
        .map(|(cmd, args)| {
            let (st, r) = (state.clone(), router.clone());
            tokio::spawn(async move { r.dispatch(st, cmd, args).await.map(|_| cmd) })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 14 writes wait for the save; reads still get a connection at once.
    for _ in 0..3 {
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
    }

    holder.execute_batch("COMMIT").unwrap();
    for w in writers {
        let r = w.await.unwrap();
        assert!(r.is_ok(), "{:?}", r.err().map(|e| e.message));
    }
    drop(long);
    let counts: (i64, i64, i64) = state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT (SELECT count(*) FROM favorites), (SELECT count(*) FROM recent), (SELECT count(*) FROM playback_positions)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(counts, (4, 4, 4));
    let s = state.settings_snapshot();
    assert_eq!(s.last_route.as_deref(), Some("/dashboard"));
}

/// Counts to `n` in SQL: long enough to still be running when it is dropped.
const SLOW_SQL: &str =
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000000000) SELECT count(*) FROM n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_cancellable_read_stops_its_sql() {
    let env = support::env().await;
    let state = env.state.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let st = state.clone();
    let call = iptv_core::state::cancel_on_drop(async move {
        st.db_call(move |c| {
            let r = c.query_row(SLOW_SQL, [], |r| r.get::<_, i64>(0));
            let _ = tx.send(r.map_err(|e| e.to_string()));
            Ok(())
        })
        .await
    });
    // The client goes away after 300 ms.
    assert!(tokio::time::timeout(Duration::from_millis(300), call)
        .await
        .is_err());
    let started = Instant::now();
    let r = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the dropped read kept running");
    assert!(started.elapsed() < Duration::from_secs(2));
    let err = r.expect_err("the read was interrupted");
    assert!(err.contains("interrupt"), "{err}");

    // Every connection still works, and a late drop interrupts nothing.
    for _ in 0..10 {
        let v: i64 = iptv_core::state::cancel_on_drop(
            state.db_call(|c| Ok(c.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?)),
        )
        .await
        .unwrap();
        assert_eq!(v, 0);
    }

    // A cancellable call still queued for a connection never starts.
    let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let blockers: Vec<_> = (0..iptv_core::db::POOL_MAX)
        .map(|_| {
            let st = state.clone();
            tokio::spawn(async move {
                st.db_call(|_| {
                    std::thread::sleep(Duration::from_millis(800));
                    Ok(())
                })
                .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (st, flag) = (state.clone(), ran.clone());
    let queued = iptv_core::state::cancel_on_drop(async move {
        st.db_call(move |_| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .await
    });
    assert!(tokio::time::timeout(Duration::from_millis(100), queued)
        .await
        .is_err());
    for b in blockers {
        b.await.unwrap().unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_call_outside_cancel_on_drop_still_finishes() {
    let env = support::env().await;
    let state = env.state.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let st = state.clone();
    let call = async move {
        st.db_call(move |c| {
            std::thread::sleep(Duration::from_millis(300));
            c.execute("INSERT INTO app_state(key, value) VALUES ('kept', 'x')", [])?;
            let _ = tx.send(());
            Ok(())
        })
        .await
    };
    assert!(tokio::time::timeout(Duration::from_millis(50), call)
        .await
        .is_err());
    rx.recv_timeout(Duration::from_secs(5))
        .expect("the write finished");
    let n: i64 = state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM app_state WHERE key = 'kept'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn a_last_route_only_update_is_not_broadcast() {
    let mut env = support::env().await;
    let state = env.state.clone();
    let router = build_router();
    let changed = |rx: &mut tokio::sync::broadcast::Receiver<iptv_core::AppEvent>| {
        support::drain(rx)
            .into_iter()
            .filter(|e| e.kind == "settings.changed")
            .count()
    };
    support::drain(&mut env.events);

    let reply = router
        .dispatch(
            state.clone(),
            "settings.update",
            json!({"patch": {"lastRoute": "/s/x/live"}}),
        )
        .await
        .unwrap();
    assert_eq!(reply["lastRoute"], "/s/x/live");
    assert_eq!(
        state.settings_snapshot().last_route.as_deref(),
        Some("/s/x/live")
    );
    assert_eq!(changed(&mut env.events), 0, "lastRoute alone is per window");
    // Persisted all the same.
    let stored: String = state
        .db_call(|c| Ok(c.query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert!(stored.contains("/s/x/live"), "{stored}");

    // Every other key still syncs, alone or with lastRoute.
    router
        .dispatch(
            state.clone(),
            "settings.update",
            json!({"patch": {"theme": "light"}}),
        )
        .await
        .unwrap();
    assert_eq!(changed(&mut env.events), 1);
    router
        .dispatch(
            state.clone(),
            "settings.update",
            json!({"patch": {"theme": "dark", "lastRoute": "/dashboard"}}),
        )
        .await
        .unwrap();
    assert_eq!(changed(&mut env.events), 1);
}

#[tokio::test]
async fn guide_search_hits_carry_the_channel_tvg_shift() {
    let env = support::env().await;
    let state = env.state.clone();
    let base = chrono::Utc::now().timestamp() - 1800;
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
                [],
            )?;
            for (id, number, extra) in [("1", 1, "{}"), ("2", 2, r#"{"tvgShift":"1"}"#)] {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, number, epg_channel_id, extra_json)
                     VALUES ('s', 'live', ?1, 'c', ?2, ?3, 'cnn.us', ?4)",
                    params![id, format!("CNN {id}"), number, extra],
                )?;
            }
            c.execute(
                "INSERT INTO epg_sources(url, origin, status) VALUES ('http://g/x.xml', 'settings', 'ok')",
                [],
            )?;
            c.execute(
                "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('http://g/x.xml', 'cnn.us', 'CNN')",
                [],
            )?;
            c.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES ('http://g/x.xml', 'cnn.us', ?1, ?2, 'Noon News')",
                params![base, base + 3600],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let router = build_router();
    let hits = router
        .dispatch(
            state.clone(),
            "epg.search",
            json!({"sourceId": "s", "query": "noon"}),
        )
        .await
        .unwrap();
    let got: Vec<(String, String, String)> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|h| {
            (
                h["ref"]["itemId"].as_str().unwrap().to_string(),
                h["program"]["start"].as_str().unwrap().to_string(),
                h["program"]["end"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let ts = iptv_core::epg::query::to_rfc3339;
    assert_eq!(
        got,
        [
            ("1".to_string(), ts(base), ts(base + 3600)),
            ("2".to_string(), ts(base + 3600), ts(base + 7200)),
        ]
    );
    // The grid shows channel 2's programme at the same shifted time.
    let grid = router
        .dispatch(
            state.clone(),
            "epg.grid",
            json!({"refs": [{"sourceId": "s", "contentType": "live", "itemId": "2"}],
                   "from": ts(base - 3600), "to": ts(base + 4 * 3600)}),
        )
        .await
        .unwrap();
    assert_eq!(grid["s|live|2"][0]["start"], ts(base + 3600), "{grid}");
}

#[test]
fn an_xmltv_ingest_leaves_an_empty_wal() {
    use iptv_core::epg::ingest::ingest_reader;
    use iptv_core::epg::xmltv::Window;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(iptv_core::db::DB_FILE);
    let pool = iptv_core::db::open_and_migrate(&path).unwrap();
    let mut conn = pool.get().unwrap();
    conn.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])
        .unwrap();
    let mut xml = String::from(r#"<tv><channel id="c"><display-name>C</display-name></channel>"#);
    for h in 0..2000 {
        let (d, hh) = (10 + h / 24, h % 24);
        xml.push_str(&format!(
            r#"<programme channel="c" start="202610{d:02}{hh:02}0000 +0000" stop="202610{d:02}{hh:02}5900 +0000"><title>Show {h}</title><desc>{}</desc></programme>"#,
            "x".repeat(400)
        ));
    }
    xml.push_str("</tv>");
    let stats = ingest_reader(
        &mut conn,
        "u",
        std::io::Cursor::new(xml.into_bytes()),
        Window::unbounded(),
        None,
        &mut |_, _| {},
    )
    .unwrap();
    assert!(stats.programs > 0);
    let wal = path.with_file_name(format!("{}-wal", iptv_core::db::DB_FILE));
    let len = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    assert_eq!(len, 0, "WAL truncated after the ingest");
}

#[tokio::test]
async fn a_gzip_playlist_that_unpacks_past_the_inline_limit_is_kept_on_disk() {
    let env = support::env().await;
    let state = env.state.clone();
    // About 10 MB of text that packs to well under the limit.
    let pad = "p".repeat(300);
    let mut text = String::from("#EXTM3U\n");
    let mut i = 0;
    while text.len() as u64 <= iptv_core::m3u::importer::RAW_INLINE_MAX + 1_000_000 {
        text.push_str(&format!(
            "#EXTINF:-1 group-title=\"G\",Channel {i}\nhttp://stream.example/{pad}/{i}.ts\n"
        ));
        i += 1;
    }
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(text.as_bytes()).unwrap();
    let packed = gz.finish().unwrap();
    assert!((packed.len() as u64) < iptv_core::m3u::importer::RAW_INLINE_MAX);
    let file = env.dir.path().join("big.m3u.gz");
    std::fs::write(&file, &packed).unwrap();

    let src = iptv_core::sources::add(state.clone(), support::file_args(&file))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, i as i64);
    let id = src.id.clone();
    let inline: i64 = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT length(raw) FROM m3u_raw WHERE source_id = ?1",
                [id],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(inline, 0, "not stored inline at its decoded size");
    let copy = iptv_core::m3u::importer::cached_playlist_path(&state.data_dir, &src.id);
    assert!(
        copy.is_file(),
        "an on-disk copy is kept: {}",
        copy.display()
    );
}
