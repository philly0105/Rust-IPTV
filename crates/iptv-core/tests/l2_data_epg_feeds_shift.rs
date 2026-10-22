//! Loop 2 (core-data, EPG):
//! - L1-core-10: overlapping guide feeds preserve the first feed's schedule
//!   without creating sliver programmes. Other feeds can fill uncovered hours.
//! - L1-core-11: a channel's `tvg-shift` moves its programmes in
//!   `epg.grid`, `epg.nowNext` and `epg.programs`.
//! - L1-core-12: fuzzy name matching keeps sibling channels apart.

use iptv_core::epg;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

const FULL: &str = "http://guide.example/full.xml";
const FEED_B: &str = "http://guide.example/feedB.xml";
const H: i64 = 3600;
const M: i64 = 60;

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    /// Start of 'noon' (and of 'B News').
    base: i64,
}

/// full.xml (added first): morning [base-1h, base), noon [base, base+1h),
/// one [base+1h, base+3h). feedB.xml: 'B News' [base, base+58m),
/// 'B Film' [base+58m, base+3h+2m). Items `s|live|<id>` all show cnn.us;
/// item 2 has tvg-shift "1", item 3 "-1.5", item 4 "+0,5", item 5 junk.
async fn setup() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(16);
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    // "Now" is half way through 'noon'.
    let base = chrono::Utc::now().timestamp() - 30 * M;
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
                [],
            )?;
            for (id, extra) in [
                ("1", "{}"),
                ("2", r#"{"tvgShift":"1"}"#),
                ("3", r#"{"tvgShift":"-1.5"}"#),
                ("4", r#"{"tvgShift":"+0,5"}"#),
                ("5", r#"{"tvgShift":"soon"}"#),
            ] {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, extra_json)
                     VALUES ('s', 'live', ?1, 'c', ?2, 'cnn.us', ?3)",
                    params![id, format!("CNN {id}"), extra],
                )?;
            }
            for url in [FULL, FEED_B] {
                c.execute(
                    "INSERT INTO epg_sources(url, origin, status) VALUES (?1, 'settings', 'ok')",
                    [url],
                )?;
                c.execute(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES (?1, 'cnn.us', 'CNN')",
                    [url],
                )?;
            }
            for (url, start, stop, title) in [
                (FULL, base - H, base, "morning"),
                (FULL, base, base + H, "noon"),
                (FULL, base + H, base + 3 * H, "one"),
                (FEED_B, base, base + 58 * M, "B News"),
                (FEED_B, base + 58 * M, base + 3 * H + 2 * M, "B Film"),
            ] {
                c.execute(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, 'cnn.us', ?2, ?3, ?4)",
                    params![url, start, stop, title],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    epg::rpc::register(&mut router);
    Env {
        _tmp: tmp,
        state,
        router,
        base,
    }
}

fn item(id: &str) -> Value {
    json!({ "sourceId": "s", "contentType": "live", "itemId": id })
}

fn ts(t: i64) -> String {
    epg::query::to_rfc3339(t)
}

impl Env {
    async fn call(&self, method: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), method, args)
            .await
            .unwrap()
    }

    async fn grid(&self, ids: &[&str], from: i64, to: i64) -> Value {
        let refs: Vec<Value> = ids.iter().map(|i| item(i)).collect();
        self.call(
            "epg.grid",
            json!({ "refs": refs, "from": ts(from), "to": ts(to) }),
        )
        .await
    }

    async fn sql(&self, sql: &'static str) {
        self.state
            .db_call(move |c| {
                c.execute(sql, [])?;
                Ok(())
            })
            .await
            .unwrap();
    }
}

