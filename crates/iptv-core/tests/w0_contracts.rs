//! dl-speed W0 contracts: `downloads::shared::resolve` on the loopback
//! Xtream mock and on M3U rows, `xtream::service::series_seasons`, the
//! source-delete cleanup of download records, `origin_json`, the pinned
//! HTTP helpers, and the three new `downloads.*` commands.

#[path = "m3u_support.rs"]
mod m3u;
#[path = "xtream_stub.rs"]
mod stub;

use iptv_core::downloads::shared::{self, Endpoint};
use iptv_core::downloads::store::{self, NewDownload};
use iptv_core::error::{CoreError, RpcErrorCode};
use iptv_core::model::{ContentType, CopyRef, ItemRef, RequestHeaders, SourceKind};
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The Xtream mock (iptv-mock when it serves Xtream), a state, and a synced
/// source.
async fn xtream() -> (stub::Server, tempfile::TempDir, Arc<AppState>, String) {
    let srv = stub::server().await;
    let (dir, state, _rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, stub::USER, stub::PASS).await;
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    r.dispatch(state.clone(), "xtream.sync", json!({ "sourceId": sid }))
        .await
        .unwrap_or_else(|e| panic!("xtream.sync failed: {}", e.message));
    (srv, dir, state, sid)
}

fn copy(source: &str, ct: ContentType, item: &str, episode: Option<&str>) -> CopyRef {
    CopyRef::new(ItemRef::new(source, ct, item), episode.map(str::to_owned))
}

/// The first 16 bytes behind `ep`, as a download's first range asks.
async fn first_bytes(ep: &Endpoint) -> Vec<u8> {
    let resp = reqwest::Client::new()
        .get(&ep.url)
        .header("Range", "bytes=0-15")
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.status());
    resp.bytes().await.unwrap().to_vec()
}

#[tokio::test]
async fn resolve_gives_an_xtream_movie_its_stream() {
    let (srv, _dir, state, sid) = xtream().await;
    let movie = copy(&sid, ContentType::Movie, "201", None);
    let ep = shared::resolve(&state, &movie).await.unwrap();
    assert_eq!(ep.copy, movie);
    assert_eq!(ep.kind, SourceKind::Xtream);
    assert!(
        ep.url
            .starts_with(&format!("{}/movie/demo/secret/201.", srv.server_url)),
        "{}",
        ep.url
    );
    assert_eq!(ep.headers, RequestHeaders::default());
    // The same URL and headers as playback's own resolution.
    let src = iptv_core::xtream::service::stream_url(&state, &movie.item_ref, None)
        .await
        .unwrap();
    assert_eq!(ep.url, src.url);
    assert_eq!(ep.headers, src.headers.unwrap_or_default());
    assert!(!first_bytes(&ep).await.is_empty());
    // Logs of an endpoint never carry the account.
    assert!(!format!("{ep:?}").contains(stub::PASS));
    // Nothing was stored: the source has no download rows.
    let rows = state.db_call(|c| store::list(c, false)).await.unwrap();
    assert!(rows.is_empty());
}

