//! Argument building for external mpv / VLC and the embedded mpv process.

use iptv_core::error::CoreError;
use iptv_core::model::{PlayerKind, PlayerSource, RequestHeaders, Settings};
use iptv_core::player::args::{
    embedded_mpv_args, escape_mpv_list_value, loadfile_options, mpv_external_args,
    mpv_header_fields, mpv_pipe_name, split_shell_args, validate_play_url, vlc_external_args,
};
use iptv_core::player::embedded::{
    is_click_message, legacy_options, recording_file_name, stream_record_command, validate_command,
    validate_property, SETTABLE_PROPERTIES,
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

#[test]
fn embedded_args_keep_the_users_hwdec() {
    let pipe = mpv_pipe_name(1);
    for user in ["--hwdec=d3d11va", "--hwdec=no", "--no-hwdec"] {
        let args = embedded_mpv_args(1, &pipe, user, 50.0, false);
        assert!(args.contains(&user.to_string()), "{args:?}");
        assert!(
            !args.contains(&"--hwdec=auto-safe".to_string()),
            "auto-safe must not override {user}: {args:?}"
        );
    }
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
    for name in ["pause", "volume", "mute", "speed", "aid", "sid"] {
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
