//! Watch stats (`stats.*`, Run 2 contract C7) through the full router:
//! record validation, zero-filled 7/30-day summaries, the live/VOD split,
//! top list order and fallbacks, parental hide mode, pruning, source removal
//! and the backup functions `export_log` / `import_log`.

use chrono::{Days, NaiveDate};
use iptv_core::error::RpcErrorCode;
use iptv_core::model::ContentType;
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::stats::{
    export_log, fmt_day, import_log, utc_today, WatchLogBackup, MAX_DAY_SECONDS, TOP_MAX,
};
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
}

/// A fresh app with sources `s1` ("Alpha") and `s2` ("Beta"). s1's catalog
/// has live channel `7` (logo) in category `10` and movie `201` (poster).
async fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(64);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    state
        .db_call(|c| {
            for (id, name) in [("s1", "Alpha"), ("s2", "Beta")] {
                c.execute(
                    "INSERT INTO sources(id, kind, name, position, created_at, config_json)
                     VALUES (?1, 'xtream', ?2, 0, CURRENT_TIMESTAMP, '{}')",
                    params![id, name],
                )?;
            }
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, logo_url)
                 VALUES ('s1', 'live', '7', '10', 'BBC One', 'http://img/bbc.png')",
                [],
            )?;
            c.execute(
                "INSERT INTO items(source_id, content_type, item_id, category_id, title, poster_url)
                 VALUES ('s1', 'movie', '201', '20', 'Black Harbor', 'http://img/201.jpg')",
                [],
            )?;
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

