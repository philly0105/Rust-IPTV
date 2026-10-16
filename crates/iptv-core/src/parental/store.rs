//! SQLite side of parental controls: the `parental_config` row and the
//! `parental_locks` table (migration 0011). Synchronous, `&Connection`
//! based; [`super`] runs these through `AppState::db_call`.

use super::pin;
use super::{ParentalLock, ParentalLockKind, ParentalLockTarget, ParentalMode};
use crate::error::{CoreError, CoreResult};
use crate::model::{ContentType, ItemRef, DEFAULT_PARENTAL_UNLOCK_MINUTES};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};

/// Consecutive wrong PINs that start the lockout.
pub const LOCKOUT_AFTER: u32 = 5;
/// First lockout length; it doubles with every further wrong PIN.
pub const LOCKOUT_BASE_SECS: u64 = 30;
/// Longest lockout.
pub const LOCKOUT_MAX_SECS: u64 = 300;
/// Longest lock display name kept.
pub const MAX_NAME_CHARS: usize = 200;
/// Longest source, category or item id a lock accepts.
pub const MAX_ID_LEN: usize = 512;

/// The `parental_config` row without the PIN material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// A PIN is set.
    pub enabled: bool,
    pub mode: ParentalMode,
    pub auto_adult: bool,
    pub unlock_minutes: u32,
    pub failed_attempts: u32,
    pub lockout_until: Option<DateTime<Utc>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: ParentalMode::Hide,
            auto_adult: true,
            unlock_minutes: DEFAULT_PARENTAL_UNLOCK_MINUTES,
            failed_attempts: 0,
            lockout_until: None,
        }
    }
}

impl Config {
    /// Seconds left of the wrong-PIN lockout at `now`, rounded up.
    pub fn retry_after(&self, now: DateTime<Utc>) -> Option<u64> {
        let until = self.lockout_until?;
        let ms = (until - now).num_milliseconds();
        (ms > 0).then(|| (ms as u64).div_ceil(1000))
    }
}

