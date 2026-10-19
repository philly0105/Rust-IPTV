//! Argument building for external mpv / VLC and the embedded mpv process.

use iptv_core::error::CoreError;
use iptv_core::model::{PlayerKind, PlayerSource, RequestHeaders, Settings};
use iptv_core::player::args::{
    embedded_mpv_args, escape_mpv_list_value, loadfile_options, mpv_external_args,
    mpv_header_fields, mpv_pipe_name, split_shell_args, validate_play_url, vlc_external_args,
};
use iptv_core::player::embedded::{
    is_click_message, legacy_options, recording_file_name, stream_record_command, validate_command,
    validate_property, validate_property_value, validate_subtitle_path, MAX_SUBTITLE_BYTES,
    SETTABLE_PROPERTIES, SUBTITLE_EXTENSIONS,
};
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
            "--",
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
            "--",
            "http://h/live.m3u8",
        ])
    );
}

#[test]
fn mpv_external_skips_blank_headers_and_title() {
    let src = source("http://h/a.ts", "  ", headers(Some(""), Some("   "), None));
    assert_eq!(mpv_external_args(&src, ""), s(&["--", "http://h/a.ts"]));
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
        vlc_external_args(&src, "--fullscreen --no-video-title-show", false),
        s(&[
            "--meta-title=Movie",
            "--http-user-agent=UA/1",
            "--http-referrer=http://r/",
            "--fullscreen",
            "--no-video-title-show",
            "--",
            "http://h/movie.mp4",
        ])
    );
}

#[test]
fn vlc_reuse_instance_flags() {
    let src = source("http://h/a.ts", "", None);
    assert_eq!(
        vlc_external_args(&src, "", true),
        s(&[
            "--one-instance",
            "--playlist-enqueue",
            "--",
            "http://h/a.ts"
        ])
    );
    let settings = Settings::default();
    assert!(settings.player_reuse_instance, "reuse is on by default");
    assert!(build_args(ExternalPlayer::Vlc, &src, &settings).contains(&"--one-instance".into()));
    let off = Settings {
        player_reuse_instance: false,
        ..Settings::default()
    };
    assert!(!build_args(ExternalPlayer::Vlc, &src, &off).contains(&"--one-instance".into()));
    assert!(!build_args(ExternalPlayer::Mpv, &src, &settings).contains(&"--one-instance".into()));
}

// ---- option injection (R4 F1) ----------------------------------------------

#[test]
fn url_that_looks_like_an_option_stays_a_url() {
    // A hostile M3U line: without the separator mpv treats it as an option
    // (and writes a log file wherever the playlist says).
    for url in [r"--log-file=C:\x", "--script=//host/share/pwn.lua"] {
        let src = source(url, "Evil", None);
        let mpv = mpv_external_args(&src, "--fs");
        let sep = mpv.iter().position(|a| a == "--").expect("mpv separator");
        assert_eq!(&mpv[sep + 1..], &[url.to_string()][..], "{mpv:?}");
        assert!(mpv[..sep].iter().all(|a| a != url));
        let vlc = vlc_external_args(&src, "", true);
        let sep = vlc.iter().position(|a| a == "--").expect("vlc separator");
        assert_eq!(&vlc[sep + 1..], &[url.to_string()][..], "{vlc:?}");
        // And the scheme allowlist refuses it before any player starts.
        assert!(matches!(
            validate_play_url(&src),
            Err(CoreError::Invalid(_))
        ));
    }
}

#[test]
fn play_url_scheme_allowlist() {
    for ok in [
        "http://h/a.m3u8",
        "HTTPS://h/a",
        "rtmp://h/live",
        "rtmps://h/live",
        "rtsp://cam/1",
        "udp://@239.0.0.1:1234",
        "rtp://239.0.0.1:5000",
        "mms://h/x",
        "file:///C:/v/a.mkv",
    ] {
        assert!(validate_play_url(&source(ok, "t", None)).is_ok(), "{ok}");
    }
    for bad in [
        "",
        "   ",
        "-v",
        "--script=x.lua",
        "av://lavfi:testsrc",
        "edl://a;b",
        "memory://x",
        "lavf://x",
        "ytdl://x",
        "javascript:alert(1)",
        "relative/path.ts",
        r"C:\Videos\a.mkv",
        "http://h/a\nb",
    ] {
        assert!(
            matches!(
                validate_play_url(&source(bad, "t", None)),
                Err(CoreError::Invalid(_))
            ),
            "{bad:?} should be refused"
        );
    }
    // Local absolute paths are fine for downloaded files only.
    let mut file = source(r"C:\Videos\clip, test.mkv", "t", None);
    file.kind = PlayerKind::File;
    assert!(validate_play_url(&file).is_ok());
    file.url = r"\\nas\share\a.mkv".into();
    assert!(validate_play_url(&file).is_ok());
    file.url = "relative.mkv".into();
    assert!(validate_play_url(&file).is_err());
    file.url = "--log-file=C:/x".into();
    assert!(validate_play_url(&file).is_err());
}

