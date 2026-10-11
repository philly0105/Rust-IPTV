//! TMDB constants, language mapping, image URLs, and API key resolution.
//!
//! Ported from the old app's `tmdb-config.ts`. The key is never logged: the
//! only place it leaves this module is the outgoing request (query param or
//! `Authorization` header), and [`ApiKey`]'s `Debug` is redacted.

use crate::model::Settings;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Production TMDB v3 base URL. Overridden by `TMDB_BASE_URL` or the
/// `Tmdb::with_base_url` constructor (tests point it at a local stub).
pub const DEFAULT_BASE_URL: &str = "https://api.themoviedb.org/3";
/// Environment variable that overrides the API base URL (not a credential).
pub const BASE_URL_ENV: &str = "TMDB_BASE_URL";
/// Name of the key variable inside a `.env` file.
pub const API_KEY_ENV: &str = "TMDB_API_KEY";

/// Image CDN root. Images never go through the configurable API base.
pub const IMAGE_BASE_URL: &str = "https://image.tmdb.org/t/p";
pub const POSTER_SIZE: &str = "w500";
pub const BACKDROP_SIZE: &str = "w1280";
pub const PROFILE_SIZE: &str = "w185";
pub const STILL_SIZE: &str = "w300";

const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// Details payloads (movie, tv, season, person) and positive title matches.
pub const DETAILS_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Weekly trending rotates slowly; refresh the rail daily.
pub const TRENDING_TTL: Duration = DAY;
/// Negative results (no confident match, 404 ids) retry sooner: providers
/// fix titles and TMDB adds entries.
pub const NEGATIVE_TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// Per-request timeout for TMDB calls (the shared client allows 60 s reads).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts per request through `http::with_retry` (429 and 5xx included).
pub const RETRY_ATTEMPTS: u32 = 4;
/// Longest `Retry-After` we honour before retrying.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);
/// Concurrent upstream requests (TMDB allows roughly 40 req/s per IP).
pub const MAX_CONCURRENT_REQUESTS: usize = 8;
/// In-memory LRU entries in front of the SQLite cache.
pub const MEMORY_CACHE_CAPACITY: usize = 300;

/// App language code (`Settings.language`, same codes as the old app's
/// `Language` enum) -> TMDB language-region code.
const LANGUAGE_MAP: &[(&str, &str)] = &[
    ("ar", "ar-SA"),
    ("ary", "ar-MA"),
    ("en", "en-US"),
    ("ko", "ko-KR"),
    ("ru", "ru-RU"),
    ("de", "de-DE"),
    ("es", "es-ES"),
    ("zh", "zh-CN"),
    ("zhtw", "zh-TW"),
    ("fr", "fr-FR"),
    ("it", "it-IT"),
    ("tr", "tr-TR"),
    ("ja", "ja-JP"),
    ("nl", "nl-NL"),
    ("by", "be-BY"),
    ("pl", "pl-PL"),
    ("pt", "pt-PT"),
    ("el", "el-GR"),
    ("hu", "hu-HU"),
];

/// Maps an app language to a TMDB code; unknown values fall back to `en-US`.
/// Accepts a few spellings the app never writes but users might type
/// (`zh-TW`, `be`).
pub fn to_tmdb_language(language: Option<&str>) -> &'static str {
    let lang = language.unwrap_or("").trim().to_ascii_lowercase();
    let lang = match lang.as_str() {
        "zh-tw" | "zh_tw" => "zhtw",
        "be" => "by",
        other => other,
    };
    LANGUAGE_MAP
        .iter()
        .find(|(app, _)| *app == lang)
        .map(|(_, tmdb)| *tmdb)
        .unwrap_or("en-US")
}

/// Effective TMDB language: `settings.tmdb.language` when set (a full code
/// like `de-DE` passes through, a bare app code is mapped), else the app
/// language mapped.
pub fn effective_language(settings: &Settings) -> String {
    match settings.tmdb.language.as_deref().map(str::trim) {
        Some(l) if l.contains('-') && l.len() >= 4 => l.to_string(),
        Some(l) if !l.is_empty() => to_tmdb_language(Some(l)).to_string(),
        _ => to_tmdb_language(Some(&settings.language)).to_string(),
    }
}

fn is_cyrillic(c: char) -> bool {
    ('\u{0400}'..='\u{04FF}').contains(&c)
}

