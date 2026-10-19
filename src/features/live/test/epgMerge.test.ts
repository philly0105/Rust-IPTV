import { describe, expect, it, vi } from 'vitest';

import type { EpgProgram, ItemRef } from '@/api/types';

import { mergePrograms, nowNextFrom, preferNowNext } from '../lib/epgMerge';
import { HOUR, MINUTE } from '../lib/epgTime';
import { StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';

const T = Date.UTC(2026, 9, 11, 12, 0, 0);
const p = (title: string, s: number, e: number): EpgProgram => ({ channelId: 'x', title, start: new Date(s).toISOString(), end: new Date(e).toISOString() });
const ref = (id: string): ItemRef => ({ sourceId: 's', contentType: 'live', itemId: id });

describe('mergePrograms', () => {
  it('keeps the primary list and fills gaps from the secondary', () => {
    const portal = [p('Portal now', T - 10 * MINUTE, T + 20 * MINUTE), p('Portal next', T + 20 * MINUTE, T + HOUR)];
    const xmltv = [
      p('X past', T - HOUR, T - 10 * MINUTE),
      p('X overlapping', T - 15 * MINUTE, T + 15 * MINUTE),
      p('X later', T + HOUR, T + 2 * HOUR),
    ];
    expect(mergePrograms(portal, xmltv).map((x) => x.title)).toEqual(['X past', 'Portal now', 'Portal next', 'X later']);
  });

  it('trims a secondary programme that only grazes a primary one instead of dropping it', () => {
    const portal = [p('Portal now', T, T + HOUR)];
    const xmltv = [p('X past', T - HOUR, T + 2 * MINUTE)];
    const merged = mergePrograms(portal, xmltv);
    expect(merged.map((x) => x.title)).toEqual(['X past', 'Portal now']);
    expect(merged[0]!.end).toBe(new Date(T).toISOString());
    expect(merged[0]!.start).toBe(xmltv[0]!.start);
  });

  it('falls back to the secondary list, sorted, when the primary is empty', () => {
    expect(mergePrograms([], [p('B', T + HOUR, T + 2 * HOUR), p('A', T, T + HOUR)]).map((x) => x.title)).toEqual(['A', 'B']);
  });

  it('drops zero-length and inverted programmes', () => {
    expect(mergePrograms([p('bad', T, T)], [p('ok', T, T + HOUR), p('inv', T + HOUR, T)]).map((x) => x.title)).toEqual(['ok']);
  });
});

describe('nowNextFrom / preferNowNext', () => {
  it('finds the airing and the following programme', () => {
    const list = [p('next', T + 30 * MINUTE, T + HOUR), p('now', T - 5 * MINUTE, T + 30 * MINUTE), p('old', T - HOUR, T - 5 * MINUTE)];
    expect(nowNextFrom(list, T)).toEqual({ now: list[1], next: list[0] });
  });

  it('gives the same object for the same list at the same time, so memoized rows keep their render (LV-3)', () => {
    const list = [p('now', T - 5 * MINUTE, T + 30 * MINUTE), p('next', T + 30 * MINUTE, T + HOUR)];
    const first = nowNextFrom(list, T);
    expect(nowNextFrom(list, T)).toBe(first);
    const later = nowNextFrom(list, T + 40 * MINUTE);
    expect(later).toEqual({ now: list[1], next: undefined });
    expect(nowNextFrom([...list], T)).toEqual(first);
  });

  it('reports only a next programme when nothing airs', () => {
    const list = [p('later', T + HOUR, T + 2 * HOUR)];
    expect(nowNextFrom(list, T)).toEqual({ next: list[0] });
    expect(nowNextFrom([], T)).toBeUndefined();
  });

  it('prefers whichever side has something airing, primary first', () => {
    const a = { now: p('a', T - 1, T + 1) };
    const b = { now: p('b', T - 1, T + 1) };
    expect(preferNowNext(a, b)).toBe(a);
    expect(preferNowNext({ next: a.now }, b)).toBe(b);
    expect(preferNowNext(undefined, b)).toBe(b);
    expect(preferNowNext(undefined, undefined)).toBeUndefined();
  });
});

describe('StalkerPreviewQueue', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('fetches only what is missing, at most `concurrency` at a time and `maxPerSync` per sync', async () => {
    let active = 0;
    let peak = 0;
    const fetched: string[] = [];
    const fetch = vi.fn(async (r: ItemRef) => {
      active++;
      peak = Math.max(peak, active);
      fetched.push(r.itemId);
      await flush();
      active--;
      return [p(`show ${r.itemId}`, Date.now() - MINUTE, Date.now() + HOUR)];
    });
    const onUpdate = vi.fn();
    const q = new StalkerPreviewQueue(fetch, onUpdate, { concurrency: 2, delayMs: 0, maxPerSync: 5 });
    q.sync(Array.from({ length: 12 }, (_, i) => ref(`c${i}`)));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(5));
    expect(peak).toBeLessThanOrEqual(2);
    expect(fetched).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(q.get(ref('c0'))?.[0]?.title).toBe('show c0');
    expect(q.get(ref('c9'))).toBeUndefined();

    // cached rows are not asked again; the next sync picks up where the window moved
    q.sync([ref('c0'), ref('c1'), ref('c5')]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
    expect(fetched.at(-1)).toBe('c5');
  });

  it('caches failures briefly as empty and refetches once the airing programme ends', async () => {
    let clock = T;
    const fetch = vi.fn(async (r: ItemRef) => {
      if (r.itemId === 'bad') throw new Error('portal down');
      return [p('short', T - MINUTE, T + 5 * MINUTE)];
    });
    const q = new StalkerPreviewQueue(fetch, () => undefined, { delayMs: 0, clock: () => clock, emptyTtlMs: 60_000 });
    q.sync([ref('bad'), ref('ok')]);
    await vi.waitFor(() => expect(q.get(ref('ok'))).toHaveLength(1));
    expect(q.get(ref('bad'))).toEqual([]);
    q.sync([ref('bad'), ref('ok')]);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);

    clock = T + 6 * MINUTE; // the cached programme has ended, the failure has expired
    expect(q.get(ref('ok'))).toBeUndefined();
    q.sync([ref('bad'), ref('ok')]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  });

  it('drops answers that arrive after a reset', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const onUpdate = vi.fn();
    const q = new StalkerPreviewQueue(
      async () => {
        await gate;
        return [p('late', Date.now() - MINUTE, Date.now() + HOUR)];
      },
      onUpdate,
      { delayMs: 0 },
    );
    q.sync([ref('a')]);
    q.reset();
    release();
    await flush();
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(q.get(ref('a'))).toBeUndefined();
  });
});
