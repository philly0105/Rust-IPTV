//! Guide reminders and scheduled recordings.
//!
//! Reminders fire `reminderLeadMinutes` before a programme while the app
//! runs (`reminders.fire` event; the UI notifies or switches). Recordings run
//! a headless mpv with `--stream-record` (or a direct HTTP copy for plain
//! streams) from the padded start to the padded end, without the player.
//! Both live in SQLite (migration 0010) and survive a restart; a recording
//! that was due while the app was closed starts late at the next launch if its
//! slot is still running, and is marked missed only once the slot is over.
//!
//! The decisions are pure ([`scheduler::plan`]) and take "now" from an
//! injectable [`scheduler::Clock`]; [`tick`] applies them. A background loop
//! ticks at the next due time (at most every 15 s) and whenever something is
//! scheduled or a guide refresh lands.

pub mod engine;
pub mod library;
pub mod naming;
pub mod rpc;
// guide: series recording rules (Run 2 C5).
pub mod rules;
pub mod scheduler;
pub mod store;

use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ItemRef, PlayerKind, PlayerSource, ReminderAction, SourceKind};
use crate::state::AppState;
use chrono::{DateTime, TimeZone, Utc};
use scheduler::{Action, Clock, PlanInput, SystemClock};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use store::{RecordingRow, ReminderRow};
use tokio::sync::watch;

/// Reminder lifecycle. A cancelled reminder is deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderStatus {
    Pending,
    Fired,
    Missed,
}

/// Recording lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingStatus {
    Scheduled,
    Recording,
    Completed,
    Failed,
    Missed,
    Cancelled,
}

/// A guide programme, or a live channel for a fixed duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingKind {
    Programme,
    Channel,
}

/// `reminders.list` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub channel_name: String,
    pub title: String,
    /// RFC 3339, display time.
    pub start: String,
    pub end: String,
    pub status: ReminderStatus,
}

/// `recordings.list` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub channel_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub kind: RecordingKind,
    /// Programme start and end (RFC 3339, display time), without padding.
    pub start: String,
    pub end: String,
    pub padding_before_minutes: i64,
    pub padding_after_minutes: i64,
    pub status: RecordingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Stable code of `error` for the UI to translate ([`error_code`]);
    /// absent for free-text stream errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// File names written so far (several when the stream dropped).
    pub file_names: Vec<String>,
    pub bytes: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// The series rule that created it (C5); absent for manual recordings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
}

/// `recordings.schedule` warning: more overlapping recordings on one
/// account than it allows connections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWarning {
    pub max_connections: i64,
    /// Recordings on this source overlapping the new one, itself included.
    pub overlapping: i64,
}

/// `recordings.schedule` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleResult {
    pub recording: Recording,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<ConnectionWarning>,
}

/// `recordings.capabilities` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Recording can be scheduled here.
    pub supported: bool,
    /// mpv was found. On the desktop it records HLS too; without it, and
    /// always in server mode, only plain streams can be recorded.
    pub mpv: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `reminders.fire` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderFired {
    pub reminder: Reminder,
    pub action: ReminderAction,
    /// RFC 3339 time it fired: with the id, tells one firing from a later
    /// one of the same (re-armed) reminder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fired_at: Option<String>,
}

/// `recordings.progress` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProgress {
    pub id: String,
    pub bytes: i64,
    pub elapsed_seconds: i64,
}

pub const EVENT_REMINDERS_UPDATE: &str = "reminders.update";
pub const EVENT_REMINDERS_FIRE: &str = "reminders.fire";
pub const EVENT_RECORDINGS_UPDATE: &str = "recordings.update";
pub const EVENT_RECORDINGS_PROGRESS: &str = "recordings.progress";

/// Why server mode cannot record.
pub const SERVER_NO_MPV: &str = "Recording from the browser needs mpv on the server machine. Install mpv there (on its PATH) to schedule recordings.";

const RUNTIME_KEY: &str = "recording_runtime";
/// Longest sleep of the scheduler loop.
const MAX_SLEEP: Duration = Duration::from_secs(15);
/// Guide re-match runs at most this often (and after each guide refresh).
const REMATCH_EVERY: i64 = 5 * 60;
/// Longest wait between two reconnect attempts. A recording keeps
/// reconnecting until its end: a provider that drops for a minute must not
/// cost the rest of the programme.
pub const MAX_BACKOFF_SECS: u64 = 30;
/// A part shorter than this that ended on its own counts as a failed
/// attempt: a provider answering an over-limit connection with a few seconds
/// of "too many connections" video backs off instead of reconnecting at once.
pub const MIN_PART_SECONDS: u64 = 15;
/// Most part files one recording keeps (a safety cap: small reconnect parts
/// are joined to the part before, see [`MERGE_MAX_BYTES`]).
pub const MAX_PARTS: usize = 50;
/// A reconnect part up to this size is appended to the part before it, so a
/// flaky stream still gives one file per programme (MPEG-TS joins byte for
/// byte). A larger one stays a separate part: copying it would take long
/// enough to miss more of the programme.
pub const MERGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// How often the bytes written so far are saved while a part is written, so
/// a crash mid-part still knows the recording has data.
const SAVE_BYTES_EVERY: u32 = 5;

/// True when a finished part counts as a failed attempt (the backoff before
/// the next one grows): nothing was written, or the stream ended on its own
/// within [`MIN_PART_SECONDS`].
pub fn part_failed(bytes: u64, seconds: u64, stopped: bool) -> bool {
    bytes == 0 || (!stopped && seconds < MIN_PART_SECONDS)
}

/// Wait before reconnect attempt number `failures` (consecutive failed
/// attempts so far): 1, 2, 4, 8, 16 s, then [`MAX_BACKOFF_SECS`].
pub fn backoff(failures: u32) -> Duration {
    Duration::from_secs(2u64.saturating_pow(failures.min(6)).min(MAX_BACKOFF_SECS))
}

/// Interval of `recordings.progress` events.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);

/// How a running recording is asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Running,
    User,
    Shutdown,
}

struct Active {
    stop: watch::Sender<bool>,
    reason: Arc<parking_lot::Mutex<StopReason>>,
    handle: tokio::task::JoinHandle<()>,
}

/// Scheduler state kept in `AppState.extensions`.
pub struct Runtime {
    clock: parking_lot::RwLock<Arc<dyn Clock>>,
    wake: tokio::sync::Notify,
    tick_lock: tokio::sync::Mutex<()>,
    active: parking_lot::Mutex<HashMap<String, Active>>,
    launched: AtomicBool,
    loop_started: AtomicBool,
    /// (last re-match time, guide generation then).
    rematched: parking_lot::Mutex<(i64, u64)>,
    /// Set first thing in [`shutdown`]: no tick and no engine start after it.
    shutting_down: AtomicBool,
    /// Reminders fired in this run that no window has handled yet (one may
    /// fire before the UI listens, e.g. right at launch, or while no browser
    /// tab is open in server mode).
    unhandled: parking_lot::Mutex<Vec<ReminderFired>>,
}

impl Runtime {
    fn new() -> Self {
        Self {
            clock: parking_lot::RwLock::new(Arc::new(SystemClock)),
            wake: tokio::sync::Notify::new(),
            tick_lock: tokio::sync::Mutex::new(()),
            active: parking_lot::Mutex::new(HashMap::new()),
            launched: AtomicBool::new(false),
            loop_started: AtomicBool::new(false),
            rematched: parking_lot::Mutex::new((i64::MIN, 0)),
            shutting_down: AtomicBool::new(false),
            unhandled: parking_lot::Mutex::new(Vec::new()),
        }
    }

    pub fn now(&self) -> i64 {
        self.clock.read().now()
    }

    fn active_ids(&self) -> HashSet<String> {
        let mut map = self.active.lock();
        map.retain(|_, a| !a.handle.is_finished());
        map.keys().cloned().collect()
    }
}

pub fn runtime(state: &AppState) -> Arc<Runtime> {
    state.ext_or_insert_with(RUNTIME_KEY, || Arc::new(Runtime::new()))
}

/// Replaces the clock (tests).
pub fn set_clock(state: &AppState, clock: Arc<dyn Clock>) {
    *runtime(state).clock.write() = clock;
}

