// The one place app language codes become Intl locales (F-INTL-LOCALE).
import { describe, expect, it } from 'vitest';

import { dateTimeFormat, formatList, intlLocale, listSeparator, numberFormat, relativeTimeFormat } from './intl';

describe('intlLocale', () => {
  it('maps app codes and i18next keys to tags Intl knows', () => {
    expect(intlLocale('ary')).toBe('ar');
    expect(intlLocale('by')).toBe('be');
    expect(intlLocale('be')).toBe('be');
    expect(intlLocale('zhtw')).toBe('zh-TW');
    expect(intlLocale('zh')).toBe('zh-CN');
    expect(intlLocale('zh-TW')).toBe('zh-TW');
    expect(intlLocale('de')).toBe('de');
    expect(intlLocale('pt')).toBe('pt');
  });

  it('falls back to English for nothing or an invalid tag', () => {
    expect(intlLocale(undefined)).toBe('en');
    expect(intlLocale(null)).toBe('en');
    expect(intlLocale('')).toBe('en');
    expect(intlLocale('not a tag')).toBe('en');
  });

  it('formats Moroccan Arabic numbers as Arabic, not in the machine locale', () => {
    expect(new Intl.NumberFormat(intlLocale('ary')).resolvedOptions().locale).toBe('ar');
  });
});

describe('formatList', () => {
  it('joins with the language conjunction and drops empty parts', () => {
    expect(formatList(['Action', 'Drama', 'Comedy'], 'en')).toBe('Action, Drama, and Comedy');
    expect(formatList(['Action', '', false, 'Drama'], 'de')).toBe('Action und Drama');
    expect(formatList(['A', 'B', 'C'], 'zh-CN')).toBe('A、B和C');
    expect(formatList(['Solo'], 'ary')).toBe('Solo');
  });
});

describe('listSeparator', () => {
  it('uses the script comma', () => {
    expect(listSeparator('en')).toBe(', ');
    expect(listSeparator('ja')).toBe('、');
    expect(listSeparator('zh-TW')).toBe('、');
    expect(listSeparator('ary')).toBe('، ');
    expect(listSeparator('ar')).toBe('، ');
  });
});

describe('cached Intl formatters', () => {
  it('builds one formatter per locale and option set', () => {
    expect(numberFormat('de', { maximumFractionDigits: 1 })).toBe(numberFormat('de', { maximumFractionDigits: 1 }));
    expect(numberFormat('de', { maximumFractionDigits: 1 })).not.toBe(numberFormat('de', { maximumFractionDigits: 0 }));
    expect(numberFormat('de')).not.toBe(numberFormat('fr'));
    expect(dateTimeFormat('en', { hour: '2-digit' })).toBe(dateTimeFormat('en', { hour: '2-digit' }));
    expect(relativeTimeFormat('en', { numeric: 'auto' })).toBe(relativeTimeFormat('en', { numeric: 'auto' }));
  });

  it('formats like the constructor', () => {
    expect(numberFormat('de', { maximumFractionDigits: 1 }).format(1234.56)).toBe(new Intl.NumberFormat('de', { maximumFractionDigits: 1 }).format(1234.56));
    expect(relativeTimeFormat('en', { numeric: 'auto' }).format(1, 'day')).toBe('tomorrow');
  });

  it('throws for an invalid locale, as the constructor does', () => {
    expect(() => numberFormat('not a locale!')).toThrow(RangeError);
    expect(() => numberFormat('not a locale!')).toThrow(RangeError);
  });
});
