/**
 * Review round 1 fixes to the guide's pure helpers: the search query counted in code points like
 * the core (an emoji is one character, a cut never splits a surrogate pair), the search panel's
 * placement inside the guide page at any width and direction, and the toolbar layout by width.
 */
import { describe, expect, it } from 'vitest';

import { GUIDE_BAR_DAYS_PX, GUIDE_BAR_STACK_PX, guideBarLayout } from '../../components/EpgGridPage';
import { panelPlacement } from '../GuideSearchPanel';
import { SEARCH_MAX_CHARS, searchQuery } from '../search';

describe('searchQuery counts code points, as the core does', () => {
  it('one emoji is one character: too short, so nothing is sent (the hint shows, not an error)', () => {
    expect('📺'.length).toBe(2);
    expect(searchQuery('📺')).toBeNull();
    expect(searchQuery(' 📺 ')).toBeNull();
    expect(searchQuery('📺📺')).toBe('📺📺');
    expect(searchQuery('a📺')).toBe('a📺');
  });

  it('cuts at 100 code points without splitting a surrogate pair', () => {
    const q = searchQuery('📺'.repeat(150))!;
    expect(Array.from(q)).toHaveLength(SEARCH_MAX_CHARS);
    expect(q).toBe('📺'.repeat(SEARCH_MAX_CHARS));
    // No lone surrogate at the end.
    expect(q.charCodeAt(q.length - 1)).toBe('📺'.charCodeAt(1));
  });

  it('a cut that ends on spaces is trimmed again, and stays null when that leaves too little', () => {
    expect(searchQuery(`ab${' '.repeat(120)}cd`)).toBe('ab');
    expect(searchQuery(`a${' '.repeat(120)}cd`)).toBeNull();
    expect(searchQuery('  news  ')).toBe('news');
  });
});

describe('panelPlacement keeps the results panel inside the guide page', () => {
  const MAX = 450; // 30rem at 15px

  it('desktop: the panel hangs from the field’s inline start', () => {
    // Page from x=72 (beside the rail) to 1280; field 484..724.
    const p = panelPlacement({ left: 484, right: 724 }, { left: 72, right: 1280 }, MAX, false)!;
    expect(p.width).toBe(MAX);
    expect(484 + p.left).toBe(484);
  });

  it('phone (390 px, 72 px rail): a field at the page start no longer pushes the panel under the rail or off screen', () => {
    // The field wrapped to the start of its row: 84..360 (full width); page 72..390.
    const p = panelPlacement({ left: 84, right: 360 }, { left: 72, right: 390 }, MAX, false)!;
    expect(p.width).toBe(390 - 72 - 16);
    const left = 84 + p.left;
    expect(left).toBeGreaterThanOrEqual(72 + 8);
    expect(left + p.width).toBeLessThanOrEqual(390 - 8);
  });

  it('the narrow w-44 field the reviewers measured (l=-127 before) lands inside', () => {
    const p = panelPlacement({ left: 84, right: 260 }, { left: 72, right: 390 }, MAX, false)!;
    expect(84 + p.left).toBe(80);
    expect(84 + p.left + p.width).toBe(382);
  });

  it('RTL mirrors it: the panel ends at the field’s right edge, slid back inside the page', () => {
    // RTL rail on the right: page 0..318; field near the page's start (its right side).
    const desk = panelPlacement({ left: 556, right: 796 }, { left: 0, right: 1208 }, MAX, true)!;
    expect(556 + desk.left + desk.width).toBe(796);
    const phone = panelPlacement({ left: 140, right: 306 }, { left: 0, right: 318 }, MAX, true)!;
    expect(140 + phone.left).toBeGreaterThanOrEqual(8);
    expect(140 + phone.left + phone.width).toBeLessThanOrEqual(310);
  });

  it('a field near the page’s end edge slides the panel back from that side too', () => {
    const p = panelPlacement({ left: 900, right: 960 }, { left: 72, right: 1000 }, MAX, false)!;
    expect(900 + p.left + p.width).toBe(992);
    // And in RTL from the other side: a field near the page's left edge.
    const rtl = panelPlacement({ left: 100, right: 160 }, { left: 72, right: 1000 }, MAX, true)!;
    expect(100 + rtl.left).toBe(80);
  });

  it('null when there is nothing to measure (jsdom, a page with no width)', () => {
    expect(panelPlacement({ left: 0, right: 0 }, { left: 0, right: 0 }, MAX, false)).toBeNull();
  });
});

describe('guideBarLayout', () => {
  it('unmeasured and wide pages keep the full toolbar', () => {
    expect(guideBarLayout(0)).toBe('full');
    expect(guideBarLayout(GUIDE_BAR_STACK_PX)).toBe('full');
    expect(guideBarLayout(1208)).toBe('full');
  });

  it('narrow pages stack the time controls; phones also drop the day buttons', () => {
    expect(guideBarLayout(GUIDE_BAR_STACK_PX - 1)).toBe('stacked');
    expect(guideBarLayout(GUIDE_BAR_DAYS_PX)).toBe('stacked');
    expect(guideBarLayout(GUIDE_BAR_DAYS_PX - 1)).toBe('phone');
    expect(guideBarLayout(318)).toBe('phone'); // 390 px viewport beside the 72 px rail
  });
});
