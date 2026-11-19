/**
 * The live tile cushion (`liveCushion.ts`): holds a live MPEG-TS tile paused until a few seconds
 * are buffered, at its start and after each stall, and says how each hold ended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachLiveCushion,
  bufferedAhead,
  CUSHION_POLL_MS,
  LIVE_CUSHION_S,
  LIVE_HOLD_MAX_MS,
  type CushionStall,
  type LiveCushion,
} from '../liveCushion';

/** A video element whose buffer, playhead and play state the test sets. */
function fakeVideo() {
  const el = document.createElement('video');
  const media = { ranges: [] as Array<[number, number]>, time: 0, paused: true };
  Object.defineProperties(el, {
    buffered: {
      get: () => ({
        length: media.ranges.length,
        start: (i: number) => media.ranges[i]![0],
        end: (i: number) => media.ranges[i]![1],
      }),
    },
    currentTime: { get: () => media.time },
    paused: { get: () => media.paused },
  });
  el.pause = vi.fn(() => {
    media.paused = true;
  });
  el.play = vi.fn(() => {
    media.paused = false;
    el.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  const fire = (type: string): void => void el.dispatchEvent(new Event(type));
  return { el, media, fire };
}

let v: ReturnType<typeof fakeVideo>;
let cushion: LiveCushion;
let stalls: CushionStall[];
let holds: number;

beforeEach(() => {
  vi.useFakeTimers();
  v = fakeVideo();
  stalls = [];
  holds = 0;
  cushion = attachLiveCushion(v.el, {
    play: () => void v.el.play(),
    onHold: () => void holds++,
    onStall: (s) => void stalls.push(s),
  });
});
afterEach(() => {
  cushion.destroy();
  vi.useRealTimers();
});

describe('bufferedAhead', () => {
  it('counts the range under the playhead only', () => {
    v.media.ranges = [[0, 4], [6, 10]];
    v.media.time = 1;
    expect(bufferedAhead(v.el)).toBe(3);
    v.media.time = 5;
    expect(bufferedAhead(v.el)).toBe(0);
    v.media.ranges = [];
    expect(bufferedAhead(v.el)).toBe(0);
  });
});

describe('the live tile cushion', () => {
  it('holds a tile that starts with less than the cushion, then plays once it fills', () => {
    v.media.ranges = [[0, 0.5]];
    v.media.paused = false;
    v.fire('playing');
    expect(cushion.holding()).toBe(true);
    expect(v.el.pause).toHaveBeenCalled();
    expect(holds).toBe(1);

    v.media.ranges = [[0, LIVE_CUSHION_S]];
    vi.advanceTimersByTime(CUSHION_POLL_MS);
    expect(cushion.holding()).toBe(false);
    expect(v.el.play).toHaveBeenCalledTimes(1);
    expect(stalls).toEqual([expect.objectContaining({ outcome: 'resumed', startup: true, aheadAtStallMs: 500, aheadAtResumeMs: 3000 })]);
  });

  it('lets a tile that starts with a full cushion play at once', () => {
    v.media.ranges = [[0, 5]];
    v.fire('playing');
    expect(cushion.holding()).toBe(false);
    expect(v.el.pause).not.toHaveBeenCalled();
  });

  it('holds after a stall mid-stream until the cushion is back', () => {
    v.media.ranges = [[0, 5]];
    v.fire('playing');
    v.media.time = 5;
    v.fire('waiting');
    expect(cushion.holding()).toBe(true);

    vi.advanceTimersByTime(2000);
    v.media.ranges = [[0, 7]];
    vi.advanceTimersByTime(CUSHION_POLL_MS);
    expect(cushion.holding()).toBe(true);
    v.media.ranges = [[0, 8]];
    vi.advanceTimersByTime(CUSHION_POLL_MS);
    expect(cushion.holding()).toBe(false);
    expect(stalls).toEqual([expect.objectContaining({ outcome: 'resumed', startup: false, aheadAtStallMs: 0 })]);
    expect(stalls[0]!.durationMs).toBe(2500);
  });

  it('pauses again when something else plays the tile during a hold', () => {
    v.media.ranges = [[0, 5]];
    v.fire('playing');
    v.media.time = 5;
    v.fire('waiting');
    vi.mocked(v.el.pause).mockClear();

    // An engine restart or a sound change plays the element.
    void v.el.play();
    expect(v.el.pause).toHaveBeenCalledTimes(1);
    expect(v.media.paused).toBe(true);
    expect(cushion.holding()).toBe(true);
    expect(holds).toBe(2);
  });

  it('plays on with what it has after the longest hold, but not with nothing', () => {
    v.media.ranges = [[0, 5]];
    v.fire('playing');
    v.media.time = 5;
    v.fire('waiting');
    vi.advanceTimersByTime(LIVE_HOLD_MAX_MS);
    expect(cushion.holding()).toBe(true);

    v.media.ranges = [[0, 6]];
    vi.advanceTimersByTime(CUSHION_POLL_MS);
    expect(cushion.holding()).toBe(false);
    expect(stalls).toEqual([expect.objectContaining({ outcome: 'timedOut', aheadAtResumeMs: 1000 })]);
  });

  it('reports a hold the tile closed during as abandoned', () => {
    v.media.ranges = [[0, 5]];
    v.fire('playing');
    v.media.time = 5;
    v.fire('waiting');
    vi.advanceTimersByTime(1000);
    cushion.destroy();
    expect(cushion.holding()).toBe(false);
    expect(stalls).toEqual([expect.objectContaining({ outcome: 'abandoned', startup: false, durationMs: 1000 })]);
    // Nothing plays a destroyed cushion's element.
    vi.advanceTimersByTime(LIVE_HOLD_MAX_MS);
    expect(v.el.play).not.toHaveBeenCalled();
  });
});
