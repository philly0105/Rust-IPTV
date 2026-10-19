//! Downscaled variants of cached images (`/api/img?...&w=<px>`).
//!
//! A poster wall shows 600x900 artwork at about 180 CSS px, so the browser
//! moved and decoded five to ten times the pixels it painted, and the cache
//! filled with bytes nobody saw. A request with a width hint gets a copy no
//! wider than the hint's [`bucket`], stored under its own key ([`super::variant_key`]).
//!
//! Only opaque or transparent still JPEG and PNG are resized (PNG keeps its
//! alpha channel and stays PNG; JPEG stays JPEG). Everything else is served
//! as stored: SVG, GIF, WebP, AVIF, ICO, animated PNG, images already no
//! wider than the bucket, files that do not decode within [`limits`], and
//! results that would not be smaller than the original.

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

/// Widths a hint is rounded up to, so a handful of variants per image cover
/// every card size and device pixel ratio.
pub const WIDTH_BUCKETS: [u32; 9] = [64, 96, 128, 192, 256, 384, 512, 768, 1024];
/// JPEG quality of a resized copy (visually lossless at card sizes).
pub const JPEG_QUALITY: u8 = 82;
/// Largest source dimension decoded for a variant.
const MAX_SOURCE_SIDE: u32 = 8192;
/// Decoder allocation cap (an 8192x8192 RGBA image is 256 MiB).
const MAX_DECODE_ALLOC: u64 = 192 * 1024 * 1024;
/// An image more than this many times the target width is first shrunk to
/// that multiple with [`image::imageops::thumbnail`] (an integer box
/// average), and only the rest is resampled with Catmull-Rom: the filter's
/// cost grows with the source size, and a 2000x3000 original took about ten
/// times a 600x900 poster.
const PRESHRINK_FACTOR: u32 = 2;

/// The bucket of a width hint: the smallest bucket at least `hint` wide, or
/// `None` (serve the original) for 0 and hints above the largest bucket.
pub fn bucket(hint: u32) -> Option<u32> {
    if hint == 0 {
        return None;
    }
    WIDTH_BUCKETS.iter().copied().find(|b| *b >= hint)
}

/// What [`shrink`] made of an image.
#[derive(Debug, PartialEq, Eq)]
pub enum Shrunk {
    /// A smaller copy at most `width` px wide.
    Resized {
        content_type: &'static str,
        body: Vec<u8>,
        width: u32,
        height: u32,
    },
    /// Serve the original as it is.
    Keep,
}

/// The format of a body by its magic bytes (only the two this module resizes).
fn format_of(body: &[u8]) -> Option<ImageFormat> {
    if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else {
        None
    }
}

/// True for an animated PNG: an `acTL` chunk before the first `IDAT`.
fn is_animated_png(body: &[u8]) -> bool {
    let mut at = 8usize;
    while let Some(head) = body.get(at..at + 8) {
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        match &head[4..8] {
            b"acTL" => return true,
            b"IDAT" | b"IEND" => return false,
            _ => {}
        }
        at = match at.checked_add(12 + len) {
            Some(next) => next,
            None => return false,
        };
    }
    false
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_SOURCE_SIDE);
    l.max_image_height = Some(MAX_SOURCE_SIDE);
    l.max_alloc = Some(MAX_DECODE_ALLOC);
    l
}

/// A copy of `body` at most `width` px wide, or [`Shrunk::Keep`]. Blocking
/// (decode, resize, encode): call it from `spawn_blocking`.
pub fn shrink(body: &[u8], width: u32) -> Shrunk {
    try_shrink(body, width).unwrap_or(Shrunk::Keep)
}

