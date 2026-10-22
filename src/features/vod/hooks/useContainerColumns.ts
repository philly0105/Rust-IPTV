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

/**
 * The visible height of a scroller (its clientHeight), kept current. A child that mounts with its
 * page runs this before React attaches the page's ref, so as in useScrollMargin the scroller is
 * looked up again once the commit is done.
 */
export function useClientHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    let ro: ResizeObserver | undefined;
    let cancelled = false;
    const start = () => {
      const el = ref.current;
      if (cancelled || !el) return;
      setHeight(el.clientHeight);
      if (typeof ResizeObserver === 'undefined') return;
      ro = new ResizeObserver(() => setHeight(el.clientHeight));
      ro.observe(el);
    };
    if (ref.current) start();
    else queueMicrotask(start);
    return () => {
      cancelled = true;
      ro?.disconnect();
    };
  }, [ref]);
  return height;
}

/**
 * Offset of `el` from the top of the scroll content of `scroller` (for virtualizer scrollMargin).
 *
 * A list that mounts in the same commit as its page (the page opened with its data cached, or
 * Back) runs this layout effect before React attaches the page's ref to the scroller, so the
 * scroller can still be null here. It is looked up again once the commit is done; before, the
 * margin stayed 0 for good and the virtualizer rendered rows thousands of pixels away from the
 * ones on screen (the VOD landing's category index showed blank).
 */
export function useScrollMargin(el: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, deps: readonly unknown[]): number {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    let ro: ResizeObserver | undefined;
    let cancelled = false;
    const start = () => {
      const a = el.current;
      const s = scroller.current;
      if (cancelled || !a || !s) return;
      const measure = () => setMargin(a.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop);
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      ro = new ResizeObserver(measure);
      ro.observe(s.firstElementChild ?? s);
    };
    if (el.current && scroller.current) start();
    else queueMicrotask(start);
    return () => {
      cancelled = true;
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return margin;
}
