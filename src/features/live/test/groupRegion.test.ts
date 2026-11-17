// Country tags of a provider's groups (lib/groupRegion.ts): what the group list's region picker offers.
import { describe, expect, it } from 'vitest';

import { groupRegion, groupRegions, regionLabel } from '../lib/groupRegion';

describe('group regions', () => {
  it('reads the tag before a pipe, a short code before a colon, or a bracketed code', () => {
    expect(groupRegion('US| SPORT ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ')).toBe('US');
    expect(groupRegion('UK | NEWS')).toBe('UK');
    expect(groupRegion('8K| SPORT ON AIR ⁸ᴷ')).toBe('8K');
    expect(groupRegion('de: Sport')).toBe(null);
    expect(groupRegion('DE: Sport')).toBe('DE');
    expect(groupRegion('[FR] Cinéma')).toBe('FR');
    expect(groupRegion('NCIS: LA')).toBe(null);
    expect(groupRegion('Sports')).toBe(null);
    expect(groupRegion('LATAM| DEPORTES')).toBe('LATAM');
    // A country written out in capitals is a tag too.
    expect(groupRegion('CANADA | SPORTS')).toBe('CANADA');
    expect(groupRegion('EX-YU| SPORT')).toBe('EX-YU');
  });

  it('reads past an emoji or a flag before the tag, so those groups join their region', () => {
    expect(groupRegion('⚽ GR| SPORTS')).toBe('GR');
    expect(groupRegion('🇬🇧 DE| MUSIC')).toBe('DE');
    expect(groupRegion('⭐️ NO| KIDS')).toBe('NO');
    expect(groupRegion('🇺🇸 EX-YU| SERIES')).toBe('EX-YU');
    expect(groupRegions(['GR| A', '⚽ GR| B', 'DE| A', '🇬🇧 DE| B'])).toEqual([
      { tag: 'DE', groups: 2 },
      { tag: 'GR', groups: 2 },
    ]);
  });

  it('names a country code in the UI language, and leaves other tags as they are', () => {
    expect(regionLabel('GR', 'en')).toBe('GR · Greece');
    expect(regionLabel('UK', 'en')).toBe('UK · United Kingdom');
    expect(regionLabel('GR', 'de')).toBe('GR · Griechenland');
    // Codes playlists use for something else, and tags that are no country code.
    expect(regionLabel('AR', 'en')).toBe('AR');
    expect(regionLabel('AF', 'en')).toBe('AF');
    expect(regionLabel('LAT', 'en')).toBe('LAT');
    expect(regionLabel('EX-YU', 'en')).toBe('EX-YU');
    expect(regionLabel('8K', 'en')).toBe('8K');
  });

  it('takes no word for a country: a group named "Movies | Action" has no region', () => {
    expect(groupRegion('Movies | Action')).toBe(null);
    expect(groupRegion('Sports | NBA')).toBe(null);
    expect(groupRegion('MOVIES | ACTION')).toBe(null);
    expect(groupRegions(['Movies | Action', 'Movies | Comedy', 'Sports | NFL', 'Sports | NBA'])).toEqual([]);
  });

  it('offers tags of two groups or more, most groups first, when most groups are tagged', () => {
    const names = ['US| A', 'US| B', 'US| C', 'UK| A', 'UK| B', 'CA| A', 'CA| B', 'IE| A', 'Misc'];
    expect(groupRegions(names)).toEqual([
      { tag: 'US', groups: 3 },
      { tag: 'CA', groups: 2 },
      { tag: 'UK', groups: 2 },
    ]);
    // Tags on a minority of groups, or a single tag: a plain list.
    expect(groupRegions(['US| A', 'US| B', 'News', 'Sports', 'Movies', 'Kids'])).toEqual([]);
    expect(groupRegions(['US| A', 'US| B', 'US| C'])).toEqual([]);
  });
});