fn rfc3339(ts: i64) -> String {
    Utc.timestamp_opt(ts, 0)
        .single()
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn parse_time(field: &str, s: &str) -> CoreResult<i64> {
    DateTime::parse_from_rfc3339(s.trim())
        .map(|d| d.timestamp())
        .map_err(|_| CoreError::invalid(format!("{field} must be an RFC 3339 time")))
}

fn file_name(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl From<&ReminderRow> for Reminder {
    fn from(r: &ReminderRow) -> Self {
        Self {
            id: r.id.clone(),
            item_ref: r.item_ref.clone(),
            channel_name: r.channel_name.clone(),
            title: r.title.clone(),
            start: rfc3339(r.start_at),
            end: rfc3339(r.end_at),
            status: r.status,
        }
    }
}

impl From<&RecordingRow> for Recording {
    fn from(r: &RecordingRow) -> Self {
        Self {
            id: r.id.clone(),
            item_ref: r.item_ref.clone(),
            channel_name: r.channel_name.clone(),
            title: r.title.clone(),
            kind: r.kind,
            start: rfc3339(r.start_at),
            end: rfc3339(r.end_at),
            padding_before_minutes: r.padding_before,
            padding_after_minutes: r.padding_after,
            status: r.status,
            error: r.error_message.clone(),
            error_code: r
                .error_message
                .as_deref()
                .and_then(error_code)
                .map(str::to_owned),
            file_names: r.parts.iter().map(|p| file_name(p)).collect(),
            bytes: r.bytes,
            started_at: r.started_at.map(rfc3339),
            ended_at: r.ended_at.map(rfc3339),
            engine: r.engine.clone(),
            rule_id: r.rule_id.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/// `reminders.add` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRequest {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub channel_name: String,
    pub title: String,
    pub start: String,
    pub end: String,
}

fn check_live(r: &ItemRef) -> CoreResult<()> {
    if !matches!(r.content_type, ContentType::Live | ContentType::Radio) {
        return Err(CoreError::invalid("only live channels have a guide"));
    }
    Ok(())
}

/// Adds a reminder for a future programme (the existing one when the same
/// programme already has one; one that already fired or was missed is
/// re-armed, so it fires again).
pub async fn add_reminder(state: &Arc<AppState>, req: ReminderRequest) -> CoreResult<Reminder> {
    check_live(&req.item_ref)?;
    let start = parse_time("start", &req.start)?;
    let end = parse_time("end", &req.end)?;
    if end <= start {
        return Err(CoreError::invalid("the programme must end after it starts"));
    }
    let now = runtime(state).now();
    if start <= now {
        return Err(CoreError::invalid(
            "This programme has already started, so there is nothing to remind you of.",
        ));
    }
    let row = ReminderRow {
        id: uuid::Uuid::new_v4().to_string(),
        item_ref: req.item_ref,
        channel_name: req.channel_name.trim().to_string(),
        title: req.title.trim().to_string(),
        start_at: start,
        end_at: end,
        status: ReminderStatus::Pending,
        fired_at: None,
        created_at: now,
    };
    let out = state
        .db_call(move |c| {
            if let Some(existing) = store::reminder_for(c, &row.item_ref, row.start_at)? {
                if existing.status == ReminderStatus::Pending {
                    return Ok(existing);
                }
                let again = ReminderRow {
                    id: existing.id,
                    created_at: existing.created_at,
                    ..row
                };
                store::rearm_reminder(c, &again)?;
                return Ok(again);
            }
            store::insert_reminder(c, &row)?;
            Ok(row)
        })
        .await?;
    changed(state, EVENT_REMINDERS_UPDATE);
    Ok(Reminder::from(&out))
}

/// Deletes a reminder. Missing is success (the toggle may race a purge).
pub async fn remove_reminder(state: &Arc<AppState>, id: &str) -> CoreResult<()> {
    let id = id.to_string();
    let key = id.clone();
    let removed = state
        .db_call(move |c| store::delete_reminder(c, &key))
        .await?;
    ack_reminder(state, &id);
    if removed {
        changed(state, EVENT_REMINDERS_UPDATE);
    }
    Ok(())
}

pub async fn list_reminders(state: &Arc<AppState>) -> CoreResult<Vec<Reminder>> {
    let rows = state.db_call(|c| store::reminders(c)).await?;
    Ok(rows.iter().map(Reminder::from).collect())
}

/// `reminders.unhandled`: reminders fired in this run that no window has
/// acknowledged yet and whose programme has not ended. A window calls it
/// when it starts listening, so a reminder that fired before (at launch, or
/// with no browser tab open) still reaches the user.
pub fn unhandled_reminders(state: &AppState) -> Vec<ReminderFired> {
    let rt = runtime(state);
    let now = rt.now();
    let mut list = rt.unhandled.lock();
    list.retain(|f| {
        DateTime::parse_from_rfc3339(&f.reminder.end).is_ok_and(|e| e.timestamp() > now)
    });
    list.clone()
}

/// `reminders.ack`: a window handled this fired reminder.
pub fn ack_reminder(state: &AppState, id: &str) {
    runtime(state)
        .unhandled
        .lock()
        .retain(|f| f.reminder.id != id);
}

/// Called when a source is removed: deletes its reminders, cancels its
/// scheduled recordings and stops its running ones (what they wrote is
/// kept). Finished rows and their files stay for My Videos.
pub async fn forget_source(state: &AppState, source_id: &str) {
    let rt = runtime(state);
    let now = rt.now();
    let sid = source_id.to_string();
    let result = state
        .db_call(move |c| {
            let reminders = store::delete_reminders_for_source(c, &sid)?;
            let mut cancelled = 0;
            for id in store::ids_for_source(c, &sid, RecordingStatus::Scheduled)? {
                if store::transition(
                    c,
                    &id,
                    &[RecordingStatus::Scheduled],
                    RecordingStatus::Cancelled,
                    Some(now),
                    Some(SOURCE_REMOVED_MESSAGE),
                )? {
                    cancelled += 1;
                }
            }
            let running = store::ids_for_source(c, &sid, RecordingStatus::Recording)?;
            Ok((reminders, cancelled, running))
        })
        .await;
    let (reminders, cancelled, running) = match result {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "could not clear the removed source's recordings");
            return;
        }
    };
    {
        let mut list = rt.unhandled.lock();
        list.retain(|f| f.reminder.item_ref.source_id != source_id);
    }
    for id in &running {
        if let Ok(row) = get_row(state, id).await {
            if let Err(e) = stop_running(state, &rt, &row).await {
                tracing::warn!(error = %e, "could not stop a recording of a removed source");
            }
        }
    }
    if reminders > 0 {
        changed(state, EVENT_REMINDERS_UPDATE);
    }
    if cancelled > 0 || !running.is_empty() {
        changed(state, EVENT_RECORDINGS_UPDATE);
    }
}

/// Folders holding recorded parts (any recordings folder used before), so
/// the desktop shell can let the built-in player read them after the
/// recordings folder changed.
pub async fn known_dirs(state: &AppState) -> CoreResult<Vec<PathBuf>> {
    let rows = state.db_call(|c| store::recordings(c)).await?;
    let dirs: std::collections::BTreeSet<PathBuf> = rows
        .iter()
        .flat_map(|r| r.parts.iter())
        .filter_map(|p| {
            std::path::Path::new(p)
                .parent()
                .map(std::path::Path::to_path_buf)
        })
        .filter(|d| !d.as_os_str().is_empty())
        .collect();
    Ok(dirs.into_iter().collect())
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/// `recordings.schedule` arguments: a programme (`title`, `start`, `end`),
/// or a live channel from now for `durationMinutes`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRequest {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub channel_name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub duration_minutes: Option<i64>,
}

/// Longest channel recording, and longest programme recording (a guide
/// programme longer than this is a placeholder, not a show).
pub const MAX_DURATION_MINUTES: i64 = 12 * 60;
/// Furthest ahead a programme recording can start.
pub const MAX_DAYS_AHEAD: i64 = 30;
/// Why a programme is refused as too long.
pub const PROGRAMME_TOO_LONG_MESSAGE: &str = "This programme is longer than 12 hours, so the guide entry is probably a placeholder. Record the channel for a set time instead.";
/// Why a programme is refused as too far ahead.
pub const TOO_FAR_AHEAD_MESSAGE: &str = "Recordings can be scheduled up to 30 days ahead.";

/// Checks a programme's times: it ends after it starts, lasts at most
/// [`MAX_DURATION_MINUTES`] and starts at most [`MAX_DAYS_AHEAD`] days after
/// `now`.
pub fn check_programme_times(start: i64, end: i64, now: i64) -> CoreResult<()> {
    if end <= start {
        return Err(CoreError::invalid("the programme must end after it starts"));
    }
    if end - start > MAX_DURATION_MINUTES * 60 {
        return Err(CoreError::invalid(PROGRAMME_TOO_LONG_MESSAGE));
    }
    if start > now + MAX_DAYS_AHEAD * 86_400 {
        return Err(CoreError::invalid(TOO_FAR_AHEAD_MESSAGE));
    }
    Ok(())
}

/// Why recording is or is not possible here.
pub fn capabilities(state: &AppState) -> Capabilities {
    let mpv = engine::mpv_path(state).is_some();
    if crate::http::is_server_mode(state) && !mpv {
        return Capabilities {
            supported: false,
            mpv,
            reason: Some(SERVER_NO_MPV.into()),
        };
    }
    Capabilities {
        supported: true,
        mpv,
        reason: None,
    }
}

/// Schedules a recording. A programme that is already airing starts at the
/// next tick. Returns a warning when the account's connection limit would be
/// exceeded by overlapping recordings (it does not block).
pub async fn schedule(state: &Arc<AppState>, req: ScheduleRequest) -> CoreResult<ScheduleResult> {
    let caps = capabilities(state);
    if !caps.supported {
        return Err(CoreError::Unsupported(
            caps.reason.unwrap_or_else(|| SERVER_NO_MPV.into()),
        ));
    }
    check_live(&req.item_ref)?;
    check_engine(state, &req.item_ref).await?;
    let rt = runtime(state);
    let now = rt.now();
    let settings = state.settings_snapshot();
    let channel_name = req.channel_name.trim().to_string();
    let (kind, title, start, end, pad_before, pad_after) = match req.duration_minutes {
        Some(d) => {
            if !(1..=MAX_DURATION_MINUTES).contains(&d) {
                return Err(CoreError::invalid(format!(
                    "durationMinutes must be between 1 and {MAX_DURATION_MINUTES}"
                )));
            }
            (RecordingKind::Channel, None, now, now + d * 60, 0, 0)
        }
        None => {
            let (Some(s), Some(e)) = (req.start.as_deref(), req.end.as_deref()) else {
                return Err(CoreError::invalid(
                    "give start and end for a programme, or durationMinutes for a channel",
                ));
            };
            let start = parse_time("start", s)?;
            let end = parse_time("end", e)?;
            check_programme_times(start, end, now)?;
            let title = req
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned);
            (
                RecordingKind::Programme,
                title,
                start,
                end,
                i64::from(settings.recording_padding_before_minutes),
                i64::from(settings.recording_padding_after_minutes),
            )
        }
    };
    let row = RecordingRow {
        id: uuid::Uuid::new_v4().to_string(),
        item_ref: req.item_ref.clone(),
        channel_name,
        title,
        kind,
        start_at: start,
        end_at: end,
        padding_before: pad_before,
        padding_after: pad_after,
        status: RecordingStatus::Scheduled,
        error_message: None,
        parts: Vec::new(),
        bytes: 0,
        started_at: None,
        ended_at: None,
        engine: None,
        created_at: now,
        rule_id: None,
    };
    if row.effective_end() <= now {
        return Err(CoreError::invalid("This programme has already ended."));
    }
    let insert = row.clone();
    let overlapping = state
        .db_call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let overlapping = insert_scheduled(&tx, &insert)?;
            tx.commit()?;
            Ok(overlapping)
        })
        .await?;
    changed(state, EVENT_RECORDINGS_UPDATE);
    rt.wake.notify_one();
    let warning = connection_warning(state, &req.item_ref.source_id, overlapping).await;
    Ok(ScheduleResult {
        recording: Recording::from(&row),
        warning,
    })
}

