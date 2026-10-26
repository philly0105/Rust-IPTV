//! SQLite storage (SPEC C3): r2d2 pool, embedded migrations, corrupt-db recovery.
//!
//! Written by W0; owned and extended by B1. Every pooled connection runs with
//! `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
//! `journal_size_limit` of 64 MiB, a 32 MiB page cache, a busy handler that waits up to 5 s for the write lock (longer while a
//! catalog import holds it, see [`long_write`]). Long imports should use one
//! write transaction per source.

use crate::error::{is_sqlite_corruption, CoreError, CoreResult};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Connection pool type shared through `AppState::db`.
pub type DbPool = r2d2::Pool<SqliteConnectionManager>;
/// A connection checked out of the pool.
pub type PooledConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Database file name inside the data dir.
pub const DB_FILE: &str = "iptv.db";
/// Maximum pooled connections. Opened on demand (one is kept idle). A write
/// that waits for an import's write lock holds its connection while it
/// waits; a burst of user writes during a save once took every connection
/// and reads queued behind them for 9 s (L2-perf-core-2). User writes now
/// pass `AppState::db_write`'s gate one at a time before they take a
/// connection, so at most one of them holds one while it waits.
pub const POOL_MAX: u32 = 8;
/// How long a connection waits for the write lock before failing with
/// "database is locked", when no catalog import is running.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);
/// The same wait while a catalog import runs. A large playlist holds the
/// write lock for its whole save (17 s for 486k channels, review round 3),
/// so user writes (positions, favorites, settings) wait for it to commit
/// instead of failing. Still bounded so a stuck writer cannot hang a call
/// forever.
pub const LONG_BUSY_TIMEOUT: Duration = Duration::from_secs(600);

/// Catalog imports in flight in this process. A plain `fn` busy handler has
/// no per-connection state, so this is process-wide; with several databases
/// open (tests) an import elsewhere only lengthens a wait that would
/// otherwise have failed.
static LONG_WRITERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Marks a catalog import as running until dropped; see [`LONG_BUSY_TIMEOUT`].
#[must_use = "the mark lasts until the guard is dropped"]
pub struct LongWrite(());

impl Drop for LongWrite {
    fn drop(&mut self) {
        LONG_WRITERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Marks a catalog import as running; held by `sources` for each import run.
pub fn long_write() -> LongWrite {
    LONG_WRITERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    LongWrite(())
}

thread_local! {
    /// When the current busy wait on this thread began.
    static BUSY_SINCE: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) };
}

/// Busy handler for every connection: retries with short sleeps (as
/// SQLite's own busy_timeout does) until [`BUSY_TIMEOUT`] has passed, or
/// [`LONG_BUSY_TIMEOUT`] while an import runs. `count` is 0 on the first
/// call of each wait.
fn busy_wait(count: i32) -> bool {
    const DELAYS_MS: [u64; 12] = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];
    let now = std::time::Instant::now();
    let since = BUSY_SINCE.with(|c| match c.get() {
        Some(t) if count > 0 => t,
        _ => {
            c.set(Some(now));
            now
        }
    });
    let limit = if LONG_WRITERS.load(std::sync::atomic::Ordering::SeqCst) > 0 {
        LONG_BUSY_TIMEOUT
    } else {
        BUSY_TIMEOUT
    };
    if now.duration_since(since) >= limit {
        return false;
    }
    let delay = DELAYS_MS[(count.max(0) as usize).min(DELAYS_MS.len() - 1)];
    std::thread::sleep(Duration::from_millis(delay));
    true
}

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
        name: "0005_source_error_code",
        sql: include_str!("migrations/0005_source_error_code.sql"),
    },
    Migration {
        version: 6,
        name: "0006_items_position_index",
        sql: include_str!("migrations/0006_items_position_index.sql"),
    },
    Migration {
        version: 7,
        name: "0007_epg_programs_unique",
        sql: include_str!("migrations/0007_epg_programs_unique.sql"),
    },
    Migration {
        version: 8,
        name: "0008_drop_epg_url_index",
        sql: include_str!("migrations/0008_drop_epg_url_index.sql"),
    },
    // account:
    Migration {
        version: 9,
        name: "0009_source_error_at",
        sql: include_str!("migrations/0009_source_error_at.sql"),
    },
    // recording:
    Migration {
        version: 10,
        name: "0010_recordings",
        sql: include_str!("migrations/0010_recordings.sql"),
    },
    // parental: parental_config and parental_locks (contract C2).
    Migration {
        version: 11,
        name: "0011_parental",
        sql: include_str!("migrations/0011_parental.sql"),
    },
    // watchlist: My List rows (contract C3).
    Migration {
        version: 12,
        name: "0012_watchlist",
        sql: include_str!("migrations/0012_watchlist.sql"),
    },
    // channeledit: channel_edits and the items year index (Run 2 C2, C4).
    Migration {
        version: 13,
        name: "0013_catalog_edits",
        sql: include_str!("migrations/0013_catalog_edits.sql"),
    },
    // lists: custom_lists and custom_list_items (Run 2 C3).
    Migration {
        version: 14,
        name: "0014_custom_lists",
        sql: include_str!("migrations/0014_custom_lists.sql"),
    },
    // guide: epg_programs_fts, recording_rules and rule skips (Run 2 C5).
    Migration {
        version: 15,
        name: "0015_guide",
        sql: include_str!("migrations/0015_guide.sql"),
    },
    // stats: watch_log (Run 2 C7).
    Migration {
        version: 16,
        name: "0016_watch_log",
        sql: include_str!("migrations/0016_watch_log.sql"),
    },
    // imagecache: image_cache index of the on-disk image cache (Run 3 C2).
    Migration {
        version: 17,
        name: "0017_image_cache",
        sql: include_str!("migrations/0017_image_cache.sql"),
    },
    // catalog: stored English-only verdict and sort indexes (loop 2).
    Migration {
        version: 18,
        name: "0018_catalog_query_speed",
        sql: include_str!("migrations/0018_catalog_query_speed.sql"),
    },
    // guide search: epg_search_rows and the channel resolution index (loop 3).
    Migration {
        version: 19,
        name: "0019_guide_search_speed",
        sql: include_str!("migrations/0019_guide_search_speed.sql"),
    },
    // catalog search: items_rank, the narrow ranking rows (loop 4).
    Migration {
        version: 20,
        name: "0020_search_rank",
        sql: include_str!("migrations/0020_search_rank.sql"),
    },
    // guide: per-channel time shift (epg.setChannelShift).
    Migration {
        version: 21,
        name: "0021_epg_channel_shift",
        sql: include_str!("migrations/0021_epg_channel_shift.sql"),
    },
    // catalog: stored live channel quality (the Live TV quality filter).
    Migration {
        version: 22,
        name: "0022_channel_quality",
        sql: include_str!("migrations/0022_channel_quality.sql"),
    },
    // settings: the stored old default stream format becomes "auto".
    Migration {
        version: 23,
        name: "0023_stream_format_auto",
        sql: include_str!("migrations/0023_stream_format_auto.sql"),
    },
    // catalog: category pages in date-added order from their own range.
    Migration {
        version: 24,
        name: "0024_category_added_index",
        sql: include_str!("migrations/0024_category_added_index.sql"),
    },
    Migration {
        version: 25,
        name: "0025_download_duration",
        sql: include_str!("migrations/0025_download_duration.sql"),
    },
    Migration {
        version: 26,
        name: "0026_download_rate_limit",
        sql: include_str!("migrations/0026_download_rate_limit.sql"),
    },
];

