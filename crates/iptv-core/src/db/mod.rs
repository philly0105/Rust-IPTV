//! SQLite storage (SPEC C3): r2d2 pool, embedded migrations, corrupt-db recovery.
//!
//! Written by W0; owned and extended by B1. Every pooled connection runs with
//! `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
//! `busy_timeout=5000`. Long imports should use one write transaction per source.

use crate::error::{is_sqlite_corruption, CoreError, CoreResult};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Connection pool type shared through `AppState::db`.
pub type DbPool = r2d2::Pool<SqliteConnectionManager>;
/// A connection checked out of the pool.
pub type PooledConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Database file name inside the data dir.
pub const DB_FILE: &str = "iptv.db";
/// Maximum pooled connections.
pub const POOL_MAX: u32 = 8;
/// Prepared statements cached per connection.
const STATEMENT_CACHE: usize = 128;
/// SQLite busy timeout applied to every connection.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// One embedded migration script.
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration, in ascending version order. Add new files as
/// `migrations/NNNN_name.sql` and append them here.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "0001_init",
        sql: include_str!("migrations/0001_init.sql"),
    },
    Migration {
        version: 2,
        name: "0002_catalog_support",
        sql: include_str!("migrations/0002_catalog_support.sql"),
    },
    Migration {
        version: 3,
        name: "0003_epg_program_url_index",
        sql: include_str!("migrations/0003_epg_program_url_index.sql"),
    },
    Migration {
        version: 4,
        name: "0004_position_watched",
        sql: include_str!("migrations/0004_position_watched.sql"),
    },
    Migration {
        version: 5,
        name: "0005_items_position_index",
        sql: include_str!("migrations/0005_items_position_index.sql"),
    },
];

/// Message shown when the database was written by a newer build.
pub const NEWER_SCHEMA_MESSAGE: &str =
    "This data was created by a newer Tsrust IPTV; update the app";

/// Suffix of the flag file written next to the database when a query reports
/// corruption at runtime (`iptv.db.needs-recovery`). The next boot runs a full
/// integrity check and quarantines the file when it fails.
pub const RECOVERY_FLAG_SUFFIX: &str = ".needs-recovery";

/// Suffix of the marker written next to the database after a clean exit
/// (`iptv.db.clean-exit`, see [`mark_clean_exit`]). Boot consumes it: when it
/// is there, the previous run closed the database normally and the boot-time
/// `quick_check`, which reads every page of the file, is skipped.
pub const CLEAN_EXIT_SUFFIX: &str = ".clean-exit";

/// Latest schema version known to this build.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

/// Applies the per-connection pragmas.
pub fn configure(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // rusqlite keeps 16 prepared statements by default; the app has more hot
    // queries than that (catalog pages, EPG now/next, favorites, positions),
    // so the default cache keeps evicting and recompiling them.
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;",
    )?;
    Ok(())
}

/// Opens a pool on `path` (max 8 connections, pragmas applied). Does not migrate;
/// see [`open_and_migrate`] for the boot path with recovery.
pub fn open(path: &Path) -> CoreResult<DbPool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let manager = SqliteConnectionManager::file(path).with_init(configure);
    let pool = r2d2::Pool::builder()
        .max_size(POOL_MAX)
        .min_idle(Some(1))
        .connection_timeout(Duration::from_secs(15))
        .build(manager)?;
    Ok(pool)
}

/// Applies pending migrations inside one IMMEDIATE transaction, tracked in
/// `schema_migrations`. Idempotent.
pub fn migrate(conn: &mut Connection) -> CoreResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let has_table: bool = tx
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    let current: i64 = if has_table {
        tx.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )?
    } else {
        0
    };
    let latest = latest_version();
    if current > latest {
        // Never write to (or "fix") a database a newer build created: its
        // tables may carry columns and rules this build does not know.
        tracing::error!(current, latest, "database schema is newer than this build");
        return Err(newer_schema_error());
    }
    for m in MIGRATIONS.iter().filter(|m| m.version > current) {
        tracing::info!(version = m.version, name = m.name, "applying migration");
        tx.execute_batch(m.sql)?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
            [m.version],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Current schema version (0 for an empty database).
pub fn schema_version(conn: &Connection) -> CoreResult<i64> {
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !has_table {
        return Ok(0);
    }
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?)
}

