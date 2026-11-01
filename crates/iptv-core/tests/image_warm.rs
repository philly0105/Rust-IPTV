//! `images.warm`: the fetch gate names the pictures it has queued, and the
//! cache fetches the ones it does not hold in parallel instead of a few at a
//! time behind the browser's connections. A warm answers once its pictures
//! are queued; a picture's own request joins the running fetch; warms take
//! at most [`WARM_PER_HOST`] of one host's slots and [`WARM_MAX`] of all;
//! requests go past the warms up to [`UPSTREAM_PER_HOST`], and a request
//! waiting for a slot goes before queued warms; a fetch gives its slots back
//! before its resize; clearing the cache drops the warms not started; and
//! server mode checks every warmed picture against the guard like a request.

use axum::extract::{Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use image::codecs::jpeg::JpegEncoder;
use image::{ImageEncoder, Rgb, RgbImage};
use iptv_core::events::NoopSink;
use iptv_core::http::ServerMode;
use iptv_core::imagecache::{
    self, WarmItem, UPSTREAM_PER_HOST, WARM_MAX, WARM_MAX_ITEMS, WARM_PER_HOST,
};
use iptv_core::AppState;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

/// Requests a host (or a set of hosts) is answering right now, and the most
/// it ever answered at once.
#[derive(Default)]
struct Load {
    now: AtomicUsize,
    max: AtomicUsize,
}

impl Load {
    fn enter(&self) {
        let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
        self.max.fetch_max(now, Ordering::SeqCst);
    }

    fn leave(&self) {
        self.now.fetch_sub(1, Ordering::SeqCst);
    }

    fn max(&self) -> usize {
        self.max.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct Track {
    arrivals: Arc<Mutex<Vec<String>>>,
    host: Arc<Load>,
    all: Arc<Load>,
}

async fn track(State(t): State<Track>, req: Request, next: axum::middleware::Next) -> Response {
    t.arrivals.lock().push(req.uri().path().to_owned());
    t.host.enter();
    t.all.enter();
    let res = next.run(req).await;
    t.host.leave();
    t.all.leave();
    res
}

/// A small PNG-looking body (the resizer leaves it as it is).
fn png() -> Response {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(900, 7);
    ([(header::CONTENT_TYPE, "image/png")], png).into_response()
}

/// A 340x510 poster: narrower than the 384 bucket the measurement asks
/// for, so the resizer reads its header and keeps it. A debug build's resize
/// would otherwise set the pace instead of the network.
fn poster_jpeg() -> Vec<u8> {
    let img = RgbImage::from_fn(340, 510, |x, y| {
        Rgb([
            (x * 255 / 340) as u8,
            (y * 255 / 510) as u8,
            ((x ^ y) % 256) as u8,
        ])
    });
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 92)
        .write_image(img.as_raw(), 340, 510, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

/// An image host: `/ok/*` answers at once, `/held/*` once the test adds a
/// permit to `release`, `/slow/*` sends a poster after `latency`.
struct Host {
    base: String,
    arrivals: Arc<Mutex<Vec<String>>>,
    load: Arc<Load>,
    release: Arc<Semaphore>,
}

impl Host {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn arrivals(&self) -> Vec<String> {
        self.arrivals.lock().clone()
    }

    fn hits(&self, path: &str) -> usize {
        self.arrivals.lock().iter().filter(|p| *p == path).count()
    }

    /// Waits until `n` requests reached the host.
    async fn reached(&self, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.arrivals.lock().len() < n {
            assert!(
                Instant::now() < deadline,
                "{n} requests never reached the host: {:?}",
                self.arrivals()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Waits until the host answers nothing.
    async fn idle(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.load.now.load(Ordering::SeqCst) > 0 {
            assert!(Instant::now() < deadline, "the host never went idle");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

async fn spawn_host(all: Arc<Load>, latency: Duration) -> Host {
    let track = Track {
        arrivals: Arc::default(),
        host: Arc::default(),
        all,
    };
    let release = Arc::new(Semaphore::new(0));
    let held = release.clone();
    let poster = Arc::new(poster_jpeg());
    let app = Router::new()
        .route("/ok/{name}", get(|| async { png() }))
        .route(
            "/held/{name}",
            get(move || async move {
                held.acquire().await.unwrap().forget();
                png()
            }),
        )
        .route(
            "/slow/{name}",
            get(move || {
                let poster = poster.clone();
                async move {
                    tokio::time::sleep(latency).await;
                    ([(header::CONTENT_TYPE, "image/jpeg")], poster.to_vec()).into_response()
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            track.clone(),
            self::track,
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Host {
        base: format!("http://127.0.0.1:{port}"),
        arrivals: track.arrivals,
        load: track.host,
        release,
    }
}

async fn new_state() -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    (dir, state)
}

fn item(url: &str, w: Option<u32>) -> WarmItem {
    WarmItem {
        url: url.to_owned(),
        source_id: None,
        w,
    }
}

#[tokio::test]
async fn a_warmed_picture_is_fetched_once_when_its_own_request_follows() {
    let host = spawn_host(Arc::default(), Duration::ZERO).await;
    let (_dir, state) = new_state().await;
    let url = host.url("/held/a.png");

    // The warm answers while the host still holds the fetch.
    imagecache::warm(&state, vec![item(&url, Some(192))]).await;
    host.reached(1).await;
    // The picture's own request (the gate's <img>) joins it.
    let request = {
        let (state, url) = (state.clone(), url.clone());
        tokio::spawn(async move { imagecache::fetch_sized(&state, &url, None, Some(180)).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!request.is_finished(), "it waits for the warmed fetch");
    host.release.add_permits(1);
    request.await.unwrap().unwrap();
    assert_eq!(host.hits("/held/a.png"), 1);

    // A stored picture is not fetched again by a warm.
    imagecache::warm(&state, vec![item(&url, Some(192))]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(host.hits("/held/a.png"), 1);
}

#[tokio::test]
async fn warms_go_to_one_host_at_most_eight_at_a_time_and_one_call_takes_48() {
    let host = spawn_host(Arc::default(), Duration::ZERO).await;
    let (_dir, state) = new_state().await;
    let paths: Vec<String> = (0..50).map(|i| format!("/held/{i}.png")).collect();
    let items = paths
        .iter()
        .map(|p| item(&host.url(p), Some(192)))
        .collect();
    imagecache::warm(&state, items).await;

    // More at once than the browser's six connections, never more than the
    // warms' share of the host's slots, and the first in the batch first.
    host.reached(WARM_PER_HOST).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let first: HashSet<String> = host.arrivals().into_iter().collect();
    assert_eq!(first, paths[..WARM_PER_HOST].iter().cloned().collect());

    host.release.add_permits(1000);
    host.reached(WARM_MAX_ITEMS).await;
    host.idle().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let all: HashSet<String> = host.arrivals().into_iter().collect();
    assert_eq!(
        all,
        paths[..WARM_MAX_ITEMS].iter().cloned().collect(),
        "each once; the items past the batch's cap are dropped"
    );
    assert_eq!(host.arrivals().len(), WARM_MAX_ITEMS);
    assert_eq!(host.load.max(), WARM_PER_HOST);
    let stats = imagecache::stats(&state).await.unwrap();
    assert_eq!(stats.files, WARM_MAX_ITEMS as u64);
}

#[tokio::test]
async fn warms_across_hosts_share_the_slots_of_all() {
    let all = Arc::new(Load::default());
    let mut hosts = Vec::new();
    for _ in 0..3 {
        hosts.push(spawn_host(all.clone(), Duration::ZERO).await);
    }
    let (_dir, state) = new_state().await;
    let items = (0..16)
        .flat_map(|i| {
            hosts
                .iter()
                .map(move |h| item(&h.url(&format!("/held/{i}.png")), Some(64)))
        })
        .collect();
    imagecache::warm(&state, items).await;
    let total = || hosts.iter().map(|h| h.arrivals().len()).sum::<usize>();
    let deadline = Instant::now() + Duration::from_secs(10);
    while total() < WARM_MAX {
        assert!(Instant::now() < deadline, "only {} went out", total());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(total(), WARM_MAX);
    for h in &hosts {
        h.release.add_permits(1000);
    }
    for h in &hosts {
        h.reached(16).await;
        h.idle().await;
        assert!(h.load.max() <= WARM_PER_HOST, "{}", h.load.max());
    }
    assert_eq!(all.max(), WARM_MAX);
}

#[tokio::test]
async fn requests_go_past_the_warms_and_a_waiting_one_goes_before_them() {
    let host = spawn_host(Arc::default(), Duration::ZERO).await;
    let (_dir, state) = new_state().await;
    let items = (0..20)
        .map(|i| item(&host.url(&format!("/held/{i}.png")), Some(192)))
        .collect();
    imagecache::warm(&state, items).await;
    host.reached(WARM_PER_HOST).await;

    // Users scrolled on: the pictures of their new screens ask. They do not
    // wait behind the warms up to the host's cap; the one past it waits for
    // a slot.
    let more = UPSTREAM_PER_HOST - WARM_PER_HOST;
    let requests: Vec<_> = (0..=more)
        .map(|i| {
            let (state, url) = (state.clone(), host.url(&format!("/held/now{i}.png")));
            tokio::spawn(
                async move { imagecache::fetch_sized(&state, &url, None, Some(192)).await },
            )
        })
        .collect();
    host.reached(UPSTREAM_PER_HOST).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let arrivals = host.arrivals();
    assert_eq!(arrivals.len(), UPSTREAM_PER_HOST);
    assert!(arrivals[WARM_PER_HOST..]
        .iter()
        .all(|p| p.starts_with("/held/now")));
    // One fetch ends: its slot goes to the waiting request, not to the
    // twelve warms queued before it.
    host.release.add_permits(1);
    host.reached(UPSTREAM_PER_HOST + 1).await;
    assert!(
        host.arrivals()[UPSTREAM_PER_HOST].starts_with("/held/now"),
        "{:?}",
        host.arrivals()
    );
    host.release.add_permits(1000);
    for request in requests {
        request.await.unwrap().unwrap();
    }
    host.reached(20 + more + 1).await;
}

#[tokio::test]
async fn a_fetch_gives_its_slots_back_before_its_resize() {
    let host = spawn_host(Arc::default(), Duration::ZERO).await;
    let (_dir, state) = new_state().await;
    // No body can be resized: each fetched one waits for a resize slot.
    let resizes = imagecache::hold_resizes_for_tests(&state).await;
    let paths: Vec<String> = (0..20).map(|i| format!("/ok/{i}.png")).collect();
    let items = paths
        .iter()
        .map(|p| item(&host.url(p), Some(192)))
        .collect();
    imagecache::warm(&state, items).await;
    // Every warm reached the host, not only the first slots' worth.
    host.reached(paths.len()).await;
    drop(resizes);
    let deadline = Instant::now() + Duration::from_secs(10);
    while imagecache::stats(&state).await.unwrap().files < paths.len() as u64 {
        assert!(Instant::now() < deadline, "the pictures were never stored");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(host.arrivals().len(), paths.len());
}

#[tokio::test]
async fn clearing_the_cache_drops_the_warms_not_started() {
    let host = spawn_host(Arc::default(), Duration::ZERO).await;
    let (_dir, state) = new_state().await;
    let items = (0..20)
        .map(|i| item(&host.url(&format!("/held/{i}.png")), Some(192)))
        .collect();
    imagecache::warm(&state, items).await;
    host.reached(WARM_PER_HOST).await;
    imagecache::clear(&state).await.unwrap();
    host.release.add_permits(1000);
    host.idle().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.arrivals().len(), WARM_PER_HOST);
}

#[tokio::test]
async fn server_mode_warms_only_what_the_guard_lets_a_request_fetch() {
    let host = spawn_host(Arc::default(), Duration::ZERO).await;
    let (_dir, state) = new_state().await;
    ServerMode::install(&state, false).unwrap();

    // A loopback literal without a trusted source: refused, never asked.
    imagecache::warm(&state, vec![item(&host.url("/ok/a.png"), Some(192))]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.arrivals().len(), 0);

    // The same host named by a source whose own server it is.
    let config = serde_json::json!({ "url": host.url("/list.m3u") }).to_string();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO sources(id, kind, name, config_json) VALUES ('s1', 'm3u', 'S', ?1)",
                [config],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let trusted = WarmItem {
        source_id: Some("s1".into()),
        ..item(&host.url("/ok/a.png"), Some(192))
    };
    imagecache::warm(&state, vec![trusted]).await;
    host.reached(1).await;
    assert_eq!(host.hits("/ok/a.png"), 1);
}

/// One cold wall of `n` posters spread over `hosts`, loaded the way the
/// fetch gate loads it: `sockets` requests at once, each the next poster
/// once the last one answered. With `warm`, the posters still waiting are
/// warmed once the first requests have run 150 ms, as the gate does.
async fn fill_wall(hosts: &[Host], n: usize, sockets: usize, warm: bool, tag: &str) -> Duration {
    let (_dir, state) = new_state().await;
    let urls: Vec<String> = (0..n)
        .map(|i| hosts[i % hosts.len()].url(&format!("/slow/{tag}-{i}.jpg")))
        .collect();
    let next = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let workers: Vec<_> = (0..sockets)
        .map(|_| {
            let (state, urls, next) = (state.clone(), urls.clone(), next.clone());
            tokio::spawn(async move {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(url) = urls.get(i) else { break };
                    imagecache::fetch_sized_within(
                        &state,
                        url,
                        None,
                        Some(360),
                        Some(Duration::from_secs(4)),
                    )
                    .await
                    .unwrap();
                }
            })
        })
        .collect();
    if warm {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let waiting = urls[sockets.min(n)..]
            .iter()
            .map(|u| item(u, Some(360)))
            .collect();
        imagecache::warm(&state, waiting).await;
    }
    for w in workers {
        w.await.unwrap();
    }
    started.elapsed()
}

/// Before and after numbers for warming: 30 posters behind 300 ms of
/// latency, on one host and spread over three, with the gate's desktop (6)
/// and server-mode (4) caps. The best of two runs of each.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "timing only; run with -- --ignored --nocapture"]
async fn measure_a_cold_wall_with_and_without_warming() {
    let latency = Duration::from_millis(300);
    let all = Arc::new(Load::default());
    let mut hosts = Vec::new();
    for _ in 0..3 {
        hosts.push(spawn_host(all.clone(), latency).await);
    }
    println!("30 posters, 300 ms upstream latency");
    for (spread, label) in [(1, "one host"), (3, "three hosts")] {
        for (sockets, gate) in [(6, "desktop"), (4, "server mode")] {
            let mut best = [Duration::MAX; 2];
            for run in 0..2 {
                for (warm, best) in [false, true].into_iter().zip(best.iter_mut()) {
                    let tag = format!("{spread}-{sockets}-{run}-{warm}");
                    let took = fill_wall(&hosts[..spread], 30, sockets, warm, &tag).await;
                    *best = (*best).min(took);
                }
            }
            println!(
                "{label:>11}, {gate:>11} ({sockets} at once): {:>5} ms before, {:>5} ms with warm",
                best[0].as_millis(),
                best[1].as_millis()
            );
        }
    }
}
