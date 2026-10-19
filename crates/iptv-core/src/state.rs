//! Process-wide application state (SPEC C1).
//!
//! One `Arc<AppState>` is created at boot by the Tauri shell or the server
//! binary and passed to every RPC handler.

use crate::db::{self, DbPool, PooledConn};
use crate::error::{CoreError, CoreResult};
use crate::events::{AppEvent, EventSink};
use crate::model::Settings;
use dashmap::DashMap;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Shared state handed to every RPC handler and background task.
pub struct AppState {
    /// App data root. DB at `data_dir/iptv.db`, logs at `data_dir/logs`,
    /// default downloads at `data_dir/downloads`.
    pub data_dir: PathBuf,
    /// r2d2 SQLite pool (C3).
    pub db: DbPool,
    /// Shared client from `http::client(None)`.
    pub http: reqwest::Client,
    /// Event sink (Tauri `app-event` or server WebSocket broadcast).
    pub events: Arc<dyn EventSink>,
    /// Settings cache, loaded at boot from the `settings` table or `Default`.
    /// `settings.update` (B2) writes the table and then refreshes this cache.
    pub settings: Arc<parking_lot::RwLock<Settings>>,
    /// True inside the Tauri shell, false in server (PWA) mode and tests.
    pub is_desktop: bool,
    /// Runtime singletons stashed by modules under their module name
    /// (download queue, mpv session, remote server handle, importers, ...).
    pub extensions: DashMap<&'static str, Arc<dyn Any + Send + Sync>>,
    /// Admits one user write at a time to the pool; see [`Self::db_write`].
    write_gate: Arc<tokio::sync::Semaphore>,
    /// Writes started with [`DbWriter::spawn`] that have not finished.
    background_writes: Arc<AtomicUsize>,
}

/// Runs best-effort writes after their caller has returned: the cache rows a
/// read fills (TMDB lookups, listed Stalker rows). They pass the gate of
/// [`AppState::db_write`] like user writes, so while an import holds the
/// write lock they never park more than that one pooled connection, and the
/// read that started them does not wait for the lock (DB-1). Cloned out of
/// the state by [`AppState::writer`] for tasks that outlive a borrow of it.
#[derive(Clone)]
pub struct DbWriter {
    pool: DbPool,
    db_path: PathBuf,
    gate: Arc<tokio::sync::Semaphore>,
    pending: Arc<AtomicUsize>,
}

/// Counts a write of [`DbWriter::spawn`] as pending until dropped.
struct Pending(Arc<AtomicUsize>);

