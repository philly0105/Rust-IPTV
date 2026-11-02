//! Catalog (B1): replace_catalog, paging, sort, search (FTS and LIKE
//! fallback), hidden categories, channelByNumber, neighbors, sameTitle,
//! matchTitles, recentlyAdded, allLiveChannels, and the `catalog.*` rpc
//! names.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::{self, CatalogQuery, CategoryRow, ItemRow};
use iptv_core::model::{ContentType, ItemRef, PageQuery, SortDir, SortKey};
use serde_json::json;
use support::*;

fn live(source: &str, id: &str, cat: &str, title: &str, number: i64) -> ItemRow {
    ItemRow {
        source_id: source.into(),
        content_type: ContentType::Live,
        item_id: id.into(),
        category_id: cat.into(),
        title: title.into(),
        number: Some(number),
        url: Some(format!("http://h/{id}")),
        position: number,
        ..Default::default()
    }
}

fn movie(source: &str, id: &str, title: &str, added: Option<&str>, rating: Option<f64>) -> ItemRow {
    ItemRow {
        source_id: source.into(),
        content_type: ContentType::Movie,
        item_id: id.into(),
        category_id: "m".into(),
        title: title.into(),
        added: added.map(str::to_owned),
        rating,
        ..Default::default()
    }
}

fn cat(id: &str, name: &str, position: i64) -> CategoryRow {
    CategoryRow {
        category_id: id.into(),
        name: name.into(),
        position,
    }
}

async fn seed(env: &Env) {
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    env.state
        .db_call(|c| {
            let mut items = vec![
                live("s1", "a", "news", "Alpha News", 1),
                live("s1", "b", "news", "Beta News HD", 2),
                live("s1", "c", "sport", "Gamma Sports", 3),
                live("s1", "d", "sport", "Delta Sports", 4),
                live("s1", "e", "kids", "Epsilon Kids", 5),
            ]
            .into_iter();
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Live,
                &[
                    cat("news", "News", 0),
                    cat("sport", "Sport", 1),
                    cat("kids", "Kids", 2),
                ],
                &mut items,
            )?;
            let mut m1 = vec![
                movie(
                    "s1",
                    "m1",
                    "EN - The Matrix (1999)",
                    Some("2026-01-01T00:00:00Z"),
                    Some(8.7),
                ),
                movie(
                    "s1",
                    "m2",
                    "Heat [4K]",
                    Some("2026-02-01T00:00:00Z"),
                    Some(8.3),
                ),
                movie("s1", "m3", "Up (2009)", None, None),
            ]
            .into_iter();
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Movie,
                &[cat("m", "Movies", 0)],
                &mut m1,
            )?;
            let mut m2 = vec![
                movie(
                    "s2",
                    "x1",
                    "|FR| The Matrix (1999)",
                    Some("2026-03-01T00:00:00Z"),
                    None,
                ),
                movie("s2", "x2", "The Matrix (2021)", None, None),
            ]
            .into_iter();
            catalog::replace_catalog(
                c,
                "s2",
                ContentType::Movie,
                &[cat("m", "Films", 0)],
                &mut m2,
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

fn q(source: &str, ct: ContentType, page: PageQuery) -> CatalogQuery {
    CatalogQuery {
        source_id: source.into(),
        content_type: ct,
        category_id: None,
        page,
        include_hidden: false,
        min_rating: None,
        english_only: false,
        quality: None,
        vod: Default::default(),
    }
}

#[tokio::test]
async fn paging_sort_and_counts() {
    let env = env().await;
    seed(&env).await;
    let page = env
        .state
        .db_call(|c| {
            catalog::query(
                c,
                &q(
                    "s1",
                    ContentType::Live,
                    PageQuery {
                        offset: 1,
                        limit: 2,
                        sort: Some(SortKey::Name),
                        dir: Some(SortDir::Desc),
                        search: None,
                    },
                ),
            )
        })
        .await
        .unwrap();
    assert_eq!(page.total, 5);
    let titles: Vec<_> = page.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, vec!["Epsilon Kids", "Delta Sports"]);

    let by_rating = env
        .state
        .db_call(|c| {
            catalog::query(
                c,
                &q(
                    "s1",
                    ContentType::Movie,
                    PageQuery {
                        sort: Some(SortKey::Rating),
                        ..Default::default()
                    },
                ),
            )
        })
        .await
        .unwrap();
    assert_eq!(by_rating.items[0].item_id, "m1");
    assert_eq!(by_rating.items[2].item_id, "m3", "nulls last");

    let counts = env
        .state
        .db_call(|c| catalog::source_counts(c, "s1"))
        .await
        .unwrap();
    assert_eq!(counts, (5, 3, 0));
}

#[tokio::test]
async fn search_fts_prefix_and_like_fallback() {
    let env = env().await;
    seed(&env).await;
    let hits = env
        .state
        .db_call(|c| catalog::search(c, "spo", Some("s1"), &[ContentType::Live], 10))
        .await
        .unwrap();
    assert_eq!(hits.len(), 2, "prefix match");
    // Substring inside a word: FTS finds nothing, LIKE does.
    let hits = env
        .state
        .db_call(|c| catalog::search(c, "psilo", None, &[ContentType::Live], 10))
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].item_id, "e");
    // Odd characters do not break FTS syntax.
    let hits = env
        .state
        .db_call(|c| catalog::search(c, "\"news* OR (", None, &[], 10))
        .await
        .unwrap();
    assert!(hits.len() <= 2);
    let page = env
        .state
        .db_call(|c| {
            catalog::query(
                c,
                &q(
                    "s1",
                    ContentType::Live,
                    PageQuery {
                        search: Some("news".into()),
                        ..Default::default()
                    },
                ),
            )
        })
        .await
        .unwrap();
    assert_eq!(page.total, 2);
}