/// The insert step of [`schedule`], shared with series rules
/// ([`rules::materialise`]): refuses a programme already scheduled or
/// recording on the same channel at the same start (`Conflict`), then
/// inserts `insert` and returns how many scheduled or running recordings
/// of the source overlap it, itself included.
///
/// Call inside an IMMEDIATE transaction: the check and the insert must not
/// interleave with another writer's (a manual schedule racing a rule), or
/// both pass the check and one airing is recorded twice.
fn insert_scheduled(c: &rusqlite::Connection, insert: &RecordingRow) -> CoreResult<i64> {
    debug_assert!(!c.is_autocommit(), "insert_scheduled runs in a transaction");
    let all = store::recordings(c)?;
    let busy: Vec<&RecordingRow> = all
        .iter()
        .filter(|r| {
            matches!(
                r.status,
                RecordingStatus::Scheduled | RecordingStatus::Recording
            )
        })
        .collect();
    if busy.iter().any(|r| {
        r.item_ref == insert.item_ref
            && r.kind == RecordingKind::Programme
            && insert.kind == RecordingKind::Programme
            && r.start_at == insert.start_at
    }) {
        return Err(CoreError::Conflict(
            "This programme is already scheduled to record.".into(),
        ));
    }
    let overlapping = busy
        .iter()
        .filter(|r| {
            r.item_ref.source_id == insert.item_ref.source_id
                && r.effective_start() < insert.effective_end()
                && insert.effective_start() < r.effective_end()
        })
        .count() as i64;
    store::insert_recording(c, insert)?;
    Ok(overlapping + 1)
}

/// Without mpv, and always in server mode ([`engine::recorder_mpv`]), only
/// plain streams can be recorded (the HTTP copy). Refuses up front a
/// channel whose stream is HLS or DASH, instead of failing at start time
/// with the user away. A stream that cannot be resolved now is let through
/// (it is checked again when the recording starts).
async fn check_engine(state: &Arc<AppState>, r: &ItemRef) -> CoreResult<()> {
    if engine::recorder_mpv(state).is_some() {
        return Ok(());
    }
    let resolved = tokio::time::timeout(Duration::from_secs(10), resolve_source(state, r)).await;
    match resolved {
        Ok(Ok((source, kind))) => engine::choose(state, source, kind, false).map(|_| ()),
        _ => Ok(()),
    }
}

/// Connection limit of an Xtream account (`None` for other sources, an
/// unknown limit, or an unreachable server).
async fn connection_warning(
    state: &Arc<AppState>,
    source_id: &str,
    overlapping: i64,
) -> Option<ConnectionWarning> {
    if overlapping < 2 {
        return None;
    }
    let source = crate::sources::get(state, source_id).await.ok()?;
    if source.kind != SourceKind::Xtream {
        return None;
    }
    let info = tokio::time::timeout(
        Duration::from_secs(5),
        crate::xtream::service::account_info(state, source_id),
    )
    .await
    .ok()?
    .ok()?;
    (info.max_connections > 0 && overlapping > info.max_connections).then_some(ConnectionWarning {
        max_connections: info.max_connections,
        overlapping,
    })
}

pub async fn list_recordings(state: &Arc<AppState>) -> CoreResult<Vec<Recording>> {
    let rows = state.db_call(|c| store::recordings(c)).await?;
    Ok(rows.iter().map(Recording::from).collect())
}

/// Cancels a scheduled recording, or stops a running one (what was
/// recorded is kept and the row completes).
pub async fn cancel(state: &Arc<AppState>, id: &str) -> CoreResult<()> {
    let rt = runtime(state);
    let row = get_row(state, id).await?;
    match row.status {
        RecordingStatus::Scheduled => {
            let key = id.to_string();
            let now = rt.now();
            let rule = row.rule_id.clone().map(|r| (r, row.start_at));
            let done = state
                .db_call(move |c| {
                    let done = store::transition(
                        c,
                        &key,
                        &[RecordingStatus::Scheduled],
                        RecordingStatus::Cancelled,
                        Some(now),
                        None,
                    )?;
                    // Its series rule must not create this airing again (C5).
                    if let (true, Some((rule_id, start))) = (done, rule) {
                        rules::add_skip(c, &rule_id, start)?;
                    }
                    Ok(done)
                })
                .await?;
            if done {
                changed(state, EVENT_RECORDINGS_UPDATE);
                return Ok(());
            }
            // It started meanwhile: stop it like a running one.
            let row = get_row(state, id).await?;
            if row.status == RecordingStatus::Recording {
                stop_running(state, &rt, &row).await?;
            }
            Ok(())
        }
        RecordingStatus::Recording => stop_running(state, &rt, &row).await,
        other => Err(CoreError::Conflict(format!(
            "This recording is already {}.",
            serde_json::to_value(other)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        ))),
    }
}

/// Removes a finished row from the list (its files stay; delete those from
/// My Videos).
pub async fn remove(state: &Arc<AppState>, id: &str) -> CoreResult<()> {
    let row = get_row(state, id).await?;
    if matches!(
        row.status,
        RecordingStatus::Scheduled | RecordingStatus::Recording
    ) {
        return Err(CoreError::Conflict(
            "Cancel this recording before removing it.".into(),
        ));
    }
    let id = id.to_string();
    state
        .db_call(move |c| store::delete_recording(c, &id))
        .await?;
    changed(state, EVENT_RECORDINGS_UPDATE);
    Ok(())
}

