//! L1-sources-home-7: an unreachable host failed only after 7 s (three tries
//! of a refused connection) and a silent Xtream panel after 46 s (three 15 s
//! head deadlines). A refused connection, an unknown host or a bad
//! certificate is now tried once, and the Xtream account check gives up
//! after one short head deadline. Busy (5xx) and reset connections are still
//! retried.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::error::{CoreError, CoreResult, RpcError, RpcErrorCode};
use iptv_core::model::{SourceKind, XtreamSourceConfig};
use iptv_core::sources::{self, AddSourceArgs};
use iptv_core::xtream::client::{XtreamClient, ACCOUNT_HEADER_TIMEOUT};
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering::SeqCst};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Head deadline of the account check in this test binary (the app's is
/// [`ACCOUNT_HEADER_TIMEOUT`]). Longer than a refused loopback connect,
/// which takes about 2 s on Windows (two SYN retries).
const SHORT_ACCOUNT_DEADLINE: Duration = Duration::from_secs(4);

/// A loopback port nothing listens on (bound, then released).
fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

#[derive(Clone, Copy)]
enum Panel {
    /// Takes the connection and never answers.
    Silent,
    /// Reads the request, then closes the connection without an answer.
    Hangup,
    /// Answers HTTP 503.
    Busy,
}

/// Loopback panel behaving like `mode`; returns its base URL and the number
/// of connections it accepted. The task ends with the test's runtime.
async fn panel(mode: Panel) -> (String, Arc<AtomicU32>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicU32::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((mut sock, _)) = listener.accept().await {
            counter.fetch_add(1, SeqCst);
            match mode {
                Panel::Silent => held.push(sock),
                Panel::Hangup => {
                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        let _ = sock.read(&mut buf).await;
                        let _ = sock.shutdown().await;
                    });
                }
                Panel::Busy => {
                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        let _ = sock.read(&mut buf).await;
                        let _ = sock
                            .write_all(
                                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        let _ = sock.shutdown().await;
                    });
                }
            }
        }
    });
    (format!("http://127.0.0.1:{port}"), hits)
}

fn xtream_config(server_url: &str) -> XtreamSourceConfig {
    serde_json::from_value(json!({
        "serverUrl": server_url,
        "username": "u",
        "password": "p",
    }))
    .unwrap()
}

fn xtream_args(server_url: &str) -> AddSourceArgs {
    AddSourceArgs {
        kind: SourceKind::Xtream,
        name: String::new(),
        auto_refresh: None,
        m3u: None,
        xtream: Some(xtream_config(server_url)),
        stalker: None,
    }
}

/// Adds a source the way the add dialog does and returns the error, how long
/// it took, and the retry progress events (`attempt` set) it emitted.
async fn add_failing(args: AddSourceArgs) -> (RpcError, Duration, Vec<serde_json::Value>) {
    iptv_core::xtream::client::set_account_header_timeout_for_tests(SHORT_ACCOUNT_DEADLINE);
    let mut env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    let started = Instant::now();
    let err = sources::add(env.state.clone(), args)
        .await
        .expect_err("the server cannot be used");
    let took = started.elapsed();
    eprintln!("failed after {took:?}: {}", err.error);
    let mut retries = Vec::new();
    while let Ok(ev) = env.events.try_recv() {
        if ev.kind == "import.progress" && ev.payload.get("attempt").is_some() {
            retries.push(ev.payload);
        }
    }
    (RpcError::from(err.error), took, retries)
}

#[test]
fn account_check_waits_ten_seconds_for_an_answer() {
    assert_eq!(ACCOUNT_HEADER_TIMEOUT, Duration::from_secs(10));
}

/// `with_retry` (TMDB, Stalker) stops after one refused connection.
#[tokio::test]
async fn closed_port_is_tried_once() {
    let url = format!("http://127.0.0.1:{}/x", dead_port());
    let http = iptv_core::http::client(None);
    let calls = AtomicU32::new(0);
    let started = Instant::now();
    let r: CoreResult<reqwest::Response> = iptv_core::http::with_retry(3, || {
        calls.fetch_add(1, SeqCst);
        iptv_core::http::send(http.get(&url))
    })
    .await;
    let took = started.elapsed();
    let err = r.unwrap_err();
    assert_eq!(calls.load(SeqCst), 1, "a refused connection was retried");
    assert!(matches!(err, CoreError::Network(_)), "{err:?}");
    assert!(!err.is_retryable());
    assert!(
        err.to_string()
            .contains("The server refused the connection."),
        "{err}"
    );
    // One try: Windows spends about 2 s on a refused loopback connect.
    assert!(took < Duration::from_secs(4), "{took:?}");
}

