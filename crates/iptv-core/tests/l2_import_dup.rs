//! L1-sources-home-4: adding a source whose address another source already
//! uses is refused with `conflict` naming the existing source (no second
//! copy, no import), and `sources.update` cannot move a source onto another
//! source's address. Pasted text is never a duplicate.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::model::{ImportSummary, M3uOrigin, M3uSourceConfig, Source, SourceKind};
use iptv_core::sources::{self, store, store::SourceConfig, AddError, Importer, SourcePatch};
use iptv_core::{AppState, CoreError, CoreResult, RpcErrorCode};
use serde_json::{json, Value};
use std::sync::Arc;
use support::{file_args, url_args, Env};

const SAMPLE: &str = "#EXTM3U\n#EXTINF:-1 group-title=\"News\",One\nhttp://h/1\n#EXTINF:-1 group-title=\"News\",Two\nhttp://h/2\n";

/// Importer that fetches nothing, so addresses need not exist.
struct Noop(SourceKind);

#[async_trait::async_trait]
impl Importer for Noop {
    fn kind(&self) -> SourceKind {
        self.0
    }
    async fn import(&self, _state: Arc<AppState>, _source: &Source) -> CoreResult<ImportSummary> {
        Ok(ImportSummary::default())
    }
}

async fn noop_env() -> Env {
    let env = support::env().await;
    for kind in [SourceKind::M3u, SourceKind::Xtream, SourceKind::Stalker] {
        sources::register_importer(&env.state, Arc::new(Noop(kind)));
    }
    env
}

fn m3u_url(url: &str) -> Value {
    json!({ "kind": "m3u", "m3u": { "origin": "url", "url": url } })
}

fn xtream(server: &str, user: &str, pass: &str) -> Value {
    json!({ "kind": "xtream", "xtream": { "serverUrl": server, "username": user, "password": pass } })
}

fn stalker(portal: &str, mac: &str) -> Value {
    json!({ "kind": "stalker", "stalker": { "portalUrl": portal, "macAddress": mac } })
}

async fn add(st: &Arc<AppState>, args: Value) -> Result<Source, AddError> {
    sources::add(st.clone(), serde_json::from_value(args).unwrap()).await
}

async fn added(st: &Arc<AppState>, args: Value) -> Source {
    add(st, args.clone())
        .await
        .unwrap_or_else(|e| panic!("{args} is not a duplicate: {:?}", e.error))
}

/// The id a refused duplicate names; panics unless it is a `Conflict`.
fn conflict_id(r: Result<Source, AddError>) -> String {
    let e = r.expect_err("a duplicate is refused");
    assert!(matches!(e.error, CoreError::Conflict(_)), "{:?}", e.error);
    assert_eq!(e.source_id, None, "no source was created");
    e.existing_source_id
        .expect("the error names the existing source")
}

fn patch(v: Value) -> SourcePatch {
    serde_json::from_value(v).unwrap()
}

async fn count(st: &Arc<AppState>) -> usize {
    sources::list(st).await.unwrap().len()
}

/// The finding's scenario with the real importer: the same playlist URL a
/// second time made a second source with duplicate channels.
#[tokio::test]
async fn same_playlist_url_twice_is_refused_with_the_existing_id() {
    let env = support::env().await;
    let st = env.state.clone();
    let stub = support::stub(SAMPLE).await;
    let first = sources::add(st.clone(), url_args(&stub.url(), false))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(first.channel_count, 2);
    let hits = stub.hits();
    let again = sources::add(st.clone(), url_args(&stub.url(), false)).await;
    assert_eq!(conflict_id(again), first.id);
    assert_eq!(stub.hits(), hits, "a refused add fetches nothing");
    let listed = sources::list(&st).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].channel_count, 2);
}

#[tokio::test]
async fn rpc_conflict_carries_only_the_existing_source_id() {
    let env = noop_env().await;
    let st = env.state.clone();
    let r = support::router();
    let url = "http://localhost:9/sample.m3u";
    let a = r
        .dispatch(st.clone(), "sources.add", m3u_url(url))
        .await
        .unwrap();
    let err = r
        .dispatch(st.clone(), "sources.add", m3u_url(url))
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Conflict);
    // Not `sourceId`: the add dialog discards the source that names.
    assert_eq!(err.details, Some(json!({ "existingSourceId": a["id"] })));
    assert!(!err.retryable);
    let msg = err.message.to_lowercase();
    assert!(msg.contains("already exists"), "{msg}");
    assert!(msg.contains("sample"), "names the existing source: {msg}");
    // The UI reads these words as a cancelled import.
    assert!(
        !msg.contains("cancel") && !msg.contains("import stopped"),
        "{msg}"
    );
    assert_eq!(count(&st).await, 1);
}