/// Stops a `recording` row: signals its engine, or closes the row here when
/// no engine runs (between attempts at boot).
async fn stop_running(state: &AppState, rt: &Runtime, row: &RecordingRow) -> CoreResult<()> {
    if !signal_stop(rt, &row.id, StopReason::User) {
        close_orphan(state, row, Some(STOPPED_MESSAGE)).await?;
    }
    Ok(())
}

async fn get_row(state: &AppState, id: &str) -> CoreResult<RecordingRow> {
    let key = id.to_string();
    state
        .db_call(move |c| store::recording_by_id(c, &key))
        .await?
        .ok_or_else(|| CoreError::NotFound(format!("recording {id} not found")))
}

fn changed(state: &AppState, event: &str) {
    state.emit(event, serde_json::json!({}));
}

fn signal_stop(rt: &Runtime, id: &str, reason: StopReason) -> bool {
    let map = rt.active.lock();
    match map.get(id) {
        Some(a) if !a.handle.is_finished() => {
            *a.reason.lock() = reason;
            let _ = a.stop.send(true);
            true
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/// Starts the scheduler loop (once).
pub async fn init(state: Arc<AppState>) -> CoreResult<()> {
    let rt = runtime(&state);
    if rt.loop_started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let weak = Arc::downgrade(&state);
    drop(state);
    tokio::spawn(run_loop(weak, rt));
    Ok(())
}

async fn run_loop(weak: Weak<AppState>, rt: Arc<Runtime>) {
    loop {
        if rt.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let sleep = {
            let Some(state) = weak.upgrade() else {
                return;
            };
            match tick(&state).await {
                Ok(next) => next
                    .map(|t| Duration::from_secs((t - rt.now()).max(1) as u64))
                    .unwrap_or(MAX_SLEEP)
                    .min(MAX_SLEEP),
                Err(e) => {
                    tracing::warn!(error = %e, "recording scheduler tick failed");
                    MAX_SLEEP
                }
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(sleep) => {}
            _ = rt.wake.notified() => {}
        }
    }
}

/// One scheduling pass at the clock's "now". Returns the next due time.
pub async fn tick(state: &Arc<AppState>) -> CoreResult<Option<i64>> {
    let rt = runtime(state);
    let _guard = rt.tick_lock.lock().await;
    if rt.shutting_down.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let now = rt.now();
    if !rt.launched.swap(true, Ordering::SeqCst) {
        let rows = state.db_call(|c| store::recordings(c)).await?;
        let actions = scheduler::launch_plan(now, &rows);
        if !actions.is_empty() {
            apply(state, &rt, now, actions).await?;
        }
    }
    maybe_rematch(state, &rt, now).await;
    let settings = state.settings_snapshot();
    // Engines first, rows second: an engine that ends in between has already
    // written its final status, so its row is never mistaken for an orphan.
    let active = rt.active_ids();
    let (reminders, recordings) = state
        .db_call(|c| Ok((store::reminders(c)?, store::recordings(c)?)))
        .await?;
    let input = PlanInput {
        now,
        reminders_enabled: settings.reminders_enabled,
        lead_minutes: i64::from(settings.reminder_lead_minutes),
        reminders: &reminders,
        recordings: &recordings,
        active: &active,
    };
    let actions = scheduler::plan(&input);
    let next = scheduler::next_wake(&input);
    if !actions.is_empty() {
        apply(state, &rt, now, actions).await?;
    }
    Ok(next)
}

/// Message on a recording that was due while the app was closed.
pub const MISSED_MESSAGE: &str = "The app was not running when this recording was due.";
/// A recording stopped because the app quit.
pub const STOPPED_SHUTDOWN_MESSAGE: &str = "Recording stopped early: the app was closing.";
/// A `recording` row found with no engine after a crash (something written).
pub const CLOSED_EARLY_MESSAGE: &str =
    "Recording stopped early: the app closed while it was running.";
/// The same with nothing written.
pub const CLOSED_NOTHING_MESSAGE: &str = "The app closed before anything was recorded.";
/// Failed with no stream error to report.
pub const NOTHING_RECORDED_MESSAGE: &str = "Nothing was recorded.";
/// Stopped by the user while no engine ran.
pub const STOPPED_MESSAGE: &str = "Stopped.";
/// The channel's source was removed.
pub const SOURCE_REMOVED_MESSAGE: &str = "The source of this channel was removed.";
/// Gave up after the stream kept dropping (what was written is kept).
pub const STREAM_DROPPED_MESSAGE: &str = "Recording stopped early: the stream kept dropping.";
/// Prefix of the note on a recording waiting to reconnect.
pub const RECONNECTING_PREFIX: &str = "Reconnecting: ";
/// Completed, but the stream dropped at least once on the way.
pub const STREAM_GAPS_MESSAGE: &str =
    "The stream dropped during the recording, so parts of the programme may be missing.";
/// The stream address answered 404 or 410.
pub const STREAM_NOT_FOUND_MESSAGE: &str = "The channel's stream address no longer exists. Refresh the source, then schedule the recording again.";
/// The stream address answered 401, 403 or another refusal.
pub const STREAM_REJECTED_MESSAGE: &str = "The provider refused the stream. Check that the subscription is active and not already using all of its connections.";
/// The provider's server could not be reached or sent no answer.
pub const STREAM_NO_ANSWER_MESSAGE: &str = "The provider's server did not answer. Check the internet connection and that the server is online.";
/// The provider's server answered 429 or 5xx.
pub const STREAM_SERVER_ERROR_MESSAGE: &str =
    "The provider's server is busy or down. Try again later.";
/// The stream address answered with a web page.
pub const NOT_A_STREAM_MESSAGE: &str = "The channel's address answered with a web page, not a video stream. Refresh the source, then schedule the recording again.";
/// The recordings folder's disk is full.
pub const DISK_FULL_MESSAGE: &str =
    "The disk is full. Free some space or choose another recordings folder in Settings.";
/// A scheduled airing cancelled because its series rule was removed (a rule
/// added again may schedule it again, unlike an airing the user cancelled).
pub const RULE_REMOVED_MESSAGE: &str = "Cancelled because its series rule was removed.";

/// Stable code (camelCase) of a status message this module writes, so the
/// UI can translate it; `None` for free-text stream errors.
pub fn error_code(message: &str) -> Option<&'static str> {
    if message.starts_with(RECONNECTING_PREFIX) {
        return Some("reconnecting");
    }
    if message.contains(engine::ENGINE_MISSING_MESSAGE) {
        return Some("engineMissing");
    }
    if message.contains(engine::SERVER_HTTP_ONLY_MESSAGE) {
        return Some("serverHttpOnly");
    }
    Some(match message {
        MISSED_MESSAGE => "missedNotRunning",
        STOPPED_SHUTDOWN_MESSAGE => "stoppedShutdown",
        CLOSED_EARLY_MESSAGE => "closedEarly",
        CLOSED_NOTHING_MESSAGE => "closedNothing",
        NOTHING_RECORDED_MESSAGE => "nothingRecorded",
        STOPPED_MESSAGE => "stopped",
        SOURCE_REMOVED_MESSAGE => "sourceRemoved",
        STREAM_DROPPED_MESSAGE => "streamDropped",
        STREAM_GAPS_MESSAGE => "streamGaps",
        STREAM_NOT_FOUND_MESSAGE => "streamNotFound",
        STREAM_REJECTED_MESSAGE => "streamRejected",
        STREAM_NO_ANSWER_MESSAGE => "streamNoAnswer",
        STREAM_SERVER_ERROR_MESSAGE => "streamServerError",
        NOT_A_STREAM_MESSAGE => "notAStream",
        DISK_FULL_MESSAGE => "diskFull",
        RULE_REMOVED_MESSAGE => "ruleRemoved",
        _ => return None,
    })
}

async fn apply(
    state: &Arc<AppState>,
    rt: &Arc<Runtime>,
    now: i64,
    actions: Vec<Action>,
) -> CoreResult<()> {
    let action_setting = state.settings_snapshot().reminder_action;
    let mut reminders_changed = false;
    let mut recordings_changed = false;
    for action in actions {
        match action {
            Action::FireReminder(id) => {
                let key = id.clone();
                let row = state
                    .db_call(move |c| {
                        store::set_reminder_status(c, &key, ReminderStatus::Fired, Some(now))?;
                        store::reminder_by_id(c, &key)
                    })
                    .await?;
                if let Some(row) = row {
                    let fired = ReminderFired {
                        reminder: Reminder::from(&row),
                        action: action_setting,
                        fired_at: Some(rfc3339(now)),
                    };
                    {
                        let mut list = rt.unhandled.lock();
                        list.retain(|f| f.reminder.id != fired.reminder.id);
                        list.push(fired.clone());
                    }
                    state.emit(EVENT_REMINDERS_FIRE, fired);
                }
                reminders_changed = true;
            }
            Action::MissReminder(id) => {
                state
                    .db_call(move |c| {
                        store::set_reminder_status(c, &id, ReminderStatus::Missed, None)
                    })
                    .await?;
                reminders_changed = true;
            }
            Action::PurgeReminder(id) => {
                state
                    .db_call(move |c| store::delete_reminder(c, &id))
                    .await?;
                reminders_changed = true;
            }
            Action::StartRecording(id) | Action::ResumeRecording(id) => {
                start_engine(state, rt, &id);
                recordings_changed = true;
            }
            Action::MissRecording(id) => {
                state
                    .db_call(move |c| {
                        store::transition(
                            c,
                            &id,
                            &[RecordingStatus::Scheduled],
                            RecordingStatus::Missed,
                            Some(now),
                            Some(MISSED_MESSAGE),
                        )
                    })
                    .await?;
                recordings_changed = true;
            }
            Action::StopRecording(id) => {
                signal_stop(rt, &id, StopReason::Running);
            }
            Action::CloseRecording(id) => {
                if let Ok(row) = get_row(state, &id).await {
                    close_orphan(state, &row, None).await?;
                }
            }
        }
    }
    if reminders_changed {
        changed(state, EVENT_REMINDERS_UPDATE);
    }
    if recordings_changed {
        changed(state, EVENT_RECORDINGS_UPDATE);
    }
    Ok(())
}

/// Closes a `recording` row that has no engine (after a crash, or when its
/// end passed): completed when anything was written, else failed.
async fn close_orphan(state: &AppState, row: &RecordingRow, note: Option<&str>) -> CoreResult<()> {
    let now = runtime(state).now();
    let id = row.id.clone();
    // The files decide, not `row.bytes`: a crash mid-part leaves the row
    // with the bytes saved last while the file holds everything written.
    let parts = row.parts.clone();
    let on_disk = tokio::task::spawn_blocking(move || total_bytes(&parts))
        .await
        .unwrap_or(0);
    let bytes = if on_disk > 0 { on_disk } else { row.bytes };
    let parts = row.parts.clone();
    let (status, msg) = if bytes > 0 {
        (
            RecordingStatus::Completed,
            note.unwrap_or(CLOSED_EARLY_MESSAGE).to_string(),
        )
    } else {
        (RecordingStatus::Failed, CLOSED_NOTHING_MESSAGE.to_string())
    };
    let done = state
        .db_call(move |c| {
            let done = store::transition(
                c,
                &id,
                &[RecordingStatus::Recording],
                status,
                Some(now),
                Some(&msg),
            )?;
            if done && on_disk > 0 {
                store::set_progress(c, &id, &parts, on_disk)?;
            }
            Ok(done)
        })
        .await?;
    if done {
        changed(state, EVENT_RECORDINGS_UPDATE);
    }
    Ok(())
}

fn start_engine(state: &Arc<AppState>, rt: &Arc<Runtime>, id: &str) {
    let mut map = rt.active.lock();
    // Checked under the lock `shutdown` takes after setting the flag, so an
    // engine is either started before (and stopped by it) or not at all.
    if rt.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    if map.get(id).is_some_and(|a| !a.handle.is_finished()) {
        return;
    }
    let (tx, rx) = watch::channel(false);
    let reason = Arc::new(parking_lot::Mutex::new(StopReason::Running));
    let handle = tokio::spawn(run(
        Arc::clone(state),
        id.to_string(),
        rx,
        Arc::clone(&reason),
    ));
    map.insert(
        id.to_string(),
        Active {
            stop: tx,
            reason,
            handle,
        },
    );
}

/// Effective recordings folder (`settings.recordingsDir`, else
/// `<downloadsDir>/recordings`).
pub fn dir(state: &AppState) -> PathBuf {
    crate::player::embedded::recordings_dir(state)
}

/// Resolves the stream the player would use for a channel, with the same
/// headers (M3U: playlist headers overridden by per-channel ones).
pub async fn resolve_source(
    state: &Arc<AppState>,
    r: &ItemRef,
) -> CoreResult<(PlayerSource, SourceKind)> {
    let source = crate::sources::get(state, &r.source_id).await?;
    let out = match source.kind {
        SourceKind::Xtream => crate::xtream::service::stream_url(state, r, None).await?,
        SourceKind::Stalker => crate::stalker::playback::stream_url(state, r, None).await?,
        SourceKind::M3u => {
            let key = r.clone();
            let row = state
                .db_call(move |c| crate::catalog::get(c, &key))
                .await?
                .ok_or_else(|| {
                    CoreError::NotFound("This channel is no longer in the playlist.".into())
                })?;
            let url = row
                .url
                .clone()
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| CoreError::NotFound("This channel has no stream address.".into()))?;
            let mut headers = source.m3u.map(|m| m.headers).unwrap_or_default();
            if let Some(ch) = row.headers() {
                headers.user_agent = ch.user_agent.or(headers.user_agent);
                headers.referrer = ch.referrer.or(headers.referrer);
                headers.origin = ch.origin.or(headers.origin);
            }
            let path = url
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            PlayerSource {
                kind: if path.ends_with(".m3u8") {
                    PlayerKind::Hls
                } else if path.ends_with(".mpd") {
                    PlayerKind::Dash
                } else {
                    PlayerKind::Direct
                },
                url,
                headers: (!headers.is_empty()).then_some(headers),
                title: row.title.clone(),
                subtitle: None,
                poster_url: row.logo_url.clone(),
                item_ref: Some(r.clone()),
                episode_id: None,
                resume_seconds: None,
                is_live: true,
                is_radio: row.is_radio,
            }
        }
    };
    Ok((out, source.kind))
}

fn file_len(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn total_bytes(parts: &[String]) -> i64 {
    parts
        .iter()
        .map(|p| file_len(std::path::Path::new(p)))
        .sum::<u64>() as i64
}

/// The engine task of one recording: resolve, record a part, retry with a
/// new part file when the stream drops, until the padded end or a stop.
async fn run(
    state: Arc<AppState>,
    id: String,
    mut stop: watch::Receiver<bool>,
    reason: Arc<parking_lot::Mutex<StopReason>>,
) {
    let rt = runtime(&state);
    let outcome = record(&state, &rt, &id, &mut stop).await;
    let reason = *reason.lock();
    let now = rt.now();
    let (status, error) = match outcome {
        Ok(done) => {
            if done.bytes > 0 {
                let note = if reason == StopReason::Shutdown {
                    Some(STOPPED_SHUTDOWN_MESSAGE.to_string())
                } else if done.gave_up {
                    Some(STREAM_DROPPED_MESSAGE.to_string())
                } else if done.dropped {
                    Some(STREAM_GAPS_MESSAGE.to_string())
                } else {
                    None
                };
                (RecordingStatus::Completed, note)
            } else if reason == StopReason::User {
                (RecordingStatus::Cancelled, None)
            } else {
                (
                    RecordingStatus::Failed,
                    Some(
                        done.last_error
                            .unwrap_or_else(|| NOTHING_RECORDED_MESSAGE.into()),
                    ),
                )
            }
        }
        Err(e) => (RecordingStatus::Failed, Some(e.to_string())),
    };
    // Only a row this engine owns (still `recording`) is finished here; a
    // row cancelled or finished meanwhile keeps its state.
    let key = id.clone();
    if let Err(e) = state
        .db_call(move |c| {
            store::transition(
                c,
                &key,
                &[RecordingStatus::Recording],
                status,
                Some(now),
                error.as_deref(),
            )
        })
        .await
    {
        tracing::warn!(error = %e, "could not save the end of a recording");
    }
    changed(&state, EVENT_RECORDINGS_UPDATE);
    rt.wake.notify_one();
}

/// What [`record`] wrote.
struct Recorded {
    bytes: i64,
    last_error: Option<String>,
    /// Stopped early: the stream dropped so often that [`MAX_PARTS`] large
    /// parts were written.
    gave_up: bool,
    /// The stream dropped at least once after something was recorded.
    dropped: bool,
}

/// An error's message without its kind prefix ("not found: ...").
fn plain(e: CoreError) -> String {
    crate::error::RpcError::from(e).message
}

/// Records until the end; returns total bytes and the last stream error.
/// A row that is no longer scheduled or recording (cancelled or finished
/// meanwhile) is left alone.
async fn record(
    state: &Arc<AppState>,
    rt: &Arc<Runtime>,
    id: &str,
    stop: &mut watch::Receiver<bool>,
) -> CoreResult<Recorded> {
    let row = get_row(state, id).await?;
    let started = rt.now();
    {
        let key = id.to_string();
        let ok = state
            .db_call(move |c| store::mark_started(c, &key, started, ""))
            .await?;
        if !ok {
            return Err(CoreError::Conflict(
                "This recording is no longer scheduled.".into(),
            ));
        }
        changed(state, EVENT_RECORDINGS_UPDATE);
    }
    let until = tokio::time::Instant::now()
        + Duration::from_secs((row.effective_end() - rt.now()).max(0) as u64);
    let dir = dir(state);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        CoreError::Io(std::io::Error::new(
            e.kind(),
            format!(
                "could not create the recordings folder {}: {e}",
                dir.display()
            ),
        ))
    })?;
    let local_start = chrono::Local
        .timestamp_opt(row.start_at, 0)
        .single()
        .unwrap_or_else(chrono::Local::now);
    let stem = naming::file_stem(&row.channel_name, row.title.as_deref(), local_start);
    let mut parts = row.parts.clone();
    let mut failures: u32 = 0;
    let mut gave_up = false;
    let mut dropped = false;
    let mut last_error: Option<String> = None;
    // A part copied over HTTP failed: mpv records the rest when installed.
    let mut http_failed = false;
    let elapsed_base = row.started_at.unwrap_or(started);
    // Keeps reconnecting until the end (or a stop): only a refusal that
    // retrying cannot change ends it early.
    loop {
        if *stop.borrow() || tokio::time::Instant::now() >= until {
            break;
        }
        match resolve_source(state, &row.item_ref).await {
            Err(e) => {
                failures += 1;
                last_error = Some(plain(e));
            }
            Ok((source, kind)) => {
                let (engine, source) = engine::choose(state, source, kind, http_failed)?;
                crate::player::args::validate_play_url(&source)?;
                // Server mode: the same fetch guard as the stream proxy. A
                // refusal is final (retrying cannot change it).
                engine::check_server_target(state, &source.url, &row.item_ref.source_id).await?;
                {
                    let key = id.to_string();
                    let name = engine.name();
                    let ok = state
                        .db_call(move |c| store::mark_started(c, &key, started, name))
                        .await?;
                    if !ok {
                        break;
                    }
                }
                let path = {
                    let (dir, stem, index) = (dir.clone(), stem.clone(), parts.len());
                    tokio::task::spawn_blocking(move || naming::create_part(&dir, &stem, index))
                        .await
                        .map_err(|e| CoreError::Other(anyhow::anyhow!(e.to_string())))??
                };
                parts.push(path.to_string_lossy().into_owned());
                save_progress(state, id, &parts).await;
                let part_started = tokio::time::Instant::now();
                let ticker = spawn_progress(
                    Arc::clone(state),
                    id.to_string(),
                    parts.clone(),
                    elapsed_base,
                );
                let end = engine::record_part(
                    state,
                    &engine,
                    &source,
                    &row.item_ref.source_id,
                    &path,
                    until,
                    stop,
                )
                .await;
                ticker.abort();
                let len = file_len(&path);
                if len == 0 {
                    let _ = crate::downloads::naming::remove_regular_file(&path);
                    parts.pop();
                }
                let failed = part_failed(len, part_started.elapsed().as_secs(), end.stopped);
                if failed {
                    failures += 1;
                } else {
                    failures = 0;
                }
                if len > 0 && parts.len() >= 2 && len <= MERGE_MAX_BYTES {
                    join_last_part(&mut parts).await;
                }
                save_progress(state, id, &parts).await;
                if end.stopped {
                    break;
                }
                dropped |= total_bytes(&parts) > 0;
                if failed
                    && !http_failed
                    && engine == engine::Engine::Http
                    && engine::recorder_mpv(state).is_some()
                {
                    // The copy could not record this stream (a provider that
                    // refuses the TS variant, or a manifest behind a plain
                    // address): mpv takes over at once.
                    http_failed = true;
                    continue;
                }
                if let Some(err) = end.error {
                    // Says why in words the user can act on when the
                    // address, the provider or the disk is the cause.
                    let why = if failed {
                        tokio::select! {
                            w = engine::diagnose(state, &source, &row.item_ref.source_id, &dir) => w,
                            _ = tokio::time::sleep_until(until) => None,
                            _ = stop.changed() => None,
                        }
                    } else {
                        None
                    };
                    last_error = Some(why.map(str::to_owned).unwrap_or(err));
                }
            }
        }
        if parts.len() >= MAX_PARTS {
            gave_up = true;
            break;
        }
        if let Some(err) = &last_error {
            let key = id.to_string();
            let msg = format!("{RECONNECTING_PREFIX}{err}");
            let _ = state
                .db_call(move |c| store::set_error(c, &key, Some(&msg)))
                .await;
            changed(state, EVENT_RECORDINGS_UPDATE);
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff(failures)) => {}
            _ = tokio::time::sleep_until(until) => {}
            _ = stop.changed() => {}
        }
    }
    let bytes = total_bytes(&parts);
    if bytes > 0 {
        let key = id.to_string();
        let _ = state
            .db_call(move |c| store::set_error(c, &key, None))
            .await;
    }
    Ok(Recorded {
        bytes,
        last_error,
        gave_up,
        dropped,
    })
}