fn newer_schema_error() -> CoreError {
    CoreError::Other(anyhow::anyhow!(NEWER_SCHEMA_MESSAGE))
}

/// A corruption error carrying the integrity check's first finding.
fn corrupt_error(detail: &str) -> CoreError {
    CoreError::Db(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
        Some(format!("database integrity check failed: {detail}")),
    ))
}

/// Runs `PRAGMA quick_check` (or the slower `integrity_check`, which also
/// verifies index contents) and turns any finding into a corruption error.
/// A file with a valid header but garbage pages opens fine and only fails on
/// the first query that touches a bad page, so this runs on every boot that
/// does not follow a clean exit (see [`mark_clean_exit`]).
fn check_integrity(conn: &Connection, full: bool) -> CoreResult<()> {
    let pragma = if full {
        "PRAGMA integrity_check(1)"
    } else {
        "PRAGMA quick_check(1)"
    };
    let first: String = conn.query_row(pragma, [], |r| r.get(0))?;
    if first.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(corrupt_error(&first))
    }
}

/// Which integrity check boot runs.
#[derive(Clone, Copy)]
enum Check {
    /// The previous run exited cleanly: no page scan.
    Skip,
    Quick,
    Full,
}

fn try_open_and_migrate(path: &Path, check: Check) -> CoreResult<DbPool> {
    // Validate and migrate on a dedicated connection first: a corrupt file fails
    // fast here instead of stalling inside the pool builder.
    {
        let mut conn = Connection::open(path)?;
        configure(&mut conn)?;
        conn.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0))?;
        match check {
            Check::Skip => {}
            Check::Quick => check_integrity(&conn, false)?,
            Check::Full => check_integrity(&conn, true)?,
        }
        if schema_version(&conn)? > latest_version() {
            return Err(newer_schema_error());
        }
        migrate(&mut conn)?;
    }
    open(path)
}

fn is_corruption(err: &CoreError) -> bool {
    matches!(err, CoreError::Db(e) if is_sqlite_corruption(e))
}

/// Moves a corrupt database (and its `-wal` / `-shm` side files) aside to
/// `<name>.corrupt-<timestamp>` and returns the new path of the main file.
pub fn quarantine(path: &Path) -> CoreResult<PathBuf> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| DB_FILE.to_string());
    let target = path.with_file_name(format!("{file_name}.corrupt-{stamp}"));
    std::fs::rename(path, &target)?;
    for side in ["-wal", "-shm"] {
        let src = path.with_file_name(format!("{file_name}{side}"));
        if src.exists() {
            let dst = path.with_file_name(format!("{file_name}.corrupt-{stamp}{side}"));
            if let Err(err) = std::fs::rename(&src, &dst) {
                tracing::warn!(%err, file = %src.display(), "could not move database side file; deleting it");
                let _ = std::fs::remove_file(&src);
            }
        }
    }
    Ok(target)
}

/// Path of the runtime-corruption flag for the database at `path`.
pub fn recovery_flag_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| DB_FILE.to_string());
    path.with_file_name(format!("{name}{RECOVERY_FLAG_SUFFIX}"))
}

/// Path of the clean-exit marker for the database at `path`.
pub fn clean_exit_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| DB_FILE.to_string());
    path.with_file_name(format!("{name}{CLEAN_EXIT_SUFFIX}"))
}

/// Records that the database at `path` was closed normally (call after the
/// exit checkpoint). The next boot skips its `quick_check`; a crash, a kill,
/// or a power loss leaves no marker, so the check runs after those.
pub fn mark_clean_exit(path: &Path) {
    if let Err(err) = std::fs::write(clean_exit_path(path), b"ok") {
        tracing::warn!(%err, "could not write the database clean-exit marker");
    }
}

/// Call with any error a query on the database at `db_path` returned. When it
/// is a corruption error (`SQLITE_CORRUPT` / `SQLITE_NOTADB`), writes the
/// recovery flag so the next boot checks the whole file and quarantines it.
/// Returns true when the flag was written.
pub fn note_error(db_path: &Path, err: &CoreError) -> bool {
    if !is_corruption(err) {
        return false;
    }
    let flag = recovery_flag_path(db_path);
    match std::fs::write(&flag, chrono::Utc::now().to_rfc3339().as_bytes()) {
        Ok(()) => {
            tracing::error!(error = %err, flag = %flag.display(), "database reported corruption; it will be checked and recovered at the next start");
            true
        }
        Err(io) => {
            tracing::error!(error = %err, %io, "database reported corruption and the recovery flag could not be written");
            false
        }
    }
}

