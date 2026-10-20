//! Check 8: a v1 playlist backup (C15) imports sources, favorites, recently
//! viewed, hidden groups/categories, playback positions and EPG URLs, and an
//! export re-imports to the same state.
//!
//! Manifest: `fixtures/backup-v1.json` when present, else
//! `iptv_fixtures::backup_manifest_v1()` when implemented, else the inline
//! manifest below. `{mock}` (and the mock's default `http://127.0.0.1:7290`)
//! is replaced with the in-process mock's base URL.
//!
//! Catalogs come from the real importers (m3u parses the embedded text). When
//! the mock does not serve Xtream yet, a stand-in Xtream importer writes the
//! mock's catalog ids straight into `items`/`categories` (C3), so the test
//! exercises the backup logic either way.

use iptv_core::backup;
use iptv_core::model::{ImportSummary, Source, SourceKind};
use iptv_core::rpc::RpcRouter;
use iptv_core::sources::{register_importer, Importer};
use iptv_core::{AppState, BroadcastSink, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

const INLINE_M3U: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"news1\" group-title=\"News\",News One\nhttp://127.0.0.1:9/live/news1.ts\n\
#EXTINF:-1 tvg-id=\"news2\" group-title=\"News\",News Two\nhttp://127.0.0.1:9/live/news2.ts\n\
#EXTINF:-1 tvg-id=\"sport1\" group-title=\"Sports\",Sport One\nhttp://127.0.0.1:9/live/sport1.ts\n\
#EXTINF:-1 tvg-id=\"film1\" group-title=\"Movies\",Film One\nhttp://127.0.0.1:9/live/film1.ts\n";

fn inline_manifest() -> String {
    json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "exportedAt": "2026-10-01T12:00:00.000Z",
        "includeSecrets": true,
        "settings": { "epgUrls": ["{mock}/epg/guide.xml", "{mock}/epg/second.xml"] },
        "playlists": [
            {
                "portalType": "m3u",
                "exportedId": "m3u-one",
                "title": "Inline M3U",
                "autoRefresh": false,
                "position": 0,
                "source": { "kind": "url", "url": "{mock}/m3u/sample.m3u", "rawM3u": INLINE_M3U, "userAgent": "BackupTest/1" },
                "userState": {
                    "favorites": ["http://127.0.0.1:9/live/sport1.ts", "http://127.0.0.1:9/live/news1.ts", "http://127.0.0.1:9/live/gone.ts"],
                    "recentlyViewed": [
                        { "source": "m3u", "id": "x", "url": "http://127.0.0.1:9/live/news2.ts", "title": "News Two", "category_id": "live", "added_at": "2026-09-30T10:00:00.000Z" },
                        { "source": "m3u", "id": "y", "url": "http://127.0.0.1:9/live/gone.ts", "title": "Gone", "category_id": "live", "added_at": "2026-09-30T09:00:00.000Z" }
                    ],
                    "hiddenGroupTitles": ["Sports", "No Such Group"]
                }
            },
            {
                "portalType": "xtream",
                "exportedId": "xt-one",
                "title": "Inline Xtream",
                "autoRefresh": true,
                "position": 1,
                "connection": { "serverUrl": "{mock}/xtream", "username": "demo", "password": "secret" },
                "userState": {
                    "hiddenCategories": [ { "categoryType": "live", "xtreamId": 2 }, { "categoryType": "movies", "xtreamId": 11 }, { "categoryType": "series", "xtreamId": 9999 } ],
                    "favorites": [
                        { "contentType": "movie", "xtreamId": 201, "addedAt": "2026-09-01T00:00:00.000Z", "position": 0 },
                        { "contentType": "live", "xtreamId": 101, "addedAt": "2026-09-02T00:00:00.000Z", "position": 1 },
                        { "contentType": "series", "xtreamId": 301, "addedAt": "2026-09-03T00:00:00.000Z", "position": 2 },
                        { "contentType": "live", "xtreamId": 99999, "addedAt": "2026-09-04T00:00:00.000Z", "position": 3 }
                    ],
                    "recentlyViewed": [
                        { "contentType": "live", "xtreamId": 102, "viewedAt": "2026-09-05T00:00:00.000Z" },
                        { "contentType": "movie", "xtreamId": 202, "viewedAt": "2026-09-06T00:00:00.000Z" }
                    ],
                    "playbackPositions": [
                        { "contentXtreamId": 201, "contentType": "vod", "positionSeconds": 600, "durationSeconds": 6000, "playlistId": "xt-one", "updatedAt": "2026-09-07T00:00:00.000Z" },
                        { "contentXtreamId": 3002, "contentType": "episode", "seriesXtreamId": 301, "seasonNumber": 1, "episodeNumber": 2, "positionSeconds": 100, "durationSeconds": 1500, "playlistId": "xt-one", "updatedAt": "2026-09-08T00:00:00.000Z" }
                    ],
                    "sourcePins": [ { "matchKey": "tmdb:603", "contentId": 201, "updatedAt": "2026-09-09T00:00:00.000Z" } ]
                }
            },
            {
                "portalType": "stalker",
                "exportedId": "st-one",
                "title": "Inline Stalker",
                "autoRefresh": false,
                "position": 2,
                "connection": { "portalUrl": "{mock}/stalker/portal.php", "macAddress": "00:1A:79:00:00:01", "isFullStalkerPortal": false },
                "userState": {
                    "favorites": [
                        { "id": "1", "name": "Stalker One", "category_id": "itv", "cmd": "ffmpeg http://127.0.0.1:9/s1" },
                        { "id": "55", "name": "Stalker Film", "category_id": "vod", "screenshot_uri": "http://127.0.0.1:9/55.jpg" }
                    ],
                    "recentlyViewed": [ { "id": "7", "name": "Stalker Show", "category_id": "series", "is_series": 1, "added_at": 1790000000000i64 } ]
                }
            },
            { "portalType": "m3u", "title": "Broken entry", "source": {} }
        ]
    })
    .to_string()
}

/// Which manifest the run uses, and whether its exact counts are known.
fn manifest(base: &str) -> (String, bool) {
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/backup-v1.json");
    let (text, inline) = if let Ok(text) = std::fs::read_to_string(&fixture) {
        (text, false)
    } else if let Ok(text) = std::panic::catch_unwind(iptv_fixtures::backup_manifest_v1) {
        (text, false)
    } else {
        (inline_manifest(), true)
    };
    // The checked-in file may carry the mock's default address instead of
    // the placeholder; point both at this run's mock.
    (
        text.replace("{mock}", base)
            .replace("http://127.0.0.1:7290", base),
        inline,
    )
}

// ---------------------------------------------------------------------------
// Stand-in Xtream importer (used only when the mock does not serve Xtream)
// ---------------------------------------------------------------------------

struct MockCatalogImporter;

/// The iptv-mock Xtream catalog ids (C13): live 101-140 in categories 1-3,
/// movies 201-235 in 10-11, series 301-310 in 20-21.
fn write_mock_catalog(c: &Connection, sid: &str) -> rusqlite::Result<()> {
    for (ct, cats) in [
        ("live", ["1", "2", "3"].as_slice()),
        ("movie", &["10", "11"]),
        ("series", &["20", "21"]),
    ] {
        for (i, cat) in cats.iter().enumerate() {
            c.execute(
                "INSERT OR REPLACE INTO categories(source_id, content_type, category_id, name, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![sid, ct, cat, format!("{ct} {cat}"), i as i64],
            )?;
        }
    }
    let put = |ct: &str, id: u32, cat: &str, title: String| {
        c.execute(
            "INSERT OR REPLACE INTO items(source_id, content_type, item_id, category_id, title, poster_url, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![sid, ct, id.to_string(), cat, title, format!("http://127.0.0.1:9/img/{id}.jpg"), id as i64],
        )
        .map(|_| ())
    };
    for id in 101..=140u32 {
        put(
            "live",
            id,
            ["1", "2", "3"][(id as usize) % 3],
            format!("Channel {id}"),
        )?;
    }
    for id in 201..=235u32 {
        put(
            "movie",
            id,
            ["10", "11"][(id as usize) % 2],
            format!("Movie {id}"),
        )?;
    }
    for id in 301..=310u32 {
        put(
            "series",
            id,
            ["20", "21"][(id as usize) % 2],
            format!("Series {id}"),
        )?;
    }
    Ok(())
}

