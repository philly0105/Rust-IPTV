//! Command-line building for external players and the embedded mpv process.
//!
//! Each argument is one argv element; `std::process::Command` does the
//! platform quoting, so titles and URLs with spaces or quotes pass through
//! intact. The only parsing here is [`split_shell_args`], which turns the
//! free-text `settings.mpvArgs` / `settings.vlcArgs` into argv elements.

use crate::error::{CoreError, CoreResult};
use crate::model::{PlayerKind, PlayerSource, RequestHeaders};

/// Splits a user-entered argument string shell-style.
///
/// - Whitespace separates arguments.
/// - `"..."` groups; inside it `\"` is a literal quote, every other
///   backslash is literal (so `"C:\Program Files\x.lua"` survives).
/// - `'...'` groups with no escapes at all.
/// - Outside quotes, a backslash escapes only whitespace or a quote
///   character; otherwise it is literal (Windows paths and UNC `\\server`
///   stay intact).
/// - Quotes may sit mid-argument (`--title="A B"` -> `--title=A B`), `""`
///   yields an empty argument, and an unterminated quote runs to the end.
pub fn split_shell_args(input: &str) -> Vec<String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Normal,
        Double,
        Single,
    }

    let mut out = Vec::new();
    let mut cur = String::new();
    // True once the current argument has started (covers `""`).
    let mut started = false;
    let mut mode = Mode::Normal;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match mode {
            Mode::Normal => match c {
                c if c.is_whitespace() => {
                    if started {
                        out.push(std::mem::take(&mut cur));
                        started = false;
                    }
                }
                '"' => {
                    mode = Mode::Double;
                    started = true;
                }
                '\'' => {
                    mode = Mode::Single;
                    started = true;
                }
                '\\' => {
                    started = true;
                    match chars.peek() {
                        Some(&n) if n.is_whitespace() || n == '"' || n == '\'' => {
                            cur.push(n);
                            chars.next();
                        }
                        _ => cur.push('\\'),
                    }
                }
                c => {
                    cur.push(c);
                    started = true;
                }
            },
            Mode::Double => match c {
                '"' => mode = Mode::Normal,
                '\\' if chars.peek() == Some(&'"') => {
                    cur.push('"');
                    chars.next();
                }
                c => cur.push(c),
            },
            Mode::Single => match c {
                '\'' => mode = Mode::Normal,
                c => cur.push(c),
            },
        }
    }
    if started {
        out.push(cur);
    }
    out
}

/// Escapes one value for an mpv string-list option such as
/// `http-header-fields`: mpv splits on unescaped commas, so `\` becomes `\\`
/// and `,` becomes `\,` (a Stalker MAG user agent contains
/// `(KHTML, like Gecko)`).
pub fn escape_mpv_list_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ',' => out.push_str("\\,"),
            c => out.push(c),
        }
    }
    out
}

fn non_blank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The value of mpv's `http-header-fields` for these headers, or `None`.
/// User-Agent and Referer have dedicated mpv options, so only Origin goes
/// here, written `Origin:<value>` as in SPEC C4.
pub fn mpv_header_fields(headers: Option<&RequestHeaders>) -> Option<String> {
    let origin = non_blank(&headers?.origin)?;
    Some(format!("Origin:{}", escape_mpv_list_value(origin)))
}

/// URL schemes a player may be handed. Anything else (`av://`, `edl://`,
/// `memory://`, a bare `--option`, ...) is refused before mpv or VLC sees it.
pub const ALLOWED_URL_SCHEMES: &[&str] = &[
    "http", "https", "rtmp", "rtmps", "rtsp", "udp", "rtp", "mms", "file",
];

/// Refuses stream URLs a player could misread as an option or as one of its
/// special protocols (playlist lines are untrusted input). Accepts the
/// [`ALLOWED_URL_SCHEMES`] and, for `kind: file`, a local absolute path.
pub fn validate_play_url(source: &PlayerSource) -> CoreResult<()> {
    let url = source.url.trim();
    if url.is_empty() {
        return Err(CoreError::invalid("this item has no stream URL to play"));
    }
    let refuse = || {
        CoreError::invalid(format!(
            "refusing to hand this stream to a player: only {} URLs (or a local file) can be played",
            ALLOWED_URL_SCHEMES.join(", ")
        ))
    };
    if url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(refuse());
    }
    if source.kind == PlayerKind::File && is_local_absolute_path(url) {
        return Ok(());
    }
    let scheme = url
        .split_once(':')
        .map(|(s, _)| s)
        .filter(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        .ok_or_else(refuse)?
        .to_ascii_lowercase();
    if ALLOWED_URL_SCHEMES.contains(&scheme.as_str()) {
        Ok(())
    } else {
        Err(refuse())
    }
}

