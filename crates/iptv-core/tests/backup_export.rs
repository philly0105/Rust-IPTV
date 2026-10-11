//! `backup.export` with a desktop `path` (atomic write, server-mode and
//! data-dir refusals) and exports of large file playlists whose text lives in
//! `data_dir/playlists/<id>.m3u` instead of `m3u_raw.raw`.

use iptv_core::backup;
use iptv_core::error::RpcErrorCode;
use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, BroadcastSink};
use serde_json::{json, Value};
use std::sync::Arc;

async fn app(is_desktop: bool) -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = BroadcastSink::channel(1024);
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(sink), is_desktop)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    (dir, state)
}

fn router() -> RpcRouter {
    let mut r = RpcRouter::new();
    backup::rpc::register(&mut r);
    r
}

/// Inserts an m3u file source whose playlist text is stored on disk only
/// (`m3u_raw.raw = ''`), the way the m3u importer keeps playlists over 8 MB.
async fn add_disk_playlist(state: &Arc<AppState>, id: &str, text: &str) {
    let dir = state.data_dir.join("playlists");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{id}.m3u")), text).unwrap();
    let id = id.to_string();
    let cfg = json!({"origin": "file", "filePath": "C:/nowhere/big.m3u"}).to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources (id, kind, name, config_json) VALUES (?1, 'm3u', 'Big file', ?2)",
                rusqlite::params![id, cfg],
            )?;
            c.execute(
                "INSERT INTO m3u_raw (source_id, raw, sha256, fetched_at) VALUES (?1, '', 'abc', '2026-10-01T00:00:00Z')",
                [&id],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

async fn source_count(state: &Arc<AppState>) -> i64 {
    state
        .db_call(|c| Ok(c.query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))?))
        .await
        .unwrap()
}

fn leftovers(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect()
}

#[tokio::test]
async fn export_to_path_writes_the_file_atomically() {
    let (_dir, state) = app(true).await;
    add_disk_playlist(
        &state,
        "m3u-small",
        "#EXTM3U\n#EXTINF:-1,A\nhttp://127.0.0.1:9/a.ts\n",
    )
    .await;
    let out_dir = tempfile::tempdir().unwrap();
    let target = out_dir.path().join("my-backup.json");
    std::fs::write(&target, "old contents").unwrap();
    let r = router();

    let out = r
        .dispatch(
            state.clone(),
            "backup.export",
            json!({"includeSecrets": false, "path": target.to_string_lossy()}),
        )
        .await
        .unwrap_or_else(|e| panic!("{:?} {}", e.code, e.message));
    assert_eq!(out["json"], "");
    assert_eq!(out["fileName"], "my-backup.json");
    let saved = out["path"].as_str().unwrap();
    assert!(saved.ends_with("my-backup.json"), "{saved}");

    // Replaced the existing file with a full manifest; no temp file left.
    let m: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
    assert_eq!(m["kind"], "iptvnator-playlist-backup");
    assert_eq!(m["playlists"].as_array().unwrap().len(), 1);
    assert!(leftovers(out_dir.path()).is_empty());

    // Without a path the desktop build still gets the JSON back.
    let out = r
        .dispatch(
            state.clone(),
            "backup.export",
            json!({"includeSecrets": false}),
        )
        .await
        .unwrap();
    assert!(out["json"]
        .as_str()
        .unwrap()
        .contains("iptvnator-playlist-backup"));
    assert!(out.get("path").is_none());
}

#[tokio::test]
async fn export_to_path_is_refused_where_it_must_be() {
    let r = router();
    let out_dir = tempfile::tempdir().unwrap();
    let target = out_dir.path().join("b.json");

    // Server mode: Unsupported, nothing written.
    let (_d1, server) = app(false).await;
    let e = r
        .dispatch(
            server.clone(),
            "backup.export",
            json!({"includeSecrets": false, "path": target.to_string_lossy()}),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, RpcErrorCode::Unsupported, "{}", e.message);
    assert!(!target.exists());
    // ...while the plain export keeps working.
    let out = r
        .dispatch(server, "backup.export", json!({"includeSecrets": false}))
        .await
        .unwrap();
    assert!(!out["json"].as_str().unwrap().is_empty());

    let (_d2, desktop) = app(true).await;
    let inside = desktop.data_dir.join("backup.json");
    let inside_dotdot = desktop
        .data_dir
        .join("playlists")
        .join("..")
        .join("sneaky.json");
    std::fs::create_dir_all(desktop.data_dir.join("playlists")).unwrap();
    let missing_dir = out_dir.path().join("no-such-dir").join("b.json");
    for (path, what) in [
        (inside.to_string_lossy().into_owned(), "inside data dir"),
        (
            inside_dotdot.to_string_lossy().into_owned(),
            "data dir via ..",
        ),
        ("relative/b.json".to_string(), "relative"),
        ("".to_string(), "empty"),
        (missing_dir.to_string_lossy().into_owned(), "missing folder"),
        (out_dir.path().to_string_lossy().into_owned(), "a folder"),
    ] {
        let e = r
            .dispatch(
                desktop.clone(),
                "backup.export",
                json!({"includeSecrets": true, "path": path}),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::Invalid, "{what}: {}", e.message);
    }
    assert!(!inside.exists());
    assert!(!desktop.data_dir.join("sneaky.json").exists());
}

/// A playlist over 8 MB has an empty `m3u_raw.raw`; the export must carry the
/// on-disk text, and a merge import of that export must match the existing
/// source by its text fingerprint instead of creating a duplicate.
#[tokio::test]
async fn large_disk_playlist_exports_its_text_and_fingerprints() {
    let (_dir, state) = app(true).await;
    // A long comment line keeps the file over 8 MB while the catalog stays tiny.
    let text = format!(
        "#EXTM3U\n# {}\n#EXTINF:-1 group-title=\"News\",Big One\nhttp://127.0.0.1:9/big1.ts\n",
        "x".repeat(9 * 1024 * 1024)
    );
    assert!(text.len() > 8 * 1024 * 1024);
    add_disk_playlist(&state, "m3u-big", &text).await;
    let r = router();

    let out = r
        .dispatch(
            state.clone(),
            "backup.export",
            json!({"includeSecrets": false}),
        )
        .await
        .unwrap();
    let json_text = out["json"].as_str().unwrap().to_string();
    let m: Value = serde_json::from_str(&json_text).unwrap();
    let entry = &m["playlists"][0];
    assert_eq!(entry["source"]["kind"], "file");
    assert_eq!(entry["source"]["rawM3u"].as_str().unwrap(), text);

    let report = r
        .dispatch(
            state.clone(),
            "backup.import",
            json!({"json": json_text, "mode": "merge"}),
        )
        .await
        .unwrap_or_else(|e| panic!("{:?} {}", e.code, e.message));
    assert_eq!(report["imported"], 1, "{report}");
    assert_eq!(
        source_count(&state).await,
        1,
        "merge created a duplicate: {report}"
    );
}
