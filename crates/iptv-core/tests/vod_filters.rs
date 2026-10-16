//! VOD browsing (Run 2 contract C4, check 7) through the full router: year
//! bounds on `catalog.movies` / `catalog.series` with NULL-year handling and
//! validation, "Hide watched" with a `total` that counts the filtered set,
//! `catalog.yearFacets` (hidden categories, categories, parental hide mode,
//! "Hide watched", junk years) and `positions.watchedContains` (item-level rows only, input
//! order, the 1..=500 limit). The filter SQL is also run on its own, so it is
//! checked independently of the reader that appends it.

use iptv_core::catalog::vodfilter::{self, VodFilter};
use iptv_core::error::RpcErrorCode;
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::userstate::watched::{self, MAX_REFS};
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
}

/// `(item id, title, year, category)` of source `s1`'s movies, in position order.
const MOVIES: &[(&str, &str, Option<i64>, &str)] = &[
    ("m1", "Alpha", Some(1985), "c1"),
    ("m2", "Bravo", Some(1992), "c1"),
    ("m3", "Charlie", Some(1999), "c2"),
    ("m4", "Delta", Some(2005), "c2"),
    ("m5", "Echo", None, "c1"),
    ("m6", "Foxtrot", Some(2023), "c3"),
    ("m7", "Golf", Some(0), "c1"),
    ("m8", "Hotel", Some(1999), "c1"),
];

/// Source `s1`'s series.
const SERIES: &[(&str, &str, Option<i64>, &str)] = &[
    ("sr1", "Show One", Some(1999), "c1"),
    ("sr2", "Show Two", Some(2010), "c1"),
    ("sr3", "Show Three", None, "c1"),
];

/// A fresh app with sources `s1` (the catalog above) and `s2` (one movie
/// `m1` from 1999, so per-source results can be told apart).
async fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(64);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    state
        .db_call(|c| {
            for id in ["s1", "s2"] {
                c.execute(
                    "INSERT INTO sources(id, kind, name, position, created_at, config_json)
                     VALUES (?1, 'xtream', ?1, 0, CURRENT_TIMESTAMP, '{}')",
                    [id],
                )?;
            }
            for ct in ["movie", "series"] {
                for (i, (id, name)) in [("c1", "Action"), ("c2", "Drama"), ("c3", "Kids")]
                    .iter()
                    .enumerate()
                {
                    c.execute(
                        "INSERT INTO categories(source_id, content_type, category_id, name, position)
                         VALUES ('s1', ?1, ?2, ?3, ?4)",
                        params![ct, id, name, i as i64],
                    )?;
                }
            }
            let mut ins = c.prepare(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, year, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (ct, rows) in [("movie", MOVIES), ("series", SERIES)] {
                for (pos, (id, title, year, cat)) in rows.iter().enumerate() {
                    ins.execute(params!["s1", ct, id, cat, title, year, pos as i64])?;
                }
            }
            ins.execute(params!["s2", "movie", "m1", "c1", "Alpha Twin", 1999, 0])?;
            Ok(())
        })
        .await
        .unwrap();
    App {
        _dir: dir,
        state,
        router: build_router(),
    }
}

fn rf(source: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": source, "contentType": ct, "itemId": id})
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

fn item_ids(refs: &Value) -> Vec<String> {
    refs.as_array()
        .unwrap()
        .iter()
        .map(|r| r["itemId"].as_str().unwrap().to_string())
        .collect()
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {} {:?}", e.message, e.code))
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

    /// `catalog.movies` of `s1` in position order with `extra` args merged in.
    async fn movies(&self, extra: Value) -> Value {
        self.list("catalog.movies", extra).await
    }

    async fn list(&self, cmd: &str, extra: Value) -> Value {
        let mut args = json!({"sourceId": "s1", "query": {"offset": 0, "limit": 100}});
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        self.call(cmd, args).await
    }

    async fn facets(&self, args: Value) -> Vec<(i64, i64)> {
        self.call("catalog.yearFacets", args)
            .await
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["year"].as_i64().unwrap(), f["count"].as_i64().unwrap()))
            .collect()
    }

    async fn set_watched(&self, r: Value, episode_id: Option<&str>, watched: bool) {
        let mut args = json!({"ref": r, "watched": watched});
        if let Some(e) = episode_id {
            args["episodeId"] = json!(e);
        }
        self.call("userstate.setWatched", args).await;
    }

    async fn watched(&self, refs: Vec<Value>) -> Vec<String> {
        item_ids(
            &self
                .call("positions.watchedContains", json!({ "refs": refs }))
                .await,
        )
    }
}

