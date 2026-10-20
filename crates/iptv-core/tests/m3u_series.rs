//! F-M3U-SERIES: an m3u_plus playlist's episodes import as series with
//! seasons (`catalog.series`, `m3u.seriesDetail`, `m3u.streamUrl`), the
//! series' watched mark follows its episodes, and state that earlier imports
//! saved on episodes stored as movies moves to the series, with the hidden
//! flag and parental lock of their movie group. The startup pass re-imports
//! catalogs an older import version wrote, and `catalog.item` gives an M3U
//! movie its stream URL.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{self, CategoryRow, ItemRow};
use iptv_core::m3u::importer::{playlist_sha, IMPORT_VERSION};
use iptv_core::model::ContentType;
use iptv_core::rpc::build_router;
use iptv_core::sources::{self, schedule};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Duration;
use support::*;

const EP1_URL: &str = "http://h:8080/series/u/p/5001.mkv";
const EP1_NAME: &str = "EN - Dark (2017) S01 E01";
const EP2_URL: &str = "http://h:8080/series/u/p/5002.mkv";
const EP2_NAME: &str = "EN - Dark (2017) S01 E02";

const PLAYLIST: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-logo=\"http://i/dark.jpg\" group-title=\"EN | Drama\",EN - Dark (2017) S01 E01\nhttp://h:8080/series/u/p/5001.mkv\n\
#EXTINF:-1 group-title=\"EN | Action\",Heat (1995)\nhttp://h:8080/movie/u/p/1001.mkv\n\
#EXTINF:-1 tvg-logo=\"http://i/dark.jpg\" group-title=\"EN | Drama\",EN - Dark (2017) S01 E02\n#EXTVLCOPT:http-user-agent=EpisodeUA/1\nhttp://h:8080/series/u/p/5002.mkv\n\
#EXTINF:-1 group-title=\"EN | Drama\",EN - Dark (2017) S02 E01\nhttp://h:8080/series/u/p/5003.mkv\n\
#EXTINF:-1 group-title=\"News\",BBC One\nhttp://h:8080/u/p/7.ts\n";

async fn call(env: &Env, cmd: &str, args: Value) -> Value {
    build_router()
        .dispatch(env.state.clone(), cmd, args)
        .await
        .unwrap_or_else(|e| panic!("{cmd} failed: {} {:?}", e.message, e.code))
}

/// The one series of `source_id` and its detail.
async fn dark(env: &Env, source_id: &str) -> (Value, Value) {
    let page = call(env, "catalog.series", json!({ "sourceId": source_id })).await;
    assert_eq!(page["total"], 1, "{page}");
    let series_ref = page["items"][0]["ref"].clone();
    let detail = call(env, "m3u.seriesDetail", json!({ "ref": series_ref })).await;
    (series_ref, detail)
}

