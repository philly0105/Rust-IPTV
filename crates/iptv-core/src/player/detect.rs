//! Player detection.
//!
//! Search order (first existing file wins, per player):
//!
//! 1. The configured path (`settings.mpvPath` / `settings.vlcPath`). A
//!    directory is accepted and searched for the executable.
//! 2. mpv only: `vendor/mpv/mpv.exe` beside the running exe, then under the
//!    working directory, then under the ancestors of both (so `pnpm tauri dev`,
//!    whose exe lives in `target/debug`, finds the repo's `vendor/`).
//! 3. Every directory on `PATH` (`where`-style).
//! 4. Well-known install locations: Program Files (VideoLAN, mpv), scoop
//!    (`~/scoop/apps/<name>/current`, `~/scoop/shims`, `$SCOOP`), choco
//!    (`C:\ProgramData\chocolatey\bin`), WinGet
//!    (`%LOCALAPPDATA%\Microsoft\WinGet\Links` and
//!    `...\WinGet\Packages\<id containing the name>\`); on other OSes `/usr/bin`,
//!    `/usr/local/bin`, `/opt/homebrew/bin`, `/snap/bin`, and
//!    `/Applications/*.app/Contents/MacOS`.
//!
//! [`DetectEnv`] carries every environment input so tests can point the
//! search at temp dirs.

use super::DetectedPlayers;
use crate::model::Settings;
use std::path::{Path, PathBuf};

/// How many parent directories of the exe dir and cwd are searched for
/// `vendor/mpv/mpv.exe`.
const VENDOR_ANCESTOR_DEPTH: usize = 4;

/// Inputs to detection. [`DetectEnv::current`] reads the real process
/// environment; tests build one by hand.
#[derive(Debug, Clone, Default)]
pub struct DetectEnv {
    /// Directory of the running executable.
    pub exe_dir: Option<PathBuf>,
    /// Working directory.
    pub cwd: Option<PathBuf>,
    /// `PATH` entries, in order.
    pub path_dirs: Vec<PathBuf>,
    /// User home (scoop lives at `~/scoop`).
    pub home: Option<PathBuf>,
    /// `$SCOOP` when set (custom scoop root).
    pub scoop_root: Option<PathBuf>,
    /// `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`.
    pub program_files: Vec<PathBuf>,
    /// `%ProgramData%` (choco lives at `ProgramData\chocolatey`).
    pub program_data: Option<PathBuf>,
    /// `%LOCALAPPDATA%` (WinGet portable installs live under
    /// `Microsoft\WinGet`).
    pub local_app_data: Option<PathBuf>,
    /// Extra fixed directories searched last (Unix bin dirs).
    pub extra_dirs: Vec<PathBuf>,
    /// Application bundle roots searched for `<App>.app/Contents/MacOS/<bin>`.
    pub app_bundle_dirs: Vec<PathBuf>,
    /// Whether to search for vendored mpv in ancestors of exe dir and cwd.
    pub search_ancestors: bool,
}

impl DetectEnv {
    /// The real environment of this process.
    pub fn current() -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let cwd = std::env::current_dir().ok();
        let path_dirs = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        let env_path = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };

        let mut program_files = Vec::new();
        let mut program_data = None;
        let mut local_app_data = None;
        let mut extra_dirs = Vec::new();
        let mut app_bundle_dirs = Vec::new();
        if cfg!(windows) {
            for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
                if let Some(p) = env_path(key) {
                    push_unique(&mut program_files, p);
                }
            }
            for p in [r"C:\Program Files", r"C:\Program Files (x86)"] {
                push_unique(&mut program_files, PathBuf::from(p));
            }
            program_data =
                env_path("ProgramData").or_else(|| Some(PathBuf::from(r"C:\ProgramData")));
            local_app_data = env_path("LOCALAPPDATA");
        } else {
            for p in [
                "/usr/bin",
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "/opt/local/bin",
                "/snap/bin",
            ] {
                extra_dirs.push(PathBuf::from(p));
            }
            app_bundle_dirs.push(PathBuf::from("/Applications"));
            if let Some(home) = dirs::home_dir() {
                app_bundle_dirs.push(home.join("Applications"));
            }
        }

        Self {
            exe_dir,
            cwd,
            path_dirs,
            home: dirs::home_dir(),
            scoop_root: env_path("SCOOP"),
            program_files,
            program_data,
            local_app_data,
            extra_dirs,
            app_bundle_dirs,
            search_ancestors: true,
        }
    }
}

fn push_unique(v: &mut Vec<PathBuf>, p: PathBuf) {
    if !v.iter().any(|q| q == &p) {
        v.push(p);
    }
}

/// Platform executable file name: `mpv.exe` on Windows, `mpv` elsewhere.
pub fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Detects both players in `env`.
pub fn detect_with(settings: &Settings, env: &DetectEnv) -> DetectedPlayers {
    DetectedPlayers {
        mpv_path: find_mpv(settings.mpv_path.as_deref(), env).map(path_string),
        vlc_path: find_vlc(settings.vlc_path.as_deref(), env).map(path_string),
    }
}

