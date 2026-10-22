//! Route tests against a real server on a free port.

use std::path::{Path, PathBuf};

use iptv_mock::{catalog, gen, stalker, xtream};
use reqwest::header;
use serde_json::Value;

struct Mock {
    base: String,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

async fn spawn() -> Mock {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let app = iptv_mock::router_with_base(base.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Mock {
        base,
        _shutdown: tx,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_gzip().build().unwrap()
}

#[tokio::test]
async fn every_route_answers_with_cors() {
    let m = spawn().await;
    let c = client();
    let paths = [
        "/health",
        "/xtream/player_api.php?username=demo&password=secret",
        "/xtream/player_api.php?username=demo&password=secret&action=get_live_categories",
        "/xtream/player_api.php?username=demo&password=secret&action=get_live_streams",
        "/xtream/player_api.php?username=demo&password=secret&action=get_vod_categories",
        "/xtream/player_api.php?username=demo&password=secret&action=get_vod_streams",
        "/xtream/player_api.php?username=demo&password=secret&action=get_vod_info&vod_id=201",
        "/xtream/player_api.php?username=demo&password=secret&action=get_series_categories",
        "/xtream/player_api.php?username=demo&password=secret&action=get_series",
        "/xtream/player_api.php?username=demo&password=secret&action=get_series_info&series_id=301",
        "/xtream/player_api.php?username=demo&password=secret&action=get_short_epg&stream_id=101",
        "/xtream/xmltv.php?username=demo&password=secret",
        "/xtream/live/demo/secret/101.m3u8",
        "/xtream/seg/5.ts",
        "/xtream/movie/demo/secret/201.mp4",
        "/xtream/series/demo/secret/3001.mp4",
        "/xtream/timeshift/demo/secret/60/2026-01-01:10-00/101.ts",
        "/stalker/portal.php?type=stb&action=handshake",
        "/stalker/c/portal.php?type=stb&action=handshake",
        "/m3u/sample.m3u",
        "/m3u/large.m3u?channels=10",
        "/xmltv/sample.xml",
        "/xmltv/sample.xml.gz",
        "/xmltv/large.xml?mb=1",
        "/files/video.bin?size=1000",
        "/files/nolen.bin?size=1000",
        "/media/radio.mp3",
        "/media/sample.webm",
        "/img/logo/bbc1.uk.svg",
        "/echo/headers",
        "/__mock/stats",
    ];
    for path in paths {
        let r = c.get(format!("{}{path}", m.base)).send().await.unwrap();
        assert!(r.status().is_success(), "{path}: {}", r.status());
        assert_eq!(
            r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "*",
            "{path}"
        );
        let body = r.bytes().await.unwrap();
        assert!(!body.is_empty(), "{path}: empty body");
    }
    let r = c.get(format!("{}/nope", m.base)).send().await.unwrap();
    assert_eq!(r.status(), 404);
    assert_eq!(r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
}

/// A channel's direct live `.ts` is endless like a panel's: no length or
/// ranges, the connect burst at once, then one 2 s segment every 2 s (it used
/// to be one 32 s file, which a player reached the end of after 32 s).
#[tokio::test]
async fn xtream_live_ts_is_endless_and_paced() {
    use iptv_mock::live::CONNECT_BURST;
    use iptv_mock::media::live_segment;
    use std::time::{Duration, Instant};
    let m = spawn().await;
    let c = client();
    for path in [
        "/xtream/live/demo/secret/101.ts",
        "/xtream/live/demo/secret/101",
    ] {
        let mut r = c.get(format!("{}{path}", m.base)).send().await.unwrap();
        assert_eq!(r.status(), 200, "{path}");
        assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp2t", "{path}");
        assert_eq!(r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(!r.headers().contains_key(header::CONTENT_LENGTH), "{path}");
        assert!(!r.headers().contains_key(header::ACCEPT_RANGES), "{path}");
        assert_eq!(r.chunk().await.unwrap().unwrap()[0], 0x47, "{path}");
    }

    let burst: usize = (0..CONNECT_BURST).map(|n| live_segment(n).len()).sum();
    let started = Instant::now();
    let mut r = c
        .get(format!("{}/xtream/live/demo/secret/101.ts", m.base))
        .send()
        .await
        .unwrap();
    let mut got = 0;
    while got < burst {
        got += r.chunk().await.unwrap().expect("the burst").len();
    }
    let burst_at = started.elapsed();
    assert!(
        burst_at < Duration::from_secs(1),
        "burst after {burst_at:?}"
    );
    if got == burst {
        r.chunk().await.unwrap().expect("the stream goes on");
    }
    let next_at = started.elapsed();
    assert!(
        next_at >= Duration::from_millis(1_500),
        "the segment after the burst came after {next_at:?}"
    );
}

#[tokio::test]
async fn xtream_auth_and_links() {
    let m = spawn().await;
    let bad: Value = reqwest::get(format!(
        "{}/xtream/player_api.php?username=x&password=y",
        m.base
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(bad["user_info"]["auth"], 0);
    let ok: Value = reqwest::get(format!(
        "{}/xtream/player_api.php?username=demo&password=secret",
        m.base
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(ok["user_info"]["auth"], 1);
    assert!(ok["server_info"].is_object());
    let live: Value = reqwest::get(format!(
        "{}/xtream/player_api.php?username=demo&password=secret&action=get_live_streams",
        m.base
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(live.as_array().unwrap().len(), 40);
    let hls = reqwest::get(format!("{}/xtream/live/demo/secret/101.m3u8", m.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(hls.starts_with("#EXTM3U"));
    assert_eq!(hls.matches("#EXTINF:2").count(), 3);
    assert!(hls.contains(&format!("{}/xtream/seg/", m.base)));
}

#[tokio::test]
async fn large_m3u_streams_50k_entries() {
    let m = spawn().await;
    let r = reqwest::get(format!("{}/m3u/large.m3u?channels=50000", m.base))
        .await
        .unwrap();
    assert!(
        r.headers().get(header::CONTENT_LENGTH).is_none(),
        "should be streamed"
    );
    let text = r.text().await.unwrap();
    assert_eq!(text.matches("#EXTINF").count(), 50_000);
}

#[tokio::test]
async fn large_xmltv_reaches_target() {
    let m = spawn().await;
    let text = reqwest::get(format!("{}/xmltv/large.xml?mb=8", m.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(text.len() >= 8 * gen::MIB, "len {}", text.len());
    assert!(text.trim_end().ends_with("</tv>"));
    assert_eq!(text.matches("<channel id=").count(), 400);
}

#[tokio::test]
async fn gzip_guide_decodes() {
    use std::io::Read;
    let m = spawn().await;
    let gz = client()
        .get(format!("{}/xmltv/sample.xml.gz", m.base))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let mut s = String::new();
    flate2::read::GzDecoder::new(&gz[..])
        .read_to_string(&mut s)
        .unwrap();
    assert!(s.contains("<tv") && s.contains("bbc1.uk"));
}

#[tokio::test]
async fn range_requests() {
    let m = spawn().await;
    let c = client();
    let url = format!("{}/files/video.bin", m.base);
    let full = c.head(&url).send().await.unwrap();
    assert_eq!(
        full.headers()[header::CONTENT_LENGTH],
        iptv_mock::VIDEO_BIN_LEN.to_string()
    );
    assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
    let etag = full.headers()[header::ETAG].to_str().unwrap().to_string();
    assert!(full.headers().contains_key(header::LAST_MODIFIED));

    let r = c
        .get(&url)
        .header(header::RANGE, "bytes=1000-1999")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(
        r.headers()[header::CONTENT_RANGE],
        format!("bytes 1000-1999/{}", iptv_mock::VIDEO_BIN_LEN)
    );
    assert_eq!(
        r.bytes().await.unwrap().to_vec(),
        iptv_mock::video_bytes(1000, 1000)
    );

    let open = c
        .get(&url)
        .header(header::RANGE, "bytes=20971000-")
        .send()
        .await
        .unwrap();
    assert_eq!(open.status(), 206);
    assert_eq!(open.bytes().await.unwrap().len(), 520);

    let bad = c
        .get(&url)
        .header(header::RANGE, "bytes=999999999-")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 416);

    let stale = c
        .get(&url)
        .header(header::RANGE, "bytes=0-9")
        .header(header::IF_RANGE, "\"other\"")
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 200);
    drop(stale);
    let fresh = c
        .get(&url)
        .header(header::RANGE, "bytes=0-9")
        .header(header::IF_RANGE, &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(fresh.status(), 206);

    let mp4 = c
        .get(format!("{}/xtream/movie/demo/secret/201.mp4", m.base))
        .header(header::RANGE, "bytes=4-7")
        .send()
        .await
        .unwrap();
    assert_eq!(mp4.status(), 206);
    assert_eq!(&mp4.bytes().await.unwrap()[..], b"ftyp");
}

#[tokio::test]
async fn flaky_fails_once_then_succeeds() {
    let m = spawn().await;
    let url = format!("{}/files/flaky.bin", m.base);
    let first = reqwest::get(&url).await.unwrap();
    assert_eq!(first.status(), 200);
    assert!(
        first.bytes().await.is_err(),
        "first download must be cut off"
    );
    let second = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
    assert_eq!(second.len() as u64, iptv_mock::VIDEO_BIN_LEN);
    assert_eq!(
        second[5_000_000..5_000_100].to_vec(),
        iptv_mock::video_bytes(5_000_000, 100)
    );
}

#[tokio::test]
async fn nolen_is_chunked_without_ranges() {
    let m = spawn().await;
    let r = client()
        .get(format!("{}/files/nolen.bin", m.base))
        .header(header::RANGE, "bytes=10-20")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().get(header::CONTENT_LENGTH).is_none());
    assert!(r
        .headers()
        .get(header::ACCEPT_RANGES)
        .is_none_or(|v| v == "none"));
    assert_eq!(r.bytes().await.unwrap().len() as u64, iptv_mock::NOLEN_LEN);
}

#[tokio::test]
async fn stalker_auth_flow() {
    let m = spawn().await;
    let c = client();
    let portal = format!("{}/stalker/portal.php", m.base);
    let cookie = "mac=00%3A1A%3A79%3A00%3A00%3A01; stb_lang=en; timezone=UTC";

    let unauth = c
        .get(format!("{portal}?type=stb&action=get_profile"))
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.text().await.unwrap(), stalker::AUTH_FAILED);

    let hs: Value = c
        .get(format!("{portal}?type=stb&action=handshake"))
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hs["js"]["token"], stalker::TOKEN);

    let bearer = format!("Bearer {}", stalker::TOKEN);
    let get = |q: &str| {
        c.get(format!("{portal}?{q}"))
            .header(header::COOKIE, cookie)
            .header(header::AUTHORIZATION, &bearer)
            .send()
    };
    let profile: Value = get("type=stb&action=get_profile")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(profile["js"]["mac"], stalker::MAC);
    let chans: Value = get("type=itv&action=get_all_channels")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(chans["js"]["data"].as_array().unwrap().len(), 30);
    let link: Value = get("type=itv&action=create_link&cmd=ffmpeg%20http://localhost/ch/1001_")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        link["js"]["cmd"],
        format!("ffmpeg {}/xtream/live/demo/secret/101.m3u8", m.base)
    );
    let epg: Value = get("type=itv&action=get_short_epg&ch_id=1001")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!epg["js"].as_array().unwrap().is_empty());

    // POST form body works too.
    let post: Value = c
        .post(&portal)
        .header(header::COOKIE, cookie)
        .header(header::AUTHORIZATION, &bearer)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body("type=vod&action=get_ordered_list&p=2")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(post["js"]["cur_page"], 2);

    // Unregistered MAC.
    let other: Value = c
        .get(format!("{portal}?type=stb&action=get_profile"))
        .header(header::COOKIE, "mac=00:1A:79:FF:FF:FF")
        .header(header::AUTHORIZATION, &bearer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(other["js"]["status"], 1);

    // Expiring the token forces a new handshake.
    c.post(format!("{}/stalker/_control/expire", m.base))
        .send()
        .await
        .unwrap();
    let expired = get("type=stb&action=get_profile")
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(expired, stalker::AUTH_FAILED);
}

#[tokio::test]
async fn protected_m3u_requires_headers() {
    let m = spawn().await;
    let c = client();
    let url = format!("{}/m3u/protected.m3u", m.base);
    assert_eq!(c.get(&url).send().await.unwrap().status(), 403);
    let ok = c
        .get(&url)
        .header(header::USER_AGENT, "IPTVMockAgent/1.0")
        .header(header::REFERER, "http://referer.mock/")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
}

// ---------------------------------------------------------------------------
// Fixture files stay in sync with the generators.
// Regenerate with `UPDATE_FIXTURES=1 cargo test -p iptv-mock --test routes`.
// ---------------------------------------------------------------------------

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

/// Fixed clock for payload fixtures: 2026-01-01 12:10 UTC.
const FIXTURE_NOW: i64 = catalog::EPOCH + 12 * 3_600 + 600;

fn check(name: &str, expected: &str, failures: &mut Vec<String>) {
    let path = fixtures_dir().join(name);
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, expected).unwrap();
    }
    let actual = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    if actual != expected {
        failures.push(name.to_string());
    }
}

#[test]
fn fixture_files_in_sync() {
    let mut failures = Vec::new();
    check(
        "sample.m3u",
        &gen::sample_m3u(gen::DEFAULT_BASE),
        &mut failures,
    );
    check(
        "sample.xml",
        &gen::sample_xmltv(gen::DEFAULT_BASE, catalog::EPOCH),
        &mut failures,
    );
    let payloads = xtream::sample_payloads(gen::DEFAULT_BASE, FIXTURE_NOW)
        .into_iter()
        .chain(stalker::sample_payloads(gen::DEFAULT_BASE, FIXTURE_NOW));
    for (name, value) in payloads {
        let mut text = serde_json::to_string_pretty(&value).unwrap();
        text.push('\n');
        check(name, &text, &mut failures);
    }
    assert!(
        failures.is_empty(),
        "out of date: {failures:?}; run UPDATE_FIXTURES=1 cargo test -p iptv-mock --test routes"
    );
}

/// hls.js stalls on per-segment discontinuities: the live playlist must be one
/// continuous stream whose segments carry increasing timestamps.
#[tokio::test]
async fn live_hls_is_continuous() {
    let m = spawn().await;
    let text = reqwest::get(format!("{}/xtream/live/demo/secret/101.m3u8", m.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let uris: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with("http"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(uris.len(), 3);
    // No discontinuity tag precedes any segment (the loop wrap is re-timestamped, so it needs none).
    assert!(!lines.contains(&"#EXT-X-DISCONTINUITY"), "{text}");
    assert!(text.contains("#EXT-X-DISCONTINUITY-SEQUENCE:0\n"));
    let seq: u64 = lines
        .iter()
        .find_map(|l| l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:"))
        .unwrap()
        .parse()
        .unwrap();
    let names: Vec<u64> = uris
        .iter()
        .map(|i| {
            lines[*i]
                .rsplit('/')
                .next()
                .unwrap()
                .trim_end_matches(".ts")
                .parse()
                .unwrap()
        })
        .collect();
    assert_eq!(names, [seq, seq + 1, seq + 2]);

    // Served segments, including across the 16-segment loop wrap, step by 2 s of PTS.
    let first_pts = |ts: &[u8]| -> u64 {
        for pkt in ts.as_chunks::<188>().0 {
            let afc = (pkt[3] >> 4) & 3;
            let idx = if afc & 2 != 0 { 5 + pkt[4] as usize } else { 4 };
            if pkt[1] & 0x40 != 0
                && afc & 1 != 0
                && idx + 14 <= 188
                && pkt[idx..idx + 3] == [0, 0, 1]
                && pkt[idx + 7] & 0x80 != 0
            {
                let b = &pkt[idx + 9..idx + 14];
                return (((b[0] as u64) >> 1) & 7) << 30
                    | (b[1] as u64) << 22
                    | ((b[2] as u64) >> 1) << 15
                    | (b[3] as u64) << 7
                    | (b[4] as u64) >> 1;
            }
        }
        panic!("no PTS");
    };
    let mut prev = None;
    for n in [seq, seq + 1, 15, 16] {
        let body = reqwest::get(format!("{}/xtream/seg/{n}.ts", m.base))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(body[0], 0x47);
        let pts = first_pts(&body);
        if let Some((pn, pp)) = prev {
            if n == pn + 1 {
                let d = (pts + (1u64 << 33) - pp) & ((1u64 << 33) - 1);
                assert!((178_000..=182_000).contains(&d), "seg {pn}->{n}: {d}");
            }
        }
        prev = Some((n, pts));
    }
}

/// B8: the `/fail/...` routes answer with the failure they document.
#[tokio::test]
async fn failure_routes_answer_as_documented() {
    use iptv_mock::failures::{LOGIN_HTML, MALFORMED_M3U};
    let m = spawn().await;
    let c = client();
    let get = |p: &str| c.get(format!("{}{p}", m.base)).send();
    for (path, code) in [
        ("/fail/401.m3u", 401),
        ("/fail/403.m3u", 403),
        ("/fail/404.m3u", 404),
        ("/fail/503.m3u", 503),
        ("/fail/status/410", 410),
        ("/fail/status/429", 429),
    ] {
        let r = get(path).await.unwrap();
        assert_eq!(r.status().as_u16(), code, "{path}");
        assert_eq!(
            r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "*",
            "{path}"
        );
    }
    let r = get("/fail/401.m3u").await.unwrap();
    assert!(r.headers().contains_key(header::WWW_AUTHENTICATE));
    assert_eq!(get("/fail/status/9999").await.unwrap().status(), 400);

    assert_eq!(
        get("/fail/empty.m3u").await.unwrap().text().await.unwrap(),
        ""
    );
    assert_eq!(
        get("/fail/malformed.m3u")
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        MALFORMED_M3U
    );
    assert_eq!(
        get("/fail/login.m3u").await.unwrap().text().await.unwrap(),
        LOGIN_HTML
    );
    let broken = get("/fail/broken.m3u").await.unwrap().text().await.unwrap();
    assert!(broken.starts_with("#EXTM3U") && broken.contains("garbage line"));
    let hls = get("/fail/hls.m3u8").await.unwrap().text().await.unwrap();
    assert!(hls.contains("#EXT-X-TARGETDURATION"));
    let xml = get("/fail/malformed.xml")
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(xml.starts_with("<?xml") && !xml.contains("</tv>"));

    // The endless stream starts with MPEG-TS sync bytes.
    let mut r = get("/fail/stream.ts").await.unwrap();
    assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp2t");
    let first = r.chunk().await.unwrap().unwrap();
    assert_eq!(first[0], 0x47);
    assert_eq!(first[188], 0x47);
    drop(r);

    // Slow answers wait for the requested delay.
    let started = std::time::Instant::now();
    let body = get("/fail/slow.m3u?ms=300")
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(started.elapsed() >= std::time::Duration::from_millis(300));
    assert!(body.starts_with("#EXTM3U"));

    // A stalled body sends its first line, then nothing.
    let mut r = get("/fail/stall.m3u").await.unwrap();
    assert_eq!(&r.chunk().await.unwrap().unwrap()[..], b"#EXTM3U\n");
    let next = tokio::time::timeout(std::time::Duration::from_millis(300), r.chunk()).await;
    assert!(next.is_err(), "stall.m3u kept sending");
}

/// B8: `/m3u/10k.m3u` is the 10 000-entry fixture.
#[tokio::test]
async fn ten_k_playlist_has_ten_thousand_entries() {
    let m = spawn().await;
    let text = client()
        .get(format!("{}/m3u/10k.m3u", m.base))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(
        text.matches("#EXTINF").count(),
        iptv_mock::playlists::TEN_K_CHANNELS
    );
}

/// B9: slow large playlist, hung headers, Xtream failure panels, non-ASCII.
#[tokio::test]
async fn b9_failure_routes_answer_as_documented() {
    use iptv_mock::failures::UNICODE_CHANNELS;
    use std::time::{Duration, Instant};
    let m = spawn().await;
    let c = client();
    let get = |p: &str| c.get(format!("{}{p}", m.base)).send();

    // The slow large playlist is paced chunk by chunk but complete.
    let started = Instant::now();
    let text = get("/fail/slow-large.m3u?channels=2000&ms=50")
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(text.matches("#EXTINF").count(), 2000);
    let chunks = gen::M3uGen::new(&m.base, 2000, 20).count() as u32;
    assert!(chunks > 1, "the test playlist should span several chunks");
    assert!(started.elapsed() >= Duration::from_millis(50) * (chunks - 1));

    // A hung server never sends its status line.
    let hung = tokio::time::timeout(Duration::from_millis(300), get("/fail/hang.m3u")).await;
    assert!(hung.is_err(), "hang.m3u answered");

    for (mode, code) in [("401", 401), ("403", 403), ("404", 404), ("503", 503)] {
        for file in ["player_api.php", "get.php", "xmltv.php"] {
            let r = get(&format!(
                "/fail/xtream/{mode}/{file}?username=demo&password=secret"
            ))
            .await
            .unwrap();
            assert_eq!(r.status().as_u16(), code, "{mode}/{file}");
        }
    }
    let html = get("/fail/xtream/html/player_api.php").await.unwrap();
    assert!(html.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    let bad = get("/fail/xtream/badjson/player_api.php")
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(serde_json::from_str::<Value>(&bad).is_err());
    assert_eq!(
        get("/fail/xtream/nope/player_api.php")
            .await
            .unwrap()
            .status(),
        400
    );
    let hung = tokio::time::timeout(
        Duration::from_millis(300),
        get("/fail/xtream/hang/player_api.php"),
    )
    .await;
    assert!(hung.is_err(), "the hung panel answered");

    let bytes = get("/fail/unicode.m3u")
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(bytes.starts_with(b"\xEF\xBB\xBF#EXTM3U\r\n"));
    let text = std::str::from_utf8(&bytes).unwrap();
    assert_eq!(text.matches("#EXTINF").count(), UNICODE_CHANNELS.len());
    for (group, name) in UNICODE_CHANNELS {
        assert!(
            text.contains(&format!("group-title=\"{group}\",{name}\r\n")),
            "{name}"
        );
    }
    assert!(!text.is_ascii());
}
