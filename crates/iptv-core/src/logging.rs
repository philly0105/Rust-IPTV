//! Structured logging (brief: "Structured tracing logs to a rotating file under
//! app data; secrets never logged").
//!
//! [`init`] installs a global subscriber with two layers:
//! - JSON lines to `<data_dir>/logs/tsrust-iptv.YYYY-MM-DD.log`, rotated daily
//!   (UTC), keeping the newest [`MAX_LOG_FILES`] files;
//! - compact human-readable lines to stderr.
//!
//! Filter: `RUST_LOG` when set, else `info`.
//!
//! Secrets: never log `Settings.tmdb.apiKey`, source passwords, tokens, or raw
//! portal URLs. Model types redact secrets in `Debug`; use [`redact_url`] for
//! URLs and never log RPC args.

use crate::error::{CoreError, CoreResult};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// Log file name prefix.
pub const LOG_PREFIX: &str = "tsrust-iptv";
/// Log file name suffix.
pub const LOG_SUFFIX: &str = "log";
/// Number of daily files kept.
pub const MAX_LOG_FILES: usize = 14;

static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Keeps the background log writer alive; dropping it flushes the file.
/// Hold it for the life of the process (e.g. in `main`).
#[must_use = "dropping the guard stops file logging"]
pub struct LogGuard {
    _guard: Option<WorkerGuard>,
}

/// Directory holding log files for a data dir.
pub fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// Path of today's log file in `logs_dir` (UTC date, matching the appender).
pub fn current_log_file(logs_dir: &Path) -> PathBuf {
    let date = chrono::Utc::now().format("%Y-%m-%d");
    logs_dir.join(format!("{LOG_PREFIX}.{date}.{LOG_SUFFIX}"))
}

/// The logs dir passed to the first successful [`init`], if any.
pub fn active_logs_dir() -> Option<&'static Path> {
    LOGS_DIR.get().map(PathBuf::as_path)
}

/// Installs the global subscriber. Safe to call more than once: later calls
/// (and calls after another subscriber was installed, e.g. in tests) return a
/// no-op guard.
pub fn init(data_dir: &Path) -> CoreResult<LogGuard> {
    if LOGS_DIR.get().is_some() {
        return Ok(LogGuard { _guard: None });
    }
    let dir = logs_dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(LOG_PREFIX)
        .filename_suffix(LOG_SUFFIX)
        .max_log_files(MAX_LOG_FILES)
        .build(&dir)
        .map_err(|e| CoreError::Other(anyhow::anyhow!("log appender: {e}")))?;
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let file_layer = fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .with_target(true)
        .with_writer(writer)
        .with_ansi(false);
    let stderr_layer = fmt::layer()
        .compact()
        .with_target(true)
        .with_writer(std::io::stderr);

    let installed = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init()
        .is_ok();
    if installed {
        let _ = LOGS_DIR.set(dir);
        install_panic_hook();
        Ok(LogGuard {
            _guard: Some(guard),
        })
    } else {
        Ok(LogGuard { _guard: None })
    }
}

/// Logs panics through tracing so they reach the log file, then runs the default hook.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic>".to_string());
        tracing::error!(target: "panic", %location, message = %msg, "panic");
        default(info);
    }));
}

/// Query parameter names whose values are masked by [`redact_url`].
const SECRET_PARAMS: &[&str] = &[
    "password",
    "pass",
    "pwd",
    "username",
    "user",
    "token",
    "api_key",
    "apikey",
    "key",
    "auth",
    "mac",
    "signature",
    "passwd",
    "access_token",
    "sn",
    "serial",
    "device_id",
    "device_id2",
];

