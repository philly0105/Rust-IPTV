//! Live TV quality filter storage (migration 0022): an import stores the
//! quality code of each live channel's name in `items.quality` and 0 for
//! every other type, and the boot backfill computes the live rows a catalog
//! written before the migration left at -1, with `items_rank` following.

#[path = "m3u_support.rs"]
mod support;

use iptv_core::catalog::quality::{self, code, UNSET, UNTAGGED};
use iptv_core::live::matcher;
use rusqlite::Connection;
use std::time::{Duration, Instant};
use support::*;

/// Live channels with and without quality markers, plus a radio station, a
/// movie and a series episode whose names carry markers too.
const PLAYLIST: &str = "#EXTM3U\n\
    #EXTINF:-1 group-title=\"UK\",UK: Sky Sports 1 FHD\nhttp://h/live/1.ts\n\
    #EXTINF:-1 group-title=\"UK\",BBC One HD\nhttp://h/live/2.ts\n\
    #EXTINF:-1 group-title=\"UK\",ITV 4K\nhttp://h/live/3.ts\n\
    #EXTINF:-1 group-title=\"UK\",Channel 5 SD\nhttp://h/live/4.ts\n\
    #EXTINF:-1 group-title=\"UK\",Film4 +1\nhttp://h/live/5.ts\n\
    #EXTINF:-1 group-title=\"DE\",4K | Sky Cinema\nhttp://h/live/6.ts\n\
    #EXTINF:-1 group-title=\"DE\",ZDF HD +\nhttp://h/live/7.ts\n\
    #EXTINF:-1 group-title=\"US\",CNN 720p\nhttp://h/live/8.ts\n\
    #EXTINF:-1 radio=\"true\" group-title=\"Radio\",Radio HD\nhttp://h/radio/9.mp3\n\
    #EXTINF:-1 group-title=\"Films\",Heat 4K (1995)\nhttp://h/movie/u/p/10.mkv\n\
    #EXTINF:-1 group-title=\"Drama\",Dark FHD S01 E01\nhttp://h/series/u/p/11.mkv\n";

/// The live channels of [`PLAYLIST`] and their codes.
const LIVE: [(&str, i64); 8] = [
    ("UK: Sky Sports 1 FHD", 3),
    ("BBC One HD", 2),
    ("ITV 4K", 4),
    ("Channel 5 SD", 1),
    ("Film4 +1", UNTAGGED),
    ("4K | Sky Cinema", 4),
    ("ZDF HD +", 2),
    ("CNN 720p", 2),
];

/// `(content_type, title, quality)` of every item.
fn rows(c: &Connection) -> Vec<(String, String, i64)> {
    let mut stmt = c
        .prepare("SELECT content_type, title, quality FROM items ORDER BY rowid")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Live rows store their name's code; other types store `other`.
fn assert_stored(c: &Connection, other: i64) {
    let all = rows(c);
    let mut live: Vec<(&str, i64)> = Vec::new();
    for (ct, title, q) in &all {
        if ct == "live" {
            assert_eq!(*q, code(matcher::quality(title)), "{title}");
            live.push((title.as_str(), *q));
        } else {
            assert_eq!(*q, other, "{ct} {title}");
        }
    }
    assert_eq!(live, LIVE, "every live channel, in playlist order");
    let others: Vec<&str> = all
        .iter()
        .filter(|r| r.0 != "live")
        .map(|r| r.0.as_str())
        .collect();
    assert!(
        others.contains(&"radio") && others.contains(&"movie"),
        "{others:?}"
    );
}

/// Every row is back at -1, as before migration 0022.
fn assert_stored_unset(c: &Connection) {
    assert!(rows(c).iter().all(|r| r.2 == UNSET));
}

#[tokio::test]
async fn an_import_stores_live_channel_quality() {
    let env = env().await;
    add_text(&env.state, "Q", PLAYLIST).await;
    env.state
        .db_call(|c| {
            assert_stored(c, UNTAGGED);
            assert_items_rank(c);
            Ok(())
        })
        .await
        .unwrap();
}

/// A catalog written before migration 0022 (every row at -1): the backfill
/// stores the live codes, `items_rank` follows through its update trigger,
/// and other types keep -1 until their next rewrite (no reader filters
/// them). A second run finds nothing.
#[tokio::test]
async fn the_backfill_stores_codes_left_unset() {
    let env = env().await;
    add_text(&env.state, "Q", PLAYLIST).await;
    env.state
        .db_call(|c| {
            c.execute("UPDATE items SET quality = -1", [])?;
            assert_stored_unset(c);
            assert_items_rank(c);
            assert_eq!(quality::backfill(c)?, LIVE.len());
            assert_stored(c, UNSET);
            assert_items_rank(c);
            assert_eq!(quality::backfill(c)?, 0);
            Ok(())
        })
        .await
        .unwrap();
}

/// `catalog::init` runs the backfill in the background at boot.
#[tokio::test]
async fn boot_runs_the_backfill() {
    let env = env().await;
    add_text(&env.state, "Q", PLAYLIST).await;
    env.state
        .db_call(|c| {
            c.execute("UPDATE items SET quality = -1", [])?;
            Ok(())
        })
        .await
        .unwrap();
    iptv_core::catalog::init(env.state.clone()).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left: i64 = env
            .state
            .db_call(|c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM items WHERE content_type = 'live' AND quality = -1",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        if left == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "{left} live rows still unset");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    env.state
        .db_call(|c| {
            assert_stored(c, UNSET);
            assert_items_rank(c);
            Ok(())
        })
        .await
        .unwrap();
}
