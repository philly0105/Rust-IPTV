//! Channel edits (`channels.*`, Run 2 contract C2) through the full router.
//!
//! Check 3: a hidden channel is absent from every reader C2 lists (with the
//! right `total` and category `itemCount`), `catalog.channelByNumber` answers
//! null for it, and `lists.items` and `epg.search` leave it out; a rename
//! shows in `catalog.channels`, `catalog.item`, `catalog.search` (by the new
//! and the old name), `favorites.list`, `recent.list` and `lists.items`; EPG
//! resolution keeps the provider name; edits survive a re-import of the same
//! M3U and a refresh of the mock Xtream source, and removing the source
//! removes them. Also: validation, unhiding a dropped channel, `channels.reset`,
//! the backup functions, parental and English-only counts, and the perf case
//! of check 4 (1,000 hidden and 1,000 renamed channels among 50k with
//! English-only on).

#[path = "xtream_stub.rs"]
mod stub;
#[path = "m3u_support.rs"]
mod support;

use iptv_core::channeledit::{self, ChannelEditBackup, MAX_NAME_CHARS, MAX_REFS};
use iptv_core::lists;
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::{AppEvent, AppState, BroadcastSink, RpcErrorCode};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::Receiver;
use tokio::sync::{RwLock, RwLockReadGuard};

/// The perf case times single calls, so it runs alone: it takes the write
/// guard, and every other test holds a read guard for its whole run (`App`
/// keeps one). Run in parallel with the rest of the file, the deep page took
/// 346 ms in a debug build against 52 ms alone.
static SERIAL: LazyLock<RwLock<()>> = LazyLock::new(|| RwLock::new(()));

const EPG_URL: &str = "http://guide.example/epg.xml";

struct App {
    _serial: RwLockReadGuard<'static, ()>,
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    events: Receiver<AppEvent>,
}

/// One fixture item: source, type, id, category, title, number, tvg-id,
/// position.
type Fixture = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<i64>,
    Option<&'static str>,
    i64,
);

/// Source `s1`: live 101 BBC One, 102 CNN International, 103 Sky News
/// (category `news`), 104 Eurosport 1 (`sport`), 105 Lonely TV (`solo`, its
/// only channel), radio 501 Jazz FM, movie 201 Film. Source `s2`: live 7 BBC
/// One. The guide has a programme in an hour on BBC One (`bbc1.uk`, matched
/// by the item's tvg-id), CNN (`cnn.us`) and Sky News (`sky.uk`, matched by
/// name only).
async fn app() -> App {
    let serial = SERIAL.read().await;
    let dir = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    state
        .db_call(move |c| {
            for id in ["s1", "s2"] {
                c.execute(
                    "INSERT INTO sources(id, kind, name, position, created_at, config_json)
                     VALUES (?1, 'xtream', ?1, 0, CURRENT_TIMESTAMP, '{}')",
                    [id],
                )?;
            }
            for (sid, ct, id, name, pos) in [
                ("s1", "live", "news", "News", 0),
                ("s1", "live", "sport", "Sports", 1),
                ("s1", "live", "solo", "Solo", 2),
                ("s1", "radio", "r", "Radio", 0),
                ("s1", "movie", "m", "Films", 0),
                ("s2", "live", "news", "News", 0),
            ] {
                c.execute(
                    "INSERT INTO categories(source_id, content_type, category_id, name, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![sid, ct, id, name, pos],
                )?;
            }
            let items: [Fixture; 8] = [
                ("s1", "live", "101", "news", "BBC One", Some(1), Some("bbc1.uk"), 0),
                ("s1", "live", "102", "news", "CNN International", Some(2), Some("cnn.us"), 1),
                ("s1", "live", "103", "news", "Sky News", Some(3), None, 2),
                ("s1", "live", "104", "sport", "Eurosport 1", Some(4), None, 3),
                ("s1", "live", "105", "solo", "Lonely TV", Some(5), None, 4),
                ("s1", "radio", "501", "r", "Jazz FM", Some(50), None, 5),
                ("s1", "movie", "201", "m", "Film", None, None, 6),
                ("s2", "live", "7", "news", "BBC One", Some(1), Some("bbc1.uk"), 0),
            ];
            for (sid, ct, id, cat, title, number, epg, pos) in items {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, number, epg_channel_id, logo_url, url, position, is_radio)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        sid,
                        ct,
                        id,
                        cat,
                        title,
                        number,
                        epg,
                        format!("http://logo/{id}.png"),
                        format!("http://stream/{id}.ts"),
                        pos,
                        ct == "radio"
                    ],
                )?;
            }
            c.execute("INSERT INTO items_fts(items_fts) VALUES ('rebuild')", [])?;
            for sid in ["s1", "s2"] {
                for ct in [ContentType::Live, ContentType::Radio, ContentType::Movie] {
                    iptv_core::catalog::recount_categories(c, sid, ct)?;
                }
                iptv_core::catalog::update_counts(c, sid)?;
            }
            c.execute(
                "INSERT INTO epg_sources(url, origin, status, channel_count, program_count) VALUES (?1, 'settings', 'ok', 3, 3)",
                [EPG_URL],
            )?;
            for (ch, name, title) in [
                ("bbc1.uk", "BBC One", "News at Ten"),
                ("cnn.us", "CNN International", "World News"),
                ("sky.uk", "Sky News", "News Review"),
            ] {
                c.execute(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, ?2, ?3)",
                    params![EPG_URL, ch, name],
                )?;
                c.execute(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![EPG_URL, ch, now + 3600, now + 7200, title],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    App {
        _serial: serial,
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

fn item_ref(source: &str, ct: ContentType, id: &str) -> ItemRef {
    ItemRef {
        source_id: source.into(),
        content_type: ct,
        item_id: id.into(),
    }
}

fn snap(title: &str) -> Value {
    json!({"title": title, "contentType": "live"})
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// `itemId`s of an array of objects carrying a `ref`.
fn ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("not an array: {v}"))
        .iter()
        .map(|e| e["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

/// `itemId`s of an array of refs.
fn ref_ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| r["itemId"].as_str().unwrap().to_string())
        .collect()
}

fn name_of<'a>(v: &'a Value, id: &str) -> &'a str {
    v.as_array()
        .unwrap()
        .iter()
        .find(|e| e["ref"]["itemId"] == id)
        .unwrap_or_else(|| panic!("{id} missing from {v}"))["name"]
        .as_str()
        .unwrap()
}