/// Message shown when the database was written by a newer build.
pub const NEWER_SCHEMA_MESSAGE: &str =
    "This data was created by a newer Tsrust IPTV; update the app";

/// Suffix of the flag file written next to the database when a query reports
/// corruption at runtime (`iptv.db.needs-recovery`). The next boot runs a full
/// integrity check and quarantines the file when it fails.
pub const RECOVERY_FLAG_SUFFIX: &str = ".needs-recovery";

/// Latest schema version known to this build.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

/// Largest database (`page_count * page_size`) whose `quick_check` runs at
/// open, before the pool. It costs well under 100 ms at this size; a 237 MB
/// database took about 670 ms, in front of the first window. A larger file
/// is checked in the background instead (see [`spawn_background_check`]).
const SYNC_CHECK_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// When the background `quick_check` of a large database starts. It reads
/// the whole file (2.9 s for 352 MB) and made the first page loads 3-6x
/// slower when it ran 3 s after open (L3-perf-core-7), so it now waits for
/// the app to go quiet.
#[derive(Debug, Clone, Copy)]
struct CheckSchedule {
    /// Earliest start after open.
    delay: Duration,
    /// Database quiet time (no call in flight) required before it starts.
    idle: Duration,
    /// Latest start after open, quiet or not.
    max_wait: Duration,
}

impl CheckSchedule {
    /// The boot schedule: 60 s after open, after 5 s without a database
    /// call, and at most 10 min after open.
    const BOOT: Self = Self {
        delay: Duration::from_secs(60),
        idle: Duration::from_secs(5),
        max_wait: Duration::from_secs(600),
    };
}

/// How long a passing background check stays valid when the previous run
/// shut down cleanly (see [`note_clean_shutdown`]).
const CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Suffix of the marker that exists while the app has the database open
/// (`iptv.db.running`). Still there at open: the last run did not shut down
/// cleanly.
const RUNNING_SUFFIX: &str = ".running";

/// Suffix of the file holding the time of the last passing background check
/// (`iptv.db.checked`, RFC 3339).
const CHECKED_SUFFIX: &str = ".checked";

/// Database calls in flight in this process (see [`activity`]).
static ACTIVE_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// When the last database call ended, in ms since [`activity_epoch`].
static LAST_CALL_END_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn activity_epoch() -> std::time::Instant {
    static EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    *EPOCH.get_or_init(std::time::Instant::now)
}

/// Marks a database call as in flight until dropped; the background check
/// waits for none to be in flight (see [`CheckSchedule`]).
#[must_use = "the mark lasts until the guard is dropped"]
pub struct Activity(());

