/**
 * Keys on the wall itself, handled where focus is (React `onKeyDown` on the wall), so they
 * act on the focused slot and never reach the global shortcut registry:
 *
 * - arrows move focus to the slot that lies that way on screen (any layout, width, direction);
 * - Home and End go to the first and last slot;
 * - Delete (or Backspace) closes the focused tile;
 * - R replaces the focused tile's channel, S starts moving it (swap);
 * - Escape cancels a swap.
 *
 * Page-wide keys (1 to 4, F, M, L, A) are registered with the shell in the page.
 */

import { useCallback, type KeyboardEvent, type RefObject } from 'react';

import { directionOf, neighbour, type Box } from './layout';
import type { MultiviewTile } from './types';

export interface WallKeyboardOptions {
  wallRef: RefObject<HTMLElement | null>;
  tiles: readonly MultiviewTile[];
  swapFrom: string | null;
  onClose(key: string): void;
  onReplace(key: string): void;
  onSwapStart(key: string): void;
  onSwapTarget(key: string): void;
  onSwapCancel(): void;
}

/** The focusable element of each slot, by slot index. */
export function slotTargets(wall: HTMLElement): Map<number, HTMLElement> {
  const out = new Map<number, HTMLElement>();
  for (const el of wall.querySelectorAll<HTMLElement>('[data-slot-focus]')) {
    const i = Number(el.dataset['slotFocus']);
    if (Number.isInteger(i)) out.set(i, el);
  }
  return out;
}

/** Focuses slot `index` (its tile or its free frame) on the next frame, after React has drawn it. */
export function focusSlot(wall: HTMLElement | null, index: number): void {
  if (!wall) return;
  requestAnimationFrame(() => {
    const targets = slotTargets(wall);
    const el = targets.get(index) ?? targets.get(Math.max(0, targets.size - 1));
    el?.focus();
  });
}

/** The slot index of the element with focus inside the wall, from the nearest slot marker. */
function slotOf(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLElement)) return null;
  const marked = target.closest<HTMLElement>('[data-slot-focus], [data-slot]');
  if (!marked) return null;
  if (marked.dataset['slotFocus'] !== undefined) return Number(marked.dataset['slotFocus']);
  const n = Number(marked.dataset['slot']);
  return Number.isInteger(n) ? n - 1 : null;
}

const bareKey = (e: KeyboardEvent): boolean => !e.ctrlKey && !e.metaKey && !e.altKey;

export function useWallKeyboard(o: WallKeyboardOptions): (e: KeyboardEvent<HTMLElement>) => void {
  const { wallRef, tiles, swapFrom, onClose, onReplace, onSwapStart, onSwapTarget, onSwapCancel } = o;
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const wall = wallRef.current;
      if (!wall || e.defaultPrevented || e.nativeEvent.isComposing) return;
      const slot = slotOf(e.target);
      if (slot === null) return;
      const tile = tiles[slot];
      const claim = (): void => {
        e.preventDefault();
        e.stopPropagation();
      };

      const dir = bareKey(e) && !e.shiftKey ? directionOf(e.key) : null;
      if (dir) {
        const targets = slotTargets(wall);
        const boxes: (Box | null)[] = [];
        for (const [i, el] of targets) {
          const r = el.getBoundingClientRect();
          boxes[i] = { left: r.left, top: r.top, width: r.width, height: r.height };
        }
        claim();
        const next = neighbour(boxes, slot, dir);
        if (next !== null) targets.get(next)?.focus();
        return;
      }
      if (!bareKey(e)) return;

      switch (e.key) {
        case 'Home':
        case 'End': {
          const targets = slotTargets(wall);
          const indices = [...targets.keys()].sort((a, b) => a - b);
          const to = e.key === 'Home' ? indices[0] : indices[indices.length - 1];
          claim();
          if (to !== undefined) targets.get(to)?.focus();
          return;
        }
        case 'Escape':
          if (swapFrom === null) return;
          claim();
          onSwapCancel();
          return;
        case 'Delete':
        case 'Backspace':
          if (!tile || swapFrom !== null) return;
          claim();
          onClose(tile.key);
          return;
        case 'r':
        case 'R':
          if (!tile || swapFrom !== null || e.shiftKey) return;
          claim();
          onReplace(tile.key);
          return;
        case 's':
        case 'S':
          if (!tile || e.shiftKey) return;
          claim();
          if (swapFrom === null) onSwapStart(tile.key);
          else if (swapFrom === tile.key) onSwapCancel();
          else onSwapTarget(tile.key);
          return;
        default:
          return;
      }
    },
    [wallRef, tiles, swapFrom, onClose, onReplace, onSwapStart, onSwapTarget, onSwapCancel],
  );
}
