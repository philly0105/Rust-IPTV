//! Cost of a poster variant (`imagecache::resize::shrink`): the first view
//! of a grid poster or logo at its drawn width pays for decode, resize and
//! encode on the blocking pool. Times a 600x900 poster, a 2000x3000 TMDB
//! original (both JPEG) and a 512x512 PNG logo, each to the 192 px bucket.
//!
//! Budgets are loose (a slow, shared machine passes; debug builds get 40
//! times as long); the printed times are what the release-profile comparison
//! in the root `Cargo.toml` used.
//!
//! Run: `cargo test -p iptv-core --release --test image_resize_perf -- --nocapture`

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use iptv_core::imagecache::resize::{shrink, Shrunk};
use std::time::{Duration, Instant};

/// A photo-like test image: smooth gradients plus pixel noise, so the JPEG
/// carries detail at every frequency as real artwork does.
fn photo(w: u32, h: u32) -> RgbImage {
    let mut seed: u32 = 0x9e37_79b9;
    RgbImage::from_fn(w, h, |x, y| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let n = (seed & 31) as i32 - 16;
        let px = |v: u32| (v as i32 + n).clamp(0, 255) as u8;
        Rgb([px(x * 255 / w), px(y * 255 / h), px(((x + y) / 3) % 256)])
    })
}

fn jpeg(w: u32, h: u32) -> Vec<u8> {
    let img = photo(w, h);
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 88)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

fn png_logo(side: u32) -> Vec<u8> {
    let img = RgbaImage::from_fn(side, side, |x, y| {
        let inside = (x as i32 - side as i32 / 2).pow(2) + (y as i32 - side as i32 / 2).pow(2)
            < (side as i32 / 3).pow(2);
        if inside {
            Rgba([(x % 256) as u8, (y % 256) as u8, 200, 255])
        } else {
            Rgba([0, 0, 0, 0])
        }
    });
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(img.as_raw(), side, side, image::ExtendedColorType::Rgba8)
        .unwrap();
    out
}

/// Median of `runs` shrinks of `body` to `width`.
fn median_shrink(body: &[u8], width: u32, runs: usize) -> Duration {
    let mut times: Vec<Duration> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            let out = shrink(body, width);
            let el = t.elapsed();
            assert!(
                matches!(out, Shrunk::Resized { width: w, .. } if w == width),
                "the image was not resized"
            );
            el
        })
        .collect();
    times.sort();
    times[runs / 2]
}

#[test]
fn poster_variants_are_cheap() {
    let cases = [
        ("600x900 poster jpeg", jpeg(600, 900), 25, 250),
        ("2000x3000 original jpeg", jpeg(2000, 3000), 7, 2500),
        ("512x512 logo png", png_logo(512), 25, 250),
    ];
    for (name, body, runs, budget_ms) in cases {
        // Debug builds decode and resample unoptimized: only check that
        // they finish.
        let budget_ms = if cfg!(debug_assertions) {
            budget_ms * 40
        } else {
            budget_ms
        };
        let runs = if cfg!(debug_assertions) { 3 } else { runs };
        let el = median_shrink(&body, 192, runs);
        println!(
            "image_resize_perf: {name} ({} KB) -> 192 px: median {:.1} ms",
            body.len() / 1024,
            el.as_secs_f64() * 1000.0
        );
        assert!(
            el < Duration::from_millis(budget_ms),
            "{name}: {el:?} over {budget_ms} ms"
        );
    }
}
