//! `favorites.*`, `recent.*`, `positions.*` through the router.

use iptv_core::error::RpcErrorCode;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::userstate::rpc::register(&mut r);
    r
}

async fn app() -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(64);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    for id in ["s1", "s2"] {
        let id = id.to_string();
        state
            .db_call(move |c| {
                c.execute(
                    "INSERT INTO sources(id, kind, name, position, created_at, config_json)
                     VALUES (?1, 'xtream', ?1, 0, CURRENT_TIMESTAMP, '{}')",
                    [&id],
                )?;
                c.execute(
                    "INSERT INTO categories(source_id, content_type, category_id, name) VALUES (?1, 'series', '20', 'Drama')",
                    [&id],
                )?;
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, poster_url)
                     VALUES (?1, 'series', '301', '20', 'Catalog Show', 'http://img/301.jpg')",
                    params![id],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }
    (dir, state)
}

async fn call(r: &RpcRouter, s: &Arc<AppState>, cmd: &str, args: Value) -> Value {
    r.dispatch(s.clone(), cmd, args)
        .await
        .unwrap_or_else(|e| panic!("{cmd} failed: {}", e.message))
}

fn rf(source: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": source, "contentType": ct, "itemId": id})
}

fn snap(title: &str, ct: &str) -> Value {
    json!({"title": title, "contentType": ct})
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|f| f["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn registers_every_command() {
    let r = router();
    for name in [
        "favorites.list",
        "favorites.toggle",
        "favorites.contains",
        "favorites.reorder",
        "favorites.remove",
        "recent.list",
        "recent.add",
        "recent.remove",
        "recent.clear",
        "positions.get",
        "positions.set",
        "positions.forSeries",
        "positions.continueWatching",
        "positions.remove",
        "userstate.setWatched",
    ] {
        assert!(r.contains(name), "{name} not registered");
    }
}

#[tokio::test]
async fn favorites_toggle_reorder_contains() {
    let (_d, s) = app().await;
    let r = router();
    for id in ["a", "b", "c"] {
        let v = call(
            &r,
            &s,
            "favorites.toggle",
            json!({"ref": rf("s1", "live", id), "snapshot": snap(id, "live")}),
        )
        .await;
        assert_eq!(v, json!({"isFavorite": true}));
    }
    call(
        &r,
        &s,
        "favorites.toggle",
        json!({"ref": rf("s2", "movie", "m"), "snapshot": snap("m", "movie")}),
    )
    .await;

    let list = call(&r, &s, "favorites.list", json!({"sourceId": "s1"})).await;
    assert_eq!(ids(&list), ["a", "b", "c"]);
    assert_eq!(list[0]["snapshot"]["title"], "a");
    assert!(list[0]["addedAt"].is_string());
    assert_eq!(
        call(&r, &s, "favorites.list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        4
    );

    call(
        &r,
        &s,
        "favorites.reorder",
        json!({"sourceId": "s1", "refs": [rf("s1", "live", "c"), rf("s1", "live", "a")]}),
    )
    .await;
    let list = call(&r, &s, "favorites.list", json!({"sourceId": "s1"})).await;
    assert_eq!(ids(&list), ["c", "a", "b"]);

    let got = call(
        &r,
        &s,
        "favorites.contains",
        json!({"refs": [rf("s1", "live", "b"), rf("s1", "live", "zzz"), rf("s2", "movie", "m")]}),
    )
    .await;
    assert_eq!(got, json!([rf("s1", "live", "b"), rf("s2", "movie", "m")]));

    let v = call(
        &r,
        &s,
        "favorites.toggle",
        json!({"ref": rf("s1", "live", "b"), "snapshot": snap("b", "live")}),
    )
    .await;
    assert_eq!(v, json!({"isFavorite": false}));
    call(
        &r,
        &s,
        "favorites.remove",
        json!({"ref": rf("s1", "live", "a")}),
    )
    .await;
    let list = call(&r, &s, "favorites.list", json!({"sourceId": "s1"})).await;
    assert_eq!(ids(&list), ["c"]);

    // Unknown source is NotFound, not a crash.
    let err = r
        .dispatch(
            s.clone(),
            "favorites.toggle",
            json!({"ref": rf("nope", "live", "x"), "snapshot": snap("x", "live")}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);

    // Deleting a source cascades.
    s.db_call(|c| Ok(c.execute("DELETE FROM sources WHERE id = 's2'", [])?))
        .await
        .unwrap();
    assert_eq!(
        call(&r, &s, "favorites.list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn recent_is_newest_first_and_capped() {
    let (_d, s) = app().await;
    let r = router();
    for i in 0..205 {
        let id = format!("c{i}");
        call(
            &r,
            &s,
            "recent.add",
            json!({"ref": rf("s1", "live", &id), "snapshot": snap(&id, "live")}),
        )
        .await;
    }
    call(
        &r,
        &s,
        "recent.add",
        json!({"ref": rf("s2", "live", "x"), "snapshot": snap("x", "live")}),
    )
    .await;
    let count: i64 = s
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM recent WHERE source_id = 's1'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 200);

    let list = call(&r, &s, "recent.list", json!({"sourceId": "s1", "limit": 3})).await;
    assert_eq!(ids(&list), ["c204", "c203", "c202"]);

    // Re-adding moves an entry to the top and refreshes its snapshot.
    call(
        &r,
        &s,
        "recent.add",
        json!({"ref": rf("s1", "live", "c100"), "snapshot": snap("c100 renamed", "live")}),
    )
    .await;
    let list = call(&r, &s, "recent.list", json!({"sourceId": "s1", "limit": 1})).await;
    assert_eq!(list[0]["ref"]["itemId"], "c100");
    assert_eq!(list[0]["snapshot"]["title"], "c100 renamed");
    assert!(list[0]["viewedAt"].is_string());

    call(
        &r,
        &s,
        "recent.remove",
        json!({"ref": rf("s1", "live", "c100")}),
    )
    .await;
    let list = call(&r, &s, "recent.list", json!({"sourceId": "s1", "limit": 1})).await;
    assert_eq!(list[0]["ref"]["itemId"], "c204");

    call(&r, &s, "recent.clear", json!({"sourceId": "s1"})).await;
    assert!(call(&r, &s, "recent.list", json!({"sourceId": "s1"}))
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        call(&r, &s, "recent.list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&r, &s, "recent.clear", Value::Null).await;
    assert!(call(&r, &s, "recent.list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn positions_complete_series_and_continue_watching() {
    let (_d, s) = app().await;
    let r = router();
    let movie = rf("s1", "movie", "201");
    call(&r, &s, "positions.set", json!({"ref": movie, "positionSeconds": 120.7, "durationSeconds": 6000, "snapshot": snap("Movie", "movie")})).await;
    let got = call(&r, &s, "positions.get", json!({"ref": movie})).await;
    assert_eq!(got["positionSeconds"], 120);
    assert_eq!(got["durationSeconds"], 6000);
    assert_eq!(got["snapshot"]["title"], "Movie");

    // >= 95 % of the duration deletes the row.
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 5700, "durationSeconds": 6000}),
    )
    .await;
    assert_eq!(
        call(&r, &s, "positions.get", json!({"ref": movie})).await,
        Value::Null
    );

    // Series: one row per episode.
    let show = rf("s1", "series", "301");
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": show, "episodeId": "3001", "positionSeconds": 10, "durationSeconds": 1000}),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": show, "episodeId": "3002", "positionSeconds": 20, "durationSeconds": 1000}),
    )
    .await;
    let eps = call(&r, &s, "positions.forSeries", json!({"ref": show})).await;
    assert_eq!(eps.as_array().unwrap().len(), 2);
    let ep = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "3002"}),
    )
    .await;
    assert_eq!(ep["positionSeconds"], 20);
    assert_eq!(ep["episodeId"], "3002");

    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let other = rf("s2", "movie", "202");
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": other, "positionSeconds": 30, "snapshot": snap("Other", "movie")}),
    )
    .await;

    // Newest first, one row per item, each with a snapshot (catalog fallback for the series).
    let cw = call(&r, &s, "positions.continueWatching", Value::Null).await;
    let rows = cw.as_array().unwrap();
    assert_eq!(rows.len(), 2, "{cw}");
    assert_eq!(rows[0]["ref"], other);
    assert_eq!(rows[1]["ref"], show);
    assert_eq!(rows[1]["episodeId"], "3002");
    assert_eq!(rows[1]["snapshot"]["title"], "Catalog Show");
    assert!(rows.iter().all(|r| r["snapshot"].is_object()));
    let one = call(&r, &s, "positions.continueWatching", json!({"limit": 1})).await;
    assert_eq!(one.as_array().unwrap().len(), 1);

    call(
        &r,
        &s,
        "positions.remove",
        json!({"ref": show, "episodeId": "3002"}),
    )
    .await;
    assert_eq!(
        call(&r, &s, "positions.forSeries", json!({"ref": show}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let err = r
        .dispatch(
            s.clone(),
            "positions.set",
            json!({"ref": movie, "positionSeconds": "x"}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
}

#[tokio::test]
async fn set_watched_marks_clears_and_hides_from_continue_watching() {
    let (_d, s) = app().await;
    let r = router();
    let show = rf("s1", "series", "301");
    let movie = rf("s1", "movie", "201");

    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": show, "episodeId": "e1", "positionSeconds": 120, "durationSeconds": 1500}),
    )
    .await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 60, "durationSeconds": 6000}),
    )
    .await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(cw.as_array().unwrap().len(), 2);
    assert_eq!(cw[0]["watched"], false);

    // Mark the episode watched: position jumps to the duration, card disappears.
    call(
        &r,
        &s,
        "userstate.setWatched",
        json!({"ref": show, "episodeId": "e1", "watched": true}),
    )
    .await;
    let p = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e1"}),
    )
    .await;
    assert_eq!(p["watched"], true);
    assert_eq!(p["positionSeconds"], 1500);
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(ids(&cw), vec!["201"]);

    // An episode without any row yet: inserted as watched.
    call(
        &r,
        &s,
        "userstate.setWatched",
        json!({"ref": show, "episodeId": "e2", "watched": true}),
    )
    .await;
    let series = call(&r, &s, "positions.forSeries", json!({"ref": show})).await;
    let watched: Vec<bool> = series
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["watched"].as_bool().unwrap())
        .collect();
    assert_eq!(watched, vec![true, true]);

    // Progress reported later keeps the flag; finishing does not drop the row.
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": show, "episodeId": "e1", "positionSeconds": 1490, "durationSeconds": 1500}),
    )
    .await;
    let p = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e1"}),
    )
    .await;
    assert_eq!(p["watched"], true);

    // Unwatched clears the row.
    call(
        &r,
        &s,
        "userstate.setWatched",
        json!({"ref": show, "episodeId": "e1", "watched": false}),
    )
    .await;
    let p = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e1"}),
    )
    .await;
    assert!(p.is_null());

    // Item-level (movie) mark; unknown source is NotFound.
    call(
        &r,
        &s,
        "userstate.setWatched",
        json!({"ref": movie, "watched": true}),
    )
    .await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert!(cw.as_array().unwrap().is_empty());
    let err = r
        .dispatch(
            s.clone(),
            "userstate.setWatched",
            json!({"ref": rf("nope", "movie", "1"), "watched": true}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
}

/// B9: a save without a duration (the player has none) still completes the
/// item against the duration stored earlier, and absurd positions are refused.
#[tokio::test]
async fn completion_uses_the_stored_duration_and_positions_are_bounded() {
    let (_d, s) = app().await;
    let r = router();
    let movie = rf("s1", "movie", "202");
    call(&r, &s, "positions.set", json!({"ref": movie, "positionSeconds": 100, "durationSeconds": 3600, "snapshot": snap("M", "movie")})).await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 3500}),
    )
    .await;
    assert_eq!(
        call(&r, &s, "positions.get", json!({"ref": movie})).await,
        Value::Null,
        "97% of the stored duration is complete"
    );
    // Not complete yet: the stored duration is kept.
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 100, "durationSeconds": 3600}),
    )
    .await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 200}),
    )
    .await;
    let got = call(&r, &s, "positions.get", json!({"ref": movie})).await;
    assert_eq!(got["positionSeconds"], 200);
    assert_eq!(got["durationSeconds"], 3600);

    for bad in [
        json!({"ref": movie, "positionSeconds": 1e300}),
        json!({"ref": movie, "positionSeconds": 10, "durationSeconds": 1e12}),
    ] {
        let e = r
            .dispatch(s.clone(), "positions.set", bad)
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::Invalid, "{e:?}");
    }
}

