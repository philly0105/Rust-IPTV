//! B8: adding playlists that fail in the common ways (iptv-mock `/fail/...`)
//! ends with the right error code, a message that says what to do, no
//! credentials in the message, and no hang. Also the 10k fixture imports.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::error::{RpcError, RpcErrorCode};
use iptv_core::sources;
use std::time::{Duration, Instant};
use support::*;

async fn add_url(url: &str) -> (Result<iptv_core::model::Source, RpcError>, Duration) {
    let env = env().await;
    let started = Instant::now();
    let r = sources::add(env.state.clone(), url_args(url, false))
        .await
        .map_err(|e| RpcError::from(e.error));
    (r, started.elapsed())
}

async fn fail(path: &str) -> RpcError {
    let mock = iptv_fixtures::spawn_mock().await;
    let (r, took) = add_url(&mock.url(path)).await;
    assert!(took < Duration::from_secs(20), "{path} took {took:?}");
    r.expect_err(path)
}

#[tokio::test]
async fn unauthorized_playlist_is_auth_with_a_next_step() {
    let e = fail("/fail/401.m3u").await;
    assert_eq!(e.code, RpcErrorCode::Auth, "{e:?}");
    assert!(!e.retryable);
    assert!(
        e.message.contains("HTTP 401") && e.message.contains("Check"),
        "{e:?}"
    );
    let e = fail("/fail/403.m3u").await;
    assert_eq!(e.code, RpcErrorCode::Auth, "{e:?}");
}

#[tokio::test]
async fn missing_playlist_is_not_found() {
    let e = fail("/fail/404.m3u").await;
    assert_eq!(e.code, RpcErrorCode::NotFound, "{e:?}");
    assert!(e.message.contains("Check the playlist URL"), "{e:?}");
}

#[tokio::test]
async fn busy_server_is_retryable_network() {
    let e = fail("/fail/503.m3u").await;
    assert_eq!(e.code, RpcErrorCode::Network, "{e:?}");
    assert!(e.retryable);
    assert!(e.message.contains("try again later"), "{e:?}");
}

#[tokio::test]
async fn not_a_playlist_is_invalid() {
    for path in ["/fail/malformed.m3u", "/fail/empty.m3u"] {
        let e = fail(path).await;
        assert_eq!(e.code, RpcErrorCode::Invalid, "{path}: {e:?}");
        assert!(e.message.contains("not an M3U playlist"), "{path}: {e:?}");
    }
    let e = fail("/fail/login.m3u").await;
    assert_eq!(e.code, RpcErrorCode::Invalid, "{e:?}");
    assert!(e.message.contains("web page"), "{e:?}");
}

#[tokio::test]
async fn single_channel_urls_are_refused_fast() {
    let mock = iptv_fixtures::spawn_mock().await;
    for (path, what) in [("/fail/stream.ts", "MPEG-TS"), ("/fail/hls.m3u8", "HLS")] {
        let (r, took) = add_url(&mock.url(path)).await;
        let e = r.expect_err(path);
        assert_eq!(e.code, RpcErrorCode::Invalid, "{path}: {e:?}");
        assert!(
            e.message.contains(what) && e.message.contains("playlist URL"),
            "{path}: {e:?}"
        );
        assert!(took < Duration::from_secs(5), "{path} took {took:?}");
    }
}

#[tokio::test]
async fn broken_playlist_keeps_the_good_channels() {
    let mock = iptv_fixtures::spawn_mock().await;
    let (r, _) = add_url(&mock.url("/fail/broken.m3u")).await;
    let src = r.expect("a partly broken playlist still imports");
    assert_eq!(
        src.channel_count,
        iptv_mock::failures::BROKEN_M3U_CHANNELS as i64
    );
}

#[tokio::test]
async fn credentials_never_reach_the_message() {
    let mock = iptv_fixtures::spawn_mock().await;
    let url = mock.url("/fail/401.m3u?username=bob&password=hunter2&token=tok123");
    let (r, _) = add_url(&url).await;
    let e = r.expect_err("401");
    let shown = serde_json::to_string(&e).unwrap();
    for secret in ["hunter2", "tok123", "username=bob"] {
        assert!(!shown.contains(secret), "{secret} leaked: {shown}");
    }
}

#[tokio::test]
async fn ten_k_fixture_imports() {
    let mock = iptv_fixtures::spawn_mock().await;
    let (r, took) = add_url(&mock.url("/m3u/10k.m3u")).await;
    let src = r.expect("10k import");
    eprintln!("b8: 10k playlist over HTTP in {took:?}");
    // The generator mixes in radio stations and movies, like real lists.
    assert_eq!(
        src.channel_count + src.radio_count + src.movie_count + src.series_count,
        iptv_mock::playlists::TEN_K_CHANNELS as i64
    );
    assert!(src.channel_count > 9_000, "{}", src.channel_count);
}
