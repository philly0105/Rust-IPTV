import { describe, expect, it, vi } from 'vitest';

import type { ItemRef, PlayerSource, Recording, Reminder, ReminderFiredEvent } from '@/api/types';

import { FIRE_TOAST_MS, claimFiring, handleReminderFired, type FireDeps, type FireText } from '../lib/fire';
import {
  airingLabel,
  buildScheduleIndex,
  clockDuration,
  clockTime,
  dayLabel,
  elapsedSeconds,
  finishedRecordings,
  groupByDay,
  markFor,
  programOptions,
  recordingFraction,
  recordingNow,
  recordingStartedAt,
  slotKey,
  stoppedEarly,
  upcoming,
} from '../lib/schedule';

const ref: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '7' };
const other: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '8' };
const T0 = Date.parse('2026-10-12T18:00:00Z');
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

function reminder(over: Partial<Reminder> = {}): Reminder {
  return { id: 'm1', ref, channelName: 'Alpha', title: 'News', start: iso(30), end: iso(60), status: 'pending', ...over };
}

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'r1',
    ref,
    channelName: 'Alpha',
    title: 'Film',
    kind: 'programme',
    start: iso(60),
    end: iso(120),
    paddingBeforeMinutes: 1,
    paddingAfterMinutes: 5,
    status: 'scheduled',
    fileNames: [],
    bytes: 0,
    ...over,
  };
}

describe('schedule index', () => {
  it('marks the programme a pending reminder or active recording belongs to', () => {
    const index = buildScheduleIndex(
      [reminder(), reminder({ id: 'm2', start: iso(90), status: 'fired' })],
      [recording(), recording({ id: 'r2', start: iso(200), status: 'cancelled' })],
    );
    expect(markFor(index, ref, { start: iso(30) }).reminder?.id).toBe('m1');
    expect(markFor(index, ref, { start: iso(90) })).toEqual({ reminder: undefined, recording: undefined });
    expect(markFor(index, ref, { start: iso(60) }).recording?.id).toBe('r1');
    expect(markFor(index, ref, { start: iso(200) }).recording).toBeUndefined();
    expect(markFor(index, other, { start: iso(30) }).reminder).toBeUndefined();
    expect(markFor(index, undefined, { start: iso(30) })).toEqual({});
  });

  it('matches programmes by instant, not by ISO spelling', () => {
    expect(slotKey(ref, '2026-10-12T20:00:00+02:00')).toBe(slotKey(ref, '2026-10-12T18:00:00.000Z'));
  });

  it('tracks channels that are writing now, including channel recordings', () => {
    const index = buildScheduleIndex([], [recording({ kind: 'channel', status: 'recording' }), recording({ id: 'r3', ref: other })]);
    expect(index.recordingChannels.get('s1|live|7')?.id).toBe('r1');
    expect(index.recordingChannels.has('s1|live|8')).toBe(false);
    expect(index.recordings.size).toBe(1);
  });
});

describe('programOptions', () => {
  it('offers a reminder only before the start and recording until the end', () => {
    expect(programOptions({ start: iso(10), end: iso(40) }, T0)).toEqual({ remind: true, record: true });
    expect(programOptions({ start: iso(-10), end: iso(40) }, T0)).toEqual({ remind: false, record: true });
    expect(programOptions({ start: iso(-60), end: iso(-1) }, T0)).toEqual({ remind: false, record: false });
    expect(programOptions({ start: iso(10), end: iso(10) }, T0)).toEqual({ remind: true, record: false });
  });
});

