//! Pure Stalker/Ministra protocol helpers: endpoint discovery candidates,
//! request URL and header building, response classification, playback
//! command parsing, and lenient JSON field readers.
//!
//! Everything here is synchronous and side-effect free so it can be unit
//! tested exhaustively (ported from the old app's
//! `stalker-portal-discovery.utils`, `stalker-auth-failure.util`,
//! `stalker-playback-command.utils`, `stalker-link-semantics.utils`).

use crate::model::{PlayerKind, RequestHeaders};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use url::Url;

/// User-Agent of a MAG set-top box (SPEC C4 stalker protocol).
pub const MAG_USER_AGENT: &str = "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";
/// `X-User-Agent` header sent with every portal request.
pub const MAG_X_USER_AGENT: &str = "Model: MAG250; Link: WiFi";
/// Default portal page size when the portal does not report `max_page_items`.
pub const DEFAULT_PAGE_SIZE: i64 = 14;
/// Serial number the old app used as a hard-coded default; treated as "no serial".
pub const LEGACY_DEFAULT_SERIAL: &str = "BEDACD4569BAF";

/// Fixed MAG250 profile parameters sent with `get_profile`.
pub const STB_PROFILE_PARAMS: &[(&str, &str)] = &[
    ("hd", "1"),
    ("ver", "ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 15:20:44 EET 2016; PORTAL version: 5.6.0; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566"),
    ("num_banks", "2"),
    ("stb_type", "MAG250"),
    ("client_type", "STB"),
    ("image_version", "218"),
    ("video_out", "hdmi"),
    ("hw_version", "1.7-BD-00"),
];

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

static PHP_SUFFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\.php$").unwrap());
static PORTAL_PHP: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)/portal\.php$").unwrap());
static SERVER_LOAD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)/server/load\.php$").unwrap());
static ANY_PHP_FILE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)/[^/]*\.php$").unwrap());
static C_SUFFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)/c$").unwrap());
static STALKER_PORTAL_DIR: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)/stalker_portal(/|$)").unwrap());
static API_SUFFIX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)/(?:portal\.php|server/load\.php|[^/]*\.php)$").unwrap());

/// Reduces a pasted portal URL to scheme + authority + path (no query, no
/// fragment, no trailing slashes). Only http(s) URLs are accepted.
pub fn normalize_portal_input_url(raw: &str) -> Option<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut url = Url::parse(trimmed).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Some(url)
}

/// Candidate API endpoints for a pasted portal URL, in probe order.
///
/// An explicitly pasted `.php` endpoint goes first; then `portal.php`,
/// `server/load.php`, `stalker_portal/server/load.php` (never nested twice),
/// and finally `c/portal.php`. Scheme, credentials, host and port are kept.
pub fn endpoint_candidates(raw: &str) -> Vec<String> {
    let Some(url) = normalize_portal_input_url(raw) else {
        return Vec::new();
    };
    let path = url.path().trim_end_matches('/').to_string();
    let from_path = |p: &str| -> String {
        let mut c = url.clone();
        c.set_path(p);
        c.to_string()
    };

    let mut out: Vec<String> = Vec::new();
    let is_php = PHP_SUFFIX.is_match(&path);
    if is_php {
        out.push(from_path(&path));
    }
    let base = if is_php {
        let b = PORTAL_PHP.replace(&path, "");
        let b = SERVER_LOAD.replace(&b, "");
        ANY_PHP_FILE.replace(&b, "").into_owned()
    } else {
        C_SUFFIX.replace(&path, "").into_owned()
    };
    out.push(from_path(&format!("{base}/portal.php")));
    out.push(from_path(&format!("{base}/server/load.php")));
    if !STALKER_PORTAL_DIR.is_match(&base) {
        out.push(from_path(&format!("{base}/stalker_portal/server/load.php")));
    }
    out.push(from_path(&format!("{base}/c/portal.php")));

    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.clone()));
    out
}

/// Installation base path of an API endpoint (`/stalker_portal` for
/// `/stalker_portal/server/load.php`, `` for `/portal.php`).
pub fn installation_base_path(endpoint: &Url) -> String {
    let path = endpoint.path();
    if API_SUFFIX.is_match(path) {
        return API_SUFFIX.replace(path, "").into_owned();
    }
    let parts: Vec<&str> = path.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        if matches!(*part, "stalker_portal" | "c" | "portal") {
            return format!("/{}", parts[1..=i].join("/"));
        }
    }
    String::new()
}

