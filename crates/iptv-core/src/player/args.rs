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

/// URL schemes a player may be handed. Anything else (`file:`, `av://`,
/// `edl://`, `memory://`, a bare `--option`, ...) is refused before mpv or
/// VLC sees it. `file:` is out because a playlist line could use it to open
/// a local file or, on Windows, a network share.
pub const ALLOWED_URL_SCHEMES: &[&str] = &[
    "http", "https", "rtmp", "rtmps", "rtsp", "udp", "rtp", "mms",
];

/// Refuses stream URLs a player could misread as an option or as one of its
/// special protocols (playlist lines are untrusted input). Accepts the
/// [`ALLOWED_URL_SCHEMES`] and, for `kind: file`, a local absolute path that
/// is not a network path.
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

/// `C:\x`, `C:/x` (Windows) or `/x` (Unix), never a network path such as
/// `\\server\share\x` or `//server/share/x`: Windows opens one by connecting
/// to that server with the user's credentials, and the UI marks a playlist
/// line without a scheme as `kind: file`.
fn is_local_absolute_path(s: &str) -> bool {
    let b = s.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && sep(b[2]);
    let network = b.len() >= 2 && sep(b[0]) && sep(b[1]);
    !network && (drive || (cfg!(unix) && s.starts_with('/')))
}

/// Arguments for an external mpv (SPEC C4):
/// `--title=<title> --user-agent=<ua> --referrer=<ref>
/// --http-header-fields=Origin:<o> --force-media-title=<title>`, then
/// `--demuxer-lavf-analyzeduration` for a live source ([`LIVE_PROBE_OPTIONS`]),
/// then the user's `mpvArgs` (a later option wins, so theirs do, a `--profile`
/// or `--include` among them too; a value in `mpv.conf` loses to the flag,
/// since mpv reads its config before the command line), then `--`
/// and the URL (the separator keeps a playlist URL such as `--script=...`
/// from being read as an option). Header flags appear only when set.
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
    if source.is_live {
        args.push(format!(
            "--demuxer-lavf-analyzeduration={LIVE_ANALYZE_SECONDS}"
        ));
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
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\tsrust-iptv-mpv-{pid}")
    }
    #[cfg(not(windows))]
    {
        format!("/tmp/tsrust-iptv-mpv-{pid}")
    }
}

/// Arguments for the embedded mpv process. The user's `mpvArgs` go first so
/// the embedding flags (SPEC C4) always win (mpv lets later options
/// override earlier ones). The one exception is `--hwdec`: a decoder the user
/// picked (`--hwdec=d3d11va`, `--hwdec=nvdec`, `--hwdec=no`) is kept, and
/// `auto-safe` is only the default. `volume` and `muted` are the UI's saved
/// values, applied at startup so mpv never plays a frame at the wrong level.
pub fn embedded_mpv_args(
    hwnd: isize,
    pipe: &str,
    user_args: &str,
    volume: f64,
    muted: bool,
) -> Vec<String> {
    let mut args = split_shell_args(user_args);
    let user_hwdec = args
        .iter()
        .any(|a| a == "--hwdec" || a.starts_with("--hwdec=") || a == "--no-hwdec");
    args.extend([
        format!("--wid={hwnd}"),
        format!("--input-ipc-server={pipe}"),
        "--idle=yes".to_string(),
        "--keep-open=yes".to_string(),
        "--no-osc".to_string(),
        "--no-input-default-bindings".to_string(),
        "--force-window=yes".to_string(),
        // Keys belong to the web UI, never to the video window.
        "--input-vo-keyboard=no".to_string(),
        "--no-terminal".to_string(),
        format!("--volume={}", volume.clamp(0.0, 130.0).round()),
        format!("--mute={}", if muted { "yes" } else { "no" }),
    ]);
    if !user_hwdec {
        args.push("--hwdec=auto-safe".to_string());
    }
    args
}

/// Per-file mpv options that turn the demuxer cache into a rewind buffer for
/// live streams. The buffer lives in mpv's RAM, so it is capped at 256 MiB:
/// about 6 minutes of a 6 Mbit/s channel, 1.5 minutes at 25 Mbit/s (1 GiB
/// grew mpv by 45 MB a minute until it held a gigabyte per stream).
pub const LIVE_TIMESHIFT_OPTIONS: &[(&str, &str)] = &[
    ("cache", "yes"),
    ("demuxer-max-back-bytes", "256MiB"),
    ("demuxer-seekable-cache", "yes"),
    ("force-seekable", "yes"),
];

/// Seconds of a live stream FFmpeg analyzes before playback (see
/// [`LIVE_PROBE_OPTIONS`]).
pub const LIVE_ANALYZE_SECONDS: &str = "2";

