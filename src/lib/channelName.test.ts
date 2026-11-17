import { describe, expect, it } from 'vitest';

import { channelNameParts, displayChannelName, plainChannelName, splitCountryTag, splitPlaceTag, stripCountryPrefix } from './channelName';

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

  it('keeps an event state or a service in front, and takes a country with its language', () => {
    expect(splitPlaceTag('NEXT | HAWKS VS ARSENAL | Tue 17 Nov 23:00')).toEqual({ name: 'NEXT | HAWKS VS ARSENAL | Tue 17 Nov 23:00' });
    expect(splitPlaceTag('ENDED | AUCKLAND FC VS BAYERN MUNICH')).toEqual({ name: 'ENDED | AUCKLAND FC VS BAYERN MUNICH' });
    expect(splitPlaceTag('PRIME: NICKELODEON ᴿᴬᵂ')).toEqual({ name: 'PRIME: NICKELODEON ᴿᴬᵂ' });
    expect(splitPlaceTag('US (ESPN+ 002) | Chelsea vs. Knicks')).toEqual({ name: 'US (ESPN+ 002) | Chelsea vs. Knicks' });
    expect(splitPlaceTag('CA EN: SKY SPORTS F1 ᴿᴬᵂ')).toEqual({ tag: 'CA EN', name: 'SKY SPORTS F1 ᴿᴬᵂ' });
    expect(splitPlaceTag('EXYU: ZEE TV ᴴᴰ')).toEqual({ tag: 'EXYU', name: 'ZEE TV ᴴᴰ' });
    expect(splitPlaceTag('EX-YU| RTS 1')).toEqual({ tag: 'EX-YU', name: 'RTS 1' });
    expect(splitPlaceTag('LAT: ITV 2')).toEqual({ tag: 'LAT', name: 'ITV 2' });
    // Capital words that are no place stay part of the name.
    expect(splitPlaceTag('NCIS: LA')).toEqual({ name: 'NCIS: LA' });
    expect(splitPlaceTag('HD SD: Test')).toEqual({ name: 'HD SD: Test' });
    expect(plainChannelName('CA EN: ESPN 4K', false)).toBe('ESPN 4K (CA EN)');
  });

  it('leaves the strip setting its own wider rule', () => {
    expect(stripCountryPrefix('Sky Sports | Main Event')).toBe('Main Event');
    expect(stripCountryPrefix('NBA: Lakers vs Celtics')).toBe('Lakers vs Celtics');
  });
});

describe('plainChannelName', () => {
  it('puts a place tag after the name in brackets, as ChannelName draws it', () => {
    expect(plainChannelName('US| ABC (Backup)', false)).toBe('ABC (Backup) (US)');
    expect(plainChannelName('[FR] TF1', undefined)).toBe('TF1 (FR)');
    expect(plainChannelName('LATAM| FOX SPORTS 1', false)).toBe('FOX SPORTS 1 (LATAM)');
  });

  it('keeps names whose prefix is not a place as written', () => {
    expect(plainChannelName('NBA: Lakers vs Celtics', false)).toBe('NBA: Lakers vs Celtics');
    expect(plainChannelName('Sky Sports | Main Event', false)).toBe('Sky Sports | Main Event');
    expect(plainChannelName('ESPN HD', false)).toBe('ESPN HD');
    expect(plainChannelName(undefined, false)).toBe('');
  });

  it('leaves the tag out with the strip setting on', () => {
    expect(plainChannelName('US| ABC (Backup)', true)).toBe('ABC (Backup)');
    expect(plainChannelName('NBA: Lakers vs Celtics', true)).toBe('Lakers vs Celtics');
  });
});

describe('channelNameParts', () => {
  it('keeps a feed\'s quality and copy words apart from the station, so a narrow column cuts the station', () => {
    expect(channelNameParts('CA EN: SKY SPORTS PREMIER LEAGUE ᴿᴬᵂ ⁶⁰ᶠᵖˢ', false)).toEqual({
      name: 'SKY SPORTS PREMIER LEAGUE',
      variant: 'ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
      tag: 'CA EN',
      full: 'CA EN: SKY SPORTS PREMIER LEAGUE ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
    });
    expect(channelNameParts('US: TENNIS CHANNEL HD (BACKUP 2)', false)).toMatchObject({ name: 'TENNIS CHANNEL', variant: 'HD (BACKUP 2)', tag: 'US' });
    expect(channelNameParts('KR: ESPN HD BACKUP', false)).toMatchObject({ name: 'ESPN', variant: 'HD BACKUP' });
    expect(channelNameParts('RAI 2 FHD ᴴᴰ/ᴿᴬᵂ', false)).toMatchObject({ name: 'RAI 2', variant: 'FHD ᴴᴰ/ᴿᴬᵂ' });
    // A name's own words and numbers stay with it, and so does its first word.
    expect(channelNameParts('SKY SPORTS F1', false)).toEqual({ name: 'SKY SPORTS F1', full: 'SKY SPORTS F1' });
    expect(channelNameParts('BEIN SPORTS 2', false)).toEqual({ name: 'BEIN SPORTS 2', full: 'BEIN SPORTS 2' });
    expect(channelNameParts('HD', false)).toEqual({ name: 'HD', full: 'HD' });
    expect(channelNameParts('NEXT | HAWKS VS ARSENAL | US: ESPN+ PPV 1', false)).toMatchObject({ name: 'NEXT | HAWKS VS ARSENAL | US: ESPN+ PPV 1' });
  });

  it('leaves out a leading word the open group\'s name already has', () => {
    expect(channelNameParts('PRIME: PBS HD', false, 'US| PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ')).toEqual({ name: 'PBS', variant: 'HD', full: 'PRIME: PBS HD' });
    expect(channelNameParts('PRIME: PBS HD', false)).toMatchObject({ name: 'PRIME: PBS' });
    expect(channelNameParts('PRIME: PBS HD', false, 'US| SPORTS')).toMatchObject({ name: 'PRIME: PBS' });
    expect(channelNameParts('NCIS: LA', false, 'NCIS')).toMatchObject({ name: 'NCIS: LA' });
  });

  it('follows the strip setting', () => {
    expect(channelNameParts('US| ESPN HD', true)).toEqual({ name: 'ESPN', variant: 'HD', full: 'ESPN HD' });
  });
});