#[async_trait::async_trait]
impl Importer for MockCatalogImporter {
    fn kind(&self) -> SourceKind {
        SourceKind::Xtream
    }
    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
        let sid = source.id.clone();
        state
            .db_call(move |c| {
                write_mock_catalog(c, &sid)?;
                Ok(())
            })
            .await?;
        Ok(ImportSummary {
            channels: 40,
            movies: 35,
            series: 10,
            unchanged: false,
        })
    }
}

async fn mock_serves_xtream(base: &str) -> bool {
    let url = format!("{base}/xtream/player_api.php?username=demo&password=secret");
    let Ok(resp) = reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    else {
        return false;
    };
    resp.status().is_success()
        && resp
            .json::<Value>()
            .await
            .is_ok_and(|v| v.get("user_info").is_some())
}

async fn app(xtream_live: bool) -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    iptv_core::stalker::init(state.clone()).await.unwrap();
    if !xtream_live || iptv_core::sources::importer(&state, SourceKind::Xtream).is_none() {
        register_importer(&state, Arc::new(MockCatalogImporter));
    }
    (dir, state)
}

/// L1-settings-2: every source a backup import loads ends its progress with
/// `done`, so the UI's progress toast closes.
#[tokio::test]
async fn backup_import_ends_each_source_progress_with_done() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, mut rx) = BroadcastSink::channel(4096);
    let st = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(st.clone()).await.unwrap();
    iptv_core::xtream::init(st.clone()).await.unwrap();
    iptv_core::stalker::init(st.clone()).await.unwrap();
    register_importer(&st, Arc::new(MockCatalogImporter));
    let r = router();
    import(&r, &st, &inline_manifest(), "merge").await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut last: std::collections::HashMap<String, String> = Default::default();
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Ok(ev)) if ev.kind == "import.progress" => {
                let id = ev.payload["sourceId"].as_str().unwrap_or("").to_string();
                let phase = ev.payload["phase"].as_str().unwrap_or("").to_string();
                last.insert(id, phase);
                if !last.is_empty() && last.values().all(|p| p == "done") {
                    break;
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(_)) | Err(_) => break,
        }
    }
    assert!(!last.is_empty(), "the import reported progress");
    assert!(last.values().all(|p| p == "done"), "{last:?}");
}

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    backup::rpc::register(&mut r);
    iptv_core::settings::rpc::register(&mut r);
    r
}

// ---------------------------------------------------------------------------
// Assertions derived from the manifest
// ---------------------------------------------------------------------------