// ---------------------------------------------------------------------------
// Year bounds
// ---------------------------------------------------------------------------

#[tokio::test]
async fn year_bounds_filter_movies_and_drop_titles_without_a_year() {
    let a = app().await;
    let all = a.movies(json!({})).await;
    assert_eq!(all["total"], 8, "no filter keeps every title");

    let nineties = a.movies(json!({"yearFrom": 1990, "yearTo": 1999})).await;
    assert_eq!(ids(&nineties), ["m2", "m3", "m8"]);
    assert_eq!(nineties["total"], 3, "total counts the filtered set");

    // One bound is enough to drop titles without a year (m5) and junk years (m7).
    let from = a.movies(json!({"yearFrom": 1999})).await;
    assert_eq!(ids(&from), ["m3", "m4", "m6", "m8"]);
    assert_eq!(from["total"], 4);
    let to = a.movies(json!({"yearTo": 1992})).await;
    assert_eq!(ids(&to), ["m1", "m2"], "year 0 is outside every chip");
    assert_eq!(to["total"], 2);

    // A single year, a category, and paging on top of the filter.
    assert_eq!(
        ids(&a.movies(json!({"yearFrom": 1999, "yearTo": 1999})).await),
        ["m3", "m8"]
    );
    assert_eq!(
        ids(&a
            .movies(json!({"yearFrom": 1990, "yearTo": 2009, "categoryId": "c2"}))
            .await),
        ["m3", "m4"]
    );
    let paged = a
        .movies(json!({"yearFrom": 1980, "query": {"offset": 1, "limit": 2}}))
        .await;
    assert_eq!(ids(&paged), ["m2", "m3"]);
    assert_eq!(paged["total"], 6, "the total ignores the page window");

    // Sorting by year still applies inside the range.
    let sorted = a
        .movies(json!({"yearFrom": 1990, "query": {"offset": 0, "limit": 100, "sort": "year", "dir": "desc"}}))
        .await;
    assert_eq!(ids(&sorted)[0], "m6");

    // A range with nothing in it is an empty page, not an error.
    let empty = a.movies(json!({"yearFrom": 1900, "yearTo": 1950})).await;
    assert_eq!(empty["total"], 0);
    assert!(ids(&empty).is_empty());
}

#[tokio::test]
async fn year_bounds_filter_series_too() {
    let a = app().await;
    let page = a
        .list("catalog.series", json!({"yearFrom": 2000, "yearTo": 2019}))
        .await;
    assert_eq!(ids(&page), ["sr2"]);
    assert_eq!(page["total"], 1);
    let any = a.list("catalog.series", json!({})).await;
    assert_eq!(
        any["total"], 3,
        "series without a year stay when no bound is set"
    );
}

#[tokio::test]
async fn bad_year_bounds_are_invalid() {
    let a = app().await;
    for extra in [
        json!({"yearFrom": 1899}),
        json!({"yearTo": 2101}),
        json!({"yearFrom": 2000, "yearTo": 1999}),
        json!({"yearFrom": -1}),
    ] {
        for cmd in ["catalog.movies", "catalog.series"] {
            let mut args = json!({"sourceId": "s1", "query": {"offset": 0, "limit": 10}});
            for (k, v) in extra.as_object().unwrap() {
                args[k] = v.clone();
            }
            assert_eq!(
                a.fail(cmd, args).await,
                RpcErrorCode::Invalid,
                "{cmd} {extra}"
            );
        }
    }
    // A year that is not a number does not parse at all.
    assert_eq!(
        a.fail(
            "catalog.movies",
            json!({"sourceId": "s1", "query": {"offset": 0, "limit": 10}, "yearFrom": "1990"})
        )
        .await,
        RpcErrorCode::Invalid
    );
}

