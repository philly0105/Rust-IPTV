//! Series recording rules (Run 2 C5): "record every airing of this title on
//! this channel".
//!
//! A rule is a channel plus a title key ([`super::scheduler::title_key`]). The
//! scheduler turns it into ordinary scheduled recordings with `rule_id` set
//! ([`materialise`]): on the re-match triggers (every `REMATCH_EVERY`, after
//! each guide refresh) and right after `recordings.addRule` or
//! `recordings.setRuleEnabled(true)`. It looks [`HORIZON_SECS`] ahead and
//! keeps at most [`MAX_UPCOMING`] scheduled recordings per rule.
//!
//! An airing is never created twice: a start already present in
//! `recordings` for the channel (any status, so a cancelled, failed or
//! finished one counts) or listed in `recording_rule_skips` is left alone.
//! Cancelling a rule-made recording writes a skip row, so removing the
//! cancelled row from the list does not bring the airing back. The one
//! exception is a recording cancelled because its rule was removed
//! ([`super::RULE_REMOVED_MESSAGE`]): the user cancelled the rule, not the
//! airing, so a rule added again for the title schedules it again.

use super::scheduler::title_key;
use super::store::{self, RecordingRow};
use super::{
    capabilities, changed, check_engine, check_live, insert_scheduled, rfc3339, runtime,
    RecordingKind, RecordingRuleBackup, RecordingStatus, Runtime, EVENT_RECORDINGS_UPDATE,
    MAX_DURATION_MINUTES, RULE_REMOVED_MESSAGE, SERVER_NO_MPV,
};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ItemRef};
use crate::state::AppState;
use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Most rules kept at once.
pub const MAX_RULES: usize = 100;
/// Longest rule title, in characters.
pub const MAX_TITLE_CHARS: usize = 200;
/// How far ahead airings are scheduled.
pub const HORIZON_SECS: i64 = 7 * 86_400;
/// Most scheduled recordings one rule keeps at a time.
pub const MAX_UPCOMING: usize = 20;

/// `recordings.rules` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRule {
    pub id: String,
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    pub channel_name: String,
    pub title: String,
    pub enabled: bool,
    /// RFC 3339.
    pub created_at: String,
    /// Scheduled recordings this rule made that have not started yet.
    pub upcoming: i64,
    /// Start of the first of them (RFC 3339, display time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_start: Option<String>,
}

/// `recordings.addRule` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRuleRequest {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub channel_name: String,
    #[serde(default)]
    pub title: String,
}

/// `recordings.setRuleEnabled` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRuleEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

/// `recordings.removeRule` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRuleRequest {
    pub id: String,
    #[serde(default)]
    pub keep_scheduled: Option<bool>,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// One `recording_rules` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleRow {
    pub id: String,
    pub item_ref: ItemRef,
    pub channel_name: String,
    pub title: String,
    pub title_key: String,
    pub enabled: bool,
    pub created_at: String,
}

const RULE_COLS: &str =
    "id, source_id, content_type, item_id, channel_name, title, title_key, enabled, created_at";

fn rule_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RuleRow> {
    let ct: String = r.get(2)?;
    let content_type = ct.parse::<ContentType>().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(RuleRow {
        id: r.get(0)?,
        item_ref: ItemRef::new(r.get::<_, String>(1)?, content_type, r.get::<_, String>(3)?),
        channel_name: r.get(4)?,
        title: r.get(5)?,
        title_key: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        created_at: r.get(8)?,
    })
}

