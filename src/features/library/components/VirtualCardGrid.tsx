/**
 * Virtualized responsive card grid. Columns follow the container width;
 * only visible rows of cards are rendered. Arrow keys move focus in two
 * dimensions, Home/End jump to the ends. With `restoreKey`, the scroll
 * position and the focused card survive leaving the page: Back to the same
 * history entry lands where the user was, with focus on the card they opened.
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
  /**
   * Identifies this grid in this history entry (e.g. the location key), so
   * returning to it restores scroll and focus. Omit to always start at the top.
   */
  restoreKey?: string;
}

interface SavedGrid {
  offset: number;
  active: number;
  width: number;
  /** The user left by opening a card: focus goes back to it on return. */
  focus: boolean;
}

/** Last state per `restoreKey`. Bounded: only recent history entries can be returned to. */
const saved = new Map<string, SavedGrid>();
const SAVED_LIMIT = 20;

function remember(key: string, state: SavedGrid): void {
  saved.delete(key);
  saved.set(key, state);
  if (saved.size > SAVED_LIMIT) saved.delete(saved.keys().next().value as string);
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
  restoreKey,
}: VirtualCardGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read once: what this history entry looked like when the user left it.
  const [restore] = useState(() => (restoreKey ? saved.get(restoreKey) : undefined));
  const [width, setWidth] = useState(restore?.width ?? 1024);
  const [active, setActive] = useState(restore?.active ?? 0);
  const offsetRef = useRef(restore?.offset ?? 0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const widthRef = useRef(width);
  widthRef.current = width;
  const openedRef = useRef(false);

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
    // The saved width gives the first render the same row height as before, so the
    // saved offset lands on the same rows.
    initialRect: { width: restore?.width ?? 1024, height: 800 },
    initialOffset: restore?.offset ?? 0,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, columns, virtualizer]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  // Remember where the user was when the grid goes away (opening a card, or any navigation).
  useEffect(() => {
    if (!restoreKey) return;
    return () => remember(restoreKey, { offset: offsetRef.current, active: activeRef.current, width: widthRef.current, focus: openedRef.current });
  }, [restoreKey]);

  // Back on the same entry: settle the offset once rows have their real height, then
  // put focus on the card that was opened (no scroll jump: the offset already shows it).
  useEffect(() => {
    if (!restore) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (Math.abs(el.scrollTop - restore.offset) > 1) el.scrollTop = restore.offset;
      if (!restore.focus) return;
      const card = el.querySelector<HTMLElement>(`[data-card-index="${restore.active}"]`);
      card?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [restore]);

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

  const open = (index: number, item: T) => {
    openedRef.current = true;
    activeRef.current = index;
    setActive(index);
    onActivate(item);
  };

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
      open(index, item);
      return;
    }
    onCardKeyDown?.(item, e);
  };

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        offsetRef.current = e.currentTarget.scrollTop;
      }}
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      data-testid={testId}
    >
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
                    onClick={() => open(index, item)}
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