#[tokio::test]
async fn hidden_categories_filter_and_survive_rebuild() {
    let env = env().await;
    seed(&env).await;
    let r = router();
    r.dispatch(
        env.state.clone(),
        "catalog.setCategoriesHidden",
        json!({"sourceId": "s1", "contentType": "live", "hiddenIds": ["sport"]}),
    )
    .await
    .unwrap();
    let page = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": "s1"}),
        )
        .await
        .unwrap();
    assert_eq!(page["total"], 3);
    let in_cat = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": "s1", "categoryId": "sport"}),
        )
        .await
        .unwrap();
    assert_eq!(
        in_cat["total"], 2,
        "explicit category ignores the hidden filter"
    );
    // Rebuild keeps the flag.
    env.state
        .db_call(|c| {
            let mut it = vec![live("s1", "c", "sport", "Gamma Sports", 3)].into_iter();
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Live,
                &[cat("sport", "Sport", 0)],
                &mut it,
            )
        })
        .await
        .unwrap();
    let cats = r
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({"sourceId": "s1", "contentType": "live", "includeHidden": true}),
        )
        .await
        .unwrap();
    assert_eq!(cats[0]["hidden"], true);
    // The bulk FTS update kept the index in step with the rebuilt rows.
    let (gone, kept) = env
        .state
        .db_call(|c| {
            c.execute(
                "INSERT INTO items_fts(items_fts, rank) VALUES ('integrity-check', 1)",
                [],
            )?;
            let fts = |t: &str| -> rusqlite::Result<i64> {
                c.query_row(
                    "SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH ?1",
                    [t],
                    |r| r.get(0),
                )
            };
            let (gone, kept) = (fts("alpha")?, fts("gamma")?);
            let suspended: i64 =
                c.query_row("SELECT COUNT(*) FROM fts_suspend", [], |r| r.get(0))?;
            assert_eq!(suspended, 0);
            Ok((gone, kept))
        })
        .await
        .unwrap();
    assert_eq!((gone, kept), (0, 1));
    let err = r
        .dispatch(
            env.state.clone(),
            "catalog.setCategoryHidden",
            json!({"sourceId": "s1", "contentType": "live", "categoryId": "nope", "hidden": true}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, iptv_core::RpcErrorCode::NotFound);
}

/// `n` movies or series of `source`, spread over `cats` in turn.
fn vod_rows(source: &str, ct: ContentType, cats: &[&str], n: usize) -> Vec<ItemRow> {
    (0..n)
        .map(|i| ItemRow {
            source_id: source.into(),
            content_type: ct,
            item_id: format!("{}{i}", ct.as_str()),
            category_id: cats[i % cats.len()].into(),
            title: format!("Title {i}"),
            rating: (!i.is_multiple_of(3)).then_some((i % 10) as f64),
            position: i as i64,
            ..Default::default()
        })
        .collect()
}

/// All movies, All series and Top rated take their total from the stored
/// category counts (CAT-2). It must equal a count of the titles the list
/// shows, `COALESCE(c.hidden, 0) = 0` on the category join, through hidden
/// categories, `include_hidden`, an undeclared category (stored as
/// Uncategorized) and a re-import that shrinks the catalog.
#[tokio::test]
async fn unfiltered_vod_totals_match_a_count_of_their_titles() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    let r = router();
    // Declared a, b, c; `x` is undeclared and becomes Uncategorized.
    let write = |ct: ContentType, cats: &'static [&'static str], n: usize| {
        env.state.db_call(move |c| {
            catalog::replace_catalog(
                c,
                "s1",
                ct,
                &[
                    cat("a", "Action", 0),
                    cat("b", "Drama", 1),
                    cat("c", "Kids", 2),
                ],
                &mut vod_rows("s1", ct, cats, n).into_iter(),
            )
        })
    };
    write(ContentType::Movie, &["a", "b", "c", "x"], 103)
        .await
        .unwrap();
    write(ContentType::Series, &["a", "b", "x"], 41)
        .await
        .unwrap();
    // Another source's titles never count.
    env.state
        .db_call(|c| {
            catalog::replace_catalog(
                c,
                "s2",
                ContentType::Movie,
                &[cat("a", "Action", 0)],
                &mut vod_rows("s2", ContentType::Movie, &["a"], 7).into_iter(),
            )
        })
        .await
        .unwrap();

    // The count every case must match, independent of `query_named`.
    let expected = |ct: ContentType, include_hidden: bool| {
        env.state.db_call(move |c| {
            Ok(c.query_row(
                "SELECT count(*) FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE i.source_id = 's1' AND i.content_type = ?1 AND (?2 OR COALESCE(c.hidden, 0) = 0)",
                rusqlite::params![ct.as_str(), include_hidden],
                |r| r.get::<_, i64>(0),
            )?)
        })
    };
    let check = |label: &'static str| {
        let (r, env) = (&r, &env);
        async move {
            for (ct, method) in [
                (ContentType::Movie, "catalog.movies"),
                (ContentType::Series, "catalog.series"),
            ] {
                let want = expected(ct, false).await.unwrap();
                for sort in ["added", "rating"] {
                    let v = r
                        .dispatch(
                            env.state.clone(),
                            method,
                            json!({"sourceId": "s1", "query": {"sort": sort, "limit": 10}}),
                        )
                        .await
                        .unwrap();
                    assert_eq!(v["total"], want, "{label}: {method} by {sort}");
                }
                let all = expected(ct, true).await.unwrap();
                let page = env
                    .state
                    .db_call(move |c| {
                        catalog::query(
                            c,
                            &CatalogQuery {
                                include_hidden: true,
                                ..q("s1", ct, PageQuery::default())
                            },
                        )
                    })
                    .await
                    .unwrap();
                assert_eq!(page.total, all, "{label}: {method}, include_hidden");
            }
        }
    };
    check("nothing hidden").await;
    assert_eq!(expected(ContentType::Movie, false).await.unwrap(), 103);

    for (ct, hidden) in [
        (ContentType::Movie, json!(["b"])),
        (ContentType::Series, json!(["a"])),
    ] {
        r.dispatch(
            env.state.clone(),
            "catalog.setCategoriesHidden",
            json!({"sourceId": "s1", "contentType": ct, "hiddenIds": hidden}),
        )
        .await
        .unwrap();
    }
    check("one category hidden").await;
    // Uncategorized can be hidden like any other category.
    r.dispatch(
        env.state.clone(),
        "catalog.setCategoriesHidden",
        json!({"sourceId": "s1", "contentType": "movie", "hiddenIds": ["b", "x"]}),
    )
    .await
    .unwrap();
    check("Uncategorized hidden").await;
    assert_eq!(expected(ContentType::Movie, false).await.unwrap(), 52);

    // A re-import that shrinks the catalog and empties c; the hidden flags
    // survive it.
    write(ContentType::Movie, &["a", "b", "x"], 40)
        .await
        .unwrap();
    write(ContentType::Series, &["b"], 9).await.unwrap();
    check("after a smaller re-import").await;
    assert_eq!(expected(ContentType::Movie, false).await.unwrap(), 14);
}

