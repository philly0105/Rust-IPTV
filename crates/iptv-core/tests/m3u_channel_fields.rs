//! B1-fix3: per-channel headers and catch-up on channel rows, live/radio
//! numbering and `channelByNumber` with `contentType`, CR-only line endings,
//! large playlists kept out of `m3u_raw`, and `sources.removeAll`.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::m3u::{importer::RAW_INLINE_MAX, M3uReader};
use serde_json::{json, Value};
use support::*;

async fn channels(env: &Env, source_id: &str, radio: bool) -> Vec<Value> {
    let page = router()
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": source_id, "radio": radio}),
        )
        .await
        .unwrap();
    page["items"].as_array().unwrap().clone()
}

fn by_name<'a>(items: &'a [Value], name: &str) -> &'a Value {
    items
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("{name} missing"))
}

#[tokio::test]
async fn channel_rows_expose_headers_and_catchup() {
    let env = env().await;
    let text = "#EXTM3U\n\
        #EXTINF:-1 group-title=\"A\",Vlc\n\
        #EXTVLCOPT:http-user-agent=VLC/3.0\n\
        #EXTVLCOPT:http-referrer=http://ref.example/\n\
        http://h/vlc.ts\n\
        #EXTINF:-1 group-title=\"A\",Pipe\n\
        http://h/pipe.ts|User-Agent=Pipe/1&Origin=http://o.example\n\
        #EXTINF:-1 catchup=\"Default\" catchup-days=\"3\" catchup-source=\"http://h/arc?s={utc}\" group-title=\"A\",Arc\n\
        http://h/arc.ts\n\
        #EXTINF:-1 catchup=\"shift\" group-title=\"A\",Shift\n\
        http://h/shift.ts\n\
        #EXTINF:-1 catchup=\"vod\" catchup-days=\"2\" group-title=\"A\",Odd\n\
        http://h/odd.ts\n\
        #EXTINF:-1 catchup-days=\"5\" group-title=\"A\",DaysOnly\n\
        http://h/days.ts\n\
        #EXTINF:-1 group-title=\"A\",Plain\n\
        http://h/plain.ts\n";
    let src = add_text(&env.state, "T", text).await;
    let live = channels(&env, &src.id, false).await;

    let vlc = by_name(&live, "Vlc");
    assert_eq!(
        vlc["headers"],
        json!({"userAgent": "VLC/3.0", "referrer": "http://ref.example/"})
    );
    let pipe = by_name(&live, "Pipe");
    assert_eq!(pipe["url"], "http://h/pipe.ts");
    assert_eq!(
        pipe["headers"],
        json!({"userAgent": "Pipe/1", "origin": "http://o.example"})
    );

    let arc = by_name(&live, "Arc");
    assert_eq!(
        arc["catchup"],
        json!({"type": "default", "days": 3, "source": "http://h/arc?s={utc}"})
    );
    assert_eq!(
        arc["archive"],
        json!({"enabled": true, "durationHours": 72})
    );

    let shift = by_name(&live, "Shift");
    assert_eq!(shift["catchup"], json!({"type": "shift"}));
    assert_eq!(shift["archive"], json!({"enabled": true}));

    let odd = by_name(&live, "Odd");
    assert_eq!(
        odd["catchup"]["type"], "vod",
        "attributes are still exposed"
    );
    assert!(
        odd.get("archive").is_none(),
        "unknown catch-up type: no archive"
    );
    let days_only = by_name(&live, "DaysOnly");
    assert!(days_only.get("archive").is_none());
    assert!(days_only.get("catchup").is_none());

    let plain = by_name(&live, "Plain");
    assert!(plain.get("headers").is_none());
    assert!(plain.get("catchup").is_none());

    // catalog.item carries the same fields.
    let item = router()
        .dispatch(
            env.state.clone(),
            "catalog.item",
            json!({"ref": vlc["ref"]}),
        )
        .await
        .unwrap();
    assert_eq!(item["headers"]["userAgent"], "VLC/3.0");
}

#[tokio::test]
async fn live_and_radio_share_one_number_sequence() {
    let env = env().await;
    let text = "#EXTM3U\n\
        #EXTINF:-1 group-title=\"N\",Live One\nhttp://h/l1.ts\n\
        #EXTINF:-1 radio=\"true\" group-title=\"R\",Radio One\nhttp://h/r1.mp3\n\
        #EXTINF:-1 group-title=\"N\",Live Two\nhttp://h/l2.ts\n\
        #EXTINF:-1 radio=\"true\" tvg-chno=\"1\" group-title=\"R\",Radio Chno\nhttp://h/rc.mp3\n";
    let src = add_text(&env.state, "N", text).await;
    assert_eq!(src.channel_count, 2);
    assert_eq!(src.radio_count, 2);

    let live = channels(&env, &src.id, false).await;
    let radio = channels(&env, &src.id, true).await;
    assert_eq!(by_name(&live, "Live One")["number"], 1);
    assert_eq!(by_name(&radio, "Radio One")["number"], 2);
    assert_eq!(by_name(&live, "Live Two")["number"], 3);
    assert_eq!(by_name(&radio, "Radio Chno")["number"], 1, "tvg-chno wins");

    let r = router();
    let zap = |number: i64, ct: Option<&str>| {
        let mut args = json!({"sourceId": src.id, "number": number});
        if let Some(ct) = ct {
            args["contentType"] = json!(ct);
        }
        let r = &r;
        let st = env.state.clone();
        async move {
            r.dispatch(st, "catalog.channelByNumber", args)
                .await
                .unwrap()
        }
    };
    assert_eq!(zap(2, None).await["name"], "Radio One");
    assert_eq!(zap(2, Some("radio")).await["name"], "Radio One");
    assert!(zap(2, Some("live")).await.is_null());
    assert_eq!(
        zap(1, None).await["name"],
        "Live One",
        "live first by default"
    );
    assert_eq!(zap(1, Some("live")).await["name"], "Live One");
    assert_eq!(zap(1, Some("radio")).await["name"], "Radio Chno");
    let bad = r
        .dispatch(
            env.state.clone(),
            "catalog.channelByNumber",
            json!({"sourceId": src.id, "number": 1, "contentType": "movie"}),
        )
        .await;
    assert!(bad.is_err());

    let counts = r
        .dispatch(env.state.clone(), "sources.counts", json!({"id": src.id}))
        .await
        .unwrap();
    assert_eq!(counts["channelCount"], 2);
    assert_eq!(counts["radioCount"], 2);
}

