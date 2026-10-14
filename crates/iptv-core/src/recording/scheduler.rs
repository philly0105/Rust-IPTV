//! Pure scheduling decisions: which reminders fire, which recordings start
//! or stop, what is missed, and when to wake next. No I/O and no sleeping,
//! so tests drive it with any clock value.

use super::store::{RecordingRow, ReminderRow};
use super::{RecordingStatus, ReminderStatus};
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};

/// Source of "now" in unix seconds. The app uses [`SystemClock`]; tests
/// install a [`ManualClock`].
pub trait Clock: Send + Sync {
    fn now(&self) -> i64;
}

/// Wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        chrono::Utc::now().timestamp()
    }
}

/// A clock tests set by hand.
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(now: i64) -> Self {
        Self(AtomicI64::new(now))
    }
    pub fn set(&self, now: i64) {
        self.0.store(now, Ordering::SeqCst);
    }
    pub fn advance(&self, secs: i64) {
        self.0.fetch_add(secs, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A reminder still fires this long after the programme started (the PC
/// woke from sleep, the app was busy); later it is missed.
pub const REMINDER_LATE_GRACE: i64 = 5 * 60;

/// How far a rescheduled programme may move and still be the same one.
pub const REMATCH_WINDOW: i64 = 3 * 3600;

/// One decision of [`plan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    FireReminder(String),
    MissReminder(String),
    /// The programme is over: delete the reminder.
    PurgeReminder(String),
    StartRecording(String),
    MissRecording(String),
    StopRecording(String),
    /// A row left `recording` with no engine (the app crashed): resume it
    /// before its end, or close it after.
    ResumeRecording(String),
    CloseRecording(String),
}

/// Inputs of one scheduling pass.
pub struct PlanInput<'a> {
    pub now: i64,
    pub reminders_enabled: bool,
    pub lead_minutes: i64,
    pub reminders: &'a [ReminderRow],
    pub recordings: &'a [RecordingRow],
    /// Recordings with a running engine.
    pub active: &'a HashSet<String>,
}

/// When a reminder fires.
pub fn fire_at(r: &ReminderRow, lead_minutes: i64) -> i64 {
    r.start_at - lead_minutes.max(0) * 60
}

/// Decisions for `input.now`.
pub fn plan(input: &PlanInput<'_>) -> Vec<Action> {
    let now = input.now;
    let mut out = Vec::new();
    for r in input.reminders {
        if r.end_at <= now {
            out.push(Action::PurgeReminder(r.id.clone()));
            continue;
        }
        if r.status != ReminderStatus::Pending {
            continue;
        }
        let late = now > r.start_at + REMINDER_LATE_GRACE;
        if !input.reminders_enabled {
            if late {
                out.push(Action::MissReminder(r.id.clone()));
            }
        } else if now >= fire_at(r, input.lead_minutes) {
            out.push(if late {
                Action::MissReminder(r.id.clone())
            } else {
                Action::FireReminder(r.id.clone())
            });
        }
    }
    for r in input.recordings {
        match r.status {
            RecordingStatus::Scheduled => {
                if now >= r.effective_end() {
                    out.push(Action::MissRecording(r.id.clone()));
                } else if now >= r.effective_start() {
                    out.push(Action::StartRecording(r.id.clone()));
                }
            }
            RecordingStatus::Recording => {
                let running = input.active.contains(&r.id);
                if running && now >= r.effective_end() {
                    out.push(Action::StopRecording(r.id.clone()));
                } else if !running {
                    out.push(if now < r.effective_end() {
                        Action::ResumeRecording(r.id.clone())
                    } else {
                        Action::CloseRecording(r.id.clone())
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// Decisions taken once at launch, before the first [`plan`]: recordings
/// whose whole (padded) slot passed while the app was not running are
/// missed. One still airing is left to [`plan`], which starts it late and
/// records the rest.
pub fn launch_plan(now: i64, recordings: &[RecordingRow]) -> Vec<Action> {
    recordings
        .iter()
        .filter(|r| r.status == RecordingStatus::Scheduled && now >= r.effective_end())
        .map(|r| Action::MissRecording(r.id.clone()))
        .collect()
}

/// The next time after `now` at which [`plan`] would decide something.
pub fn next_wake(input: &PlanInput<'_>) -> Option<i64> {
    let now = input.now;
    let mut times = Vec::new();
    for r in input.reminders {
        times.push(r.end_at);
        if r.status == ReminderStatus::Pending {
            if input.reminders_enabled {
                times.push(fire_at(r, input.lead_minutes));
            }
            times.push(r.start_at + REMINDER_LATE_GRACE + 1);
        }
    }
    for r in input.recordings {
        match r.status {
            RecordingStatus::Scheduled => {
                times.push(r.effective_start());
                times.push(r.effective_end());
            }
            RecordingStatus::Recording => times.push(r.effective_end()),
            _ => {}
        }
    }
    times.into_iter().filter(|t| *t > now).min()
}

/// Title comparison key: lowercase letters and digits only.
pub fn title_key(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// A guide programme as `(start, end, title)` in display time.
pub type Slot<'a> = (i64, i64, &'a str);

/// Finds `title` again among `candidates` after a guide refresh: the slot
/// with the same title whose start is closest to `start`, within
/// [`REMATCH_WINDOW`]. Returns its times when they differ from the stored ones.
pub fn rematch(start: i64, end: i64, title: &str, candidates: &[Slot<'_>]) -> Option<(i64, i64)> {
    let key = title_key(title);
    if key.is_empty() {
        return None;
    }
    let best = candidates
        .iter()
        .filter(|(s, e, t)| e > s && (s - start).abs() <= REMATCH_WINDOW && title_key(t) == key)
        .min_by_key(|(s, _, _)| (s - start).abs())?;
    ((best.0, best.1) != (start, end)).then_some((best.0, best.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ContentType, ItemRef};
    use crate::recording::RecordingKind;

    const T0: i64 = 1_800_000_000;

    fn reminder(id: &str, start: i64, end: i64, status: ReminderStatus) -> ReminderRow {
        ReminderRow {
            id: id.into(),
            item_ref: ItemRef::new("s", ContentType::Live, "1"),
            channel_name: "C".into(),
            title: "News".into(),
            start_at: start,
            end_at: end,
            status,
            fired_at: None,
            created_at: T0 - 1000,
        }
    }

    fn recording(id: &str, start: i64, end: i64, status: RecordingStatus) -> RecordingRow {
        RecordingRow {
            id: id.into(),
            item_ref: ItemRef::new("s", ContentType::Live, "1"),
            channel_name: "C".into(),
            title: Some("News".into()),
            kind: RecordingKind::Programme,
            start_at: start,
            end_at: end,
            padding_before: 1,
            padding_after: 5,
            status,
            error_message: None,
            parts: Vec::new(),
            bytes: 0,
            started_at: None,
            ended_at: None,
            engine: None,
            created_at: T0 - 1000,
            rule_id: None,
        }
    }

    fn run(
        now: i64,
        enabled: bool,
        reminders: &[ReminderRow],
        recordings: &[RecordingRow],
        active: &[&str],
    ) -> Vec<Action> {
        let active: HashSet<String> = active.iter().map(|s| s.to_string()).collect();
        plan(&PlanInput {
            now,
            reminders_enabled: enabled,
            lead_minutes: 2,
            reminders,
            recordings,
            active: &active,
        })
    }

    #[test]
    fn padding_moves_start_and_end() {
        let r = recording("a", T0, T0 + 3600, RecordingStatus::Scheduled);
        assert_eq!(r.effective_start(), T0 - 60);
        assert_eq!(r.effective_end(), T0 + 3600 + 300);
        let rs = [r];
        assert!(run(T0 - 61, true, &[], &rs, &[]).is_empty());
        assert_eq!(
            run(T0 - 60, true, &[], &rs, &[]),
            vec![Action::StartRecording("a".into())]
        );
    }

    #[test]
    fn recording_states_follow_the_clock() {
        let scheduled = [recording("a", T0, T0 + 600, RecordingStatus::Scheduled)];
        // Past its padded end without ever starting: missed.
        assert_eq!(
            run(T0 + 900, true, &[], &scheduled, &[]),
            vec![Action::MissRecording("a".into())]
        );
        let recording_row = [recording("a", T0, T0 + 600, RecordingStatus::Recording)];
        assert!(run(T0 + 100, true, &[], &recording_row, &["a"]).is_empty());
        assert_eq!(
            run(T0 + 900, true, &[], &recording_row, &["a"]),
            vec![Action::StopRecording("a".into())]
        );
        // No engine behind a `recording` row (crash): resume or close.
        assert_eq!(
            run(T0 + 100, true, &[], &recording_row, &[]),
            vec![Action::ResumeRecording("a".into())]
        );
        assert_eq!(
            run(T0 + 900, true, &[], &recording_row, &[]),
            vec![Action::CloseRecording("a".into())]
        );
        for done in [
            RecordingStatus::Completed,
            RecordingStatus::Failed,
            RecordingStatus::Missed,
            RecordingStatus::Cancelled,
        ] {
            assert!(run(
                T0 + 100,
                true,
                &[],
                &[recording("a", T0, T0 + 600, done)],
                &[]
            )
            .is_empty());
        }
    }

    #[test]
    fn launch_misses_only_slots_that_are_over() {
        let rows = [
            recording("over", T0 - 7200, T0 - 3600, RecordingStatus::Scheduled),
            recording("airing", T0 - 3600, T0 + 3600, RecordingStatus::Scheduled),
            recording("later", T0 + 7200, T0 + 9000, RecordingStatus::Scheduled),
            recording("done", T0 - 9000, T0 - 7200, RecordingStatus::Completed),
        ];
        assert_eq!(
            launch_plan(T0, &rows),
            vec![Action::MissRecording("over".into())]
        );
        // A programme still on air (crash or reboot just before it began)
        // starts late at the first plan instead of being missed.
        assert_eq!(
            run(T0, true, &[], &rows[1..2], &[]),
            vec![Action::StartRecording("airing".into())]
        );
    }

    #[test]
    fn reminder_fires_at_lead_time_and_only_once() {
        let pending = [reminder("r", T0, T0 + 1800, ReminderStatus::Pending)];
        assert!(run(T0 - 121, true, &pending, &[], &[]).is_empty());
        assert_eq!(
            run(T0 - 120, true, &pending, &[], &[]),
            vec![Action::FireReminder("r".into())]
        );
        let fired = [reminder("r", T0, T0 + 1800, ReminderStatus::Fired)];
        assert!(run(T0, true, &fired, &[], &[]).is_empty());
    }

    #[test]
    fn late_reminders_are_missed_and_disabled_ones_never_fire() {
        let pending = [reminder("r", T0, T0 + 1800, ReminderStatus::Pending)];
        assert_eq!(
            run(T0 + REMINDER_LATE_GRACE, true, &pending, &[], &[]),
            vec![Action::FireReminder("r".into())]
        );
        assert_eq!(
            run(T0 + REMINDER_LATE_GRACE + 1, true, &pending, &[], &[]),
            vec![Action::MissReminder("r".into())]
        );
        assert!(run(T0 - 60, false, &pending, &[], &[]).is_empty());
        assert_eq!(
            run(T0 + REMINDER_LATE_GRACE + 1, false, &pending, &[], &[]),
            vec![Action::MissReminder("r".into())]
        );
    }

    #[test]
    fn ended_programmes_purge_their_reminders() {
        let rows = [
            reminder("p", T0 - 3600, T0, ReminderStatus::Pending),
            reminder("f", T0 - 3600, T0, ReminderStatus::Fired),
            reminder("m", T0 - 3600, T0 - 1, ReminderStatus::Missed),
            reminder("keep", T0 - 60, T0 + 60, ReminderStatus::Fired),
        ];
        assert_eq!(
            run(T0, true, &rows, &[], &[]),
            vec![
                Action::PurgeReminder("p".into()),
                Action::PurgeReminder("f".into()),
                Action::PurgeReminder("m".into()),
            ]
        );
    }

    #[test]
    fn next_wake_is_the_earliest_future_event() {
        let reminders = [reminder("r", T0 + 600, T0 + 1200, ReminderStatus::Pending)];
        let recordings = [recording(
            "a",
            T0 + 300,
            T0 + 900,
            RecordingStatus::Scheduled,
        )];
        let active = HashSet::new();
        let input = PlanInput {
            now: T0,
            reminders_enabled: true,
            lead_minutes: 2,
            reminders: &reminders,
            recordings: &recordings,
            active: &active,
        };
        // Recording start (T0 + 300 - 60) beats the reminder (T0 + 600 - 120).
        assert_eq!(next_wake(&input), Some(T0 + 240));
        let empty = PlanInput {
            reminders: &[],
            recordings: &[],
            ..input
        };
        assert_eq!(next_wake(&empty), None);
    }

    #[test]
    fn rematch_follows_a_rescheduled_programme() {
        let guide = [
            (T0 - 7200, T0 - 3600, "The News"),
            (T0 + 900, T0 + 2700, "the news!"),
            (T0 + 5 * 3600, T0 + 6 * 3600, "The News"),
            (T0, T0 + 900, "Weather"),
        ];
        assert_eq!(
            rematch(T0, T0 + 1800, "The News", &guide),
            Some((T0 + 900, T0 + 2700))
        );
        // Unchanged times, other titles and far-away slots are not matches.
        assert_eq!(rematch(T0 + 900, T0 + 2700, "The News", &guide), None);
        assert_eq!(rematch(T0, T0 + 1800, "Sport", &guide), None);
        assert_eq!(
            rematch(T0 + 12 * 3600, T0 + 13 * 3600, "Weather", &guide),
            None
        );
        assert_eq!(rematch(T0, T0 + 1800, "   ", &guide), None);
    }

    #[test]
    fn manual_clock_moves() {
        let c = ManualClock::new(T0);
        c.advance(30);
        assert_eq!(c.now(), T0 + 30);
        c.set(5);
        assert_eq!(c.now(), 5);
    }
}