fn counts(pairs: &[(&str, i64)]) -> Vec<(String, i64)> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args.clone())
            .await
            .unwrap_or_else(|e| panic!("{cmd} {args} failed: {}", e.message))
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

    /// Payloads of the `channels.changed` events since the last call.
    fn changed(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(ev) = self.events.try_recv() {
            if ev.kind == channeledit::CHANGED_EVENT {
                out.push(ev.payload);
            }
        }
        out
    }

    async fn category_counts(&self, include_hidden: bool) -> Vec<(String, i64)> {
        let v = self
            .call(
                "catalog.categories",
                json!({"sourceId": "s1", "contentType": "live", "includeHidden": include_hidden}),
            )
            .await;
        v.as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["id"].as_str().unwrap().to_string(),
                    c["itemCount"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    async fn scalar(&self, sql: &'static str, source: &str) -> i64 {
        let s = source.to_string();
        self.state
            .db_call(move |c| Ok(c.query_row(sql, [s], |r| r.get(0))?))
            .await
            .unwrap()
    }

    async fn channel_count(&self, source: &str) -> i64 {
        self.scalar(
            "SELECT channel_count FROM source_counts WHERE source_id = ?1",
            source,
        )
        .await
    }

    async fn edit_rows(&self, source: &str) -> i64 {
        self.scalar(
            "SELECT count(*) FROM channel_edits WHERE source_id = ?1",
            source,
        )
        .await
    }

    /// Distinct `ref.itemId`s of `epg.search` hits on source `s1`.
    async fn guide_hits(&self, query: &str) -> Vec<String> {
        let v = self
            .call("epg.search", json!({"sourceId": "s1", "query": query}))
            .await;
        let mut out = ids(&v);
        out.sort();
        out.dedup();
        out
    }
}

#[tokio::test]
async fn a_hidden_channel_leaves_every_reader() {
    let mut a = app().await;
    a.call(
        "favorites.toggle",
        json!({"ref": live("s1", "102"), "snapshot": snap("CNN International")}),
    )
    .await;
    a.call(
        "recent.add",
        json!({"ref": live("s1", "102"), "snapshot": snap("CNN International")}),
    )
    .await;
    let list = a
        .call(
            "lists.create",
            json!({"name": "Mine", "items": [
                {"ref": live("s1", "101"), "snapshot": snap("BBC One")},
                {"ref": live("s1", "102"), "snapshot": snap("CNN International")},
                {"ref": live("s1", "103"), "snapshot": snap("Sky News")},
            ]}),
        )
        .await;
    let list_id = list["id"].as_str().unwrap().to_string();
    assert_eq!(a.channel_count("s1").await, 5);
    assert_eq!(a.guide_hits("News").await, s(&["101", "102", "103"]));
    a.changed();

    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102"), live("s1", "105"), live("s1", "102")], "hidden": true}),
    )
    .await;
    assert_eq!(
        a.changed(),
        vec![json!({"sourceId": "s1"})],
        "one event per source"
    );

    // catalog.channels: page and total, with a category, with includeHidden
    // (the manage-categories view) and with a search.
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(ids(&page["items"]), s(&["101", "103", "104"]));
    assert_eq!(page["total"], 3);
    let page = a
        .call(
            "catalog.channels",
            json!({"sourceId": "s1", "categoryId": "news"}),
        )
        .await;
    assert_eq!(ids(&page["items"]), s(&["101", "103"]));
    assert_eq!(page["total"], 2);
    let page = a
        .call(
            "catalog.channels",
            json!({"sourceId": "s1", "includeHidden": true}),
        )
        .await;
    assert_eq!(page["total"], 3);
    for search in ["CNN", "cnn int", "nternat"] {
        let page = a
            .call(
                "catalog.channels",
                json!({"sourceId": "s1", "query": {"search": search}}),
            )
            .await;
        assert_eq!(page["total"], 0, "{search}");
    }

    // catalog.categories: counts without hidden channels; a category they
    // empty leaves the sidebar but stays in the manage view.
    assert_eq!(
        a.category_counts(false).await,
        counts(&[("news", 2), ("sport", 1)])
    );
    assert_eq!(
        a.category_counts(true).await,
        counts(&[("news", 2), ("sport", 1), ("solo", 0)])
    );
    assert_eq!(a.channel_count("s1").await, 3);

    // catalog.search, across sources and in one source.
    for args in [
        json!({"query": "CNN"}),
        json!({"query": "CNN", "sourceId": "s1"}),
        json!({"query": "nternationa"}),
        json!({"query": "Lonely", "contentTypes": ["live"]}),
    ] {
        let v = a.call("catalog.search", args.clone()).await;
        assert!(ids(&v["live"]).is_empty(), "{args}: {v}");
    }

    // catalog.neighbors skips it, in the whole list and in a category.
    let n = a
        .call("catalog.neighbors", json!({"ref": live("s1", "101")}))
        .await;
    assert_eq!(n["next"]["ref"]["itemId"], "103");
    assert_eq!(n["prev"]["ref"]["itemId"], "104", "wraps past hidden 105");
    let n = a
        .call(
            "catalog.neighbors",
            json!({"ref": live("s1", "103"), "categoryId": "news"}),
        )
        .await;
    assert_eq!(n["prev"]["ref"]["itemId"], "101");
    assert_eq!(n["next"]["ref"]["itemId"], "101");

    // catalog.channelByNumber answers null.
    for args in [
        json!({"sourceId": "s1", "number": 2}),
        json!({"sourceId": "s1", "number": 2, "contentType": "live"}),
    ] {
        let c = a.call("catalog.channelByNumber", args).await;
        assert!(c.is_null(), "{c}");
    }
    let c = a
        .call(
            "catalog.channelByNumber",
            json!({"sourceId": "s1", "number": 3}),
        )
        .await;
    assert_eq!(c["ref"]["itemId"], "103");

    // catalog.allLiveChannels (the zap list).
    let all = a
        .call("catalog.allLiveChannels", json!({"sourceId": "s1"}))
        .await;
    assert_eq!(ids(&all), s(&["101", "103", "104"]));

    // catalog.item still answers (the hidden-channels dialog and the player).
    let item = a
        .call("catalog.item", json!({"ref": live("s1", "102")}))
        .await;
    assert_eq!(item["name"], "CNN International");

    // favorites.list and recent.list; the favorite itself is kept.
    assert!(ids(&a.call("favorites.list", json!({})).await).is_empty());
    assert!(ids(&a.call("favorites.list", json!({"sourceId": "s1"})).await).is_empty());
    assert!(ids(&a.call("recent.list", json!({})).await).is_empty());
    let contains = a
        .call("favorites.contains", json!({"refs": [live("s1", "102")]}))
        .await;
    assert_eq!(ref_ids(&contains), s(&["102"]));

    // lists.items and epg.search.
    let items = a.call("lists.items", json!({"id": list_id})).await;
    assert_eq!(ids(&items), s(&["101", "103"]));
    assert_eq!(a.guide_hits("News").await, s(&["101", "103"]));

    // The helpers other slices use.
    let (hidden, set) = a
        .state
        .db_call(|c| {
            Ok((
                channeledit::is_hidden(c, &item_ref("s1", ContentType::Live, "102"))?,
                channeledit::hidden_set(c, "s1")?,
            ))
        })
        .await
        .unwrap();
    assert!(hidden);
    assert_eq!(set.len(), 2);
    assert!(set.contains(&(ContentType::Live, "105".to_string())));

    // channels.edits: both rows, with the provider name.
    let edits = a.call("channels.edits", json!({"sourceId": "s1"})).await;
    let mut got = ids(&edits);
    got.sort();
    assert_eq!(got, s(&["102", "105"]));
    for e in edits.as_array().unwrap() {
        assert_eq!(e["hidden"], true);
        assert!(e.get("name").is_none(), "{e}");
        assert!(e["updatedAt"].as_str().unwrap().ends_with('Z'), "{e}");
    }
    let cnn = edits
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["ref"]["itemId"] == "102")
        .unwrap();
    assert_eq!(cnn["originalName"], "CNN International");
    let hidden_only = a
        .call(
            "channels.edits",
            json!({"sourceId": "s1", "hiddenOnly": true}),
        )
        .await;
    assert_eq!(hidden_only.as_array().unwrap().len(), 2);

    // Unhide: everything comes back and the rows go.
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102"), live("s1", "105")], "hidden": false}),
    )
    .await;
    assert_eq!(a.changed(), vec![json!({"sourceId": "s1"})]);
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(page["total"], 5);
    assert_eq!(
        a.category_counts(false).await,
        counts(&[("news", 3), ("sport", 1), ("solo", 1)])
    );
    assert_eq!(a.channel_count("s1").await, 5);
    let c = a
        .call(
            "catalog.channelByNumber",
            json!({"sourceId": "s1", "number": 2}),
        )
        .await;
    assert_eq!(c["ref"]["itemId"], "102");
    assert_eq!(ids(&a.call("favorites.list", json!({})).await), s(&["102"]));
    assert_eq!(ids(&a.call("recent.list", json!({})).await), s(&["102"]));
    let items = a.call("lists.items", json!({"id": list_id})).await;
    assert_eq!(ids(&items), s(&["101", "102", "103"]));
    assert_eq!(a.guide_hits("News").await, s(&["101", "102", "103"]));
    assert_eq!(a.edit_rows("s1").await, 0);
}

