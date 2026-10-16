//! L2-settings-3 and L2-settings-7: merging a backup into existing sources.
//!
//! - A merge keeps the existing source's name, auto refresh and config; the
//!   backup only fills what the source lacks.
//! - A merge into a source that already holds its catalog, with nothing new
//!   in its config, does not import the catalog again.
//! - `background: true` returns before the catalogs that must load have
//!   loaded; each source's favorites follow its catalog.

use iptv_core::model::{ImportSummary, Source, SourceKind};
use iptv_core::rpc::RpcRouter;
use iptv_core::sources::{register_importer, Importer};
use iptv_core::{AppEvent, AppState, BroadcastSink, CoreResult};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};

const M3U: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"news1\" group-title=\"News\",News One\nhttp://127.0.0.1:9/live/news1.ts\n\
#EXTINF:-1 tvg-id=\"sport1\" group-title=\"Sports\",Sport One\nhttp://127.0.0.1:9/live/sport1.ts\n";

const OTHER_M3U: &str = "#EXTM3U\n\
#EXTINF:-1 tvg-id=\"film1\" group-title=\"Movies\",Film One\nhttp://127.0.0.1:9/live/film1.ts\n";

/// The real m3u importer, counted, and held while the gate is closed.
struct GatedM3u {
    runs: Arc<AtomicUsize>,
    open: watch::Receiver<bool>,
}

#[async_trait::async_trait]
impl Importer for GatedM3u {
    fn kind(&self) -> SourceKind {
        SourceKind::M3u
    }
    async fn import(&self, state: Arc<AppState>, source: &Source) -> CoreResult<ImportSummary> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        let mut open = self.open.clone();
        let _ = open.wait_for(|o| *o).await;
        iptv_core::m3u::importer::import_source(state, source).await
    }
}

struct App {
    _dir: tempfile::TempDir,
    st: Arc<AppState>,
    r: RpcRouter,
    runs: Arc<AtomicUsize>,
    gate: watch::Sender<bool>,
    events: broadcast::Receiver<AppEvent>,
}

async fn app() -> App {
    let dir = tempfile::tempdir().unwrap();
    let (sink, events) = BroadcastSink::channel(4096);
    let st = AppState::new(dir.path().to_path_buf(), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(st.clone()).await.unwrap();
    let runs = Arc::new(AtomicUsize::new(0));
    let (gate, open) = watch::channel(true);
    register_importer(
        &st,
        Arc::new(GatedM3u {
            runs: runs.clone(),
            open,
        }),
    );
    let mut r = RpcRouter::new();
    iptv_core::backup::rpc::register(&mut r);
    App {
        _dir: dir,
        st,
        r,
        runs,
        gate,
        events,
    }
}

/// One m3u playlist with a favorite. `url` makes it a URL source.
fn playlist(id: &str, title: &str, url: &str, raw: &str, favorite: &str) -> Value {
    json!({
        "portalType": "m3u",
        "exportedId": id,
        "title": title,
        "autoRefresh": true,
        "position": 0,
        "source": { "kind": "url", "url": url, "rawM3u": raw, "userAgent": "Backup/1" },
        "userState": { "favorites": [favorite] }
    })
}

fn manifest(playlists: Vec<Value>) -> String {
    json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "exportedAt": "2026-10-01T12:00:00.000Z",
        "includeSecrets": true,
        "settings": { "epgUrls": [] },
        "playlists": playlists
    })
    .to_string()
}

async fn import(a: &App, json: &str, background: bool) -> Value {
    a.r.dispatch(
        a.st.clone(),
        "backup.import",
        json!({ "json": json, "mode": "merge", "background": background }),
    )
    .await
    .unwrap_or_else(|e| panic!("backup.import failed: {}", e.message))
}

/// (name, auto_refresh, config_json) of source `id`.
async fn row(st: &AppState, id: &str) -> (String, bool, Value) {
    let id = id.to_string();
    st.db_call(move |c| {
        Ok(c.query_row(
            "SELECT name, auto_refresh, config_json FROM sources WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? != 0,
                    serde_json::from_str(&r.get::<_, String>(2)?).unwrap(),
                ))
            },
        )?)
    })
    .await
    .unwrap()
}

