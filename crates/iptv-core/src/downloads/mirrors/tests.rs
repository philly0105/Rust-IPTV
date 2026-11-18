//! Unit tests of the pure parts and the verdict cache (an in-memory
//! `app_state`). The network paths are tested against `dl_panel` in
//! `tests/downloads_mirrors.rs`.

use super::cache::{self, stamp};
use super::*;
use crate::downloads::shared::{mirror_key, MirrorRecord, Verdict, VerdictEntry, MIN_MIRROR_TOTAL};
use crate::model::{ContentType, ItemRef};
use chrono::{Duration as Span, Utc};

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
         CREATE TABLE sources (id TEXT PRIMARY KEY);
         INSERT INTO sources (id) VALUES ('a'), ('b'), ('c'), ('d');",
    )
    .unwrap();
    conn
}

fn movie(source: &str) -> CopyRef {
    CopyRef::new(ItemRef::new(source, ContentType::Movie, "7"), None)
}

fn fp(total: i64, validator: Option<&str>, seed: &str) -> Fingerprint {
    Fingerprint {
        total,
        validator: validator.map(str::to_string),
        samples: [format!("{seed}0"), format!("{seed}1"), format!("{seed}2")],
        checked_at: stamp(Utc::now()),
    }
}

fn entry(copy: &CopyRef, verdict: Verdict, total: Option<i64>, ago: Span) -> VerdictEntry {
    VerdictEntry {
        copy: copy.clone(),
        verdict,
        total,
        validator: None,
        checked_at: stamp(Utc::now() - ago),
    }
}

fn meta(q: Option<Quality>, c: Option<&str>, total: i64) -> CopyMeta {
    CopyMeta {
        quality: q,
        container: c.map(str::to_string),
        total,
    }
}

#[test]
fn equivalent_follows_the_table() {
    use Quality::*;
    let cases: &[(CopyMeta, CopyMeta, bool, &str)] = &[
        (
            meta(Some(Fhd), Some("mkv"), 1000),
            meta(Some(Fhd), Some("mkv"), 1000),
            true,
            "same",
        ),
        (
            meta(None, Some("mp4"), 1000),
            meta(None, Some("mp4"), 900),
            true,
            "both untagged",
        ),
        (
            meta(Some(Hd), Some("mp4"), 1000),
            meta(None, Some("mp4"), 1000),
            false,
            "one untagged",
        ),
        (
            meta(Some(Hd), Some("mp4"), 1000),
            meta(Some(Uhd), Some("mp4"), 1000),
            false,
            "other quality",
        ),
        (
            meta(None, Some("MKV"), 1000),
            meta(None, Some(".mkv"), 1000),
            true,
            "case and dot",
        ),
        (
            meta(None, Some("mkv"), 1000),
            meta(None, Some("mp4"), 1000),
            false,
            "other container",
        ),
        (
            meta(None, None, 1000),
            meta(None, None, 1000),
            false,
            "no container",
        ),
        (
            meta(None, Some("mp4"), 1000),
            meta(None, None, 1000),
            false,
            "one container",
        ),
        (
            meta(None, Some(" "), 1000),
            meta(None, Some(" "), 1000),
            false,
            "blank container",
        ),
        (
            meta(None, Some("mp4"), 1000),
            meta(None, Some("mp4"), 850),
            true,
            "exactly 15%",
        ),
        (
            meta(None, Some("mp4"), 850),
            meta(None, Some("mp4"), 1000),
            true,
            "symmetric",
        ),
        (
            meta(None, Some("mp4"), 1000),
            meta(None, Some("mp4"), 849),
            false,
            "just past 15%",
        ),
        (
            meta(None, Some("mp4"), 0),
            meta(None, Some("mp4"), 0),
            false,
            "unknown sizes",
        ),
        (
            meta(None, Some("mp4"), -1),
            meta(None, Some("mp4"), 1),
            false,
            "negative size",
        ),
        (
            meta(None, Some("mp4"), i64::MAX),
            meta(None, Some("mp4"), i64::MAX - 1),
            true,
            "no overflow",
        ),
    ];
    for (a, b, want, what) in cases {
        assert_eq!(equivalent(a, b), *want, "{what}: {a:?} vs {b:?}");
        assert_eq!(equivalent(b, a), *want, "{what} (swapped)");
    }
}

