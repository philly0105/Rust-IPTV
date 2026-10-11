//! Parser edge cases (B1): quoted commas, missing names, CRLF, BOM,
//! `#EXTINF:0`, duplicate URLs, bad lines, >100k lines, streaming input.

use iptv_core::m3u::{parse_str, M3uReader};
use std::io::BufReader;

#[test]
fn quoted_attr_with_comma_and_missing_name() {
    let text = "#EXTM3U\n#EXTINF:-1 tvg-name=\"News, Weather\" group-title=\"A, B\",\nhttp://h/1\n#EXTINF:-1,\nhttp://h/2\n";
    let (entries, _, stats) = parse_str(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].group.as_deref(), Some("A, B"));
    assert_eq!(entries[0].name, "News, Weather", "falls back to tvg-name");
    assert_eq!(
        entries[1].name, "2",
        "falls back to the last URL path segment"
    );
    assert_eq!(stats.skipped, 0);
}

#[test]
fn crlf_bom_and_zero_duration() {
    let text = "\u{feff}#EXTM3U url-tvg=\"http://e/1.xml,http://e/2.xml\"\r\n#EXTINF:0 tvg-id=\"x\",Zero\r\nhttp://h/z\r\n";
    let (entries, header, stats) = parse_str(text);
    assert!(stats.saw_header);
    assert_eq!(header.epg_urls, vec!["http://e/1.xml", "http://e/2.xml"]);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "Zero");
    assert_eq!(entries[0].url, "http://h/z");
    assert_eq!(entries[0].duration, Some(0.0));
}

#[test]
fn duplicate_urls_are_all_returned() {
    let text = "#EXTM3U\n#EXTINF:-1,A\nhttp://h/same\n#EXTINF:-1,A\nhttp://h/same\n#EXTINF:-1,B\nhttp://h/same\n";
    let (entries, _, _) = parse_str(text);
    assert_eq!(entries.len(), 3);
}

#[test]
fn bad_lines_are_skipped_and_counted() {
    let text =
        "#EXTM3U\ngarbage line\n#EXTINF:-1,Dangling\n#EXTINF:-1,Ok\nhttp://h/ok\n#EXTINF:-1,End\n";
    let (entries, _, stats) = parse_str(text);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "Ok");
    assert!(
        stats.skipped >= 3,
        "junk, dangling and trailing EXTINF: {stats:?}"
    );
}

#[test]
fn header_options_and_kodiprop() {
    let text = "#EXTM3U\n#KODIPROP:inputstream.adaptive.license_type=clearkey\n#EXTINF:-1 tvg-chno=\"7\" catchup=\"default\" catchup-days=\"3\",Seven\n#EXTVLCOPT:http-user-agent=UA/1\n#EXTGRP:Override\nhttp://h/7|User-Agent=Other&Referer=http://r/\n";
    let (entries, _, _) = parse_str(text);
    let e = &entries[0];
    assert_eq!(e.url, "http://h/7");
    assert_eq!(e.tvg_chno, Some(7));
    assert_eq!(e.group.as_deref(), Some("Override"));
    assert_eq!(e.catchup_days, Some(3));
    assert!(e.user_agent.is_some());
    assert_eq!(e.referrer.as_deref(), Some("http://r/"));
    assert_eq!(e.kodi_props.len(), 1);
}

#[test]
fn streams_more_than_100k_lines_with_small_buffer() {
    let mut s = String::from("#EXTM3U\n");
    for i in 0..60_000 {
        s.push_str(&format!(
            "#EXTINF:-1 group-title=\"G{}\",C{i}\r\nhttp://h/{i}\r\n",
            i % 9
        ));
    }
    let reader = BufReader::with_capacity(64, s.as_bytes());
    let mut r = M3uReader::new(reader);
    let n = r.by_ref().count();
    assert_eq!(n, 60_000);
    let stats = r.stats();
    assert!(stats.lines > 100_000);
    assert_eq!(stats.skipped, 0);
    assert!(r.take_io_error().is_none());
}