async fn count(st: &AppState, sql: &'static str, id: &str) -> i64 {
    let id = id.to_string();
    st.db_call(move |c| Ok(c.query_row(sql, [id], |r| r.get(0))?))
        .await
        .unwrap()
}

async fn favorites(st: &AppState, id: &str) -> i64 {
    count(
        st,
        "SELECT COUNT(*) FROM favorites WHERE source_id = ?1",
        id,
    )
    .await
}

async fn items(st: &AppState, id: &str) -> i64 {
    count(st, "SELECT COUNT(*) FROM items WHERE source_id = ?1", id).await
}

/// L2-settings-7: renaming a source, turning off its auto refresh and
/// setting its own user agent, then merging an older backup of it, keeps
/// all three. A blank the source has (here the catch-up override is absent
/// either way) is the only thing the backup may fill.
#[tokio::test]
async fn merging_an_older_backup_keeps_the_renamed_source() {
    let a = app().await;
    let url = "http://127.0.0.1:9/list.m3u";
    let backup = manifest(vec![playlist(
        "src-1",
        "Old name",
        url,
        M3U,
        "http://127.0.0.1:9/live/news1.ts",
    )]);
    import(&a, &backup, false).await;
    let (name, auto, _) = row(&a.st, "src-1").await;
    assert_eq!((name.as_str(), auto), ("Old name", true));

    a.st.db_call(|c| {
        c.execute(
            "UPDATE sources SET name = 'My name', auto_refresh = 0,
               config_json = json_set(config_json, '$.headers', json('{\"userAgent\":\"Mine/2\"}'))
             WHERE id = 'src-1'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let rep = import(&a, &backup, false).await;
    assert_eq!(rep["imported"], 1, "{rep}");
    let (name, auto, cfg) = row(&a.st, "src-1").await;
    assert_eq!(name, "My name", "the merge kept the user's name");
    assert!(!auto, "the merge kept the user's auto refresh");
    assert_eq!(cfg["headers"]["userAgent"], "Mine/2", "{cfg}");
    assert_eq!(cfg["origin"], "url", "{cfg}");
    assert_eq!(cfg["url"], url, "{cfg}");
}

/// L2-settings-7: a source without its own user agent takes the backup's.
#[tokio::test]
async fn merge_fills_only_what_the_source_lacks() {
    let a = app().await;
    let url = "http://127.0.0.1:9/list.m3u";
    let backup = manifest(vec![playlist(
        "src-1",
        "Name",
        url,
        M3U,
        "http://127.0.0.1:9/live/news1.ts",
    )]);
    import(&a, &backup, false).await;
    a.st.db_call(|c| {
        c.execute(
            "UPDATE sources SET config_json = json_set(config_json, '$.headers', json('{}'))
             WHERE id = 'src-1'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    import(&a, &backup, false).await;
    let (_, _, cfg) = row(&a.st, "src-1").await;
    assert_eq!(cfg["headers"]["userAgent"], "Backup/1", "{cfg}");
}

/// L2-settings-3: a merge into a source that already holds its catalog, with
/// the same connection, applies the user state without importing the
/// catalog again.
#[tokio::test]
async fn merge_into_a_loaded_source_skips_the_catalog_import() {
    let a = app().await;
    let url = "http://127.0.0.1:9/list.m3u";
    let first = manifest(vec![playlist(
        "src-1",
        "Name",
        url,
        M3U,
        "http://127.0.0.1:9/live/news1.ts",
    )]);
    import(&a, &first, false).await;
    assert_eq!(a.runs.load(Ordering::SeqCst), 1);
    assert_eq!(items(&a.st, "src-1").await, 2);
    assert_eq!(favorites(&a.st, "src-1").await, 1);

    // Same URL (the fingerprint), another favorite.
    let second = manifest(vec![playlist(
        "src-1",
        "Name",
        url,
        M3U,
        "http://127.0.0.1:9/live/sport1.ts",
    )]);
    let rep = import(&a, &second, false).await;
    assert_eq!(rep["imported"], 1, "{rep}");
    assert_eq!(a.runs.load(Ordering::SeqCst), 1, "no second catalog import");
    assert_eq!(items(&a.st, "src-1").await, 2);
    assert_eq!(favorites(&a.st, "src-1").await, 2, "user state applied");

    // A merge that filled a blank the source had does load the catalog.
    a.st.db_call(|c| {
        c.execute(
            "UPDATE sources SET config_json = json_set(config_json, '$.headers', json('{}'))
             WHERE id = 'src-1'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    import(&a, &second, false).await;
    assert_eq!(
        a.runs.load(Ordering::SeqCst),
        2,
        "the changed config reloads"
    );
}

/// L2-settings-3: `background: true` returns while the new source's catalog
/// is still loading, names it in `refreshing`, and restores its favorites
/// once the catalog is in. A loaded source in the same backup is merged in
/// the call itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_merge_returns_before_the_catalog_loads() {
    let mut a = app().await;
    let loaded = playlist(
        "src-1",
        "Loaded",
        "http://127.0.0.1:9/list.m3u",
        M3U,
        "http://127.0.0.1:9/live/news1.ts",
    );
    import(&a, &manifest(vec![loaded.clone()]), false).await;
    assert_eq!(a.runs.load(Ordering::SeqCst), 1);

    a.gate.send_replace(false);
    while a.events.try_recv().is_ok() {}
    let fresh = playlist(
        "src-2",
        "Fresh",
        "http://127.0.0.1:9/other.m3u",
        OTHER_M3U,
        "http://127.0.0.1:9/live/film1.ts",
    );
    let rep = tokio::time::timeout(
        Duration::from_secs(20),
        import(&a, &manifest(vec![loaded, fresh]), true),
    )
    .await
    .expect("background import returned while the catalog is held");
    assert_eq!(rep["imported"], 2, "{rep}");
    assert_eq!(rep["refreshing"], json!(["Fresh"]), "{rep}");
    // The row exists, its catalog and favorites do not yet.
    let (name, _, cfg) = row(&a.st, "src-2").await;
    assert_eq!(name, "Fresh");
    assert_eq!(cfg["origin"], "url", "the row holds its real origin: {cfg}");
    assert_eq!(items(&a.st, "src-2").await, 0);
    assert_eq!(favorites(&a.st, "src-2").await, 0);

    a.gate.send_replace(true);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut done = false;
    while !done {
        match tokio::time::timeout_at(deadline, a.events.recv()).await {
            Ok(Ok(ev)) if ev.kind == "import.progress" => {
                done = ev.payload["sourceId"] == "src-2" && ev.payload["phase"] == "done";
            }
            Ok(Ok(_)) => {}
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
            other => panic!("no import.progress done for src-2: {other:?}"),
        }
    }
    // The parked favorites follow the catalog.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while favorites(&a.st, "src-2").await == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "favorites not restored after the background load"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(items(&a.st, "src-2").await, 1);
    assert_eq!(favorites(&a.st, "src-2").await, 1);
    assert_eq!(
        a.runs.load(Ordering::SeqCst),
        2,
        "only the new source loaded"
    );
    let parked = count(
        &a.st,
        "SELECT COUNT(*) FROM app_state WHERE key = 'backup_pending:' || ?1",
        "src-2",
    )
    .await;
    assert_eq!(parked, 0, "the parked state was applied");
}

/// Without `background` the report has no `refreshing` key (unchanged shape).
#[tokio::test]
async fn foreground_report_shape_is_unchanged() {
    let a = app().await;
    let rep = import(
        &a,
        &manifest(vec![playlist(
            "src-1",
            "Name",
            "http://127.0.0.1:9/list.m3u",
            M3U,
            "http://127.0.0.1:9/live/news1.ts",
        )]),
        false,
    )
    .await;
    assert!(rep.get("refreshing").is_none(), "{rep}");
    assert_eq!(favorites(&a.st, "src-1").await, 1);
}