/// (title, start, end) of a programme list.
fn slots(list: &Value) -> Vec<(String, String, String)> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["title"].as_str().unwrap().to_string(),
                p["start"].as_str().unwrap().to_string(),
                p["end"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn slot(title: &str, start: i64, end: i64) -> (String, String, String) {
    (title.to_string(), ts(start), ts(end))
}

#[tokio::test]
async fn rolling_grid_windows_keep_programmes_when_feeds_cover_different_days() {
    let env = setup().await;
    let day = epg::query::parse_time("2026-10-23T00:00:00Z", "day").unwrap();
    env.state.db_call(move |c| {
        c.execute("DELETE FROM epg_programs", [])?;
        // The first feed starts tomorrow morning. The other feed has tonight's guide.
        // Moving the wide query six hours used to switch feeds and erase all evening tiles.
        for (url, start, stop, title) in [
            (FULL, day + 32 * H, day + 33 * H, "Tomorrow"),
            (FEED_B, day + 18 * H, day + 19 * H, "Evening news"),
            (FEED_B, day + 19 * H, day + 21 * H, "Evening film"),
        ] {
            c.execute(
                "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title) VALUES (?1, 'cnn.us', ?2, ?3, ?4)",
                params![url, start, stop, title],
            )?;
        }
        Ok(())
    }).await.unwrap();
    let want = vec![
        slot("Evening news", day + 18 * H, day + 19 * H),
        slot("Evening film", day + 19 * H, day + 21 * H),
    ];
    // Both rolling 24-hour windows, the small visible query, and a return to the first window.
    for (from, to) in [(6, 30), (12, 36), (15, 24), (6, 30)] {
        let grid = env
            .call(
                "epg.grid",
                json!({
                    "refs": [item("1"), item("2")],
                    "from": ts(day + from * H), "to": ts(day + to * H),
                    "withDescription": false,
                }),
            )
            .await;
        let evening: Vec<_> = slots(&grid["s|live|1"])
            .into_iter()
            .filter(|(_, start, end)| start < &ts(day + 21 * H) && end > &ts(day + 18 * H))
            .collect();
        assert_eq!(evening, want, "query hours {from}..{to}");
        assert!(slots(&grid["s|live|2"]).contains(&slot(
            "Evening news",
            day + 19 * H,
            day + 20 * H
        )));
    }
}

#[tokio::test]
async fn two_feeds_for_one_channel_are_not_mixed() {
    let env = setup().await;
    let b = env.base;
    let want = vec![slot("noon", b, b + H), slot("one", b + H, b + 3 * H)];

    // Probe: the grid was "noon (to 12:58) | B Film (12:58-13:00) | one".
    let grid = env.grid(&["1"], b, b + 3 * H).await;
    assert_eq!(slots(&grid["s|live|1"]), want);
    let list = env
        .call(
            "epg.programs",
            json!({ "ref": item("1"), "from": ts(b), "to": ts(b + 3 * H) }),
        )
        .await;
    assert_eq!(slots(&list), want);
    let nn = env
        .call("epg.nowNext", json!({ "refs": [item("1")] }))
        .await;
    let nn = &nn["s|live|1"];
    assert_eq!(nn["now"]["title"], "noon");
    assert_eq!(nn["now"]["end"], ts(b + H), "not clipped at B Film's start");
    assert_eq!(nn["next"]["title"], "one");

    // A range only feedB covers (full.xml ends at base+3h) reads feedB.
    let grid = env.grid(&["1"], b + 3 * H, b + 4 * H).await;
    assert_eq!(
        slots(&grid["s|live|1"]),
        vec![slot("B Film", b + 58 * M, b + 3 * H + 2 * M)]
    );

    // With full.xml disabled, feedB alone, uncut.
    env.sql("UPDATE epg_sources SET enabled = 0 WHERE url = 'http://guide.example/full.xml'")
        .await;
    let grid = env.grid(&["1"], b, b + 3 * H).await;
    assert_eq!(
        slots(&grid["s|live|1"]),
        vec![
            slot("B News", b, b + 58 * M),
            slot("B Film", b + 58 * M, b + 3 * H + 2 * M)
        ]
    );
}

#[tokio::test]
async fn tvg_shift_moves_grid_now_next_and_programs() {
    let env = setup().await;
    let b = env.base;

    // +1 h: 'morning' (guide base-1h..base) airs now.
    let grid = env.grid(&["1", "2"], b, b + 3 * H).await;
    assert_eq!(
        slots(&grid["s|live|2"]),
        vec![
            slot("morning", b, b + H),
            slot("noon", b + H, b + 2 * H),
            slot("one", b + 2 * H, b + 4 * H)
        ]
    );
    // The unshifted item sharing the channel is not affected by the cache.
    assert_eq!(slots(&grid["s|live|1"])[0], slot("noon", b, b + H));
    let list = env
        .call(
            "epg.programs",
            json!({ "ref": item("2"), "from": ts(b), "to": ts(b + H) }),
        )
        .await;
    assert_eq!(slots(&list), vec![slot("morning", b, b + H)]);

    let refs: Vec<Value> = ["1", "2", "3", "4", "5"].iter().map(|i| item(i)).collect();
    let nn = env.call("epg.nowNext", json!({ "refs": refs })).await;
    let now_of = |id: &str| nn[format!("s|live|{id}")]["now"]["title"].clone();
    assert_eq!(now_of("1"), "noon");
    assert_eq!(now_of("2"), "morning");
    assert_eq!(nn["s|live|2"]["now"]["start"], ts(b));
    assert_eq!(nn["s|live|2"]["next"]["title"], "noon");
    assert_eq!(nn["s|live|2"]["next"]["start"], ts(b + H));
    // -1.5 h: now is guide time base+2h, inside 'one' (shown 1.5 h earlier).
    assert_eq!(now_of("3"), "one");
    assert_eq!(nn["s|live|3"]["now"]["start"], ts(b + H - 90 * M));
    // "+0,5" reads as half an hour: 'noon' is shown [base+30m, base+90m).
    assert_eq!(now_of("4"), "noon");
    assert_eq!(nn["s|live|4"]["now"]["start"], ts(b + 30 * M));
    // An unusable value is no shift.
    assert_eq!(now_of("5"), "noon");

    // The global display offset still composes with the channel shift:
    // +60 min reads the guide an hour earlier again.
    let nn = env
        .call(
            "epg.nowNext",
            json!({ "refs": [item("2")], "offsetMinutes": 60 }),
        )
        .await;
    assert!(nn["s|live|2"]["now"].is_null(), "{nn}");
    assert_eq!(nn["s|live|2"]["next"]["title"], "morning");
}

#[test]
fn shift_values() {
    use epg::query::parse_shift;
    assert_eq!(parse_shift("1"), 3600);
    assert_eq!(parse_shift(" +2 "), 7200);
    assert_eq!(parse_shift("-1.5"), -5400);
    assert_eq!(parse_shift("0,5"), 1800);
    assert_eq!(parse_shift("25"), 0);
    assert_eq!(parse_shift("NaN"), 0);
    assert_eq!(parse_shift(""), 0);
}

/// L1-core-12 through `epg.resolve`: the item names differ from the guide
/// only in the channel number or timeshift.
#[tokio::test]
async fn name_resolution_keeps_siblings_apart() {
    let env = setup().await;
    env.sql(
        "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES
         ('http://guide.example/full.xml', 'ss2.uk', 'Sky Sports 2'),
         ('http://guide.example/full.xml', 'b1p2.uk', 'BBC One +2')",
    )
    .await;
    env.sql(
        "INSERT INTO items(source_id, content_type, item_id, category_id, title) VALUES
         ('s', 'live', 'ss1', 'c', 'Sky Sports 1'),
         ('s', 'live', 'ss2', 'c', 'Sky Sport 2'),
         ('s', 'live', 'b1p1', 'c', 'BBC One +1')",
    )
    .await;
    let resolve = |id: &'static str| {
        let env = &env;
        async move { env.call("epg.resolve", json!({ "ref": item(id) })).await }
    };
    assert_eq!(resolve("ss1").await["via"], "none");
    assert_eq!(resolve("b1p1").await["via"], "none");
    let r = resolve("ss2").await;
    assert_eq!(r["via"], "name");
    assert_eq!(r["epgChannelId"], "ss2.uk");
}
