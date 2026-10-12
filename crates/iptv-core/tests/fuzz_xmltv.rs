//! Fuzz tests for the streaming XMLTV parser (plain and gzip), the date and
//! offset parser and the lenient entity decoder. Deterministic; see
//! `fuzz_common` for `FUZZ_SEED` / `FUZZ_CASES`.

mod fuzz_common;

use flate2::write::GzEncoder;
use flate2::Compression;
use fuzz_common::{mixed_input, mutate, random_tokens, random_utf8, run, Rng, INTERESTING_NUMBERS};
use iptv_core::epg::fetch::open_reader;
use iptv_core::epg::xmltv::{
    parse, parse_with_limits, parse_xmltv_date, unescape_lenient, ParseStats, Window, XmltvItem,
    MAX_ID_BYTES, MAX_URL_BYTES,
};
use std::io::{BufRead, BufReader, Write};

const SEED: u64 = 0x584D_4C54_0001;
const MAX_LEN: usize = 8 * 1024;

const DICT: &[&str] = &[
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE tv SYSTEM \"xmltv.dtd\">",
    "<tv>",
    "</tv>",
    "<tv generator-info-name=\"x\">",
    "<channel id=\"",
    "</channel>",
    "<display-name lang=\"en\">",
    "</display-name>",
    "<icon src=\"http://h/i.png\"/>",
    "<programme start=\"",
    "\" stop=\"",
    "\" channel=\"",
    "\">",
    "</programme>",
    "<title>",
    "</title>",
    "<desc>",
    "</desc>",
    "<category>",
    "</category>",
    "<![CDATA[",
    "]]>",
    "<!--",
    "-->",
    "<?pi x?>",
    "&amp;",
    "&lt;",
    "&#x1F600;",
    "&#9999999999;",
    "&nbsp;",
    "& ",
    "&#;",
    "20231114221320 +0000",
    "20231114231320 -0530",
    "20231114 utc",
    "2023111422 GMT",
    "202311142213 +5",
    "99991231235959 +1800",
    "00000101000000 -1800",
    "2023-11-14T22:13:20Z",
    "\"",
    "'",
    "<",
    ">",
    "/>",
    " ",
    "\n",
    "\u{feff}",
    "<a>",
    "</a>",
    "<a><a><a><a>",
];

fn seeds() -> Vec<Vec<u8>> {
    let mut s = vec![iptv_fixtures::sample_xmltv().as_bytes().to_vec()];
    for text in [
        "<tv><channel id=\"a\"><display-name>A &amp; B</display-name></channel>\
         <programme start=\"20231114221320 +0000\" stop=\"20231114231320 +0000\" channel=\"a\">\
         <title>T</title><desc><![CDATA[x <b>y</b>]]></desc></programme></tv>",
        "\u{feff}<?xml version=\"1.0\"?><tv><programme start=\"20231114221320 utc\" channel=\"\u{0130}\u{0130}\">\
         <title lang=\"ar\">\u{062C}\u{0645}\u{0639}\u{0629}</title></programme></tv>",
        "<tv><programme start=\"20231114221320 +0530\" stop=\"20231114221320 +0530\" channel=\"z\"/></tv>",
        "<tv><channel id=\"\"></channel><programme channel=\"x\" start=\"garbage\"/><programme/></tv>",
    ] {
        s.push(text.as_bytes().to_vec());
    }
    s
}

/// The first input byte picks the window and the size limits.
fn split_mode(bytes: &[u8]) -> (u8, &[u8]) {
    match bytes.split_first() {
        Some((m, rest)) => (*m, rest),
        None => (0, &[]),
    }
}

fn window_for(mode: u8) -> Window {
    match mode % 4 {
        0 => Window::unbounded(),
        1 => Window::around(1_700_000_000),
        2 => Window::around(i64::MAX),
        _ => Window::around(i64::MIN),
    }
}

/// Parses `reader` and checks the documented invariants of every item.
fn parse_and_check<R: BufRead>(reader: R, mode: u8) -> Option<ParseStats> {
    let window = window_for(mode);
    let (mut channels, mut programmes) = (0u64, 0u64);
    let mut sink = |item: XmltvItem| {
        match item {
            XmltvItem::Channel(c) => {
                channels += 1;
                assert!(!c.id.trim().is_empty(), "blank channel id");
                assert!(c.id.len() <= MAX_ID_BYTES);
                assert!(!c.display_name.is_empty());
                if let Some(icon) = &c.icon {
                    assert!(icon.len() <= MAX_URL_BYTES);
                }
            }
            XmltvItem::Programme(p) => {
                programmes += 1;
                assert!(!p.channel.trim().is_empty(), "blank programme channel");
                assert!(p.channel.len() <= MAX_ID_BYTES);
                assert!(p.stop > p.start, "stop {} <= start {}", p.stop, p.start);
                assert!(p.stop > window.min_stop && p.start <= window.max_start);
                if let Some(icon) = &p.icon {
                    assert!(icon.len() <= MAX_URL_BYTES);
                }
            }
        }
        Ok(())
    };
    let res = if mode & 0x80 != 0 {
        // Small limits exercise the document and node caps.
        let max_doc = 64 + u64::from(mode & 0x3f) * 64;
        let max_node = 16 + usize::from(mode & 0x30);
        parse_with_limits(reader, window, max_doc, max_node, &mut sink)
    } else {
        parse(reader, window, &mut sink)
    };
    let stats = res.ok()?;
    assert_eq!(stats.channels, channels);
    assert_eq!(stats.programmes, programmes);
    Some(stats)
}

