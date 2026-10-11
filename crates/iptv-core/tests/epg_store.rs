//! EPG ingestion into SQLite, resolution, queries and every `epg.*` RPC,
//! using local XMLTV files (no network).

use iptv_core::epg::{self, store};
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppEvent, AppState, BroadcastSink, RpcErrorCode};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

const SRC: &str = "src-1";

struct Env {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    state: Arc<AppState>,
    events: Receiver<AppEvent>,
    router: RpcRouter,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let (sink, events) = BroadcastSink::channel(4096);
    let state = AppState::new(dir.join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    let mut router = RpcRouter::new();
    epg::rpc::register(&mut router);
    state
        .db_call(|c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, position, config_json, epg_json) VALUES (?1, 'm3u', 'Test', 0, ?2, ?3)",
                rusqlite::params![
                    SRC,
                    r#"{"origin":"text","headers":{"userAgent":"UA-Test"}}"#,
                    r#"{"detectedUrls":[],"manualUrls":[],"disabledUrls":[]}"#
                ],
            )?;
            let items: &[(&str, &str, Option<&str>)] = &[
                ("i-exact", "Whatever Name", Some("one.uk")),
                ("i-case", "Something", Some("ONE.UK")),
                ("i-name", "UK: Channel Two FHD", None),
                ("i-fuzzy", "Channel Threee", None),
                ("i-undeclared", "Ghost", Some("ghost.xx")),
                ("i-none", "Nothing Matches Here", Some("missing.id")),
            ];
            for (i, (id, title, epg)) in items.iter().enumerate() {
                c.execute(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id, position)
                     VALUES (?1, 'live', ?2, 'g', ?3, ?4, ?5)",
                    rusqlite::params![SRC, id, title, epg, i as i64],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    Env {
        _tmp: tmp,
        dir,
        state,
        events,
        router,
    }
}

fn r(id: &str) -> ItemRef {
    ItemRef::new(SRC, ContentType::Live, id)
}

fn xmltv_ts(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .format("%Y%m%d%H%M%S +0000")
        .to_string()
}

/// A feed with channels one.uk, two.uk, three.uk (declared) and ghost.xx
/// (programmes only); 30-minute slots from 3 h ago to 6 h ahead, titled
/// `<prefix> <channel> <slot>`.
fn write_feed(path: &Path, prefix: &str) -> i64 {
    let now = chrono::Utc::now().timestamp();
    let base = now - now % 1800 - 3 * 3600;
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n");
    for (id, name) in [
        ("one.uk", "Channel One"),
        ("two.uk", "Channel Two HD"),
        ("three.uk", "Channel Three"),
    ] {
        xml.push_str(&format!(
            "<channel id=\"{id}\"><display-name>{name}</display-name><icon src=\"http://logo/{id}.png\"/></channel>\n"
        ));
    }
    for ch in ["one.uk", "two.uk", "three.uk", "ghost.xx"] {
        for slot in 0..18 {
            let s = base + slot * 1800;
            xml.push_str(&format!(
                "<programme start=\"{}\" stop=\"{}\" channel=\"{ch}\"><title>{prefix} {ch} {slot}</title><desc>About {slot}</desc><category>Cat</category></programme>\n",
                xmltv_ts(s),
                xmltv_ts(s + 1800)
            ));
        }
    }
    xml.push_str("</tv>\n");
    std::fs::write(path, xml).unwrap();
    base
}

impl Env {
    fn feed_path(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }

    fn set_settings_urls(&self, urls: &[&str]) {
        self.state.settings.write().epg_urls = urls.iter().map(|s| s.to_string()).collect();
    }

    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {e:?}"))
    }

    async fn call_err(&self, cmd: &str, args: Value) -> iptv_core::RpcError {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .expect_err("expected an error")
    }

    async fn now_title(&self, id: &str) -> Option<String> {
        let v = self.call("epg.nowNext", json!({"refs": [r(id)]})).await;
        v[r(id).key()]["now"]["title"].as_str().map(str::to_string)
    }