/// All channels (live and radio) take their total from the stored category
/// counts too, which leave out channels hidden by a channel edit. It must
/// equal an independent count of the rows the list shows: visible
/// categories (every one with `includeHidden`), no hidden channel, through
/// hidden groups, hidden channels inside and outside a hidden group, a
/// re-import that keeps the edits, and `channels.reset`.
#[tokio::test]
async fn unfiltered_channel_totals_match_a_count_without_hidden_channels() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    let mut r = router();
    iptv_core::channeledit::rpc::register(&mut r);
    // Declared a, b, c; `x` is undeclared and becomes Uncategorized.
    let write = |source: &'static str, ct: ContentType, cats: &'static [&'static str], n: usize| {
        env.state.db_call(move |c| {
            catalog::replace_catalog(
                c,
                source,
                ct,
                &[
                    cat("a", "News", 0),
                    cat("b", "Sport", 1),
                    cat("c", "Kids", 2),
                ],
                &mut vod_rows(source, ct, cats, n).into_iter(),
            )
        })
    };
    write("s1", ContentType::Live, &["a", "b", "c", "x"], 57)
        .await
        .unwrap();
    write("s1", ContentType::Radio, &["a", "b", "x"], 23)
        .await
        .unwrap();
    // Another source's channels never count.
    write("s2", ContentType::Live, &["a"], 9).await.unwrap();

    // The count every case must match, independent of `query_named`.
    let expected = |ct: ContentType, include_hidden: bool| {
        env.state.db_call(move |c| {
            Ok(c.query_row(
                "SELECT count(*) FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE i.source_id = 's1' AND i.content_type = ?1 AND (?2 OR COALESCE(c.hidden, 0) = 0) AND NOT EXISTS (SELECT 1 FROM channel_edits e WHERE e.source_id = i.source_id AND e.content_type = i.content_type AND e.item_id = i.item_id AND e.hidden = 1)",
                rusqlite::params![ct.as_str(), include_hidden],
                |r| r.get::<_, i64>(0),
            )?)
        })
    };
    let check = |label: &'static str| {
        let (r, env) = (&r, &env);
        async move {
            let mut totals = Vec::new();
            for (ct, radio) in [(ContentType::Live, false), (ContentType::Radio, true)] {
                for include_hidden in [false, true] {
                    let want = expected(ct, include_hidden).await.unwrap();
                    for sort in [json!(null), json!("number"), json!("name")] {
                        let page = r
                            .dispatch(
                                env.state.clone(),
                                "catalog.channels",
                                json!({"sourceId": "s1", "radio": radio, "includeHidden": include_hidden, "query": {"sort": sort, "limit": 10}}),
                            )
                            .await
                            .unwrap();
                        assert_eq!(
                            page["total"], want,
                            "{label}: {ct} by {sort}, includeHidden {include_hidden}"
                        );
                        assert_eq!(
                            page["items"].as_array().unwrap().len() as i64,
                            want.min(10),
                            "{label}: {ct} page"
                        );
                    }
                    totals.push(want);
                }
            }
            totals
        }
    };
    assert_eq!(check("nothing hidden").await, [57, 57, 23, 23]);

    for (ct, hidden) in [("live", "b"), ("radio", "a")] {
        r.dispatch(
            env.state.clone(),
            "catalog.setCategoriesHidden",
            json!({"sourceId": "s1", "contentType": ct, "hiddenIds": [hidden]}),
        )
        .await
        .unwrap();
    }
    // 14 live channels in b (1, 5, ..., 53), 8 radio stations in a.
    assert_eq!(check("one group hidden").await, [43, 57, 15, 23]);

    // live1 and radio0 sit in the hidden groups, live2 and radio1 outside.
    let refs: Vec<_> = [
        ("live", "live1"),
        ("live", "live2"),
        ("radio", "radio0"),
        ("radio", "radio1"),
    ]
    .into_iter()
    .map(|(ct, id)| json!({"sourceId": "s1", "contentType": ct, "itemId": id}))
    .collect();
    r.dispatch(
        env.state.clone(),
        "channels.setHidden",
        json!({"refs": refs, "hidden": true}),
    )
    .await
    .unwrap();
    assert_eq!(check("channels hidden").await, [42, 55, 14, 21]);

    // A smaller re-import keeps the edits and the hidden groups.
    write("s1", ContentType::Live, &["a", "b", "c", "x"], 30)
        .await
        .unwrap();
    write("s1", ContentType::Radio, &["a", "b", "x"], 12)
        .await
        .unwrap();
    assert_eq!(check("after a smaller re-import").await, [21, 28, 7, 10]);

    r.dispatch(
        env.state.clone(),
        "channels.reset",
        json!({"sourceId": "s1"}),
    )
    .await
    .unwrap();
    assert_eq!(check("after channels.reset").await, [22, 30, 8, 12]);
}

