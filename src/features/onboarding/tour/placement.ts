/**
 * Where the tour card goes next to its anchor. Pure geometry in viewport
 * pixels (physical left/top, as `getBoundingClientRect` reports them), so it
 * is unit-tested without layout.
 *
 * Preference order: beside the anchor on its inline-end side (the rail sits
 * on the start edge, so the card opens into the page), then below, above,
 * and on the inline-start side. The first side where the whole card fits
 * inside the margins wins; along the other axis the card is centred on the
 * anchor and clamped into the viewport. When no side fits (a phone held
 * sideways with the anchor mid-screen) the card is centred in the window.
 */

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type CardSide = 'end' | 'bottom' | 'top' | 'start' | 'center';

/**
 * The card's pointer: which physical edge of the card it sits on (facing the anchor) and how far
 * along that edge its tip is, in px from the card's top (left and right edges) or left (top and
 * bottom edges). Kept clear of the rounded corners.
 */
export interface CardArrow {
  edge: 'left' | 'right' | 'top' | 'bottom';
  offset: number;
}

export interface CardPlacement {
  top: number;
  left: number;
  side: CardSide;
  /** Absent for a centred card, which points at nothing. */
  arrow?: CardArrow;
}

/** Space between the spotlight ring and the card. */
export const CARD_GAP = 16;
/** Least distance between the card and the window edge. */
export const VIEWPORT_MARGIN = 12;
/** Extra room the spotlight leaves around its anchor. */
export const SPOTLIGHT_PAD = 6;
/** Least distance between the arrow's tip and a corner of the card (its radius plus the arrow's half width). */
export const ARROW_INSET = 24;

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** The card's top-left corner when it sits centred in a `vw` x `vh` window. */
export function centred(card: { width: number; height: number }, vw: number, vh: number): CardPlacement {
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.round((vw - card.width) / 2)),
    top: Math.max(VIEWPORT_MARGIN, Math.round((vh - card.height) / 2)),
    side: 'center',
  };
}

/** The spotlight box around an anchor: padded, then kept inside the window. */
export function spotlightBox(anchor: Box, vw: number, vh: number): Box {
  const left = clamp(anchor.left - SPOTLIGHT_PAD, 2, vw - 4);
  const top = clamp(anchor.top - SPOTLIGHT_PAD, 2, vh - 4);
  const right = clamp(anchor.left + anchor.width + SPOTLIGHT_PAD, left + 2, vw - 2);
  const bottom = clamp(anchor.top + anchor.height + SPOTLIGHT_PAD, top + 2, vh - 2);
  return { left, top, width: right - left, height: bottom - top };
}

export function placeCard(
  anchor: Box,
  card: { width: number; height: number },
  vw: number,
  vh: number,
  rtl = false,
): CardPlacement {
  const m = VIEWPORT_MARGIN;
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const midX = anchor.left + anchor.width / 2;
  const midY = anchor.top + anchor.height / 2;
  const alongY = clamp(Math.round(midY - card.height / 2), m, vh - card.height - m);
  const alongX = clamp(Math.round(midX - card.width / 2), m, vw - card.width - m);

  // The arrow points at the anchor's middle, wherever clamping left the card along that axis.
  const arrowY = clamp(Math.round(midY - alongY), ARROW_INSET, card.height - ARROW_INSET);
  const arrowX = clamp(Math.round(midX - alongX), ARROW_INSET, card.width - ARROW_INSET);

  const beside = (toRight: boolean, side: 'end' | 'start'): CardPlacement | null => {
    const left = toRight ? right + CARD_GAP : anchor.left - CARD_GAP - card.width;
    const fits = toRight ? left + card.width <= vw - m : left >= m;
    return fits && card.height <= vh - 2 * m
      ? { left: Math.round(left), top: alongY, side, arrow: { edge: toRight ? 'left' : 'right', offset: arrowY } }
      : null;
  };
  const below = (): CardPlacement | null => {
    const top = bottom + CARD_GAP;
    return top + card.height <= vh - m && card.width <= vw - 2 * m
      ? { left: alongX, top: Math.round(top), side: 'bottom', arrow: { edge: 'top', offset: arrowX } }
      : null;
  };
  const above = (): CardPlacement | null => {
    const top = anchor.top - CARD_GAP - card.height;
    return top >= m && card.width <= vw - 2 * m ? { left: alongX, top: Math.round(top), side: 'top', arrow: { edge: 'bottom', offset: arrowX } } : null;
  };

  // Inline-end is the right in LTR and the left in RTL.
  const end = () => beside(!rtl, 'end');
  const start = () => beside(rtl, 'start');
  for (const attempt of [end, below, above, start]) {
    const p = attempt();
    if (p) return p;
  }
  return centred(card, vw, vh);
}
