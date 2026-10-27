import { describe, expect, it } from 'vitest';

import { displayChannelName, splitCountryTag, stripCountryPrefix } from './channelName';

describe('splitCountryTag', () => {
  it('splits a provider tag from the name by the strip rules', () => {
    expect(splitCountryTag('US| ESPN HD')).toEqual({ tag: 'US', name: 'ESPN HD' });
    expect(splitCountryTag('US | CNN')).toEqual({ tag: 'US', name: 'CNN' });
    expect(splitCountryTag('UK: BBC One')).toEqual({ tag: 'UK', name: 'BBC One' });
    expect(splitCountryTag('DE - ARD')).toEqual({ tag: 'DE', name: 'ARD' });
    expect(splitCountryTag('4K-DE - Das Erste')).toEqual({ tag: '4K-DE', name: 'Das Erste' });
    expect(splitCountryTag('[FR] TF1')).toEqual({ tag: 'FR', name: 'TF1' });
    // A leading separator strips nothing by itself.
    expect(splitCountryTag('|DE| ARD')).toEqual({ tag: 'DE', name: 'ARD' });
  });

  it('leaves names whose dash or colon is part of the name, and names that would be left empty', () => {
    expect(splitCountryTag('NCIS: LA')).toEqual({ name: 'NCIS: LA' });
    expect(splitCountryTag('Sky - Sports F1')).toEqual({ name: 'Sky - Sports F1' });
    expect(splitCountryTag('1917 - Live')).toEqual({ name: '1917 - Live' });
    expect(splitCountryTag('  ESPN  ')).toEqual({ name: 'ESPN' });
    expect(splitCountryTag('US|')).toEqual({ name: 'US|' });
    expect(splitCountryTag('')).toEqual({ name: '' });
  });

  it('is what stripping keeps', () => {
    for (const n of ['US| ESPN HD', '[FR] TF1', '|DE| ARD', 'NCIS: LA', 'US|', 'AR-SUBS - Film']) {
      expect(stripCountryPrefix(n)).toBe(splitCountryTag(n).name);
    }
    expect(displayChannelName('US| ESPN HD', true)).toBe('ESPN HD');
    expect(displayChannelName('US| ESPN HD', false)).toBe('US| ESPN HD');
  });
});