#[test]
fn build_args_uses_settings_strings() {
    let settings = Settings {
        mpv_args: "--fs".into(),
        vlc_args: "--loop".into(),
        ..Settings::default()
    };
    let src = source("u", "t", None);
    let mpv = build_args(ExternalPlayer::Mpv, &src, &settings);
    assert_eq!(&mpv[mpv.len() - 2..], &s(&["--", "u"])[..]);
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
    let args = embedded_mpv_args(0x1234, &pipe, "--wid=999 --vo=gpu-next", 80.4, true);
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
        "--mute=yes",
    ] {
        assert!(
            args.contains(&flag.to_string()),
            "missing {flag} in {args:?}"
        );
    }
    // Our --wid comes after the user's, so mpv uses ours.
    let ours = args.iter().position(|a| a == "--wid=4660").unwrap();
    assert!(ours > 0);
    let unmuted = embedded_mpv_args(1, &pipe, "", 35.0, false);
    assert!(unmuted.contains(&"--volume=35".to_string()));
    assert!(unmuted.contains(&"--mute=no".to_string()));
}

// ---- recording -----------------------------------------------------------------

#[test]
fn stream_record_ipc_framing() {
    use iptv_core::player::ipc::encode_command;
    let path = std::path::Path::new(r"C:\Rec\News HD-20261011-0230.ts");
    let start = stream_record_command(Some(path));
    assert_eq!(
        start,
        vec![
            json!("set_property"),
            json!("stream-record"),
            json!(r"C:\Rec\News HD-20261011-0230.ts")
        ]
    );
    let line = encode_command(7, &start);
    assert_eq!(*line.last().unwrap(), b'\n');
    assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1);
    let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(
        v,
        json!({"command": ["set_property", "stream-record", r"C:\Rec\News HD-20261011-0230.ts"], "request_id": 7})
    );
    // Stopping clears the property with an empty string.
    assert_eq!(
        stream_record_command(None),
        vec![json!("set_property"), json!("stream-record"), json!("")]
    );
}

