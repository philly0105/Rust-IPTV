/**
 * A reorderable list for the manage and edit dialogs: drag by the grip, or
 * press Alt+ArrowUp / Alt+ArrowDown anywhere in a row. Plain ArrowUp/Down
 * moves focus to the same control in the row above or below. After a move
 * focus stays on the control that had it, and a polite live region says
 * where the row went. With `virtual`, only the rows near the screen are
 * mounted (Edit channels holds up to 2,000), and a keyboard move or step
 * scrolls its row into view.
 */

import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { TFunction } from 'i18next';
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton, Tooltip, cn, useListVirtualizer } from '../deps';

export interface SortableListProps<T> {
  items: readonly T[];
  getKey(item: T): string;
  getLabel(item: T): string;
  onMove(from: number, to: number): void;
  /** The row's content after the grip; mark focusable controls with `data-sort-part="<name>"` to keep focus across moves. */
  renderRow(item: T, index: number): ReactNode;
  /** Accessible name of the list. */
  label: string;
  /** Rows that cannot move (still saving, renaming). */
  locked?: (item: T) => boolean;
  /** Extra classes for a row (a flex row: the grip, `renderRow`'s content, then the move arrows below md). */
  rowClassName?: (item: T) => string | undefined;
  testId?: string;
  /**
   * Mount only the rows near the screen. The list then scrolls in its own box, with these classes
   * (its height cap and overflow), and every row is `rowHeight` px tall.
   */
  virtual?: { rowHeight: number; scrollerClassName: string };
}

type Over = { key: string; where: 'before' | 'after' };

export function SortableList<T>(props: SortableListProps<T>) {
  const { items, getKey, getLabel, onMove, renderRow, label, locked, rowClassName, testId, virtual } = props;
  const { t } = useTranslation('lists');
  const [drag, setDrag] = useState<{ key: string; over?: Over } | null>(null);
  const [announce, setAnnounce] = useState('');
  const pendingFocus = useRef<{ key: string; part: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // A dragged row stays mounted while it scrolls out of view: its dragend has to reach React.
  const dragIndex = drag ? items.findIndex((x) => getKey(x) === drag.key) : -1;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const shown = defaultRangeExtractor(range);
      return dragIndex < 0 || shown.includes(dragIndex) ? shown : [...shown, dragIndex].sort((a, b) => a - b);
    },
    [dragIndex],
  );
  const virtualizer = useListVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => virtual?.rowHeight ?? 0,
    overscan: 8,
    initialRect: { width: 480, height: 520 },
    rangeExtractor,
  });

  // Put focus back on the control that had it once the moved row re-renders. A virtual list may
  // render the row only once it has scrolled to it; a row that left the list is not waited for.
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(want.key)}"]`);
    if (!row && virtual && items.some((x) => getKey(x) === want.key)) return;
    pendingFocus.current = null;
    const el = row?.querySelector<HTMLElement>(`[data-sort-part="${CSS.escape(want.part)}"]`) ?? row?.querySelector<HTMLElement>('[data-sort-part]');
    if (el && document.activeElement !== el) el.focus();
  });

  /** Brings row `index` into view in a virtual list (an outer list shows every row). */
  const reveal = (index: number) => {
    if (virtual) virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  const moveBy = (index: number, delta: number, part: string) => {
    const to = index + delta;
    const item = items[index];
    if (!item || to < 0 || to >= items.length || locked?.(item)) return;
    pendingFocus.current = { key: getKey(item), part };
    onMove(index, to);
    reveal(to);
    setAnnounce(t('movedTo', { name: getLabel(item), position: to + 1, total: items.length }));
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.getAttribute('role') === 'switch') {
      if (!e.altKey) return;
    }
    const part = target.closest<HTMLElement>('[data-sort-part]')?.dataset.sortPart ?? 'grip';
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      moveBy(index, delta, part);
      return;
    }
    if (e.shiftKey) return;
    // Plain arrows walk the same control up and down the rows.
    const next = items[index + delta];
    if (!next) return;
    reveal(index + delta);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(getKey(next))}"]`);
    const el = row?.querySelector<HTMLElement>(`[data-sort-part="${CSS.escape(part)}"]`) ?? row?.querySelector<HTMLElement>('[data-sort-part]');
    if (el) el.focus();
    // Not mounted yet: the layout effect focuses it once the scroll has rendered it.
    else pendingFocus.current = { key: getKey(next), part };
  };

  const onDragOver = (e: DragEvent<HTMLLIElement>, key: string) => {
    if (!drag || drag.key === key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const where = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drag.over?.key !== key || drag.over.where !== where) setDrag({ key: drag.key, over: { key, where } });
  };

  const onDrop = (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    const d = drag;
    setDrag(null);
    if (!d?.over) return;
    const from = items.findIndex((x) => getKey(x) === d.key);
    let to = items.findIndex((x) => getKey(x) === d.over!.key);
    if (from < 0 || to < 0) return;
    if (d.over.where === 'after') to += 1;
    if (from < to) to -= 1;
    if (from === to) return;
    const item = items[from]!;
    onMove(from, to);
    setAnnounce(t('movedTo', { name: getLabel(item), position: to + 1, total: items.length }));
  };

  // Rows are memoized and get these stable handlers, so a drag-over re-renders the rows whose drop
  // marker changes, not all of a 2,000-channel list (LV-6).
  const latest = useRef({ onRowKeyDown, onDragOver, onDrop, moveBy, setDrag });
  latest.current = { onRowKeyDown, onDragOver, onDrop, moveBy, setDrag };
  const handlers = useMemo<RowHandlers>(
    () => ({
      keyDown: (e, index) => latest.current.onRowKeyDown(e, index),
      dragOver: (e, key) => latest.current.onDragOver(e, key),
      drop: (e) => latest.current.onDrop(e),
      dragStart: (key) => latest.current.setDrag({ key }),
      dragEnd: () => latest.current.setDrag(null),
      moveBy: (index, delta, part) => latest.current.moveBy(index, delta, part),
    }),
    [],
  );

  const row = (item: T, index: number, top?: number) => {
    const key = getKey(item);
    return (
      <SortableRow<T>
        key={key}
        item={item}
        index={index}
        last={index === items.length - 1}
        rowKey={key}
        name={getLabel(item)}
        isLocked={locked?.(item) ?? false}
        over={drag?.over?.key === key ? drag.over.where : undefined}
        dragging={drag?.key === key}
        className={rowClassName?.(item)}
        renderRow={renderRow}
        handlers={handlers}
        t={t}
        top={top}
        height={virtual?.rowHeight}
        setSize={virtual ? items.length : undefined}
      />
    );
  };

  const list = (
    <ul
      ref={listRef}
      aria-label={label}
      className="flex flex-col"
      data-testid={testId}
      style={virtual ? { position: 'relative', height: virtualizer.getTotalSize() } : undefined}
    >
      {virtual ? virtualizer.getVirtualItems().map((v) => row(items[v.index]!, v.index, v.start)) : items.map((item, index) => row(item, index))}
    </ul>
  );

  return (
    <>
      {virtual ? (
        <div ref={scrollerRef} className={virtual.scrollerClassName}>
          {list}
        </div>
      ) : (
        list
      )}
      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>
    </>
  );
}