/// Appends the last part to the one before it and forgets it (see
/// [`MERGE_MAX_BYTES`]). On failure both stay as separate parts.
async fn join_last_part(parts: &mut Vec<String>) {
    let [.., into, from] = parts.as_slice() else {
        return;
    };
    let (from, into) = (PathBuf::from(from), PathBuf::from(into));
    let src = from.clone();
    let joined = tokio::task::spawn_blocking(move || naming::append_part(&src, &into)).await;
    match joined {
        Ok(Ok(())) => {
            parts.pop();
            if let Err(e) = crate::downloads::naming::remove_regular_file(&from) {
                tracing::warn!(error = %e, "could not delete a recording part after joining it");
            }
        }
        Ok(Err(e)) => tracing::warn!(error = %e, "could not join a recording part; keeping it"),
        Err(e) => tracing::warn!(error = %e, "could not join a recording part; keeping it"),
    }
}

async fn save_progress(state: &Arc<AppState>, id: &str, parts: &[String]) {
    let key = id.to_string();
    let parts = parts.to_vec();
    let bytes = total_bytes(&parts);
    if let Err(e) = state
        .db_call(move |c| store::set_progress(c, &key, &parts, bytes))
        .await
    {
        tracing::warn!(error = %e, "could not save recording progress");
    }
}