    /// Waits for an `epg.progress` event of `url` with a terminal phase.
    async fn wait_done(&mut self, url: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let ev = tokio::time::timeout_at(deadline, self.events.recv())
                .await
                .expect("timed out waiting for epg.progress")
                .expect("event channel");
            if ev.kind == "epg.progress"
                && ev.payload["url"] == url
                && matches!(ev.payload["phase"].as_str(), Some("done" | "error"))
            {
                return ev.payload;
            }
        }
    }
}

#[tokio::test]
async fn registers_exactly_the_c4_commands() {
    let e = env().await;
    let mut expected = vec![
        "epg.sources",
        "epg.refresh",
        "epg.nowNext",
        "epg.programs",
        "epg.grid",
        "epg.channelsSearch",
        "epg.setMapping",
        "epg.clearMapping",
        "epg.resolve",
        "epg.setEnabled",
        "epg.clearAll",
    ];
    expected.sort_unstable();
    assert_eq!(e.router.names(), expected);
}

#[tokio::test]
async fn ingest_resolve_and_query() {
    let e = env().await;
    let url = e.feed_path("guide.xml");
    let base = write_feed(Path::new(&url), "v1");
    e.set_settings_urls(&[&url]);

    let stats = epg::refresh_now(e.state.clone(), &url).await.unwrap();
    assert_eq!(stats.channels, 3);
    assert_eq!(stats.programs, 72);

    let sources = e.call("epg.sources", Value::Null).await;
    assert_eq!(sources[0]["url"], url);
    assert_eq!(sources[0]["status"], "ok");
    assert_eq!(sources[0]["programCount"], 72);
    assert_eq!(sources[0]["channelCount"], 3);
    assert_eq!(sources[0]["origin"], "settings");
    assert_eq!(sources[0]["enabled"], true);
    assert!(sources[0]["lastFetchAt"].is_string());

    // Resolution order and via.
    let via = |v: &Value| {
        (
            v["via"].as_str().unwrap().to_string(),
            v["epgChannelId"].as_str().map(str::to_string),
        )
    };
    let res = e.call("epg.resolve", json!({"ref": r("i-exact")})).await;
    assert_eq!(via(&res), ("item".into(), Some("one.uk".into())));
    let res = e.call("epg.resolve", json!({"ref": r("i-case")})).await;
    assert_eq!(via(&res), ("item".into(), Some("one.uk".into())));
    let res = e.call("epg.resolve", json!({"ref": r("i-name")})).await;
    assert_eq!(via(&res), ("name".into(), Some("two.uk".into())));
    let res = e.call("epg.resolve", json!({"ref": r("i-fuzzy")})).await;
    assert_eq!(via(&res), ("name".into(), Some("three.uk".into())));
    let res = e
        .call("epg.resolve", json!({"ref": r("i-undeclared")}))
        .await;
    assert_eq!(via(&res), ("item".into(), Some("ghost.xx".into())));
    let res = e.call("epg.resolve", json!({"ref": r("i-none")})).await;
    assert_eq!(via(&res), ("none".into(), None));
    let res = e
        .call("epg.resolve", json!({"ref": r("does-not-exist")}))
        .await;
    assert_eq!(via(&res), ("none".into(), None));

    // now/next: slot 6 is "now" (base = now rounded down to 30 min - 3 h).
    let refs = vec![r("i-exact"), r("i-name"), r("i-none")];
    let nn = e.call("epg.nowNext", json!({"refs": refs})).await;
    assert_eq!(nn[r("i-exact").key()]["now"]["title"], "v1 one.uk 6");
    assert_eq!(nn[r("i-exact").key()]["next"]["title"], "v1 one.uk 7");
    assert_eq!(nn[r("i-exact").key()]["now"]["channelId"], "one.uk");
    assert_eq!(nn[r("i-exact").key()]["now"]["description"], "About 6");
    assert_eq!(nn[r("i-exact").key()]["now"]["category"], "Cat");
    assert_eq!(nn[r("i-name").key()]["now"]["title"], "v1 two.uk 6");
    assert_eq!(nn[r("i-none").key()], json!({}));
    let now_start = nn[r("i-exact").key()]["now"]["start"].as_str().unwrap();
    assert_eq!(now_start, epg::query::to_rfc3339(base + 6 * 1800));
    assert!(now_start.ends_with('Z'));

    // programs: range [slot 2 + 10 min, slot 5) overlaps slots 2, 3, 4.
    let from = epg::query::to_rfc3339(base + 2 * 1800 + 600);
    let to = epg::query::to_rfc3339(base + 5 * 1800);
    let progs = e
        .call(
            "epg.programs",
            json!({"ref": r("i-exact"), "from": from, "to": to}),
        )
        .await;
    let titles: Vec<_> = progs
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(titles, vec!["v1 one.uk 2", "v1 one.uk 3", "v1 one.uk 4"]);

    // grid: per ref, unresolvable refs get [].
    let grid = e
        .call(
            "epg.grid",
            json!({"refs": [r("i-exact"), r("i-fuzzy"), r("i-none")], "from": from, "to": to}),
        )
        .await;
    assert_eq!(grid[r("i-exact").key()].as_array().unwrap().len(), 3);
    assert_eq!(grid[r("i-fuzzy").key()][0]["title"], "v1 three.uk 2");
    assert_eq!(grid[r("i-none").key()], json!([]));

    // Bad ranges are Invalid.
    let err = e
        .call_err(
            "epg.programs",
            json!({"ref": r("i-exact"), "from": to, "to": from}),
        )
        .await;
    assert_eq!(err.code, RpcErrorCode::Invalid);
    let err = e
        .call_err(
            "epg.grid",
            json!({"refs": [], "from": "yesterday", "to": to}),
        )
        .await;
    assert_eq!(err.code, RpcErrorCode::Invalid);

    // channelsSearch: name-prefix matches first, then id matches, shorter names first.
    let hits = e
        .call("epg.channelsSearch", json!({"query": "channel t"}))
        .await;
    let names: Vec<_> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["displayName"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["Channel Three", "Channel Two HD"]);
    assert_eq!(hits[0]["channelId"], "three.uk");
    assert_eq!(hits[0]["icon"], "http://logo/three.uk.png");
    let hits = e
        .call("epg.channelsSearch", json!({"query": "two.u"}))
        .await;
    assert_eq!(
        hits[0]["displayName"], "Channel Two HD",
        "id matches count too"
    );
    assert_eq!(hits[0]["epgUrl"], url);
    let hits = e
        .call("epg.channelsSearch", json!({"query": "uk", "limit": 2}))
        .await;
    assert_eq!(hits.as_array().unwrap().len(), 2);
    let hits = e
        .call("epg.channelsSearch", json!({"query": "100%_"}))
        .await;
    assert_eq!(hits, json!([]));
}