#[test]
fn still_matches_compares_total_and_validator() {
    let with = fp(MIN_MIRROR_TOTAL, Some("\"a\""), "x");
    assert!(still_matches(&with, MIN_MIRROR_TOTAL, Some("\"a\"")));
    assert!(!still_matches(&with, MIN_MIRROR_TOTAL, Some("\"b\"")));
    assert!(!still_matches(&with, MIN_MIRROR_TOTAL, None));
    assert!(!still_matches(&with, MIN_MIRROR_TOTAL + 1, Some("\"a\"")));
    let without = fp(MIN_MIRROR_TOTAL, None, "x");
    assert!(still_matches(&without, MIN_MIRROR_TOTAL, None));
    assert!(still_matches(&without, MIN_MIRROR_TOTAL, Some("\"new\"")));
}

#[test]
fn fingerprints_without_a_validator_last_seven_days() {
    let conn = db();
    let copy = movie("a");
    let mut old = fp(MIN_MIRROR_TOTAL, None, "x");
    old.checked_at = stamp(Utc::now() - Span::days(6));
    store_fingerprint(&conn, &copy, &old).unwrap();
    assert_eq!(cached_fingerprint(&conn, &copy).unwrap(), Some(old.clone()));
    cache::age(&conn, std::time::Duration::from_secs(2 * 24 * 3600)).unwrap();
    assert_eq!(
        cached_fingerprint(&conn, &copy).unwrap(),
        None,
        "8 days old"
    );

    // With a validator it stands until the caller sees a change.
    let mut tagged = fp(MIN_MIRROR_TOTAL, Some("\"e\""), "x");
    tagged.checked_at = stamp(Utc::now() - Span::days(400));
    store_fingerprint(&conn, &copy, &tagged).unwrap();
    assert_eq!(cached_fingerprint(&conn, &copy).unwrap(), Some(tagged));
    assert_eq!(cached_fingerprint(&conn, &movie("other")).unwrap(), None);
}

#[test]
fn a_changed_fingerprint_drops_the_verdicts() {
    let conn = db();
    let (a, b) = (movie("a"), movie("b"));
    let first = fp(MIN_MIRROR_TOTAL, Some("\"1\""), "x");
    store_fingerprint(&conn, &a, &first).unwrap();
    cache::record_verdict(
        &conn,
        &a,
        entry(&b, Verdict::Identical, Some(MIN_MIRROR_TOTAL), Span::zero()),
    )
    .unwrap();
    // The same fingerprint again, or one checked later with the same bytes
    // and validator, keeps them.
    store_fingerprint(&conn, &a, &first).unwrap();
    let mut later = first.clone();
    later.checked_at = stamp(Utc::now() + Span::seconds(5));
    store_fingerprint(&conn, &a, &later).unwrap();
    assert_eq!(cached_identical(&conn, &a).unwrap(), vec![b.clone()]);
    // Another validator: the file changed.
    let changed = fp(MIN_MIRROR_TOTAL, Some("\"2\""), "x");
    store_fingerprint(&conn, &a, &changed).unwrap();
    assert!(cached_identical(&conn, &a).unwrap().is_empty());
    cache::record_verdict(
        &conn,
        &a,
        entry(&b, Verdict::Identical, Some(MIN_MIRROR_TOTAL), Span::zero()),
    )
    .unwrap();
    // Other bytes, no validator to tell.
    store_fingerprint(&conn, &a, &fp(MIN_MIRROR_TOTAL, None, "y")).unwrap();
    assert!(cached_identical(&conn, &a).unwrap().is_empty());
}

