//! The disk store and its index: lookups, the single writer task (inserts,
//! touches, forgets, eviction, clear) and the startup reconcile scan.
//!
//! Every write to `image_cache` goes through [`run`], which drains whatever
//! is queued (up to [`MAX_BATCH`] operations) into one IMMEDIATE transaction.
//! Files are deleted only after the transaction commits, so a crash leaves
//! at worst a file without a row, which the next reconcile removes.
//!
//! The running byte total covers this process's writes only. Another process
//! on the same data dir (the desktop app plus an `iptv-server --data-dir`
//! pointed at it, or two servers) adds rows it never sees, so the writer
//! re-reads `SUM(bytes)` inside its transaction on every `images.stats`
//! barrier and, while inserting, at least every [`RESYNC_INTERVAL`]. Their
//! combined total therefore goes over the cap by at most what they insert
//! between two resyncs, instead of by a whole cap per process.

use super::{file_path, is_key, max_bytes, Flights, EVICT_TARGET_PERCENT, MAX_IMAGE_BYTES};
use crate::db::{self, DbPool};
use crate::error::{CoreError, CoreResult};
use crate::model::Settings;
use parking_lot::RwLock;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{mpsc, oneshot};

/// Operations applied in one transaction at most.
const MAX_BATCH: usize = 256;
/// Longest time an inserting writer trusts its running total before it
/// re-reads `SUM(bytes)` (rows other processes added are not in it).
pub(super) const RESYNC_INTERVAL: Duration = Duration::from_secs(60);
/// Files younger than this are left alone by the reconcile: a fetch may be
/// between its rename and its row's commit.
const RECONCILE_GRACE: Duration = Duration::from_secs(10 * 60);
/// The table, as in migration 0017 (`IF NOT EXISTS` throughout).
const SCHEMA: &str = include_str!("../db/migrations/0017_image_cache.sql");

/// A new index row.
pub(super) struct Row {
    pub key: String,
    pub url: String,
    pub content_type: String,
    pub bytes: u64,
    /// Unix seconds; both `created_at` and `last_access`.
    pub at: i64,
}

/// One queued write.
pub(super) enum Op {
    /// Index a stored file; `ack` fires once the row is committed.
    Insert { row: Row, ack: oneshot::Sender<()> },
    /// Move `last_access` forward.
    Touch { key: String, at: i64 },
    /// Drop rows whose file is missing or has the wrong size (re-checked
    /// here, so a stale report never removes a row that was just refreshed).
    Forget { keys: Vec<String> },
    /// Barrier for `stats`: evicts down to the cap when over it.
    Evict {
        ack: oneshot::Sender<CoreResult<()>>,
    },
    /// Delete every row and file.
    Clear {
        ack: oneshot::Sender<CoreResult<()>>,
    },
}

/// What [`lookup`] found.
pub(super) enum Lookup {
    Hit {
        content_type: String,
        bytes: u64,
        last_access: i64,
    },
    /// A row whose file is missing or has the wrong size.
    Stale,
    Miss,
}

fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// Creates the table when a data dir was migrated while slot 0017 was a
/// placeholder, then returns `SUM(bytes)`.
pub(super) fn prepare(conn: &mut Connection) -> CoreResult<u64> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_cache'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        conn.execute_batch(SCHEMA)?;
    }
    Ok(totals(conn)?.0)
}

/// `(SUM(bytes), COUNT(*))` of the index.
pub(super) fn totals(conn: &mut Connection) -> CoreResult<(u64, u64)> {
    let (bytes, files): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(bytes), 0), COUNT(*) FROM image_cache",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((to_u64(bytes), to_u64(files)))
}

/// `SUM(bytes)` of the index, every process's rows included.
fn byte_total(conn: &Connection) -> CoreResult<u64> {
    let sum: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM image_cache", [], |r| {
        r.get(0)
    })?;
    Ok(to_u64(sum))
}