#[tokio::test]
async fn resolve_gives_an_xtream_episode_its_stream() {
    let (srv, _dir, state, sid) = xtream().await;
    let series = ItemRef::new(&sid, ContentType::Series, "301");
    let seasons = iptv_core::xtream::service::series_seasons(&state, &series)
        .await
        .unwrap();
    assert!(!seasons.is_empty());
    assert!(seasons.iter().all(|s| !s.episodes.is_empty()));
    let first = &seasons[0].episodes[0];
    assert_eq!(first.series_ref, series);
    // Cached: a second read answers the same.
    let again = iptv_core::xtream::service::series_seasons(&state, &series)
        .await
        .unwrap();
    assert_eq!(again, seasons);

    let episode = copy(&sid, ContentType::Series, "301", Some(&first.id));
    let ep = shared::resolve(&state, &episode).await.unwrap();
    assert!(
        ep.url.starts_with(&format!(
            "{}/series/demo/secret/{}.",
            srv.server_url, first.id
        )),
        "{}",
        ep.url
    );
    assert!(!first_bytes(&ep).await.is_empty());

    // series_seasons is for series only.
    let err = iptv_core::xtream::service::series_seasons(
        &state,
        &ItemRef::new(&sid, ContentType::Movie, "201"),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
}

#[tokio::test]
async fn resolve_refuses_live_unknown_and_removed_copies() {
    let (_srv, _dir, state, sid) = xtream().await;
    for ct in [ContentType::Live, ContentType::Radio] {
        let err = shared::resolve(&state, &copy(&sid, ct, "101", None))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Unsupported(_)), "{err:?}");
    }
    let err = shared::resolve(&state, &copy("nope", ContentType::Movie, "201", None))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    iptv_core::sources::remove(&state, &sid).await.unwrap();
    let err = shared::resolve(&state, &copy(&sid, ContentType::Movie, "201", None))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn resolve_gives_m3u_rows_their_playlist_links() {
    let env = m3u::env().await;
    let text = "#EXTM3U\n\
        #EXTINF:-1 group-title=\"Films\",Heat (1995)\n\
        #EXTVLCOPT:http-user-agent=MovieUA/1\n\
        http://h:8080/movie/u/p/1001.mkv\n\
        #EXTINF:-1 group-title=\"EN | Drama\",EN - Dark (2017) S01 E01\n\
        http://h:8080/series/u/p/5001.mkv\n\
        #EXTINF:-1 group-title=\"EN | Drama\",EN - Dark (2017) S01 E02\n\
        #EXTVLCOPT:http-user-agent=EpisodeUA/1\n\
        http://h:8080/series/u/p/5002.mkv\n";
    let src = m3u::add_text(&env.state, "Films", text).await;
    let sid = src.id.clone();
    let (movie_id, series_id) = env
        .state
        .db_call(move |c| {
            let id = |ct: &str| -> rusqlite::Result<String> {
                c.query_row(
                    "SELECT item_id FROM items WHERE source_id = ?1 AND content_type = ?2",
                    [&sid, ct],
                    |r| r.get(0),
                )
            };
            Ok((id("movie")?, id("series")?))
        })
        .await
        .unwrap();

    let ep = shared::resolve(
        &env.state,
        &copy(&src.id, ContentType::Movie, &movie_id, None),
    )
    .await
    .unwrap();
    assert_eq!(ep.kind, SourceKind::M3u);
    assert_eq!(ep.url, "http://h:8080/movie/u/p/1001.mkv");
    assert_eq!(ep.headers.user_agent.as_deref(), Some("MovieUA/1"));

    let detail = m3u::router()
        .dispatch(
            env.state.clone(),
            "m3u.seriesDetail",
            json!({ "ref": { "sourceId": src.id, "contentType": "series", "itemId": series_id } }),
        )
        .await
        .unwrap_or_else(|e| panic!("m3u.seriesDetail failed: {}", e.message));
    let episodes = detail["seasons"][0]["episodes"].as_array().unwrap();
    let second = episodes
        .iter()
        .find(|e| e["episode"] == 2)
        .expect("episode 2");
    let ep = shared::resolve(
        &env.state,
        &copy(
            &src.id,
            ContentType::Series,
            &series_id,
            second["id"].as_str(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(ep.url, "http://h:8080/series/u/p/5002.mkv");
    assert_eq!(ep.headers.user_agent.as_deref(), Some("EpisodeUA/1"));

    let err = shared::resolve(
        &env.state,
        &copy(&src.id, ContentType::Movie, "missing", None),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
}

/// Keys under `app_state` that start with `prefix`.
async fn keys(state: &Arc<AppState>, prefix: &'static str) -> Vec<String> {
    state
        .db_call(move |c| {
            let mut stmt = c.prepare(
                "SELECT key FROM app_state WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key",
            )?;
            let rows = stmt.query_map([prefix], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn source_delete_drops_its_download_records_only() {
    let env = m3u::env().await;
    // `_` is a LIKE wildcard: `a_b`'s cleanup must spare `aXb`, and its
    // prefix must spare `a_b2`.
    for id in ["a_b", "aXb", "a_b2"] {
        m3u::bare_source(&env.state, id).await;
    }
    let movie = |s: &str, item: &str| copy(s, ContentType::Movie, item, None);
    let mut written = Vec::new();
    for s in ["a_b", "aXb", "a_b2"] {
        written.push(shared::limit_key(s));
        written.push(shared::mirror_key(&movie(s, "1")));
        written.push(shared::mirror_key(&copy(
            s,
            ContentType::Series,
            "9",
            Some("901"),
        )));
    }
    let w = written.clone();
    env.state
        .db_call(move |c| {
            for k in &w {
                shared::write_record(c, k, &json!({ "version": 1 }))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        keys(&env.state, "dl_").await.len(),
        written.len(),
        "{written:?}"
    );

    iptv_core::sources::remove(&env.state, "a_b").await.unwrap();
    let mut want: Vec<String> = written
        .iter()
        .filter(|k| !k.starts_with("dl_conn_limit:a_b") || k.as_str() == "dl_conn_limit:a_b2")
        .filter(|k| !k.starts_with("dl_mirror:a_b:"))
        .cloned()
        .collect();
    want.sort();
    assert_eq!(keys(&env.state, "dl_").await, want);
    assert_eq!(want.len(), 6);
}

#[tokio::test]
async fn origin_is_stored_and_cleared_when_a_row_starts_over() {
    let env = m3u::env().await;
    m3u::bare_source(&env.state, "s").await;
    let id = env
        .state
        .db_call(|c| {
            let r = ItemRef::new("s", ContentType::Movie, "1");
            store::insert(
                c,
                &NewDownload {
                    item_ref: &r,
                    episode_id: None,
                    title: "T",
                    subtitle: None,
                    url: "http://h/1.mp4",
                    poster_url: None,
                    headers: &RequestHeaders::default(),
                    duration_seconds: None,
                },
            )
        })
        .await
        .unwrap();
    let origin = copy("other", ContentType::Movie, "7", None);
    let read = |state: Arc<AppState>| async move {
        state
            .db_call(move |c| store::get(c, id))
            .await
            .unwrap()
            .download
    };
    let fresh = read(env.state.clone()).await;
    assert_eq!(fresh.origin, None);
    assert_eq!(
        (fresh.sources, fresh.served_by, fresh.stats),
        (None, None, None)
    );

    let o = origin.clone();
    env.state
        .db_call(move |c| store::set_origin(c, id, Some(&o)))
        .await
        .unwrap();
    let row = read(env.state.clone()).await;
    assert_eq!(row.origin, Some(origin.clone()));
    assert_eq!(
        row.updated_at, fresh.updated_at,
        "set_origin changes nothing else"
    );
    assert_eq!(
        serde_json::to_value(&row).unwrap()["origin"]["ref"]["sourceId"],
        "other"
    );

    // A completed row whose file went missing starts over without it.
    let o = origin.clone();
    env.state
        .db_call(move |c| {
            store::complete(c, id, "1.mp4", "C:/nowhere/1.mp4", 10)?;
            store::set_origin(c, id, Some(&o))?;
            store::restart_completed(c, id)
        })
        .await
        .unwrap();
    assert_eq!(read(env.state.clone()).await.origin, None);

    // So does a row reset for a new download of the same item.
    let o = origin.clone();
    env.state
        .db_call(move |c| {
            store::set_origin(c, id, Some(&o))?;
            let r = ItemRef::new("s", ContentType::Movie, "1");
            store::reset(
                c,
                id,
                &NewDownload {
                    item_ref: &r,
                    episode_id: None,
                    title: "T",
                    subtitle: None,
                    url: "http://h/1.mp4",
                    poster_url: None,
                    headers: &RequestHeaders::default(),
                    duration_seconds: None,
                },
            )
        })
        .await
        .unwrap();
    assert_eq!(read(env.state.clone()).await.origin, None);

    // Clearing works, and a missing row is reported.
    env.state
        .db_call(move |c| store::set_origin(c, id, None))
        .await
        .unwrap();
    let err = env
        .state
        .db_call(|c| store::set_origin(c, 999_999, None))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn pinned_client_connects_to_the_pinned_address() {
    let env = m3u::env().await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let served = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.unwrap();
        let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
        sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
            .await
            .unwrap();
        head
    });

    let host = "pinned.w0.test";
    iptv_core::downloads::set_dns_override(&env.state, host, vec![addr]);
    let found = iptv_core::http::host_addresses(&env.state, host, addr.port()).await;
    assert_eq!(found, vec![addr]);

    let client = iptv_core::http::pinned_client(&env.state, host, found[0]).unwrap();
    let body = client
        .get(format!("http://{host}:{}/x", addr.port()))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "ok");
    let head = served.await.unwrap();
    assert!(
        head.contains(&format!("host: {host}:{}", addr.port())),
        "{head}"
    );

    // Another address of the same host is another client.
    let other: SocketAddr = "127.0.0.2:9".parse().unwrap();
    assert!(iptv_core::http::pinned_client(&env.state, host, other).is_some());
}

#[tokio::test]
async fn new_download_commands_answer_before_any_transfer() {
    let env = m3u::env().await;
    let mut r = RpcRouter::new();
    iptv_core::downloads::rpc::register(&mut r);
    let call = |cmd: &'static str, args: Value| {
        let r = &r;
        let state = env.state.clone();
        async move { r.dispatch(state, cmd, args).await }
    };
    assert_eq!(
        call("downloads.stats", json!({ "id": 1 })).await.unwrap(),
        Value::Null
    );
    assert_eq!(iptv_core::downloads::transfer_stats(&env.state, 1), None);
    assert_eq!(
        call("downloads.connectionLimits", Value::Null)
            .await
            .unwrap(),
        json!([])
    );
    assert!(iptv_core::downloads::connection_limits(&env.state)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        call("downloads.resetConnectionLimit", json!({ "sourceId": "s" }))
            .await
            .unwrap(),
        Value::Null
    );
    let err = call(
        "downloads.resetConnectionLimit",
        json!({ "sourceId": "  " }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    let err = call("downloads.stats", json!({})).await.unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Invalid);
    iptv_core::downloads::age_connection_limit(&env.state, "s", std::time::Duration::from_secs(1))
        .await
        .unwrap();
}
