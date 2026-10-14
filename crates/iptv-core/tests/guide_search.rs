//! Guide programme search (Run 2 C5, check 8): the FTS5 index and the scan
//! used before it is built, mapping hits to one source's channels, hidden
//! and parental-locked channels, the time window, the limit, the query
//! plans and the speed on 200k programmes.

use iptv_core::epg::{self, search};
use iptv_core::model::{ContentType, ParentalLockKind, ParentalLockTarget};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink, RpcErrorCode};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const SRC: &str = "src-1";
const OTHER: &str = "src-2";
const HOUR: i64 = 3600;
const CONFIG: &str = r#"{"origin":"text"}"#;
const EPG_JSON: &str = r#"{"detectedUrls":[],"manualUrls":[],"disabledUrls":[]}"#;

struct Env {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    state: Arc<AppState>,
    router: RpcRouter,
}

fn ts(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn xmltv_ts(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .format("%Y%m%d%H%M%S +0000")
        .to_string()
}

/// The next full hour: every programme of the test feed lies inside the
/// ingest window around the real clock.
fn base() -> i64 {
    let now = chrono::Utc::now().timestamp();
    now - now % HOUR + HOUR
}

async fn bare_env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let (sink, _events) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    epg::rpc::register(&mut router);
    Env {
        _tmp: tmp,
        dir,
        state,
        router,
    }
}

/// `(source, item id, title, number, epg_channel_id)`.
type Channel = (
    &'static str,
    &'static str,
    &'static str,
    Option<i64>,
    Option<&'static str>,
);

