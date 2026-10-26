//! `downloads` table access (C3). All functions are blocking; call them
//! through `AppState::db_call`.

use crate::db::{now_rfc3339, to_rfc3339};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, Download, DownloadStatus, ItemRef, RequestHeaders};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::str::FromStr;

/// A download row plus the columns that never cross the RPC boundary.
#[derive(Debug, Clone)]
pub struct DownloadRow {
    pub download: Download,
    pub headers: RequestHeaders,
    pub resume_validator: Option<String>,
}

const COLUMNS: &str =
    "id, source_id, content_type, item_id, episode_id, title, subtitle, url, file_name, \
    file_path, poster_url, headers_json, status, bytes_downloaded, total_bytes, resume_validator, \
    error_message, position_seconds, created_at, updated_at, completed_at, duration_seconds, rate_limit_bps";

fn map_row(r: &Row<'_>) -> rusqlite::Result<DownloadRow> {
    let content_type: String = r.get(2)?;
    let episode_id: String = r.get(4)?;
    let headers_json: Option<String> = r.get(11)?;
    let status: String = r.get(12)?;
    let created_at: String = r.get(18)?;
    let updated_at: String = r.get(19)?;
    let completed_at: Option<String> = r.get(20)?;
    let content_type = ContentType::from_str(&content_type).unwrap_or(ContentType::Movie);
    let status = DownloadStatus::from_str(&status).unwrap_or(DownloadStatus::Failed);
    let headers = headers_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<RequestHeaders>(j).ok())
        .unwrap_or_default();
    Ok(DownloadRow {
        download: Download {
            id: r.get(0)?,
            item_ref: ItemRef::new(r.get::<_, String>(1)?, content_type, r.get::<_, String>(3)?),
            episode_id: (!episode_id.is_empty()).then_some(episode_id),
            title: r.get(5)?,
            subtitle: r.get(6)?,
            url: r.get(7)?,
            file_name: r.get(8)?,
            file_path: r.get(9)?,
            poster_url: r.get(10)?,
            status,
            bytes_downloaded: r.get(13)?,
            total_bytes: r.get(14)?,
            error_message: r.get(16)?,
            created_at: to_rfc3339(&created_at),
            updated_at: to_rfc3339(&updated_at),
            completed_at: completed_at.as_deref().map(to_rfc3339),
            file_available: None,
            position_seconds: r.get(17)?,
            waiting: None,
            connections: None,
            duration_seconds: r.get(21)?,
            rate_limit_bps: r.get(22)?,
        },
        headers,
        resume_validator: r.get(15)?,
    })
}

/// Sets `file_available` for completed rows: only a regular, non-symlink file
/// counts. Other statuses report `None`. Never changes the persisted status.
pub fn derive_availability(d: &mut Download) {
    d.file_available = if d.status == DownloadStatus::Completed {
        Some(
            d.file_path
                .as_deref()
                .is_some_and(|p| super::naming::is_regular_file(Path::new(p))),
        )
    } else {
        None
    };
}

/// Sets the override without changing the transfer's progress or lifecycle.
pub fn set_rate_limit(conn: &Connection, id: i64, bps: Option<u64>) -> CoreResult<()> {
    let changed = conn.execute(
        "UPDATE downloads SET rate_limit_bps = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, bps, now_rfc3339()],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("download {id} not found")));
    }
    Ok(())
}

/// One row by id.
pub fn get(conn: &Connection, id: i64) -> CoreResult<DownloadRow> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM downloads WHERE id = ?1"),
        [id],
        map_row,
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("download {id} not found")))
}

/// Row for an item identity, if any.
pub fn find_by_ref(
    conn: &Connection,
    r: &ItemRef,
    episode_id: Option<&str>,
) -> CoreResult<Option<DownloadRow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM downloads WHERE source_id = ?1 AND content_type = ?2 \
                 AND item_id = ?3 AND episode_id = ?4"
            ),
            params![
                r.source_id,
                r.content_type.as_str(),
                r.item_id,
                episode_id.unwrap_or("")
            ],
            map_row,
        )
        .optional()?)
}

