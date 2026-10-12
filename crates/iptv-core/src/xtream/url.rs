//! Xtream server URL normalization and stream URL builders.
//!
//! Normalization follows the old app's `normalizeXtreamServerUrl`
//! (`libs/shared/interfaces/src/lib/xtream-portal.utils.ts`): trim, require
//! http(s), reject URL credentials, drop query and fragment, strip trailing
//! slashes and a trailing `/player_api.php` or `/get.php`, keep port and base
//! path. One addition: a bare `host:port` without a scheme gets `http://`.
//!
//! Every builder percent-encodes the username and password as one path
//! segment each. The resulting URLs carry credentials: never log them
//! unredacted (use [`crate::logging::redact_url`]).

use crate::error::{CoreError, CoreResult};
use chrono::{DateTime, Duration, Utc};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

/// Characters escaped inside one path segment (RFC 3986 `pchar` complement,
/// matching JS `encodeURIComponent` closely enough for credentials).
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// Normalizes a user-entered Xtream server URL to `scheme://host[:port][/base]`.
///
/// ```text
/// " https://example.com/ "                                    -> "https://example.com"
/// "http://h:8080/base/player_api.php?username=u&password=p"  -> "http://h:8080/base"
/// "h:8080/get.php"                                            -> "http://h:8080"
/// ```
///
/// Covered by the unit tests below (a runnable doctest fails to link under
/// `cargo test --workspace` on Windows, so the example is text).
pub fn normalize_server_url(raw: &str) -> CoreResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CoreError::invalid("Enter the Xtream server URL."));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| {
        CoreError::invalid("The server URL is not valid. Use the form http://host:port.")
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(CoreError::invalid(
            "Only http and https Xtream URLs are supported.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::invalid(
            "Remove the username and password from the server URL and enter them in their own fields.",
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(CoreError::invalid("The server URL has no host."));
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    for endpoint in ["/player_api.php", "/get.php"] {
        if path.len() >= endpoint.len()
            && path[path.len() - endpoint.len()..].eq_ignore_ascii_case(endpoint)
        {
            path.truncate(path.len() - endpoint.len());
            break;
        }
    }
    let path = path.trim_end_matches('/');
    Ok(format!("{}{}", url.origin().ascii_serialization(), path))
}

/// Encodes one credential as a URL path segment.
pub fn encode_segment(s: &str) -> String {
    utf8_percent_encode(s.trim(), SEGMENT).to_string()
}

/// `{server}/player_api.php`
pub fn api_endpoint(server: &str) -> String {
    format!("{server}/player_api.php")
}

/// `{server}/xmltv.php?username=..&password=..` (query-encoded).
pub fn xmltv_url(server: &str, username: &str, password: &str) -> String {
    let mut url = url::Url::parse(&format!("{server}/xmltv.php"))
        .unwrap_or_else(|_| url::Url::parse("http://invalid/xmltv.php").expect("static url"));
    url.query_pairs_mut()
        .append_pair("username", username.trim())
        .append_pair("password", password.trim());
    url.to_string()
}

/// True when `url` is an `xmltv.php` URL on `server` (any credentials).
pub fn is_xmltv_url_for(url: &str, server: &str) -> bool {
    let prefix = format!("{server}/xmltv.php");
    // Compare bytes: `url[..n]` panics when byte `n` falls inside a
    // multi-byte character of a provider-supplied EPG URL.
    url.as_bytes()
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix.as_bytes()))
}

/// Live stream: `{server}/live/{u}/{p}/{id}.{ext}`.
pub fn live_url(server: &str, username: &str, password: &str, id: &str, ext: &str) -> String {
    format!(
        "{server}/live/{}/{}/{}.{ext}",
        encode_segment(username),
        encode_segment(password),
        encode_segment(id)
    )
}

/// Movie: `{server}/movie/{u}/{p}/{id}.{ext}`.
pub fn movie_url(server: &str, username: &str, password: &str, id: &str, ext: &str) -> String {
    format!(
        "{server}/movie/{}/{}/{}.{ext}",
        encode_segment(username),
        encode_segment(password),
        encode_segment(id)
    )
}

/// Episode: `{server}/series/{u}/{p}/{episodeId}.{ext}`.
pub fn episode_url(server: &str, username: &str, password: &str, id: &str, ext: &str) -> String {
    format!(
        "{server}/series/{}/{}/{}.{ext}",
        encode_segment(username),
        encode_segment(password),
        encode_segment(id)
    )
}

/// Catch-up: `{server}/timeshift/{u}/{p}/{duration}/{YYYY-MM-DD:HH-mm}/{id}.ts`.
pub fn timeshift_url(
    server: &str,
    username: &str,
    password: &str,
    duration_minutes: i64,
    start_stamp: &str,
    id: &str,
) -> String {
    format!(
        "{server}/timeshift/{}/{}/{}/{start_stamp}/{}.ts",
        encode_segment(username),
        encode_segment(password),
        duration_minutes.max(1),
        encode_segment(id)
    )
}

