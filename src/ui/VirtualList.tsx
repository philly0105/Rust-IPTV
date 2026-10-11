import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from './cn';

export interface VirtualItemState {
  /** Keyboard cursor is on this row. */
  active: boolean;
  /** Matches `selectedIndex` (e.g. the playing channel). */
  selected: boolean;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Fixed row height in px. */
  itemHeight: number;
  render: (item: T, index: number, state: VirtualItemState) => ReactNode;
  /** Called once per `items.length` when the last rows come into view. */
  onEndReached?: () => void;
  /** How many rows before the end trigger `onEndReached`. Default 10. */
  endThreshold?: number;
  selectedIndex?: number;
  overscan?: number;
  className?: string;
  /** Enter / click on a row. */
  onSelect?: (item: T, index: number) => void;
  /** Keyboard cursor moved. */
  onActiveChange?: (index: number) => void;
  getKey?: (item: T, index: number) => string | number;
  /** Accessible name for the listbox. */
  label?: string;
  /** Extra rows rendered after the items (e.g. a loading skeleton for the next page). */
  footer?: ReactNode;
  footerHeight?: number;
  /** Initial viewport size used before layout (tests, SSR). */
  initialRect?: { width: number; height: number };
  testId?: string;
}

/**
 * Virtualized single-column listbox. The container takes focus
 * (aria-activedescendant); ArrowUp/Down, PageUp/Down, Home/End move the
 * cursor, Enter selects. Size the container with className (e.g. `h-full`).
 */
export function VirtualList<T>({
  items,
  itemHeight,
  render,
  onEndReached,
  endThreshold = 10,
  selectedIndex,
  overscan = 8,
  className,
  onSelect,
  onActiveChange,
  getKey,
  label,
  footer,
  footerHeight = 0,
  initialRect = { width: 0, height: 600 },
  testId,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [active, setActive] = useState(() => (selectedIndex !== undefined && selectedIndex >= 0 ? selectedIndex : -1));

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan,
    initialRect,
    getItemKey: getKey ? (i) => getKey(items[i]!, i) : undefined,
  });

  // Follow external selection (e.g. channel zap) and keep it in view.
  useEffect(() => {
    if (selectedIndex === undefined || selectedIndex < 0 || selectedIndex >= items.length) return;
    setActive(selectedIndex);
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
    // virtualizer identity is stable per instance
  }, [selectedIndex]);

  // Clamp the cursor when the list shrinks.
  useEffect(() => {
    if (active >= items.length) setActive(items.length - 1);
  }, [items.length, active]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1]!.index : -1;
  const firedFor = useRef(-1);
  useEffect(() => {
    if (!onEndReached || items.length === 0) return;
    if (lastIndex >= items.length - 1 - endThreshold && firedFor.current !== items.length) {
      firedFor.current = items.length;
      onEndReached();
    }
  }, [lastIndex, items.length, endThreshold, onEndReached]);

  const moveTo = (i: number) => {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    setActive(next);
    onActiveChange?.(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // let row controls handle their own keys
    const page = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? itemHeight * 10) / itemHeight) - 1);
    const cur = active < 0 ? -1 : active;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(cur + 1);
        break;
      case 'ArrowUp':
        moveTo(cur <= 0 ? 0 : cur - 1);
        break;
      case 'PageDown':
        moveTo(cur + page);
        break;
      case 'PageUp':
        moveTo(cur - page);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(items.length - 1);
        break;
      case 'Enter':
        if (cur >= 0 && items[cur] !== undefined) onSelect?.(items[cur]!, cur);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const optionId = (i: number) => `${baseId}-opt-${i}`;

  return (
    <div
      ref={parentRef}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={active >= 0 && active < items.length ? optionId(active) : undefined}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget && active < 0 && items.length > 0) setActive(0);
      }}
      data-testid={testId}
      className={cn('relative h-full overflow-y-auto overscroll-contain', className)}
    >
      <div style={{ height: virtualizer.getTotalSize() + footerHeight, position: 'relative', width: '100%' }}>
        {virtualItems.map((vi) => {
          const item = items[vi.index]!;
          const state = { active: vi.index === active, selected: vi.index === selectedIndex };
          return (
            <div
              key={vi.key}
              id={optionId(vi.index)}
              role="option"
              aria-selected={state.selected || state.active}
              aria-posinset={vi.index + 1}
              aria-setsize={items.length}
              data-index={vi.index}
              data-active={state.active || undefined}
              onClick={() => {
                setActive(vi.index);
                onActiveChange?.(vi.index);
                onSelect?.(item, vi.index);
              }}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: itemHeight, transform: `translateY(${vi.start}px)` }}
            >
              {render(item, vi.index, state)}
            </div>
          );
        })}
        {footer && (
          <div style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}>{footer}</div>
        )}
      </div>
    </div>
  );
}