/// Origin (`scheme://host[:port]`) of a URL.
pub fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Makes a portal-relative logo/poster path absolute. Absolute http(s) URLs
/// pass through; `/path` resolves against the origin; bare file names resolve
/// against the installation base.
pub fn absolutize(endpoint: &str, raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() || value == "0" || value.eq_ignore_ascii_case("null") {
        return None;
    }
    if has_http_scheme(value) {
        return Some(value.to_string());
    }
    if let Some(rest) = value.strip_prefix("//") {
        let scheme = Url::parse(endpoint)
            .map(|u| u.scheme().to_string())
            .unwrap_or_else(|_| "http".into());
        return Some(format!("{scheme}://{rest}"));
    }
    let ep = Url::parse(endpoint).ok()?;
    let origin = origin_of(&ep);
    if value.starts_with('/') {
        return Some(format!("{origin}{value}"));
    }
    if value.contains("://") {
        // Some other scheme (rtmp, ...): not a usable image URL.
        return None;
    }
    let base = installation_base_path(&ep);
    Some(format!("{origin}{base}/{value}"))
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

const COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent` equivalent.
pub fn encode_component(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, COMPONENT).to_string()
}

/// Minimal encoding of a `cmd` value: a real MAG sends cmd nearly raw and the
/// portal decodes once, so pre-encoded `%XX` sequences pass through while
/// `&`, `#`, `;`, spaces and non-ASCII are escaped.
pub fn encode_cmd_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        let safe = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '-' | '_'
                    | '.'
                    | '~'
                    | '!'
                    | '*'
                    | '('
                    | ')'
                    | '/'
                    | ':'
                    | '?'
                    | '@'
                    | '$'
                    | ','
                    | '+'
                    | '='
                    | '['
                    | ']'
                    | '%'
            );
        if safe {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for b in ch.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// Builds `endpoint?k=v&...`. Any query on the endpoint is dropped;
/// `JsHttpRequest=1-xml` is appended when missing.
pub fn build_request_url(endpoint: &str, params: &[(String, String)]) -> String {
    let base = match Url::parse(endpoint) {
        Ok(mut u) => {
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        }
        Err(_) => endpoint.split('?').next().unwrap_or(endpoint).to_string(),
    };
    let mut parts: Vec<String> = params
        .iter()
        .map(|(k, v)| {
            if k == "cmd" {
                format!("{k}={}", encode_cmd_value(v))
            } else {
                format!("{k}={}", encode_component(v))
            }
        })
        .collect();
    if !params.iter().any(|(k, _)| k == "JsHttpRequest") {
        parts.push("JsHttpRequest=1-xml".to_string());
    }
    format!("{base}?{}", parts.join("&"))
}

/// Trimmed, non-empty identity value.
pub fn identity_value(v: Option<&str>) -> Option<String> {
    v.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Serial number with the old app's hard-coded default treated as absent.
pub fn normalize_serial(v: Option<&str>) -> Option<String> {
    identity_value(v).filter(|s| !s.eq_ignore_ascii_case(LEGACY_DEFAULT_SERIAL))
}

/// `__cfduid` cookie value derived from a serial number (32 hex chars).
pub fn serial_cfduid(serial: &str) -> String {
    let prefix: String = serial
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    let mut s = format!("{prefix}e030245495acd6ebfc1");
    s.truncate(32);
    while s.len() < 32 {
        s.push('0');
    }
    s
}

/// Cookie header a real STB sends.
pub fn cookie_header(mac: &str, serial: Option<&str>) -> String {
    let mut c = format!("mac={}; stb_lang=en; timezone=Europe/Paris", mac.trim());
    if let Some(sn) = serial {
        c.push_str(&format!("; __cfduid={}", serial_cfduid(sn)));
    }
    c
}

/// Canonical uppercase colon MAC (`00:1A:79:12:34:56`) or `None` when the
/// input is not 12 hex digits (separators `:`, `-`, `.`, whitespace allowed).
pub fn normalize_mac(value: &str) -> Option<String> {
    let digits: String = value
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '.') && !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if digits.len() != 12 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        digits
            .as_bytes()
            .chunks(2)
            .map(|p| std::str::from_utf8(p).unwrap_or("00"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// Handshake prehash: uppercase SHA-1 of the uppercase MAC.
pub fn prehash(mac: &str) -> String {
    super::sha1::hex_upper(mac.trim().to_uppercase().as_bytes())
}

/// 40 random lowercase hex chars (handshake `random` fallback for metrics).
pub fn random_hex40() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..40)
        .map(|_| char::from(b"abcdef0123456789"[rng.gen_range(0..16)]))
        .collect()
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

/// What a portal response body turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    /// `{"js": ...}`; carries the `js` value.
    Js(Value),
    /// One of the middleware's auth-failure answers (plain text or JSON envelope).
    AuthFailure(String),
    /// An HTML page (proxy error page, landing page, WAF).
    Html,
    /// Empty body.
    Empty,
    /// Something else: not JSON, or JSON without `js`.
    Unexpected,
}

static AUTH_BODY_PATTERNS: Lazy<Vec<(&'static str, Regex)>> = Lazy::new(|| {
    vec![
        (
            "Authorization failed.",
            Regex::new(r"(?i)^authorization\s+failed[.!]*(?:\s+\d+)?$").unwrap(),
        ),
        (
            "Access denied.",
            Regex::new(r"(?i)^access\s+denied[.!]*$").unwrap(),
        ),
        (
            "Unauthorized request.",
            Regex::new(r"(?i)^unauthorized\s+request[.!]*$").unwrap(),
        ),
    ]
});

static JSON_AUTH_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"(?i)authorization\s+failed",
        r"(?i)access\s+denied",
        r"(?i)unauthorized\s+request",
        r"(?i)auth\s+failed",
        r"(?i)invalid\s+token",
        r"(?i)\bunauthorized\b",
        r"(?i)authorization",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// Canonical failure body when `text` is one of the three plain-text
/// middleware answers (whole trimmed body, at most 64 chars).
pub fn classify_auth_failure_body(text: &str) -> Option<&'static str> {
    let body = text.trim();
    if body.is_empty() || body.len() > 64 {
        return None;
    }
    AUTH_BODY_PATTERNS
        .iter()
        .find(|(_, re)| re.is_match(body))
        .map(|(canonical, _)| *canonical)
}