#[tokio::test]
async fn m3u_on_a_closed_port_fails_after_one_try() {
    let url = format!("http://127.0.0.1:{}/list.m3u", dead_port());
    let (err, took, retries) = add_failing(url_args(&url, false)).await;
    assert_eq!(err.code, RpcErrorCode::Network, "{err:?}");
    assert!(retries.is_empty(), "retried: {retries:?}");
    assert!(
        err.message.starts_with("Could not reach 127.0.0.1. ")
            && err.message.contains("refused the connection")
            && !err.message.contains("tries."),
        "{}",
        err.message
    );
    // The user can still fix the address and press Try again.
    assert!(err.retryable);
    assert!(took < Duration::from_secs(4), "{took:?}");
}

#[tokio::test]
async fn xtream_on_a_closed_port_fails_after_one_try() {
    let (err, took, retries) =
        add_failing(xtream_args(&format!("http://127.0.0.1:{}", dead_port()))).await;
    assert_eq!(err.code, RpcErrorCode::Network, "{err:?}");
    assert!(retries.is_empty(), "retried: {retries:?}");
    assert!(
        err.message.contains("refused the connection"),
        "{}",
        err.message
    );
    assert!(!err.message.contains("p&"), "{}", err.message);
    assert!(took < Duration::from_secs(4), "{took:?}");
}

/// The finding's 46 s case: the account check gives up after one head
/// deadline and is not retried.
#[tokio::test]
async fn silent_xtream_panel_fails_on_one_account_deadline() {
    let (url, hits) = panel(Panel::Silent).await;
    let (err, took, retries) = add_failing(xtream_args(&url)).await;
    assert_eq!(err.code, RpcErrorCode::Timeout, "{err:?}");
    assert!(
        err.message
            .contains("accepted the connection but did not answer"),
        "{}",
        err.message
    );
    assert_eq!(hits.load(SeqCst), 1, "the silent panel was asked again");
    assert!(retries.is_empty(), "retried: {retries:?}");
    assert!(took >= SHORT_ACCOUNT_DEADLINE, "{took:?}");
    assert!(took < SHORT_ACCOUNT_DEADLINE * 3, "{took:?}");
}

/// The Test connection button uses the same short deadline.
#[tokio::test]
async fn silent_xtream_panel_fails_the_connection_test_fast() {
    iptv_core::xtream::client::set_account_header_timeout_for_tests(SHORT_ACCOUNT_DEADLINE);
    let (url, hits) = panel(Panel::Silent).await;
    let (_dir, state) = {
        let env = env().await;
        iptv_core::xtream::init(env.state.clone()).await.unwrap();
        (env.dir, env.state)
    };
    let started = Instant::now();
    let r = iptv_core::xtream::service::test(&state, &xtream_config(&url))
        .await
        .unwrap();
    assert!(!r.ok);
    assert_eq!(hits.load(SeqCst), 1);
    assert!(started.elapsed() < SHORT_ACCOUNT_DEADLINE * 3);
}

/// Transient failures of the account check are still retried.
#[tokio::test]
async fn busy_or_hung_up_account_check_is_still_retried() {
    iptv_core::xtream::client::set_account_header_timeout_for_tests(SHORT_ACCOUNT_DEADLINE);
    for (mode, what) in [(Panel::Busy, "HTTP 503"), (Panel::Hangup, "hang-up")] {
        let (url, hits) = panel(mode).await;
        let client =
            XtreamClient::new(iptv_core::http::client(None), &xtream_config(&url)).unwrap();
        let err = client.account().await.unwrap_err();
        assert!(err.is_retryable(), "{what}: {err:?}");
        assert!(
            matches!(err, CoreError::Server(_) | CoreError::Network(_)),
            "{what}: {err:?}"
        );
        assert_eq!(hits.load(SeqCst), 3, "{what} was not retried");
        assert!(
            err.to_string()
                .ends_with("The download failed after 3 tries."),
            "{what}: {err}"
        );
    }
}
