// Pure helpers of the stats page: duration and date formatting through Intl,
// the chart scale, axis label spacing, and the range parameter.
import { describe, expect, it } from 'vitest';

import type { WatchStatsDay } from '@/api/types';

import { barPercent, chartScale, labelsFit, rangeTotals, showDayLabel } from '../lib/chart';
import { formatAxisHours, formatAxisMinutes, formatWatchTime, intlLocale, longDayLabel, narrowWeekdayLabel, parseDay, weekdayLabel } from '../lib/format';
import { readRange } from '../paths';

const day = (seconds: number, live = seconds): WatchStatsDay => ({ day: '2026-10-13', seconds, liveSeconds: live, vodSeconds: seconds - live });

describe('formatWatchTime', () => {
  it('reads hours and minutes, leaving out zero parts', () => {
    expect(formatWatchTime(0, 'en')).toBe('0 min');
    expect(formatWatchTime(40, 'en')).toBe('40 sec');
    expect(formatWatchTime(2700, 'en')).toBe('45 min');
    expect(formatWatchTime(7200, 'en')).toBe('2 hr');
    expect(formatWatchTime(12_000, 'en')).toBe('3 hr 20 min');
    // 59 min 50 s rounds to the hour, not "0 hr 60 min".
    expect(formatWatchTime(3590, 'en')).toBe('1 hr');
    expect(formatWatchTime(-5, 'en')).toBe('0 min');
  });

  it('uses the locale’s own unit words', () => {
    const hr = new Intl.NumberFormat('de', { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(3);
    const min = new Intl.NumberFormat('de', { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(20);
    expect(formatWatchTime(12_000, 'de')).toBe(`${hr} ${min}`);
    expect(formatWatchTime(12_000, 'en', { display: 'long' })).toBe('3 hours 20 minutes');
  });

  it('formats axis ticks', () => {
    expect(formatAxisMinutes(1800, 'en')).toBe(new Intl.NumberFormat('en', { style: 'unit', unit: 'minute', unitDisplay: 'narrow' }).format(30));
    expect(formatAxisHours(5400, 'en')).toBe(new Intl.NumberFormat('en', { style: 'unit', unit: 'hour', unitDisplay: 'narrow' }).format(1.5));
  });
});

describe('intlLocale', () => {
  it('maps app language codes to tags Intl knows', () => {
    expect(intlLocale('en')).toBe('en');
    expect(intlLocale('de-AT')).toBe('de-AT');
    expect(intlLocale('be')).toBe('be');
    expect(intlLocale('by')).toBe('be');
    expect(intlLocale('zhtw')).toBe('zh-TW');
    expect(intlLocale('zh-CN')).toBe('zh-CN');
    expect(['ary', 'ar']).toContain(intlLocale('ary'));
    expect(intlLocale(undefined)).toBe('en');
    expect(intlLocale('')).toBe('en');
  });
});

describe('dates', () => {
  it('parses a day as local noon and labels it', () => {
    const d = parseDay('2026-10-13');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 13, 12]);
    expect(weekdayLabel('2026-10-13', 'en')).toBe('Tue');
    expect(longDayLabel('2026-10-13', 'en')).toBe('Tuesday, October 13');
  });

  it('has a narrow weekday for tight axes, also for Arabic, whose short names are words', () => {
    expect(narrowWeekdayLabel('2026-10-13', 'en')).toBe('T');
    const ar = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ar', o).format(parseDay('2026-10-14'));
    expect(weekdayLabel('2026-10-14', 'ar')).toBe(ar({ weekday: 'short' }));
    expect(narrowWeekdayLabel('2026-10-14', 'ar')).toBe(ar({ weekday: 'narrow' }));
    expect(narrowWeekdayLabel('2026-10-14', 'ary')).toBe(narrowWeekdayLabel('2026-10-14', intlLocale('ary')));
    expect(Array.from(narrowWeekdayLabel('2026-10-14', 'ar')).length).toBeLessThan(Array.from(weekdayLabel('2026-10-14', 'ar')).length);
  });
});

describe('chart', () => {
  it('gives an empty range one hour of headroom', () => {
    expect(chartScale([day(0), day(0)])).toEqual({ top: 3600, ticks: [1800, 3600] });
  });

  it('picks the smallest step that fits in four gridlines', () => {
    expect(chartScale([day(100)])).toEqual({ top: 900, ticks: [900] });
    expect(chartScale([day(600), day(2000)])).toEqual({ top: 2700, ticks: [900, 1800, 2700] });
    expect(chartScale([day(7200)])).toEqual({ top: 7200, ticks: [1800, 3600, 5400, 7200] });
    expect(chartScale([day(7300)])).toEqual({ top: 10_800, ticks: [3600, 7200, 10_800] });
    expect(chartScale([day(86_400)])).toEqual({ top: 86_400, ticks: [21_600, 43_200, 64_800, 86_400] });
  });

  it('keeps a minute visible and caps at the top', () => {
    expect(barPercent(0, 3600)).toBe(0);
    expect(barPercent(10, 3600)).toBe(2);
    expect(barPercent(1800, 3600)).toBe(50);
    expect(barPercent(9000, 3600)).toBe(100);
  });

  it('labels every day of a week and every 7th day back from today in a month', () => {
    expect(Array.from({ length: 7 }, (_, i) => showDayLabel(i, 7)).every(Boolean)).toBe(true);
    const shown = Array.from({ length: 30 }, (_, i) => i).filter((i) => showDayLabel(i, 30));
    expect(shown).toEqual([1, 8, 15, 22, 29]);
  });

  it('checks whether the widest label fits a column, gaps taken out', () => {
    // 7 columns in 264 px with 2 px gaps: (264 - 12) / 7 = 36 px each.
    expect(labelsFit(264, 2, 7, 36)).toBe(true);
    expect(labelsFit(264, 2, 7, 36.5)).toBe(false);
    expect(labelsFit(264, 0, 7, 37)).toBe(true);
    // Not laid out yet: keep the short names.
    expect(labelsFit(0, 2, 7, 80)).toBe(true);
    expect(labelsFit(264, 2, 0, 80)).toBe(true);
  });

  it('sums the live and VOD split', () => {
    expect(rangeTotals([day(100, 40), day(50, 50)])).toEqual({ live: 90, vod: 60 });
  });
});

describe('readRange', () => {
  it('accepts 30 and defaults to 7', () => {
    expect(readRange('30')).toBe(30);
    expect(readRange('7')).toBe(7);
    expect(readRange(null)).toBe(7);
    expect(readRange('14')).toBe(7);
  });
});