/// The row of `key`, checked against its file.
pub(super) fn lookup(conn: &mut Connection, dir: &Path, key: &str) -> CoreResult<Lookup> {
    let row = conn
        .query_row(
            "SELECT content_type, bytes, last_access FROM image_cache WHERE key = ?1",
            [key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((content_type, bytes, last_access)) = row else {
        return Ok(Lookup::Miss);
    };
    let bytes = to_u64(bytes);
    Ok(match fs::metadata(file_path(dir, key)) {
        Ok(m) if m.is_file() && m.len() == bytes => Lookup::Hit {
            content_type,
            bytes,
            last_access,
        },
        _ => Lookup::Stale,
    })
}

/// Every `(key, bytes)` of the index.
pub(super) fn all_rows(conn: &mut Connection) -> CoreResult<HashMap<String, u64>> {
    let mut stmt = conn.prepare("SELECT key, bytes FROM image_cache")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (key, bytes) = row?;
        out.insert(key, to_u64(bytes));
    }
    Ok(out)
}

/// Writes `body` to a temp name next to its final path, then renames it
/// into place (replacing an older copy). Returns the final path.
pub(super) async fn write_file(dir: &Path, key: &str, body: Vec<u8>) -> CoreResult<PathBuf> {
    let sub = dir.join(&key[..2]);
    let path = sub.join(key);
    let tmp = sub.join(format!("{key}.{:016x}.tmp", rand::random::<u64>()));
    tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&sub)?;
        if let Err(err) = fs::write(&tmp, &body).and_then(|()| fs::rename(&tmp, &path)) {
            let _ = fs::remove_file(&tmp);
            return Err(CoreError::Io(std::io::Error::new(
                err.kind(),
                format!("could not write to the image cache: {err}"),
            )));
        }
        Ok(path)
    })
    .await?
}

/// The writer task's state.
pub(super) struct Writer {
    pub pool: DbPool,
    pub db_path: PathBuf,
    pub dir: PathBuf,
    pub settings: Arc<RwLock<Settings>>,
    pub flights: Flights,
    /// Running `SUM(bytes)`, kept by this task alone: its own writes, plus
    /// whatever other processes had written at the last resync.
    pub total: u64,
    /// When `total` was last read from the table.
    pub synced_at: Instant,
}

/// The writer loop: one batch at a time until every sender is gone and the
/// queue is drained.
pub(super) async fn run(mut w: Writer, mut rx: mpsc::UnboundedReceiver<Op>) {
    while let Some(first) = rx.recv().await {
        let mut ops = vec![first];
        while ops.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(op) => ops.push(op),
                Err(_) => break,
            }
        }
        let barrier = ops.iter().any(|o| matches!(o, Op::Evict { .. }));
        let inserting = ops.iter().any(|o| matches!(o, Op::Insert { .. }));
        let resync = barrier || (inserting && w.synced_at.elapsed() >= RESYNC_INTERVAL);
        let cap = max_bytes(&w.settings.read());
        // Files of running fetches survive a clear or an eviction of their
        // key: the fetch may have renamed a fresh copy into place already.
        let protected: HashSet<String> = w
            .flights
            .lock()
            .keys()
            .filter_map(|k| k.split('|').next())
            .map(str::to_owned)
            .collect();
        let batch = Batch {
            pool: w.pool.clone(),
            db_path: w.db_path.clone(),
            dir: w.dir.clone(),
            total: w.total,
            cap,
            protected,
            resync,
        };
        match tokio::task::spawn_blocking(move || batch.apply(ops)).await {
            Ok(applied) => {
                w.total = applied.total;
                if applied.synced {
                    w.synced_at = Instant::now();
                }
            }
            Err(err) => tracing::error!(%err, "image cache write batch panicked"),
        }
    }
}

/// One batch of writes.
struct Batch {
    pool: DbPool,
    db_path: PathBuf,
    dir: PathBuf,
    total: u64,
    cap: u64,
    /// Keys with a fetch still running (until its row is acknowledged).
    protected: HashSet<String>,
    /// Start from `SUM(bytes)` read inside the transaction instead of
    /// `total`, so rows other processes wrote count against the cap.
    resync: bool,
}

/// What [`Batch::apply`] leaves for the writer.
#[derive(Debug, PartialEq, Eq)]
struct Applied {
    /// The new running total (unchanged when the transaction failed).
    total: u64,
    /// True when `total` was read from the table.
    synced: bool,
}

/// What a committed batch leaves to do on disk.
#[derive(Default)]
struct Effects {
    /// Keys whose files go (evicted, or found with the wrong size).
    doomed: HashSet<String>,
    /// `Some(keep)`: delete every cache file except these keys.
    wipe: Option<HashSet<String>>,
    evicted: usize,
}

