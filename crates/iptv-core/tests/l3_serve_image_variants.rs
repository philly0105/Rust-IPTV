//! Loop 3 (core-serve, L3-perf-desktop-3): width hints. A request with a
//! hint (`fetch_sized`, `/api/img?...&w=<px>`) gets a JPEG or PNG copy no
//! wider than the hint's bucket, cached under its own key, so a poster wall
//! moves and stores a fraction of the bytes. SVG, GIF, small and broken
//! images are served as stored; PNG keeps its transparency; a full-size
//! original or a wider copy already in the cache is reused instead of
//! refetched; a host that picks the format from `Accept` sends a variant
//! fetch a JPEG, not WebP.

use axum::extract::{Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{GenericImageView, ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use iptv_core::events::NoopSink;
use iptv_core::imagecache::{self, cache_key, normalize_url, resize, variant_key};
use iptv_core::AppState;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

async fn new_state(dir: &Path) -> Arc<AppState> {
    AppState::new(dir.to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap()
}

/// A 600x900 poster with detail (about the size real portals serve).
fn poster_jpeg() -> Vec<u8> {
    let img = RgbImage::from_fn(600, 900, |x, y| {
        Rgb([
            (x * 255 / 600) as u8,
            (y * 255 / 900) as u8,
            ((x ^ y) % 256) as u8,
        ])
    });
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 92)
        .write_image(img.as_raw(), 600, 900, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

/// A `side`-px square RGBA logo whose left half is transparent.
fn logo_png(side: u32) -> Vec<u8> {
    let img = RgbaImage::from_fn(side, side, |x, y| {
        let a = if x < side / 2 { 0 } else { 255 };
        Rgba([(x * 5 % 256) as u8, (y * 3 % 256) as u8, 90, a])
    });
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(img.as_raw(), side, side, image::ExtendedColorType::Rgba8)
        .unwrap();
    out
}

const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;";
const SVG: &str = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10'/></svg>";
/// A WebP header and filler: the resizer leaves WebP alone, so the bytes
/// only have to look like one.
const WEBP: &[u8] = b"RIFF\x24\0\0\0WEBPVP8 \x18\0\0\0filler bytes of a picture";

struct Stub {
    base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Stub {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    fn hits(&self, path: &str) -> usize {
        self.hits.lock().get(path).copied().unwrap_or(0)
    }
}

async fn count(
    State(hits): State<Arc<Mutex<HashMap<String, usize>>>>,
    req: Request,
    next: axum::middleware::Next,
) -> Response {
    *hits.lock().entry(req.uri().path().to_owned()).or_default() += 1;
    next.run(req).await
}

fn typed(ct: &'static str, body: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, ct)], body).into_response()
}

async fn spawn_stub() -> Stub {
    let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
    let poster = poster_jpeg();
    let negotiated = poster.clone();
    let app = Router::new()
        .route(
            "/poster.jpg",
            get(move || {
                let body = poster.clone();
                async move { typed("image/jpeg", body) }
            }),
        )
        // Picks the format from `Accept`, like TMDB's image CDN: WebP to
        // whoever names it, else the JPEG.
        .route(
            "/negotiated.jpg",
            get(move |headers: header::HeaderMap| {
                let jpeg = negotiated.clone();
                async move {
                    let accept = headers
                        .get(header::ACCEPT)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default();
                    if accept.contains("image/webp") {
                        typed("image/webp", WEBP.to_vec())
                    } else {
                        typed("image/jpeg", jpeg)
                    }
                }
            }),
        )
        .route(
            "/logo.png",
            get(|| async { typed("image/png", logo_png(300)) }),
        )
        .route(
            "/small.png",
            get(|| async { typed("image/png", logo_png(100)) }),
        )
        .route(
            "/anim.gif",
            get(|| async { typed("image/gif", GIF.to_vec()) }),
        )
        .route(
            "/mark.svg",
            get(|| async { typed("image/svg+xml", SVG.as_bytes().to_vec()) }),
        )
        .layer(axum::middleware::from_fn_with_state(hits.clone(), count));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Stub {
        base: format!("http://127.0.0.1:{port}"),
        hits,
    }
}

/// `(key, url, bytes)` of every index row, after the writer committed.
async fn rows(state: &Arc<AppState>) -> Vec<(String, String, u64)> {
    // `images.stats` is a barrier: queued inserts commit before it reads.
    imagecache::stats(state).await.unwrap();
    state
        .db_call(|c| {
            let mut stmt = c.prepare("SELECT key, url, bytes FROM image_cache ORDER BY url")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u64))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn a_poster_with_a_width_hint_is_stored_and_served_small() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/poster.jpg");
    let original_len = poster_jpeg().len() as u64;

    // 180 CSS px at DPR 2 -> the 384 bucket.
    let first = imagecache::fetch_sized(&state, &url, None, Some(360))
        .await
        .unwrap();
    assert!(!first.hit);
    assert_eq!(first.content_type, "image/jpeg");
    let body = std::fs::read(&first.path).unwrap();
    assert_eq!(body.len() as u64, first.bytes);
    assert_eq!(
        image::load_from_memory(&body).unwrap().dimensions(),
        (384, 576)
    );
    assert!(
        first.bytes * 4 < original_len * 3,
        "{} vs {original_len}",
        first.bytes
    );

    // Only the copy is stored, under its own key.
    let norm = normalize_url(&url).unwrap();
    let stored = rows(&state).await;
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(stored[0].0, variant_key(&norm, 384));
    assert_eq!(stored[0].1, format!("{norm}#w=384"));
    assert_eq!(stored[0].2, first.bytes);

    // Any hint in the same bucket is a disk hit, without an upstream fetch.
    let again = imagecache::fetch_sized(&state, &url, None, Some(300))
        .await
        .unwrap();
    assert!(again.hit);
    assert_eq!(again.path, first.path);
    assert_eq!(stub.hits("/poster.jpg"), 1);

    // No hint, a zero hint or one above the largest bucket: the original.
    for hint in [None, Some(0), Some(4000)] {
        let full = imagecache::fetch_sized(&state, &url, None, hint)
            .await
            .unwrap();
        assert_eq!(full.bytes, original_len, "{hint:?}");
    }
    assert_eq!(stub.hits("/poster.jpg"), 2, "the original was fetched once");
}

#[tokio::test]
async fn a_full_size_original_already_cached_is_resized_without_a_refetch() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/poster.jpg");
    // Cached before width hints existed.
    imagecache::fetch(&state, &url, None).await.unwrap();
    assert_eq!(stub.hits("/poster.jpg"), 1);

    let small = imagecache::fetch_sized(&state, &url, None, Some(180))
        .await
        .unwrap();
    assert_eq!(
        image::load_from_memory(&std::fs::read(&small.path).unwrap())
            .unwrap()
            .dimensions(),
        (192, 288)
    );
    assert_eq!(stub.hits("/poster.jpg"), 1, "made from the cached original");
    let keys: Vec<String> = rows(&state).await.into_iter().map(|r| r.0).collect();
    let norm = normalize_url(&url).unwrap();
    assert!(keys.contains(&cache_key(&norm)));
    assert!(keys.contains(&variant_key(&norm, 192)));
}

/// Width and height of the image stored at `path`.
fn dimensions(path: &Path) -> (u32, u32) {
    image::load_from_memory(&std::fs::read(path).unwrap())
        .unwrap()
        .dimensions()
}

#[tokio::test]
async fn a_smaller_copy_is_made_from_a_wider_one_without_a_refetch() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/poster.jpg");
    let norm = normalize_url(&url).unwrap();

    // A rail at DPR 2 (384), then a grid at DPR 1 (192).
    let wide = imagecache::fetch_sized(&state, &url, None, Some(360))
        .await
        .unwrap();
    assert_eq!(dimensions(&wide.path), (384, 576));
    let small = imagecache::fetch_sized(&state, &url, None, Some(150))
        .await
        .unwrap();
    assert!(
        small.hit,
        "made on disk, reported as a hit like the original's"
    );
    assert_eq!(small.content_type, "image/jpeg");
    assert_eq!(dimensions(&small.path), (192, 288));
    assert_eq!(stub.hits("/poster.jpg"), 1, "the poster was fetched once");
    let keys: Vec<String> = rows(&state).await.into_iter().map(|r| r.0).collect();
    assert_eq!(
        keys,
        [variant_key(&norm, 192), variant_key(&norm, 384)],
        "two copies, no original"
    );
    // The new copy is a disk hit from now on.
    let again = imagecache::fetch_sized(&state, &url, None, Some(180))
        .await
        .unwrap();
    assert!(again.hit);
    assert_eq!(again.path, small.path);

    // Nothing marked the copy as served by the original: the original,
    // which was never stored, is fetched when it is asked for.
    let full = imagecache::fetch(&state, &url, None).await.unwrap();
    assert!(!full.hit);
    assert_eq!(full.bytes, poster_jpeg().len() as u64);
    assert_eq!(stub.hits("/poster.jpg"), 2);
}

#[tokio::test]
async fn a_logo_in_the_list_and_the_guide_is_fetched_once_and_keeps_its_transparency() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/logo.png");
    // The Live list at DPR 2 (40 px: 96), then the guide (32 px: 64).
    let list = imagecache::fetch_sized(&state, &url, None, Some(80))
        .await
        .unwrap();
    let guide = imagecache::fetch_sized(&state, &url, None, Some(64))
        .await
        .unwrap();
    assert_eq!(stub.hits("/logo.png"), 1);
    assert_ne!(guide.path, list.path);
    assert_eq!(guide.content_type, "image/png");
    let decoded = image::load_from_memory(&std::fs::read(&guide.path).unwrap())
        .unwrap()
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (64, 64));
    assert_eq!(decoded.get_pixel(3, 30)[3], 0);
    assert_eq!(decoded.get_pixel(60, 30)[3], 255);
}

#[tokio::test]
async fn a_wider_copy_gone_from_disk_or_left_alone_by_the_resizer_falls_back_to_one_fetch() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/poster.jpg");
    let norm = normalize_url(&url).unwrap();

    // The wider copy's file vanished (evicted by another process, say).
    let wide = imagecache::fetch_sized(&state, &url, None, Some(360))
        .await
        .unwrap();
    rows(&state).await;
    std::fs::remove_file(&wide.path).unwrap();
    let small = imagecache::fetch_sized(&state, &url, None, Some(150))
        .await
        .unwrap();
    assert!(!small.hit);
    assert_eq!(dimensions(&small.path), (192, 288));
    assert_eq!(stub.hits("/poster.jpg"), 2);
    let keys: Vec<String> = rows(&state).await.into_iter().map(|r| r.0).collect();
    assert_eq!(keys, [variant_key(&norm, 192)], "the stale row is dropped");

    // A wider copy the resizer will not shrink (it only resizes JPEG and
    // PNG): the copy is fetched as on any miss, and later requests at
    // that width are not sent to an original that is not stored.
    let other = stub.url("/negotiated.jpg");
    let other_norm = normalize_url(&other).unwrap();
    let key = variant_key(&other_norm, 1024);
    let path = dir
        .path()
        .join(imagecache::DIR_NAME)
        .join(&key[..2])
        .join(&key);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, WEBP).unwrap();
    state
        .db_call(move |c| {
            c.execute(
                "INSERT INTO image_cache (key, url, content_type, bytes, created_at, last_access)
                 VALUES (?1, 'x', 'image/webp', ?2, 1, 1)",
                rusqlite::params![key, WEBP.len() as i64],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let copy = imagecache::fetch_sized(&state, &other, None, Some(512))
        .await
        .unwrap();
    assert!(!copy.hit);
    assert_eq!(copy.content_type, "image/jpeg");
    assert_eq!(dimensions(&copy.path), (512, 768));
    assert_eq!(stub.hits("/negotiated.jpg"), 1);
    let again = imagecache::fetch_sized(&state, &other, None, Some(512))
        .await
        .unwrap();
    assert!(again.hit);
    assert_eq!(again.path, copy.path);
    assert_eq!(stub.hits("/negotiated.jpg"), 1);
}

#[tokio::test]
async fn a_host_that_negotiates_the_format_sends_a_variant_fetch_one_the_resizer_reads() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let url = stub.url("/negotiated.jpg");

    // The variant fetch does not name WebP, so the host sends the JPEG and
    // the grid gets a 192 px copy instead of the full-size WebP.
    let small = imagecache::fetch_sized(&state, &url, None, Some(180))
        .await
        .unwrap();
    assert_eq!(small.content_type, "image/jpeg");
    assert_eq!(
        image::load_from_memory(&std::fs::read(&small.path).unwrap())
            .unwrap()
            .dimensions(),
        (192, 288)
    );
    let norm = normalize_url(&url).unwrap();
    let stored = rows(&state).await;
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(stored[0].0, variant_key(&norm, 192));

    // A full-size fetch still asks like a browser and gets the WebP.
    let full = imagecache::fetch(&state, &url, None).await.unwrap();
    assert_eq!(full.content_type, "image/webp");
    assert_eq!(full.bytes, WEBP.len() as u64);
    assert_eq!(stub.hits("/negotiated.jpg"), 2);
}

#[tokio::test]
async fn a_logo_keeps_its_transparency() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    let img = imagecache::fetch_sized(&state, &stub.url("/logo.png"), None, Some(128))
        .await
        .unwrap();
    assert_eq!(img.content_type, "image/png");
    assert!(img.bytes < logo_png(300).len() as u64);
    let decoded = image::load_from_memory(&std::fs::read(&img.path).unwrap())
        .unwrap()
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (128, 128));
    assert_eq!(decoded.get_pixel(3, 60)[3], 0);
    assert_eq!(decoded.get_pixel(124, 60)[3], 255);
}