#[tokio::test]
async fn a_rename_shows_in_every_reader_and_guide_matching_keeps_the_provider_name() {
    let mut a = app().await;
    a.call(
        "favorites.toggle",
        json!({"ref": live("s1", "101"), "snapshot": snap("BBC One")}),
    )
    .await;
    a.call(
        "recent.add",
        json!({"ref": live("s1", "101"), "snapshot": snap("BBC One")}),
    )
    .await;
    let list = a
        .call(
            "lists.create",
            json!({"name": "Mine", "items": [
                {"ref": live("s1", "101"), "snapshot": snap("BBC One")},
                {"ref": live("s1", "102"), "snapshot": snap("CNN International")},
            ]}),
        )
        .await;
    let list_id = list["id"].as_str().unwrap().to_string();
    let resolved = a
        .call("epg.resolve", json!({"ref": live("s1", "103")}))
        .await;
    assert_eq!(resolved["epgChannelId"], "sky.uk");
    assert_eq!(resolved["via"], "name");
    a.changed();

    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "101"), "name": "  My BBC  "}),
        )
        .await;
    assert_eq!(row["ref"], live("s1", "101"));
    assert_eq!(row["name"], "My BBC", "trimmed");
    assert_eq!(row["originalName"], "BBC One");
    assert_eq!(row["hidden"], false);
    assert_eq!(a.changed(), vec![json!({"sourceId": "s1"})]);
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "103"), "name": "Sky 24"}),
    )
    .await;

    // catalog.channels, catalog.item, neighbors, channelByNumber, zap list.
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(name_of(&page["items"], "101"), "My BBC");
    assert_eq!(name_of(&page["items"], "102"), "CNN International");
    let item = a
        .call("catalog.item", json!({"ref": live("s1", "101")}))
        .await;
    assert_eq!(item["name"], "My BBC");
    let n = a
        .call("catalog.neighbors", json!({"ref": live("s1", "102")}))
        .await;
    assert_eq!(n["prev"]["name"], "My BBC");
    assert_eq!(n["next"]["name"], "Sky 24");
    let c = a
        .call(
            "catalog.channelByNumber",
            json!({"sourceId": "s1", "number": 1}),
        )
        .await;
    assert_eq!(c["name"], "My BBC");
    let all = a
        .call("catalog.allLiveChannels", json!({"sourceId": "s1"}))
        .await;
    assert_eq!(name_of(&all, "101"), "My BBC");
    // Another source's channel with the same provider name is untouched.
    let other = a.call("catalog.channels", json!({"sourceId": "s2"})).await;
    assert_eq!(name_of(&other["items"], "7"), "BBC One");

    // Sorting by name keeps provider order ("BBC One" sorts first).
    let sorted = a
        .call(
            "catalog.channels",
            json!({"sourceId": "s1", "query": {"sort": "name"}}),
        )
        .await;
    assert_eq!(
        ids(&sorted["items"]),
        s(&["101", "102", "104", "105", "103"])
    );

    // catalog.search by the new name and by the old one.
    let v = a.call("catalog.search", json!({"query": "My BBC"})).await;
    assert_eq!(ids(&v["live"]), s(&["101"]));
    assert_eq!(v["live"][0]["name"], "My BBC");
    let v = a.call("catalog.search", json!({"query": "my b"})).await;
    assert_eq!(ids(&v["live"]), s(&["101"]), "substring of the custom name");
    let v = a.call("catalog.search", json!({"query": "BBC One"})).await;
    let mut got: Vec<(String, String)> = v["live"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["ref"]["sourceId"].as_str().unwrap().to_string(),
                c["name"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            ("s1".to_string(), "My BBC".to_string()),
            ("s2".to_string(), "BBC One".to_string())
        ]
    );
    // "BBC" matches both names of 101: listed once.
    let v = a
        .call("catalog.search", json!({"query": "BBC", "sourceId": "s1"}))
        .await;
    assert_eq!(ids(&v["live"]), s(&["101"]));
    let v = a
        .call(
            "catalog.search",
            json!({"query": "Sky 24", "contentTypes": ["live", "radio"]}),
        )
        .await;
    assert_eq!(ids(&v["live"]), s(&["103"]));
    let v = a
        .call(
            "catalog.search",
            json!({"query": "Sky 24", "contentTypes": ["movie"]}),
        )
        .await;
    assert!(ids(&v["live"]).is_empty() && ids(&v["movies"]).is_empty());

    // The in-list search of catalog.channels, both names, both strategies.
    for (search, want) in [
        ("my bbc", vec!["101"]),
        ("y BB", vec!["101"]),
        ("BBC One", vec!["101"]),
        ("bbc", vec!["101"]),
        ("Sky", vec!["103"]),
        ("24", vec!["103"]),
    ] {
        let page = a
            .call(
                "catalog.channels",
                json!({"sourceId": "s1", "query": {"search": search}}),
            )
            .await;
        assert_eq!(ids(&page["items"]), s(&want), "{search}");
        assert_eq!(page["total"], want.len() as i64, "{search}");
    }

    // favorites.list, recent.list, lists.items.
    let favs = a.call("favorites.list", json!({})).await;
    assert_eq!(favs[0]["snapshot"]["title"], "My BBC");
    let recent = a.call("recent.list", json!({"sourceId": "s1"})).await;
    assert_eq!(recent[0]["snapshot"]["title"], "My BBC");
    let items = a.call("lists.items", json!({"id": list_id})).await;
    let first = &items.as_array().unwrap()[0];
    assert_eq!(first["ref"]["itemId"], "101");
    assert_eq!(first["channel"]["name"], "My BBC");

    // EPG resolution and the guide keep the provider name.
    let resolved = a
        .call("epg.resolve", json!({"ref": live("s1", "101")}))
        .await;
    assert_eq!(resolved["epgChannelId"], "bbc1.uk");
    let resolved = a
        .call("epg.resolve", json!({"ref": live("s1", "103")}))
        .await;
    assert_eq!(resolved["epgChannelId"], "sky.uk", "{resolved}");
    assert_eq!(resolved["via"], "name");
    assert!(a
        .guide_hits("News Review")
        .await
        .contains(&"103".to_string()));

    // The helper other slices use.
    let names = a
        .state
        .db_call(|c| {
            Ok((
                channeledit::custom_name(c, &item_ref("s1", ContentType::Live, "101"))?,
                channeledit::custom_name(c, &item_ref("s1", ContentType::Live, "102"))?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(names, (Some("My BBC".to_string()), None));
    a.changed();

    // The provider's own name, null and "" reset; the rows go.
    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "101"), "name": "BBC One"}),
        )
        .await;
    assert!(row.is_null(), "{row}");
    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "103"), "name": null}),
        )
        .await;
    assert!(row.is_null());
    assert_eq!(a.edit_rows("s1").await, 0);
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "103"), "name": "X"}),
    )
    .await;
    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "103"), "name": ""}),
        )
        .await;
    assert!(row.is_null());
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(name_of(&page["items"], "101"), "BBC One");
    assert_eq!(name_of(&page["items"], "103"), "Sky News");
    assert_eq!(a.changed().len(), 4, "one event per write");

    // Hidden and renamed: one row; clearing the name keeps it hidden,
    // unhiding keeps the name.
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "104"), "name": "Sport"}),
    )
    .await;
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "104")], "hidden": true}),
    )
    .await;
    let edits = a.call("channels.edits", json!({"sourceId": "s1"})).await;
    assert_eq!(edits.as_array().unwrap().len(), 1);
    assert_eq!(edits[0]["hidden"], true);
    assert_eq!(edits[0]["name"], "Sport");
    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "104"), "name": null}),
        )
        .await;
    assert_eq!(row["hidden"], true);
    assert!(row.get("name").is_none(), "{row}");
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "104"), "name": "Sport"}),
    )
    .await;
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "104")], "hidden": false}),
    )
    .await;
    let edits = a.call("channels.edits", json!({"sourceId": "s1"})).await;
    assert_eq!(edits[0]["hidden"], false);
    assert_eq!(edits[0]["name"], "Sport");
    let edits = a
        .call(
            "channels.edits",
            json!({"sourceId": "s1", "hiddenOnly": true}),
        )
        .await;
    assert!(edits.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn bad_requests_are_refused_and_write_nothing() {
    let a = app().await;
    // setHidden: count, type, missing ids, unknown channels.
    let many: Vec<Value> = (0..=MAX_REFS).map(|i| live("s1", &i.to_string())).collect();
    for (args, want) in [
        (json!({"refs": [], "hidden": true}), RpcErrorCode::Invalid),
        (json!({"refs": many, "hidden": true}), RpcErrorCode::Invalid),
        (
            json!({"refs": [rf("s1", "movie", "201")], "hidden": true}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"refs": [live("s1", "")], "hidden": true}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"refs": [live("s1", "101"), live("s1", "999")], "hidden": true}),
            RpcErrorCode::NotFound,
        ),
        (
            json!({"refs": [live("nope", "101")], "hidden": true}),
            RpcErrorCode::NotFound,
        ),
        (
            json!({"refs": [live("s1", &"9".repeat(lists::MAX_ID_CHARS + 1))], "hidden": true}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"refs": [live(&"s".repeat(lists::MAX_ID_CHARS + 1), "101")], "hidden": false}),
            RpcErrorCode::Invalid,
        ),
    ] {
        assert_eq!(
            a.fail("channels.setHidden", args.clone()).await,
            want,
            "{args}"
        );
    }
    // An unknown id at the cap is NotFound, with the id shortened in the
    // message.
    let err = a
        .router
        .dispatch(
            a.state.clone(),
            "channels.setHidden",
            json!({"refs": [live("s1", &"9".repeat(lists::MAX_ID_CHARS))], "hidden": true}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::NotFound);
    assert!(err.message.len() < 200, "{}", err.message);
    assert_eq!(a.edit_rows("s1").await, 0, "nothing written");
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(page["total"], 5);
    // Exactly MAX_REFS is fine (radio too); unhiding a visible channel is a
    // no-op.
    let max = vec![rf("s1", "radio", "501"); MAX_REFS];
    a.call("channels.setHidden", json!({"refs": max, "hidden": true}))
        .await;
    let radio = a
        .call("catalog.channels", json!({"sourceId": "s1", "radio": true}))
        .await;
    assert_eq!(radio["total"], 0);
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "101")], "hidden": false}),
    )
    .await;
    assert_eq!(a.edit_rows("s1").await, 1);

    // rename: blank, too long, control characters, type, unknown channel.
    for bad in [
        json!("   "),
        json!("a".repeat(MAX_NAME_CHARS + 1)),
        json!("line\nbreak"),
        json!("tab\there"),
        json!("\u{200B}"),
        json!(" \u{200F}\u{FEFF} "),
        json!("line\u{2028}separator"),
    ] {
        assert_eq!(
            a.fail(
                "channels.rename",
                json!({"ref": live("s1", "101"), "name": bad})
            )
            .await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    let longest = "é".repeat(MAX_NAME_CHARS);
    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "101"), "name": longest}),
        )
        .await;
    assert_eq!(row["name"], longest.as_str());
    for (args, want) in [
        (
            json!({"ref": rf("s1", "movie", "201"), "name": "x"}),
            RpcErrorCode::Invalid,
        ),
        (
            json!({"ref": live("s1", "999"), "name": "x"}),
            RpcErrorCode::NotFound,
        ),
        (
            json!({"ref": live("s1", "999"), "name": null}),
            RpcErrorCode::NotFound,
        ),
        (json!({"name": "x"}), RpcErrorCode::Invalid),
    ] {
        assert_eq!(
            a.fail("channels.rename", args.clone()).await,
            want,
            "{args}"
        );
    }

    // edits and reset.
    assert_eq!(
        a.fail("channels.edits", json!({"sourceId": " "})).await,
        RpcErrorCode::Invalid
    );
    assert!(a
        .call("channels.edits", json!({"sourceId": "nope"}))
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        a.fail("channels.reset", json!({"sourceId": "nope"})).await,
        RpcErrorCode::NotFound
    );
    assert_eq!(
        a.fail("channels.reset", json!({"sourceId": ""})).await,
        RpcErrorCode::Invalid
    );
}