/// Emits `recordings.progress` every 2 s while a part is written, and saves
/// the byte count every [`SAVE_BYTES_EVERY`] ticks.
fn spawn_progress(
    state: Arc<AppState>,
    id: String,
    parts: Vec<String>,
    started: i64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(PROGRESS_EVERY);
        let mut ticks: u32 = 0;
        loop {
            every.tick().await;
            let rt = runtime(&state);
            let bytes = total_bytes(&parts);
            state.emit(
                EVENT_RECORDINGS_PROGRESS,
                RecordingProgress {
                    id: id.clone(),
                    bytes,
                    elapsed_seconds: (rt.now() - started).max(0),
                },
            );
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(SAVE_BYTES_EVERY) {
                let key = id.clone();
                // Bytes only: the parts list is the engine's to write.
                if let Err(e) = state
                    .db_background(move |c| store::set_bytes(c, &key, bytes))
                    .await
                {
                    tracing::debug!(error = %e, "could not save recording bytes");
                }
            }
        }
    })
}

/// Re-matches pending reminders and scheduled programme recordings against
/// the guide after a refresh (or every few minutes): a programme that moved
/// keeps its reminder or recording.
async fn maybe_rematch(state: &Arc<AppState>, rt: &Runtime, now: i64) {
    let generation = crate::epg::runtime(state).generation();
    {
        let mut last = rt.rematched.lock();
        if last.1 == generation && now - last.0 < REMATCH_EVERY {
            return;
        }
        *last = (now, generation);
    }
    if let Err(e) = rematch(state, now).await {
        tracing::debug!(error = %e, "guide re-match skipped");
    }
    // Series rules (C5): same triggers, after the re-match so an airing
    // that moved is found at its new time instead of being added twice.
    if let Err(e) = rules::materialise(state, rt, now).await {
        tracing::debug!(error = %e, "series rules skipped");
    }
}

