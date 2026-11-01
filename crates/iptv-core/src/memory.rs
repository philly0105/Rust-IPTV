//! Process memory housekeeping after large source imports.
//!
//! glibc keeps the memory an import freed inside its arenas when long-lived
//! blocks sit above it: SQLite page-cache pages, allocated on the same
//! blocking thread while the decoded rows were still alive, pin the arena,
//! so its top cannot shrink. The server image and Linux desktop builds then
//! keep most of an import's peak resident for the rest of the session: an
//! Xtream import of 170k items stayed 280-330 MB above its start, 45-70 MB
//! after a trim. `malloc_trim` hands every whole free page in every arena
//! back to the OS. Windows, macOS and musl allocators are left alone.
//!
//! Guide ingests stream and leave next to nothing to trim, so only imports
//! call it.

#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::sync::atomic::{AtomicBool, Ordering};

/// True while a [`release_freed_heap_soon`] trim waits for its thread, so
/// imports finishing together queue one trim, not one each.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
static PENDING: AtomicBool = AtomicBool::new(false);

/// Clears [`PENDING`] when dropped: when the queued trim starts, and also
/// when its runtime shuts down first and drops it unrun. Otherwise no later
/// import would queue a trim again.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
struct Pending;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
impl Drop for Pending {
    fn drop(&mut self) {
        PENDING.store(false, Ordering::Release);
    }
}

/// Returns the heap's free pages to the OS. Blocking: it walks every arena
/// under that arena's lock (20-35 ms after a 170k-item import). Call it once
/// the import's rows are dropped, or it frees nothing.
pub fn release_freed_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim takes no pointers and locks each arena itself.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// [`release_freed_heap`] on the blocking pool, without waiting for it.
/// Needs a Tokio runtime on linux-gnu; does nothing elsewhere.
pub fn release_freed_heap_soon() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    if !PENDING.swap(true, Ordering::AcqRel) {
        let pending = Pending;
        tokio::task::spawn_blocking(move || {
            // Cleared first: memory freed while this trim runs needs another.
            drop(pending);
            release_freed_heap();
        });
    }
}
