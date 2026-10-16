//! Fuzz tests for the Stalker body classifier, URL / MAC / command helpers,
//! value coercions and the row mappers. Deterministic; see `fuzz_common` for
//! `FUZZ_SEED` / `FUZZ_CASES`.

mod fuzz_common;

use chrono::DateTime;
use fuzz_common::{
    mixed_input, mutate, random_json, random_record, random_tokens, random_utf8, run, Rng,
    INTERESTING_NUMBERS,
};
use iptv_core::model::ContentType;
use iptv_core::stalker::mapping::{
    cast, categories, channel_row, epg_program, is_vod_series, series_item, vod_id, vod_item,
};
use iptv_core::stalker::protocol::{
    absolutize, build_request_url, classify_auth_failure_body, classify_body, classify_probe,
    combine_messages, cookie_header, date_to_rfc3339, encode_cmd_value, endpoint_candidates,
    int_of, into_list, is_auth_failure_json, is_device_conflict, list_of, normalize_mac,
    normalize_playback_command, normalize_portal_input_url, player_kind_for, resolve_playback_url,
    split_list, static_playback_url, strip_markup, year_of, Body,
};
use iptv_core::stalker::session::{check_profile, redact_mac};
use serde_json::Value;

const SEED: u64 = 0x5354_414C_0001;
const MAX_LEN: usize = 6 * 1024;
const ENDPOINT: &str = "http://127.0.0.1:7308/stalker_portal/server/load.php";

const KEYS: &[&str] = &[
    "js",
    "id",
    "name",
    "title",
    "cmd",
    "cmds",
    "url",
    "tv_archive",
    "tv_archive_duration",
    "archive",
    "time",
    "duration",
    "start_timestamp",
    "stop_timestamp",
    "start",
    "stop",
    "t_time",
    "t_time_to",
    "total_items",
    "max_page_items",
    "selected_item",
    "cur_page",
    "data",
    "year",
    "releasedate",
    "rating_imdb",
    "rating_kinopoisk",
    "added",
    "logo",
    "screenshot_uri",
    "is_series",
    "series",
    "category_id",
    "genre_id",
    "tv_genre_id",
    "number",
    "description",
    "actors",
    "director",
    "genres_str",
    "status",
    "msg",
    "block_msg",
    "token",
    "mac",
    "use_http_tmp_link",
    "censored",
    "has_files",
    "tmdb_id",
    "o_name",
    "name_orig",
    "season_number",
    "error",
    "1",
];

const TEXT_DICT: &[&str] = &[
    "ffmpeg ",
    "auto ",
    "ffrt ",
    "http://",
    "https://h:80/",
    "/stalker_portal",
    "/c/",
    "/portal.php",
    "/server/load.php",
    "x.php",
    "?a=1",
    "#f",
    "localhost",
    "00:1A:79:",
    "00-1a-79-",
    "AB",
    "zz",
    ":",
    "-",
    ".m3u8",
    ".mpd",
    ".mp4",
    "/media/",
    "file_",
    "&",
    "=",
    "%",
    " ",
    "<b>",
    "</b>",
    "&amp;",
    "Authorization failed",
    "Access denied",
    "{\"js\":",
    "}",
    "[",
    "]",
    "2019-05-01",
    "2019-05-01 10:00:00",
    "20190501",
    "1700000000",
    "ﾠ",
    "İ",
    "جمعة",
    "中文",
];

fn seeds() -> Vec<Vec<u8>> {
    let mut s: Vec<Vec<u8>> =
        iptv_mock::stalker::sample_payloads("http://127.0.0.1:7308", 1_700_000_000)
            .into_iter()
            .map(|(_, v)| serde_json::to_vec(&v).unwrap())
            .collect();
    let link = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/stalker-create-link-itv.json"
    );
    if let Ok(b) = std::fs::read(link) {
        s.push(b);
    }
    s.push(b"Authorization failed.".to_vec());
    s.push(b"<html><body>502 Bad Gateway</body></html>".to_vec());
    s.push(
        "\u{feff}{\"js\":{\"data\":[{\"id\":\"1\"}]}}"
            .as_bytes()
            .to_vec(),
    );
    s
}

fn json_input(rng: &mut Rng, seeds: &[Vec<u8>]) -> Vec<u8> {
    match rng.below(10) {
        0..=3 => {
            let v = if rng.chance(1, 2) {
                let n = rng.size(10);
                let list = Value::Array((0..n).map(|_| random_record(rng, KEYS)).collect());
                if rng.chance(1, 2) {
                    serde_json::json!({ "js": { "data": list, "total_items": rng.pick(&[
                        Value::from(i64::MAX), Value::from(-1), Value::from("9e99"), Value::Null,
                    ]) } })
                } else {
                    list
                }
            } else {
                random_json(rng, KEYS, 4)
            };
            serde_json::to_vec(&v).unwrap()
        }
        4 | 5 => {
            let v = random_json(rng, KEYS, 4);
            mutate(
                rng,
                &serde_json::to_vec(&v).unwrap(),
                &["{", "}", "[", "]", ",", "\""],
            )
        }
        _ => mixed_input(
            rng,
            seeds,
            &["{", "}", "[", "]", "null", "\"", ":", ","],
            MAX_LEN,
        ),
    }
}

