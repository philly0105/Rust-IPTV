import { describe, expect, it } from 'vitest';

import { dateTimeFormat, numberFormat, relativeTimeFormat } from './intl';

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
