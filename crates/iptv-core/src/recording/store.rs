//! SQL for the `reminders` and `recordings` tables (migration 0010).
//!
//! Times are unix seconds of the guide time as the user saw it (the EPG
//! offset already applied).

use super::{RecordingKind, RecordingStatus, ReminderStatus};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ItemRef};
use rusqlite::{params, Connection, OptionalExtension, Row};

/// One `reminders` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderRow {
    pub id: String,
    pub item_ref: ItemRef,
    pub channel_name: String,
    pub title: String,
    pub start_at: i64,
    pub end_at: i64,
    pub status: ReminderStatus,
    pub fired_at: Option<i64>,
    pub created_at: i64,
}

/// One `recordings` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingRow {
    pub id: String,
    pub item_ref: ItemRef,
    pub channel_name: String,
    pub title: Option<String>,
    pub kind: RecordingKind,
    pub start_at: i64,
    pub end_at: i64,
    /// Minutes.
    pub padding_before: i64,
    /// Minutes.
    pub padding_after: i64,
    pub status: RecordingStatus,
    pub error_message: Option<String>,
    /// Absolute paths of the files written, in order.
    pub parts: Vec<String>,
    pub bytes: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub engine: Option<String>,
    pub created_at: i64,
    /// The series rule that created it (`recording_rules.id`, migration
    /// 0015); `None` for a recording scheduled by hand.
    pub rule_id: Option<String>,
}

impl RecordingRow {
    /// When the engine starts: the programme start minus the padding.
    pub fn effective_start(&self) -> i64 {
        self.start_at - self.padding_before * 60
    }

    /// When the engine stops: the programme end plus the padding.
    pub fn effective_end(&self) -> i64 {
        self.end_at + self.padding_after * 60
    }
}

