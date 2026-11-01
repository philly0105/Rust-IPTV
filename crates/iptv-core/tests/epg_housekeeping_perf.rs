//! Guide upkeep on large guides, timed. Release-only and ignored by default:
//! - building the channel directory of a 40k-channel guide, and the first
//!   now/next of 120 channels after a refresh, with the directory built on
//!   the request and built ahead;
//! - the fuzzy name scan of 120 unmatched titles after a refresh that left
//!   the guide's channels as they were;
//! - refreshing an unchanged 120 MB local guide file, against reading it
//!   again once its modification time moves.
//!
//! Run: `cargo test -p iptv-core --release --test epg_housekeeping_perf --
//! --ignored --nocapture --test-threads=1`

use iptv_core::epg::{self, resolve};
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::{AppState, NoopSink};
use rusqlite::params;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const CHANNELS: usize = 40_000;
const REFS: usize = 120;

async fn state(dir: &std::path::Path) -> Arc<AppState> {
    AppState::new(dir.join("data"), Arc::new(NoopSink), false)
        .await
        .unwrap()
}

/// Four letters naming `i` (most guide names carry no digits).
fn code(i: usize) -> String {
    (0..4)
        .map(|k| (b'a' + (i / 26usize.pow(k) % 26) as u8) as char)
        .collect()
}

/// A guide name the way providers write them: a country prefix, a quality
/// suffix, sometimes a timeshift or a feed.
fn guide_name(i: usize) -> String {
    const PREFIX: [&str; 5] = ["UK: ", "|US| ", "[DE] ", "", "fr - "];
    const WORDS: [&str; 8] = [
        "Sports",
        "Movies",
        "News",
        "Kids",
        "Music",
        "Documentary",
        "Comedy",
        "Drama",
    ];
    const SUFFIX: [&str; 6] = [" HD", " FHD", "", " 4K", " +1", " East"];
    format!(
        "{}{} {} Network {}{}",
        PREFIX[i % 5],
        WORDS[i % 8],
        WORDS[(i / 8) % 8],
        code(i),
        SUFFIX[i % 6]
    )
}

fn guide_id(i: usize) -> String {
    format!("Channel{}.uk", code(i))
}

/// One feed of [`CHANNELS`] channels, and a playlist of `REFS` channels
/// found by their guide id and `REFS` whose titles match no guide name.
async fn seed(state: &AppState) -> (Vec<ItemRef>, Vec<ItemRef>) {
    state
        .db_call(|c| {
            let tx = c.transaction()?;
            tx.execute("INSERT INTO epg_sources(url) VALUES ('u')", [])?;
            {
                let mut ch = tx.prepare(
                    "INSERT INTO epg_channels(epg_url, channel_id, display_name) VALUES ('u', ?1, ?2)",
                )?;
                for i in 0..CHANNELS {
                    ch.execute(params![guide_id(i), guide_name(i)])?;
                }
            }
            tx.execute(
                "INSERT INTO sources(id, kind, name, config_json, epg_json) VALUES ('s', 'm3u', 'S', '{}', '{}')",
                [],
            )?;
            {
                let mut item = tx.prepare(
                    "INSERT INTO items(source_id, content_type, item_id, category_id, title, epg_channel_id)
                     VALUES ('s', 'live', ?1, 'g', ?2, ?3)",
                )?;
                for i in 0..REFS {
                    let n = i * (CHANNELS / REFS);
                    item.execute(params![format!("id{i}"), guide_name(n), guide_id(n)])?;
                    // Event feeds and channels the guide does not carry.
                    item.execute(params![
                        format!("t{i}"),
                        format!("Pay Per View Event Special {}", code(i * 7919)),
                        Option::<String>::None
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .unwrap();
    let refs = |prefix: &str| -> Vec<ItemRef> {
        (0..REFS)
            .map(|i| ItemRef::new("s", ContentType::Live, format!("{prefix}{i}")))
            .collect()
    };
    (refs("id"), refs("t"))
}

async fn timed<F: std::future::Future>(f: F) -> (F::Output, Duration) {
    let started = Instant::now();
    let out = f.await;
    (out, started.elapsed())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release-only measurement"]
async fn directory_and_first_reads_on_a_large_guide() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path()).await;
    let (by_id, by_title) = seed(&state).await;
    let rt = epg::runtime(&state);
    let build = || {
        let rt = rt.clone();
        state.db_call(move |c| resolve::directory(c, &rt).map(drop))
    };

    // Warm the page cache and the regexes once.
    build().await.unwrap();
    let mut cold = Vec::new();
    for _ in 0..5 {
        rt.bump();
        cold.push(timed(build()).await.1);
    }
    cold.sort();

    rt.bump();
    let (_, on_request) = timed(epg::now_next(&state, by_id.clone())).await;
    rt.bump();
    build().await.unwrap();
    let (_, built_ahead) = timed(epg::now_next(&state, by_id.clone())).await;

    rt.bump();
    let (fuzzy, fresh_memo) = timed(epg::now_next(&state, by_title.clone())).await;
    fuzzy.unwrap();
    // A refresh that kept every channel.
    rt.bump();
    build().await.unwrap();
    let (_, same_channels) = timed(epg::now_next(&state, by_title.clone())).await;

    println!(
        "epg_housekeeping: directory of {CHANNELS} channels built in {:.1} ms (median of 5); \
         first now/next of {REFS} refs after a refresh: {:.1} ms building on the request, \
         {:.1} ms built ahead; {REFS} unmatched titles: {:.1} ms on a fresh memo, \
         {:.1} ms after a refresh with the same channels",
        cold[2].as_secs_f64() * 1e3,
        on_request.as_secs_f64() * 1e3,
        built_ahead.as_secs_f64() * 1e3,
        fresh_memo.as_secs_f64() * 1e3,
        same_channels.as_secs_f64() * 1e3,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "release-only measurement"]
async fn refreshing_an_unchanged_local_guide() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("guide.xml");
    iptv_fixtures::write_xmltv(&path, 120).unwrap();
    let size = std::fs::metadata(&path).unwrap().len();
    let state = state(tmp.path()).await;
    let url = path.to_string_lossy().into_owned();
    state.settings.write().epg_urls = vec![url.clone()];

    let (first, full) = timed(epg::refresh_now(state.clone(), &url)).await;
    let first = first.unwrap();
    let (second, unchanged) = timed(epg::refresh_now(state.clone(), &url)).await;
    let second = second.unwrap();
    // The same bytes with a new modification time are read again.
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    let (third, touched) = timed(epg::refresh_now(state.clone(), &url)).await;
    let third = third.unwrap();
    println!(
        "epg_housekeeping: {:.1} MB local guide, {} programmes: first ingest {:.2} s; \
         unchanged refresh {:.3} s (kept: {}); same bytes with a new mtime {:.2} s (kept: {})",
        size as f64 / 1_048_576.0,
        first.programs,
        full.as_secs_f64(),
        unchanged.as_secs_f64(),
        second.not_modified,
        touched.as_secs_f64(),
        third.not_modified,
    );
    assert_eq!(second.programs, first.programs);
    assert_eq!(third.programs, first.programs);
}