/// B9: a ref listed twice keeps its first place; concurrent toggles of one
/// ref never fail on the unique key.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reorder_with_duplicates_and_concurrent_toggles() {
    let (_d, s) = app().await;
    let r = router();
    for id in ["a", "b", "c"] {
        call(
            &r,
            &s,
            "favorites.toggle",
            json!({"ref": rf("s1", "live", id), "snapshot": snap(id, "live")}),
        )
        .await;
    }
    call(
        &r,
        &s,
        "favorites.reorder",
        json!({"refs": [rf("s1", "live", "c"), rf("s1", "live", "a"), rf("s1", "live", "c")]}),
    )
    .await;
    let list = call(&r, &s, "favorites.list", json!({})).await;
    assert_eq!(ids(&list), ["c", "a", "b"]);
    let positions: Vec<i64> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["position"].as_i64().unwrap_or(-1))
        .collect();
    if positions.iter().all(|p| *p >= 0) {
        assert_eq!(positions, [0, 1, 2], "no gaps");
    }

    let mut tasks = Vec::new();
    for _ in 0..16 {
        let (r, s) = (r.clone(), s.clone());
        tasks.push(tokio::spawn(async move {
            r.dispatch(
                s,
                "favorites.toggle",
                json!({"ref": rf("s2", "live", "z"), "snapshot": snap("z", "live")}),
            )
            .await
        }));
    }
    for t in tasks {
        let res = t.await.unwrap();
        assert!(res.is_ok(), "{:?}", res.err());
    }
}

