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