impl Drop for Activity {
    fn drop(&mut self) {
        let ms = activity_epoch().elapsed().as_millis() as u64;
        LAST_CALL_END_MS.fetch_max(ms, std::sync::atomic::Ordering::SeqCst);
        ACTIVE_CALLS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Marks a database call as in flight; held by `AppState::db_call`.
pub fn activity() -> Activity {
    activity_epoch();
    ACTIVE_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Activity(())
}

/// How long the database has been quiet: zero while a call is in flight.
fn quiet_for() -> Duration {
    if ACTIVE_CALLS.load(std::sync::atomic::Ordering::SeqCst) > 0 {
        return Duration::ZERO;
    }
    let now = activity_epoch().elapsed().as_millis() as u64;
    let last = LAST_CALL_END_MS.load(std::sync::atomic::Ordering::SeqCst);
    Duration::from_millis(now.saturating_sub(last))
}

/// Sleeps until `schedule` lets the background check start.
fn wait_for_quiet(schedule: CheckSchedule) {
    let opened = std::time::Instant::now();
    std::thread::sleep(schedule.delay);
    loop {
        let quiet = quiet_for();
        if quiet >= schedule.idle || opened.elapsed() >= schedule.max_wait {
            return;
        }
        let rest = (schedule.idle - quiet).max(Duration::from_millis(50));
        std::thread::sleep(rest.min(schedule.max_wait.saturating_sub(opened.elapsed())));
    }
}

/// Path of the side file `<db file name><suffix>` next to `path`.
fn side_path(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| DB_FILE.to_string());
    path.with_file_name(format!("{name}{suffix}"))
}

/// Call when the app closes the database cleanly (after the last write).
/// Removes the running marker, so the next start may skip the background
/// check of a large database checked within [`CHECK_INTERVAL`].
pub fn note_clean_shutdown(path: &Path) {
    match std::fs::remove_file(side_path(path, RUNNING_SUFFIX)) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!(%err, "could not remove the database running marker"),
    }
}

/// True when a background check passed within [`CHECK_INTERVAL`].
fn checked_recently(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(side_path(path, CHECKED_SUFFIX)) else {
        return false;
    };
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(text.trim()) else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(at);
    age >= chrono::TimeDelta::zero() && age.to_std().is_ok_and(|age| age < CHECK_INTERVAL)
}

/// Applies the per-connection pragmas and registers the app's SQL functions.
/// `journal_size_limit` (64 MiB) truncates a WAL that an import grew back to
/// that size when the WAL is next reset; see also [`checkpoint_truncate`].
///
/// `cache_size` is 32 MiB per connection (SQLite's default is 2 MiB): a
/// broad search reads one `items` row per FTS match, and on a 215k-item
/// library the default cache missed on most of them. 32 MiB halved "blue",
/// "news" and "zzzz" (p50 25-30 -> 12-17 ms) for about 40 MB more peak
/// memory in `l3_search_perf`; 16 MiB gave almost nothing and 64 MiB little
/// more. The cache is private to each connection and fills only as pages are
/// read, so the pool's [`POOL_MAX`] connections hold at most 256 MiB.
/// `mmap_size` (pages shared through the OS cache) measured no gain.
///
/// Each connection caches [`STATEMENT_CACHE`] prepared statements instead of
/// rusqlite's 16: one Live scroll step alone uses 10-14 statements, and
/// moving between Live, VOD and Home cycles 40-60, so 16 slots evicted
/// statements still in use (DB-3).
pub fn configure(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.busy_handler(Some(busy_wait))?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    crate::catalog::language::register(conn)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA journal_size_limit=67108864; PRAGMA cache_size=-32768;",
    )?;
    Ok(())
}

/// Prepared statements cached per connection (see [`configure`]).
pub const STATEMENT_CACHE: usize = 64;

/// Opens a pool on `path` (max 8 connections, pragmas applied). Does not migrate;
/// see [`open_and_migrate`] for the boot path with recovery.
///
/// Connections are kept for the life of the pool (no idle timeout, no
/// maximum lifetime): r2d2's defaults closed idle ones after 10 minutes and
/// replaced every one after 30, and each new connection starts with a cold
/// 32 MiB page cache and no prepared statements (DB-4).
pub fn open(path: &Path) -> CoreResult<DbPool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let manager = SqliteConnectionManager::file(path).with_init(configure);
    let pool = r2d2::Pool::builder()
        .max_size(POOL_MAX)
        .min_idle(Some(1))
        .idle_timeout(None)
        .max_lifetime(None)
        .connection_timeout(Duration::from_secs(15))
        .build(manager)?;
    Ok(pool)
}

