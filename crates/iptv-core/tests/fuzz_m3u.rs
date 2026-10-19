//! Fuzz tests for the M3U/M3U8 parser, importer row builder, preview and
//! body sniffing. Deterministic; see `fuzz_common` for `FUZZ_SEED` /
//! `FUZZ_CASES`.

mod fuzz_common;

use fuzz_common::{mixed_input, random_tokens, random_utf8, run, Rng};
use iptv_core::m3u::body::sniff;
use iptv_core::m3u::importer::RowBuilder;
use iptv_core::m3u::parser::{
    extract_urls, has_movie_extension, parse_str, url_extension, M3uReader,
};
use iptv_core::m3u::rpc::preview;
use std::io::BufReader;

const SEED: u64 = 0x4D33_5530_0001;
const MAX_LEN: usize = 8 * 1024;

const DICT: &[&str] = &[
    "#EXTM3U",
    "#EXTM3U url-tvg=\"http://e/g.xml\" x-tvg-url=\"http://e/a.xml,http://e/b.xml.gz\"",
    "\n#EXTINF:",
    "#EXTINF:-1",
    "#EXTINF:0 ",
    "#extinf:",
    "#EXTGRP:",
    "#EXTVLCOPT:http-user-agent=",
    "#EXTVLCOPT:http-referrer=",
    "#KODIPROP:inputstream.adaptive.license_key=",
    " tvg-id=\"",
    " tvg-name=\"",
    " tvg-logo=\"",
    " tvg-chno=\"",
    " channel-number=",
    " tvg-shift=\"",
    " group-title=\"",
    " radio=\"true\"",
    " catchup=\"default\"",
    " catchup=\"xc\"",
    " catchup-days=\"",
    " timeshift=",
    " catchup-source=\"?utc={utc}&lutc={lutc}\"",
    " user-agent=\"",
    "\"",
    "'",
    ",",
    "=",
    "\n",
    "\r\n",
    "\r",
    "http://",
    "https://h/live/u/p/1.ts",
    "http://h/movie/u/p/2.mkv",
    "|User-Agent=VLC&Referer=http://r/",
    "rtmp://h/x",
    ".m3u8",
    ".mp4?token=a",
    "#",
    " ",
];

fn seeds() -> Vec<Vec<u8>> {
    let mut s = vec![
        iptv_fixtures::sample_m3u().as_bytes().to_vec(),
        iptv_fixtures::m3u_text(60, 7).into_bytes(),
    ];
    for text in [
        "#EXTM3U\n#EXTINF:-1 tvg-id=\"a\" tvg-chno=\"NaN\" catchup=\"default\" catchup-days=\"9223372036854775807\" group-title=\"G\",A\nhttp://a/1.ts\n",
        "\u{feff}#EXTM3U\r\n#EXTINF:-1,Ünïcødé 中文 العربية\r\nhttp://h/ü.ts|User-Agent=x\r\n",
        "#EXTINF:-1 tvg-name=\"İİİİ Season 2\" group-title=\"Séries\",\nhttp://h/series/a.mkv\n",
        "#EXTM3U\n#EXTINF:-1 tvg-logo=\"\" radio=\"1\",R\n#EXTVLCOPT:http-referrer=http://r\n#KODIPROP:k=v\nhttp://r/s.mp3\n",
        "http://bare/url.ts\nhttp://bare/two.m3u8\n",
    ] {
        s.push(text.as_bytes().to_vec());
    }
    s
}

fn input(rng: &mut Rng, seeds: &[Vec<u8>]) -> Vec<u8> {
    mixed_input(rng, seeds, DICT, MAX_LEN)
}