fn xml_input(rng: &mut Rng, seeds: &[Vec<u8>]) -> Vec<u8> {
    let mut v = match rng.below(4) {
        0 => {
            // A well-formed skeleton with hostile values.
            let mut s = String::from("<tv>");
            for _ in 0..rng.size(6) {
                let id = random_tokens(rng, &["a", "\u{0130}", "&amp;", " ", "x"], 4);
                s.push_str(&format!(
                    "<programme start=\"{}\" stop=\"{}\" channel=\"{id}\"><title>{}</title></programme>",
                    date_text(rng),
                    date_text(rng),
                    random_utf8(rng, 12).replace(['<', '&'], "")
                ));
            }
            s.push_str("</tv>");
            mutate(rng, s.as_bytes(), DICT)
        }
        _ => mixed_input(rng, seeds, DICT, MAX_LEN),
    };
    v.insert(0, rng.next_u64() as u8);
    v
}

fn date_text(rng: &mut Rng) -> String {
    match rng.below(4) {
        0 => random_tokens(rng, DICT, 2),
        1 => random_utf8(rng, 20),
        _ => {
            let mut s = String::new();
            for _ in 0..rng.size(3) {
                s.push_str(rng.pick(INTERESTING_NUMBERS));
            }
            s.push_str(rng.pick(&[
                "",
                " ",
                " +0000",
                " -1800",
                " +1900",
                " +",
                " utc",
                " GMT",
                "Z",
                " +05:30",
                " +5",
                " -9",
                " +99:99",
                " +\u{0661}\u{0662}",
            ]));
            s
        }
    }
}

#[test]
fn fuzz_parse() {
    let seeds = seeds();
    let mut parsed = 0u64;
    run(
        "xmltv::parse",
        SEED,
        |rng| xml_input(rng, &seeds),
        |bytes| {
            let (mode, body) = split_mode(bytes);
            let _ = parse_and_check(body, mode);
            // A tiny read buffer must not change the result.
            let a = parse_and_check(BufReader::with_capacity(7, body), mode & 0x7f);
            let b = parse_and_check(body, mode & 0x7f);
            parsed += b.as_ref().map_or(0, |s| s.programmes);
            assert_eq!(a, b, "read buffer size changed the result");
        },
    );
    // Guard against a generator that never reaches the programme path.
    assert!(
        parsed > 1000,
        "only {parsed} programmes parsed in the whole run"
    );
}

#[test]
fn fuzz_parse_gzip() {
    let seeds = seeds();
    run(
        "xmltv::parse (gzip)",
        SEED ^ 0x10,
        |rng| {
            let xml = xml_input(rng, &seeds);
            let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
            enc.write_all(&xml[1..]).unwrap();
            let mut gz = enc.finish().unwrap();
            if rng.chance(1, 3) {
                // A second member, as concatenated gzip feeds have.
                gz.extend_from_slice(&gz.clone());
            }
            if rng.chance(1, 2) {
                gz = mutate(rng, &gz, &["\u{1f}\u{8b}", "\0"]);
            }
            gz.insert(0, xml[0]);
            gz
        },
        |bytes| {
            let (mode, body) = split_mode(bytes);
            let reader = BufReader::new(flate2::bufread::MultiGzDecoder::new(body));
            let _ = parse_and_check(reader, mode);
        },
    );
}

#[test]
fn fuzz_open_reader_files() {
    // File-backed: fewer cases (each writes a temp file), same invariants.
    let seeds = seeds();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("epg.bin");
    let n = (fuzz_common::cases() / 10).max(1);
    let base = fuzz_common::base_seed(SEED ^ 0x20);
    for i in 0..n {
        let case_seed = base ^ i as u64;
        let mut rng = Rng::new(case_seed);
        let mut bytes = xml_input(&mut rng, &seeds);
        let mode = bytes.remove(0);
        if rng.chance(1, 2) {
            let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
            enc.write_all(&bytes).unwrap();
            bytes = enc.finish().unwrap();
        }
        if rng.chance(1, 4) {
            let head: &[u8] = rng.pick(&[&b"\xef\xbb\xbf"[..], b"PK\x03\x04", b"BZh9"]);
            bytes.splice(0..0, head.iter().copied());
        }
        std::fs::write(&path, &bytes).unwrap();
        let res = std::panic::catch_unwind(|| {
            if let Ok(reader) = open_reader(&path) {
                let _ = parse_and_check(reader, mode);
            }
        });
        assert!(
            res.is_ok(),
            "open_reader + parse panicked: FUZZ_SEED={case_seed} FUZZ_CASES=1 (case {i})"
        );
    }
}

#[test]
fn fuzz_dates_and_entities() {
    run(
        "xmltv date / entity helpers",
        SEED ^ 0x30,
        |rng| {
            if rng.chance(1, 2) {
                date_text(rng).into_bytes()
            } else {
                let mut s = random_tokens(rng, DICT, 8);
                s.push_str(&random_utf8(rng, 16));
                s.into_bytes()
            }
        },
        |bytes| {
            let s = String::from_utf8_lossy(bytes);
            if let Some(t) = parse_xmltv_date(&s) {
                // Year 0..=9999 with an offset of at most 18 h.
                assert!(
                    (-62_167_219_200 - 18 * 3600..=253_402_300_799 + 18 * 3600).contains(&t),
                    "{t}"
                );
            }
            let u = unescape_lenient(&s);
            if !s.contains('&') {
                assert_eq!(u, s);
            }
        },
    );
}
