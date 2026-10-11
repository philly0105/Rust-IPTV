//! Database boot recovery: a file with a valid header but garbage pages is
//! quarantined at open, a runtime corruption error flags the next boot for a
//! full check, and a schema newer than this build is refused.

use iptv_core::db::{
    self, latest_version, note_error, open_and_migrate, recovery_flag_path, schema_version,
    DB_FILE, NEWER_SCHEMA_MESSAGE,
};
use iptv_core::{AppState, CoreError, NoopSink};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;

fn corrupt_backups(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("iptv.db.corrupt-"))
        .collect()
}

/// Fills `app_state` with about 4 MB so the middle of the file is table pages.
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
    drop(conn);
    drop(pool);
}

#[test]
fn garbage_pages_mid_file_are_quarantined_at_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    populate(&path);

    let len = std::fs::metadata(&path).unwrap().len();
    assert!(len > 1_000_000, "test database is big enough ({len} bytes)");
    {
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start(len / 2)).unwrap();
        let garbage: Vec<u8> = (0..64 * 1024u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        f.write_all(&garbage).unwrap();
        f.sync_all().unwrap();
    }
    // The header is intact: a plain open and schema read still succeed.
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0))
            .unwrap();
    }

    let pool = open_and_migrate(&path).unwrap();
    let conn = pool.get().unwrap();
    assert_eq!(schema_version(&conn).unwrap(), latest_version());
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0, "a fresh, empty database replaced the corrupt one");
    let ok: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ok, "ok");
    assert_eq!(
        corrupt_backups(dir.path()).len(),
        1,
        "corrupt file kept aside"
    );
}

#[test]
fn runtime_corruption_flags_next_boot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    populate(&path);

    // Non-corruption errors never write the flag.
    assert!(!note_error(&path, &CoreError::invalid("x")));
    assert!(!note_error(
        &path,
        &CoreError::Db(rusqlite::Error::QueryReturnedNoRows)
    ));
    assert!(!recovery_flag_path(&path).exists());

    let corrupt = CoreError::Db(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
        Some("database disk image is malformed".into()),
    ));
    assert!(note_error(&path, &corrupt));
    let flag = recovery_flag_path(&path);
    assert!(flag.exists());
    assert!(flag.to_string_lossy().ends_with("iptv.db.needs-recovery"));

    // A healthy file passes the full check: data kept, flag cleared.
    let pool = open_and_migrate(&path).unwrap();
    let rows: i64 = pool
        .get()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 2000);
    drop(pool);
    assert!(!flag.exists(), "flag removed after a clean check");
    assert!(corrupt_backups(dir.path()).is_empty());
}

#[test]
fn newer_schema_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    {
        let pool = open_and_migrate(&path).unwrap();
        pool.get()
            .unwrap()
            .execute(
                "INSERT INTO schema_migrations(version) VALUES (?1)",
                [latest_version() + 1],
            )
            .unwrap();
    }
    let err = open_and_migrate(&path).map(|_| ()).unwrap_err();
    assert!(err.to_string().contains(NEWER_SCHEMA_MESSAGE), "{err}");
    // Refused, not quarantined: the user's data stays where it is.
    assert!(path.exists());
    assert!(corrupt_backups(dir.path()).is_empty());

    // `migrate` on its own refuses too.
    let mut c = rusqlite::Connection::open(&path).unwrap();
    assert!(db::migrate(&mut c).is_err());
}

#[tokio::test]
async fn newer_schema_fails_startup_with_a_clear_message() {
    let dir = tempfile::tempdir().unwrap();
    {
        let pool = open_and_migrate(&dir.path().join(DB_FILE)).unwrap();
        pool.get()
            .unwrap()
            .execute(
                "INSERT INTO schema_migrations(version) VALUES (?1)",
                [latest_version() + 5],
            )
            .unwrap();
    }
    let err = AppState::new(dir.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .map(|_| ())
        .unwrap_err();
    assert_eq!(err.to_string(), NEWER_SCHEMA_MESSAGE);
}

#[tokio::test]
async fn db_call_corruption_error_flags_next_boot() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), Arc::new(NoopSink), false)
        .await
        .unwrap();
    let flag = recovery_flag_path(&state.db_path());

    // An ordinary error leaves no flag.
    let err = state
        .db_call(|_| -> iptv_core::CoreResult<()> { Err(CoreError::invalid("nope")) })
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(!flag.exists());

    // A corruption error is returned unchanged and flags the next boot.
    let err = state
        .db_call(|_| -> iptv_core::CoreResult<()> {
            Err(CoreError::Db(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                Some("database disk image is malformed".into()),
            )))
        })
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Db(_)), "{err:?}");
    assert!(flag.exists(), "db_call must flag runtime corruption");

    // The same goes for paths that use the pool directly.
    std::fs::remove_file(&flag).unwrap();
    let _ = state.note_db_error(CoreError::Db(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
        None,
    )));
    assert!(flag.exists());
}
