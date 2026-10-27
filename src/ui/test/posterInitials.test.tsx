/**
 * L3-cross-XB-2 and round 4: the fallback initials size themselves from the tile, and stand alone.
 * A 36 px row thumbnail (Recent, Favorites, Downloads) drew "BH" at text-3xl, wider than the tile;
 * later a 44 px tile pushed the letters to its top edge to make room for a type glyph, and a 135 px
 * On now card left 22 px letters floating in an empty field. The fallback is a size container: the
 * letters follow its shorter side, with a floor for small tiles and a cap for large ones, and there
 * is no glyph (the caption or row says what the item is). jsdom has no layout, so this pins the
 * classes; the screenshots measured the fit.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Poster } from '@/ui/Poster';

afterEach(cleanup);

function fallback(aspect: 'poster' | 'square' | 'wide', kind?: 'movie' | 'live' | 'radio') {
  const { container } = render(<Poster src={undefined} alt="" label="Black Hole" aspect={aspect} kind={kind} />);
  const tile = container.querySelector<HTMLElement>('[data-poster-fallback]')!;
  return { tile, letters: tile.querySelector('span')! };
}

describe('poster fallback initials fit their tile (L3-cross-XB-2)', () => {
  it('the fallback is a size container, so the letters can follow the tile', () => {
    const { tile, letters } = fallback('poster');
    expect(letters.textContent).toBe('BH');
    expect(tile.className).toContain('[container-type:size]');
  });

  it('a poster tile sizes its letters by its width, other tiles by their height, floored and capped', () => {
    const poster = fallback('poster').letters.className;
    expect(poster).toContain('text-[length:max(min(40cqmin,0.9rem),min(24cqmin,2.25rem))]');
    expect(poster).not.toMatch(/\btext-3xl\b/);
    cleanup();
    for (const aspect of ['square', 'wide'] as const) {
      const cls = fallback(aspect).letters.className;
      expect(cls).toContain('text-[length:max(min(40cqmin,1rem),min(30cqmin,2.75rem))]');
      expect(cls).not.toMatch(/\btext-2xl\b/);
      cleanup();
    }
  });

  it('draws the initials alone, with no type glyph, for every kind', () => {
    for (const kind of ['movie', 'live', 'radio'] as const) {
      const { tile } = fallback('square', kind);
      expect(tile.querySelector('svg'), kind).toBeNull();
      expect(tile.children).toHaveLength(1);
      cleanup();
    }
  });
});
