//! Run 2 check 5 (contract C8): a backup export followed by a Replace import
//! into a fresh data folder keeps custom lists (items from two sources,
//! remapped through `exportedId`), channel edits, recording rules, the watch
//! log and the five C1 settings keys. An IPTVnator-shaped file without the
//! new keys still imports, and a Merge import maps lists by name and drops
//! the items of sources that are not in the file.
//!
//! Catalogs come from the real M3U importer reading inline playlist text, so
//! nothing here touches the network. Module state the backup carries per
//! source (edits, rules, watch log) is seeded through each module's own
//! backup import function, the same path a restore takes.

use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::sync::Arc;

const ALPHA_M3U: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"a.news\" group-title=\"News\",Alpha News\nhttp://127.0.0.1:9/alpha/news.ts\n\
#EXTINF:-1 tvg-id=\"a.sport\" group-title=\"Sport\",Alpha Sport\nhttp://127.0.0.1:9/alpha/sport.ts\n\
#EXTINF:-1 tvg-id=\"a.kids\" group-title=\"Kids\",Alpha Kids\nhttp://127.0.0.1:9/alpha/kids.ts\n";

const BETA_M3U: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"b.one\" group-title=\"General\",Beta One\nhttp://127.0.0.1:9/beta/one.ts\n\
#EXTINF:-1 tvg-id=\"b.two\" group-title=\"General\",Beta Two\nhttp://127.0.0.1:9/beta/two.ts\n";

const OTHER_M3U: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"o.one\" group-title=\"Misc\",Other One\nhttp://127.0.0.1:9/other/one.ts\n";

const SUBTITLE_PATCH: &str = r#"{"subtitleSize": "large", "subtitleColor": "yellow", "subtitleBackground": "solid", "subtitlePosition": 25, "vodHideWatched": true}"#;

/// An IPTVnator v1 M3U entry with inline playlist text and an empty
/// IPTVnator `userState` (no Tsrust keys).
fn entry(exported_id: &str, title: &str, m3u: &str) -> Value {
    json!({
        "portalType": "m3u",
        "exportedId": exported_id,
        "title": title,
        "autoRefresh": false,
        "source": { "kind": "text", "rawM3u": m3u },
        "userState": { "favorites": [], "recentlyViewed": [], "hiddenGroupTitles": [] }
    })
}

/// An IPTVnator-shaped backup file holding `entries`.
fn manifest(entries: Vec<Value>) -> String {
    json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "exportedAt": "2026-10-01T12:00:00.000Z",
        "includeSecrets": true,
        "settings": { "epgUrls": [] },
        "playlists": entries
    })
    .to_string()
}

fn alpha_and_beta() -> String {
    manifest(vec![
        entry("src-a", "Alpha", ALPHA_M3U),
        entry("src-b", "Beta", BETA_M3U),
    ])
}

fn live(source: &str, id: &str) -> Value {
    json!({"sourceId": source, "contentType": "live", "itemId": id})
}

fn new_item(r: Value, title: &str) -> Value {
    json!({"ref": r, "snapshot": {"title": title, "contentType": "live"}})
}

fn yesterday() -> String {
    (chrono::Utc::now().date_naive() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string()
}

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
}

async fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    App {
        _dir: dir,
        state,
        router: build_router(),
    }
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {}", e.message))
    }

    async fn import(&self, json: &str, mode: &str) -> Value {
        self.call("backup.import", json!({"json": json, "mode": mode}))
            .await
    }

    async fn export(&self) -> Value {
        let out = self
            .call("backup.export", json!({"includeSecrets": true}))
            .await;
        serde_json::from_str(out["json"].as_str().unwrap()).unwrap()
    }

    async fn lists(&self) -> Vec<Value> {
        self.call("lists.list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    /// `(name, onDashboard, itemCount)` of every list, in list order.
    async fn list_summary(&self) -> Vec<(String, bool, i64)> {
        self.lists()
            .await
            .iter()
            .map(|l| {
                (
                    l["name"].as_str().unwrap().to_string(),
                    l["onDashboard"].as_bool().unwrap(),
                    l["itemCount"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    async fn list_id(&self, name: &str) -> String {
        self.lists()
            .await
            .iter()
            .find(|l| l["name"] == name)
            .unwrap_or_else(|| panic!("no list {name:?}"))["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn items(&self, list: &str) -> Vec<Value> {
        let id = self.list_id(list).await;
        self.call("lists.items", json!({"id": id}))
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    /// `(sourceId, itemId)` of a list's items, in list order.
    async fn item_refs(&self, list: &str) -> Vec<(String, String)> {
        self.items(list)
            .await
            .iter()
            .map(|i| {
                (
                    i["ref"]["sourceId"].as_str().unwrap().to_string(),
                    i["ref"]["itemId"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    async fn source(&self, name: &str) -> Option<String> {
        let name = name.to_string();
        self.state
            .db_call(move |c| {
                use rusqlite::OptionalExtension;
                Ok(
                    c.query_row("SELECT id FROM sources WHERE name = ?1", [name], |r| {
                        r.get(0)
                    })
                    .optional()?,
                )
            })
            .await
            .unwrap()
    }

    /// The catalog id of the live channel titled `title` in source `sid`.
    async fn channel(&self, sid: &str, title: &str) -> String {
        let key = [sid.to_string(), title.to_string()];
        self.state
            .db_call(move |c| {
                Ok(c.query_row(
                    "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' AND title = ?2",
                    key,
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap_or_else(|e| panic!("no channel {title:?} in {sid}: {e}"))
    }

    /// Every row of `sql` (which must select text-convertible columns),
    /// each column rendered as a string.
    async fn rows(&self, sql: &'static str) -> Vec<Vec<String>> {
        self.state
            .db_call(move |c| {
                let mut stmt = c.prepare(sql)?;
                let n = stmt.column_count();
                let rows = stmt.query_map([], |r| {
                    (0..n)
                        .map(|i| {
                            let v: rusqlite::types::Value = r.get(i)?;
                            Ok(match v {
                                rusqlite::types::Value::Null => "NULL".to_string(),
                                rusqlite::types::Value::Integer(i) => i.to_string(),
                                rusqlite::types::Value::Real(f) => f.to_string(),
                                rusqlite::types::Value::Text(s) => s,
                                rusqlite::types::Value::Blob(_) => "BLOB".to_string(),
                            })
                        })
                        .collect::<rusqlite::Result<Vec<String>>>()
                })?;
                Ok(rows.collect::<Result<_, _>>()?)
            })
            .await
            .unwrap()
    }
}

/// Catalog ids of the seeded channels (the same in every data folder: M3U
/// ids derive from the stream URL and name).
struct Channels {
    a_news: String,
    a_sport: String,
    a_kids: String,
    b_one: String,
    b_two: String,
}

/// Imports Alpha (`src-a`) and Beta (`src-b`), then builds three lists in
/// the order Kids, Mix, Empty: Mix holds Alpha Sport, Beta One and Alpha
/// News; Kids holds Alpha Kids and is off the dashboard; Empty has nothing.
/// Sets the five C1 settings keys.
async fn seeded() -> (App, Channels) {
    let a = app().await;
    let rep = a.import(&alpha_and_beta(), "merge").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert_eq!(a.source("Alpha").await.as_deref(), Some("src-a"));
    assert_eq!(a.source("Beta").await.as_deref(), Some("src-b"));
    let ch = Channels {
        a_news: a.channel("src-a", "Alpha News").await,
        a_sport: a.channel("src-a", "Alpha Sport").await,
        a_kids: a.channel("src-a", "Alpha Kids").await,
        b_one: a.channel("src-b", "Beta One").await,
        b_two: a.channel("src-b", "Beta Two").await,
    };
    let mix = a
        .call(
            "lists.create",
            json!({"name": "Mix", "items": [
                new_item(live("src-a", &ch.a_sport), "Alpha Sport"),
                new_item(live("src-b", &ch.b_one), "Beta One"),
                new_item(live("src-a", &ch.a_news), "Alpha News"),
            ]}),
        )
        .await["id"]
        .clone();
    let kids = a
        .call(
            "lists.create",
            json!({"name": "Kids", "items": [new_item(live("src-a", &ch.a_kids), "Alpha Kids")]}),
        )
        .await["id"]
        .clone();
    a.call("lists.update", json!({"id": kids, "onDashboard": false}))
        .await;
    let empty = a.call("lists.create", json!({"name": "Empty"})).await["id"].clone();
    a.call("lists.reorder", json!({"ids": [kids, mix, empty]}))
        .await;
    iptv_core::settings::update(&a.state, serde_json::from_str(SUBTITLE_PATCH).unwrap())
        .await
        .unwrap();
    assert_eq!(
        a.list_summary().await,
        [
            ("Kids".to_string(), false, 1),
            ("Mix".to_string(), true, 3),
            ("Empty".to_string(), true, 0)
        ]
    );
    (a, ch)
}

/// Exports `src`, then Replace-imports the file into a fresh data folder
/// that already holds an unrelated source with id `src-a`, so the backup's
/// `src-a` has to be imported under a new id. Returns the exported manifest,
/// the new app, its import report and the id Alpha was imported as.
async fn replace_into_fresh(src: &App) -> (Value, App, Value, String) {
    let out = src.export().await;
    let dst = app().await;
    dst.import(&manifest(vec![entry("src-a", "Other", OTHER_M3U)]), "merge")
        .await;
    assert_eq!(dst.source("Other").await.as_deref(), Some("src-a"));
    let rep = dst.import(&out.to_string(), "replace").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert_eq!(dst.source("Other").await, None, "Replace removed it");
    let alpha = dst.source("Alpha").await.expect("Alpha imported");
    assert_ne!(
        alpha, "src-a",
        "the old id was taken, so Alpha got a new one"
    );
    assert_eq!(dst.source("Beta").await.as_deref(), Some("src-b"));
    (out, dst, rep, alpha)
}

fn playlist<'a>(out: &'a Value, title: &str) -> &'a Value {
    out["playlists"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["title"] == title)
        .unwrap_or_else(|| panic!("no playlist {title:?} in {out}"))
}

fn warnings(rep: &Value) -> Vec<String> {
    rep["warnings"]
        .as_array()
        .map(|w| {
            w.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn lists_and_settings_survive_replace_into_a_fresh_data_dir() {
    let (src, ch) = seeded().await;
    let (out, dst, rep, alpha) = replace_into_fresh(&src).await;

    // The file: lists at the top level, items naming their source by the
    // entry's exportedId; the settings keys next to epgUrls.
    let lists = out["tsrustCustomLists"].as_array().expect("lists exported");
    let names: Vec<&str> = lists.iter().map(|l| l["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Kids", "Mix", "Empty"]);
    let mix: Vec<(&str, &str)> = lists[1]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["sourceExportedId"].as_str().unwrap(),
                i["itemId"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        mix,
        [
            ("src-a", ch.a_sport.as_str()),
            ("src-b", ch.b_one.as_str()),
            ("src-a", ch.a_news.as_str())
        ]
    );
    assert_eq!(lists[0]["onDashboard"], false);
    let s = &out["settings"];
    assert_eq!(s["subtitleSize"], "large");
    assert_eq!(s["subtitleColor"], "yellow");
    assert_eq!(s["subtitleBackground"], "solid");
    assert_eq!(s["subtitlePosition"], 25);
    assert_eq!(s["vodHideWatched"], true);

    // The restore: same lists, order and dashboard flags; items remapped to
    // the new source ids with the same catalog ids, all available.
    assert!(
        !warnings(&rep).iter().any(|w| w.starts_with("Custom lists")),
        "{rep}"
    );
    assert_eq!(
        dst.list_summary().await,
        [
            ("Kids".to_string(), false, 1),
            ("Mix".to_string(), true, 3),
            ("Empty".to_string(), true, 0)
        ]
    );
    assert_eq!(
        dst.item_refs("Mix").await,
        [
            (alpha.clone(), ch.a_sport.clone()),
            ("src-b".to_string(), ch.b_one.clone()),
            (alpha.clone(), ch.a_news.clone())
        ]
    );
    assert_eq!(dst.item_refs("Kids").await, [(alpha.clone(), ch.a_kids)]);
    let items = dst.items("Mix").await;
    assert!(items.iter().all(|i| i["available"] == true), "{items:?}");
    assert_eq!(items[0]["snapshot"]["title"], "Alpha Sport");
    assert_eq!(items[1]["channel"]["name"], "Beta One");

    let settings = serde_json::to_value(dst.state.settings_snapshot()).unwrap();
    let want: Value = serde_json::from_str(SUBTITLE_PATCH).unwrap();
    for (k, v) in want.as_object().unwrap() {
        assert_eq!(&settings[k], v, "setting {k}");
    }
}

#[tokio::test]
async fn the_watch_log_survives_replace_under_the_new_source_id() {
    let (src, ch) = seeded().await;
    let day = yesterday();
    let rows: Vec<iptv_core::stats::WatchLogBackup> = serde_json::from_value(json!([{
        "day": day, "contentType": "live", "itemId": ch.a_sport, "title": "Alpha Sport",
        "seconds": 1800, "lastAt": format!("{day}T20:00:00.000Z")
    }]))
    .unwrap();
    let n = src
        .state
        .db_call(move |c| iptv_core::stats::import_log(c, "src-a", &rows))
        .await
        .unwrap();
    assert_eq!(n.written, 1);

    let (out, dst, _rep, alpha) = replace_into_fresh(&src).await;
    let exported = playlist(&out, "Alpha")["userState"]["tsrustWatchLog"]
        .as_array()
        .expect("watch log exported");
    assert_eq!(exported.len(), 1);
    assert_eq!(exported[0]["seconds"], 1800);
    assert!(playlist(&out, "Beta")["userState"]
        .get("tsrustWatchLog")
        .is_none());
    assert_eq!(
        dst.rows("SELECT source_id, item_id, day, seconds FROM watch_log")
            .await,
        [vec![alpha, ch.a_sport, day, "1800".to_string()]]
    );
}

#[tokio::test]
async fn channel_edits_survive_replace_under_the_new_source_id() {
    let (src, ch) = seeded().await;
    let renamed: Vec<iptv_core::channeledit::ChannelEditBackup> = serde_json::from_value(json!([{
        "contentType": "live", "itemId": ch.a_news, "hidden": false,
        "name": "My News", "originalName": "Alpha News", "updatedAt": "2026-10-01T00:00:00.000Z"
    }]))
    .unwrap();
    let hidden: Vec<iptv_core::channeledit::ChannelEditBackup> = serde_json::from_value(json!([{
        "contentType": "live", "itemId": ch.b_two, "hidden": true,
        "originalName": "Beta Two", "updatedAt": "2026-10-02T00:00:00.000Z"
    }]))
    .unwrap();
    src.state
        .db_call(move |c| {
            iptv_core::channeledit::import_edits(c, "src-a", &renamed)?;
            iptv_core::channeledit::import_edits(c, "src-b", &hidden)
        })
        .await
        .unwrap();

    let (out, dst, _rep, alpha) = replace_into_fresh(&src).await;
    let a = &playlist(&out, "Alpha")["userState"]["tsrustChannelEdits"];
    assert_eq!(a.as_array().map(Vec::len), Some(1), "{a}");
    assert_eq!(a[0]["name"], "My News");
    let b = &playlist(&out, "Beta")["userState"]["tsrustChannelEdits"];
    assert_eq!(b[0]["hidden"], true, "{b}");

    let mut rows = dst
        .rows("SELECT source_id, item_id, hidden, COALESCE(name, ''), original_name FROM channel_edits")
        .await;
    rows.sort();
    let mut want = vec![
        vec![
            alpha,
            ch.a_news.clone(),
            "0".to_string(),
            "My News".to_string(),
            "Alpha News".to_string(),
        ],
        vec![
            "src-b".to_string(),
            ch.b_two,
            "1".to_string(),
            String::new(),
            "Beta Two".to_string(),
        ],
    ];
    want.sort();
    assert_eq!(rows, want);
    // The rename shows in the restored list; the snapshot keeps its title.
    let items = dst.items("Mix").await;
    assert_eq!(items[2]["channel"]["name"], "My News");
    assert_eq!(items[2]["snapshot"]["title"], "Alpha News");
}

#[tokio::test]
async fn recording_rules_survive_replace_under_the_new_source_id() {
    let (src, ch) = seeded().await;
    let rules: Vec<iptv_core::recording::RecordingRuleBackup> = serde_json::from_value(json!([{
        "contentType": "live", "itemId": ch.a_news, "channelName": "Alpha News",
        "title": "Evening Bulletin", "enabled": true, "createdAt": "2026-10-01T00:00:00.000Z"
    }]))
    .unwrap();
    let n = src
        .state
        .db_call(move |c| iptv_core::recording::import_rules(c, "src-a", &rules))
        .await
        .unwrap();
    assert_eq!(n, 1);

    let (out, dst, _rep, alpha) = replace_into_fresh(&src).await;
    let exported = &playlist(&out, "Alpha")["userState"]["tsrustRecordingRules"];
    assert_eq!(exported.as_array().map(Vec::len), Some(1), "{exported}");
    assert_eq!(exported[0]["title"], "Evening Bulletin");
    assert_eq!(
        dst.rows("SELECT source_id, item_id, channel_name, title, enabled FROM recording_rules")
            .await,
        [vec![
            alpha,
            ch.a_news,
            "Alpha News".to_string(),
            "Evening Bulletin".to_string(),
            "1".to_string()
        ]]
    );
}

/// A file from IPTVnator (no Tsrust keys) imports as before, and an export
/// with no Run 2 state carries none of the Run 2 keys. Replace with such a
/// file clears the custom lists, like every other piece of user state.
#[tokio::test]
async fn an_iptvnator_file_without_the_new_keys_still_imports() {
    let a = app().await;
    let plain = alpha_and_beta();
    let rep = a.import(&plain, "merge").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert!(warnings(&rep).is_empty(), "{rep}");
    assert!(a.lists().await.is_empty());

    let out = a.export().await;
    assert!(out.get("tsrustCustomLists").is_none(), "{out}");
    for p in out["playlists"].as_array().unwrap() {
        let us = &p["userState"];
        for k in [
            "tsrustChannelEdits",
            "tsrustRecordingRules",
            "tsrustWatchLog",
        ] {
            assert!(us.get(k).is_none(), "{k} in {us}");
        }
    }

    let (src, _) = seeded().await;
    assert_eq!(src.lists().await.len(), 3);
    let rep = src.import(&plain, "replace").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert!(src.lists().await.is_empty(), "Replace clears custom lists");
}

/// Merge with one playlist missing from the file drops that source's list
/// items with a warning; merging the full file later adds them to the lists
/// of the same name instead of creating duplicates.
#[tokio::test]
async fn merge_maps_lists_by_name_and_drops_items_of_missing_sources() {
    let (src, ch) = seeded().await;
    let full = src.export().await;
    let mut partial = full.clone();
    partial["playlists"]
        .as_array_mut()
        .unwrap()
        .retain(|p| p["title"] != "Beta");

    let dst = app().await;
    let rep = dst.import(&partial.to_string(), "merge").await;
    assert_eq!(rep["imported"], 1, "{rep}");
    let w = warnings(&rep);
    assert!(
        w.iter().any(|w| w
            .starts_with("Custom lists (source not in the backup): 1 channels not found")
            && w.contains("Beta One")),
        "{w:?}"
    );
    assert_eq!(
        dst.list_summary().await,
        [
            ("Kids".to_string(), false, 1),
            ("Mix".to_string(), true, 2),
            ("Empty".to_string(), true, 0)
        ]
    );
    assert_eq!(
        dst.item_refs("Mix").await,
        [
            ("src-a".to_string(), ch.a_sport.clone()),
            ("src-a".to_string(), ch.a_news.clone())
        ]
    );

    let rep = dst.import(&full.to_string(), "merge").await;
    assert!(
        !warnings(&rep).iter().any(|w| w.starts_with("Custom lists")),
        "{rep}"
    );
    assert_eq!(dst.lists().await.len(), 3, "merged by name, no duplicates");
    assert_eq!(
        dst.item_refs("Mix").await,
        [
            ("src-a".to_string(), ch.a_sport),
            ("src-a".to_string(), ch.a_news),
            ("src-b".to_string(), ch.b_one)
        ],
        "the missing channel is appended"
    );
}

/// Unreadable list entries are skipped and counted; the readable rest is
/// restored.
#[tokio::test]
async fn unreadable_list_entries_are_skipped_with_a_warning() {
    let a = app().await;
    let mut m: Value = serde_json::from_str(&alpha_and_beta()).unwrap();
    m["tsrustCustomLists"] = json!([
        5,
        { "items": [ {}, {} ] },
        { "name": "  Kept  ", "items": [
            { "sourceExportedId": "src-a" },
            { "sourceExportedId": "src-b", "contentType": "live", "itemId": "x", "title": "Gone" },
            { "sourceExportedId": "src-a", "contentType": "movie", "itemId": "m1", "title": "A film" }
        ] }
    ]);
    let rep = a.import(&m.to_string(), "merge").await;
    let w = warnings(&rep);
    assert!(
        w.iter()
            .any(|w| w == "Custom lists: skipped 4 unreadable entries in the backup"),
        "{w:?}"
    );
    assert!(
        w.iter()
            .any(|w| w.starts_with("Custom lists: 1 channel(s) were not restored")),
        "the movie is refused: {w:?}"
    );
    // The live item names a channel the catalog does not have: it is kept
    // and shown unavailable, like any list item whose channel went away.
    assert_eq!(a.list_summary().await, [("Kept".to_string(), true, 1)]);
    let items = a.items("Kept").await;
    assert_eq!(items[0]["available"], false);
    assert_eq!(items[0]["snapshot"]["title"], "Gone");
}

/// Seeds `n` series rules titled `"{prefix} {i}"` on Alpha's channels.
async fn seed_rules(a: &App, ch: &Channels, prefix: &str, n: usize) {
    let rules: Vec<Value> = (0..n)
        .map(|i| {
            let item = if i % 2 == 0 { &ch.a_news } else { &ch.a_sport };
            json!({
                "contentType": "live", "itemId": item, "channelName": "Alpha",
                "title": format!("{prefix} {i}"), "enabled": i % 3 != 0,
                "createdAt": "2026-10-01T00:00:00.000Z"
            })
        })
        .collect();
    let rules: Vec<iptv_core::recording::RecordingRuleBackup> =
        serde_json::from_value(Value::Array(rules)).unwrap();
    let written = a
        .state
        .db_call(move |c| iptv_core::recording::import_rules(c, "src-a", &rules))
        .await
        .unwrap();
    assert_eq!(written, n);
}

fn rule_warnings(rep: &Value) -> Vec<String> {
    warnings(rep)
        .into_iter()
        .filter(|w| w.contains("recording rule"))
        .collect()
}

/// Review fix: Replace restoring an install's own backup keeps every series
/// rule, even past half the limit of 100: the rules of the sources Replace
/// removes do not count toward it.
#[tokio::test]
async fn replace_onto_an_install_with_many_rules_keeps_them_all() {
    let (a, ch) = seeded().await;
    seed_rules(&a, &ch, "Show", 60).await;
    let out = a.export().await;
    let exported = &playlist(&out, "Alpha")["userState"]["tsrustRecordingRules"];
    assert_eq!(exported.as_array().map(Vec::len), Some(60));

    let rep = a.import(&out.to_string(), "replace").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert!(rule_warnings(&rep).is_empty(), "{rep}");
    let alpha = a.source("Alpha").await.expect("Alpha imported");
    assert_ne!(alpha, "src-a", "imported next to the old source, then kept");
    assert_eq!(
        a.rows("SELECT count(*), count(DISTINCT source_id), sum(enabled) FROM recording_rules")
            .await,
        [vec!["60".to_string(), "1".to_string(), "40".to_string()]]
    );
    assert_eq!(
        a.rows("SELECT source_id FROM recording_rules LIMIT 1")
            .await,
        [vec![alpha]]
    );
}

/// Review fix: rules the limit of 100 leaves out of a restore are reported;
/// rules already there are not counted again.
#[tokio::test]
async fn rules_over_the_limit_are_reported() {
    let (a, ch) = seeded().await;
    seed_rules(&a, &ch, "Show", 60).await;
    let out = a.export().await;
    let mut more = out.clone();
    for p in more["playlists"].as_array_mut().unwrap() {
        if let Some(rules) = p["userState"]["tsrustRecordingRules"].as_array_mut() {
            for r in rules {
                let t = r["title"].as_str().unwrap().replace("Show", "Other");
                r["title"] = json!(t);
            }
        }
    }
    let rep = a.import(&more.to_string(), "merge").await;
    assert_eq!(
        rule_warnings(&rep),
        ["20 series recording rules in the backup were not restored: you can keep up to 100 series rules"],
        "{rep}"
    );
    assert_eq!(
        a.rows("SELECT count(*) FROM recording_rules").await,
        [vec!["100".to_string()]]
    );

    let rep = a.import(&out.to_string(), "merge").await;
    assert!(rule_warnings(&rep).is_empty(), "{rep}");
    assert_eq!(
        a.rows("SELECT count(*) FROM recording_rules").await,
        [vec!["100".to_string()]]
    );
}

fn list_warnings(rep: &Value) -> Vec<String> {
    warnings(rep)
        .into_iter()
        .filter(|w| w.starts_with("Custom lists"))
        .collect()
}

fn log_warnings(rep: &Value) -> Vec<String> {
    warnings(rep)
        .into_iter()
        .filter(|w| w.contains("watch history"))
        .collect()
}

/// Review fix: lists the import cannot create (a blank name, or past the
/// limit of 50) are counted in one warning, even when they hold no items.
#[tokio::test]
async fn lists_that_cannot_be_created_are_reported() {
    let a = app().await;
    let mut m: Value = serde_json::from_str(&alpha_and_beta()).unwrap();
    // A zero-width space survives the reader's trim but is no visible name.
    let mut lists = vec![json!({"name": "\u{200B}", "position": 0, "items": []})];
    lists.extend((0..51).map(|i| json!({"name": format!("L{i}"), "position": i + 1, "items": []})));
    m["tsrustCustomLists"] = Value::Array(lists);
    let rep = a.import(&m.to_string(), "merge").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert_eq!(
        list_warnings(&rep),
        ["Custom lists: 2 lists in the backup were not restored (a blank name, or you can keep up to 50 lists)"],
        "{rep}"
    );
    let names: Vec<String> = a
        .list_summary()
        .await
        .into_iter()
        .map(|(n, _, _)| n)
        .collect();
    assert_eq!(names.len(), 50);
    assert_eq!(names.last().map(String::as_str), Some("L49"));

    let b = app().await;
    let mut m: Value = serde_json::from_str(&alpha_and_beta()).unwrap();
    m["tsrustCustomLists"] = json!([{"name": "\u{200B}\u{2060}", "items": []}]);
    let rep = b.import(&m.to_string(), "merge").await;
    assert_eq!(
        list_warnings(&rep),
        ["Custom lists: 1 list in the backup was not restored (a blank name, or you can keep up to 50 lists)"],
        "{rep}"
    );
    assert!(b.lists().await.is_empty());
}

/// Review fix: watch log rows the import refuses (an unreadable or too old
/// day, a blank title, no seconds) are counted in one warning per entry.
#[tokio::test]
async fn skipped_watch_log_rows_are_reported() {
    let a = app().await;
    let day = yesterday();
    let row = |day: &str, title: &str, seconds: i64| {
        json!({
            "day": day, "contentType": "live", "itemId": "x1", "title": title,
            "seconds": seconds, "lastAt": "2026-10-01T00:00:00.000Z"
        })
    };
    let mut m: Value = serde_json::from_str(&alpha_and_beta()).unwrap();
    m["playlists"][0]["userState"]["tsrustWatchLog"] = json!([
        row(&day, "Kept", 600),
        row("2026-13-40", "Bad day", 600),
        row("2000-01-01", "Too old", 600),
        row(&day, "   ", 600),
        row(&day, "Zero", 0),
    ]);
    m["playlists"][1]["userState"]["tsrustWatchLog"] = json!([row(&day, "Negative", -5)]);
    let rep = a.import(&m.to_string(), "merge").await;
    assert_eq!(rep["imported"], 2, "{rep}");
    assert_eq!(
        log_warnings(&rep),
        [
            "\"Alpha\": 4 watch history entries in the backup were not restored (an unreadable date or one outside the last 90 days, no title or item id, or no time watched)",
            "\"Beta\": 1 watch history entry in the backup was not restored (an unreadable date or one outside the last 90 days, no title or item id, or no time watched)",
        ],
        "{rep}"
    );
    assert_eq!(
        a.rows("SELECT source_id, title, seconds FROM watch_log")
            .await,
        [vec![
            "src-a".to_string(),
            "Kept".to_string(),
            "600".to_string()
        ]]
    );
}

/// Review fix: a clean round trip (Replace into a fresh data folder, then
/// Merge of the same file onto the install it came from) reports neither
/// dropped lists nor skipped watch log rows. Rows a re-import leaves as they
/// are do not count as skipped.
#[tokio::test]
async fn a_clean_round_trip_reports_no_dropped_lists_or_skipped_watch_rows() {
    let (src, ch) = seeded().await;
    let day = yesterday();
    let rows: Vec<iptv_core::stats::WatchLogBackup> = serde_json::from_value(json!([
        {"day": day, "contentType": "live", "itemId": ch.a_sport, "title": "Alpha Sport",
         "seconds": 1800, "lastAt": format!("{day}T20:00:00.000Z")},
        {"day": day, "contentType": "live", "itemId": ch.b_one, "title": "Beta One",
         "seconds": 60, "lastAt": format!("{day}T21:00:00.000Z")}
    ]))
    .unwrap();
    let (a_rows, b_rows) = (rows[..1].to_vec(), rows[1..].to_vec());
    src.state
        .db_call(move |c| {
            iptv_core::stats::import_log(c, "src-a", &a_rows)?;
            iptv_core::stats::import_log(c, "src-b", &b_rows)
        })
        .await
        .unwrap();

    let (out, dst, rep, _alpha) = replace_into_fresh(&src).await;
    assert!(list_warnings(&rep).is_empty(), "{rep}");
    assert!(log_warnings(&rep).is_empty(), "{rep}");
    assert_eq!(dst.lists().await.len(), 3);
    assert_eq!(
        dst.rows("SELECT count(*) FROM watch_log").await,
        [vec!["2".to_string()]]
    );

    let rep = src.import(&out.to_string(), "merge").await;
    assert!(list_warnings(&rep).is_empty(), "{rep}");
    assert!(log_warnings(&rep).is_empty(), "{rep}");
}
