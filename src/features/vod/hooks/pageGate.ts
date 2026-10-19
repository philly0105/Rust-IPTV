/**
 * Which grid pages may fetch (VD-2). Every grid cell subscribes to the page that holds it, so a
 * scrollbar drag across a 200k grid would send a `catalog.movies` call for every page it passes,
 * and the pages where it stops would queue behind them. The gate opens a page for its cells when:
 *
 * - it is within the pages last opened, or next to them while nothing is settling (a normal
 *   scroll moves onto the next page at once);
 * - or the cells have rested on it for {@link PAGE_SETTLE_MS} after a jump of more than a page.
 *
 * A closed page still shows what the cache holds (a disabled query returns cached data); it just
 * sends nothing. Posters wait for a scroll to settle the same way (src/ui/imageGate.ts).
 */

import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react';

/** How long the mounted cells must rest after a jump before their pages fetch. */
export const PAGE_SETTLE_MS = 110;

export class PageGate {
  /** Open pages, lo..hi inclusive; empty (lo > hi) until the first cell mounts. */
  private lo = 0;
  private hi = -1;
  private readonly mounted = new Map<number, number>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  isOpen(page: number): boolean {
    return page >= this.lo && page <= this.hi;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A cell of `page` mounted. */
  mount(page: number): void {
    this.mounted.set(page, (this.mounted.get(page) ?? 0) + 1);
    if (this.isOpen(page)) return;
    if (!this.started) {
      // The first page a grid shows fetches at once.
      this.started = true;
      this.openMounted();
      return;
    }
    const next = page === this.lo - 1 || page === this.hi + 1;
    if (next && this.timer === undefined) {
      this.openMounted();
      return;
    }
    // A jump restarts the wait; a step next to the open pages waits for the running timer.
    if (!next || this.timer === undefined) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.openMounted();
      }, PAGE_SETTLE_MS);
    }
  }

  /** A cell of `page` went away. */
  unmount(page: number): void {
    const n = (this.mounted.get(page) ?? 0) - 1;
    if (n > 0) this.mounted.set(page, n);
    else this.mounted.delete(page);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Opens exactly the pages that have mounted cells (they are contiguous: one window of rows). */
  private openMounted(): void {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const page of this.mounted.keys()) {
      lo = Math.min(lo, page);
      hi = Math.max(hi, page);
    }
    if (lo > hi) return;
    if (lo === this.lo && hi === this.hi) return;
    this.lo = lo;
    this.hi = hi;
    for (const l of this.listeners) l();
  }
}

const PageGateContext = createContext<PageGate | null>(null);

export const PageGateProvider = PageGateContext.Provider;

const alwaysOpen = () => true;
const noSubscribe = () => () => undefined;

/**
 * Whether the cell's page may fetch now. Registers the cell with the grid's gate; outside a
 * {@link PageGateProvider} every page is open.
 */
export function usePageOpen(page: number): boolean {
  const gate = useContext(PageGateContext);
  // Before paint: a cell next to the open pages opens in the same frame it mounts.
  useLayoutEffect(() => {
    if (!gate) return;
    gate.mount(page);
    return () => gate.unmount(page);
  }, [gate, page]);
  return useSyncExternalStore(gate ? gate.subscribe : noSubscribe, gate ? () => gate.isOpen(page) : alwaysOpen);
}
