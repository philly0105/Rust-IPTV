//! Sources (B1): what a successful refresh, a config change and a removal do
//! to state other modules park per source: parked backup user state (B2),
//! cached stalker sessions (B4), and stalker movie/series counts.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::backup::{self, ImportMode};
use iptv_core::model::{SourceKind, StalkerSourceConfig, XtreamSourceConfig};
use iptv_core::sources::{self, store, store::SourceConfig, SourcePatch};
use iptv_core::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use support::*;

async fn count(state: &AppState, sql: &'static str, id: &str) -> i64 {
    let id = id.to_string();
    state
        .db_call(move |c| Ok(c.query_row(sql, [&id], |r| r.get(0))?))
        .await
        .unwrap()
}

async fn put_app_state(state: &AppState, key: String) {
    state
        .db_call(move |c| {
            c.execute(
                "INSERT OR REPLACE INTO app_state (key, value) VALUES (?1, '{}')",
                [key],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

fn stalker_cfg(portal: &str, mac: &str) -> StalkerSourceConfig {
    serde_json::from_value(json!({ "portalUrl": portal, "macAddress": mac })).unwrap()
}

#[tokio::test]
async fn refresh_applies_user_state_parked_by_a_backup_import() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    let st = env.state.clone();
    iptv_core::xtream::init(st.clone()).await.unwrap();

    // The fixture's Xtream entry, exported without secrets: the import cannot
    // load the catalog, so its favorites and positions are parked.
    let mut manifest: Value = serde_json::from_str(
        &iptv_fixtures::backup_manifest_v1().replace(iptv_fixtures::MOCK_PLACEHOLDER, &mock.base),
    )
    .unwrap();
    let mut entry = manifest["playlists"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["portalType"] == "xtream")
        .unwrap()
        .clone();
    entry["connection"]
        .as_object_mut()
        .unwrap()
        .remove("password");
    manifest["includeSecrets"] = json!(false);
    manifest["playlists"] = json!([entry]);
    backup::import(&st, &manifest.to_string(), ImportMode::Merge)
        .await
        .unwrap();

    let src = sources::list(&st)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.kind == SourceKind::Xtream)
        .expect("xtream source imported");
    let id = src.id.clone();
    const FAVS: &str = "SELECT COUNT(*) FROM favorites WHERE source_id = ?1";
    const POS: &str = "SELECT COUNT(*) FROM playback_positions WHERE source_id = ?1";
    const PARKED: &str = "SELECT COUNT(*) FROM app_state WHERE key = 'backup_pending:' || ?1";
    assert_eq!(count(&st, FAVS, &id).await, 0);
    assert_eq!(count(&st, PARKED, &id).await, 1, "state parked");

    // The user enters the password and refreshes: the parked state lands now,
    // not on the next app start.
    let cfg = src.xtream.clone().unwrap();
    sources::update(
        &st,
        &id,
        SourcePatch {
            xtream: Some(XtreamSourceConfig {
                password: iptv_fixtures::XTREAM_PASSWORD.into(),
                ..cfg
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let refreshed = sources::refresh(st.clone(), &id).await.unwrap();
    assert!(refreshed.last_error.is_none(), "{:?}", refreshed.last_error);
    assert!(refreshed.channel_count > 0);
    assert_eq!(count(&st, FAVS, &id).await, 3, "favorites restored");
    assert_eq!(count(&st, POS, &id).await, 2, "positions restored");
    assert_eq!(count(&st, PARKED, &id).await, 0, "parked state consumed");

    // A second refresh has nothing left to apply and keeps the state.
    sources::refresh(st.clone(), &id).await.unwrap();
    assert_eq!(count(&st, FAVS, &id).await, 3);
    drop(mock);
}

#[tokio::test]
async fn config_change_and_removal_forget_cached_stalker_session() {
    let env = env().await;
    let st = env.state.clone();
    let id = "stk";
    let cfg = stalker_cfg("http://portal.test/c/", "00:1A:79:00:00:01");
    {
        let cfg = SourceConfig::Stalker(sources::validate_stalker(cfg.clone()).unwrap());
        st.db_call(move |c| store::insert(c, id, "Portal", false, &cfg, None))
            .await
            .unwrap();
    }
    const TOKEN: &str = "SELECT COUNT(*) FROM app_state WHERE key = 'stalker_token:' || ?1";
    put_app_state(&st, format!("stalker_token:{id}")).await;

    // Renames and an unchanged config keep the session.
    sources::update(
        &st,
        id,
        SourcePatch {
            name: Some("Renamed".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sources::update(
        &st,
        id,
        SourcePatch {
            stalker: Some(cfg.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        count(&st, TOKEN, id).await,
        1,
        "same config keeps the token"
    );

    // A new MAC (or URL / credentials) drops it.
    let updated = sources::update(
        &st,
        id,
        SourcePatch {
            stalker: Some(stalker_cfg("http://portal.test/c/", "00:1A:79:00:00:02")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        updated.stalker.unwrap().mac_address,
        "00:1A:79:00:00:02",
        "config saved"
    );
    assert_eq!(
        count(&st, TOKEN, id).await,
        0,
        "changed config drops the token"
    );

    // Removal drops the session and any parked backup state.
    put_app_state(&st, format!("stalker_token:{id}")).await;
    put_app_state(&st, format!("backup_pending:{id}")).await;
    put_app_state(&st, "stalker_token:other".into()).await;
    sources::remove(&st, id).await.unwrap();
    const PER_SOURCE: &str =
        "SELECT COUNT(*) FROM app_state WHERE key IN ('stalker_token:' || ?1, 'backup_pending:' || ?1)";
    assert_eq!(count(&st, PER_SOURCE, id).await, 0);
    assert_eq!(
        count(&st, TOKEN, "other").await,
        1,
        "other sources' sessions untouched"
    );
}

#[tokio::test]
async fn stalker_sources_list_portal_movie_and_series_totals() {
    let mock = iptv_fixtures::spawn_mock().await;
    let env = env().await;
    let st: Arc<AppState> = env.state.clone();
    iptv_core::stalker::init(st.clone()).await.unwrap();

    let added = sources::add(
        st.clone(),
        sources::AddSourceArgs {
            kind: SourceKind::Stalker,
            name: "Portal".into(),
            auto_refresh: None,
            m3u: None,
            xtream: None,
            stalker: Some(stalker_cfg(
                &mock.stalker_portal_url(),
                iptv_fixtures::STALKER_MAC,
            )),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("stalker add failed: {:?}", e.error));
    assert!(added.channel_count > 0, "channels counted");
    assert!(added.movie_count > 0, "portal movie total recorded");
    assert!(added.series_count > 0, "portal series total recorded");

    // A later catalog write (live channels only) keeps the portal totals.
    let id = added.id.clone();
    st.db_call(move |c| iptv_core::catalog::update_counts(c, &id))
        .await
        .unwrap();
    let listed = sources::list(&st)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.id == added.id)
        .unwrap();
    assert_eq!(
        (
            listed.channel_count,
            listed.movie_count,
            listed.series_count
        ),
        (added.channel_count, added.movie_count, added.series_count)
    );
    let counts = sources::counts(&st, &added.id).await.unwrap();
    assert_eq!(counts.movie_count, added.movie_count);
    drop(mock);
}