#[test]
fn verdict_windows_follow_the_spec() {
    let conn = db();
    let a = movie("a");
    let rec = |verdicts: Vec<VerdictEntry>| MirrorRecord {
        version: 1,
        copy: a.clone(),
        fingerprint: Some(fp(MIN_MIRROR_TOTAL, None, "x")),
        verdicts,
    };
    let now = Utc::now();
    let b = movie("b");
    let at = |v: Verdict, ago: Span| {
        cache::fresh_verdict(
            &rec(vec![entry(&b, v, Some(MIN_MIRROR_TOTAL), ago)]),
            &b,
            None,
            now,
        )
    };
    use Verdict::*;
    assert_eq!(at(Identical, Span::days(29)), Some(Identical));
    assert_eq!(at(Identical, Span::days(31)), None);
    assert_eq!(at(Equivalent, Span::days(29)), Some(Equivalent));
    assert_eq!(at(Equivalent, Span::days(31)), None);
    assert_eq!(at(Differs, Span::days(29)), Some(Differs));
    assert_eq!(at(Differs, Span::days(31)), None);
    assert_eq!(at(Unavailable, Span::minutes(59)), Some(Unavailable));
    assert_eq!(at(Unavailable, Span::minutes(61)), None);
    // A source that was only busy is asked again after two minutes.
    let busy = |ago: Span| {
        let mut e = entry(&b, Unavailable, None, ago);
        e.validator = Some(cache::BUSY.into());
        cache::fresh_verdict(&rec(vec![e]), &b, None, now)
    };
    assert_eq!(busy(Span::seconds(110)), Some(Unavailable));
    assert_eq!(busy(Span::seconds(130)), None);
    // A stamp from the future (a clock set back) or one that does not parse
    // never stands.
    assert_eq!(at(Differs, Span::hours(-2)), None);
    let mut bad = entry(&b, Differs, None, Span::zero());
    bad.checked_at = "yesterday".into();
    assert_eq!(cache::fresh_verdict(&rec(vec![bad]), &b, None, now), None);
    assert_eq!(cache::fresh_verdict(&rec(vec![]), &b, None, now), None);

    // Identical stands only while both totals still match.
    let same = rec(vec![entry(
        &b,
        Identical,
        Some(MIN_MIRROR_TOTAL),
        Span::zero(),
    )]);
    let theirs = fp(MIN_MIRROR_TOTAL, None, "x");
    assert_eq!(
        cache::fresh_verdict(&same, &b, Some(&theirs), now),
        Some(Identical)
    );
    let grown = fp(MIN_MIRROR_TOTAL + 1, None, "x");
    assert_eq!(cache::fresh_verdict(&same, &b, Some(&grown), now), None);
    let other_bytes = fp(MIN_MIRROR_TOTAL, None, "z");
    assert_eq!(
        cache::fresh_verdict(&same, &b, Some(&other_bytes), now),
        None
    );
    let mut own_changed = same.clone();
    own_changed.fingerprint = Some(fp(MIN_MIRROR_TOTAL * 2, None, "x"));
    assert_eq!(cache::fresh_verdict(&own_changed, &b, None, now), None);
    // A recorded validator must still be the copy's.
    let mut tagged = same.clone();
    tagged.verdicts[0].validator = Some("\"v1\"".into());
    let mut theirs_v2 = theirs.clone();
    theirs_v2.validator = Some("\"v2\"".into());
    assert_eq!(
        cache::fresh_verdict(&tagged, &b, Some(&theirs_v2), now),
        None
    );
    theirs_v2.validator = Some("\"v1\"".into());
    assert_eq!(
        cache::fresh_verdict(&tagged, &b, Some(&theirs_v2), now),
        Some(Identical)
    );
    // Equivalent copies have other totals by nature; only the other side's
    // recorded total is checked.
    let eq = rec(vec![entry(
        &b,
        Equivalent,
        Some(MIN_MIRROR_TOTAL + 9),
        Span::zero(),
    )]);
    let theirs_eq = fp(MIN_MIRROR_TOTAL + 9, None, "q");
    assert_eq!(
        cache::fresh_verdict(&eq, &b, Some(&theirs_eq), now),
        Some(Equivalent)
    );
    assert_eq!(cache::fresh_verdict(&eq, &b, Some(&theirs), now), None);
    drop(conn);
}

#[test]
fn records_keep_the_newest_fifty_and_newest_wins_per_copy() {
    let conn = db();
    let a = movie("a");
    for i in 0..60 {
        let copy = CopyRef::new(ItemRef::new(format!("s{i}"), ContentType::Movie, "7"), None);
        // Older the higher i goes, so s50..s59 are the ones to go.
        let e = entry(&copy, Verdict::Differs, None, Span::minutes(i));
        cache::record_verdict(&conn, &a, e).unwrap();
    }
    let rec = cache::load(&conn, &a).unwrap().unwrap();
    assert_eq!(rec.verdicts.len(), 50);
    assert!(rec.verdicts.iter().all(|e| {
        let i: i64 = e.copy.source_id()[1..].parse().unwrap();
        i < 50
    }));

    let b = movie("b");
    cache::record_verdict(
        &conn,
        &a,
        entry(&b, Verdict::Identical, Some(1), Span::minutes(1)),
    )
    .unwrap();
    // An older verdict does not replace a newer one.
    cache::record_verdict(
        &conn,
        &a,
        entry(&b, Verdict::Differs, None, Span::minutes(5)),
    )
    .unwrap();
    let rec = cache::load(&conn, &a).unwrap().unwrap();
    let mine: Vec<_> = rec.verdicts.iter().filter(|e| e.copy == b).collect();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].verdict, Verdict::Identical);
    // A newer one does.
    cache::record_verdict(&conn, &a, entry(&b, Verdict::Differs, None, Span::zero())).unwrap();
    let rec = cache::load(&conn, &a).unwrap().unwrap();
    let mine: Vec<_> = rec.verdicts.iter().filter(|e| e.copy == b).collect();
    assert_eq!((mine.len(), mine[0].verdict), (1, Verdict::Differs));
    assert_eq!(rec.verdicts.len(), 50);
}