#[tokio::test]
async fn playlist_url_match_ignores_spaces_scheme_host_case_and_trailing_slash() {
    let env = noop_env().await;
    let st = env.state.clone();
    let a = added(&st, m3u_url("http://localhost:9/lists/tv.m3u?user=a")).await;
    for same in [
        "http://localhost:9/lists/tv.m3u?user=a",
        "  http://localhost:9/lists/tv.m3u?user=a  ",
        "HTTP://LocalHost:9/lists/tv.m3u?user=a",
        "http://localhost:9/lists/tv.m3u/?user=a",
    ] {
        assert_eq!(conflict_id(add(&st, m3u_url(same)).await), a.id, "{same}");
    }
    // Another path, path case or query is another playlist.
    for other in [
        "http://localhost:9/lists/tv2.m3u?user=a",
        "http://localhost:9/LISTS/tv.m3u?user=a",
        "http://localhost:9/lists/tv.m3u?user=b",
        "http://localhost:10/lists/tv.m3u?user=a",
    ] {
        added(&st, m3u_url(other)).await;
    }
    assert_eq!(count(&st).await, 5);
}

#[tokio::test]
async fn pasted_text_is_never_a_duplicate() {
    let env = support::env().await;
    let st = env.state.clone();
    support::add_text(&st, "A", SAMPLE).await;
    support::add_text(&st, "B", SAMPLE).await;
    assert_eq!(count(&st).await, 2);
}

#[tokio::test]
async fn same_playlist_file_is_refused() {
    let env = noop_env().await;
    let st = env.state.clone();
    let path = env.dir.path().join("Local List.m3u");
    std::fs::write(&path, SAMPLE).unwrap();
    let a = sources::add(st.clone(), file_args(&path))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(
        conflict_id(sources::add(st.clone(), file_args(&path)).await),
        a.id
    );
    if cfg!(windows) {
        // One file, written another way.
        let shouty = path.to_string_lossy().to_uppercase().replace('\\', "/");
        let args = json!({ "kind": "m3u", "m3u": { "origin": "file", "filePath": shouty } });
        assert_eq!(conflict_id(add(&st, args).await), a.id);
    }
    // A copy elsewhere is another source, even with the same lines.
    let copy = env.dir.path().join("copy.m3u");
    std::fs::write(&copy, SAMPLE).unwrap();
    sources::add(st.clone(), file_args(&copy))
        .await
        .map_err(|e| e.error)
        .unwrap();
    assert_eq!(count(&st).await, 2);
}

#[tokio::test]
async fn xtream_same_server_and_username_is_refused() {
    let env = noop_env().await;
    let st = env.state.clone();
    let a = added(&st, xtream("http://localhost:9/panel", "demo", "secret")).await;
    for (server, user, pass) in [
        ("http://localhost:9/panel", "demo", "secret"),
        ("http://localhost:9/panel/", "demo", "another password"),
        (
            "HTTP://LOCALHOST:9/panel/player_api.php",
            " demo ",
            "secret",
        ),
    ] {
        let r = add(&st, xtream(server, user, pass)).await;
        assert_eq!(conflict_id(r), a.id, "{server} {user}");
    }
    // Another account on the panel, or the account on another panel.
    added(&st, xtream("http://localhost:9/panel", "other", "secret")).await;
    added(&st, xtream("http://localhost:10/panel", "demo", "secret")).await;
    assert_eq!(count(&st).await, 3);
}

#[tokio::test]
async fn stalker_same_portal_and_mac_is_refused() {
    let env = noop_env().await;
    let st = env.state.clone();
    let portal = "http://127.0.0.1:9/stalker_portal/c/";
    let a = added(&st, stalker(portal, "00:1A:79:00:00:01")).await;
    for (p, mac) in [
        (portal, "00:1A:79:00:00:01"),
        ("http://127.0.0.1:9/stalker_portal/c", "00-1a-79-00-00-01"),
    ] {
        assert_eq!(
            conflict_id(add(&st, stalker(p, mac)).await),
            a.id,
            "{p} {mac}"
        );
    }
    added(&st, stalker(portal, "00:1A:79:00:00:02")).await;
    assert_eq!(count(&st).await, 2);
}

