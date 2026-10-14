/**
 * Wall geometry. Three layouts, each a fixed number of slots; tiles fill the slots in order
 * and the rest show an "Add channel" frame.
 *
 * Sizing: the wall host is a size container. Below 42rem of width the slots stack in one
 * column at 16:9 and the host scrolls. From 42rem the whole wall is fitted into the host
 * (`cqw`/`cqh`) at the aspect ratio that keeps every slot 16:9, and centered, like a monitor
 * wall: nothing is letterboxed twice and nothing scrolls.
 *
 * Ratios (gaps ignored, the video letterboxes the last pixels):
 * - 1x2: two 16:9 slots in a row, 32:9.
 * - 2x2: 16:9.
 * - 1+3 from 64rem: a 3/4-width slot beside three stacked ones, 64:27.
 * - 1+3 from 42rem: the large slot on top, three below, 4:3.
 *
 * Focus moves by geometry (`neighbour`), so arrow keys follow what is on screen in every
 * layout, width and writing direction.
 */

import type { MultiviewLayout } from './types';

export const MAX_TILES = 4;

export const LAYOUTS: readonly MultiviewLayout[] = ['1x2', '2x2', '1+3'];

const CAPACITY: Record<MultiviewLayout, number> = { '1x2': 2, '2x2': 4, '1+3': 4 };

export function isLayout(v: unknown): v is MultiviewLayout {
  return typeof v === 'string' && (LAYOUTS as readonly string[]).includes(v);
}

/** How many slots the layout has. */
export function capacityOf(layout: MultiviewLayout): number {
  return CAPACITY[layout];
}

/** Whether `count` tiles fit in `layout`. */
export function layoutFits(layout: MultiviewLayout, count: number): boolean {
  return count <= CAPACITY[layout];
}

/** `layout` when it holds `count` tiles; otherwise the 2x2 grid. */
export function fitLayout(layout: MultiviewLayout, count: number): MultiviewLayout {
  return layoutFits(layout, count) ? layout : '2x2';
}

/** The next layout in the cycle that holds `count` tiles (the `L` shortcut). */
export function nextLayout(layout: MultiviewLayout, count: number): MultiviewLayout {
  const start = LAYOUTS.indexOf(layout);
  for (let step = 1; step <= LAYOUTS.length; step++) {
    const candidate = LAYOUTS[(start + step) % LAYOUTS.length]!;
    if (layoutFits(candidate, count)) return candidate;
  }
  return layout;
}

/** Grid classes of the wall per layout (see the module comment for the ratios). */
export const WALL_CLASSES: Record<MultiviewLayout, string> = {
  '1x2':
    'grid-cols-1 @2xl:grid-cols-2 @2xl:grid-rows-1 @2xl:w-[min(100cqw,calc(100cqh*32/9))] @2xl:h-[min(100cqh,calc(100cqw*9/32))]',
  '2x2':
    'grid-cols-1 @2xl:grid-cols-2 @2xl:grid-rows-2 @2xl:w-[min(100cqw,calc(100cqh*16/9))] @2xl:h-[min(100cqh,calc(100cqw*9/16))]',
  '1+3':
    'grid-cols-1 @2xl:grid-cols-3 @2xl:grid-rows-[3fr_1fr] @2xl:w-[min(100cqw,calc(100cqh*4/3))] @2xl:h-[min(100cqh,calc(100cqw*3/4))] @5xl:grid-cols-[3fr_1fr] @5xl:grid-rows-3 @5xl:w-[min(100cqw,calc(100cqh*64/27))] @5xl:h-[min(100cqh,calc(100cqw*27/64))]',
};

/** Classes of one slot: 16:9 when stacked, the grid cell from 42rem; the large 1+3 slot spans. */
export function slotClass(layout: MultiviewLayout, index: number): string {
  const base = 'aspect-video min-w-0 @2xl:aspect-auto @2xl:min-h-0';
  if (layout === '1+3' && index === 0) return `${base} @2xl:col-span-3 @5xl:col-span-1 @5xl:row-span-3`;
  return base;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Arrow key to direction; anything else is null. */
export function directionOf(key: string): Direction | null {
  switch (key) {
    case 'ArrowLeft':
    case 'arrowleft':
      return 'left';
    case 'ArrowRight':
    case 'arrowright':
      return 'right';
    case 'ArrowUp':
    case 'arrowup':
      return 'up';
    case 'ArrowDown':
    case 'arrowdown':
      return 'down';
    default:
      return null;
  }
}

/** Length of the overlap of [a0, a1] and [b0, b1]; 0 when they do not overlap. */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * The slot to move focus to from `from` in `dir`, by on-screen position: the closest box
 * whose center lies in that direction, preferring boxes that share a row (or column) with
 * the current one. `null` when nothing lies that way. Boxes may be null (not measured).
 */
export function neighbour(boxes: readonly (Box | null)[], from: number, dir: Direction): number | null {
  const cur = boxes[from];
  if (!cur) return null;
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  const horizontal = dir === 'left' || dir === 'right';
  let best: number | null = null;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    if (!b || i === from) return;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const primary = dir === 'right' ? bx - cx : dir === 'left' ? cx - bx : dir === 'down' ? by - cy : cy - by;
    // Must lie in that direction by more than a rounding error.
    if (primary <= 1) return;
    const shared = horizontal
      ? overlap(cur.top, cur.top + cur.height, b.top, b.top + b.height)
      : overlap(cur.left, cur.left + cur.width, b.left, b.left + b.width);
    const offAxis = horizontal ? Math.abs(by - cy) : Math.abs(bx - cx);
    // A box in the same row (column) wins over a diagonal one; then the nearest.
    const score = (shared > 0 ? 0 : 1_000_000) + primary + offAxis * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
