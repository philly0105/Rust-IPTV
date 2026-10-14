//! My List (`watchlist.*`, contract C3) through the full router: ordering,
//! validation, watched state, events, source removal, and the backup round
//! trip through `export_entries` / `import_entries`.

use iptv_core::error::RpcErrorCode;
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::watchlist::{
    export_entries, import_entries, WatchlistBackupEntry, CHANGED_EVENT, MAX_REFS,
};
use iptv_core::{AppEvent, AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    events: Receiver<AppEvent>,
}

/// A fresh app with sources `s1` and `s2`; each has movie `201` in its
/// catalog with a poster, so the catalog fallback can be checked.
async fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(256);
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
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, poster_url)
                     VALUES (?1, 'movie', '201', '10', 'Black Harbor', 'http://img/201.jpg')",
                    params![id],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }
    App {
        _dir: dir,
        state,
        router: build_router(),
        events,
    }
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {}", e.message))
    }

    async fn fail(&self, cmd: &str, args: Value) -> RpcErrorCode {
        match self
            .router
            .dispatch(self.state.clone(), cmd, args.clone())
            .await
        {
            Ok(v) => panic!("{cmd} {args} should fail, got {v}"),
            Err(e) => e.code,
        }
    }

    async fn toggle(&self, r: Value, title: &str) -> bool {
        let ct = r["contentType"].clone();
        let v = self
            .call(
                "watchlist.toggle",
                json!({"ref": r, "snapshot": {"title": title, "contentType": ct}}),
            )
            .await;
        v["inList"].as_bool().expect("toggle answers { inList }")
    }

    async fn list(&self, args: Value) -> Value {
        self.call("watchlist.list", args).await
    }

    async fn ids(&self) -> Vec<String> {
        ids(&self.list(json!({})).await)
    }

    /// `watchlist.changed` events received since the last call.
    fn changes(&mut self) -> usize {
        let mut n = 0;
        while let Ok(e) = self.events.try_recv() {
            if e.kind == CHANGED_EVENT {
                assert_eq!(e.payload, json!({}), "the payload is always {{}}");
                n += 1;
            }
        }
        n
    }

    async fn export(&self) -> Vec<WatchlistBackupEntry> {
        self.state.db_call(|c| export_entries(c)).await.unwrap()
    }

    async fn import(&self, entries: Vec<WatchlistBackupEntry>, replace: bool) -> usize {
        self.state
            .db_call(move |c| import_entries(c, &entries, replace))
            .await
            .unwrap()
    }
}

fn rf(source: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": source, "contentType": ct, "itemId": id})
}

fn movie(id: &str) -> Value {
    rf("s1", "movie", id)
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| e["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn the_full_router_registers_every_command() {
    let r = build_router();
    for cmd in iptv_core::watchlist::rpc::COMMANDS {
        assert!(r.contains(cmd), "{cmd} is not registered");
    }
}

#[tokio::test]
async fn toggle_adds_on_top_and_removes_on_the_second_call() {
    let a = app().await;
    assert_eq!(a.list(json!({})).await, json!([]));
    for id in ["1", "2", "3"] {
        assert!(a.toggle(movie(id), &format!("Movie {id}")).await);
    }
    assert_eq!(a.ids().await, ["3", "2", "1"], "newest add first");

    let list = a.list(json!({})).await;
    let first = &list[0];
    assert_eq!(first["ref"], movie("3"));
    assert_eq!(first["snapshot"]["title"], "Movie 3");
    assert_eq!(first["snapshot"]["contentType"], "movie");
    assert_eq!(first["watched"], false);
    let added = first["addedAt"].as_str().unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(added).is_ok(),
        "addedAt is RFC 3339: {added}"
    );

    assert!(
        !a.toggle(movie("2"), "Movie 2").await,
        "second toggle removes"
    );
    assert_eq!(a.ids().await, ["3", "1"]);
    a.call("watchlist.remove", json!({"ref": movie("3")})).await;
    assert_eq!(a.ids().await, ["1"]);
    // Removing an absent item is fine.
    assert_eq!(
        a.call("watchlist.remove", json!({"ref": movie("3")})).await,
        Value::Null
    );
}

