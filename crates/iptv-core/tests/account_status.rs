//! Cached subscription status (`account.*`) against the mock Xtream panel's
//! account modes: expiry, trial, full connections, the sync refreshing the
//! cache, and cleanup on remove.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::account;
use iptv_core::model::{SourceKind, XtreamSourceConfig};
use iptv_core::rpc::RpcRouter;
use iptv_core::sources::{self, AddSourceArgs};
use serde_json::json;
use support::*;

fn xtream_args(server: &str, user: &str) -> AddSourceArgs {
    let cfg: XtreamSourceConfig = serde_json::from_value(json!({
        "serverUrl": server,
        "username": user,
        "password": iptv_mock::xtream::PASSWORD,
    }))
    .unwrap();
    AddSourceArgs {
        kind: SourceKind::Xtream,
        name: user.into(),
        auto_refresh: None,
        m3u: None,
        xtream: Some(cfg),
        stalker: None,
    }
}

/// How many Xtream API calls the mock has served so far.
async fn api_requests(mock: &iptv_fixtures::MockHandle) -> u64 {
    let v: serde_json::Value = reqwest::get(mock.url("/__mock/stats"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["requests"]["/xtream/player_api.php"]
        .as_u64()
        .unwrap_or(0)
}

fn account_router() -> RpcRouter {
    let mut r = router();
    account::rpc::register(&mut r);
    r
}

#[tokio::test]
async fn sync_caches_the_account_and_status_all_reads_it() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    let server = mock.url("/xtream");

    let full = sources::add(
        env.state.clone(),
        xtream_args(&server, iptv_mock::xtream::USER_FULL),
    )
    .await
    .map_err(|e| e.error)
    .unwrap();
    let expiring = sources::add(
        env.state.clone(),
        xtream_args(&server, iptv_mock::xtream::USER_EXPIRING),
    )
    .await
    .map_err(|e| e.error)
    .unwrap();
    let m3u = add_text(&env.state, "list", "#EXTM3U\n#EXTINF:-1,One\nhttp://x/1\n").await;

    let r = account_router();
    let all = r
        .dispatch(env.state.clone(), "account.statusAll", json!(null))
        .await
        .unwrap();
    let all = all.as_array().unwrap();
    assert_eq!(all.len(), 2, "m3u sources have no account: {all:?}");
    let f = all
        .iter()
        .find(|s| s["sourceId"] == full.id.as_str())
        .unwrap();
    assert_eq!(
        (f["activeCons"].as_i64(), f["maxConnections"].as_i64()),
        (Some(2), Some(2))
    );
    assert_eq!(f["kind"], "xtream");
    let e = all
        .iter()
        .find(|s| s["sourceId"] == expiring.id.as_str())
        .unwrap();
    assert_eq!(e["isTrial"], true);
    let exp = chrono::DateTime::parse_from_rfc3339(e["expDate"].as_str().unwrap()).unwrap();
    let days = (exp.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours();
    assert!(
        (70..=73).contains(&days),
        "expires in about 3 days, got {days} h"
    );
    // Nothing secret in the cached status.
    let text = serde_json::to_string(&all).unwrap();
    assert!(!text.contains(iptv_mock::xtream::PASSWORD), "{text}");

    // m3u: null, unknown source: not found.
    let v = r
        .dispatch(
            env.state.clone(),
            "account.status",
            json!({ "sourceId": m3u.id }),
        )
        .await
        .unwrap();
    assert!(v.is_null());
    assert!(r
        .dispatch(
            env.state.clone(),
            "account.status",
            json!({ "sourceId": "nope" })
        )
        .await
        .is_err());

    // A forced check right after the sync reuses it (rate limit).
    let before = api_requests(&mock).await;
    let v = r
        .dispatch(
            env.state.clone(),
            "account.status",
            json!({ "sourceId": full.id, "refresh": true }),
        )
        .await
        .unwrap();
    assert_eq!(v["activeCons"], 2);
    let after = api_requests(&mock).await;
    assert_eq!(before, after, "no new request within the rate limit");

    // Remove drops the cached status.
    sources::remove(&env.state, &full.id).await.unwrap();
    let id = full.id.clone();
    let left = env
        .state
        .db_call(move |c| account::load(c, &id))
        .await
        .unwrap();
    assert!(left.is_none());
}

#[tokio::test]
async fn an_expired_account_still_imports_and_reports_expired() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    let src = sources::add(
        env.state.clone(),
        xtream_args(&mock.url("/xtream"), iptv_mock::xtream::USER_EXPIRED),
    )
    .await
    .map_err(|e| e.error)
    .unwrap();
    let s = account::status(&env.state, &src.id, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.status.as_deref(), Some("Expired"));
    let exp = chrono::DateTime::parse_from_rfc3339(s.exp_date.as_deref().unwrap()).unwrap();
    assert!(exp.with_timezone(&chrono::Utc) < chrono::Utc::now());
    assert!(!s.connections_full());
}

#[tokio::test]
async fn a_failed_check_keeps_the_last_good_fields() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    let src = sources::add(
        env.state.clone(),
        xtream_args(&mock.url("/xtream"), iptv_mock::xtream::USER_FULL),
    )
    .await
    .map_err(|e| e.error)
    .unwrap();
    // Age the cached check past the rate limit, then take the panel away.
    let id = src.id.clone();
    env.state
        .db_call(move |c| {
            let mut s = account::load(c, &id)?.unwrap();
            s.checked_at = "2020-01-01T00:00:00Z".into();
            account::save(c, &s)?;
            Ok(())
        })
        .await
        .unwrap();
    drop(mock);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let s = account::status(&env.state, &src.id, true)
        .await
        .unwrap()
        .unwrap();
    assert!(s.error.is_some(), "{s:?}");
    assert_eq!(s.active_cons, Some(2), "last good values kept");
    assert_ne!(s.checked_at, "2020-01-01T00:00:00Z");
    assert!(!s
        .error
        .as_deref()
        .unwrap()
        .contains(iptv_mock::xtream::PASSWORD));

    // The forced check answers before its row is stored (R4-1); the next
    // one reuses it without waiting for that row, which lands after.
    let again = account::status(&env.state, &src.id, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again, s);
    wait_stored(&env.state, &s).await;
}

