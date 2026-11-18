//! W0b: every `dl_panel` feature the download speed work tests against,
//! proved with plain reqwest (no download engine), so a failing engine test
//! can trust the panel: the shared line, each validator mode, redirects and
//! token expiry, kick-oldest, copies that differ, the Xtream JSON, and the
//! catalog helpers the mirror lookup reads.

mod dl_panel;

use dl_panel::{
    add_movie, add_series, add_xtream_source, content, movie_ref, sample_offsets, series_ref,
    variant_content, LimitMode, Line, Panel, PanelOptions, Redirect, Validators, Variant,
    SAMPLE_LEN,
};
use futures::StreamExt;
use iptv_core::{AppState, BroadcastSink};
use reqwest::header;
use reqwest::StatusCode;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;

/// A client that does not follow redirects.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn get(url: &str, range: Option<(u64, u64)>, if_range: Option<&str>) -> reqwest::Response {
    let mut req = client().get(url);
    if let Some((a, b)) = range {
        req = req.header(header::RANGE, format!("bytes={a}-{b}"));
    }
    if let Some(v) = if_range {
        req = req.header(header::IF_RANGE, v);
    }
    req.send().await.unwrap()
}

fn head(resp: &reqwest::Response, name: header::HeaderName) -> Option<String> {
    resp.headers()
        .get(name)
        .map(|v| v.to_str().unwrap().to_string())
}

async fn bytes_of(url: &str, at: u64, len: u64) -> Vec<u8> {
    let resp = get(url, Some((at, at + len - 1)), None).await;
    assert_eq!(
        resp.status(),
        StatusCode::PARTIAL_CONTENT,
        "{url} {at}+{len}"
    );
    resp.bytes().await.unwrap().to_vec()
}

fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Reads a body to its end: the bytes, and whether it ended with an error.
async fn drain(resp: reqwest::Response) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => out.extend_from_slice(&c),
            Err(_) => return (out, true),
        }
    }
    (out, false)
}