#[tokio::test]
async fn snapshots_are_trimmed_and_fall_back_to_the_catalog_poster() {
    let a = app().await;
    a.call(
        "watchlist.toggle",
        json!({
            "ref": movie("201"),
            "snapshot": {"title": "  Black Harbor ", "subtitle": " ", "contentType": "movie"}
        }),
    )
    .await;
    a.call(
        "watchlist.toggle",
        json!({
            "ref": movie("202"),
            "snapshot": {
                "title": "Own Poster", "subtitle": "2021", "posterUrl": "http://img/own.jpg",
                "contentType": "series"
            }
        }),
    )
    .await;
    let list = a.list(json!({})).await;
    let own = &list[0]["snapshot"];
    assert_eq!(own["title"], "Own Poster");
    assert_eq!(own["subtitle"], "2021");
    assert_eq!(own["posterUrl"], "http://img/own.jpg");
    assert_eq!(own["contentType"], "movie", "the ref decides the type");
    let harbor = &list[1]["snapshot"];
    assert_eq!(harbor["title"], "Black Harbor");
    assert!(
        harbor.get("subtitle").is_none(),
        "a blank subtitle is dropped"
    );
    assert_eq!(
        harbor["posterUrl"], "http://img/201.jpg",
        "no poster in the snapshot: the catalog's is used"
    );
}

#[tokio::test]
async fn list_filters_by_source_and_type() {
    let a = app().await;
    a.toggle(movie("1"), "A").await;
    a.toggle(rf("s1", "series", "9"), "B").await;
    a.toggle(rf("s2", "movie", "1"), "C").await;

    let all = a.list(Value::Null).await;
    assert_eq!(all.as_array().unwrap().len(), 3);
    let s1 = a.list(json!({"sourceId": "s1"})).await;
    assert_eq!(ids(&s1), ["9", "1"]);
    let series = a.list(json!({"contentType": "series"})).await;
    assert_eq!(series[0]["ref"], rf("s1", "series", "9"));
    assert_eq!(series.as_array().unwrap().len(), 1);
    let s2_movies = a
        .list(json!({"sourceId": "s2", "contentType": "movie"}))
        .await;
    assert_eq!(s2_movies[0]["ref"], rf("s2", "movie", "1"));
    assert_eq!(s2_movies.as_array().unwrap().len(), 1);
    assert_eq!(a.list(json!({"sourceId": "nope"})).await, json!([]));
}

