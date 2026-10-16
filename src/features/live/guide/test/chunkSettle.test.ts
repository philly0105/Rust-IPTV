/**
 * L3-live-guide-x1: when the guide asks for the chunks a vertical scroll reaches. A fling that
 * stops is answered once the scroll has been idle GRID_SCROLL_IDLE_MS, not GRID_CHUNK_SETTLE_MS
 * after the last chunk change; a scroll slowing down asks at once; a cached chunk shows in its
 * slot at once while a chunk the fling only passes is not asked for. Pure maths, no timers, so
 * a busy machine cannot change the answers.
 */
import { describe, expect, it } from 'vitest';

import {
  chunkSettleWait,
  GRID_CHUNK,
  GRID_CHUNK_SETTLE_MS,
  GRID_ROW,
  GRID_SCROLL_IDLE_MS,
  GRID_SLOW_PX_PER_MS,
  shownChunks,
} from '../../components/EpgGridPage';

/** vertical.mjs: 1200 px wheel steps about 27 ms apart. */
const FLING = 1200 / 27;

describe('chunkSettleWait', () => {
  it('the first chunk change after a pause is asked at once, however fast', () => {
    expect(chunkSettleWait(true, FLING, 0, 0)).toBe(0);
  });

  it('a scroll slower than a chunk per two settles is asked at once', () => {
    // At this speed a chunk stays on screen at least twice the settle.
    expect((GRID_CHUNK * GRID_ROW) / GRID_SLOW_PX_PER_MS).toBeCloseTo(2 * GRID_CHUNK_SETTLE_MS);
    expect(chunkSettleWait(false, GRID_SLOW_PX_PER_MS - 0.01, 0, 0)).toBe(0);
    expect(chunkSettleWait(false, 1, 0, 0)).toBe(0);
    expect(chunkSettleWait(false, GRID_SLOW_PX_PER_MS, 0, 0)).toBeGreaterThan(0);
  });

  it('a fling waits while it keeps scrolling', () => {
    expect(chunkSettleWait(false, FLING, 0, 0)).toBe(GRID_SCROLL_IDLE_MS);
    expect(chunkSettleWait(false, FLING, 10, 30)).toBe(GRID_SCROLL_IDLE_MS - 10);
  });

  it('a fling that stops is asked once it has been idle, well before the settle', () => {
    expect(GRID_SCROLL_IDLE_MS).toBeLessThan(GRID_CHUNK_SETTLE_MS);
    // Last scroll event at the chunk change; nothing since.
    expect(chunkSettleWait(false, FLING, GRID_SCROLL_IDLE_MS, GRID_SCROLL_IDLE_MS)).toBe(0);
    expect(chunkSettleWait(false, FLING, GRID_SCROLL_IDLE_MS + 5, 60)).toBe(0);
  });

  it('a chunk that holds the settle is asked even while the scroll goes on', () => {
    expect(chunkSettleWait(false, FLING, 0, GRID_CHUNK_SETTLE_MS - 5)).toBe(5);
    expect(chunkSettleWait(false, FLING, 0, GRID_CHUNK_SETTLE_MS)).toBe(0);
    expect(chunkSettleWait(false, FLING, 0, GRID_CHUNK_SETTLE_MS + 40)).toBe(0);
  });

  it('a scroll that never sent an event (keyboard, a list change) is not held', () => {
    expect(chunkSettleWait(false, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0)).toBe(0);
  });
});

describe('shownChunks', () => {
  const none = () => false;
  const only = (...chunks: number[]) => (c: number) => chunks.includes(c);

  it('at rest, or on a new list, both slots follow the view', () => {
    expect(shownChunks({ a: 6, b: 7 }, { a: 2, b: 3 }, true, none)).toEqual({ a: 6, b: 7 });
  });

  it('chunks a fling passes are not asked for: both slots keep the settled chunks', () => {
    expect(shownChunks({ a: 6, b: 7 }, { a: 2, b: 3 }, false, none)).toEqual({ a: 2, b: 3 });
    // The view inside one chunk as well (the screen is shorter than a chunk).
    expect(shownChunks({ a: 6, b: 6 }, { a: 2, b: 3 }, false, none)).toEqual({ a: 2, b: 3 });
  });

  it('a cached chunk shows in its slot at once, whatever the other slot', () => {
    expect(shownChunks({ a: 6, b: 7 }, { a: 2, b: 3 }, false, only(7))).toEqual({ a: 2, b: 7 });
    expect(shownChunks({ a: 6, b: 7 }, { a: 2, b: 3 }, false, only(6))).toEqual({ a: 6, b: 3 });
    expect(shownChunks({ a: 6, b: 6 }, { a: 2, b: 3 }, false, only(6))).toEqual({ a: 6, b: 6 });
  });
});
