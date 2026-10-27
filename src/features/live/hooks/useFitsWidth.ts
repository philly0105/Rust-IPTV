import { useLayoutEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/**
 * Whether the element in `ref` is at least `minRem` wide (in rem of the root, so it follows the UI
 * scale), kept current as it resizes. The element must mount with the component and stay. While it
 * has no width yet (and in jsdom, which lays nothing out) the answer is true, so a page never starts
 * in its narrow layout by mistake.
 *
 * The width comes from the ResizeObserver's entry, after the browser's own layout: a read while
 * the page mounts would force that layout inside the commit (P2-LIVE-1, 78 ms at a 4x CPU slowdown
 * on Live's cold open). The observer is attached in a layout effect so its first report lands in
 * the frame of the mount, and flushSync renders the answer before that frame paints, so a narrow
 * page never shows its wide layout for a frame. The element is read through its content box, so it
 * must have no padding.
 */
export function useFitsWidth(ref: RefObject<HTMLElement | null>, minRem: number): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number) => {
      if (!width) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setFits(width >= minRem * rem);
    };
    // Without an observer (old engines, tests without a stub) there is nothing to wait for.
    if (typeof ResizeObserver === 'undefined') {
      apply(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) flushSync(() => apply(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minRem]);
  return fits;
}
