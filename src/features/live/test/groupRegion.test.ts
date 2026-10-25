// Country tags of a provider's groups (lib/groupRegion.ts): what the group list's region picker offers.
import { describe, expect, it } from 'vitest';

import { groupRegion, groupRegions } from '../lib/groupRegion';

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