/// C13 (B6 review round 1): the reviewer's repro. Removing a series card
/// clears every unfinished episode, and finishing a later episode never
/// brings an older half-watched one back.
#[tokio::test]
async fn continue_watching_follows_the_newest_episode_and_card_removal_clears_the_series() {
    let (_d, s) = app().await;
    let r = router();
    let show = rf("s1", "series", "301");
    let set = |ep: &str, pos: i64| json!({"ref": show, "episodeId": ep, "positionSeconds": pos, "durationSeconds": 1000});
    let card = |cw: &Value| {
        cw.as_array()
            .unwrap()
            .iter()
            .find(|p| p["ref"]["itemId"] == "301")
            .map(|p| {
                format!(
                    "{}@{}",
                    p["episodeId"].as_str().unwrap(),
                    p["positionSeconds"]
                )
            })
    };

    call(&r, &s, "positions.set", set("e1", 300)).await;
    call(&r, &s, "positions.set", set("e2", 120)).await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(card(&cw).as_deref(), Some("e2@120"));

    // Removing the card removes the whole series, not just e2.
    call(
        &r,
        &s,
        "positions.remove",
        json!({"ref": show, "allEpisodes": true}),
    )
    .await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(card(&cw), None, "after remove: {cw}");

    // e1 half-watched, then e3 finished: the series is done, e1 does not resurface.
    call(&r, &s, "positions.set", set("e1", 300)).await;
    call(&r, &s, "positions.set", set("e3", 990)).await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(card(&cw), None, "after e3 done: {cw}");
    let e3 = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e3"}),
    )
    .await;
    assert_eq!(e3["watched"], true);

    // Starting e4 brings the card back on e4.
    call(&r, &s, "positions.set", set("e4", 60)).await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(card(&cw).as_deref(), Some("e4@60"));

    // allEpisodes keeps watched rows: e3 stays, e1 and e4 go.
    call(
        &r,
        &s,
        "positions.remove",
        json!({"ref": show, "allEpisodes": true}),
    )
    .await;
    let left = call(&r, &s, "positions.forSeries", json!({"ref": show})).await;
    let eps: Vec<&str> = left
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["episodeId"].as_str().unwrap())
        .collect();
    assert_eq!(eps, ["e3"]);
}

