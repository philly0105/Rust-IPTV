//! First view of an uncached poster or logo: [`resize::shrink`] (decode,
//! box pre-shrink, Catmull-Rom, encode) on a 600x900 poster, a 2000x3000
//! original and an 800x800 transparent PNG logo. It asserts nothing and
//! prints the median and p95 of each, the numbers the release profile's
//! opt-level is weighed on (see the comment on `[profile.release]`).
//!
//! Measured 2026-10-31 on a 4-core Linux box, p50 at opt-level "s" / 2 / 3:
//! poster 21.0 / 18.9 / 20.6 ms, original 119 / 105 / 121 ms, logo
//! 20.1 / 17.0 / 18.6 ms.
//!
//! Release-only: `cargo test -p iptv-core --release --test resize_perf -- --ignored --nocapture`

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use iptv_core::imagecache::resize::{self, Shrunk};
use std::time::{Duration, Instant};

const RUNS: usize = 20;

/// A cheap xorshift, so the pictures carry some noise: a flat fill encodes
/// to a few JPEG coefficients and decodes faster than any artwork.
fn noise(seed: &mut u32) -> u8 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    (*seed & 31) as u8
}

fn photo_jpeg(w: u32, h: u32) -> Vec<u8> {
    let mut seed = 0x9e37_79b9;
    let img = RgbImage::from_fn(w, h, |x, y| {
        let n = noise(&mut seed);
        Rgb([
            ((x * 255 / w) as u8).wrapping_add(n),
            ((y * 255 / h) as u8).wrapping_add(n),
            ((x + y) % 256) as u8 ^ n,
        ])
    });
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 90)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

fn logo_png(side: u32) -> Vec<u8> {
    let mut seed = 0x0bad_5eed;
    let img = RgbaImage::from_fn(side, side, |x, y| {
        let n = noise(&mut seed);
        let inside = (x as i64 - side as i64 / 2).pow(2) + (y as i64 - side as i64 / 2).pow(2)
            < (side as i64 / 3).pow(2);
        Rgba([
            (x * 255 / side) as u8,
            (y * 255 / side) as u8,
            n * 8,
            if inside { 255 } else { 0 },
        ])
    });
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(img.as_raw(), side, side, image::ExtendedColorType::Rgba8)
        .unwrap();
    out
}

fn time(label: &str, body: &[u8], width: u32) {
    let mut samples = Vec::with_capacity(RUNS);
    for k in 0..=RUNS {
        let started = Instant::now();
        let out = resize::shrink(body, width);
        let took = started.elapsed();
        assert!(matches!(out, Shrunk::Resized { .. }), "{label}: kept");
        if k > 0 {
            samples.push(took);
        }
    }
    samples.sort();
    let at = |q: usize| samples[(samples.len() * q).div_ceil(100).max(1) - 1];
    let ms = |d: Duration| d.as_secs_f64() * 1e3;
    eprintln!(
        "resize_perf: {label:<26} -> w={width:<4} | p50 {:>7.2} ms | p95 {:>7.2} ms | min {:>7.2} ms",
        ms(at(50)),
        ms(at(95)),
        ms(samples[0]),
    );
}

#[test]
#[ignore = "timing only; run with --release -- --ignored --nocapture"]
fn shrink_timings() {
    time("600x900 poster (JPEG)", &photo_jpeg(600, 900), 192);
    time("2000x3000 original (JPEG)", &photo_jpeg(2000, 3000), 192);
    time("800x800 logo (RGBA PNG)", &logo_png(800), 128);
}