#[test]
fn cached_identical_lists_standing_copies_on_other_sources() {
    let conn = db();
    let a = movie("a");
    let (b, c, d, own) = (movie("b"), movie("c"), movie("d"), movie("a"));
    let total = Some(MIN_MIRROR_TOTAL);
    store_fingerprint(&conn, &a, &fp(MIN_MIRROR_TOTAL, None, "x")).unwrap();
    for e in [
        entry(&b, Verdict::Identical, total, Span::zero()),
        entry(&c, Verdict::Differs, total, Span::zero()),
        entry(&d, Verdict::Identical, total, Span::days(31)),
        entry(&own, Verdict::Identical, total, Span::zero()),
    ] {
        cache::record_verdict(&conn, &a, e).unwrap();
    }
    assert_eq!(cached_identical(&conn, &a).unwrap(), vec![b.clone()]);
    // b's own fingerprint now shows other bytes: no longer identical.
    store_fingerprint(&conn, &b, &fp(MIN_MIRROR_TOTAL, None, "other")).unwrap();
    assert!(cached_identical(&conn, &a).unwrap().is_empty());
    assert!(cached_identical(&conn, &movie("nobody"))
        .unwrap()
        .is_empty());
}

#[test]
fn removed_sources_are_skipped_then_forgotten() {
    let conn = db();
    let (a, b, c) = (movie("a"), movie("b"), movie("c"));
    let total = Some(MIN_MIRROR_TOTAL);
    for copy in [&a, &b, &c] {
        store_fingerprint(&conn, copy, &fp(MIN_MIRROR_TOTAL, None, "x")).unwrap();
    }
    for (owner, of) in [(&a, &b), (&a, &c), (&b, &a), (&c, &b)] {
        cache::record_verdict(
            &conn,
            owner,
            entry(of, Verdict::Identical, total, Span::zero()),
        )
        .unwrap();
    }
    assert_eq!(
        cached_identical(&conn, &a).unwrap(),
        vec![b.clone(), c.clone()]
    );
    conn.execute("DELETE FROM sources WHERE id = 'b'", [])
        .unwrap();
    // Before the cleanup, reads already skip the removed source.
    assert_eq!(cached_identical(&conn, &a).unwrap(), vec![c.clone()]);
    // a and c lose their verdicts on b; b's record goes.
    assert_eq!(cache::forget_source(&conn, "b").unwrap(), 3);
    let copies = |owner: &CopyRef| -> Vec<CopyRef> {
        cache::load(&conn, owner)
            .unwrap()
            .unwrap()
            .verdicts
            .into_iter()
            .map(|e| e.copy)
            .collect()
    };
    assert_eq!(copies(&a), vec![c.clone()]);
    assert!(copies(&c).is_empty());
    assert!(cache::load(&conn, &b).unwrap().is_none());
    assert!(cache::cached_fingerprint(&conn, &c, Utc::now())
        .unwrap()
        .is_some());
    // Nothing left to do the second time.
    assert_eq!(cache::forget_source(&conn, "b").unwrap(), 0);
}

#[test]
fn drop_verdict_removes_only_the_named_kind() {
    let conn = db();
    let (a, b) = (movie("a"), movie("b"));
    cache::record_verdict(&conn, &a, entry(&b, Verdict::Differs, None, Span::zero())).unwrap();
    assert!(!cache::drop_verdict(&conn, &a, &b, Verdict::Identical).unwrap());
    assert!(cache::drop_verdict(&conn, &a, &b, Verdict::Differs).unwrap());
    assert!(!cache::drop_verdict(&conn, &movie("none"), &b, Verdict::Differs).unwrap());
}

