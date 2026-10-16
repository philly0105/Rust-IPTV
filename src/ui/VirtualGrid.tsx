import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from './cn';
import { scalePx, useDensity, useUiScale } from './scale';
import type { VirtualItemState } from './VirtualList';

export type GridAspect = number | 'poster' | 'wide' | 'square';

export function aspectRatio(aspect: GridAspect): number {
  if (typeof aspect === 'number') return aspect > 0 ? aspect : 2 / 3;
  return aspect === 'poster' ? 2 / 3 : aspect === 'wide' ? 16 / 9 : 1;
}

/** Column count and cell width for a container width. */
export function gridLayout(width: number, minColumnWidth: number, gap: number): { columns: number; cellWidth: number } {
  const columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
  const cellWidth = columns > 0 ? (width - gap * (columns - 1)) / columns : width;
  return { columns, cellWidth: Math.max(0, cellWidth) };
}

interface GridSlotProps {
  item: unknown;
  index: number;
  id: string;
  active: boolean;
  selected: boolean;
  setSize: number;
  render: (item: unknown, index: number, state: VirtualItemState) => ReactNode;
  onPick: (index: number) => void;
}

/**
 * One cell. Memoised with primitive props and a stable click handler, so a scroll that only
 * moves the window re-renders the rows that enter it, not every cell already on screen.
 */
const GridSlot = memo(function GridSlot({ item, index, id, active, selected, setSize, render, onPick }: GridSlotProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active || selected}
      aria-posinset={index + 1}
      aria-setsize={setSize}
      data-index={index}
      data-active={active || undefined}
      className="min-w-0"
      onClick={() => onPick(index)}
    >
      {render(item, index, { active, selected })}
    </div>
  );
});

export interface VirtualGridProps<T> {
  items: readonly T[];
  /**
   * Minimum cell width in px; columns are derived from the container width.
   * Like `gap` and `captionHeight`, given at 100 % UI scale and comfortable
   * density: the grid applies the active scale (and density, for width and gap).
   */
  minColumnWidth: number;
  /** Artwork aspect (width / height) or a named aspect. */
  aspect: GridAspect;
  render: (item: T, index: number, state: VirtualItemState) => ReactNode;
  onEndReached?: () => void;
  /** Rows before the end that trigger `onEndReached`. Default 2. */
  endThresholdRows?: number;
  /** Fixed extra height per cell below the artwork (title, meta). Default 52. */
  captionHeight?: number;
  gap?: number;
  overscan?: number;
  className?: string;
  onSelect?: (item: T, index: number) => void;
  getKey?: (item: T, index: number) => string | number;
  label?: string;
  selectedIndex?: number;
  footer?: ReactNode;
  initialRect?: { width: number; height: number };
  testId?: string;
  /**
   * Keyboard cursor on first mount (e.g. the title that was open before going
   * back). Read once; does not scroll (restore the scroll offset separately).
   */
  initialActiveIndex?: number;
}

/**
 * Virtualized responsive grid (rows virtualized). Focusable container with
 * aria-activedescendant; arrows move by cell / row, PageUp/Down by viewport,
 * Home/End, Enter selects.
 */
