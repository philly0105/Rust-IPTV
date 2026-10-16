//! M3U catch-up: the per-source override and the archive URL builder.
//!
//! The builder mirrors `src/features/live/lib/catchup.ts` (Kodi IPTV Simple
//! conventions). Both are tested against `fixtures/catchup-url-cases.json`,
//! so a change to one without the other fails a test.
//!
//! The override is stored with the source (`M3uSourceConfig.catchup`) and
//! applied when channel rows are read, so editing it never needs a re-import.

use crate::error::{CoreError, CoreResult};
use crate::model::{ArchiveInfo, CatchupInfo, CatchupOverride, Channel, ContentType};
use crate::xtream::meta::MAX_ARCHIVE_DAYS;
use chrono::{DateTime, Datelike, Timelike, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::Connection;
use std::collections::HashMap;

/// Override types the source dialog offers. `none` turns catch-up off.
pub const OVERRIDE_TYPES: [&str; 6] = ["default", "append", "shift", "flussonic", "xc", "none"];

/// Longest accepted override template.
pub const MAX_TEMPLATE_LEN: usize = 2048;

/// Checks and normalizes an override: lowercased type, trimmed template
/// (empty = none), days in `1..=MAX_ARCHIVE_DAYS` (0 = none).
pub fn validate_override(o: Option<CatchupOverride>) -> CoreResult<Option<CatchupOverride>> {
    let Some(o) = o else { return Ok(None) };
    let kind = o.kind.trim().to_ascii_lowercase();
    if !OVERRIDE_TYPES.contains(&kind.as_str()) {
        return Err(CoreError::Invalid(format!(
            "catch-up type must be one of {}",
            OVERRIDE_TYPES.join(", ")
        )));
    }
    let template = o
        .template
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    if let Some(t) = &template {
        if t.chars().count() > MAX_TEMPLATE_LEN {
            return Err(CoreError::Invalid(format!(
                "catch-up template is longer than {MAX_TEMPLATE_LEN} characters"
            )));
        }
        if t.chars().any(char::is_control) {
            return Err(CoreError::Invalid(
                "catch-up template contains control characters".into(),
            ));
        }
    }
    let days = match o.days {
        None | Some(0) => None,
        Some(d) if (1..=MAX_ARCHIVE_DAYS).contains(&d) => Some(d),
        Some(_) => {
            return Err(CoreError::Invalid(format!(
                "catch-up days must be between 0 and {MAX_ARCHIVE_DAYS}"
            )))
        }
    };
    // `none` carries nothing else.
    if kind == "none" {
        return Ok(Some(CatchupOverride {
            kind,
            template: None,
            days: None,
        }));
    }
    Ok(Some(CatchupOverride {
        kind,
        template,
        days,
    }))
}

/// Applies a source's override to one channel row (live channels only).
pub fn apply_override(channel: &mut Channel, o: &CatchupOverride) {
    if channel.item_ref.content_type != ContentType::Live {
        return;
    }
    if o.kind == "none" {
        channel.archive = None;
        channel.catchup = None;
        return;
    }
    let old = channel.catchup.take();
    let days = o.days.or(old.as_ref().and_then(|c| c.days));
    let source = o.template.clone().or_else(|| old.and_then(|c| c.source));
    channel.catchup = Some(CatchupInfo {
        kind: o.kind.clone(),
        days,
        source,
    });
    channel.archive = Some(ArchiveInfo {
        enabled: true,
        duration_hours: match o.days {
            Some(d) => crate::xtream::meta::archive_days_to_hours(d),
            None => channel.archive.as_ref().and_then(|a| a.duration_hours),
        },
    });
    // Only a channel the builder can serve shows an archive.
    if mode(channel).is_none() {
        channel.archive = None;
    }
}

/// The stored override of an M3U source; `None` for other kinds or a
/// missing source. Reads only the config column (the full source row counts
/// radio items, which is slow on large playlists).
fn source_override(conn: &Connection, source_id: &str) -> CoreResult<Option<CatchupOverride>> {
    use rusqlite::OptionalExtension;
    let row: Option<(String, String)> = conn
        .prepare_cached("SELECT kind, config_json FROM sources WHERE id = ?1")?
        .query_row([source_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(match row {
        Some((kind, cfg)) if kind == "m3u" => {
            serde_json::from_str::<crate::model::M3uSourceConfig>(&cfg)
                .ok()
                .and_then(|m| m.catchup)
        }
        _ => None,
    })
}

/// Applies each M3U source's override to its rows. Sources are read once per
/// call; rows of other kinds are left alone.
pub fn apply_overrides(conn: &Connection, channels: &mut [Channel]) -> CoreResult<()> {
    let mut by_source: HashMap<String, Option<CatchupOverride>> = HashMap::new();
    for ch in channels.iter_mut() {
        if ch.item_ref.content_type != ContentType::Live {
            continue;
        }
        let sid = &ch.item_ref.source_id;
        if !by_source.contains_key(sid) {
            let o = source_override(conn, sid)?;
            by_source.insert(sid.clone(), o);
        }
        if let Some(Some(o)) = by_source.get(sid) {
            apply_override(ch, o);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// URL builder (mirror of catchup.ts)
// ---------------------------------------------------------------------------

/// Every catch-up `type` (lowercase) the URL builder can serve, with the type
/// it is handled as. `default` and `append` use `catchup-source` when present
/// and otherwise the standard `?utc={utc}&lutc={lutc}` convention; `shift`
/// (alias `timeshift`) always uses that convention; `xc` and `flussonic`
/// (aliases `flussonic-hls`, `flussonic-ts`, `fs`) derive the URL from the
/// stream URL. The importer ([`catchup_usable`]) and [`mode`] both read this
/// table, so a type enables an archive exactly when the builder serves it.
pub const CATCHUP_TYPES: [(&str, &str); 9] = [
    ("default", "default"),
    ("append", "append"),
    ("shift", "shift"),
    ("timeshift", "shift"),
    ("xc", "xc"),
    ("flussonic", "flussonic"),
    ("flussonic-hls", "flussonic"),
    ("flussonic-ts", "flussonic"),
    ("fs", "flussonic"),
];

/// The type a catch-up `type` (case-insensitive) is handled as (the second
/// column of [`CATCHUP_TYPES`]), or `None` when the builder cannot serve it.
pub fn catchup_kind(kind: &str) -> Option<&'static str> {
    let k = kind.trim().to_ascii_lowercase();
    CATCHUP_TYPES
        .iter()
        .find(|(t, _)| *t == k)
        .map(|(_, handled_as)| *handled_as)
}

/// True when a catch-up `type` (case-insensitive) is one clients can play.
pub fn catchup_usable(kind: &str) -> bool {
    catchup_kind(kind).is_some()
}

/// Which builder applies to a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Template,
    Append,
    Shift,
    Xc,
    Flussonic,
}

/// Programme window in epoch milliseconds.
#[derive(Debug, Clone, Copy)]
pub struct Window {
    pub start: i64,
    pub end: i64,
    pub now: i64,
}

static XC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(https?://.+?)/(?:live/)?([^/?#]+)/([^/?#]+)/([^/?#.]+)(\.[A-Za-z0-9]+)?(\?[^#]*)?$",
    )
    .expect("xc regex")
});
static FLUSSONIC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(https?://[^/]+)/(.*)/([^/]*)(mpegts|\.m3u8)(\?[^#]*)?$")
        .expect("flussonic regex")
});
static TOKEN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\$?\{([A-Za-z]+)(?::([^}]*))?\}").expect("token regex"));