#[tokio::test]
async fn manual_mapping_overrides_and_clears() {
    let e = env().await;
    let url = e.feed_path("guide.xml");
    write_feed(Path::new(&url), "m");
    e.set_settings_urls(&[&url]);
    epg::refresh_now(e.state.clone(), &url).await.unwrap();

    assert_eq!(e.now_title("i-exact").await.as_deref(), Some("m one.uk 6"));
    e.call(
        "epg.setMapping",
        json!({"ref": r("i-exact"), "epgChannelId": "three.uk"}),
    )
    .await;
    let res = e.call("epg.resolve", json!({"ref": r("i-exact")})).await;
    assert_eq!(res, json!({"epgChannelId": "three.uk", "via": "manual"}));
    assert_eq!(
        e.now_title("i-exact").await.as_deref(),
        Some("m three.uk 6")
    );

    // NULL = explicitly unmapped.
    e.call(
        "epg.setMapping",
        json!({"ref": r("i-exact"), "epgChannelId": null}),
    )
    .await;
    let res = e.call("epg.resolve", json!({"ref": r("i-exact")})).await;
    assert_eq!(res, json!({"via": "manual"}));
    assert_eq!(e.now_title("i-exact").await, None);

    e.call("epg.clearMapping", json!({"ref": r("i-exact")}))
        .await;
    let res = e.call("epg.resolve", json!({"ref": r("i-exact")})).await;
    assert_eq!(res["via"], "item");

    // Unknown source.
    let err = e
        .call_err(
            "epg.setMapping",
            json!({"ref": ItemRef::new("nope", ContentType::Live, "x"), "epgChannelId": "one.uk"}),
        )
        .await;
    assert_eq!(err.code, RpcErrorCode::NotFound);
}