/// Wider phrase check used for structured fields (`js.error`, `js.msg`) and
/// our own error messages.
pub fn is_auth_failure_phrase(text: &str) -> bool {
    let phrase = text.trim();
    !phrase.is_empty()
        && phrase.len() <= 200
        && JSON_AUTH_PATTERNS.iter().any(|re| re.is_match(phrase))
}

/// True when a parsed JSON response is an auth failure in any envelope form.
pub fn is_auth_failure_json(v: &Value) -> bool {
    match v {
        Value::String(s) => classify_auth_failure_body(s).is_some(),
        Value::Object(map) => match map.get("js") {
            Some(Value::String(s)) => is_auth_failure_phrase(s),
            Some(Value::Object(js)) => ["error", "msg"].iter().any(|k| {
                js.get(*k)
                    .and_then(Value::as_str)
                    .is_some_and(is_auth_failure_phrase)
            }),
            _ => false,
        },
        _ => false,
    }
}

/// Classifies a raw response body.
pub fn classify_body(text: &str) -> Body {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Body::Empty;
    }
    if let Some(canonical) = classify_auth_failure_body(trimmed) {
        return Body::AuthFailure(canonical.to_string());
    }
    if trimmed.starts_with('<') {
        return Body::Html;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(v) => {
            if is_auth_failure_json(&v) {
                let phrase = match &v {
                    Value::String(s) => s.clone(),
                    Value::Object(m) => match m.get("js") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Object(js)) => js
                            .get("error")
                            .or_else(|| js.get("msg"))
                            .and_then(Value::as_str)
                            .unwrap_or("Authorization failed.")
                            .to_string(),
                        _ => "Authorization failed.".to_string(),
                    },
                    _ => "Authorization failed.".to_string(),
                };
                return Body::AuthFailure(phrase.trim().to_string());
            }
            match v {
                Value::Object(mut m) if m.contains_key("js") => {
                    Body::Js(m.remove("js").unwrap_or(Value::Null))
                }
                _ => Body::Unexpected,
            }
        }
        Err(_) => Body::Unexpected,
    }
}

/// Result of probing a candidate endpoint with a token-less `itv/get_genres`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// Real list data: a token-free panel.
    Data,
    /// The endpoint exists and enforces a token.
    AuthRequired,
    /// Not a Stalker portal API.
    NotAPortal,
}

/// Classifies a probe answer. Requires a real list shape, not a bare `js` key.
pub fn classify_probe(body: &Body) -> Probe {
    match body {
        Body::AuthFailure(_) => Probe::AuthRequired,
        Body::Js(Value::Array(_)) => Probe::Data,
        Body::Js(Value::Object(m))
            if m.get("data").is_some_and(Value::is_array) && !m.contains_key("error") =>
        {
            Probe::Data
        }
        _ => Probe::NotAPortal,
    }
}

// ---------------------------------------------------------------------------
// Profile messages
// ---------------------------------------------------------------------------

static TAGS: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]*>").unwrap());
static SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static DEVICE_CONFLICT: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"(?i)device\s*conflict").unwrap(),
        Regex::new(
            r"(?i)device[\s_-]?id[^.!?]{0,40}?(mismatch|conflict|does\s*not\s*match|not\s*match)",
        )
        .unwrap(),
    ]
});

/// Strips markup from a portal message.
pub fn strip_markup(text: &str) -> String {
    let t = TAGS.replace_all(text, " ");
    SPACES.replace_all(&t, " ").trim().to_string()
}

/// Combines `msg` and `block_msg` into one plain line, de-duplicated.
pub fn combine_messages(msg: Option<&str>, block_msg: Option<&str>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for p in [msg, block_msg].into_iter().flatten() {
        let s = strip_markup(p);
        if !s.is_empty() && !parts.contains(&s) {
            parts.push(s);
        }
    }
    (!parts.is_empty()).then(|| parts.join(" - "))
}

/// True when a refusal names a device-id binding conflict.
pub fn is_device_conflict(text: &str) -> bool {
    DEVICE_CONFLICT.iter().any(|re| re.is_match(text))
}

// ---------------------------------------------------------------------------
// Playback commands
// ---------------------------------------------------------------------------

