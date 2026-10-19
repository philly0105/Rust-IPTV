//! Loop 1 (core-import): user state survives a stream-token rotation, an
//! empty playlist never wipes a catalog, and a parser change re-imports an
//! unchanged playlist once.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::sources;
use rusqlite::params;
use sha2::{Digest, Sha256};
use support::*;

fn playlist(token: &str) -> String {
    let mut s = String::from("#EXTM3U\n");
    for i in 0..5 {
        s.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"ch{i}.example\" group-title=\"News\",Channel {i}\nhttp://s.example/live/user/{token}/{i}.ts\n"
        ));
    }
    // Two channels without tvg-id: matched on group + title.
    for i in 0..2 {
        s.push_str(&format!(
            "#EXTINF:-1 group-title=\"Sport\",Sport {i}\nhttp://s.example/live/user/{token}/s{i}.ts\n"
        ));
    }
    s
}

async fn item_id(env: &Env, source_id: &str, title: &str) -> String {
    let (sid, title) = (source_id.to_string(), title.to_string());
    env.state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT item_id FROM items WHERE source_id = ?1 AND title = ?2",
                params![sid, title],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
}

async fn refs(env: &Env, table: &'static str, source_id: &str) -> Vec<String> {
    let sid = source_id.to_string();
    env.state
        .db_call(move |c| {
            let mut st = c.prepare(&format!(
                "SELECT item_id FROM {table} WHERE source_id = ?1 ORDER BY item_id"
            ))?;
            let rows = st
                .query_map(params![sid], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

async fn exec(env: &Env, sql: &'static str, a: String, b: String) {
    env.state
        .db_call(move |c| {
            c.execute(sql, params![a, b])?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn rotated_stream_tokens_keep_favorites_recents_and_positions() {
    let env = env().await;
    let stub = stub(&playlist("tok1")).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 7);

    let ch1 = item_id(&env, &src.id, "Channel 1").await;
    let sp0 = item_id(&env, &src.id, "Sport 0").await;
    exec(
        &env,
        "INSERT INTO favorites (source_id, content_type, item_id, snapshot_json) VALUES (?1, 'live', ?2, '{}')",
        src.id.clone(),
        ch1.clone(),
    )
    .await;
    exec(
        &env,
        "INSERT INTO favorites (source_id, content_type, item_id, snapshot_json) VALUES (?1, 'live', ?2, '{}')",
        src.id.clone(),
        sp0.clone(),
    )
    .await;
    exec(
        &env,
        "INSERT INTO recent (source_id, content_type, item_id, snapshot_json) VALUES (?1, 'live', ?2, '{}')",
        src.id.clone(),
        ch1.clone(),
    )
    .await;
    exec(
        &env,
        "INSERT INTO playback_positions (source_id, content_type, item_id, position_seconds) VALUES (?1, 'live', ?2, 42)",
        src.id.clone(),
        sp0.clone(),
    )
    .await;

    // The provider rotates the token in every stream URL: every item id changes.
    stub.set_body(&playlist("tok2"));
    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(again.channel_count, 7);
    let new_ch1 = item_id(&env, &src.id, "Channel 1").await;
    let new_sp0 = item_id(&env, &src.id, "Sport 0").await;
    assert_ne!(new_ch1, ch1, "the item id is derived from the stream URL");
    assert_ne!(new_sp0, sp0);

    let mut want_favs = vec![new_ch1.clone(), new_sp0.clone()];
    want_favs.sort();
    assert_eq!(refs(&env, "favorites", &src.id).await, want_favs);
    assert_eq!(refs(&env, "recent", &src.id).await, vec![new_ch1]);
    assert_eq!(
        refs(&env, "playback_positions", &src.id).await,
        vec![new_sp0]
    );
}

/// IN-5: the remapper keeps only referenced identities. A successor that
/// is not unique (two new rows with the identity) still leaves the
/// reference alone, and an unreferenced row never moves anything.
#[tokio::test]
async fn ambiguous_successors_leave_references_alone() {
    let env = env().await;
    let stub = stub(&playlist("tok1")).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let ch2 = item_id(&env, &src.id, "Channel 2").await;
    let sp1 = item_id(&env, &src.id, "Sport 1").await;
    for id in [&ch2, &sp1] {
        exec(
            &env,
            "INSERT INTO favorites (source_id, content_type, item_id, snapshot_json) VALUES (?1, 'live', ?2, '{}')",
            src.id.clone(),
            id.clone(),
        )
        .await;
    }

    // "Sport 1" comes back twice under new URLs: two successors.
    let mut body = playlist("tok2");
    body.push_str("#EXTINF:-1 group-title=\"Sport\",Sport 1\nhttp://s.example/live/user/tok2/s1b.ts\n");
    stub.set_body(&body);
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    let new_ch2 = item_id(&env, &src.id, "Channel 2").await;
    let mut want = vec![new_ch2, sp1];
    want.sort();
    assert_eq!(refs(&env, "favorites", &src.id).await, want);
}

/// ST-3: a URL refresh sends the last body's ETag, and a 304 keeps the
/// catalog without a download; a new ETag brings the new body.
#[tokio::test]
async fn not_modified_playlist_keeps_the_catalog() {
    let env = env().await;
    let stub = stub(&playlist("tok1")).await;
    stub.set_etag(Some("\"v1\""));
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 7);
    let ch1 = item_id(&env, &src.id, "Channel 1").await;

    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(stub.not_modified(), 1, "the ETag was not sent");
    assert_eq!(again.channel_count, 7);
    assert_eq!(item_id(&env, &src.id, "Channel 1").await, ch1);

    // A changed playlist under a new ETag is downloaded and imported.
    stub.set_body(&playlist("tok2"));
    stub.set_etag(Some("\"v2\""));
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(stub.not_modified(), 1);
    assert_ne!(item_id(&env, &src.id, "Channel 1").await, ch1);

    // The server stops sending validators: the stored ones go, so the next
    // refresh asks without them and gets the body.
    stub.set_etag(None);
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    stub.set_etag(Some("\"v2\""));
    let hits = stub.hits();
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(stub.hits(), hits + 1);
    assert_eq!(stub.not_modified(), 1, "stale validators were sent");
}

#[tokio::test]
async fn empty_playlist_keeps_the_previous_catalog() {
    let env = env().await;
    let stub = stub(&playlist("tok1")).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.channel_count, 7);

    // The provider answers with a bare header (expired account, outage).
    stub.set_body("#EXTM3U\n");
    let err = sources::refresh(env.state.clone(), &src.id)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("kept the previous channels"),
        "{err}"
    );
    let after = sources::get(&env.state, &src.id).await.unwrap();
    assert_eq!(after.channel_count, 7);
    assert!(after.last_error.is_some());

    // Adding a source whose playlist has no channels fails up front.
    let empty = support::stub("#EXTM3U\n").await;
    let err = sources::add(env.state.clone(), url_args(&empty.url(), false))
        .await
        .map_err(|e| e.error)
        .unwrap_err();
    assert!(err.to_string().contains("no channels"), "{err}");
}

#[tokio::test]
async fn unchanged_playlist_from_an_older_importer_is_imported_again() {
    let env = env().await;
    let body = playlist("tok1");
    let stub = stub(&body).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();

    // Mark the catalog so a rebuild is visible.
    exec(
        &env,
        "UPDATE items SET title = 'Edited' WHERE source_id = ?1 AND title = ?2",
        src.id.clone(),
        "Channel 0".into(),
    )
    .await;

    // Same body, same importer: the unchanged shortcut keeps the catalog.
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert!(!item_id(&env, &src.id, "Edited").await.is_empty());

    // Same body, but the stored sha came from an older importer (plain sha256).
    let plain = hex::encode(Sha256::digest(body.as_bytes()));
    exec(
        &env,
        "UPDATE m3u_raw SET sha256 = ?2 WHERE source_id = ?1",
        src.id.clone(),
        plain,
    )
    .await;
    sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert!(!item_id(&env, &src.id, "Channel 0").await.is_empty());
}

/// `import.progress` phases (and messages) of one source, in order.
fn phases(
    events: &[iptv_core::events::AppEvent],
    source_id: &str,
) -> Vec<(String, Option<String>)> {
    events
        .iter()
        .filter(|ev| ev.kind == "import.progress" && ev.payload["sourceId"] == source_id)
        .map(|ev| {
            (
                ev.payload["phase"].as_str().unwrap_or_default().to_string(),
                ev.payload["message"].as_str().map(str::to_string),
            )
        })
        .collect()
}

fn changed_count(events: &[iptv_core::events::AppEvent]) -> usize {
    events
        .iter()
        .filter(|ev| ev.kind == "sources.changed")
        .count()
}

/// L1-sources-home-10 / L1-perf-3: every run opens with `connecting`, and a
/// refresh that finds the playlist unchanged ends with `done` + "unchanged"
/// and sends no `sources.changed`, so other clients keep their catalog queries.
#[tokio::test]
async fn runs_start_with_connecting_and_unchanged_refreshes_say_so() {
    let mut env = env().await;
    let stub = stub(&playlist("tok1")).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), true))
        .await
        .map_err(|e| e.error)
        .unwrap();
    let added = drain(&mut env.events);
    let first = phases(&added, &src.id);
    assert_eq!(
        first.first().map(|p| p.0.as_str()),
        Some("connecting"),
        "{first:?}"
    );
    assert_eq!(first.last(), Some(&("done".to_string(), None)), "{first:?}");

    // Same body: the catalog is kept and the run says so.
    let (_, summary) = sources::run_import(env.state.clone(), &src.id)
        .await
        .unwrap();
    assert!(summary.unchanged);
    assert_eq!(summary.channels, 7);
    let same = drain(&mut env.events);
    let ph = phases(&same, &src.id);
    assert_eq!(
        ph.first().map(|p| p.0.as_str()),
        Some("connecting"),
        "{ph:?}"
    );
    assert_eq!(
        ph.last(),
        Some(&("done".to_string(), Some("unchanged".to_string()))),
        "{ph:?}"
    );
    assert_eq!(
        changed_count(&same),
        0,
        "an unchanged refresh sends no sources.changed"
    );

    // A new body: a real import, `done` without a message, and sources.changed.
    stub.set_body(&playlist("tok2"));
    let (_, summary) = sources::run_import(env.state.clone(), &src.id)
        .await
        .unwrap();
    assert!(!summary.unchanged);
    let changed = drain(&mut env.events);
    let ph = phases(&changed, &src.id);
    assert_eq!(
        ph.first().map(|p| p.0.as_str()),
        Some("connecting"),
        "{ph:?}"
    );
    assert_eq!(ph.last(), Some(&("done".to_string(), None)), "{ph:?}");
    assert_eq!(changed_count(&changed), 1);
    // The flag stays out of the wire format unless set.
    assert!(serde_json::to_value(summary)
        .unwrap()
        .get("unchanged")
        .is_none());
}