/// B6 review round 1: parallel toggles of one ref serialize, so each pair
/// ends where it started and the two calls report opposite states.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_toggle_pairs_report_opposite_states() {
    let (_d, s) = app().await;
    let r = router();
    for i in 0..40 {
        let target = rf("s1", "live", &format!("p{i}"));
        let go = |r: RpcRouter, s: Arc<AppState>, target: Value| {
            tokio::spawn(async move {
                r.dispatch(
                    s,
                    "favorites.toggle",
                    json!({"ref": target, "snapshot": snap("p", "live")}),
                )
                .await
                .unwrap()["isFavorite"]
                    .as_bool()
                    .unwrap()
            })
        };
        let a = go(r.clone(), s.clone(), target.clone());
        let b = go(r.clone(), s.clone(), target.clone());
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        assert_ne!(a, b, "pair {i}: both calls returned {a}");
        let on = call(&r, &s, "favorites.contains", json!({"refs": [target]})).await;
        assert!(on.as_array().unwrap().is_empty(), "pair {i} should end off");
    }
}

fn card_of(cw: &Value, item: &str) -> Option<String> {
    cw.as_array()
        .unwrap()
        .iter()
        .find(|p| p["ref"]["itemId"] == item)
        .map(|p| {
            format!(
                "{}@{}",
                p["episodeId"].as_str().unwrap_or(""),
                p["positionSeconds"]
            )
        })
}

