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
        }))
    }

    /// App version (`CARGO_PKG_VERSION` of iptv-core).
    pub const fn version() -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    /// Checks out a pooled connection. Blocking: from async code prefer [`Self::db_call`].
    pub fn conn(&self) -> CoreResult<PooledConn> {
        Ok(self.db.get()?)
    }

    /// Runs blocking database work on the blocking thread pool.
    pub async fn db_call<T, F>(&self, f: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> CoreResult<T> + Send + 'static,
    {
        let pool = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool.get()?;
            f(&mut conn)
        })
        .await?
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