#[tokio::test]
async fn number_neighbors_all_live() {
    let env = env().await;
    seed(&env).await;
    let r = router();
    let ch = r
        .dispatch(
            env.state.clone(),
            "catalog.channelByNumber",
            json!({"sourceId": "s1", "number": 3}),
        )
        .await
        .unwrap();
    assert_eq!(ch["name"], "Gamma Sports");
    let none = r
        .dispatch(
            env.state.clone(),
            "catalog.channelByNumber",
            json!({"sourceId": "s1", "number": 99}),
        )
        .await
        .unwrap();
    assert!(none.is_null());
    let reference = ItemRef {
        source_id: "s1".into(),
        content_type: ContentType::Live,
        item_id: "a".into(),
    };
    let n = r
        .dispatch(
            env.state.clone(),
            "catalog.neighbors",
            json!({"ref": reference}),
        )
        .await
        .unwrap();
    assert_eq!(n["next"]["name"], "Beta News HD");
    assert_eq!(n["prev"]["name"], "Epsilon Kids", "wraps around");
    let n = r
        .dispatch(
            env.state.clone(),
            "catalog.neighbors",
            json!({"ref": reference, "categoryId": "news"}),
        )
        .await
        .unwrap();
    assert_eq!(n["next"]["name"], "Beta News HD");
    assert_eq!(n["prev"]["name"], "Beta News HD");
    let all = r
        .dispatch(
            env.state.clone(),
            "catalog.allLiveChannels",
            json!({"sourceId": "s1"}),
        )
        .await
        .unwrap();
    assert_eq!(all.as_array().unwrap().len(), 5);
    let item = r
        .dispatch(env.state.clone(), "catalog.item", json!({"ref": reference}))
        .await
        .unwrap();
    assert_eq!(item["categoryName"], "News");
    let missing = r
        .dispatch(
            env.state.clone(),
            "catalog.item",
            json!({"ref": {"sourceId": "s1", "contentType": "live", "itemId": "zz"}}),
        )
        .await
        .unwrap_err();
    assert_eq!(missing.code, iptv_core::RpcErrorCode::NotFound);
}

#[tokio::test]
async fn same_title_recently_added_and_search_rpc() {
    let env = env().await;
    seed(&env).await;
    let r = router();
    let m1 = ItemRef {
        source_id: "s1".into(),
        content_type: ContentType::Movie,
        item_id: "m1".into(),
    };
    let same = r
        .dispatch(env.state.clone(), "catalog.sameTitle", json!({"ref": m1}))
        .await
        .unwrap();
    let ids: Vec<_> = same
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["ref"]["itemId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids,
        vec!["x1"],
        "same base title and year, other source only"
    );

    let recent = r
        .dispatch(
            env.state.clone(),
            "catalog.recentlyAdded",
            json!({"contentType": "movie", "limit": 2}),
        )
        .await
        .unwrap();
    let ids: Vec<_> = recent
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["ref"]["itemId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["x1", "m2"]);
    let bad = r
        .dispatch(
            env.state.clone(),
            "catalog.recentlyAdded",
            json!({"contentType": "live"}),
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, iptv_core::RpcErrorCode::Invalid);

    let res = r
        .dispatch(
            env.state.clone(),
            "catalog.search",
            json!({"query": "matrix"}),
        )
        .await
        .unwrap();
    assert_eq!(res["movies"].as_array().unwrap().len(), 3);
    assert!(res["live"].as_array().unwrap().is_empty());
    let series = r
        .dispatch(
            env.state.clone(),
            "catalog.series",
            json!({"sourceId": "s1"}),
        )
        .await
        .unwrap();
    assert_eq!(series["total"], 0);
}

#[test]
fn all_catalog_commands_registered() {
    let r = router();
    for name in [
        "catalog.categories",
        "catalog.setCategoryHidden",
        "catalog.setCategoriesHidden",
        "catalog.channels",
        "catalog.movies",
        "catalog.series",
        "catalog.item",
        "catalog.channelByNumber",
        "catalog.neighbors",
        "catalog.search",
        "catalog.recentlyAdded",
        "catalog.sameTitle",
        "catalog.matchTitles",
        "catalog.allLiveChannels",
        "sources.list",
        "sources.get",
        "sources.add",
        "sources.update",
        "sources.remove",
        "sources.removeAll",
        "sources.reorder",
        "sources.refresh",
        "sources.refreshAll",
        "sources.counts",
        "m3u.raw",
        "m3u.parsePreview",
        "m3u.seriesDetail",
        "m3u.streamUrl",
    ] {
        assert!(r.contains(name), "{name} missing");
    }
}

/// `catalog.search` honours limits up to 1001 (the UI's 1000 step plus one
/// probe row) and clamps anything larger there.
#[tokio::test]
async fn search_limit_reaches_the_ui_probe_of_1001() {
    let env = env().await;
    let r = router();
    add_text(&env.state, "Many", &gen_m3u(1100, 4)).await;
    let count = |res: serde_json::Value| res["live"].as_array().unwrap().len();
    for (limit, want) in [(201, 201), (1001, 1001), (5000, 1001)] {
        let res = r
            .dispatch(
                env.state.clone(),
                "catalog.search",
                json!({"query": "channel", "contentTypes": ["live"], "limit": limit}),
            )
            .await
            .unwrap();
        assert_eq!(count(res), want, "limit {limit}");
    }
    assert_eq!(iptv_core::catalog::rpc::MAX_SEARCH_LIMIT, 1001);
}

/// `minRating` filters in SQL: unrated items drop out, `total` counts the
/// filtered set, paging applies after the filter, and 0 or absent is off.
#[tokio::test]
async fn movies_min_rating_filters_in_sql_with_counts() {
    let env = env().await;
    seed(&env).await;
    let page = env
        .state
        .db_call(|c| {
            catalog::query(
                c,
                &CatalogQuery {
                    min_rating: Some(8.5),
                    ..q("s1", ContentType::Movie, PageQuery::default())
                },
            )
        })
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].item_id, "m1");

    let r = router();
    let ids = |v: &serde_json::Value| -> Vec<String> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["ref"]["itemId"].as_str().unwrap().to_string())
            .collect()
    };
    for (min, total) in [
        (json!(8.0), 2),
        (json!(8.3), 2),
        (json!(9.6), 0),
        (json!(0), 3),
        (serde_json::Value::Null, 3),
    ] {
        let res = r
            .dispatch(
                env.state.clone(),
                "catalog.movies",
                json!({"sourceId": "s1", "query": {"offset": 0, "limit": 1, "sort": "rating"}, "minRating": min}),
            )
            .await
            .unwrap();
        assert_eq!(res["total"], total, "minRating {min}");
        if total > 0 {
            assert_eq!(ids(&res), vec!["m1"], "minRating {min}");
        }
    }
    // Second page of the filtered set, and the filter combined with search.
    let res = r
        .dispatch(
            env.state.clone(),
            "catalog.movies",
            json!({"sourceId": "s1", "query": {"offset": 1, "limit": 1, "sort": "rating"}, "minRating": 8.0}),
        )
        .await
        .unwrap();
    assert_eq!(ids(&res), vec!["m2"]);
    let res = r
        .dispatch(
            env.state.clone(),
            "catalog.movies",
            json!({"sourceId": "s1", "query": {"search": "heat"}, "minRating": 8.5}),
        )
        .await
        .unwrap();
    assert_eq!(res["total"], 0);
    let res = r
        .dispatch(
            env.state.clone(),
            "catalog.series",
            json!({"sourceId": "s1", "query": {}, "minRating": 5}),
        )
        .await
        .unwrap();
    assert_eq!(res["total"], 0);
}

