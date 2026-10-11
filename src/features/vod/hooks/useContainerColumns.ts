import { useLayoutEffect, useState, type RefObject } from 'react';

/** Width-driven column count for a responsive list: floor((w + gap) / (min + gap)), at least 1. */
export function columnsFor(width: number, minColumnWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
}

export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Offset of `el` from the top of the scroll content of `scroller` (for virtualizer scrollMargin). */
export function useScrollMargin(el: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, deps: readonly unknown[]): number {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const a = el.current;
    const s = scroller.current;
    if (!a || !s) return;
    const measure = () => setMargin(a.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(s.firstElementChild ?? s);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return margin;
}