/// Every row, newest first. `completed_only` restricts to completed rows
/// ordered by completion time.
pub fn list(conn: &Connection, completed_only: bool) -> CoreResult<Vec<DownloadRow>> {
    let sql = if completed_only {
        format!(
            "SELECT {COLUMNS} FROM downloads WHERE status = 'completed' \
             ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC"
        )
    } else {
        format!("SELECT {COLUMNS} FROM downloads ORDER BY created_at DESC, id DESC")
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Ids in the given status with their source, oldest first (FIFO).
pub fn ids_with_status(
    conn: &Connection,
    status: DownloadStatus,
) -> CoreResult<Vec<(i64, String)>> {
    let mut stmt = conn
        .prepare("SELECT id, source_id FROM downloads WHERE status = ?1 ORDER BY created_at, id")?;
    let ids = stmt.query_map([status.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(ids.collect::<Result<Vec<_>, _>>()?)
}

/// Final paths the other unfinished rows record. A paused row's `.part` can
/// be gone for now (deleted by hand to free space), and a reservation that
/// handed its name out again would give two rows one `.part`.
pub fn held_paths(conn: &Connection, except: i64) -> CoreResult<super::naming::HeldPaths> {
    let mut stmt = conn.prepare(
        "SELECT file_path FROM downloads \
         WHERE id != ?1 AND status != 'completed' AND file_path IS NOT NULL",
    )?;
    let paths = stmt.query_map([except], |r| r.get(0))?;
    Ok(super::naming::HeldPaths::new(
        paths.collect::<Result<Vec<String>, _>>()?,
    ))
}

/// Fields for a fresh (or reset) queued row.
pub struct NewDownload<'a> {
    pub item_ref: &'a ItemRef,
    pub episode_id: Option<&'a str>,
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub url: &'a str,
    pub poster_url: Option<&'a str>,
    pub headers: &'a RequestHeaders,
    pub duration_seconds: Option<i64>,
}

fn headers_json(h: &RequestHeaders) -> Option<String> {
    (!h.is_empty()).then(|| serde_json::to_string(h).unwrap_or_default())
}

/// Inserts a queued row and returns its id.
pub fn insert(conn: &Connection, n: &NewDownload<'_>) -> CoreResult<i64> {
    let now = now_rfc3339();
    conn.execute(
        "INSERT INTO downloads (source_id, content_type, item_id, episode_id, title, subtitle, url, \
         poster_url, headers_json, duration_seconds, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', ?11, ?11)",
        params![
            n.item_ref.source_id,
            n.item_ref.content_type.as_str(),
            n.item_ref.item_id,
            n.episode_id.unwrap_or(""),
            n.title,
            n.subtitle,
            n.url,
            n.poster_url,
            headers_json(n.headers),
            n.duration_seconds,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Resets an existing row to a fresh queued transfer (new metadata, no file,
/// no progress). Keeps id, created_at and the playback position.
pub fn reset(conn: &Connection, id: i64, n: &NewDownload<'_>) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET title = ?2, subtitle = ?3, url = ?4, poster_url = ?5, headers_json = ?6, duration_seconds = ?8, \
         status = 'queued', bytes_downloaded = 0, total_bytes = NULL, resume_validator = NULL, \
         error_message = NULL, file_name = NULL, file_path = NULL, completed_at = NULL, updated_at = ?7 \
         WHERE id = ?1",
        params![
            id,
            n.title,
            n.subtitle,
            n.url,
            n.poster_url,
            headers_json(n.headers),
            now_rfc3339(),
            n.duration_seconds
        ],
    )?;
    Ok(())
}

/// Re-queues a completed row whose file went missing: clears the recorded
/// path, progress, and representation, keeps `file_name` so the new transfer
/// asks for the same name in the current downloads folder. Conditional on
/// `completed`; returns true when the row changed.
pub fn restart_completed(conn: &Connection, id: i64) -> CoreResult<bool> {
    Ok(conn.execute(
        "UPDATE downloads SET status = 'queued', file_path = NULL, bytes_downloaded = 0, \
         total_bytes = NULL, resume_validator = NULL, error_message = NULL, completed_at = NULL, \
         updated_at = ?2 WHERE id = ?1 AND status = 'completed'",
        params![id, now_rfc3339()],
    )? > 0)
}

/// Sets the status (and error message) when the current status is one of
/// `from`. Returns true when a row changed (a conditional claim).
pub fn transition(
    conn: &Connection,
    id: i64,
    from: &[DownloadStatus],
    to: DownloadStatus,
    error: Option<&str>,
) -> CoreResult<bool> {
    use rusqlite::types::Value;
    let placeholders = (0..from.len())
        .map(|i| format!("?{}", i + 5))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE downloads SET status = ?2, error_message = ?3, updated_at = ?4 \
         WHERE id = ?1 AND status IN ({placeholders})"
    );
    let mut values = vec![
        Value::Integer(id),
        Value::Text(to.as_str().to_string()),
        error.map_or(Value::Null, |e| Value::Text(e.to_string())),
        Value::Text(now_rfc3339()),
    ];
    values.extend(from.iter().map(|s| Value::Text(s.as_str().to_string())));
    Ok(conn.execute(&sql, rusqlite::params_from_iter(values))? > 0)
}

/// Stores a re-resolved stream URL and its headers (Xtream/Stalker).
pub fn set_source(
    conn: &Connection,
    id: i64,
    url: &str,
    headers: &RequestHeaders,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET url = ?2, headers_json = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, url, headers_json(headers), now_rfc3339()],
    )?;
    Ok(())
}

/// Persists the reserved destination before the transfer starts.
pub fn set_destination(
    conn: &Connection,
    id: i64,
    file_name: &str,
    file_path: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET file_name = ?2, file_path = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, file_name, file_path, now_rfc3339()],
    )?;
    Ok(())
}

/// Clears the destination (after its `.part` was removed) and the progress.
pub fn clear_destination(conn: &Connection, id: i64) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET file_name = NULL, file_path = NULL, bytes_downloaded = 0, \
         total_bytes = NULL, resume_validator = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, now_rfc3339()],
    )?;
    Ok(())
}