/// Change to C2 asked for by the channel-edit UI: `hidden: false` never
/// answers `not_found`, so a channel the provider has dropped can leave the
/// hidden-channels list; `hidden: true` still needs the channel.
#[tokio::test]
async fn unhiding_works_for_a_channel_the_provider_dropped() {
    let mut a = app().await;
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102"), live("s1", "103")], "hidden": true}),
    )
    .await;
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "103"), "name": "Sky 24"}),
    )
    .await;
    // The provider drops both.
    a.state
        .db_call(|c| {
            c.execute(
                "DELETE FROM items WHERE source_id = 's1' AND content_type = 'live' AND item_id IN ('102', '103')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let edits = a
        .call(
            "channels.edits",
            json!({"sourceId": "s1", "hiddenOnly": true}),
        )
        .await;
    let cnn = edits
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["ref"]["itemId"] == "102")
        .unwrap();
    assert_eq!(cnn["originalName"], "CNN International", "the name it had");
    assert_eq!(
        a.fail(
            "channels.setHidden",
            json!({"refs": [live("s1", "102")], "hidden": true})
        )
        .await,
        RpcErrorCode::NotFound,
        "hiding still needs the channel"
    );
    a.changed();

    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102"), live("s1", "103")], "hidden": false}),
    )
    .await;
    assert_eq!(a.changed(), vec![json!({"sourceId": "s1"})]);
    let edits = a.call("channels.edits", json!({"sourceId": "s1"})).await;
    assert_eq!(ids(&edits), s(&["103"]), "only the rename is left");
    assert_eq!(edits[0]["hidden"], false);
    assert_eq!(edits[0]["name"], "Sky 24");
    assert!(a
        .call(
            "channels.edits",
            json!({"sourceId": "s1", "hiddenOnly": true})
        )
        .await
        .as_array()
        .unwrap()
        .is_empty());

    // Nothing to unhide (no row, no channel, or no source): a no-op with no
    // event.
    for r in [live("s1", "102"), live("s1", "999"), live("nope", "1")] {
        a.call("channels.setHidden", json!({"refs": [r], "hidden": false}))
            .await;
    }
    assert!(a.changed().is_empty());
    assert_eq!(a.edit_rows("s1").await, 1);
    assert_eq!(a.edit_rows("nope").await, 0);
    // The rename of the dropped channel can still be cleared.
    let row = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "103"), "name": null}),
        )
        .await;
    assert!(row.is_null());
    assert_eq!(a.edit_rows("s1").await, 0);
}

#[tokio::test]
async fn reset_drops_every_edit_of_one_source() {
    let mut a = app().await;
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102"), live("s1", "103"), rf("s1", "radio", "501")], "hidden": true}),
    )
    .await;
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "101"), "name": "Mine"}),
    )
    .await;
    a.call(
        "channels.rename",
        json!({"ref": live("s2", "7"), "name": "Other"}),
    )
    .await;
    assert_eq!(
        a.category_counts(false).await,
        counts(&[("news", 1), ("sport", 1), ("solo", 1)])
    );
    let radio = a
        .state
        .db_call(|c| iptv_core::catalog::radio_count(c, "s1"))
        .await
        .unwrap();
    assert_eq!(radio, 0);
    a.changed();

    a.call("channels.reset", json!({"sourceId": "s1"})).await;
    assert_eq!(a.changed(), vec![json!({"sourceId": "s1"})]);
    assert_eq!(a.edit_rows("s1").await, 0);
    assert_eq!(a.edit_rows("s2").await, 1, "other sources keep theirs");
    assert_eq!(
        a.category_counts(false).await,
        counts(&[("news", 3), ("sport", 1), ("solo", 1)])
    );
    assert_eq!(a.channel_count("s1").await, 5);
    let radio = a
        .call("catalog.channels", json!({"sourceId": "s1", "radio": true}))
        .await;
    assert_eq!(radio["total"], 1);
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(name_of(&page["items"], "101"), "BBC One");
}