fn parse_time(s: Option<String>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s?.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn fmt_time(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Makes sure the single config row exists (writers only).
fn ensure_row(conn: &Connection) -> CoreResult<()> {
    conn.execute("INSERT OR IGNORE INTO parental_config(id) VALUES (1)", [])?;
    Ok(())
}

/// Reads the config. A missing row reads as the defaults.
pub fn load_config(conn: &Connection) -> CoreResult<Config> {
    let row = conn
        .prepare_cached(
            "SELECT pin_hash IS NOT NULL AND pin_salt IS NOT NULL, mode, auto_adult, unlock_minutes,
                    failed_attempts, lockout_until
             FROM parental_config WHERE id = 1",
        )?
        .query_row([], |r| {
            Ok((
                r.get::<_, bool>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .optional()?;
    let Some((enabled, mode, auto_adult, minutes, failed, lockout)) = row else {
        return Ok(Config::default());
    };
    Ok(Config {
        enabled,
        mode: mode.parse().unwrap_or_default(),
        auto_adult,
        unlock_minutes: minutes.clamp(0, i64::from(super::MAX_UNLOCK_MINUTES)) as u32,
        failed_attempts: failed.clamp(0, i64::from(u32::MAX)) as u32,
        lockout_until: parse_time(lockout),
    })
}

/// Outcome of a PIN check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// No PIN is set.
    NoPin,
    Correct,
    /// Wrong, below the lockout threshold; `failed` consecutive wrong PINs.
    Wrong {
        failed: u32,
    },
    /// Locked out (now, or by this wrong PIN) for `retry_after` seconds.
    LockedOut {
        retry_after: u64,
    },
}

/// Lockout length after `failed` consecutive wrong PINs (0 below the
/// threshold): 30 s at the fifth, doubling with each further one, at most
/// 300 s.
pub fn lockout_secs(failed: u32) -> u64 {
    if failed < LOCKOUT_AFTER {
        return 0;
    }
    let doublings = (failed - LOCKOUT_AFTER).min(16);
    (LOCKOUT_BASE_SECS << doublings).min(LOCKOUT_MAX_SECS)
}

/// Checks `pin` against the stored hash and records the outcome: a correct
/// PIN clears the wrong-PIN count, a wrong one raises it and starts or
/// extends the lockout. While a lockout runs the PIN is not checked at all.
pub fn check_pin(conn: &Connection, pin: &str, now: DateTime<Utc>) -> CoreResult<Verdict> {
    let cfg = load_config(conn)?;
    if let Some(retry_after) = cfg.retry_after(now) {
        return Ok(Verdict::LockedOut { retry_after });
    }
    let stored: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT pin_hash, pin_salt FROM parental_config WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((Some(hash), Some(salt))) = stored else {
        return Ok(Verdict::NoPin);
    };
    // A malformed PIN can never match; it is still a wrong attempt.
    if pin::is_valid(pin) && pin::verify(pin, &hash, &salt) {
        if cfg.failed_attempts != 0 || cfg.lockout_until.is_some() {
            conn.execute(
                "UPDATE parental_config SET failed_attempts = 0, lockout_until = NULL WHERE id = 1",
                [],
            )?;
        }
        return Ok(Verdict::Correct);
    }
    let failed = cfg.failed_attempts.saturating_add(1);
    let secs = lockout_secs(failed);
    let until = (secs > 0).then(|| now + chrono::Duration::seconds(secs as i64));
    conn.execute(
        "UPDATE parental_config SET failed_attempts = ?1, lockout_until = ?2 WHERE id = 1",
        params![failed, until.map(fmt_time)],
    )?;
    Ok(if secs > 0 {
        Verdict::LockedOut { retry_after: secs }
    } else {
        Verdict::Wrong { failed }
    })
}

/// Stores a new PIN hash and clears the wrong-PIN count.
pub fn set_pin(conn: &Connection, stored: &pin::Stored) -> CoreResult<()> {
    ensure_row(conn)?;
    conn.execute(
        "UPDATE parental_config SET pin_hash = ?1, pin_salt = ?2, failed_attempts = 0,
             lockout_until = NULL, updated_at = ?3 WHERE id = 1",
        params![stored.hash, stored.salt, crate::db::now_rfc3339()],
    )?;
    Ok(())
}

/// Removes the PIN (controls off). Options and locks stay.
pub fn clear_pin(conn: &Connection) -> CoreResult<()> {
    ensure_row(conn)?;
    conn.execute(
        "UPDATE parental_config SET pin_hash = NULL, pin_salt = NULL, failed_attempts = 0,
             lockout_until = NULL, updated_at = ?1 WHERE id = 1",
        [crate::db::now_rfc3339()],
    )?;
    Ok(())
}

/// Writes the options that are `Some`.
pub fn set_options(
    conn: &Connection,
    mode: Option<ParentalMode>,
    auto_adult: Option<bool>,
    unlock_minutes: Option<u32>,
) -> CoreResult<()> {
    ensure_row(conn)?;
    conn.execute(
        "UPDATE parental_config SET mode = COALESCE(?1, mode), auto_adult = COALESCE(?2, auto_adult),
             unlock_minutes = COALESCE(?3, unlock_minutes), updated_at = ?4 WHERE id = 1",
        params![
            mode.map(|m| m.as_str()),
            auto_adult,
            unlock_minutes,
            crate::db::now_rfc3339()
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

fn read_lock(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<ParentalLock>> {
    let ct: String = r.get(1)?;
    let kind: String = r.get(2)?;
    let (Ok(content_type), Ok(kind)) =
        (ct.parse::<ContentType>(), kind.parse::<ParentalLockKind>())
    else {
        return Ok(None);
    };
    Ok(Some(ParentalLock {
        source_id: r.get(0)?,
        content_type,
        kind,
        target_id: r.get(3)?,
        name: r.get(4)?,
        created_at: crate::db::to_rfc3339(&r.get::<_, String>(5)?),
    }))
}

/// Every lock, or those of one source, ordered by source, type, kind, name.
pub fn locks(conn: &Connection, source_id: Option<&str>) -> CoreResult<Vec<ParentalLock>> {
    let mut stmt = conn.prepare_cached(
        "SELECT source_id, content_type, kind, target_id, name, created_at FROM parental_locks
         WHERE (?1 IS NULL OR source_id = ?1)
         ORDER BY source_id, content_type, kind, name COLLATE NOCASE, target_id",
    )?;
    let rows = stmt.query_map([source_id], read_lock)?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(lock) = row? {
            out.push(lock);
        }
    }
    Ok(out)
}

/// Length-checked copy of a lock target (source id and name trimmed; the
/// target id kept exactly as given).
pub fn validate_target(t: &ParentalLockTarget) -> CoreResult<ParentalLockTarget> {
    let source_id = t.source_id.trim();
    if source_id.is_empty() || t.target_id.trim().is_empty() {
        return Err(CoreError::invalid(
            "target.sourceId and target.targetId are required",
        ));
    }
    // The limit applies to what is stored: padding cannot carry an id past it.
    if source_id.len() > MAX_ID_LEN || t.target_id.len() > MAX_ID_LEN {
        return Err(CoreError::invalid("target ids are too long"));
    }
    let name: String = t.name.trim().chars().take(MAX_NAME_CHARS).collect();
    Ok(ParentalLockTarget {
        source_id: source_id.to_string(),
        content_type: t.content_type,
        kind: t.kind,
        // Ids are matched exactly as the catalog stores them.
        target_id: t.target_id.clone(),
        name,
    })
}

/// Adds a lock (an existing one gets the new name). Returns true when the
/// table changed. NotFound when the source does not exist.
pub fn add_lock(conn: &Connection, t: &ParentalLockTarget, created_at: &str) -> CoreResult<bool> {
    let n = conn
        .execute(
            "INSERT INTO parental_locks(source_id, content_type, kind, target_id, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(source_id, content_type, kind, target_id) DO UPDATE SET name = excluded.name
             WHERE parental_locks.name <> excluded.name",
            params![
                t.source_id,
                t.content_type.as_str(),
                t.kind.as_str(),
                t.target_id,
                t.name,
                created_at
            ],
        )
        .map_err(|e| map_fk(e, &t.source_id))?;
    Ok(n > 0)
}

/// Removes a lock. Returns true when one was removed.
pub fn remove_lock(conn: &Connection, t: &ParentalLockTarget) -> CoreResult<bool> {
    let n = conn.execute(
        "DELETE FROM parental_locks WHERE source_id = ?1 AND content_type = ?2 AND kind = ?3 AND target_id = ?4",
        params![
            t.source_id,
            t.content_type.as_str(),
            t.kind.as_str(),
            t.target_id
        ],
    )?;
    Ok(n > 0)
}

fn map_fk(err: rusqlite::Error, source_id: &str) -> CoreError {
    if let rusqlite::Error::SqliteFailure(e, _) = &err {
        if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY {
            return CoreError::not_found(format!("source {source_id} does not exist"));
        }
    }
    CoreError::Db(err)
}

/// The refs of `items` that are locked: an item lock, a lock on the item's
/// category, or (with `auto_adult`) a category whose name marks adult
/// content. `category_id` is looked up from the catalog when absent. Input
/// order, duplicates collapsed.
pub fn check(
    conn: &Connection,
    items: &[(ItemRef, Option<String>)],
    auto_adult: bool,
) -> CoreResult<Vec<ItemRef>> {
    let mut item_lock = conn.prepare_cached(
        "SELECT 1 FROM parental_locks WHERE source_id = ?1 AND content_type = ?2 AND kind = 'item' AND target_id = ?3",
    )?;
    let mut cat_lock = conn.prepare_cached(
        "SELECT 1 FROM parental_locks WHERE source_id = ?1 AND content_type = ?2 AND kind = 'category' AND target_id = ?3",
    )?;
    let mut item_cat = conn.prepare_cached(
        "SELECT category_id FROM items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3",
    )?;
    // Stalker movies and series are not in `items`; their listed category
    // is kept with the remembered portal row.
    let mut stalker_cat = if crate::stalker::items_have_categories(conn)? {
        Some(conn.prepare_cached(
            "SELECT category_id FROM stalker_items WHERE source_id = ?1 AND content_type = ?2 AND item_id = ?3 AND category_id IS NOT NULL",
        )?)
    } else {
        None
    };
    let mut cat_name = conn.prepare_cached(
        "SELECT name FROM categories WHERE source_id = ?1 AND content_type = ?2 AND category_id = ?3",
    )?;
    let mut adult_cache: HashMap<(String, ContentType, String), bool> = HashMap::new();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (r, category_id) in items {
        if !seen.insert(r) {
            continue;
        }
        let ct = r.content_type.as_str();
        if item_lock.exists(params![r.source_id, ct, r.item_id])? {
            out.push(r.clone());
            continue;
        }
        let category = match category_id.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => Some(c.to_string()),
            None => match item_cat
                .query_row(params![r.source_id, ct, r.item_id], |row| row.get(0))
                .optional()?
            {
                Some(c) => Some(c),
                None => match stalker_cat.as_mut() {
                    Some(stmt) => stmt
                        .query_row(params![r.source_id, ct, r.item_id], |row| row.get(0))
                        .optional()?,
                    None => None,
                },
            },
        };
        let Some(category) = category else {
            continue;
        };
        if cat_lock.exists(params![r.source_id, ct, category])? {
            out.push(r.clone());
            continue;
        }
        if auto_adult {
            let key = (r.source_id.clone(), r.content_type, category.clone());
            let adult = match adult_cache.get(&key) {
                Some(a) => *a,
                None => {
                    let name: Option<String> = cat_name
                        .query_row(params![r.source_id, ct, category], |row| row.get(0))
                        .optional()?;
                    let a = name.as_deref().is_some_and(super::is_adult_category);
                    adult_cache.insert(key, a);
                    a
                }
            };
            if adult {
                out.push(r.clone());
            }
        }
    }
    Ok(out)
}

/// Category ids of one source and type whose name marks adult content, in
/// category order.
pub fn adult_categories(
    conn: &Connection,
    source_id: &str,
    content_type: ContentType,
) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT category_id, name FROM categories WHERE source_id = ?1 AND content_type = ?2
         ORDER BY position, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![source_id, content_type.as_str()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name) = row?;
        if super::is_adult_category(&name) {
            out.push(id);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockout_doubles_from_the_fifth_wrong_pin_up_to_five_minutes() {
        let got: Vec<u64> = (1..=10).map(lockout_secs).collect();
        assert_eq!(got, [0, 0, 0, 0, 30, 60, 120, 240, 300, 300]);
        assert_eq!(lockout_secs(u32::MAX), 300);
    }

    #[test]
    fn target_length_limit_applies_to_the_stored_id() {
        let t = |id: String| ParentalLockTarget {
            source_id: " s1 ".into(),
            content_type: ContentType::Live,
            kind: ParentalLockKind::Item,
            target_id: id,
            name: " Name ".into(),
        };
        // Padding cannot carry an id past the limit.
        let padded = format!("{}ca915ddbf6fe48e6{}", " ".repeat(500), " ".repeat(500));
        assert!(matches!(
            validate_target(&t(padded)),
            Err(CoreError::Invalid(_))
        ));
        let edge = format!("  {}", "x".repeat(MAX_ID_LEN - 1));
        assert!(validate_target(&t(edge)).is_err());
        assert!(validate_target(&t("   ".into())).is_err());
        // Within the limit the id is stored as given (ids match the catalog
        // exactly); the source id and name are trimmed.
        let ok = validate_target(&t("x".repeat(MAX_ID_LEN))).unwrap();
        assert_eq!(ok.target_id.len(), MAX_ID_LEN);
        assert_eq!((ok.source_id.as_str(), ok.name.as_str()), ("s1", "Name"));
    }

    #[test]
    fn retry_after_rounds_up() {
        let now = Utc::now();
        let mut c = Config {
            lockout_until: Some(now + chrono::Duration::milliseconds(29_001)),
            ..Config::default()
        };
        assert_eq!(c.retry_after(now), Some(30));
        c.lockout_until = Some(now);
        assert_eq!(c.retry_after(now), None);
        c.lockout_until = None;
        assert_eq!(c.retry_after(now), None);
    }
}
