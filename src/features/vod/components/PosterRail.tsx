import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { handleGridKeyDown } from '../lib/gridNav';
import { IconButton, cn } from '../_shim';
import { PosterCardSkeleton } from './PosterCard';

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
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
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
    el.scrollBy({ left: dir * Math.max(cardWidth, el.clientWidth - cardWidth), behavior: 'smooth' });
  };

  if (!loading && items.length === 0 && !empty) return null;

  return (
    <section aria-labelledby={headingId} className={cn('min-w-0', className)}>
      <div className="mb-3 flex items-end gap-3">
        <h2 id={headingId} className="text-base text-fg">
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {action}
          {items.length > 0 && (
            <>
              <IconButton
                size="sm"
                label={t('railPrevious')}
                icon={<ChevronLeft aria-hidden size={18} />}
                disabled={edges.start}
                onClick={() => page(-1)}
              />
              <IconButton
                size="sm"
                label={t('railNext')}
                icon={<ChevronRight aria-hidden size={18} />}
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
          className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pt-1 pb-3 motion-safe:scroll-smooth"
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