describe('Scheduled page helpers', () => {
  it('lists pending reminders and waiting recordings soonest first', () => {
    const list = upcoming(
      [reminder({ id: 'late', start: iso(500) }), reminder({ id: 'gone', status: 'missed' }), reminder({ id: 'tie', start: iso(60) })],
      [recording(), recording({ id: 'busy', status: 'recording' })],
    );
    expect(list.map((e) => `${e.type}:${e.id}`)).toEqual(['recording:r1', 'reminder:tie', 'reminder:late']);
  });

  it('splits running and finished recordings', () => {
    const recs = [
      recording({ id: 'a', status: 'recording', start: iso(10) }),
      recording({ id: 'b', status: 'recording', start: iso(5) }),
      recording({ id: 'c', status: 'completed', end: iso(-100) }),
      recording({ id: 'd', status: 'failed', end: iso(-200), endedAt: iso(-10) }),
      recording({ id: 'e', status: 'missed', end: iso(-50) }),
    ];
    expect(recordingNow(recs).map((r) => r.id)).toEqual(['b', 'a']);
    expect(finishedRecordings(recs).map((r) => r.id)).toEqual(['d', 'e', 'c']);
  });

  it('groups by local day and keeps order', () => {
    const day = new Date(2026, 9, 12, 9).getTime();
    const groups = groupByDay([{ at: day }, { at: day + 3_600_000 }, { at: day + 86_400_000 }]);
    expect(groups.map((g) => g.entries.length)).toEqual([2, 1]);
    expect(groups[0]?.day).toBe(new Date(2026, 9, 12).getTime());
  });

  it('measures progress over the padded window', () => {
    const r = recording({ start: iso(0), end: iso(54), paddingBeforeMinutes: 1, paddingAfterMinutes: 5 });
    expect(recordingFraction(r, T0 - 60_000)).toBe(0);
    expect(recordingFraction(r, T0 + 29 * 60_000)).toBeCloseTo(0.5);
    expect(recordingFraction(r, T0 + 600 * 60_000)).toBe(1);
    expect(recordingFraction(recording({ start: iso(0), end: iso(0), paddingBeforeMinutes: 0, paddingAfterMinutes: 0 }), T0)).toBe(0);
  });

  it('measures a programme joined part-way from when the recording began', () => {
    // 60-minute programme, joined 30 minutes in: the bar starts empty, in step with the elapsed clock.
    const r = recording({ status: 'recording', start: iso(-30), end: iso(30), paddingBeforeMinutes: 0, paddingAfterMinutes: 0, startedAt: iso(0) });
    expect(recordingStartedAt(r)).toBe(T0);
    expect(recordingFraction(r, T0)).toBe(0);
    expect(recordingFraction(r, T0 + 15 * 60_000)).toBeCloseTo(0.5);
    expect(recordingStartedAt(recording({ start: iso(0), paddingBeforeMinutes: 1 }))).toBe(T0 - 60_000);
  });

  it('flags a completed recording that ended well before its padded end', () => {
    const base = { start: iso(-60), end: iso(0), paddingAfterMinutes: 5 };
    expect(stoppedEarly(recording({ ...base, status: 'completed', endedAt: iso(-20) }))).toBe(true);
    expect(stoppedEarly(recording({ ...base, status: 'completed', endedAt: iso(5) }))).toBe(false);
    // Within a minute of the end counts as a full recording.
    expect(stoppedEarly(recording({ ...base, status: 'completed', endedAt: iso(4.5) }))).toBe(false);
    expect(stoppedEarly(recording({ ...base, status: 'completed' }))).toBe(false);
    expect(stoppedEarly(recording({ ...base, status: 'failed', endedAt: iso(-20) }))).toBe(false);
  });

  it('prefers the engine-reported elapsed time', () => {
    expect(elapsedSeconds({ startedAt: iso(0) }, T0 + 90_500)).toBe(90);
    expect(elapsedSeconds({ startedAt: iso(0) }, T0 + 90_500, 42)).toBe(42);
    expect(elapsedSeconds({}, T0)).toBe(0);
  });

  it('formats a clock', () => {
    expect(clockDuration(0)).toBe('0:00');
    expect(clockDuration(65)).toBe('1:05');
    expect(clockDuration(3723.9)).toBe('1:02:03');
    expect(clockDuration(-5)).toBe('0:00');
  });
});

