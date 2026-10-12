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
        .with_writer(RedactingMakeWriter(writer))
        .with_ansi(false);
    let stderr_layer = fmt::layer()
        .compact()
        .with_target(true)
        .with_writer(RedactingMakeWriter(std::io::stderr));

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
    "play_token",
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
    "metrics",
];

/// Masks credentials inside free text (error messages, upstream answers, log
/// lines): `name=value` pairs of [`SECRET_PARAMS`] (plain and URL-encoded),
/// JSON `"password": "..."`-style members, `Bearer`/`Basic` credentials, URL
/// userinfo, and the username/password segments of Xtream stream paths (with
/// or without the `/live/` prefix). Text without secrets comes back unchanged.
pub fn redact_text(text: &str) -> std::borrow::Cow<'_, str> {
    use regex::Regex;
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        let names = SECRET_PARAMS.join("|");
        let re = |s: &str| Regex::new(s).expect("static redaction pattern");
        vec![
            (
                re(&format!(r#"(?i)(^|[^A-Za-z0-9])({names})=([^&\s"'<>#]+)"#)),
                "$1$2=***",
            ),
            // URL-encoded pairs (`password%3Dx%26...`): the value runs until
            // an encoded `&` (%26) or a plain delimiter.
            (
                re(&format!(
                    r#"(?i)(^|[^A-Za-z0-9]|%3F|%26)({names})%3D(?:[^&\s"'<>#%]|%(?:[013-9A-F][0-9A-F]|2[0-57-9A-F]))+"#
                )),
                "$1$2%3D***",
            ),
            // Account names (Stalker `do_auth` `login=`): first character and
            // `***`, like `xtream::client::mask_username`.
            (
                re(r#"(?i)(^|[^A-Za-z0-9])(login)=([^&\s"'<>#])[^&\s"'<>#]*"#),
                "$1$2=$3***",
            ),
            (
                re(
                    r#"(?i)(^|[^A-Za-z0-9]|%3F|%26)(login)%3D([^&\s"'<>#%]|%(?:[013-9A-F][0-9A-F]|2[0-57-9A-F]))(?:[^&\s"'<>#%]|%(?:[013-9A-F][0-9A-F]|2[0-57-9A-F]))*"#,
                ),
                "$1$2%3D$3***",
            ),
            (
                re(r#"(?i)(\\?")(username|login)(\\?")(\s*:\s*)(\\?")([^"\\])(?:[^"\\]|\\[^"])*\\?""#),
                "$1$2$3$4${5}${6}***${5}",
            ),
            // JSON members, also inside an already JSON-escaped string.
            (
                re(&format!(
                    r#"(?i)(\\?")({JSON_SECRET_KEYS})(\\?")(\s*:\s*)(\\?")(?:[^"\\]|\\[^"])*\\?""#
                )),
                "$1$2$3$4${5}***${5}",
            ),
            (
                re(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+"),
                "$1 ***",
            ),
            (
                re(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@:]+(?::[^/\s@]*)?@"),
                "$1***:***@",
            ),
            (
                re(r"(?i)/(live|movie|series|timeshift)/[^/\s?#]+/[^/\s?#]+/"),
                "/$1/***/***/",
            ),
            // Playlist and play paths with the account in the path:
            // `/playlist/{user}/{pass}/m3u_plus`, `/play/{user}/{pass}/...`.
            (
                re(r"(?i)/(playlist|play)/[^/\s?#]+/[^/\s?#]+"),
                "/$1/***/***",
            ),
            // Bare MAC addresses (Stalker portals key the account on them),
            // plain and URL-encoded.
            (
                re(r"(?i)\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b"),
                "**:**:**:**:**:**",
            ),
            // No leading boundary: an encoded MAC often follows `%22`.
            (
                re(r"(?i)[0-9a-f]{2}(?:%3A[0-9a-f]{2}){5}\b"),
                "***",
            ),
            // Xtream HLS redirects: `/hlsr/{token}/{user}/{pass}/{id}/...`.
            (
                re(r"(?i)/hlsr/[^/\s?#]+/[^/\s?#]+/[^/\s?#]+/"),
                "/hlsr/***/***/***/",
            ),
            // Xtream `get.php` playlists list live streams as
            // `http://host:port/{user}/{pass}/{id}[.ext]`.
            (
                re(r"(?i)(\b[a-z][a-z0-9+.-]*://[^/\s?#]+)/[^/\s?#]+/[^/\s?#]+/(\d+(?:\.[a-z0-9]{1,5})?)\b"),
                "$1/***/***/$2",
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

/// JSON member names masked by [`redact_text`] (a narrower list than
/// [`SECRET_PARAMS`]: log lines have members like `key` that are not secret).
const JSON_SECRET_KEYS: &str =
    "password|passwd|pass|pwd|token|access_token|api_key|apikey|apiKey|signature|secret|mac|sn|serial|device_id|device_id2";

/// Xtream path prefixes followed by `/{username}/{password}/`.
const XTREAM_PATH_PREFIXES: &[&str] = &["live", "movie", "series", "timeshift"];

/// Path prefixes followed by `/{username}/{password}` with or without more
/// segments: `/playlist/u/p/m3u_plus`, `/play/u/p/...`.
const ACCOUNT_PATH_PREFIXES: &[&str] = &["playlist", "play"];

/// Masks credentials in a URL for logging: userinfo, secret query parameters,
/// and the username/password path segments of Xtream stream URLs (`/live/u/p/1`
/// and the prefix-less `/u/p/1.ts` of `get.php` playlists). Unparseable input
/// is replaced entirely.
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
                let value = if secret {
                    "***".to_string()
                } else if k.eq_ignore_ascii_case("login") {
                    let first: String = v.trim().chars().take(1).collect();
                    format!("{first}***")
                } else {
                    v.into_owned()
                };
                (k.into_owned(), value)
            })
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    let segments: Option<Vec<String>> = url.path_segments().map(|s| s.map(str::to_owned).collect());
    if let Some(mut segs) = segments {
        let mut changed = false;
        // `/hlsr/{token}/{user}/{pass}/{id}/...`
        if let Some(i) = segs.iter().position(|s| s.eq_ignore_ascii_case("hlsr")) {
            if i + 4 < segs.len() {
                for seg in &mut segs[i + 1..=i + 3] {
                    *seg = "***".into();
                }
                changed = true;
            }
        }
        for i in 0..segs.len() {
            if changed {
                break;
            }
            if XTREAM_PATH_PREFIXES
                .iter()
                .any(|p| segs[i].eq_ignore_ascii_case(p))
                && i + 3 < segs.len()
            {
                segs[i + 1] = "***".into();
                segs[i + 2] = "***".into();
                changed = true;
                break;
            }
        }
        if !changed {
            if let Some(i) = segs.iter().position(|s| {
                ACCOUNT_PATH_PREFIXES
                    .iter()
                    .any(|p| s.eq_ignore_ascii_case(p))
            }) {
                if i + 2 < segs.len() {
                    segs[i + 1] = "***".into();
                    segs[i + 2] = "***".into();
                    changed = true;
                }
            }
        }
        if !changed && segs.len() == 3 && is_stream_id(&segs[2]) {
            segs[0] = "***".into();
            segs[1] = "***".into();
            changed = true;
        }
        if changed {
            url.set_path(&segs.join("/"));
        }
    }
    url.to_string()
}

/// `12345` or `12345.ts`: the last segment of an Xtream stream path.
fn is_stream_id(seg: &str) -> bool {
    let (id, ext) = seg.split_once('.').unwrap_or((seg, ""));
    !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_digit())
        && ext.len() <= 5
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// A log writer that runs every formatted line through [`redact_text`], so a
/// secret that reaches a log call by accident (an unredacted error message,
/// an upstream answer) never lands in the log file or on stderr.
pub struct RedactingWriter<W>(W);

impl<W: std::io::Write> std::io::Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // The fmt layer writes each event as one buffer.
        match std::str::from_utf8(buf) {
            Ok(text) => self.0.write_all(redact_text(text).as_bytes())?,
            Err(_) => self.0.write_all(buf)?,
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

/// [`tracing_subscriber::fmt::MakeWriter`] wrapper producing [`RedactingWriter`]s.
pub struct RedactingMakeWriter<M>(pub M);

impl<'a, M: tracing_subscriber::fmt::MakeWriter<'a>> tracing_subscriber::fmt::MakeWriter<'a>
    for RedactingMakeWriter<M>
{
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter(self.0.make_writer())
    }
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

    /// Review round 1: `play_token=` (an `_` before a secret name) and the
    /// token, user and password of Xtream `/hlsr/` paths.
    #[test]
    fn redacts_play_token_and_hlsr_paths() {
        let t =
            redact_text("GET http://h/play/x.m3u8?play_token=Tk9aZ&x=1 and stream_password=pw77");
        assert!(!t.contains("Tk9aZ") && !t.contains("pw77"), "{t}");
        assert!(t.contains("x=1"), "{t}");
        let t = redact_text("GET http://h:80/hlsr/tok123/bob/hunter2/1501/index.m3u8 failed");
        for secret in ["tok123", "bob", "hunter2"] {
            assert!(!t.contains(secret), "{secret} in {t}");
        }
        assert!(t.contains("/1501/index.m3u8"), "{t}");
        let u = redact_url("http://h:80/hlsr/tok123/bob/hunter2/1501/index.m3u8?play_token=Tk9aZ");
        for secret in ["tok123", "bob", "hunter2", "Tk9aZ"] {
            assert!(!u.contains(secret), "{secret} in {u}");
        }
        assert!(u.contains("/1501/index.m3u8"), "{u}");
    }

    /// Review round 2: Stalker `login=` and the JSON `username` member keep
    /// only the first character, like the Xtream account mask.
    #[test]
    fn redacts_playlist_and_play_paths() {
        let u = redact_url("http://h:8080/playlist/alice77/hunter2/m3u_plus?output=ts");
        assert_eq!(u, "http://h:8080/playlist/***/***/m3u_plus?output=ts");
        let u = redact_url("http://h/play/alice77/hunter2/12345");
        assert!(!u.contains("alice77") && !u.contains("hunter2"), "{u}");
        assert!(u.ends_with("/play/***/***/12345"), "{u}");
        let u = redact_url("http://h/playlist/alice77/hunter2");
        assert!(!u.contains("alice77") && !u.contains("hunter2"), "{u}");
        let t = redact_text(
            "download of http://h:8080/playlist/alice77/hunter2/m3u_plus failed; also http://h/play/alice77/hunter2/9.ts",
        );
        assert!(!t.contains("alice77") && !t.contains("hunter2"), "{t}");
        assert!(
            t.contains("/playlist/***/***/m3u_plus") && t.contains("/play/***/***/9.ts"),
            "{t}"
        );
        // Words that only contain the prefix are left alone.
        assert_eq!(redact_text("/display/a/b"), "/display/a/b");
    }

    #[test]
    fn redacts_stalker_device_ids_and_macs() {
        let t = redact_text(
            r#"answer {"mac": "00:1A:79:12:34:56", "sn": "SER1", "serial": "SER2", "device_id": "DEV1", "device_id2": "DEV2", "status": 1}"#,
        );
        for secret in ["00:1A:79", "SER1", "SER2", "DEV1", "DEV2"] {
            assert!(!t.contains(secret), "{secret} in {t}");
        }
        assert!(t.contains(r#""status": 1"#), "{t}");
        let t = redact_text(
            "GET http://h/portal.php?action=get_profile&metrics=%7B%22mac%22%3A%2200%3A1A%3A79%3A12%3A34%3A56%22%2C%22sn%22%3A%22SER1%22%7D&x=1",
        );
        assert!(!t.contains("SER1") && !t.contains("79%3A12"), "{t}");
        assert!(t.contains("metrics=***") && t.contains("x=1"), "{t}");
        let t = redact_text(
            "handshake for 00:1a:79:ab:cd:ef failed; encoded 00%3A1A%3A79%3AAB%3ACD%3AEF",
        );
        assert!(!t.contains("ab:cd") && !t.contains("AB%3ACD"), "{t}");
        let u = redact_url("http://h/portal.php?metrics=%7B%22sn%22%3A%22SER1%22%7D");
        assert!(!u.contains("SER1"), "{u}");
        // Times and plain hex stay.
        assert_eq!(
            redact_text("at 12:30:45, id deadbeef"),
            "at 12:30:45, id deadbeef"
        );
    }

    #[test]
    fn redacts_login_and_json_username() {
        let t = redact_text(
            "GET http://h/portal.php?type=stb&action=do_auth&login=alice77&password=pw&x=1 failed",
        );
        assert!(!t.contains("alice77") && !t.contains("=pw"), "{t}");
        assert!(t.contains("login=a***") && t.contains("x=1"), "{t}");
        let t = redact_text("url=http%3A%2F%2Fh%2Fp.php%3Flogin%3Dalice77%26x%3D1");
        assert!(!t.contains("alice77"), "{t}");
        assert!(t.contains("login%3Da***%26x%3D1"), "{t}");
        let t = redact_text(r#"answer {"username": "alice77", "status": "Active"}"#);
        assert!(!t.contains("alice77"), "{t}");
        assert!(
            t.contains(r#""username": "a***""#) && t.contains("Active"),
            "{t}"
        );
        let t = redact_text(r#"body "{\"username\":\"alice77\"}""#);
        assert!(!t.contains("alice77"), "{t}");
        let u = redact_url("http://h/portal.php?action=do_auth&login=alice77&x=1");
        assert!(!u.contains("alice77") && u.contains("login=a***"), "{u}");
        // Untouched without a value.
        assert_eq!(redact_text("login= done"), "login= done");
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

    /// B9: forms the first version missed.
    #[test]
    fn redacts_bare_xtream_paths_json_basic_and_encoded_secrets() {
        let t = redact_text(
            r#"stream http://h:8080/bob/hunter2/12345.ts and http://h/LIVE/al/pw9/7.m3u8 failed; reply {"js":{"token":"TK1","password": "pw2"}} log "{\"api_key\":\"K3\"}" Authorization: Basic dXNlcjpwYXNz; next=%2Fx%3Fpassword%3Dpw4%26a%3D1 at http://tok5@h/x"#,
        );
        for secret in [
            "bob",
            "hunter2",
            "al/",
            "pw9",
            "TK1",
            "pw2",
            "K3",
            "dXNlcjpwYXNz",
            "pw4",
            "tok5",
        ] {
            assert!(!t.contains(secret), "{secret} in {t}");
        }
        for kept in [
            "12345.ts",
            "7.m3u8",
            "%26a%3D1",
            "Basic ***",
            r#""token":"***""#,
            r#"\"api_key\":\"***\""#,
        ] {
            assert!(t.contains(kept), "{kept} missing in {t}");
        }
        let r = redact_url("http://h:8080/bob/hunter2/12345.ts");
        assert_eq!(r, "http://h:8080/***/***/12345.ts");
        let r = redact_url("http://h/LIVE/bob/hunter2/1.ts");
        assert!(!r.contains("hunter2"), "{r}");
        // Ordinary paths are left alone.
        assert_eq!(redact_url("http://h/a/b/c.m3u"), "http://h/a/b/c.m3u");
        // JSON log fields that only look like secret names stay readable.
        assert_eq!(
            redact_text(r#"{"key":"sources.active"}"#),
            r#"{"key":"sources.active"}"#
        );
    }

    #[test]
    fn the_log_writer_redacts_each_line() {
        use std::io::Write;
        let mut out = Vec::new();
        {
            let mut w = RedactingWriter(&mut out);
            w.write_all(
                b"failed http://h/live/bob/hunter2/1.ts password=x
",
            )
            .unwrap();
        }
        let line = String::from_utf8(out).unwrap();
        assert!(!line.contains("hunter2") && !line.contains("=x"), "{line}");
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