/// Formats a catch-up start as `YYYY-MM-DD:HH-mm` in the server's local time
/// (`offset_seconds` east of UTC; 0 when unknown).
pub fn catchup_stamp(start: DateTime<Utc>, offset_seconds: i64) -> String {
    // The offset is read back from stored metadata; an out-of-range value
    // (or a start at the edge of chrono's range) must not panic. Real
    // offsets are within +-14 h, so anything else is treated as 0.
    let offset = Some(offset_seconds)
        .filter(|s| s.unsigned_abs() <= 14 * 3600)
        .and_then(Duration::try_seconds)
        .unwrap_or_else(Duration::zero);
    start
        .checked_add_signed(offset)
        .unwrap_or(start)
        .format("%Y-%m-%d:%H-%M")
        .to_string()
}

/// Cleans a container extension (`".MP4 "` -> `"mp4"`); `None` when empty or unsafe.
pub fn clean_extension(ext: Option<&str>) -> Option<String> {
    let e = ext?.trim().trim_start_matches('.').to_ascii_lowercase();
    if e.is_empty() || e.len() > 8 || !e.chars().all(|c| c.is_ascii_alphanumeric()) {
        None
    } else {
        Some(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn normalizes_like_the_old_app() {
        let cases = [
            (" https://example.com/ ", "https://example.com"),
            ("https://example.com/base/", "https://example.com/base"),
            (
                "https://example.com/get.php?username=user&password=pass&type=m3u_plus",
                "https://example.com",
            ),
            (
                "https://example.com/base/player_api.php?username=user&password=pass",
                "https://example.com/base",
            ),
            ("http://Example.com:8080//", "http://example.com:8080"),
            ("http://h:8080/PLAYER_API.PHP", "http://h:8080"),
            ("h.example:25461", "http://h.example:25461"),
            ("h:8080/get.php", "http://h:8080"),
            (
                "http://h:8080/base/player_api.php?username=u&password=p",
                "http://h:8080/base",
            ),
            ("http://h/a/b/get.php/", "http://h/a/b"),
            ("http://h:80/x#frag", "http://h/x"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_server_url(input).unwrap(), want, "{input}");
        }
    }

    #[test]
    fn rejects_bad_urls() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("file://example.com/portal").is_err());
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("http://u:p@example.com").is_err());
    }

    #[test]
    fn builds_stream_urls() {
        let s = "http://h:8080/base";
        assert_eq!(
            live_url(s, "demo", "p@ss/w", "101", "m3u8"),
            "http://h:8080/base/live/demo/p%40ss%2Fw/101.m3u8"
        );
        assert_eq!(
            movie_url(s, "u", "p", "201", "mkv"),
            "http://h:8080/base/movie/u/p/201.mkv"
        );
        assert_eq!(
            episode_url(s, "u", "p", "3001", "mp4"),
            "http://h:8080/base/series/u/p/3001.mp4"
        );
        assert_eq!(
            timeshift_url(s, "u", "p", 0, "2026-10-11:02-30", "101"),
            "http://h:8080/base/timeshift/u/p/1/2026-10-11:02-30/101.ts"
        );
        let x = xmltv_url(s, "u", "a&b");
        assert_eq!(x, "http://h:8080/base/xmltv.php?username=u&password=a%26b");
        assert!(is_xmltv_url_for(&x, s));
        assert!(!is_xmltv_url_for("http://other/xmltv.php?x", s));
    }

    #[test]
    fn catchup_stamp_uses_server_offset() {
        let t = Utc.with_ymd_and_hms(2026, 10, 11, 23, 5, 0).unwrap();
        assert_eq!(catchup_stamp(t, 0), "2026-10-11:23-05");
        assert_eq!(catchup_stamp(t, 2 * 3600), "2026-10-12:01-05");
        assert_eq!(catchup_stamp(t, -5 * 3600), "2026-10-11:18-05");
    }

    /// B8-parsers: absurd offsets and starts at chrono's range edge used to
    /// panic in `Duration::seconds` / `DateTime + Duration`.
    #[test]
    fn catchup_stamp_survives_extreme_inputs() {
        let t = Utc.with_ymd_and_hms(2026, 10, 11, 23, 5, 0).unwrap();
        assert_eq!(catchup_stamp(t, i64::MAX), "2026-10-11:23-05");
        assert_eq!(catchup_stamp(t, i64::MIN), "2026-10-11:23-05");
        let _ = catchup_stamp(DateTime::<Utc>::MAX_UTC, 3600);
        let _ = catchup_stamp(DateTime::<Utc>::MIN_UTC, -3600);
    }

    /// B8-parsers: a multi-byte char at the prefix length used to panic.
    #[test]
    fn xmltv_url_check_is_char_safe() {
        let server = "http://h:8080";
        assert!(is_xmltv_url_for("HTTP://H:8080/XMLTV.PHP?u=a", server));
        assert!(!is_xmltv_url_for("http://h:8080/xmltv.ph", server));
        // Byte 26 (the prefix length) lands inside 'é' here.
        assert!(!is_xmltv_url_for("http://h:8080/xmltv.phéé", server));
        assert!(!is_xmltv_url_for("http://h:8080/éééééééééé", server));
        assert!(!is_xmltv_url_for("", server));
    }

    #[test]
    fn extensions() {
        assert_eq!(clean_extension(Some(" .MKV ")).as_deref(), Some("mkv"));
        assert_eq!(clean_extension(Some("")), None);
        assert_eq!(clean_extension(Some("m p4")), None);
        assert_eq!(clean_extension(None), None);
    }
}
