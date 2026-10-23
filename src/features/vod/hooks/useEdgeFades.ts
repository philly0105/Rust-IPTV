/**
 * A sideways scroller with its scrollbar hidden (the VOD decade chips) that
 * still shows when it holds more: the edge hiding content fades out, a
 * vertical mouse wheel moves the row sideways, and a chip that takes focus
 * is pulled clear of the fade. The math is in pure functions (physical
 * left/right, RTL-aware) so it can be tested without layout.
 */

import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

/** What the fade math needs from a scroller. */
export interface ScrollBox {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  rtl: boolean;
}

/** Physical edges with content scrolled out of view. */
export interface HiddenEdges {
  left: boolean;
  right: boolean;
}

/** Sub-pixel layouts leave a scroller a fraction off its ends. */
const SLACK = 1;
/** Fade length; a chip pulled into view keeps this much clear of the edge. */
export const FADE_LENGTH = '2rem';
const FADE_CLEAR_PX = 32;
const NONE: HiddenEdges = { left: false, right: false };

/** How far the scroller sits from its left end, 0..max, in either direction (RTL scrollLeft runs 0 to negative). */
function fromLeft(b: ScrollBox, max: number): number {
  return b.rtl ? b.scrollLeft + max : b.scrollLeft;
}

export function hiddenEdges(b: ScrollBox): HiddenEdges {
  const max = b.scrollWidth - b.clientWidth;
  if (max <= SLACK) return NONE;
  const x = fromLeft(b, max);
  return { left: x > SLACK, right: x < max - SLACK };
}

/** A mask that fades the hidden edges (only its alpha counts); undefined when nothing is hidden. */
export function fadeMask(edges: HiddenEdges): string | undefined {
  if (!edges.left && !edges.right) return undefined;
  const start = edges.left ? `transparent 0, #000 ${FADE_LENGTH}` : '#000 0';
  const end = edges.right ? `#000 calc(100% - ${FADE_LENGTH}), transparent 100%` : '#000 100%';
  return `linear-gradient(to right, ${start}, ${end})`;
}

/**
 * Pixels a wheel turn moves the row sideways, or 0 to leave it to the
 * browser: pinch zoom, sideways gestures (trackpads, Shift+wheel), a row
 * with nothing hidden, or one already at the end the turn points to.
 * Down moves toward the row's end: right in LTR, left in RTL.
 */
export function wheelShift(
  b: ScrollBox,
  e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean },
): number {
  if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return 0;
  const max = b.scrollWidth - b.clientWidth;
  if (max <= SLACK) return 0;
  // deltaMode: 0 pixels, 1 lines, 2 pages.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.clientWidth : 1;
  const dx = (b.rtl ? -e.deltaY : e.deltaY) * unit;
  const x = fromLeft(b, max);
  if ((dx > 0 && x >= max - SLACK) || (dx < 0 && x <= SLACK)) return 0;
  return dx;
}

function boxOf(el: HTMLElement): ScrollBox {
  return {
    scrollLeft: el.scrollLeft,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    rtl: getComputedStyle(el).direction === 'rtl',
  };
}

/** Scrolls `el` sideways just enough to show `child` whole and clear of the fades. */
export function revealInRow(el: HTMLElement, child: Element): void {
  const box = el.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  if (box.width <= 0) return;
  if (c.left < box.left + FADE_CLEAR_PX) el.scrollLeft -= box.left + FADE_CLEAR_PX - c.left;
  else if (c.right > box.right - FADE_CLEAR_PX) el.scrollLeft += c.right - (box.right - FADE_CLEAR_PX);
}

/**
 * Edge fades for a sideways scroller. Attach `ref`; spread `style` on the
 * same element. `contentKey` names the content (chips, language), so a row
 * whose content changed without a resize is measured again.
 */
export function useEdgeFades(contentKey: string): {
  ref: (el: HTMLElement | null) => void;
  el: HTMLElement | null;
  style: { maskImage?: string; WebkitMaskImage?: string };
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<HiddenEdges>(NONE);

  const measure = useCallback(() => {
    if (!el) return;
    const next = hiddenEdges(boxOf(el));
    setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, [el]);

  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = wheelShift(boxOf(el), e);
      if (dx === 0) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target !== el) revealInRow(el, e.target);
    };
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('focusin', onFocus);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('focusin', onFocus);
    };
  }, [el, measure]);

  // P2-RAILS-3: measured from an observer's first callback, which comes after the browser's own
  // layout, instead of in an effect right after the commit, where the reads forced the page's
  // layout (12 ms at a 4x slowdown on a cold Movies landing). The callback still comes before
  // paint, and flushSync puts a change on screen in that frame, so the fade is there when the row
  // first shows. A new observer per content, so a row whose chips changed without a resize is
  // measured again.
  useEffect(() => {
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      measure();
      return;
    }
    const ro = new ResizeObserver(() => flushSync(measure));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, measure, contentKey]);

  const mask = fadeMask(edges);
  return { ref: setEl, el, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : {} };
}
