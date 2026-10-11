//! Fix wave 3 (R7-r3 F4): a playlist server that drips one byte every few
//! seconds keeps resetting the body idle timeout. `sources.remove` and a
//! settings change in `sources.update` must cancel that import instead of
//! waiting behind its lock, and the cancelled import must delete its `.part`
//! download. (The minimum-throughput rule that also ends such a download is
//! covered by the unit test in `m3u/importer.rs`, with a short window.)

#[path = "m3u_support.rs"]
mod support;

use iptv_core::CoreError;
use std::path::Path;
use std::time::{Duration, Instant};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Serves a playlist head on `port`, then one byte every `gap` forever.
/// The fixed port (this fixer's assigned range) may be briefly busy, so the
/// bind is retried for a while.
async fn drip_server(port: u16, gap: Duration) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    let l = loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => break l,
            Err(e) if Instant::now() < deadline => {
                eprintln!("port {port} busy ({e}); retrying");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(e) => panic!("port {port} stayed busy: {e}"),
        }
    };
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/x-mpegurl\r\nContent-Length: 100000000\r\n\r\n#EXTM3U\n")
                    .await;
                loop {
                    tokio::time::sleep(gap).await;
                    if s.write_all(b"#").await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}/list.m3u")
}

fn part_files(data_dir: &Path) -> Vec<String> {
    std::fs::read_dir(data_dir.join("tmp"))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".part"))
                .collect()
        })
        .unwrap_or_default()
}

/// Starts `sources.add` for `url` in the background and waits until the
/// source is listed and its download has begun.
async fn add_in_background(
    env: &Env,
    url: &str,
) -> (
    String,
    tokio::task::JoinHandle<Result<iptv_core::model::Source, iptv_core::sources::AddError>>,
) {
    let st = env.state.clone();
    let args = url_args(url, false);
    let add = tokio::spawn(async move { iptv_core::sources::add(st, args).await });
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let listed = iptv_core::sources::list(&env.state).await.unwrap();
        if let Some(s) = listed.first() {
            if !part_files(env.dir.path()).is_empty() {
                return (s.id.clone(), add);
            }
        }
        assert!(Instant::now() < deadline, "the import never started");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn cancelled_add(
    add: tokio::task::JoinHandle<Result<iptv_core::model::Source, iptv_core::sources::AddError>>,
) {
    let result = tokio::time::timeout(Duration::from_secs(5), add)
        .await
        .expect("sources.add kept running after the cancel")
        .unwrap();
    let err = result.expect_err("a cancelled add fails").error;
    assert!(
        matches!(err, CoreError::Conflict(ref m) if m.contains("Refresh the source")),
        "{err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remove_cancels_a_drip_fed_import() {
    let env = env().await;
    let url = drip_server(7203, Duration::from_secs(2)).await;
    let (id, add) = add_in_background(&env, &url).await;
    // Let the drip reset the idle timer at least once.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let started = Instant::now();
    tokio::time::timeout(
        Duration::from_secs(10),
        iptv_core::sources::remove(&env.state, &id),
    )
    .await
    .expect("sources.remove waited behind the import")
    .unwrap();
    let took = started.elapsed();
    assert!(took < Duration::from_secs(3), "remove took {took:?}");
    cancelled_add(add).await;
    assert!(iptv_core::sources::list(&env.state)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(part_files(env.dir.path()), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changing_the_url_cancels_the_running_import() {
    let env = env().await;
    let url = drip_server(7204, Duration::from_secs(2)).await;
    let (id, add) = add_in_background(&env, &url).await;
    // A rename alone does not cancel.
    let rename: iptv_core::sources::SourcePatch =
        serde_json::from_value(serde_json::json!({ "name": "Renamed" })).unwrap();
    iptv_core::sources::update(&env.state, &id, rename)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!add.is_finished(), "a rename cancelled the import");
    let patch: iptv_core::sources::SourcePatch = serde_json::from_value(serde_json::json!({
        "m3u": { "origin": "url", "url": "http://127.0.0.1:7204/other.m3u" }
    }))
    .unwrap();
    iptv_core::sources::update(&env.state, &id, patch)
        .await
        .unwrap();
    cancelled_add(add).await;
    let source = iptv_core::sources::get(&env.state, &id).await.unwrap();
    assert_eq!(source.name, "Renamed");
    assert_eq!(source.last_error, None, "a cancel is not an import error");
    assert_eq!(part_files(env.dir.path()), Vec::<String>::new());
}
