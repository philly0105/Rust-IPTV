//! Large pasted playlists live on disk (R7-r2 F2), and cached playlist copies
//! do not outlive their sources (R7-r2 F3).

#[path = "m3u_support.rs"]
mod support;

use iptv_core::sources;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Instant;
use support::*;

const MB: usize = 1024 * 1024;

/// A 20 MB playlist with 2000 channels (long comment lines pad it).
fn big_text() -> String {
    let pad = "x".repeat(11 * 1024);
    let mut s = String::with_capacity(23 * MB);
    s.push_str("#EXTM3U\n");
    for i in 0..2000 {
        s.push_str(&format!(
            "# {pad}\n#EXTINF:-1 group-title=\"G\",Channel {i}\nhttp://h.example/{i}.ts\n"
        ));
    }
    assert!(s.len() > 20 * MB);
    s
}

fn backup_router() -> iptv_core::rpc::RpcRouter {
    let mut r = router();
    iptv_core::backup::rpc::register(&mut r);
    r
}

fn cache(dir: &Path, id: &str) -> std::path::PathBuf {
    iptv_core::m3u::cached_playlist_path(dir, id)
}

async fn raw_row(state: &iptv_core::AppState, id: &str) -> (i64, String) {
    let id = id.to_string();
    state
        .db_call(move |c| {
            Ok(c.query_row(
                "SELECT length(raw), sha256 FROM m3u_raw WHERE source_id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .await
        .unwrap()
}

fn playlist_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir.join("playlists"))
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_paste_is_stored_on_disk_and_round_trips() {
    let env = env().await;
    let text = big_text();
    let src = add_text(&env.state, "Big paste", &text).await;
    assert_eq!(src.channel_count, 2000);

    // Stored on disk, raw empty, sha recorded.
    let (raw_len, sha) = raw_row(&env.state, &src.id).await;
    assert_eq!(
        raw_len, 0,
        "pasted text over 8 MB must not be stored inline"
    );
    assert_eq!(sha, hex::encode(Sha256::digest(text.as_bytes())));
    let path = cache(&env.state.data_dir, &src.id);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);

    // An unchanged refresh trusts the stored sha and reads nothing: even a
    // damaged copy is not looked at.
    std::fs::write(&path, "junk").unwrap();
    let started = Instant::now();
    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    let ms = started.elapsed().as_millis();
    assert_eq!(again.channel_count, 2000);
    assert!(again.last_error.is_none());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "junk");
    assert!(ms < 2_000, "unchanged refresh took {ms} ms");
    std::fs::write(&path, &text).unwrap();

    // m3u.raw and the backup export carry the on-disk text.
    let r = backup_router();
    let raw = r
        .dispatch(env.state.clone(), "m3u.raw", json!({"sourceId": src.id}))
        .await
        .unwrap();
    assert_eq!(raw["text"].as_str().map(str::len), Some(text.len()));
    let out = r
        .dispatch(
            env.state.clone(),
            "backup.export",
            json!({"includeSecrets": false}),
        )
        .await
        .unwrap();
    let json_text = out["json"].as_str().unwrap().to_string();
    let m: Value = serde_json::from_str(&json_text).unwrap();
    assert_eq!(m["playlists"][0]["source"]["kind"], "text");
    assert_eq!(
        m["playlists"][0]["source"]["rawM3u"].as_str().unwrap(),
        text
    );

    // Restoring that export elsewhere stores it on disk again and imports it.
    let other = support::env().await;
    let report = r
        .dispatch(
            other.state.clone(),
            "backup.import",
            json!({"json": json_text, "mode": "merge"}),
        )
        .await
        .unwrap_or_else(|e| panic!("{:?} {}", e.code, e.message));
    assert_eq!(report["imported"], 1, "{report}");
    let restored = sources::list(&other.state).await.unwrap();
    assert_eq!(restored.len(), 1);
    let rid = restored[0].id.clone();
    assert_eq!(restored[0].channel_count, 2000);
    assert_eq!(raw_row(&other.state, &rid).await.0, 0);
    assert_eq!(
        std::fs::read_to_string(cache(&other.state.data_dir, &rid)).unwrap(),
        text
    );

    // Remove deletes the copy.
    sources::remove(&env.state, &src.id).await.unwrap();
    assert!(!path.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn small_paste_stays_inline() {
    let env = env().await;
    let text = gen_m3u(10, 2);
    let src = add_text(&env.state, "Small", &text).await;
    assert_eq!(raw_row(&env.state, &src.id).await.0, text.len() as i64);
    assert!(!cache(&env.state.data_dir, &src.id).exists());
    // Unchanged refresh keeps the catalog.
    let again = sources::refresh(env.state.clone(), &src.id).await.unwrap();
    assert_eq!(again.channel_count, 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replace_import_and_boot_sweep_remove_orphan_copies() {
    let env = env().await;
    let big = add_text(&env.state, "Big", &big_text()).await;
    let big_path = cache(&env.state.data_dir, &big.id);
    assert!(big_path.is_file());

    // A small backup from elsewhere, imported in Replace mode.
    let small_env = env_small().await;
    let r = backup_router();
    let out = r
        .dispatch(
            small_env.state.clone(),
            "backup.export",
            json!({"includeSecrets": false}),
        )
        .await
        .unwrap();
    let report = r
        .dispatch(
            env.state.clone(),
            "backup.import",
            json!({"json": out["json"], "mode": "replace"}),
        )
        .await
        .unwrap_or_else(|e| panic!("{:?} {}", e.code, e.message));
    assert_eq!(report["imported"], 1, "{report}");
    assert!(
        !big_path.exists(),
        "replaced source kept its playlist copy: {:?}",
        playlist_files(&env.state.data_dir)
    );

    // Boot sweep: files without a source row and partial writes go; the
    // copy of a live source stays.
    let live = add_text(&env.state, "Big 2", &big_text()).await;
    let dir = env.state.data_dir.join("playlists");
    std::fs::write(dir.join("gone-source.m3u"), "#EXTM3U\n").unwrap();
    std::fs::write(dir.join("half.m3u.part"), "#EXTM3U\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "keep").unwrap();
    iptv_core::m3u::init(env.state.clone()).await.unwrap();
    let mut files = playlist_files(&env.state.data_dir);
    files.sort();
    assert_eq!(
        files,
        vec![format!("{}.m3u", live.id), "notes.txt".to_string()]
    );
}

/// Env with one small pasted playlist.
async fn env_small() -> Env {
    let env = env().await;
    add_text(&env.state, "Small", &gen_m3u(5, 1)).await;
    env
}
