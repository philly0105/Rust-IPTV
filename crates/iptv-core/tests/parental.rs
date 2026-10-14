//! Parental controls (contract C2, check 3 / SC3 and SC11) through the full
//! router: PIN rules and storage, the wrong-PIN lockout, session unlocks and
//! their expiry (lazy and by the timer), `parental.changed` events, locks,
//! `parental.check` / `parental.adultCategories`, hide mode in every reader
//! C2 lists, ask mode filtering nothing, the backup round trip of locks,
//! options and My List with no PIN material in the file, and hide mode on a
//! 50k-channel source within the catalog query budget.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::error::RpcErrorCode;
use iptv_core::model::ParentalStatus;
use iptv_core::parental::{self, is_adult_category};
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::{AppEvent, AppState, BroadcastSink, RpcError};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::Receiver;

const PIN: &str = "2468";

struct App {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    events: Receiver<AppEvent>,
}

/// A fresh app (m3u importer registered, no background timer).
async fn app() -> App {
    let support::Env { dir, state, events } = support::env().await;
    App {
        dir,
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
            .unwrap_or_else(|e| panic!("{cmd} failed: {} {:?}", e.message, e.code))
    }

    async fn err(&self, cmd: &str, args: Value) -> RpcError {
        match self
            .router
            .dispatch(self.state.clone(), cmd, args.clone())
            .await
        {
            Ok(v) => panic!("{cmd} {args} should fail, got {v}"),
            Err(e) => e,
        }
    }

    async fn fail(&self, cmd: &str, args: Value) -> RpcErrorCode {
        self.err(cmd, args).await.code
    }

    async fn status(&self) -> ParentalStatus {
        serde_json::from_value(self.call("parental.status", Value::Null).await).unwrap()
    }

    async fn set_pin(&self) {
        self.call("parental.setPin", json!({ "newPin": PIN })).await;
    }

    async fn lock(&self, source: &str, ct: &str, kind: &str, target: &str) {
        self.call(
            "parental.setLocked",
            json!({"target": target_json(source, ct, kind, target), "locked": true}),
        )
        .await;
    }

    /// `parental.changed` payloads received since the last call.
    fn changes(&mut self) -> Vec<ParentalStatus> {
        let mut out = Vec::new();
        while let Ok(e) = self.events.try_recv() {
            if e.kind == parental::CHANGED_EVENT {
                assert_no_pin_material(&e.payload);
                out.push(serde_json::from_value(e.payload).expect("payload is a ParentalStatus"));
            }
        }
        out
    }

    /// The stored `(pin_hash, pin_salt)`.
    async fn stored_pin(&self) -> (Option<String>, Option<String>) {
        self.state
            .db_call(|c| {
                Ok(c.query_row(
                    "SELECT pin_hash, pin_salt FROM parental_config WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .await
            .unwrap()
    }
}

fn rf(source: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": source, "contentType": ct, "itemId": id})
}

fn target_json(source: &str, ct: &str, kind: &str, target: &str) -> Value {
    json!({"sourceId": source, "contentType": ct, "kind": kind, "targetId": target, "name": format!("Lock {target}")})
}

/// No key or value that could carry the PIN, its hash or its salt.
fn assert_no_pin_material(v: &Value) {
    match v {
        Value::Object(m) => {
            for (k, v) in m {
                let k = k.to_ascii_lowercase();
                assert!(
                    !(k == "pin"
                        || k.contains("pinhash")
                        || k.contains("pin_hash")
                        || k.contains("salt")),
                    "PIN material key {k} in {m:?}"
                );
                assert_no_pin_material(v);
            }
        }
        Value::Array(a) => a.iter().for_each(assert_no_pin_material),
        Value::String(s) => assert!(!s.starts_with("pbkdf2-"), "PIN hash in {s}"),
        _ => {}
    }
}

/// Item ids of a `catalog.channels` / `movies` / `series` page, or of a list
/// of channels, items or user-state entries.
fn ids(v: &Value) -> BTreeSet<String> {
    let list = v.get("items").unwrap_or(v);
    list.as_array()
        .unwrap_or_else(|| panic!("not a list: {v}"))
        .iter()
        .map(|e| e["ref"]["itemId"].as_str().unwrap().to_string())
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Catalog fixture
// ---------------------------------------------------------------------------

/// Sources `s1` and `s2` with this catalog (positions in listed order):
///
/// - s1 live: `news` News {n1, n2}, `kids` Kids {k1}, `xxx` "[XXX] After
///   Dark" {x1}, `swim` "Adult Swim" {a1}, `sports` Sports {p1, p2}.
///   Numbers 1..=7 in that order.
/// - s1 movie: `action` Action {m1 Black Harbor, m2 Secret Movie},
///   `m18` "Movies 18+" {m3 Late Movie}.
/// - s1 series: `drama` Drama {r1, r3}, `erotic` "EROTIC Series" {r2}.
/// - s2 movie: `act2` Action {t1 Black Harbor, t3 Black Harbor (Director's
///   Cut)}, `adult2` "ADULTS ONLY" {t2 Black Harbor}.
///
/// `fixture_locks` locks item n2, category sports, item m2, item r3 and
/// item t3. Adult by name: xxx, m18, erotic, adult2 (not swim).
async fn fixture(a: &App) {
    for id in ["s1", "s2"] {
        support::bare_source(&a.state, id).await;
    }
    a.state
        .db_call(|c| {
            let cats: &[(&str, &str, &str, &str, i64)] = &[
                ("s1", "live", "news", "News", 2),
                ("s1", "live", "kids", "Kids", 1),
                ("s1", "live", "xxx", "[XXX] After Dark", 1),
                ("s1", "live", "swim", "Adult Swim", 1),
                ("s1", "live", "sports", "Sports", 2),
                ("s1", "movie", "action", "Action", 2),
                ("s1", "movie", "m18", "Movies 18+", 1),
                ("s1", "series", "drama", "Drama", 2),
                ("s1", "series", "erotic", "EROTIC Series", 1),
                ("s2", "movie", "act2", "Action", 2),
                ("s2", "movie", "adult2", "ADULTS ONLY", 1),
            ];
            for (pos, (s, ct, id, name, n)) in cats.iter().enumerate() {
                c.execute(
                    "INSERT INTO categories(source_id, content_type, category_id, name, item_count, position)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![s, ct, id, name, n, pos as i64],
                )?;
            }
            // (source, type, id, category, title, number, added)
            type Row<'a> = (&'a str, &'a str, &'a str, &'a str, &'a str, Option<i64>, Option<&'a str>);
            let items: &[Row] = &[
                ("s1", "live", "n1", "news", "BBC News", Some(1), None),
                ("s1", "live", "n2", "news", "CNN Locked", Some(2), None),
                ("s1", "live", "k1", "kids", "Kids One", Some(3), None),
                ("s1", "live", "x1", "xxx", "Night Channel", Some(4), None),
                ("s1", "live", "a1", "swim", "Adult Swim HD", Some(5), None),
                ("s1", "live", "p1", "sports", "Sports One", Some(6), None),
                ("s1", "live", "p2", "sports", "Sports Two", Some(7), None),
                ("s1", "movie", "m1", "action", "Black Harbor", None, Some("2026-10-01")),
                ("s1", "movie", "m2", "action", "Secret Movie", None, Some("2026-10-02")),
                ("s1", "movie", "m3", "m18", "Late Movie", None, Some("2026-10-03")),
                ("s1", "series", "r1", "drama", "Drama Show", None, Some("2026-09-01")),
                ("s1", "series", "r2", "erotic", "Hot Show", None, Some("2026-09-02")),
                ("s1", "series", "r3", "drama", "Locked Show", None, Some("2026-09-03")),
                ("s2", "movie", "t1", "act2", "Black Harbor", None, Some("2026-08-01")),
                ("s2", "movie", "t2", "adult2", "Black Harbor", None, Some("2026-08-02")),
                ("s2", "movie", "t3", "act2", "Black Harbor (Director's Cut)", None, Some("2026-08-03")),
            ];
            for (pos, (s, ct, id, cat, title, number, added)) in items.iter().enumerate() {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, title_base, number, added, position, url)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        s,
                        ct,
                        id,
                        cat,
                        title,
                        if title.starts_with("Black Harbor") { Some("Black Harbor") } else { None },
                        number,
                        added,
                        pos as i64,
                        format!("http://stream.example/{s}/{id}")
                    ],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

async fn fixture_locks(a: &App) {
    a.lock("s1", "live", "item", "n2").await;
    a.lock("s1", "live", "category", "sports").await;
    a.lock("s1", "movie", "item", "m2").await;
    a.lock("s1", "series", "item", "r3").await;
    a.lock("s2", "movie", "item", "t3").await;
}

/// Favorites, recent and continue-watching rows over the fixture.
async fn fixture_user_state(a: &App) {
    for (ct, id) in [
        ("live", "n1"),
        ("live", "n2"),
        ("live", "x1"),
        ("live", "a1"),
        ("live", "p1"),
        // Not in the catalog: only an item lock can hide it.
        ("live", "gone"),
        ("movie", "m1"),
        ("movie", "m2"),
        ("movie", "m3"),
    ] {
        let args = json!({"ref": rf("s1", ct, id), "snapshot": {"title": id, "contentType": ct}});
        a.call("favorites.toggle", args.clone()).await;
        a.call("recent.add", args).await;
    }
    for (ct, id) in [
        ("movie", "m1"),
        ("movie", "m2"),
        ("movie", "m3"),
        ("series", "r1"),
        ("series", "r2"),
        ("series", "r3"),
    ] {
        a.call(
            "positions.set",
            json!({"ref": rf("s1", ct, id), "positionSeconds": 600, "durationSeconds": 6000,
                   "snapshot": {"title": id, "contentType": ct}}),
        )
        .await;
    }
    a.lock("s1", "live", "item", "gone").await;
}

/// What every reader C2 lists returns right now, as item-id sets (and the
/// list totals), so one call compares the whole picture.
#[derive(Debug, PartialEq)]
struct Readers {
    live: BTreeSet<String>,
    live_total: i64,
    movies: BTreeSet<String>,
    movies_total: i64,
    series: BTreeSet<String>,
    series_total: i64,
    live_categories: Vec<(String, i64)>,
    movie_categories: Vec<(String, i64)>,
    series_categories: Vec<(String, i64)>,
    search_harbor: BTreeSet<String>,
    search_live: BTreeSet<String>,
    search_shows: BTreeSet<String>,
    recently_added_movies: BTreeSet<String>,
    recently_added_series: BTreeSet<String>,
    all_live: BTreeSet<String>,
    numbers: Vec<Option<String>>,
    neighbors_of_n1: (Option<String>, Option<String>),
    same_title: BTreeSet<String>,
    favorites: BTreeSet<String>,
    recent: BTreeSet<String>,
    continue_watching: BTreeSet<String>,
}

async fn readers(a: &App) -> Readers {
    let page = |ct: &str| {
        let cmd = match ct {
            "live" => "catalog.channels",
            "movie" => "catalog.movies",
            _ => "catalog.series",
        };
        (cmd, json!({"sourceId": "s1"}))
    };
    let (cmd, args) = page("live");
    let live = a.call(cmd, args).await;
    let (cmd, args) = page("movie");
    let movies = a.call(cmd, args).await;
    let (cmd, args) = page("series");
    let series = a.call(cmd, args).await;
    let cats = |v: Value| -> Vec<(String, i64)> {
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
    };
    let mut categories = Vec::new();
    for ct in ["live", "movie", "series"] {
        categories.push(cats(
            a.call(
                "catalog.categories",
                json!({"sourceId": "s1", "contentType": ct}),
            )
            .await,
        ));
    }
    let search = |q: &str| json!({ "query": q });
    let harbor = a.call("catalog.search", search("Black Harbor")).await;
    let live_search = a
        .call(
            "catalog.search",
            json!({"query": "One", "contentTypes": ["live"]}),
        )
        .await;
    let shows = a
        .call(
            "catalog.search",
            json!({"query": "Show", "contentTypes": ["series"]}),
        )
        .await;
    let mut numbers = Vec::new();
    for n in 1..=7 {
        let v = a
            .call(
                "catalog.channelByNumber",
                json!({"sourceId": "s1", "number": n}),
            )
            .await;
        numbers.push(v["ref"]["itemId"].as_str().map(str::to_string));
    }
    let nb = a
        .call("catalog.neighbors", json!({"ref": rf("s1", "live", "n1")}))
        .await;
    let id_of = |v: &Value| v["ref"]["itemId"].as_str().map(str::to_string);
    Readers {
        live: ids(&live),
        live_total: live["total"].as_i64().unwrap(),
        movies: ids(&movies),
        movies_total: movies["total"].as_i64().unwrap(),
        series: ids(&series),
        series_total: series["total"].as_i64().unwrap(),
        live_categories: categories[0].clone(),
        movie_categories: categories[1].clone(),
        series_categories: categories[2].clone(),
        search_harbor: ids(&harbor["movies"]),
        search_live: ids(&live_search["live"]),
        search_shows: ids(&shows["series"]),
        recently_added_movies: ids(&a
            .call("catalog.recentlyAdded", json!({"contentType": "movie"}))
            .await),
        recently_added_series: ids(&a
            .call("catalog.recentlyAdded", json!({"contentType": "series"}))
            .await),
        all_live: ids(&a
            .call("catalog.allLiveChannels", json!({"sourceId": "s1"}))
            .await),
        numbers,
        neighbors_of_n1: (id_of(&nb["prev"]), id_of(&nb["next"])),
        same_title: ids(&a
            .call("catalog.sameTitle", json!({"ref": rf("s1", "movie", "m1")}))
            .await),
        favorites: ids(&a.call("favorites.list", json!({})).await),
        recent: ids(&a.call("recent.list", json!({})).await),
        continue_watching: ids(&a.call("positions.continueWatching", json!({})).await),
    }
}

/// Everything, as no filter sees it.
fn unfiltered() -> Readers {
    let s = |v: &[&str]| set(v);
    let c = |v: &[(&str, i64)]| v.iter().map(|(a, b)| (a.to_string(), *b)).collect();
    Readers {
        live: s(&["n1", "n2", "k1", "x1", "a1", "p1", "p2"]),
        live_total: 7,
        movies: s(&["m1", "m2", "m3"]),
        movies_total: 3,
        series: s(&["r1", "r2", "r3"]),
        series_total: 3,
        live_categories: c(&[
            ("news", 2),
            ("kids", 1),
            ("xxx", 1),
            ("swim", 1),
            ("sports", 2),
        ]),
        movie_categories: c(&[("action", 2), ("m18", 1)]),
        series_categories: c(&[("drama", 2), ("erotic", 1)]),
        search_harbor: s(&["m1", "t1", "t2", "t3"]),
        search_live: s(&["k1", "p1"]),
        search_shows: s(&["r1", "r2", "r3"]),
        recently_added_movies: s(&["m1", "m2", "m3", "t1", "t2", "t3"]),
        recently_added_series: s(&["r1", "r2", "r3"]),
        all_live: s(&["n1", "n2", "k1", "x1", "a1", "p1", "p2"]),
        numbers: ["n1", "n2", "k1", "x1", "a1", "p1", "p2"]
            .iter()
            .map(|s| Some(s.to_string()))
            .collect(),
        neighbors_of_n1: (Some("p2".into()), Some("n2".into())),
        same_title: s(&["t1", "t2", "t3"]),
        favorites: s(&["n1", "n2", "x1", "a1", "p1", "gone", "m1", "m2", "m3"]),
        recent: s(&["n1", "n2", "x1", "a1", "p1", "gone", "m1", "m2", "m3"]),
        continue_watching: s(&["m1", "m2", "m3", "r1", "r2", "r3"]),
    }
}

/// Hide mode with `autoAdult` on: locks and adult categories dropped.
fn hidden() -> Readers {
    let s = |v: &[&str]| set(v);
    let c = |v: &[(&str, i64)]| v.iter().map(|(a, b)| (a.to_string(), *b)).collect();
    Readers {
        live: s(&["n1", "k1", "a1"]),
        live_total: 3,
        movies: s(&["m1"]),
        movies_total: 1,
        series: s(&["r1"]),
        series_total: 1,
        // news loses its locked channel; xxx is adult, sports locked; the
        // "Adult Swim" brand stays.
        live_categories: c(&[("news", 1), ("kids", 1), ("swim", 1)]),
        movie_categories: c(&[("action", 1)]),
        series_categories: c(&[("drama", 1)]),
        search_harbor: s(&["m1", "t1"]),
        search_live: s(&["k1"]),
        search_shows: s(&["r1"]),
        recently_added_movies: s(&["m1", "t1"]),
        recently_added_series: s(&["r1"]),
        all_live: s(&["n1", "k1", "a1"]),
        numbers: vec![
            Some("n1".into()),
            None,
            Some("k1".into()),
            None,
            Some("a1".into()),
            None,
            None,
        ],
        neighbors_of_n1: (Some("a1".into()), Some("k1".into())),
        same_title: s(&["t1"]),
        favorites: s(&["n1", "a1", "m1"]),
        recent: s(&["n1", "a1", "m1"]),
        continue_watching: s(&["m1", "r1"]),
    }
}

/// Hide mode with `autoAdult` off: only the explicit locks.
fn hidden_locks_only() -> Readers {
    let s = |v: &[&str]| set(v);
    let c = |v: &[(&str, i64)]| v.iter().map(|(a, b)| (a.to_string(), *b)).collect();
    Readers {
        live: s(&["n1", "k1", "x1", "a1"]),
        live_total: 4,
        movies: s(&["m1", "m3"]),
        movies_total: 2,
        series: s(&["r1", "r2"]),
        series_total: 2,
        live_categories: c(&[("news", 1), ("kids", 1), ("xxx", 1), ("swim", 1)]),
        movie_categories: c(&[("action", 1), ("m18", 1)]),
        series_categories: c(&[("drama", 1), ("erotic", 1)]),
        search_harbor: s(&["m1", "t1", "t2"]),
        search_live: s(&["k1"]),
        search_shows: s(&["r1", "r2"]),
        recently_added_movies: s(&["m1", "m3", "t1", "t2"]),
        recently_added_series: s(&["r1", "r2"]),
        all_live: s(&["n1", "k1", "x1", "a1"]),
        numbers: vec![
            Some("n1".into()),
            None,
            Some("k1".into()),
            Some("x1".into()),
            Some("a1".into()),
            None,
            None,
        ],
        neighbors_of_n1: (Some("a1".into()), Some("k1".into())),
        same_title: s(&["t1", "t2"]),
        favorites: s(&["n1", "x1", "a1", "m1", "m3"]),
        recent: s(&["n1", "x1", "a1", "m1", "m3"]),
        continue_watching: s(&["m1", "m3", "r1", "r2"]),
    }
}

/// A fixture app with locks and user state, PIN set (hide mode, locked).
async fn hidden_app() -> App {
    let a = app().await;
    fixture(&a).await;
    fixture_user_state(&a).await;
    fixture_locks(&a).await;
    a.set_pin().await;
    a
}

// ---------------------------------------------------------------------------
// Commands, PIN rules, storage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_full_router_registers_every_command() {
    let r = build_router();
    for cmd in parental::rpc::COMMANDS {
        assert!(r.contains(cmd), "{cmd} is not registered");
    }
}

#[tokio::test]
async fn migration_creates_the_config_row_with_the_c2_defaults() {
    let a = app().await;
    let row: (Option<String>, String, bool, i64, i64) = a
        .state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT pin_hash, mode, auto_adult, unlock_minutes, failed_attempts FROM parental_config",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(row, (None, "hide".into(), true, 15, 0));
    let s = a.status().await;
    assert_eq!(s, ParentalStatus::default());
    let raw = a.call("parental.status", json!({})).await;
    assert_eq!(
        raw,
        json!({"enabled": false, "mode": "hide", "autoAdult": true, "unlockMinutes": 15,
               "unlocked": false, "failedAttempts": 0}),
        "optional fields are absent"
    );
    // The filters probe locks by their primary key.
    let plan: Vec<String> = a
        .state
        .db_call(|c| {
            let mut stmt = c.prepare(
                "EXPLAIN QUERY PLAN SELECT 1 FROM parental_locks WHERE source_id = 's' AND content_type = 'live' AND kind = 'item' AND target_id = 'x'",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(3))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap();
    assert!(plan.iter().any(|d| d.contains("PRIMARY KEY")), "{plan:?}");
}

#[tokio::test]
async fn set_pin_validates_and_stores_only_a_salted_hash() {
    let a = app().await;
    for bad in [
        "",
        "123",
        "123456789",
        "12a4",
        " 1234",
        "1234 ",
        "١٢٣٤",
        "12.4",
        "-123",
    ] {
        let e = a.err("parental.setPin", json!({ "newPin": bad })).await;
        assert_eq!(e.code, RpcErrorCode::Invalid, "{bad:?}");
    }
    assert_eq!(
        a.fail("parental.setPin", json!({ "newPin": 1234 })).await,
        RpcErrorCode::Invalid,
        "a number is not a PIN"
    );
    assert!(!a.status().await.enabled);

    let s = a
        .call("parental.setPin", json!({ "newPin": "97531864" }))
        .await;
    assert_eq!(s["enabled"], true);
    assert_no_pin_material(&s);
    let (hash, salt) = a.stored_pin().await;
    let (hash, salt) = (hash.unwrap(), salt.unwrap());
    assert!(hash.starts_with("pbkdf2-sha256$"), "{hash}");
    assert!(!hash.contains("97531864") && !salt.contains("97531864"));
    assert_eq!(salt.len(), 32, "16 random bytes as hex");

    // Changing needs the current PIN.
    assert_eq!(
        a.fail("parental.setPin", json!({ "newPin": "1111" })).await,
        RpcErrorCode::Auth
    );
    let e = a
        .err(
            "parental.setPin",
            json!({ "currentPin": "0000", "newPin": "1111" }),
        )
        .await;
    assert_eq!(e.code, RpcErrorCode::Auth);
    assert!(!e.message.contains("0000") && !e.message.contains("97531864"));
    assert_eq!(
        a.status().await.failed_attempts,
        1,
        "a wrong current PIN counts"
    );
    a.call(
        "parental.setPin",
        json!({ "currentPin": "97531864", "newPin": "1111" }),
    )
    .await;
    assert_eq!(
        a.status().await.failed_attempts,
        0,
        "a right PIN clears the count"
    );
    let (hash2, salt2) = a.stored_pin().await;
    assert_ne!(Some(hash), hash2);
    assert_ne!(Some(salt), salt2, "a new salt for every PIN");
    assert_eq!(
        a.fail("parental.unlock", json!({ "pin": "97531864" }))
            .await,
        RpcErrorCode::Auth,
        "the old PIN no longer works"
    );
    a.call("parental.unlock", json!({ "pin": "1111" })).await;
}

#[tokio::test]
async fn disable_needs_the_pin_and_keeps_locks_and_options() {
    let mut a = app().await;
    fixture(&a).await;
    a.set_pin().await;
    a.lock("s1", "live", "item", "n2").await;
    a.call(
        "parental.configure",
        json!({"pin": PIN, "mode": "ask", "autoAdult": false, "unlockMinutes": 30}),
    )
    .await;
    a.changes();
    assert_eq!(
        a.fail("parental.disable", json!({"pin": "1357"})).await,
        RpcErrorCode::Auth
    );
    assert_eq!(
        a.fail("parental.disable", json!({})).await,
        RpcErrorCode::Invalid,
        "pin is required"
    );
    assert!(a.status().await.enabled);
    let s: ParentalStatus =
        serde_json::from_value(a.call("parental.disable", json!({ "pin": PIN })).await).unwrap();
    assert!(!s.enabled && !s.unlocked);
    assert_eq!(
        (s.mode.as_str(), s.auto_adult, s.unlock_minutes),
        ("ask", false, 30)
    );
    assert_eq!(a.stored_pin().await, (None, None));
    let locks = a.call("parental.locks", json!({})).await;
    assert_eq!(
        locks.as_array().unwrap().len(),
        1,
        "locks are kept: {locks}"
    );
    assert!(a.changes().iter().any(|s| !s.enabled));
    // Disabling again is harmless; unlock needs a PIN to exist.
    a.call("parental.disable", json!({ "pin": PIN })).await;
    assert_eq!(
        a.fail("parental.unlock", json!({ "pin": PIN })).await,
        RpcErrorCode::Invalid
    );
    // With no PIN nothing is filtered, locks or not.
    assert_eq!(
        a.call("catalog.channels", json!({"sourceId": "s1"})).await["total"],
        7
    );
}

#[tokio::test]
async fn configure_validates_and_needs_the_pin_or_an_unlock() {
    let a = app().await;
    // Before a PIN exists, the options can be set freely.
    a.call("parental.configure", json!({"unlockMinutes": 5}))
        .await;
    assert_eq!(a.status().await.unlock_minutes, 5);
    for bad in [
        json!({"unlockMinutes": 721}),
        json!({"unlockMinutes": -1}),
        json!({"unlockMinutes": 1.5}),
        json!({"mode": "block"}),
        json!({"autoAdult": "yes"}),
        json!("1234"),
    ] {
        assert_eq!(
            a.fail("parental.configure", bad.clone()).await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    a.call("parental.configure", json!({"unlockMinutes": 720}))
        .await;
    a.call("parental.configure", json!({"unlockMinutes": 0}))
        .await;

    a.set_pin().await;
    assert_eq!(
        a.fail("parental.configure", json!({"mode": "ask"})).await,
        RpcErrorCode::Auth,
        "no PIN, no unlock"
    );
    assert_eq!(
        a.fail("parental.configure", json!({"pin": "0000", "mode": "ask"}))
            .await,
        RpcErrorCode::Auth
    );
    assert_eq!(a.status().await.mode.as_str(), "hide");
    let s = a
        .call("parental.configure", json!({"pin": PIN, "mode": "ask"}))
        .await;
    assert_eq!(s["mode"], "ask");
    assert_eq!(s["unlockMinutes"], 0, "absent fields keep their value");
    assert_eq!(s["autoAdult"], true);

    // An active unlock is enough.
    a.call("parental.unlock", json!({ "pin": PIN })).await;
    let s = a
        .call(
            "parental.configure",
            json!({"autoAdult": false, "unlockMinutes": 60, "mode": "hide"}),
        )
        .await;
    assert_eq!(
        (
            s["mode"].clone(),
            s["autoAdult"].clone(),
            s["unlockMinutes"].clone()
        ),
        (json!("hide"), json!(false), json!(60))
    );
}

#[tokio::test]
async fn wrong_pins_lock_out_for_30_seconds_doubling_to_300() {
    let mut a = app().await;
    a.set_pin().await;
    a.changes();
    for n in 1..=4u32 {
        let e = a.err("parental.unlock", json!({"pin": "0000"})).await;
        assert_eq!(e.code, RpcErrorCode::Auth, "try {n}");
        assert!(!e.retryable);
        assert_eq!(a.status().await.failed_attempts, n);
    }
    assert_eq!(a.changes().len(), 4, "every wrong PIN emits the new count");

    let e = a.err("parental.unlock", json!({"pin": "0000"})).await;
    assert_eq!(e.code, RpcErrorCode::Conflict);
    assert!(e.retryable);
    assert_eq!(e.details, Some(json!({"retryAfterSeconds": 30})));
    let s = a.status().await;
    assert_eq!((s.failed_attempts, s.retry_after_seconds), (5, Some(30)));

    // During the lockout even the right PIN is refused, everywhere.
    for (cmd, args) in [
        ("parental.unlock", json!({"pin": PIN})),
        ("parental.disable", json!({"pin": PIN})),
        ("parental.configure", json!({"pin": PIN, "mode": "ask"})),
        (
            "parental.setPin",
            json!({"currentPin": PIN, "newPin": "1111"}),
        ),
    ] {
        let e = a.err(cmd, args).await;
        assert_eq!(e.code, RpcErrorCode::Conflict, "{cmd}");
        assert!(e.details.unwrap()["retryAfterSeconds"].as_u64().unwrap() <= 30);
    }
    assert_eq!(
        a.status().await.failed_attempts,
        5,
        "refused tries do not count"
    );

    // After it, each further wrong PIN doubles the wait, up to 300 s.
    for want in [60, 120, 240, 300, 300] {
        let wait = a.status().await.retry_after_seconds.unwrap();
        parental::advance_clock(&a.state, Duration::from_secs(wait + 1));
        assert_eq!(a.status().await.retry_after_seconds, None);
        let e = a.err("parental.unlock", json!({"pin": "0000"})).await;
        assert_eq!(e.code, RpcErrorCode::Conflict);
        assert_eq!(e.details, Some(json!({"retryAfterSeconds": want})));
    }
    assert_eq!(a.status().await.failed_attempts, 10);

    // The lockout survives a restart.
    let dir = a.dir;
    drop(a.router);
    drop(a.state);
    let (sink, _rx) = BroadcastSink::channel(64);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    let router = build_router();
    let s: ParentalStatus = serde_json::from_value(
        router
            .dispatch(state.clone(), "parental.status", Value::Null)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(s.failed_attempts, 10);
    assert!(s.retry_after_seconds.is_some(), "{s:?}");
    assert!(!s.unlocked, "an unlock never survives a restart");

    // Once it ends, the right PIN works and clears the count. (The new
    // state's test clock starts at real time, so the stored lockout end is
    // still the one written under the old clock offset.)
    let wait = s.retry_after_seconds.unwrap();
    parental::advance_clock(&state, Duration::from_secs(wait + 1));
    let s: ParentalStatus = serde_json::from_value(
        router
            .dispatch(state.clone(), "parental.unlock", json!({"pin": PIN}))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(s.unlocked);
    assert_eq!((s.failed_attempts, s.retry_after_seconds), (0, None));
}

// ---------------------------------------------------------------------------
// Session unlock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unlock_lasts_unlock_minutes_and_lock_now_ends_it() {
    let mut a = app().await;
    a.set_pin().await;
    assert_eq!(
        a.fail("parental.unlock", json!({})).await,
        RpcErrorCode::Invalid
    );
    let before = chrono::Utc::now();
    let s: ParentalStatus =
        serde_json::from_value(a.call("parental.unlock", json!({"pin": PIN})).await).unwrap();
    assert!(s.unlocked);
    let until = chrono::DateTime::parse_from_rfc3339(s.unlocked_until.as_deref().unwrap())
        .unwrap()
        .with_timezone(&chrono::Utc);
    let mins = (until - before).num_seconds();
    assert!(
        (899..=905).contains(&mins),
        "15 minutes by default, got {mins} s"
    );
    assert!(a.status().await.unlocked);

    a.changes();
    let s: ParentalStatus =
        serde_json::from_value(a.call("parental.lockNow", Value::Null).await).unwrap();
    assert!(!s.unlocked && s.unlocked_until.is_none());
    assert_eq!(a.changes().len(), 1);
    a.call("parental.lockNow", json!({})).await;
    assert!(
        a.changes().is_empty(),
        "locking a locked session changes nothing"
    );

    // 0 = until the app restarts.
    a.call(
        "parental.configure",
        json!({"pin": PIN, "unlockMinutes": 0}),
    )
    .await;
    let s: ParentalStatus =
        serde_json::from_value(a.call("parental.unlock", json!({"pin": PIN})).await).unwrap();
    assert!(s.unlocked && s.unlocked_until.is_none());
    parental::advance_clock(&a.state, Duration::from_secs(86_400 * 30));
    assert!(a.status().await.unlocked, "no expiry");
}

#[tokio::test]
async fn an_expired_unlock_is_noticed_by_the_next_catalog_call() {
    let mut a = app().await;
    fixture(&a).await;
    a.lock("s1", "live", "item", "n2").await;
    a.set_pin().await;
    a.call(
        "parental.configure",
        json!({"pin": PIN, "unlockMinutes": 1}),
    )
    .await;
    a.call("parental.unlock", json!({"pin": PIN})).await;
    let total = |v: Value| v["total"].as_i64().unwrap();
    assert_eq!(
        total(a.call("catalog.channels", json!({"sourceId": "s1"})).await),
        7
    );
    a.changes();
    parental::advance_clock(&a.state, Duration::from_secs(61));
    // No parental call in between: the catalog reader finds the expiry.
    // Hidden again: n2 (locked) and x1 (adult category).
    assert_eq!(
        total(a.call("catalog.channels", json!({"sourceId": "s1"})).await),
        5
    );
    let changes = a.changes();
    assert_eq!(changes.len(), 1, "{changes:?}");
    assert!(!changes[0].unlocked && changes[0].enabled);
    assert!(!a.status().await.unlocked);
    assert!(a.changes().is_empty(), "the expiry is announced once");
}

#[tokio::test]
async fn the_timer_announces_an_expiry_without_any_call() {
    let mut a = app().await;
    parental::init(a.state.clone()).await.unwrap();
    parental::init(a.state.clone()).await.unwrap(); // idempotent
    a.set_pin().await;
    a.call(
        "parental.configure",
        json!({"pin": PIN, "unlockMinutes": 2}),
    )
    .await;
    a.call("parental.unlock", json!({"pin": PIN})).await;
    a.changes();
    parental::advance_clock(&a.state, Duration::from_secs(121));
    let deadline = Instant::now() + Duration::from_secs(5);
    let got = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, a.events.recv()).await {
            Ok(Ok(e)) if e.kind == parental::CHANGED_EVENT => {
                break serde_json::from_value::<ParentalStatus>(e.payload).unwrap()
            }
            Ok(Ok(_)) => continue,
            other => panic!("no parental.changed from the timer: {other:?}"),
        }
    };
    assert!(got.enabled && !got.unlocked && got.unlocked_until.is_none());
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_state_change_emits_parental_changed_without_pin_material() {
    let mut a = app().await;
    fixture(&a).await;
    a.changes();
    let target = target_json("s1", "live", "item", "n1");

    a.set_pin().await;
    let c = a.changes();
    assert_eq!(c.len(), 1, "set PIN");
    assert!(c[0].enabled);

    a.call(
        "parental.setLocked",
        json!({"target": target, "locked": true}),
    )
    .await;
    assert_eq!(a.changes().len(), 1, "lock added");
    a.call(
        "parental.setLocked",
        json!({"target": target, "locked": true}),
    )
    .await;
    assert!(
        a.changes().is_empty(),
        "the same lock again changes nothing"
    );

    a.call("parental.configure", json!({"pin": PIN, "mode": "ask"}))
        .await;
    assert_eq!(a.changes()[0].mode.as_str(), "ask", "configure");

    a.call("parental.unlock", json!({"pin": PIN})).await;
    assert!(a.changes()[0].unlocked, "unlock");

    a.call(
        "parental.setLocked",
        json!({"target": target, "locked": false}),
    )
    .await;
    assert_eq!(a.changes().len(), 1, "lock removed (with the unlock)");

    a.call("parental.lockNow", Value::Null).await;
    assert!(!a.changes()[0].unlocked, "lock now");

    let _ = a.err("parental.unlock", json!({"pin": "0000"})).await;
    assert_eq!(a.changes()[0].failed_attempts, 1, "wrong PIN");

    a.call("parental.disable", json!({"pin": PIN})).await;
    assert!(!a.changes()[0].enabled, "disable");

    // Reads emit nothing.
    a.call("parental.status", Value::Null).await;
    a.call("parental.locks", json!({})).await;
    a.call(
        "parental.check",
        json!({"items": [{"ref": rf("s1", "live", "n1")}]}),
    )
    .await;
    a.call(
        "parental.adultCategories",
        json!({"sourceId": "s1", "contentType": "live"}),
    )
    .await;
    assert!(a.changes().is_empty());
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn locks_are_added_freely_and_removed_with_the_pin() {
    let a = app().await;
    fixture(&a).await;
    a.set_pin().await;
    // Adding needs no PIN, even while locked.
    a.call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "movie", "kind": "item",
                          "targetId": "m2", "name": "  Secret Movie  "}, "locked": true}),
    )
    .await;
    a.lock("s1", "live", "category", "sports").await;
    a.lock("s2", "movie", "item", "t3").await;

    let locks = a.call("parental.locks", json!({})).await;
    let list = locks.as_array().unwrap();
    assert_eq!(list.len(), 3, "{locks}");
    let m2 = list.iter().find(|l| l["targetId"] == "m2").unwrap();
    assert_eq!(m2["name"], "Secret Movie", "the name is trimmed");
    assert_eq!(m2["kind"], "item");
    assert_eq!(m2["contentType"], "movie");
    assert!(chrono::DateTime::parse_from_rfc3339(m2["createdAt"].as_str().unwrap()).is_ok());
    assert_eq!(
        a.call("parental.locks", json!({"sourceId": "s2"}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        a.call("parental.locks", json!({"sourceId": "nope"})).await,
        json!([])
    );
    assert_eq!(
        a.call("parental.locks", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        3
    );

    // Removing one needs the PIN or an unlock.
    let off = |pin: Option<&str>| {
        let mut v =
            json!({"target": target_json("s1", "live", "category", "sports"), "locked": false});
        if let Some(p) = pin {
            v["pin"] = json!(p);
        }
        v
    };
    assert_eq!(
        a.fail("parental.setLocked", off(None)).await,
        RpcErrorCode::Auth
    );
    assert_eq!(
        a.fail("parental.setLocked", off(Some("0000"))).await,
        RpcErrorCode::Auth
    );
    assert_eq!(
        a.call("parental.locks", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        3
    );
    a.call("parental.setLocked", off(Some(PIN))).await;
    assert_eq!(
        a.call("parental.locks", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    a.call("parental.unlock", json!({"pin": PIN})).await;
    a.call(
        "parental.setLocked",
        json!({"target": target_json("s2", "movie", "item", "t3"), "locked": false}),
    )
    .await;
    // Removing a lock that does not exist is fine.
    a.call(
        "parental.setLocked",
        json!({"target": target_json("s2", "movie", "item", "t3"), "locked": false}),
    )
    .await;
    assert_eq!(
        a.call("parental.locks", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Validation.
    for bad in [
        json!({"target": target_json("", "live", "item", "x"), "locked": true}),
        json!({"target": target_json("s1", "live", "item", "  "), "locked": true}),
        json!({"target": target_json("s1", "live", "item", &"x".repeat(600)), "locked": true}),
        json!({"target": target_json("s1", "tv", "item", "x"), "locked": true}),
        json!({"target": target_json("s1", "live", "group", "x"), "locked": true}),
        json!({"target": {"sourceId": "s1", "contentType": "live", "kind": "item", "targetId": "x"}, "locked": true}),
        json!({"target": target_json("s1", "live", "item", "x")}),
    ] {
        assert_eq!(
            a.fail("parental.setLocked", bad.clone()).await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    assert_eq!(
        a.fail(
            "parental.setLocked",
            json!({"target": target_json("gone", "live", "item", "x"), "locked": true})
        )
        .await,
        RpcErrorCode::NotFound,
        "unknown source"
    );
    // A long name is cut, not refused.
    let mut long = target_json("s1", "live", "item", "k1");
    long["name"] = json!("N".repeat(500));
    a.call(
        "parental.setLocked",
        json!({"target": long, "locked": true}),
    )
    .await;
    let k1 = a.call("parental.locks", json!({"sourceId": "s1"})).await;
    let k1 = k1
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["targetId"] == "k1")
        .unwrap()
        .clone();
    assert_eq!(k1["name"].as_str().unwrap().chars().count(), 200);
}

#[tokio::test]
async fn removing_a_source_removes_its_locks() {
    let a = app().await;
    fixture(&a).await;
    a.lock("s1", "live", "item", "n1").await;
    a.lock("s2", "movie", "item", "t1").await;
    a.call("sources.remove", json!({"id": "s1"})).await;
    let locks = a.call("parental.locks", json!({})).await;
    assert_eq!(locks.as_array().unwrap().len(), 1);
    assert_eq!(locks[0]["sourceId"], "s2");
}

#[tokio::test]
async fn removing_a_source_with_locks_needs_the_pin_while_locked() {
    let a = app().await;
    fixture(&a).await;
    support::bare_source(&a.state, "s3").await;
    a.set_pin().await;
    a.lock("s1", "live", "item", "n1").await;
    // No locks in s3: it goes without the PIN (a cancelled import takes a fresh source back).
    a.call("sources.remove", json!({"id": "s3"})).await;
    // Removing s1 (or everything) would shed its lock: refused while locked, nothing deleted.
    assert_eq!(
        a.fail("sources.remove", json!({"id": "s1"})).await,
        RpcErrorCode::Auth
    );
    assert_eq!(
        a.fail("sources.removeAll", Value::Null).await,
        RpcErrorCode::Auth
    );
    assert_eq!(
        a.call("parental.locks", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        a.call("sources.list", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // Unlocked, it goes.
    a.call("parental.unlock", json!({"pin": PIN})).await;
    a.call("sources.remove", json!({"id": "s1"})).await;
    a.call("parental.lockNow", Value::Null).await;
    // s2 holds no lock, so removing every source needs no PIN either.
    a.call("sources.removeAll", Value::Null).await;
    assert!(a
        .call("sources.list", Value::Null)
        .await
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn hide_mode_never_offers_a_hidden_channel_as_an_alternate() {
    let a = app().await;
    fixture(&a).await;
    // s2 carries BBC News too, in a group that gets locked.
    a.state
        .db_call(|c| {
            c.execute(
                "INSERT INTO categories(source_id, content_type, category_id, name, item_count, position)
                 VALUES ('s2', 'live', 'uk', 'UK', 1, 99)",
                [],
            )?;
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, number, position, url)
                 VALUES ('s2', 'live', 'b2', 'uk', 'BBC News', 1, 99, 'http://stream.example/s2/b2')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let alternates = |v: Value| -> Vec<String> {
        v["alternates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["channel"]["ref"]["itemId"].as_str().unwrap().to_string())
            .collect()
    };
    let args = json!({ "ref": rf("s1", "live", "n1") });
    assert_eq!(
        alternates(a.call("live.alternates", args.clone()).await),
        ["b2"]
    );

    a.set_pin().await;
    a.call("parental.configure", json!({ "mode": "hide", "pin": PIN }))
        .await;
    a.lock("s2", "live", "category", "uk").await;
    assert!(alternates(a.call("live.alternates", args.clone()).await).is_empty());
    // Ask mode filters nothing in the core: the player's gate asks for the PIN instead.
    a.call("parental.configure", json!({ "mode": "ask", "pin": PIN }))
        .await;
    assert_eq!(alternates(a.call("live.alternates", args).await), ["b2"]);
}

#[tokio::test]
async fn check_reports_item_category_and_adult_locks() {
    let a = app().await;
    fixture(&a).await;
    fixture_locks(&a).await;
    let items = json!({"items": [
        {"ref": rf("s1", "live", "n2")},                          // item lock
        {"ref": rf("s1", "live", "k1")},                          // free
        {"ref": rf("s1", "live", "x1")},                          // adult category (looked up)
        {"ref": rf("s1", "live", "p1"), "categoryId": "sports"},  // locked category (given)
        {"ref": rf("s1", "live", "zz"), "categoryId": "xxx"},     // not stored, adult category given
        {"ref": rf("s1", "live", "unknown")},                     // not stored, no category
        {"ref": rf("s1", "live", "a1")},                          // "Adult Swim" is not adult
        {"ref": rf("s1", "live", "n2")},                          // duplicate
        {"ref": rf("s2", "movie", "t2"), "categoryId": ""},       // empty id: looked up
    ]});
    // No PIN: nothing is locked right now.
    assert_eq!(a.call("parental.check", items.clone()).await, json!([]));

    a.set_pin().await;
    let want = json!([
        rf("s1", "live", "n2"),
        rf("s1", "live", "x1"),
        rf("s1", "live", "p1"),
        rf("s1", "live", "zz"),
        rf("s2", "movie", "t2"),
    ]);
    assert_eq!(a.call("parental.check", items.clone()).await, want);
    // Ask mode reports the same refs (the UI gates on them).
    a.call("parental.configure", json!({"pin": PIN, "mode": "ask"}))
        .await;
    assert_eq!(a.call("parental.check", items.clone()).await, want);
    // autoAdult off: only explicit locks.
    a.call(
        "parental.configure",
        json!({"pin": PIN, "autoAdult": false}),
    )
    .await;
    assert_eq!(
        a.call("parental.check", items.clone()).await,
        json!([rf("s1", "live", "n2"), rf("s1", "live", "p1")])
    );
    // Unlocked: nothing.
    a.call("parental.unlock", json!({"pin": PIN})).await;
    assert_eq!(a.call("parental.check", items).await, json!([]));

    assert_eq!(
        a.call("parental.check", json!({"items": []})).await,
        json!([])
    );
    let many: Vec<Value> = (0..501)
        .map(|i| json!({"ref": rf("s1", "live", &i.to_string())}))
        .collect();
    assert_eq!(
        a.fail("parental.check", json!({ "items": many })).await,
        RpcErrorCode::Invalid
    );
    let ok: Vec<Value> = (0..500)
        .map(|i| json!({"ref": rf("s1", "live", &i.to_string())}))
        .collect();
    a.call("parental.check", json!({ "items": ok })).await;
    assert_eq!(
        a.fail(
            "parental.check",
            json!({"items": [{"ref": {"sourceId": "s1"}}]})
        )
        .await,
        RpcErrorCode::Invalid
    );
}

#[tokio::test]
async fn adult_categories_follow_the_c2_token_rules() {
    async fn adult(a: &App, src: &str, ct: &str) -> Value {
        a.call(
            "parental.adultCategories",
            json!({"sourceId": src, "contentType": ct}),
        )
        .await
    }
    let a = app().await;
    fixture(&a).await;
    assert_eq!(adult(&a, "s1", "live").await, json!(["xxx"]));
    assert_eq!(adult(&a, "s1", "movie").await, json!(["m18"]));
    assert_eq!(adult(&a, "s1", "series").await, json!(["erotic"]));
    assert_eq!(adult(&a, "s2", "movie").await, json!(["adult2"]));
    assert_eq!(adult(&a, "s2", "live").await, json!([]));
    assert_eq!(adult(&a, "nope", "live").await, json!([]));
    // Reported whether or not autoAdult is on.
    a.call("parental.configure", json!({"autoAdult": false}))
        .await;
    assert_eq!(adult(&a, "s1", "live").await, json!(["xxx"]));
    assert_eq!(
        a.fail(
            "parental.adultCategories",
            json!({"sourceId": "s1", "contentType": "tv"})
        )
        .await,
        RpcErrorCode::Invalid
    );

    for yes in [
        "XXX",
        "xxx movies",
        "ADULT",
        "Adults",
        "18+",
        "+18 Channels",
        "Movies 18+",
        "PORN",
        "Erotic",
        "Playboy TV",
        "HUSTLER",
        "Private",
        "[XXX] Hot",
        "|XXX| VOD",
        "VOD | ADULT",
        "(18+)",
        "US: Adult",
        "Adult Swim Adult",
    ] {
        assert!(is_adult_category(yes), "{yes:?} is adult");
    }
    for no in [
        "Adult Swim",
        "ADULT SWIM",
        "adult swim HD",
        "US | Adult Swim",
        "[Adult Swim]",
        "Kids",
        "Pornography",
        "Adulting",
        "XXXL Sports",
        "118+",
        "Privates",
        "Sussex",
        "",
    ] {
        assert!(!is_adult_category(no), "{no:?} is not adult");
    }
}

// ---------------------------------------------------------------------------
// Hide mode in every reader
// ---------------------------------------------------------------------------

#[tokio::test]
async fn without_a_pin_locks_filter_nothing() {
    let a = app().await;
    fixture(&a).await;
    fixture_user_state(&a).await;
    fixture_locks(&a).await;
    assert_eq!(readers(&a).await, unfiltered());
}

#[tokio::test]
async fn hide_mode_drops_locked_and_adult_items_from_every_reader() {
    let a = hidden_app().await;
    assert_eq!(readers(&a).await, hidden());
}

#[tokio::test]
async fn hide_mode_without_auto_adult_drops_only_explicit_locks() {
    let a = hidden_app().await;
    a.call(
        "parental.configure",
        json!({"pin": PIN, "autoAdult": false}),
    )
    .await;
    assert_eq!(readers(&a).await, hidden_locks_only());
}

#[tokio::test]
async fn ask_mode_filters_nothing_in_the_core() {
    let a = hidden_app().await;
    a.call("parental.configure", json!({"pin": PIN, "mode": "ask"}))
        .await;
    assert!(!a.status().await.unlocked);
    assert_eq!(readers(&a).await, unfiltered());
}

#[tokio::test]
async fn an_unlock_shows_everything_until_lock_now() {
    let a = hidden_app().await;
    a.call("parental.unlock", json!({"pin": PIN})).await;
    assert_eq!(readers(&a).await, unfiltered());
    a.call("parental.lockNow", Value::Null).await;
    assert_eq!(readers(&a).await, hidden());
}

#[tokio::test]
async fn hide_mode_pages_count_only_what_they_can_show() {
    let a = hidden_app().await;
    // Paging: total counts the visible rows, pages hold only them.
    let p1 = a
        .call(
            "catalog.channels",
            json!({"sourceId": "s1", "query": {"limit": 2}}),
        )
        .await;
    assert_eq!(p1["total"], 3);
    assert_eq!(ids(&p1), set(&["n1", "k1"]));
    let p2 = a
        .call(
            "catalog.channels",
            json!({"sourceId": "s1", "query": {"offset": 2, "limit": 2}}),
        )
        .await;
    assert_eq!(ids(&p2), set(&["a1"]));
    // A locked or adult category's page is empty; others count their rest.
    for (cat, total) in [("sports", 0), ("xxx", 0), ("news", 1), ("swim", 1)] {
        let v = a
            .call(
                "catalog.channels",
                json!({"sourceId": "s1", "categoryId": cat}),
            )
            .await;
        assert_eq!(v["total"], total, "{cat}: {v}");
    }
    // In-list search, FTS and the LIKE fallback.
    for (q, total) in [
        ("Sports", 0),
        ("Night", 0),
        ("CNN", 0),
        ("BBC", 1),
        ("ews", 1),
    ] {
        let v = a
            .call(
                "catalog.channels",
                json!({"sourceId": "s1", "query": {"search": q}}),
            )
            .await;
        assert_eq!(v["total"], total, "{q}: {v}");
    }
    // Sorted pages and the rating filter keep the filter.
    let v = a
        .call(
            "catalog.movies",
            json!({"sourceId": "s1", "query": {"sort": "added", "dir": "desc"}}),
        )
        .await;
    assert_eq!((v["total"].clone(), ids(&v)), (json!(1), set(&["m1"])));
    let v = a.call("catalog.movies", json!({"sourceId": "s2"})).await;
    assert_eq!(ids(&v), set(&["t1"]));
    // Global search with a LIKE-only term.
    let v = a.call("catalog.search", json!({"query": "arbor"})).await;
    assert_eq!(ids(&v["movies"]), set(&["m1", "t1"]));
    let v = a
        .call(
            "catalog.search",
            json!({"query": "Harbor", "sourceId": "s2"}),
        )
        .await;
    assert_eq!(ids(&v["movies"]), set(&["t1"]));
    // English-only and hide mode together.
    a.call("settings.update", json!({"patch": {"englishOnly": true}}))
        .await;
    let v = a.call("catalog.channels", json!({"sourceId": "s1"})).await;
    assert_eq!(v["total"], 3);
    let cats = a
        .call(
            "catalog.categories",
            json!({"sourceId": "s1", "contentType": "live"}),
        )
        .await;
    let names: Vec<&str> = cats
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["news", "kids", "swim"]);
    assert_eq!(cats[0]["itemCount"], 1);
}

#[tokio::test]
async fn hide_mode_hides_locked_categories_from_category_management_too() {
    let a = hidden_app().await;
    a.call(
        "catalog.setCategoryHidden",
        json!({"sourceId": "s1", "contentType": "live", "categoryId": "kids", "hidden": true}),
    )
    .await;
    let cats = a
        .call(
            "catalog.categories",
            json!({"sourceId": "s1", "contentType": "live", "includeHidden": true}),
        )
        .await;
    let names: Vec<&str> = cats
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["news", "kids", "swim"]);
    // Locking every channel of a category empties it, so it goes.
    a.lock("s1", "live", "item", "n1").await;
    let cats = a
        .call(
            "catalog.categories",
            json!({"sourceId": "s1", "contentType": "live"}),
        )
        .await;
    assert_eq!(cats.as_array().unwrap().len(), 1, "{cats}");
    assert_eq!(cats[0]["id"], "swim");
}

#[tokio::test]
async fn hide_mode_keeps_locked_items_out_of_single_item_reads() {
    let a = hidden_app().await;
    for r in [
        rf("s1", "live", "n2"),
        rf("s1", "live", "x1"),
        rf("s1", "live", "p1"),
        rf("s1", "movie", "m2"),
        rf("s2", "movie", "t2"),
    ] {
        let e = a.err("catalog.item", json!({ "ref": r })).await;
        assert_eq!(e.code, RpcErrorCode::NotFound, "{r}");
        assert!(e.message.contains("parental"), "{}", e.message);
    }
    let v = a
        .call("catalog.item", json!({"ref": rf("s1", "live", "a1")}))
        .await;
    assert_eq!(v["name"], "Adult Swim HD");
    for (n, ct) in [(2, "live"), (4, "live"), (6, "live")] {
        assert_eq!(
            a.call(
                "catalog.channelByNumber",
                json!({"sourceId": "s1", "number": n, "contentType": ct})
            )
            .await,
            Value::Null,
            "channel {n}"
        );
    }
    // Neighbors inside a category skip its locked channels.
    let nb = a
        .call(
            "catalog.neighbors",
            json!({"ref": rf("s1", "live", "n1"), "categoryId": "news"}),
        )
        .await;
    assert!(
        nb.get("prev").is_none() && nb.get("next").is_none(),
        "n1 is alone in news: {nb}"
    );
    // Provider details take a ref directly and refuse a hidden title the same way.
    for (cmd, r) in [
        ("xtream.vodDetail", rf("s1", "movie", "m2")),
        ("xtream.seriesDetail", rf("s1", "series", "r3")),
        ("stalker.vodDetail", rf("s1", "movie", "m3")),
        ("stalker.seriesDetail", rf("s1", "series", "r2")),
    ] {
        let e = a.err(cmd, json!({ "ref": r })).await;
        assert_eq!(e.code, RpcErrorCode::NotFound, "{cmd} {r}");
        assert!(e.message.contains("parental"), "{cmd}: {}", e.message);
    }
    // A visible title gets past the check (the fixture source is M3U, so the portal call fails).
    let e = a
        .err("xtream.vodDetail", json!({"ref": rf("s1", "movie", "m1")}))
        .await;
    assert!(!e.message.contains("parental"), "{}", e.message);
    a.call("parental.unlock", json!({"pin": PIN})).await;
    a.call("catalog.item", json!({"ref": rf("s1", "live", "n2")}))
        .await;
    let e = a
        .err("xtream.vodDetail", json!({"ref": rf("s1", "movie", "m2")}))
        .await;
    assert!(!e.message.contains("parental"), "unlocked: {}", e.message);
}

/// Stream and catch-up URLs take a ref directly too: a channel left in the
/// zap history or a resume record must not play while hide mode hides it.
#[tokio::test]
async fn hide_mode_refuses_stream_and_catchup_urls_of_hidden_items() {
    let a = hidden_app().await;
    let start = "2026-10-14T08:00:00Z";
    let calls = |r: Value| {
        [
            ("xtream.streamUrl", json!({ "ref": r })),
            (
                "xtream.catchupUrl",
                json!({"ref": r, "start": start, "durationMinutes": 30.0}),
            ),
            ("stalker.streamUrl", json!({ "ref": r })),
            (
                "stalker.catchupUrl",
                json!({"ref": r, "start": start, "durationMinutes": 30}),
            ),
        ]
    };
    // An item lock, a category lock, an adult category, and a locked title
    // (episode playback goes through the series ref).
    for r in [
        rf("s1", "live", "n2"),
        rf("s1", "live", "p1"),
        rf("s1", "live", "x1"),
        rf("s1", "movie", "m2"),
        rf("s1", "series", "r3"),
    ] {
        for (cmd, args) in calls(r.clone()) {
            let e = a.err(cmd, args).await;
            assert_eq!(e.code, RpcErrorCode::NotFound, "{cmd} {r}");
            assert!(e.message.contains("parental"), "{cmd} {r}: {}", e.message);
        }
    }
    // A visible channel gets past the check (the fixture source is M3U, so
    // the provider call fails later for another reason).
    for (cmd, args) in calls(rf("s1", "live", "n1")) {
        let e = a.err(cmd, args).await;
        assert!(!e.message.contains("parental"), "{cmd}: {}", e.message);
    }
    a.call("parental.unlock", json!({"pin": PIN})).await;
    for (cmd, args) in calls(rf("s1", "live", "n2")) {
        let e = a.err(cmd, args).await;
        assert!(
            !e.message.contains("parental"),
            "unlocked {cmd}: {}",
            e.message
        );
    }
}

/// Stalker movies and series never reach `items` (the portal pages them
/// live); their category is known only from the remembered portal row. Hide
/// mode must still apply category and adult-category locks to them in every
/// user-state reader, `parental.check` and the commands that open or play
/// them.
#[tokio::test]
async fn hide_mode_applies_category_locks_to_stalker_titles() {
    use iptv_core::model::{ContentType, ItemRef};
    use iptv_core::stalker::{persist_items, CachedItem};
    let a = app().await;
    support::bare_source(&a.state, "stk").await;
    a.state
        .db_call(|c| {
            // What a Stalker sync stores for VOD: categories, no items rows.
            for (pos, (id, name)) in [("xm", "XXX Movies"), ("km", "Late Movies"), ("ok", "Action")]
                .iter()
                .enumerate()
            {
                c.execute(
                    "INSERT INTO categories(source_id, content_type, category_id, name, item_count, position)
                     VALUES ('stk', 'movie', ?1, ?2, 0, ?3)",
                    params![id, name, pos as i64],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    // Listing the portal's movies remembers each row with its category.
    let row = |id: &str, cat: &str, name: &str| {
        (
            ItemRef::new("stk", ContentType::Movie, id),
            CachedItem {
                raw: json!({"id": id, "name": id, "cmd": format!("http://portal.invalid/{id}.mp4")}),
                category_name: Some(name.to_string()),
                category_id: Some(cat.to_string()),
            },
        )
    };
    persist_items(
        &a.state,
        vec![
            row("portal42", "xm", "XXX Movies"),
            row("portal43", "km", "Late Movies"),
            row("portal44", "ok", "Action"),
        ],
    )
    .await;
    for id in ["portal42", "portal43", "portal44"] {
        let r = rf("stk", "movie", id);
        let snap = json!({"title": id, "contentType": "movie"});
        a.call("favorites.toggle", json!({"ref": r, "snapshot": snap}))
            .await;
        a.call("recent.add", json!({"ref": r, "snapshot": snap}))
            .await;
        a.call(
            "positions.set",
            json!({"ref": r, "positionSeconds": 600, "durationSeconds": 6000, "snapshot": snap}),
        )
        .await;
        a.call("watchlist.toggle", json!({"ref": r, "snapshot": snap}))
            .await;
    }
    a.lock("stk", "movie", "category", "km").await;
    a.set_pin().await;

    let all = set(&["portal42", "portal43", "portal44"]);
    let visible = set(&["portal44"]);
    for (cmd, args) in [
        ("favorites.list", json!({})),
        ("recent.list", json!({})),
        ("positions.continueWatching", json!({})),
        ("watchlist.list", json!({})),
    ] {
        assert_eq!(ids(&a.call(cmd, args).await), visible, "{cmd} (hide)");
    }
    let refs: Vec<Value> = ["portal42", "portal43", "portal44"]
        .iter()
        .map(|id| json!({ "ref": rf("stk", "movie", id) }))
        .collect();
    let locked: BTreeSet<String> = a
        .call("parental.check", json!({ "items": refs }))
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["itemId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        locked,
        set(&["portal42", "portal43"]),
        "check without categoryId"
    );
    for id in ["portal42", "portal43"] {
        for (cmd, args) in [
            ("stalker.vodDetail", json!({"ref": rf("stk", "movie", id)})),
            ("stalker.streamUrl", json!({"ref": rf("stk", "movie", id)})),
        ] {
            let e = a.err(cmd, args).await;
            assert_eq!(e.code, RpcErrorCode::NotFound, "{cmd} {id}");
            assert!(e.message.contains("parental"), "{cmd} {id}: {}", e.message);
        }
    }
    let e = a
        .err(
            "stalker.vodDetail",
            json!({"ref": rf("stk", "movie", "portal44")}),
        )
        .await;
    assert!(!e.message.contains("parental"), "{}", e.message);

    a.call("parental.unlock", json!({"pin": PIN})).await;
    for cmd in [
        "favorites.list",
        "recent.list",
        "positions.continueWatching",
        "watchlist.list",
    ] {
        assert_eq!(ids(&a.call(cmd, json!({})).await), all, "{cmd} (unlocked)");
    }
}

/// A `stalker_items` table an older build created (no `category_id`) is
/// brought up to date at start-up, the column filled from the remembered
/// row, so hide mode covers titles listed before the upgrade.
#[tokio::test]
async fn an_old_stalker_row_cache_gets_its_categories_at_start_up() {
    let a = app().await;
    support::bare_source(&a.state, "stk").await;
    a.state
        .db_call(|c| {
            c.execute_batch(
                "CREATE TABLE stalker_items (
                   source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                   content_type TEXT NOT NULL,
                   item_id TEXT NOT NULL,
                   raw_json TEXT NOT NULL,
                   category_name TEXT,
                   touched_at INTEGER NOT NULL,
                   PRIMARY KEY (source_id, content_type, item_id)
                 ) WITHOUT ROWID;
                 INSERT INTO categories(source_id, content_type, category_id, name, item_count, position)
                   VALUES ('stk', 'movie', 'xm', 'XXX Movies', 0, 0), ('stk', 'movie', 'km', 'Late Movies', 0, 1);
                 INSERT INTO stalker_items VALUES
                   ('stk', 'movie', 'p1', '{\"id\":\"p1\",\"category_id\":12}', NULL, 1),
                   ('stk', 'movie', 'p2', '{\"id\":\"p2\"}', 'Late Movies', 2),
                   ('stk', 'movie', 'p3', 'not json', NULL, 3);",
            )?;
            Ok(())
        })
        .await
        .unwrap();
    iptv_core::stalker::init(a.state.clone()).await.unwrap();
    let cats: Vec<(String, Option<String>)> = a
        .state
        .db_call(|c| {
            let mut s =
                c.prepare("SELECT item_id, category_id FROM stalker_items ORDER BY item_id")?;
            let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(
        cats,
        vec![
            ("p1".to_string(), Some("12".to_string())),
            ("p2".to_string(), Some("km".to_string())),
            ("p3".to_string(), None),
        ]
    );
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

const PLAYLIST: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"news1\" group-title=\"News\",Morning News\nhttp://stream.example/news1.ts\n\
#EXTINF:-1 tvg-id=\"news2\" group-title=\"News\",Evening News\nhttp://stream.example/news2.ts\n\
#EXTINF:-1 tvg-id=\"late\" group-title=\"XXX Adult\",Late Channel\nhttp://stream.example/late.ts\n\
#EXTINF:-1 tvg-id=\"swim\" group-title=\"Adult Swim\",Adult Swim\nhttp://stream.example/swim.ts\n";

/// Locks, options and My List of an app with one M3U source; returns the
/// source id and the backup JSON.
async fn backup_source(a: &App, pin: &str) -> (String, String) {
    let src = support::add_text(&a.state, "Home", PLAYLIST).await;
    let sid = src.id.clone();
    let channels = a.call("catalog.channels", json!({ "sourceId": sid })).await;
    let evening = channels["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Evening News")
        .unwrap()["ref"]["itemId"]
        .as_str()
        .unwrap()
        .to_string();
    let news = channels["items"][0]["categoryId"]
        .as_str()
        .unwrap()
        .to_string();
    a.call("parental.setPin", json!({ "newPin": pin })).await;
    a.call(
        "parental.configure",
        json!({"pin": pin, "mode": "ask", "autoAdult": false, "unlockMinutes": 45}),
    )
    .await;
    a.lock(&sid, "live", "item", &evening).await;
    a.lock(&sid, "live", "category", &news).await;
    a.lock(&sid, "movie", "item", "vod-9").await;
    for (id, title) in [("vod-1", "First Film"), ("vod-2", "Second Film")] {
        a.call(
            "watchlist.toggle",
            json!({"ref": rf(&sid, "movie", id), "snapshot": {"title": title, "contentType": "movie"}}),
        )
        .await;
    }
    let out = a.call("backup.export", json!({})).await;
    (sid, out["json"].as_str().unwrap().to_string())
}

fn entry_ext<'a>(manifest: &'a Value, key: &str) -> &'a Value {
    &manifest["playlists"][0]["userState"][key]
}

/// `(ref, title)` of every My List entry.
async fn my_list(a: &App) -> Vec<(Value, Value)> {
    a.call("watchlist.list", json!({}))
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["ref"].clone(), e["snapshot"]["title"].clone()))
        .collect()
}

async fn source_count(a: &App) -> usize {
    a.call("sources.list", json!({}))
        .await
        .as_array()
        .unwrap()
        .len()
}

async fn lock_count(a: &App) -> usize {
    a.call("parental.locks", json!({}))
        .await
        .as_array()
        .unwrap()
        .len()
}

#[tokio::test]
async fn backup_round_trip_keeps_locks_options_and_my_list_but_never_the_pin() {
    let a = app().await;
    let pin = "97531864";
    let (sid, json) = backup_source(&a, pin).await;

    // No PIN material anywhere in the file.
    let (hash, salt) = a.stored_pin().await;
    let (hash, salt) = (hash.unwrap(), salt.unwrap());
    assert!(!json.contains(pin), "the PIN is in the backup");
    assert!(!json.contains(&hash), "the PIN hash is in the backup");
    assert!(!json.contains(&salt), "the PIN salt is in the backup");
    assert!(!json.contains("pbkdf2"));
    let manifest: Value = serde_json::from_str(&json).unwrap();
    assert_no_pin_material(&manifest);
    assert_eq!(
        manifest["settings"]["tsrustParental"],
        json!({"mode": "ask", "autoAdult": false, "unlockMinutes": 45})
    );
    let locks = entry_ext(&manifest, "tsrustParentalLocks");
    assert_eq!(locks.as_array().unwrap().len(), 3, "{locks}");
    for l in locks.as_array().unwrap() {
        let keys: BTreeSet<&str> = l.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["contentType", "createdAt", "kind", "name", "targetId"]
                .into_iter()
                .collect()
        );
    }
    let watch = entry_ext(&manifest, "tsrustWatchlist");
    assert_eq!(watch.as_array().unwrap().len(), 2, "{watch}");

    // Into a fresh app.
    let b = app().await;
    let report = b
        .call("backup.import", json!({ "json": json, "mode": "merge" }))
        .await;
    assert_eq!(report["imported"], 1, "{report}");
    let s = b.status().await;
    assert!(!s.enabled, "the PIN is never restored");
    assert_eq!(
        (s.mode.as_str(), s.auto_adult, s.unlock_minutes),
        ("ask", false, 45)
    );
    assert_eq!(b.stored_pin().await, (None, None));
    let strip = |v: Value| -> Vec<Value> {
        let mut v: Vec<Value> = v.as_array().unwrap().clone();
        for l in &mut v {
            l.as_object_mut().unwrap().remove("createdAt");
        }
        v
    };
    let before = a.call("parental.locks", json!({})).await;
    let after = b.call("parental.locks", json!({})).await;
    assert_eq!(after[0]["sourceId"], sid, "the exported id is reused");
    assert_eq!(strip(after.clone()), strip(before.clone()));
    assert_eq!(after, before, "createdAt survives too");
    assert_eq!(my_list(&b).await, my_list(&a).await);

    // Exporting again gives the same extension blocks.
    let again: Value = serde_json::from_str(
        b.call("backup.export", json!({})).await["json"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        entry_ext(&again, "tsrustParentalLocks"),
        entry_ext(&manifest, "tsrustParentalLocks")
    );
    assert_eq!(
        entry_ext(&again, "tsrustWatchlist"),
        entry_ext(&manifest, "tsrustWatchlist")
    );
    assert_eq!(
        again["settings"]["tsrustParental"],
        manifest["settings"]["tsrustParental"]
    );

    // A merge of the same file adds nothing.
    b.call("backup.import", json!({ "json": json, "mode": "merge" }))
        .await;
    assert_eq!(b.call("parental.locks", json!({})).await, before);
    assert_eq!(my_list(&b).await.len(), 2);
}

#[tokio::test]
async fn a_locked_app_takes_backup_locks_but_not_weaker_options() {
    let a = app().await;
    let (_sid, json) = backup_source(&a, "1357").await;

    let c = app().await;
    c.set_pin().await; // hide, autoAdult on, 15 min; locked
    let report = c
        .call("backup.import", json!({ "json": json, "mode": "merge" }))
        .await;
    let warnings = report["warnings"].to_string();
    assert!(warnings.contains("Parental settings"), "{warnings}");
    let s = c.status().await;
    assert_eq!(
        (s.mode.as_str(), s.auto_adult, s.unlock_minutes),
        ("hide", true, 15),
        "a locked app keeps its options"
    );
    assert_eq!(
        lock_count(&c).await,
        3,
        "locks only add protection, so they are taken"
    );

    // Replace would drop every source and its locks: it needs an unlock.
    let n = source_count(&c).await;
    let e = c
        .err("backup.import", json!({ "json": json, "mode": "replace" }))
        .await;
    assert_eq!(e.code, RpcErrorCode::Auth, "{}", e.message);
    assert_eq!(source_count(&c).await, n, "nothing changed");
    assert_eq!(lock_count(&c).await, 3);
    c.call("parental.unlock", json!({ "pin": PIN })).await;
    c.call("backup.import", json!({ "json": json, "mode": "replace" }))
        .await;
    let s = c.status().await;
    assert!(s.enabled, "the PIN set here stays");
    assert_eq!(
        (s.mode.as_str(), s.auto_adult, s.unlock_minutes),
        ("ask", false, 45),
        "unlocked, the backup's options apply"
    );
    assert_eq!(source_count(&c).await, 1);
    assert_eq!(
        lock_count(&c).await,
        3,
        "the new source has the backup's locks"
    );
}

#[tokio::test]
async fn unreadable_backup_rows_are_skipped_with_warnings() {
    let a = app().await;
    let (_sid, json) = backup_source(&a, "1357").await;
    let mut manifest: Value = serde_json::from_str(&json).unwrap();
    let us = &mut manifest["playlists"][0]["userState"];
    us["tsrustParentalLocks"].as_array_mut().unwrap().extend([
        json!({"contentType": "tv", "kind": "item", "targetId": "x"}),
        json!({"contentType": "live", "kind": "group", "targetId": "x"}),
        json!({"contentType": "live", "kind": "item"}),
        json!({"contentType": "live", "kind": "item", "targetId": " "}),
        json!("nonsense"),
    ]);
    us["tsrustWatchlist"]
        .as_array_mut()
        .unwrap()
        .push(json!({"itemId": 5}));
    manifest["settings"]["tsrustParental"] =
        json!({"mode": "block", "autoAdult": "yes", "unlockMinutes": 9999});
    let b = app().await;
    let report = b
        .call(
            "backup.import",
            json!({ "json": manifest.to_string(), "mode": "merge" }),
        )
        .await;
    let warnings = report["warnings"].to_string();
    for needle in [
        "5 parental lock(s)",
        "My List entr",
        "Parental mode",
        "Parental autoAdult",
        "Parental unlockMinutes",
    ] {
        assert!(warnings.contains(needle), "{needle}: {warnings}");
    }
    assert_eq!(lock_count(&b).await, 3);
    assert_eq!(b.status().await, ParentalStatus::default());
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/// Hide mode on 50k channels (250 groups, 10 of them adult by name, 2
/// locked, 200 channel locks) answers every catalog reader within the
/// catalog query budget (100 ms a call, 4x for the 20k-row zap list).
///
/// The real bar is release:
/// `cargo test --release -p iptv-core --test parental hide_mode_queries`.
/// Unlike catalog_perf, debug budgets are doubled: the deep page also probes
/// the hidden-rowid set for each of the 47k rows it skips, about 70 ms in a
/// debug build (50 ms in release), too close to 100 ms while the other
/// tests of this file (100k-iteration PBKDF2) run beside it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hide_mode_queries_on_50k_channels_stay_fast() {
    const CHANNELS: usize = 50_000;
    const GROUPS: usize = 250;
    #[cfg(debug_assertions)]
    const SCALE: u32 = 2;
    #[cfg(not(debug_assertions))]
    const SCALE: u32 = 1;
    const QUERY_BUDGET: Duration = Duration::from_millis(100 * SCALE as u64);

    let a = app().await;
    let src = support::add_text(&a.state, "big", &support::gen_m3u(CHANNELS, GROUPS)).await;
    let sid = src.id.clone();
    let s2 = sid.clone();
    // Groups 0..10 become adult by name; locks: groups 10 and 11, and the
    // first channel of groups 20..220 (channel k sits in group k % 250).
    let item_locks: Vec<String> = a
        .state
        .db_call(move |c| {
            c.execute(
                "UPDATE categories SET name = 'XXX ' || name WHERE source_id = ?1 AND content_type = 'live' AND name IN ('Group 0','Group 1','Group 2','Group 3','Group 4','Group 5','Group 6','Group 7','Group 8','Group 9')",
                [&s2],
            )?;
            let mut stmt = c.prepare(
                "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = 'live' AND title = ?2",
            )?;
            let mut out = Vec::new();
            for k in 20..220 {
                out.push(stmt.query_row(params![s2, format!("Channel {k}")], |r| r.get(0))?);
            }
            Ok(out)
        })
        .await
        .unwrap();
    assert_eq!(item_locks.len(), 200);
    let cats = a
        .call(
            "catalog.categories",
            json!({"sourceId": sid, "contentType": "live"}),
        )
        .await;
    let cat_id = |name: &str| -> String {
        cats.as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("{name}"))["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    for g in ["Group 10", "Group 11"] {
        a.lock(&sid, "live", "category", &cat_id(g)).await;
    }
    for id in &item_locks {
        a.lock(&sid, "live", "item", id).await;
    }
    let open_group = cat_id("Group 125");
    a.set_pin().await;

    let per_group = CHANNELS / GROUPS;
    let visible = CHANNELS - 12 * per_group - 200;

    type Check = Box<dyn Fn(&Value)>;
    let calls: Vec<(&str, &str, Value, Check)> = vec![
        (
            "categories",
            "catalog.categories",
            json!({"sourceId": sid, "contentType": "live"}),
            Box::new(move |v: &Value| assert_eq!(v.as_array().unwrap().len(), GROUPS - 12)),
        ),
        (
            "first page",
            "catalog.channels",
            json!({"sourceId": sid}),
            Box::new(move |v: &Value| assert_eq!(v["total"], visible as i64)),
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
            json!({"sourceId": sid, "categoryId": open_group}),
            Box::new(move |v: &Value| assert_eq!(v["total"], (per_group - 1) as i64)),
        ),
        (
            "sorted by name",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"sort": "name", "dir": "desc"}}),
            Box::new(|v: &Value| assert_eq!(v["items"].as_array().unwrap().len(), 100)),
        ),
        (
            "in-list search",
            "catalog.channels",
            json!({"sourceId": sid, "query": {"search": "Channel 99"}}),
            Box::new(|v: &Value| assert!(v["total"].as_i64().unwrap() >= 10, "{v}")),
        ),
        (
            "global search",
            "catalog.search",
            json!({"query": "Channel 1234"}),
            Box::new(|v: &Value| assert!(!v["live"].as_array().unwrap().is_empty(), "{v}")),
        ),
        (
            "channel by number (visible)",
            "catalog.channelByNumber",
            json!({"sourceId": sid, "number": 9_876}),
            Box::new(|v: &Value| assert_eq!(v["name"], "Channel 9875")),
        ),
        (
            "channel by number (adult group)",
            "catalog.channelByNumber",
            json!({"sourceId": sid, "number": 1}),
            Box::new(|v: &Value| assert_eq!(*v, Value::Null)),
        ),
        (
            "all live channels",
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
        let first = a.call(method, args.clone()).await;
        check(&first);
        let started = Instant::now();
        let v = a.call(method, args).await;
        let took = started.elapsed();
        check(&v);
        eprintln!("parental perf: {label} in {took:?}");
        let budget = if method == "catalog.allLiveChannels" {
            QUERY_BUDGET * 4
        } else {
            QUERY_BUDGET
        };
        assert!(took < budget, "{label} took {took:?} (budget {budget:?})");
    }

    let mid = a
        .call(
            "catalog.channels",
            json!({"sourceId": sid, "query": {"offset": visible / 2, "limit": 1}}),
        )
        .await;
    let reference = mid["items"][0]["ref"].clone();
    let _ = a
        .call("catalog.neighbors", json!({ "ref": reference }))
        .await;
    let started = Instant::now();
    let n = a
        .call("catalog.neighbors", json!({ "ref": reference }))
        .await;
    let took = started.elapsed();
    eprintln!("parental perf: neighbors in {took:?}");
    assert!(n["next"].is_object() && n["prev"].is_object(), "{n}");
    assert!(took < QUERY_BUDGET, "neighbors took {took:?}");
}