/// B6 round 2: rewatching a finished episode is the series' place to resume;
/// it must not hide the series (watched used to stick on a partial save).
#[tokio::test]
async fn rewatching_a_finished_episode_keeps_the_series_in_continue_watching() {
    let (_d, s) = app().await;
    let r = router();
    let show = rf("s1", "series", "301");
    let set = |ep: &str, pos: i64| json!({"ref": show, "episodeId": ep, "positionSeconds": pos, "durationSeconds": 1000});
    call(&r, &s, "positions.set", set("e2", 990)).await;
    call(&r, &s, "positions.set", set("e3", 200)).await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(card_of(&cw, "301").as_deref(), Some("e3@200"));

    call(&r, &s, "positions.set", set("e2", 100)).await;
    let e2 = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e2"}),
    )
    .await;
    assert_eq!(e2["watched"], false, "a partial save clears watched");
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(card_of(&cw, "301").as_deref(), Some("e2@100"));
}

/// B6 round 2 (C14): a dated save keeps its time, so an undo puts cards back
/// in their old order; a bad date is refused.
#[tokio::test]
async fn dated_saves_keep_their_time_and_order() {
    let (_d, s) = app().await;
    let r = router();
    let a = rf("s1", "movie", "a");
    let b = rf("s1", "movie", "b");
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": a, "positionSeconds": 60, "updatedAt": "2026-10-01T10:00:00Z"}),
    )
    .await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": b, "positionSeconds": 60, "updatedAt": "2026-10-01T09:00:00Z"}),
    )
    .await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(ids(&cw), ["a", "b"], "a is newer although written first");
    assert_eq!(cw[0]["updatedAt"], "2026-10-01T10:00:00.000Z");

    let e = r
        .dispatch(
            s.clone(),
            "positions.set",
            json!({"ref": a, "positionSeconds": 60, "updatedAt": "yesterday"}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
}

/// B6 round 2: a dated write (Merge import of an older backup) never rolls
/// back newer progress, neither by overwriting nor by deleting.
#[tokio::test]
async fn an_older_dated_write_does_not_roll_back_newer_progress() {
    let (_d, s) = app().await;
    let r = router();
    let movie = rf("s1", "movie", "m");
    let show = rf("s1", "series", "301");
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 1800, "durationSeconds": 6000}),
    )
    .await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": show, "episodeId": "e1", "positionSeconds": 500, "durationSeconds": 1000}),
    )
    .await;

    // Older: partial, finished movie (would delete), finished episode (would mark watched).
    let old = "2020-01-01T00:00:00Z";
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 60, "updatedAt": old}),
    )
    .await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 5990, "durationSeconds": 6000, "updatedAt": old}),
    )
    .await;
    call(&r, &s, "positions.set", json!({"ref": show, "episodeId": "e1", "positionSeconds": 990, "durationSeconds": 1000, "updatedAt": old})).await;
    let m = call(&r, &s, "positions.get", json!({"ref": movie})).await;
    assert_eq!(m["positionSeconds"], 1800);
    let e1 = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e1"}),
    )
    .await;
    assert_eq!(
        (e1["positionSeconds"].as_i64(), e1["watched"].as_bool()),
        (Some(500), Some(false))
    );

    // Newer dated write does apply.
    let newer = (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": movie, "positionSeconds": 2400, "updatedAt": newer}),
    )
    .await;
    let m = call(&r, &s, "positions.get", json!({"ref": movie})).await;
    assert_eq!(m["positionSeconds"], 2400);
}