#[tokio::test]
async fn m3u_plus_episodes_import_as_one_series_with_seasons() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", PLAYLIST).await;
    assert_eq!(src.channel_count, 1);
    assert_eq!(src.movie_count, 1, "episodes are not movies");
    assert_eq!(src.series_count, 1);

    let movies = call(&env, "catalog.movies", json!({ "sourceId": src.id })).await;
    assert_eq!(movies["total"], 1);
    assert_eq!(movies["items"][0]["title"], "Heat (1995)");

    let (series_ref, detail) = dark(&env, &src.id).await;
    let item = &detail["item"];
    assert_eq!(item["title"], "EN - Dark (2017)");
    assert_eq!(item["titleBase"], "Dark");
    assert_eq!(item["year"], 2017);
    assert_eq!(item["posterUrl"], "http://i/dark.jpg");
    assert_eq!(item["categoryName"], "EN | Drama");
    let seasons = detail["seasons"].as_array().unwrap();
    assert_eq!(seasons.len(), 2);
    assert_eq!(seasons[0]["number"], 1);
    let s1 = seasons[0]["episodes"].as_array().unwrap();
    assert_eq!(s1.len(), 2);
    assert_eq!(s1[1]["episode"], 2);
    assert_eq!(s1[1]["containerExtension"], "mkv");
    assert_eq!(s1[1]["seriesRef"], series_ref);
    assert_eq!(seasons[1]["number"], 2);
    assert_eq!(detail["providerDetailsUnavailable"], false);

    // The episode plays from its own URL, with its own headers.
    let play = call(
        &env,
        "m3u.streamUrl",
        json!({ "ref": series_ref, "episodeId": s1[1]["id"] }),
    )
    .await;
    assert_eq!(play["url"], EP2_URL);
    assert_eq!(play["kind"], "direct");
    assert_eq!(play["episodeId"], s1[1]["id"]);
    assert_eq!(play["headers"]["userAgent"], "EpisodeUA/1");
    assert!(play["subtitle"].as_str().unwrap().starts_with("S01E02 · "));
    assert_eq!(play["isLive"], false);

    // Search finds the show as a series.
    let found = call(&env, "catalog.search", json!({ "query": "dark" })).await;
    assert_eq!(found["series"].as_array().unwrap().len(), 1, "{found}");
    assert!(found["movies"].as_array().unwrap().is_empty(), "{found}");

    let r = build_router();
    let err = r
        .dispatch(
            env.state.clone(),
            "m3u.streamUrl",
            json!({ "ref": series_ref, "episodeId": "nope" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::NotFound);
    let err = r
        .dispatch(
            env.state.clone(),
            "m3u.streamUrl",
            json!({ "ref": series_ref }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);
    let err = r
        .dispatch(
            env.state.clone(),
            "m3u.seriesDetail",
            json!({ "ref": movies["items"][0]["ref"] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::Invalid);
}

async fn series_watched(env: &Env, series_ref: &Value) -> bool {
    let v = call(
        env,
        "positions.watchedContains",
        json!({ "refs": [series_ref] }),
    )
    .await;
    !v.as_array().unwrap().is_empty()
}

#[tokio::test]
async fn watching_every_episode_marks_the_m3u_series_watched() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", PLAYLIST).await;
    let (series_ref, detail) = dark(&env, &src.id).await;
    let ids: Vec<Value> = detail["seasons"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| {
            s["episodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["id"].clone())
        })
        .collect();
    assert_eq!(ids.len(), 3);
    for id in &ids[..2] {
        call(
            &env,
            "userstate.setWatched",
            json!({ "ref": series_ref, "episodeId": id, "watched": true }),
        )
        .await;
    }
    assert!(!series_watched(&env, &series_ref).await, "one episode left");
    call(
        &env,
        "userstate.setWatched",
        json!({ "ref": series_ref, "episodeId": ids[2], "watched": true }),
    )
    .await;
    assert!(
        series_watched(&env, &series_ref).await,
        "every stored episode is watched"
    );
    call(
        &env,
        "userstate.setWatched",
        json!({ "ref": series_ref, "episodeId": ids[0], "watched": false }),
    )
    .await;
    assert!(
        !series_watched(&env, &series_ref).await,
        "unmarking an episode clears the series"
    );
}

async fn exec(env: &Env, sql: &'static str, a: String, b: String) {
    env.state
        .db_call(move |c| {
            c.execute(sql, params![a, b])?;
            Ok(())
        })
        .await
        .unwrap();
}

/// `(content_type, item_id)` of every row of `table` for the source.
async fn refs(env: &Env, table: &'static str, source_id: &str) -> Vec<(String, String)> {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            let mut st = c.prepare(&format!(
                "SELECT content_type, item_id FROM {table} WHERE source_id = ?1 ORDER BY content_type, item_id"
            ))?;
            let rows = st
                .query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn state_saved_on_episodes_imported_as_movies_moves_to_the_series() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", PLAYLIST).await;
    // Imports before series grouping stored each episode as a movie, with the
    // id every m3u row gets. Recreate the state they left behind.
    let ep1 = iptv_core::m3u::item_id(EP1_URL, EP1_NAME);
    let ep2 = iptv_core::m3u::item_id(EP2_URL, EP2_NAME);
    let movies = call(&env, "catalog.movies", json!({ "sourceId": src.id })).await;
    let heat = movies["items"][0]["ref"]["itemId"]
        .as_str()
        .unwrap()
        .to_string();
    for id in [&ep1, &ep2, &heat] {
        exec(
            &env,
            "INSERT INTO favorites (source_id, content_type, item_id, snapshot_json) VALUES (?1, 'movie', ?2, '{\"title\":\"Old\",\"contentType\":\"movie\"}')",
            src.id.clone(),
            id.clone(),
        )
        .await;
    }
    exec(
        &env,
        "INSERT INTO playback_positions (source_id, content_type, item_id, position_seconds, duration_seconds, watched, snapshot_json)
         VALUES (?1, 'movie', ?2, 2000, 2100, 1, '{\"title\":\"EN - Dark (2017) S01 E01\",\"contentType\":\"movie\"}')",
        src.id.clone(),
        ep1.clone(),
    )
    .await;
    exec(
        &env,
        "INSERT INTO playback_positions (source_id, content_type, item_id, position_seconds) VALUES (?1, 'movie', ?2, 300)",
        src.id.clone(),
        ep2.clone(),
    )
    .await;
    exec(
        &env,
        "INSERT INTO watchlist (source_id, content_type, item_id, title, added_at) VALUES (?1, 'movie', ?2, 'Old', '2026-01-01T00:00:00Z')",
        src.id.clone(),
        ep1.clone(),
    )
    .await;
    let (sid, a, b) = (src.id.clone(), ep1.clone(), ep2.clone());
    env.state
        .db_call(move |c| {
            for (id, secs) in [(a, 60), (b, 30)] {
                c.execute(
                    "INSERT INTO watch_log (day, source_id, content_type, item_id, title, seconds, last_at)
                     VALUES ('2026-01-01', ?1, 'movie', ?2, 'Old', ?3, '2026-01-01T20:00:00Z')",
                    params![sid, id, secs],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();

    // The next import (forced: the stored sha predates this build) moves it.
    exec(
        &env,
        "UPDATE m3u_raw SET sha256 = ?2 WHERE source_id = ?1",
        src.id.clone(),
        "old".into(),
    )
    .await;
    sources::refresh(env.state.clone(), &src.id).await.unwrap();

    let (series_ref, detail) = dark(&env, &src.id).await;
    let series_id = series_ref["itemId"].as_str().unwrap().to_string();
    let s1 = detail["seasons"][0]["episodes"].as_array().unwrap();
    let (e1, e2) = (
        s1[0]["id"].as_str().unwrap().to_string(),
        s1[1]["id"].as_str().unwrap().to_string(),
    );
    let series = |id: &str| ("series".to_string(), id.to_string());
    let movie = |id: &str| ("movie".to_string(), id.to_string());

    // Two favorited episodes make one series favorite; the real movie stays.
    assert_eq!(
        refs(&env, "favorites", &src.id).await,
        [movie(&heat), series(&series_id)]
    );
    assert_eq!(refs(&env, "watchlist", &src.id).await, [series(&series_id)]);
    assert_eq!(refs(&env, "watch_log", &src.id).await, [series(&series_id)]);

    let sid = src.id.clone();
    let positions: Vec<(String, String, String, i64, i64, Option<String>)> = env
        .state
        .db_call(move |c| {
            let mut st = c.prepare(
                "SELECT content_type, item_id, episode_id, position_seconds, watched, snapshot_json
                 FROM playback_positions WHERE source_id = ?1 ORDER BY position_seconds DESC",
            )?;
            let rows = st
                .query_map(params![sid], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap();
    assert_eq!(positions.len(), 2, "{positions:?}");
    let (ct, item, ep, pos, watched, snap) = &positions[0];
    assert_eq!(
        (ct.as_str(), item.as_str(), ep.as_str(), *pos, *watched),
        ("series", series_id.as_str(), e1.as_str(), 2000, 1)
    );
    let snap: Value = serde_json::from_str(snap.as_deref().unwrap()).unwrap();
    assert_eq!(snap["contentType"], "series");
    assert_eq!(snap["title"], "EN - Dark (2017)");
    assert!(snap["subtitle"].as_str().unwrap().starts_with("S01E01 · "));
    assert_eq!(
        (
            positions[1].0.as_str(),
            positions[1].2.as_str(),
            positions[1].3
        ),
        ("series", e2.as_str(), 300)
    );

    let favs = env
        .state
        .db_call({
            let sid = src.id.clone();
            move |c| {
                Ok(c.query_row(
                    "SELECT snapshot_json FROM favorites WHERE source_id = ?1 AND content_type = 'series'",
                    params![sid],
                    |r| r.get::<_, String>(0),
                )?)
            }
        })
        .await
        .unwrap();
    let favs: Value = serde_json::from_str(&favs).unwrap();
    assert_eq!(favs["contentType"], "series");
    assert_eq!(favs["title"], "EN - Dark (2017)");
    assert!(favs.get("subtitle").is_none());

    let secs: i64 = env
        .state
        .db_call({
            let sid = src.id.clone();
            move |c| {
                Ok(c.query_row(
                    "SELECT seconds FROM watch_log WHERE source_id = ?1",
                    params![sid],
                    |r| r.get(0),
                )?)
            }
        })
        .await
        .unwrap();
    assert_eq!(secs, 90, "the two episodes' time adds up under the series");
}

/// The rows of `sql` (the source id as `?1`), three text columns each.
async fn rows3(env: &Env, sql: &'static str, source_id: &str) -> Vec<[String; 3]> {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            let mut st = c.prepare(sql)?;
            let rows = st
                .query_map(params![sid], |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?]))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

const POSITIONS: &str = "SELECT content_type || '/' || item_id, episode_id, CAST(watched AS TEXT)
     FROM playback_positions WHERE source_id = ?1 ORDER BY 1, 2";

const ITEM_LOCKS: &str = "SELECT content_type, target_id, kind FROM parental_locks
     WHERE source_id = ?1 AND kind = 'item'";

/// The provider rotated the token in every URL between the last import that
/// stored episodes as movies and the first that groups them: their movie ids
/// changed, so the saved state finds them by identity (name and group) in the
/// movie rows that import wrote. Favorites, positions and parental item locks
/// move to the series.
#[tokio::test]
async fn state_on_episodes_follows_them_through_a_token_rotation() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", PLAYLIST).await;
    let ep1 = iptv_core::m3u::item_id(EP1_URL, EP1_NAME);
    let ep2 = iptv_core::m3u::item_id(EP2_URL, EP2_NAME);
    let drama = iptv_core::m3u::group_id("EN | Drama");
    let sid = src.id.clone();
    env.state
        .db_call(move |c| {
            // The catalog that import wrote: the episodes as movie rows.
            c.execute(
                "DELETE FROM items WHERE source_id = ?1 AND content_type = 'series'",
                params![sid],
            )?;
            for (id, title) in [(&ep1, EP1_NAME), (&ep2, EP2_NAME)] {
                c.execute(
                    "INSERT INTO items (source_id, content_type, item_id, category_id, title)
                     VALUES (?1, 'movie', ?2, ?3, ?4)",
                    params![sid, id, drama, title],
                )?;
            }
            c.execute(
                "INSERT INTO favorites (source_id, content_type, item_id, snapshot_json)
                 VALUES (?1, 'movie', ?2, '{\"title\":\"Old\"}')",
                params![sid, ep1],
            )?;
            c.execute(
                "INSERT INTO playback_positions (source_id, content_type, item_id, position_seconds, duration_seconds, watched)
                 VALUES (?1, 'movie', ?2, 2000, 2100, 1)",
                params![sid, ep1],
            )?;
            c.execute(
                "INSERT INTO parental_locks (source_id, content_type, kind, target_id, name, created_at)
                 VALUES (?1, 'movie', 'item', ?2, 'Old', '2026-01-01T00:00:00Z')",
                params![sid, ep2],
            )?;
            // The next import reads new URLs.
            c.execute(
                "UPDATE m3u_raw SET raw = ?2, sha256 = 'v2' WHERE source_id = ?1",
                params![sid, PLAYLIST.replace("/u/p/", "/u/NEW/")],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    sources::refresh(env.state.clone(), &src.id).await.unwrap();

    let (series_ref, detail) = dark(&env, &src.id).await;
    let series_id = series_ref["itemId"].as_str().unwrap().to_string();
    let e1 = detail["seasons"][0]["episodes"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let play = call(
        &env,
        "m3u.streamUrl",
        json!({ "ref": series_ref, "episodeId": e1 }),
    )
    .await;
    assert_eq!(play["url"], "http://h:8080/series/u/NEW/5001.mkv");
    assert_eq!(
        refs(&env, "favorites", &src.id).await,
        [("series".to_string(), series_id.clone())]
    );
    assert_eq!(
        rows3(&env, POSITIONS, &src.id).await,
        [[format!("series/{series_id}"), e1, "1".to_string()]]
    );
    assert_eq!(
        rows3(&env, ITEM_LOCKS, &src.id).await,
        [["series".to_string(), series_id, "item".to_string()]]
    );
}

const RECENT: &str = "SELECT content_type || '/' || item_id, viewed_at, json_extract(snapshot_json, '$.posterUrl')
     FROM recent WHERE source_id = ?1";

/// Two episodes in history, stored as movies by imports before grouping,
/// leave one series entry with the newer view and its snapshot, whichever
/// of them comes first in the playlist.
#[tokio::test]
async fn migrated_history_keeps_the_newest_episode_view() {
    for newer_first in [true, false] {
        let env = env().await;
        let src = add_text(&env.state, "Plus", PLAYLIST).await;
        let ep1 = iptv_core::m3u::item_id(EP1_URL, EP1_NAME);
        let ep2 = iptv_core::m3u::item_id(EP2_URL, EP2_NAME);
        let (old, new) = ("2026-01-01T10:00:00.000Z", "2026-01-02T10:00:00.000Z");
        let views = if newer_first {
            [(ep1, new), (ep2, old)]
        } else {
            [(ep1, old), (ep2, new)]
        };
        let sid = src.id.clone();
        env.state
            .db_call(move |c| {
                // The snapshot's poster names the view it belongs to.
                for (id, at) in views {
                    c.execute(
                        "INSERT INTO recent (source_id, content_type, item_id, viewed_at, snapshot_json)
                         VALUES (?1, 'movie', ?2, ?3, json_object('title', 'Old', 'posterUrl', ?3))",
                        params![sid, id, at],
                    )?;
                }
                c.execute(STALE_SHA, params![sid])?;
                Ok(())
            })
            .await
            .unwrap();
        sources::refresh(env.state.clone(), &src.id).await.unwrap();
        let (series_ref, _) = dark(&env, &src.id).await;
        let series = format!("series/{}", series_ref["itemId"].as_str().unwrap());
        assert_eq!(
            rows3(&env, RECENT, &src.id).await,
            [[series, new.to_string(), new.to_string()]],
            "newer first: {newer_first}"
        );
    }
}

/// Episodes imported as movies and watched there: a series whose every
/// episode comes in watched gets the series mark that finishing its last
/// episode sets; one with an episode left does not.
#[tokio::test]
async fn migrated_watched_episodes_mark_a_complete_series() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", GROUPS).await;
    let sid = src.id.clone();
    env.state
        .db_call(move |c| {
            for (url, name, watched) in [
                ("http://h:8080/series/u/p/9001.mp4", "Bluey S01E01", 1),
                ("http://h:8080/series/u/p/9002.mp4", "Bluey S01E02", 1),
                ("http://h:8080/series/u/p/9101.mp4", "Planet Earth S01E01", 0),
            ] {
                c.execute(
                    "INSERT INTO playback_positions (source_id, content_type, item_id, position_seconds, watched)
                     VALUES (?1, 'movie', ?2, 300, ?3)",
                    params![sid, iptv_core::m3u::item_id(url, name), watched],
                )?;
            }
            c.execute(STALE_SHA, params![sid])?;
            Ok(())
        })
        .await
        .unwrap();
    sources::refresh(env.state.clone(), &src.id).await.unwrap();

    let page = call(&env, "catalog.series", json!({ "sourceId": src.id })).await;
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{page}");
    for item in items {
        let complete = item["title"] == "Bluey";
        assert_eq!(series_watched(&env, &item["ref"]).await, complete, "{item}");
    }
}

/// FW-M3U-MOVIE-URL: `catalog.item` gives an M3U movie the playlist's link
/// and its own headers, which playback and downloads need. Lists stay
/// without links, and a movie of another source kind never gets one.
#[tokio::test]
async fn catalog_item_gives_an_m3u_movie_its_stream_url() {
    let env = env().await;
    let text = "#EXTM3U\n\
        #EXTINF:-1 group-title=\"Films\",Heat (1995)\n\
        #EXTVLCOPT:http-user-agent=MovieUA/1\n\
        http://h:8080/movie/u/p/1001.mkv\n\
        #EXTINF:-1 group-title=\"Films\",Up (2009)\n\
        http://h/films/up.mp4\n";
    let src = add_text(&env.state, "Films", text).await;
    let movies = call(&env, "catalog.movies", json!({ "sourceId": src.id })).await;
    let items = movies["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{movies}");
    for m in items {
        assert!(m.get("url").is_none(), "lists carry no links: {m}");
        let item = call(&env, "catalog.item", json!({ "ref": m["ref"] })).await;
        if m["title"] == "Heat (1995)" {
            assert_eq!(item["url"], "http://h:8080/movie/u/p/1001.mkv");
            assert_eq!(item["headers"], json!({ "userAgent": "MovieUA/1" }));
            assert_eq!(item["containerExtension"], "mkv");
        } else {
            assert_eq!(item["url"], "http://h/films/up.mp4");
            assert!(item.get("headers").is_none(), "{item}");
        }
    }

    // An Xtream movie row that holds a link (as rows once did) stays without
    // one: its link carries the account and comes from xtream.streamUrl.
    env.state
        .db_call(|c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('xt', 'xtream', 'X', '{}')",
                [],
            )?;
            let row = ItemRow {
                source_id: "xt".into(),
                content_type: ContentType::Movie,
                item_id: "1".into(),
                category_id: "c".into(),
                title: "Heat".into(),
                url: Some("http://x:8080/movie/user/pass/1.mkv".into()),
                ..Default::default()
            };
            let cat = CategoryRow {
                category_id: "c".into(),
                name: "Films".into(),
                position: 0,
            };
            let mut rows = vec![row].into_iter();
            catalog::replace_catalog(c, "xt", ContentType::Movie, &[cat], &mut rows)?;
            Ok(())
        })
        .await
        .unwrap();
    let xt_ref = json!({ "sourceId": "xt", "contentType": "movie", "itemId": "1" });
    let xt = call(&env, "catalog.item", json!({ "ref": xt_ref })).await;
    assert_eq!(xt["title"], "Heat");
    assert!(xt.get("url").is_none(), "{xt}");
    assert!(xt.get("headers").is_none(), "{xt}");
}

/// The stored `(sha256, recorded import version)` of a source.
async fn import_record(env: &Env, source_id: &str) -> (String, Option<String>) {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT r.sha256, a.value FROM m3u_raw r
                 LEFT JOIN app_state a ON a.key = 'm3u_import_version:' || r.source_id
                 WHERE r.source_id = ?1",
                params![sid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .await
        .unwrap()
}

/// Stores a sha no import of this version writes, as an older version's
/// import did: the next import rewrites the catalog.
const STALE_SHA: &str = "UPDATE m3u_raw SET sha256 = 'v2' WHERE source_id = ?1";

/// Runs `sql` with the source id as `?1`.
async fn exec_one(env: &Env, sql: &'static str, source_id: &str) {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            c.execute(sql, params![sid])?;
            Ok(())
        })
        .await
        .unwrap();
}

/// The sources the startup pass re-imported (none may fail).
async fn startup_refreshed(env: &Env) -> Vec<String> {
    let r = schedule::startup(&env.state, &schedule::SystemClock, Duration::ZERO).await;
    assert!(r.failed.is_empty(), "{r:?}");
    r.refreshed
}

/// FW-M3U-SERIES-MIGRATION: the startup pass re-imports, once, an M3U
/// source whose catalog an older import version wrote, pasted text with
/// auto-refresh off included, and one whose version was never recorded.
#[tokio::test]
async fn startup_re_imports_catalogs_an_older_import_version_wrote() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", PLAYLIST).await;
    let sha = playlist_sha(PLAYLIST.as_bytes());
    let recorded = (sha.clone(), Some(IMPORT_VERSION.to_string()));
    assert_eq!(import_record(&env, &src.id).await, recorded);
    assert!(startup_refreshed(&env).await.is_empty(), "nothing to do");

    // What an import before series grouping left: version 2, its own sha.
    for sql in [
        "UPDATE app_state SET value = '2' WHERE key = 'm3u_import_version:' || ?1",
        STALE_SHA,
        "UPDATE sources SET auto_refresh = 0 WHERE id = ?1",
    ] {
        exec_one(&env, sql, &src.id).await;
    }
    assert_eq!(startup_refreshed(&env).await, [src.id.clone()]);
    // Re-imported from the stored text: this version's sha and record.
    assert_eq!(import_record(&env, &src.id).await, recorded);
    let (_, detail) = dark(&env, &src.id).await;
    assert_eq!(detail["seasons"].as_array().unwrap().len(), 2);
    assert!(startup_refreshed(&env).await.is_empty(), "only once");

    // A build that recorded no version: one re-import, which finds the text
    // unchanged and records the version.
    let forget = "DELETE FROM app_state WHERE key = 'm3u_import_version:' || ?1";
    exec_one(&env, forget, &src.id).await;
    assert_eq!(import_record(&env, &src.id).await, (sha, None));
    assert_eq!(startup_refreshed(&env).await, [src.id.clone()]);
    assert_eq!(import_record(&env, &src.id).await, recorded);

    // Removing the source drops the record.
    sources::remove(&env.state, &src.id).await.unwrap();
    let left: i64 = env
        .state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM app_state WHERE key LIKE 'm3u_import_version:%'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(left, 0);
}

const PIN: &str = "2468";

const GROUPS: &str = "#EXTM3U\n\
#EXTINF:-1 group-title=\"Kids\",Bluey S01E01\nhttp://h:8080/series/u/p/9001.mp4\n\
#EXTINF:-1 group-title=\"Kids\",Bluey S01E02\nhttp://h:8080/series/u/p/9002.mp4\n\
#EXTINF:-1 group-title=\"Docs\",Planet Earth S01E01\nhttp://h:8080/series/u/p/9101.mp4\n\
#EXTINF:-1 group-title=\"Action\",Heat (1995)\nhttp://h:8080/movie/u/p/1001.mkv\n";

/// `parental.setLocked` args for the category lock on group `group`.
fn group_lock(source_id: &str, content_type: &str, group: &str, locked: bool) -> Value {
    json!({
        "target": {
            "sourceId": source_id,
            "contentType": content_type,
            "kind": "category",
            "targetId": group,
            "name": "Kids",
        },
        "locked": locked,
        "pin": PIN,
    })
}

/// `(category_id, hidden)` of the source's series categories, by id.
async fn series_categories(env: &Env, source_id: &str) -> Vec<(String, i64)> {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            let mut st = c.prepare(
                "SELECT category_id, hidden FROM categories
                 WHERE source_id = ?1 AND content_type = 'series' ORDER BY category_id",
            )?;
            let rows = st
                .query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

/// `(content_type, target_id)` of the source's parental category locks.
async fn category_locks(env: &Env, source_id: &str) -> Vec<(String, String)> {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            let mut st = c.prepare(
                "SELECT content_type, target_id FROM parental_locks
                 WHERE source_id = ?1 AND kind = 'category' ORDER BY content_type",
            )?;
            let rows = st
                .query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

/// FW-M3U-SERIES-PARENTAL: the import that groups a movie group's episodes
/// into a series category gives that category the group's parental lock and
/// hidden flag, so a locked show stays hidden. Later imports keep what the
/// user set on the series group.
#[tokio::test]
async fn a_movie_group_lock_and_hidden_flag_follow_its_episodes_into_series() {
    let env = env().await;
    let src = add_text(&env.state, "Plus", GROUPS).await;
    let kids = iptv_core::m3u::group_id("Kids");
    let docs = iptv_core::m3u::group_id("Docs");

    // The catalog an import before grouping left: both groups were movie
    // categories (Docs hidden, Kids locked) and no series existed.
    for sql in [
        "DELETE FROM items WHERE source_id = ?1 AND content_type = 'series'",
        "DELETE FROM categories WHERE source_id = ?1 AND content_type = 'series'",
        STALE_SHA,
    ] {
        exec_one(&env, sql, &src.id).await;
    }
    let (sid, k, d) = (src.id.clone(), kids.clone(), docs.clone());
    env.state
        .db_call(move |c| {
            for (id, name, hidden) in [(k, "Kids", 0), (d, "Docs", 1)] {
                c.execute(
                    "INSERT INTO categories (source_id, content_type, category_id, name, hidden, position, item_count)
                     VALUES (?1, 'movie', ?2, ?3, ?4, 9, 0)",
                    params![sid, id, name, hidden],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let lock = group_lock(&src.id, "movie", &kids, true);
    call(&env, "parental.setLocked", lock).await;
    sources::refresh(env.state.clone(), &src.id).await.unwrap();

    let mut want = [(docs, 1), (kids.clone(), 0)];
    want.sort();
    assert_eq!(series_categories(&env, &src.id).await, want);
    let movie_lock = ("movie".to_string(), kids.clone());
    let series_lock = ("series".to_string(), kids.clone());
    assert_eq!(
        category_locks(&env, &src.id).await,
        [movie_lock.clone(), series_lock]
    );

    // Docs is hidden; Kids is listed until a PIN makes its lock count.
    let page = call(&env, "catalog.series", json!({ "sourceId": src.id })).await;
    assert_eq!(page["total"], 1, "{page}");
    assert_eq!(page["items"][0]["title"], "Bluey");
    let bluey = page["items"][0]["ref"].clone();
    call(&env, "parental.setPin", json!({ "newPin": PIN })).await;
    let page = call(&env, "catalog.series", json!({ "sourceId": src.id })).await;
    assert_eq!(page["total"], 0, "{page}");
    let err = build_router()
        .dispatch(
            env.state.clone(),
            "m3u.seriesDetail",
            json!({ "ref": bluey }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::NotFound);

    // The user unlocks and shows the series groups again; the next import
    // keeps that, although the movie lock is still there.
    let unlock = group_lock(&src.id, "series", &kids, false);
    call(&env, "parental.setLocked", unlock).await;
    let show = json!({ "sourceId": src.id, "contentType": "series", "hiddenIds": [] });
    call(&env, "catalog.setCategoriesHidden", show).await;
    exec_one(&env, STALE_SHA, &src.id).await;
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    let shown: Vec<(String, i64)> = want.into_iter().map(|(id, _)| (id, 0)).collect();
    assert_eq!(series_categories(&env, &src.id).await, shown);
    assert_eq!(category_locks(&env, &src.id).await, [movie_lock]);
}
