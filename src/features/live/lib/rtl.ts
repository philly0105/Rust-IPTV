import { useSyncExternalStore } from 'react';

/** True when the document runs right-to-left (the i18n layer sets `<html dir>` on every language switch). */
export function documentIsRtl(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => observer.disconnect();
}

/** Follows `<html dir>` so time axes re-lay out when the language switches between LTR and RTL. */
export function useIsRtl(): boolean {
  return useSyncExternalStore(subscribe, documentIsRtl, () => false);
}

/**
 * Physical offset from the inline-start edge of a time track: `left` in LTR, `right` in RTL.
 * Kept physical (not `insetInlineStart`) so layout and tests read the same numbers.
 */
export function inlineStart(x: number, rtl: boolean): { left: number } | { right: number } {
  return rtl ? { right: x } : { left: x };
}

/**
 * Distance scrolled from the inline-start edge. Chromium, Firefox and WebKit report an RTL
 * scroller's `scrollLeft` as 0 at the start (right) edge and negative toward the left.
 */
export function scrollStart(el: Element): number {
  return Math.abs(el.scrollLeft);
}

/** The `scrollLeft` value that puts `x` px from the inline-start edge at the scroller's start. */
export function scrollLeftFor(x: number, rtl: boolean): number {
  return rtl ? -x : x;
}

/** Arrow keys follow the screen: in RTL, ArrowLeft moves forward in time. */
export function timeStep(key: string, rtl: boolean): 1 | -1 | 0 {
  if (key === 'ArrowRight') return rtl ? -1 : 1;
  if (key === 'ArrowLeft') return rtl ? 1 : -1;
  return 0;
}