#[test]
fn cr_only_and_split_crlf_line_endings() {
    let text =
        "#EXTM3U\r#EXTINF:-1 group-title=\"G\",One\rhttp://h/1.ts\r#EXTINF:-1,Two\rhttp://h/2.ts\r";
    let (entries, _, stats) = iptv_core::m3u::parse_str(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].name, "One");
    assert_eq!(entries[0].group.as_deref(), Some("G"));
    assert_eq!(entries[1].url, "http://h/2.ts");
    assert_eq!(stats.skipped, 0);

    // CRLF whose \r and \n land in different reads (1-byte buffer), mixed
    // with LF and CR-only lines, must not create phantom lines.
    let mixed = "#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://h/a.ts\n#EXTINF:-1,B\rhttp://h/b.ts\r\n";
    let reader = std::io::BufReader::with_capacity(1, mixed.as_bytes());
    let mut parser = M3uReader::new(reader);
    let got: Vec<_> = parser.by_ref().map(|e| (e.name, e.url)).collect();
    assert_eq!(
        got,
        vec![
            ("A".to_string(), "http://h/a.ts".to_string()),
            ("B".to_string(), "http://h/b.ts".to_string())
        ]
    );
    assert_eq!(parser.stats().lines, 5);
    assert_eq!(parser.stats().bytes, mixed.len() as u64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_playlists_are_not_stored_inline() {
    let env = env().await;
    let n = (RAW_INLINE_MAX as usize / 150) + 5_000;
    let body = gen_m3u(n, 20);
    assert!(body.len() as u64 > RAW_INLINE_MAX);
    let path = env.dir.path().join("big.m3u");
    std::fs::write(&path, &body).unwrap();
    let src = iptv_core::sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, n as i64);

    let sid = src.id.clone();
    let (inline_len, sha): (i64, String) = env
        .state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT length(raw), sha256 FROM m3u_raw WHERE source_id = ?1",
                [&sid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(inline_len, 0, "large playlist text is not stored inline");
    assert_eq!(sha.len(), 64);
    let cache = iptv_core::m3u::cached_playlist_path(&env.state.data_dir, &src.id);
    assert!(cache.is_file());

    // m3u.raw reads the on-disk copy, even after the user's file is gone.
    std::fs::remove_file(&path).unwrap();
    let raw = router()
        .dispatch(env.state.clone(), "m3u.raw", json!({"sourceId": src.id}))
        .await
        .unwrap();
    assert_eq!(raw["text"].as_str().unwrap().len(), body.len());
    assert_eq!(raw["sha256"], sha);

    iptv_core::sources::remove(&env.state, &src.id)
        .await
        .unwrap();
    assert!(!cache.exists(), "removing the source deletes its copy");
}

#[tokio::test]
async fn small_playlists_stay_inline() {
    let env = env().await;
    let path = env.dir.path().join("small.m3u");
    std::fs::write(&path, gen_m3u(10, 2)).unwrap();
    let src = iptv_core::sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let raw = router()
        .dispatch(env.state.clone(), "m3u.raw", json!({"sourceId": src.id}))
        .await
        .unwrap();
    assert!(raw["text"].as_str().unwrap().contains("Channel 9"));
    assert!(!iptv_core::m3u::cached_playlist_path(&env.state.data_dir, &src.id).exists());
}

#[tokio::test]
async fn remove_all_removes_every_source() {
    let mut env = env().await;
    add_text(&env.state, "A", "#EXTM3U\n#EXTINF:-1,A\nhttp://h/a.ts\n").await;
    add_text(&env.state, "B", "#EXTM3U\n#EXTINF:-1,B\nhttp://h/b.ts\n").await;
    drain(&mut env.events);
    let r = router();
    let out = r
        .dispatch(env.state.clone(), "sources.removeAll", Value::Null)
        .await
        .unwrap();
    assert!(out.is_null());
    let list = r
        .dispatch(env.state.clone(), "sources.list", Value::Null)
        .await
        .unwrap();
    assert_eq!(list, json!([]));
    let items: i64 = env
        .state
        .db_call(|c| Ok(c.query_row("SELECT count(*) FROM items", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(items, 0);
    let changed = drain(&mut env.events)
        .into_iter()
        .filter(|e| e.kind == "sources.changed")
        .count();
    assert!(changed >= 1);
    // Idempotent on an empty list.
    r.dispatch(env.state.clone(), "sources.removeAll", Value::Null)
        .await
        .unwrap();
}
