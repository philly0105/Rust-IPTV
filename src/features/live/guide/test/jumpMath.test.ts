/**
 * Jump-to-date maths on pinned time zones (Run 2 C5): the day chips are local calendar days
 * (never "now + n x 24 h"), each day's 30-minute slots cover exactly the time that day has
 * (46 on a spring-forward day, 50 on a fall-back day, 47/49 where DST moves 30 minutes, and
 * a day that starts at 01:00 where midnight does not exist), and the `at` URL parameter is
 * read safely. Node re-reads `process.env.TZ` on assignment, so each case runs in its own zone.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  MINUTE,
  atWallTime,
  daySlots,
  floorLocal,
  jumpDays,
  localDayDiff,
  localDayKey,
  localDayStart,
  parseWindowAt,
  wallMinutes,
} from '../../lib/epgTime';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});
const zone = (tz: string) => {
  process.env.TZ = tz;
};
const SLOT = 30 * MINUTE;
const wall = (t: number) => {
  const d = new Date(t);
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), m: d.getMinutes() };
};

describe('jumpDays', () => {
  it.each([
    ['Europe/Berlin', new Date(2026, 9, 24, 23, 40)], // the night before the clocks go back
    ['Europe/Berlin', new Date(2026, 2, 28, 22, 0)], // the night before they go forward
    ['America/New_York', new Date(2026, 10, 1, 0, 30)],
    ['Australia/Lord_Howe', new Date(2026, 9, 3, 12, 0)],
    ['America/Santiago', new Date(2026, 8, 5, 23, 59)],
  ])('%s: 16 local days from two back to 13 ahead, each starting its own calendar day', (tz, local) => {
    zone(tz);
    // Rebuild the instant in the zone under test (the Date above was built before `zone`).
    const now = new Date(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()).getTime();
    const days = jumpDays(now);
    expect(days).toHaveLength(16);
    days.forEach((d, i) => {
      expect(localDayDiff(d, now)).toBe(i - 2);
      expect(localDayStart(d)).toBe(d);
      // The first instant of the day: midnight, or 01:00 where midnight was skipped.
      expect(localDayStart(d - 1)).not.toBe(d);
      expect(wallMinutes(d) % 60).toBe(0);
      expect(wallMinutes(d)).toBeLessThanOrEqual(60);
    });
    expect(new Set(days.map(localDayKey)).size).toBe(16);
    expect(localDayKey(days[2]!)).toBe(localDayKey(now));
  });

  it('crossing a DST change, the chips are 23 or 25 hours apart, not 24', () => {
    zone('Europe/Berlin');
    const days = jumpDays(new Date(2026, 9, 24, 12, 0).getTime());
    const gaps = days.slice(1).map((d, i) => (d - days[i]!) / (60 * MINUTE));
    expect(gaps).toContain(25);
    expect(gaps.filter((g) => g !== 24)).toEqual([25]);
    const spring = jumpDays(new Date(2026, 2, 28, 12, 0).getTime());
    expect(spring.slice(1).map((d, i) => (d - spring[i]!) / (60 * MINUTE)).filter((g) => g !== 24)).toEqual([23]);
  });
});

describe('daySlots', () => {
  it.each([
    ['Europe/Berlin', [2026, 2, 29], 46],
    ['Europe/Berlin', [2026, 9, 25], 50],
    ['Europe/Berlin', [2026, 9, 26], 48],
    ['America/New_York', [2026, 2, 8], 46],
    ['America/New_York', [2026, 10, 1], 50],
    ['Australia/Lord_Howe', [2026, 9, 4], 47],
    ['Australia/Lord_Howe', [2026, 3, 5], 49],
    ['Asia/Kathmandu', [2026, 9, 14], 48],
  ] as const)('%s %j has %i slots', (tz, [y, m, d], count) => {
    zone(tz);
    const slots = daySlots(new Date(y, m, d).getTime());
    expect(slots).toHaveLength(count);
    expect(wall(slots[0]!)).toMatchObject({ h: 0, m: 0 });
    expect(wall(slots.at(-1)!)).toMatchObject({ h: 23, m: 30 });
  });

  it.each(['Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Kathmandu', 'UTC'])(
    '%s: every day of a year is cut into 30-minute instants that fill it exactly',
    (tz) => {
      zone(tz);
      let day = localDayStart(new Date(2026, 0, 1, 12).getTime());
      for (let i = 0; i < 366; i++) {
        const next = new Date(new Date(day).getFullYear(), new Date(day).getMonth(), new Date(day).getDate() + 1).getTime();
        const slots = daySlots(day);
        expect(slots[0]).toBe(day);
        expect(slots.length * SLOT).toBe(next - day);
        for (let k = 1; k < slots.length; k++) expect(slots[k]! - slots[k - 1]!).toBe(SLOT);
        for (const s of slots) {
          expect(localDayKey(s)).toBe(localDayKey(day));
          expect(wallMinutes(s) % 30).toBe(0);
        }
        day = next;
      }
    },
    20_000,
  );

  it('America/Santiago: the day whose midnight is skipped starts at 01:00 and has 46 slots', () => {
    zone('America/Santiago');
    // Chile moves to summer time at midnight on the first Sunday of September.
    const day = localDayStart(new Date(2026, 8, 6, 12).getTime());
    expect(wall(day)).toMatchObject({ d: 6, h: 1, m: 0 });
    const slots = daySlots(day);
    expect(slots).toHaveLength(46);
    expect(wall(slots[0]!)).toMatchObject({ h: 1, m: 0 });
    expect(jumpDays(new Date(2026, 8, 5, 20).getTime())[3]).toBe(day);
  });
});

describe('atWallTime', () => {
  it('Europe/Berlin: a time the spring gap swallowed moves to the next slot that exists', () => {
    zone('Europe/Berlin');
    const day = new Date(2026, 2, 29).getTime();
    expect(wall(atWallTime(day, 2 * 60 + 30))).toMatchObject({ h: 3, m: 0 });
    expect(wall(atWallTime(day, 20 * 60 + 30))).toMatchObject({ d: 29, h: 20, m: 30 });
  });

  it('Europe/Berlin: in the repeated hour it picks the first 02:30 (summer time)', () => {
    zone('Europe/Berlin');
    const day = new Date(2026, 9, 25).getTime();
    const t = atWallTime(day, 2 * 60 + 30);
    expect(wall(t)).toMatchObject({ h: 2, m: 30 });
    expect(new Date(t).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('keeps the wall time when the day changes across DST (19:30 stays 19:30)', () => {
    zone('America/New_York');
    const sat = new Date(2026, 9, 31).getTime();
    const sun = new Date(2026, 10, 1).getTime();
    const a = atWallTime(sat, 19 * 60 + 30);
    const b = atWallTime(sun, wallMinutes(a));
    expect(wall(b)).toMatchObject({ d: 1, h: 19, m: 30 });
    expect(b - a).toBe(25 * 60 * MINUTE);
  });
});

describe('parseWindowAt', () => {
  it('reads epoch ms floored to the local 30-minute slot', () => {
    zone('Asia/Kathmandu'); // +05:45: local :00/:30, not UTC's
    const t = new Date(2026, 9, 14, 20, 47, 13).getTime();
    const at = parseWindowAt(String(t))!;
    expect(wall(at)).toMatchObject({ h: 20, m: 30 });
    expect(at).toBe(floorLocal(t, 30));
  });

  it.each([null, undefined, '', 'abc', '-5', '1.5e12', '12 34', '0x10', '946684799999', '4102444800001', '1'.repeat(16)])('rejects %j', (raw) => {
    zone('UTC');
    expect(parseWindowAt(raw)).toBeNull();
  });

  it('accepts the range ends', () => {
    zone('UTC');
    expect(parseWindowAt(String(Date.UTC(2000, 0, 1)))).toBe(Date.UTC(2000, 0, 1));
    expect(parseWindowAt(String(Date.UTC(2100, 0, 1)))).toBe(Date.UTC(2100, 0, 1));
  });
});
