/**
 * L3-cross-XB-2: the fallback initials size themselves from the tile. A 36 px row thumbnail
 * (Recent, Favorites, Downloads) drew "BH" at text-3xl, wider than the tile, so the letters and the
 * glyph were cut. The fallback is a size container; the letters are capped at 40 % and the glyph at
 * 30 % of its shorter side, and keep text-3xl / text-2xl on tiles big enough for them (about 70 px).
 * jsdom has no layout, so this pins the classes; the scratch build measured the fit in Edge.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Poster } from '@/ui/Poster';

afterEach(cleanup);

function fallback(aspect: 'poster' | 'square' | 'wide') {
  const { container } = render(<Poster src={undefined} alt="" label="Black Hole" aspect={aspect} />);
  const tile = container.querySelector<HTMLElement>('[data-poster-fallback]')!;
  return { tile, letters: tile.querySelector('span')!, glyph: tile.querySelector('svg')! };
}

describe('poster fallback initials fit their tile (L3-cross-XB-2)', () => {
  it('the fallback is a size container, so the letters can follow the tile', () => {
    const { tile, letters } = fallback('poster');
    expect(letters.textContent).toBe('BH');
    expect(tile.className).toContain('[container-type:size]');
  });

  it('a poster tile caps text-3xl by its shorter side; other tiles cap text-2xl', () => {
    const poster = fallback('poster').letters.className;
    expect(poster).toContain('text-[length:min(1.875rem,40cqmin)]');
    expect(poster).toContain('leading-[1.2]');
    expect(poster).not.toMatch(/\btext-3xl\b/);
    cleanup();
    for (const aspect of ['square', 'wide'] as const) {
      const cls = fallback(aspect).letters.className;
      expect(cls).toContain('text-[length:min(1.5rem,40cqmin)]');
      expect(cls).not.toMatch(/\btext-2xl\b/);
      cleanup();
    }
  });

  it('the glyph shrinks with the tile and keeps 16 px on large tiles', () => {
    const { glyph } = fallback('square');
    expect(glyph.getAttribute('class')).toContain('size-[min(16px,30cqmin)]');
    expect(glyph.getAttribute('width')).toBe('16');
  });
});
