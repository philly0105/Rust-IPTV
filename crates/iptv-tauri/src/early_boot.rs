//! Opens the database before the webview exists (Windows).
//!
//! Tauri builds the main window, and with it WebView2, before `setup` runs,
//! and that takes a few hundred milliseconds. The database used to start
//! opening only then, so the page's first `rpc` calls (`app.info`, which the
//! first render waits for, and the settings) waited for it on top of the
//! webview. Here `run` starts it first, from the same data folder Tauri
//! resolves (`app_data_dir`: the roaming app-data known folder joined with
//! the identifier), and `setup` picks it up.
//!
//! Only the first instance does this: a second launch hands over to the
//! running one (single-instance) and must not open the database on the way.
//! The `<identifier>-boot` mutex is held for the process's life, so of two
//! launches only one opens early; the other boots as before, in `setup`, if
//! it ends up being the instance that stays.

use iptv_core::logging::LogGuard;
use iptv_core::{AppState, CoreResult};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::async_runtime::JoinHandle;

/// The state being opened ahead of the window, and the log it writes to.
pub struct EarlyBoot {
    pub data_dir: PathBuf,
    pub log_guard: Option<LogGuard>,
    pub sink: Arc<crate::LateSink>,
    pub state: JoinHandle<CoreResult<Arc<AppState>>>,
}

/// Starts opening the state for `identifier`, or None when this process
/// must not (another instance runs or is starting, or the folder is unknown).
pub fn start(identifier: &str) -> Option<EarlyBoot> {
    if !first_instance(identifier) {
        return None;
    }
    let data_dir = roaming_app_data()?.join(identifier);
    let log_guard = crate::init_logging(&data_dir);
    let sink = Arc::new(crate::LateSink::default());
    let state = tauri::async_runtime::spawn(crate::open_state(
        data_dir.clone(),
        Arc::clone(&sink) as Arc<dyn iptv_core::EventSink>,
    ));
    Some(EarlyBoot {
        data_dir,
        log_guard,
        sink,
        state,
    })
}

/// True when no other instance runs or is starting: this process created
/// the boot mutex (kept until exit) and no single-instance window exists
/// (an older build without the mutex).
#[cfg(windows)]
fn first_instance(identifier: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

    let name = HSTRING::from(format!("{identifier}-boot"));
    // SAFETY: a named mutex with default security; the handle is left open
    // on purpose so the name stays taken until the process exits.
    let created = unsafe { CreateMutexW(None, false, &name) };
    // SAFETY: reads this thread's last error right after the call.
    if created.is_err() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return false;
    }
    let class = HSTRING::from(format!("{identifier}-sic"));
    let window = HSTRING::from(format!("{identifier}-siw"));
    // SAFETY: both strings are valid for the call.
    unsafe { FindWindowW(&class, &window) }.is_err()
}

#[cfg(not(windows))]
fn first_instance(_identifier: &str) -> bool {
    false
}

/// `FOLDERID_RoamingAppData`, as `dirs::data_dir` (and so Tauri) reads it.
#[cfg(windows)]
fn roaming_app_data() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        FOLDERID_RoamingAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    };

    // SAFETY: the returned string is read once, then freed with CoTaskMemFree as documented.
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, None).ok()?;
        let dir = std::ffi::OsString::from_wide(path.as_wide());
        CoTaskMemFree(Some(path.0 as *const core::ffi::c_void));
        Some(PathBuf::from(dir))
    }
}

#[cfg(not(windows))]
fn roaming_app_data() -> Option<PathBuf> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn the_known_folder_is_the_roaming_app_data_folder() {
        let dir = roaming_app_data().expect("roaming app data");
        assert!(dir.is_absolute());
        if let Some(env) = std::env::var_os("APPDATA") {
            assert_eq!(dir, PathBuf::from(env));
        }
    }

    #[test]
    fn only_one_process_or_launch_takes_the_boot_mutex() {
        let id = format!("com.philly.tsrustiptv.boot-test-{}", std::process::id());
        assert!(first_instance(&id), "the first launch opens early");
        assert!(
            !first_instance(&id),
            "a second launch while it runs does not"
        );
    }
}