fn try_shrink(body: &[u8], width: u32) -> Option<Shrunk> {
    let format = format_of(body)?;
    if width == 0 || (format == ImageFormat::Png && is_animated_png(body)) {
        return None;
    }
    let mut reader = ImageReader::with_format(Cursor::new(body), format);
    reader.limits(limits());
    // The decoder reads the headers only; the pixels wait for `from_decoder`,
    // so an image already narrow enough costs no decode.
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (sw, sh) = decoder.dimensions();
    let shown_width = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => sh,
        _ => sw,
    };
    if shown_width <= width {
        return None;
    }
    let icc = decoder.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    img.apply_orientation(orientation);
    let (w, h) = (img.width(), img.height());
    if w <= width {
        return None;
    }
    let nh = ((u64::from(h) * u64::from(width) + u64::from(w) / 2) / u64::from(w)).max(1) as u32;
    let mid = width.saturating_mul(PRESHRINK_FACTOR);
    if w > mid {
        let mh = ((u64::from(h) * u64::from(mid) + u64::from(w) / 2) / u64::from(w)).max(1) as u32;
        img = img.thumbnail_exact(mid, mh);
    }
    let small = img.resize_exact(width, nh, FilterType::CatmullRom);
    let mut out = Vec::with_capacity(body.len() / 2);
    let content_type = match format {
        ImageFormat::Png => {
            let small = if small.color().has_alpha() {
                DynamicImage::ImageRgba8(small.into_rgba8())
            } else {
                DynamicImage::ImageRgb8(small.into_rgb8())
            };
            let mut enc = PngEncoder::new_with_quality(
                &mut out,
                CompressionType::Default,
                PngFilter::Adaptive,
            );
            if let Some(icc) = icc {
                let _ = enc.set_icc_profile(icc);
            }
            enc.write_image(
                small.as_bytes(),
                small.width(),
                small.height(),
                small.color().into(),
            )
            .ok()?;
            "image/png"
        }
        _ => {
            let small = small.into_rgb8();
            let mut enc = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
            if let Some(icc) = icc {
                let _ = enc.set_icc_profile(icc);
            }
            enc.write_image(
                small.as_raw(),
                small.width(),
                small.height(),
                image::ExtendedColorType::Rgb8,
            )
            .ok()?;
            "image/jpeg"
        }
    };
    if out.len() >= body.len() {
        return None;
    }
    Some(Shrunk::Resized {
        content_type,
        body: out,
        width,
        height: nh,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 90)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn png_rgba(w: u32, h: u32) -> Vec<u8> {
        let img = RgbaImage::from_fn(w, h, |x, y| {
            Rgba([
                (x * 7 % 256) as u8,
                (y * 3 % 256) as u8,
                40,
                if x < w / 2 { 0 } else { 255 },
            ])
        });
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    #[test]
    fn hints_round_up_to_a_bucket_and_large_ones_mean_the_original() {
        assert_eq!(bucket(0), None);
        assert_eq!(bucket(1), Some(64));
        assert_eq!(bucket(64), Some(64));
        assert_eq!(bucket(65), Some(96));
        assert_eq!(bucket(180), Some(192));
        assert_eq!(bucket(360), Some(384));
        assert_eq!(bucket(1024), Some(1024));
        assert_eq!(bucket(1025), None);
    }

    #[test]
    fn a_large_jpeg_shrinks_to_the_bucket_keeping_its_aspect() {
        let body = jpeg(600, 900);
        let Shrunk::Resized {
            content_type,
            body: small,
            width,
            height,
        } = shrink(&body, 384)
        else {
            panic!("expected a resized copy")
        };
        assert_eq!((content_type, width, height), ("image/jpeg", 384, 576));
        assert!(small.len() < body.len());
        let decoded = image::load_from_memory(&small).unwrap();
        assert_eq!(decoded.dimensions(), (384, 576));
    }

    /// EP-4: a source far wider than the bucket is box-shrunk first; the
    /// result still has the bucket's size and the source's colours.
    #[test]
    fn a_large_original_is_preshrunk_to_the_same_size() {
        let img = RgbImage::from_pixel(2000, 3000, Rgb([200, 40, 90]));
        let mut body = Vec::new();
        JpegEncoder::new_with_quality(&mut body, 90)
            .write_image(img.as_raw(), 2000, 3000, image::ExtendedColorType::Rgb8)
            .unwrap();
        let Shrunk::Resized {
            body: small,
            width,
            height,
            ..
        } = shrink(&body, 192)
        else {
            panic!("expected a resized copy")
        };
        assert_eq!((width, height), (192, 288));
        let decoded = image::load_from_memory(&small).unwrap().into_rgb8();
        assert_eq!(decoded.dimensions(), (192, 288));
        let px = decoded.get_pixel(96, 144);
        for (got, want) in px.0.iter().zip([200u8, 40, 90]) {
            assert!(got.abs_diff(want) <= 8, "{px:?}");
        }
    }

    #[test]
    fn a_png_keeps_its_transparency() {
        let body = png_rgba(300, 300);
        let Shrunk::Resized {
            content_type,
            body: small,
            ..
        } = shrink(&body, 128)
        else {
            panic!("expected a resized copy")
        };
        assert_eq!(content_type, "image/png");
        let decoded = image::load_from_memory(&small).unwrap().into_rgba8();
        assert_eq!(decoded.dimensions(), (128, 128));
        assert_eq!(decoded.get_pixel(2, 64)[3], 0, "the clear half stays clear");
        assert_eq!(decoded.get_pixel(125, 64)[3], 255);
    }

    #[test]
    fn small_animated_vector_and_broken_images_are_kept() {
        assert_eq!(shrink(&jpeg(200, 300), 384), Shrunk::Keep, "already small");
        assert_eq!(shrink(b"<svg xmlns='x'/>", 64), Shrunk::Keep);
        assert_eq!(shrink(b"GIF89a.......", 64), Shrunk::Keep);
        assert_eq!(shrink(b"RIFF\0\0\0\0WEBPVP8 ", 64), Shrunk::Keep);
        assert_eq!(shrink(&[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3], 64), Shrunk::Keep);
        // An APNG: the acTL chunk comes before the first IDAT.
        let mut apng = png_rgba(300, 300);
        let ihdr_end = 8 + 12 + 13;
        let actl = [
            0, 0, 0, 8, b'a', b'c', b'T', b'L', 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        apng.splice(ihdr_end..ihdr_end, actl);
        assert!(is_animated_png(&apng));
        assert!(!is_animated_png(&png_rgba(10, 10)));
        assert_eq!(shrink(&apng, 128), Shrunk::Keep);
    }
}