/// Saves channel `id` of `s1` as a favorite (re-adding it when it already
/// is one, so the snapshot is replaced), in history and in the watch log
/// under `title`, as the app does with the name it shows. Its custom list
/// item (added once by the test) is set to `title` too.
async fn save_as(a: &App, id: &str, title: &str) {
    let (item, name) = (id.to_string(), title.to_string());
    a.state
        .db_call(move |c| {
            c.execute(
                "UPDATE custom_list_items SET title = ?2 WHERE item_id = ?1",
                params![item, name],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let r = live("s1", id);
    let fav = json!({"ref": r, "snapshot": snap(title)});
    if a.call("favorites.toggle", fav.clone()).await["isFavorite"] == json!(false) {
        a.call("favorites.toggle", fav).await;
    }
    a.call("recent.add", json!({"ref": r, "snapshot": snap(title)}))
        .await;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    a.call(
        "stats.record",
        json!({"ref": r, "title": title, "seconds": 60, "day": today}),
    )
    .await;
}

/// Titles of channel `id` of `s1` in `favorites.list`, `recent.list`, its
/// stored list item and its watch-log row.
async fn saved_titles(a: &App, id: &str) -> [String; 4] {
    let title = |v: &Value| -> String {
        v.as_array()
            .unwrap()
            .iter()
            .find(|e| e["ref"]["itemId"] == id)
            .unwrap_or_else(|| panic!("{id} missing from {v}"))["snapshot"]["title"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let favs = title(&a.call("favorites.list", json!({})).await);
    let recent = title(&a.call("recent.list", json!({})).await);
    let id = id.to_string();
    let (list, log) = a
        .state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT (SELECT title FROM custom_list_items WHERE item_id = ?1),
                        (SELECT title FROM watch_log WHERE item_id = ?1)",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .await
        .unwrap();
    [favs, recent, list, log]
}

/// Favorites, history, list items and the watch log store the name the app
/// showed, here the custom one. Clearing the name (undo or reset of one
/// channel, `channels.reset`, a newer hidden-only backup entry) puts the
/// provider name back, so they stop showing the old custom name.
#[tokio::test]
async fn clearing_a_rename_restores_the_provider_name_in_saved_titles() {
    let a = app().await;
    let rename = |name: Value| json!({"ref": live("s1", "101"), "name": name});
    let beeb = || ["Beeb", "Beeb", "Beeb", "Beeb"].map(String::from);
    let bbc_one = || ["BBC One", "BBC One", "BBC One", "BBC One"].map(String::from);

    a.call("channels.rename", rename(json!("Beeb"))).await;
    a.call(
        "lists.create",
        json!({"name": "Mine", "items": [
            {"ref": live("s1", "101"), "snapshot": snap("Beeb")},
            {"ref": live("s1", "102"), "snapshot": snap("My CNN")},
        ]}),
    )
    .await;
    save_as(&a, "101", "Beeb").await;
    // A channel that is not renamed keeps whatever title it was saved with.
    save_as(&a, "102", "My CNN").await;
    assert_eq!(saved_titles(&a, "101").await, beeb());

    // Undo / Reset name: `channels.rename` with `null`.
    a.call("channels.rename", rename(Value::Null)).await;
    assert_eq!(saved_titles(&a, "101").await, bbc_one(), "after undo");

    // Naming it back to the provider name clears the custom name too.
    a.call("channels.rename", rename(json!("Beeb"))).await;
    save_as(&a, "101", "Beeb").await;
    a.call("channels.rename", rename(json!("BBC One"))).await;
    assert_eq!(saved_titles(&a, "101").await, bbc_one(), "named BBC One");

    // `channels.reset` of the whole source.
    a.call("channels.rename", rename(json!("Beeb"))).await;
    save_as(&a, "101", "Beeb").await;
    assert_eq!(saved_titles(&a, "101").await, beeb());
    a.call("channels.reset", json!({"sourceId": "s1"})).await;
    assert_eq!(saved_titles(&a, "101").await, bbc_one(), "after reset");
    assert_eq!(
        saved_titles(&a, "102").await,
        ["My CNN", "My CNN", "My CNN", "My CNN"].map(String::from),
        "a channel that was not renamed is left alone"
    );

    // A newer backup entry that only hides the channel clears the name.
    a.call("channels.rename", rename(json!("Beeb"))).await;
    save_as(&a, "101", "Beeb").await;
    let rows = vec![ChannelEditBackup {
        content_type: ContentType::Live,
        item_id: "101".into(),
        hidden: true,
        name: None,
        original_name: "BBC One".into(),
        updated_at: "2999-01-01T00:00:00Z".into(),
    }];
    let stored = a
        .state
        .db_call(move |c| {
            assert_eq!(channeledit::import_edits(c, "s1", &rows)?, 1);
            iptv_core::userstate::recent_list(c, None, None)
        })
        .await
        .unwrap();
    let entry = stored.iter().find(|e| e.item_ref.item_id == "101").unwrap();
    assert_eq!(entry.snapshot.title, "BBC One", "after a backup import");
}

#[tokio::test]
async fn writes_that_change_nothing_send_no_event() {
    let mut a = app().await;
    let one = json!({"sourceId": "s1"});

    // Reset of a source with no edits.
    a.call("channels.reset", json!({"sourceId": "s1"})).await;
    assert!(a.changed().is_empty());

    // Rename to the provider name, or clearing a name that is not set.
    for name in [json!("BBC One"), json!(null), json!("")] {
        let row = a
            .call(
                "channels.rename",
                json!({"ref": live("s1", "101"), "name": name}),
            )
            .await;
        assert!(row.is_null(), "{row}");
        assert!(a.changed().is_empty(), "rename to {name}");
    }

    // Renaming to the current custom name writes nothing and keeps updatedAt.
    let first = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "101"), "name": "Mine"}),
        )
        .await;
    assert_eq!(a.changed(), vec![one.clone()]);
    let again = a
        .call(
            "channels.rename",
            json!({"ref": live("s1", "101"), "name": "  Mine "}),
        )
        .await;
    assert_eq!(again, first, "same row, same updatedAt");
    assert!(a.changed().is_empty());

    // Hiding a hidden channel.
    let hide = json!({"refs": [live("s1", "102")], "hidden": true});
    a.call("channels.setHidden", hide.clone()).await;
    assert_eq!(a.changed(), vec![one.clone()]);
    let before = a
        .call(
            "channels.edits",
            json!({"sourceId": "s1", "hiddenOnly": true}),
        )
        .await;
    a.call("channels.setHidden", hide).await;
    assert!(a.changed().is_empty());
    let after = a
        .call(
            "channels.edits",
            json!({"sourceId": "s1", "hiddenOnly": true}),
        )
        .await;
    assert_eq!(after, before, "updatedAt is kept");

    // A real change still sends one event.
    a.call("channels.reset", json!({"sourceId": "s1"})).await;
    assert_eq!(a.changed(), vec![one]);
}

#[tokio::test]
async fn backup_export_and_import_keep_the_newer_edit() {
    let a = app().await;
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102")], "hidden": true}),
    )
    .await;
    a.call(
        "channels.rename",
        json!({"ref": live("s1", "101"), "name": "Mine"}),
    )
    .await;
    let exported = a
        .state
        .db_call(|c| channeledit::export_edits(c, "s1"))
        .await
        .unwrap();
    assert_eq!(exported.len(), 2);
    assert_eq!(exported[0].item_id, "101");
    assert_eq!(exported[0].name.as_deref(), Some("Mine"));
    assert!(!exported[0].hidden);
    assert_eq!(exported[1].item_id, "102");
    assert!(exported[1].hidden);
    assert_eq!(exported[1].original_name, "CNN International");
    let json = serde_json::to_value(&exported).unwrap();
    assert!(json[1].get("name").is_none(), "{json}");
    assert_eq!(json[0]["contentType"], "live");

    // Into s2: bad entries are skipped and the counts follow.
    let entry = |id: &str, hidden: bool, name: Option<&str>, at: &str| ChannelEditBackup {
        content_type: ContentType::Live,
        item_id: id.into(),
        hidden,
        name: name.map(str::to_string),
        original_name: "BBC One".into(),
        updated_at: at.into(),
    };
    let rows = vec![
        entry("7", true, Some("  Imported  "), "2026-01-01T00:00:00Z"),
        entry("", true, None, "2026-01-01T00:00:00Z"),
        entry("8", false, None, "2026-01-01T00:00:00Z"),
        entry("9", false, Some("\u{7}"), "2026-01-01T00:00:00Z"),
        ChannelEditBackup {
            content_type: ContentType::Movie,
            ..entry("10", true, None, "2026-01-01T00:00:00Z")
        },
    ];
    let n = a
        .state
        .db_call(move |c| channeledit::import_edits(c, "s2", &rows))
        .await
        .unwrap();
    assert_eq!(n, 1);
    let page = a.call("catalog.channels", json!({"sourceId": "s2"})).await;
    assert_eq!(page["total"], 0, "the imported hidden row applies");
    assert_eq!(a.channel_count("s2").await, 0);
    let edits = a.call("channels.edits", json!({"sourceId": "s2"})).await;
    assert_eq!(edits[0]["name"], "Imported");
    assert!(
        edits[0]["updatedAt"]
            .as_str()
            .unwrap()
            .starts_with("2026-01-01T00:00:00"),
        "{edits}"
    );

    // An older copy does not roll the row back; a newer one replaces it.
    let older = vec![entry("7", false, Some("Old"), "2025-06-01T00:00:00Z")];
    let n = a
        .state
        .db_call(move |c| channeledit::import_edits(c, "s2", &older))
        .await
        .unwrap();
    assert_eq!(n, 0);
    let newer = vec![entry("7", false, Some("New"), "2026-06-01 00:00:00")];
    let n = a
        .state
        .db_call(move |c| channeledit::import_edits(c, "s2", &newer))
        .await
        .unwrap();
    assert_eq!(n, 1);
    let page = a.call("catalog.channels", json!({"sourceId": "s2"})).await;
    assert_eq!(page["total"], 1);
    assert_eq!(name_of(&page["items"], "7"), "New");
    assert_eq!(a.channel_count("s2").await, 1);
    // Unknown source.
    let rows = vec![entry("7", true, None, "2026-01-01T00:00:00Z")];
    assert!(a
        .state
        .db_call(move |c| channeledit::import_edits(c, "nope", &rows))
        .await
        .is_err());
}