#[tokio::test]
async fn invalid_input_uses_the_contract_error_codes() {
    let a = app().await;
    let snap = |ct: &str| json!({"title": "T", "contentType": ct});
    for ct in ["live", "radio"] {
        let r = rf("s1", ct, "7");
        assert_eq!(
            a.fail("watchlist.toggle", json!({"ref": r, "snapshot": snap(ct)}))
                .await,
            RpcErrorCode::Invalid,
            "{ct} refs cannot be added"
        );
        assert_eq!(
            a.fail("watchlist.remove", json!({"ref": r})).await,
            RpcErrorCode::Invalid
        );
        assert_eq!(
            a.fail("watchlist.reorder", json!({"refs": [movie("1"), r]}))
                .await,
            RpcErrorCode::Invalid
        );
        assert_eq!(
            a.fail("watchlist.list", json!({"contentType": ct})).await,
            RpcErrorCode::Invalid
        );
    }
    for (r, s) in [
        (rf("s1", "movie", " "), snap("movie")),
        (rf("", "movie", "7"), snap("movie")),
        (movie("7"), json!({"title": "   ", "contentType": "movie"})),
        (rf("s1", "movie", &"x".repeat(5_000)), snap("movie")),
    ] {
        assert_eq!(
            a.fail("watchlist.toggle", json!({"ref": r, "snapshot": s}))
                .await,
            RpcErrorCode::Invalid
        );
    }
    assert_eq!(
        a.fail(
            "watchlist.toggle",
            json!({"ref": rf("gone", "movie", "1"), "snapshot": snap("movie")})
        )
        .await,
        RpcErrorCode::NotFound,
        "unknown source"
    );
    let too_many: Vec<Value> = (0..=MAX_REFS).map(|i| movie(&i.to_string())).collect();
    assert_eq!(
        a.fail("watchlist.contains", json!({"refs": too_many}))
            .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(
        a.fail("watchlist.reorder", json!({"refs": too_many})).await,
        RpcErrorCode::Invalid
    );
    assert!(a.list(json!({})).await.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn contains_answers_in_input_order_without_duplicates() {
    let a = app().await;
    a.toggle(movie("1"), "A").await;
    a.toggle(rf("s2", "series", "5"), "B").await;
    let got = a
        .call(
            "watchlist.contains",
            json!({"refs": [
                rf("s2", "series", "5"), movie("2"), rf("s1", "live", "1"), movie("1"),
                rf("s2", "series", "5"), rf("s2", "movie", "5")
            ]}),
        )
        .await;
    assert_eq!(got, json!([rf("s2", "series", "5"), movie("1")]));
    assert_eq!(
        a.call("watchlist.contains", json!({"refs": []})).await,
        json!([])
    );
}

#[tokio::test]
async fn reorder_sets_the_order_and_new_adds_stay_on_top() {
    let a = app().await;
    for id in ["1", "2", "3", "4"] {
        a.toggle(movie(id), id).await;
    }
    assert_eq!(a.ids().await, ["4", "3", "2", "1"]);
    a.call(
        "watchlist.reorder",
        json!({"refs": [movie("1"), movie("2"), movie("3"), movie("4")]}),
    )
    .await;
    assert_eq!(a.ids().await, ["1", "2", "3", "4"]);
    // A partial list reorders those within the places they held (2nd and
    // 4th); the others stay put and unknown refs are ignored.
    a.call(
        "watchlist.reorder",
        json!({"refs": [movie("4"), movie("99"), movie("2")]}),
    )
    .await;
    assert_eq!(a.ids().await, ["1", "4", "3", "2"]);
    // Swapping two neighbours needs only those two.
    a.call(
        "watchlist.reorder",
        json!({"refs": [movie("3"), movie("4")]}),
    )
    .await;
    assert_eq!(a.ids().await, ["1", "3", "4", "2"]);
    a.toggle(movie("5"), "5").await;
    assert_eq!(a.ids().await, ["5", "1", "3", "4", "2"]);
    // The order survives a restart of the app state (it lives in SQLite).
    let entries = a.export().await;
    assert_eq!(
        entries
            .iter()
            .map(|e| e.item_id.as_str())
            .collect::<Vec<_>>(),
        ["5", "1", "3", "4", "2"]
    );
    assert_eq!(
        entries.iter().map(|e| e.position).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );
}

#[tokio::test]
async fn watched_comes_from_the_item_level_playback_row() {
    let a = app().await;
    a.toggle(movie("1"), "Movie").await;
    a.toggle(rf("s1", "series", "9"), "Show").await;
    let watched = |list: &Value, id: &str| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|e| e["ref"]["itemId"] == id)
            .unwrap()["watched"]
            .as_bool()
            .unwrap()
    };

    a.call(
        "userstate.setWatched",
        json!({"ref": movie("1"), "watched": true}),
    )
    .await;
    // One watched episode does not make the series watched.
    a.call(
        "userstate.setWatched",
        json!({"ref": rf("s1", "series", "9"), "episodeId": "e1", "watched": true}),
    )
    .await;
    let list = a.list(json!({})).await;
    assert!(watched(&list, "1"));
    assert!(!watched(&list, "9"));

    // A half-watched movie is not watched.
    a.call(
        "userstate.setWatched",
        json!({"ref": movie("1"), "watched": false}),
    )
    .await;
    a.call(
        "positions.set",
        json!({"ref": movie("1"), "positionSeconds": 600, "durationSeconds": 6000}),
    )
    .await;
    // Marking the whole series watched does.
    a.call(
        "userstate.setWatched",
        json!({"ref": rf("s1", "series", "9"), "watched": true}),
    )
    .await;
    let list = a.list(json!({})).await;
    assert!(!watched(&list, "1"));
    assert!(watched(&list, "9"));
}

#[tokio::test]
async fn every_write_emits_watchlist_changed() {
    let mut a = app().await;
    a.changes();
    a.toggle(movie("1"), "A").await;
    assert_eq!(a.changes(), 1, "add");
    a.toggle(movie("2"), "B").await;
    a.call(
        "watchlist.reorder",
        json!({"refs": [movie("1"), movie("2")]}),
    )
    .await;
    assert_eq!(a.changes(), 2, "add + reorder");
    a.toggle(movie("2"), "B").await;
    assert_eq!(a.changes(), 1, "remove by toggle");
    a.call("watchlist.remove", json!({"ref": movie("1")})).await;
    assert_eq!(a.changes(), 1, "remove");
    a.call("watchlist.remove", json!({"ref": movie("1")})).await;
    assert_eq!(a.changes(), 0, "removing an absent item changes nothing");
    a.list(json!({})).await;
    a.call("watchlist.contains", json!({"refs": [movie("1")]}))
        .await;
    assert_eq!(a.changes(), 0, "reads emit nothing");
    let _ = a
        .fail(
            "watchlist.toggle",
            json!({"ref": rf("s1", "live", "1"), "snapshot": {"title": "x", "contentType": "live"}}),
        )
        .await;
    assert_eq!(a.changes(), 0, "a rejected write emits nothing");
}

#[tokio::test]
async fn concurrent_toggles_of_one_item_serialize() {
    let a = app().await;
    let calls = (0..6).map(|_| a.toggle(movie("1"), "A"));
    let results = futures::future::join_all(calls).await;
    let on = results.iter().filter(|r| **r).count();
    assert_eq!(on, 3, "toggles alternate: {results:?}");
    assert!(
        a.ids().await.is_empty(),
        "an even number of toggles ends absent"
    );
}

#[tokio::test]
async fn removing_a_source_removes_its_entries() {
    let a = app().await;
    a.toggle(movie("1"), "A").await;
    a.toggle(rf("s2", "movie", "1"), "B").await;
    a.toggle(rf("s1", "series", "3"), "C").await;
    a.call("sources.remove", json!({"id": "s1"})).await;
    let list = a.list(json!({})).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["ref"], rf("s2", "movie", "1"));
    let left: i64 = a
        .state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM watchlist WHERE source_id = 's1'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(left, 0);
}

