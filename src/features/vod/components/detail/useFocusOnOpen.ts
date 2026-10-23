import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * L2-vod-9: a title opened from a grid, a rail or search (a PUSH) puts focus
 * on its primary action, so Enter plays at once, the way Netflix and Apple TV
 * land on Play. The action names the title through `aria-describedby`, so a
 * screen reader reads both. Without one (a series with no episodes), the
 * title heading takes focus instead.
 *
 * It runs once per history entry, when the content (not the skeleton) is
 * first on screen. Back and Forward (POP, also a cold start) keep the focus
 * restore of the page you return to, and focus the user (or a dialog) has
 * already moved somewhere other than the page body is left alone.
 */
export function useFocusOnOpen(ready: boolean, getTarget: () => HTMLElement | null | undefined): void {
  const navigationType = useNavigationType();
  const { key } = useLocation();
  const handled = useRef<string | null>(null);
  const getRef = useRef(getTarget);
  getRef.current = getTarget;

  useEffect(() => {
    if (!ready || handled.current === key) return;
    handled.current = key;
    if (navigationType !== 'PUSH') return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const el = getRef.current();
    if (!el) return;
    const stopIgnoring = ignoreHeldKey();
    if (typeof ResizeObserver === 'undefined') {
      el.focus({ preventScroll: true });
      return stopIgnoring;
    }
    // P2-RAILS-6: focus() brings the page's style up to date first, and right after the content
    // committed that was the whole new page (41 ms at a 4x slowdown on a movie). A one-shot
    // observer's callback comes after the browser's own style and layout and before paint, so the
    // focus forces nothing there and the first frame still shows it. Focus moved meanwhile stays.
    const ro = new ResizeObserver(() => {
      ro.disconnect();
      const now = document.activeElement;
      if (now && now !== document.body) return;
      el.focus({ preventScroll: true });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      stopIgnoring();
    };
  }, [ready, key, navigationType]);
}

/**
 * The Enter that opened the page may still be held down: its auto-repeat must
 * not press the button that just took focus. Repeats of that key are dropped
 * until a key is released or a new key goes down.
 */
function ignoreHeldKey(): () => void {
  function stop() {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', stop, true);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!e.repeat) return stop();
    e.preventDefault();
    e.stopPropagation();
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', stop, true);
  return stop;
}
