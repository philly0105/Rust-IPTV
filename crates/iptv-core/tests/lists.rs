//! Custom lists (`lists.*`, Run 2 contract C3) through the full router:
//! create / rename / remove / reorder validation, the 50-list and
//! 2000-channel limits, item order and availability, hidden channels,
//! `lists.neighbors`, events, and source removal.

use iptv_core::error::RpcErrorCode;
use iptv_core::lists::{CHANGED_EVENT, MAX_ITEMS, MAX_LISTS, MAX_NAME_CHARS};
use iptv_core::rpc::{build_router, RpcRouter};
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

/// Source `s1` has live channels 101 BBC One, 102 CNN, 103 Sky News (category
/// 1 "News"), radio 501 Jazz FM and movie 201; source `s2` has live 7
/// Eurosport.
async fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(4096);
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
            c.execute(
                "INSERT INTO categories(source_id, content_type, category_id, name) VALUES ('s1', 'live', '1', 'News')",
                [],
            )?;
            for (sid, ct, id, title, pos) in [
                ("s1", "live", "101", "BBC One", 0),
                ("s1", "live", "102", "CNN", 1),
                ("s1", "live", "103", "Sky News", 2),
                ("s1", "radio", "501", "Jazz FM", 3),
                ("s1", "movie", "201", "Film", 4),
                ("s2", "live", "7", "Eurosport", 0),
            ] {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, logo_url, url, position, is_radio)
                     VALUES (?1, ?2, ?3, '1', ?4, ?5, ?6, ?7, ?8)",
                    params![
                        sid,
                        ct,
                        id,
                        title,
                        format!("http://logo/{id}.png"),
                        format!("http://stream/{id}.ts"),
                        pos,
                        ct == "radio"
                    ],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    App {
        _dir: dir,
        state,
        router: build_router(),
        events,
    }
}

fn rf(source: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": source, "contentType": ct, "itemId": id})
}

fn live(source: &str, id: &str) -> Value {
    rf(source, "live", id)
}