fn path_string(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Finds mpv. See the module docs for the order.
pub fn find_mpv(configured: Option<&str>, env: &DetectEnv) -> Option<PathBuf> {
    let exe = exe_name("mpv");
    if let Some(p) = configured_path(configured, &exe) {
        return Some(p);
    }
    let found = vendored_mpv_candidates(env)
        .into_iter()
        .chain(path_candidates(env, &exe))
        .chain(well_known_candidates(env, Player::Mpv))
        .find(|p| p.is_file());
    found
}

/// Finds VLC. See the module docs for the order.
pub fn find_vlc(configured: Option<&str>, env: &DetectEnv) -> Option<PathBuf> {
    let exe = exe_name("vlc");
    if let Some(p) = configured_path(configured, &exe) {
        return Some(p);
    }
    let found = path_candidates(env, &exe)
        .chain(well_known_candidates(env, Player::Vlc))
        .find(|p| p.is_file());
    found
}

#[derive(Clone, Copy)]
enum Player {
    Mpv,
    Vlc,
}

/// A configured path that exists: the file itself, or `<dir>/<exe>` when a
/// directory was configured. Blank strings are ignored.
fn configured_path(configured: Option<&str>, exe: &str) -> Option<PathBuf> {
    let raw = configured?.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }
    let p = PathBuf::from(raw);
    if p.is_file() {
        return Some(p);
    }
    if p.is_dir() {
        let inner = p.join(exe);
        if inner.is_file() {
            return Some(inner);
        }
    }
    None
}

fn vendored_mpv_candidates(env: &DetectEnv) -> Vec<PathBuf> {
    let rel = Path::new("vendor").join("mpv").join(exe_name("mpv"));
    let mut out = Vec::new();
    let roots: Vec<&PathBuf> = env.exe_dir.iter().chain(env.cwd.iter()).collect();
    for root in &roots {
        push_unique(&mut out, root.join(&rel));
    }
    if env.search_ancestors {
        for root in &roots {
            for ancestor in root.ancestors().skip(1).take(VENDOR_ANCESTOR_DEPTH) {
                push_unique(&mut out, ancestor.join(&rel));
            }
        }
    }
    out
}

fn path_candidates<'a>(env: &'a DetectEnv, exe: &'a str) -> impl Iterator<Item = PathBuf> + 'a {
    env.path_dirs
        .iter()
        .filter(|d| !d.as_os_str().is_empty())
        .map(move |d| d.join(exe))
}

fn well_known_candidates(env: &DetectEnv, player: Player) -> Vec<PathBuf> {
    let (name, exe) = match player {
        Player::Mpv => ("mpv", exe_name("mpv")),
        Player::Vlc => ("vlc", exe_name("vlc")),
    };
    let mut out = Vec::new();

    for pf in &env.program_files {
        match player {
            Player::Mpv => {
                out.push(pf.join("mpv").join(&exe));
                out.push(pf.join("MPV Player").join(&exe));
            }
            Player::Vlc => out.push(pf.join("VideoLAN").join("VLC").join(&exe)),
        }
    }

    let scoop_roots = env
        .scoop_root
        .iter()
        .cloned()
        .chain(env.home.iter().map(|h| h.join("scoop")));
    for root in scoop_roots {
        out.push(root.join("apps").join(name).join("current").join(&exe));
        out.push(root.join("shims").join(&exe));
    }

    if let Some(pd) = &env.program_data {
        out.push(pd.join("chocolatey").join("bin").join(&exe));
        // scoop --global installs
        out.push(
            pd.join("scoop")
                .join("apps")
                .join(name)
                .join("current")
                .join(&exe),
        );
    }

    if let Some(lad) = &env.local_app_data {
        let winget = lad.join("Microsoft").join("WinGet");
        out.push(winget.join("Links").join(&exe));
        out.extend(winget_package_candidates(
            &winget.join("Packages"),
            name,
            &exe,
        ));
    }

    for dir in &env.extra_dirs {
        out.push(dir.join(&exe));
    }

    for apps in &env.app_bundle_dirs {
        match player {
            Player::Mpv => out.push(
                apps.join("mpv.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("mpv"),
            ),
            Player::Vlc => out.push(
                apps.join("VLC.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("VLC"),
            ),
        }
    }

    let mut dedup: Vec<PathBuf> = Vec::with_capacity(out.len());
    for p in out {
        push_unique(&mut dedup, p);
    }
    dedup
}

/// `<Packages>/<id>/<exe>` for every WinGet package id that contains `name`
/// (e.g. `mpv-player.mpv-CI.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe`),
/// sorted so the choice is stable.
fn winget_package_candidates(packages: &Path, name: &str, exe: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(packages) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains(name)
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs.into_iter().map(|d| d.join(exe)).collect()
}