fn text_input(rng: &mut Rng) -> String {
    match rng.below(3) {
        0 => random_utf8(rng, 64),
        1 => random_tokens(rng, TEXT_DICT, 10),
        _ => {
            let mut s = String::new();
            for _ in 0..rng.size(4) {
                s.push_str(rng.pick(INTERESTING_NUMBERS));
                s.push_str(rng.pick(&["", "-", ":", " ", "0"]));
            }
            s
        }
    }
}

#[test]
fn fuzz_classify_body() {
    let seeds = seeds();
    run(
        "stalker classify_body / auth / probe",
        SEED,
        |rng| json_input(rng, &seeds),
        |bytes| {
            let text = String::from_utf8_lossy(bytes);
            let body = classify_body(&text);
            let _ = classify_probe(&body);
            let _ = classify_auth_failure_body(&text);
            let _ = is_device_conflict(&text);
            let _ = strip_markup(&text);
            if let Body::Js(js) = body {
                let _ = is_auth_failure_json(&js);
                let _ = list_of(&js);
                let _ = into_list(js);
            }
        },
    );
}

#[test]
fn fuzz_mappers() {
    let seeds = seeds();
    run(
        "stalker mapping rows",
        SEED ^ 0x10,
        |rng| json_input(rng, &seeds),
        |bytes| {
            let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
                return;
            };
            let list = match v.get("js") {
                Some(js) => list_of(js),
                None => list_of(&v),
            };
            let mut items = list;
            items.push(v);
            let _ = categories(&items);
            for (i, it) in items.iter().enumerate() {
                for ct in [ContentType::Live, ContentType::Radio] {
                    if let Some(row) = channel_row("s", ENDPOINT, it, ct, "c".into(), i as i64) {
                        if let Some(h) = row.archive_hours {
                            assert!((0..=366 * 24).contains(&h), "archive_hours {h}");
                        }
                    }
                }
                let _ = is_vod_series(it);
                let _ = vod_id(it);
                if let Some(item) = vod_item("s", ENDPOINT, it, "c", None) {
                    if let Some(d) = item.duration_seconds {
                        assert!(d > 0);
                    }
                    if let Some(y) = item.year {
                        assert!((1900..=2100).contains(&y), "year {y}");
                    }
                }
                let _ = series_item("s", ENDPOINT, it, "c", Some("n".into()));
                let _ = cast(it);
                if let Some(p) = epg_program("ch", it) {
                    let s = DateTime::parse_from_rfc3339(&p.start).expect("start is rfc3339");
                    let e = DateTime::parse_from_rfc3339(&p.end).expect("end is rfc3339");
                    assert!(e >= s, "{} .. {}", p.start, p.end);
                }
                let _ = static_playback_url(it, "ffmpeg http://h/x.ts");
                let _ = check_profile(it, "00:1A:79:00:00:01");
            }
        },
    );
}

#[test]
fn fuzz_value_coercions() {
    run(
        "stalker value coercions",
        SEED ^ 0x20,
        |rng| {
            let v = match rng.below(4) {
                0 => Value::from(text_input(rng)),
                1 => Value::from(rng.next_u64() as i64),
                2 => Value::from(f64::from_bits(rng.next_u64())),
                _ => random_json(rng, KEYS, 2),
            };
            serde_json::to_vec(&v).unwrap()
        },
        |bytes| {
            let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
                return;
            };
            let _ = int_of(&v);
            if let Some(d) = date_to_rfc3339(&v) {
                assert!(DateTime::parse_from_rfc3339(&d).is_ok(), "{d}");
            }
            if let Some(y) = year_of(&v) {
                assert!((1900..=2100).contains(&y), "year {y}");
            }
            let _ = list_of(&v);
            if let Some(s) = v.as_str() {
                for part in split_list(s) {
                    assert!(!part.trim().is_empty());
                }
            }
        },
    );
}

#[test]
fn fuzz_url_and_command_helpers() {
    run(
        "stalker url / mac / command helpers",
        SEED ^ 0x30,
        |rng| {
            let mut parts = Vec::new();
            for _ in 0..3 {
                parts.push(text_input(rng));
            }
            parts.join("\u{0}").into_bytes()
        },
        |bytes| {
            let text = String::from_utf8_lossy(bytes);
            let mut it = text.split('\u{0}');
            let a = it.next().unwrap_or("");
            let b = it.next().unwrap_or("");
            let c = it.next().unwrap_or("");
            if let Some(u) = normalize_portal_input_url(a) {
                assert!(matches!(u.scheme(), "http" | "https"));
            }
            for e in endpoint_candidates(a) {
                assert!(e.starts_with("http://") || e.starts_with("https://"), "{e}");
            }
            let _ = absolutize(ENDPOINT, Some(b));
            let _ = absolutize(a, Some(b));
            if let Some(mac) = normalize_mac(a) {
                assert_eq!(mac.len(), 17, "{mac}");
                let _ = cookie_header(&mac, Some(b));
                let _ = redact_mac(c, &mac);
            }
            let _ = redact_mac(a, b);
            let _ = cookie_header(a, None);
            let _ = encode_cmd_value(a);
            let _ = normalize_playback_command(a);
            let _ = resolve_playback_url(ENDPOINT, a, b);
            let _ = resolve_playback_url(a, b, c);
            let _ = player_kind_for(a);
            let _ = combine_messages(Some(a), Some(b));
            let _ = combine_messages(None, Some(c));
            let params = vec![
                (a.to_string(), b.to_string()),
                ("cmd".into(), c.to_string()),
            ];
            let _ = build_request_url(ENDPOINT, &params);
            let _ = build_request_url(a, &params);
        },
    );
}
