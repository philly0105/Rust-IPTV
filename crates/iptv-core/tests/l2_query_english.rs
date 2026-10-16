//! Loop 2 (L2-perf-core-1, L2-perf-core-3, L2-perf-core-5): English-only
//! reads the verdict the catalog writer stores (`items.non_english`,
//! migration 0018) instead of a per-connection cache that every database
//! write dropped. These tests pin that the stored verdict is exactly the
//! Rust rule (`is_non_english`) for every row, that catalogs written before
//! the migration answer correctly while pending and after the backfill, and
//! that the reworked readers (page rowid subselect, one-pass global search)
//! return the same rows as the plain statements.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::language::{backfill_pending, is_non_english};
use serde_json::{json, Value};
use support::*;

const CHANNELS: usize = 3_000;
const GROUPS: usize = 40;

fn group(g: usize) -> String {
    match g % 6 {
        0 => format!("FR | Groupe {g}"),
        1 => format!("UK | Group {g}"),
        2 => format!("Новости {g}"),
        3 => format!("VOD - SPAIN [ES] {g}"),
        _ => format!("Group {g}"),
    }
}

fn title(i: usize) -> String {
    match i % 11 {
        0 => format!("Канал {i}"),
        1 => format!("DE - Channel {i}"),
        2 => format!("EN - Channel {i}"),
        3 => format!("UK: Channel {i}"),
        4 => format!("It: Chapter {i}"),
        5 => format!("مسلسل {i}"),
        _ => format!("Channel {i}"),
    }
}

fn playlist() -> String {
    use std::fmt::Write as _;
    let mut s = String::from("#EXTM3U\n");
    for i in 0..CHANNELS {
        let _ = write!(
            s,
            "#EXTINF:-1 tvg-id=\"c{i}\" group-title=\"{}\",{}\nhttp://stream.example/{i}.ts\n",
            group(i % GROUPS),
            title(i)
        );
    }
    s
}

/// Rows whose stored verdict differs from the Rust rule.
async fn wrong_verdicts(state: &std::sync::Arc<iptv_core::AppState>, sid: &str) -> Vec<String> {
    let sid = sid.to_owned();
    state
        .db_call(move |c| {
            let mut stmt = c.prepare(
                "SELECT i.title, c.name, i.non_english FROM items i LEFT JOIN categories c ON c.source_id = i.source_id AND c.content_type = i.content_type AND c.category_id = i.category_id WHERE i.source_id = ?1",
            )?;
            let rows = stmt
                .query_map([sid], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows
                .into_iter()
                .filter(|(t, c, stored)| is_non_english(t, c.as_deref()) != *stored)
                .map(|(t, c, stored)| format!("{t:?} in {c:?}: stored {stored}"))
                .collect())
        })
        .await
        .unwrap()
}

