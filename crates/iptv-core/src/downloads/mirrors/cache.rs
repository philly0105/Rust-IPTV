//! Mirror records in `app_state` ([`MirrorRecord`] under
//! [`shared::mirror_key`]): each copy's fingerprint and the verdicts of the
//! comparisons it took part in, with the validity windows of the download
//! speed spec (section 3.5):
//!
//! - A fingerprint with a validator stands while the copy's total and
//!   validator are unchanged ([`super::still_matches`] is the caller's check);
//!   one without a validator stands for [`FINGERPRINT_TTL`].
//! - Identical and Equivalent verdicts stand for [`MATCH_TTL`], and only
//!   while both copies' fingerprints still agree with what was compared.
//! - Differs stands for [`DIFFERS_TTL`]; Unavailable for [`UNAVAILABLE_TTL`],
//!   or [`BUSY_TTL`] when the source only had no spare connection (the
//!   entry's validator is [`BUSY`]).
//! - Nothing names a removed source: [`forget_source`] strips it, and the
//!   reads here skip any copy whose source is gone.
//!
//! Every write is a read-modify-write of one record; callers on the
//! serialized write connection (`db_write`) never lose each other's updates.
//! A record that no longer parses, or has another version, reads as absent:
//! a format change costs a re-check, never an error.

use crate::downloads::shared::{
    mirror_key, read_record, write_record, Fingerprint, MirrorRecord, Verdict, VerdictEntry,
    MIRROR_KEY_PREFIX,
};
use crate::error::CoreResult;
use crate::model::CopyRef;
use chrono::{DateTime, Duration as Span, Utc};
use rusqlite::{params, Connection};
use std::time::Duration;

/// Version of the [`MirrorRecord`]s written here.
pub(super) const VERSION: u32 = 1;
/// How long a fingerprint without a validator stands.
pub(super) const FINGERPRINT_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// How long an Identical or Equivalent verdict stands.
pub(super) const MATCH_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// How long a Differs verdict stands.
pub(super) const DIFFERS_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// How long an Unavailable verdict stands (the source was busy or failed).
pub(super) const UNAVAILABLE_TTL: Duration = Duration::from_secs(3600);
/// How long an Unavailable verdict stands when the source was only busy
/// (the manager refused a verification hold).
pub(super) const BUSY_TTL: Duration = Duration::from_secs(120);
/// The validator of a busy Unavailable entry. Unavailable entries carry no
/// validator otherwise.
pub(super) const BUSY: &str = "busy";
/// Most verdicts one record keeps; the oldest go first.
pub(super) const MAX_VERDICTS: usize = 50;

/// Now, as records store it (RFC 3339, UTC, milliseconds).
pub(super) fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn now() -> DateTime<Utc> {
    Utc::now()
}

