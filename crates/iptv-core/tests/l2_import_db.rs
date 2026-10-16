//! WAL size after imports (L2-perf-core-12): every connection caps the WAL
//! with `journal_size_limit`, and `checkpoint_truncate` empties a WAL that an
//! import grew, without waiting for readers.

use iptv_core::db::{checkpoint_truncate, configure, open_and_migrate, DB_FILE};
use rusqlite::Connection;
use std::path::Path;
use std::time::{Duration, Instant};

const LIMIT: i64 = 64 * 1024 * 1024;

fn connect(path: &Path) -> Connection {
    let mut conn = Connection::open(path).unwrap();
    configure(&mut conn).unwrap();
    conn
}

fn wal_len(path: &Path) -> u64 {
    let wal = path.with_file_name(format!("{DB_FILE}-wal"));
    std::fs::metadata(wal).map(|m| m.len()).unwrap_or(0)
}

/// Writes about 8 MB in one transaction, as an import does.
fn grow_wal(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS blobs(id INTEGER PRIMARY KEY, data BLOB);
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
         INSERT INTO blobs(data) SELECT randomblob(4000) FROM n;",
    )
    .unwrap();
}

#[test]
fn configure_sets_journal_size_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    let limit: i64 = connect(&path)
        .query_row("PRAGMA journal_size_limit", [], |r| r.get(0))
        .unwrap();
    assert_eq!(limit, LIMIT);

    // Pooled connections get it too.
    let pool = open_and_migrate(&path).unwrap();
    let limit: i64 = pool
        .get()
        .unwrap()
        .query_row("PRAGMA journal_size_limit", [], |r| r.get(0))
        .unwrap();
    assert_eq!(limit, LIMIT);
}

#[test]
fn checkpoint_truncate_empties_a_grown_wal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    let conn = connect(&path);
    grow_wal(&conn);
    assert!(wal_len(&path) > 4_000_000, "WAL grew: {}", wal_len(&path));

    checkpoint_truncate(&conn);
    assert_eq!(wal_len(&path), 0, "WAL truncated to zero bytes");
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 2000, "checkpointed data is kept");
}

#[test]
fn checkpoint_truncate_does_not_wait_for_a_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    let writer = connect(&path);
    // Keep the frames un-checkpointed, so the reader reads them from the WAL
    // (a reader of a fully checkpointed WAL reads the main file and does not
    // hold it).
    writer.execute_batch("PRAGMA wal_autocheckpoint=0").unwrap();
    grow_wal(&writer);

    let reader = connect(&path);
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))
        .unwrap();

    // With the busy handler on, a TRUNCATE checkpoint waits up to 5 s for
    // the reader to finish.
    let started = Instant::now();
    checkpoint_truncate(&writer);
    let took = started.elapsed();
    assert!(took < Duration::from_secs(2), "blocked for {took:?}");
    assert!(wal_len(&path) > 0, "the reader still uses the WAL");

    reader.execute_batch("COMMIT").unwrap();
    checkpoint_truncate(&writer);
    assert_eq!(wal_len(&path), 0, "a later checkpoint truncates it");
}

/// The connection's busy handler is back afterwards: a write that meets
/// another writer's lock waits for it instead of failing at once.
#[test]
fn checkpoint_truncate_restores_the_busy_handler() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    let conn = connect(&path);
    conn.execute_batch("CREATE TABLE t(x)").unwrap();
    checkpoint_truncate(&conn);

    let other = connect(&path);
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let holder = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        other.execute_batch("COMMIT").unwrap();
    });
    conn.execute("INSERT INTO t(x) VALUES (1)", [])
        .expect("the insert waits for the other writer");
    holder.join().unwrap();
}
