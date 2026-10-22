//! Review-round fixes: detail pages fall back to the catalog row when the
//! provider's detail call fails, movie refs that point at series, catch-up
//! window checks and unknown episode ids.

use iptv_core::error::{RpcError, RpcErrorCode};
use iptv_core::rpc::RpcRouter;
use iptv_core::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

#[path = "xtream_stub.rs"]
mod stub;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    r
}

fn item_ref(sid: &str, ct: &str, id: &str) -> Value {
    json!({"sourceId": sid, "contentType": ct, "itemId": id})
}

async fn call(r: &RpcRouter, state: &Arc<AppState>, cmd: &str, args: Value) -> Value {
    match r.dispatch(state.clone(), cmd, args).await {
        Ok(v) => v,
        Err(e) => panic!("{cmd} failed: {:?} {}", e.code, e.message),
    }
}

async fn fail(r: &RpcRouter, state: &Arc<AppState>, cmd: &str, args: Value) -> RpcError {
    match r.dispatch(state.clone(), cmd, args).await {
        Ok(v) => panic!("{cmd} should fail, got {v}"),
        Err(e) => e,
    }
}

/// Stub server, state and a synced source for `user`.
async fn synced(
    user: &str,
) -> (
    stub::Server,
    tempfile::TempDir,
    Arc<AppState>,
    RpcRouter,
    String,
) {
    let srv = stub::stub().await;
    let (dir, state, _rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, user, stub::PASS).await;
    let r = router();
    call(&r, &state, "xtream.sync", json!({"sourceId": sid})).await;
    (srv, dir, state, r, sid)
}

async fn detail_falls_back_to_row(user: &str, status: &str) {
    let (_srv, _dir, state, r, sid) = synced(user).await;

    let vod = call(
        &r,
        &state,
        "xtream.vodDetail",
        json!({"ref": item_ref(&sid, "movie", "202")}),
    )
    .await;
    assert_eq!(vod["providerDetailsUnavailable"], true, "{vod}");
    assert!(
        vod["providerError"].as_str().unwrap().contains(status),
        "{vod}"
    );
    assert_eq!(vod["item"]["title"], "Movie 202 (1992)");
    assert_eq!(vod["item"]["posterUrl"], "http://img.mock/m202.jpg");
    assert_eq!(vod["cast"], json!([]));

    let series = call(
        &r,
        &state,
        "xtream.seriesDetail",
        json!({"ref": item_ref(&sid, "series", "301")}),
    )
    .await;
    assert_eq!(series["providerDetailsUnavailable"], true, "{series}");
    assert!(series["providerError"].as_str().unwrap().contains(status));
    assert_eq!(series["item"]["title"], "Series 301");
    assert_eq!(series["item"]["plot"], "A plot.");
    assert_eq!(series["seasons"], json!([]));

    // No catalog row and no provider payload: still an error.
    let e = fail(
        &r,
        &state,
        "xtream.vodDetail",
        json!({"ref": item_ref(&sid, "movie", "999")}),
    )
    .await;
    assert_ne!(e.code, RpcErrorCode::Internal, "{}", e.message);
}

#[tokio::test]
async fn detail_uses_catalog_row_when_provider_404s() {
    detail_falls_back_to_row("nodetail404", "404").await;
}

#[tokio::test]
async fn detail_uses_catalog_row_when_provider_500s() {
    detail_falls_back_to_row("nodetail500", "500").await;
}

#[tokio::test]
async fn healthy_detail_is_not_flagged() {
    let (_srv, _dir, state, r, sid) = synced(stub::USER).await;
    let vod = call(
        &r,
        &state,
        "xtream.vodDetail",
        json!({"ref": item_ref(&sid, "movie", "201")}),
    )
    .await;
    assert_eq!(vod["providerDetailsUnavailable"], false);
    assert!(vod.get("providerError").is_none());
    assert_eq!(vod["director"], "Jane Doe");

    // Neither row nor payload: NotFound.
    let e = fail(
        &r,
        &state,
        "xtream.vodDetail",
        json!({"ref": item_ref(&sid, "movie", "999")}),
    )
    .await;
    assert_eq!(e.code, RpcErrorCode::NotFound);
}

#[tokio::test]
async fn movie_ref_with_a_series_id_names_the_series() {
    let (_srv, _dir, state, r, sid) = synced(stub::USER).await;
    let e = fail(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "movie", "305")}),
    )
    .await;
    assert_eq!(e.code, RpcErrorCode::NotFound);
    assert!(e.message.contains("Series 305"), "{}", e.message);
    assert!(e.message.contains("series list"), "{}", e.message);
}