/// Masks credentials inside free text (error messages, upstream answers):
/// `name=value` pairs of [`SECRET_PARAMS`], `Bearer` tokens, URL userinfo,
/// and the username/password segments of Xtream stream paths. Text without
/// secrets comes back unchanged.
pub fn redact_text(text: &str) -> std::borrow::Cow<'_, str> {
    use regex::Regex;
    static PATTERNS: OnceLock<[(Regex, &'static str); 4]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        let names = SECRET_PARAMS.join("|");
        let re = |s: &str| Regex::new(s).expect("static redaction pattern");
        [
            (
                re(&format!(r#"(?i)(^|[^A-Za-z0-9_])({names})=([^&\s"'<>#]+)"#)),
                "$1$2=***",
            ),
            (re(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/=-]+"), "$1 ***"),
            (
                re(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@:]+:[^/\s@]*@"),
                "$1***:***@",
            ),
            (
                re(r"/(live|movie|series|timeshift)/[^/\s?#]+/[^/\s?#]+/"),
                "/$1/***/***/",
            ),
        ]
    });
    let mut out = std::borrow::Cow::Borrowed(text);
    for (re, rep) in patterns {
        if re.is_match(&out) {
            out = std::borrow::Cow::Owned(re.replace_all(&out, *rep).into_owned());
        }
    }
    out
}

/// Xtream path prefixes followed by `/{username}/{password}/`.
const XTREAM_PATH_PREFIXES: &[&str] = &["live", "movie", "series", "timeshift"];

/// Masks credentials in a URL for logging: userinfo, secret query parameters,
/// and the username/password path segments of Xtream stream URLs. Unparseable
/// input is replaced entirely.
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return "<unparseable url>".to_string();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("***");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("***"));
    }
    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| {
                let secret = SECRET_PARAMS.iter().any(|p| k.eq_ignore_ascii_case(p));
                (
                    k.into_owned(),
                    if secret {
                        "***".to_string()
                    } else {
                        v.into_owned()
                    },
                )
            })
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    let segments: Option<Vec<String>> = url.path_segments().map(|s| s.map(str::to_owned).collect());
    if let Some(mut segs) = segments {
        let mut changed = false;
        for i in 0..segs.len() {
            if XTREAM_PATH_PREFIXES.contains(&segs[i].as_str()) && i + 3 < segs.len() {
                segs[i + 1] = "***".into();
                segs[i + 2] = "***".into();
                changed = true;
                break;
            }
        }
        if changed {
            url.set_path(&segs.join("/"));
        }
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_credentials() {
        let r = redact_url(
            "http://host:8080/player_api.php?username=bob&password=hunter2&action=get_live_streams",
        );
        assert!(!r.contains("bob") && !r.contains("hunter2"), "{r}");
        assert!(r.contains("action=get_live_streams"));

        let r = redact_url("http://host/live/bob/hunter2/101.m3u8");
        assert!(!r.contains("bob") && !r.contains("hunter2"), "{r}");
        assert!(r.ends_with("101.m3u8"));

        let r = redact_url("http://bob:hunter2@host/x");
        assert!(!r.contains("hunter2"), "{r}");

        assert_eq!(redact_url("not a url"), "<unparseable url>");
    }

    #[test]
    fn redacts_secrets_in_free_text() {
        let t = redact_text(
            "GET http://h:8080/player_api.php?username=bob&password=hunter2&action=x failed; Authorization: Bearer tok.123-abc; see http://al:pw@h/x and http://h/live/bob/hunter2/1.ts (passwd=p2, sn=SER1, mac=00:1A:79:00:00:01)",
        );
        for secret in [
            "bob", "hunter2", "tok.123", "al:pw", "p2,", "SER1", "00:1A:79",
        ] {
            assert!(!t.contains(secret), "{secret} in {t}");
        }
        assert!(
            t.contains("action=x") && t.contains("Bearer ***") && t.contains("1.ts"),
            "{t}"
        );
        // Ordinary messages are untouched (and not copied).
        let plain = "Could not reach h. Check the address (connection refused)";
        assert!(matches!(redact_text(plain), std::borrow::Cow::Borrowed(_)));
        // Words that only end in a secret name are left alone.
        assert_eq!(redact_text("monkey=1 subpass=2"), "monkey=1 subpass=2");
        let r = redact_url("http://h/portal.php?type=stb&token=abc&sn=X1&device_id=D1");
        assert!(
            !r.contains("abc") && !r.contains("X1") && !r.contains("D1"),
            "{r}"
        );
    }

    #[test]
    fn log_file_name_shape() {
        let p = current_log_file(Path::new("/tmp/logs"));
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            name.starts_with("tsrust-iptv.") && name.ends_with(".log"),
            "{name}"
        );
    }
}