/// Applies pending migrations inside one IMMEDIATE transaction, tracked in
/// `schema_migrations`. Idempotent.
pub fn migrate(conn: &mut Connection) -> CoreResult<()> {
    // Index builds over a large table (a unique index on a multi-million-row
    // table) sort through temp storage: on disk here, not in memory, so an
    // upgrade does not take hundreds of MB before the window shows. The
    // pragma cannot change inside a transaction; restored afterwards. For the
    // same reason the page cache drops to SQLite's 2 MiB default (a 600k-row
    // guide upgrade otherwise fills the whole 32 MiB of [`configure`]).
    let cache: i64 = conn.query_row("PRAGMA cache_size", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA temp_store=FILE; PRAGMA cache_size=-2000;")?;
    let result = migrate_in_tx(conn);
    conn.execute_batch(&format!(
        "PRAGMA temp_store=MEMORY; PRAGMA cache_size={cache};"
    ))?;
    result
}

fn migrate_in_tx(conn: &mut Connection) -> CoreResult<()> {
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
    // Local builds before the origin rebase used 22 for download duration and 23 for its
    // rate limit. Origin uses those numbers for channel quality and the stream-format default.
    // The old database records only numbers, so identify that path by its actual columns and
    // apply the two origin migrations it would otherwise skip. Keep this inside the transaction:
    // a failed upgrade leaves both the schema and recorded versions untouched.
    if (22..=23).contains(&current)
        && has_column(&tx, "downloads", "duration_seconds")?
        && !has_column(&tx, "items", "quality")?
    {
        tx.execute_batch(MIGRATIONS[21].sql)?;
        if current == 23 {
            tx.execute_batch(MIGRATIONS[22].sql)?;
        }
    }
    for m in MIGRATIONS.iter().filter(|m| m.version > current) {
        tracing::info!(version = m.version, name = m.name, "applying migration");
        let already_present = match m.version {
            25 => has_column(&tx, "downloads", "duration_seconds")?,
            26 => has_column(&tx, "downloads", "rate_limit_bps")?,
            _ => false,
        };
        if !already_present {
            tx.execute_batch(m.sql)?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
            [m.version],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> CoreResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2 LIMIT 1",
            (table, column),
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
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
/// the first query that touches a bad page, so this runs on every boot: at
/// open for a small or flagged file, in the background for a large one.
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

/// Opens, checks and migrates `path`. The full check always runs; the quick
/// one only when the database is at most `sync_check_max_bytes`. Returns the
/// pool and whether a check ran.
fn try_open_and_migrate(
    path: &Path,
    full_check: bool,
    sync_check_max_bytes: u64,
) -> CoreResult<(DbPool, bool)> {
    // Validate and migrate on a dedicated connection first: a corrupt file fails
    // fast here instead of stalling inside the pool builder.
    let checked = {
        let mut conn = Connection::open(path)?;
        configure(&mut conn)?;
        conn.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0))?;
        let checked = full_check || database_bytes(&conn)? <= sync_check_max_bytes;
        if checked {
            check_integrity(&conn, full_check)?;
        }
        if schema_version(&conn)? > latest_version() {
            return Err(newer_schema_error());
        }
        migrate(&mut conn)?;
        checked
    };
    Ok((open(path)?, checked))
}

/// Size of the database the integrity check walks, WAL frames included.
fn database_bytes(conn: &Connection) -> CoreResult<u64> {
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    Ok((pages.max(0) as u64).saturating_mul(page_size.max(0) as u64))
}

/// Runs `quick_check` on its own read-only connection in a background thread,
/// when `schedule` allows, for a database too large to check at open. A
/// finding writes the recovery flag (see [`note_error`]), so the next boot
/// runs the full check and quarantines the file; a pass records its time
/// (see [`checked_recently`]).
fn spawn_background_check(
    path: &Path,
    schedule: CheckSchedule,
) -> Option<std::thread::JoinHandle<()>> {
    let path = path.to_path_buf();
    std::thread::Builder::new()
        .name("db-quick-check".into())
        .spawn(move || {
            wait_for_quiet(schedule);
            let started = std::time::Instant::now();
            let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI;
            let result = Connection::open_with_flags(&path, flags)
                .and_then(|conn| conn.busy_timeout(BUSY_TIMEOUT).map(|()| conn))
                .map_err(CoreError::from)
                .and_then(|conn| check_integrity(&conn, false));
            match result {
                Ok(()) => {
                    tracing::info!(
                        ms = started.elapsed().as_millis() as u64,
                        "background database check passed"
                    );
                    let stamp = chrono::Utc::now().to_rfc3339();
                    if let Err(err) = std::fs::write(side_path(&path, CHECKED_SUFFIX), stamp) {
                        tracing::warn!(%err, "could not record the database check");
                    }
                }
                // note_error logged the finding.
                Err(err) if note_error(&path, &err) => {}
                Err(err) => tracing::warn!(%err, "background database check did not run"),
            }
        })
        .map_err(|err| tracing::warn!(%err, "could not start the background database check"))
        .ok()
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

/// Boot path: open, check integrity, refuse a schema newer than this build,
/// and migrate. The check is `quick_check` at open for a database up to
/// 32 MiB, and the full `integrity_check` at open when a previous run flagged
/// corruption (see [`note_error`]). A larger database gets `quick_check` in a
/// background thread once the app is quiet (see [`CheckSchedule::BOOT`]; a
/// finding flags the next boot), unless the last run shut down cleanly (see
/// [`note_clean_shutdown`]) and a check passed within [`CHECK_INTERVAL`].
/// When the file is corrupt or not a database, quarantine it (see
/// [`quarantine`]), log a warning, and recreate an empty one.
pub fn open_and_migrate(path: &Path) -> CoreResult<DbPool> {
    open_and_migrate_with(path, SYNC_CHECK_MAX_BYTES, CheckSchedule::BOOT).map(|(pool, _)| pool)
}

/// [`open_and_migrate`] with the size limit of the check at open and the
/// schedule of the background check as parameters. Returns the background
/// check's thread when one started.
fn open_and_migrate_with(
    path: &Path,
    sync_check_max_bytes: u64,
    schedule: CheckSchedule,
) -> CoreResult<(DbPool, Option<std::thread::JoinHandle<()>>)> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let running = side_path(path, RUNNING_SUFFIX);
    let unclean = running.exists();
    let flag = recovery_flag_path(path);
    let flagged = flag.exists();
    if flagged {
        tracing::warn!("previous run reported database corruption; running a full integrity check");
    }
    let result = match try_open_and_migrate(path, flagged, sync_check_max_bytes) {
        Ok(opened) => Ok(opened),
        Err(err) if is_corruption(&err) => {
            let moved = quarantine(path)?;
            // The last pass was of the file just moved aside.
            let _ = std::fs::remove_file(side_path(path, CHECKED_SUFFIX));
            tracing::warn!(error = %err, backup = %moved.display(), "database was corrupt; moved aside and recreating");
            try_open_and_migrate(path, false, sync_check_max_bytes)
        }
        Err(err) => Err(err),
    };
    if flagged && result.is_ok() {
        if let Err(err) = std::fs::remove_file(&flag) {
            tracing::warn!(%err, "could not remove the database recovery flag");
        }
    }
    let (pool, checked) = result?;
    if let Err(err) = std::fs::write(&running, chrono::Utc::now().to_rfc3339()) {
        tracing::warn!(%err, "could not write the database running marker");
    }
    let background = if checked {
        None
    } else if !unclean && checked_recently(path) {
        tracing::info!("background database check skipped: clean shutdown and a recent pass");
        None
    } else {
        spawn_background_check(path, schedule)
    };
    Ok((pool, background))
}

/// Checkpoints the WAL into the database and truncates it to zero bytes,
/// after a large write (a catalog import) grew it. Never blocks: when a
/// reader or writer is busy the checkpoint does what it can and the WAL is
/// truncated by a later one. Errors are logged, never returned.
pub fn checkpoint_truncate(conn: &Connection) {
    // Without a busy handler a busy reader or writer makes the checkpoint
    // fall back to a passive one (busy = 1) instead of waiting for it.
    if conn.busy_handler(None).is_err() {
        return;
    }
    match conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    }) {
        Ok((busy, pages)) => tracing::debug!(busy, pages, "wal checkpoint after import"),
        Err(err) => tracing::debug!(%err, "wal checkpoint after import skipped"),
    }
    let _ = conn.busy_handler(Some(busy_wait));
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
    /// Every guide statement over `epg_programs` searches an index instead of
    /// scanning the table (0008 dropped the epg_url index).
    #[test]
    fn guide_queries_use_an_index_after_all_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let pool = super::open_and_migrate(&dir.path().join("plan.db")).unwrap();
        let conn = pool.get().unwrap();
        let statements = [
            // epg/query.rs `rows` (the guide grid, now/next and programs): the
            // feed pick, then that feed's programme before and inside the range.
            crate::epg::query::FEED_SQL,
            crate::epg::query::BEFORE_SQL,
            crate::epg::query::INSIDE_SQL,
            // epg/resolve.rs: does a channel have programmes.
            "SELECT 1 FROM epg_programs WHERE channel_id = ?1 LIMIT 1",
            // epg/store.rs: replace, clear and remove a feed.
            "DELETE FROM epg_programs WHERE epg_url = ?1",
            "SELECT count(*) FROM epg_programs WHERE epg_url = ?1",
            // epg/search.rs: guide search through the title index, and its fallback scan.
            crate::epg::search::FTS_SQL,
            crate::epg::search::SCAN_SQL,
        ];
        for sql in statements {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let args = vec![rusqlite::types::Null; stmt.parameter_count()];
            let plan: Vec<String> = stmt
                .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let programmes: Vec<&String> = plan
                .iter()
                .filter(|d| matches!(d.split_whitespace().nth(1), Some("p" | "epg_programs")))
                .collect();
            assert!(!programmes.is_empty(), "{sql}: {plan:?}");
            // The search reads each FTS hit's programme by rowid: `USING INTEGER PRIMARY KEY`.
            for d in programmes {
                assert!(
                    d.starts_with("SEARCH") && (d.contains("INDEX") || d.contains("PRIMARY KEY")),
                    "{sql} does not use an index: {plan:?}"
                );
            }
        }
    }

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

    /// Versions run 1, 2, 3... without gaps, and each name starts with its
    /// zero-padded version (the file name convention `NNNN_name.sql`).
    #[test]
    fn migration_list_is_contiguous_and_named_by_version() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1, "{} is out of sequence", m.name);
            assert!(
                m.name.starts_with(&format!("{:04}_", m.version)),
                "{} does not start with its version",
                m.name
            );
        }
        assert_eq!(latest_version(), MIGRATIONS.len() as i64);
    }

    /// Run 2 slots: each file sits at its contract number, so builders that
    /// fill them in parallel never renumber one another's migration.
    #[test]
    fn run2_migration_slots_are_reserved() {
        let names: Vec<&str> = MIGRATIONS.iter().map(|m| m.name).collect();
        for (version, name) in [
            (13, "0013_catalog_edits"),
            (14, "0014_custom_lists"),
            (15, "0015_guide"),
            (16, "0016_watch_log"),
        ] {
            assert_eq!(
                names.get(version - 1).copied(),
                Some(name),
                "migration {version} is {name}"
            );
        }
        assert!(latest_version() >= 16);
    }

    /// Run 3 slot: the image cache index sits at 17, right after Run 2's last
    /// migration.
    #[test]
    fn run3_migration_slot_is_reserved() {
        let names: Vec<&str> = MIGRATIONS.iter().map(|m| m.name).collect();
        assert_eq!(names.get(16).copied(), Some("0017_image_cache"));
        assert_eq!(MIGRATIONS[16].version, 17);
        assert!(latest_version() >= 17);
    }

    /// A database left at any earlier version (including one that stopped
    /// before a migration that is only a comment) upgrades to the latest.
    #[test]
    fn every_earlier_version_upgrades_to_latest() {
        for stop in 1..MIGRATIONS.len() {
            let mut conn = Connection::open_in_memory().unwrap();
            configure(&mut conn).unwrap();
            for m in &MIGRATIONS[..stop] {
                conn.execute_batch(m.sql).unwrap();
                conn.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                    [m.version],
                )
                .unwrap();
            }
            assert_eq!(schema_version(&conn).unwrap(), stop as i64);
            migrate(&mut conn).unwrap_or_else(|e| panic!("upgrade from v{stop}: {e}"));
            assert_eq!(schema_version(&conn).unwrap(), latest_version());
            let recorded: i64 = conn
                .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
                .unwrap();
            assert_eq!(recorded, latest_version(), "every version is recorded once");
        }
    }

    #[test]
    fn download_rate_migration_preserves_existing_progress_and_inherits_default() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&mut conn).unwrap();
        for m in MIGRATIONS.iter().filter(|m| m.version <= 25) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                [m.version],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO downloads (source_id, content_type, item_id, title, url, status, bytes_downloaded, duration_seconds, file_path) VALUES ('s', 'live', '1', 'News', 'http://example.test/archive.ts', 'paused', 123456, 1800, '/saved/News.ts')", []).unwrap();
        migrate(&mut conn).unwrap();
        let row = crate::downloads::store::get(&conn, 1).unwrap().download;
        assert_eq!(row.rate_limit_bps, None);
        assert_eq!(row.bytes_downloaded, 123456);
        assert_eq!(row.duration_seconds, Some(1800));
        assert_eq!(row.status, crate::model::DownloadStatus::Paused);
        assert_eq!(row.file_path.as_deref(), Some("/saved/News.ts"));
    }

    #[test]
    fn upgrades_pre_rebase_download_migrations_without_losing_data() {
        for old_version in [22, 23] {
            let mut conn = Connection::open_in_memory().unwrap();
            configure(&mut conn).unwrap();
            for m in MIGRATIONS.iter().filter(|m| m.version <= 21) {
                conn.execute_batch(m.sql).unwrap();
                conn.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                    [m.version],
                )
                .unwrap();
            }
            conn.execute_batch(include_str!("migrations/0025_download_duration.sql"))
                .unwrap();
            conn.execute("INSERT INTO schema_migrations(version) VALUES (22)", [])
                .unwrap();
            if old_version == 23 {
                conn.execute_batch(include_str!("migrations/0026_download_rate_limit.sql"))
                    .unwrap();
                conn.execute("INSERT INTO schema_migrations(version) VALUES (23)", [])
                    .unwrap();
            }
            conn.execute("INSERT INTO downloads (source_id, content_type, item_id, title, url, status, bytes_downloaded, duration_seconds) VALUES ('s', 'live', '1', 'News', 'http://example.test/archive.ts', 'paused', 123456, 1800)", []).unwrap();
            if old_version == 23 {
                conn.execute(
                    "UPDATE downloads SET rate_limit_bps = 512000 WHERE id = 1",
                    [],
                )
                .unwrap();
            }

            migrate(&mut conn).unwrap();
            assert_eq!(schema_version(&conn).unwrap(), latest_version());
            assert!(has_column(&conn, "items", "quality").unwrap());
            assert!(has_column(&conn, "downloads", "duration_seconds").unwrap());
            assert!(has_column(&conn, "downloads", "rate_limit_bps").unwrap());
            let row = crate::downloads::store::get(&conn, 1).unwrap().download;
            assert_eq!(row.bytes_downloaded, 123456);
            assert_eq!(row.duration_seconds, Some(1800));
            assert_eq!(row.rate_limit_bps, (old_version == 23).then_some(512_000));
            migrate(&mut conn).unwrap();
        }
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
        let has_index = |name: &str| -> bool {
            conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [name],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                == 1
        };
        // 0007's unique slot index replaces 0003's epg_url index (0008).
        assert!(
            has_index("idx_epg_programs_slot"),
            "0007 adds the slot index"
        );
        assert!(
            !has_index("idx_epg_programs_url"),
            "0008 drops the redundant epg_url index"
        );
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
        let rank: (String, String, i64, i64, i64) = conn
            .query_row(
                "SELECT r.source_id, r.content_type, r.title_len, r.position, r.quality FROM items_rank r JOIN items i ON i.rowid = r.id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            rank,
            ("s".into(), "live".into(), 10, 0, -1),
            "items_rank follows an insert (quality not computed yet)"
        );
        conn.execute("UPDATE items SET title = 'BBC One', position = 4", [])
            .unwrap();
        let rank: (i64, i64) = conn
            .query_row("SELECT title_len, position FROM items_rank", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(rank, (7, 4), "items_rank follows an update");
        // The quality backfill writes the column alone (migration 0022).
        conn.execute("UPDATE items SET quality = 2 WHERE item_id = '1'", [])
            .unwrap();
        let quality: i64 = conn
            .query_row("SELECT quality FROM items_rank", [], |r| r.get(0))
            .unwrap();
        assert_eq!(quality, 2, "items_rank follows a quality update");
        conn.execute("DELETE FROM sources WHERE id = 's'", [])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "ON DELETE CASCADE removes items");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM items_rank", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "and their items_rank rows");
    }

    /// 0022 appends `quality` to the live page, count and guide indexes and
    /// leaves their other columns as they were; rows written before it read
    /// -1 (not computed yet) in `items` and `items_rank`.
    #[test]
    fn channel_quality_migration_extends_the_live_indexes() {
        const INDEXES: [&str; 4] = [
            "idx_items_cat",
            "idx_items_pos",
            "idx_items_title",
            "idx_items_guide",
        ];
        let mut conn = Connection::open_in_memory().unwrap();
        for m in &MIGRATIONS[..21] {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                [m.version],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO sources(id, kind, name, config_json) VALUES ('s', 'm3u', 'S', '{}');
             INSERT INTO items(source_id, content_type, item_id, category_id, title) VALUES ('s', 'live', '1', 'g', 'BBC One HD');",
        )
        .unwrap();
        let index_sql = |conn: &Connection| -> Vec<String> {
            INDEXES
                .iter()
                .map(|name| {
                    conn.query_row(
                        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                        [name],
                        |r| r.get(0),
                    )
                    .unwrap()
                })
                .collect()
        };
        let before = index_sql(&conn);
        // Unconfigured: the migration calls no app SQL function.
        migrate(&mut conn).unwrap();
        for (old, new) in before.iter().zip(&index_sql(&conn)) {
            assert_eq!(*new, old.replacen(')', ", quality)", 1));
        }
        let stored: (i64, i64) = conn
            .query_row(
                "SELECT i.quality, r.quality FROM items i JOIN items_rank r ON r.id = i.rowid",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, (-1, -1));
    }

    /// 0023 moves a stored "m3u8" (the old default) to "auto" once; any other
    /// value, a document without the field, and an HLS pick made after the
    /// upgrade stay as they are.
    #[test]
    fn stream_format_migration_moves_the_old_default_to_auto_once() {
        let stored_after_upgrade = |json: &str| -> String {
            let mut conn = Connection::open_in_memory().unwrap();
            configure(&mut conn).unwrap();
            for m in &MIGRATIONS[..22] {
                conn.execute_batch(m.sql).unwrap();
                conn.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
                    [m.version],
                )
                .unwrap();
            }
            conn.execute("INSERT INTO settings(id, json) VALUES (1, ?1)", [json])
                .unwrap();
            migrate(&mut conn).unwrap();
            conn.query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get(0))
                .unwrap()
        };
        let format = |json: &str| -> Option<String> {
            serde_json::from_str::<serde_json::Value>(json).unwrap()["streamFormat"]
                .as_str()
                .map(str::to_string)
        };
        let moved = stored_after_upgrade(r#"{"streamFormat":"m3u8","theme":"dark"}"#);
        assert_eq!(format(&moved).as_deref(), Some("auto"));
        assert!(
            moved.contains(r#""theme":"dark""#),
            "other fields stay: {moved}"
        );
        let ts = stored_after_upgrade(r#"{"streamFormat":"ts"}"#);
        assert_eq!(format(&ts).as_deref(), Some("ts"));
        assert_eq!(format(&stored_after_upgrade(r#"{"theme":"dark"}"#)), None);
        assert_eq!(stored_after_upgrade("not json"), "not json");

        // Migrated once: HLS picked afterwards survives the next start.
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO settings(id, json) VALUES (1, '{\"streamFormat\":\"m3u8\"}')",
            [],
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let kept: String = conn
            .query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(format(&kept).as_deref(), Some("m3u8"));
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

    fn corrupt_backups(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("iptv.db.corrupt-")
            })
            .count()
    }

    /// Writes about 4 MB of `app_state` rows to a fresh database at `path`
    /// and checkpoints, so the middle of the main file is table pages.
    fn populate(path: &Path) {
        let pool = open_and_migrate(path).unwrap();
        let mut conn = pool.get().unwrap();
        let tx = conn.transaction().unwrap();
        let value = "v".repeat(2000);
        for i in 0..2000 {
            tx.execute(
                "INSERT INTO app_state(key, value) VALUES (?1, ?2)",
                rusqlite::params![format!("k{i}"), value],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }

    /// Overwrites 64 KiB in the middle of the file with garbage; the header
    /// stays valid.
    fn corrupt_middle(path: &Path) {
        use std::io::{Seek, SeekFrom, Write};
        let len = std::fs::metadata(path).unwrap().len();
        let mut f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.seek(SeekFrom::Start(len / 2)).unwrap();
        let garbage: Vec<u8> = (0..64 * 1024u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        f.write_all(&garbage).unwrap();
        f.sync_all().unwrap();
    }

    /// Waits at most 30 s for the background check to finish.
    fn join_bounded(handle: std::thread::JoinHandle<()>) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !handle.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "background check still running after 30 s"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        handle.join().unwrap();
    }

    /// Background check at once, quiet or not.
    const NOW: CheckSchedule = CheckSchedule {
        delay: Duration::ZERO,
        idle: Duration::ZERO,
        max_wait: Duration::ZERO,
    };

    /// L3-perf-core-7: after a clean shutdown and a pass within the
    /// interval, the next start skips the background check; an unclean
    /// shutdown or a stale pass runs it again.
    #[test]
    fn background_check_is_skipped_only_after_clean_shutdown_and_recent_pass() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        populate(&path);
        let checked = side_path(&path, CHECKED_SUFFIX);

        // First start: never checked.
        note_clean_shutdown(&path);
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        join_bounded(check.expect("no pass recorded yet"));
        assert!(checked.exists(), "a pass is recorded");
        drop(pool);

        // Clean shutdown, recent pass: skipped.
        note_clean_shutdown(&path);
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        assert!(check.is_none(), "skipped after a clean shutdown");
        drop(pool);

        // No clean shutdown (a crash): checked again.
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        join_bounded(check.expect("checked after an unclean shutdown"));
        drop(pool);

        // Clean shutdown but the last pass is 8 days old: checked again.
        note_clean_shutdown(&path);
        let old = chrono::Utc::now() - chrono::TimeDelta::days(8);
        std::fs::write(&checked, old.to_rfc3339()).unwrap();
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        join_bounded(check.expect("checked when the last pass is stale"));
        drop(pool);
        assert!(!recovery_flag_path(&path).exists());
    }

    /// Broad searches need more than SQLite's default 2 MiB page cache (see
    /// [`configure`]); `migrate` runs on the default and gives it back.
    #[test]
    fn connections_get_a_32_mib_page_cache() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&mut conn).unwrap();
        let size =
            |c: &Connection| -> i64 { c.query_row("PRAGMA cache_size", [], |r| r.get(0)).unwrap() };
        assert_eq!(size(&conn), -32768);
        migrate(&mut conn).unwrap();
        assert_eq!(size(&conn), -32768, "restored after the migrations");
    }

    /// The desktop and server shells call `note_clean_shutdown` on exit: it
    /// removes the running marker written at open, and does nothing once the
    /// marker is gone.
    #[test]
    fn clean_shutdown_removes_the_running_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let pool = open_and_migrate(&path).unwrap();
        let running = side_path(&path, RUNNING_SUFFIX);
        assert!(running.exists(), "written at open");
        note_clean_shutdown(&path);
        assert!(!running.exists(), "removed on a clean shutdown");
        note_clean_shutdown(&path);
        assert!(!running.exists());
        drop(pool);
    }

    /// L3-perf-core-7: the background check does not start while a database
    /// call is in flight, and starts once the database is quiet.
    #[test]
    fn background_check_waits_for_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        populate(&path);
        let checked = side_path(&path, CHECKED_SUFFIX);
        let busy = activity();
        let schedule = CheckSchedule {
            delay: Duration::ZERO,
            idle: Duration::from_millis(200),
            max_wait: Duration::from_secs(20),
        };
        let (pool, check) = open_and_migrate_with(&path, 0, schedule).unwrap();
        let check = check.expect("a background check is scheduled");
        std::thread::sleep(Duration::from_millis(800));
        assert!(!check.is_finished(), "waits while a call is in flight");
        assert!(!checked.exists());
        drop(busy);
        join_bounded(check);
        assert!(checked.exists(), "ran once the database was quiet");
        drop(pool);
    }

    /// A database over the size limit opens without the check (the corrupt
    /// file stays in place); the background check then flags it, and the
    /// next boot quarantines it.
    #[test]
    fn large_db_is_checked_in_background_and_flagged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        populate(&path);
        corrupt_middle(&path);
        let flag = recovery_flag_path(&path);

        // Limit 0: every database counts as large.
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        assert_eq!(corrupt_backups(dir.path()), 0, "not checked at open");
        let rows: i64 = pool
            .get()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "the pool is usable before the check");
        let check = check.expect("a background check started");
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !flag.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "background check did not flag the corrupt page within 30 s"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        join_bounded(check);
        drop(pool);

        // The flagged boot runs the full check at open (even with limit 0)
        // and recovers. The recreated file is checked in the background.
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        assert_eq!(corrupt_backups(dir.path()), 1, "corrupt file moved aside");
        join_bounded(check.expect("the new file counts as large too"));
        assert!(!flag.exists(), "flag cleared after recovery");
        let rows: i64 = pool
            .get()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "a fresh database replaced the corrupt one");
    }

    /// A healthy large database passes the background check: no flag, data kept.
    #[test]
    fn healthy_large_db_background_check_writes_no_flag() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        populate(&path);
        let (pool, check) = open_and_migrate_with(&path, 0, NOW).unwrap();
        join_bounded(check.expect("a background check started"));
        assert!(!recovery_flag_path(&path).exists());
        let rows: i64 = pool
            .get()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2000);
        assert_eq!(corrupt_backups(dir.path()), 0);
    }

    /// Under the size limit the check still runs at open: a corrupt page is
    /// quarantined before the pool opens and no background check starts.
    #[test]
    fn small_corrupt_db_is_still_quarantined_at_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        populate(&path);
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(len > 1_000_000 && len < SYNC_CHECK_MAX_BYTES, "{len} bytes");
        corrupt_middle(&path);

        let (pool, check) =
            open_and_migrate_with(&path, SYNC_CHECK_MAX_BYTES, CheckSchedule::BOOT).unwrap();
        assert!(check.is_none(), "checked at open, not in the background");
        assert_eq!(corrupt_backups(dir.path()), 1);
        let rows: i64 = pool
            .get()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn timestamp_normalization() {
        assert_eq!(to_rfc3339("2026-10-11 02:30:00"), "2026-10-11T02:30:00Z");
        assert_eq!(to_rfc3339("2026-10-11T02:30:00Z"), "2026-10-11T02:30:00Z");
        assert!(now_rfc3339().ends_with('Z'));
    }
}