/// B6 round 2: positions the player would not resume from (<= 5 s) are not offered.
#[tokio::test]
async fn continue_watching_skips_positions_the_player_would_not_resume() {
    let (_d, s) = app().await;
    let r = router();
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": rf("s1", "movie", "five"), "positionSeconds": 5}),
    )
    .await;
    call(
        &r,
        &s,
        "positions.set",
        json!({"ref": rf("s1", "movie", "six"), "positionSeconds": 6}),
    )
    .await;
    let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
    assert_eq!(ids(&cw), ["six"]);
}

/// B6 round 3: the player's first tick (a save at 1-5 s) on a finished
/// episode keeps it watched, and the newest row still stands for the series,
/// so Continue Watching never falls back to an older half-watched episode.
#[tokio::test]
async fn a_short_rewatch_save_never_brings_back_an_older_episode() {
    let (_d, s) = app().await;
    let r = router();
    let show = rf("s1", "series", "301");
    let set = |ep: &str, pos: i64| json!({"ref": show, "episodeId": ep, "positionSeconds": pos, "durationSeconds": 1200});
    let cw_card = || async {
        let cw = call(&r, &s, "positions.continueWatching", json!({"limit": 10})).await;
        card_of(&cw, "301")
    };
    call(&r, &s, "positions.set", set("e1", 600)).await;
    call(&r, &s, "positions.set", set("e2", 1190)).await;
    assert_eq!(cw_card().await, None);

    // Replay e2: the 5 s tick saves at 4 s.
    call(&r, &s, "positions.set", set("e2", 4)).await;
    let e2 = call(
        &r,
        &s,
        "positions.get",
        json!({"ref": show, "episodeId": "e2"}),
    )
    .await;
    assert_eq!(e2["watched"], true, "a save at or below 5 s keeps watched");
    assert_eq!(cw_card().await, None, "e1 must not resurface");

    // Past the first tick it is a real rewatch.
    call(&r, &s, "positions.set", set("e2", 30)).await;
    assert_eq!(cw_card().await.as_deref(), Some("e2@30"));

    // A newly started episode (3 s, unwatched) also stands for the series.
    call(&r, &s, "positions.set", set("e2", 1190)).await;
    call(&r, &s, "positions.set", set("e3", 3)).await;
    assert_eq!(cw_card().await, None, "e1 must not resurface");
}

/// B6 round 3: a far-future `updatedAt` names the field it came from.
#[tokio::test]
async fn a_future_updated_at_names_updated_at() {
    let (_d, s) = app().await;
    let r = router();
    let e = r
        .dispatch(
            s.clone(),
            "positions.set",
            json!({"ref": rf("s1", "movie", "a"), "positionSeconds": 60, "updatedAt": "2999-01-01T00:00:00Z"}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
    assert_eq!(e.message, "updatedAt is in the future");
    let e = r
        .dispatch(
            s.clone(),
            "positions.set",
            json!({"ref": rf("s1", "movie", "a"), "positionSeconds": 60, "updatedAt": "soon"}),
        )
        .await
        .unwrap_err();
    assert!(e.message.starts_with("updatedAt must be"), "{}", e.message);
}

/// B6 round 3: Undo of Mark unwatched puts a watched row back as watched,
/// with its original time, for a movie and for an episode.
#[tokio::test]
async fn a_restored_watched_row_stays_watched_with_its_time() {
    let (_d, s) = app().await;
    let r = router();
    let at = "2026-10-01T10:00:00Z";
    for (item, ep) in [
        (rf("s1", "movie", "m"), None),
        (rf("s1", "series", "301"), Some("e1")),
    ] {
        let mut args = json!({"ref": item, "positionSeconds": 6000, "durationSeconds": 6000, "updatedAt": at, "watched": true});
        let mut get = json!({"ref": item});
        if let Some(e) = ep {
            args["episodeId"] = json!(e);
            get["episodeId"] = json!(e);
        }
        call(&r, &s, "positions.set", args).await;
        let row = call(&r, &s, "positions.get", get).await;
        assert_eq!(row["watched"], true, "{ep:?}");
        assert_eq!(row["updatedAt"], "2026-10-01T10:00:00.000Z", "{ep:?}");
    }
}
