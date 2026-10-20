import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * True for the exit animations of globals.css (fade-out, pop-out, toast-out, drawer-out,
 * sheet-out). Anything else running in the subtree (a spinner, a live dot) is not waited for.
 */
function isExit(a: Animation): boolean {
  const name = (a as Animation & { animationName?: string }).animationName;
  return typeof name === 'string' && name.endsWith('-out');
}

/** Longest an exit may hold the element; a stalled animation never keeps an overlay on screen. */
const EXIT_CAP_MS = 400;

/**
 * Keeps an overlay mounted while its exit animation plays (DS-MOTION-EXIT). `present` is what
 * to render; `closing` is true from the moment `open` turns false until the element goes, and
 * the caller swaps its enter animation for the exit twin (`animate-pop-out`, ...) while it is.
 *
 * Right after the closing render commits, the hook asks the element (and its subtree) for its
 * running `*-out` animations and unmounts when they finish. With none (reduced motion, where
 * the motion-safe classes do not apply; an environment without the Web Animations API, such as
 * jsdom) it unmounts in the same commit, before paint, so nothing lingers.
 *
 * Callers stop treating a closing overlay as open: focus goes back and scroll unlocks as soon
 * as `open` is false, and the closing layer takes no pointer events.
 */
export function usePresence(open: boolean, ref: RefObject<HTMLElement | null>): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  // Opening again mid-exit, or the first open: render at once (state derived during render).
  if (open && !present) setPresent(true);
  const closing = present && !open;

  useLayoutEffect(() => {
    if (!closing) return;
    const el = ref.current;
    const running = typeof el?.getAnimations === 'function' ? el.getAnimations({ subtree: true }).filter(isExit) : [];
    if (running.length === 0) {
      setPresent(false);
      return;
    }
    let live = true;
    const done = () => {
      if (live) setPresent(false);
    };
    Promise.all(running.map((a) => a.finished)).then(done, done);
    const cap = setTimeout(done, EXIT_CAP_MS);
    return () => {
      live = false;
      clearTimeout(cap);
    };
  }, [closing, ref]);

  return { present: open || present, closing };
}