async fn wait_until(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

struct App {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
}

async fn app() -> App {
    let tmp = tempfile::tempdir().unwrap();
    let (sink, _events) = BroadcastSink::channel(1024);
    let state = AppState::new(tmp.path().join("data"), Arc::new(sink), false)
        .await
        .unwrap();
    iptv_core::xtream::init(state.clone()).await.unwrap();
    App { _tmp: tmp, state }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_line_cap_is_shared_across_panels() {
    const SIZE: u64 = 3 * MIB;
    let line = Line::new(6 * MIB);
    let opts = PanelOptions {
        line: Some(line.clone()),
        ..PanelOptions::default()
    };
    let a = Panel::with(PanelOptions {
        seed: 1,
        ..opts.clone()
    })
    .await;
    let b = Panel::with(PanelOptions { seed: 2, ..opts }).await;
    a.file(1, SIZE, 0);
    b.file(2, SIZE, 0);

    // Alone, a panel off the line goes much faster than the line.
    let free = Panel::spawn(3).await;
    free.file(1, SIZE, 0);
    let t = Instant::now();
    let (data, _) = drain(get(&free.url(1), None, None).await).await;
    let alone = t.elapsed();
    assert_eq!(dl_panel::first_wrong(1, 0, &data), None);
    assert!(
        alone < Duration::from_millis(500),
        "an unpaced body took {alone:?}"
    );

    // Two bodies on two panels share 6 MiB/s: 6 MiB take about a second,
    // and they finish together (the line interleaves them).
    let t = Instant::now();
    let fetch = |url: String| async move {
        let (data, failed) = drain(get(&url, None, None).await).await;
        (data, failed, t.elapsed())
    };
    let ((da, fa, ta), (db, fb, tb)) = tokio::join!(fetch(a.url(1)), fetch(b.url(2)));
    let both = t.elapsed();
    assert!(!fa && !fb);
    assert_eq!(dl_panel::first_wrong(1, 0, &da), None);
    assert_eq!(dl_panel::first_wrong(2, 0, &db), None);
    assert_eq!(line.served(), 2 * SIZE);
    let rate = (2 * SIZE) as f64 / both.as_secs_f64() / MIB as f64;
    println!("line: 2 panels, {both:?} for 6 MiB = {rate:.2} MiB/s (a {ta:?}, b {tb:?})");
    assert!(
        both >= Duration::from_millis(850),
        "6 MiB in {both:?} on a 6 MiB/s line"
    );
    assert!(
        both < Duration::from_secs(4),
        "the line is far slower than its rate: {both:?}"
    );
    assert!(
        ta >= Duration::from_millis(700) && tb >= Duration::from_millis(700),
        "one body had the line to itself: a {ta:?}, b {tb:?}"
    );
}

#[tokio::test]
async fn validators_follow_the_mode_and_none_ignores_if_range() {
    const SIZE: u64 = 256 * 1024;
    let p = Panel::spawn(1).await;
    p.file(3, SIZE, 0);
    let url = p.url(3);

    // ETag (the default): sent, and If-Range must match it.
    let r = get(&url, Some((0, 99)), None).await;
    let tag = head(&r, header::ETAG).expect("an ETag by default");
    assert_eq!(head(&r, header::LAST_MODIFIED), None);
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    let r = get(&url, Some((100, 199)), Some(&tag)).await;
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.bytes().await.unwrap().to_vec(), content(3, 100, 100));
    let r = get(&url, Some((100, 199)), Some("\"other\"")).await;
    assert_eq!(
        r.status(),
        StatusCode::OK,
        "a stale If-Range gets the whole file"
    );
    assert_eq!(r.content_length(), Some(SIZE));

    // Last-Modified only.
    p.set_validators(Validators::LastModified);
    let r = get(&url, Some((0, 99)), None).await;
    assert_eq!(head(&r, header::ETAG), None);
    let date = head(&r, header::LAST_MODIFIED).expect("a Last-Modified date");
    assert!(date.ends_with(" GMT"), "{date}");
    assert_eq!(
        get(&url, Some((0, 9)), Some(&date)).await.status(),
        StatusCode::PARTIAL_CONTENT
    );
    assert_eq!(
        get(&url, Some((0, 9)), Some(&tag)).await.status(),
        StatusCode::OK
    );

    // Both: either matches.
    p.set_validators(Validators::Both);
    let r = get(&url, Some((0, 99)), None).await;
    assert_eq!(head(&r, header::ETAG).as_deref(), Some(tag.as_str()));
    assert_eq!(
        head(&r, header::LAST_MODIFIED).as_deref(),
        Some(date.as_str())
    );
    assert_eq!(
        get(&url, Some((0, 9)), Some(&tag)).await.status(),
        StatusCode::PARTIAL_CONTENT
    );
    assert_eq!(
        get(&url, Some((0, 9)), Some(&date)).await.status(),
        StatusCode::PARTIAL_CONTENT
    );

    // None, set at build time: no validator, any If-Range still gets the range.
    let none = Panel::with(PanelOptions {
        validators: Validators::None,
        ..PanelOptions::default()
    })
    .await;
    none.file(3, SIZE, 0);
    let r = get(&none.url(3), Some((1000, 1999)), Some("\"whatever\"")).await;
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(head(&r, header::ETAG), None);
    assert_eq!(head(&r, header::LAST_MODIFIED), None);
    assert_eq!(
        head(&r, header::CONTENT_RANGE).as_deref(),
        Some(format!("bytes 1000-1999/{SIZE}").as_str()),
        "the total comes with the range"
    );
    assert_eq!(r.bytes().await.unwrap().to_vec(), content(3, 1000, 1000));
}

#[tokio::test]
async fn same_host_redirects_carry_tokens_that_expire() {
    const SIZE: u64 = MIB;
    let p = Panel::with(PanelOptions {
        redirect: Some(Redirect::SameHost {
            token_ttl: Duration::from_millis(400),
        }),
        ..PanelOptions::default()
    })
    .await;
    p.file(5, SIZE, 0);
    assert_eq!(p.edge_base().as_deref(), Some(p.base.as_str()));

    let r = get(&p.movie_url(5), Some((0, 99)), None).await;
    assert_eq!(r.status(), StatusCode::FOUND);
    let edge = head(&r, header::LOCATION).unwrap();
    assert!(edge.starts_with(&format!("{}/edge/5?t=", p.base)), "{edge}");
    let r = get(&p.episode_url(5), None, None).await;
    assert_eq!(r.status(), StatusCode::FOUND, "series URLs redirect too");
    assert_eq!(p.redirects(), 2);

    // The edge URL serves ranges while the token lives, and can be reused.
    assert_eq!(bytes_of(&edge, 1000, 1000).await, content(5, 1000, 1000));
    assert_eq!(bytes_of(&edge, 5000, 10).await, content(5, 5000, 10));
    // `/f/` never redirects.
    assert_eq!(
        get(&p.url(5), Some((0, 9)), None).await.status(),
        StatusCode::PARTIAL_CONTENT
    );

    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = get(&edge, Some((0, 99)), None).await;
    assert_eq!(
        r.status(),
        StatusCode::FORBIDDEN,
        "an expired token is refused"
    );
    assert_eq!(p.expired(), 1);

    // Asking the original URL again gives a fresh token; a token for another
    // file or none at all is refused (not counted as expired).
    let r = get(&p.movie_url(5), None, None).await;
    let fresh = head(&r, header::LOCATION).unwrap();
    assert_ne!(fresh, edge);
    assert_eq!(bytes_of(&fresh, 0, 64).await, content(5, 0, 64));
    let wrong = fresh.replace("/edge/5?", "/edge/6?");
    assert_eq!(
        get(&wrong, None, None).await.status(),
        StatusCode::FORBIDDEN
    );
    let bare = format!("{}/edge/5", p.base);
    assert_eq!(get(&bare, None, None).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(p.expired(), 1);
    assert_eq!(p.counts().get("badToken"), Some(&2));

    // The log shows the hops: 302s on the Xtream routes, bodies on the edge.
    let log = p.log();
    assert!(log.iter().any(|l| l.route == "movie" && l.status == 302));
    assert!(log.iter().any(|l| l.route == "series" && l.status == 302));
    assert!(log.iter().any(|l| l.route == "edge" && l.status == 206));
    assert!(log.iter().any(|l| l.route == "edge" && l.status == 403));
}

#[tokio::test]
async fn edge_host_redirects_go_to_a_second_listener() {
    const SIZE: u64 = 512 * 1024;
    let p = Panel::with(PanelOptions {
        redirect: Some(Redirect::EdgeHost {
            token_ttl: Duration::from_secs(60),
        }),
        ..PanelOptions::default()
    })
    .await;
    p.file(7, SIZE, 0);
    let edge_base = p.edge_base().unwrap();
    assert_ne!(edge_base, p.base, "the edge is another origin");

    let r = get(&p.movie_url(7), None, None).await;
    assert_eq!(r.status(), StatusCode::FOUND);
    let edge = head(&r, header::LOCATION).unwrap();
    assert!(
        edge.starts_with(&format!("{edge_base}/edge/7?t=")),
        "{edge}"
    );
    // The panel's own listener has no edge route.
    let on_panel = edge.replace(&edge_base, &p.base);
    assert_eq!(
        get(&on_panel, None, None).await.status(),
        StatusCode::NOT_FOUND
    );

    // A client that follows redirects ends on the edge with the right bytes.
    let r = reqwest::Client::new()
        .get(p.movie_url(7))
        .header(header::RANGE, "bytes=100-199")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert!(r.url().as_str().starts_with(&edge_base), "{}", r.url());
    assert_eq!(r.bytes().await.unwrap().to_vec(), content(7, 100, 100));
    assert_eq!(p.redirects(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kick_oldest_ends_the_oldest_body_and_refuse_stays_the_default() {
    const SIZE: u64 = 8 * MIB;
    let p = Panel::with(PanelOptions {
        limit_mode: LimitMode::KickOldest,
        ..PanelOptions::default()
    })
    .await;
    p.set_enforced(1);
    p.file(1, SIZE, 1024);

    // The oldest body is open and flowing.
    let first = get(&p.url(1), Some((0, SIZE - 1)), None).await;
    assert_eq!(first.status(), StatusCode::PARTIAL_CONTENT);
    let mut stream = first.bytes_stream();
    let mut got = stream.next().await.unwrap().unwrap().to_vec();

    // A second request past the limit is accepted, and the first one ends.
    let second = get(&p.url(1), Some((4 * MIB, 4 * MIB + 99_999)), None).await;
    assert_eq!(second.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(p.kicked(), 1);
    assert_eq!(p.open(), 1, "the kicked body no longer counts");
    let mut failed = false;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => got.extend_from_slice(&c),
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    assert!(
        failed || (got.len() as u64) < SIZE,
        "the kicked body ran to its end"
    );
    assert!(
        (got.len() as u64) < SIZE / 2,
        "the kicked body went on for {} bytes",
        got.len()
    );
    assert_eq!(
        dl_panel::first_wrong(1, 0, &got),
        None,
        "bytes before the kick are right"
    );
    let (data, failed) = drain(second).await;
    assert!(!failed);
    assert_eq!(dl_panel::first_wrong(1, 4 * MIB, &data), None);
    assert_eq!(data.len(), 100_000);
    assert_eq!(p.peak(), 1, "never two bodies open at once");

    // Refuse (the default) answers 403 past the limit instead.
    wait_until(|| p.open() == 0).await;
    p.set_limit_mode(LimitMode::Refuse);
    let held = get(&p.url(1), Some((0, SIZE - 1)), None).await;
    assert_eq!(held.status(), StatusCode::PARTIAL_CONTENT);
    let refused = get(&p.url(1), Some((0, 99)), None).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(p.kicked(), 1);
    assert_eq!(p.counts().get("refused"), Some(&1));
    drop(held);
}

#[tokio::test]
async fn variants_match_or_differ_only_where_specified() {
    // Not a multiple of the window, so the middle window is aligned down.
    let total = 8 * MIB + 12_345;
    let [first, mid, last] = sample_offsets(total);
    assert_eq!(first, 0);
    assert_eq!(mid, (total / 2) / SAMPLE_LEN * SAMPLE_LEN);
    assert_eq!(last, total - SAMPLE_LEN);

    // Same is the canonical file; Differs differs at every byte.
    let whole = content(4, 0, total as usize);
    assert_eq!(
        variant_content(4, Variant::Same, total, 0, total as usize),
        whole
    );
    let differs = variant_content(4, Variant::Differs, total, 0, total as usize);
    assert!(differs.iter().zip(&whole).all(|(a, b)| a != b));

    // DiffersOutsideSamples: canonical exactly inside the three windows.
    let planted = variant_content(4, Variant::DiffersOutsideSamples, total, 0, total as usize);
    for at in 0..total {
        let inside = [first, mid, last]
            .iter()
            .any(|&o| at >= o && at < o + SAMPLE_LEN);
        let i = at as usize;
        assert_eq!(
            planted[i] == whole[i],
            inside,
            "byte {at} (inside a window: {inside})"
        );
    }
    // Any slice agrees with the whole.
    let slice = variant_content(4, Variant::DiffersOutsideSamples, total, mid - 10, 70_000);
    assert_eq!(
        slice,
        planted[(mid - 10) as usize..(mid - 10 + 70_000) as usize]
    );

    // Over HTTP: three panels with three copies of file 4.
    let same = Panel::spawn(1).await;
    let other = Panel::spawn(2).await;
    let outside = Panel::spawn(3).await;
    same.file(4, total, 0);
    other.file_variant(4, total, 0, Variant::Differs);
    outside.file_variant(4, total, 0, Variant::DiffersOutsideSamples);
    for o in [first, mid, last] {
        let want = sha(&bytes_of(&same.url(4), o, SAMPLE_LEN).await);
        assert_eq!(
            sha(&bytes_of(&outside.url(4), o, SAMPLE_LEN).await),
            want,
            "window {o}"
        );
        assert_ne!(
            sha(&bytes_of(&other.url(4), o, SAMPLE_LEN).await),
            want,
            "window {o}"
        );
    }
    // Just past the first window and just before the last, the planted copy differs.
    for at in [SAMPLE_LEN, mid + SAMPLE_LEN, last - 4096] {
        let a = bytes_of(&same.url(4), at, 4096).await;
        let c = bytes_of(&outside.url(4), at, 4096).await;
        assert!(a.iter().zip(&c).all(|(x, y)| x != y), "4 KiB at {at}");
    }
    // Copies with other bytes carry other validators.
    let mut tags = BTreeSet::new();
    for p in [&same, &other, &outside] {
        tags.insert(head(&get(&p.url(4), Some((0, 0)), None).await, header::ETAG).unwrap());
    }
    assert_eq!(tags.len(), 3, "{tags:?}");

    // Registering again swaps the bytes for new requests (a file changing
    // on the provider mid-download).
    same.file_variant(4, total, 0, Variant::Differs);
    assert_eq!(bytes_of(&same.url(4), 0, 64).await, differs[..64].to_vec());
    same.file(4, total, 0);
    assert_eq!(bytes_of(&same.url(4), 0, 64).await, whole[..64].to_vec());
}

#[tokio::test]
async fn series_and_vod_info_json_reads_through_the_apps_own_code() {
    let app = app().await;
    let p = Panel::spawn(1).await;
    p.set_reported(2);
    p.file(5, MIB, 0);
    for f in [101, 102, 201] {
        p.file(f, MIB, 0);
    }
    p.series(70, &[(1, 1, 101), (1, 2, 102), (2, 1, 201)]);

    // Raw JSON, as a panel sends it.
    let api = format!("{}/player_api.php?username=u&password=p", p.base);
    let v: Value = reqwest::get(format!("{api}&action=get_series_info&series_id=70"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["seasons"].as_array().unwrap().len(), 2);
    assert_eq!(v["episodes"]["1"][1]["id"], "102");
    assert_eq!(v["episodes"]["1"][1]["episode_num"], "2");
    assert_eq!(v["episodes"]["2"][0]["id"], "201");
    assert_eq!(v["episodes"]["2"][0]["container_extension"], "mp4");
    let v: Value = reqwest::get(format!("{api}&action=get_series_info&series_id=71"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        v["episodes"],
        serde_json::json!([]),
        "an unknown series is empty"
    );
    let v: Value = reqwest::get(format!("{api}&action=get_vod_info&vod_id=5"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["movie_data"]["container_extension"], "mp4");

    // The app's account check caches the reported limit.
    let sid = add_xtream_source(&app.state, "xa", &p).await;
    let s2 = sid.clone();
    let status = app
        .state
        .db_call(move |c| iptv_core::account::load(c, &s2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.max_connections, Some(2));

    // The app's stream URLs are the panel's, through its own parsers:
    // an episode from get_series_info, a movie with no row from get_vod_info.
    add_series(&app.state, &sid, 70, "Panel Show").await;
    let ep = iptv_core::xtream::service::stream_url(&app.state, &series_ref(&sid, 70), Some("201"))
        .await
        .unwrap();
    assert_eq!(ep.url, p.episode_url(201));
    let vod_before = p.counts().get("vodInfo").copied().unwrap_or(0);
    let mv = iptv_core::xtream::service::stream_url(&app.state, &movie_ref(&sid, 5), None)
        .await
        .unwrap();
    assert_eq!(mv.url, p.movie_url(5));
    assert!(p.counts().get("vodInfo").copied().unwrap_or(0) > vod_before);
    // And the panel serves them.
    assert_eq!(bytes_of(&ep.url, 0, 100).await, content(201, 0, 100));
    assert_eq!(bytes_of(&mv.url, 0, 100).await, content(5, 0, 100));
}

#[tokio::test]
async fn catalog_helpers_let_same_title_find_the_copies() {
    let app = app().await;
    let panels = [
        Panel::spawn(1).await,
        Panel::spawn(2).await,
        Panel::spawn(3).await,
    ];
    let mut ids = Vec::new();
    for (i, p) in panels.iter().enumerate() {
        p.set_reported(1);
        ids.push(add_xtream_source(&app.state, &format!("x{i}"), p).await);
    }
    let (a, b, c) = (&ids[0], &ids[1], &ids[2]);
    add_movie(&app.state, a, 1, "The Matrix (1999)", None, "mp4").await;
    add_movie(&app.state, a, 2, "Heat (1995)", None, "mp4").await;
    add_movie(
        &app.state,
        b,
        11,
        "EN - The Matrix (1999) [4K]",
        Some(1999),
        "mkv",
    )
    .await;
    add_movie(&app.state, c, 21, "The Matrix", Some(1999), "mp4").await;
    add_movie(&app.state, c, 22, "The Matrix (2021)", None, "mp4").await;
    // Writing a row again replaces it in place.
    add_movie(&app.state, c, 21, "The Matrix", Some(1999), "mp4").await;
    add_series(&app.state, a, 70, "Breaking Bad").await;
    add_series(&app.state, b, 80, "breaking bad").await;
    add_series(&app.state, c, 90, "Better Call Saul").await;

    let found = |r: iptv_core::model::ItemRef| {
        let state = app.state.clone();
        async move {
            state
                .db_call(move |conn| iptv_core::catalog::same_title(conn, &r, None))
                .await
                .unwrap()
                .into_iter()
                .map(|n| (n.row.source_id, n.row.item_id))
                .collect::<BTreeSet<_>>()
        }
    };
    let want: BTreeSet<_> = [(b.clone(), "11".to_string()), (c.clone(), "21".to_string())].into();
    assert_eq!(
        found(movie_ref(a, 1)).await,
        want,
        "the 2021 film is another film"
    );
    let want: BTreeSet<_> = [(b.clone(), "80".to_string())].into();
    assert_eq!(found(series_ref(a, 70)).await, want);

    // Earlier rows survive later writes, with their own fields.
    let (s1, s2) = (a.clone(), c.clone());
    let (heat, rows_c) = app
        .state
        .db_call(move |conn| {
            let heat = iptv_core::catalog::get(conn, &movie_ref(&s1, 2))?;
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM items WHERE source_id = ?1 AND content_type = 'movie'",
                [&s2],
                |r| r.get(0),
            )?;
            Ok((heat, n))
        })
        .await
        .unwrap();
    let heat = heat.expect("Heat is still there");
    assert_eq!(heat.year, Some(1995));
    assert!(heat
        .title_base
        .as_deref()
        .is_some_and(|b| b.eq_ignore_ascii_case("heat")));
    assert_eq!(rows_c, 2);

    // The row's extension makes the app's stream URL, which the panel serves.
    panels[1].file(11, MIB, 0);
    let mv = iptv_core::xtream::service::stream_url(&app.state, &movie_ref(b, 11), None)
        .await
        .unwrap();
    assert_eq!(mv.url, format!("{}/movie/u/p/11.mkv", panels[1].base));
    assert_eq!(bytes_of(&mv.url, 0, 100).await, content(11, 0, 100));
}

#[tokio::test]
async fn a_second_loopback_address_reaches_the_same_panel() {
    let p = Panel::spawn(1).await;
    p.file(1, MIB, 0);
    let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
    let addr = match p.listen_also(ip).await {
        Ok(addr) => addr,
        Err(e) => {
            // macOS has only 127.0.0.1 unless aliased.
            println!("skipped: cannot listen on {ip}: {e}");
            return;
        }
    };
    assert_eq!(addr.port(), p.port());
    let url = format!("http://{addr}/f/1");
    assert_eq!(bytes_of(&url, 10, 10).await, content(1, 10, 10));
    assert_eq!(bytes_of(&p.url(1), 10, 10).await, content(1, 10, 10));
    assert_eq!(p.requests_on(ip), 1);
    assert_eq!(p.requests_on(IpAddr::V4(Ipv4Addr::LOCALHOST)), 1);
    assert!(p.log().iter().any(|l| l.local == ip));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_panel_ends_its_open_bodies() {
    let p = Panel::spawn(1).await;
    p.file(1, 64 * MIB, 256);
    let resp = get(&p.url(1), None, None).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let t = Instant::now();
    drop(p);
    let (data, failed) = tokio::time::timeout(Duration::from_secs(10), drain(resp))
        .await
        .expect("the body ends once the panel is gone");
    assert!(failed || (data.len() as u64) < 64 * MIB);
    assert!(t.elapsed() < Duration::from_secs(10));
}