#[tokio::test]
async fn reimport_swaps_atomically_and_failure_keeps_old_data() {
    let e = env().await;
    let url = e.feed_path("guide.xml");
    write_feed(Path::new(&url), "old");
    e.set_settings_urls(&[&url]);
    epg::refresh_now(e.state.clone(), &url).await.unwrap();
    assert_eq!(
        e.now_title("i-exact").await.as_deref(),
        Some("old one.uk 6")
    );

    write_feed(Path::new(&url), "new");
    let stats = epg::refresh_now(e.state.clone(), &url).await.unwrap();
    assert_eq!(stats.programs, 72);
    assert_eq!(
        e.now_title("i-exact").await.as_deref(),
        Some("new one.uk 6")
    );
    let total: i64 = e
        .state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(total, 72, "old rows replaced, not appended");

    // A broken feed fails, records the error, and keeps the previous data.
    std::fs::write(&url, "<html>oops</html>").unwrap();
    let err = epg::refresh_now(e.state.clone(), &url).await.unwrap_err();
    assert!(matches!(err, iptv_core::CoreError::Invalid(_)), "{err}");
    let sources = e.call("epg.sources", Value::Null).await;
    assert_eq!(sources[0]["status"], "error");
    assert!(sources[0]["error"].as_str().unwrap().contains("XMLTV"));
    assert_eq!(sources[0]["programCount"], 72);
    assert_eq!(
        e.now_title("i-exact").await.as_deref(),
        Some("new one.uk 6")
    );
    let staged: i64 = e
        .state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM epg_sources WHERE origin = 'staging'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(staged, 0);

    // A missing file is NotFound with a next step.
    std::fs::remove_file(&url).unwrap();
    let err = epg::refresh_now(e.state.clone(), &url).await.unwrap_err();
    assert!(matches!(err, iptv_core::CoreError::NotFound(_)));
}

#[tokio::test]
async fn sources_merge_settings_and_source_links() {
    let e = env().await;
    e.state
        .db_call(|c| {
            c.execute(
                "UPDATE sources SET epg_json = ?1 WHERE id = ?2",
                rusqlite::params![
                    r#"{"detectedUrls":["http://a/epg.xml","http://dup/epg.xml"," http://b/epg.xml.gz "],"manualUrls":["http://c/epg.xml","http://disabled/x.xml"],"disabledUrls":["http://disabled/x.xml","http://b/epg.xml.gz"]}"#,
                    SRC
                ],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    e.set_settings_urls(&["http://dup/epg.xml", "  ", "http://s/epg.xml"]);
    let list = e.call("epg.sources", Value::Null).await;
    let rows: Vec<(String, String, Option<String>)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["url"].as_str().unwrap().to_string(),
                v["origin"].as_str().unwrap().to_string(),
                v["sourceId"].as_str().map(str::to_string),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("http://dup/epg.xml".into(), "settings".into(), None),
            ("http://s/epg.xml".into(), "settings".into(), None),
            ("http://a/epg.xml".into(), "source".into(), Some(SRC.into())),
            ("http://c/epg.xml".into(), "source".into(), Some(SRC.into())),
        ]
    );
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["status"] == "idle" && v["enabled"] == true));

    // Source headers travel with source urls.
    let cfg = e
        .state
        .db_call(|c| store::configured_urls(c, &[]))
        .await
        .unwrap();
    assert_eq!(cfg[0].headers.user_agent.as_deref(), Some("UA-Test"));

    // Refresh of an unconfigured url is NotFound.
    let err = e
        .call_err("epg.refresh", json!({"url": "http://unknown/x.xml"}))
        .await;
    assert_eq!(err.code, RpcErrorCode::NotFound);
}