// ---------------------------------------------------------------------------
// Hide watched
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hide_watched_drops_watched_titles_and_keeps_the_total_right() {
    let a = app().await;
    a.set_watched(rf("s1", "movie", "m2"), None, true).await;
    a.set_watched(rf("s1", "movie", "m4"), None, true).await;
    // The same item id on another source is a different title.
    a.set_watched(rf("s2", "movie", "m1"), None, true).await;

    let page = a.movies(json!({"hideWatched": true})).await;
    assert_eq!(ids(&page), ["m1", "m3", "m5", "m6", "m7", "m8"]);
    assert_eq!(page["total"], 6);

    // hideWatched false (or absent) keeps them.
    assert_eq!(a.movies(json!({"hideWatched": false})).await["total"], 8);

    // Combined with a year range and paging.
    let both = a
        .movies(json!({"hideWatched": true, "yearFrom": 1990, "yearTo": 2009, "query": {"offset": 0, "limit": 1}}))
        .await;
    assert_eq!(ids(&both), ["m3"]);
    assert_eq!(both["total"], 2, "m3 and m8 remain; m2 and m4 are watched");

    // Unwatching brings a title back.
    a.set_watched(rf("s1", "movie", "m2"), None, false).await;
    assert_eq!(a.movies(json!({"hideWatched": true})).await["total"], 7);
}

#[tokio::test]
async fn an_unfinished_position_is_not_watched() {
    let a = app().await;
    a.call(
        "positions.set",
        json!({"ref": rf("s1", "movie", "m3"), "positionSeconds": 600, "durationSeconds": 6000}),
    )
    .await;
    assert_eq!(a.movies(json!({"hideWatched": true})).await["total"], 8);
    assert!(a.watched(vec![rf("s1", "movie", "m3")]).await.is_empty());
}

#[tokio::test]
async fn a_movie_finished_in_the_player_counts_as_watched() {
    let a = app().await;
    // 95 % of the duration, as the player saves it (no watched field).
    a.call(
        "positions.set",
        json!({"ref": rf("s1", "movie", "m3"), "positionSeconds": 5700, "durationSeconds": 6000}),
    )
    .await;
    assert_eq!(a.watched(vec![rf("s1", "movie", "m3")]).await, ["m3"]);
    let page = a.movies(json!({"hideWatched": true})).await;
    assert!(!ids(&page).contains(&"m3".to_string()), "{page}");
    assert_eq!(page["total"], 7);
}

#[tokio::test]
async fn replaying_part_of_a_watched_movie_keeps_it_watched() {
    let a = app().await;
    a.set_watched(rf("s1", "movie", "m3"), None, true).await;
    // The player's saves while the film is replayed: past the first tick and
    // well short of the end.
    for at in [3, 600] {
        a.call(
            "positions.set",
            json!({"ref": rf("s1", "movie", "m3"), "positionSeconds": at, "durationSeconds": 6000}),
        )
        .await;
        assert_eq!(
            a.watched(vec![rf("s1", "movie", "m3")]).await,
            ["m3"],
            "still ticked after a save at {at} s"
        );
        assert_eq!(a.movies(json!({"hideWatched": true})).await["total"], 7);
    }
    // It does not come back as a film to resume.
    let cw = a
        .call("positions.continueWatching", json!({"limit": 20}))
        .await;
    assert!(cw.as_array().unwrap().is_empty(), "{cw}");
    // Unmarking it is the way back.
    a.set_watched(rf("s1", "movie", "m3"), None, false).await;
    assert!(a.watched(vec![rf("s1", "movie", "m3")]).await.is_empty());
    assert_eq!(a.movies(json!({"hideWatched": true})).await["total"], 8);
}

