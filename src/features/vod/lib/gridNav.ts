/**
 * Arrow-key navigation for poster grids and rails.
 *
 * Cells are any focusable element carrying `data-grid-index`. Columns are
 * measured from the DOM (cells sharing the focused cell's row), so the helper
 * works with whatever column count the responsive grid picked. When the
 * target cell is outside the virtualized window it scrolls the nearest
 * scrollable ancestor by one row and retries on the next frames.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface GridNavOptions {
  /** Rails move only horizontally. */
  orientation?: 'grid' | 'horizontal';
  /** Total item count, so End and clamping know the last index. */
  count?: number;
}

const KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);

function cellOf(el: EventTarget | null): HTMLElement | null {
  return el instanceof HTMLElement ? el.closest<HTMLElement>('[data-grid-index]') : null;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const style = getComputedStyle(cur);
    if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function measureColumns(container: HTMLElement, cell: HTMLElement): number {
  const top = cell.getBoundingClientRect().top;
  let cols = 0;
  for (const c of container.querySelectorAll<HTMLElement>('[data-grid-index]')) {
    if (Math.abs(c.getBoundingClientRect().top - top) < 4) cols++;
  }
  return Math.max(1, cols);
}

/**
 * Pure target computation (exported for tests). Arrows follow the screen: in
 * RTL the next item sits to the left, so ArrowLeft moves forward.
 */
export function targetIndex(key: string, index: number, columns: number, count: number, rowsPerPage = 3, rtl = false): number | null {
  let next: number;
  switch (key) {
    case 'ArrowRight':
      next = rtl ? index - 1 : index + 1;
      break;
    case 'ArrowLeft':
      next = rtl ? index + 1 : index - 1;
      break;
    case 'ArrowDown':
      next = index + columns;
      break;
    case 'ArrowUp':
      next = index - columns;
      break;
    case 'PageDown':
      next = index + columns * rowsPerPage;
      break;
    case 'PageUp':
      next = index - columns * rowsPerPage;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return null;
  }
  if (count <= 0) return null;
  if (key === 'ArrowDown' || key === 'PageDown') next = Math.min(next, count - 1);
  if (key === 'ArrowUp' || key === 'PageUp') next = Math.max(next, 0);
  if (next < 0 || next >= count || next === index) return null;
  return next;
}

function focusIndex(container: HTMLElement, index: number, direction: number, attempt = 0): void {
  const el = container.querySelector<HTMLElement>(`[data-grid-index="${index}"]`);
  if (el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  if (attempt > 6) return;
  const anyCell = container.querySelector<HTMLElement>('[data-grid-index]');
  const scroller = scrollParent(anyCell);
  if (scroller) {
    const rowHeight = anyCell?.getBoundingClientRect().height || 200;
    scroller.scrollTop += direction * rowHeight;
  }
  requestAnimationFrame(() => focusIndex(container, index, direction, attempt + 1));
}

export function handleGridKeyDown(e: ReactKeyboardEvent<HTMLElement>, opts: GridNavOptions = {}): void {
  if (!KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const cell = cellOf(e.target);
  if (!cell) return;
  const container = e.currentTarget;
  const index = Number(cell.dataset['gridIndex']);
  if (!Number.isFinite(index)) return;
  const horizontal = opts.orientation === 'horizontal';
  if (horizontal && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown')) return;
  const count = opts.count ?? container.querySelectorAll('[data-grid-index]').length;
  const columns = horizontal ? Number.MAX_SAFE_INTEGER : measureColumns(container, cell);
  const rtl = getComputedStyle(container).direction === 'rtl';
  const next = targetIndex(e.key, index, columns, count, 3, rtl);
  if (next === null) return;
  e.preventDefault();
  focusIndex(container, next, Math.sign(next - index));
}