#[tokio::test]
async fn parental_locks_and_english_only_count_a_hidden_channel_once() {
    let a = app().await;
    a.state
        .db_call(|c| {
            for (id, name) in [("102", "CNN"), ("103", "Sky")] {
                c.execute(
                    "INSERT INTO parental_locks(source_id, content_type, kind, target_id, name, created_at)
                     VALUES ('s1', 'live', 'item', ?1, ?2, CURRENT_TIMESTAMP)",
                    params![id, name],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102")], "hidden": true}),
    )
    .await;
    let hide = Some(iptv_core::parental::Hide { auto_adult: false });
    for english in [false, true] {
        let cats = a
            .state
            .db_call(move |c| {
                iptv_core::catalog::visible_categories(
                    c,
                    "s1",
                    ContentType::Live,
                    false,
                    english,
                    None,
                    hide,
                )
            })
            .await
            .unwrap();
        let news = cats.iter().find(|c| c.id == "news").unwrap();
        // 101, 102 (hidden and locked), 103 (locked): 101 remains.
        assert_eq!(news.item_count, 1, "englishOnly {english}");
    }
    // English-only alone (every title here is English).
    a.call("settings.update", json!({"patch": {"englishOnly": true}}))
        .await;
    assert_eq!(
        a.category_counts(false).await,
        counts(&[("news", 2), ("sport", 1), ("solo", 1)])
    );
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(page["total"], 4);
    let v = a.call("catalog.search", json!({"query": "CNN"})).await;
    assert!(ids(&v["live"]).is_empty());
}

/// The Live TV quality filter with parental locks and hidden channels: a
/// locked channel the filter already drops is not taken out of its group's
/// count again, also when it is hidden too (`locked_item_counts` and
/// `locked_hidden_counts` test the filter as well).
#[tokio::test]
async fn parental_locks_and_the_quality_filter_count_a_channel_once() {
    use iptv_core::catalog::quality::QualityFilter;
    use iptv_core::live::matcher::Quality;

    let a = app().await;
    // The fixture writes past the catalog writer, so the codes are stored
    // here. News: 101 HD and locked, 102 SD, locked and hidden, 103 untagged
    // (still -1, which readers take as untagged).
    a.state
        .db_call(|c| {
            let rows = [("101", "BBC One HD", 2), ("102", "CNN SD", 1)];
            for (id, title, code) in rows {
                c.execute(
                    "UPDATE items SET title = ?2, quality = ?3 WHERE source_id = 's1' AND content_type = 'live' AND item_id = ?1",
                    params![id, title, code],
                )?;
                c.execute(
                    "INSERT INTO parental_locks(source_id, content_type, kind, target_id, name, created_at)
                     VALUES ('s1', 'live', 'item', ?1, ?2, CURRENT_TIMESTAMP)",
                    params![id, title],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102")], "hidden": true}),
    )
    .await;
    let hide = Some(iptv_core::parental::Hide { auto_adult: false });
    let groups = |min: Quality, untagged: bool| {
        let quality = Some(QualityFilter {
            min,
            hide_untagged: untagged,
        });
        let state = a.state.clone();
        async move {
            let all = state
                .db_call(move |c| {
                    iptv_core::catalog::visible_categories(
                        c,
                        "s1",
                        ContentType::Live,
                        false,
                        false,
                        quality,
                        hide,
                    )
                })
                .await
                .unwrap();
            all.into_iter()
                .map(|c| (c.id, c.item_count))
                .collect::<Vec<_>>()
        }
    };
    // HD and up: News counts 103 only. 101 leaves through its lock; 102 is
    // in neither the count nor the locks the filter keeps, so the hidden
    // and locked overlap must not add it back.
    assert_eq!(
        groups(Quality::Hd, false).await,
        counts(&[("news", 1), ("sport", 1), ("solo", 1)])
    );
    // Full HD and up: 101 and 102 are dropped by the filter, so neither
    // lock takes anything out of News again.
    assert_eq!(
        groups(Quality::Fhd, false).await,
        counts(&[("news", 1), ("sport", 1), ("solo", 1)])
    );
    // HD and up without untagged channels: the lock on 101 empties News, and
    // the filter empties the other groups.
    assert!(groups(Quality::Hd, true).await.is_empty());

    // The rpc without hide mode: News keeps 101 and 103.
    a.call(
        "settings.update",
        json!({"patch": {"liveMinQuality": "hd"}}),
    )
    .await;
    assert_eq!(
        a.category_counts(false).await,
        counts(&[("news", 2), ("sport", 1), ("solo", 1)])
    );
    let page = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(page["total"], 4);
}

// ---------------------------------------------------------------------------
// Refreshes and source removal
// ---------------------------------------------------------------------------

/// `n` channels in two groups; `extra` appends one more channel.
fn playlist(n: usize, extra: bool) -> String {
    let mut s = String::from("#EXTM3U\n");
    for i in 0..n {
        s.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"c{i}.example\" group-title=\"Group {}\",Channel {i}\nhttp://stream.example/live/{i}.ts\n",
            i % 2
        ));
    }
    if extra {
        s.push_str(
            "#EXTINF:-1 group-title=\"Group 0\",Late Arrival\nhttp://stream.example/live/late.ts\n",
        );
    }
    s
}

async fn edit_count(state: &Arc<AppState>, source: &str) -> i64 {
    let s = source.to_string();
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT count(*) FROM channel_edits WHERE source_id = ?1",
                [s],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edits_survive_m3u_reimports_and_go_with_the_source() {
    let _serial = SERIAL.read().await;
    let env = support::env().await;
    let router = build_router();
    let call = |cmd: &'static str, args: Value| {
        let r = &router;
        let state = env.state.clone();
        async move {
            r.dispatch(state, cmd, args.clone())
                .await
                .unwrap_or_else(|e| panic!("{cmd} {args}: {}", e.message))
        }
    };
    let http = support::stub(&playlist(10, false)).await;
    let src = iptv_core::sources::add(env.state.clone(), support::url_args(&http.url(), false))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 10);
    let sid = src.id.clone();
    let page = call("catalog.channels", json!({"sourceId": sid})).await;
    let r3 = page["items"][3]["ref"].clone();
    let r4 = page["items"][4]["ref"].clone();
    let r5 = page["items"][5]["ref"].clone();
    call("channels.setHidden", json!({"refs": [r3], "hidden": true})).await;
    call("channels.rename", json!({"ref": r4, "name": "Four"})).await;
    let check = |page: &Value, total: i64| {
        assert_eq!(page["total"], total, "{page}");
        let items = page["items"].as_array().unwrap();
        assert!(
            items.iter().all(|c| c["ref"] != r3),
            "hidden 3 is back: {page}"
        );
        let four = items.iter().find(|c| c["ref"] == r4).unwrap();
        assert_eq!(four["name"], "Four");
        let five = items.iter().find(|c| c["ref"] == r5).unwrap();
        assert_eq!(five["name"], "Channel 5");
    };
    check(&call("catalog.channels", json!({"sourceId": sid})).await, 9);

    // The same playlist again (the importer may keep the catalog), then a
    // changed one (the catalog is rewritten): the edits hold either way.
    let again = iptv_core::sources::refresh(env.state.clone(), &sid)
        .await
        .unwrap();
    assert_eq!(
        again.channel_count, 9,
        "counts leave the hidden channel out"
    );
    check(&call("catalog.channels", json!({"sourceId": sid})).await, 9);
    http.set_body(&playlist(10, true));
    let again = iptv_core::sources::refresh(env.state.clone(), &sid)
        .await
        .unwrap();
    assert_eq!(again.channel_count, 10);
    check(
        &call("catalog.channels", json!({"sourceId": sid})).await,
        10,
    );
    let cats = call(
        "catalog.categories",
        json!({"sourceId": sid, "contentType": "live"}),
    )
    .await;
    let sum: i64 = cats
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["itemCount"].as_i64().unwrap())
        .sum();
    assert_eq!(sum, 10, "category counts after the rewrite: {cats}");
    let v = call("catalog.search", json!({"query": "Four"})).await;
    assert_eq!(v["live"][0]["ref"], r4);
    let edits = call("channels.edits", json!({"sourceId": sid})).await;
    assert_eq!(edits.as_array().unwrap().len(), 2);

    // Removing the source removes its edits.
    call("sources.remove", json!({"id": sid})).await;
    assert_eq!(edit_count(&env.state, &sid).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edits_survive_a_refresh_of_the_mock_xtream_source() {
    let _serial = SERIAL.read().await;
    let server = stub::server().await;
    let (_dir, state, _rx) = stub::state().await;
    let router = build_router();
    let call = |cmd: &'static str, args: Value| {
        let r = &router;
        let state = state.clone();
        async move {
            r.dispatch(state, cmd, args.clone())
                .await
                .unwrap_or_else(|e| panic!("{cmd} {args}: {}", e.message))
        }
    };
    let sid = stub::add_source(&state, &server.server_url, stub::USER, stub::PASS).await;
    call("xtream.sync", json!({"sourceId": sid})).await;
    let page = call(
        "catalog.channels",
        json!({"sourceId": sid, "query": {"limit": 1000}}),
    )
    .await;
    let total = page["total"].as_i64().unwrap();
    assert!(total >= 3, "{page}");
    let hidden = page["items"][0]["ref"].clone();
    let renamed = page["items"][1]["ref"].clone();
    let renamed_number = page["items"][1]["number"].clone();
    call(
        "channels.setHidden",
        json!({"refs": [hidden], "hidden": true}),
    )
    .await;
    call(
        "channels.rename",
        json!({"ref": renamed, "name": "Renamed Here"}),
    )
    .await;

    call("xtream.sync", json!({"sourceId": sid})).await;
    let page = call(
        "catalog.channels",
        json!({"sourceId": sid, "query": {"limit": 1000}}),
    )
    .await;
    assert_eq!(page["total"], total - 1);
    let items = page["items"].as_array().unwrap();
    assert!(items.iter().all(|c| c["ref"] != hidden));
    assert_eq!(
        items.iter().find(|c| c["ref"] == renamed).unwrap()["name"],
        "Renamed Here"
    );
    let v = call("catalog.search", json!({"query": "Renamed Here"})).await;
    assert_eq!(v["live"][0]["ref"], renamed);
    if let Some(n) = renamed_number.as_i64() {
        let c = call(
            "catalog.channelByNumber",
            json!({"sourceId": sid, "number": n}),
        )
        .await;
        assert_eq!(c["name"], "Renamed Here");
    }
    let sources = call("sources.list", json!({})).await;
    let me = sources
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == sid.as_str())
        .unwrap();
    assert_eq!(me["channelCount"], total - 1, "{me}");
    call("sources.remove", json!({"id": sid})).await;
    assert_eq!(edit_count(&state, &sid).await, 0);
}

// ---------------------------------------------------------------------------
// Check 4: 1,000 hidden and 1,000 renamed channels among 50k
// ---------------------------------------------------------------------------

const CHANNELS: usize = 50_000;
const GROUPS: usize = 250;
/// One call (a page, a keystroke), as in `catalog_perf`. The bar is the
/// release build (`cargo test --release --test channel_edits`); a debug
/// build gets three times as long.
#[cfg(debug_assertions)]
const QUERY_BUDGET: Duration = Duration::from_millis(300);
#[cfg(not(debug_assertions))]
const QUERY_BUDGET: Duration = Duration::from_millis(100);
/// The 1001-row search (the UI's "show up to 1000" step) has its own
/// budget, recorded in docs/architecture/channel-edits.md. "channel"
/// matches 49k titles here (34k left after English-only), and ranking every
/// match costs nearly the same at limit 30 as at 1001: about 90 ms in
/// release on a quiet
/// machine (85 to 94 ms; bm25 ranking about 30 ms, the category join for
/// the hidden-category and English-only filters about 18 ms, the empty
/// movie and series passes about 9 ms each). The hidden set adds about 9 %.
/// At 100 ms about one run in four failed.
#[cfg(debug_assertions)]
const WIDE_SEARCH_BUDGET: Duration = Duration::from_millis(450);
#[cfg(not(debug_assertions))]
const WIDE_SEARCH_BUDGET: Duration = Duration::from_millis(150);

/// Group `g` of the mixed playlist (as in `catalog_perf`, without the adult
/// groups): French (hidden by English-only), British (kept) or untagged.
fn mixed_group(g: usize) -> String {
    match g % 5 {
        0 => format!("FR | Groupe {g}"),
        1 => format!("UK | Group {g}"),
        _ => format!("Group {g}"),
    }
}

/// Channel `i`'s title, as in `catalog_perf`.
fn mixed_title(i: usize) -> String {
    match i % 50 {
        3 => format!("Канал {i}"),
        n if n % 7 == 0 => format!("DE - Channel {i}"),
        n if n % 7 == 1 => format!("EN - Channel {i}"),
        n if n % 7 == 2 => format!("UK: Channel {i}"),
        n if n % 7 == 3 => format!("BBC Channel {i}"),
        _ => format!("Channel {i}"),
    }
}

fn gen_mixed_m3u(n: usize, groups: usize) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(n * 170);
    s.push_str("#EXTM3U\n");
    for i in 0..n {
        let _ = write!(
            s,
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" tvg-logo=\"http://logo.example/{i}.png\" group-title=\"{}\",{}\nhttp://stream.example/live/{i}.ts\n",
            mixed_group(i % groups),
            mixed_title(i)
        );
    }
    s
}

/// Check 4: with 1,000 hidden and 1,000 renamed channels among 50k and
/// English-only on, every list and search call stays within budget. The
/// hidden channels (i % 50 == 6) and the renamed ones (i % 50 == 11) all
/// have plain titles in British groups, so English-only keeps them and each
/// edit changes what the call returns. Totals are checked against the Rust
/// rules.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edits_keep_lists_and_search_fast_on_50k_channels_with_english_only() {
    use iptv_core::catalog::language::is_non_english;

    let _serial = SERIAL.write().await;
    let env = support::env().await;
    let r = build_router();
    let src = support::add_text(&env.state, "mixed", &gen_mixed_m3u(CHANNELS, GROUPS)).await;
    assert_eq!(src.channel_count, CHANNELS as i64);
    let sid = src.id.clone();
    let call = |method: &'static str, args: Value| {
        let r = &r;
        let state = env.state.clone();
        async move {
            r.dispatch(state, method, args.clone())
                .await
                .unwrap_or_else(|e| panic!("{method} {args}: {e:?}"))
        }
    };
    // Item ids by title (titles are unique).
    let s2 = sid.clone();
    let by_title: std::collections::HashMap<String, String> = env
        .state
        .db_call(move |c| {
            let mut stmt = c.prepare(
                "SELECT title, item_id FROM items WHERE source_id = ?1 AND content_type = 'live'",
            )?;
            let rows = stmt.query_map([s2], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    let id_of = |i: usize| by_title[&mixed_title(i)].clone();
    // 1,000 hidden through the RPC, in two calls of 500.
    let hidden: Vec<usize> = (0..CHANNELS).filter(|i| i % 50 == 6).collect();
    assert_eq!(hidden.len(), 1000);
    for chunk in hidden.chunks(MAX_REFS) {
        let refs: Vec<Value> = chunk.iter().map(|i| live(&sid, &id_of(*i))).collect();
        call("channels.setHidden", json!({"refs": refs, "hidden": true})).await;
    }
    // 1,000 renamed: a few through the RPC, the rest in one transaction
    // (the reads are what is measured).
    let renamed: Vec<usize> = (0..CHANNELS).filter(|i| i % 50 == 11).collect();
    assert_eq!(renamed.len(), 1000);
    for i in &renamed[..5] {
        call(
            "channels.rename",
            json!({"ref": live(&sid, &id_of(*i)), "name": format!("Renamed {i}")}),
        )
        .await;
    }
    let rest: Vec<(String, String)> = renamed[5..]
        .iter()
        .map(|i| (id_of(*i), format!("Renamed {i}")))
        .collect();
    let s3 = sid.clone();
    env.state
        .db_call(move |c| {
            let tx = c.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO channel_edits(source_id, content_type, item_id, hidden, name, original_name, updated_at)
                     SELECT source_id, content_type, item_id, 0, ?3, title, '2026-10-14T00:00:00.000Z' FROM items
                     WHERE source_id = ?1 AND content_type = 'live' AND item_id = ?2",
                )?;
                for (id, name) in &rest {
                    assert_eq!(stmt.execute(params![s3, id, name])?, 1);
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .unwrap();
    call("settings.update", json!({"patch": {"englishOnly": true}})).await;

    // Expected rows, from the Rust rules.
    let visible = (0..CHANNELS)
        .filter(|i| i % 50 != 6)
        .filter(|i| !is_non_english(&mixed_title(*i), Some(mixed_group(i % GROUPS).as_str())))
        .count();
    assert!(visible > CHANNELS / 3 && visible < CHANNELS, "{visible}");
    let cats = call(
        "catalog.categories",
        json!({"sourceId": sid, "contentType": "live"}),
    )
    .await;
    // Channel i sits in group i % 250, so a group's channels share i % 50:
    // the 200 channels of group 156 are all hidden (the group leaves the
    // sidebar), the 200 of group 161 are all renamed.
    let find = |g: usize| {
        cats.as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == mixed_group(g))
            .cloned()
    };
    assert!(find(156).is_none(), "an emptied group is dropped");
    let renamed_group = find(161).unwrap_or_else(|| panic!("{cats}"));
    assert_eq!(renamed_group["itemCount"], 200, "{renamed_group}");
    let group_id = renamed_group["id"].clone();

    type Check = Box<dyn Fn(&Value)>;
    let calls: Vec<(&str, &'static str, Value, Check)> = vec![
        (
            "first page",
            "catalog.channels",
            json!({"sourceId": sid}),
            Box::new(move |v: &Value| {
                assert_eq!(v["total"], visible as i64);
                assert!(v["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["name"].as_str().unwrap().starts_with("Renamed ")));
            }),
        ),
        (
            "deep page",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"offset": visible - 100, "limit": 100}}),
            Box::new(|v: &Value| assert_eq!(v["items"].as_array().unwrap().len(), 100)),
        ),
        (
            "group page",
            "catalog.channels",
            json!({"sourceId": sid, "categoryId": group_id}),
            Box::new(|v: &Value| {
                assert_eq!(v["total"], 200);
                assert!(v["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|c| c["name"].as_str().unwrap().starts_with("Renamed ")));
            }),
        ),
        (
            "sorted by name",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"sort": "name", "dir": "desc"}}),
            Box::new(move |v: &Value| assert_eq!(v["total"], visible as i64)),
        ),
        (
            "in-list search, custom name",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"search": "Renamed 2"}}),
            Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() > 0, "{v}")),
        ),
        (
            "in-list search, provider name",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"search": "Channel 99"}}),
            Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() > 0, "{v}")),
        ),
        (
            "in-list search, one letter",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"search": "c"}}),
            Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() > 0, "{v}")),
        ),
        (
            "global search, custom name",
            "catalog.search",
            json!({"query": "Renamed 1"}),
            Box::new(|v: &Value| {
                let live = v["live"].as_array().unwrap();
                assert!(!live.is_empty(), "{v}");
                assert!(live[0]["name"].as_str().unwrap().starts_with("Renamed 1"));
            }),
        ),
        (
            "global search, provider name",
            "catalog.search",
            json!({"query": "Channel 1234"}),
            Box::new(|v: &Value| assert!(v["live"].is_array(), "{v}")),
        ),
        (
            "global search, wide",
            "catalog.search",
            json!({"query": "channel", "limit": 1001}),
            Box::new(|v: &Value| assert!(!v["live"].as_array().unwrap().is_empty())),
        ),
        (
            "categories",
            "catalog.categories",
            json!({"sourceId": sid, "contentType": "live"}),
            Box::new(|v: &Value| assert!(!v.as_array().unwrap().is_empty())),
        ),
        (
            // L3-perf-desktop-7: the one call the Live page makes.
            "categories, includeHidden",
            "catalog.categories",
            json!({"sourceId": sid, "contentType": "live", "includeHidden": true}),
            Box::new(|v: &Value| {
                let flag = |g: usize| {
                    v.as_array()
                        .unwrap()
                        .iter()
                        .find(|c| c["name"] == mixed_group(g))
                        .unwrap_or_else(|| panic!("group {g} missing: {v}"))["emptiedByEdits"]
                        .clone()
                };
                // Groups g with g % 50 == 6 have every channel hidden.
                assert_eq!(flag(156), true, "all 200 channels hidden");
                assert_eq!(flag(6), true, "all 200 channels hidden");
                assert_eq!(flag(161), false, "renamed, not hidden");
            }),
        ),
        (
            "all live channels (zap list)",
            "catalog.allLiveChannels",
            json!({"sourceId": sid}),
            Box::new(move |v: &Value| {
                assert_eq!(
                    v.as_array().unwrap().len(),
                    visible.min(iptv_core::catalog::ALL_LIVE_CAP)
                )
            }),
        ),
    ];
    for (label, method, args, check) in calls {
        let first = call(method, args.clone()).await;
        check(&first);
        let started = Instant::now();
        let v = call(method, args).await;
        let took = started.elapsed();
        check(&v);
        eprintln!("channel_edits perf: {label} in {took:?}");
        // The capped 20k-row zap list has four budgets, as in catalog_perf;
        // the 1001-row search has its own (see WIDE_SEARCH_BUDGET).
        let budget = if method == "catalog.allLiveChannels" {
            QUERY_BUDGET * 4
        } else if label == "global search, wide" {
            WIDE_SEARCH_BUDGET
        } else {
            QUERY_BUDGET
        };
        assert!(took < budget, "{label} took {took:?} (budget {budget:?})");
    }
    let mid = call(
        "catalog.channels",
        json!({"sourceId": sid, "query": {"offset": visible / 2, "limit": 1}}),
    )
    .await;
    let reference = mid["items"][0]["ref"].clone();
    let _ = call("catalog.neighbors", json!({"ref": reference})).await;
    let started = Instant::now();
    let n = call("catalog.neighbors", json!({"ref": reference})).await;
    let took = started.elapsed();
    eprintln!("channel_edits perf: neighbors in {took:?}");
    assert!(n["next"].is_object() && n["prev"].is_object(), "{n}");
    assert!(took < QUERY_BUDGET, "neighbors took {took:?}");
}

