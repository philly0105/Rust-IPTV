import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * True once the element has come within `margin` of its scroller's viewport, and from then on
 * (it never turns back to false, so a rail that scrolled past keeps its cards). The landing's
 * category rails mount through it (CB-VOD-LANDING), so a source with a dozen rails asks for and
 * draws only the ones near the screen.
 *
 * Without IntersectionObserver (jsdom, very old WebViews) it stays false: the element keeps its
 * placeholder and asks for nothing. Every WebView the app ships in has the observer.
 */
export function useNearViewport<T extends Element>(
  rootRef: RefObject<Element | null>,
  margin = '600px 0px',
): [ref: (el: T | null) => void, near: boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  const ref = useCallback((node: T | null) => setEl(node), []);
  useEffect(() => {
    if (!el || near || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { root: rootRef.current, rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, near, rootRef, margin]);
  return [ref, near];
}