/// Every rule, oldest first.
pub fn rule_rows(c: &Connection) -> CoreResult<Vec<RuleRow>> {
    let mut s = c.prepare(&format!(
        "SELECT {RULE_COLS} FROM recording_rules ORDER BY created_at, rowid"
    ))?;
    let rows = s.query_map([], rule_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn rule_by_id(c: &Connection, id: &str) -> CoreResult<Option<RuleRow>> {
    Ok(c.query_row(
        &format!("SELECT {RULE_COLS} FROM recording_rules WHERE id = ?1"),
        [id],
        rule_row,
    )
    .optional()?)
}

/// Inserts a rule; false when the channel already has one for the title key.
fn insert_rule(c: &Connection, r: &RuleRow) -> CoreResult<bool> {
    let n = c.execute(
        "INSERT OR IGNORE INTO recording_rules
           (id, source_id, content_type, item_id, channel_name, title, title_key, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            r.id,
            r.item_ref.source_id,
            r.item_ref.content_type.as_str(),
            r.item_ref.item_id,
            r.channel_name,
            r.title,
            r.title_key,
            i64::from(r.enabled),
            r.created_at
        ],
    )?;
    Ok(n > 0)
}

fn count_rules(c: &Connection) -> CoreResult<usize> {
    let n: i64 = c.query_row("SELECT count(*) FROM recording_rules", [], |r| r.get(0))?;
    Ok(n as usize)
}

/// Records that `rule_id` must not schedule the airing at `start_at`
/// (display time). A rule removed meanwhile is ignored.
pub fn add_skip(c: &Connection, rule_id: &str, start_at: i64) -> CoreResult<()> {
    c.execute(
        "INSERT OR IGNORE INTO recording_rule_skips (rule_id, start_at)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM recording_rules WHERE id = ?1)",
        params![rule_id, start_at],
    )?;
    Ok(())
}

fn skips(c: &Connection, rule_id: &str) -> CoreResult<HashSet<i64>> {
    let mut s = c.prepare_cached("SELECT start_at FROM recording_rule_skips WHERE rule_id = ?1")?;
    let rows = s.query_map([rule_id], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A cancelled airing of a rule (a skip) that the guide re-match follows
/// like a scheduled recording, so a cancelled airing the guide moves stays
/// cancelled at its new time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkipClaim {
    pub rule_id: String,
    pub item_ref: ItemRef,
    pub title: String,
    /// Display time.
    pub start: i64,
    /// The cancelled recording's end, or `start` when it was removed.
    pub end: i64,
}

/// Skips starting after `after`, with their rule's channel and title. Skips
/// of slots over long ago are pruned first: [`materialise`] only looks
/// ahead, so they can no longer hold anything back.
pub(super) fn skip_claims(c: &Connection, after: i64) -> CoreResult<Vec<SkipClaim>> {
    c.execute(
        "DELETE FROM recording_rule_skips WHERE start_at < ?1",
        [after - super::scheduler::REMATCH_WINDOW - 86_400],
    )?;
    let mut s = c.prepare(
        "SELECT s.rule_id, r.source_id, r.content_type, r.item_id, r.title, s.start_at,
                (SELECT max(x.end_at) FROM recordings x
                  WHERE x.rule_id = s.rule_id AND x.start_at = s.start_at AND x.status = 'cancelled')
         FROM recording_rule_skips s JOIN recording_rules r ON r.id = s.rule_id
         WHERE s.start_at > ?1
         ORDER BY s.start_at",
    )?;
    let rows = s.query_map([after], |r| {
        let ct: String = r.get(2)?;
        let content_type = ct.parse::<ContentType>().map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
        })?;
        let start: i64 = r.get(5)?;
        Ok(SkipClaim {
            rule_id: r.get(0)?,
            item_ref: ItemRef::new(r.get::<_, String>(1)?, content_type, r.get::<_, String>(3)?),
            title: r.get(4)?,
            start,
            end: r.get::<_, Option<i64>>(6)?.unwrap_or(start),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Moves a skip, and the cancelled recording it stands for, to the time the
/// guide moved the airing to.
pub(super) fn move_skip(c: &Connection, skip: &SkipClaim, start: i64, end: i64) -> CoreResult<()> {
    c.execute(
        "UPDATE OR REPLACE recording_rule_skips SET start_at = ?3 WHERE rule_id = ?1 AND start_at = ?2",
        params![skip.rule_id, skip.start, start],
    )?;
    c.execute(
        "UPDATE recordings SET start_at = ?3, end_at = ?4
         WHERE rule_id = ?1 AND start_at = ?2 AND status = 'cancelled'",
        params![skip.rule_id, skip.start, start, end],
    )?;
    Ok(())
}

/// Starts of every recording of `r`, whatever its status, except the ones
/// cancelled only because their rule was removed.
fn recorded_starts(c: &Connection, r: &ItemRef) -> CoreResult<HashSet<i64>> {
    let mut s = c.prepare_cached(
        "SELECT start_at FROM recordings WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3
         AND NOT (status = 'cancelled' AND error_message IS ?4)",
    )?;
    let rows = s.query_map(
        params![
            r.source_id,
            r.content_type.as_str(),
            r.item_id,
            RULE_REMOVED_MESSAGE
        ],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Scheduled recordings of `rule_id`.
fn scheduled_count(c: &Connection, rule_id: &str) -> CoreResult<usize> {
    let n: i64 = c.query_row(
        "SELECT count(*) FROM recordings WHERE rule_id = ?1 AND status = 'scheduled'",
        [rule_id],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Rule rows with their upcoming count and next start.
fn with_upcoming(c: &Connection, rows: Vec<RuleRow>) -> CoreResult<Vec<RecordingRule>> {
    let mut upcoming: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut s = c.prepare(
            "SELECT rule_id, count(*), min(start_at) FROM recordings
             WHERE rule_id IS NOT NULL AND status = 'scheduled' GROUP BY rule_id",
        )?;
        let it = s.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in it {
            let (id, n, first) = row?;
            upcoming.insert(id, (n, first));
        }
    }
    Ok(rows
        .into_iter()
        .map(|r| {
            let (n, first) = upcoming
                .get(&r.id)
                .map(|(n, f)| (*n, Some(*f)))
                .unwrap_or((0, None));
            RecordingRule {
                id: r.id,
                item_ref: r.item_ref,
                channel_name: r.channel_name,
                title: r.title,
                enabled: r.enabled,
                created_at: r.created_at,
                upcoming: n,
                next_start: first.map(rfc3339),
            }
        })
        .collect())
}

fn one(c: &Connection, id: &str) -> CoreResult<RecordingRule> {
    let row = rule_by_id(c, id)?
        .ok_or_else(|| CoreError::NotFound(format!("recording rule {id} not found")))?;
    Ok(with_upcoming(c, vec![row])?.remove(0))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `recordings.rules`: every rule, oldest first.
pub async fn list(state: &Arc<AppState>) -> CoreResult<Vec<RecordingRule>> {
    state
        .db_call(|c| {
            let rows = rule_rows(c)?;
            with_upcoming(c, rows)
        })
        .await
}

/// Trims a rule title and checks its length and key.
fn clean_title(title: &str) -> CoreResult<(String, String)> {
    let title = title.trim();
    let chars = title.chars().count();
    if !(1..=MAX_TITLE_CHARS).contains(&chars) {
        return Err(CoreError::invalid(format!(
            "title must be 1 to {MAX_TITLE_CHARS} characters"
        )));
    }
    let key = title_key(title);
    if key.is_empty() {
        return Err(CoreError::invalid("title must contain a letter or a digit"));
    }
    Ok((title.to_string(), key))
}

/// `recordings.addRule`: same capability and live-only checks as
/// `recordings.schedule`; a second rule for the same channel and title is
/// a conflict; at most [`MAX_RULES`]. Schedules the matching airings right
/// away.
pub async fn add(state: &Arc<AppState>, req: AddRuleRequest) -> CoreResult<RecordingRule> {
    let caps = capabilities(state);
    if !caps.supported {
        return Err(CoreError::Unsupported(
            caps.reason.unwrap_or_else(|| SERVER_NO_MPV.into()),
        ));
    }
    check_live(&req.item_ref)?;
    let (title, key) = clean_title(&req.title)?;
    check_engine(state, &req.item_ref).await?;
    let rt = runtime(state);
    let channel_name = Some(req.channel_name.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| req.item_ref.item_id.clone());
    let row = RuleRow {
        id: uuid::Uuid::new_v4().to_string(),
        item_ref: req.item_ref,
        channel_name,
        title,
        title_key: key,
        enabled: true,
        created_at: rfc3339(rt.now()),
    };
    let id = row.id.clone();
    let rule = state
        .db_call(move |c| {
            // The count and the insert in one write transaction: two adds
            // at once cannot both pass the cap check.
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists = tx
                .query_row(
                    "SELECT 1 FROM sources WHERE id = ?1",
                    [&row.item_ref.source_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Err(CoreError::NotFound(format!(
                    "source {} not found",
                    row.item_ref.source_id
                )));
            }
            if count_rules(&tx)? >= MAX_RULES {
                return Err(CoreError::invalid(format!(
                    "You can keep up to {MAX_RULES} series rules. Remove one first."
                )));
            }
            if !insert_rule(&tx, &row)? {
                return Err(CoreError::Conflict(
                    "This series is already recorded on this channel.".into(),
                ));
            }
            let rule = one(&tx, &row.id)?;
            tx.commit()?;
            Ok(rule)
        })
        .await?;
    changed(state, EVENT_RECORDINGS_UPDATE);
    let rule = materialise_now(state, &rt, &id).await.unwrap_or(rule);
    Ok(rule)
}

/// `recordings.setRuleEnabled`. Enabling schedules the matching airings
/// right away; disabling keeps the recordings already scheduled.
pub async fn set_enabled(
    state: &Arc<AppState>,
    id: &str,
    enabled: bool,
) -> CoreResult<RecordingRule> {
    let rt = runtime(state);
    let key = id.to_string();
    let rule = state
        .db_call(move |c| {
            let n = c.execute(
                "UPDATE recording_rules SET enabled = ?2 WHERE id = ?1",
                params![key, i64::from(enabled)],
            )?;
            if n == 0 {
                return Err(CoreError::NotFound(format!(
                    "recording rule {key} not found"
                )));
            }
            one(c, &key)
        })
        .await?;
    changed(state, EVENT_RECORDINGS_UPDATE);
    if enabled {
        return Ok(materialise_now(state, &rt, id).await.unwrap_or(rule));
    }
    Ok(rule)
}

/// `recordings.removeRule`: deletes the rule (and its skips) and cancels
/// its scheduled recordings unless `keep_scheduled`; running ones go on.
/// Recordings that stay (kept, or running) lose their `rule_id`: they are
/// one-off recordings from then on, so a rule added later for the same
/// title neither counts them nor cancels them when it is removed.
pub async fn remove(state: &Arc<AppState>, id: &str, keep_scheduled: bool) -> CoreResult<()> {
    let rt = runtime(state);
    let now = rt.now();
    let key = id.to_string();
    state
        .db_call(move |c| {
            // One write transaction, and [`materialise`] re-reads the rule
            // inside its own: no recording is added for a rule half removed.
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if tx.execute("DELETE FROM recording_rules WHERE id = ?1", [&key])? == 0 {
                return Err(CoreError::NotFound(format!(
                    "recording rule {key} not found"
                )));
            }
            if !keep_scheduled {
                let ids: Vec<String> = {
                    let mut s = tx.prepare(
                        "SELECT id FROM recordings WHERE rule_id = ?1 AND status = 'scheduled'",
                    )?;
                    let rows = s.query_map([&key], |r| r.get(0))?;
                    rows.collect::<Result<_, _>>()?
                };
                for rec in ids {
                    store::transition(
                        &tx,
                        &rec,
                        &[RecordingStatus::Scheduled],
                        RecordingStatus::Cancelled,
                        Some(now),
                        Some(RULE_REMOVED_MESSAGE),
                    )?;
                }
            }
            tx.execute(
                "UPDATE recordings SET rule_id = NULL
                 WHERE rule_id = ?1 AND status IN ('scheduled', 'recording')",
                [&key],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    changed(state, EVENT_RECORDINGS_UPDATE);
    rt.wake.notify_one();
    Ok(())
}

/// Runs [`materialise`] now (under the scheduler's tick lock, so a tick in
/// progress cannot add the same airing) and returns the rule refreshed.
async fn materialise_now(state: &Arc<AppState>, rt: &Runtime, id: &str) -> Option<RecordingRule> {
    {
        let _guard = rt.tick_lock.lock().await;
        if let Err(e) = materialise(state, rt, rt.now()).await {
            tracing::debug!(error = %e, "series rules skipped");
        }
    }
    let key = id.to_string();
    state.db_call(move |c| one(c, &key)).await.ok()
}

// ---------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------

/// An airing of a rule's title: display-time start and end, guide title.
type Airing = (i64, i64, String);

/// The rule's airings starting after `now` within [`HORIZON_SECS`], in
/// display time (guide time plus the EPG offset, as `find_moved` reads it).
async fn airings(state: &Arc<AppState>, rule: &RuleRow, now: i64, offset: i64) -> Vec<Airing> {
    let from = rfc3339(now - offset);
    let to = rfc3339(now - offset + HORIZON_SECS);
    let programs = match crate::epg::programs(state, rule.item_ref.clone(), &from, &to).await {
        Ok(p) => p,
        Err(e) => {
            tracing::debug!(error = %e, rule = %rule.id, "series rule: guide unavailable");
            return Vec::new();
        }
    };
    programs
        .into_iter()
        .filter(|p| title_key(&p.title) == rule.title_key)
        .filter_map(|p| {
            let s = DateTime::parse_from_rfc3339(&p.start).ok()?.timestamp() + offset;
            let e = DateTime::parse_from_rfc3339(&p.end).ok()?.timestamp() + offset;
            (s > now && e > s).then_some((s, e, p.title))
        })
        .collect()
}

/// Schedules the upcoming airings of every enabled rule (see the module
/// docs). Call with the scheduler's tick lock held. Returns how many
/// recordings were added.
pub(super) async fn materialise(
    state: &Arc<AppState>,
    rt: &Runtime,
    now: i64,
) -> CoreResult<usize> {
    if !capabilities(state).supported {
        return Ok(0);
    }
    let rules: Vec<RuleRow> = state
        .db_call(|c| Ok(rule_rows(c)?.into_iter().filter(|r| r.enabled).collect()))
        .await?;
    if rules.is_empty() {
        return Ok(0);
    }
    let settings = state.settings_snapshot();
    let offset = i64::from(settings.epg_offset_minutes) * 60;
    let pad_before = i64::from(settings.recording_padding_before_minutes);
    let pad_after = i64::from(settings.recording_padding_after_minutes);
    let mut added = 0usize;
    for rule in rules {
        let found = airings(state, &rule, now, offset).await;
        if found.is_empty() {
            continue;
        }
        let rule = rule.clone();
        added += state
            .db_call(move |c| {
                // Checks and inserts in one write transaction: a manual
                // `recordings.schedule` of the same airing, a removal or a
                // switch-off of the rule land wholly before or after it.
                let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let live = tx
                    .query_row(
                        "SELECT enabled FROM recording_rules WHERE id = ?1",
                        [&rule.id],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?;
                if live != Some(1) {
                    return Ok(0);
                }
                let taken = recorded_starts(&tx, &rule.item_ref)?;
                let skipped = skips(&tx, &rule.id)?;
                let mut room = MAX_UPCOMING.saturating_sub(scheduled_count(&tx, &rule.id)?);
                let mut added = 0usize;
                for (start, end, title) in found {
                    if room == 0 {
                        break;
                    }
                    if taken.contains(&start) || skipped.contains(&start) {
                        continue;
                    }
                    // A guide entry longer than a manual recording may be
                    // is a placeholder ("off air" for a day), not a show.
                    if end - start > MAX_DURATION_MINUTES * 60 {
                        continue;
                    }
                    // The airing cancelled with an earlier rule makes way
                    // for the new one rather than listing it twice.
                    tx.execute(
                        "DELETE FROM recordings WHERE source_id = ?1 AND content_type = ?2
                         AND item_id = ?3 AND start_at = ?4 AND status = 'cancelled'
                         AND error_message IS ?5",
                        params![
                            rule.item_ref.source_id,
                            rule.item_ref.content_type.as_str(),
                            rule.item_ref.item_id,
                            start,
                            RULE_REMOVED_MESSAGE
                        ],
                    )?;
                    let row = RecordingRow {
                        id: uuid::Uuid::new_v4().to_string(),
                        item_ref: rule.item_ref.clone(),
                        channel_name: rule.channel_name.clone(),
                        title: Some(title.trim().to_string()).filter(|t| !t.is_empty()),
                        kind: RecordingKind::Programme,
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
                        rule_id: Some(rule.id.clone()),
                    };
                    match insert_scheduled(&tx, &row) {
                        Ok(_) => {
                            added += 1;
                            room -= 1;
                        }
                        // Already scheduled: nothing to add.
                        Err(CoreError::Conflict(_)) => {}
                        Err(e) => return Err(e),
                    }
                }
                tx.commit()?;
                Ok(added)
            })
            .await?;
    }
    if added > 0 {
        tracing::info!(added, "series rules scheduled recordings");
        changed(state, EVENT_RECORDINGS_UPDATE);
        rt.wake.notify_one();
    }
    Ok(added)
}

// ---------------------------------------------------------------------------
// Backup (C8)
// ---------------------------------------------------------------------------

/// Every rule of a source, oldest first.
pub fn export(c: &Connection, source_id: &str) -> CoreResult<Vec<RecordingRuleBackup>> {
    let mut s = c.prepare(&format!(
        "SELECT {RULE_COLS} FROM recording_rules WHERE source_id = ?1 ORDER BY created_at, rowid"
    ))?;
    let rows = s.query_map([source_id], rule_row)?;
    let mut out = Vec::new();
    for row in rows {
        let r = row?;
        out.push(RecordingRuleBackup {
            content_type: r.item_ref.content_type,
            item_id: r.item_ref.item_id,
            channel_name: r.channel_name,
            title: r.title,
            enabled: r.enabled,
            created_at: r.created_at,
        });
    }
    Ok(out)
}

/// Adds backup rules to a source. Skipped: a rule for a non-live type, an
/// empty or over-long title, a duplicate (same channel and title key), and
/// anything past [`MAX_RULES`]. Returns rows written.
pub fn import(c: &Connection, source_id: &str, rules: &[RecordingRuleBackup]) -> CoreResult<usize> {
    Ok(import_counted(c, source_id, rules)?.written)
}

/// What [`import_counted`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuleImport {
    /// Rules written.
    pub written: usize,
    /// Valid, new rules left out because [`MAX_RULES`] was reached.
    pub over_cap: usize,
}

/// [`import`], also counting the rules the cap left out, so a restore can
/// say so instead of dropping them silently.
pub fn import_counted(
    c: &Connection,
    source_id: &str,
    rules: &[RecordingRuleBackup],
) -> CoreResult<RuleImport> {
    let mut total = count_rules(c)?;
    let mut out = RuleImport::default();
    let mut left_out: HashSet<(ItemRef, String)> = HashSet::new();
    for r in rules {
        if !matches!(r.content_type, ContentType::Live | ContentType::Radio) {
            continue;
        }
        let Ok((title, key)) = clean_title(&r.title) else {
            continue;
        };
        let item_id = r.item_id.trim();
        if item_id.is_empty() {
            continue;
        }
        let created_at = if DateTime::parse_from_rfc3339(r.created_at.trim()).is_ok() {
            r.created_at.trim().to_string()
        } else {
            crate::db::now_rfc3339()
        };
        let row = RuleRow {
            id: uuid::Uuid::new_v4().to_string(),
            item_ref: ItemRef::new(source_id, r.content_type, item_id),
            channel_name: Some(r.channel_name.trim().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| item_id.to_string()),
            title,
            title_key: key,
            enabled: r.enabled,
            created_at,
        };
        if total >= MAX_RULES {
            let first = left_out.insert((row.item_ref.clone(), row.title_key.clone()));
            if first && !rule_exists(c, &row.item_ref, &row.title_key)? {
                out.over_cap += 1;
            }
            continue;
        }
        if insert_rule(c, &row)? {
            out.written += 1;
            total += 1;
        }
    }
    Ok(out)
}

/// Whether the channel already has a rule for the title key.
fn rule_exists(c: &Connection, r: &ItemRef, title_key: &str) -> CoreResult<bool> {
    Ok(c.prepare_cached(
        "SELECT 1 FROM recording_rules
         WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND title_key = ?4",
    )?
    .exists(params![
        r.source_id,
        r.content_type.as_str(),
        r.item_id,
        title_key
    ])?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_trimmed_and_keyed() {
        assert_eq!(
            clean_title("  The News at 6! ").unwrap(),
            ("The News at 6!".to_string(), "thenewsat6".to_string())
        );
        assert!(clean_title("   ").is_err());
        assert!(clean_title("!!!").is_err());
        assert!(clean_title(&"x".repeat(MAX_TITLE_CHARS + 1)).is_err());
        assert!(clean_title(&"x".repeat(MAX_TITLE_CHARS)).is_ok());
    }

    #[test]
    fn rule_serializes_in_camel_case() {
        let rule = RecordingRule {
            id: "r".into(),
            item_ref: ItemRef::new("s", ContentType::Live, "1"),
            channel_name: "One".into(),
            title: "News".into(),
            enabled: true,
            created_at: "2026-10-14T10:00:00Z".into(),
            upcoming: 2,
            next_start: None,
        };
        let v = serde_json::to_value(&rule).unwrap();
        assert_eq!(v["ref"]["sourceId"], "s");
        assert_eq!(v["channelName"], "One");
        assert_eq!(v["createdAt"], "2026-10-14T10:00:00Z");
        assert_eq!(v["upcoming"], 2);
        assert!(v.get("nextStart").is_none());
    }

    #[test]
    fn guide_titles_match_the_rule_key() {
        let (_, key) = clean_title("Match of the Day").unwrap();
        for guide in ["MATCH OF THE DAY", "Match of the Day!", "match-of-the-day"] {
            assert_eq!(title_key(guide), key, "{guide}");
        }
        assert_ne!(title_key("Match of the Day 2"), key);
    }
}