/// Waits (up to 5 s) for the background save of `expected` to land.
async fn wait_stored(
    state: &std::sync::Arc<iptv_core::AppState>,
    expected: &account::AccountStatus,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let id = expected.source_id.clone();
        let row = state
            .db_read_call(move |c| account::load(c, &id))
            .await
            .unwrap();
        if row.as_ref() == Some(expected) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "never stored: {expected:?}, row {row:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// R4-1 follow-up: a playback failure makes two forced checks of one source
/// (smart reconnect, then the error screen) a few seconds apart. With
/// another source's import save holding the write lock, the first check
/// answers and its row waits for the commit; the second used to wait for
/// the source's lock, held until that row was stored, so "connection limit
/// reached" still came once the save committed. It reuses the first answer
/// now, at once and without a second panel request.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_forced_check_does_not_wait_for_the_first_ones_row() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    iptv_core::xtream::init(env.state.clone()).await.unwrap();
    let cfg = json!({
        "serverUrl": mock.url("/xtream"),
        "username": iptv_mock::xtream::USER_FULL,
        "password": iptv_mock::xtream::PASSWORD,
    })
    .to_string();
    env.state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('x', 'xtream', 'Panel', ?1)",
                [cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let r = account_router();
    let before = api_requests(&mock).await;

    // Another source's import save holds the write lock.
    let holder = rusqlite::Connection::open(env.state.db_path()).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let long = iptv_core::db::long_write();

    let mut answers = Vec::new();
    for which in ["reconnect", "error screen"] {
        let t = std::time::Instant::now();
        let v = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            r.dispatch(
                env.state.clone(),
                "account.status",
                json!({ "sourceId": "x", "refresh": true }),
            ),
        )
        .await
        .unwrap_or_else(|_| panic!("the {which} check waited for the save"))
        .unwrap();
        eprintln!("account_status: {which} check in {:?}", t.elapsed());
        assert_eq!(
            (v["activeCons"].as_i64(), v["maxConnections"].as_i64()),
            (Some(2), Some(2)),
            "{v}"
        );
        answers.push(v);
    }
    assert_eq!(answers[0], answers[1], "the second check reuses the first");
    assert_eq!(
        api_requests(&mock).await,
        before + 1,
        "one panel request for both checks"
    );
    let stored = env
        .state
        .db_read_call(|c| account::load(c, "x"))
        .await
        .unwrap();
    assert_eq!(stored, None, "the row waits for the save's commit");

    // The row lands once the save commits.
    holder.execute_batch("COMMIT").unwrap();
    let answer: account::AccountStatus = serde_json::from_value(answers[0].clone()).unwrap();
    wait_stored(&env.state, &answer).await;
    drop(long);
}

/// Portal requests the mock Stalker portal has served so far.
async fn portal_requests(mock: &iptv_fixtures::MockHandle) -> u64 {
    let v: serde_json::Value = reqwest::get(mock.url("/__mock/stats"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["requests"]["/stalker/portal.php"].as_u64().unwrap_or(0)
}

#[tokio::test]
async fn a_forced_stalker_check_returns_the_cache_without_portal_traffic() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    iptv_core::stalker::init(env.state.clone()).await.unwrap();
    let cfg = json!({
        "portalUrl": mock.url("/stalker/portal.php"),
        "macAddress": "00:1A:79:00:00:01",
    })
    .to_string();
    env.state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES ('stk', 'stalker', 'Portal', ?1)",
                [cfg],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let before = portal_requests(&mock).await;
    let s = account::status(&env.state, "stk", true).await.unwrap();
    assert!(s.is_none(), "nothing cached yet: {s:?}");
    assert_eq!(
        portal_requests(&mock).await,
        before,
        "the player's forced check never reaches a Stalker portal"
    );
}
