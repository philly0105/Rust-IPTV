/**
 * Stops decorative loops nobody can see (L2-sources-home-1, L1-perf-2).
 *
 * A poster in a horizontal rail that sits outside the rail's scroller never
 * loads (`loading="lazy"`), so its shimmer would run forever: 33 of them kept
 * an idle Home at 74-92 % of a core. `pauseWhenOffscreen` is a ref callback
 * for an animated element: one shared IntersectionObserver keeps
 * `data-offscreen` on it while it is out of view (scroller clips included),
 * and globals.css turns its animation off there. The attribute is set before
 * the first observation, so an element that mounts out of view never starts.
 *
 * While the page is hidden, html[data-page-hidden] pauses the same loops.
 *
 * No IntersectionObserver (jsdom, very old engines): nothing is marked and
 * animations run as before.
 */

/** Out-of-view elements; also read by the CSS in src/styles/globals.css. */
export const OFFSCREEN_ATTR = 'data-offscreen';

let observer: IntersectionObserver | null | undefined;

function sharedObserver(): IntersectionObserver | null {
  if (observer === undefined) {
    observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) e.target.toggleAttribute(OFFSCREEN_ATTR, !e.isIntersecting);
            },
            // A little early, so a card scrolled into view is already moving.
            { rootMargin: '64px' },
          )
        : null;
  }
  return observer;
}

/**
 * Ref callback: pauses the element's CSS animation while it is out of view.
 * Pass this function itself (a stable identity), not a wrapper.
 */
export function pauseWhenOffscreen(el: Element | null): (() => void) | undefined {
  const io = el ? sharedObserver() : null;
  if (!el || !io) return undefined;
  el.setAttribute(OFFSCREEN_ATTR, '');
  io.observe(el);
  return () => io.unobserve(el);
}

/** Test hook: forget the shared observer so a stubbed IntersectionObserver is picked up. */
export function resetOffscreenObserver(): void {
  observer?.disconnect();
  observer = undefined;
}

if (typeof document !== 'undefined') {
  const sync = () => document.documentElement.toggleAttribute('data-page-hidden', document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', sync);
  sync();
}