fn parse(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Whether `at` lies within `ttl` before `now`. A stamp that does not parse,
/// or lies more than a minute in the future (a clock that jumped back), is
/// never fresh.
fn within(at: &str, ttl: Duration, now: DateTime<Utc>) -> bool {
    let Some(at) = parse(at) else {
        return false;
    };
    let age = now.signed_duration_since(at);
    age >= -Span::minutes(1) && age.to_std().map_or(true, |a| a < ttl)
}

/// `copy`'s record, if one of this version parses.
pub(super) fn load(conn: &Connection, copy: &CopyRef) -> CoreResult<Option<MirrorRecord>> {
    Ok(read_record::<MirrorRecord>(conn, &mirror_key(copy))?
        .filter(|r| r.version == VERSION && r.copy == *copy))
}

fn load_or_new(conn: &Connection, copy: &CopyRef) -> CoreResult<MirrorRecord> {
    Ok(load(conn, copy)?.unwrap_or_else(|| MirrorRecord {
        version: VERSION,
        copy: copy.clone(),
        fingerprint: None,
        verdicts: Vec::new(),
    }))
}

fn save(conn: &Connection, rec: &MirrorRecord) -> CoreResult<()> {
    write_record(conn, &mirror_key(&rec.copy), rec)
}

/// Whether `fp`, cached for its copy, may still be used without asking the
/// provider: always with a validator (the caller compares it against the
/// next answer), for [`FINGERPRINT_TTL`] without one.
pub(super) fn fingerprint_fresh(fp: &Fingerprint, now: DateTime<Utc>) -> bool {
    fp.validator.is_some() || within(&fp.checked_at, FINGERPRINT_TTL, now)
}

/// Whether two fingerprints describe the same bytes: the same total and all
/// three samples equal. Validators are per provider and never compared.
pub(super) fn same_bytes(a: &Fingerprint, b: &Fingerprint) -> bool {
    a.total == b.total && a.samples == b.samples
}

/// Whether `new` describes another state of a copy than `old`: other
/// bytes, or another validator where both have one.
fn changed(old: &Fingerprint, new: &Fingerprint) -> bool {
    !same_bytes(old, new)
        || matches!((&old.validator, &new.validator), (Some(a), Some(b)) if a != b)
}

pub(super) fn cached_fingerprint(
    conn: &Connection,
    copy: &CopyRef,
    now: DateTime<Utc>,
) -> CoreResult<Option<Fingerprint>> {
    Ok(load(conn, copy)?
        .and_then(|r| r.fingerprint)
        .filter(|fp| fingerprint_fresh(fp, now)))
}

/// Stores `fp` as `copy`'s fingerprint. When it describes another state of
/// the copy than the stored one, the copy's verdicts go too: they compared
/// bytes it no longer has.
pub(super) fn store_fingerprint(
    conn: &Connection,
    copy: &CopyRef,
    fp: &Fingerprint,
) -> CoreResult<()> {
    let mut rec = load_or_new(conn, copy)?;
    if rec.fingerprint.as_ref() == Some(fp) {
        return Ok(());
    }
    if rec.fingerprint.as_ref().is_some_and(|old| changed(old, fp)) {
        rec.verdicts.clear();
    }
    rec.fingerprint = Some(fp.clone());
    save(conn, &rec)
}

/// Forgets `copy`'s cached fingerprint (its verdicts stay), so the next
/// comparison asks the provider again.
pub(super) fn forget_fingerprint(conn: &Connection, copy: &CopyRef) -> CoreResult<()> {
    let Some(mut rec) = load(conn, copy)? else {
        return Ok(());
    };
    if rec.fingerprint.take().is_some() {
        save(conn, &rec)?;
    }
    Ok(())
}

/// Records `entry` in `owner`'s record: it replaces the copy's earlier
/// verdict unless that one is newer, and the record keeps the newest
/// [`MAX_VERDICTS`].
pub(super) fn record_verdict(
    conn: &Connection,
    owner: &CopyRef,
    entry: VerdictEntry,
) -> CoreResult<()> {
    let mut rec = load_or_new(conn, owner)?;
    let newer = |e: &VerdictEntry| match (parse(&e.checked_at), parse(&entry.checked_at)) {
        (Some(old), Some(new)) => old > new,
        _ => false,
    };
    if rec
        .verdicts
        .iter()
        .any(|e| e.copy == entry.copy && newer(e))
    {
        return Ok(());
    }
    rec.verdicts.retain(|e| e.copy != entry.copy);
    rec.verdicts.push(entry);
    if rec.verdicts.len() > MAX_VERDICTS {
        // Newest first; a stamp that does not parse counts as oldest.
        rec.verdicts
            .sort_by_key(|e| std::cmp::Reverse(parse(&e.checked_at)));
        rec.verdicts.truncate(MAX_VERDICTS);
    }
    save(conn, &rec)
}

/// Drops `owner`'s verdict on `copy` when it is `verdict`. True when one
/// went.
pub(super) fn drop_verdict(
    conn: &Connection,
    owner: &CopyRef,
    copy: &CopyRef,
    verdict: Verdict,
) -> CoreResult<bool> {
    let Some(mut rec) = load(conn, owner)? else {
        return Ok(false);
    };
    let before = rec.verdicts.len();
    rec.verdicts
        .retain(|e| !(e.copy == *copy && e.verdict == verdict));
    if rec.verdicts.len() == before {
        return Ok(false);
    }
    save(conn, &rec)?;
    Ok(true)
}

/// Drops every Identical and Equivalent verdict between `copy` and another
/// copy, under both records (a match is recorded on both sides). Differs
/// and Unavailable verdicts stay.
pub(super) fn drop_matches(conn: &Connection, copy: &CopyRef) -> CoreResult<()> {
    let Some(rec) = load(conn, copy)? else {
        return Ok(());
    };
    let matched = rec
        .verdicts
        .iter()
        .filter(|e| matches!(e.verdict, Verdict::Identical | Verdict::Equivalent))
        .map(|e| e.copy.clone());
    for other in matched {
        for verdict in [Verdict::Identical, Verdict::Equivalent] {
            drop_verdict(conn, &other, copy, verdict)?;
            drop_verdict(conn, copy, &other, verdict)?;
        }
    }
    Ok(())
}

/// `rec`'s verdict on `copy`, when it still stands. `other` is `copy`'s own
/// cached fingerprint, if any: an Identical or Equivalent verdict stands
/// only while that still shows the total (and validator) compared, and an
/// Identical one only while both copies' samples still agree.
pub(super) fn fresh_verdict(
    rec: &MirrorRecord,
    copy: &CopyRef,
    other: Option<&Fingerprint>,
    now: DateTime<Utc>,
) -> Option<Verdict> {
    let e = rec.verdicts.iter().find(|e| e.copy == *copy)?;
    let fresh = match e.verdict {
        Verdict::Identical | Verdict::Equivalent => {
            within(&e.checked_at, MATCH_TTL, now)
                && other.is_none_or(|o| {
                    e.total.is_none_or(|t| t == o.total)
                        && match (&e.validator, &o.validator) {
                            (Some(a), Some(b)) => a == b,
                            _ => true,
                        }
                })
                && (e.verdict == Verdict::Equivalent
                    || (e.total.is_some()
                        && rec.fingerprint.as_ref().is_none_or(|own| {
                            Some(own.total) == e.total && other.is_none_or(|o| same_bytes(own, o))
                        })))
        }
        Verdict::Differs => within(&e.checked_at, DIFFERS_TTL, now),
        Verdict::Unavailable if e.validator.as_deref() == Some(BUSY) => {
            within(&e.checked_at, BUSY_TTL, now)
        }
        Verdict::Unavailable => within(&e.checked_at, UNAVAILABLE_TTL, now),
    };
    fresh.then_some(e.verdict)
}

/// Whether source `id` still exists.
pub(super) fn source_exists(conn: &Connection, id: &str) -> CoreResult<bool> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM sources WHERE id = ?1")?
        .exists([id])?)
}

