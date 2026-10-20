/**
 * Whether a Home card is on screen or about to be, for the lookups a card makes of its own
 * (SH-home-rpc-fanout): a Continue watching card's backdrop (`catalog.item`) and a trending
 * card's catalog match (`catalog.search`). Every card of a rail is mounted (no virtualization),
 * so without this a TMDB user's cold Home asked the server up to 40 searches and 24 item reads
 * at once, and again for every card on each `sources.changed`.
 *
 * One shared IntersectionObserver per scroll root. The root is the shell's outlet, which is what
 * scrolls Home (the window does not, so a margin on the viewport would be clipped away by the
 * outlet); the margin reaches one outlet height past the fold, so the next rail down is ready
 * before it scrolls in. A card outside its rail's own scroller stays out (the scroller clips it)
 * until the rail scrolls it into view. A card that leaves the view keeps what it found (the
 * query's cache), but its query stops being active, so an invalidation refetches only the cards
 * on screen.
 *
 * No IntersectionObserver (jsdom, very old engines): every card counts as near, as before.
 */

import { useEffect, useState } from 'react';

const NEAR_MARGIN = '100% 0px';
const OUTLET = '[data-shell-outlet]';

const watchers = new Map<Element, (near: boolean) => void>();
/** Per root: its observer and how many cards it watches (it is dropped with the last one). */
const observers = new Map<Element | null, { io: IntersectionObserver; count: number }>();

function observe(el: Element, onChange: (near: boolean) => void): () => void {
  const root = el.closest(OUTLET);
  let entry = observers.get(root);
  if (!entry) {
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) watchers.get(r.target)?.(r.isIntersecting);
      },
      { root, rootMargin: NEAR_MARGIN },
    );
    entry = { io, count: 0 };
    observers.set(root, entry);
  }
  const held = entry;
  held.count += 1;
  watchers.set(el, onChange);
  held.io.observe(el);
  return () => {
    held.io.unobserve(el);
    watchers.delete(el);
    held.count -= 1;
    if (held.count === 0) {
      held.io.disconnect();
      observers.delete(root);
    }
  };
}

const supported = () => typeof IntersectionObserver === 'function';

/** Live: `el` is in view or within NEAR_MARGIN of it. Pass the element from a callback ref (state), not a ref object. */
export function useNearView(el: Element | null): boolean {
  const [near, setNear] = useState(() => !supported());
  useEffect(() => {
    if (!el || !supported()) return;
    return observe(el, setNear);
  }, [el]);
  return near;
}
