//! `epg.clearAll`: wipes programmes and guide channels of every url, resets
//! their status, keeps urls / mappings / staging, and emits `epg.changed`.

use iptv_core::epg;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::Value;
use std::sync::Arc;

#[tokio::test]
async fn clear_all_wipes_guide_data_and_emits() {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, mut events) = BroadcastSink::channel(64);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    epg::rpc::register(&mut router);
    assert!(router.contains("epg.clearAll"));

    state
        .db_call(|c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
                [],
            )?;
            c.execute(
                "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES ('s', 'live', '1', 'one')",
                [],
            )?;
            let staging = epg::store::staging_key("http://a/guide.xml");
            for (url, origin) in [
                ("http://a/guide.xml", "settings"),
                ("http://b/guide.xml", "source"),
                (staging.as_str(), "staging"),
            ] {
                c.execute(
                    "INSERT INTO epg_sources(url, origin, status, last_fetch_at, channel_count, program_count, etag)
                     VALUES (?1, ?2, 'ok', '2026-10-10T00:00:00Z', 1, 2, 'W/1')",
                    params![url, origin],
                )?;
                c.execute(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, 'one', 'One')",
                    [url],
                )?;
                for start in [0, 3600] {
                    c.execute(
                        "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, 'one', ?2, ?3, 'Show')",
                        params![url, start, start + 3600],
                    )?;
                }
            }
            Ok(())
        })
        .await
        .unwrap();

    let out = router
        .dispatch(state.clone(), "epg.clearAll", Value::Null)
        .await
        .unwrap();
    assert!(out.is_null());

    let (programs, channels, staged, sources, map, statuses) = state
        .db_call(|c| {
            let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
            let statuses: Vec<(String, i64, Option<String>, Option<String>)> = {
                let mut st = c.prepare(
                    "SELECT status, program_count, etag, last_fetch_at FROM epg_sources WHERE origin <> 'staging' ORDER BY url",
                )?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                rows.collect::<Result<_, _>>()?
            };
            Ok((
                n("SELECT COUNT(*) FROM epg_programs WHERE epg_url NOT LIKE '%staging'")?,
                n("SELECT COUNT(*) FROM epg_channels WHERE epg_url NOT LIKE '%staging'")?,
                n("SELECT COUNT(*) FROM epg_programs WHERE epg_url LIKE '%staging'")?,
                n("SELECT COUNT(*) FROM epg_sources")?,
                n("SELECT COUNT(*) FROM epg_channel_map")?,
                statuses,
            ))
        })
        .await
        .unwrap();
    assert_eq!(programs, 0, "programmes deleted");
    assert_eq!(channels, 0, "guide channels deleted");
    assert_eq!(staged, 2, "a running refresh's staging rows are kept");
    assert_eq!(sources, 3, "configured urls are kept");
    assert_eq!(map, 1, "manual mappings are kept");
    for (status, count, etag, fetched) in statuses {
        assert_eq!(status, "idle");
        assert_eq!(count, 0);
        assert!(
            etag.is_none(),
            "etag dropped so the next refresh is a full download"
        );
        assert!(
            fetched.is_some(),
            "fetch time kept so the scheduler does not re-download at once"
        );
    }

    let mut kinds = Vec::new();
    while let Ok(ev) = events.try_recv() {
        kinds.push(ev.kind);
    }
    assert!(kinds.iter().any(|k| k == "epg.changed"), "{kinds:?}");
}