/// `englishOnly`: channel and movie lists, totals, categories (dropped when
/// left empty, counts filtered), search and allLiveChannels drop items that
/// are clearly in another language; items without a clear language stay.
#[tokio::test]
async fn english_only_setting_filters_lists_counts_and_categories() {
    let env = env().await;
    seed(&env).await;
    bare_source(&env.state, "s3").await;
    env.state
        .db_call(|c| {
            let mut items = vec![
                live("s3", "1", "fr", "FR| TF1", 1),
                live("s3", "2", "fr", "FR| France 2", 2),
                live("s3", "3", "uk", "UK| BBC One", 3),
                live("s3", "4", "mix", "AR: Al Jazeera News", 4),
                live("s3", "5", "mix", "Sky News", 5),
                live("s3", "6", "mix", "Новости 24", 6),
            ]
            .into_iter();
            catalog::replace_catalog(
                c,
                "s3",
                ContentType::Live,
                &[
                    cat("fr", "FRANCE | GENERAL", 0),
                    cat("uk", "UK | NEWS", 1),
                    cat("mix", "News", 2),
                ],
                &mut items,
            )
        })
        .await
        .unwrap();
    let mut r = router();
    iptv_core::settings::rpc::register(&mut r);
    let channel_ids = |v: &serde_json::Value| -> Vec<String> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["ref"]["itemId"].as_str().unwrap().to_string())
            .collect()
    };
    let set = |on: bool| {
        r.dispatch(
            env.state.clone(),
            "settings.update",
            json!({ "patch": { "englishOnly": on } }),
        )
    };

    let all = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": "s3"}),
        )
        .await
        .unwrap();
    assert_eq!(all["total"], 6, "off by default");

    set(true).await.unwrap();
    let page = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": "s3"}),
        )
        .await
        .unwrap();
    assert_eq!(page["total"], 2, "{page}");
    assert_eq!(channel_ids(&page), vec!["3", "5"]);

    let cats = r
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({"sourceId": "s3", "contentType": "live"}),
        )
        .await
        .unwrap();
    let cats: Vec<(String, i64)> = cats
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_str().unwrap().to_string(),
                c["itemCount"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(cats, vec![("uk".into(), 1), ("mix".into(), 1)]);

    let hits = r
        .dispatch(
            env.state.clone(),
            "catalog.search",
            json!({"query": "news"}),
        )
        .await
        .unwrap();
    let live_hits: Vec<_> = hits["live"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["ref"]["itemId"].as_str().unwrap().to_string())
        .collect();
    assert!(live_hits.contains(&"5".to_string()), "{hits}");
    assert!(!live_hits.contains(&"4".to_string()), "{hits}");

    let all_live = r
        .dispatch(
            env.state.clone(),
            "catalog.allLiveChannels",
            json!({"sourceId": "s3"}),
        )
        .await
        .unwrap();
    assert_eq!(all_live.as_array().unwrap().len(), 2, "{all_live}");

    // Movies: the |FR| title goes, the untagged one stays.
    let movies = r
        .dispatch(
            env.state.clone(),
            "catalog.movies",
            json!({"sourceId": "s2", "query": {}}),
        )
        .await
        .unwrap();
    assert_eq!(channel_ids(&movies), vec!["x2"]);

    set(false).await.unwrap();
    let page = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": "s3"}),
        )
        .await
        .unwrap();
    assert_eq!(page["total"], 6);
}