/// Copies with a standing Identical verdict in `item`'s record, on sources
/// other than `item`'s that still exist, ordered by source.
pub(super) fn cached_identical(
    conn: &Connection,
    item: &CopyRef,
    now: DateTime<Utc>,
) -> CoreResult<Vec<CopyRef>> {
    let Some(rec) = load(conn, item)? else {
        return Ok(Vec::new());
    };
    let mut out: Vec<CopyRef> = Vec::new();
    for e in &rec.verdicts {
        if e.verdict != Verdict::Identical
            || e.copy.source_id() == item.source_id()
            || out.contains(&e.copy)
            || !source_exists(conn, e.copy.source_id())?
        {
            continue;
        }
        let other = cached_fingerprint(conn, &e.copy, now)?;
        if fresh_verdict(&rec, &e.copy, other.as_ref(), now) == Some(Verdict::Identical) {
            out.push(e.copy.clone());
        }
    }
    // A stable order, whatever order the checks finished in.
    out.sort_by(|a, b| {
        (a.source_id(), &a.item_ref.item_id, &a.episode_id).cmp(&(
            b.source_id(),
            &b.item_ref.item_id,
            &b.episode_id,
        ))
    });
    Ok(out)
}

/// Every mirror record's key. A prefix compare, not LIKE: ids may hold `_`.
fn keys(conn: &Connection) -> CoreResult<Vec<String>> {
    let mut st = conn
        .prepare("SELECT key FROM app_state WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key")?;
    let keys = st
        .query_map(params![MIRROR_KEY_PREFIX], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(keys)
}

/// Forgets source `source_id` in every mirror record: its copies' records
/// (their fingerprints) go, and every other record loses the verdicts that
/// name one of its copies. Records that do not parse are left alone.
/// Returns how many records changed or went.
pub(super) fn forget_source(conn: &Connection, source_id: &str) -> CoreResult<usize> {
    let mut changed = 0;
    for key in keys(conn)? {
        let Some(mut rec) = read_record::<MirrorRecord>(conn, &key)? else {
            continue;
        };
        if rec.copy.source_id() == source_id {
            conn.execute("DELETE FROM app_state WHERE key = ?1", [&key])?;
            changed += 1;
            continue;
        }
        let before = rec.verdicts.len();
        rec.verdicts.retain(|e| e.copy.source_id() != source_id);
        if rec.verdicts.len() != before {
            write_record(conn, &key, &rec)?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Test hook: moves every mirror record's stamps `by` into the past, as if
/// that much time had gone by.
pub(super) fn age(conn: &Connection, by: Duration) -> CoreResult<usize> {
    let by = Span::from_std(by).unwrap_or(Span::MAX);
    let shift = |at: &mut String| {
        if let Some(t) = parse(at).and_then(|t| t.checked_sub_signed(by)) {
            *at = stamp(t);
        }
    };
    let mut aged = 0;
    for key in keys(conn)? {
        let Some(mut rec) = read_record::<MirrorRecord>(conn, &key)? else {
            continue;
        };
        if let Some(fp) = rec.fingerprint.as_mut() {
            shift(&mut fp.checked_at);
        }
        for e in &mut rec.verdicts {
            shift(&mut e.checked_at);
        }
        write_record(conn, &key, &rec)?;
        aged += 1;
    }
    Ok(aged)
}
