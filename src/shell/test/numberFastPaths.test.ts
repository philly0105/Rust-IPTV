/**
 * English number formatting without an `Intl.NumberFormat` on Home's first commit: the hero's and
 * the new arrivals' ratings (`formatTenths`, `formatRating`) and i18next's `{{count, number}}`
 * (`englishInteger`) write in English exactly what `Intl.NumberFormat('en')` writes, and leave
 * every other language and option to `Intl`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { applyLanguage, englishInteger } from '@/i18n';
import { englishTenths, formatRating, formatTenths } from '@/features/vod/lib/rating';

const tenths = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');

afterEach(async () => {
  await applyLanguage('en');
});

describe('englishTenths', () => {
  it('matches Intl.NumberFormat("en") with one fraction digit, rounding as ICU does', () => {
    const values = [0, 0.04, 0.05, 0.95, 1, 1.15, 1.25, 1.35, 2.45, 6.849999, 7, 7.25, 7.35, 7.5, 8.05, 9.94, 9.95, 9.96, 9.999, 10, 99.95, 123.45, 999.94];
    for (let i = 0; i <= 1000; i++) values.push(i / 100, i / 10 + 0.05);
    for (const v of values) expect(englishTenths(v) ?? tenths.format(v), String(v)).toBe(tenths.format(v));
    expect(englishTenths(1.15)).toBe('1.2');
    expect(englishTenths(9.95)).toBe('10.0');
  });

  it('leaves what it does not cover to Intl', () => {
    expect(englishTenths(-1.5)).toBeUndefined();
    expect(englishTenths(999.95)).toBeUndefined();
    expect(englishTenths(1234.5)).toBeUndefined();
    expect(englishTenths(1e-7)).toBeUndefined();
    expect(englishTenths(Number.NaN)).toBeUndefined();
    expect(formatTenths(-1.5, 'en')).toBe(tenths.format(-1.5));
  });

  it('formats other languages with Intl', () => {
    expect(formatTenths(7.5, 'de')).toBe(new Intl.NumberFormat('de', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(7.5));
    expect(formatRating(7.46, 'de')).toBe('7,5');
    expect(formatRating(7.46, 'en')).toBe('7.5');
    expect(formatRating(7.46)).toBe('7.5');
    expect(formatRating(0)).toBeUndefined();
  });
});

describe('englishInteger', () => {
  it('matches Intl.NumberFormat("en") for whole numbers', () => {
    for (const v of [0, 1, 7, 12, 999, 1000, 1234, 12345, 123456, 1234567, -1, -1000, -1234567, Number.MAX_SAFE_INTEGER, -0]) {
      expect(englishInteger(v, 'en', {}), String(v)).toBe(whole.format(v));
    }
  });

  it('leaves fractions, other languages and number options to Intl', () => {
    expect(englishInteger(1.5, 'en', {})).toBeUndefined();
    expect(englishInteger(1234, 'de', {})).toBeUndefined();
    expect(englishInteger(1234, 'en', { minimumFractionDigits: 2 })).toBeUndefined();
    expect(englishInteger(1234, 'en', { style: 'percent' })).toBeUndefined();
    expect(englishInteger('1234', 'en', {})).toBeUndefined();
  });

  it('is what {{count, number}} gives in English, and Intl in another language', async () => {
    i18n.addResource('en', 'common', 'zzNumberTest', '{{count, number}} titles');
    expect(i18n.t('common:zzNumberTest', { count: 12345 })).toBe('12,345 titles');
    i18n.addResource('de', 'common', 'zzNumberTest', '{{count, number}} Titel');
    await applyLanguage('de');
    expect(i18n.t('common:zzNumberTest', { count: 12345 })).toBe('12.345 Titel');
  });
});