/// The Live TV quality filter (`liveMinQuality`, `liveHideUntagged`) at every
/// minimum, with untagged channels kept and hidden: the live list, its total,
/// a group page, in-list search, categories (counts filtered, groups left
/// empty dropped), `catalog.search`, allLiveChannels, neighbors and
/// channelByNumber leave out the live channels whose name marks a lower
/// quality. Radio and movies are never filtered, and the untagged toggle does
/// nothing without a minimum.
#[tokio::test]
async fn live_quality_filter_applies_to_every_live_reader() {
    use iptv_core::catalog::quality::QualityFilter;
    use iptv_core::live::matcher::{self, Quality};
    use serde_json::Value;

    // Item id (also number and position), group, title.
    const CHANNELS: [(&str, &str, &str); 9] = [
        ("1", "sd", "BBC One SD"),
        ("2", "sd", "Channel 5 SD"),
        ("3", "hd", "BBC Two HD"),
        ("4", "hd", "ITV 720p"),
        ("5", "fhd", "Sky Sports FHD"),
        ("6", "fhd", "Eurosport 1080p"),
        ("7", "uhd", "Sky Cinema 4K"),
        ("8", "plain", "CNN"),
        ("9", "plain", "Al Jazeera"),
    ];
    const GROUPS: [&str; 5] = ["sd", "hd", "fhd", "uhd", "plain"];
    let env = env().await;
    seed(&env).await;
    bare_source(&env.state, "s3").await;
    env.state
        .db_call(|c| {
            let groups: Vec<CategoryRow> = (0..).zip(GROUPS).map(|(i, g)| cat(g, g, i)).collect();
            let mut items = (1..)
                .zip(CHANNELS)
                .map(|(n, (id, group, title))| live("s3", id, group, title, n));
            catalog::replace_catalog(c, "s3", ContentType::Live, &groups, &mut items)?;
            // Radio is never filtered; r1 shares its number with "BBC One SD".
            let radio = |id: &str, title: &str, number: i64| ItemRow {
                content_type: ContentType::Radio,
                is_radio: true,
                ..live("s3", id, "r", title, number)
            };
            let stations = [radio("r1", "Radio One SD", 1), radio("r2", "Jazz FM", 20)];
            let radio_groups = [cat("r", "Radio", 0)];
            let mut stations = stations.into_iter();
            catalog::replace_catalog(c, "s3", ContentType::Radio, &radio_groups, &mut stations)
        })
        .await
        .unwrap();
    let mut r = router();
    iptv_core::settings::rpc::register(&mut r);
    let call = |method: &'static str, args: Value| {
        let r = &r;
        let state = env.state.clone();
        async move {
            r.dispatch(state, method, args)
                .await
                .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        }
    };
    let item_ids = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap_or_else(|| panic!("not an array: {v}"))
            .iter()
            .map(|c| c["ref"]["itemId"].as_str().unwrap().to_string())
            .collect()
    };

    // (liveMinQuality, liveHideUntagged, the ids of the live channels left)
    let cases = [
        (None, false, "123456789"),
        (Some(Quality::Sd), false, "123456789"),
        (Some(Quality::Sd), true, "1234567"),
        (Some(Quality::Hd), false, "3456789"),
        (Some(Quality::Hd), true, "34567"),
        (Some(Quality::Fhd), false, "56789"),
        (Some(Quality::Fhd), true, "567"),
        (Some(Quality::Uhd), false, "789"),
        (Some(Quality::Uhd), true, "7"),
        // The toggle alone filters nothing.
        (None, true, "123456789"),
    ];
    for (min, hide, left) in cases {
        call(
            "settings.update",
            json!({"patch": {"liveMinQuality": min, "liveHideUntagged": hide}}),
        )
        .await;
        let label = format!("liveMinQuality {min:?}, liveHideUntagged {hide}");
        // The table follows the matcher's markers.
        let filter = min.map(|min| QualityFilter {
            min,
            hide_untagged: hide,
        });
        let rule: String = CHANNELS
            .iter()
            .filter(|(_, _, title)| filter.is_none_or(|f| f.keeps(matcher::quality(title))))
            .map(|(id, _, _)| *id)
            .collect();
        assert_eq!(rule, left, "{label}: the matcher's verdicts");
        let kept = |ids: &[&str]| -> Vec<String> {
            ids.iter()
                .filter(|id| left.contains(**id))
                .map(|id| id.to_string())
                .collect()
        };
        let visible: Vec<String> = left.chars().map(String::from).collect();

        // The list and its total, a group page and an in-list search.
        let page = call("catalog.channels", json!({"sourceId": "s3"})).await;
        assert_eq!(page["total"], visible.len(), "{label}");
        assert_eq!(item_ids(&page["items"]), visible, "{label}");
        let args = json!({"sourceId": "s3", "categoryId": "hd"});
        let group = call("catalog.channels", args).await;
        assert_eq!(item_ids(&group["items"]), kept(&["3", "4"]), "{label}");
        assert_eq!(group["total"], kept(&["3", "4"]).len(), "{label}");
        let args = json!({"sourceId": "s3", "query": {"search": "bbc"}});
        let found = call("catalog.channels", args).await;
        assert_eq!(item_ids(&found["items"]), kept(&["1", "3"]), "{label}");

        // Categories: filtered counts, emptied groups dropped.
        let args = json!({"sourceId": "s3", "contentType": "live"});
        let cats = call("catalog.categories", args).await;
        let cats: Vec<(String, i64)> = cats
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["id"].as_str().unwrap().to_string(),
                    c["itemCount"].as_i64().unwrap(),
                )
            })
            .collect();
        let want: Vec<(String, i64)> = GROUPS
            .iter()
            .map(|g| {
                let n = CHANNELS
                    .iter()
                    .filter(|(id, group, _)| group == g && left.contains(id))
                    .count();
                (g.to_string(), n as i64)
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        assert_eq!(cats, want, "{label}");

        // Global search: live hits follow, radio hits stay.
        let args = json!({"query": "sky", "sourceId": "s3"});
        let hits = call("catalog.search", args).await;
        let mut sky = item_ids(&hits["live"]);
        sky.sort();
        assert_eq!(sky, kept(&["5", "7"]), "{label}");
        let args = json!({"query": "radio", "sourceId": "s3"});
        let hits = call("catalog.search", args).await;
        assert_eq!(item_ids(&hits["live"]), ["r1"], "{label}");

        // The zap list, and zapping from channel 1 (which the filter may
        // drop itself: its neighbours are the first and last channels left).
        let all = call("catalog.allLiveChannels", json!({"sourceId": "s3"})).await;
        assert_eq!(item_ids(&all), visible, "{label}");
        let first = json!({"sourceId": "s3", "contentType": "live", "itemId": "1"});
        let n = call("catalog.neighbors", json!({"ref": first})).await;
        let others = kept(&["2", "3", "4", "5", "6", "7", "8", "9"]);
        let next = n["next"]["ref"]["itemId"].as_str();
        assert_eq!(next, others.first().map(String::as_str), "{label}");
        let prev = n["prev"]["ref"]["itemId"].as_str();
        assert_eq!(prev, others.last().map(String::as_str), "{label}");

        // Number entry: a dropped live channel answers null, or the radio
        // station with its number when the type is not given.
        for (number, (id, _, title)) in (1..).zip(CHANNELS) {
            let args = json!({"sourceId": "s3", "number": number});
            let ch = call("catalog.channelByNumber", args).await;
            let want = if left.contains(id) {
                Some(title)
            } else if number == 1 {
                Some("Radio One SD")
            } else {
                None
            };
            assert_eq!(ch["name"].as_str(), want, "{label}: number {number}");
        }
        let args = json!({"sourceId": "s3", "number": 1, "contentType": "live"});
        let ch = call("catalog.channelByNumber", args).await;
        assert_eq!(ch.is_null(), !left.contains('1'), "{label}");

        // Radio and movies ("Heat [4K]" among them) are never filtered.
        let args = json!({"sourceId": "s3", "radio": true});
        let radio = call("catalog.channels", args).await;
        assert_eq!(item_ids(&radio["items"]), ["r1", "r2"], "{label}");
        let args = json!({"sourceId": "s3", "contentType": "radio"});
        let radio_groups = call("catalog.categories", args).await;
        assert_eq!(radio_groups[0]["itemCount"], 2, "{label}");
        let movies = call("catalog.movies", json!({"sourceId": "s1", "query": {}})).await;
        assert_eq!(movies["total"], 3, "{label}");
    }
}

