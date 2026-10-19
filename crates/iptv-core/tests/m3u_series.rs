//! F-M3U-SERIES: an m3u_plus playlist's episodes import as series with
//! seasons (`catalog.series`, `m3u.seriesDetail`, `m3u.streamUrl`), the
//! series' watched mark follows its episodes, and state that earlier imports
//! saved on episodes stored as movies moves to the series.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::rpc::build_router;
use iptv_core::sources;
use rusqlite::params;
use serde_json::{json, Value};
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
        .dispatch(env.state.clone(), "m3u.streamUrl", json!({ "ref": series_ref }))
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
    let v = call(env, "positions.watchedContains", json!({ "refs": [series_ref] })).await;
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
    assert!(series_watched(&env, &series_ref).await, "every stored episode is watched");
    call(
        &env,
        "userstate.setWatched",
        json!({ "ref": series_ref, "episodeId": ids[0], "watched": false }),
    )
    .await;
    assert!(!series_watched(&env, &series_ref).await, "unmarking an episode clears the series");
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
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
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
        (positions[1].0.as_str(), positions[1].2.as_str(), positions[1].3),
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
