//! Failure paths: bad credentials, retry on 5xx, unreachable server, password
//! never in error messages.

use iptv_core::error::RpcErrorCode;
use iptv_core::rpc::RpcRouter;
use serde_json::json;

#[path = "xtream_stub.rs"]
mod stub;

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    iptv_core::xtream::rpc::register(&mut r);
    r
}

#[tokio::test]
async fn bad_credentials_are_auth_errors() {
    let srv = stub::server().await;
    let (_dir, state, _rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, "demo", "wrong-pass-123").await;
    let r = router();

    let e = r
        .dispatch(state.clone(), "xtream.sync", json!({"sourceId": sid}))
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Auth);
    assert!(!e.message.contains("wrong-pass-123"));

    // The failure is recorded on the source, without the password.
    let sid2 = sid.clone();
    let last_error: Option<String> = state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT last_error FROM sources WHERE id = ?1",
                [&sid2],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    let last_error = last_error.expect("last_error recorded");
    assert!(!last_error.contains("wrong-pass-123"));

    let e = r
        .dispatch(
            state.clone(),
            "xtream.accountInfo",
            json!({"sourceId": sid}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Auth);

    let t = r
        .dispatch(
            state.clone(),
            "xtream.test",
            json!({"config": {"serverUrl": srv.server_url, "username": "demo", "password": "wrong-pass-123"}}),
        )
        .await
        .unwrap();
    assert_eq!(t["ok"], false);
    let msg = t["message"].as_str().unwrap();
    assert!(!msg.is_empty());
    assert!(!msg.contains("wrong-pass-123"));
}

#[tokio::test]
async fn transient_server_errors_are_retried() {
    let srv = stub::stub().await;
    let (_dir, state, _rx) = stub::state().await;
    let sid = stub::add_source(&state, &srv.server_url, "flaky", stub::PASS).await;
    let acc = router()
        .dispatch(
            state.clone(),
            "xtream.accountInfo",
            json!({"sourceId": sid}),
        )
        .await
        .expect("second attempt succeeds");
    assert_eq!(acc["status"], "Active");
}

#[tokio::test]
async fn unreachable_server_is_a_network_error() {
    // Bind then drop to get a closed local port.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (_dir, state, _rx) = stub::state().await;
    let sid = stub::add_source(
        &state,
        &format!("http://127.0.0.1:{port}"),
        "demo",
        "s3cr3t-xyz",
    )
    .await;
    let r = router();
    let e = r
        .dispatch(state.clone(), "xtream.sync", json!({"sourceId": sid}))
        .await
        .unwrap_err();
    assert!(
        matches!(e.code, RpcErrorCode::Network | RpcErrorCode::Timeout),
        "{:?}",
        e.code
    );
    assert!(e.retryable);
    assert!(!e.message.contains("s3cr3t-xyz"), "{}", e.message);

    let t = r
        .dispatch(
            state.clone(),
            "xtream.test",
            json!({"config": {"serverUrl": format!("127.0.0.1:{port}/get.php"), "username": "demo", "password": "s3cr3t-xyz"}}),
        )
        .await
        .unwrap();
    assert_eq!(t["ok"], false);
    assert!(!t["message"].as_str().unwrap().contains("s3cr3t-xyz"));
}

#[tokio::test]
async fn missing_source_and_bad_args_are_clear() {
    let (_dir, state, _rx) = stub::state().await;
    let r = router();
    let e = r
        .dispatch(state.clone(), "xtream.sync", json!({"sourceId": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::NotFound);
    let e = r
        .dispatch(state.clone(), "xtream.sync", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
}