fn new_item(r: Value, title: &str) -> Value {
    let ct = r["contentType"].clone();
    json!({"ref": r, "snapshot": {"title": title, "contentType": ct, "posterUrl": format!("http://snap/{title}.png")}})
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

    async fn create(&self, name: &str, items: Vec<Value>) -> String {
        let v = self
            .call("lists.create", json!({"name": name, "items": items}))
            .await;
        v["id"].as_str().unwrap().to_string()
    }

    async fn lists(&self) -> Vec<Value> {
        self.call("lists.list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    async fn names(&self) -> Vec<String> {
        self.lists()
            .await
            .iter()
            .map(|l| l["name"].as_str().unwrap().to_string())
            .collect()
    }

    async fn items(&self, id: &str) -> Vec<Value> {
        self.call("lists.items", json!({"id": id}))
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    /// Item ids of a list, in order.
    async fn item_ids(&self, id: &str) -> Vec<String> {
        self.items(id)
            .await
            .iter()
            .map(|e| e["ref"]["itemId"].as_str().unwrap().to_string())
            .collect()
    }

    /// Every stored item id of a list in list order, hidden ones included.
    async fn stored_ids(&self, id: &str) -> Vec<String> {
        let id = id.to_string();
        self.state
            .db_call(move |c| {
                let mut stmt = c.prepare(
                    "SELECT item_id FROM custom_list_items WHERE list_id = ?1 ORDER BY position, rowid",
                )?;
                let ids = stmt
                    .query_map([id], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                Ok(ids)
            })
            .await
            .unwrap()
    }

    async fn add(&self, id: &str, items: Vec<Value>) -> i64 {
        self.call("lists.addItems", json!({"id": id, "items": items}))
            .await["added"]
            .as_i64()
            .unwrap()
    }

    /// `(prev, next)` item ids around `r`.
    async fn neighbors(&self, id: &str, r: Value) -> (Option<String>, Option<String>) {
        let v = self
            .call("lists.neighbors", json!({"id": id, "ref": r}))
            .await;
        let pick = |k: &str| {
            v.get(k)
                .map(|c| c["ref"]["itemId"].as_str().unwrap().to_string())
        };
        (pick("prev"), pick("next"))
    }

    /// `lists.changed` events received since the last call.
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

    async fn sql(&self, sql: &'static str) {
        self.state
            .db_call(move |c| {
                c.execute_batch(sql)?;
                Ok(())
            })
            .await
            .unwrap();
    }
}

fn s(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn create_rename_remove_and_reorder_validate_their_input() {
    let mut a = app().await;
    let sports = a.call("lists.create", json!({"name": "  Sports  "})).await;
    assert_eq!(sports["name"], "Sports", "names are trimmed");
    assert_eq!(sports["position"], 0);
    assert_eq!(
        sports["onDashboard"], true,
        "new lists show on the dashboard"
    );
    assert_eq!(sports["itemCount"], 0);
    assert!(sports["createdAt"].as_str().unwrap().ends_with('Z'));
    let sid = sports["id"].as_str().unwrap().to_string();
    assert_eq!(sid.len(), 36, "uuid: {sid}");
    assert_eq!(&sid[14..15], "4", "uuid v4: {sid}");
    let news = a.create("News", vec![]).await;
    assert_eq!(a.names().await, ["Sports", "News"], "new lists go last");
    assert_eq!(a.changes(), 2);

    // create: empty or too long -> invalid; same name in any case -> conflict.
    for bad in [
        json!({"name": ""}),
        json!({"name": "   "}),
        json!({"name": "x".repeat(MAX_NAME_CHARS + 1)}),
        json!({"name": "two\nlines"}),
        json!({}),
        json!({"name": "Films", "items": [new_item(rf("s1", "movie", "201"), "Film")]}),
        json!({"name": "Films", "items": [new_item(live("s1", "101"), "  ")]}),
    ] {
        assert_eq!(
            a.fail("lists.create", bad.clone()).await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    for dup in ["sports", "SPORTS", " news "] {
        assert_eq!(
            a.fail("lists.create", json!({"name": dup})).await,
            RpcErrorCode::Conflict,
            "{dup}"
        );
    }
    let longest = "é".repeat(MAX_NAME_CHARS);
    let l = a.call("lists.create", json!({"name": longest})).await;
    assert_eq!(l["name"], longest, "60 characters, not bytes");
    a.call("lists.remove", json!({"id": l["id"]})).await;
    assert_eq!(a.changes(), 2, "failed calls emit nothing");

    // update: rename, case-only rename, dashboard flag, conflicts, unknown id.
    let v = a
        .call("lists.update", json!({"id": sid, "name": "Football"}))
        .await;
    assert_eq!(v["name"], "Football");
    assert!(v["updatedAt"].as_str().unwrap() >= sports["updatedAt"].as_str().unwrap());
    let v = a
        .call("lists.update", json!({"id": sid, "name": "FOOTBALL"}))
        .await;
    assert_eq!(
        v["name"], "FOOTBALL",
        "a case change of its own name is fine"
    );
    let v = a
        .call("lists.update", json!({"id": sid, "onDashboard": false}))
        .await;
    assert_eq!(v["onDashboard"], false);
    assert_eq!(a.changes(), 3);
    a.call("lists.update", json!({"id": sid, "onDashboard": false}))
        .await;
    a.call("lists.update", json!({"id": sid})).await;
    assert_eq!(
        a.changes(),
        0,
        "an update to the current values emits nothing"
    );
    assert_eq!(
        a.fail("lists.update", json!({"id": news, "name": "football"}))
            .await,
        RpcErrorCode::Conflict
    );
    assert_eq!(
        a.fail("lists.update", json!({"id": news, "name": " "}))
            .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(
        a.fail("lists.update", json!({"id": "nope", "name": "X"}))
            .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(
        a.fail("lists.update", json!({"id": "nope"})).await,
        RpcErrorCode::NotFound
    );
    let lists = a.lists().await;
    assert_eq!(lists[0]["onDashboard"], false);
    assert_eq!(lists[1]["onDashboard"], true);

    // reorder: a permutation of every id, else invalid.
    let third = a.create("Kids", vec![]).await;
    a.changes();
    for bad in [
        json!({"ids": [news, sid]}),
        json!({"ids": [news, sid, third, third]}),
        json!({"ids": [news, sid, "nope"]}),
        json!({"ids": [news, sid, third, "nope"]}),
        json!({"ids": []}),
        json!({}),
    ] {
        assert_eq!(
            a.fail("lists.reorder", bad.clone()).await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    a.call("lists.reorder", json!({"ids": [third, news, sid]}))
        .await;
    assert_eq!(a.names().await, ["Kids", "News", "FOOTBALL"]);
    let positions: Vec<i64> = a
        .lists()
        .await
        .iter()
        .map(|l| l["position"].as_i64().unwrap())
        .collect();
    assert_eq!(positions, [0, 1, 2]);
    assert_eq!(a.changes(), 1);

    // remove: the list goes; an unknown id is a no-op without an event.
    a.call("lists.remove", json!({"id": news})).await;
    assert_eq!(a.names().await, ["Kids", "FOOTBALL"]);
    a.call("lists.remove", json!({"id": news})).await;
    assert_eq!(a.changes(), 1);
    assert_eq!(
        a.fail("lists.items", json!({"id": news})).await,
        RpcErrorCode::NotFound
    );
    // A new list goes after the others, whatever positions are left.
    a.create("Late", vec![]).await;
    assert_eq!(a.names().await, ["Kids", "FOOTBALL", "Late"]);
}

#[tokio::test]
async fn fifty_lists_and_two_thousand_channels_are_the_limits() {
    let mut a = app().await;
    let mut ids = Vec::new();
    for n in 0..MAX_LISTS {
        ids.push(a.create(&format!("List {n}"), vec![]).await);
    }
    assert_eq!(
        a.fail("lists.create", json!({"name": "One too many"}))
            .await,
        RpcErrorCode::Invalid,
        "the 51st list"
    );
    assert_eq!(a.lists().await.len(), MAX_LISTS as usize);
    a.call("lists.remove", json!({"id": ids[0]})).await;
    a.create("One more", vec![]).await;
    a.changes();

    // 2000 channels per list; ids need not be in the catalog.
    let many = |from: i64, n: i64| -> Vec<Value> {
        (from..from + n)
            .map(|i| new_item(live("s1", &format!("x{i}")), &format!("X {i}")))
            .collect()
    };
    let too_many = many(0, MAX_ITEMS + 1);
    assert_eq!(
        a.fail("lists.create", json!({"name": "Huge", "items": too_many}))
            .await,
        RpcErrorCode::Invalid
    );
    let id = ids[1].clone();
    assert_eq!(a.add(&id, many(0, MAX_ITEMS - 1)).await, MAX_ITEMS - 1);
    // Over the limit: invalid and nothing written, even for the ones that fit.
    assert_eq!(
        a.fail(
            "lists.addItems",
            json!({"id": id, "items": many(MAX_ITEMS - 1, 2)})
        )
        .await,
        RpcErrorCode::Invalid
    );
    let count = |lists: Vec<Value>| {
        lists.iter().find(|l| l["id"] == json!(id)).unwrap()["itemCount"]
            .as_i64()
            .unwrap()
    };
    assert_eq!(count(a.lists().await), MAX_ITEMS - 1);
    // Channels already present do not count against the limit.
    assert_eq!(a.add(&id, many(MAX_ITEMS - 2, 2)).await, 1);
    assert_eq!(count(a.lists().await), MAX_ITEMS);
    assert_eq!(
        a.add(&id, many(0, 3)).await,
        0,
        "all present: nothing to add"
    );
    assert_eq!(
        a.fail("lists.addItems", json!({"id": id, "items": many(5000, 1)}))
            .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(a.changes(), 2, "two adds wrote, the rest did not");
    let ids_in_order = a.item_ids(&id).await;
    assert_eq!(ids_in_order.len(), MAX_ITEMS as usize);
    assert_eq!(ids_in_order[0], "x0");
    assert_eq!(
        ids_in_order[(MAX_ITEMS - 1) as usize],
        format!("x{}", MAX_ITEMS - 1)
    );
}

#[tokio::test]
async fn items_append_in_order_and_flag_unavailable_channels() {
    let mut a = app().await;
    let id = a
        .create(
            "Mix",
            vec![
                new_item(live("s1", "101"), "BBC One (saved)"),
                new_item(live("s2", "7"), "Eurosport"),
            ],
        )
        .await;
    let added = a
        .add(
            &id,
            vec![
                new_item(live("s1", "101"), "dup"),
                new_item(rf("s1", "radio", "501"), "Jazz FM"),
                new_item(live("s1", "999"), "Gone Channel"),
                new_item(rf("s1", "radio", "501"), "dup in the same call"),
            ],
        )
        .await;
    assert_eq!(added, 2, "present and repeated refs are ignored");
    assert_eq!(a.item_ids(&id).await, ["101", "7", "501", "999"]);
    let items = a.items(&id).await;
    assert_eq!(items[0]["available"], true);
    assert_eq!(
        items[0]["channel"]["name"], "BBC One",
        "the catalog channel"
    );
    assert_eq!(
        items[0]["snapshot"]["title"], "BBC One (saved)",
        "the stored snapshot"
    );
    assert_eq!(
        items[0]["snapshot"]["posterUrl"],
        "http://snap/BBC One (saved).png"
    );
    assert_eq!(items[0]["snapshot"]["contentType"], "live");
    assert_eq!(items[1]["channel"]["ref"], live("s2", "7"));
    assert_eq!(items[2]["channel"]["isRadio"], true);
    assert_eq!(items[3]["available"], false, "not in the catalog");
    assert!(items[3].get("channel").is_none());
    assert_eq!(items[3]["snapshot"]["title"], "Gone Channel");
    assert!(items[0]["addedAt"].as_str().unwrap().ends_with('Z'));
    let positions: Vec<i64> = items
        .iter()
        .map(|e| e["position"].as_i64().unwrap())
        .collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "{positions:?}");
    assert_eq!(a.lists().await[0]["itemCount"], 4, "unavailable ones count");
    assert_eq!(a.changes(), 2);

    // The provider drops a channel: it stays, greyed out.
    a.sql("DELETE FROM items WHERE source_id = 's2' AND item_id = '7'")
        .await;
    let items = a.items(&id).await;
    assert_eq!(items[1]["available"], false);
    assert_eq!(items[1]["snapshot"]["title"], "Eurosport");

    // Validation: movie refs, unknown lists and sources, malformed refs.
    assert_eq!(
        a.fail(
            "lists.addItems",
            json!({"id": id, "items": [new_item(rf("s1", "movie", "201"), "Film")]})
        )
        .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(
        a.fail(
            "lists.addItems",
            json!({"id": id, "items": [new_item(live("s1", "102"), "CNN"), new_item(rf("s1", "series", "3"), "S")]})
        )
        .await,
        RpcErrorCode::Invalid,
        "one bad item fails the call"
    );
    assert_eq!(
        a.fail(
            "lists.addItems",
            json!({"id": id, "items": [new_item(live("", "1"), "Blank")]})
        )
        .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(
        a.fail(
            "lists.addItems",
            json!({"id": id, "items": [new_item(live("nosuch", "1"), "X")]})
        )
        .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(
        a.fail(
            "lists.addItems",
            json!({"id": "nope", "items": [new_item(live("s1", "102"), "CNN")]})
        )
        .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(
        a.item_ids(&id).await,
        ["101", "7", "501", "999"],
        "nothing written"
    );
    assert_eq!(a.changes(), 0);

    // containing: list ids in list order; movies are in none.
    let other = a
        .create("Other", vec![new_item(live("s1", "101"), "BBC")])
        .await;
    let v = a
        .call("lists.containing", json!({"ref": live("s1", "101")}))
        .await;
    assert_eq!(s(&v), [id.clone(), other.clone()]);
    let v = a
        .call("lists.containing", json!({"ref": rf("s1", "radio", "501")}))
        .await;
    assert_eq!(s(&v), std::slice::from_ref(&id));
    let v = a
        .call("lists.containing", json!({"ref": rf("s1", "movie", "201")}))
        .await;
    assert_eq!(v, json!([]));
    a.call("lists.reorder", json!({"ids": [other, id]})).await;
    let v = a
        .call("lists.containing", json!({"ref": live("s1", "101")}))
        .await;
    assert_eq!(s(&v), [other.clone(), id.clone()], "follows the list order");
    a.changes();

    // removeItems: present refs go, absent ones are ignored.
    a.call(
        "lists.removeItems",
        json!({"id": id, "refs": [live("s1", "101"), live("s1", "555")]}),
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["7", "501", "999"]);
    a.call(
        "lists.removeItems",
        json!({"id": id, "refs": [live("s1", "101")]}),
    )
    .await;
    assert_eq!(a.changes(), 1, "removing nothing emits nothing");
    assert_eq!(
        a.fail("lists.removeItems", json!({"id": "nope", "refs": []}))
            .await,
        RpcErrorCode::NotFound
    );
    // Re-adding appends at the end.
    a.add(&id, vec![new_item(live("s1", "101"), "BBC One")])
        .await;
    assert_eq!(a.item_ids(&id).await, ["7", "501", "999", "101"]);

    // reorderItems: a ref the list does not hold or a repeated ref is
    // invalid, and nothing changes.
    let (r7, r501, r999, r101) = (
        live("s2", "7"),
        rf("s1", "radio", "501"),
        live("s1", "999"),
        live("s1", "101"),
    );
    a.changes();
    for bad in [
        json!([r7, r501, r999, r101, r101]),
        json!([r7, r7]),
        json!([r7, r501, r999, live("s1", "102")]),
        json!([r7, r501, r999, r101, live("s1", "102")]),
        json!([r7, r501, r999, rf("s1", "live", "501")]),
    ] {
        assert_eq!(
            a.fail("lists.reorderItems", json!({"id": id, "refs": bad.clone()}))
                .await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    assert_eq!(
        a.fail("lists.reorderItems", json!({"id": "nope", "refs": []}))
            .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(a.item_ids(&id).await, ["7", "501", "999", "101"]);
    assert_eq!(a.changes(), 0, "a refused reorder emits nothing");
    // A full permutation sets the whole order.
    a.call(
        "lists.reorderItems",
        json!({"id": id, "refs": [r101, r999, r7, r501]}),
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["101", "999", "7", "501"]);
    assert_eq!(a.changes(), 1);
    // Part of the list: the listed refs swap the slots they held (0 and 2),
    // the others stay.
    a.call("lists.reorderItems", json!({"id": id, "refs": [r7, r101]}))
        .await;
    assert_eq!(a.item_ids(&id).await, ["7", "999", "101", "501"]);
    assert_eq!(a.changes(), 1);
}

#[tokio::test]
async fn neighbors_follow_the_list_order_and_wrap() {
    let a = app().await;
    let id = a
        .create(
            "Zap",
            vec![
                new_item(live("s1", "101"), "A"),
                new_item(live("s2", "7"), "B"),
                new_item(live("s1", "999"), "Unavailable"),
                new_item(live("s1", "102"), "D"),
            ],
        )
        .await;
    let n = |p: &str, q: &str| (Some(p.to_string()), Some(q.to_string()));
    assert_eq!(
        a.neighbors(&id, live("s1", "101")).await,
        n("102", "7"),
        "wraps back to the end"
    );
    assert_eq!(
        a.neighbors(&id, live("s2", "7")).await,
        n("101", "102"),
        "crosses sources and skips the unavailable channel"
    );
    assert_eq!(
        a.neighbors(&id, live("s1", "102")).await,
        n("7", "101"),
        "wraps to the start"
    );
    assert_eq!(
        a.neighbors(&id, live("s1", "999")).await,
        n("7", "102"),
        "an unavailable current channel still has neighbours"
    );
    // Channels carry the catalog details the player needs.
    let v = a
        .call(
            "lists.neighbors",
            json!({"id": id, "ref": live("s1", "101")}),
        )
        .await;
    assert_eq!(v["next"]["name"], "Eurosport");
    assert_eq!(v["next"]["url"], "http://stream/7.ts");

    // The order follows reorderItems.
    a.call(
        "lists.reorderItems",
        json!({"id": id, "refs": [live("s1", "102"), live("s1", "999"), live("s2", "7"), live("s1", "101")]}),
    )
    .await;
    assert_eq!(a.neighbors(&id, live("s1", "101")).await, n("7", "102"));

    // Two playable channels: the other one both ways. One: none.
    let two = a
        .create(
            "Two",
            vec![
                new_item(live("s1", "101"), "A"),
                new_item(live("s1", "103"), "C"),
            ],
        )
        .await;
    assert_eq!(a.neighbors(&two, live("s1", "101")).await, n("103", "103"));
    let one = a
        .create(
            "One",
            vec![
                new_item(live("s1", "101"), "A"),
                new_item(live("s1", "998"), "Gone"),
            ],
        )
        .await;
    assert_eq!(a.neighbors(&one, live("s1", "101")).await, (None, None));
    let v = a
        .call(
            "lists.neighbors",
            json!({"id": one, "ref": live("s1", "101")}),
        )
        .await;
    assert_eq!(v, json!({}), "absent neighbours are left out");

    // A channel the list does not hold, or an unknown list: not_found.
    assert_eq!(
        a.fail(
            "lists.neighbors",
            json!({"id": id, "ref": live("s1", "103")})
        )
        .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(
        a.fail(
            "lists.neighbors",
            json!({"id": "nope", "ref": live("s1", "101")})
        )
        .await,
        RpcErrorCode::NotFound
    );
}

/// Hidden channels (C2 `channel_edits.hidden`) and parental hide mode leave
/// channels out of `lists.items`, `itemCount` and `lists.neighbors`; the rows
/// stay and come back. A reorder of only the visible channels keeps the
/// hidden ones in their slots.
#[tokio::test]
async fn hidden_and_parentally_hidden_channels_are_left_out() {
    let a = app().await;
    let id = a
        .create(
            "News",
            vec![
                new_item(live("s1", "101"), "A"),
                new_item(live("s1", "102"), "B"),
                new_item(live("s1", "103"), "C"),
                new_item(live("s2", "7"), "D"),
            ],
        )
        .await;
    a.sql(
        "INSERT INTO channel_edits(source_id, content_type, item_id, hidden, name, original_name, updated_at)
         VALUES ('s1', 'live', '102', 1, NULL, 'CNN', '2026-10-14T00:00:00.000Z')",
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["101", "103", "7"]);
    assert_eq!(a.lists().await[0]["itemCount"], 3);
    assert_eq!(
        a.neighbors(&id, live("s1", "101")).await,
        (Some("7".into()), Some("103".into())),
        "zapping skips the hidden channel"
    );
    // The manage dialog sends what it shows; the hidden channel keeps slot 2.
    a.call(
        "lists.reorderItems",
        json!({"id": id, "refs": [live("s2", "7"), live("s1", "103"), live("s1", "101")]}),
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["7", "103", "101"]);
    assert_eq!(a.stored_ids(&id).await, ["7", "102", "103", "101"]);
    // Undo of a removal in a list holding a hidden channel: the dialog
    // re-adds the channel (it goes to the end), then sends the order it
    // showed before.
    a.call(
        "lists.removeItems",
        json!({"id": id, "refs": [live("s1", "103")]}),
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["7", "101"]);
    a.add(&id, vec![new_item(live("s1", "103"), "C")]).await;
    assert_eq!(a.stored_ids(&id).await, ["7", "102", "101", "103"]);
    a.call(
        "lists.reorderItems",
        json!({"id": id, "refs": [live("s2", "7"), live("s1", "103"), live("s1", "101")]}),
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["7", "103", "101"]);
    // The hidden channel is still a channel of the list: listing it twice
    // or listing a stranger is refused.
    assert_eq!(
        a.fail(
            "lists.reorderItems",
            json!({"id": id, "refs": [live("s1", "102"), live("s1", "102")]})
        )
        .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(
        a.fail(
            "lists.reorderItems",
            json!({"id": id, "refs": [live("s1", "102"), live("s1", "104")]})
        )
        .await,
        RpcErrorCode::Invalid
    );
    a.sql("DELETE FROM channel_edits").await;
    assert_eq!(a.item_ids(&id).await, ["7", "102", "103", "101"]);

    // Parental hide mode: an item lock, while a PIN is set and locked.
    a.call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "live", "kind": "item", "targetId": "103", "name": "Sky News"}, "locked": true}),
    )
    .await;
    a.call("parental.setPin", json!({"newPin": "2468"})).await;
    assert_eq!(a.item_ids(&id).await, ["7", "102", "101"]);
    assert_eq!(a.lists().await[0]["itemCount"], 3);
    assert_eq!(
        a.neighbors(&id, live("s1", "102")).await,
        (Some("7".into()), Some("101".into()))
    );
    // Reordering what parental hide mode lets the dialog show keeps the
    // locked channel in its slot (2).
    a.call(
        "lists.reorderItems",
        json!({"id": id, "refs": [live("s1", "101"), live("s2", "7"), live("s1", "102")]}),
    )
    .await;
    assert_eq!(a.item_ids(&id).await, ["101", "7", "102"]);
    assert_eq!(a.stored_ids(&id).await, ["101", "7", "103", "102"]);
    // A category lock hides every channel of the category.
    a.call("parental.unlock", json!({"pin": "2468"})).await;
    a.call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "live", "kind": "category", "targetId": "1", "name": "News"}, "locked": true}),
    )
    .await;
    a.call("parental.lockNow", Value::Null).await;
    assert_eq!(a.item_ids(&id).await, ["7"], "s2's category is not locked");
    assert_eq!(a.neighbors(&id, live("s2", "7")).await, (None, None));
    a.call("parental.unlock", json!({"pin": "2468"})).await;
    assert_eq!(a.item_ids(&id).await, ["101", "7", "103", "102"]);
}

/// Renamed channels (C2 `channel_edits.name`) show their custom name in
/// `lists.items` and `lists.neighbors`; the snapshot keeps the stored title.
#[tokio::test]
async fn renamed_channels_show_their_custom_name() {
    let a = app().await;
    let id = a
        .create(
            "News",
            vec![
                new_item(live("s1", "101"), "A"),
                new_item(live("s1", "102"), "B"),
            ],
        )
        .await;
    a.sql(
        "INSERT INTO channel_edits(source_id, content_type, item_id, hidden, name, original_name, updated_at)
         VALUES ('s1', 'live', '102', 0, 'My CNN', 'CNN', '2026-10-14T00:00:00.000Z')",
    )
    .await;
    let items = a.items(&id).await;
    assert_eq!(items[1]["channel"]["name"], "My CNN");
    assert_eq!(items[1]["snapshot"]["title"], "B");
    let v = a
        .call(
            "lists.neighbors",
            json!({"id": id, "ref": live("s1", "101")}),
        )
        .await;
    assert_eq!(v["next"]["name"], "My CNN");
}

#[tokio::test]
async fn removing_a_source_removes_its_channels_from_every_list() {
    let a = app().await;
    let one = a
        .create(
            "One",
            vec![
                new_item(live("s1", "101"), "A"),
                new_item(live("s2", "7"), "B"),
            ],
        )
        .await;
    let two = a
        .create("Two", vec![new_item(live("s1", "102"), "C")])
        .await;
    a.call("sources.remove", json!({"id": "s1"})).await;
    assert_eq!(a.item_ids(&one).await, ["7"]);
    assert_eq!(a.item_ids(&two).await, Vec::<String>::new());
    let lists = a.lists().await;
    assert_eq!(lists.len(), 2, "the lists themselves stay");
    assert_eq!(lists[0]["itemCount"], 1);
    assert_eq!(lists[1]["itemCount"], 0);
    let left: i64 = a
        .state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM custom_list_items WHERE source_id = 's1'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(left, 0);
    // Removing a list removes its rows too.
    a.call("lists.remove", json!({"id": one})).await;
    let rows: i64 = a
        .state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM custom_list_items", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

/// `lists::forget_source` is the hook `sources::remove` calls after the
/// cascade: it announces `lists.changed` when any list exists.
#[tokio::test]
async fn forget_source_announces_the_cascade() {
    let mut a = app().await;
    iptv_core::lists::forget_source(&a.state, "s1").await;
    assert_eq!(a.changes(), 0, "no lists: nothing to refresh");
    a.create("One", vec![new_item(live("s1", "101"), "A")])
        .await;
    a.changes();
    iptv_core::lists::forget_source(&a.state, "s1").await;
    assert_eq!(a.changes(), 1);
}

#[tokio::test]
async fn removing_a_source_emits_lists_changed() {
    let mut a = app().await;
    a.create("One", vec![new_item(live("s1", "101"), "A")])
        .await;
    a.changes();
    a.call("sources.remove", json!({"id": "s1"})).await;
    assert_eq!(a.changes(), 1);
}
