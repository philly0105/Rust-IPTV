/**
 * Programme times read once and time ranges formatted once (P2-GUIDE-4): a guide row reads each
 * programme's start and end many times per render, and every cell names its range.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatTimeRange, HOUR, MINUTE, ms } from '../../lib/epgTime';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('programme times and ranges (P2-GUIDE-4)', () => {
  it('reads each UTC time once, and a time without a zone (local time) each time', () => {
    const parse = vi.spyOn(Date, 'parse');
    const utc = '2031-02-03T04:05:00Z';
    expect(ms(utc)).toBe(Date.UTC(2031, 1, 3, 4, 5));
    expect(ms(utc)).toBe(Date.UTC(2031, 1, 3, 4, 5));
    expect(parse.mock.calls.filter(([s]) => s === utc)).toHaveLength(1);
    const local = '2031-02-03T04:05:00';
    expect(ms(local)).toBe(new Date(2031, 1, 3, 4, 5).getTime());
    ms(local);
    expect(parse.mock.calls.filter(([s]) => s === local)).toHaveLength(2);
  });

  it('formats each range once per locale', () => {
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const start = Date.UTC(2031, 0, 1, 20);
    const first = formatTimeRange(start, start + 30 * MINUTE, 'en');
    const calls = parts.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(formatTimeRange(start, start + 30 * MINUTE, 'en')).toBe(first);
    expect(parts.mock.calls.length).toBe(calls);
    // Another locale or end is its own range.
    formatTimeRange(start, start + 30 * MINUTE, 'ko');
    expect(parts.mock.calls.length).toBeGreaterThan(calls);
    const ko = parts.mock.calls.length;
    formatTimeRange(start, start + HOUR, 'ko');
    expect(parts.mock.calls.length).toBeGreaterThan(ko);
  });
});
