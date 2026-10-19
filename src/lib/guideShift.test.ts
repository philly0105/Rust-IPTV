import { describe, expect, it } from 'vitest';

import { parseGuideShift } from './guideShift';

describe('parseGuideShift', () => {
  it('reads whole minutes within 12 hours either way; blank is none', () => {
    expect(parseGuideShift('')).toBe(0);
    expect(parseGuideShift('  ')).toBe(0);
    expect(parseGuideShift('60')).toBe(60);
    expect(parseGuideShift('+30')).toBe(30);
    expect(parseGuideShift('-90')).toBe(-90);
    expect(parseGuideShift('−45')).toBe(-45);
    expect(parseGuideShift('720')).toBe(720);
    expect(parseGuideShift('-720')).toBe(-720);
  });

  it('refuses fractions, words and shifts beyond the limit', () => {
    expect(parseGuideShift('1.5')).toBeNull();
    expect(parseGuideShift('abc')).toBeNull();
    expect(parseGuideShift('721')).toBeNull();
    expect(parseGuideShift('-721')).toBeNull();
  });
});
