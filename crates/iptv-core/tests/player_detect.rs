//! Player detection against temp-dir layouts.

use iptv_core::model::Settings;
use iptv_core::player::detect::{detect_with, exe_name, find_mpv, find_vlc, DetectEnv};
use std::fs;
use std::path::{Path, PathBuf};

fn touch(p: &Path) -> PathBuf {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, b"").unwrap();
    p.to_path_buf()
}

fn empty_env() -> DetectEnv {
    DetectEnv::default()
}

#[test]
fn nothing_found_in_empty_env() {
    let found = detect_with(&Settings::default(), &empty_env());
    assert_eq!(found.mpv_path, None);
    assert_eq!(found.vlc_path, None);
}

#[test]
fn configured_paths_win_and_accept_directories() {
    let dir = tempfile::tempdir().unwrap();
    let mpv = touch(&dir.path().join("custom").join(exe_name("mpv")));
    let vlc_dir = dir.path().join("vlcdir");
    let vlc = touch(&vlc_dir.join(exe_name("vlc")));
    // Also present on PATH: the configured one must still win.
    let path_dir = dir.path().join("bin");
    touch(&path_dir.join(exe_name("mpv")));

    let settings = Settings {
        mpv_path: Some(format!("\"{}\"", mpv.display())), // quoted paths are tolerated
        vlc_path: Some(vlc_dir.display().to_string()),
        ..Settings::default()
    };
    let env = DetectEnv {
        path_dirs: vec![path_dir],
        ..empty_env()
    };
    let found = detect_with(&settings, &env);
    assert_eq!(found.mpv_path.as_deref(), Some(mpv.to_str().unwrap()));
    assert_eq!(found.vlc_path.as_deref(), Some(vlc.to_str().unwrap()));
}

#[test]
fn missing_configured_path_falls_back_to_search() {
    let dir = tempfile::tempdir().unwrap();
    let path_dir = dir.path().join("bin");
    let mpv = touch(&path_dir.join(exe_name("mpv")));
    let env = DetectEnv {
        path_dirs: vec![path_dir],
        ..empty_env()
    };
    let missing = dir.path().join("gone").join(exe_name("mpv"));
    assert_eq!(
        find_mpv(Some(missing.to_str().unwrap()), &env),
        Some(mpv.clone())
    );
    assert_eq!(find_mpv(Some("   "), &env), Some(mpv));
}

#[test]
fn vendor_beside_exe_beats_cwd_and_path() {
    let dir = tempfile::tempdir().unwrap();
    let exe_dir = dir.path().join("app");
    let cwd = dir.path().join("work");
    let beside = touch(&exe_dir.join("vendor").join("mpv").join(exe_name("mpv")));
    touch(&cwd.join("vendor").join("mpv").join(exe_name("mpv")));
    let path_dir = dir.path().join("bin");
    touch(&path_dir.join(exe_name("mpv")));
    let env = DetectEnv {
        exe_dir: Some(exe_dir),
        cwd: Some(cwd),
        path_dirs: vec![path_dir],
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(beside));
}

#[test]
fn vendor_under_cwd_and_ancestors() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    let vendored = touch(&repo.join("vendor").join("mpv").join(exe_name("mpv")));
    let exe_dir = repo.join("target").join("debug");
    fs::create_dir_all(&exe_dir).unwrap();

    // Found under cwd directly.
    let env = DetectEnv {
        cwd: Some(repo.clone()),
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(vendored.clone()));

    // From target/debug only when ancestor search is on.
    let env = DetectEnv {
        exe_dir: Some(exe_dir.clone()),
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), None);
    let env = DetectEnv {
        exe_dir: Some(exe_dir),
        search_ancestors: true,
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(vendored));
}

#[test]
fn path_lookup_in_order_skipping_empty_entries() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    fs::create_dir_all(&a).unwrap();
    let in_b = touch(&b.join(exe_name("vlc")));
    let env = DetectEnv {
        path_dirs: vec![PathBuf::new(), a, b],
        ..empty_env()
    };
    assert_eq!(find_vlc(None, &env), Some(in_b));
}

#[test]
fn program_files_videolan() {
    let dir = tempfile::tempdir().unwrap();
    let pf86 = dir.path().join("Program Files (x86)");
    let vlc = touch(&pf86.join("VideoLAN").join("VLC").join(exe_name("vlc")));
    let env = DetectEnv {
        program_files: vec![dir.path().join("Program Files"), pf86],
        ..empty_env()
    };
    assert_eq!(find_vlc(None, &env), Some(vlc));
}

#[test]
fn scoop_apps_and_shims() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let shim = touch(&home.join("scoop").join("shims").join(exe_name("vlc")));
    let app = touch(
        &home
            .join("scoop")
            .join("apps")
            .join("mpv")
            .join("current")
            .join(exe_name("mpv")),
    );
    let env = DetectEnv {
        home: Some(home),
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(app));
    assert_eq!(find_vlc(None, &env), Some(shim));

    // Custom $SCOOP root.
    let root = dir.path().join("scoop-root");
    let custom = touch(&root.join("shims").join(exe_name("mpv")));
    let env = DetectEnv {
        scoop_root: Some(root),
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(custom));
}

#[test]
fn chocolatey_bin() {
    let dir = tempfile::tempdir().unwrap();
    let pd = dir.path().join("ProgramData");
    let mpv = touch(&pd.join("chocolatey").join("bin").join(exe_name("mpv")));
    let env = DetectEnv {
        program_data: Some(pd),
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(mpv));
}

#[test]
fn winget_links_and_packages() {
    let dir = tempfile::tempdir().unwrap();
    let lad = dir.path().join("LocalAppData");
    let pkg = touch(
        &lad.join("Microsoft")
            .join("WinGet")
            .join("Packages")
            .join("mpv-player.mpv-CI.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join(exe_name("mpv")),
    );
    let env = DetectEnv {
        local_app_data: Some(lad.clone()),
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(pkg));
    let link = touch(
        &lad.join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join(exe_name("mpv")),
    );
    assert_eq!(
        find_mpv(None, &env),
        Some(link),
        "Links is preferred over Packages"
    );
}

#[test]
fn unix_bin_dirs_and_app_bundles() {
    let dir = tempfile::tempdir().unwrap();
    let brew = dir.path().join("opt").join("homebrew").join("bin");
    let mpv = touch(&brew.join(exe_name("mpv")));
    let apps = dir.path().join("Applications");
    let vlc = touch(
        &apps
            .join("VLC.app")
            .join("Contents")
            .join("MacOS")
            .join("VLC"),
    );
    let env = DetectEnv {
        extra_dirs: vec![dir.path().join("usr").join("bin"), brew],
        app_bundle_dirs: vec![apps],
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), Some(mpv));
    assert_eq!(find_vlc(None, &env), Some(vlc));
}

#[test]
fn directories_named_like_the_exe_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fs::create_dir_all(bin.join(exe_name("mpv"))).unwrap();
    let env = DetectEnv {
        path_dirs: vec![bin],
        ..empty_env()
    };
    assert_eq!(find_mpv(None, &env), None);
}

#[test]
fn current_env_does_not_panic() {
    let env = DetectEnv::current();
    assert!(env.search_ancestors);
    let _ = detect_with(&Settings::default(), &env);
    let _ = iptv_core::player::detect(&Settings::default());
}