/// The My List page sends the order it shows; in hide mode that leaves the
/// locked titles out, and they must keep their places rather than drop to
/// the end.
#[tokio::test]
async fn reordering_in_hide_mode_keeps_hidden_titles_in_place() {
    let a = app().await;
    for id in ["5", "4", "1", "3"] {
        a.toggle(movie(id), id).await;
    }
    assert_eq!(a.ids().await, ["3", "1", "4", "5"]);
    a.call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "movie", "kind": "item", "targetId": "1", "name": "One"}, "locked": true}),
    )
    .await;
    a.call("parental.setPin", json!({"newPin": "2468"})).await;
    assert_eq!(a.ids().await, ["3", "4", "5"]);
    // One step up for the last visible title, as Alt+ArrowUp sends it.
    a.call(
        "watchlist.reorder",
        json!({"refs": [movie("3"), movie("5"), movie("4")]}),
    )
    .await;
    assert_eq!(a.ids().await, ["3", "5", "4"]);
    a.call("parental.unlock", json!({"pin": "2468"})).await;
    assert_eq!(
        a.ids().await,
        ["3", "1", "5", "4"],
        "the hidden title is still second"
    );
}

#[tokio::test]
async fn parental_hide_mode_leaves_locked_titles_out_of_the_list() {
    let a = app().await;
    // Movie 201 sits in s1's movie category 10 (see `app`); 1 and 2 are not in the catalog.
    a.toggle(movie("201"), "Black Harbor").await;
    a.toggle(movie("1"), "One").await;
    a.toggle(movie("2"), "Two").await;
    let lock = |kind: &str, target: &str| {
        json!({"target": {
            "sourceId": "s1", "contentType": "movie", "kind": kind, "targetId": target, "name": target
        }, "locked": true})
    };
    // Locks do nothing while no PIN is set.
    a.call("parental.setLocked", lock("item", "1")).await;
    assert_eq!(a.ids().await, ["2", "1", "201"]);

    a.call("parental.setPin", json!({"newPin": "2468"})).await;
    assert_eq!(a.ids().await, ["2", "201"], "an item lock hides the title");
    a.call("parental.setLocked", lock("category", "10")).await;
    assert_eq!(a.ids().await, ["2"], "a category lock hides its titles");
    assert_eq!(
        a.list(json!({"contentType": "movie", "sourceId": "s1"}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1,
        "filters combine with hide mode"
    );
    assert_eq!(
        a.export().await.len(),
        3,
        "backups keep every row, hidden or not"
    );

    a.call("parental.unlock", json!({"pin": "2468"})).await;
    assert_eq!(
        a.ids().await,
        ["2", "1", "201"],
        "an unlock shows them again, in place"
    );
    a.call("parental.lockNow", Value::Null).await;
    a.call("parental.configure", json!({"pin": "2468", "mode": "ask"}))
        .await;
    assert_eq!(
        a.ids().await,
        ["2", "1", "201"],
        "ask mode filters nothing in the core"
    );
}

fn entry(source: &str, ct: &str, id: &str, title: &str, position: i64) -> WatchlistBackupEntry {
    serde_json::from_value(json!({
        "sourceId": source, "contentType": ct, "itemId": id, "title": title,
        "addedAt": "2026-10-01T10:00:00Z", "position": position
    }))
    .unwrap()
}

#[tokio::test]
async fn backup_round_trip_keeps_entries_order_and_dates() {
    let a = app().await;
    a.call(
        "watchlist.toggle",
        json!({
            "ref": rf("s1", "series", "301"),
            "snapshot": {"title": "Harbor Lights", "subtitle": "2019", "posterUrl": "http://img/301.jpg", "contentType": "series"}
        }),
    )
    .await;
    a.toggle(movie("201"), "Black Harbor").await;
    a.toggle(rf("s2", "movie", "7"), "Seven").await;
    a.call(
        "watchlist.reorder",
        json!({"refs": [rf("s1", "series", "301")]}),
    )
    .await;
    let before = a.list(json!({})).await;
    let exported = a.export().await;
    assert_eq!(exported.len(), 3);

    // Through JSON, the way the backup file carries it.
    let file = serde_json::to_string(&exported).unwrap();
    assert!(file.contains("\"sourceId\":\"s1\""), "camelCase: {file}");
    let parsed: Vec<WatchlistBackupEntry> = serde_json::from_str(&file).unwrap();

    let b = app().await;
    b.toggle(movie("999"), "Replaced").await;
    assert_eq!(b.import(parsed.clone(), true).await, 3);
    assert_eq!(b.export().await, exported, "replace restores exactly");
    let after = b.list(json!({})).await;
    // The catalog fallback poster differs per app only by content; both
    // apps have the same catalog, so the lists match entry for entry.
    assert_eq!(after, before);

    // Importing the same file again (merge) changes nothing.
    assert_eq!(b.import(parsed, false).await, 3);
    assert_eq!(b.export().await, exported);
}

#[tokio::test]
async fn merge_import_keeps_existing_rows_and_skips_what_cannot_be_stored() {
    let a = app().await;
    a.call(
        "watchlist.toggle",
        json!({"ref": movie("1"), "snapshot": {"title": "Mine", "contentType": "movie"}}),
    )
    .await;
    a.toggle(movie("2"), "Two").await;
    let mine_added = a.export().await[1].added_at.clone();

    let mut older = entry("s1", "movie", "1", "Theirs", 0);
    older.poster_url = Some("http://img/1.jpg".into());
    older.added_at = "2020-01-01T00:00:00Z".into();
    let mut unix_date = entry("s2", "series", "8", "Eight", 1);
    unix_date.added_at = "1760342400".into();
    let mut bad_date = entry("s2", "movie", "9", "Nine", 3);
    bad_date.added_at = "yesterday".into();
    let backup = vec![
        bad_date,
        entry("gone", "movie", "1", "Unknown source", 0),
        entry("s1", "live", "5", "A channel", 0),
        entry("s1", "radio", "6", "A station", 0),
        entry("s1", "movie", " ", "Blank id", 0),
        entry("s1", "movie", "4", "   ", 0),
        older,
        unix_date,
        entry("s2", "series", "8", "Duplicate", 2),
    ];
    assert_eq!(a.import(backup, false).await, 3, "1 merged + 8 and 9 added");

    let out = a.export().await;
    let keys: Vec<(&str, &str)> = out
        .iter()
        .map(|e| (e.source_id.as_str(), e.item_id.as_str()))
        .collect();
    assert_eq!(
        keys,
        [("s1", "2"), ("s1", "1"), ("s2", "8"), ("s2", "9")],
        "existing rows keep their place; new ones follow in backup order"
    );
    let mine = &out[1];
    assert_eq!(mine.title, "Mine", "an existing title is kept");
    assert_eq!(mine.poster_url.as_deref(), Some("http://img/1.jpg"));
    assert_eq!(
        mine.added_at, "2020-01-01T00:00:00.000Z",
        "earlier date wins"
    );
    assert!(mine_added.as_str() > "2020", "{mine_added}");
    assert_eq!(out[2].title, "Eight", "the first entry per item counts");
    assert_eq!(out[2].added_at, "2025-10-13T08:00:00.000Z");
    assert!(
        chrono::DateTime::parse_from_rfc3339(&out[3].added_at).is_ok(),
        "an unreadable date becomes the import time"
    );
}
