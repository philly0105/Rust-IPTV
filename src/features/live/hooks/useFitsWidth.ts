import { useLayoutEffect, useState } from 'react';

/**
 * Whether `el` is at least `minRem` wide (in rem of the root, so it follows the UI scale), kept
 * current as it resizes. While the element has no width yet (before it is attached, and in jsdom,
 * which lays nothing out) the answer is true, so a page never starts in its narrow layout by mistake.
 */
export function useFitsWidth(el: HTMLElement | null, minRem: number): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    if (!el) return;
    const check = () => {
      const width = el.clientWidth;
      if (!width) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setFits(width >= minRem * rem);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, minRem]);
  return fits;
}