#[tokio::test]
async fn a_series_is_watched_only_when_marked_as_a_whole() {
    let a = app().await;
    // A watched episode does not make the series watched.
    a.set_watched(rf("s1", "series", "sr1"), Some("e1"), true)
        .await;
    let page = a.list("catalog.series", json!({"hideWatched": true})).await;
    assert_eq!(page["total"], 3);
    assert!(a.watched(vec![rf("s1", "series", "sr1")]).await.is_empty());

    // "Mark series as watched" (no episode id) does.
    a.set_watched(rf("s1", "series", "sr1"), None, true).await;
    let page = a.list("catalog.series", json!({"hideWatched": true})).await;
    assert_eq!(ids(&page), ["sr2", "sr3"]);
    assert_eq!(page["total"], 2);
    assert_eq!(a.watched(vec![rf("s1", "series", "sr1")]).await, ["sr1"]);
}

// ---------------------------------------------------------------------------
// The filter SQL on its own
// ---------------------------------------------------------------------------

#[tokio::test]
async fn filter_sql_selects_the_same_rows_without_the_reader() {
    let a = app().await;
    a.set_watched(rf("s1", "movie", "m3"), None, true).await;
    let rows = a
        .state
        .db_call(|c| {
            let run = |f: &VodFilter| -> iptv_core::error::CoreResult<Vec<String>> {
                let mut args: Vec<rusqlite::types::Value> =
                    vec!["s1".to_string().into(), "movie".to_string().into()];
                let extra = vodfilter::vod_filter_sql(f, &mut args);
                let sql = format!(
                    "SELECT i.item_id FROM items i WHERE i.source_id = ?1 AND i.content_type = ?2{extra} ORDER BY i.position"
                );
                let mut stmt = c.prepare(&sql)?;
                let v = stmt
                    .query_map(rusqlite::params_from_iter(args.iter()), |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                Ok(v)
            };
            Ok(vec![
                run(&VodFilter::default())?,
                run(&VodFilter {
                    year_from: Some(1990),
                    year_to: Some(1999),
                    hide_watched: true,
                })?,
                run(&VodFilter {
                    year_from: None,
                    year_to: None,
                    hide_watched: true,
                })?,
            ])
        })
        .await
        .unwrap();
    assert_eq!(rows[0].len(), 8);
    assert_eq!(rows[1], ["m2", "m8"]);
    assert_eq!(rows[2], ["m1", "m2", "m4", "m5", "m6", "m7", "m8"]);
}

// ---------------------------------------------------------------------------
// Year facets
// ---------------------------------------------------------------------------

#[tokio::test]
async fn year_facets_count_titles_per_year_newest_first() {
    let a = app().await;
    let all = a
        .facets(json!({"sourceId": "s1", "contentType": "movie"}))
        .await;
    // No NULL year, no year 0; 1999 counted twice.
    assert_eq!(all, [(2023, 1), (2005, 1), (1999, 2), (1992, 1), (1985, 1)]);

    let drama = a
        .facets(json!({"sourceId": "s1", "contentType": "movie", "categoryId": "c2"}))
        .await;
    assert_eq!(drama, [(2005, 1), (1999, 1)]);

    let series = a
        .facets(json!({"sourceId": "s1", "contentType": "series"}))
        .await;
    assert_eq!(series, [(2010, 1), (1999, 1)]);

    // Per source; an unknown source or an empty category has no years.
    let other = a
        .facets(json!({"sourceId": "s2", "contentType": "movie"}))
        .await;
    assert_eq!(other, [(1999, 1)]);
    assert!(a
        .facets(json!({"sourceId": "nope", "contentType": "movie"}))
        .await
        .is_empty());
    assert!(a
        .facets(json!({"sourceId": "s1", "contentType": "movie", "categoryId": "c9"}))
        .await
        .is_empty());
}

#[tokio::test]
async fn year_facets_leave_out_hidden_categories() {
    let a = app().await;
    a.call(
        "catalog.setCategoryHidden",
        json!({"sourceId": "s1", "contentType": "movie", "categoryId": "c3", "hidden": true}),
    )
    .await;
    let all = a
        .facets(json!({"sourceId": "s1", "contentType": "movie"}))
        .await;
    assert!(all.iter().all(|(y, _)| *y != 2023), "{all:?}");
    // Asking for the hidden category itself still answers (like catalog.movies).
    let kids = a
        .facets(json!({"sourceId": "s1", "contentType": "movie", "categoryId": "c3"}))
        .await;
    assert_eq!(kids, [(2023, 1)]);
}

#[tokio::test]
async fn year_facets_follow_parental_hide_mode() {
    let a = app().await;
    a.call("parental.setPin", json!({"newPin": "2468"})).await;
    a.call(
        "parental.setLocked",
        json!({
            "target": {"sourceId": "s1", "contentType": "movie", "kind": "category", "targetId": "c2", "name": "Drama"},
            "locked": true
        }),
    )
    .await;
    let all = a
        .facets(json!({"sourceId": "s1", "contentType": "movie"}))
        .await;
    assert_eq!(all, [(2023, 1), (1999, 1), (1992, 1), (1985, 1)]);

    // An unlock shows them again.
    a.call("parental.unlock", json!({"pin": "2468"})).await;
    let all = a
        .facets(json!({"sourceId": "s1", "contentType": "movie"}))
        .await;
    assert_eq!(all, [(2023, 1), (2005, 1), (1999, 2), (1992, 1), (1985, 1)]);
}

#[tokio::test]
async fn year_facets_with_hide_watched_count_what_the_grid_shows() {
    let a = app().await;
    a.set_watched(rf("s1", "movie", "m3"), None, true).await;
    a.set_watched(rf("s1", "movie", "m4"), None, true).await;
    // The same item id on another source and a watched episode do not count.
    a.set_watched(rf("s2", "movie", "m1"), None, true).await;
    a.set_watched(rf("s1", "series", "sr2"), Some("e1"), true)
        .await;

    let hidden = a
        .facets(json!({"sourceId": "s1", "contentType": "movie", "hideWatched": true}))
        .await;
    // m3 (1999) drops out of its year's count; m4 (2005) takes its year with it.
    assert_eq!(hidden, [(2023, 1), (1999, 1), (1992, 1), (1985, 1)]);
    let page = a
        .movies(json!({"hideWatched": true, "yearFrom": 1999, "yearTo": 1999}))
        .await;
    assert_eq!(page["total"], 1, "the facet count matches the grid");

    let drama = a
        .facets(json!({"sourceId": "s1", "contentType": "movie", "categoryId": "c2", "hideWatched": true}))
        .await;
    assert!(drama.is_empty(), "{drama:?}");
    let series = a
        .facets(json!({"sourceId": "s1", "contentType": "series", "hideWatched": true}))
        .await;
    assert_eq!(series, [(2010, 1), (1999, 1)]);

    // hideWatched false or absent keeps the old counts.
    let all = [(2023, 1), (2005, 1), (1999, 2), (1992, 1), (1985, 1)];
    assert_eq!(
        a.facets(json!({"sourceId": "s1", "contentType": "movie", "hideWatched": false}))
            .await,
        all
    );
    assert_eq!(
        a.facets(json!({"sourceId": "s1", "contentType": "movie"}))
            .await,
        all
    );

    // Not a boolean does not parse.
    assert_eq!(
        a.fail(
            "catalog.yearFacets",
            json!({"sourceId": "s1", "contentType": "movie", "hideWatched": "yes"})
        )
        .await,
        RpcErrorCode::Invalid
    );
}

#[tokio::test]
async fn year_facets_reject_live_content() {
    let a = app().await;
    for ct in ["live", "radio"] {
        assert_eq!(
            a.fail(
                "catalog.yearFacets",
                json!({"sourceId": "s1", "contentType": ct})
            )
            .await,
            RpcErrorCode::Invalid
        );
    }
}

#[tokio::test]
async fn year_facets_function_matches_the_rpc() {
    let a = app().await;
    let v = a
        .state
        .db_call(|c| vodfilter::year_facets(c, "s1", ContentType::Movie, None))
        .await
        .unwrap();
    assert_eq!(v, [(2023, 1), (2005, 1), (1999, 2), (1992, 1), (1985, 1)]);

    a.set_watched(rf("s1", "movie", "m8"), None, true).await;
    let v = a
        .state
        .db_call(|c| {
            vodfilter::year_facets_filtered(c, "s1", ContentType::Movie, None, false, None, true)
        })
        .await
        .unwrap();
    assert_eq!(v, [(2023, 1), (2005, 1), (1999, 1), (1992, 1), (1985, 1)]);
}

// ---------------------------------------------------------------------------
// positions.watchedContains
// ---------------------------------------------------------------------------

#[tokio::test]
async fn watched_contains_answers_item_level_watched_rows_in_input_order() {
    let a = app().await;
    a.set_watched(rf("s1", "movie", "m4"), None, true).await;
    a.set_watched(rf("s1", "movie", "m1"), None, true).await;
    a.set_watched(rf("s1", "series", "sr2"), None, true).await;
    a.set_watched(rf("s1", "series", "sr1"), Some("e9"), true)
        .await;

    let got = a
        .watched(vec![
            rf("s1", "movie", "m1"),
            rf("s1", "movie", "m2"),
            rf("s1", "series", "sr1"),
            rf("s1", "series", "sr2"),
            rf("s1", "movie", "m4"),
            rf("s1", "movie", "m1"),
            rf("s2", "movie", "m1"),
            rf("s1", "movie", "unknown"),
        ])
        .await;
    assert_eq!(
        got,
        ["m1", "sr2", "m4"],
        "input order, duplicates collapsed"
    );

    // The function behind the command; a movie finished in the player is
    // covered by a_movie_finished_in_the_player_counts_as_watched.
    let set = a
        .state
        .db_call(|c| {
            watched::watched_set(
                c,
                &[
                    ItemRef::new("s1", ContentType::Movie, "m1"),
                    ItemRef::new("s1", ContentType::Movie, "m2"),
                ],
            )
        })
        .await
        .unwrap();
    assert_eq!(set.into_iter().collect::<Vec<_>>(), ["s1|movie|m1"]);
}

#[tokio::test]
async fn watched_contains_validates_the_ref_count() {
    let a = app().await;
    assert_eq!(
        a.fail("positions.watchedContains", json!({"refs": []}))
            .await,
        RpcErrorCode::Invalid
    );
    let too_many: Vec<Value> = (0..=MAX_REFS)
        .map(|i| rf("s1", "movie", &format!("x{i}")))
        .collect();
    assert_eq!(
        a.fail("positions.watchedContains", json!({ "refs": too_many }))
            .await,
        RpcErrorCode::Invalid
    );
    let max: Vec<Value> = (0..MAX_REFS)
        .map(|i| rf("s1", "movie", &format!("x{i}")))
        .collect();
    assert!(a.watched(max).await.is_empty());
    assert_eq!(
        a.fail("positions.watchedContains", json!({})).await,
        RpcErrorCode::Invalid,
        "refs is required"
    );
}

#[tokio::test]
async fn the_full_router_registers_both_commands() {
    let r = build_router();
    for cmd in ["catalog.yearFacets", "positions.watchedContains"] {
        assert!(r.contains(cmd), "{cmd} is not registered");
    }
}
