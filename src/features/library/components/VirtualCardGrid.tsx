/**
 * Virtualized responsive card grid. Columns follow the container width;
 * only visible rows of cards are rendered. Arrow keys move focus in two
 * dimensions, Home/End jump to the ends.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@/ui/cn';

export interface VirtualCardGridProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  /** Card body. The grid owns the focusable wrapper. */
  render: (item: T, info: { index: number }) => ReactNode;
  onActivate: (item: T) => void;
  /** Extra key handling on a focused card. */
  onCardKeyDown?: (item: T, e: KeyboardEvent<HTMLDivElement>) => void;
  /** Accessible name for a card. */
  cardLabel: (item: T) => string;
  label: string;
  minColumnWidth?: number;
  gap?: number;
  /** width / height of the artwork. */
  aspect?: number;
  /** Fixed height of the text block under the artwork. */
  captionHeight?: number;
  className?: string;
  testId?: string;
}

export function VirtualCardGrid<T>({
  items,
  itemKey,
  render,
  onActivate,
  onCardKeyDown,
  cardLabel,
  label,
  minColumnWidth = 168,
  gap = 20,
  aspect = 2 / 3,
  captionHeight = 64,
  className,
  testId,
}: VirtualCardGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1024);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const rowHeight = Math.round(cardWidth / aspect + captionHeight + gap);
  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    initialRect: { width: 1024, height: 800 },
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, columns, virtualizer]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  const focusIndex = useCallback(
    (i: number) => {
      const index = Math.max(0, Math.min(items.length - 1, i));
      setActive(index);
      virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'auto' });
      const tryFocus = (attempt: number) => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-card-index="${index}"]`);
        if (el) el.focus();
        else if (attempt < 4) requestAnimationFrame(() => tryFocus(attempt + 1));
      };
      requestAnimationFrame(() => tryFocus(0));
    },
    [columns, items.length, virtualizer],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number, item: T) => {
    if (e.target !== e.currentTarget) return;
    // Arrows follow the screen: an RTL grid flows right to left, so ArrowLeft moves forward.
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const moves: Record<string, number> = {
      ArrowRight: rtl ? index - 1 : index + 1,
      ArrowLeft: rtl ? index + 1 : index - 1,
      ArrowDown: index + columns,
      ArrowUp: index - columns,
      Home: 0,
      End: items.length - 1,
    };
    const next = moves[e.key];
    if (next !== undefined) {
      e.preventDefault();
      if (next >= 0 && next < items.length) focusIndex(next);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onActivate(item);
      return;
    }
    onCardKeyDown?.(item, e);
  };

  return (
    <div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)} data-testid={testId}>
      <div role="list" aria-label={label} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vr) => {
          const start = vr.index * columns;
          const slice = items.slice(start, start + columns);
          return (
            <div
              key={vr.key}
              className="absolute start-0 top-0 grid w-full"
              style={{
                transform: `translateY(${vr.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: gap,
                height: rowHeight - gap,
              }}
            >
              {slice.map((item, j) => {
                const index = start + j;
                return (
                  <div
                    key={itemKey(item)}
                    role="listitem"
                    aria-label={cardLabel(item)}
                    tabIndex={index === active ? 0 : -1}
                    data-card-index={index}
                    onFocus={() => setActive(index)}
                    onKeyDown={(e) => onKeyDown(e, index, item)}
                    onClick={() => onActivate(item)}
                    className="group min-w-0 cursor-pointer rounded-lg"
                  >
                    {render(item, { index })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