#[test]
fn recording_file_names() {
    use chrono::TimeZone;
    let at = chrono::Utc
        .with_ymd_and_hms(2026, 10, 11, 2, 30, 59)
        .unwrap();
    assert_eq!(
        recording_file_name("News HD", at),
        "News HD-20261011-0230.ts"
    );
    assert_eq!(
        recording_file_name(r#"A/B: "C" <D>|E?*\F"#, at),
        "A_B_ _C_ _D__E___F-20261011-0230.ts"
    );
    assert_eq!(
        recording_file_name("  ...  ", at),
        "recording-20261011-0230.ts"
    );
    assert_eq!(recording_file_name("", at), "recording-20261011-0230.ts");
    let long = "x".repeat(300);
    assert_eq!(
        recording_file_name(&long, at).len(),
        80 + "-20261011-0230.ts".len()
    );
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
    // Live gets the timeshift cache instead.
    let live = loadfile_options(&src);
    assert_eq!(live["force-seekable"], json!("yes"));
    assert_eq!(live["demuxer-max-back-bytes"], json!("1GiB"));
    src.is_live = false;
    assert!(!loadfile_options(&src).contains_key("force-seekable"));
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

#[test]
fn only_ui_properties_can_be_set() {
    // Everything the player UI sends through mpv.setProperty.
    for name in [
        "pause",
        "volume",
        "mute",
        "speed",
        "aid",
        "sid",
        "sub-scale",
        "sub-color",
        "sub-back-color",
        "sub-border-style",
        "sub-border-size",
        "sub-shadow-offset",
        "sub-pos",
        "sub-ass-override",
        "video-aspect-override",
        "keepaspect",
        "panscan",
        "video-zoom",
        "deinterlace",
    ] {
        assert!(validate_property(name).is_ok(), "{name}");
        assert!(SETTABLE_PROPERTIES.contains(&name));
    }
    assert!(validate_property(" volume ").is_ok());
    // Path-writing and arbitrary properties are refused as Invalid.
    for name in [
        "stream-record",
        "dump-cache",
        "screenshot-directory",
        "log-file",
        "input-ipc-server",
        "scripts",
        "",
        "  ",
    ] {
        let err = validate_property(name).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{name}: {err:?}");
    }
}

#[test]
fn property_commands_cannot_bypass_the_allowlist() {
    for cmd in [
        vec![
            json!("set_property"),
            json!("stream-record"),
            json!("C:/x.ts"),
        ],
        vec![json!("set"), json!("stream-record"), json!("C:/x.ts")],
        vec![
            json!("set_property_string"),
            json!("dump-cache"),
            json!("x"),
        ],
        vec![
            json!("cycle-values"),
            json!("!reverse"),
            json!("stream-record"),
            json!("a"),
            json!("b"),
        ],
        vec![
            json!("change-list"),
            json!("scripts"),
            json!("append"),
            json!("C:/evil.lua"),
        ],
        vec![json!("add"), json!("stream-record")],
        vec![json!("set_property")],
        vec![json!("dump-cache"), json!(0), json!("no"), json!("C:/x.ts")],
        vec![json!("screenshot-to-file"), json!("C:/x.png")],
    ] {
        let err = validate_command(&cmd).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{cmd:?}: {err:?}");
    }
    assert!(validate_command(&[json!("add"), json!("volume"), json!(5)]).is_ok());
    assert!(validate_command(&[json!("cycle"), json!("mute")]).is_ok());
    assert!(validate_command(&[
        json!("cycle-values"),
        json!("!reverse"),
        json!("speed"),
        json!(1),
        json!(2)
    ])
    .is_ok());
}

#[test]
fn raw_commands_are_an_allowlist() {
    // Round-3 bypasses: an mpv prefix as the first element, or keybind.
    for cmd in [
        vec![
            json!("no-osd"),
            json!("set"),
            json!("stream-record"),
            json!("C:/p3.ts"),
        ],
        vec![
            json!("async"),
            json!("dump-cache"),
            json!(0),
            json!("no"),
            json!("C:/p5.ts"),
        ],
        vec![
            json!("no-osd"),
            json!("run"),
            json!("cmd.exe"),
            json!("/c"),
            json!("copy NUL C:/p6.txt"),
        ],
        vec![
            json!("keybind"),
            json!("F24"),
            json!("set stream-record C:/p7.ts"),
        ],
        vec![json!("keypress"), json!("F24")],
        vec![
            json!("no-osd"),
            json!("screenshot-to-file"),
            json!("C:/p8.png"),
            json!("video"),
        ],
        // Every other prefix, even in front of an allowed command.
        vec![json!("osd-msg"), json!("seek"), json!(1)],
        vec![json!("osd-auto"), json!("seek"), json!(1)],
        vec![json!("raw"), json!("seek"), json!(1)],
        vec![json!("expand-properties"), json!("seek"), json!(1)],
        vec![json!("sync"), json!("seek"), json!(1)],
        vec![json!("repeatable"), json!("seek"), json!(1)],
        vec![json!("nonrepeatable"), json!("seek"), json!(1)],
        vec![json!("nonscalable"), json!("seek"), json!(1)],
        // Anything else outside the allowlist.
        vec![json!("loadfile"), json!("C:/x.mkv")],
        vec![json!("script-message"), json!("x")],
        vec![json!("script-binding"), json!("x")],
        vec![json!("load-script"), json!("C:/evil.lua")],
        vec![json!("quit-watch-later")],
        vec![json!("write-watch-later-config")],
        vec![json!("SEEK"), json!(1)],
        vec![
            json!("change-list"),
            json!("volume"),
            json!("set"),
            json!(1),
        ],
    ] {
        let err = validate_command(&cmd).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{cmd:?}: {err:?}");
    }
    // What the UI and tests send.
    assert!(validate_command(&[json!("seek"), json!(42.5), json!("absolute")]).is_ok());
    assert!(validate_command(&[json!("get_property"), json!("time-pos")]).is_ok());
    assert!(validate_command(&[json!("multiply"), json!("speed"), json!(2)]).is_ok());
}

#[test]
fn only_our_script_message_counts_as_a_video_click() {
    assert!(is_click_message(
        &json!({"event": "client-message", "args": ["tsrust-click"]})
    ));
    assert!(!is_click_message(
        &json!({"event": "client-message", "args": ["other"]})
    ));
    assert!(!is_click_message(
        &json!({"event": "client-message", "args": []})
    ));
    assert!(!is_click_message(
        &json!({"event": "property-change", "name": "pause"})
    ));
}

// ---- subtitles (Run 2 C6) ---------------------------------------------------

#[test]
fn subtitle_style_values_in_range_are_accepted() {
    for (name, value) in [
        ("sub-scale", json!(0.5)),
        ("sub-scale", json!(3.0)),
        ("sub-scale", json!(1)),
        ("sub-scale", json!("1.25")),
        ("sub-color", json!("#FFFFFF")),
        ("sub-color", json!("#ffe600")),
        ("sub-color", json!("#80000000")),
        ("sub-back-color", json!("#80000000")),
        ("sub-back-color", json!("#aaBBcc")),
        ("sub-border-style", json!("outline-and-shadow")),
        ("sub-border-style", json!("opaque-box")),
        ("sub-border-style", json!("background-box")),
        ("sub-border-size", json!(0)),
        ("sub-border-size", json!(10)),
        ("sub-border-size", json!(2.5)),
        ("sub-shadow-offset", json!(0)),
        ("sub-shadow-offset", json!(10.0)),
        ("sub-shadow-offset", json!("3")),
        ("sub-pos", json!(0)),
        ("sub-pos", json!(150)),
        ("sub-pos", json!(80.0)),
        ("sub-pos", json!("100")),
        ("sub-ass-override", json!("no")),
        ("sub-ass-override", json!("yes")),
        ("sub-ass-override", json!("scale")),
        ("sub-ass-override", json!("force")),
        ("sub-ass-override", json!("strip")),
        (" sub-scale ", json!(2)),
    ] {
        assert!(
            validate_property_value(name, &value).is_ok(),
            "{name} = {value}"
        );
    }
    // The older properties keep their unchecked values (mpv checks them).
    for (name, value) in [
        ("volume", json!(250)),
        ("pause", json!(true)),
        ("sub-delay", json!("-1.5")),
        ("sid", json!("no")),
        ("time-pos", json!(null)),
    ] {
        assert!(
            validate_property_value(name, &value).is_ok(),
            "{name} = {value}"
        );
    }
}

#[test]
fn subtitle_style_values_out_of_range_are_invalid() {
    for (name, value) in [
        ("sub-scale", json!(4)),
        ("sub-scale", json!(0.1)),
        ("sub-scale", json!(3.0001)),
        ("sub-scale", json!("big")),
        ("sub-scale", json!("NaN")),
        ("sub-scale", json!("inf")),
        ("sub-scale", json!(" 1.5")),
        ("sub-scale", json!(true)),
        ("sub-scale", json!(null)),
        ("sub-scale", json!([1])),
        ("sub-scale", json!({"v": 1})),
        (" sub-scale ", json!(4)),
        ("sub-color", json!("red")),
        ("sub-color", json!("#12345")),
        ("sub-color", json!("#1234567")),
        ("sub-color", json!("FFFFFF")),
        ("sub-color", json!("#GGGGGG")),
        ("sub-color", json!("#FFFFFF ")),
        ("sub-color", json!("")),
        ("sub-color", json!(16777215)),
        ("sub-back-color", json!("#123456789")),
        ("sub-back-color", json!("1.0/0.5/0.0")),
        ("sub-border-style", json!("box")),
        ("sub-border-style", json!("Opaque-Box")),
        ("sub-border-style", json!(1)),
        ("sub-border-size", json!(11)),
        ("sub-border-size", json!(-0.5)),
        ("sub-border-size", json!("x")),
        ("sub-shadow-offset", json!(-1)),
        ("sub-shadow-offset", json!(10.5)),
        ("sub-pos", json!(151)),
        ("sub-pos", json!(-1)),
        ("sub-pos", json!(10.5)),
        ("sub-pos", json!("10.5")),
        ("sub-pos", json!(false)),
        ("sub-ass-override", json!(true)),
        ("sub-ass-override", json!(false)),
        ("sub-ass-override", json!("YES")),
        ("sub-ass-override", json!("maybe")),
        ("sub-ass-override", json!(1)),
    ] {
        let err = validate_property_value(name, &value).unwrap_err();
        assert!(
            matches!(err, CoreError::Invalid(ref m) if m.contains(name.trim()) && m.contains("must be")),
            "{name} = {value}: {err:?}"
        );
    }
}

#[test]
fn subtitle_style_commands_set_checked_values_only() {
    for set in ["set", "set_property", "set_property_string"] {
        for (name, value) in [
            ("sub-scale", json!("1.5")),
            ("sub-color", json!("#FFE600")),
            ("sub-back-color", json!("#80000000")),
            ("sub-border-style", json!("opaque-box")),
            ("sub-border-size", json!("2")),
            ("sub-shadow-offset", json!(1)),
            ("sub-pos", json!(90)),
            ("sub-ass-override", json!("force")),
        ] {
            assert!(
                validate_command(&[json!(set), json!(name), value.clone()]).is_ok(),
                "{set} {name} {value}"
            );
        }
        for cmd in [
            vec![json!(set), json!("sub-scale"), json!(4)],
            vec![json!(set), json!("sub-color"), json!("red")],
            vec![json!(set), json!("sub-pos"), json!(10.5)],
            vec![json!(set), json!("sub-border-style"), json!("box")],
            vec![json!(set), json!("sub-ass-override"), json!(true)],
            // The value is required, and only one.
            vec![json!(set), json!("sub-scale")],
            vec![json!(set), json!("sub-scale"), json!(1), json!(2)],
            // A leading flag does not move the checked value.
            vec![json!(set), json!("!reverse"), json!("sub-scale"), json!(9)],
        ] {
            let err = validate_command(&cmd).unwrap_err();
            assert!(matches!(err, CoreError::Invalid(_)), "{cmd:?}: {err:?}");
        }
    }
    // Relative changes would step past the allowed range.
    for cmd in [
        vec![json!("add"), json!("sub-scale"), json!(0.1)],
        vec![json!("add"), json!("sub-pos"), json!(1000)],
        vec![json!("multiply"), json!("sub-scale"), json!(10)],
        vec![json!("multiply"), json!("sub-border-size"), json!(2)],
        vec![json!("cycle"), json!("sub-ass-override")],
        vec![json!("cycle"), json!("sub-border-style")],
        vec![
            json!("cycle-values"),
            json!("sub-border-style"),
            json!("opaque-box"),
            json!("box"),
        ],
        vec![
            json!("cycle-values"),
            json!("!reverse"),
            json!("sub-pos"),
            json!(1),
            json!(500),
        ],
    ] {
        let err = validate_command(&cmd).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{cmd:?}: {err:?}");
    }
    // The older subtitle properties keep their relative commands.
    assert!(validate_command(&[json!("add"), json!("sub-delay"), json!(0.1)]).is_ok());
    assert!(validate_command(&[json!("cycle"), json!("sub-visibility")]).is_ok());
    assert!(validate_command(&[json!("cycle"), json!("sid")]).is_ok());
}

#[test]
fn sub_add_only_runs_through_add_subtitle() {
    for cmd in [
        vec![json!("sub-add"), json!("C:/x.srt")],
        vec![json!("sub-add"), json!("C:/x.srt"), json!("select")],
        vec![json!("no-osd"), json!("sub-add"), json!("C:/x.srt")],
        vec![json!("screenshot-to-file"), json!("C:/x.png")],
    ] {
        let err = validate_command(&cmd).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{cmd:?}: {err:?}");
    }
}

fn subtitle_error(path: &str) -> String {
    match validate_subtitle_path(path) {
        Err(CoreError::Invalid(m)) => m,
        other => panic!("{path:?} should be Invalid, got {other:?}"),
    }
}

#[test]
fn subtitle_paths_are_checked() {
    assert_eq!(SUBTITLE_EXTENSIONS, ["srt", "vtt", "ass", "ssa"]);
    assert_eq!(MAX_SUBTITLE_BYTES, 5 * 1024 * 1024);
    let dir = tempfile::tempdir().unwrap();
    let p = |name: &str| dir.path().join(name).display().to_string();

    // Empty and relative paths (URLs and mpv protocols are not absolute).
    for empty in ["", "   "] {
        assert!(subtitle_error(empty).contains("Choose"), "{empty:?}");
    }
    for relative in [
        "x.srt",
        "subs/x.srt",
        r"subs\x.srt",
        "C:x.srt",
        "http://h/x.srt",
        "memory://x.srt",
    ] {
        assert!(
            subtitle_error(relative).contains("full path"),
            "{relative:?}"
        );
    }

    // The extension is checked before the file is opened.
    for name in ["x.txt", "x.srt.exe", "x", "x.srt.", "x.sub", "srt"] {
        std::fs::write(dir.path().join(name), b"1").unwrap();
        assert!(subtitle_error(&p(name)).contains(".srt, .vtt"), "{name}");
    }
    assert!(subtitle_error(&p("never-made.idx")).contains(".srt, .vtt"));

    // Missing files, folders, and oversized files.
    assert!(subtitle_error(&p("missing.srt")).contains("not found"));
    std::fs::create_dir(dir.path().join("folder.srt")).unwrap();
    assert!(subtitle_error(&p("folder.srt")).contains("folder"));
    let big = std::fs::File::create(dir.path().join("big.srt")).unwrap();
    big.set_len(MAX_SUBTITLE_BYTES + 1).unwrap();
    drop(big);
    assert!(subtitle_error(&p("big.srt")).contains("5 MB"));

    // Accepted: every extension in any case, up to exactly 5 MB.
    let edge = std::fs::File::create(dir.path().join("edge.srt")).unwrap();
    edge.set_len(MAX_SUBTITLE_BYTES).unwrap();
    drop(edge);
    let names = [
        "ok.srt",
        "UPPER.SRT",
        "styled.ass",
        "web.vtt",
        "old.ssa",
        "Mixed.Vtt",
        "Movie, part 1.en.srt",
    ];
    for name in names {
        std::fs::write(
            dir.path().join(name),
            b"1\n00:00:00,000 --> 00:00:01,000\nHi\n",
        )
        .unwrap();
    }
    for name in names.into_iter().chain(["edge.srt"]) {
        let got = validate_subtitle_path(&p(name)).unwrap();
        assert_eq!(got, dir.path().join(name), "{name}");
    }
    // Surrounding whitespace is trimmed.
    let padded = format!("  {}\t", p("ok.srt"));
    assert_eq!(
        validate_subtitle_path(&padded).unwrap(),
        dir.path().join("ok.srt")
    );
}

/// L3-desktop: `osd-overlay` (the dim the UI draws under a dialog's backdrop
/// on the embedded mpv) takes one short line of ASS or `none`, an id mpv
/// accepts and at most three small integer sizes; anything else is Invalid.
#[test]
fn osd_overlay_is_limited_to_one_short_ass_line() {
    let osd = |args: &[serde_json::Value]| {
        let mut cmd = vec![json!("osd-overlay")];
        cmd.extend_from_slice(args);
        validate_command(&cmd)
    };
    let dim =
        r"{\an7\pos(0,0)\1c&H100804&\1a&H47&\p1}m -10 -10 l 10000 -10 10000 10000 -10 10000{\p0}";
    for ok in [
        vec![
            json!(63),
            json!("ass-events"),
            json!(dim),
            json!(0),
            json!(720),
            json!(0),
        ],
        vec![json!(0), json!("ass-events"), json!(dim)],
        vec![json!(1), json!("ass-events"), json!("x".repeat(512))],
        vec![json!(63), json!("none"), json!("")],
    ] {
        assert!(osd(&ok).is_ok(), "{ok:?}");
    }
    for bad in [
        // Ids past mpv's 0-63, or not an integer.
        vec![json!(64), json!("none"), json!("")],
        vec![json!(-1), json!("none"), json!("")],
        vec![json!("1"), json!("none"), json!("")],
        // Formats that read bitmaps from a file or memory.
        vec![json!(1), json!("bgra"), json!("")],
        // A second event, or more than one drawing's worth of text.
        vec![json!(1), json!("ass-events"), json!("a\nb")],
        vec![json!(1), json!("ass-events"), json!("a\rb")],
        vec![json!(1), json!("ass-events"), json!("x".repeat(513))],
        vec![json!(1), json!("ass-events"), json!(5)],
        // More than three sizes, or sizes that are not small integers.
        vec![
            json!(1),
            json!("ass-events"),
            json!("x"),
            json!(0),
            json!(720),
            json!(0),
            json!(0),
        ],
        vec![json!(1), json!("ass-events"), json!("x"), json!(16385)],
        vec![json!(1), json!("ass-events"), json!("x"), json!(-1)],
        vec![json!(1), json!("ass-events"), json!("x"), json!("720")],
        vec![json!(1), json!("ass-events"), json!("x"), json!(1.5)],
        // Too few arguments.
        vec![json!(1), json!("none")],
        vec![],
    ] {
        let err = osd(&bad).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad:?}: {err:?}");
    }
}