/// L3-perf-desktop-7: `catalog.categories` with `includeHidden` flags each
/// group with `emptiedByEdits`: true exactly for the groups the answer
/// without `includeHidden` drops only because hidden channels emptied them.
/// A group the provider ships empty, a partly hidden group and a hidden
/// category are false, so the Live page can derive the shown groups from
/// the one includeHidden answer.
#[tokio::test]
async fn categories_flag_the_groups_emptied_by_hidden_channels() {
    let a = app().await;
    a.state
        .db_call(|c| {
            c.execute(
                "INSERT INTO categories(source_id, content_type, category_id, name, position) VALUES ('s1', 'live', 'empty', 'Empty', 3)",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let flags = |v: &Value| -> Vec<(String, Option<bool>)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["id"].as_str().unwrap().to_string(),
                    c.get("emptiedByEdits").map(|f| f.as_bool().unwrap()),
                )
            })
            .collect()
    };
    let cats = |include_hidden: bool| {
        a.call(
            "catalog.categories",
            json!({"sourceId": "s1", "contentType": "live", "includeHidden": include_hidden}),
        )
    };
    let flag = |id: &str, f: bool| (id.to_string(), Some(f));

    // No edits: every group is false, and the flag is always sent.
    assert_eq!(
        flags(&cats(true).await),
        vec![
            flag("news", false),
            flag("sport", false),
            flag("solo", false),
            flag("empty", false)
        ]
    );

    // 105 is the only channel of solo; 102 is one of three in news; sport
    // is a hidden category whose only channel is hidden too.
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "102"), live("s1", "105"), live("s1", "104")], "hidden": true}),
    )
    .await;
    a.call(
        "catalog.setCategoryHidden",
        json!({"sourceId": "s1", "contentType": "live", "categoryId": "sport", "hidden": true}),
    )
    .await;
    let all = cats(true).await;
    assert_eq!(
        flags(&all),
        vec![
            flag("news", false),
            flag("sport", false),
            flag("solo", true),
            flag("empty", false)
        ]
    );
    let shown = cats(false).await;
    assert_eq!(
        flags(&shown),
        vec![("news".to_string(), None), ("empty".to_string(), None)],
        "solo (emptied) and sport (hidden) are left out; no flag without includeHidden"
    );
    // The derivation the Live page makes from the includeHidden answer.
    let derived: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["hidden"] == false && c["emptiedByEdits"] == false)
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(derived, vec!["news", "empty"]);

    // Unhiding the channel brings solo back and clears its flag.
    a.call(
        "channels.setHidden",
        json!({"refs": [live("s1", "105")], "hidden": false}),
    )
    .await;
    assert_eq!(flags(&cats(true).await)[2], flag("solo", false));
}
