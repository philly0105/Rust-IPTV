//! The Live TV quality filter (`liveMinQuality`, `liveHideUntagged`) in the
//! user views and the other live readers outside the catalog lists:
//! `favorites.list` (and the order `favorites.reorder` keeps),
//! `recent.list`, `lists.items` with `itemCount`, `lists.neighbors`,
//! `epg.search` and `live.alternates`, under every minimum with the
//! untagged toggle on and off. A live entry whose catalog row the filter
//! hides is left out; one whose channel is gone from the catalog stays (it
//! shows as unavailable); radio and movie entries are never filtered, and
//! the channel being played still gets its alternates.

use iptv_core::catalog::quality::{code, QualityFilter, UNSET, UNTAGGED};
use iptv_core::live::matcher::{self, Quality};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::{AppEvent, AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

const EPG_URL: &str = "http://guide.example/epg.xml";

/// Source `s1`'s live channels: item id and provider name. 106 was written
/// before migration 0022 and is not backfilled yet (`UNSET`).
const S1_LIVE: [(&str, &str); 6] = [
    ("101", "BBC One SD"),
    ("102", "BBC Two HD"),
    ("103", "Sky Sports FHD"),
    ("104", "Sky Cinema 4K"),
    ("105", "CNN"),
    ("106", "Old News"),
];

/// Source `s2`: Sky Sports in every quality, the alternates of `s1`'s 103.
const S2_LIVE: [(&str, &str); 5] = [
    ("1", "Sky Sports SD"),
    ("2", "Sky Sports HD"),
    ("3", "Sky Sports FHD"),
    ("4", "Sky Sports 4K"),
    ("5", "Sky Sports"),
];

/// A live channel the catalog no longer has (a favorite, a history entry
/// and a list item).
const GONE: &str = "999";

/// `(liveMinQuality, liveHideUntagged, s1 live channels left)`.
const CASES: [(Option<&str>, bool, &str); 8] = [
    (None, false, "101 102 103 104 105 106"),
    // The toggle alone changes nothing.
    (None, true, "101 102 103 104 105 106"),
    (Some("sd"), false, "101 102 103 104 105 106"),
    (Some("sd"), true, "101 102 103 104"),
    (Some("hd"), false, "102 103 104 105 106"),
    (Some("fhd"), false, "103 104 105 106"),
    (Some("fhd"), true, "103 104"),
    (Some("uhd"), true, "104"),
];

/// One catalog row: source, type, item id, provider name.
type Row = (&'static str, &'static str, &'static str, &'static str);

/// `s1`: [`S1_LIVE`], radio 501 Jazz HD and movie 201 Heat SD. `s2`:
/// [`S2_LIVE`] and radio 502 Jazz SD.
fn catalog() -> Vec<Row> {
    let mut out: Vec<Row> = S1_LIVE
        .iter()
        .map(|&(id, t)| ("s1", "live", id, t))
        .collect();
    out.push(("s1", "radio", "501", "Jazz HD"));
    out.push(("s1", "movie", "201", "Heat SD"));
    out.extend(S2_LIVE.iter().map(|&(id, t)| ("s2", "live", id, t)));
    out.push(("s2", "radio", "502", "Jazz SD"));
    out
}

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    _events: Receiver<AppEvent>,
}

/// The [`catalog`] stored the way the catalog writer stores it (live rows
/// with their name's quality code, other types untagged), each `s1` live
/// and radio channel with a "Match Night" programme in an hour on its own
/// guide channel.
async fn app() -> App {
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
            c.execute(
                "INSERT INTO epg_sources(url, origin, status, channel_count, program_count) VALUES (?1, 'settings', 'ok', 7, 7)",
                [EPG_URL],
            )?;
            for (pos, (sid, ct, id, title)) in catalog().into_iter().enumerate() {
                let quality = if ct == "live" {
                    code(matcher::quality(title))
                } else {
                    UNTAGGED
                };
                let guide = format!("g-{sid}-{id}");
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, url, position, is_radio, quality)
                     VALUES (?1, ?2, ?3, 'g', ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        sid,
                        ct,
                        id,
                        title,
                        guide,
                        format!("http://stream/{sid}/{id}.ts"),
                        pos as i64,
                        ct == "radio",
                        quality
                    ],
                )?;
                if sid != "s1" || ct == "movie" {
                    continue;
                }
                c.execute(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, ?2, ?3)",
                    params![EPG_URL, guide, title],
                )?;
                c.execute(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![EPG_URL, guide, now + 3600, now + 7200, "Match Night"],
                )?;
            }
            c.execute(
                "UPDATE items SET quality = ?1 WHERE source_id = 's1' AND item_id = '106'",
                [UNSET],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    App {
        _dir: dir,
        state,
        router: build_router(),
        _events: events,
    }
}

fn rf(sid: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": sid, "contentType": ct, "itemId": id})
}

