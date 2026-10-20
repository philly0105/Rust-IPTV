import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { MyListKey, useMyListKeyFocus, type MyListTarget } from '../hooks/useMyListKey';
import { useRailCardWidth } from '../hooks/useRailCardWidth';
import { handleGridKeyDown } from '../lib/gridNav';
import { IconButton, PosterWidthContext, SectionHeader, cn } from '@/ui';
import { GridMyListProvider, PosterCardSkeleton } from './PosterCard';

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

/** What a rail hands each card: pass `tabIndex` to the card's link (one Tab stop per rail). */
export interface RailCardProps {
  tabIndex: number;
}

export interface PosterRailProps<T> {
  title: ReactNode;
  items: readonly T[];
  render: (item: T, index: number, rail: RailCardProps) => ReactNode;
  loading?: boolean;
  /** Shown instead of the rail when there are no items and not loading. Omit to hide the rail. */
  empty?: ReactNode;
  action?: ReactNode;
  /** A muted number after the title (a category's title count), formatted by the caller. */
  count?: ReactNode;
  /** "See all" on the heading row: the grid this rail is a slice of. */
  seeAll?: { to: string; label?: ReactNode } | undefined;
  /** Card width in px. Defaults to the cover-size setting at the UI scale (useRailCardWidth). */
  cardWidth?: number;
  /**
   * The track runs out to the page edge through the page gutter (it sits inside `Page`), so the
   * last visible card is cut by the window, not by a hard edge inside the content (VL-page-rhythm).
   */
  bleed?: boolean;
  className?: string;
  /** The title a card saves to My List: S on a focused card toggles it (its corner button is out of the Tab order). */
  myList?: ((item: T) => MyListTarget | undefined) | undefined;
}

/**
 * Horizontal rail of fixed-width cards (capped lists: recently added,
 * similar, known for). The rail is one Tab stop (roving tabindex): Tab lands
 * on the card you were last on, arrow keys move between cards, and S saves
 * the focused card to My List when the rail has `myList`. The step buttons
 * page by the visible width.
 */
export function PosterRail<T>({ title, items, render, loading, empty, action, count, seeAll, cardWidth: fixedWidth, bleed, className, myList }: PosterRailProps<T>) {
  const { t } = useTranslation('vod');
  const headingId = useId();
  const autoWidth = useRailCardWidth();
  const cardWidth = fixedWidth ?? autoWidth;
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  // The card holding the rail's Tab stop: the last one focused, clamped when the list shrinks.
  const [current, setCurrent] = useState(0);
  const tabStop = Math.max(0, Math.min(current, items.length - 1));
  const myListFocus = useMyListKeyFocus();
  const onCardFocus = (e: FocusEvent<HTMLDivElement>) => {
    myListFocus.onFocus();
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-grid-index]') : null;
    const index = Number(cell?.dataset['gridIndex']);
    if (cell && Number.isInteger(index) && index !== current) setCurrent(index);
  };

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

  const rail = (
    <section aria-labelledby={headingId} className={cn('min-w-0', className)}>
      {myList && (
        <MyListKey
          enabled={myListFocus.focused}
          targetAt={(i) => {
            const item = items[i];
            return item === undefined ? undefined : myList(item);
          }}
        />
      )}
      <SectionHeader
        id={headingId}
        title={title}
        count={count}
        seeAll={seeAll}
        className="mb-3"
        action={
          action || items.length > 0 ? (
            <>
              {action}
              {items.length > 0 && (
                // Touch screens swipe the track; the step buttons are for a mouse (no sideways wheel) and the keyboard.
                <span className="flex items-center gap-1 pointer-coarse:hidden">
                  <IconButton
                    size="sm"
                    label={t('railPrevious')}
                    icon={<ChevronLeft aria-hidden size={18} className="rtl:rotate-180" />}
                    disabled={edges.start}
                    onClick={() => page(-1)}
                    className="disabled:opacity-30"
                  />
                  <IconButton
                    size="sm"
                    label={t('railNext')}
                    icon={<ChevronRight aria-hidden size={18} className="rtl:rotate-180" />}
                    disabled={edges.end}
                    onClick={() => page(1)}
                    className="disabled:opacity-30"
                  />
                </span>
              )}
            </>
          ) : undefined
        }
      />
      {!loading && items.length === 0 ? (
        empty
      ) : (
        <div
          ref={scroller}
          role="list"
          onScroll={updateEdges}
          onFocus={onCardFocus}
          onBlur={myListFocus.onBlur}
          onKeyDown={(e) => handleGridKeyDown(e, { orientation: 'horizontal', count: items.length })}
          // Skeletons have nothing to focus, so the loading row clips instead of scrolling (axe scrollable-region-focusable).
          className={cn(
            'flex snap-x gap-4 pt-1 pb-3 motion-safe:scroll-smooth',
            // Bleeding through the gutter, the first card still snaps to the content edge (scroll padding = gutter).
            bleed ? '-mx-(--page-gutter) scroll-px-(--page-gutter) px-(--page-gutter)' : '-mx-1 scroll-px-1 px-1',
            loading ? 'overflow-x-hidden' : 'overflow-x-auto scrollbar-none',
          )}
        >
          {/* The posters fill the card, so they load at its width without measuring (SH-6). */}
          <PosterWidthContext.Provider value={cardWidth}>
            {loading
              ? Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="shrink-0" style={{ width: cardWidth }}>
                    <PosterCardSkeleton />
                  </div>
                ))
              : items.map((item, i) => (
                  <div key={i} role="listitem" className="shrink-0 snap-start" style={{ width: cardWidth }}>
                    {render(item, i, { tabIndex: i === tabStop ? 0 : -1 })}
                  </div>
                ))}
          </PosterWidthContext.Provider>
        </div>
      )}
    </section>
  );
  // A rail of savable titles shares one My List subscription, like a grid (VD-1), and its cards
  // know which titles are saved, so they draw the small saved chip instead of a standing toggle.
  return myList ? <GridMyListProvider>{rail}</GridMyListProvider> : rail;
}
