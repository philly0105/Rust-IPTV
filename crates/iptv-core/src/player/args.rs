//! Command-line building for external players and the embedded mpv process.
//!
//! Each argument is one argv element; `std::process::Command` does the
//! platform quoting, so titles and URLs with spaces or quotes pass through
//! intact. The only parsing here is [`split_shell_args`], which turns the
//! free-text `settings.mpvArgs` / `settings.vlcArgs` into argv elements.

use crate::model::{PlayerSource, RequestHeaders};

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

/// Arguments for an external mpv (SPEC C4):
/// `--title=<title> --user-agent=<ua> --referrer=<ref>
/// --http-header-fields=Origin:<o> --force-media-title=<title>`, then the
/// user's `mpvArgs`, then the URL. Header flags appear only when set.
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
    args.push(source.url.clone());
    args
}

/// Arguments for an external VLC (SPEC C4):
/// `--meta-title=<t> --http-user-agent=<ua> --http-referrer=<ref>`, then the
/// user's `vlcArgs`, then the URL. VLC has no Origin option.
pub fn vlc_external_args(source: &PlayerSource, user_args: &str) -> Vec<String> {
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
    args.extend(split_shell_args(user_args));
    args.push(source.url.clone());
    args
}

/// Named pipe for the embedded session's JSON IPC (`<pid>` is this process).
pub fn mpv_pipe_name(pid: u32) -> String {
    format!(r"\\.\pipe\tsrust-iptv-mpv-{pid}")
}

/// Arguments for the embedded mpv process. The user's `mpvArgs` go first so
/// the embedding flags (SPEC C4) always win (mpv lets later options
/// override earlier ones).
pub fn embedded_mpv_args(hwnd: isize, pipe: &str, user_args: &str, volume: f64) -> Vec<String> {
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
    ]);
    args
}

/// Per-file options for `loadfile` in embedded mode: `force-media-title`,
/// `user-agent`, `referrer`, `http-header-fields`, and `start=+<seconds>`
/// for a resume position (live sources never seek).
pub fn loadfile_options(source: &PlayerSource) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let mut opts = serde_json::Map::new();
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
    opts
}