impl Batch {
    /// Applies `ops`, answers their acks and returns the new running total.
    fn apply(self, ops: Vec<Op>) -> Applied {
        let only_barriers = ops.iter().all(|o| matches!(o, Op::Evict { .. }));
        if only_barriers {
            // The table's own total, read without taking the write lock: a
            // barrier under the cap (the usual `images.stats`) writes nothing.
            // Over it, or when the read fails, the write path below re-reads
            // it inside its transaction and evicts (or reports the error).
            let sum = self
                .pool
                .get()
                .map_err(CoreError::from)
                .and_then(|conn| byte_total(&conn));
            if let Some(sum) = sum.ok().filter(|s| *s <= self.cap) {
                for op in ops {
                    if let Op::Evict { ack } = op {
                        let _ = ack.send(Ok(()));
                    }
                }
                return Applied {
                    total: sum,
                    synced: true,
                };
            }
        }
        let mut inserted = Vec::new();
        let mut waiting = Vec::new();
        let mut work = Vec::with_capacity(ops.len());
        for op in ops {
            match op {
                Op::Insert { row, ack } => {
                    inserted.push(ack);
                    work.push(Work::Insert(row));
                }
                Op::Touch { key, at } => work.push(Work::Touch(key, at)),
                Op::Forget { keys } => work.push(Work::Forget(keys)),
                Op::Evict { ack } => waiting.push(ack),
                Op::Clear { ack } => {
                    waiting.push(ack);
                    work.push(Work::Clear);
                }
            }
        }
        let result = self
            .pool
            .get()
            .map_err(CoreError::from)
            .and_then(|mut conn| self.write(&mut conn, work));
        match result {
            Ok((total, effects)) => {
                self.delete_files(&effects);
                if effects.evicted > 0 {
                    tracing::debug!(
                        evicted = effects.evicted,
                        total,
                        cap = self.cap,
                        "image cache evicted least recently used entries"
                    );
                }
                for ack in waiting {
                    let _ = ack.send(Ok(()));
                }
                for ack in inserted {
                    let _ = ack.send(());
                }
                Applied {
                    total,
                    synced: self.resync,
                }
            }
            Err(err) => {
                db::note_error(&self.db_path, &err);
                tracing::warn!(error = %err, "image cache index write failed");
                let msg = err.to_string();
                for ack in waiting {
                    let _ = ack.send(Err(CoreError::Other(anyhow::anyhow!(
                        "the image cache index could not be updated: {msg}"
                    ))));
                }
                // Dropping the insert acks tells their flights the batch is done.
                Applied {
                    total: self.total,
                    synced: false,
                }
            }
        }
    }