describe('handleReminderFired', () => {
  const text: FireText = { title: 'Starting soon: News', body: 'Alpha at 18:30', watchNow: 'Watch now', switched: 'Switched', undo: 'Undo', switchFailed: 'Failed' };
  const previous = { url: 'http://x/prev.ts' } as PlayerSource;

  function deps(over: Partial<FireDeps> = {}): FireDeps & { toasts: Parameters<FireDeps['toast']>[0][] } {
    const toasts: Parameters<FireDeps['toast']>[0][] = [];
    return {
      toasts,
      isDesktop: () => true,
      nativeNotify: vi.fn(async () => undefined),
      browserPermission: () => 'default',
      browserNotify: vi.fn(),
      toast: (o) => void toasts.push(o),
      sourceKind: vi.fn(async () => 'xtream' as const),
      currentSource: () => previous,
      tune: vi.fn(async () => undefined),
      restore: vi.fn(),
      ...over,
    };
  }
  const event = (action: ReminderFiredEvent['action']): ReminderFiredEvent => ({ reminder: reminder(), action });

  it('notify on the desktop: native notification plus a Watch now toast', async () => {
    const d = deps();
    await handleReminderFired(event('notify'), text, d);
    expect(d.nativeNotify).toHaveBeenCalledWith(text.title, text.body);
    expect(d.browserNotify).not.toHaveBeenCalled();
    expect(d.tune).not.toHaveBeenCalled();
    expect(d.toasts).toHaveLength(1);
    expect(d.toasts[0]).toMatchObject({ title: text.title, description: text.body, duration: FIRE_TOAST_MS });
    d.toasts[0]?.action?.onClick();
    await vi.waitFor(() => expect(d.tune).toHaveBeenCalledWith({ ref, title: 'Alpha', subtitle: 'News', sourceKind: 'xtream' }));
  });

  it('a failing native notification still shows the toast', async () => {
    const d = deps({ nativeNotify: vi.fn(async () => Promise.reject(new Error('no aumid'))) });
    await handleReminderFired(event('notify'), text, d);
    expect(d.toasts).toHaveLength(1);
  });

  it('server mode never asks for notification permission', async () => {
    const asked = deps({ isDesktop: () => false, browserPermission: () => 'default' });
    await handleReminderFired(event('notify'), text, asked);
    expect(asked.browserNotify).not.toHaveBeenCalled();
    expect(asked.nativeNotify).not.toHaveBeenCalled();
    expect(asked.toasts).toHaveLength(1);

    const granted = deps({ isDesktop: () => false, browserPermission: () => 'granted' });
    await handleReminderFired(event('notify'), text, granted);
    expect(granted.browserNotify).toHaveBeenCalledWith(text.title, text.body);
  });

  it('switch tunes in and Undo restores what was playing', async () => {
    const d = deps();
    await handleReminderFired(event('switch'), text, d);
    expect(d.tune).toHaveBeenCalledTimes(1);
    expect(d.nativeNotify).not.toHaveBeenCalled();
    expect(d.toasts[0]).toMatchObject({ title: text.switched, description: text.body });
    d.toasts[0]?.action?.onClick();
    expect(d.restore).toHaveBeenCalledWith(previous);
  });

  it('switch reports a source that is gone', async () => {
    const d = deps({ sourceKind: vi.fn(async () => undefined) });
    await handleReminderFired(event('switch'), text, d);
    expect(d.tune).not.toHaveBeenCalled();
    expect(d.toasts).toEqual([{ variant: 'error', title: text.switchFailed, description: text.title }]);
  });
});

describe('claimFiring', () => {
  it('handles a firing once, and a re-armed reminder that fires again', () => {
    const fired = (firedAt: string): ReminderFiredEvent => ({ reminder: reminder({ id: 'claim1' }), action: 'notify', firedAt });
    expect(claimFiring(fired('2026-10-12T18:30:00Z'))).toBe(true);
    // The live event and the mount-time `reminders.unhandled` fetch bring the same firing.
    expect(claimFiring(fired('2026-10-12T18:30:00Z'))).toBe(false);
    expect(claimFiring(fired('2026-10-12T19:30:00Z'))).toBe(true);
  });
});

describe('airingLabel (L2-guide-library-13)', () => {
  // Local times, so the day maths does not depend on the test machine's zone.
  const now = new Date(2026, 9, 16, 1, 0).getTime();
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();

  it('words a series rule\'s next airing the way the Scheduled list does', () => {
    const today = at(16, 2, 45);
    // The list shows the day heading and the row's clock time; the rule's line joins the two.
    expect(airingLabel(today, now, 'en-US')).toBe(`${dayLabel(today, now, 'en-US')} ${clockTime(today, 'en-US')}`);
    expect(airingLabel(today, now, 'en-US')).toBe('today 02:45 AM');
    expect(airingLabel(at(17, 21, 0), now, 'en-US')).toBe('tomorrow 09:00 PM');
  });

  it('names the day in full past tomorrow, as the list heading does', () => {
    const later = at(19, 2, 45);
    expect(dayLabel(later, now, 'en-US')).toBe('Monday, October 19');
    expect(airingLabel(later, now, 'en-US')).toMatch(/^Monday, October 19.*02:45 AM$/);
  });

  it('uses the locale\'s own words for today', () => {
    expect(airingLabel(at(16, 2, 45), now, 'de')).toBe('heute 02:45');
  });
});