fn expected_visible() -> i64 {
    (0..CHANNELS)
        .filter(|i| !is_non_english(&title(*i), Some(&group(i % GROUPS))))
        .count() as i64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stored_verdicts_follow_the_rule_before_and_after_the_backfill() {
    let env = env().await;
    let r = iptv_core::rpc::build_router();
    let src = add_text(&env.state, "mixed", &playlist()).await;
    let sid = src.id.clone();
    let call = |method: &'static str, args: Value| {
        let r = &r;
        let state = env.state.clone();
        async move {
            r.dispatch(state, method, args)
                .await
                .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        }
    };

    // The writer stores the rule's answer for every row.
    let wrong = wrong_verdicts(&env.state, &sid).await;
    assert!(
        wrong.is_empty(),
        "{} wrong: {:?}",
        wrong.len(),
        &wrong[..wrong.len().min(5)]
    );

    let visible = expected_visible();
    assert!(visible > 0 && visible < CHANNELS as i64, "{visible}");
    call("settings.update", json!({"patch": {"englishOnly": true}})).await;
    let total = |v: &Value| v["total"].as_i64().unwrap();
    let page = call("catalog.channels", json!({"sourceId": sid})).await;
    assert_eq!(total(&page), visible);
    // Any other write (the UI writes settings on every navigation) changes
    // nothing.
    call("settings.update", json!({"patch": {"lastRoute": "/live"}})).await;
    let page = call("catalog.channels", json!({"sourceId": sid})).await;
    assert_eq!(total(&page), visible);
    let cats = call(
        "catalog.categories",
        json!({"sourceId": sid, "contentType": "live"}),
    )
    .await;
    let counted: i64 = cats
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["itemCount"].as_i64().unwrap())
        .sum();
    assert_eq!(counted, visible, "{cats}");

    // A catalog written before migration 0018: verdicts all 0, pending.
    let s2 = sid.clone();
    env.state
        .db_call(move |c| {
            c.execute(
                "UPDATE items SET non_english = 0 WHERE source_id = ?1",
                [&s2],
            )?;
            c.execute(
                "INSERT INTO english_pending (source_id, content_type) VALUES (?1, 'live')",
                [&s2],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    // Readers fall back to the per-row rule while pending.
    let page = call("catalog.channels", json!({"sourceId": sid})).await;
    assert_eq!(total(&page), visible, "pending");
    let found = call("catalog.search", json!({"query": "Channel"})).await;
    for ch in found["live"].as_array().unwrap() {
        let name = ch["name"].as_str().unwrap();
        let cat = ch["categoryName"].as_str();
        assert!(
            !is_non_english(name, cat),
            "search kept {name:?} in {cat:?}"
        );
    }
    // The boot backfill stores them and clears the pending row.
    let done = env
        .state
        .db_call(|c| Ok(backfill_pending(c)?))
        .await
        .unwrap();
    assert_eq!(done, 1);
    let wrong = wrong_verdicts(&env.state, &sid).await;
    assert!(wrong.is_empty(), "after backfill: {wrong:?}");
    let pending: i64 = env
        .state
        .db_call(|c| Ok(c.query_row("SELECT count(*) FROM english_pending", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(pending, 0);
    let page = call("catalog.channels", json!({"sourceId": sid})).await;
    assert_eq!(total(&page), visible, "after backfill");
    // Search with the stored verdict drops the same rows.
    let found = call("catalog.search", json!({"query": "Channel", "limit": 1000})).await;
    let live = found["live"].as_array().unwrap();
    assert!(!live.is_empty());
    for ch in live {
        let name = ch["name"].as_str().unwrap();
        let cat = ch["categoryName"].as_str();
        assert!(
            !is_non_english(name, cat),
            "search kept {name:?} in {cat:?}"
        );
    }
}

/// Pages read through the rowid subselect hold exactly the rows (and order)
/// of the plain ORDER BY ... LIMIT ... OFFSET statement, for every sort and
/// at the end of the list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deep_pages_match_the_plain_statement() {
    let env = env().await;
    let r = router();
    let src = add_text(&env.state, "plain", &playlist()).await;
    let sid = src.id.clone();
    for (sort, dir, order) in [
        (None, None, "position"),
        (
            Some("name"),
            Some("desc"),
            "title COLLATE NOCASE DESC, position",
        ),
        (
            Some("number"),
            Some("asc"),
            "number ASC NULLS LAST, position",
        ),
    ] {
        for offset in [0usize, 1_234, CHANNELS - 37] {
            let mut query = json!({"offset": offset, "limit": 50});
            if let Some(s) = sort {
                query["sort"] = json!(s);
            }
            if let Some(d) = dir {
                query["dir"] = json!(d);
            }
            let page = r
                .dispatch(
                    env.state.clone(),
                    "catalog.channels",
                    json!({"sourceId": sid, "query": query}),
                )
                .await
                .unwrap();
            let got: Vec<String> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["ref"]["itemId"].as_str().unwrap().to_owned())
                .collect();
            let s2 = sid.clone();
            let sql = format!(
                "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' ORDER BY {order} LIMIT 50 OFFSET {offset}"
            );
            let want: Vec<String> = env
                .state
                .db_call(move |c| {
                    let mut stmt = c.prepare(&sql)?;
                    let rows = stmt
                        .query_map([s2], |r| r.get(0))?
                        .collect::<Result<Vec<String>, _>>()?;
                    Ok(rows)
                })
                .await
                .unwrap();
            assert_eq!(got, want, "sort {sort:?} {dir:?} at {offset}");
        }
    }
}

/// One `catalog.search` answers each list as a search of that list alone
/// would: word-prefix matches ranked per type, the substring fallback only
/// for a list the prefix match found nothing for. The reference is the
/// statement pair each list ran on its own before loop 2.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_pass_search_matches_per_type_search() {
    use iptv_core::catalog::{fts_query, like_pattern};
    let env = env().await;
    let r = router();
    add_text(&env.state, "plain", &playlist()).await;
    for q in ["chan", "channel 12", "hann", "zzzz", "12", "de"] {
        let all = r
            .dispatch(
                env.state.clone(),
                "catalog.search",
                json!({"query": q, "limit": 40}),
            )
            .await
            .unwrap();
        let got: Vec<String> = all["live"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["ref"]["itemId"].as_str().unwrap().to_owned())
            .collect();
        let q2 = q.to_owned();
        let want: Vec<String> = env
            .state
            .db_call(move |c| {
                let ids = |sql: &str, arg: String| -> rusqlite::Result<Vec<String>> {
                    let mut stmt = c.prepare(sql)?;
                    let rows = stmt.query_map([arg], |r| r.get(0))?;
                    rows.collect()
                };
                let mut rows = match fts_query(&q2) {
                    Some(fq) => ids(
                        "SELECT i.item_id FROM items i JOIN items_fts ON items_fts.rowid = i.rowid WHERE items_fts MATCH ?1 AND i.content_type IN ('live', 'radio') ORDER BY items_fts.rank, length(i.title), i.position LIMIT 40",
                        fq,
                    )?,
                    None => Vec::new(),
                };
                if rows.is_empty() {
                    rows = ids(
                        "SELECT i.item_id FROM items i WHERE i.title LIKE ?1 ESCAPE '\\' AND i.content_type IN ('live', 'radio') ORDER BY length(i.title), i.title COLLATE NOCASE LIMIT 40",
                        like_pattern(&q2),
                    )?;
                }
                Ok(rows)
            })
            .await
            .unwrap();
        assert_eq!(got, want, "{q}");
        assert!(all["movies"].as_array().unwrap().is_empty(), "{q}");
    }
}