    fn write(&self, conn: &mut Connection, work: Vec<Work>) -> CoreResult<(u64, Effects)> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Under the write lock nobody else changes the table, so the total
        // read here stays exact through this batch's own deltas.
        let mut total = if self.resync {
            byte_total(&tx)?
        } else {
            self.total
        };
        let mut fx = Effects::default();
        let mut inserted_keys: Vec<String> = Vec::new();
        for item in work {
            match item {
                Work::Insert(row) => {
                    let old: Option<i64> = tx
                        .query_row(
                            "SELECT bytes FROM image_cache WHERE key = ?1",
                            [&row.key],
                            |r| r.get(0),
                        )
                        .optional()?;
                    tx.execute(
                        "INSERT INTO image_cache (key, url, content_type, bytes, created_at, last_access)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                         ON CONFLICT(key) DO UPDATE SET url = excluded.url,
                           content_type = excluded.content_type, bytes = excluded.bytes,
                           created_at = excluded.created_at, last_access = excluded.last_access",
                        params![row.key, row.url, row.content_type, row.bytes as i64, row.at],
                    )?;
                    total = total.saturating_sub(old.map_or(0, to_u64)) + row.bytes;
                    // A fresh file replaced whatever was doomed under this key.
                    fx.doomed.remove(&row.key);
                    if let Some(keep) = fx.wipe.as_mut() {
                        keep.insert(row.key.clone());
                    }
                    inserted_keys.push(row.key);
                }
                Work::Touch(key, at) => {
                    tx.execute(
                        "UPDATE image_cache SET last_access = MAX(last_access, ?2) WHERE key = ?1",
                        params![key, at],
                    )?;
                }
                Work::Forget(keys) => {
                    for key in keys {
                        let Some(bytes) = tx
                            .query_row(
                                "SELECT bytes FROM image_cache WHERE key = ?1",
                                [&key],
                                |r| r.get::<_, i64>(0),
                            )
                            .optional()?
                            .map(to_u64)
                        else {
                            continue;
                        };
                        let file = fs::metadata(file_path(&self.dir, &key));
                        if matches!(&file, Ok(m) if m.is_file() && m.len() == bytes) {
                            continue;
                        }
                        // A damaged file is left in place: the caller that
                        // found it is refetching and renames a fresh copy
                        // over it (deleting it here could hit that copy);
                        // if nobody does, the next reconcile removes it.
                        tx.execute("DELETE FROM image_cache WHERE key = ?1", [&key])?;
                        total = total.saturating_sub(bytes);
                    }
                }
                Work::Clear => {
                    tx.execute("DELETE FROM image_cache", [])?;
                    total = 0;
                    fx.doomed.clear();
                    // Rows inserted earlier in this batch are gone too; files
                    // of flights still waiting for their row are kept.
                    let mut keep = self.protected.clone();
                    for key in &inserted_keys {
                        keep.remove(key);
                    }
                    fx.wipe = Some(keep);
                }
            }
        }
        if total > self.cap {
            total = self.evict(&tx, &mut fx)?;
        }
        tx.commit()?;
        Ok((total, fx))
    }

    /// Deletes the least recently accessed rows until the total is at most
    /// [`EVICT_TARGET_PERCENT`] of the cap; returns the new total.
    fn evict(&self, tx: &rusqlite::Transaction<'_>, fx: &mut Effects) -> CoreResult<u64> {
        // Re-read: without a resync, `total` may still count rows another
        // process has evicted or cleared since.
        let mut total = byte_total(tx)?;
        if total <= self.cap {
            return Ok(total);
        }
        let target = self.cap / 100 * EVICT_TARGET_PERCENT;
        let mut victims = Vec::new();
        {
            let mut stmt = tx.prepare(
                "SELECT key, bytes FROM image_cache ORDER BY last_access ASC, created_at ASC, key ASC",
            )?;
            let mut rows = stmt.query([])?;
            while total > target {
                let Some(row) = rows.next()? else { break };
                let key: String = row.get(0)?;
                let bytes = to_u64(row.get(1)?);
                total = total.saturating_sub(bytes);
                victims.push(key);
            }
        }
        let mut del = tx.prepare("DELETE FROM image_cache WHERE key = ?1")?;
        for key in victims {
            del.execute([&key])?;
            fx.evicted += 1;
            // A running fetch for this key (its old row was stale, or it is
            // the fetch's own new row) keeps its file: deleting it could hit
            // the copy that fetch is serving. Without a row the file is an
            // orphan that the next fetch overwrites or a reconcile removes.
            if !self.protected.contains(&key) {
                fx.doomed.insert(key);
            }
        }
        Ok(total)
    }

    /// File deletions after a commit (failures are logged and left to the
    /// next reconcile).
    fn delete_files(&self, fx: &Effects) {
        for key in &fx.doomed {
            remove_quietly(&file_path(&self.dir, key));
        }
        let Some(keep) = &fx.wipe else { return };
        let Ok(subs) = fs::read_dir(&self.dir) else {
            return;
        };
        for sub in subs.flatten() {
            let sub_path = sub.path();
            if !is_shard(&sub.file_name().to_string_lossy()) || !sub_path.is_dir() {
                continue;
            }
            if let Ok(files) = fs::read_dir(&sub_path) {
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().into_owned();
                    if is_key(&name) && !keep.contains(&name) {
                        remove_quietly(&file.path());
                    }
                }
            }
            // Fails (and is ignored) unless the shard is now empty.
            let _ = fs::remove_dir(&sub_path);
        }
    }
}

/// One write inside a batch.
enum Work {
    Insert(Row),
    Touch(String, i64),
    Forget(Vec<String>),
    Clear,
}

fn remove_quietly(path: &Path) {
    if let Err(err) = fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %err, "could not delete a cached image file");
        }
    }
}