async fn rematch(state: &Arc<AppState>, now: i64) -> CoreResult<()> {
    let offset = i64::from(state.settings_snapshot().epg_offset_minutes) * 60;
    let (reminders, recordings, skips) = state
        .db_call(move |c| {
            Ok((
                store::reminders(c)?,
                store::recordings(c)?,
                rules::skip_claims(c, now)?,
            ))
        })
        .await?;
    let mut reminders_changed = false;
    for r in reminders
        .iter()
        .filter(|r| r.status == ReminderStatus::Pending && r.start_at > now)
    {
        if let Some((s, e)) =
            find_moved(state, &r.item_ref, r.start_at, r.end_at, &r.title, offset).await
        {
            let id = r.id.clone();
            state
                .db_call(move |c| store::set_reminder_times(c, &id, s, e))
                .await?;
            reminders_changed = true;
        }
    }
    let recordings_changed = rematch_recordings(state, now, offset, &recordings, skips).await?;
    if reminders_changed {
        changed(state, EVENT_REMINDERS_UPDATE);
    }
    if recordings_changed {
        changed(state, EVENT_RECORDINGS_UPDATE);
    }
    Ok(())
}

/// A stored airing the re-match follows on one channel.
enum Followed<'a> {
    /// A scheduled programme recording that has not started.
    Row(&'a RecordingRow),
    /// A series rule's cancelled airing ([`rules::SkipClaim`]).
    Skip(&'a rules::SkipClaim),
}

impl Followed<'_> {
    fn claim(&self) -> scheduler::Claim<'_> {
        match self {
            Followed::Row(r) => scheduler::Claim {
                start: r.start_at,
                end: r.end_at,
                title: r.title.as_deref().unwrap_or_default(),
            },
            Followed::Skip(s) => scheduler::Claim {
                start: s.start,
                end: s.end,
                title: &s.title,
            },
        }
    }
}

/// One change the re-match makes.
enum Rematched {
    Move(String, i64, i64),
    Drop(String),
    MoveSkip(rules::SkipClaim, i64, i64),
}

/// Re-matches, channel by channel, the scheduled programme recordings and
/// the series rules' cancelled airings against the guide
/// ([`scheduler::follow`]):
/// - an airing the guide moved is followed, but never onto a slot another
///   recording of the channel already holds (one airing, one recording);
/// - a cancelled rule airing moves too, so the rule does not schedule it
///   again at its new time (C5: a cancelled airing is not re-created);
/// - a rule-made recording whose airing is gone (the guide shows something
///   else there, and no free airing of the title nearby) is deleted: it
///   never started, and [`rules::materialise`] schedules what the rule
///   still needs. A manual one stays where the user put it.
///
/// Returns whether anything changed.
async fn rematch_recordings(
    state: &Arc<AppState>,
    now: i64,
    offset: i64,
    recordings: &[RecordingRow],
    skips: Vec<rules::SkipClaim>,
) -> CoreResult<bool> {
    let mut channels: HashMap<&ItemRef, (HashSet<i64>, Vec<Followed<'_>>)> = HashMap::new();
    for r in recordings.iter().filter(|r| {
        r.kind == RecordingKind::Programme
            && matches!(
                r.status,
                RecordingStatus::Scheduled | RecordingStatus::Recording
            )
    }) {
        let (fixed, followed) = channels.entry(&r.item_ref).or_default();
        let movable = r.status == RecordingStatus::Scheduled
            && r.effective_start() > now
            && r.title.as_deref().is_some_and(|t| !t.trim().is_empty());
        if movable {
            followed.push(Followed::Row(r));
        } else {
            fixed.insert(r.start_at);
        }
    }
    for s in &skips {
        channels
            .entry(&s.item_ref)
            .or_default()
            .1
            .push(Followed::Skip(s));
    }
    let mut changes = Vec::new();
    for (item_ref, (fixed, mut followed)) in channels {
        if followed.is_empty() {
            continue;
        }
        followed.sort_by_key(|f| f.claim().start);
        let claims: Vec<scheduler::Claim<'_>> = followed.iter().map(Followed::claim).collect();
        let Some(slots) = guide_slots(state, item_ref, &claims, offset).await else {
            continue;
        };
        let refs: Vec<scheduler::Slot<'_>> =
            slots.iter().map(|(s, e, t)| (*s, *e, t.as_str())).collect();
        let found = scheduler::follow(&claims, &refs, &fixed);
        for ((f, c), hit) in followed.iter().zip(&claims).zip(found) {
            match (f, hit) {
                (Followed::Row(r), scheduler::Follow::At(s, e)) if (s, e) != (c.start, c.end) => {
                    changes.push(Rematched::Move(r.id.clone(), s, e));
                }
                (Followed::Row(r), scheduler::Follow::Gone) if r.rule_id.is_some() => {
                    changes.push(Rematched::Drop(r.id.clone()));
                }
                (Followed::Skip(k), scheduler::Follow::At(s, e)) if s != c.start => {
                    changes.push(Rematched::MoveSkip((*k).clone(), s, e));
                }
                _ => {}
            }
        }
    }
    if changes.is_empty() {
        return Ok(false);
    }
    state
        .db_call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut changed = false;
            let mut moves = Vec::new();
            for change in changes {
                match change {
                    Rematched::Move(id, s, e) => moves.push((id, s, e)),
                    Rematched::Drop(id) => changed |= store::delete_scheduled(&tx, &id)?,
                    Rematched::MoveSkip(k, s, e) => {
                        rules::move_skip(&tx, &k, s, e)?;
                        changed = true;
                    }
                }
            }
            // A move onto a start another row leaves in this pass succeeds
            // once that row has moved; whatever is still refused stays put.
            loop {
                let before = moves.len();
                let mut left = Vec::new();
                for (id, s, e) in moves {
                    if store::move_scheduled(&tx, &id, s, e)? {
                        changed = true;
                    } else {
                        left.push((id, s, e));
                    }
                }
                moves = left;
                if moves.is_empty() || moves.len() == before {
                    break;
                }
            }
            tx.commit()?;
            Ok(changed)
        })
        .await
}