/// Boot path: open, check integrity (`quick_check`; the full `integrity_check`
/// when a previous run flagged corruption, see [`note_error`]), refuse a
/// schema newer than this build, and migrate. When the file is corrupt or not
/// a database, quarantine it (see [`quarantine`]), log a warning, and recreate
/// an empty one.
pub fn open_and_migrate(path: &Path) -> CoreResult<DbPool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let flag = recovery_flag_path(path);
    let flagged = flag.exists();
    if flagged {
        tracing::warn!("previous run reported database corruption; running a full integrity check");
    }
    // The marker is consumed whatever happens next, so only an exit that
    // writes a new one lets the following boot skip the check again. When it
    // cannot be removed, check anyway: a stale marker must not stick.
    let marker = clean_exit_path(path);
    let clean_exit = marker.exists() && std::fs::remove_file(&marker).is_ok();
    let check = if flagged {
        Check::Full
    } else if clean_exit {
        Check::Skip
    } else {
        Check::Quick
    };
    let result = match try_open_and_migrate(path, check) {
        Ok(pool) => Ok(pool),
        Err(err) if is_corruption(&err) => {
            let moved = quarantine(path)?;
            tracing::warn!(error = %err, backup = %moved.display(), "database was corrupt; moved aside and recreating");
            try_open_and_migrate(path, Check::Quick)
        }
        Err(err) => Err(err),
    };
    if flagged && result.is_ok() {
        if let Err(err) = std::fs::remove_file(&flag) {
            tracing::warn!(%err, "could not remove the database recovery flag");
        }
    }
    result
}

/// Current UTC time as RFC 3339 with second precision (`2026-10-11T02:30:00Z`).
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Normalizes a SQLite `CURRENT_TIMESTAMP` value (`YYYY-MM-DD HH:MM:SS`, UTC)
/// to RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ`). RFC 3339 input passes through.
pub fn to_rfc3339(ts: &str) -> String {
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S") {
        return dt
            .and_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }
    ts.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_db_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let pool = open_and_migrate(&path).unwrap();
        let mut conn = pool.get().unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn upgrades_v1_database_to_v2() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&mut conn).unwrap();
        // Apply only migration 1, the way a W0 build left the database.
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources (id, kind, name, position, auto_refresh, created_at, config_json)              VALUES ('s1', 'm3u', 'S', 0, 0, '2026-01-01T00:00:00Z', '{}')",
            [],
        )
        .unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 1);
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        let has_url_index: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_epg_programs_url'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has_url_index, "0003 adds the epg_programs(epg_url) index");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        conn.execute("INSERT INTO source_counts (source_id) VALUES ('s1')", [])
            .unwrap();
        conn.execute("DELETE FROM sources WHERE id = 's1'", [])
            .unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM source_counts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "source_counts cascades on source delete");
    }

    #[test]
    fn fts_triggers_work() {
        let dir = tempfile::tempdir().unwrap();
        let pool = open_and_migrate(&dir.path().join(DB_FILE)).unwrap();
        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO items(source_id, content_type, item_id, category_id, title) VALUES ('s','live','1','g','BBC One HD')",
            [],
        )
        .unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM items_fts WHERE items_fts MATCH 'bbc*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        conn.execute("DELETE FROM sources WHERE id = 's'", [])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "ON DELETE CASCADE removes items");
    }

    #[test]
    fn corrupt_db_is_quarantined_and_recreated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        std::fs::write(
            &path,
            b"this is definitely not a sqlite database file, just garbage bytes......",
        )
        .unwrap();
        let pool = open_and_migrate(&path).unwrap();
        assert_eq!(
            schema_version(&pool.get().unwrap()).unwrap(),
            latest_version()
        );
        let moved = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("iptv.db.corrupt-")
            });
        assert!(moved, "corrupt file kept as a backup");
    }

    #[test]
    fn timestamp_normalization() {
        assert_eq!(to_rfc3339("2026-10-11 02:30:00"), "2026-10-11T02:30:00Z");
        assert_eq!(to_rfc3339("2026-10-11T02:30:00Z"), "2026-10-11T02:30:00Z");
        assert!(now_rfc3339().ends_with('Z'));
    }
}