/// True for a shard folder name (two lowercase hex characters).
fn is_shard(name: &str) -> bool {
    name.len() == 2
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// What the reconcile scan found and did.
#[derive(Debug, Default)]
pub(super) struct ScanReport {
    /// Rows whose file is missing or has the wrong size (dropped through
    /// the writer, which re-checks them).
    pub stale: Vec<String>,
    /// Files deleted: cache files without a row or with the wrong size,
    /// abandoned temp files, and files too large to have been stored by
    /// this module. Files younger than [`RECONCILE_GRACE`] are spared
    /// (except oversized ones), since a fetch may be writing them.
    pub removed: usize,
}

/// Walks the cache folder against the index `rows`.
pub(super) fn scan(dir: &Path, rows: &HashMap<String, u64>) -> ScanReport {
    let mut report = ScanReport::default();
    let mut seen = HashSet::new();
    let now = SystemTime::now();
    let old = |meta: &fs::Metadata| {
        meta.modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= RECONCILE_GRACE)
    };
    if let Ok(subs) = fs::read_dir(dir) {
        for sub in subs.flatten() {
            let shard = sub.file_name().to_string_lossy().into_owned();
            if !is_shard(&shard) || !sub.path().is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(sub.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                let Ok(meta) = file.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let ours = is_key(&name) && name.starts_with(&shard);
                let temp = name.ends_with(".tmp") && is_key(name.get(..64).unwrap_or(""));
                let remove = if ours {
                    match rows.get(&name) {
                        Some(&bytes) => {
                            seen.insert(name.clone());
                            let damaged = meta.len() != bytes;
                            if damaged {
                                report.stale.push(name.clone());
                            }
                            // Unless a fetch may be replacing it right now.
                            damaged && old(&meta)
                        }
                        None => old(&meta) || meta.len() > MAX_IMAGE_BYTES,
                    }
                } else {
                    temp && old(&meta)
                };
                if remove {
                    remove_quietly(&file.path());
                    report.removed += 1;
                }
            }
        }
    }
    for key in rows.keys() {
        if !seen.contains(key) {
            report.stale.push(key.clone());
        }
    }
    report.stale.sort();
    report.stale.dedup();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shards_are_two_lowercase_hex() {
        assert!(is_shard("0f"));
        assert!(!is_shard("0F"));
        assert!(!is_shard("0"));
        assert!(!is_shard("xyz"));
    }

    #[test]
    fn scan_reports_missing_and_resized_files_and_spares_young_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let key = |c: char| c.to_string().repeat(64);
        let (a, b, c, d) = (key('a'), key('b'), key('c'), key('d'));
        for (k, len) in [(&a, 3usize), (&b, 5), (&d, 2)] {
            let p = file_path(dir.path(), k);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, vec![1u8; len]).unwrap();
        }
        // A foreign file in a shard and a young temp file are left alone.
        fs::write(dir.path().join("aa").join("notes.txt"), b"x").unwrap();
        fs::write(dir.path().join("aa").join(format!("{a}.1.tmp")), b"x").unwrap();
        let rows: HashMap<String, u64> = [(a.clone(), 3), (b.clone(), 4), (c.clone(), 7)]
            .into_iter()
            .collect();
        let report = scan(dir.path(), &rows);
        // b has the wrong size, c has no file; d is a young orphan.
        assert_eq!(report.stale, vec![b, c]);
        assert_eq!(report.removed, 0);
        assert!(file_path(dir.path(), &d).exists());
        assert!(dir.path().join("aa").join("notes.txt").exists());
    }

    #[test]
    fn eviction_keeps_the_files_of_running_fetches() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("db.sqlite");
        let pool = db::open_and_migrate(&db_path).unwrap();
        let dir = tmp.path().join(super::super::DIR_NAME);
        let key = |c: char| c.to_string().repeat(64);
        let (a, b, c) = (key('a'), key('b'), key('c'));
        for k in [&a, &b, &c] {
            let p = file_path(&dir, k);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, vec![1u8; 400]).unwrap();
        }
        {
            let conn = pool.get().unwrap();
            for (k, at) in [(&a, 1), (&b, 2)] {
                conn.execute(
                    "INSERT INTO image_cache (key, url, content_type, bytes, created_at, last_access)
                     VALUES (?1, ?1, 'image/png', 400, ?2, ?2)",
                    params![k, at],
                )
                .unwrap();
            }
        }
        // b's old row is stale and a fetch for it is running (it may have
        // renamed its fresh copy into place already).
        let batch = Batch {
            pool: pool.clone(),
            db_path,
            dir: dir.clone(),
            total: 800,
            cap: 500,
            protected: [b.clone()].into_iter().collect(),
            resync: false,
        };
        let (ack, _rx) = oneshot::channel();
        let row = Row {
            key: c.clone(),
            url: c.clone(),
            content_type: "image/png".into(),
            bytes: 400,
            at: 3,
        };
        // 1,200 bytes against a 500 cap: a and b go (down to 450).
        let applied = batch.apply(vec![Op::Insert { row, ack }]);
        assert_eq!(applied.total, 400);
        let mut conn = pool.get().unwrap();
        assert_eq!(totals(&mut conn).unwrap(), (400, 1));
        assert!(!file_path(&dir, &a).exists(), "a's file is evicted");
        assert!(
            file_path(&dir, &b).exists(),
            "the running fetch keeps b's file"
        );
        assert!(file_path(&dir, &c).exists());
    }

    /// A migrated index holding rows another process wrote, as
    /// `(key char, bytes, last_access)`, with their files.
    fn other_process_rows(rows: &[(char, u64, i64)]) -> (tempfile::TempDir, DbPool, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::open_and_migrate(&tmp.path().join("db.sqlite")).unwrap();
        let dir = tmp.path().join(super::super::DIR_NAME);
        let conn = pool.get().unwrap();
        for &(c, bytes, at) in rows {
            let k = c.to_string().repeat(64);
            let p = file_path(&dir, &k);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, vec![1u8; bytes as usize]).unwrap();
            conn.execute(
                "INSERT INTO image_cache (key, url, content_type, bytes, created_at, last_access)
                 VALUES (?1, ?1, 'image/png', ?2, ?3, ?3)",
                params![k, bytes as i64, at],
            )
            .unwrap();
        }
        (tmp, pool, dir)
    }

    /// A batch of this process, whose running total is `total`.
    fn batch(tmp: &tempfile::TempDir, pool: &DbPool, total: u64, resync: bool) -> Batch {
        Batch {
            pool: pool.clone(),
            db_path: tmp.path().join("db.sqlite"),
            dir: tmp.path().join(super::super::DIR_NAME),
            total,
            cap: 1000,
            protected: HashSet::new(),
            resync,
        }
    }

    fn row(c: char, bytes: u64, at: i64) -> Row {
        let key = c.to_string().repeat(64);
        Row {
            url: key.clone(),
            key,
            content_type: "image/png".into(),
            bytes,
            at,
        }
    }

    #[test]
    fn a_barrier_counts_the_rows_another_process_wrote() {
        // Another process on the data dir stored 1,200 bytes against the
        // 1,000 cap; this one has stored nothing.
        let (tmp, pool, dir) = other_process_rows(&[('a', 400, 1), ('b', 400, 2), ('c', 400, 3)]);
        let (ack, mut done) = oneshot::channel();
        let applied = batch(&tmp, &pool, 0, true).apply(vec![Op::Evict { ack }]);
        // Down to 90 % of the cap: the least recently accessed row goes.
        assert_eq!(
            applied,
            Applied {
                total: 800,
                synced: true
            }
        );
        assert!(matches!(done.try_recv(), Ok(Ok(()))));
        assert_eq!(totals(&mut pool.get().unwrap()).unwrap(), (800, 2));
        assert!(!file_path(&dir, &"a".repeat(64)).exists());
        assert!(file_path(&dir, &"b".repeat(64)).exists());

        // Under the cap a barrier only reads the table's total.
        let (ack, mut done) = oneshot::channel();
        let applied = batch(&tmp, &pool, 5, true).apply(vec![Op::Evict { ack }]);
        assert_eq!(
            applied,
            Applied {
                total: 800,
                synced: true
            }
        );
        assert!(matches!(done.try_recv(), Ok(Ok(()))));
    }

    #[test]
    fn an_insert_with_a_resync_counts_the_rows_another_process_wrote() {
        let (tmp, pool, dir) = other_process_rows(&[('a', 400, 1), ('b', 400, 2)]);
        // Between resyncs this process counts its own 300 bytes only, so the
        // table may go over the cap (1,100 against 1,000).
        let (ack, _rx) = oneshot::channel();
        let applied = batch(&tmp, &pool, 0, false).apply(vec![Op::Insert {
            row: row('c', 300, 3),
            ack,
        }]);
        assert_eq!(
            applied,
            Applied {
                total: 300,
                synced: false
            }
        );
        assert_eq!(totals(&mut pool.get().unwrap()).unwrap(), (1100, 3));

        // A resync reads 1,100, adds 300 and evicts a and b (down to 600).
        let (ack, _rx) = oneshot::channel();
        let applied = batch(&tmp, &pool, 300, true).apply(vec![Op::Insert {
            row: row('d', 300, 4),
            ack,
        }]);
        assert_eq!(
            applied,
            Applied {
                total: 600,
                synced: true
            }
        );
        assert_eq!(totals(&mut pool.get().unwrap()).unwrap(), (600, 2));
        assert!(!file_path(&dir, &"a".repeat(64)).exists());
        assert!(!file_path(&dir, &"b".repeat(64)).exists());
    }
}