/// `C:\x`, `C:/x`, `\\server\share\x` (Windows) or `/x` (Unix).
fn is_local_absolute_path(s: &str) -> bool {
    let b = s.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    let unc = s.len() > 2 && s.starts_with(r"\\");
    drive || unc || (cfg!(unix) && s.starts_with('/'))
}

/// Arguments for an external mpv (SPEC C4):
/// `--title=<title> --user-agent=<ua> --referrer=<ref>
/// --http-header-fields=Origin:<o> --force-media-title=<title>`, then the
/// user's `mpvArgs`, then `--` and the URL (the separator keeps a playlist
/// URL such as `--script=...` from being read as an option). Header flags
/// appear only when set.
pub fn mpv_external_args(source: &PlayerSource, user_args: &str) -> Vec<String> {
    let mut args = Vec::new();
    let title = source.title.trim();
    if !title.is_empty() {
        args.push(format!("--title={title}"));
    }
    if let Some(h) = &source.headers {
        if let Some(ua) = non_blank(&h.user_agent) {
            args.push(format!("--user-agent={ua}"));
        }
        if let Some(r) = non_blank(&h.referrer) {
            args.push(format!("--referrer={r}"));
        }
    }
    if let Some(fields) = mpv_header_fields(source.headers.as_ref()) {
        args.push(format!("--http-header-fields={fields}"));
    }
    if !title.is_empty() {
        args.push(format!("--force-media-title={title}"));
    }
    args.extend(split_shell_args(user_args));
    args.push("--".to_string());
    args.push(source.url.clone());
    args
}

/// Arguments for an external VLC (SPEC C4):
/// `--meta-title=<t> --http-user-agent=<ua> --http-referrer=<ref>`, then
/// `--one-instance --playlist-enqueue` when `reuse_instance`, then the
/// user's `vlcArgs`, then `--` and the URL. VLC has no Origin option.
pub fn vlc_external_args(
    source: &PlayerSource,
    user_args: &str,
    reuse_instance: bool,
) -> Vec<String> {
    let mut args = Vec::new();
    let title = source.title.trim();
    if !title.is_empty() {
        args.push(format!("--meta-title={title}"));
    }
    if let Some(h) = &source.headers {
        if let Some(ua) = non_blank(&h.user_agent) {
            args.push(format!("--http-user-agent={ua}"));
        }
        if let Some(r) = non_blank(&h.referrer) {
            args.push(format!("--http-referrer={r}"));
        }
    }
    if reuse_instance {
        args.push("--one-instance".to_string());
        args.push("--playlist-enqueue".to_string());
    }
    args.extend(split_shell_args(user_args));
    args.push("--".to_string());
    args.push(source.url.clone());
    args
}

/// Base name of the embedded session's JSON IPC pipe (`<pid>` is this
/// process). The embedded player appends `-<session>`, a number that is new
/// for each attach (player/embedded.rs), so the pipe mpv opens is
/// `\\.\pipe\tsrust-iptv-mpv-<pid>-<session>`.
pub fn mpv_pipe_name(pid: u32) -> String {
    format!(r"\\.\pipe\tsrust-iptv-mpv-{pid}")
}

/// Arguments for the embedded mpv process. The user's `mpvArgs` go first so
/// the embedding flags (SPEC C4) always win (mpv lets later options
/// override earlier ones). `volume` and `muted` are the UI's saved values,
/// applied at startup so mpv never plays a frame at the wrong level.
pub fn embedded_mpv_args(
    hwnd: isize,
    pipe: &str,
    user_args: &str,
    volume: f64,
    muted: bool,
) -> Vec<String> {
    let mut args = split_shell_args(user_args);
    args.extend([
        format!("--wid={hwnd}"),
        format!("--input-ipc-server={pipe}"),
        "--idle=yes".to_string(),
        "--keep-open=yes".to_string(),
        "--no-osc".to_string(),
        "--no-input-default-bindings".to_string(),
        "--force-window=yes".to_string(),
        "--hwdec=auto-safe".to_string(),
        // Keys belong to the web UI, never to the video window.
        "--input-vo-keyboard=no".to_string(),
        "--no-terminal".to_string(),
        format!("--volume={}", volume.clamp(0.0, 130.0).round()),
        format!("--mute={}", if muted { "yes" } else { "no" }),
    ]);
    args
}

/// Per-file mpv options that turn the demuxer cache into a rewind buffer for
/// live streams.
pub const LIVE_TIMESHIFT_OPTIONS: &[(&str, &str)] = &[
    ("cache", "yes"),
    ("demuxer-max-back-bytes", "1GiB"),
    ("demuxer-seekable-cache", "yes"),
    ("force-seekable", "yes"),
];

