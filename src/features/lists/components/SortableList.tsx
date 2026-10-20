/**
 * A reorderable list for the manage and edit dialogs: drag by the grip, or
 * press Alt+ArrowUp / Alt+ArrowDown anywhere in a row. Plain ArrowUp/Down
 * moves focus to the same control in the row above or below. After a move
 * focus stays on the control that had it, and a polite live region says
 * where the row went.
 */

import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { TFunction } from 'i18next';
import { memo, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton, cn } from '../deps';

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
}

type Over = { key: string; where: 'before' | 'after' };

export function SortableList<T>(props: SortableListProps<T>) {
  const { items, getKey, getLabel, onMove, renderRow, label, locked, rowClassName, testId } = props;
  const { t } = useTranslation('lists');
  const [drag, setDrag] = useState<{ key: string; over?: Over } | null>(null);
  const [announce, setAnnounce] = useState('');
  const pendingFocus = useRef<{ key: string; part: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Put focus back on the control that had it once the moved row re-renders.
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want || !listRef.current) return;
    pendingFocus.current = null;
    const row = listRef.current.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(want.key)}"]`);
    const el = row?.querySelector<HTMLElement>(`[data-sort-part="${CSS.escape(want.part)}"]`) ?? row?.querySelector<HTMLElement>('[data-sort-part]');
    if (el && document.activeElement !== el) el.focus();
  });

  const moveBy = (index: number, delta: number, part: string) => {
    const to = index + delta;
    const item = items[index];
    if (!item || to < 0 || to >= items.length || locked?.(item)) return;
    pendingFocus.current = { key: getKey(item), part };
    onMove(index, to);
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
    const row = listRef.current?.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(getKey(next))}"]`);
    (row?.querySelector<HTMLElement>(`[data-sort-part="${CSS.escape(part)}"]`) ?? row?.querySelector<HTMLElement>('[data-sort-part]'))?.focus();
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

  return (
    <>
      <ul ref={listRef} aria-label={label} className="flex flex-col" data-testid={testId}>
        {items.map((item, index) => {
          const key = getKey(item);
          return (
            <SortableRow<T>
              key={key}
              item={item}
              index={index}
              count={items.length}
              rowKey={key}
              name={getLabel(item)}
              isLocked={locked?.(item) ?? false}
              over={drag?.over?.key === key ? drag.over.where : undefined}
              dragging={drag?.key === key}
              className={rowClassName?.(item)}
              renderRow={renderRow}
              handlers={handlers}
              t={t}
            />
          );
        })}
      </ul>
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
  count: number;
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
}

const SortableRow = memo(function SortableRow<T>({ item, index, count, rowKey: key, name, isLocked, over, dragging, className, renderRow, handlers, t }: SortableRowProps<T>) {
  return (
    <li
      data-sort-key={key}
      onKeyDown={(e) => handlers.keyDown(e, index)}
      onDragOver={(e) => handlers.dragOver(e, key)}
      onDrop={handlers.drop}
      className={cn(
        'relative flex min-h-12 items-center gap-1 border-b border-divider py-1.5 pe-1 ps-0.5 last:border-b-0',
        dragging && 'opacity-50',
        className,
      )}
    >
      {over ? (
        <span
          aria-hidden
          className={cn('pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-accent', over === 'before' ? '-top-px' : '-bottom-px')}
        />
      ) : null}
      <button
        type="button"
        draggable={!isLocked}
        disabled={isLocked}
        data-sort-part="grip"
        aria-label={t('dragHandle', { name })}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title={t('reorderHint')}
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
          disabled={isLocked || index === count - 1}
          data-sort-part="down"
          onClick={() => handlers.moveBy(index, 1, 'down')}
        />
      </span>
    </li>
  );
}) as <T>(props: SortableRowProps<T> & { key?: string }) => ReactElement;