impl Pending {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(count))
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl DbWriter {
    /// The pool, for the reads that go with the writes.
    pub fn pool(&self) -> &DbPool {
        &self.pool
    }

    /// Runs `f` through the write gate in a background task and returns at
    /// once. A failure is logged with `what`; a corruption error flags the
    /// next boot as in [`AppState::db_call`]. Must be called inside a Tokio
    /// runtime.
    pub fn spawn<F>(&self, what: &'static str, f: F)
    where
        F: FnOnce(&mut Connection) -> CoreResult<()> + Send + 'static,
    {
        let this = self.clone();
        let pending = Pending::new(&self.pending);
        tokio::spawn(async move {
            let _pending = pending;
            let Ok(_permit) = this.gate.acquire().await else {
                return;
            };
            let activity = db::activity();
            let pool = this.pool.clone();
            let joined = tokio::task::spawn_blocking(move || -> CoreResult<()> {
                let _activity = activity;
                let mut conn = pool.get()?;
                f(&mut conn)
            })
            .await;
            let result = match joined {
                Ok(r) => r,
                Err(err) => Err(CoreError::from(err)),
            };
            if let Err(err) = result {
                db::note_error(&this.db_path, &err);
                tracing::warn!(what, error = %err, "background database write failed");
            }
        });
    }
}

tokio::task_local! {
    /// Set by [`cancel_on_drop`]: database calls made inside it stop their
    /// SQL when the call is dropped.
    static CANCEL_ON_DROP: ();
}

/// Runs `fut` so that a [`AppState::db_call`] inside it interrupts its SQLite
/// statement when `fut` is dropped before it finishes, instead of running to
/// the end for nobody. For read-only work whose caller may go away (server
/// mode drops a request when the browser aborts it, L2-perf-desktop-6).
/// Never wrap writes in it: an interrupted write rolls back.
pub async fn cancel_on_drop<F: std::future::Future>(fut: F) -> F::Output {
    CANCEL_ON_DROP.scope((), fut).await
}

/// Where a cancellable database call is, shared by its async and blocking
/// halves.
enum CallState {
    /// Waiting for a pooled connection.
    Queued,
    /// Running on a connection.
    Running(rusqlite::InterruptHandle),
    /// The caller went away.
    Cancelled,
    /// The closure returned (or panicked); the connection may serve others.
    Done,
}

type CallSlot = Arc<parking_lot::Mutex<CallState>>;

/// Async half: dropped with the caller's future. Interrupts the statement
/// while the closure runs; a queued call never starts.
struct InterruptOnDrop(CallSlot);

impl Drop for InterruptOnDrop {
    fn drop(&mut self) {
        let mut st = self.0.lock();
        match &*st {
            CallState::Running(handle) => {
                handle.interrupt();
                *st = CallState::Cancelled;
            }
            CallState::Queued => *st = CallState::Cancelled,
            CallState::Cancelled | CallState::Done => {}
        }
    }
}

/// Blocking half: marks the call done (also on panic) before the connection
/// goes back to the pool, so a late interrupt never reaches another call.
struct Disarm(CallSlot);

impl Drop for Disarm {
    fn drop(&mut self) {
        *self.0.lock() = CallState::Done;
    }
}

impl AppState {
    /// Creates the data dir tree (`data_dir`, `logs`, `downloads`), opens and
    /// migrates the database (quarantining a corrupt file), loads settings, and
    /// builds the HTTP client. Does not install logging (call
    /// `logging::init` first) and does not start module runtimes (call
    /// `rpc::init_all` after).
    pub async fn new(
        data_dir: PathBuf,
        events: Arc<dyn EventSink>,
        is_desktop: bool,
    ) -> CoreResult<Arc<Self>> {
        let (data_dir, db, settings) = tokio::task::spawn_blocking(move || -> CoreResult<_> {
            let data_dir = std::path::absolute(&data_dir).unwrap_or(data_dir);
            std::fs::create_dir_all(&data_dir).map_err(|e| {
                CoreError::Io(std::io::Error::new(
                    e.kind(),
                    format!("cannot create data dir {}: {e}", data_dir.display()),
                ))
            })?;
            std::fs::create_dir_all(crate::logging::logs_dir(&data_dir))?;
            std::fs::create_dir_all(data_dir.join("downloads"))?;
            let pool = db::open_and_migrate(&data_dir.join(db::DB_FILE))?;
            let settings = {
                let conn = pool.get()?;
                load_settings(&conn)?
            };
            Ok((data_dir, pool, settings))
        })
        .await??;

        tracing::info!(data_dir = %data_dir.display(), is_desktop, version = Self::version(), "app state ready");
        Ok(Arc::new(Self {
            data_dir,
            db,
            http: crate::http::client(None),
            events,
            settings: Arc::new(parking_lot::RwLock::new(settings)),
            is_desktop,
            extensions: DashMap::new(),
            write_gate: Arc::new(tokio::sync::Semaphore::new(1)),
            background_writes: Arc::new(AtomicUsize::new(0)),
        }))
    }

    /// App version (`CARGO_PKG_VERSION` of iptv-core).
    pub const fn version() -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    /// Checks out a pooled connection. Blocking: from async code prefer [`Self::db_call`].
    pub fn conn(&self) -> CoreResult<PooledConn> {
        self.db
            .get()
            .map_err(|e| self.note_db_error(CoreError::from(e)))
    }

    /// Runs blocking database work on the blocking thread pool. A corruption
    /// error from the closure flags the next boot for a full integrity check
    /// (see [`db::note_error`]); the error is returned unchanged.
    ///
    /// Inside [`cancel_on_drop`], dropping the returned future interrupts the
    /// closure's SQL (or skips it while it still waits for a connection).
    pub async fn db_call<T, F>(&self, f: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> CoreResult<T> + Send + 'static,
    {
        let pool = self.db.clone();
        let db_path = self.db_path();
        let slot: Option<CallSlot> = CANCEL_ON_DROP
            .try_with(|_| Arc::new(parking_lot::Mutex::new(CallState::Queued)))
            .ok();
        let _interrupt = slot.clone().map(InterruptOnDrop);
        // Held until the closure ends: the background integrity check waits
        // for a quiet database (L3-perf-core-7).
        let activity = db::activity();
        tokio::task::spawn_blocking(move || {
            let _activity = activity;
            pool.get()
                .map_err(CoreError::from)
                .and_then(|mut conn| {
                    // Declared after `conn`, so dropped before it.
                    let _disarm = match &slot {
                        Some(slot) => {
                            let mut st = slot.lock();
                            if matches!(*st, CallState::Cancelled) {
                                return Err(CoreError::Other(anyhow::anyhow!(
                                    "the request was cancelled"
                                )));
                            }
                            *st = CallState::Running(conn.get_interrupt_handle());
                            Some(Disarm(slot.clone()))
                        }
                        None => None,
                    };
                    f(&mut conn)
                })
                .inspect_err(|e| {
                    db::note_error(&db_path, e);
                })
        })
        .await?
    }

    /// [`Self::db_call`] for user writes (a favourite, a position, a setting,
    /// a recent entry). They pass a process-wide gate one at a time before
    /// they take a pooled connection: while an import holds SQLite's write
    /// lock, one of them waits on a connection and the rest wait here, so
    /// reads keep the other connections (L2-perf-core-2). The closure must
    /// not call `db_write` itself (it is synchronous, so it cannot).
    pub async fn db_write<T, F>(&self, f: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> CoreResult<T> + Send + 'static,
    {
        let _permit = self
            .write_gate
            .acquire()
            .await
            .map_err(|_| CoreError::Other(anyhow::anyhow!("the database is closing")))?;
        self.db_call(f).await
    }

    /// A handle for best-effort writes that run through the gate of
    /// [`Self::db_write`] without the caller waiting; see [`DbWriter`].
    pub fn writer(&self) -> DbWriter {
        DbWriter {
            pool: self.db.clone(),
            db_path: self.db_path(),
            gate: Arc::clone(&self.write_gate),
            pending: Arc::clone(&self.background_writes),
        }
    }

    /// Waits until every write started with [`DbWriter::spawn`] has finished
    /// (a cache clear, tests that read the rows a call wrote).
    pub async fn flush_background_writes(&self) {
        while self.background_writes.load(Ordering::SeqCst) > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Records a database error for boot-time recovery when it is a
    /// corruption error (see [`db::note_error`]) and hands it back, so any
    /// pooled-connection path outside [`Self::db_call`] can write
    /// `.map_err(|e| state.note_db_error(e))`.
    pub fn note_db_error(&self, err: CoreError) -> CoreError {
        db::note_error(&self.db_path(), &err);
        err
    }

    /// Fetches a runtime singleton stored with [`Self::set_ext`]; `None` if
    /// missing or stored with a different type.
    pub fn ext<T: Any + Send + Sync>(&self, key: &'static str) -> Option<Arc<T>> {
        let v = self.extensions.get(key)?.value().clone();
        v.downcast::<T>().ok()
    }

    /// Stores (or replaces) a runtime singleton under `key`.
    pub fn set_ext<T: Any + Send + Sync>(&self, key: &'static str, v: Arc<T>) {
        self.extensions.insert(key, v);
    }

    /// Returns the singleton under `key`, creating it with `init` when absent.
    pub fn ext_or_insert_with<T: Any + Send + Sync>(
        &self,
        key: &'static str,
        init: impl FnOnce() -> Arc<T>,
    ) -> Arc<T> {
        let entry = self
            .extensions
            .entry(key)
            .or_insert_with(|| init() as Arc<dyn Any + Send + Sync>);
        entry
            .value()
            .clone()
            .downcast::<T>()
            .unwrap_or_else(|_| panic!("extension {key:?} already stored with a different type"))
    }

    /// Emits an app event through the sink.
    pub fn emit(&self, kind: &str, payload: impl Serialize) {
        self.events.emit(AppEvent::new(kind, payload));
    }

    /// Clone of the current settings.
    pub fn settings_snapshot(&self) -> Settings {
        self.settings.read().clone()
    }

    /// Path of the SQLite database.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(db::DB_FILE)
    }

    /// Directory holding log files.
    pub fn logs_dir(&self) -> PathBuf {
        crate::logging::logs_dir(&self.data_dir)
    }

    /// Effective downloads directory: `settings.downloadsDir` or `data_dir/downloads`.
    pub fn downloads_dir(&self) -> PathBuf {
        match self.settings.read().downloads_dir.as_deref().map(str::trim) {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => self.data_dir.join("downloads"),
        }
    }

    /// True when `path` is inside the data dir.
    pub fn is_in_data_dir(&self, path: &Path) -> bool {
        path.starts_with(&self.data_dir)
    }
}

/// Reads settings row 1; missing row or unreadable JSON yields `Settings::default()`.
pub fn load_settings(conn: &Connection) -> CoreResult<Settings> {
    let json: Option<String> = conn
        .query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get(0))
        .optional()?;
    Ok(match json {
        None => Settings::default(),
        Some(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
            // Never log the JSON itself: it may contain the TMDB key.
            tracing::warn!(%err, "stored settings are unreadable; using defaults");
            Settings::default()
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::NoopSink;
    use crate::model::Theme;

    #[tokio::test]
    async fn new_creates_dirs_and_loads_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("nested").join("data");
        let state = AppState::new(data.clone(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        assert!(data.join("logs").is_dir());
        assert!(data.join("downloads").is_dir());
        assert_eq!(state.settings_snapshot(), Settings::default());

        state
            .db_call(|c| {
                c.execute(
                    "INSERT INTO settings(id, json) VALUES (1, ?1)",
                    [r#"{"theme":"dark"}"#],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        drop(state);
        let state = AppState::new(data, Arc::new(NoopSink), false)
            .await
            .unwrap();
        assert_eq!(state.settings.read().theme, Theme::Dark);
    }

    #[tokio::test]
    async fn extensions_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        state.set_ext("answer", Arc::new(42u32));
        assert_eq!(*state.ext::<u32>("answer").unwrap(), 42);
        assert!(state.ext::<String>("answer").is_none());
        let v = state.ext_or_insert_with("lazy", || Arc::new(String::from("x")));
        assert_eq!(v.as_str(), "x");
    }
}
