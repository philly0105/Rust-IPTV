//! Heap the mapped rows of an Xtream sync hold: a changed sync keeps every
//! mapped row of every changed list (live, movies, series) until the one
//! catalog write, so the bytes a row holds set the sync's peak memory.
//!
//! The test binary counts live heap bytes with its own global allocator, so
//! the numbers are exact and the same in debug and release.

use iptv_core::xtream::raw::{RawLive, RawSeries, RawVod};
use iptv_core::xtream::sync::{live_row, series_row, vod_row};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

struct Counting;

static LIVE_BYTES: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE_BYTES.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            LIVE_BYTES.fetch_add(
                new_size as isize - layout.size() as isize,
                Ordering::Relaxed,
            );
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const ROWS: usize = 5_000;

fn live_raw(i: usize) -> RawLive {
    serde_json::from_value(json!({
        "num": i + 1, "name": format!("UK: Channel {i} HD"), "stream_type": "live",
        "stream_id": i + 1, "stream_icon": format!("http://logo.example/{i}.png"),
        "epg_channel_id": format!("channel{i}.uk"), "added": "1700000000",
        "category_id": format!("{}", i % 300), "category_ids": [i % 300],
        "tv_archive": i.is_multiple_of(3), "tv_archive_duration": if i.is_multiple_of(3) { 7 } else { 0 },
        "is_adult": 0, "custom_sid": ""
    }))
    .unwrap()
}

fn vod_raw(i: usize) -> RawVod {
    serde_json::from_value(json!({
        "num": i + 1, "name": format!("Movie {i} (2019)"), "stream_type": "movie",
        "stream_id": i + 1, "stream_icon": format!("http://img.example/p/{i}.jpg"),
        "rating": "6.5", "rating_5based": 3.25, "added": "1700000000",
        "category_id": format!("{}", i % 400), "category_ids": [i % 400],
        "container_extension": "mkv", "is_adult": 0, "tmdb": format!("{}", 1000 + i)
    }))
    .unwrap()
}

fn series_raw(i: usize) -> RawSeries {
    serde_json::from_value(json!({
        "num": i + 1, "name": format!("Show {i}"), "series_id": i + 1,
        "cover": format!("http://img.example/c/{i}.jpg"),
        "plot": "A family of four moves to a quiet town where nothing is as it seems, and every neighbour keeps a secret that the youngest daughter is set on finding out before the summer ends.",
        "genre": "Drama, Mystery / Thriller", "releaseDate": "2018-03-01",
        "last_modified": "1700000000", "rating": "8.2", "rating_5based": 4.1,
        "backdrop_path": [format!("http://img.example/b/{i}.jpg")],
        "category_id": format!("{}", i % 100), "category_ids": [i % 100],
        "tmdb": format!("{}", 5000 + i)
    }))
    .unwrap()
}

/// Heap bytes per mapped row beyond the row itself, for `ROWS` raw rows.
fn held_per_row<R, F: Fn(usize) -> R, M: Fn(R) -> Option<iptv_core::catalog::ItemRow>>(
    raw: F,
    map: M,
) -> isize {
    let base = LIVE_BYTES.load(Ordering::Relaxed);
    let raws: Vec<R> = (0..ROWS).map(raw).collect();
    // The raw rows are consumed: whatever of their heap the rows did not
    // take over is freed by now, and so is their Vec.
    let rows: Vec<_> = raws.into_iter().filter_map(map).collect();
    assert_eq!(rows.len(), ROWS);
    let row_vec = (rows.capacity() * std::mem::size_of_val(&rows[0])) as isize;
    let held = LIVE_BYTES.load(Ordering::Relaxed) - base - row_vec;
    drop(rows);
    held / ROWS as isize
}

/// The rows carry their extra fields as JSON text (`extra_json`), not as a
/// map: a map of a few keys held about 0.6 KB more per row (792 B a live
/// row, 758 B a movie, 1,102 B a series with its plot), about 100 MB at the
/// write of a 50k live, 100k movie, 20k series panel.
#[test]
fn mapped_xtream_rows_hold_little_heap() {
    let live = held_per_row(live_raw, |r| live_row("source-0000-0000", 0, r));
    let vod = held_per_row(vod_raw, |r| vod_row("source-0000-0000", 0, r));
    let series = held_per_row(series_raw, |r| series_row("source-0000-0000", 0, r));
    eprintln!(
        "xtream_row_memory: heap held per mapped row: live {live} B, movie {vod} B, series {series} B (row itself {} B)",
        std::mem::size_of::<iptv_core::catalog::ItemRow>()
    );
    assert!(live < 400, "live row holds {live} B");
    assert!(vod < 400, "movie row holds {vod} B");
    assert!(series < 700, "series row holds {series} B");
}