/// Records what the server said about the representation.
pub fn set_representation(
    conn: &Connection,
    id: i64,
    total: Option<i64>,
    validator: Option<&str>,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET total_bytes = ?2, resume_validator = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, total, validator, now_rfc3339()],
    )?;
    Ok(())
}

/// Persists byte progress.
pub fn set_progress(conn: &Connection, id: i64, bytes: i64) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET bytes_downloaded = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, bytes, now_rfc3339()],
    )?;
    Ok(())
}

/// Ends a transfer in a non-completed status with its byte count.
pub fn finish(
    conn: &Connection,
    id: i64,
    status: DownloadStatus,
    bytes: i64,
    error: Option<&str>,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE downloads SET status = ?2, bytes_downloaded = ?3, error_message = ?4, updated_at = ?5 \
         WHERE id = ?1",
        params![id, status.as_str(), bytes, error, now_rfc3339()],
    )?;
    Ok(())
}

/// A running transfer goes back to `queued` (it yielded its connection, or
/// its source refused or was unreachable), keeping its byte count. Only a
/// row still `downloading`: a pause that landed first stays.
pub fn requeue(conn: &Connection, id: i64, bytes: i64) -> CoreResult<bool> {
    Ok(conn.execute(
        "UPDATE downloads SET status = 'queued', bytes_downloaded = ?2, error_message = NULL, \
         updated_at = ?3 WHERE id = ?1 AND status = 'downloading'",
        params![id, bytes, now_rfc3339()],
    )? > 0)
}

/// Marks a transfer completed at its final path.
pub fn complete(
    conn: &Connection,
    id: i64,
    file_name: &str,
    file_path: &str,
    bytes: i64,
) -> CoreResult<()> {
    let now = now_rfc3339();
    conn.execute(
        "UPDATE downloads SET status = 'completed', file_name = ?2, file_path = ?3, bytes_downloaded = ?4, \
         total_bytes = ?4, error_message = NULL, completed_at = ?5, updated_at = ?5 WHERE id = ?1",
        params![id, file_name, file_path, bytes, now],
    )?;
    Ok(())
}

/// Updates the saved playback position (seconds, clamped at 0).
pub fn set_position(conn: &Connection, id: i64, seconds: i64) -> CoreResult<()> {
    let n = conn.execute(
        "UPDATE downloads SET position_seconds = ?2 WHERE id = ?1",
        params![id, seconds.max(0)],
    )?;
    if n == 0 {
        return Err(CoreError::NotFound(format!("download {id} not found")));
    }
    Ok(())
}

/// Deletes a row.
pub fn delete(conn: &Connection, id: i64) -> CoreResult<()> {
    conn.execute("DELETE FROM downloads WHERE id = ?1", [id])?;
    Ok(())
}

/// `app_state` key of the saved queue order (a JSON array of ids).
const QUEUE_ORDER_KEY: &str = "downloads_queue";

/// The queue order saved by [`save_queue_order`]; empty when none (or it is
/// unreadable).
pub fn load_queue_order(conn: &Connection) -> CoreResult<Vec<i64>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [QUEUE_ORDER_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

/// Saves the queue order: running ids in start order, then the queue.
pub fn save_queue_order(conn: &Connection, ids: &[i64]) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![QUEUE_ORDER_KEY, serde_json::to_string(ids)?],
    )?;
    Ok(())
}

/// Boot recovery: rows left `downloading` by a previous process go back to
/// `queued`. Returns the number of rows changed.
pub fn requeue_interrupted(conn: &Connection) -> CoreResult<usize> {
    Ok(conn.execute(
        "UPDATE downloads SET status = 'queued', updated_at = ?1 WHERE status = 'downloading'",
        [now_rfc3339()],
    )?)
}
