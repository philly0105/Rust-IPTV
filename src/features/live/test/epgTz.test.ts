/**
 * Guide time maths on a pinned clock and pinned time zones: midnight, DST in both directions,
 * a midnight that does not exist, :30 and :45 viewer offsets, and provider offsets in programme times.
 * Node re-reads `process.env.TZ` on assignment, so each case runs in its own zone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultStart, slotLabels } from '../components/EpgGridPage';
import { nowNextFrom } from '../lib/epgMerge';
import {
  HOUR,
  MINUTE,
  addLocalDays,
  floorLocal,
  formatClock,
  formatDay,
  isValidProgram,
  layoutBlocks,
  localDayKey,
  localHourTicks,
  minutesLeft,
  ms,
  programProgress,
  programWhen,
} from '../lib/epgTime';

const ORIGINAL_TZ = process.env.TZ;
function zone(tz: string) {
  process.env.TZ = tz;
}
beforeEach(() => zone('UTC'));
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const local = (d: Date) => ({ h: d.getHours(), m: d.getMinutes(), day: d.getDate() });
const at = (t: number) => local(new Date(t));
const prog = (title: string, start: string, end: string) => ({ channelId: 'c', title, start, end });

describe('provider time offsets in programme times', () => {
  it('reads +05:45, +0545, -03:30, +14:00 and XMLTV compact times as the same instants', () => {
    const utc = Date.UTC(2026, 9, 12, 4, 15);
    expect(ms('2026-10-12T10:00:00+05:45')).toBe(utc);
    expect(ms('2026-10-12T10:00:00+0545')).toBe(utc);
    expect(ms('20261012100000 +0545')).toBe(utc);
    expect(ms('20261012100000+0545')).toBe(utc);
    expect(ms('2026-10-12T00:45:00-03:30')).toBe(utc);
    expect(ms('2026-10-12T18:15:00+14:00')).toBe(utc);
    // XMLTV with no offset is UTC.
    expect(ms('20261012041500')).toBe(utc);
  });

  it('treats unreadable times as invalid instead of "airing since 1970"', () => {
    const now = Date.UTC(2026, 9, 12, 12);
    const broken = prog('Broken', 'not a date', '2026-10-12T13:00:00Z');
    expect(isValidProgram(broken)).toBe(false);
    expect(isValidProgram(prog('Empty', '', ''))).toBe(false);
    expect(isValidProgram(prog('Inverted', '2026-10-12T13:00:00Z', '2026-10-12T12:00:00Z'))).toBe(false);
    // nowNextFrom and layout skip it rather than calling it airing.
    expect(nowNextFrom([broken], now)).toBeUndefined();
    expect(layoutBlocks([broken], now - HOUR, now + HOUR, 4, now)).toEqual([]);
  });

  it('a mixed-offset schedule picks the right airing programme', () => {
    // Same provider, entries written in +0545 and in UTC: they must chain, not overlap.
    const list = [prog('Morning', '20261012090000 +0545', '20261012100000 +0545'), prog('News', '2026-10-12T04:15:00Z', '2026-10-12T05:15:00Z')];
    const nn = nowNextFrom(list, Date.UTC(2026, 9, 12, 4, 30));
    expect(nn?.now?.title).toBe('News');
    expect(nn?.next).toBeUndefined();
  });
});

describe('now/next across midnight', () => {
  it('a programme spanning midnight is airing on both sides, with the right progress and time left', () => {
    zone('Europe/Berlin');
    const start = new Date(2026, 9, 12, 23, 30).getTime();
    const end = new Date(2026, 9, 13, 0, 30).getTime();
    const p = prog('Late show', new Date(start).toISOString(), new Date(end).toISOString());
    const beforeMidnight = new Date(2026, 9, 12, 23, 50).getTime();
    const afterMidnight = new Date(2026, 9, 13, 0, 10).getTime();
    expect(programWhen(p, beforeMidnight)).toBe('now');
    expect(programWhen(p, afterMidnight)).toBe('now');
    expect(minutesLeft(p, afterMidnight)).toBe(20);
    expect(programProgress(p, afterMidnight)).toBeCloseTo(40 / 60, 5);
    expect(localDayKey(start)).not.toBe(localDayKey(end));
  });
});

describe('DST', () => {
  it('a programme across the spring-forward jump lasts its real hour, not two', () => {
    zone('Europe/London');
    // 00:30 GMT to 02:30 BST on 29 Mar 2026 is one real hour (01:00 GMT does not exist as 01:00).
    const p = prog('Overnight', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z');
    const now = Date.UTC(2026, 2, 29, 1, 0);
    expect(minutesLeft(p, now)).toBe(30);
    expect(programProgress(p, now)).toBeCloseTo(0.5, 5);
    expect(at(ms(p.start))).toMatchObject({ h: 0, m: 30 });
    expect(at(ms(p.end))).toMatchObject({ h: 2, m: 30 });
  });

  it('next day keeps the wall-clock time across both DST changes', () => {
    zone('Europe/London');
    const sat = new Date(2026, 2, 28, 20, 0).getTime();
    const sun = addLocalDays(sat, 1);
    expect(at(sun)).toMatchObject({ h: 20, m: 0, day: 29 });
    expect(sun - sat).toBe(23 * HOUR);
    const autumn = new Date(2026, 9, 24, 20, 0).getTime();
    const next = addLocalDays(autumn, 1);
    expect(at(next)).toMatchObject({ h: 20, m: 0, day: 25 });
    expect(next - autumn).toBe(25 * HOUR);
    expect(at(addLocalDays(next, -1))).toMatchObject({ h: 20, day: 24 });
  });

  it('flooring in the repeated autumn hour stays in the same hour, never an hour back', () => {
    zone('Europe/London');
    // 01:40 GMT on 25 Oct 2026 is the second 01:40 of the night.
    const t = Date.UTC(2026, 9, 25, 1, 40);
    const f = floorLocal(t, 30);
    expect(t - f).toBe(10 * MINUTE);
  });

  it('ribbon ticks are whole local hours through both changes, one per real hour', () => {
    zone('Europe/London');
    const spring = localHourTicks(Date.UTC(2026, 2, 28, 22), Date.UTC(2026, 2, 29, 4));
    for (const t of spring) expect(new Date(t).getMinutes()).toBe(0);
    expect(new Set(spring).size).toBe(spring.length);
    for (let i = 1; i < spring.length; i++) expect(spring[i]! - spring[i - 1]!).toBe(HOUR);
    const autumn = localHourTicks(Date.UTC(2026, 9, 24, 22), Date.UTC(2026, 9, 25, 4));
    expect(autumn.map((t) => new Date(t).getHours())).toEqual([0, 1, 1, 2, 3]);
  });

  it('the guide labels the day even when local midnight does not exist (Chile springs 00:00 -> 01:00)', () => {
    zone('America/Santiago');
    const start = new Date(2026, 8, 5, 23, 0).getTime();
    const slots = [0, 1, 2, 3].map((i) => start + i * 30 * MINUTE);
    expect(at(slots[2]!)).toMatchObject({ h: 1, m: 0, day: 6 });
    const labels = slotLabels(slots, 'en');
    expect(labels[2]).toBe(formatDay(slots[2]!, 'en'));
    expect(labels.filter((l, i) => l === formatDay(slots[i]!, 'en'))).toHaveLength(1);
  });
});

describe('viewers in :30 and :45 time zones', () => {
  it('the /epg grid opens on local :00/:30 columns in Nepal (+5:45), not on :15/:45', () => {
    zone('Asia/Kathmandu');
    const now = Date.UTC(2026, 9, 12, 5, 7); // 10:52 local
    const start = defaultStart(now);
    expect(at(start)).toMatchObject({ h: 10, m: 0 });
    expect(start).toBeLessThanOrEqual(now);
    expect(formatClock(start, 'en-GB')).toBe('10:00');
  });

  it('ribbon ticks fall on local hours in India (+5:30), and the day label sits on 00:00, not 00:30', () => {
    zone('Asia/Kolkata');
    const from = new Date(2026, 9, 12, 21, 10).getTime();
    const ticks = localHourTicks(from, from + 6 * HOUR);
    expect(ticks.length).toBe(6);
    for (const t of ticks) expect(new Date(t).getMinutes()).toBe(0);
    const dayChange = ticks.findIndex((t, i) => localDayKey(t) !== localDayKey(i > 0 ? ticks[i - 1]! : from));
    expect(at(ticks[dayChange]!)).toMatchObject({ h: 0, m: 0, day: 13 });
  });

  it('the grid labels midnight with the day in Nepal', () => {
    zone('Asia/Kathmandu');
    const start = new Date(2026, 9, 12, 23, 0).getTime();
    const slots = [0, 1, 2, 3].map((i) => start + i * 30 * MINUTE);
    const labels = slotLabels(slots, 'en');
    expect(labels[2]).toBe(formatDay(slots[2]!, 'en'));
    expect(labels[0]).toBe(formatClock(slots[0]!, 'en'));
  });
});