fn is_http_url(v: Option<&str>) -> bool {
    v.and_then(|s| url::Url::parse(s).ok())
        .is_some_and(|u| matches!(u.scheme(), "http" | "https"))
}

/// The builder for a channel, or `None` when its catch-up cannot be played.
pub fn mode(channel: &Channel) -> Option<Mode> {
    if !channel.archive.as_ref().is_some_and(|a| a.enabled) {
        return None;
    }
    let url = channel.url.as_deref().map(str::trim);
    let source = channel
        .catchup
        .as_ref()
        .and_then(|c| c.source.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let kind = channel.catchup.as_ref().map_or("", |c| c.kind.trim());
    // An archive without a catch-up type is served like `shift`.
    let kind = if kind.is_empty() {
        "shift"
    } else {
        catchup_kind(kind)?
    };
    let http_url = is_http_url(url);
    match kind {
        "shift" => http_url.then_some(Mode::Shift),
        "default" => {
            if is_http_url(source) {
                Some(Mode::Template)
            } else if source.is_some() {
                http_url.then_some(Mode::Append)
            } else {
                http_url.then_some(Mode::Shift)
            }
        }
        "append" => (source.is_some() && http_url).then_some(Mode::Append),
        "xc" => url.filter(|u| XC_RE.is_match(u)).map(|_| Mode::Xc),
        "flussonic" => url
            .filter(|u| FLUSSONIC_RE.is_match(u))
            .map(|_| Mode::Flussonic),
        _ => None,
    }
}

fn utc(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// `catchup.ts` `formatUtc`: every `Y m d H M S` letter of `fmt` becomes
/// that UTC field; other characters stay.
fn format_utc(ms: i64, fmt: &str) -> String {
    let d = utc(ms);
    let mut out = String::with_capacity(fmt.len() + 8);
    for c in fmt.chars() {
        match c {
            'Y' => out.push_str(&format!("{:04}", d.year())),
            'm' => out.push_str(&format!("{:02}", d.month())),
            'd' => out.push_str(&format!("{:02}", d.day())),
            'H' => out.push_str(&format!("{:02}", d.hour())),
            'M' => out.push_str(&format!("{:02}", d.minute())),
            'S' => out.push_str(&format!("{:02}", d.second())),
            other => out.push(other),
        }
    }
    out
}

fn secs(ms: i64) -> i64 {
    ms.div_euclid(1000)
}

/// Fills Kodi-style tokens: `{utc}` `{start}` `${start}`, `{utcend}` `{end}`,
/// `{lutc}` `{now}` `${timestamp}`, `{duration}` and `{offset}` (seconds,
/// `:N` divides), `{Y}{m}{d}{H}{M}{S}` (programme start, UTC) and
/// `{utc:Y-m-d:H-M}` style formats. Unknown tokens stay as written.
pub fn fill_template(template: &str, w: Window) -> String {
    let (start_s, end_s, now_s) = (secs(w.start), secs(w.end), secs(w.now));
    TOKEN_RE
        .replace_all(template, |caps: &regex::Captures| {
            let whole = caps[0].to_owned();
            let name = &caps[1];
            let arg = caps.get(2).map(|m| m.as_str());
            if arg.is_none() && name.len() == 1 && "YmdHMS".contains(name) {
                return format_utc(w.start, name);
            }
            let key = name.to_ascii_lowercase();
            if key == "duration" || key == "offset" {
                let value = if key == "duration" {
                    (end_s - start_s).max(0)
                } else {
                    (now_s - start_s).max(0)
                };
                return match arg {
                    None => value.to_string(),
                    Some(a) => match leading_int(a) {
                        Some(unit) if unit > 0 => value.div_euclid(unit).to_string(),
                        _ => whole,
                    },
                };
            }
            let time = match key.as_str() {
                "utc" | "start" => Some((w.start, start_s)),
                "utcend" | "end" => Some((w.end, end_s)),
                "lutc" | "now" | "timestamp" => Some((w.now, now_s)),
                _ => None,
            };
            match (time, arg) {
                (Some((_, s)), None) => s.to_string(),
                (Some((t, _)), Some(f)) => format_utc(t, f),
                (None, _) => whole,
            }
        })
        .into_owned()
}

/// JS `parseInt(s, 10)`: optional sign and leading digits after whitespace.
fn leading_int(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

fn append_query(url: &str, query: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{query}")
}

/// The archive URL of a programme on an M3U channel, or `None` when the
/// channel's catch-up is not usable.
pub fn build_url(channel: &Channel, w: Window) -> Option<String> {
    let m = mode(channel)?;
    let url = channel.url.as_deref().unwrap_or("").trim();
    let source = channel
        .catchup
        .as_ref()
        .and_then(|c| c.source.as_deref())
        .unwrap_or("")
        .trim();
    let start_s = secs(w.start);
    let dur_s = ((w.end - w.start).div_euclid(1000)).max(60);
    Some(match m {
        Mode::Template => fill_template(source, w),
        Mode::Append => {
            let filled = fill_template(source, w);
            match filled.strip_prefix('?') {
                Some(q) if url.contains('?') => format!("{url}&{q}"),
                _ => format!("{url}{filled}"),
            }
        }
        Mode::Shift => append_query(url, &format!("utc={start_s}&lutc={}", secs(w.now))),
        Mode::Xc => {
            let c = XC_RE.captures(url)?;
            let minutes = ((dur_s + 59) / 60).max(1);
            let ts = match c.get(5) {
                Some(e) if e.as_str().eq_ignore_ascii_case(".m3u8") => ".m3u8",
                _ => ".ts",
            };
            format!(
                "{}/timeshift/{}/{}/{minutes}/{}/{}{ts}{}",
                &c[1],
                &c[2],
                &c[3],
                format_utc(w.start, "Y-m-d:H-M"),
                &c[4],
                c.get(6).map_or("", |q| q.as_str())
            )
        }
        Mode::Flussonic => {
            let c = FLUSSONIC_RE.captures(url)?;
            let (host, id, list, kind) = (&c[1], &c[2], &c[3], &c[4]);
            let query = c.get(5).map_or("", |q| q.as_str());
            if kind == "mpegts" {
                format!("{host}/{id}/timeshift_abs-{start_s}.ts{query}")
            } else {
                let list = if list.is_empty() { "index" } else { list };
                format!("{host}/{id}/{list}-{start_s}-{dur_s}.m3u8{query}")
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ItemRef;
    use serde::Deserialize;

    /// L1-live-5: `timeshift` and the Flussonic spellings enable an archive
    /// and use the same builder as their canonical type.
    #[test]
    fn catchup_aliases_are_usable() {
        assert_eq!(catchup_kind("timeshift"), Some("shift"));
        assert_eq!(catchup_kind(" TimeShift "), Some("shift"));
        for fs in ["flussonic-hls", "flussonic-ts", "fs"] {
            assert_eq!(catchup_kind(fs), Some("flussonic"), "{fs}");
        }
        assert!(catchup_usable("timeshift"));
        assert!(!catchup_usable("vod"));
        assert!(!catchup_usable(""));
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        url: Option<String>,
        archive: bool,
        catchup: Option<CatchupInfo>,
        #[serde(default)]
        r#override: Option<CatchupOverride>,
        #[serde(default)]
        effective: Option<Effective>,
        start: i64,
        end: i64,
        now: i64,
        expected: Option<String>,
    }

    #[derive(Deserialize)]
    struct Effective {
        archive: bool,
        catchup: Option<CatchupInfo>,
    }

    fn channel(url: Option<String>, archive: bool, catchup: Option<CatchupInfo>) -> Channel {
        Channel {
            item_ref: ItemRef::new("s", ContentType::Live, "1"),
            name: "C".into(),
            number: None,
            logo_url: None,
            category_id: String::new(),
            category_name: String::new(),
            epg_channel_id: None,
            url,
            is_radio: false,
            archive: archive.then_some(ArchiveInfo {
                enabled: true,
                duration_hours: None,
            }),
            headers: None,
            catchup,
        }
    }

    #[test]
    fn shared_url_table() {
        let raw = include_str!("../../../../fixtures/catchup-url-cases.json");
        let cases: Vec<Case> = serde_json::from_str(raw).expect("cases parse");
        assert!(cases.len() >= 10);
        for c in cases {
            let mut ch = channel(c.url, c.archive, c.catchup);
            if let Some(o) = c.r#override {
                let o = validate_override(Some(o))
                    .expect("valid override")
                    .expect("some");
                apply_override(&mut ch, &o);
                let e = c
                    .effective
                    .expect("override cases list the effective channel");
                assert_eq!(ch.archive.is_some(), e.archive, "archive of {}", c.name);
                assert_eq!(ch.catchup, e.catchup, "catchup of {}", c.name);
            }
            let w = Window {
                start: c.start,
                end: c.end,
                now: c.now,
            };
            assert_eq!(build_url(&ch, w), c.expected, "case {}", c.name);
        }
    }

    #[test]
    fn validate_override_normalizes_and_rejects() {
        let o = |k: &str, t: Option<&str>, d: Option<i64>| CatchupOverride {
            kind: k.into(),
            template: t.map(Into::into),
            days: d,
        };
        let v = validate_override(Some(o(" SHIFT ", Some("  "), Some(0))))
            .unwrap()
            .unwrap();
        assert_eq!(v, o("shift", None, None));
        let v = validate_override(Some(o("none", Some("x"), Some(3))))
            .unwrap()
            .unwrap();
        assert_eq!(v, o("none", None, None));
        assert!(validate_override(Some(o("weird", None, None))).is_err());
        assert!(validate_override(Some(o("default", None, Some(-1)))).is_err());
        assert!(validate_override(Some(o("default", None, Some(MAX_ARCHIVE_DAYS + 1)))).is_err());
        assert!(validate_override(Some(o("default", Some("a\nb"), None))).is_err());
        let long = "x".repeat(MAX_TEMPLATE_LEN + 1);
        assert!(validate_override(Some(o("default", Some(&long), None))).is_err());
        assert_eq!(validate_override(None).unwrap(), None);
    }

    #[test]
    fn override_sets_archive_window_and_none_clears() {
        let mut ch = channel(Some("http://h/live/1.ts".into()), false, None);
        apply_override(
            &mut ch,
            &CatchupOverride {
                kind: "shift".into(),
                template: None,
                days: Some(3),
            },
        );
        assert_eq!(
            ch.archive,
            Some(ArchiveInfo {
                enabled: true,
                duration_hours: Some(72)
            })
        );
        assert_eq!(ch.catchup.as_ref().map(|c| c.days), Some(Some(3)));
        apply_override(
            &mut ch,
            &CatchupOverride {
                kind: "none".into(),
                template: None,
                days: None,
            },
        );
        assert_eq!(ch.archive, None);
        assert_eq!(ch.catchup, None);
        // Radio rows are never touched.
        let mut radio = channel(Some("http://h/r.mp3".into()), false, None);
        radio.item_ref.content_type = ContentType::Radio;
        apply_override(
            &mut radio,
            &CatchupOverride {
                kind: "shift".into(),
                template: None,
                days: None,
            },
        );
        assert_eq!(radio.archive, None);
    }

    #[test]
    fn fill_template_never_panics_on_odd_input() {
        let w = Window {
            start: i64::MIN,
            end: i64::MAX,
            now: 0,
        };
        for t in [
            "{utc:}",
            "{duration:0}",
            "{offset:-5}",
            "${",
            "{Y}{m}{zz}",
            "{utc:%%}",
        ] {
            let _ = fill_template(t, w);
        }
    }
}
