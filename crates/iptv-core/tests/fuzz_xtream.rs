//! Fuzz tests for the Xtream JSON shapes, row mapping, detail builders,
//! short EPG mapping and the meta / URL helpers. Deterministic; see
//! `fuzz_common` for `FUZZ_SEED` / `FUZZ_CASES`.

mod fuzz_common;

use chrono::{DateTime, Utc};
use fuzz_common::{
    mixed_input, mutate, random_json, random_record, random_tokens, random_utf8, run, Rng,
    INTERESTING_NUMBERS,
};
use iptv_core::model::{ContentType, ItemRef};
use iptv_core::xtream::client::{check_auth, decode};
use iptv_core::xtream::meta::{
    added_to_rfc3339, duration_to_seconds, parse_instant, parse_server_datetime,
    server_offset_seconds, unix_to_rfc3339, year_from_date, ServerMeta,
};
use iptv_core::xtream::raw::{
    LenientVec, RawAccount, RawCategory, RawLive, RawSeries, RawSeriesInfo, RawShortEpg, RawVod,
    RawVodInfo,
};
use iptv_core::xtream::service::{
    build_seasons, build_series_detail, build_vod_detail, cast_list, decode_b64_text,
    map_short_epg, trailer_url,
};
use iptv_core::xtream::sync::{live_row, map_categories, series_row, vod_row};
use iptv_core::xtream::url::{
    catchup_stamp, clean_extension, encode_segment, is_xmltv_url_for, normalize_server_url,
};
use serde_json::Value;

const SEED: u64 = 0x5854_5245_0001;
const MAX_LEN: usize = 6 * 1024;

const KEYS: &[&str] = &[
    "active_cons",
    "actors",
    "added",
    "allowed_output_formats",
    "auth",
    "backdrop_path",
    "cast",
    "category_id",
    "category_ids",
    "category_name",
    "channel_id",
    "container_extension",
    "cover",
    "cover_big",
    "created_at",
    "custom_sid",
    "description",
    "director",
    "duration",
    "duration_secs",
    "end",
    "end_timestamp",
    "epg_channel_id",
    "epg_id",
    "epg_listings",
    "episode_num",
    "episodes",
    "exp_date",
    "genre",
    "id",
    "info",
    "is_adult",
    "is_trial",
    "last_modified",
    "max_connections",
    "message",
    "movie_data",
    "movie_image",
    "name",
    "num",
    "o_name",
    "overview",
    "plot",
    "rating",
    "rating_5based",
    "release_date",
    "releaseDate",
    "releasedate",
    "season",
    "season_number",
    "seasons",
    "series_id",
    "server_info",
    "start",
    "start_timestamp",
    "status",
    "stop_timestamp",
    "stream_icon",
    "stream_id",
    "stream_type",
    "time_now",
    "timestamp_now",
    "timezone",
    "title",
    "tmdb",
    "tmdb_id",
    "tv_archive",
    "tv_archive_duration",
    "url",
    "user_info",
    "username",
    "year",
    "youtube_trailer",
    "1",
    "2",
];

const TEXT_DICT: &[&str] = &[
    "2019-05-01",
    "01/05/1999",
    "2023-11-14 23:13:20",
    "2023-11-14T23:13:20",
    "1700000000",
    "01:30:05",
    "95 min",
    ":",
    "-",
    "+",
    "UTC",
    "GMT",
    "Etc/GMT-2",
    "+05:30",
    "-0530",
    "UTC+1é1",
    "http://",
    "https://h:8080",
    "/player_api.php",
    "/xmltv.php",
    "?username=a",
    "TW9ybmluZyBOZXdz",
    "Q2Fmw6k",
    "==",
    ", ",
    "youtu.be/",
    "dQw4w9WgXcQ",
    ".MKV",
    "جمعة",
    "٢٠١٩",
];

fn seeds() -> Vec<Vec<u8>> {
    iptv_mock::xtream::sample_payloads("http://127.0.0.1:7290", 1_700_000_000)
        .into_iter()
        .map(|(_, v)| serde_json::to_vec(&v).unwrap())
        .collect()
}

