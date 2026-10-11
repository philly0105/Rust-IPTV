//! Argument building for external mpv / VLC and the embedded mpv process.

use iptv_core::model::{PlayerKind, PlayerSource, RequestHeaders, Settings};
use iptv_core::player::args::{
    embedded_mpv_args, escape_mpv_list_value, loadfile_options, mpv_external_args,
    mpv_header_fields, mpv_pipe_name, split_shell_args, vlc_external_args,
};
use iptv_core::player::embedded::{legacy_options, validate_command};
use iptv_core::player::external::{build_args, ExternalPlayer};
use serde_json::json;

fn source(url: &str, title: &str, headers: Option<RequestHeaders>) -> PlayerSource {
    PlayerSource {
        url: url.into(),
        kind: PlayerKind::Hls,
        headers,
        title: title.into(),
        subtitle: None,
        poster_url: None,
        item_ref: None,
        episode_id: None,
        resume_seconds: None,
        is_live: true,
        is_radio: false,
    }
}

fn headers(
    ua: Option<&str>,
    referrer: Option<&str>,
    origin: Option<&str>,
) -> Option<RequestHeaders> {
    Some(RequestHeaders {
        user_agent: ua.map(Into::into),
        referrer: referrer.map(Into::into),
        origin: origin.map(Into::into),
    })
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

// ---- shell-style splitting ------------------------------------------------

#[test]
fn split_plain_whitespace() {
    assert_eq!(
        split_shell_args("  --fs   --volume=50\t--mute=yes \n"),
        s(&["--fs", "--volume=50", "--mute=yes"])
    );
    assert!(split_shell_args("").is_empty());
    assert!(split_shell_args("   \t ").is_empty());
}

#[test]
fn split_double_quotes_group_and_keep_backslashes() {
    assert_eq!(
        split_shell_args(r#"--script="C:\Program Files\mpv\x.lua" --title="My Show""#),
        s(&[r"--script=C:\Program Files\mpv\x.lua", "--title=My Show"])
    );
    assert_eq!(split_shell_args(r#""say \"hi\"""#), s(&[r#"say "hi""#]));
}

#[test]
fn split_single_quotes_are_literal() {
    assert_eq!(
        split_shell_args(r#"'a "b" \c' d"#),
        s(&[r#"a "b" \c"#, "d"])
    );
}

#[test]
fn split_backslash_outside_quotes() {
    // Escapes whitespace and quotes only; Windows and UNC paths survive.
    assert_eq!(split_shell_args(r"a\ b"), s(&["a b"]));
    assert_eq!(split_shell_args(r#"\"x\""#), s(&[r#""x""#]));
    assert_eq!(
        split_shell_args(r"C:\mpv\mpv.exe \\server\share"),
        s(&[r"C:\mpv\mpv.exe", r"\\server\share"])
    );
}

#[test]
fn split_empty_quotes_and_unterminated() {
    assert_eq!(split_shell_args(r#"a "" b"#), s(&["a", "", "b"]));
    assert_eq!(
        split_shell_args(r#"--title="never closed"#),
        s(&["--title=never closed"])
    );
    assert_eq!(split_shell_args("x'y z'w"), s(&["xy zw"]));
}

// ---- mpv external ----------------------------------------------------------

#[test]
fn mpv_external_minimal() {
    let src = source("http://h/live.m3u8", "News HD", None);
    assert_eq!(
        mpv_external_args(&src, ""),
        s(&[
            "--title=News HD",
            "--force-media-title=News HD",
            "http://h/live.m3u8"
        ])
    );
}

#[test]
fn mpv_external_with_headers_and_user_args() {
    let src = source(
        "http://h/live.m3u8",
        "Sports 1",
        headers(
            Some("VLC/3.0"),
            Some("http://ref.example/"),
            Some("http://origin.example"),
        ),
    );
    assert_eq!(
        mpv_external_args(&src, r#"--fs --profile="low latency""#),
        s(&[
            "--title=Sports 1",
            "--user-agent=VLC/3.0",
            "--referrer=http://ref.example/",
            "--http-header-fields=Origin:http://origin.example",
            "--force-media-title=Sports 1",
            "--fs",
            "--profile=low latency",
            "http://h/live.m3u8",
        ])
    );
}

#[test]
fn mpv_external_skips_blank_headers_and_title() {
    let src = source("http://h/a.ts", "  ", headers(Some(""), Some("   "), None));
    assert_eq!(mpv_external_args(&src, ""), s(&["http://h/a.ts"]));
}

#[test]
fn mpv_user_agent_with_commas_is_one_argument() {
    // The UA has its own option, so no escaping is needed and it stays one argv element.
    let ua = "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";
    let src = source("http://h/x", "T", headers(Some(ua), None, None));
    let args = mpv_external_args(&src, "");
    assert!(args.contains(&format!("--user-agent={ua}")));
}

#[test]
fn header_fields_escape_commas_and_backslashes() {
    assert_eq!(escape_mpv_list_value(r"a,b\c"), r"a\,b\\c");
    assert_eq!(
        mpv_header_fields(headers(None, None, Some("http://o,x")).as_ref()),
        Some(r"Origin:http://o\,x".to_string())
    );
    assert_eq!(
        mpv_header_fields(headers(Some("ua"), None, None).as_ref()),
        None
    );
    assert_eq!(mpv_header_fields(None), None);
}

#[test]
fn title_with_quotes_stays_single_argument() {
    let src = source("http://h/x", r#"The "Best" Show"#, None);
    let args = mpv_external_args(&src, "");
    assert_eq!(args[0], r#"--title=The "Best" Show"#);
}

// ---- vlc external -----------------------------------------------------------

#[test]
fn vlc_external_args_full() {
    let src = source(
        "http://h/movie.mp4",
        "Movie",
        headers(
            Some("UA/1"),
            Some("http://r/"),
            Some("http://ignored-origin"),
        ),
    );
    assert_eq!(
        vlc_external_args(&src, "--fullscreen --no-video-title-show"),
        s(&[
            "--meta-title=Movie",
            "--http-user-agent=UA/1",
            "--http-referrer=http://r/",
            "--fullscreen",
            "--no-video-title-show",
            "http://h/movie.mp4",
        ])
    );
}

#[test]
fn build_args_uses_settings_strings() {
    let settings = Settings {
        mpv_args: "--fs".into(),
        vlc_args: "--loop".into(),
        ..Settings::default()
    };
    let src = source("u", "t", None);
    assert_eq!(
        build_args(ExternalPlayer::Mpv, &src, &settings)
            .last()
            .unwrap(),
        "u"
    );
    assert!(build_args(ExternalPlayer::Mpv, &src, &settings).contains(&"--fs".to_string()));
    assert!(build_args(ExternalPlayer::Vlc, &src, &settings).contains(&"--loop".to_string()));
    assert!(!build_args(ExternalPlayer::Vlc, &src, &settings).contains(&"--fs".to_string()));
}

#[test]
fn external_player_serde() {
    assert_eq!(
        serde_json::to_value(ExternalPlayer::Vlc).unwrap(),
        json!("vlc")
    );
    let p: ExternalPlayer = serde_json::from_value(json!("mpv")).unwrap();
    assert_eq!(p, ExternalPlayer::Mpv);
}

// ---- embedded ------------------------------------------------------------------

#[test]
fn embedded_args_contain_c4_flags_after_user_args() {
    let pipe = mpv_pipe_name(4242);
    assert_eq!(pipe, r"\\.\pipe\tsrust-iptv-mpv-4242");
    let args = embedded_mpv_args(0x1234, &pipe, "--wid=999 --vo=gpu-next", 80.4);
    assert_eq!(&args[..2], &s(&["--wid=999", "--vo=gpu-next"])[..]);
    for flag in [
        "--wid=4660",
        r"--input-ipc-server=\\.\pipe\tsrust-iptv-mpv-4242",
        "--idle=yes",
        "--keep-open=yes",
        "--no-osc",
        "--no-input-default-bindings",
        "--force-window=yes",
        "--hwdec=auto-safe",
        "--volume=80",
    ] {
        assert!(
            args.contains(&flag.to_string()),
            "missing {flag} in {args:?}"
        );
    }
    // Our --wid comes after the user's, so mpv uses ours.
    let ours = args.iter().position(|a| a == "--wid=4660").unwrap();
    assert!(ours > 0);
}

#[test]
fn loadfile_options_headers_title_and_resume() {
    let mut src = source(
        "http://h/movie.mkv",
        "Film",
        headers(Some("UA, with comma"), Some("http://r/"), Some("http://o")),
    );
    src.is_live = false;
    src.resume_seconds = Some(95);
    let opts = loadfile_options(&src);
    assert_eq!(opts["force-media-title"], json!("Film"));
    assert_eq!(opts["user-agent"], json!("UA, with comma"));
    assert_eq!(opts["referrer"], json!("http://r/"));
    assert_eq!(opts["http-header-fields"], json!("Origin:http://o"));
    assert_eq!(opts["start"], json!("+95"));
}

#[test]
fn loadfile_options_never_seek_live_or_zero() {
    let mut src = source("http://h/live", "Live", None);
    src.resume_seconds = Some(120);
    assert!(!loadfile_options(&src).contains_key("start"));
    src.is_live = false;
    src.resume_seconds = Some(0);
    assert!(!loadfile_options(&src).contains_key("start"));
}

#[test]
fn legacy_options_use_length_quoting() {
    let mut src = source("http://h/x", "A, B", headers(Some("UA, x"), None, None));
    src.is_live = false;
    src.resume_seconds = Some(5);
    let legacy = legacy_options(&loadfile_options(&src));
    assert!(legacy.contains("force-media-title=%4%A, B"), "{legacy}");
    assert!(legacy.contains("user-agent=%5%UA, x"), "{legacy}");
    assert!(legacy.contains("start=%2%+5"), "{legacy}");
}

#[test]
fn raw_commands_are_validated() {
    assert!(validate_command(&[json!("seek"), json!(10), json!("relative")]).is_ok());
    assert!(validate_command(&[json!("set_property"), json!("pause"), json!(true)]).is_ok());
    assert!(validate_command(&[]).is_err());
    assert!(validate_command(&[json!(1)]).is_err());
    assert!(validate_command(&[json!("quit")]).is_err());
    assert!(validate_command(&[json!("run"), json!("calc.exe")]).is_err());
    assert!(validate_command(&[json!("subprocess"), json!("x")]).is_err());
    assert!(validate_command(&[json!("loadfile"), json!({"a": 1})]).is_err());
}