fn content_type(raw: String) -> rusqlite::Result<ContentType> {
    raw.parse().map_err(|e: CoreError| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn parse<T: serde::de::DeserializeOwned>(raw: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(raw)).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn wire<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

const REMINDER_COLS: &str =
    "id, source_id, content_type, item_id, channel_name, title, start_at, end_at, status, fired_at, created_at";

fn reminder(r: &Row<'_>) -> rusqlite::Result<ReminderRow> {
    Ok(ReminderRow {
        id: r.get(0)?,
        item_ref: ItemRef::new(
            r.get::<_, String>(1)?,
            content_type(r.get(2)?)?,
            r.get::<_, String>(3)?,
        ),
        channel_name: r.get(4)?,
        title: r.get(5)?,
        start_at: r.get(6)?,
        end_at: r.get(7)?,
        status: parse(r.get(8)?)?,
        fired_at: r.get(9)?,
        created_at: r.get(10)?,
    })
}

pub fn insert_reminder(c: &Connection, r: &ReminderRow) -> CoreResult<()> {
    c.execute(
        "INSERT INTO reminders (id, source_id, content_type, item_id, channel_name, title, start_at, end_at, status, fired_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            r.id,
            r.item_ref.source_id,
            r.item_ref.content_type.as_str(),
            r.item_ref.item_id,
            r.channel_name,
            r.title,
            r.start_at,
            r.end_at,
            wire(&r.status),
            r.fired_at,
            r.created_at
        ],
    )?;
    Ok(())
}

pub fn reminders(c: &Connection) -> CoreResult<Vec<ReminderRow>> {
    let mut s = c.prepare(&format!(
        "SELECT {REMINDER_COLS} FROM reminders ORDER BY start_at, created_at"
    ))?;
    let rows = s.query_map([], reminder)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn reminder_by_id(c: &Connection, id: &str) -> CoreResult<Option<ReminderRow>> {
    Ok(c.query_row(
        &format!("SELECT {REMINDER_COLS} FROM reminders WHERE id = ?1"),
        [id],
        reminder,
    )
    .optional()?)
}

/// The reminder for this channel and start, if any.
pub fn reminder_for(c: &Connection, r: &ItemRef, start_at: i64) -> CoreResult<Option<ReminderRow>> {
    Ok(c.query_row(
        &format!(
            "SELECT {REMINDER_COLS} FROM reminders
             WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND start_at = ?4"
        ),
        params![r.source_id, r.content_type.as_str(), r.item_id, start_at],
        reminder,
    )
    .optional()?)
}

pub fn delete_reminder(c: &Connection, id: &str) -> CoreResult<bool> {
    Ok(c.execute("DELETE FROM reminders WHERE id = ?1", [id])? > 0)
}

pub fn set_reminder_status(
    c: &Connection,
    id: &str,
    status: ReminderStatus,
    fired_at: Option<i64>,
) -> CoreResult<()> {
    c.execute(
        "UPDATE reminders SET status = ?2, fired_at = COALESCE(?3, fired_at) WHERE id = ?1",
        params![id, wire(&status), fired_at],
    )?;
    Ok(())
}

/// Re-arms a reminder that already fired or was missed (the user asked for
/// it again), with the latest names and times.
pub fn rearm_reminder(c: &Connection, r: &ReminderRow) -> CoreResult<()> {
    c.execute(
        "UPDATE reminders SET status = 'pending', fired_at = NULL, channel_name = ?2, title = ?3,
           start_at = ?4, end_at = ?5 WHERE id = ?1",
        params![r.id, r.channel_name, r.title, r.start_at, r.end_at],
    )?;
    Ok(())
}

/// Deletes every reminder of a source; returns how many there were.
pub fn delete_reminders_for_source(c: &Connection, source_id: &str) -> CoreResult<usize> {
    Ok(c.execute("DELETE FROM reminders WHERE source_id = ?1", [source_id])?)
}

pub fn set_reminder_times(c: &Connection, id: &str, start_at: i64, end_at: i64) -> CoreResult<()> {
    c.execute(
        "UPDATE reminders SET start_at = ?2, end_at = ?3 WHERE id = ?1",
        params![id, start_at, end_at],
    )?;
    Ok(())
}

const RECORDING_COLS: &str = "id, source_id, content_type, item_id, channel_name, title, kind, start_at, end_at, padding_before, padding_after, status, error_message, parts_json, bytes, started_at, ended_at, engine, created_at, rule_id";

fn recording(r: &Row<'_>) -> rusqlite::Result<RecordingRow> {
    let parts: String = r.get(13)?;
    Ok(RecordingRow {
        id: r.get(0)?,
        item_ref: ItemRef::new(
            r.get::<_, String>(1)?,
            content_type(r.get(2)?)?,
            r.get::<_, String>(3)?,
        ),
        channel_name: r.get(4)?,
        title: r.get(5)?,
        kind: parse(r.get(6)?)?,
        start_at: r.get(7)?,
        end_at: r.get(8)?,
        padding_before: r.get(9)?,
        padding_after: r.get(10)?,
        status: parse(r.get(11)?)?,
        error_message: r.get(12)?,
        parts: serde_json::from_str(&parts).unwrap_or_default(),
        bytes: r.get(14)?,
        started_at: r.get(15)?,
        ended_at: r.get(16)?,
        engine: r.get(17)?,
        created_at: r.get(18)?,
        rule_id: r.get(19)?,
    })
}

pub fn insert_recording(c: &Connection, r: &RecordingRow) -> CoreResult<()> {
    c.execute(
        "INSERT INTO recordings (id, source_id, content_type, item_id, channel_name, title, kind, start_at, end_at,
           padding_before, padding_after, status, error_message, parts_json, bytes, started_at, ended_at, engine, created_at, rule_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            r.id,
            r.item_ref.source_id,
            r.item_ref.content_type.as_str(),
            r.item_ref.item_id,
            r.channel_name,
            r.title,
            wire(&r.kind),
            r.start_at,
            r.end_at,
            r.padding_before,
            r.padding_after,
            wire(&r.status),
            r.error_message,
            serde_json::to_string(&r.parts)?,
            r.bytes,
            r.started_at,
            r.ended_at,
            r.engine,
            r.created_at,
            r.rule_id
        ],
    )?;
    Ok(())
}

pub fn recordings(c: &Connection) -> CoreResult<Vec<RecordingRow>> {
    let mut s = c.prepare(&format!(
        "SELECT {RECORDING_COLS} FROM recordings ORDER BY start_at, created_at"
    ))?;
    let rows = s.query_map([], recording)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn recording_by_id(c: &Connection, id: &str) -> CoreResult<Option<RecordingRow>> {
    Ok(c.query_row(
        &format!("SELECT {RECORDING_COLS} FROM recordings WHERE id = ?1"),
        [id],
        recording,
    )
    .optional()?)
}

pub fn delete_recording(c: &Connection, id: &str) -> CoreResult<bool> {
    Ok(c.execute("DELETE FROM recordings WHERE id = ?1", [id])? > 0)
}

/// Moves a row from one of `from` to `to`, writing `ended_at` when given
/// and `error` as is (`None` clears it). Returns false (and changes
/// nothing) when the row is gone or no longer in one of `from`, so a stale
/// decision never overwrites a newer state.
pub fn transition(
    c: &Connection,
    id: &str,
    from: &[RecordingStatus],
    to: RecordingStatus,
    ended_at: Option<i64>,
    error: Option<&str>,
) -> CoreResult<bool> {
    let from: Vec<String> = from.iter().map(wire).collect();
    let from = serde_json::to_string(&from)?;
    let n = c.execute(
        "UPDATE recordings SET status = ?2, ended_at = COALESCE(?3, ended_at), error_message = ?4
         WHERE id = ?1 AND status IN (SELECT value FROM json_each(?5))",
        params![id, wire(&to), ended_at, error, from],
    )?;
    Ok(n > 0)
}

/// Marks a scheduled (or resuming) row as recording. False when the row is
/// gone or was cancelled or finished meanwhile: the engine must not run.
pub fn mark_started(c: &Connection, id: &str, started_at: i64, engine: &str) -> CoreResult<bool> {
    let n = c.execute(
        "UPDATE recordings SET status = 'recording', started_at = COALESCE(started_at, ?2), engine = ?3,
           error_message = NULL WHERE id = ?1 AND status IN ('scheduled', 'recording')",
        params![id, started_at, engine],
    )?;
    Ok(n > 0)
}

/// Ids of a source's recordings in `status`.
pub fn ids_for_source(
    c: &Connection,
    source_id: &str,
    status: RecordingStatus,
) -> CoreResult<Vec<String>> {
    let mut s = c.prepare("SELECT id FROM recordings WHERE source_id = ?1 AND status = ?2")?;
    let rows = s.query_map(params![source_id, wire(&status)], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn set_progress(c: &Connection, id: &str, parts: &[String], bytes: i64) -> CoreResult<()> {
    c.execute(
        "UPDATE recordings SET parts_json = ?2, bytes = ?3 WHERE id = ?1",
        params![id, serde_json::to_string(parts)?, bytes],
    )?;
    Ok(())
}

pub fn set_error(c: &Connection, id: &str, error: Option<&str>) -> CoreResult<()> {
    c.execute(
        "UPDATE recordings SET error_message = ?2 WHERE id = ?1",
        params![id, error],
    )?;
    Ok(())
}

/// Moves a scheduled programme recording to new times (the guide moved its
/// programme). Refused (false, nothing changed) when the row is no longer
/// scheduled, or when another scheduled or running programme recording of
/// the same channel already starts there: one airing is recorded once.
pub fn move_scheduled(c: &Connection, id: &str, start_at: i64, end_at: i64) -> CoreResult<bool> {
    let n = c.execute(
        "UPDATE recordings SET start_at = ?2, end_at = ?3
         WHERE id = ?1 AND status = 'scheduled'
           AND NOT EXISTS (
             SELECT 1 FROM recordings o
             WHERE o.id <> recordings.id
               AND o.source_id = recordings.source_id
               AND o.content_type = recordings.content_type
               AND o.item_id = recordings.item_id
               AND o.kind = 'programme' AND o.start_at = ?2
               AND o.status IN ('scheduled', 'recording'))",
        params![id, start_at, end_at],
    )?;
    Ok(n > 0)
}

/// Deletes a recording that is still only scheduled (never started, no
/// files). False when it is gone or has moved on meanwhile.
pub fn delete_scheduled(c: &Connection, id: &str) -> CoreResult<bool> {
    Ok(c.execute(
        "DELETE FROM recordings WHERE id = ?1 AND status = 'scheduled'",
        [id],
    )? > 0)
}