/// Language for a `/search` request. TMDB matches translated titles but
/// returns `title` in the request language, so a Cyrillic query issued as
/// `en-US` comes back in English and fails the exact-title gate. Cyrillic
/// titles therefore search in `ru-RU` unless the app language is already a
/// Cyrillic one. Details are still fetched in the app language.
pub fn search_language_for_title(title: &str, tmdb_language: &str) -> String {
    let cyrillic_app = matches!(tmdb_language, "ru-RU" | "be-BY");
    if title.chars().any(is_cyrillic) && !cyrillic_app {
        "ru-RU".to_string()
    } else {
        tmdb_language.to_string()
    }
}

fn image(size: &str, path: Option<&str>) -> Option<String> {
    let path = path.map(str::trim).filter(|p| !p.is_empty())?;
    if path.starts_with("http://") || path.starts_with("https://") {
        return Some(path.to_string());
    }
    let sep = if path.starts_with('/') { "" } else { "/" };
    Some(format!("{IMAGE_BASE_URL}/{size}{sep}{path}"))
}

pub fn poster_url(path: Option<&str>) -> Option<String> {
    image(POSTER_SIZE, path)
}
pub fn backdrop_url(path: Option<&str>) -> Option<String> {
    image(BACKDROP_SIZE, path)
}
pub fn profile_url(path: Option<&str>) -> Option<String> {
    image(PROFILE_SIZE, path)
}
pub fn still_url(path: Option<&str>) -> Option<String> {
    image(STILL_SIZE, path)
}

/// A TMDB credential. v4 read-access tokens are JWTs (`eyJ...`, ~200+
/// chars) and travel as `Authorization: Bearer`; classic v3 keys (32 hex
/// chars) travel as the `api_key` query parameter.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// Trims and wraps a key; `None` for blank input.
    pub fn new(raw: &str) -> Option<Self> {
        let k = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        (!k.is_empty()).then(|| Self(k.to_string()))
    }
    /// True for v4 tokens (Bearer auth).
    pub fn is_bearer(&self) -> bool {
        self.0.starts_with("eyJ") || self.0.len() > 64
    }
    /// The raw secret. Only the HTTP layer calls this.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = if self.is_bearer() { "v4" } else { "v3" };
        write!(f, "ApiKey({kind}, <redacted>)")
    }
}

/// Where the active key came from (shown nowhere but useful in tests/docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Settings,
    DataDirEnv,
    CwdEnv,
}

/// Parses a dotenv file and returns the value of `name`. Supports comments,
/// blank lines, `export NAME=...`, single/double quotes, and trailing
/// `# comments` on unquoted values. No variable expansion.
pub fn parse_dotenv_value(text: &str, name: &str) -> Option<String> {
    let mut found = None;
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if k.trim() != name {
            continue;
        }
        let v = v.trim();
        let value = if let Some(rest) = v.strip_prefix('"') {
            rest.split_once('"').map(|(inner, _)| inner).unwrap_or(rest)
        } else if let Some(rest) = v.strip_prefix('\'') {
            rest.split_once('\'')
                .map(|(inner, _)| inner)
                .unwrap_or(rest)
        } else {
            v.split_once(" #")
                .map(|(inner, _)| inner)
                .unwrap_or(v)
                .trim()
        };
        // Last assignment wins, like most dotenv loaders.
        found = Some(value.to_string());
    }
    found.filter(|v| !v.trim().is_empty())
}

fn key_from_env_file(path: &Path) -> Option<ApiKey> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_dotenv_value(&text, API_KEY_ENV).and_then(|v| ApiKey::new(&v))
}