export function VirtualGrid<T>({
  items,
  minColumnWidth: baseMinColumnWidth,
  aspect,
  render,
  onEndReached,
  endThresholdRows = 2,
  captionHeight: baseCaptionHeight = 52,
  gap: baseGap = 16,
  overscan = 3,
  className,
  onSelect,
  getKey,
  label,
  selectedIndex,
  footer,
  initialRect = { width: 960, height: 720 },
  testId,
  initialActiveIndex,
}: VirtualGridProps<T>) {
  const uiScale = useUiScale();
  const density = useDensity();
  const minColumnWidth = scalePx(baseMinColumnWidth, uiScale, density, true);
  const gap = scalePx(baseGap, uiScale, density, true);
  // The caption holds text, which density does not shrink.
  const captionHeight = scalePx(baseCaptionHeight, uiScale, density);
  const parentRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [width, setWidth] = useState(initialRect.width);
  const [active, setActive] = useState(() =>
    initialActiveIndex !== undefined && initialActiveIndex >= 0 && initialActiveIndex < items.length ? initialActiveIndex : -1,
  );

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { columns, cellWidth } = gridLayout(width, minColumnWidth, gap);
  const rowHeight = Math.round(cellWidth / aspectRatio(aspect) + captionHeight);
  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + gap,
    overscan,
    initialRect,
    // A scroll event renders in the next frame with the others, not synchronously inside the
    // event (L2-vod-1: flushSync per event made a fast scroll a string of 50-100 ms tasks).
    useFlushSync: false,
  });

  useEffect(() => {
    virtualizer.measure();
    // remeasure when geometry changes
  }, [rowHeight, gap, columns]);

  const rows = virtualizer.getVirtualItems();
  const lastRow = rows.length > 0 ? rows[rows.length - 1]!.index : -1;
  const firedFor = useRef(-1);
  useEffect(() => {
    if (!onEndReached || items.length === 0) return;
    if (lastRow >= rowCount - 1 - endThresholdRows && firedFor.current !== items.length) {
      firedFor.current = items.length;
      onEndReached();
    }
  }, [lastRow, rowCount, endThresholdRows, items.length, onEndReached]);

  useEffect(() => {
    if (active >= items.length) setActive(items.length - 1);
  }, [items.length, active]);

  const moveTo = (i: number) => {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    setActive(next);
    virtualizer.scrollToIndex(Math.floor(next / columns), { align: 'auto' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const cur = active < 0 ? 0 : active;
    const visibleRows = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? rowHeight * 3) / (rowHeight + gap)));
    // Grid columns mirror in RTL, so the horizontal arrows swap meaning there.
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    switch (e.key) {
      case rtl ? 'ArrowLeft' : 'ArrowRight':
        moveTo(active < 0 ? 0 : cur + 1);
        break;
      case rtl ? 'ArrowRight' : 'ArrowLeft':
        moveTo(cur - 1);
        break;
      case 'ArrowDown':
        moveTo(active < 0 ? 0 : cur + columns);
        break;
      case 'ArrowUp':
        moveTo(cur - columns);
        break;
      case 'PageDown':
        moveTo(cur + columns * visibleRows);
        break;
      case 'PageUp':
        moveTo(cur - columns * visibleRows);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(items.length - 1);
        break;
      case 'Enter':
        if (active >= 0 && items[active] !== undefined) onSelect?.(items[active]!, active);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const cellId = (i: number) => `${baseId}-cell-${i}`;
  // The latest items and onSelect for the cells' shared, stable click handler.
  const latest = useRef({ items, onSelect });
  latest.current = { items, onSelect };
  const onPick = useCallback((index: number) => {
    const { items: list, onSelect: select } = latest.current;
    setActive(index);
    if (index < list.length) select?.(list[index]!, index);
  }, []);
  const renderCell = render as GridSlotProps['render'];

  return (
    <div
      ref={parentRef}
      role="listbox"
      aria-label={label}
      aria-orientation="horizontal"
      tabIndex={0}
      aria-activedescendant={active >= 0 && active < items.length ? cellId(active) : undefined}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget && active < 0 && items.length > 0) setActive(0);
      }}
      data-testid={testId}
      data-columns={columns}
      className={cn('relative h-full overflow-y-auto overscroll-contain', className)}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {rows.map((row) => {
          const start = row.index * columns;
          const cells = items.slice(start, start + columns);
          return (
            <div
              key={row.key}
              role="presentation"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: rowHeight,
                transform: `translateY(${row.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: gap,
              }}
            >
              {cells.map((item, j) => {
                const index = start + j;
                return (
                  <GridSlot
                    key={getKey ? getKey(item, index) : index}
                    item={item}
                    index={index}
                    id={cellId(index)}
                    active={index === active}
                    selected={index === selectedIndex}
                    setSize={items.length}
                    render={renderCell}
                    onPick={onPick}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
