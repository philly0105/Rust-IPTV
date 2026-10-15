//! m3u import (B1): text/file/URL origins, sha256 skip, failed refresh keeps
//! the catalog, progress events, `m3u.raw` / `m3u.parsePreview` rpc.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::sources;
use serde_json::json;
use support::*;

#[tokio::test]
async fn text_import_classifies_and_counts() {
    let env = env().await;
    let text = "#EXTM3U x-tvg-url=\"http://e/g.xml\"\n\
        #EXTINF:-1 tvg-id=\"a\" group-title=\"News\",Alpha\nhttp://h/a.ts\n\
        #EXTINF:-1 radio=\"true\" group-title=\"Radio\",Beta FM\nhttp://h/b.mp3\n\
        #EXTINF:-1 group-title=\"Movies\",Heat (1995)\nhttp://h/heat.mkv\n\
        #EXTINF:-1 group-title=\"News\",Alpha\nhttp://h/a.ts\n";
    let src = add_text(&env.state, "T", text).await;
    assert_eq!(
        src.channel_count, 2,
        "live only, duplicate kept with a distinct id"
    );
    assert_eq!(src.radio_count, 1);
    assert_eq!(src.movie_count, 1);
    assert!(src.last_refresh_at.is_some());
    assert!(src.last_error.is_none());
    assert_eq!(src.epg.detected_urls, vec!["http://e/g.xml"]);

    let r = router();
    let movies = r
        .dispatch(
            env.state.clone(),
            "catalog.movies",
            json!({"sourceId": src.id}),
        )
        .await
        .unwrap();
    assert_eq!(movies["items"][0]["titleBase"], "Heat");
    assert_eq!(movies["items"][0]["year"], 1995);
    let radio = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": src.id, "radio": true}),
        )
        .await
        .unwrap();
    assert_eq!(radio["total"], 1);
    assert_eq!(radio["items"][0]["isRadio"], true);
}

#[tokio::test]
async fn invalid_text_fails_and_keeps_source_with_last_error() {
    let env = env().await;
    let err = sources::add(
        env.state.clone(),
        text_args("Bad", "just some words\nmore words\n"),
    )
    .await
    .unwrap_err();
    let id = err.source_id.clone().expect("source kept");
    let rpc_err = iptv_core::RpcError::from(err);
    assert_eq!(rpc_err.details.unwrap()["sourceId"], id.as_str());
    let src = sources::get(&env.state, &id).await.unwrap();
    assert!(src.last_error.is_some());
    assert!(src.last_refresh_at.is_none());
}

#[tokio::test]
async fn file_import_and_progress_events() {
    let mut env = env().await;
    let path = env.dir.path().join("big.m3u");
    std::fs::write(&path, gen_m3u(5_000, 10)).unwrap();
    let src = sources::add(env.state.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    // L1-sources-home-6: default names drop the playlist extension, as the UI does.
    assert_eq!(src.name, "big");
    assert_eq!(src.channel_count, 5_000);
    let events = drain(&mut env.events);
    let progress: Vec<_> = events
        .iter()
        .filter(|e| e.kind == "import.progress")
        .collect();
    assert!(progress.len() >= 3, "progress every 2000 items plus done");
    assert_eq!(progress.last().unwrap().payload["phase"], "done");
    assert!(events.iter().any(|e| e.kind == "sources.changed"));
    let cats = router()
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({"sourceId": src.id, "contentType": "live"}),
        )
        .await
        .unwrap();
    let cats = cats.as_array().unwrap();
    assert_eq!(cats.len(), 10);
    assert_eq!(
        cats.iter()
            .map(|c| c["itemCount"].as_i64().unwrap())
            .sum::<i64>(),
        5_000
    );
}

#[tokio::test]
async fn url_import_sha_skip_and_failed_refresh_keeps_catalog() {
    let env = env().await;
    let stub = stub(&gen_m3u(300, 3)).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 300);
    assert_eq!(src.name, "list");
    assert_eq!(
        stub.state.last_user_agent.lock().as_deref(),
        Some("B1Test/1.0")
    );

    // Hide a category, refresh with the same body: sha unchanged, nothing rebuilt.
    let r = router();
    let cats = r
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({"sourceId": src.id, "contentType": "live"}),
        )
        .await
        .unwrap();
    let cat_id = cats[0]["id"].as_str().unwrap().to_string();
    r.dispatch(
        env.state.clone(),
        "catalog.setCategoryHidden",
        json!({"sourceId": src.id, "contentType": "live", "categoryId": cat_id, "hidden": true}),
    )
    .await
    .unwrap();
    let hits = stub.hits();
    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(again.channel_count, 300);
    assert_eq!(stub.hits(), hits + 1);

    // Changed body: rebuilt, hidden flag preserved.
    stub.set_body(&gen_m3u(450, 3));
    let changed = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(changed.channel_count, 450);
    let cats = r
        .dispatch(
            env.state.clone(),
            "catalog.categories",
            json!({"sourceId": src.id, "contentType": "live", "includeHidden": true}),
        )
        .await
        .unwrap();
    let hidden = cats
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == cat_id.as_str())
        .unwrap();
    assert_eq!(hidden["hidden"], true);
    let visible = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": src.id, "query": {"limit": 1}}),
        )
        .await
        .unwrap();
    assert_eq!(
        visible["total"], 300,
        "hidden category excluded from listing"
    );

    // Failure: previous catalog kept, lastError set.
    stub.set_fail(true);
    assert!(sources::refresh(env.state.clone(), &src.id).await.is_err());
    let after = sources::get(&env.state, &src.id).await.unwrap();
    assert_eq!(after.channel_count, 450);
    assert!(after.last_error.is_some());
    let page = r
        .dispatch(
            env.state.clone(),
            "catalog.channels",
            json!({"sourceId": src.id, "includeHidden": true, "query": {"limit": 1}}),
        )
        .await
        .unwrap();
    assert_eq!(page["total"], 450);

    // Recovery clears lastError.
    stub.set_fail(false);
    let ok = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert!(ok.last_error.is_none());

    // No temp files left behind.
    let tmp = env.dir.path().join("tmp");
    if tmp.exists() {
        assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn raw_and_preview_rpc() {
    let env = env().await;
    let text = "#EXTM3U\n#EXTINF:-1 group-title=\"G\",One\nhttp://h/1\n";
    let src = add_text(&env.state, "T", text).await;
    let r = router();
    let raw = r
        .dispatch(env.state.clone(), "m3u.raw", json!({"sourceId": src.id}))
        .await
        .unwrap();
    assert_eq!(raw["text"], text);
    assert_eq!(raw["sha256"].as_str().unwrap().len(), 64);
    let missing = r
        .dispatch(env.state.clone(), "m3u.raw", json!({"sourceId": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(missing.code, iptv_core::RpcErrorCode::NotFound);
    let p = r
        .dispatch(
            env.state.clone(),
            "m3u.parsePreview",
            json!({"text": gen_m3u(20, 4)}),
        )
        .await
        .unwrap();
    assert_eq!(p["channelCount"], 20);
    assert_eq!(p["groups"].as_array().unwrap().len(), 4);
    assert_eq!(p["epgUrls"][0], "http://epg.example/guide.xml");
}