/// True for `http://` / `https://` (any case).
pub fn has_http_scheme(v: &str) -> bool {
    let lower = v.get(..8).unwrap_or(v).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// True for an http(s) URL with a non-empty authority.
pub fn is_playable_http_url(v: &str) -> bool {
    if !has_http_scheme(v) {
        return false;
    }
    let rest = &v[v.find("://").map(|i| i + 3).unwrap_or(0)..];
    !rest.is_empty() && !rest.starts_with('/')
}

/// Strips a solution prefix (`ffmpeg `, `auto `, `ffrt3 ` ...) from a
/// command when what follows is a URL, a path, or a query.
pub fn normalize_playback_command(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(split_at) = trimmed.find(' ') {
        if split_at > 0 {
            let candidate = trimmed[split_at + 1..].trim();
            if has_http_scheme(candidate)
                || candidate.starts_with('/')
                || candidate.starts_with('?')
            {
                return candidate.to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Resolves the `cmd` a `create_link` returned into a playable URL: absolute
/// replies pass through, `/path` replies resolve against the installation
/// base, `?query` replies append to the original command.
pub fn resolve_playback_url(endpoint: &str, original_cmd: &str, response_cmd: &str) -> String {
    let url = normalize_playback_command(response_cmd);
    if url.is_empty() || has_http_scheme(&url) {
        return url;
    }
    let Ok(ep) = Url::parse(endpoint) else {
        return url;
    };
    let origin = origin_of(&ep);
    let base = installation_base_path(&ep);
    if url.starts_with('?') {
        let normalized = normalize_playback_command(original_cmd);
        if has_http_scheme(&normalized) {
            return format!("{normalized}{url}");
        }
        return format!("{origin}{base}{normalized}{url}");
    }
    if url.starts_with('/') {
        return format!("{origin}{base}{url}");
    }
    url
}

/// True when a VOD item needs its file id resolved before `create_link`.
pub fn should_resolve_movie_file_id(has_files: bool, cmd: &str) -> bool {
    has_files && !cmd.contains("://") && cmd.contains("/media/") && !cmd.contains("/media/file_")
}

/// Interprets a portal boolean flag (`1`, `"1"`, `true`, `"true"` ...).
pub fn flag_enabled(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => {
            let s = s.trim().to_ascii_lowercase();
            !s.is_empty() && s != "0" && s != "false"
        }
        Some(_) => true,
    }
}

fn is_local_hostname(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    matches!(
        host,
        "localhost" | "localhost.localdomain" | "0.0.0.0" | "::1" | "::"
    ) || host.ends_with(".localhost")
        || host.starts_with("127.")
        || host.starts_with("::ffff:127.")
}

/// A channel/movie `cmd` that can be played without `create_link`: the
/// portal sent link flags and neither `use_http_tmp_link` nor
/// `use_load_balancing` is on, and the command is a non-loopback http URL.
pub fn static_playback_url(item: &Value, cmd: &str) -> Option<String> {
    let tmp = item.get("use_http_tmp_link");
    let lb = item.get("use_load_balancing");
    let evidence = tmp.is_some_and(|v| !v.is_null()) || lb.is_some_and(|v| !v.is_null());
    if !evidence || flag_enabled(tmp) || flag_enabled(lb) {
        return None;
    }
    let url = normalize_playback_command(cmd);
    if !is_playable_http_url(&url) {
        return None;
    }
    let parsed = Url::parse(&url).ok()?;
    if is_local_hostname(&parsed.host_str()?.to_ascii_lowercase()) {
        return None;
    }
    Some(url)
}

/// Player kind by URL extension: `.m3u8` hls, `.mpd` dash, else direct.
pub fn player_kind_for(url: &str) -> PlayerKind {
    let path = Url::parse(url)
        .map(|u| u.path().to_ascii_lowercase())
        .unwrap_or_else(|_| {
            url.split(['?', '#'])
                .next()
                .unwrap_or(url)
                .to_ascii_lowercase()
        });
    let lower_url = url.to_ascii_lowercase();
    if path.ends_with(".m3u8") || path.ends_with(".m3u") || lower_url.contains("extension=m3u8") {
        PlayerKind::Hls
    } else if path.ends_with(".mpd") {
        PlayerKind::Dash
    } else {
        PlayerKind::Direct
    }
}

/// Playback headers for a resolved stream: same-host streams carry the MAG
/// User-Agent and the portal origin as Referer/Origin; foreign hosts only get
/// a user-configured User-Agent (the portal's identity must not leak).
pub fn playback_headers(
    portal_url: &str,
    stream_url: &str,
    configured: &RequestHeaders,
) -> Option<RequestHeaders> {
    let portal = Url::parse(portal_url).ok();
    let stream = Url::parse(stream_url).ok();
    let same_host = match (&portal, &stream) {
        (Some(p), Some(s)) => {
            p.host_str().map(str::to_ascii_lowercase) == s.host_str().map(str::to_ascii_lowercase)
                && !(p.scheme() == "https" && s.scheme() == "http")
        }
        _ => false,
    };
    let user_ua = identity_value(configured.user_agent.as_deref());
    let headers = if same_host {
        let origin = portal.as_ref().map(origin_of);
        RequestHeaders {
            user_agent: Some(user_ua.unwrap_or_else(|| MAG_USER_AGENT.to_string())),
            referrer: identity_value(configured.referrer.as_deref())
                .or_else(|| origin.as_ref().map(|o| format!("{o}/"))),
            origin: identity_value(configured.origin.as_deref()).or(origin),
        }
    } else {
        RequestHeaders {
            user_agent: user_ua,
            referrer: None,
            origin: None,
        }
    };
    (!headers.is_empty()).then_some(headers)
}

// ---------------------------------------------------------------------------
// Lenient JSON readers
// ---------------------------------------------------------------------------

/// Field as a trimmed non-empty string (numbers are stringified).
pub fn s(v: &Value, key: &str) -> Option<String> {
    str_of(v.get(key)?)
}

/// Value as a trimmed non-empty string.
pub fn str_of(v: &Value) -> Option<String> {
    match v {
        Value::String(x) => {
            let t = x.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Field as an integer (number or numeric string).
pub fn n(v: &Value, key: &str) -> Option<i64> {
    int_of(v.get(key)?)
}

/// Value as an integer (number or numeric string, fractional part dropped).
pub fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(x) => x
            .as_i64()
            .or_else(|| x.as_f64().filter(|f| f.is_finite()).map(|f| f as i64)),
        Value::String(x) => {
            let t = x.trim();
            t.parse::<i64>().ok().or_else(|| {
                t.parse::<f64>()
                    .ok()
                    .filter(|f| f.is_finite())
                    .map(|f| f as i64)
            })
        }
        _ => None,
    }
}

/// Field as a float, lenient (`"7.5"`, `"7,5"`, `"N/A"` -> None, 0 -> None).
pub fn f(v: &Value, key: &str) -> Option<f64> {
    let x = match v.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace(',', ".").parse::<f64>().ok(),
        _ => None,
    }?;
    (x.is_finite() && x > 0.0).then_some(x)
}

/// Unix seconds or `YYYY-MM-DD[ HH:MM[:SS]]` (assumed UTC) -> RFC 3339.
pub fn date_to_rfc3339(v: &Value) -> Option<String> {
    use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
    if let Some(secs) = int_of(v) {
        if secs <= 0 {
            return None;
        }
        // Milliseconds sneak in on some panels.
        let secs = if secs > 100_000_000_000 {
            secs / 1000
        } else {
            secs
        };
        return Utc
            .timestamp_opt(secs, 0)
            .single()
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    let text = str_of(v)?;
    if text.starts_with("0000") {
        return None;
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(&text) {
        return Some(
            d.with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        );
    }
    for fmt in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%d.%m.%Y %H:%M:%S",
        "%d.%m.%Y %H:%M",
    ] {
        if let Ok(d) = NaiveDateTime::parse_from_str(&text, fmt) {
            return Some(
                Utc.from_utc_datetime(&d)
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            );
        }
    }
    for fmt in ["%Y-%m-%d", "%d.%m.%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(&text, fmt) {
            let dt = d.and_hms_opt(0, 0, 0)?;
            return Some(
                Utc.from_utc_datetime(&dt)
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            );
        }
    }
    None
}

/// First plausible 4-digit year (1900..2100) in a field like `"2019"` or `"2019-05-01"`.
pub fn year_of(v: &Value) -> Option<i64> {
    let text = str_of(v)?;
    let digits: Vec<char> = text.chars().collect();
    for w in digits.windows(4) {
        if w.iter().all(char::is_ascii_digit) {
            let y: i64 = w.iter().collect::<String>().parse().ok()?;
            if (1900..2100).contains(&y) {
                return Some(y);
            }
        }
    }
    None
}

/// The item list inside a `js` value: `js.data`, or `js` itself when it is an array.
pub fn list_of(js: &Value) -> Vec<Value> {
    match js {
        Value::Array(a) => a.clone(),
        Value::Object(m) => match m.get("data") {
            Some(Value::Array(a)) => a.clone(),
            // Some panels key data by id.
            Some(Value::Object(o)) => o.values().cloned().collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Owned variant of [`list_of`] that avoids cloning large arrays.
pub fn into_list(js: Value) -> Vec<Value> {
    match js {
        Value::Array(a) => a,
        Value::Object(mut m) => match m.remove("data") {
            Some(Value::Array(a)) => a,
            Some(Value::Object(o)) => o.into_iter().map(|(_, v)| v).collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Splits a comma/semicolon separated list, trimming and dropping blanks.
pub fn split_list(text: &str) -> Vec<String> {
    text.split([',', ';', '|'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn candidates_for_browser_c_url_and_bare_host() {
        let expected = vec![
            "http://portal.example/portal.php",
            "http://portal.example/server/load.php",
            "http://portal.example/stalker_portal/server/load.php",
            "http://portal.example/c/portal.php",
        ];
        assert_eq!(endpoint_candidates("http://portal.example/c"), expected);
        assert_eq!(endpoint_candidates("http://portal.example"), expected);
        assert_eq!(endpoint_candidates("http://portal.example/c///"), expected);
        assert_eq!(
            endpoint_candidates("http://portal.example/c?key=value"),
            expected
        );
    }

    #[test]
    fn pasted_php_endpoint_goes_first() {
        assert_eq!(
            endpoint_candidates("http://portal.example/server/load.php"),
            vec![
                "http://portal.example/server/load.php",
                "http://portal.example/portal.php",
                "http://portal.example/stalker_portal/server/load.php",
                "http://portal.example/c/portal.php",
            ]
        );
        assert_eq!(
            endpoint_candidates("http://portal.example/cp/api.php"),
            vec![
                "http://portal.example/cp/api.php",
                "http://portal.example/cp/portal.php",
                "http://portal.example/cp/server/load.php",
                "http://portal.example/cp/stalker_portal/server/load.php",
                "http://portal.example/cp/c/portal.php",
            ]
        );
        assert_eq!(
            endpoint_candidates("http://portal.example/tenant/c/portal.php")[..3],
            [
                "http://portal.example/tenant/c/portal.php",
                "http://portal.example/tenant/c/server/load.php",
                "http://portal.example/tenant/c/stalker_portal/server/load.php",
            ]
        );
    }

    #[test]
    fn never_nests_stalker_portal_and_dedupes() {
        assert_eq!(
            endpoint_candidates("http://portal.example/stalker_portal/c"),
            vec![
                "http://portal.example/stalker_portal/portal.php",
                "http://portal.example/stalker_portal/server/load.php",
                "http://portal.example/stalker_portal/c/portal.php",
            ]
        );
        assert_eq!(
            endpoint_candidates("http://portal.example/stalker_portal/server/load.php"),
            vec![
                "http://portal.example/stalker_portal/server/load.php",
                "http://portal.example/stalker_portal/portal.php",
                "http://portal.example/stalker_portal/c/portal.php",
            ]
        );
    }

    #[test]
    fn keeps_port_and_credentials_and_rejects_garbage() {
        assert_eq!(
            endpoint_candidates("http://portal.example:8080/portal.php?sn=1#frag")[..3],
            [
                "http://portal.example:8080/portal.php",
                "http://portal.example:8080/server/load.php",
                "http://portal.example:8080/stalker_portal/server/load.php",
            ]
        );
        assert_eq!(
            endpoint_candidates("https://user:pass@host.example/c")[0],
            "https://user:pass@host.example/portal.php"
        );
        assert!(endpoint_candidates("   ").is_empty());
        assert!(endpoint_candidates("not-a-url").is_empty());
        assert!(endpoint_candidates("file:///tmp/c").is_empty());
        assert_eq!(
            normalize_portal_input_url("http://host.example/c?key=value#f")
                .unwrap()
                .as_str(),
            "http://host.example/c"
        );
    }

    #[test]
    fn auth_failure_bodies() {
        for body in [
            "Authorization failed.",
            "Authorization failed. 12",
            "authorization failed",
            "Access denied.",
            "Unauthorized request.",
        ] {
            assert!(classify_auth_failure_body(body).is_some(), "{body}");
        }
        let page = format!("<html><body>Access denied</body>{}</html>", "x".repeat(100));
        assert!(classify_auth_failure_body(&page).is_none());
        assert!(classify_auth_failure_body("").is_none());
        assert!(classify_auth_failure_body("OK").is_none());
        assert!(classify_auth_failure_body("Invalid token").is_none());
        assert!(is_auth_failure_phrase("Invalid token"));
        assert!(is_auth_failure_phrase("Profile error: Auth failed"));
        assert!(!is_auth_failure_phrase("nothing_to_play"));
        assert!(!is_auth_failure_phrase("timeout of 15000ms exceeded"));
    }

    #[test]
    fn classifies_bodies() {
        assert_eq!(classify_body(""), Body::Empty);
        assert_eq!(classify_body("  \n"), Body::Empty);
        assert_eq!(
            classify_body("Authorization failed. 75"),
            Body::AuthFailure("Authorization failed.".into())
        );
        assert_eq!(
            classify_body("<html><h1>502 Bad Gateway</h1></html>"),
            Body::Html
        );
        assert_eq!(
            classify_body(r#"{"js":{"token":"t"}}"#),
            Body::Js(json!({"token":"t"}))
        );
        assert_eq!(
            classify_body(r#"{"js":"Authorization failed. 75"}"#),
            Body::AuthFailure("Authorization failed. 75".into())
        );
        assert!(matches!(
            classify_body(r#"{"js":{"error":"Invalid token"}}"#),
            Body::AuthFailure(_)
        ));
        assert_eq!(
            classify_body(r#"{"js":{"error":"nothing_to_play"}}"#),
            Body::Js(json!({"error":"nothing_to_play"}))
        );
        assert_eq!(classify_body(r#"{"data":[]}"#), Body::Unexpected);
        assert_eq!(classify_body("garbage"), Body::Unexpected);
        assert_eq!(classify_body("\u{feff}{\"js\":[]}"), Body::Js(json!([])));
    }

    #[test]
    fn probe_classification() {
        assert_eq!(classify_probe(&Body::Js(json!([]))), Probe::Data);
        assert_eq!(classify_probe(&Body::Js(json!({"data": []}))), Probe::Data);
        assert_eq!(
            classify_probe(&Body::AuthFailure("x".into())),
            Probe::AuthRequired
        );
        assert_eq!(
            classify_probe(&Body::Js(json!({"error": "Unknown action"}))),
            Probe::NotAPortal
        );
        assert_eq!(classify_probe(&Body::Js(json!(false))), Probe::NotAPortal);
        assert_eq!(classify_probe(&Body::Html), Probe::NotAPortal);
    }

    #[test]
    fn playback_command_normalization() {
        assert_eq!(
            normalize_playback_command("ffrt3 http://cdn.example/a.ts"),
            "http://cdn.example/a.ts"
        );
        assert_eq!(
            normalize_playback_command("ffrt3 HTTP://cdn.example/a.ts"),
            "HTTP://cdn.example/a.ts"
        );
        assert_eq!(
            normalize_playback_command("ffmpeg http://h/x.m3u8"),
            "http://h/x.m3u8"
        );
        assert_eq!(
            normalize_playback_command("auto http://h/x.m3u8"),
            "http://h/x.m3u8"
        );
        assert_eq!(
            normalize_playback_command("ffrt4://ch/live/1/index.m3u8"),
            "ffrt4://ch/live/1/index.m3u8"
        );
        assert_eq!(
            normalize_playback_command("ffmpeg /media/file_1.mpg"),
            "/media/file_1.mpg"
        );
        assert_eq!(
            normalize_playback_command("ffmpeg ?token=abc"),
            "?token=abc"
        );
        assert_eq!(normalize_playback_command("   "), "");
    }

    #[test]
    fn http_scheme_checks() {
        for (v, want) in [
            ("http://a/b", true),
            ("https://a/b", true),
            ("HTTP://a/b", true),
            ("HtTpS://a/b", true),
            ("ffrt4://a/b", false),
            ("rtmp://a/b", false),
            ("/media/1.mpg", false),
            ("", false),
        ] {
            assert_eq!(has_http_scheme(v), want, "{v}");
        }
        for (v, want) in [
            ("http://cdn.example/a.ts", true),
            ("HTTPS://cdn.example/a.ts", true),
            ("http://[::1]/a.ts", true),
            ("http:///ch/1", false),
            ("ffrt4://ch/1", false),
            ("/media/1.mpg", false),
        ] {
            assert_eq!(is_playable_http_url(v), want, "{v}");
        }
    }

    #[test]
    fn resolves_playback_urls() {
        let portal = "http://demo.example/stalker_portal/server/load.php";
        assert_eq!(
            resolve_playback_url(
                portal,
                "/media/source.mpg",
                "ffmpeg HTTPS://cdn.example/a.ts"
            ),
            "HTTPS://cdn.example/a.ts"
        );
        assert_eq!(
            resolve_playback_url(portal, "/media/source.mpg", "/media/video_7.mpg"),
            "http://demo.example/stalker_portal/media/video_7.mpg"
        );
        assert_eq!(
            resolve_playback_url(portal, "auto HTTP://cdn.example/live/9.m3u8", "?token=xyz"),
            "HTTP://cdn.example/live/9.m3u8?token=xyz"
        );
        assert_eq!(
            resolve_playback_url(portal, "/ch/9", "?token=xyz"),
            "http://demo.example/stalker_portal/ch/9?token=xyz"
        );
        assert_eq!(resolve_playback_url(portal, "/ch/9", ""), "");
        assert_eq!(
            resolve_playback_url("http://h/portal.php", "x", "ffmpeg /ch/1.ts"),
            "http://h/ch/1.ts"
        );
    }

    #[test]
    fn static_links_need_flag_evidence() {
        let cmd = "ffmpeg http://cdn.example/1.ts";
        assert_eq!(
            static_playback_url(
                &json!({"use_http_tmp_link": "0", "use_load_balancing": 0}),
                cmd
            ),
            Some("http://cdn.example/1.ts".into())
        );
        assert_eq!(static_playback_url(&json!({}), cmd), None);
        assert_eq!(
            static_playback_url(&json!({"use_http_tmp_link": "1"}), cmd),
            None
        );
        assert_eq!(
            static_playback_url(
                &json!({"use_http_tmp_link": 0, "use_load_balancing": "1"}),
                cmd
            ),
            None
        );
        assert_eq!(
            static_playback_url(
                &json!({"use_http_tmp_link": 0}),
                "ffmpeg http://localhost/ch/1"
            ),
            None
        );
        assert_eq!(
            static_playback_url(
                &json!({"use_http_tmp_link": 0}),
                "ffmpeg http://127.0.0.1:88/ch/1"
            ),
            None
        );
        assert_eq!(
            static_playback_url(&json!({"use_http_tmp_link": 0}), "ffrt4://ch/1"),
            None
        );
    }

    #[test]
    fn movie_file_id_rule() {
        assert!(should_resolve_movie_file_id(true, "/media/12.mpg"));
        assert!(!should_resolve_movie_file_id(false, "/media/12.mpg"));
        assert!(!should_resolve_movie_file_id(true, "/media/file_3.mpg"));
        assert!(!should_resolve_movie_file_id(true, "http://h/media/12.mpg"));
    }

    #[test]
    fn request_url_encoding() {
        let url = build_request_url(
            "http://h/stalker_portal/server/load.php?stale=1",
            &[
                ("type".into(), "itv".into()),
                ("action".into(), "create_link".into()),
                ("cmd".into(), "ffmpeg http://x/a b&c=%3A".into()),
                ("search".into(), "a&b é".into()),
            ],
        );
        assert_eq!(
            url,
            "http://h/stalker_portal/server/load.php?type=itv&action=create_link&cmd=ffmpeg%20http://x/a%20b%26c=%3A&search=a%26b%20%C3%A9&JsHttpRequest=1-xml"
        );
    }

    #[test]
    fn identity_helpers() {
        assert_eq!(
            normalize_mac("00-1a-79-00-00-01").as_deref(),
            Some("00:1A:79:00:00:01")
        );
        assert_eq!(
            normalize_mac("001A79000001").as_deref(),
            Some("00:1A:79:00:00:01")
        );
        assert_eq!(normalize_mac("nope"), None);
        assert_eq!(normalize_serial(Some(" BEDACD4569BAF ")), None);
        assert_eq!(normalize_serial(Some("ABC123")).as_deref(), Some("ABC123"));
        assert_eq!(serial_cfduid("ABC123").len(), 32);
        assert!(serial_cfduid("ABC123").starts_with("abc123e030245495acd6ebfc1"));
        assert_eq!(
            cookie_header("00:1A:79:00:00:01", None),
            "mac=00:1A:79:00:00:01; stb_lang=en; timezone=Europe/Paris"
        );
        assert_eq!(
            prehash("00:1a:79:00:00:01"),
            super::super::sha1::hex_upper(b"00:1A:79:00:00:01")
        );
        assert_eq!(random_hex40().len(), 40);
    }

    #[test]
    fn absolutizes_logos() {
        let ep = "http://h:8080/stalker_portal/server/load.php";
        assert_eq!(
            absolutize(ep, Some("http://cdn/x.png")).as_deref(),
            Some("http://cdn/x.png")
        );
        assert_eq!(
            absolutize(ep, Some("/stalker_portal/misc/logos/1.png")).as_deref(),
            Some("http://h:8080/stalker_portal/misc/logos/1.png")
        );
        assert_eq!(
            absolutize(ep, Some("1.png")).as_deref(),
            Some("http://h:8080/stalker_portal/1.png")
        );
        assert_eq!(
            absolutize(ep, Some("//cdn/x.png")).as_deref(),
            Some("http://cdn/x.png")
        );
        assert_eq!(absolutize(ep, Some("")), None);
        assert_eq!(absolutize(ep, None), None);
    }

    #[test]
    fn profile_messages() {
        assert_eq!(
            combine_messages(
                Some("Your STB is damaged.<br/> Call the provider."),
                Some("Your STB is damaged.<br/> Call the provider.")
            )
            .as_deref(),
            Some("Your STB is damaged. Call the provider.")
        );
        assert_eq!(combine_messages(Some(""), None), None);
        assert!(is_device_conflict("Device ID mismatch"));
        assert!(is_device_conflict("device conflict detected"));
        assert!(!is_device_conflict("device limit reached"));
    }

    #[test]
    fn lenient_readers() {
        let v = json!({"a": " x ", "b": 5, "c": "7", "d": "7,5", "e": "N/A", "f": "", "g": 2.9});
        assert_eq!(s(&v, "a").as_deref(), Some("x"));
        assert_eq!(s(&v, "b").as_deref(), Some("5"));
        assert_eq!(s(&v, "f"), None);
        assert_eq!(n(&v, "c"), Some(7));
        assert_eq!(n(&v, "g"), Some(2));
        assert_eq!(f(&v, "d"), Some(7.5));
        assert_eq!(f(&v, "e"), None);
        assert_eq!(
            date_to_rfc3339(&json!("2021-03-04 12:13:14")).as_deref(),
            Some("2021-03-04T12:13:14Z")
        );
        assert_eq!(
            date_to_rfc3339(&json!(1_600_000_000)).as_deref(),
            Some("2020-09-13T12:26:40Z")
        );
        assert_eq!(
            date_to_rfc3339(&json!("1600000000")).as_deref(),
            Some("2020-09-13T12:26:40Z")
        );
        assert_eq!(date_to_rfc3339(&json!("0000-00-00 00:00:00")), None);
        assert_eq!(year_of(&json!("2019-05-01")), Some(2019));
        assert_eq!(year_of(&json!(2001)), Some(2001));
        assert_eq!(year_of(&json!("n/a")), None);
        assert_eq!(list_of(&json!({"data": [1, 2]})).len(), 2);
        assert_eq!(list_of(&json!([1])).len(), 1);
        assert_eq!(split_list("A, B,,C"), vec!["A", "B", "C"]);
    }

    #[test]
    fn player_kinds_and_headers() {
        assert_eq!(
            player_kind_for("http://h/x/index.m3u8?token=1"),
            PlayerKind::Hls
        );
        assert_eq!(player_kind_for("http://h/x/manifest.mpd"), PlayerKind::Dash);
        assert_eq!(player_kind_for("http://h/x/1.ts"), PlayerKind::Direct);
        assert_eq!(player_kind_for("http://h/x/1.mp4"), PlayerKind::Direct);
        let same = playback_headers(
            "http://p.example/portal.php",
            "http://p.example:8080/1.ts",
            &RequestHeaders::default(),
        )
        .unwrap();
        assert_eq!(same.user_agent.as_deref(), Some(MAG_USER_AGENT));
        assert_eq!(same.origin.as_deref(), Some("http://p.example"));
        assert!(playback_headers(
            "http://p.example/portal.php",
            "http://cdn.other/1.ts",
            &RequestHeaders::default()
        )
        .is_none());
        let custom = RequestHeaders {
            user_agent: Some("VLC".into()),
            ..Default::default()
        };
        assert_eq!(
            playback_headers(
                "https://p.example/portal.php",
                "http://p.example/1.ts",
                &custom
            )
            .unwrap()
            .user_agent
            .as_deref(),
            Some("VLC")
        );
    }
}
