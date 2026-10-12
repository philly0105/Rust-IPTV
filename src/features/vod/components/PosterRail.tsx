import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { handleGridKeyDown } from '../lib/gridNav';
import { IconButton, cn } from '@/ui';
import { PosterCardSkeleton } from './PosterCard';

/** True when the user asked the OS to reduce motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Horizontal scroll delta for a step toward the inline end (`dir = 1`) or
 * start (`dir = -1`). RTL scrollers count `scrollLeft` from 0 down to
 * negative values, so the sign flips there.
 */
export function railScrollDelta(dir: 1 | -1, rtl: boolean, clientWidth: number, cardWidth: number): number {
  return dir * (rtl ? -1 : 1) * Math.max(cardWidth, clientWidth - cardWidth);
}

/**
 * Slack for the edge checks. Above the rail's 4 px inline padding, so a snap
 * that settles on the first card's edge (scrollLeft 4, or -4 in RTL) still
 * counts as the start.
 */
export const RAIL_EDGE_TOLERANCE = 6;

/**
 * Whether the rail sits at its inline start / end. Uses `|scrollLeft|` so it
 * holds in RTL, where `scrollLeft` runs from 0 to `-(scrollWidth - clientWidth)`.
 */
export function railEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): { start: boolean; end: boolean } {
  const pos = Math.abs(scrollLeft);
  return { start: pos <= RAIL_EDGE_TOLERANCE, end: pos + clientWidth >= scrollWidth - RAIL_EDGE_TOLERANCE };
}

export interface PosterRailProps<T> {
  title: ReactNode;
  items: readonly T[];
  render: (item: T, index: number) => ReactNode;
  loading?: boolean;
  /** Shown instead of the rail when there are no items and not loading. Omit to hide the rail. */
  empty?: ReactNode;
  action?: ReactNode;
  /** Card width in px. */
  cardWidth?: number;
  className?: string;
}

/**
 * Horizontal rail of fixed-width cards (capped lists: recently added,
 * similar, known for). Arrow keys move between cards; the step buttons
 * page by the visible width.
 */
export function PosterRail<T>({ title, items, render, loading, empty, action, cardWidth = 150, className }: PosterRailProps<T>) {
  const { t } = useTranslation('vod');
  const headingId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const updateEdges = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges(railEdges(el.scrollLeft, el.clientWidth, el.scrollWidth));
  }, []);

  useEffect(() => {
    updateEdges();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges, items.length, loading]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    // 'auto' defers to CSS scroll-behavior, which is smooth only under motion-safe.
    el.scrollBy({ left: railScrollDelta(dir, rtl, el.clientWidth, cardWidth), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  if (!loading && items.length === 0 && !empty) return null;

  return (
    <section aria-labelledby={headingId} className={cn('min-w-0', className)}>
      <div className="mb-3 flex items-end gap-3">
        <h2 id={headingId} className="text-base text-fg">
          {title}
        </h2>
        <div className="ms-auto flex items-center gap-1">
          {action}
          {items.length > 0 && (
            <>
              <IconButton
                size="sm"
                label={t('railPrevious')}
                icon={<ChevronLeft aria-hidden size={18} className="rtl:rotate-180" />}
                disabled={edges.start}
                onClick={() => page(-1)}
              />
              <IconButton
                size="sm"
                label={t('railNext')}
                icon={<ChevronRight aria-hidden size={18} className="rtl:rotate-180" />}
                disabled={edges.end}
                onClick={() => page(1)}
              />
            </>
          )}
        </div>
      </div>
      {!loading && items.length === 0 ? (
        empty
      ) : (
        <div
          ref={scroller}
          role="list"
          onScroll={updateEdges}
          onKeyDown={(e) => handleGridKeyDown(e, { orientation: 'horizontal', count: items.length })}
          // Skeletons have nothing to focus, so the loading row clips instead of scrolling (axe scrollable-region-focusable).
          className={cn('-mx-1 flex snap-x scroll-px-1 gap-4 px-1 pt-1 pb-3 motion-safe:scroll-smooth', loading ? 'overflow-x-hidden' : 'overflow-x-auto')}
        >
          {loading
            ? Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="shrink-0" style={{ width: cardWidth }}>
                  <PosterCardSkeleton />
                </div>
              ))
            : items.map((item, i) => (
                <div key={i} role="listitem" className="shrink-0 snap-start" style={{ width: cardWidth }}>
                  {render(item, i)}
                </div>
              ))}
        </div>
      )}
    </section>
  );
}
