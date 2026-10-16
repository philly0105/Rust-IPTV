/**
 * Scroll and focus memory for the shell's outlet (`<main id="main">`), the scroll container of
 * every page that does not scroll inside itself (the dashboard, Settings, Recent, Stats...).
 *
 * Each history entry (`location.key`) remembers where #main was scrolled and which control had
 * focus. Back/Forward (POP) puts both back once the page has grown tall enough (queries answer
 * from the cache, but sections can mount over a few frames), and gives up after
 * SCROLL_RESTORE_MAX_MS or as soon as the user scrolls or presses a key. A new page (PUSH, or a
 * REPLACE to another path) starts at the top. A page that restores its own scroller (the VOD
 * pages' useScrollMemory) can mark any element inside #main with `data-own-scroll-memory` to keep
 * the shell out of its way.
 */

import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** Longest Back waits for the page to be tall enough to take its old offset. */
export const SCROLL_RESTORE_MAX_MS = 2000;
const MAX_ENTRIES = 100;

interface Spot {
  top: number;
  /** A selector that finds the focused control again (its link target or accessible name). */
  focus?: string;
}

const spots = new Map<string, Spot>();

function remember(key: string, patch: Partial<Spot>): void {
  const prev = spots.get(key);
  spots.delete(key);
  spots.set(key, { top: prev?.top ?? 0, ...(prev?.focus ? { focus: prev.focus } : {}), ...patch });
  while (spots.size > MAX_ENTRIES) spots.delete(spots.keys().next().value!);
}

/** Test hook. */
export function forgetShellScrollForTests(): void {
  spots.clear();
}

/** An attribute value quoted for a selector (CSS.escape where the platform has it). */
const quote = (v: string) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&'));

/** A selector for `el` stable across a remount: link target first, then its accessible name. */
export function focusSelector(el: Element): string | undefined {
  const attr = (name: string) => {
    const v = el.getAttribute(name);
    return v ? `${el.tagName.toLowerCase()}[${name}="${quote(v)}"]` : undefined;
  };
  return attr('href') ?? attr('data-testid') ?? attr('aria-label') ?? undefined;
}

function ownsScroll(main: HTMLElement): boolean {
  return main.querySelector('[data-own-scroll-memory]') !== null;
}

/** Keys and the pointer that start a scroll of their own: the user has taken over. */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Restores `spot` into `main` once its content is tall enough, retrying each frame for up to
 * SCROLL_RESTORE_MAX_MS. Returns the cancel function.
 */
function restore(main: HTMLElement, spot: Spot): () => void {
  let raf = 0;
  let stopped = false;
  const deadline = performance.now() + SCROLL_RESTORE_MAX_MS;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    for (const type of TAKEOVER_EVENTS) window.removeEventListener(type, stop, true);
  };
  for (const type of TAKEOVER_EVENTS) window.addEventListener(type, stop, { capture: true, passive: true });

  const refocus = (): boolean => {
    if (!spot.focus) return true;
    const active = document.activeElement;
    // Never take focus from something the user (or the page) already focused.
    if (active && active !== document.body && active !== main) return true;
    const el = main.querySelector<HTMLElement>(spot.focus);
    if (!el) return false;
    el.focus({ preventScroll: true });
    return true;
  };

  const step = () => {
    if (stopped) return;
    const room = main.scrollHeight - main.clientHeight;
    const out = performance.now() >= deadline;
    if (room >= spot.top || out) {
      main.scrollTop = Math.min(spot.top, Math.max(0, room));
      if (refocus() || out) {
        stop();
        return;
      }
    }
    raf = requestAnimationFrame(step);
  };
  step();
  return stop;
}

/**
 * Mount once with the outlet. Records #main's offset and focus per history entry and restores
 * them on Back/Forward; new pages open at the top.
 */
export function useOutletScrollMemory(getMain: () => HTMLElement | null = () => document.getElementById('main')): void {
  const location = useLocation();
  const navType = useNavigationType();
  const prev = useRef<{ key: string; pathname: string } | null>(null);
  const getRef = useRef(getMain);
  getRef.current = getMain;
  // #main's offset as of its last scroll event or our own write. A new page skips the reset while
  // it is already 0: writing scrollTop (like reading it) forces a synchronous layout of the page
  // that just mounted (17 ms for a series page, XB2-25). Every offset change fires a scroll event,
  // so this stays current without reading layout.
  const seenTop = useRef(0);
  const toTop = (main: HTMLElement) => {
    if (seenTop.current === 0) return;
    main.scrollTop = 0;
    seenTop.current = 0;
  };

  // Record while the page is in use: scroll events carry the offset, focusin the control.
  // A layout effect, so a page change never records the next page's clamped offset under
  // the old entry: the listeners move to the new key in the same commit.
  useLayoutEffect(() => {
    const main = getRef.current();
    if (!main) return;
    const key = location.key;
    const onScroll = () => {
      seenTop.current = main.scrollTop;
      remember(key, { top: seenTop.current });
    };
    const onFocus = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const focus = target && target !== main ? focusSelector(target) : undefined;
      if (focus) remember(key, { focus });
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    main.addEventListener('focusin', onFocus);
    return () => {
      main.removeEventListener('scroll', onScroll);
      main.removeEventListener('focusin', onFocus);
    };
  }, [location.key]);

  useLayoutEffect(() => {
    const main = getRef.current();
    const before = prev.current;
    prev.current = { key: location.key, pathname: location.pathname };
    if (!main || !before || before.key === location.key) return;
    if (ownsScroll(main)) return;
    if (navType === 'POP') {
      const spot = spots.get(location.key);
      if (spot && (spot.top > 0 || spot.focus)) return restore(main, spot);
      toTop(main);
      return;
    }
    // A filter or query change on the same page keeps its place; a new page starts at the top.
    if (before.pathname !== location.pathname) toTop(main);
  }, [location.key, location.pathname, navType]);
}