/// `{ref, snapshot}` of a channel or movie.
fn entry(sid: &str, ct: &str, id: &str, title: &str) -> Value {
    json!({"ref": rf(sid, ct, id), "snapshot": {"title": title, "contentType": ct}})
}

/// `itemId`s of an array of objects carrying a `ref`, in order.
fn ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("not an array: {v}"))
        .iter()
        .map(|e| e["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// The filter a case's settings give.
fn filter(min: Option<&str>, hide: bool) -> Option<QualityFilter> {
    let min: Quality = serde_json::from_value(Value::from(min?)).unwrap();
    Some(QualityFilter {
        min,
        hide_untagged: hide,
    })
}

/// `lists.neighbors` by its definition: the nearest playable channel before
/// and after `at` in list order, wrapping around, never `at` itself.
fn around(order: &[String], playable: &[&str], at: &str) -> (Option<String>, Option<String>) {
    let cur = order.iter().position(|x| x == at).unwrap();
    let n = order.len();
    let ok = |i: &usize| playable.contains(&order[*i].as_str());
    let prev = (0..cur).rev().chain((cur + 1..n).rev()).find(ok);
    let next = (cur + 1..n).chain(0..cur).find(ok);
    let id = |i: usize| order[i].clone();
    (prev.map(id), next.map(id))
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter()
        .map(|(s, i)| (s.to_string(), i.to_string()))
        .collect()
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args.clone())
            .await
            .unwrap_or_else(|e| panic!("{cmd} {args} failed: {}", e.message))
    }

    /// Sets the filter through `settings.update`.
    async fn set(&self, min: Option<&str>, hide: bool) {
        self.call(
            "settings.update",
            json!({"patch": {"liveMinQuality": min, "liveHideUntagged": hide}}),
        )
        .await;
    }

    /// `(itemId, quality)` of the `s1` live channels as stored.
    async fn s1_codes(&self) -> Vec<(String, i64)> {
        self.state
            .db_call(|c| {
                let mut stmt = c.prepare(
                    "SELECT item_id, quality FROM items WHERE source_id = 's1' AND content_type = 'live' ORDER BY position",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                Ok(rows.collect::<Result<Vec<(String, i64)>, _>>()?)
            })
            .await
            .unwrap()
    }

    /// `(prev, next)` item ids around `at` in a custom list.
    async fn neighbors(&self, list: &str, at: &str) -> (Option<String>, Option<String>) {
        let v = self
            .call(
                "lists.neighbors",
                json!({"id": list, "ref": rf("s1", "live", at)}),
            )
            .await;
        let pick = |k: &str| {
            v.get(k)
                .map(|c| c["ref"]["itemId"].as_str().unwrap().to_string())
        };
        (pick("prev"), pick("next"))
    }

    /// `(sourceId, itemId)` of a channel's `live.alternates`, sorted.
    async fn alternates(&self, r: Value) -> Vec<(String, String)> {
        let v = self.call("live.alternates", json!({"ref": r})).await;
        let mut out: Vec<(String, String)> = v["alternates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                let r = &a["channel"]["ref"];
                (
                    r["sourceId"].as_str().unwrap().to_string(),
                    r["itemId"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        out.sort();
        out
    }
}

#[tokio::test]
async fn user_views_and_live_readers_follow_the_filter() {
    let a = app().await;
    // Every s1 live channel, the radio station and the gone channel as
    // favorites, history and one custom list; the movie as a favorite and
    // in the history.
    let mut channels: Vec<Value> = S1_LIVE
        .iter()
        .map(|&(id, t)| entry("s1", "live", id, t))
        .collect();
    channels.push(entry("s1", "radio", "501", "Jazz HD"));
    channels.push(entry("s1", "live", GONE, "Gone TV HD"));
    let movie = entry("s1", "movie", "201", "Heat SD");
    for e in channels.iter().chain([&movie]) {
        a.call("favorites.toggle", e.clone()).await;
        a.call("recent.add", e.clone()).await;
    }
    let created = a
        .call("lists.create", json!({"name": "Mix", "items": channels}))
        .await;
    assert_eq!(created["itemCount"], json!(8));
    let list = created["id"].as_str().unwrap().to_string();
    let order = ids(&json!(channels));
    let codes = a.s1_codes().await;
    assert_eq!(codes[5], ("106".to_string(), UNSET));

    for (min, hide, live) in CASES {
        a.set(min, hide).await;
        let case = format!("liveMinQuality {min:?}, liveHideUntagged {hide}");
        let live = words(live);
        // The table is the stored-code rule, -1 counting as untagged.
        let f = filter(min, hide);
        let rule: Vec<String> = codes
            .iter()
            .filter(|(_, q)| f.is_none_or(|f| f.keeps_code(*q)))
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(rule, live, "{case}");

        // Favorites and history: radio, the movie and the gone channel stay.
        let mut shown = live.clone();
        shown.extend(words("501 201 999"));
        let favorites = a.call("favorites.list", Value::Null).await;
        assert_eq!(sorted(ids(&favorites)), sorted(shown.clone()), "{case}");
        let recent = a.call("recent.list", Value::Null).await;
        assert_eq!(sorted(ids(&recent)), sorted(shown), "{case}");

        // The custom list, in its order; the gone channel stays, unavailable.
        let mut listed = live.clone();
        listed.extend(words("501 999"));
        let items = a.call("lists.items", json!({"id": list})).await;
        assert_eq!(ids(&items), listed, "{case}");
        let unavailable: Vec<&str> = items
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["available"].as_bool() == Some(false))
            .map(|e| e["ref"]["itemId"].as_str().unwrap())
            .collect();
        assert_eq!(unavailable, [GONE], "{case}");
        let lists = a.call("lists.list", Value::Null).await;
        assert_eq!(lists[0]["itemCount"], json!(listed.len()), "{case}");

        // Zapping skips what lists.items leaves out and the gone channel; a
        // channel the filter hides still has neighbours.
        let playable: Vec<&str> = listed
            .iter()
            .map(String::as_str)
            .filter(|id| *id != GONE)
            .collect();
        for at in ["101", "103", "104", "106"] {
            let want = around(&order, &playable, at);
            assert_eq!(a.neighbors(&list, at).await, want, "{at}, {case}");
        }

        // The guide search: one programme on every s1 channel.
        let hits = a
            .call("epg.search", json!({"sourceId": "s1", "query": "match"}))
            .await;
        let mut want = live.clone();
        want.push("501".into());
        assert_eq!(sorted(ids(&hits)), sorted(want), "{case}");

        // Failover: the copies the filter keeps, by the matcher's quality.
        let want: Vec<(String, String)> = S2_LIVE
            .iter()
            .filter(|(_, t)| f.is_none_or(|f| f.keeps(matcher::quality(t))))
            .map(|(id, _)| ("s2".to_string(), id.to_string()))
            .collect();
        let got = a.alternates(rf("s1", "live", "103")).await;
        assert_eq!(got, want, "{case}");
        // Radio is never filtered.
        let got = a.alternates(rf("s1", "radio", "501")).await;
        assert_eq!(got, pairs(&[("s2", "502")]), "{case}");
    }

    // Spot checks with 1080p and up, untagged channels hidden.
    a.set(Some("fhd"), true).await;
    assert_eq!(
        a.neighbors(&list, "103").await,
        (Some("501".into()), Some("104".into()))
    );
    assert_eq!(
        a.neighbors(&list, "101").await,
        (Some("501".into()), Some("103".into())),
        "a hidden channel's neighbours"
    );
    assert_eq!(
        a.alternates(rf("s1", "live", "103")).await,
        pairs(&[("s2", "3"), ("s2", "4")])
    );
    // The channel being played may itself be below the minimum.
    assert_eq!(
        a.alternates(rf("s2", "live", "1")).await,
        pairs(&[("s1", "103"), ("s2", "3"), ("s2", "4")])
    );
    // Writes that report a list count it the way lists.items does.
    let picked = [
        entry("s1", "live", "101", "BBC One SD"),
        entry("s1", "live", "103", "Sky Sports FHD"),
        entry("s1", "live", GONE, "Gone TV HD"),
    ];
    let two = a
        .call("lists.create", json!({"name": "Two", "items": picked}))
        .await;
    assert_eq!(two["itemCount"], json!(2));
    let renamed = a
        .call("lists.update", json!({"id": two["id"], "name": "Two b"}))
        .await;
    assert_eq!(renamed["itemCount"], json!(2));

    // Off again: everything is back.
    a.set(None, true).await;
    let favorites = a.call("favorites.list", Value::Null).await;
    assert_eq!(ids(&favorites).len(), 9);
    assert_eq!(
        a.alternates(rf("s1", "live", "103")).await.len(),
        S2_LIVE.len()
    );
}

/// `favorites.reorder` under the filter: favorites it hides keep their
/// slots, so they come back in place when it goes.
#[tokio::test]
async fn reordering_favorites_keeps_hidden_ones_in_place() {
    let a = app().await;
    for e in [
        entry("s1", "live", "101", "BBC One SD"),
        entry("s1", "live", "103", "Sky Sports FHD"),
        entry("s1", "live", "105", "CNN"),
        entry("s1", "radio", "501", "Jazz HD"),
        entry("s1", "live", GONE, "Gone TV HD"),
    ] {
        a.call("favorites.toggle", e).await;
    }
    a.set(Some("fhd"), true).await;
    let shown = a.call("favorites.list", Value::Null).await;
    assert_eq!(ids(&shown), words("103 501 999"));
    a.call(
        "favorites.reorder",
        json!({"refs": [rf("s1", "live", GONE), rf("s1", "live", "103")]}),
    )
    .await;
    let shown = a.call("favorites.list", Value::Null).await;
    assert_eq!(ids(&shown), words("999 103 501"));
    a.set(None, false).await;
    let all = a.call("favorites.list", Value::Null).await;
    assert_eq!(ids(&all), words("101 999 105 103 501"));
}