interface RowHandlers {
  keyDown(e: KeyboardEvent<HTMLLIElement>, index: number): void;
  dragOver(e: DragEvent<HTMLLIElement>, key: string): void;
  drop(e: DragEvent<HTMLLIElement>): void;
  dragStart(key: string): void;
  dragEnd(): void;
  moveBy(index: number, delta: number, part: string): void;
}

interface SortableRowProps<T> {
  item: T;
  index: number;
  /** The last row: no border under it, and no Move down. Not the count, which every row would re-render for. */
  last: boolean;
  rowKey: string;
  name: string;
  isLocked: boolean;
  /** The drop marker on this row while a drag is over it. */
  over: Over['where'] | undefined;
  dragging: boolean;
  className: string | undefined;
  renderRow(item: T, index: number): ReactNode;
  handlers: RowHandlers;
  /** The `lists` namespace. */
  t: TFunction;
  /** In a virtual list: the row's offset and height, and the list's length for screen readers. */
  top?: number;
  height?: number;
  setSize?: number;
}

const SortableRow = memo(function SortableRow<T>({
  item,
  index,
  last,
  rowKey: key,
  name,
  isLocked,
  over,
  dragging,
  className,
  renderRow,
  handlers,
  t,
  top,
  height,
  setSize,
}: SortableRowProps<T>) {
  return (
    <li
      data-sort-key={key}
      aria-setsize={setSize}
      aria-posinset={setSize === undefined ? undefined : index + 1}
      style={top === undefined ? undefined : { position: 'absolute', top: 0, left: 0, right: 0, height, transform: `translateY(${top}px)` }}
      onKeyDown={(e) => handlers.keyDown(e, index)}
      onDragOver={(e) => handlers.dragOver(e, key)}
      onDrop={handlers.drop}
      className={cn(
        'relative flex min-h-12 items-center gap-1 border-divider py-1.5 pe-1 ps-0.5',
        !last && 'border-b',
        dragging && 'opacity-50',
        className,
      )}
    >
      {/* The drop marker: a mark, so the accent's mark tone (the text tone reads as brown in light). */}
      {over ? (
        <span
          aria-hidden
          data-testid="drop-marker"
          className={cn('pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-accent-mark', over === 'before' ? '-top-px' : '-bottom-px')}
        />
      ) : null}
      <Tooltip content={t('reorderHint')}>
        <button
          type="button"
          draggable={!isLocked}
          disabled={isLocked}
          data-sort-part="grip"
          aria-label={t('dragHandle', { name })}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', name);
            handlers.dragStart(key);
          }}
          onDragEnd={handlers.dragEnd}
          className="inline-flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      </Tooltip>
      {renderRow(item, index)}
      {/* Touch screens have no drag and drop: arrows instead, below tablet width.
          At the row's end, also when a row wraps onto a second line. */}
      <span className="ms-auto flex shrink-0 md:hidden">
        <IconButton
          size="sm"
          variant="ghost"
          label={t('moveUp', { name })}
          icon={<ArrowUp className="size-4" />}
          disabled={isLocked || index === 0}
          data-sort-part="up"
          onClick={() => handlers.moveBy(index, -1, 'up')}
        />
        <IconButton
          size="sm"
          variant="ghost"
          label={t('moveDown', { name })}
          icon={<ArrowDown className="size-4" />}
          disabled={isLocked || last}
          data-sort-part="down"
          onClick={() => handlers.moveBy(index, 1, 'down')}
        />
      </span>
    </li>
  );
}) as <T>(props: SortableRowProps<T> & { key?: string }) => ReactElement;