/// Per-file mpv options for movies and episodes: read far ahead, and after a
/// stall refill a few seconds before playing again, so a stream that arrives
/// barely faster than its bitrate pauses rarely instead of every few seconds.
pub const VOD_BUFFER_OPTIONS: &[(&str, &str)] = &[
    ("cache", "yes"),
    ("cache-pause-wait", "5"),
    ("demuxer-readahead-secs", "120"),
    ("demuxer-max-bytes", "500MiB"),
];

/// Per-file options for `loadfile` in embedded mode: `force-media-title`,
/// `user-agent`, `referrer`, `http-header-fields`, and `start=+<seconds>`
/// for a resume position (live sources never seek).
///
/// Every item starts playing (`pause=no`): mpv's `pause` is global, so a
/// user pause, or `keep-open` pausing at the end of an episode, would
/// otherwise carry over to the next channel or the Up next episode.
///
/// Live items end instead of pausing at the end (`keep-open=no`): a live
/// stream only ends when the provider drops it, and the resulting `end-file`
/// (reason `eof`) is reported as an error, so the player reconnects or fails
/// over instead of freezing on the last frame (`mpv_state::apply_event`).
pub fn loadfile_options(source: &PlayerSource) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let mut opts = serde_json::Map::new();
    opts.insert("pause".into(), Value::String("no".into()));
    let title = source.title.trim();
    if !title.is_empty() {
        opts.insert("force-media-title".into(), Value::String(title.to_string()));
    }
    if let Some(h) = &source.headers {
        if let Some(ua) = non_blank(&h.user_agent) {
            opts.insert("user-agent".into(), Value::String(ua.to_string()));
        }
        if let Some(r) = non_blank(&h.referrer) {
            opts.insert("referrer".into(), Value::String(r.to_string()));
        }
    }
    if let Some(fields) = mpv_header_fields(source.headers.as_ref()) {
        opts.insert("http-header-fields".into(), Value::String(fields));
    }
    match source.resume_seconds {
        Some(s) if s > 0 && !source.is_live => {
            opts.insert("start".into(), Value::String(format!("+{s}")));
        }
        _ => {}
    }
    if source.is_live {
        // Timeshift: keep what was watched in the cache and let mpv seek in it,
        // so live TV can rewind (about 20 minutes of a 6 Mbit/s stream) and
        // jump back to the live edge.
        for (k, v) in LIVE_TIMESHIFT_OPTIONS {
            opts.insert((*k).into(), Value::String((*v).to_string()));
        }
        opts.insert("keep-open".into(), Value::String("no".into()));
    } else {
        for (k, v) in VOD_BUFFER_OPTIONS {
            opts.insert((*k).into(), Value::String((*v).to_string()));
        }
    }
    opts
}

#[cfg(test)]
mod loadfile_tests {
    use super::loadfile_options;
    use crate::model::{PlayerKind, PlayerSource};
    use serde_json::json;

    fn source(is_live: bool) -> PlayerSource {
        PlayerSource {
            url: "http://h/x".into(),
            kind: PlayerKind::Direct,
            headers: None,
            title: "X".into(),
            subtitle: None,
            poster_url: None,
            item_ref: None,
            episode_id: None,
            resume_seconds: None,
            is_live,
            is_radio: false,
        }
    }

    /// L2-desktop-1: mpv's pause is global. A zap after a user pause, and the
    /// Up next episode after `keep-open` paused at the end, must start playing.
    #[test]
    fn every_item_starts_playing() {
        for live in [true, false] {
            assert_eq!(loadfile_options(&source(live))["pause"], json!("no"));
        }
        let legacy = crate::player::embedded::legacy_options(&loadfile_options(&source(false)));
        assert!(legacy.contains("pause=%2%no"), "{legacy}");
    }

    /// L2-desktop-2: a live stream ends (`end-file`) instead of freezing paused
    /// on its last frame; VOD keeps the global `keep-open` (pause at the end).
    #[test]
    fn live_items_end_instead_of_pausing_at_the_end() {
        assert_eq!(loadfile_options(&source(true))["keep-open"], json!("no"));
        assert!(!loadfile_options(&source(false)).contains_key("keep-open"));
    }

    /// Movies and episodes refill a few seconds after a stall; live keeps zapping fast.
    #[test]
    fn vod_items_buffer_ahead_and_live_items_do_not() {
        assert_eq!(loadfile_options(&source(false))["cache-pause-wait"], json!("5"));
        assert_eq!(loadfile_options(&source(false))["demuxer-readahead-secs"], json!("120"));
        assert!(!loadfile_options(&source(true)).contains_key("cache-pause-wait"));
    }
}
