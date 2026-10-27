import { describe, expect, it } from 'vitest';

import { displayChannelName, splitCountryTag, splitPlaceTag, stripCountryPrefix } from './channelName';

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

describe('splitPlaceTag', () => {
  it('moves a tag shaped like a place code', () => {
    expect(splitPlaceTag('US| ESPN HD')).toEqual({ tag: 'US', name: 'ESPN HD' });
    expect(splitPlaceTag('LATAM | DEPORTES')).toEqual({ tag: 'LATAM', name: 'DEPORTES' });
    expect(splitPlaceTag('4K-DE - Das Erste')).toEqual({ tag: '4K-DE', name: 'Das Erste' });
    expect(splitPlaceTag('[FR] TF1')).toEqual({ tag: 'FR', name: 'TF1' });
  });

  it('keeps a prefix with lowercase letters or spaces as part of the name', () => {
    expect(splitPlaceTag('Sky Sports | Main Event')).toEqual({ name: 'Sky Sports | Main Event' });
    expect(splitPlaceTag('beIN SPORTS 1 | HD')).toEqual({ name: 'beIN SPORTS 1 | HD' });
    expect(splitPlaceTag('ESPN HD | Backup')).toEqual({ name: 'ESPN HD | Backup' });
    expect(splitPlaceTag('NBA 01 | Celtics @ Lakers')).toEqual({ name: 'NBA 01 | Celtics @ Lakers' });
    expect(splitPlaceTag('NORTHAMERICA| News')).toEqual({ name: 'NORTHAMERICA| News' });
  });

  it('keeps a kind of content or quality in front of what it names', () => {
    expect(splitPlaceTag('NBA: Lakers vs Celtics')).toEqual({ name: 'NBA: Lakers vs Celtics' });
    expect(splitPlaceTag('PPV: UFC 300')).toEqual({ name: 'PPV: UFC 300' });
    expect(splitPlaceTag('24/7| Friends')).toEqual({ name: '24/7| Friends' });
    expect(splitPlaceTag('VIP | Sky Cinema')).toEqual({ name: 'VIP | Sky Cinema' });
  });

  it('leaves the strip setting its own wider rule', () => {
    expect(stripCountryPrefix('Sky Sports | Main Event')).toBe('Main Event');
    expect(stripCountryPrefix('NBA: Lakers vs Celtics')).toBe('Lakers vs Celtics');
  });
});