/// JSON-ish input: random records, mutated random JSON, or fixture mixes.
fn json_input(rng: &mut Rng, seeds: &[Vec<u8>], list: bool) -> Vec<u8> {
    match rng.below(10) {
        0..=3 => {
            let v = if list {
                let n = rng.size(12);
                Value::Array((0..n).map(|_| random_record(rng, KEYS)).collect())
            } else if rng.chance(1, 2) {
                random_record(rng, KEYS)
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
                &["{", "}", "[", "]", ",", "\"", ":"],
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

fn r(ct: ContentType) -> ItemRef {
    ItemRef::new("fuzz", ct, "1")
}

fn fuzz_list(name: &str, salt: u64, check: impl FnMut(&[u8])) {
    let seeds = seeds();
    run(
        name,
        SEED ^ salt,
        |rng| json_input(rng, &seeds, true),
        check,
    );
}

#[test]
fn fuzz_live_rows() {
    fuzz_list("xtream get_live_streams -> live_row", 0x01, |bytes| {
        if let Ok(list) = decode::<LenientVec<RawLive>>(bytes, "fuzz") {
            for (i, raw) in list.items.into_iter().enumerate() {
                if let Some(row) = live_row("s", i as i64, raw) {
                    if let Some(h) = row.archive_hours {
                        assert!(h > 0 && h <= 366 * 24, "archive_hours {h}");
                    }
                }
            }
        }
    });
}

#[test]
fn fuzz_vod_rows() {
    fuzz_list("xtream get_vod_streams -> vod_row", 0x02, |bytes| {
        if let Ok(list) = decode::<LenientVec<RawVod>>(bytes, "fuzz") {
            for (i, raw) in list.items.into_iter().enumerate() {
                if let Some(row) = vod_row("s", i as i64, raw) {
                    if let Some(rating) = row.rating {
                        assert!((0.0..=10.0).contains(&rating), "rating {rating}");
                    }
                }
            }
        }
    });
}

#[test]
fn fuzz_series_rows() {
    fuzz_list("xtream get_series -> series_row", 0x03, |bytes| {
        if let Ok(list) = decode::<LenientVec<RawSeries>>(bytes, "fuzz") {
            for (i, raw) in list.items.into_iter().enumerate() {
                let _ = series_row("s", i as i64, raw);
            }
        }
    });
}

#[test]
fn fuzz_categories() {
    fuzz_list("xtream categories -> map_categories", 0x04, |bytes| {
        if let Ok(list) = decode::<LenientVec<RawCategory>>(bytes, "fuzz") {
            let _ = map_categories(list);
        }
    });
}

#[test]
fn fuzz_vod_and_series_detail() {
    let seeds = seeds();
    run(
        "xtream vod/series info -> detail",
        SEED ^ 0x10,
        |rng| json_input(rng, &seeds, false),
        |bytes| {
            if let Ok(raw) = decode::<RawVodInfo>(bytes, "fuzz") {
                let d = build_vod_detail(&r(ContentType::Movie), None, raw);
                if let Some(s) = d.item.duration_seconds {
                    assert!(s > 0);
                }
            }
            if let Ok(raw) = decode::<RawSeriesInfo>(bytes, "fuzz") {
                let seasons = build_seasons(&r(ContentType::Series), &raw);
                for s in &seasons {
                    for e in &s.episodes {
                        assert!(!e.id.is_empty());
                    }
                }
                let _ = build_series_detail(&r(ContentType::Series), None, &raw);
            }
        },
    );
}

#[test]
fn fuzz_short_epg_and_account() {
    let seeds = seeds();
    run(
        "xtream short epg / account",
        SEED ^ 0x20,
        |rng| {
            let mut v = json_input(rng, &seeds, false);
            // Prefix 8 bytes: the server offset handed to map_short_epg.
            let offset: i64 = match rng.below(4) {
                0 => 0,
                1 => *rng.pick(&[i64::MAX, i64::MIN, 14 * 3600, -14 * 3600, 1 << 40]),
                _ => rng.next_u64() as i64 % (15 * 3600),
            };
            let mut out = offset.to_le_bytes().to_vec();
            out.append(&mut v);
            out
        },
        |bytes| {
            let (head, body) = bytes.split_at(8.min(bytes.len()));
            let mut o = [0u8; 8];
            o[..head.len()].copy_from_slice(head);
            let offset = i64::from_le_bytes(o);
            if let Ok(epg) = decode::<RawShortEpg>(body, "fuzz") {
                let progs = map_short_epg(epg.epg_listings.items, "fallback", offset, 50);
                assert!(progs.len() <= 50);
                for p in progs {
                    assert!(
                        DateTime::parse_from_rfc3339(&p.start).is_ok(),
                        "{}",
                        p.start
                    );
                }
            }
            if let Ok(acc) = decode::<RawAccount>(body, "fuzz") {
                let meta = ServerMeta::from_account(&acc);
                assert!(meta.offset_seconds.abs() <= 14 * 3600);
                let _ = check_auth(acc.user_info.as_ref());
            }
        },
    );
}

#[test]
fn fuzz_meta_and_text_helpers() {
    run(
        "xtream meta/service text helpers",
        SEED ^ 0x30,
        |rng| {
            let mut s = match rng.below(3) {
                0 => random_utf8(rng, 48),
                1 => random_tokens(rng, TEXT_DICT, 8),
                _ => {
                    let mut s = String::new();
                    for _ in 0..rng.size(5) {
                        s.push_str(rng.pick(INTERESTING_NUMBERS));
                        s.push_str(rng.pick(&[":", " ", "-", "", " min"]));
                    }
                    s
                }
            }
            .into_bytes();
            // 8 bytes of "timestamp" in front.
            let ts = rng.next_u64().to_le_bytes();
            s.splice(0..0, ts);
            s
        },
        |bytes| {
            let (head, body) = bytes.split_at(8);
            let ts = i64::from_le_bytes(head.try_into().unwrap());
            let s = String::from_utf8_lossy(body);
            let _ = year_from_date(Some(&s)).inspect(|y| assert!((1900..=2100).contains(y)));
            if let Some(d) = duration_to_seconds(Some(&s)) {
                assert!(d > 0);
            }
            let off = server_offset_seconds(Some(ts), Some(&s));
            assert!(off.abs() <= 14 * 3600);
            let _ = server_offset_seconds(Some(ts), Some("2023-11-14 23:13:20"));
            let _ = parse_server_datetime(&s);
            for d in [added_to_rfc3339(Some(&s)), unix_to_rfc3339(ts)]
                .into_iter()
                .flatten()
            {
                assert!(
                    DateTime::parse_from_rfc3339(&d).is_ok(),
                    "not RFC 3339: {d}"
                );
            }
            let _ = parse_instant(&s);
            let _ = decode_b64_text(&s);
            let _ = cast_list(Some(&s));
            let _ = trailer_url(Some(&s));
            if let Some(e) = clean_extension(Some(&s)) {
                assert!(e.len() <= 8 && e.bytes().all(|b| b.is_ascii_alphanumeric()));
            }
            let _ = encode_segment(&s);
        },
    );
}

#[test]
fn fuzz_url_helpers() {
    run(
        "xtream url helpers",
        SEED ^ 0x40,
        |rng| {
            let mut s = random_tokens(rng, TEXT_DICT, 10).into_bytes();
            s.splice(0..0, rng.next_u64().to_le_bytes());
            s
        },
        |bytes| {
            let (head, body) = bytes.split_at(8);
            let n = i64::from_le_bytes(head.try_into().unwrap());
            let s = String::from_utf8_lossy(body);
            if let Ok(server) = normalize_server_url(&s) {
                assert!(server.starts_with("http://") || server.starts_with("https://"));
                assert!(!server.ends_with('/'));
                let _ = is_xmltv_url_for(&s, &server);
            }
            let _ = is_xmltv_url_for(&s, "http://h:8080");
            let mid = s
                .char_indices()
                .nth(s.chars().count() / 2)
                .map_or(s.len(), |(i, _)| i);
            let (a, b) = s.split_at(mid);
            let _ = is_xmltv_url_for(a, b);
            // Catch-up stamps at any instant chrono can represent.
            let secs = n % 8_000_000_000_000;
            if let Some(t) = DateTime::<Utc>::from_timestamp(secs, 0) {
                let _ = catchup_stamp(t, n);
                let _ = catchup_stamp(t, n % (15 * 3600));
            }
            let _ = catchup_stamp(DateTime::<Utc>::MAX_UTC, n);
            let _ = catchup_stamp(DateTime::<Utc>::MIN_UTC, n);
        },
    );
}