fn s(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn source_id(c: &Connection, kind: &str, title: &str) -> String {
    c.query_row(
        "SELECT id FROM sources WHERE kind = ?1 AND name = ?2",
        params![kind, title],
        |r| r.get(0),
    )
    .unwrap_or_else(|_| panic!("source {kind} {title:?} was not imported"))
}

fn item_exists(c: &Connection, sid: &str, ct: &str, id: &str) -> bool {
    c.query_row(
        "SELECT 1 FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
        params![sid, ct, id],
        |_| Ok(()),
    )
    .optional()
    .unwrap()
    .is_some()
}

fn keys(c: &Connection, sql: &str, sid: &str) -> BTreeSet<(String, String)> {
    let mut stmt = c.prepare(sql).unwrap();
    stmt.query_map([sid], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn xt_ct(t: &str) -> &'static str {
    match t {
        "live" => "live",
        "movie" | "movies" | "vod" => "movie",
        _ => "series",
    }
}

/// Restored rows per category, for the non-vacuous check.
#[derive(Debug, Default)]
struct Restored {
    sources: usize,
    favorites: usize,
    recent: usize,
    hidden: usize,
    positions: usize,
}

fn assert_restored(c: &Connection, m: &Value) -> Restored {
    let mut got = Restored::default();
    for p in m["playlists"].as_array().unwrap() {
        let us = &p["userState"];
        let title = s(p, "title").unwrap_or_default();
        match p["portalType"].as_str() {
            Some("m3u")
                if p["source"]["rawM3u"]
                    .as_str()
                    .is_some_and(|r| !r.trim().is_empty()) =>
            {
                let sid = source_id(c, "m3u", &title);
                got.sources += 1;
                let url_of = |u: &str| -> Option<(String, String)> {
                    c.query_row(
                        "SELECT content_type, item_id FROM items WHERE source_id = ?1 AND url = ?2 LIMIT 1",
                        params![sid, u],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .unwrap()
                };
                let fav_want: BTreeSet<_> = us["favorites"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|u| u.as_str())
                    .filter_map(url_of)
                    .collect();
                let fav_got = keys(
                    c,
                    "SELECT content_type, item_id FROM favorites WHERE source_id = ?1",
                    &sid,
                );
                assert_eq!(fav_got, fav_want, "{title}: m3u favorites");
                got.favorites += fav_got.len();
                let rec_want: BTreeSet<_> = us["recentlyViewed"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| s(r, "url"))
                    .filter_map(|u| url_of(&u))
                    .collect();
                let rec_got = keys(
                    c,
                    "SELECT content_type, item_id FROM recent WHERE source_id = ?1",
                    &sid,
                );
                assert_eq!(rec_got, rec_want, "{title}: m3u recently viewed");
                got.recent += rec_got.len();
                for g in us["hiddenGroupTitles"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|g| g.as_str())
                {
                    let flags: Vec<i64> = {
                        let mut st = c
                            .prepare(
                                "SELECT hidden FROM categories WHERE source_id = ?1 AND name = ?2",
                            )
                            .unwrap();
                        st.query_map(params![sid, g], |r| r.get(0))
                            .unwrap()
                            .map(Result::unwrap)
                            .collect()
                    };
                    assert!(
                        flags.iter().all(|h| *h == 1),
                        "{title}: group {g} not hidden"
                    );
                    got.hidden += flags.len();
                }
            }
            Some("xtream") => {
                let sid = source_id(c, "xtream", &title);
                got.sources += 1;
                let refs = |key: &str| -> BTreeSet<(String, String)> {
                    us[key]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|f| {
                            Some((xt_ct(&s(f, "contentType")?).to_string(), s(f, "xtreamId")?))
                        })
                        .filter(|(ct, id)| item_exists(c, &sid, ct, id))
                        .collect()
                };
                let fav_got = keys(
                    c,
                    "SELECT content_type, item_id FROM favorites WHERE source_id = ?1",
                    &sid,
                );
                assert_eq!(fav_got, refs("favorites"), "{title}: xtream favorites");
                got.favorites += fav_got.len();
                let rec_got = keys(
                    c,
                    "SELECT content_type, item_id FROM recent WHERE source_id = ?1",
                    &sid,
                );
                assert_eq!(
                    rec_got,
                    refs("recentlyViewed"),
                    "{title}: xtream recently viewed"
                );
                got.recent += rec_got.len();
                for h in us["hiddenCategories"].as_array().into_iter().flatten() {
                    let (Some(t), Some(id)) = (s(h, "categoryType"), s(h, "xtreamId")) else {
                        continue;
                    };
                    let hidden: Option<i64> = c
                        .query_row(
                            "SELECT hidden FROM categories WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
                            params![sid, xt_ct(&t), id],
                            |r| r.get(0),
                        )
                        .optional()
                        .unwrap();
                    if let Some(h) = hidden {
                        assert_eq!(h, 1, "{title}: category {t} {id} not hidden");
                        got.hidden += 1;
                    }
                }
                for pos in us["playbackPositions"].as_array().into_iter().flatten() {
                    let kind = s(pos, "contentType").unwrap_or_default();
                    let content = s(pos, "contentXtreamId").unwrap_or_default();
                    let (ct, item, ep) = if kind == "episode" {
                        (
                            "series",
                            s(pos, "seriesXtreamId").unwrap_or_default(),
                            content,
                        )
                    } else {
                        ("movie", content, String::new())
                    };
                    let p_s = pos["positionSeconds"].as_f64().unwrap_or(0.0);
                    let complete = pos["durationSeconds"]
                        .as_f64()
                        .is_some_and(|d| d > 0.0 && p_s >= 0.95 * d);
                    if !item_exists(c, &sid, ct, &item) || complete {
                        continue;
                    }
                    let stored: i64 = c
                        .query_row(
                            "SELECT position_seconds FROM playback_positions WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = ?4",
                            params![sid, ct, item, ep],
                            |r| r.get(0),
                        )
                        .unwrap_or_else(|_| panic!("{title}: position {kind} {item}/{ep} missing"));
                    assert_eq!(stored, p_s as i64);
                    got.positions += 1;
                }
                if let Some(pins) = us["sourcePins"].as_array() {
                    let n: i64 = c
                        .query_row(
                            "SELECT COUNT(*) FROM vod_source_pins WHERE source_id = ?1",
                            [&sid],
                            |r| r.get(0),
                        )
                        .unwrap();
                    assert_eq!(n as usize, pins.len(), "{title}: source pins");
                }
            }
            Some("stalker") => {
                let sid = source_id(c, "stalker", &title);
                got.sources += 1;
                let with_id = |key: &str| {
                    us[key]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|i| {
                            ["id", "stream_id", "series_id", "movie_id"]
                                .iter()
                                .any(|k| s(i, k).is_some())
                        })
                        .count()
                };
                let n_fav = keys(
                    c,
                    "SELECT content_type, item_id FROM favorites WHERE source_id = ?1",
                    &sid,
                )
                .len();
                let n_rec = keys(
                    c,
                    "SELECT content_type, item_id FROM recent WHERE source_id = ?1",
                    &sid,
                )
                .len();
                assert_eq!(n_fav, with_id("favorites"), "{title}: stalker favorites");
                assert_eq!(
                    n_rec,
                    with_id("recentlyViewed"),
                    "{title}: stalker recently viewed"
                );
                got.favorites += n_fav;
                got.recent += n_rec;
            }
            _ => {}
        }
    }
    got
}

async fn export(r: &RpcRouter, st: &Arc<AppState>, secrets: bool) -> Value {
    let out = r
        .dispatch(
            st.clone(),
            "backup.export",
            json!({ "includeSecrets": secrets }),
        )
        .await
        .unwrap();
    assert!(out["fileName"].as_str().unwrap().ends_with(".json"));
    serde_json::from_str(out["json"].as_str().unwrap()).unwrap()
}

async fn import(r: &RpcRouter, st: &Arc<AppState>, json: &str, mode: &str) -> Value {
    r.dispatch(
        st.clone(),
        "backup.import",
        json!({ "json": json, "mode": mode }),
    )
    .await
    .unwrap_or_else(|e| panic!("backup.import failed: {}", e.message))
}

fn comparable(m: &Value) -> Value {
    json!({ "settings": m.get("settings"), "playlists": m["playlists"] })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn check8_import_and_round_trip() {
    let mock = iptv_fixtures::spawn_mock().await;
    let xtream_live = mock_serves_xtream(&mock.base).await;
    let (text, inline) = manifest(&mock.base);
    let m: Value = serde_json::from_str(&text).unwrap();
    let r = router();
    eprintln!(
        "check8: manifest = {}, xtream catalog = {}",
        if inline { "inline" } else { "fixture" },
        if xtream_live {
            "real importer against the mock"
        } else {
            "stand-in importer"
        }
    );

    // 1. Import into a fresh store.
    let (_d1, st1) = app(xtream_live).await;
    let report = import(&r, &st1, &text, "merge").await;
    let restored = st1
        .db_call({
            let m = m.clone();
            move |c| Ok(assert_restored(c, &m))
        })
        .await
        .unwrap();
    assert!(
        restored.sources > 0 && restored.favorites > 0,
        "nothing restored: {restored:?} {report}"
    );
    if m.to_string().contains("\"playbackPositions\"") {
        assert!(
            restored.positions > 0,
            "no playback position restored: {restored:?} {report}"
        );
    }

    // EPG URLs.
    let epg = st1.settings_snapshot().epg_urls;
    for u in m["settings"]["epgUrls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_str())
    {
        assert!(
            epg.iter().any(|e| e == u.trim()),
            "epg url {u} missing from {epg:?}"
        );
    }

    if inline {
        assert_eq!(report["imported"], 3, "{report}");
        assert_eq!(report["skipped"], 1, "{report}");
        assert_eq!(restored.sources, 3);
        assert_eq!(restored.favorites, 2 + 3 + 2, "{restored:?}");
        assert_eq!(restored.recent, 1 + 2 + 1, "{restored:?}");
        assert_eq!(restored.hidden, 1 + 2, "{restored:?}");
        assert_eq!(restored.positions, 2, "{restored:?}");
        let warnings = report["warnings"].to_string();
        for needle in [
            "gone.ts",
            "No Such Group",
            "99999",
            "9999",
            "missing raw playlist data",
        ] {
            assert!(
                warnings.contains(needle),
                "no warning about {needle}: {warnings}"
            );
        }
        // Favorite order follows the backup (xtream positions).
        let order: Vec<String> = st1
            .db_call(|c| {
                let mut st = c.prepare(
                    "SELECT item_id FROM favorites WHERE source_id = 'xt-one' ORDER BY position",
                )?;
                let v = st
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                Ok(v)
            })
            .await
            .unwrap();
        assert_eq!(order, ["201", "101", "301"]);
        // Episode snapshot carries the season/episode label.
        let snap: String = st1
            .db_call(|c| {
                Ok(c.query_row(
                    "SELECT snapshot_json FROM playback_positions WHERE episode_id = '3002'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert!(snap.contains("S1 E2"), "{snap}");
        assert_eq!(epg.len(), 2);
    }

    // 2. Re-importing the same file (merge) changes nothing.
    let before = export(&r, &st1, true).await;
    let again = import(&r, &st1, &text, "merge").await;
    assert_eq!(again["imported"].as_i64(), report["imported"].as_i64());
    let after = export(&r, &st1, true).await;
    assert_eq!(
        before["playlists"].as_array().unwrap().len(),
        after["playlists"].as_array().unwrap().len()
    );
    assert_eq!(
        comparable(&before),
        comparable(&after),
        "merge re-import changed state"
    );

    // 3. Export -> import into a fresh store -> export again: identical.
    assert!(
        before["playlists"].to_string().contains("\"password\""),
        "secrets missing with includeSecrets"
    );
    let (_d2, st2) = app(xtream_live).await;
    let rep2 = import(&r, &st2, &before.to_string(), "replace").await;
    assert_eq!(rep2["skipped"], 0, "{rep2}");
    let second = export(&r, &st2, true).await;
    assert_eq!(
        comparable(&before),
        comparable(&second),
        "export round trip differs"
    );
    let restored2 = st2
        .db_call({
            let m = before.clone();
            move |c| Ok(assert_restored(c, &m))
        })
        .await
        .unwrap();
    assert_eq!(restored2.favorites, restored.favorites);
    assert_eq!(restored2.recent, restored.recent);
    assert_eq!(restored2.positions, restored.positions);

    // 4. Replace mode on a populated store removes what the file does not have.
    let only_first = json!({ "kind": "iptvnator-playlist-backup", "version": 1, "playlists": [before["playlists"][0].clone()] });
    let rep3 = import(&r, &st2, &only_first.to_string(), "replace").await;
    assert_eq!(rep3["imported"], 1);
    let n: i64 = st2
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert!(
        st2.settings_snapshot().epg_urls.is_empty(),
        "replace without settings clears EPG URLs"
    );
    drop(mock);
}

#[tokio::test]
async fn export_without_secrets_parks_xtream_state_until_refresh() {
    let mock = iptv_fixtures::spawn_mock().await;
    let text = inline_manifest().replace("{mock}", &mock.base);
    let r = router();
    let (_d1, st1) = app(false).await;
    import(&r, &st1, &text, "merge").await;
    let exported = export(&r, &st1, false).await;
    let raw = exported.to_string();
    assert!(
        !raw.contains("\"password\""),
        "password exported without includeSecrets"
    );
    assert!(!raw.contains("secret"), "secret value leaked");

    let (_d2, st2) = app(false).await;
    let rep = import(&r, &st2, &raw, "merge").await;
    assert_eq!(rep["imported"], 3, "{rep}");
    assert!(rep["warnings"].to_string().contains("no password"), "{rep}");
    let (err, favs, parked): (Option<String>, i64, i64) = st2
        .db_call(|c| {
            Ok((
                c.query_row(
                    "SELECT last_error FROM sources WHERE id = 'xt-one'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT COUNT(*) FROM favorites WHERE source_id = 'xt-one'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT COUNT(*) FROM app_state WHERE key = 'backup_pending:xt-one'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .await
        .unwrap();
    assert!(err.is_some());
    assert_eq!(favs, 0);
    assert_eq!(parked, 1);

    // Nothing to apply while the catalog is empty.
    assert!(backup::apply_pending_restore(&st2, "xt-one")
        .await
        .unwrap()
        .is_empty());
    // After a (simulated) successful refresh the parked state is applied once.
    st2.db_call(|c| Ok(write_mock_catalog(c, "xt-one")?))
        .await
        .unwrap();
    let w = backup::apply_pending_restore(&st2, "xt-one").await.unwrap();
    assert!(
        w.is_empty(),
        "every exported ref exists in the catalog: {w:?}"
    );
    let (favs, positions, parked): (i64, i64, i64) = st2
        .db_call(|c| {
            Ok((
                c.query_row(
                    "SELECT COUNT(*) FROM favorites WHERE source_id = 'xt-one'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT COUNT(*) FROM playback_positions WHERE source_id = 'xt-one'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT COUNT(*) FROM app_state WHERE key LIKE 'backup_pending:%'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .await
        .unwrap();
    assert_eq!((favs, positions, parked), (3, 2, 0));
    drop(mock);
}

#[tokio::test]
async fn rejects_invalid_files() {
    let (_d, st) = app(false).await;
    let r = router();
    for bad in [
        "not json".to_string(),
        "[]".to_string(),
        json!({"kind": "something-else", "version": 1, "playlists": []}).to_string(),
        json!({"kind": "iptvnator-playlist-backup", "version": 2, "playlists": []}).to_string(),
        json!({"kind": "iptvnator-playlist-backup", "version": 1}).to_string(),
    ] {
        let err = r
            .dispatch(st.clone(), "backup.import", json!({ "json": bad }))
            .await
            .unwrap_err();
        assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid, "{bad}");
    }
    let err = r
        .dispatch(
            st.clone(),
            "backup.import",
            json!({ "json": "{}", "mode": "wipe" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);
    // An empty, valid backup is fine.
    let ok = import(
        &r,
        &st,
        &json!({"kind": "iptvnator-playlist-backup", "version": 1, "playlists": []}).to_string(),
        "merge",
    )
    .await;
    assert_eq!(ok, json!({"imported": 0, "skipped": 0, "warnings": []}));
}

/// Xtream importer that blocks until released, standing in for a portal that
/// accepts the connection and never answers.
struct HangingImporter {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl Importer for HangingImporter {
    fn kind(&self) -> SourceKind {
        SourceKind::Xtream
    }
    async fn import(&self, _state: Arc<AppState>, _source: &Source) -> CoreResult<ImportSummary> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(ImportSummary {
            channels: 0,
            movies: 0,
            series: 0,
            unchanged: false,
        })
    }
}

/// R7 F3: a restore whose portal hangs must not block unrelated work.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hanging_portal_restore_does_not_block_sources_add() {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    register_importer(
        &state,
        Arc::new(HangingImporter {
            started: started.clone(),
            release: release.clone(),
        }),
    );

    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "xtream",
            "exportedId": "hang",
            "title": "Hanging portal",
            "connection": { "serverUrl": "http://127.0.0.1:9/xtream", "username": "u", "password": "p" },
            "userState": { "favorites": [], "recentlyViewed": [], "playbackPositions": [] }
        }]
    })
    .to_string();
    let restore = {
        let state = state.clone();
        tokio::spawn(
            async move { backup::import(&state, &manifest, backup::ImportMode::Merge).await },
        )
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), started.notified())
        .await
        .expect("restore reached the portal sync");

    let mut r = RpcRouter::new();
    iptv_core::sources::rpc::register(&mut r);
    let t0 = std::time::Instant::now();
    let added = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        r.dispatch(
            state.clone(),
            "sources.add",
            json!({"kind": "m3u", "name": "Unrelated", "m3u": {"origin": "text", "text": INLINE_M3U}}),
        ),
    )
    .await
    .expect("sources.add returned within 5 s while the restore hangs")
    .expect("sources.add succeeded");
    assert_eq!(added["name"], "Unrelated");
    assert!(t0.elapsed() < std::time::Duration::from_secs(5));

    // The restore is still parked on the portal until it answers.
    assert!(!restore.is_finished());
    release.notify_one();
    let report = tokio::time::timeout(std::time::Duration::from_secs(10), restore)
        .await
        .expect("restore finished once the portal answered")
        .unwrap()
        .unwrap();
    assert_eq!(report.imported, 1, "{report:?}");
}

/// Watched positions and app-level settings survive export and import; an old
/// manifest without them still imports (watched defaults to false).
#[tokio::test]
async fn watched_positions_and_app_settings_round_trip() {
    let (_d, st) = app(false).await;
    let r = router();
    iptv_core::settings::update(
        &st,
        json!({"stripCountryPrefix": true, "epgOffsetMinutes": 60, "vodMinRating": 5.5, "showExternalBar": false}),
    )
    .await
    .unwrap();
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "xtream",
            "exportedId": "xt-w",
            "title": "Watched Xtream",
            "connection": { "serverUrl": "http://127.0.0.1:9/xtream", "username": "w", "password": "p" },
            "userState": {
                "favorites": [], "recentlyViewed": [], "hiddenCategories": [],
                "playbackPositions": [
                    { "contentXtreamId": 201, "contentType": "vod", "positionSeconds": 6000, "durationSeconds": 6000, "watched": true },
                    { "contentXtreamId": 202, "contentType": "vod", "positionSeconds": 30, "durationSeconds": 6000 }
                ]
            }
        }]
    })
    .to_string();
    import(&r, &st, &manifest, "merge").await;
    let rows: Vec<(String, i64, i64)> = st
        .db_call(|c| {
            let mut s = c.prepare(
                "SELECT item_id, position_seconds, watched FROM playback_positions ORDER BY item_id",
            )?;
            let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(
        rows,
        vec![("201".to_string(), 6000, 1), ("202".to_string(), 30, 0)],
        "a complete watched position is kept; the old-shape entry is unwatched"
    );

    let out = export(&r, &st, true).await;
    let settings = &out["settings"];
    assert_eq!(settings["stripCountryPrefix"], true);
    assert_eq!(settings["epgOffsetMinutes"], 60);
    assert_eq!(settings["vodMinRating"], 5.5);
    assert_eq!(settings["showExternalBar"], false);
    assert!(settings["epgUrls"].is_array(), "IPTVnator needs epgUrls");
    assert!(settings.get("recordingsDir").is_none() && settings.get("mpvPath").is_none());
    let positions = out["playlists"][0]["userState"]["playbackPositions"]
        .as_array()
        .unwrap();
    let w: Vec<(i64, bool)> = positions
        .iter()
        .map(|p| {
            (
                p["contentXtreamId"].as_i64().unwrap(),
                p.get("watched").and_then(Value::as_bool).unwrap_or(false),
            )
        })
        .collect();
    assert!(
        w.contains(&(201, true)) && w.contains(&(202, false)),
        "{w:?}"
    );
    assert!(
        positions
            .iter()
            .all(|p| p.get("watched") != Some(&json!(false))),
        "unwatched entries keep the old app's shape"
    );

    // Into a fresh app: settings and the watched flag come back.
    let (_d2, st2) = app(false).await;
    import(&r, &st2, &out.to_string(), "replace").await;
    let s2 = st2.settings_snapshot();
    assert!(s2.strip_country_prefix && !s2.show_external_bar);
    assert_eq!((s2.epg_offset_minutes, s2.vod_min_rating), (60, 5.5));
    let watched: i64 = st2
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT watched FROM playback_positions WHERE item_id = '201'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(watched, 1);
}

/// One app setting this build refuses (a scale out of range, an accent from a
/// later version) skips only that key, each with its own warning; the rest of
/// the backup's settings are restored.
#[tokio::test]
async fn a_refused_app_setting_skips_only_that_key() {
    let (_d, st) = app(false).await;
    let r = router();
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "settings": { "englishOnly": true, "uiScale": 1.3, "accent": "plum", "density": "compact" },
        "playlists": [{
            "portalType": "xtream",
            "exportedId": "xt-s",
            "title": "Settings Xtream",
            "connection": { "serverUrl": "http://127.0.0.1:9/xtream", "username": "s", "password": "p" },
            "userState": { "favorites": [], "recentlyViewed": [], "hiddenCategories": [] }
        }]
    })
    .to_string();
    let report = import(&r, &st, &manifest, "merge").await;
    let warnings: Vec<&str> = report["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter(|w| w.contains("App setting"))
        .collect();
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert!(
        warnings
            .iter()
            .any(|w| w.starts_with("App setting uiScale"))
            && warnings.iter().any(|w| w.starts_with("App setting accent")),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().all(|w| !w.contains("invalid:")),
        "{warnings:?}"
    );
    let s = st.settings_snapshot();
    assert!(s.english_only, "the other keys are restored");
    assert_eq!(s.ui_scale, 1.0, "the refused key keeps its value");
    assert_eq!(
        serde_json::to_value(&s).unwrap()["density"],
        "compact",
        "{s:?}"
    );
}

/// A restored playlist over `RAW_INLINE_MAX` is stored like an imported large
/// file: `m3u_raw.raw = ''` plus `playlists/<id>.m3u`, and it still parses,
/// refreshes, exports, and re-imports unchanged.
#[tokio::test]
async fn large_raw_m3u_is_stored_on_disk_not_inline() {
    let (dir, st) = app(false).await;
    let r = router();
    let logo = "x".repeat(1000);
    let mut text = String::from("#EXTM3U\n");
    let mut n = 0usize;
    while text.len() as u64 <= iptv_core::m3u::importer::RAW_INLINE_MAX {
        text.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"c{n}\" tvg-logo=\"http://127.0.0.1:9/{logo}.png\" group-title=\"G{}\",Channel {n}\nhttp://127.0.0.1:9/live/{n}.ts\n",
            n % 20
        ));
        n += 1;
    }
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "m3u",
            "exportedId": "big",
            "title": "Big Playlist",
            "source": { "kind": "text", "rawM3u": text },
            "userState": { "favorites": [], "recentlyViewed": [], "hiddenCategories": [], "playbackPositions": [] }
        }]
    })
    .to_string();
    import(&r, &st, &manifest, "merge").await;

    let (sid, raw, sha, channels) = st
        .db_call(|c| {
            let sid = source_id(c, "m3u", "Big Playlist");
            let (raw, sha): (String, String) = c.query_row(
                "SELECT raw, sha256 FROM m3u_raw WHERE source_id = ?1",
                [&sid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let channels: i64 = c.query_row(
                "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'live'",
                [&sid],
                |r| r.get(0),
            )?;
            Ok((sid, raw, sha, channels))
        })
        .await
        .unwrap();
    assert!(raw.is_empty(), "large playlist must not be stored inline");
    assert!(!sha.is_empty(), "the import recorded the playlist sha");
    assert_eq!(channels, n as i64);
    let cached = iptv_core::m3u::cached_playlist_path(dir.path(), &sid);
    assert_eq!(std::fs::read_to_string(&cached).unwrap(), text);

    // A refresh of the text source reads the cached copy (unchanged shortcut).
    let (src, _) = iptv_core::sources::run_import(st.clone(), &sid)
        .await
        .unwrap();
    assert!(src.last_error.is_none(), "{:?}", src.last_error);
    assert!(cached.is_file(), "the refresh keeps the cached copy");

    // Export carries the full text; re-importing it keeps the sha (no re-parse needed).
    let exported = export(&r, &st, true).await;
    let entry = exported["playlists"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["title"] == "Big Playlist")
        .unwrap();
    assert_eq!(entry["source"]["rawM3u"].as_str().unwrap(), text);
    import(&r, &st, &manifest, "merge").await;
    let sha_after: String = st
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT sha256 FROM m3u_raw WHERE source_id = ?1",
                [&sid],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(sha_after, sha);
    assert_eq!(std::fs::read_to_string(&cached).unwrap(), text);
}

/// R3 round 2 F3 + F6: a Stalker source restored through `backup.import`
/// records the portal totals (as `sources.add` does), a failed one stores
/// the plain message (no `kind:` prefix), and a replace drops rows the
/// stalker runtime remembered for the re-created id.
#[tokio::test]
async fn stalker_restore_records_totals_and_plain_errors() {
    let mock = iptv_fixtures::spawn_mock().await;
    let (_dir, state) = app(false).await;
    let r = router();
    let portal = mock.url("/stalker/c");
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [
            {
                "portalType": "stalker",
                "exportedId": "stk-good",
                "title": "Good portal",
                "connection": { "portalUrl": portal, "macAddress": "00:1A:79:00:00:01", "isFullStalkerPortal": true },
                "userState": { "favorites": [], "recentlyViewed": [] }
            },
            {
                "portalType": "stalker",
                "exportedId": "stk-bad",
                "title": "Wrong MAC",
                "connection": { "portalUrl": portal, "macAddress": "00:1A:79:00:00:99", "isFullStalkerPortal": true },
                "userState": { "favorites": [], "recentlyViewed": [] }
            }
        ]
    })
    .to_string();
    import(&r, &state, &manifest, "merge").await;

    let check = |sources: Vec<Source>| {
        let good = sources.iter().find(|s| s.name == "Good portal").unwrap();
        assert_eq!(
            (good.channel_count, good.movie_count, good.series_count),
            (30, 30, 10),
            "{good:?}"
        );
        assert_eq!(good.last_error, None);
        let bad = sources.iter().find(|s| s.name == "Wrong MAC").unwrap();
        assert_eq!(
            bad.last_error.as_deref(),
            Some("This MAC address is not registered on the portal. Check the MAC or contact your provider. Portal message: Your STB is not registered. Call the provider."),
            "{bad:?}"
        );
    };
    check(iptv_core::sources::list(&state).await.unwrap());

    // A row remembered for the id must not survive a replace (the old
    // source is removed; the new one may point at another portal).
    let rt = iptv_core::stalker::Runtime::get(&state);
    rt.items.insert(
        "stk-good|movie|5005".into(),
        iptv_core::stalker::CachedItem {
            raw: json!({"id": "5005", "cmd": "http://old-portal.invalid/5005.mp4"}),
            category_name: None,
            category_id: None,
        },
    );
    import(&r, &state, &manifest, "replace").await;
    assert!(!rt.items.contains_key("stk-good|movie|5005"));
    let after = iptv_core::sources::list(&state).await.unwrap();
    assert_eq!(after.len(), 2, "{after:?}");
    check(after);
}

/// B9: merging a backup made without secrets into the install it came from
/// keeps the saved password instead of blanking it.
#[tokio::test]
async fn merge_without_secrets_keeps_saved_passwords() {
    let mock = iptv_fixtures::spawn_mock().await;
    let text = inline_manifest().replace("{mock}", &mock.base);
    let r = router();
    let (_d, st) = app(false).await;
    import(&r, &st, &text, "merge").await;
    let exported = export(&r, &st, false).await.to_string();
    assert!(!exported.contains("\"password\""));
    let rep = import(&r, &st, &exported, "merge").await;
    assert!(
        !rep["warnings"].to_string().contains("no password"),
        "{rep}"
    );
    let cfg: String = st
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT config_json FROM sources WHERE id = 'xt-one'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    let cfg: Value = serde_json::from_str(&cfg).unwrap();
    assert_eq!(cfg["password"], "secret", "{cfg}");
    drop(mock);
}

fn m3u_entry(id: Value, position: Value) -> Value {
    json!({
        "portalType": "m3u",
        "exportedId": id,
        "title": format!("T {id}"),
        "position": position,
        "source": { "kind": "text", "rawM3u": INLINE_M3U },
    })
}

/// B9: hostile ids cannot name files outside the data folder, and a huge
/// position cannot break later `sources.add`.
#[tokio::test]
async fn hostile_ids_and_positions_are_neutralized() {
    let (_d, st) = app(false).await;
    let r = router();
    let text = json!({
        "kind": "iptvnator-playlist-backup", "version": 1,
        "playlists": [
            m3u_entry(json!("C:evil"), json!(i64::MAX)),
            m3u_entry(json!("x:stream"), json!(-5)),
            m3u_entry(json!(".."), Value::Null),
        ]
    })
    .to_string();
    // Same playlist text: two entries are duplicates; make them differ.
    let text = text.replacen("Sport One", "Sport A", 1);
    let rep = import(&r, &st, &text, "merge").await;
    assert!(rep["imported"].as_i64().unwrap() >= 1, "{rep}");
    let rows: Vec<(String, i64)> = st
        .db_call(|c| {
            let mut stmt = c.prepare("SELECT id, position FROM sources")?;
            let v = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
        .await
        .unwrap();
    for (id, pos) in &rows {
        assert!(!id.contains(':') && !id.starts_with('.'), "{id}");
        assert!((0..=1_000_000).contains(pos), "{id}: {pos}");
    }
    // A later add still computes MAX(position) + 1.
    let added = iptv_core::rpc::build_router()
        .dispatch(
            st.clone(),
            "sources.add",
            json!({"kind": "m3u", "name": "After", "m3u": {"origin": "text", "text": INLINE_M3U}}),
        )
        .await;
    assert!(added.is_ok(), "{added:?}");
}

/// B9: Replace refuses a backup none of whose playlists can be read, and
/// leaves the existing sources alone.
#[tokio::test]
async fn replace_with_no_usable_entry_changes_nothing() {
    let mock = iptv_fixtures::spawn_mock().await;
    let text = inline_manifest().replace("{mock}", &mock.base);
    let r = router();
    let (_d, st) = app(false).await;
    import(&r, &st, &text, "merge").await;
    let count = |st: Arc<AppState>| async move {
        st.db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM sources", [], |r| r.get::<_, i64>(0))?))
            .await
            .unwrap()
    };
    let before = count(st.clone()).await;
    assert!(before >= 3);
    let bad = json!({
        "kind": "iptvnator-playlist-backup", "version": 1,
        "playlists": [ { "portalType": "m3u", "title": "Broken", "source": {} }, { "portalType": "nope" } ]
    })
    .to_string();
    let err = r
        .dispatch(
            st.clone(),
            "backup.import",
            json!({ "json": bad, "mode": "replace" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);
    assert!(err.message.contains("nothing was replaced"), "{err:?}");
    assert_eq!(count(st.clone()).await, before);
    drop(mock);
}

/// B9 (review round 1): Replace with an empty playlist list, or with only an
/// M3U whose text holds no channel, is refused and keeps every source.
#[tokio::test]
async fn replace_with_empty_or_unparseable_backup_changes_nothing() {
    let mock = iptv_fixtures::spawn_mock().await;
    let text = inline_manifest().replace("{mock}", &mock.base);
    let r = router();
    let (_d, st) = app(false).await;
    import(&r, &st, &text, "merge").await;
    let count = |st: Arc<AppState>| async move {
        st.db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM sources", [], |r| r.get::<_, i64>(0))?))
            .await
            .unwrap()
    };
    let before = count(st.clone()).await;
    assert!(before >= 3);
    let empty = json!({ "kind": "iptvnator-playlist-backup", "version": 1, "playlists": [] });
    let junk = json!({
        "kind": "iptvnator-playlist-backup", "version": 1,
        "playlists": [ { "portalType": "m3u", "title": "Junk",
                         "source": { "kind": "text", "rawM3u": "this is not a playlist" } } ]
    });
    for bad in [empty, junk] {
        let err = r
            .dispatch(
                st.clone(),
                "backup.import",
                json!({ "json": bad.to_string(), "mode": "replace" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid, "{bad}");
        assert!(err.message.contains("nothing was replaced"), "{err:?}");
        assert_eq!(count(st.clone()).await, before, "{bad}");
    }
    drop(mock);
}

/// B9 (review round 2): Replace keeps every existing source until a new
/// catalog actually loaded. A header-only M3U whose URL 404s and an Xtream
/// account without a password load nothing, so the old sources, settings
/// and pins stay; adding one good playlist makes the replace go through.
#[tokio::test]
async fn replace_keeps_old_sources_until_a_new_catalog_loads() {
    let mock = iptv_fixtures::spawn_mock().await;
    let text = inline_manifest().replace("{mock}", &mock.base);
    let r = router();
    let (_d, st) = app(false).await;
    import(&r, &st, &text, "merge").await;
    let ids = |st: Arc<AppState>| async move {
        st.db_call(|c| {
            Ok(c.prepare("SELECT id FROM sources ORDER BY id")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap()
    };
    let before = ids(st.clone()).await;
    assert!(before.len() >= 3, "{before:?}");
    let epg_before = st.settings_snapshot().epg_urls;
    assert!(!epg_before.is_empty());

    let empty_m3u = json!({ "portalType": "m3u", "exportedId": "empty", "title": "Empty",
        "source": { "kind": "url", "url": format!("{}/missing/404.m3u", mock.base), "rawM3u": "#EXTM3U\n" } });
    let no_password = json!({ "portalType": "xtream", "exportedId": "nopw", "title": "No password",
        "connection": { "serverUrl": mock.base, "username": "someone" } });
    let failing = json!({ "kind": "iptvnator-playlist-backup", "version": 1,
        "settings": { "epgUrls": [] },
        "playlists": [empty_m3u.clone(), no_password.clone()] });
    let err = r
        .dispatch(
            st.clone(),
            "backup.import",
            json!({ "json": failing.to_string(), "mode": "replace" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid, "{err:?}");
    assert!(err.message.contains("nothing was replaced"), "{err:?}");
    // Review round 3: the reason is the import's own failure, not the
    // "source was kept ... will be restored" tail of its warning.
    assert!(err.message.contains("\"Empty\": "), "{err:?}");
    assert!(
        !err.message.contains("was kept") && !err.message.contains("will be restored"),
        "{err:?}"
    );
    assert_eq!(ids(st.clone()).await, before, "old sources must stay");
    assert_eq!(
        st.settings_snapshot().epg_urls,
        epg_before,
        "settings must stay"
    );

    let good = json!({ "portalType": "m3u", "exportedId": "good", "title": "Good",
        "source": { "kind": "text", "rawM3u": INLINE_M3U } });
    let mixed = json!({ "kind": "iptvnator-playlist-backup", "version": 1,
        "playlists": [empty_m3u, no_password, good] });
    let rep = import(&r, &st, &mixed.to_string(), "replace").await;
    assert_eq!(rep["imported"], 3, "{rep}");
    let after = ids(st.clone()).await;
    assert_eq!(after.len(), 3, "{after:?}");
    assert!(after.iter().all(|id| !before.contains(id)), "{after:?}");
    assert!(after.contains(&"good".to_string()), "{after:?}");
    assert!(
        st.settings_snapshot().epg_urls.is_empty(),
        "replace restores settings"
    );
    drop(mock);
}

/// Review round 2: merging an older backup never rolls back newer progress.
/// Dated rows lose to newer stored rows; undated rows only fill gaps.
#[tokio::test]
async fn merge_of_an_older_backup_keeps_newer_progress() {
    let (_d, st) = app(false).await;
    let r = router();
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "xtream",
            "exportedId": "xt-p",
            "title": "Progress",
            "connection": { "serverUrl": "http://127.0.0.1:9/xtream", "username": "p", "password": "p" },
            "userState": {
                "favorites": [], "recentlyViewed": [], "hiddenCategories": [],
                "playbackPositions": [
                    { "contentXtreamId": 201, "contentType": "vod", "positionSeconds": 600, "durationSeconds": 6000, "updatedAt": "2026-09-07T00:00:00.000Z" },
                    { "contentXtreamId": 202, "contentType": "vod", "positionSeconds": 30, "durationSeconds": 6000 }
                ]
            }
        }]
    })
    .to_string();
    let rows = |st: Arc<AppState>| async move {
        st.db_call(|c| {
            let mut s = c.prepare(
                "SELECT item_id, position_seconds FROM playback_positions ORDER BY item_id",
            )?;
            let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap()
    };
    import(&r, &st, &manifest, "merge").await;
    // An undated row fills the gap when nothing is stored.
    assert_eq!(
        rows(st.clone()).await,
        vec![("201".to_string(), 600), ("202".to_string(), 30)]
    );
    // The user keeps watching after the backup was made.
    st.db_call(|c| {
        c.execute_batch(
            "UPDATE playback_positions SET position_seconds = 3000, updated_at = '2026-10-01T00:00:00.000Z' WHERE item_id = '201';
             UPDATE playback_positions SET position_seconds = 2000, updated_at = '2026-10-01T00:00:00.000Z' WHERE item_id = '202';",
        )?;
        Ok(())
    })
    .await
    .unwrap();
    import(&r, &st, &manifest, "merge").await;
    assert_eq!(
        rows(st.clone()).await,
        vec![("201".to_string(), 3000), ("202".to_string(), 2000)],
        "an older backup must not roll back progress"
    );
}

/// Review round 3 (R3-sources F1): a backup carries manual EPG mappings (every
/// kind), M3U and Stalker playback positions and Stalker hidden categories as
/// Tsrust extensions, and a Replace with that backup restores them under the
/// new source ids.
#[tokio::test]
async fn round_trip_keeps_epg_mappings_positions_and_stalker_hidden_categories() {
    let mock = iptv_fixtures::spawn_mock().await;
    let text = inline_manifest().replace("{mock}", &mock.base);
    let r = router();
    let (_d, st) = app(false).await;
    import(&r, &st, &text, "merge").await;
    let (m3u_item, stk_cat) = st
        .db_call(|c| {
            let m3u = source_id(c, "m3u", "Inline M3U");
            let xt = source_id(c, "xtream", "Inline Xtream");
            let stk = source_id(c, "stalker", "Inline Stalker");
            let m3u_item: String = c.query_row(
                "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' ORDER BY item_id LIMIT 1",
                [&m3u],
                |r| r.get(0),
            )?;
            let stk_cat: (String, String) = c.query_row(
                "SELECT content_type, category_id FROM categories WHERE source_id = ?1 ORDER BY content_type, category_id LIMIT 1",
                [&stk],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            for (sid, ct, item, epg) in [
                (&m3u, "live", m3u_item.as_str(), Some("news.override")),
                (&xt, "live", "101", None),
                (&stk, "live", "1", Some("stalker.one")),
            ] {
                c.execute(
                    "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES (?1, ?2, ?3, ?4)",
                    params![sid, ct, item, epg],
                )?;
            }
            for (sid, ct, item, ep, pos, watched) in [
                (&m3u, "live", m3u_item.as_str(), "", 120, 0),
                (&stk, "movie", "55", "", 900, 1),
                (&stk, "series", "7", "7:1:2", 50, 0),
            ] {
                c.execute(
                    "INSERT INTO playback_positions(source_id, content_type, item_id, episode_id, position_seconds, duration_seconds, updated_at, snapshot_json, watched)
                     VALUES (?1, ?2, ?3, ?4, ?5, 5400, '2026-10-02T00:00:00.000Z', '{\"title\":\"Saved\"}', ?6)",
                    params![sid, ct, item, ep, pos, watched],
                )?;
            }
            c.execute(
                "UPDATE categories SET hidden = 1 WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
                params![stk, stk_cat.0, stk_cat.1],
            )?;
            Ok((m3u_item, stk_cat))
        })
        .await
        .unwrap();

    let exported = export(&r, &st, true).await;
    let rep = import(&r, &st, &exported.to_string(), "replace").await;
    assert_eq!(rep["skipped"], 0, "{rep}");

    st.db_call(move |c| {
        let m3u = source_id(c, "m3u", "Inline M3U");
        let xt = source_id(c, "xtream", "Inline Xtream");
        let stk = source_id(c, "stalker", "Inline Stalker");
        let map = |sid: &str, ct: &str, item: &str| -> rusqlite::Result<Option<Option<String>>> {
            c.query_row(
                "SELECT epg_channel_id FROM epg_channel_map WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
                params![sid, ct, item],
                |r| r.get(0),
            )
            .optional()
        };
        assert_eq!(
            map(&m3u, "live", &m3u_item)?,
            Some(Some("news.override".into()))
        );
        assert_eq!(map(&xt, "live", "101")?, Some(None), "explicitly unmapped");
        assert_eq!(map(&stk, "live", "1")?, Some(Some("stalker.one".into())));
        let pos = |sid: &str,
                   ct: &str,
                   item: &str,
                   ep: &str|
         -> rusqlite::Result<Option<(i64, bool, String)>> {
            c.query_row(
                "SELECT position_seconds, watched, snapshot_json FROM playback_positions
                 WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND episode_id = ?4",
                params![sid, ct, item, ep],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?)),
            )
            .optional()
        };
        let p = pos(&m3u, "live", &m3u_item, "")?.expect("m3u position");
        assert_eq!((p.0, p.1), (120, false));
        assert!(p.2.contains("Saved"), "{}", p.2);
        assert_eq!(
            pos(&stk, "movie", "55", "")?.map(|p| (p.0, p.1)),
            Some((900, true))
        );
        assert_eq!(pos(&stk, "series", "7", "7:1:2")?.map(|p| p.0), Some(50));
        let hidden: i64 = c.query_row(
            "SELECT hidden FROM categories WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
            params![stk, stk_cat.0, stk_cat.1],
            |r| r.get(0),
        )?;
        assert_eq!(hidden, 1, "stalker hidden category");
        Ok(())
    })
    .await
    .unwrap();

    // The extension keys travel in Tsrust exports; IPTVnator ignores them,
    // and backups without them (every other test here) still import.
    let us = &exported["playlists"][0]["userState"];
    assert!(us.get("tsrustEpgMappings").is_some(), "{us}");
    drop(mock);
}

/// Review round 3 (R3-sources F6): an M3U URL source whose first import
/// failed exports `rawM3u: ""`; one with only the header carries no
/// channels. Both import from their URL instead of being dropped or left
/// empty.
#[tokio::test]
async fn url_entries_without_channel_text_import_from_the_url() {
    let mock = iptv_fixtures::spawn_mock().await;
    let r = router();
    let (_d, st) = app(false).await;
    let url = format!("{}/m3u/sample.m3u", mock.base);
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [
            { "portalType": "m3u", "exportedId": "empty-raw", "title": "Empty raw",
              "source": { "kind": "url", "url": url, "rawM3u": "" } },
            { "portalType": "m3u", "exportedId": "header-only", "title": "Header only",
              "source": { "kind": "url", "url": format!("{url}?second=1"), "rawM3u": "#EXTM3U\n" } }
        ]
    })
    .to_string();
    let rep = import(&r, &st, &manifest, "replace").await;
    assert_eq!(
        (rep["imported"].as_i64(), rep["skipped"].as_i64()),
        (Some(2), Some(0)),
        "{rep}"
    );
    let sources = iptv_core::sources::list(&st).await.unwrap();
    assert_eq!(sources.len(), 2);
    for s in sources {
        assert!(s.channel_count > 0, "{s:?}");
        let cfg = s.m3u.as_ref().unwrap();
        assert_eq!(cfg.origin, iptv_core::model::M3uOrigin::Url, "{s:?}");
        assert!(cfg.url.as_deref().unwrap().starts_with(&url), "{s:?}");
    }
    drop(mock);
}

/// Per-channel guide shifts travel as `tsrustEpgShifts`: imported under the
/// entry's source (zero and out-of-range rows skipped, including numbers and
/// strings that saturate to i64::MIN) and exported again.
#[tokio::test]
async fn channel_guide_shifts_round_trip() {
    let (_d, st) = app(false).await;
    let r = router();
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "m3u", "exportedId": "m3u-s", "title": "Shifted M3U",
            "source": { "kind": "text", "rawM3u": INLINE_M3U },
            "userState": { "favorites": [], "recentlyViewed": [], "tsrustEpgShifts": [
                { "contentType": "live", "itemId": "a", "shiftMinutes": 90 },
                { "contentType": "live", "itemId": "b", "shiftMinutes": 0 },
                { "contentType": "live", "itemId": "c", "shiftMinutes": 5000 },
                { "contentType": "live", "itemId": "d", "shiftMinutes": i64::MIN },
                { "contentType": "live", "itemId": "e", "shiftMinutes": "-1e30" },
                { "contentType": "live", "itemId": "f", "shiftMinutes": -720 },
                { "contentType": "live", "itemId": "g", "shiftMinutes": -721 }
            ] }
        }]
    })
    .to_string();
    import(&r, &st, &manifest, "merge").await;
    let rows = st
        .db_call(|c| {
            let mut s = c.prepare(
                "SELECT item_id, shift_minutes FROM epg_channel_shift WHERE source_id = 'm3u-s'
                 ORDER BY item_id",
            )?;
            let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(rows, vec![("a".to_string(), 90), ("f".to_string(), -720)]);
    let exported = export(&r, &st, false).await;
    assert_eq!(
        exported["playlists"][0]["userState"]["tsrustEpgShifts"],
        json!([
            { "contentType": "live", "itemId": "a", "shiftMinutes": 90 },
            { "contentType": "live", "itemId": "f", "shiftMinutes": -720 }
        ])
    );
}

/// Review round 3: the Tsrust position extension (M3U and Stalker) follows
/// the same rules as the Xtream positions: an older dated row and an undated
/// row never overwrite newer stored progress; an undated row fills a gap.
#[tokio::test]
async fn merged_extension_positions_never_roll_back_progress() {
    let (_d, st) = app(false).await;
    let r = router();
    let manifest = |positions: Value| {
        json!({
            "kind": "iptvnator-playlist-backup",
            "version": 1,
            "playlists": [{
                "portalType": "m3u", "exportedId": "m3u-p", "title": "Progress M3U",
                "source": { "kind": "text", "rawM3u": INLINE_M3U },
                "userState": { "favorites": [], "recentlyViewed": [], "tsrustPlaybackPositions": positions }
            }]
        })
        .to_string()
    };
    import(&r, &st, &manifest(json!([])), "merge").await;
    let items: Vec<String> = st
        .db_call(|c| {
            Ok(c.prepare(
                "SELECT item_id FROM items WHERE source_id = 'm3u-p' ORDER BY item_id LIMIT 3",
            )?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    let (a, b, gap) = (items[0].clone(), items[1].clone(), items[2].clone());
    {
        let (a, b) = (a.clone(), b.clone());
        st.db_call(move |c| {
            for item in [&a, &b] {
                c.execute(
                    "INSERT INTO playback_positions(source_id, content_type, item_id, position_seconds, updated_at)
                     VALUES ('m3u-p', 'live', ?1, 3000, '2026-10-01T00:00:00.000Z')",
                    [item],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    }
    let older = manifest(json!([
        { "contentType": "live", "itemId": a, "positionSeconds": 10, "updatedAt": "2026-09-01T00:00:00.000Z" },
        { "contentType": "live", "itemId": b, "positionSeconds": 20 },
        { "contentType": "live", "itemId": gap, "positionSeconds": 30 }
    ]));
    import(&r, &st, &older, "merge").await;
    let rows = st
        .db_call(|c| {
            let mut s = c.prepare(
                "SELECT item_id, position_seconds FROM playback_positions WHERE source_id = 'm3u-p' ORDER BY item_id",
            )?;
            let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    let mut want = vec![(a, 3000), (b, 3000), (gap, 30)];
    want.sort();
    assert_eq!(rows, want);
}