#[tokio::test]
async fn set_enabled_hides_data_and_rpc_refresh_runs_in_background() {
    let mut e = env().await;
    let url = e.feed_path("guide.xml.gz");
    // Gzipped on disk to cover sniffing on the ingest path.
    {
        use std::io::Write;
        let plain = e.dir.join("plain.xml");
        write_feed(&plain, "bg");
        let mut enc = flate2::write::GzEncoder::new(
            std::fs::File::create(&url).unwrap(),
            flate2::Compression::default(),
        );
        enc.write_all(&std::fs::read(&plain).unwrap()).unwrap();
        enc.finish().unwrap();
    }
    e.set_settings_urls(&[&url]);

    // epg.refresh returns immediately; completion arrives as events.
    let v = e.call("epg.refresh", json!({"url": url})).await;
    assert!(v.is_null());
    let done = e.wait_done(&url).await;
    assert_eq!(done["phase"], "done", "{done}");
    assert_eq!(done["programs"], 72);
    assert_eq!(e.now_title("i-exact").await.as_deref(), Some("bg one.uk 6"));

    e.call("epg.setEnabled", json!({"url": url, "enabled": false}))
        .await;
    let list = e.call("epg.sources", Value::Null).await;
    assert_eq!(list[0]["enabled"], false);
    assert_eq!(e.now_title("i-exact").await, None);
    let res = e.call("epg.resolve", json!({"ref": r("i-name")})).await;
    assert_eq!(res["via"], "none", "disabled channels do not match names");
    let hits = e
        .call("epg.channelsSearch", json!({"query": "channel"}))
        .await;
    assert_eq!(hits, json!([]));

    // Refresh-all skips disabled urls.
    e.call("epg.refresh", json!({})).await;
    e.call("epg.setEnabled", json!({"url": url, "enabled": true}))
        .await;
    assert_eq!(e.now_title("i-exact").await.as_deref(), Some("bg one.uk 6"));

    let err = e
        .call_err(
            "epg.setEnabled",
            json!({"url": "http://nope/x", "enabled": true}),
        )
        .await;
    assert_eq!(err.code, RpcErrorCode::NotFound);

    // Refresh all (no url) in the background.
    e.call("epg.refresh", Value::Null).await;
    let done = e.wait_done(&url).await;
    assert_eq!(done["phase"], "done");
}

#[tokio::test]
async fn scheduler_fetches_new_urls_and_prunes_removed_ones() {
    let mut e = env().await;
    let url = e.feed_path("guide.xml");
    write_feed(Path::new(&url), "sched");
    e.set_settings_urls(&[&url]);

    // Boot path with no delay: cleanup + first pass picks up the never-fetched url.
    epg::ingest::start(e.state.clone(), Duration::ZERO)
        .await
        .unwrap();
    let done = e.wait_done(&url).await;
    assert_eq!(done["phase"], "done");
    assert_eq!(
        e.now_title("i-exact").await.as_deref(),
        Some("sched one.uk 6")
    );

    // Fresh data is not refetched.
    let started = epg::ingest::schedule_pass(e.state.clone()).await.unwrap();
    assert!(started.is_empty());

    // Removing the url prunes its data.
    e.set_settings_urls(&[]);
    epg::ingest::schedule_pass(e.state.clone()).await.unwrap();
    let rows: i64 = e
        .state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(rows, 0);
    assert_eq!(e.call("epg.sources", Value::Null).await, json!([]));
}

#[tokio::test]
async fn concurrent_refresh_of_one_url_is_rejected() {
    let e = env().await;
    let url = e.feed_path("guide.xml");
    write_feed(Path::new(&url), "c");
    e.set_settings_urls(&[&url]);
    assert!(epg::spawn_refresh(e.state.clone(), &url));
    // Same url while the first is queued or running.
    let second = epg::refresh_now(e.state.clone(), &url).await;
    assert!(matches!(second, Err(iptv_core::CoreError::Conflict(_))));
    assert!(!epg::spawn_refresh(e.state.clone(), &url));
    // Let it finish so the temp dir can be removed.
    let rt = epg::runtime(&e.state);
    for _ in 0..200 {
        if !rt.is_running(&url) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!rt.is_running(&url));
}
