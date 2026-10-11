//! Catalog (B1): replace_catalog, paging, sort, search (FTS and LIKE
//! fallback), hidden categories, channelByNumber, neighbors, sameTitle,
//! recentlyAdded, allLiveChannels, and the `catalog.*` rpc names.

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
        "catalog.allLiveChannels",
        "sources.list",
        "sources.get",
        "sources.add",
        "sources.update",
        "sources.remove",
        "sources.reorder",
        "sources.refresh",
        "sources.refreshAll",
        "sources.counts",
        "m3u.raw",
        "m3u.parsePreview",
    ] {
        assert!(r.contains(name), "{name} missing");
    }
}