#[tokio::test]
async fn small_gif_and_svg_images_are_served_as_stored_and_fetched_once() {
    let stub = spawn_stub().await;
    let dir = tempfile::tempdir().unwrap();
    let state = new_state(dir.path()).await;
    for (path, len) in [
        ("/small.png", logo_png(100).len()),
        ("/anim.gif", GIF.len()),
        ("/mark.svg", SVG.len()),
    ] {
        let url = stub.url(path);
        let first = imagecache::fetch_sized(&state, &url, None, Some(128))
            .await
            .unwrap();
        assert_eq!(first.bytes, len as u64, "{path}");
        // Stored once, as the original: a plain request is a disk hit.
        let plain = imagecache::fetch(&state, &url, None).await.unwrap();
        assert!(plain.hit, "{path}");
        assert_eq!(plain.path, first.path, "{path}");
        // A second hint is served from the original without another fetch.
        let again = imagecache::fetch_sized(&state, &url, None, Some(150))
            .await
            .unwrap();
        assert!(again.hit, "{path}");
        assert_eq!(again.path, first.path, "{path}");
        assert_eq!(stub.hits(path), 1, "{path}");
    }
    let stored = rows(&state).await;
    assert_eq!(stored.len(), 3, "no variant rows: {stored:?}");
    assert!(stored.iter().all(|r| !r.1.contains("#w=")), "{stored:?}");
}

#[test]
fn buckets_cover_cards_and_logos_at_common_pixel_ratios() {
    // ChannelLogo 40 CSS px at DPR 1/1.5/2; Poster 180 CSS px at 1/1.25/2.
    let cases = [
        (40, 64),
        (60, 64),
        (80, 96),
        (180, 192),
        (225, 256),
        (360, 384),
    ];
    for (hint, bucket) in cases {
        assert_eq!(resize::bucket(hint), Some(bucket), "{hint}");
    }
}
