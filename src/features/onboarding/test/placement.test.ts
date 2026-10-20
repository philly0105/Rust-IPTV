// Tour card geometry: beside the anchor on its inline-end side, then below,
// above and inline-start, clamped into the window; centred when nothing fits.
import { describe, expect, it } from 'vitest';

import { ARROW_INSET, CARD_GAP, centred, placeCard, spotlightBox, SPOTLIGHT_PAD, VIEWPORT_MARGIN } from '../tour/placement';

const CARD = { width: 352, height: 232 };

describe('placeCard', () => {
  it('opens to the right of a rail item in a left-to-right layout', () => {
    const anchor = { top: 200, left: 8, width: 56, height: 44 };
    const p = placeCard(anchor, CARD, 1280, 800);
    expect(p.side).toBe('end');
    expect(p.left).toBe(8 + 56 + CARD_GAP);
    // Centred on the anchor along the other axis.
    expect(p.top).toBe(Math.round(222 - CARD.height / 2));
  });

  it('opens to the left of a rail item on the right edge in right-to-left', () => {
    const anchor = { top: 200, left: 1216, width: 56, height: 44 };
    const p = placeCard(anchor, CARD, 1280, 800, true);
    expect(p.side).toBe('end');
    expect(p.left).toBe(1216 - CARD_GAP - CARD.width);
  });

  it('keeps the card inside the window when the anchor is near the top', () => {
    const anchor = { top: 4, left: 8, width: 56, height: 40 };
    const p = placeCard(anchor, CARD, 1280, 800);
    expect(p.side).toBe('end');
    expect(p.top).toBe(VIEWPORT_MARGIN);
  });

  it('goes below a header button with no room beside it', () => {
    const anchor = { top: 10, left: 1180, width: 90, height: 36 };
    const p = placeCard(anchor, CARD, 1280, 800);
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(10 + 36 + CARD_GAP);
    expect(p.left + CARD.width).toBeLessThanOrEqual(1280 - VIEWPORT_MARGIN);
  });

  it('goes above an anchor at the bottom of a narrow window', () => {
    const anchor = { top: 780, left: 150, width: 90, height: 50 };
    const p = placeCard(anchor, CARD, 390, 844);
    expect(p.side).toBe('top');
    expect(p.top).toBe(780 - CARD_GAP - CARD.height);
    expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(p.left + CARD.width).toBeLessThanOrEqual(390 - VIEWPORT_MARGIN);
  });

  it('falls back to the inline-start side', () => {
    // Right edge of a short, wide window: no room to the right, below or above.
    const anchor = { top: 100, left: 900, width: 80, height: 100 };
    const p = placeCard(anchor, CARD, 1000, 300);
    expect(p.side).toBe('start');
    expect(p.left).toBe(900 - CARD_GAP - CARD.width);
  });

  it('centres the card when no side fits', () => {
    const anchor = { top: 150, left: 150, width: 90, height: 100 };
    const p = placeCard(anchor, CARD, 390, 400);
    expect(p).toEqual(centred(CARD, 390, 400));
    expect(p.side).toBe('center');
  });
});

describe('centred', () => {
  it('centres in the window', () => {
    expect(centred(CARD, 1280, 800)).toEqual({ left: 464, top: 284, side: 'center' });
  });

  it('never goes past the top-left margin on a tiny window', () => {
    const p = centred(CARD, 300, 200);
    expect(p.left).toBe(VIEWPORT_MARGIN);
    expect(p.top).toBe(VIEWPORT_MARGIN);
  });
});

describe('spotlightBox', () => {
  it('pads the anchor', () => {
    expect(spotlightBox({ top: 100, left: 100, width: 50, height: 20 }, 1280, 800)).toEqual({
      top: 100 - SPOTLIGHT_PAD,
      left: 100 - SPOTLIGHT_PAD,
      width: 50 + 2 * SPOTLIGHT_PAD,
      height: 20 + 2 * SPOTLIGHT_PAD,
    });
  });

  it('stays inside the window for an anchor at the edge', () => {
    const b = spotlightBox({ top: 0, left: 0, width: 64, height: 48 }, 1280, 800);
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.left).toBeGreaterThanOrEqual(0);
    const far = spotlightBox({ top: 760, left: 1240, width: 80, height: 80 }, 1280, 800);
    expect(far.left + far.width).toBeLessThanOrEqual(1280);
    expect(far.top + far.height).toBeLessThanOrEqual(800);
  });
});

describe('the card arrow', () => {
  it('sits on the edge that faces the anchor and points at its middle', () => {
    const anchor = { top: 200, left: 8, width: 56, height: 44 };
    const p = placeCard(anchor, CARD, 1280, 800);
    expect(p.arrow?.edge).toBe('left');
    // The card is centred on the anchor, so the tip is half way down the card.
    expect(p.top + p.arrow!.offset).toBe(222);
  });

  it('points at an anchor the card had to be clamped away from, but stays clear of the corners', () => {
    const anchor = { top: 4, left: 8, width: 56, height: 20 };
    const p = placeCard(anchor, CARD, 1280, 800);
    expect(p.top).toBe(VIEWPORT_MARGIN);
    expect(p.arrow).toEqual({ edge: 'left', offset: ARROW_INSET });
  });

  it('uses the right edge in right-to-left and the top or bottom edge below or above', () => {
    expect(placeCard({ top: 200, left: 1216, width: 56, height: 44 }, CARD, 1280, 800, true).arrow?.edge).toBe('right');
    const below = placeCard({ top: 10, left: 180, width: 36, height: 36 }, CARD, 390, 800);
    expect(below.side).toBe('bottom');
    expect(below.arrow?.edge).toBe('top');
    expect(below.left + below.arrow!.offset).toBe(198);
    const above = placeCard({ top: 780, left: 180, width: 36, height: 36 }, CARD, 390, 840);
    expect(above.side).toBe('top');
    expect(above.arrow?.edge).toBe('bottom');
  });

  it('is absent on a centred card', () => {
    expect(centred(CARD, 1280, 800).arrow).toBeUndefined();
  });
});