#[test]
fn drop_matches_removes_every_match_of_the_copy_both_ways() {
    let conn = db();
    let (a, b, c, d) = (movie("a"), movie("b"), movie("c"), movie("d"));
    let total = Some(MIN_MIRROR_TOTAL);
    store_fingerprint(&conn, &a, &fp(MIN_MIRROR_TOTAL, None, "x")).unwrap();
    for (owner, copy, verdict) in [
        (&a, &b, Verdict::Identical),
        (&b, &a, Verdict::Identical),
        (&a, &c, Verdict::Equivalent),
        (&c, &a, Verdict::Equivalent),
        (&b, &c, Verdict::Identical),
        (&c, &b, Verdict::Identical),
    ] {
        cache::record_verdict(&conn, owner, entry(copy, verdict, total, Span::zero())).unwrap();
    }
    cache::record_verdict(&conn, &a, entry(&d, Verdict::Differs, None, Span::zero())).unwrap();
    cache::drop_matches(&conn, &a).unwrap();
    let names = |owner: &CopyRef, copy: &CopyRef| {
        cache::load(&conn, owner)
            .unwrap()
            .is_some_and(|r| r.verdicts.iter().any(|e| e.copy == *copy))
    };
    for other in [&b, &c] {
        assert!(!names(&a, other) && !names(other, &a), "{other:?}");
    }
    // A Differs verdict stays, and so do the matches between the others.
    assert!(names(&a, &d));
    assert_eq!(cached_identical(&conn, &b).unwrap(), vec![c.clone()]);
    assert_eq!(cached_identical(&conn, &c).unwrap(), vec![b.clone()]);
    // The fingerprint is the caller's to forget (`record_mismatch` does it
    // next); with it gone, no match of the copy comes back.
    assert!(cached_fingerprint(&conn, &a).unwrap().is_some());
    cache::forget_fingerprint(&conn, &a).unwrap();
    assert_eq!(cached_fingerprint(&conn, &a).unwrap(), None);
    assert!(cached_identical(&conn, &a).unwrap().is_empty());
}

#[test]
fn records_of_another_version_or_copy_read_as_absent() {
    let conn = db();
    let a = movie("a");
    let mut rec = MirrorRecord {
        version: 2,
        copy: a.clone(),
        fingerprint: Some(fp(MIN_MIRROR_TOTAL, None, "x")),
        verdicts: vec![],
    };
    crate::downloads::shared::write_record(&conn, &mirror_key(&a), &rec).unwrap();
    assert_eq!(cached_fingerprint(&conn, &a).unwrap(), None);
    rec.version = 1;
    rec.copy = movie("b");
    crate::downloads::shared::write_record(&conn, &mirror_key(&a), &rec).unwrap();
    assert_eq!(cached_fingerprint(&conn, &a).unwrap(), None);
    // Writing over it starts a clean record.
    let new = fp(MIN_MIRROR_TOTAL, None, "n");
    store_fingerprint(&conn, &a, &new).unwrap();
    assert_eq!(cached_fingerprint(&conn, &a).unwrap(), Some(new));
}

#[test]
fn age_moves_every_stamp_back() {
    let conn = db();
    let (a, b) = (movie("a"), movie("b"));
    store_fingerprint(&conn, &a, &fp(MIN_MIRROR_TOTAL, None, "x")).unwrap();
    cache::record_verdict(
        &conn,
        &a,
        entry(&b, Verdict::Unavailable, None, Span::zero()),
    )
    .unwrap();
    conn.execute(
        "INSERT INTO app_state(key, value) VALUES ('dl_conn_limit:a', '{}')",
        [],
    )
    .unwrap();
    assert_eq!(
        cache::age(&conn, std::time::Duration::from_secs(7200)).unwrap(),
        1
    );
    let rec = cache::load(&conn, &a).unwrap().unwrap();
    let now = Utc::now();
    assert_eq!(cache::fresh_verdict(&rec, &b, None, now), None);
    let checked = chrono::DateTime::parse_from_rfc3339(&rec.fingerprint.unwrap().checked_at)
        .unwrap()
        .with_timezone(&Utc);
    assert!(now - checked >= Span::hours(2));
    // Other key families are left alone.
    let other: String = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = 'dl_conn_limit:a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(other, "{}");
}