#[test]
fn fuzz_parse_str_and_row_builder() {
    let seeds = seeds();
    run(
        "m3u::parse_str + RowBuilder",
        SEED,
        |rng| input(rng, &seeds),
        |bytes| {
            let text = String::from_utf8_lossy(bytes);
            let (entries, header, stats) = parse_str(&text);
            assert_eq!(stats.entries, entries.len() as u64);
            for u in &header.epg_urls {
                assert!(!u.is_empty());
            }
            let mut b = RowBuilder::new("fuzz");
            for e in entries {
                assert!(!e.name.is_empty(), "documented: name is never empty");
                if let Some(d) = e.duration {
                    assert!(d.is_finite());
                }
                // Episodes are held back and come out as series rows below.
                let Some(row) = b.push(e) else { continue };
                if let Some(h) = row.archive_hours {
                    assert!(h > 0 && h <= 366 * 24, "archive_hours {h}");
                }
            }
            let (series, _) = b.take_series();
            for s in &series {
                let eps = iptv_core::m3u::series::stored_episodes(&s.extra);
                assert!(!eps.is_empty(), "a series row without episodes");
            }
            let _ = b.categories();
        },
    );
}

#[test]
fn fuzz_streaming_reader_is_chunk_independent() {
    let seeds = seeds();
    run(
        "m3u::M3uReader",
        SEED ^ 0x10,
        |rng| input(rng, &seeds),
        |bytes| {
            // Raw bytes (invalid UTF-8 included) through a tiny buffer must
            // give exactly what a large buffer gives.
            let cap = bytes.len() % 37 + 1;
            let mut small = M3uReader::new(BufReader::with_capacity(cap, bytes));
            let a: Vec<_> = small.by_ref().collect();
            let mut big = M3uReader::new(BufReader::with_capacity(1 << 16, bytes));
            let b: Vec<_> = big.by_ref().collect();
            assert_eq!(a, b, "buffer size {cap} changed the result");
            assert_eq!(small.header(), big.header());
            assert_eq!(small.stats().entries, a.len() as u64);
            assert!(small.take_io_error().is_none());
        },
    );
}

#[test]
fn fuzz_preview() {
    let seeds = seeds();
    run(
        "m3u::rpc::preview",
        SEED ^ 0x20,
        |rng| input(rng, &seeds),
        |bytes| {
            let p = preview(&String::from_utf8_lossy(bytes));
            assert!(p.channel_count >= 0);
        },
    );
}

#[test]
fn fuzz_sniff() {
    let seeds = seeds();
    const TYPES: &[&str] = &[
        "",
        "video/mp2t",
        "application/octet-stream",
        "text/html; charset=utf-8",
        "audio/x-mpegurl",
        "application/vnd.apple.mpegurl",
        "VIDEO/MP4",
    ];
    run(
        "m3u::body::sniff",
        SEED ^ 0x30,
        |rng| {
            let mut v = input(rng, &seeds);
            // First byte picks the content type (or a random one).
            v.insert(0, rng.below(TYPES.len() + 1) as u8);
            if rng.chance(1, 8) {
                // An MPEG-TS-looking head.
                v.insert(1, 0x47);
            }
            v
        },
        |bytes| {
            let (sel, body) = bytes.split_first().unwrap_or((&0, &[]));
            let ct_owned;
            let ct = match TYPES.get(*sel as usize) {
                Some(t) => Some(*t),
                None => {
                    ct_owned =
                        String::from_utf8_lossy(body.get(..body.len().min(16)).unwrap_or(&[]))
                            .into_owned();
                    Some(ct_owned.as_str())
                }
            };
            let _ = sniff(body, ct, "fuzz.host");
            let _ = sniff(body, None, "");
        },
    );
}

#[test]
fn fuzz_url_helpers() {
    const URL_DICT: &[&str] = &[
        "http://",
        "https://",
        "h",
        ".mkv",
        ".MP4",
        ".m3u8",
        "?",
        "&",
        "#",
        "|",
        ".",
        "/",
        "..",
        "%2e",
        "ts",
        "avi",
        " ",
        ",",
        "http://a/b.mkv,http://c/d.ts",
    ];
    run(
        "m3u::parser url helpers",
        SEED ^ 0x40,
        |rng| {
            if rng.chance(1, 2) {
                random_tokens(rng, URL_DICT, 24).into_bytes()
            } else {
                random_utf8(rng, 64).into_bytes()
            }
        },
        |bytes| {
            let s = String::from_utf8_lossy(bytes);
            for u in extract_urls(&s) {
                assert!(!u.is_empty());
            }
            let _ = has_movie_extension(&s);
            if let Some(ext) = url_extension(&s) {
                assert!(!ext.is_empty());
            }
        },
    );
}
