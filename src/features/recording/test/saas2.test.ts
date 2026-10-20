/**
 * Product redesign, stage 2: the Scheduled page's clock times drop the leading zero where the
 * locale counts 12 hours, a time range says its day period once (and no dates when it runs past
 * midnight), and a day heading carries its date.
 */
import { describe, expect, it } from 'vitest';

import { clockRange, clockTime, dayHeading } from '../lib/schedule';

const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();

describe('clock times on the Scheduled page', () => {
  it('writes 12-hour times without a leading zero and keeps two digits in 24-hour locales', () => {
    expect(clockTime(at(20, 2, 45), 'en-US')).toBe('2:45 AM');
    expect(clockTime(at(20, 2, 45), 'de')).toBe('02:45');
  });

  it('says a range in the locale\'s words, with the day period once', () => {
    const range = clockRange(at(20, 12, 45), at(20, 13, 45), 'en-US');
    expect(range.replace(/\s/g, ' ')).toBe('12:45 – 1:45 PM');
    expect(clockRange(at(20, 13, 45), at(20, 14, 15), 'de')).toMatch(/^13:45\s?–\s?14:15/);
  });

  it('keeps a programme that runs past midnight to two clock times, with no dates', () => {
    // formatRange spells out both dates when the days differ ("10/21/2026, 11:00 PM – 10/22/2026, ...").
    const range = clockRange(at(21, 23, 0), at(22, 0, 0), 'en-US').replace(/\s/g, ' ');
    expect(range).toBe('11:00 PM – 12:00 AM');
    expect(clockRange(at(21, 23, 30), at(22, 0, 30), 'de')).toBe('23:30 – 00:30');
  });

  it('heads today and tomorrow with the date too, a later day with its own name', () => {
    const now = at(20, 9, 0);
    const today = dayHeading(at(20, 0, 0), now, 'en-US');
    expect(today.label).toBe('today');
    expect(today.date).toBe('Tue, Oct 20');
    expect(dayHeading(at(21, 0, 0), now, 'en-US')).toEqual({ label: 'tomorrow', date: 'Wed, Oct 21' });
    expect(dayHeading(at(23, 0, 0), now, 'en-US')).toEqual({ label: 'Friday, October 23' });
  });
});