#[tokio::test]
async fn unknown_episode_is_not_found() {
    let (_srv, _dir, state, r, sid) = synced(stub::USER).await;
    let e = fail(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "series", "301"), "episodeId": "../../etc"}),
    )
    .await;
    assert_eq!(e.code, RpcErrorCode::NotFound, "{}", e.message);

    // When series info itself fails, the mp4 fallback still plays.
    let (srv, _dir2, state, r, sid) = synced("nodetail500").await;
    let ep = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "series", "301"), "episodeId": "3001"}),
    )
    .await;
    assert_eq!(
        ep["url"],
        format!("{}/series/nodetail500/secret/3001.mp4", srv.server_url)
    );
}

#[tokio::test]
async fn catchup_respects_the_channel_archive() {
    let (_srv, _dir, state, r, sid) = synced(stub::USER).await;
    let recent = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();

    // 106 has no archive.
    let e = fail(
        &r,
        &state,
        "xtream.catchupUrl",
        json!({"ref": item_ref(&sid, "live", "106"), "start": recent, "durationMinutes": 30}),
    )
    .await;
    assert_eq!(e.code, RpcErrorCode::Invalid);
    assert_eq!(e.message, "This channel has no catch-up.");

    // 101 keeps 3 days.
    let old = (chrono::Utc::now() - chrono::Duration::days(4)).to_rfc3339();
    let e = fail(
        &r,
        &state,
        "xtream.catchupUrl",
        json!({"ref": item_ref(&sid, "live", "101"), "start": old, "durationMinutes": 30}),
    )
    .await;
    assert_eq!(e.code, RpcErrorCode::Invalid);
    assert!(e.message.contains("3 days"), "{}", e.message);

    let ok = call(
        &r,
        &state,
        "xtream.catchupUrl",
        json!({"ref": item_ref(&sid, "live", "101"), "start": recent, "durationMinutes": 30}),
    )
    .await;
    assert!(ok["url"].as_str().unwrap().contains("/timeshift/"));
}

#[tokio::test]
async fn allowed_output_formats_reach_account_and_live_urls() {
    // Panel allows m3u8: the default streamFormat (auto, asked without a
    // player's autoFormat) gives m3u8.
    let (srv, _dir, state, r, sid) = synced(stub::USER).await;
    let acc = call(&r, &state, "xtream.accountInfo", json!({"sourceId": sid})).await;
    assert_eq!(acc["allowedOutputFormats"], json!(["m3u8", "ts"]));
    let live = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    assert_eq!(
        live["url"],
        format!("{}/live/demo/secret/101.m3u8", srv.server_url)
    );
    assert_eq!(live["kind"], "hls");

    // Panel allows only ts/rtmp: falls back to ts (normalized), kind direct.
    let (srv, _dir2, state, r, sid) = synced("tsonly").await;
    let acc = call(&r, &state, "xtream.accountInfo", json!({"sourceId": sid})).await;
    assert_eq!(acc["allowedOutputFormats"], json!(["ts", "rtmp"]));
    let live = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    assert_eq!(
        live["url"],
        format!("{}/live/tsonly/secret/101.ts", srv.server_url)
    );
    assert_eq!(live["kind"], "direct");
}

#[tokio::test]
async fn mock_account_reports_allowed_output_formats() {
    let srv = stub::server().await;
    let (_dir, state, _rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, stub::USER, stub::PASS).await;
    let acc = call(
        &router(),
        &state,
        "xtream.accountInfo",
        json!({"sourceId": sid}),
    )
    .await;
    assert_eq!(acc["allowedOutputFormats"], json!(["m3u8", "ts"]));
}

/// The source's own User-Agent (and Referer / Origin) reach the stream it
/// plays, not only `player_api.php`: the player, downloads and recordings
/// all take `PlayerSource.headers`.
#[tokio::test]
async fn source_headers_reach_stream_urls() {
    use iptv_core::model::{RequestHeaders, XtreamSourceConfig};
    use iptv_core::sources::SourcePatch;
    let (srv, _dir, state, r, sid) = synced(stub::USER).await;
    let live = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    assert!(live["headers"].is_null(), "{live}");

    let patch = SourcePatch {
        xtream: Some(XtreamSourceConfig {
            server_url: srv.server_url.clone(),
            username: stub::USER.into(),
            password: stub::PASS.into(),
            headers: RequestHeaders {
                user_agent: Some(" TestAgent/1.0 ".into()),
                ..Default::default()
            },
        }),
        ..Default::default()
    };
    iptv_core::sources::update(&state, &sid, patch)
        .await
        .unwrap();
    let live = call(
        &r,
        &state,
        "xtream.streamUrl",
        json!({"ref": item_ref(&sid, "live", "101")}),
    )
    .await;
    assert_eq!(live["headers"], json!({"userAgent": "TestAgent/1.0"}));
}