#[tokio::test]
async fn update_onto_another_sources_address_is_refused() {
    let env = noop_env().await;
    let st = env.state.clone();
    let a = added(&st, m3u_url("http://localhost:9/a.m3u")).await;
    let b = added(&st, m3u_url("http://localhost:9/b.m3u")).await;
    let err = sources::update(
        &st,
        &b.id,
        patch(
            json!({ "name": "B2", "m3u": { "origin": "url", "url": "HTTP://LOCALHOST:9/a.m3u " } }),
        ),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CoreError::Conflict(_)), "{err:?}");
    assert!(
        sources::error_text(&err).contains(&format!("\"{}\"", a.name)),
        "names the other source: {err:?}"
    );
    let kept = sources::get(&st, &b.id).await.unwrap();
    assert_eq!(kept.name, b.name, "nothing of the patch is applied");
    assert_eq!(
        kept.m3u.unwrap().url.as_deref(),
        Some("http://localhost:9/b.m3u")
    );

    // Its own address (with another catch-up setting), or a free one, is fine.
    sources::update(
        &st,
        &b.id,
        patch(json!({ "m3u": { "origin": "url", "url": "http://localhost:9/b.m3u", "catchup": { "type": "none" } } })),
    )
    .await
    .unwrap();
    sources::update(
        &st,
        &b.id,
        patch(json!({ "m3u": { "origin": "url", "url": "http://localhost:9/c.m3u" } })),
    )
    .await
    .unwrap();

    // Over RPC, for Xtream: another source's account.
    let mut args = xtream("http://localhost:9/panel", "demo", "secret");
    args["name"] = json!("Panel X");
    let x = added(&st, args).await;
    let y = added(&st, xtream("http://localhost:9/panel", "other", "secret")).await;
    let err = support::router()
        .dispatch(
            st.clone(),
            "sources.update",
            json!({ "id": y.id, "patch": { "xtream": { "serverUrl": "http://localhost:9/panel/", "username": "demo", "password": "x" } } }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, RpcErrorCode::Conflict);
    assert_eq!(x.name, "Panel X");
    assert!(err.message.contains("\"Panel X\""), "{}", err.message);
    let kept = sources::get(&st, &y.id).await.unwrap();
    assert_eq!(kept.xtream.unwrap().username, "other");
}

/// Rows that share an address from before the check (or from a backup) stay
/// editable as long as the edit does not move them.
#[tokio::test]
async fn existing_duplicates_stay_editable() {
    let env = noop_env().await;
    let st = env.state.clone();
    st.db_call(|c| {
        let cfg = SourceConfig::M3u(M3uSourceConfig {
            origin: M3uOrigin::Url,
            url: Some("http://localhost:9/same.m3u".into()),
            file_path: None,
            headers: Default::default(),
            catchup: None,
        });
        store::insert(c, "one", "One", false, &cfg, None)?;
        store::insert(c, "two", "Two", false, &cfg, None)
    })
    .await
    .unwrap();
    let updated = sources::update(
        &st,
        "two",
        patch(json!({ "name": "Two b", "m3u": { "origin": "url", "url": "http://localhost:9/same.m3u", "catchup": { "type": "none" } } })),
    )
    .await
    .unwrap();
    assert_eq!(updated.name, "Two b");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_adds_of_one_address_create_one_source() {
    let env = noop_env().await;
    let st = env.state.clone();
    let url = "http://localhost:9/race.m3u";
    let (x, y) = tokio::join!(add(&st, m3u_url(url)), add(&st, m3u_url(url)));
    assert_eq!(
        [x.is_ok(), y.is_ok()].iter().filter(|ok| **ok).count(),
        1,
        "exactly one add wins"
    );
    let winner = x.as_ref().or(y.as_ref()).unwrap().id.clone();
    let loser = if x.is_err() { x } else { y };
    assert_eq!(conflict_id(loser), winner);
    assert_eq!(count(&st).await, 1);
}