/// The guide's programmes of `r` around every claim, in display time, each
/// once. `None` when the guide could not be read.
async fn guide_slots(
    state: &Arc<AppState>,
    r: &ItemRef,
    claims: &[scheduler::Claim<'_>],
    offset: i64,
) -> Option<Vec<(i64, i64, String)>> {
    let mut seen: HashSet<(i64, i64, String)> = HashSet::new();
    let mut out = Vec::new();
    // Neighbouring claims share most of their window: one read per run of
    // overlapping windows (each well under the guide's 31-day limit).
    let mut windows: Vec<(i64, i64)> = Vec::new();
    for c in claims {
        let from = c.start - scheduler::REMATCH_WINDOW;
        let to = c.end.max(c.start + 1) + scheduler::REMATCH_WINDOW;
        match windows.last_mut() {
            Some(w) if from <= w.1 && to - w.0 <= 7 * 86_400 => w.1 = w.1.max(to),
            _ => windows.push((from, to)),
        }
    }
    for (from, to) in windows {
        let programs = crate::epg::programs(
            state,
            r.clone(),
            &rfc3339(from - offset),
            &rfc3339(to - offset),
        )
        .await
        .ok()?;
        for p in programs {
            let (Ok(s), Ok(e)) = (
                DateTime::parse_from_rfc3339(&p.start),
                DateTime::parse_from_rfc3339(&p.end),
            ) else {
                continue;
            };
            let slot = (s.timestamp() + offset, e.timestamp() + offset, p.title);
            if seen.insert(slot.clone()) {
                out.push(slot);
            }
        }
    }
    Some(out)
}

async fn find_moved(
    state: &Arc<AppState>,
    r: &ItemRef,
    start: i64,
    end: i64,
    title: &str,
    offset: i64,
) -> Option<(i64, i64)> {
    let from = rfc3339(start - offset - scheduler::REMATCH_WINDOW);
    let to = rfc3339(start - offset + scheduler::REMATCH_WINDOW + (end - start));
    let programs = crate::epg::programs(state, r.clone(), &from, &to)
        .await
        .ok()?;
    let slots: Vec<(i64, i64, String)> = programs
        .iter()
        .filter_map(|p| {
            let s = DateTime::parse_from_rfc3339(&p.start).ok()?.timestamp() + offset;
            let e = DateTime::parse_from_rfc3339(&p.end).ok()?.timestamp() + offset;
            Some((s, e, p.title.clone()))
        })
        .collect();
    if slots.is_empty() {
        return None;
    }
    let refs: Vec<scheduler::Slot<'_>> =
        slots.iter().map(|(s, e, t)| (*s, *e, t.as_str())).collect();
    scheduler::rematch(start, end, title, &refs)
}

/// Stops every running recording (keeping what was written) and saves
/// their final state. Called on app exit before the process ends; mpv
/// children are killed with the process anyway (kill-on-close job).
pub async fn shutdown(state: &Arc<AppState>) {
    let rt = runtime(state);
    // First: the loop and any later tick start nothing, so a recording that
    // finishes during the wait below cannot wake a resume of the others.
    rt.shutting_down.store(true, Ordering::SeqCst);
    let handles: Vec<tokio::task::JoinHandle<()>> = {
        let mut map = rt.active.lock();
        for a in map.values() {
            *a.reason.lock() = StopReason::Shutdown;
            let _ = a.stop.send(true);
        }
        map.drain().map(|(_, a)| a.handle).collect()
    };
    if handles.is_empty() {
        return;
    }
    let all = futures::future::join_all(handles);
    if tokio::time::timeout(Duration::from_secs(5), all)
        .await
        .is_err()
    {
        tracing::warn!("recordings did not stop within 5 s; closing their rows directly");
        if let Ok(rows) = state.db_call(|c| store::recordings(c)).await {
            for row in rows
                .iter()
                .filter(|r| r.status == RecordingStatus::Recording)
            {
                let _ = close_orphan(state, row, Some(STOPPED_SHUTDOWN_MESSAGE)).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Series recording rules: backup surface (Run 2 C5, C8)
// ---------------------------------------------------------------------------
//
// The rules themselves live in [`rules`].

/// One series recording rule in a backup file (per-entry
/// `userState.tsrustRecordingRules`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRuleBackup {
    pub content_type: ContentType,
    pub item_id: String,
    pub channel_name: String,
    pub title: String,
    pub enabled: bool,
    pub created_at: String,
}

/// Every rule of a source, for `backup.export` (oldest first).
pub fn export_rules(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> CoreResult<Vec<RecordingRuleBackup>> {
    rules::export(conn, source_id)
}

/// Adds the rules to a source; duplicates by `title_key` are ignored.
/// Returns rows written. The scheduler schedules their airings on its next
/// re-match pass (within `REMATCH_EVERY`).
pub fn import_rules(
    conn: &rusqlite::Connection,
    source_id: &str,
    rules: &[RecordingRuleBackup],
) -> CoreResult<usize> {
    rules::import(conn, source_id, rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_use_their_wire_names() {
        assert_eq!(
            serde_json::to_value(RecordingStatus::Cancelled).unwrap(),
            "cancelled"
        );
        assert_eq!(
            serde_json::to_value(ReminderStatus::Pending).unwrap(),
            "pending"
        );
        assert_eq!(
            serde_json::to_value(RecordingKind::Programme).unwrap(),
            "programme"
        );
    }

    /// R-recording-F5: a few seconds of "too many connections" video then a
    /// close counts as a failed attempt; a stop or a long part does not.
    #[test]
    fn short_parts_count_as_failures() {
        assert!(part_failed(0, 600, false));
        assert!(part_failed(188_000, 3, false));
        assert!(part_failed(188_000, MIN_PART_SECONDS - 1, false));
        assert!(!part_failed(188_000, MIN_PART_SECONDS, false));
        assert!(!part_failed(188_000, 2, true));
        const { assert!(MAX_PARTS > 1) };
    }

    /// R-recording-F11: every status message the module writes has a code.
    #[test]
    fn status_messages_have_codes() {
        for (msg, code) in [
            (MISSED_MESSAGE, "missedNotRunning"),
            (STOPPED_SHUTDOWN_MESSAGE, "stoppedShutdown"),
            (CLOSED_EARLY_MESSAGE, "closedEarly"),
            (CLOSED_NOTHING_MESSAGE, "closedNothing"),
            (NOTHING_RECORDED_MESSAGE, "nothingRecorded"),
            (STOPPED_MESSAGE, "stopped"),
            (SOURCE_REMOVED_MESSAGE, "sourceRemoved"),
            (STREAM_DROPPED_MESSAGE, "streamDropped"),
            (engine::ENGINE_MISSING_MESSAGE, "engineMissing"),
            (engine::SERVER_HTTP_ONLY_MESSAGE, "serverHttpOnly"),
            (STREAM_GAPS_MESSAGE, "streamGaps"),
            (STREAM_NOT_FOUND_MESSAGE, "streamNotFound"),
            (STREAM_REJECTED_MESSAGE, "streamRejected"),
            (STREAM_NO_ANSWER_MESSAGE, "streamNoAnswer"),
            (STREAM_SERVER_ERROR_MESSAGE, "streamServerError"),
            (NOT_A_STREAM_MESSAGE, "notAStream"),
            (DISK_FULL_MESSAGE, "diskFull"),
            (RULE_REMOVED_MESSAGE, "ruleRemoved"),
        ] {
            assert_eq!(error_code(msg), Some(code), "{msg}");
        }
        let reconnecting = format!("{RECONNECTING_PREFIX}the stream ended");
        assert_eq!(error_code(&reconnecting), Some("reconnecting"));
        let missing = CoreError::EngineMissing(engine::ENGINE_MISSING_MESSAGE.into()).to_string();
        assert_eq!(error_code(&missing), Some("engineMissing"));
        let server = CoreError::Unsupported(engine::SERVER_HTTP_ONLY_MESSAGE.into()).to_string();
        assert_eq!(error_code(&server), Some("serverHttpOnly"));
        assert_eq!(error_code("example.com answered 403"), None);
    }

    #[test]
    fn programme_times_are_capped_in_length_and_horizon() {
        let now = 1_800_000_000;
        assert!(check_programme_times(now, now + 3600, now).is_ok());
        assert!(check_programme_times(now, now + MAX_DURATION_MINUTES * 60, now).is_ok());
        assert!(check_programme_times(now, now, now).is_err());
        assert!(check_programme_times(now, now + MAX_DURATION_MINUTES * 60 + 1, now).is_err());
        let far = now + MAX_DAYS_AHEAD * 86_400;
        assert!(check_programme_times(far, far + 60, now).is_ok());
        assert!(check_programme_times(far + 1, far + 61, now).is_err());
    }

    #[test]
    fn reconnect_backoff_grows_and_stays_capped() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(1), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(5), Duration::from_secs(MAX_BACKOFF_SECS));
        assert_eq!(backoff(u32::MAX), Duration::from_secs(MAX_BACKOFF_SECS));
    }

    #[test]
    fn times_round_trip_as_rfc3339() {
        let t = 1_800_000_000;
        assert_eq!(parse_time("start", &rfc3339(t)).unwrap(), t);
        assert!(parse_time("start", "tomorrow").is_err());
    }

    /// DB-1R: the byte count saved every [`SAVE_BYTES_EVERY`] ticks passes
    /// `AppState::db_background`'s gate, so while another background write
    /// holds it (one parked on an import's write lock) the save waits there
    /// instead of on a connection. Paused time: the save is due 8 s in.
    #[tokio::test(start_paused = true)]
    async fn byte_saves_wait_at_the_background_gate() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            dir.path().to_path_buf(),
            Arc::new(crate::events::NoopSink),
            false,
        )
        .await
        .unwrap();
        state
            .db_call(|c| {
                c.execute(
                    "INSERT INTO recordings (id, source_id, content_type, item_id, channel_name,
                       kind, start_at, end_at, status, created_at)
                     VALUES ('r1', 's1', 'live', 'c1', 'Alpha', 'programme', 0, 1, 'recording', 0)",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let saved = |state: Arc<AppState>| async move {
            state
                .db_call(|c| {
                    let sql = "SELECT bytes FROM recordings WHERE id = 'r1'";
                    Ok(c.query_row(sql, [], |r| r.get::<_, i64>(0))?)
                })
                .await
                .unwrap()
        };
        let part = dir.path().join("r1.ts");
        std::fs::write(&part, vec![0u8; 4096]).unwrap();
        let held = state.background_gate().acquire_owned().await.unwrap();
        let ticker = spawn_progress(
            state.clone(),
            "r1".into(),
            vec![part.to_string_lossy().into_owned()],
            0,
        );
        // The first tick is at once, so the fifth (the save) comes at 8 s.
        tokio::time::sleep(PROGRESS_EVERY * SAVE_BYTES_EVERY).await;
        assert_eq!(saved(state.clone()).await, 0, "the save waits at the gate");
        drop(held);
        // The gate admits in order, so this passes once the save is done.
        state.db_background(|_| Ok(())).await.unwrap();
        assert_eq!(saved(state.clone()).await, 4096);
        ticker.abort();
    }
}