/// `today` (the core's UTC date) shifted by `delta` days.
fn day(delta: i64) -> String {
    let t = utc_today();
    let d = if delta >= 0 {
        t.checked_add_days(Days::new(delta as u64))
    } else {
        t.checked_sub_days(Days::new(delta.unsigned_abs()))
    };
    fmt_day(d.unwrap())
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

    async fn record(&self, r: Value, title: &str, seconds: i64, day: &str) {
        self.call(
            "stats.record",
            json!({"ref": r, "title": title, "seconds": seconds, "day": day}),
        )
        .await;
    }

    async fn summary(&self, days: u32) -> Value {
        self.call("stats.summary", json!({"days": days, "today": day(0)}))
            .await
    }

    async fn rows(&self) -> i64 {
        self.state
            .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM watch_log", [], |r| r.get(0))?))
            .await
            .unwrap()
    }

    /// Inserts a row directly, bypassing the record checks (old days).
    async fn insert(&self, day: &str, source: &str, ct: &str, id: &str, title: &str, seconds: i64) {
        let args = (
            day.to_string(),
            source.to_string(),
            ct.to_string(),
            id.to_string(),
            title.to_string(),
        );
        self.state
            .db_call(move |c| {
                c.execute(
                    "INSERT INTO watch_log(day, source_id, content_type, item_id, title, seconds, last_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-01-01T00:00:00.000Z')",
                    params![args.0, args.1, args.2, args.3, args.4, seconds],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }
}

fn titles(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn the_full_router_registers_every_command() {
    let names = build_router().names();
    for cmd in ["stats.record", "stats.summary", "stats.clear"] {
        assert!(names.contains(&cmd), "{cmd} is registered");
    }
}

#[tokio::test]
async fn record_validates_its_input_with_the_contract_codes() {
    let a = app().await;
    let live = rf("s1", "live", "7");
    let ok = |extra: Value| {
        let mut v = json!({"ref": live, "title": "BBC One", "seconds": 30, "day": day(0)});
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    };
    for bad in [
        ok(json!({"seconds": 0})),
        ok(json!({"seconds": -5})),
        ok(json!({"seconds": 301})),
        ok(json!({"seconds": 2.5})),
        ok(json!({"day": day(3)})),
        ok(json!({"day": day(-3)})),
        ok(json!({"day": "2026-13-01"})),
        ok(json!({"day": "14/10/2026"})),
        ok(json!({"title": "   "})),
        ok(json!({"title": "x".repeat(301)})),
        ok(json!({"ref": rf("s1", "episode", "7")})),
        ok(json!({"ref": rf("s1", "live", " ")})),
        json!({"title": "BBC One", "seconds": 30, "day": day(0)}),
    ] {
        assert_eq!(
            a.fail("stats.record", bad.clone()).await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    assert_eq!(
        a.fail("stats.record", ok(json!({"ref": rf("nope", "live", "7")})))
            .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(a.rows().await, 0, "nothing was written");

    // The edges are accepted: 1 and 300 seconds, two days either side, a
    // 300-character title (after trimming), any of the four content types.
    for (extra, n) in [
        (json!({"seconds": 1}), 1),
        (json!({"seconds": 300, "day": day(2)}), 2),
        (json!({"day": day(-2)}), 3),
        (json!({"title": format!("  {}  ", "é".repeat(300))}), 3),
        (json!({"ref": rf("s1", "radio", "9")}), 4),
        (json!({"ref": rf("s1", "series", "3")}), 5),
    ] {
        a.call("stats.record", ok(extra)).await;
        assert_eq!(a.rows().await, n);
    }
}

#[tokio::test]
async fn record_adds_seconds_and_refreshes_the_snapshot() {
    let a = app().await;
    let movie = rf("s1", "movie", "201");
    a.record(movie.clone(), "Black Harbor", 10, &day(-1)).await;
    a.call(
        "stats.record",
        json!({"ref": movie, "title": "Black Harbour", "posterUrl": "http://img/a.jpg", "seconds": 30, "day": day(0)}),
    )
    .await;
    a.record(movie.clone(), "  Black Harbor (2019) ", 45, &day(0))
        .await;
    let s = a.summary(7).await;
    let top = &s["topTitles"];
    assert_eq!(top.as_array().unwrap().len(), 1);
    assert_eq!(top[0]["seconds"], 85);
    assert_eq!(
        top[0]["title"], "Black Harbor (2019)",
        "the title of the latest record"
    );
    assert_eq!(
        top[0]["posterUrl"], "http://img/a.jpg",
        "a record without a poster keeps the stored one"
    );
    assert_eq!(top[0]["sourceName"], "Alpha");
    assert_eq!(top[0]["ref"], movie);

    // A row never holds more than a day.
    for _ in 0..300 {
        a.record(rf("s2", "live", "1"), "News", 300, &day(0)).await;
    }
    let s = a.summary(7).await;
    assert_eq!(s["topChannels"][0]["seconds"], MAX_DAY_SECONDS);
}

#[tokio::test]
async fn summary_zero_fills_exactly_the_range_ending_today() {
    let a = app().await;
    a.record(rf("s1", "live", "7"), "BBC One", 120, &day(0))
        .await;
    a.record(rf("s1", "movie", "201"), "Black Harbor", 60, &day(0))
        .await;
    a.record(rf("s2", "series", "5"), "Dark", 30, &day(-2))
        .await;
    a.record(rf("s1", "radio", "9"), "Jazz FM", 15, &day(-2))
        .await;
    a.insert(&day(-6), "s1", "live", "7", "BBC One", 600).await;
    a.insert(&day(-7), "s1", "live", "7", "BBC One", 1000).await;
    a.insert(&day(-29), "s1", "movie", "201", "Black Harbor", 2000)
        .await;
    a.insert(&day(-30), "s1", "movie", "201", "Black Harbor", 4000)
        .await;
    // A day after `today` (another time zone ahead) is outside the range.
    a.insert(&day(1), "s1", "live", "7", "BBC One", 7).await;

    let week = a.summary(7).await;
    let days = week["days"].as_array().unwrap();
    assert_eq!(days.len(), 7);
    let names: Vec<&str> = days.iter().map(|d| d["day"].as_str().unwrap()).collect();
    let expected: Vec<String> = (-6..=0).map(day).collect();
    assert_eq!(names, expected, "oldest first, ending at today");
    assert_eq!(
        days[6],
        json!({"day": day(0), "seconds": 180, "liveSeconds": 120, "vodSeconds": 60})
    );
    assert_eq!(
        days[4],
        json!({"day": day(-2), "seconds": 45, "liveSeconds": 15, "vodSeconds": 30}),
        "radio counts as live, series as VOD"
    );
    assert_eq!(days[0]["liveSeconds"], 600);
    assert_eq!(
        days[1],
        json!({"day": day(-5), "seconds": 0, "liveSeconds": 0, "vodSeconds": 0})
    );
    assert_eq!(week["totalSeconds"], 180 + 45 + 600);
    for d in days {
        assert_eq!(
            d["seconds"].as_i64().unwrap(),
            d["liveSeconds"].as_i64().unwrap() + d["vodSeconds"].as_i64().unwrap()
        );
    }

    let month = a.summary(30).await;
    let days = month["days"].as_array().unwrap();
    assert_eq!(days.len(), 30);
    assert_eq!(days[0]["day"], day(-29));
    assert_eq!(days[0]["vodSeconds"], 2000);
    assert_eq!(days[29]["day"], day(0));
    assert_eq!(month["totalSeconds"], 180 + 45 + 600 + 1000 + 2000);

    // `today` is the client's date: a summary for another day ends there.
    let past = a
        .call("stats.summary", json!({"days": 7, "today": day(-7)}))
        .await;
    assert_eq!(
        past["days"][6],
        json!({"day": day(-7), "seconds": 1000, "liveSeconds": 1000, "vodSeconds": 0})
    );

    // An empty log still answers every day.
    a.call("stats.clear", Value::Null).await;
    let empty = a.summary(30).await;
    assert_eq!(empty["days"].as_array().unwrap().len(), 30);
    assert_eq!(empty["totalSeconds"], 0);
    assert_eq!(empty["topChannels"], json!([]));
    assert_eq!(empty["topTitles"], json!([]));
}

#[tokio::test]
async fn summary_validates_days_today_and_top() {
    let a = app().await;
    for bad in [
        json!({"days": 0, "today": day(0)}),
        json!({"days": 14, "today": day(0)}),
        json!({"days": 31, "today": day(0)}),
        json!({"days": 7, "today": "2026-02-30"}),
        json!({"days": 7, "today": "today"}),
        json!({"days": 7}),
        json!({"days": 7, "today": day(0), "top": 0}),
        json!({"days": 7, "today": day(0), "top": TOP_MAX + 1}),
        Value::Null,
    ] {
        assert_eq!(
            a.fail("stats.summary", bad.clone()).await,
            RpcErrorCode::Invalid,
            "{bad}"
        );
    }
    a.call(
        "stats.summary",
        json!({"days": 30, "today": day(0), "top": TOP_MAX}),
    )
    .await;
}

#[tokio::test]
async fn top_lists_split_channels_from_titles_and_order_by_time_then_title() {
    let a = app().await;
    a.record(rf("s1", "live", "7"), "BBC One", 100, &day(0))
        .await;
    a.record(rf("s1", "live", "7"), "BBC One", 100, &day(-1))
        .await;
    a.record(rf("s2", "live", "1"), "alpha news", 50, &day(0))
        .await;
    a.record(rf("s2", "radio", "2"), "Zeta FM", 300, &day(0))
        .await;
    a.record(rf("s1", "live", "3"), "Beta TV", 50, &day(0))
        .await;
    a.record(rf("s1", "movie", "201"), "Black Harbor", 40, &day(0))
        .await;
    a.record(rf("s2", "series", "5"), "Dark", 90, &day(-1))
        .await;
    a.record(rf("s2", "movie", "6"), "Arrival", 40, &day(0))
        .await;
    // Outside the 7-day range: does not count towards the week.
    a.insert(&day(-8), "s1", "movie", "201", "Black Harbor", 5000)
        .await;

    let s = a.summary(7).await;
    assert_eq!(
        titles(&s["topChannels"]),
        ["Zeta FM", "BBC One", "alpha news", "Beta TV"],
        "seconds desc, then title (case-insensitive)"
    );
    assert_eq!(s["topChannels"][1]["seconds"], 200, "summed across days");
    assert_eq!(titles(&s["topTitles"]), ["Dark", "Arrival", "Black Harbor"]);
    assert_eq!(s["topChannels"][2]["sourceName"], "Beta");

    // The catalog fills a missing poster: the logo for a channel, the poster
    // for a movie. An item the catalog does not know has none.
    assert_eq!(s["topChannels"][1]["posterUrl"], "http://img/bbc.png");
    assert_eq!(s["topTitles"][2]["posterUrl"], "http://img/201.jpg");
    assert!(s["topTitles"][0].get("posterUrl").is_none());

    let s = a
        .call(
            "stats.summary",
            json!({"days": 7, "today": day(0), "top": 2}),
        )
        .await;
    assert_eq!(titles(&s["topChannels"]), ["Zeta FM", "BBC One"]);
    assert_eq!(titles(&s["topTitles"]), ["Dark", "Arrival"]);

    let s = a.summary(30).await;
    assert_eq!(titles(&s["topTitles"])[0], "Black Harbor");
}

#[tokio::test]
async fn parental_hide_mode_leaves_locked_items_out_of_the_top_lists() {
    let a = app().await;
    a.record(rf("s1", "live", "7"), "BBC One", 100, &day(0))
        .await;
    a.record(rf("s1", "live", "8"), "Other", 50, &day(0)).await;
    a.record(rf("s1", "movie", "201"), "Black Harbor", 40, &day(0))
        .await;
    a.call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "live", "kind": "category", "targetId": "10", "name": "News"}, "locked": true}),
    )
    .await;
    a.call(
        "parental.setLocked",
        json!({"target": {"sourceId": "s1", "contentType": "movie", "kind": "item", "targetId": "201", "name": "Black Harbor"}, "locked": true}),
    )
    .await;
    a.call("parental.setPin", json!({"newPin": "2468"})).await;

    let s = a.summary(7).await;
    assert_eq!(titles(&s["topChannels"]), ["Other"], "category lock");
    assert_eq!(s["topTitles"], json!([]), "item lock");
    assert_eq!(
        s["totalSeconds"], 190,
        "the totals still count every second"
    );

    a.call("parental.unlock", json!({"pin": "2468"})).await;
    let s = a.summary(7).await;
    assert_eq!(titles(&s["topChannels"]), ["BBC One", "Other"]);
    assert_eq!(titles(&s["topTitles"]), ["Black Harbor"]);
}

#[tokio::test]
async fn the_first_record_of_a_day_prunes_rows_past_ninety_days() {
    let a = app().await;
    a.insert(&day(-91), "s1", "live", "7", "BBC One", 10).await;
    a.insert(&day(-90), "s1", "live", "7", "BBC One", 20).await;
    a.insert(&day(-120), "s2", "movie", "1", "Old", 30).await;
    a.record(rf("s1", "live", "7"), "BBC One", 5, &day(0)).await;
    assert_eq!(a.rows().await, 2, "day -90 stays, older rows go");

    // Later records the same day do not prune again (rows written behind
    // the record path's back stay until tomorrow or the next init).
    a.insert(&day(-95), "s1", "live", "7", "BBC One", 10).await;
    a.record(rf("s1", "live", "7"), "BBC One", 5, &day(0)).await;
    assert_eq!(a.rows().await, 3);

    // Init prunes too.
    iptv_core::stats::init(a.state.clone()).await.unwrap();
    assert_eq!(a.rows().await, 2);

    // A rejected record neither writes nor prunes.
    let fresh = app().await;
    fresh
        .insert(&day(-100), "s1", "live", "7", "BBC One", 10)
        .await;
    assert_eq!(
        fresh
            .fail(
                "stats.record",
                json!({"ref": rf("s1", "live", "7"), "title": "BBC", "seconds": 0, "day": day(0)})
            )
            .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(fresh.rows().await, 1);
}

#[tokio::test]
async fn clear_and_source_removal_delete_rows() {
    let a = app().await;
    a.record(rf("s1", "live", "7"), "BBC One", 5, &day(0)).await;
    a.record(rf("s2", "movie", "1"), "Heat", 5, &day(0)).await;
    a.call("sources.remove", json!({"id": "s1"})).await;
    let s = a.summary(7).await;
    assert_eq!(s["totalSeconds"], 5);
    assert_eq!(titles(&s["topTitles"]), ["Heat"]);
    assert_eq!(a.rows().await, 1, "the cascade removed s1's rows");

    a.call("stats.clear", json!({})).await;
    assert_eq!(a.rows().await, 0);
    a.call("stats.clear", Value::Null).await;
}

fn backup_row(
    day: &str,
    ct: ContentType,
    id: &str,
    title: &str,
    seconds: i64,
    last_at: &str,
) -> WatchLogBackup {
    WatchLogBackup {
        day: day.into(),
        content_type: ct,
        item_id: id.into(),
        title: title.into(),
        poster_url: None,
        seconds,
        last_at: last_at.into(),
    }
}

#[tokio::test]
async fn backup_round_trip_is_idempotent_and_keeps_the_larger_count() {
    let a = app().await;
    a.call(
        "stats.record",
        json!({"ref": rf("s1", "live", "7"), "title": "BBC One", "posterUrl": "http://logo", "seconds": 120, "day": day(0)}),
    )
    .await;
    a.record(rf("s1", "movie", "201"), "Black Harbor", 60, &day(-1))
        .await;
    a.record(rf("s2", "movie", "1"), "Heat", 30, &day(0)).await;

    let exported = a.state.db_call(|c| export_log(c, "s1")).await.unwrap();
    assert_eq!(exported.len(), 2, "only the source's rows");
    assert_eq!(exported[0].day, day(-1), "by day");
    assert_eq!(exported[1].poster_url.as_deref(), Some("http://logo"));
    assert!(exported[1].last_at.ends_with('Z'));

    // Into a fresh install under a new source id.
    let b = app().await;
    let rows = exported.clone();
    let n = b
        .state
        .db_call(move |c| import_log(c, "s2", &rows))
        .await
        .unwrap();
    assert_eq!(n, 2);
    let rows = exported.clone();
    let again = b
        .state
        .db_call(move |c| import_log(c, "s2", &rows))
        .await
        .unwrap();
    assert_eq!(again, 0, "a re-import changes nothing");
    let back = b.state.db_call(|c| export_log(c, "s2")).await.unwrap();
    assert_eq!(back, exported);
    let s = b.summary(7).await;
    assert_eq!(s["totalSeconds"], 180);
    assert_eq!(s["topChannels"][0]["ref"], rf("s2", "live", "7"));

    // Merging keeps the larger count per key; the later snapshot names it.
    let newer = "2999-01-01T00:00:00.000Z";
    let rows = vec![
        backup_row(&day(0), ContentType::Live, "7", "BBC One HD", 90, newer),
        backup_row(
            &day(-1),
            ContentType::Movie,
            "201",
            "Renamed",
            600,
            "2000-01-01T00:00:00Z",
        ),
    ];
    let n = b
        .state
        .db_call(move |c| import_log(c, "s2", &rows))
        .await
        .unwrap();
    assert_eq!(n, 2);
    let back = b.state.db_call(|c| export_log(c, "s2")).await.unwrap();
    assert_eq!(
        (back[0].seconds, back[0].title.as_str()),
        (600, "Black Harbor")
    );
    assert_eq!(
        (back[1].seconds, back[1].title.as_str()),
        (120, "BBC One HD")
    );
    assert_eq!(
        back[1].poster_url.as_deref(),
        Some("http://logo"),
        "filled from the stored row"
    );
}

#[tokio::test]
async fn import_skips_rows_it_cannot_store() {
    let a = app().await;
    let ts = "2026-10-01T00:00:00Z";
    let old = fmt_day(
        utc_today()
            .checked_sub_days(Days::new(200))
            .unwrap_or(NaiveDate::MIN),
    );
    let rows = vec![
        backup_row("2026-1-1", ContentType::Live, "7", "Bad day", 10, ts),
        backup_row(&old, ContentType::Live, "7", "Too old", 10, ts),
        backup_row(&day(0), ContentType::Live, " ", "No id", 10, ts),
        backup_row(&day(0), ContentType::Live, "7", "  ", 10, ts),
        backup_row(&day(0), ContentType::Live, "7", "Zero", 0, ts),
        backup_row(
            &day(0),
            ContentType::Movie,
            "9",
            "Huge",
            10_000_000,
            "not a date",
        ),
        backup_row(&day(-1), ContentType::Radio, "3", &"t".repeat(400), 10, ts),
    ];
    let n = a
        .state
        .db_call(move |c| import_log(c, "s1", &rows))
        .await
        .unwrap();
    assert_eq!(n, 2);
    let back = a.state.db_call(|c| export_log(c, "s1")).await.unwrap();
    assert_eq!(back[0].title.chars().count(), 300, "titles are cut");
    assert_eq!(back[1].seconds, MAX_DAY_SECONDS, "seconds are capped");
    assert!(
        back[1].last_at.starts_with('2'),
        "an unreadable lastAt becomes now"
    );

    let rows = vec![backup_row(&day(0), ContentType::Live, "7", "BBC", 10, ts)];
    let err = a
        .state
        .db_call(move |c| import_log(c, "missing", &rows))
        .await
        .unwrap_err();
    assert_eq!(err.code(), RpcErrorCode::NotFound);
    let none = a
        .state
        .db_call(|c| import_log(c, "missing", &[]))
        .await
        .unwrap();
    assert_eq!(none, 0, "nothing to import is not an error");
}