/// Two sources. `src-1` channels and how each maps to the guide:
/// - c1 "Channel One" #1: `epg_channel_id` one.uk
/// - c2 "Channel Two HD" #2: no id, exact normalised name "Channel Two"
/// - c3 "Channel Threee" #3: no id, only a similar name (never matched)
/// - c4 "Mapped" #4: manual mapping to four.uk
/// - c5 "Unnumbered" (no number): `epg_channel_id` ONE.UK (case-insensitive)
/// - c6 "Blocked" #6: id two.uk but manually unmapped
///
/// `src-2` has o1 on one.uk, which must never show in `src-1` results.
async fn env() -> Env {
    let e = bare_env().await;
    e.state
        .db_call(|c| {
            for id in [SRC, OTHER] {
                c.execute(
                    "INSERT INTO sources(id, kind, name, position, config_json, epg_json) VALUES (?1, 'm3u', ?1, 0, ?2, ?3)",
                    [id, CONFIG, EPG_JSON],
                )?;
            }
            let items: &[Channel] = &[
                (SRC, "c1", "Channel One", Some(1), Some("one.uk")),
                (SRC, "c2", "Channel Two HD", Some(2), None),
                (SRC, "c3", "Channel Threee", Some(3), None),
                (SRC, "c4", "Mapped", Some(4), None),
                (SRC, "c5", "Unnumbered", None, Some("ONE.UK")),
                (SRC, "c6", "Blocked", Some(6), Some("two.uk")),
                (OTHER, "o1", "Other One", Some(1), Some("one.uk")),
            ];
            for (i, (src, id, title, number, epg)) in items.iter().enumerate() {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, number, logo_url, epg_channel_id, position)
                     VALUES (?1, 'live', ?2, 'news', ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![src, id, title, number, format!("http://logo/{id}.png"), epg, i as i64],
                )?;
            }
            c.execute(
                "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES (?1, 'live', 'c4', 'four.uk')",
                [SRC],
            )?;
            c.execute(
                "INSERT INTO epg_channel_map(source_id, content_type, item_id, epg_channel_id) VALUES (?1, 'live', 'c6', NULL)",
                [SRC],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    e
}

/// `(channel, start offset from base in hours, title)`.
fn programmes() -> Vec<(&'static str, i64, &'static str)> {
    vec![
        ("one.uk", 0, "Café Society"),
        ("one.uk", 1, "Le Journal de 20h"),
        ("one.uk", 2, "café noir"),
        ("one.uk", 26, "Café Society"),
        ("two.uk", 0, "CAFE SOCIETY"),
        ("two.uk", 1, "Sports Tonight"),
        ("three.uk", 0, "Café Society"),
        ("four.uk", 3, "Société Générale Report"),
    ]
}

impl Env {
    fn feed_path(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }

    /// Writes the test feed and refreshes it through the normal ingest path.
    async fn ingest(&self, base: i64) -> String {
        let url = self.feed_path("guide.xml");
        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n");
        for (id, name) in [
            ("one.uk", "Channel One"),
            ("two.uk", "Channel Two"),
            ("three.uk", "Channel Three"),
            ("four.uk", "Channel Four"),
        ] {
            xml.push_str(&format!(
                "<channel id=\"{id}\"><display-name>{name}</display-name></channel>\n"
            ));
        }
        for (ch, h, title) in programmes() {
            let s = base + h * HOUR;
            xml.push_str(&format!(
                "<programme start=\"{}\" stop=\"{}\" channel=\"{ch}\"><title>{title}</title><desc>About {title}</desc><category>Talk</category></programme>\n",
                xmltv_ts(s),
                xmltv_ts(s + HOUR)
            ));
        }
        xml.push_str("</tv>\n");
        std::fs::write(&url, xml).unwrap();
        self.state.settings.write().epg_urls = vec![url.clone()];
        epg::refresh_now(self.state.clone(), &url).await.unwrap();
        url
    }

    /// The same programmes written straight into the tables, as an
    /// upgraded database holds them before its index is built.
    async fn insert_direct(&self, base: i64) {
        self.state
            .db_call(move |c| {
                c.execute(
                    "INSERT INTO epg_sources(url, enabled, origin, status) VALUES ('direct', 1, 'settings', 'ok')",
                    [],
                )?;
                for (id, name) in [
                    ("one.uk", "Channel One"),
                    ("two.uk", "Channel Two"),
                    ("three.uk", "Channel Three"),
                    ("four.uk", "Channel Four"),
                ] {
                    c.execute(
                        "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('direct', ?1, ?2)",
                        [id, name],
                    )?;
                }
                for (ch, h, title) in programmes() {
                    let s = base + h * HOUR;
                    c.execute(
                        "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description, category)
                         VALUES ('direct', ?1, ?2, ?3, ?4, ?5, 'Talk')",
                        rusqlite::params![ch, s, s + HOUR, title, format!("About {title}")],
                    )?;
                }
                Ok(())
            })
            .await
            .unwrap();
        // The generation keys the cached channel directory.
        epg::runtime(&self.state).bump();
    }

    async fn search(&self, args: Value) -> Vec<Value> {
        let v = self
            .router
            .dispatch(self.state.clone(), "epg.search", args)
            .await
            .unwrap_or_else(|e| panic!("epg.search failed: {e:?}"));
        v.as_array().expect("an array").clone()
    }

    async fn search_err(&self, args: Value) -> RpcErrorCode {
        self.router
            .dispatch(self.state.clone(), "epg.search", args)
            .await
            .expect_err("expected an error")
            .code
    }

    async fn index_ready(&self) -> bool {
        self.state
            .db_call(|c| search::index_ready(c))
            .await
            .unwrap()
    }
}

/// `(item id, start)` of each hit.
fn keys(hits: &[Value]) -> Vec<(String, String)> {
    hits.iter()
        .map(|h| {
            (
                h["ref"]["itemId"].as_str().unwrap().to_string(),
                h["program"]["start"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn k(id: &str, t: i64) -> (String, String) {
    (id.to_string(), ts(t))
}

fn window(query: &str, from: i64, to: i64) -> Value {
    json!({"sourceId": SRC, "query": query, "from": ts(from), "to": ts(to)})
}

#[tokio::test]
async fn finds_titles_with_case_and_diacritics_folded() {
    let e = env().await;
    let b = base();
    e.ingest(b).await;
    assert!(e.index_ready().await, "a refresh builds the index");

    let all = vec![
        k("c1", b),
        k("c2", b),
        k("c5", b),
        k("c1", b + 2 * HOUR),
        k("c5", b + 2 * HOUR),
        k("c1", b + 26 * HOUR),
        k("c5", b + 26 * HOUR),
    ];
    for q in ["cafe", "CAFÉ", "  Café "] {
        let hits = e.search(window(q, b - HOUR, b + 2 * 86_400)).await;
        assert_eq!(keys(&hits), all, "query {q:?}");
    }
    // Every word must start a title word.
    let hits = e.search(window("CAFÉ soc", b - HOUR, b + 2 * 86_400)).await;
    assert_eq!(
        keys(&hits),
        vec![
            k("c1", b),
            k("c2", b),
            k("c5", b),
            k("c1", b + 26 * HOUR),
            k("c5", b + 26 * HOUR)
        ]
    );
    let hits = e.search(window("societe", b - HOUR, b + 86_400)).await;
    assert_eq!(keys(&hits), vec![k("c4", b + 3 * HOUR)], "manual mapping");
    assert!(e
        .search(window("afe", b - HOUR, b + 86_400))
        .await
        .is_empty());

    // The hit carries the channel and the programme (raw guide times).
    let hits = e.search(window("journal 20h", b - HOUR, b + 86_400)).await;
    assert_eq!(hits.len(), 2);
    let h = &hits[0];
    assert_eq!(
        h["ref"],
        json!({"sourceId": SRC, "contentType": "live", "itemId": "c1"})
    );
    assert_eq!(h["channelName"], "Channel One");
    assert_eq!(h["channelNumber"], 1);
    assert_eq!(h["logoUrl"], "http://logo/c1.png");
    assert_eq!(h["categoryId"], "news");
    assert_eq!(h["program"]["channelId"], "one.uk");
    assert_eq!(h["program"]["title"], "Le Journal de 20h");
    assert_eq!(h["program"]["start"], ts(b + HOUR));
    assert_eq!(h["program"]["end"], ts(b + 2 * HOUR));
    assert_eq!(h["program"]["description"], "About Le Journal de 20h");
    assert_eq!(h["program"]["category"], "Talk");
    // No number: after the numbered channels, without the field.
    assert_eq!(hits[1]["ref"]["itemId"], "c5");
    assert!(hits[1].get("channelNumber").is_none());
}

#[tokio::test]
async fn honours_the_window_and_the_limit() {
    let e = env().await;
    let b = base();
    e.ingest(b).await;

    // Overlap: the programme on air at `from` counts; one starting at `to` does not.
    let hits = e.search(window("cafe", b + HOUR / 2, b + 2 * HOUR)).await;
    assert_eq!(keys(&hits), vec![k("c1", b), k("c2", b), k("c5", b)]);
    let hits = e.search(window("cafe", b + 90 * 60, b + 25 * HOUR)).await;
    assert_eq!(
        keys(&hits),
        vec![k("c1", b + 2 * HOUR), k("c5", b + 2 * HOUR)]
    );

    // Limit keeps the first hits in (start, channel number) order.
    let mut args = window("cafe", b - HOUR, b + 2 * 86_400);
    args["limit"] = json!(2);
    assert_eq!(
        keys(&e.search(args.clone()).await),
        vec![k("c1", b), k("c2", b)]
    );
    args["limit"] = json!(4);
    assert_eq!(
        keys(&e.search(args).await),
        vec![k("c1", b), k("c2", b), k("c5", b), k("c1", b + 2 * HOUR)]
    );

    // Defaults: from now, 14 days, 50 hits.
    let hits = e
        .search(json!({"sourceId": SRC, "query": "cafe society"}))
        .await;
    assert_eq!(hits.len(), 5);

    // The other source sees its own channel only.
    let hits = e
        .search(
            json!({"sourceId": OTHER, "query": "cafe", "from": ts(b - HOUR), "to": ts(b + 86_400)}),
        )
        .await;
    assert_eq!(keys(&hits), vec![k("o1", b), k("o1", b + 2 * HOUR)]);
}

#[tokio::test]
async fn rejects_bad_arguments() {
    let e = env().await;
    let b = base();
    for args in [
        json!({"sourceId": SRC, "query": "a"}),
        json!({"sourceId": SRC, "query": "  b  "}),
        json!({"sourceId": SRC, "query": "x".repeat(101)}),
        json!({"sourceId": SRC, "query": "news", "limit": 0}),
        json!({"sourceId": SRC, "query": "news", "limit": 201}),
        json!({"sourceId": SRC, "query": "news", "from": ts(b), "to": ts(b)}),
        json!({"sourceId": SRC, "query": "news", "from": ts(b), "to": ts(b + 16 * 86_400 + 1)}),
        json!({"sourceId": SRC, "query": "news", "from": "tomorrow"}),
    ] {
        assert_eq!(
            e.search_err(args.clone()).await,
            RpcErrorCode::Invalid,
            "{args}"
        );
    }
    assert_eq!(
        e.search_err(json!({"sourceId": "nope", "query": "news"}))
            .await,
        RpcErrorCode::NotFound
    );
    // Accepted edges: 2 and 100 characters, 16 days, 200 hits.
    for args in [
        json!({"sourceId": SRC, "query": "ab"}),
        json!({"sourceId": SRC, "query": "x".repeat(100), "limit": 200}),
        json!({"sourceId": SRC, "query": "news", "from": ts(b), "to": ts(b + 16 * 86_400)}),
    ] {
        e.search(args).await;
    }
}

#[tokio::test]
async fn hidden_renamed_and_locked_channels() {
    let e = env().await;
    let b = base();
    e.ingest(b).await;
    let range = window("cafe society", b - HOUR, b + HOUR);
    assert_eq!(
        keys(&e.search(range.clone()).await),
        vec![k("c1", b), k("c2", b), k("c5", b)]
    );

    // C2 channel edits: c2 hidden, c1 renamed.
    e.state
        .db_call(|c| {
            for (item, hidden, name) in [("c2", 1, None), ("c1", 0, Some("My One"))] {
                c.execute(
                    "INSERT INTO channel_edits(source_id, content_type, item_id, hidden, name, original_name, updated_at)
                     VALUES (?1, 'live', ?2, ?3, ?4, 'x', '2026-10-14T10:00:00.000Z')",
                    rusqlite::params![SRC, item, hidden, name],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let hits = e.search(range.clone()).await;
    assert_eq!(keys(&hits), vec![k("c1", b), k("c5", b)]);
    assert_eq!(hits[0]["channelName"], "My One");

    // Parental hide mode: a locked channel drops out while locked.
    iptv_core::parental::set_pin(&e.state, None, "2468")
        .await
        .unwrap();
    let target = ParentalLockTarget {
        source_id: SRC.into(),
        content_type: ContentType::Live,
        kind: ParentalLockKind::Item,
        target_id: "c5".into(),
        name: "Unnumbered".into(),
    };
    iptv_core::parental::set_locked(&e.state, &target, true, Some("2468"))
        .await
        .unwrap();
    assert_eq!(keys(&e.search(range.clone()).await), vec![k("c1", b)]);
    iptv_core::parental::unlock(&e.state, "2468").await.unwrap();
    assert_eq!(keys(&e.search(range).await), vec![k("c1", b), k("c5", b)]);
}

#[tokio::test]
async fn scans_before_the_index_is_built_with_the_same_results() {
    let e = env().await;
    let b = base();
    // Programmes present, index never built (an upgraded database).
    e.insert_direct(b).await;
    assert!(!e.index_ready().await);
    let queries = [
        window("cafe", b - HOUR, b + 2 * 86_400),
        window("CAFÉ soc", b - HOUR, b + 2 * 86_400),
        window("societe", b - HOUR, b + 86_400),
        window("journal", b - HOUR, b + 86_400),
        window("cafe", b + 90 * 60, b + 25 * HOUR),
        json!({"sourceId": SRC, "query": "cafe", "from": ts(b - HOUR), "to": ts(b + 2 * 86_400), "limit": 2}),
    ];
    let mut scanned = Vec::new();
    for q in &queries {
        scanned.push(e.search(q.clone()).await);
    }
    assert_eq!(
        keys(&scanned[0]),
        vec![
            k("c1", b),
            k("c2", b),
            k("c5", b),
            k("c1", b + 2 * HOUR),
            k("c5", b + 2 * HOUR),
            k("c1", b + 26 * HOUR),
            k("c5", b + 26 * HOUR),
        ]
    );
    assert_eq!(keys(&scanned[5]), vec![k("c1", b), k("c2", b)]);
    assert_eq!(
        scanned[2][0]["program"]["description"],
        "About Société Générale Report"
    );

    // The startup build indexes them; results do not change.
    search::spawn_startup_build(&e.state);
    let deadline = Instant::now() + Duration::from_secs(20);
    while !e.index_ready().await {
        assert!(Instant::now() < deadline, "startup build did not finish");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for (q, before) in queries.iter().zip(&scanned) {
        assert_eq!(&e.search(q.clone()).await, before, "{q}");
    }
}

#[tokio::test]
async fn index_follows_refresh_clear_and_staging() {
    let e = env().await;
    let b = base();
    // An empty guide: the startup build has nothing to do.
    search::spawn_startup_build(&e.state);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!e.index_ready().await);

    let url = e.ingest(b).await;
    assert!(e.index_ready().await);
    let range = window("cafe", b - HOUR, b + 2 * 86_400);
    assert_eq!(e.search(range.clone()).await.len(), 7);

    // A second refresh with other titles: old titles gone, new ones found.
    let xml = format!(
        "<?xml version=\"1.0\"?><tv><channel id=\"one.uk\"><display-name>Channel One</display-name></channel>\
         <programme start=\"{}\" stop=\"{}\" channel=\"one.uk\"><title>Brand New Show</title></programme></tv>",
        xmltv_ts(b),
        xmltv_ts(b + HOUR)
    );
    std::fs::write(&url, xml).unwrap();
    epg::refresh_now(e.state.clone(), &url).await.unwrap();
    assert!(e.index_ready().await);
    assert!(e.search(range.clone()).await.is_empty());
    assert_eq!(
        keys(&e.search(window("brand new", b - HOUR, b + HOUR)).await),
        vec![k("c1", b), k("c5", b)]
    );

    // A failed import discards its staging rows: the index is rebuilt.
    std::fs::write(&url, "this is not xml").unwrap();
    let _ = epg::refresh_now(e.state.clone(), &url).await;
    assert!(e.index_ready().await);
    assert_eq!(
        e.search(window("brand new", b - HOUR, b + HOUR))
            .await
            .len(),
        2
    );

    // epg.clearAll empties the guide and leaves a matching (empty) index.
    e.router
        .dispatch(e.state.clone(), "epg.clearAll", Value::Null)
        .await
        .unwrap();
    assert!(e.index_ready().await);
    assert!(e
        .search(window("brand new", b - HOUR, b + HOUR))
        .await
        .is_empty());
}

/// The index test of `db/mod.rs` covers the grid statements; these are the
/// two search statements: the FTS match drives the index path (each hit
/// reads its programme by rowid), and the scan walks the `stop` index.
#[tokio::test]
async fn search_statements_use_indexes() {
    let e = bare_env().await;
    let plans = e
        .state
        .db_call(|c| {
            let mut out = Vec::new();
            for sql in [search::FTS_SQL, search::SCAN_SQL] {
                let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let args = vec![rusqlite::types::Null; stmt.parameter_count()];
                let plan: Vec<String> = stmt
                    .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))?
                    .collect::<Result<_, _>>()?;
                out.push(plan);
            }
            Ok(out)
        })
        .await
        .unwrap();
    let fts = &plans[0];
    assert!(
        fts.iter()
            .any(|d| d.starts_with("SCAN f VIRTUAL TABLE INDEX")),
        "{fts:?}"
    );
    let p: Vec<&String> = fts.iter().filter(|d| d.contains(" p ")).collect();
    assert!(!p.is_empty(), "{fts:?}");
    for d in p {
        assert!(
            d.starts_with("SEARCH p USING INTEGER PRIMARY KEY"),
            "{fts:?}"
        );
    }
    let scan = &plans[1];
    let p: Vec<&String> = scan.iter().filter(|d| d.contains(" p ")).collect();
    assert!(!p.is_empty(), "{scan:?}");
    for d in p {
        assert!(
            d.starts_with("SEARCH p USING INDEX idx_epg_programs_stop"),
            "{scan:?}"
        );
    }
}

/// 1,000 channels x 200 half-hour programmes. Release builds must answer a
/// common and a rare query in under 150 ms each.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn searches_200k_programmes_quickly() {
    const CHANNELS: i64 = 1_000;
    const PER_CHANNEL: i64 = 200;
    const WORDS: [&str; 24] = [
        "news", "world", "sport", "kitchen", "garden", "travel", "music", "movie", "comedy",
        "drama", "history", "science", "nature", "football", "tennis", "weather", "market",
        "morning", "evening", "night", "live", "classic", "family", "quiz",
    ];
    let e = bare_env().await;
    let now = chrono::Utc::now().timestamp();
    let start = now - now % 1800 - 6 * HOUR;
    let setup = Instant::now();
    e.state
        .db_call(move |c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO sources(id, kind, name, position, config_json, epg_json) VALUES (?1, 'm3u', 'Perf', 0, ?2, ?3)",
                [SRC, CONFIG, EPG_JSON],
            )?;
            tx.execute(
                "INSERT INTO epg_sources(url, enabled, origin, status) VALUES ('perf', 1, 'settings', 'ok')",
                [],
            )?;
            {
                let mut item = tx.prepare(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, number, epg_channel_id, position)
                     VALUES (?1, 'live', ?2, 'cat', ?3, ?4, ?5, ?4)",
                )?;
                let mut chan = tx.prepare(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('perf', ?1, ?2)",
                )?;
                let mut prog = tx.prepare(
                    "INSERT INTO epg_programs(epg_url, channel_id, start, stop, title, description)
                     VALUES ('perf', ?1, ?2, ?3, ?4, 'Programme description text')",
                )?;
                for ch in 0..CHANNELS {
                    let id = format!("ch{ch}.tv");
                    item.execute(rusqlite::params![SRC, format!("i{ch}"), format!("Channel {ch}"), ch + 1, id])?;
                    chan.execute(rusqlite::params![id, format!("Channel {ch}")])?;
                    for n in 0..PER_CHANNEL {
                        let s = start + n * 1800;
                        let i = (ch * PER_CHANNEL + n) as usize;
                        let title = if i % 70_000 == 7 {
                            "Zebra Crossing Special".to_string()
                        } else {
                            format!(
                                "{} {} {}",
                                WORDS[i % WORDS.len()],
                                WORDS[(i / 7) % WORDS.len()],
                                n % 13
                            )
                        };
                        prog.execute(rusqlite::params![id, s, s + 1800, title])?;
                    }
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .unwrap();
    let insert_ms = setup.elapsed().as_millis();
    let build = Instant::now();
    assert!(e
        .state
        .db_call(|c| search::ensure_index(c, true))
        .await
        .unwrap());
    let build_ms = build.elapsed().as_millis();

    let mut timings = Vec::new();
    for (query, want) in [
        ("news", 50usize),
        ("zebra cross", 3),
        ("world kitchen", 50),
        ("Évening quiz", 50),
    ] {
        let args = json!({"sourceId": SRC, "query": query, "from": ts(start), "to": ts(start + 5 * 86_400)});
        // Warm the channel directory and the statement cache once.
        e.search(args.clone()).await;
        let t = Instant::now();
        let hits = e.search(args).await;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(hits.len(), want, "{query}");
        let starts: Vec<&str> = hits
            .iter()
            .map(|h| h["program"]["start"].as_str().unwrap())
            .collect();
        assert!(
            starts.windows(2).all(|w| w[0] <= w[1]),
            "{query}: ordered by start"
        );
        timings.push((query, ms));
    }
    // The scan before the index exists: slower, still bounded.
    e.state
        .db_call(|c| search::invalidate_index(c))
        .await
        .unwrap();
    let t = Instant::now();
    let scanned = e
        .search(json!({"sourceId": SRC, "query": "news", "from": ts(start), "to": ts(start + 5 * 86_400)}))
        .await;
    let scan_ms = t.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(scanned.len(), 50);
    println!(
        "guide_search perf: {} programmes inserted in {insert_ms} ms, index built in {build_ms} ms; searches {timings:?} ms; scan {scan_ms:.1} ms",
        CHANNELS * PER_CHANNEL
    );
    #[cfg(not(debug_assertions))]
    for (query, ms) in &timings {
        assert!(*ms < 150.0, "{query} took {ms:.1} ms (limit 150 ms)");
    }
}