/// Per-file mpv options that cut FFmpeg's stream analysis of a live stream
/// short (STR-3). With FFmpeg's defaults (5 MB, up to 7 s of stream) the lavf
/// demuxer waits for codec parameters of every PID the panel lists: a silent
/// second audio track or a data PID held each zap until the limit. Two seconds
/// still reach a video keyframe and the audio of a normal channel, and
/// `fpsprobesize=0` stops it waiting for 20 frames to guess the frame rate,
/// which live TS timestamps carry anyway. `fpsprobesize` goes in through
/// `demuxer-lavf-o-append`, which adds it to the user's list for that file
/// (a per-file `demuxer-lavf-o` would replace the whole list). Each is left
/// out when the user's own configuration sets it ([`UserProbeOptions`]).
pub const LIVE_PROBE_OPTIONS: &[(&str, &str)] = &[
    ("demuxer-lavf-analyzeduration", LIVE_ANALYZE_SECONDS),
    ("demuxer-lavf-o-append", "fpsprobesize=0"),
];

/// Which of [`LIVE_PROBE_OPTIONS`] the user's own mpv configuration sets.
/// Embedded mpv reports its global values right after it starts
/// (`embedded::attach`), so `mpvArgs`, a `--profile` or `--include` in them,
/// and `mpv.conf` all count; a per-file value would replace theirs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UserProbeOptions {
    /// `demuxer-lavf-analyzeduration` is not mpv's default, 0 (FFmpeg's own
    /// limit), which is also how an explicit 0 reads.
    pub analyzeduration: bool,
    /// `demuxer-lavf-o` has an `fpsprobesize` entry.
    pub fpsprobesize: bool,
}

impl UserProbeOptions {
    /// From mpv's `get_property` replies for `demuxer-lavf-analyzeduration`
    /// and `demuxer-lavf-o` (`None` when a read failed). A value that could
    /// not be read counts as set: the app does not replace what it can't see.
    pub fn from_globals(
        analyzeduration: Option<&serde_json::Value>,
        lavf_o: Option<&serde_json::Value>,
    ) -> Self {
        Self {
            analyzeduration: analyzeduration.and_then(serde_json::Value::as_f64) != Some(0.0),
            fpsprobesize: lavf_o
                .and_then(serde_json::Value::as_object)
                .is_none_or(|list| list.contains_key("fpsprobesize")),
        }
    }

    /// The user set the option behind `name`, one of [`LIVE_PROBE_OPTIONS`].
    fn sets(self, name: &str) -> bool {
        if name == "demuxer-lavf-analyzeduration" {
            self.analyzeduration
        } else {
            self.fpsprobesize
        }
    }
}

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
/// for a resume position (live sources never seek). `user` is what the
/// running mpv reported of [`LIVE_PROBE_OPTIONS`].
///
/// Every item starts playing (`pause=no`): mpv's `pause` is global, so a
/// user pause, or `keep-open` pausing at the end of an episode, would
/// otherwise carry over to the next channel or the Up next episode.
///
/// Live items end instead of pausing at the end (`keep-open=no`): a live
/// stream only ends when the provider drops it, and the resulting `end-file`
/// (reason `eof`) is reported as an error, so the player reconnects or fails
/// over instead of freezing on the last frame (`mpv_state::apply_event`).
pub fn loadfile_options(
    source: &PlayerSource,
    user: UserProbeOptions,
) -> serde_json::Map<String, serde_json::Value> {
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
        for (k, v) in LIVE_PROBE_OPTIONS {
            if !user.sets(k) {
                opts.insert((*k).into(), Value::String((*v).to_string()));
            }
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
    use super::{loadfile_options, UserProbeOptions};
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

    /// Options for a user who set none of the live probe options.
    fn options(is_live: bool) -> serde_json::Map<String, serde_json::Value> {
        loadfile_options(&source(is_live), UserProbeOptions::default())
    }

    /// L2-desktop-1: mpv's pause is global. A zap after a user pause, and the
    /// Up next episode after `keep-open` paused at the end, must start playing.
    #[test]
    fn every_item_starts_playing() {
        for live in [true, false] {
            assert_eq!(options(live)["pause"], json!("no"));
        }
        let legacy = crate::player::embedded::legacy_options(&options(false));
        assert!(legacy.contains("pause=%2%no"), "{legacy}");
    }

    /// L2-desktop-2: a live stream ends (`end-file`) instead of freezing paused
    /// on its last frame; VOD keeps the global `keep-open` (pause at the end).
    #[test]
    fn live_items_end_instead_of_pausing_at_the_end() {
        assert_eq!(options(true)["keep-open"], json!("no"));
        assert!(!options(false).contains_key("keep-open"));
    }

    /// Movies and episodes refill a few seconds after a stall; live keeps zapping fast.
    #[test]
    fn vod_items_buffer_ahead_and_live_items_do_not() {
        assert_eq!(options(false)["cache-pause-wait"], json!("5"));
        assert_eq!(options(false)["demuxer-readahead-secs"], json!("120"));
        assert!(!options(true).contains_key("cache-pause-wait"));
    }
}
