//! R5-7: `backup.import` makes no extra copies of an embedded playlist. The
//! RPC's text is parsed on the blocking pool and freed once its tree is
//! built, the playlist text moves from the tree into the entry and then into
//! the database call, and its fingerprint is hashed without canonical copies
//! of the text.
//!
//! A counting global allocator measures the peak heap of the call above what
//! the caller already holds (the args with the backup text). Only one test
//! lives in this binary, so no other test's allocations land in the count.
//! SQLite allocates through its own malloc and is not counted.
//!
//! Measured with a 24 MB playlist: 144 MB above the caller before (6.0x the
//! text: the RPC's text, the tree, a clone of `playlists`, the entry's
//! `source` clone and text copy, three canonical copies for the
//! fingerprint), 50 MB after (2.1x). What is left is serde_json's parse:
//! an escaped string is unescaped into a scratch buffer and then copied into
//! the tree, so two copies exist until the parse returns.

use iptv_core::rpc::RpcRouter;
use iptv_core::{AppState, NoopSink};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::Arc;

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(by: usize) {
    let now = CURRENT.fetch_add(by, Relaxed) + by;
    PEAK.fetch_max(now, Relaxed);
}

// SAFETY: every call forwards to `System` with the caller's arguments; the
// counters only observe sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        CURRENT.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                grew(new_size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const MB: usize = 1024 * 1024;
/// Over `m3u::RAW_INLINE_MAX` (8 MiB), so the text goes to the playlist
/// cache file as a real large import does.
const PLAYLIST_MB: usize = 24;

/// A playlist of a few channels padded with comment lines (the parser skips
/// them) to `PLAYLIST_MB`, so the import's own work stays small and the
/// copies of the text dominate the peak.
fn playlist() -> String {
    let mut text = String::with_capacity(PLAYLIST_MB * MB + 4096);
    text.push_str("#EXTM3U\n");
    for i in 0..20 {
        text.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"ch{i}\" group-title=\"News\",Channel {i}\nhttp://127.0.0.1:9/live/{i}.ts\n"
        ));
    }
    let pad = format!("# {}\n", "padding ".repeat(12));
    while text.len() < PLAYLIST_MB * MB {
        text.push_str(&pad);
    }
    text
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backup_import_makes_no_extra_copies_of_an_embedded_playlist() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    iptv_core::m3u::init(state.clone()).await.unwrap();
    let mut router = RpcRouter::new();
    iptv_core::backup::rpc::register(&mut router);

    let text = playlist();
    let size = text.len();
    // `text` kind with no URL: the fingerprint hashes the whole text.
    let manifest = json!({
        "kind": "iptvnator-playlist-backup",
        "version": 1,
        "playlists": [{
            "portalType": "m3u",
            "exportedId": "big",
            "title": "Big",
            "source": { "kind": "text", "rawM3u": text },
        }],
    })
    .to_string();
    let args = json!({ "json": manifest, "mode": "merge" });

    let before = CURRENT.load(Relaxed);
    PEAK.store(before, Relaxed);
    let report = router
        .dispatch(state.clone(), "backup.import", args)
        .await
        .unwrap_or_else(|e| panic!("backup.import failed: {}", e.message));
    let peak = PEAK.load(Relaxed).saturating_sub(before);
    println!(
        "backup_import_memory: {} MB playlist, peak heap above the caller's {:.1} MB ({:.2}x the text)",
        size / MB,
        peak as f64 / MB as f64,
        peak as f64 / size as f64
    );

    assert_eq!(report["imported"], 1, "{report}");
    let channels: i64 = state
        .db_call(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM items WHERE source_id = 'big'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(channels, 20);
    // The parse's two copies, plus room for the import's own work.
    assert!(
        peak < size * 5 / 2,
        "peak heap {peak} bytes for a {size}-byte playlist: the import holds extra copies of the text"
    );
}