/// A TMDB brief of the "More like this" / "Known for" lookup.
#[derive(Clone, Copy, Debug)]
struct Brief {
    title: &'static str,
    year: Option<i64>,
    tmdb: Option<i64>,
}

fn brief(title: &'static str, year: Option<i64>, tmdb: Option<i64>) -> Brief {
    Brief { title, year, tmdb }
}

/// The UI's `fold` (src/features/vod/hooks/useCatalogMatches.ts): lower
/// case, no accents, letters and digits only.
fn fold(s: &str) -> String {
    iptv_core::tmdb::normalize::strip_diacritics(&s.to_lowercase())
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// The UI's `matchBrief`, ported: the hit with the brief's TMDB id, else the
/// first whose folded base title equals the brief's, years at most one apart
/// (or unknown on a side). Answers the hit's item id.
fn match_brief(b: &Brief, hits: &[serde_json::Value]) -> Option<String> {
    let id = |h: &serde_json::Value| h["ref"]["itemId"].as_str().unwrap().to_string();
    if let Some(h) = hits
        .iter()
        .find(|h| h["tmdbId"].as_i64().is_some() && h["tmdbId"].as_i64() == b.tmdb)
    {
        return Some(id(h));
    }
    let want = fold(b.title);
    if want.is_empty() {
        return None;
    }
    hits.iter()
        .find(|h| {
            let base = h["titleBase"]
                .as_str()
                .filter(|t| !t.is_empty())
                .or(h["title"].as_str())
                .unwrap_or("");
            fold(base) == want
                && match (b.year, h["year"].as_i64()) {
                    (Some(a), Some(y)) => (a - y).abs() <= 1,
                    _ => true,
                }
        })
        .map(id)
}

fn ids_of(hits: &[serde_json::Value]) -> Vec<String> {
    hits.iter()
        .map(|h| h["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

/// F4-3: `catalog.matchTitles` replaces one `catalog.search` per TMDB title
/// (limit 8, the source, the one type) for the "More like this" and "Known
/// for" rails. For every brief the UI's matcher must pick the same title
/// from its lists as from the searches: base titles the source has, accents
/// and punctuation (through the word-prefix pass), a remake under another
/// base title found by its TMDB id, a year too far off, titles the source
/// lacks, and the filters (hidden groups, parental locks, English-only).
/// Without base-title rows a list is exactly the search's word-prefix
/// hits; the substring pass is gone, and only ever found in-word matches,
/// which the matcher rejects.
#[tokio::test]
async fn match_titles_picks_what_the_search_lookup_picked() {
    let env = env().await;
    bare_source(&env.state, "s1").await;
    bare_source(&env.state, "s2").await;
    env.state
        .db_call(|c| {
            let film = |id: &str, cat: &str, title: &str, tmdb: Option<i64>| ItemRow {
                category_id: cat.into(),
                extra: tmdb.map_or(json!({}), |t| json!({ "tmdbId": t })),
                ..movie("s1", id, title, None, None)
            };
            let mut films = vec![
                film("heat95", "m", "EN - Heat (1995)", None),
                film("heat86", "m", "Heat (1986)", None),
                film("heated", "m", "Heated (2010)", None),
                film("amelie", "m", "Amelie (2001)", None),
                film("spidey", "m", "Spider-Man: Homecoming (2017)", None),
                film("dune84", "m", "Dune (1984)", Some(841)),
                film("dune21", "m", "Dune: Part One (2021)", Some(438631)),
                film("matrix", "m", "The Matrix (1999)", None),
                film("thing", "m", "The Thing (1982)", None),
                film("others", "m", "The Others (2001)", None),
                film("ronin", "h", "Ronin (1998)", None),
                film("up", "m", "Up (2009)", None),
                film("lemans", "fr", "FR - Le Mans 66 (2019)", None),
            ]
            .into_iter();
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Movie,
                &[
                    cat("m", "Movies", 0),
                    cat("h", "Hidden", 1),
                    cat("fr", "FRANCE | FILMS", 2),
                ],
                &mut films,
            )?;
            let mut shows = std::iter::once(ItemRow {
                content_type: ContentType::Series,
                ..movie("s1", "dark", "Dark (2017)", None, None)
            });
            catalog::replace_catalog(
                c,
                "s1",
                ContentType::Series,
                &[cat("m", "Shows", 0)],
                &mut shows,
            )?;
            // Another source's titles never answer.
            let mut other = std::iter::once(movie("s2", "x", "Heat (1995)", None, None));
            catalog::replace_catalog(
                c,
                "s2",
                ContentType::Movie,
                &[cat("m", "Films", 0)],
                &mut other,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let r = iptv_core::rpc::build_router();
    let call = |cmd: &'static str, args: serde_json::Value| {
        let (r, env) = (&r, &env);
        async move {
            r.dispatch(env.state.clone(), cmd, args)
                .await
                .unwrap_or_else(|e| panic!("{cmd}: {}", e.message))
        }
    };
    call(
        "catalog.setCategoriesHidden",
        json!({"sourceId": "s1", "contentType": "movie", "hiddenIds": ["h"]}),
    )
    .await;

    let movies = [
        brief("Heat", Some(1995), Some(949)),
        brief("Heat", Some(1986), None),
        brief("heat", None, None),
        brief("Amélie", Some(2001), Some(194)),
        brief("Spider-Man Homecoming", Some(2017), Some(315635)),
        brief("Dune", Some(2021), Some(438631)),
        brief("Dune", Some(1984), Some(841)),
        brief("The Matrix", Some(1999), Some(603)),
        brief("Ronin", Some(1998), Some(8195)),
        brief("Up", Some(2009), Some(14160)),
        brief("Le Mans 66", Some(2019), Some(359724)),
        brief("Nothing Like It", Some(2020), Some(1)),
        brief("atrix", None, None),
        brief("  ", None, None),
    ];
    let shows = [
        brief("Dark", Some(2017), Some(70523)),
        brief("Dark", Some(2010), None),
    ];
    // Runs both lookups for every brief: the old one (a search per title)
    // and the new one (one matchTitles per kind). Answers the new lists and
    // the matcher's pick from them, which must be the old pick.
    let lookups = |label: &'static str| {
        let call = &call;
        let (movies, shows) = (&movies, &shows);
        async move {
            let mut lists = Vec::new();
            let mut picks = Vec::new();
            for (kind, key, briefs) in [
                ("movie", "movies", &movies[..]),
                ("series", "series", &shows[..]),
            ] {
                let titles: Vec<_> = briefs
                    .iter()
                    .map(|b| json!({"title": b.title, "year": b.year, "tmdbId": b.tmdb}))
                    .collect();
                let new = call(
                    "catalog.matchTitles",
                    json!({"sourceId": "s1", "contentType": kind, "titles": titles}),
                )
                .await;
                let new = new.as_array().unwrap();
                assert_eq!(new.len(), briefs.len(), "{label}: one list per title");
                for (b, list) in briefs.iter().zip(new) {
                    let list = list.as_array().unwrap().clone();
                    for h in &list {
                        assert_eq!(h["ref"]["sourceId"], "s1", "{label}: {b:?}");
                        assert_eq!(h["ref"]["contentType"], kind, "{label}: {b:?}");
                    }
                    let old = call(
                        "catalog.search",
                        json!({"query": b.title, "sourceId": "s1", "contentTypes": [kind], "limit": 8}),
                    )
                    .await;
                    let old = old[key].as_array().unwrap().clone();
                    let pick = match_brief(b, &list);
                    assert_eq!(pick, match_brief(b, &old), "{label}: {b:?}");
                    picks.push(pick);
                    lists.push((ids_of(&list), ids_of(&old)));
                }
            }
            (lists, picks)
        }
    };
    let some = |id: &str| Some(id.to_string());

    let (lists, picks) = lookups("nothing locked").await;
    assert_eq!(
        picks,
        [
            some("heat95"),
            some("heat86"),
            some("heat86"),
            some("amelie"),
            some("spidey"),
            some("dune21"),
            some("dune84"),
            some("matrix"),
            None,
            some("up"),
            some("lemans"),
            None,
            None,
            None,
            some("dark"),
            None,
        ]
    );
    // Base-title rows first, shortest title first; enough to settle Heat.
    assert_eq!(lists[0].0, ["heat86", "heat95"]);
    // No base-title row: exactly the search's word-prefix hits.
    assert_eq!(lists[3].0, lists[3].1, "Amélie");
    assert_eq!(lists[4].0, lists[4].1, "Spider-Man Homecoming");
    // Dune (1984) has another TMDB id than Dune 2021: the ranked hits follow.
    assert_eq!(lists[5].0[0], "dune84");
    assert!(lists[5].0.contains(&"dune21".to_string()), "{:?}", lists[5]);
    // A title the source lacks, an in-word fragment, a blank title.
    assert!(lists[11].0.is_empty() && lists[11].1.is_empty());
    assert!(lists[12].0.is_empty(), "no substring pass: {:?}", lists[12]);
    assert_eq!(lists[12].1, ["matrix"], "the search's substring hit");
    assert!(lists[13].0.is_empty());

    // Parental Hide mode and English-only drop the same titles from both.
    call("parental.setPin", json!({"newPin": "2580"})).await;
    call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "movie", "kind": "item", "targetId": "up", "name": "Up"}, "locked": true}),
    )
    .await;
    call("settings.update", json!({"patch": {"englishOnly": true}})).await;
    let (_, picks) = lookups("locked, English only").await;
    assert_eq!((&picks[9], &picks[10]), (&None, &None), "{picks:?}");
    assert_eq!(picks[0], some("heat95"));

    // Arguments.
    let fail = |args: serde_json::Value| {
        let (r, env) = (&r, &env);
        async move {
            r.dispatch(env.state.clone(), "catalog.matchTitles", args)
                .await
                .unwrap_err()
                .code
        }
    };
    assert_eq!(
        fail(json!({"sourceId": "s1", "contentType": "live", "titles": []})).await,
        iptv_core::RpcErrorCode::Invalid
    );
    let many: Vec<_> = (0..=iptv_core::catalog::rpc::MAX_MATCH_TITLES)
        .map(|i| json!({ "title": format!("Title {i}") }))
        .collect();
    assert_eq!(
        fail(json!({"sourceId": "s1", "contentType": "movie", "titles": many})).await,
        iptv_core::RpcErrorCode::Invalid
    );
    let lists = call(
        "catalog.matchTitles",
        json!({"sourceId": "s1", "contentType": "movie", "titles": many[1..]}),
    )
    .await;
    assert_eq!(lists.as_array().unwrap().len(), 40);
}
