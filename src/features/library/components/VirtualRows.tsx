/**
 * Virtualized list with section headers and roving keyboard focus.
 * ArrowUp/ArrowDown, Home/End and PageUp/PageDown move between focusable
 * rows (headers are skipped); only rendered rows exist in the DOM.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/ui/cn';

export interface RowBase {
  key: string;
  kind: string;
}

export interface RowRenderInfo {
  index: number;
  active: boolean;
}

export interface VirtualRowsProps<R extends RowBase> {
  rows: readonly R[];
  /** Fixed height per row; rows are not measured. */
  rowHeight: (row: R) => number;
  renderRow: (row: R, info: RowRenderInfo) => ReactNode;
  isFocusable: (row: R) => boolean;
  /** Accessible name of the list. */
  label: string;
  /** Called for keys the list does not handle itself, on the focused row. */
  onRowKeyDown?: (row: R, e: ReactKeyboardEvent<HTMLDivElement>, index: number) => void;
  /** Extra content rendered above the rows inside the scroll area (scrolls away). */
  header?: ReactNode;
  headerHeight?: number;
  className?: string;
  testId?: string;
}

export function VirtualRows<R extends RowBase>({
  rows,
  rowHeight,
  renderRow,
  isFocusable,
  label,
  onRowKeyDown,
  header,
  headerHeight = 0,
  className,
  testId,
}: VirtualRowsProps<R>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const row = rows[i];
      return row ? rowHeight(row) : 0;
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    scrollMargin: headerHeight,
    // jsdom has no layout; render a first screenful so tests see rows.
    initialRect: { width: 1024, height: 800 },
  });

  // Recompute sizes when the row set changes shape.
  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  const firstFocusable = rows.findIndex(isFocusable);
  const activeIndex = activeKey !== undefined ? rows.findIndex((r) => r.key === activeKey) : -1;
  const tabStop = activeIndex >= 0 && rows[activeIndex] && isFocusable(rows[activeIndex] as R) ? activeIndex : firstFocusable;

  const focusIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setActiveKey(row.key);
      virtualizer.scrollToIndex(index, { align: 'auto' });
      const tryFocus = (attempt: number) => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
        if (el) el.focus({ preventScroll: false });
        else if (attempt < 4) requestAnimationFrame(() => tryFocus(attempt + 1));
      };
      requestAnimationFrame(() => tryFocus(0));
    },
    [rows, virtualizer],
  );

  const step = useCallback(
    (from: number, delta: number): number => {
      let i = from;
      for (let n = 0; n < rows.length; n += 1) {
        i += delta;
        if (i < 0 || i >= rows.length) return from;
        const r = rows[i];
        if (r && isFocusable(r)) return i;
      }
      return from;
    },
    [rows, isFocusable],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (e.target !== e.currentTarget) {
      // Keys inside a row's own buttons stay with those buttons.
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) {
      // Modified keys belong to page shortcuts (e.g. alt+arrow reorder).
      const row = rows[index];
      if (row) onRowKeyDown?.(row, e, index);
      return;
    }
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 600) / 64));
    let next: number | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = step(index, 1);
        break;
      case 'ArrowUp':
        next = step(index, -1);
        break;
      case 'Home':
        next = firstFocusable;
        break;
      case 'End':
        next = step(rows.length, -1);
        break;
      case 'PageDown':
        next = step(Math.min(rows.length - 1, index + pageRows) - 1, 1);
        break;
      case 'PageUp':
        next = step(Math.max(0, index - pageRows) + 1, -1);
        break;
      default: {
        const row = rows[index];
        if (row) onRowKeyDown?.(row, e, index);
        return;
      }
    }
    e.preventDefault();
    if (next !== undefined && next >= 0 && next !== index) focusIndex(next);
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)} data-testid={testId}>
      {header}
      <div role="list" aria-label={label} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          const focusable = isFocusable(row);
          return (
            <div
              key={vi.key}
              role="listitem"
              data-row-index={vi.index}
              tabIndex={focusable ? (vi.index === tabStop ? 0 : -1) : undefined}
              onFocus={focusable ? () => setActiveKey(row.key) : undefined}
              onKeyDown={focusable ? (e) => onKeyDown(e, vi.index) : undefined}
              className="absolute start-0 top-0 w-full rounded-md focus-visible:outline-offset-[-2px]"
              style={{ height: vi.size, transform: `translateY(${vi.start - headerHeight}px)` }}
            >
              {renderRow(row, { index: vi.index, active: vi.index === activeIndex })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
