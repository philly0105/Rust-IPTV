//! B9 contracts C7 (`recent.add` `viewedAt`) and C10 (error codes on
//! `Source.lastErrorCode`, `sources.refreshAll` failures and
//! `import.progress` errors).

#[path = "m3u_support.rs"]
mod support;

use iptv_core::error::RpcErrorCode;
use iptv_core::sources;
use serde_json::json;
use support::*;

/// A loopback port nothing listens on (bound, then released).
fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_refresh_records_a_code_and_success_clears_it() {
    let mut env = env().await;
    let stub = stub(&gen_m3u(5, 1)).await;
    let src = sources::add(env.state.clone(), url_args(&stub.url(), false))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(src.last_error_code, None);
    drain(&mut env.events);

    stub.set_fail(true); // 404
    let err = sources::refresh(env.state.clone(), &src.id)
        .await
        .unwrap_err();
    assert_eq!(err.code(), RpcErrorCode::NotFound);
    let after = sources::get(&env.state, &src.id).await.unwrap();
    assert_eq!(after.last_error_code, Some(RpcErrorCode::NotFound));
    assert!(after.last_error.is_some());
    assert_eq!(after.channel_count, 5, "previous catalog kept");
    // Wire shape: camelCase, snake_case value.
    let v = serde_json::to_value(&after).unwrap();
    assert_eq!(v["lastErrorCode"], "not_found");
    // The error progress event carries the code too.
    let evs = drain(&mut env.events);
    let ev = evs
        .iter()
        .rev()
        .find(|e| e.kind == "import.progress" && e.payload["phase"] == "error")
        .expect("error progress");
    assert_eq!(ev.payload["code"], "not_found");
    assert!(ev.payload["message"].is_string());
    // Non-error phases carry no code.
    assert!(evs
        .iter()
        .filter(|e| e.kind == "import.progress" && e.payload["phase"] != "error")
        .all(|e| e.payload.get("code").is_none()));

    // Survives a restart of the listing path (read back from the column).
    let listed = sources::list(&env.state).await.unwrap();
    assert_eq!(listed[0].last_error_code, Some(RpcErrorCode::NotFound));

    stub.set_fail(false);
    let ok = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(ok.last_error, None);
    assert_eq!(ok.last_error_code, None);
    assert!(serde_json::to_value(&ok)
        .unwrap()
        .get("lastErrorCode")
        .is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_all_failures_carry_a_code() {
    let env = env().await;
    let url = format!("http://127.0.0.1:{}/list.m3u", dead_port());
    let err = sources::add(env.state.clone(), url_args(&url, true))
        .await
        .unwrap_err();
    let id = err.source_id.unwrap();
    let src = sources::get(&env.state, &id).await.unwrap();
    assert_eq!(src.last_error_code, Some(RpcErrorCode::Network));

    let v = router()
        .dispatch(env.state.clone(), "sources.refreshAll", json!(null))
        .await
        .unwrap();
    let failed = v["failed"].as_array().unwrap();
    assert_eq!(failed.len(), 1, "{v}");
    assert_eq!(failed[0]["id"], id.as_str());
    assert_eq!(failed[0]["code"], "network");
    assert!(failed[0]["error"]
        .as_str()
        .unwrap()
        .contains("Could not reach"));
}

#[tokio::test]
async fn a_message_without_a_code_clears_a_stale_code() {
    let env = env().await;
    bare_source(&env.state, "s-code").await;
    env.state
        .db_call(|c| {
            sources::store::record_import_error(c, "s-code", "boom", RpcErrorCode::Auth)?;
            Ok(())
        })
        .await
        .unwrap();
    let s = sources::get(&env.state, "s-code").await.unwrap();
    assert_eq!(s.last_error_code, Some(RpcErrorCode::Auth));
    env.state
        .db_call(|c| sources::store::record_import(c, "s-code", Some("other")))
        .await
        .unwrap();
    let s = sources::get(&env.state, "s-code").await.unwrap();
    assert_eq!(s.last_error.as_deref(), Some("other"));
    assert_eq!(s.last_error_code, None);
    // An unknown stored code (newer build) is dropped, not an error.
    env.state
        .db_call(|c| {
            c.execute(
                "UPDATE sources SET last_error_code = 'from_the_future' WHERE id = 's-code'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let s = sources::get(&env.state, "s-code").await.unwrap();
    assert_eq!(s.last_error_code, None);
}

#[tokio::test]
async fn stored_errors_are_redacted() {
    let env = env().await;
    bare_source(&env.state, "s-red").await;
    let leaky = "GET http://h/get.php?username=bob&password=hunter2 failed (http://bob:pw@h/live/bob/hunter2/1.ts)";
    env.state
        .db_call(move |c| {
            sources::store::record_import_error(c, "s-red", leaky, RpcErrorCode::Network)?;
            Ok(())
        })
        .await
        .unwrap();
    let s = sources::get(&env.state, "s-red").await.unwrap();
    let msg = s.last_error.unwrap();
    assert!(!msg.contains("hunter2") && !msg.contains(":pw@"), "{msg}");
    env.state
        .db_call(move |c| sources::store::record_import(c, "s-red", Some(leaky)))
        .await
        .unwrap();
    let msg = sources::get(&env.state, "s-red")
        .await
        .unwrap()
        .last_error
        .unwrap();
    assert!(!msg.contains("hunter2"), "{msg}");
}

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

fn add_args(viewed_at: Option<&str>) -> serde_json::Value {
    let mut v = json!({
        "ref": { "sourceId": "s-recent", "contentType": "movie", "itemId": "m1" },
        "snapshot": { "title": "Movie One", "contentType": "movie" },
    });
    if let Some(t) = viewed_at {
        v["viewedAt"] = json!(t);
    }
    v
}

#[tokio::test]
async fn recent_add_restores_the_original_viewed_at() {
    let env = env().await;
    bare_source(&env.state, "s-recent").await;
    let r = iptv_core::rpc::build_router();
    let st = env.state.clone();

    r.dispatch(st.clone(), "recent.add", add_args(None))
        .await
        .unwrap();
    let list = r
        .dispatch(st.clone(), "recent.list", json!({ "sourceId": "s-recent" }))
        .await
        .unwrap();
    let original = list[0]["viewedAt"].as_str().unwrap().to_string();

    // Undo: remove, then add back with the original date.
    r.dispatch(
        st.clone(),
        "recent.remove",
        json!({ "ref": add_args(None)["ref"] }),
    )
    .await
    .unwrap();
    r.dispatch(
        st.clone(),
        "recent.add",
        add_args(Some("2026-01-02T03:04:05+02:00")),
    )
    .await
    .unwrap();
    let list = r
        .dispatch(st.clone(), "recent.list", json!({ "sourceId": "s-recent" }))
        .await
        .unwrap();
    // Normalized to UTC with milliseconds.
    assert_eq!(list[0]["viewedAt"], "2026-01-02T01:04:05.000Z");

    r.dispatch(st.clone(), "recent.add", add_args(Some(&original)))
        .await
        .unwrap();
    let list = r
        .dispatch(st.clone(), "recent.list", json!({ "sourceId": "s-recent" }))
        .await
        .unwrap();
    assert_eq!(list[0]["viewedAt"], original.as_str());
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn recent_add_rejects_a_garbage_viewed_at() {
    let env = env().await;
    bare_source(&env.state, "s-recent").await;
    let r = iptv_core::rpc::build_router();
    for bad in [
        "yesterday",
        "",
        "2026-13-01T00:00:00Z",
        "2026-01-01 10:00:00",
        "2026-01-01T10:00:00",  // no offset
        "9999-01-01T00:00:00Z", // future
    ] {
        let e = r
            .dispatch(env.state.clone(), "recent.add", add_args(Some(bad)))
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::Invalid, "{bad:?}: {e:?}");
        assert!(e.message.contains("viewedAt"), "{bad:?}: {e:?}");
    }
    // Wrong JSON type is invalid too.
    let mut v = add_args(None);
    v["viewedAt"] = json!(12);
    let e = r
        .dispatch(env.state.clone(), "recent.add", v)
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Invalid);
    // Nothing was written by the rejected calls.
    let list = r
        .dispatch(env.state.clone(), "recent.list", json!({}))
        .await
        .unwrap();
    assert_eq!(list, json!([]));
}

/// C12: an upstream HTTP 5xx is stored and reported as `server`, not
/// `network` (the host answered; it is busy or failing).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upstream_5xx_is_recorded_as_server() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let env = env().await;
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
                let _ = s.shutdown().await;
            });
        }
    });
    let err = sources::add(
        env.state.clone(),
        url_args(&format!("http://{addr}/list.m3u"), true),
    )
    .await
    .unwrap_err();
    assert_eq!(err.error.code(), RpcErrorCode::Server, "{:?}", err.error);
    let id = err.source_id.unwrap();
    let src = sources::get(&env.state, &id).await.unwrap();
    assert_eq!(src.last_error_code, Some(RpcErrorCode::Server));
    // Same text shape as every other kind: no "server: " prefix.
    let text = src.last_error.clone().unwrap_or_default();
    assert!(
        !text.starts_with("server:") && text.contains(": HTTP 503 "),
        "{text}"
    );
    assert_eq!(
        serde_json::to_value(&src).unwrap()["lastErrorCode"],
        "server"
    );
    let v = router()
        .dispatch(env.state.clone(), "sources.refreshAll", json!(null))
        .await
        .unwrap();
    assert_eq!(v["failed"][0]["code"], "server", "{v}");
    // The stored code reads back (not dropped as unknown).
    assert_eq!(RpcErrorCode::parse("server"), Some(RpcErrorCode::Server));
    assert_eq!(
        RpcErrorCode::parse("engine_missing"),
        Some(RpcErrorCode::EngineMissing)
    );
}