/// Resolves the API key: `settings.tmdb.apiKey`, else `TMDB_API_KEY` from
/// `<data_dir>/.env`, else (when `search_cwd`) from `./.env`. The process
/// environment is deliberately not read.
pub fn resolve_api_key(
    settings: &Settings,
    data_dir: &Path,
    search_cwd: bool,
) -> Option<(ApiKey, KeySource)> {
    if let Some(k) = settings.tmdb.api_key.as_deref().and_then(ApiKey::new) {
        return Some((k, KeySource::Settings));
    }
    if let Some(k) = key_from_env_file(&data_dir.join(".env")) {
        return Some((k, KeySource::DataDirEnv));
    }
    if search_cwd {
        let cwd_env: PathBuf = std::env::current_dir().ok()?.join(".env");
        if cwd_env != data_dir.join(".env") {
            if let Some(k) = key_from_env_file(&cwd_env) {
                return Some((k, KeySource::CwdEnv));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_app_languages_to_tmdb_codes() {
        assert_eq!(to_tmdb_language(Some("de")), "de-DE");
        assert_eq!(to_tmdb_language(Some("ru")), "ru-RU");
        assert_eq!(to_tmdb_language(Some("zhtw")), "zh-TW");
        assert_eq!(to_tmdb_language(Some("by")), "be-BY");
        assert_eq!(to_tmdb_language(Some("ary")), "ar-MA");
    }

    #[test]
    fn unknown_languages_fall_back_to_en_us() {
        assert_eq!(to_tmdb_language(None), "en-US");
        assert_eq!(to_tmdb_language(Some("xx")), "en-US");
    }

    #[test]
    fn effective_language_prefers_tmdb_setting() {
        let mut s = Settings::default();
        assert_eq!(effective_language(&s), "en-US");
        s.language = "fr".into();
        assert_eq!(effective_language(&s), "fr-FR");
        s.tmdb.language = Some("pt-BR".into());
        assert_eq!(effective_language(&s), "pt-BR");
        s.tmdb.language = Some("de".into());
        assert_eq!(effective_language(&s), "de-DE");
        s.tmdb.language = Some("  ".into());
        assert_eq!(effective_language(&s), "fr-FR");
    }

    #[test]
    fn search_language_uses_app_language_for_latin_titles() {
        assert_eq!(search_language_for_title("The Matrix", "de-DE"), "de-DE");
    }

    #[test]
    fn search_language_switches_to_russian_for_cyrillic() {
        assert_eq!(search_language_for_title("Ирония судьбы", "en-US"), "ru-RU");
        assert_eq!(search_language_for_title("Ирония судьбы", "de-DE"), "ru-RU");
        assert_eq!(search_language_for_title("Ирония судьбы", "ru-RU"), "ru-RU");
        assert_eq!(search_language_for_title("Ірония лёсу", "be-BY"), "be-BY");
    }

    #[test]
    fn image_urls() {
        assert_eq!(
            poster_url(Some("/abc.jpg")).unwrap(),
            "https://image.tmdb.org/t/p/w500/abc.jpg"
        );
        assert_eq!(
            backdrop_url(Some("/b.jpg")).unwrap(),
            "https://image.tmdb.org/t/p/w1280/b.jpg"
        );
        assert_eq!(poster_url(None), None);
        assert_eq!(poster_url(Some("")), None);
    }

    #[test]
    fn key_kind_detection_and_redaction() {
        let v3 = ApiKey::new(" 0123456789abcdef0123456789abcdef ").unwrap();
        assert!(!v3.is_bearer());
        let v4 = ApiKey::new("eyJhbGciOiJIUzI1NiJ9.payload.sig").unwrap();
        assert!(v4.is_bearer());
        assert!(ApiKey::new("   ").is_none());
        let dbg = format!("{v3:?}");
        assert!(!dbg.contains("0123"));
        assert!(dbg.contains("redacted"));
    }

    #[test]
    fn dotenv_parsing() {
        let text = "\u{feff}# comment\nOTHER=1\nexport TMDB_API_KEY = \"abc def\" \n";
        assert_eq!(parse_dotenv_value(text, API_KEY_ENV).unwrap(), "abc def");
        assert_eq!(
            parse_dotenv_value("TMDB_API_KEY=xyz # note", API_KEY_ENV).unwrap(),
            "xyz"
        );
        assert_eq!(
            parse_dotenv_value("TMDB_API_KEY='q'\nTMDB_API_KEY=last", API_KEY_ENV).unwrap(),
            "last"
        );
        assert!(parse_dotenv_value("TMDB_API_KEY=", API_KEY_ENV).is_none());
        assert!(parse_dotenv_value("TMDB_API_KEYS=x", API_KEY_ENV).is_none());
    }

    #[test]
    fn key_resolution_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        assert!(resolve_api_key(&s, dir.path(), false).is_none());
        std::fs::write(dir.path().join(".env"), "TMDB_API_KEY=fromfile\n").unwrap();
        let (k, src) = resolve_api_key(&s, dir.path(), false).unwrap();
        assert_eq!(k.expose(), "fromfile");
        assert_eq!(src, KeySource::DataDirEnv);
        s.tmdb.api_key = Some("fromsettings".into());
        let (k, src) = resolve_api_key(&s, dir.path(), false).unwrap();
        assert_eq!(k.expose(), "fromsettings");
        assert_eq!(src, KeySource::Settings);
    }
}
