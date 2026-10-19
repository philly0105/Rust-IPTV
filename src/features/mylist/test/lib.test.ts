import { describe, expect, it, vi } from 'vitest';

import type { ItemRef, WatchlistEntry } from '@/api/types';

import {
  buildView,
  canSave,
  draftEntry,
  fold,
  keysOf,
  matchesQuery,
  moveInSubset,
  parseFilter,
  parseSort,
  reinsertRef,
  relativeTime,
  sortEntries,
} from '../lib/list';

const r = (contentType: 'movie' | 'series', itemId: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType, itemId });
const e = (ref: ItemRef, title: string, extra: Partial<WatchlistEntry> & { subtitle?: string } = {}): WatchlistEntry => ({
  ref,
  snapshot: { title, contentType: ref.contentType, ...(extra.subtitle ? { subtitle: extra.subtitle } : {}) },
  addedAt: extra.addedAt ?? '2026-10-01T10:00:00.000Z',
  watched: extra.watched ?? false,
});
const titles = (l: readonly WatchlistEntry[]) => l.map((x) => x.snapshot.title);

describe('URL params', () => {
  it('falls back to the defaults for anything unknown', () => {
    expect(parseFilter('movie')).toBe('movie');
    expect(parseFilter('series')).toBe('series');
    expect(parseFilter('live')).toBe('all');
    expect(parseFilter(null)).toBe('all');
    expect(parseSort('added')).toBe('added');
    expect(parseSort('title')).toBe('title');
    expect(parseSort('random')).toBe('order');
    expect(parseSort(undefined)).toBe('order');
  });
});

describe('canSave', () => {
  it('accepts movies and series only', () => {
    expect(canSave({ contentType: 'movie' })).toBe(true);
    expect(canSave({ contentType: 'series' })).toBe(true);
    expect(canSave({ contentType: 'live' })).toBe(false);
    expect(canSave({ contentType: 'radio' })).toBe(false);
  });
});

describe('keysOf', () => {
  it('keys entries as sourceId|contentType|itemId and caches per list', () => {
    const list = [e(r('movie', 'm1'), 'A'), e(r('series', 's1', 'src2'), 'B')];
    const keys = keysOf(list);
    expect([...keys]).toEqual(['src1|movie|m1', 'src2|series|s1']);
    expect(keysOf(list)).toBe(keys);
    expect(keysOf(undefined).size).toBe(0);
  });
});

describe('search', () => {
  it('folds case and accents', () => {
    expect(fold('Amélie ÇA')).toBe('amelie ca');
  });

  it('needs every word, in the title or the subtitle', () => {
    const x = e(r('movie', 'm1'), 'Amélie', { subtitle: '2001 · Comedy' });
    expect(matchesQuery(x, 'amelie')).toBe(true);
    expect(matchesQuery(x, 'amelie comedy')).toBe(true);
    expect(matchesQuery(x, 'amelie drama')).toBe(false);
    expect(matchesQuery(x, '   ')).toBe(true);
  });
});

describe('sortEntries', () => {
  const list = [
    e(r('movie', 'a'), 'Movie 10', { addedAt: '2026-10-02T00:00:00Z' }),
    e(r('movie', 'b'), 'movie 2', { addedAt: '2026-10-05T00:00:00Z' }),
    e(r('movie', 'c'), 'Zulu', { addedAt: 'not a date' }),
    e(r('movie', 'd'), 'Alpha', { addedAt: '2026-10-03T00:00:00Z' }),
  ];

  it('keeps the user order', () => {
    expect(titles(sortEntries(list, 'order', 'en'))).toEqual(['Movie 10', 'movie 2', 'Zulu', 'Alpha']);
  });

  it('puts the newest add first and unreadable dates last', () => {
    expect(titles(sortEntries(list, 'added', 'en'))).toEqual(['movie 2', 'Alpha', 'Movie 10', 'Zulu']);
  });

  it('sorts titles case-blind and with numbers in numeric order', () => {
    expect(titles(sortEntries(list, 'title', 'en'))).toEqual(['Alpha', 'movie 2', 'Movie 10', 'Zulu']);
  });

  it('never mutates its input', () => {
    const before = titles(list);
    sortEntries(list, 'title', 'en');
    expect(titles(list)).toEqual(before);
  });
});

describe('buildView', () => {
  const list = [
    e(r('movie', 'm1'), 'Arrival', { watched: true }),
    e(r('series', 's1'), 'Severance'),
    e(r('movie', 'm2', 'src2'), 'Blade Runner'),
    e(r('series', 's2'), 'Dark', { watched: true }),
  ];
  const base = { filter: 'all', sort: 'order', hideWatched: false, query: '', language: 'en' } as const;

  it('counts every type and the watched entries', () => {
    const v = buildView(list, base);
    expect(v.counts).toEqual({ all: 4, movie: 2, series: 2 });
    expect(v.watchedCount).toBe(2);
    expect(titles(v.rows)).toEqual(['Arrival', 'Severance', 'Blade Runner', 'Dark']);
  });

  it('narrows by type, then watched, then search, keeping each stage', () => {
    const v = buildView(list, { ...base, filter: 'movie', hideWatched: true, query: 'blade' });
    expect(titles(v.typed)).toEqual(['Arrival', 'Blade Runner']);
    expect(titles(v.unwatched)).toEqual(['Blade Runner']);
    expect(titles(v.rows)).toEqual(['Blade Runner']);
  });

  it('leaves out sources waiting out their removal undo', () => {
    const v = buildView(list, { ...base, hiddenSources: new Set(['src2']) });
    expect(titles(v.base)).toEqual(['Arrival', 'Severance', 'Dark']);
    expect(v.counts.all).toBe(3);
  });

  it('sorts the rows it lists', () => {
    expect(titles(buildView(list, { ...base, sort: 'title' }).rows)).toEqual(['Arrival', 'Blade Runner', 'Dark', 'Severance']);
  });
});

describe('per-keystroke work (VD-9)', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    e(r('movie', `m${i}`), `Amélie ${i}`, { addedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }),
  );

  it('parses each date once when sorting by date added', () => {
    const parse = vi.spyOn(Date, 'parse');
    try {
      const sorted = sortEntries(many, 'added', 'en');
      expect(sorted[0]!.snapshot.title).toBe('Amélie 49');
      expect(parse).toHaveBeenCalledTimes(many.length);
    } finally {
      parse.mockRestore();
    }
  });

  it('folds each entry once across searches', () => {
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      const o = { filter: 'all' as const, sort: 'order' as const, hideWatched: false, language: 'en' };
      buildView(many, { ...o, query: 'ame' });
      const first = normalize.mock.calls.length;
      expect(buildView(many, { ...o, query: 'amelie 4' }).rows).toHaveLength(14);
      // Only the query itself is folded again.
      expect(normalize.mock.calls.length - first).toBe(1);
    } finally {
      normalize.mockRestore();
    }
  });
});

describe('moveInSubset', () => {
  const m1 = e(r('movie', 'm1'), 'M1');
  const s1 = e(r('series', 's1'), 'S1');
  const m2 = e(r('movie', 'm2'), 'M2');
  const s2 = e(r('series', 's2'), 'S2');
  const m3 = e(r('movie', 'm3'), 'M3');
  const all = [m1, s1, m2, s2, m3];

  it('moves within the whole list', () => {
    expect(titles(moveInSubset(all, all, m3.ref, 0))).toEqual(['M3', 'M1', 'S1', 'M2', 'S2']);
    expect(titles(moveInSubset(all, all, m1.ref, 2))).toEqual(['S1', 'M2', 'M1', 'S2', 'M3']);
  });

  it('reshuffles only the rows on screen; the others keep their slots', () => {
    const movies = [m1, m2, m3];
    // M3 to the top of the movie view: series S1 and S2 stay at slots 1 and 3.
    expect(titles(moveInSubset(all, movies, m3.ref, 0))).toEqual(['M3', 'S1', 'M1', 'S2', 'M2']);
  });

  it('clamps the target and returns the same list when nothing moves', () => {
    expect(titles(moveInSubset(all, all, m1.ref, -5))).toEqual(titles(all));
    expect(moveInSubset(all, all, m1.ref, 0)).toBe(all);
    expect(titles(moveInSubset(all, all, m1.ref, 99))).toEqual(['S1', 'M2', 'S2', 'M3', 'M1']);
    expect(moveInSubset(all, all, r('movie', 'gone'), 1)).toBe(all);
  });
});

describe('reinsertRef', () => {
  it('places a ref at an index, moving it when present', () => {
    const a = r('movie', 'a');
    const b = r('movie', 'b');
    const c = r('movie', 'c');
    expect(reinsertRef([a, b], c, 1)).toEqual([a, c, b]);
    expect(reinsertRef([c, a, b], c, 2)).toEqual([a, b, c]);
    expect(reinsertRef([a], c, 10)).toEqual([a, c]);
    expect(reinsertRef([a], c, -1)).toEqual([c, a]);
  });
});

describe('draftEntry', () => {
  it('stamps the content type from the ref and starts unwatched', () => {
    const d = draftEntry(r('series', 's1'), { title: 'Dark', contentType: 'movie' }, new Date('2026-10-13T00:00:00Z'));
    expect(d).toEqual({
      ref: r('series', 's1'),
      snapshot: { title: 'Dark', contentType: 'series' },
      addedAt: '2026-10-13T00:00:00.000Z',
      watched: false,
    });
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('speaks in the UI language', () => {
    expect(relativeTime('2026-10-13T11:55:00Z', 'en', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-10-12T12:00:00Z', 'en', now)).toBe('yesterday');
    expect(relativeTime('2026-09-29T12:00:00Z', 'en', now)).toBe('2 weeks ago');
    expect(relativeTime('2026-10-12T12:00:00Z', 'de', now)).toBe('gestern');
  });

  it('is empty for an unreadable date', () => {
    expect(relativeTime('soon', 'en', now)).toBe('');
  });
});

describe('patchList', () => {
  // TanStack Query reverts a cancelled fetch (revert: true) synchronously
  // inside cancelQueries, before the patch lands, and drops the fetch's late
  // answer; the cancelled fetch must not put the old list back afterwards.
  it('keeps the optimistic patch when a list fetch in flight lands late', async () => {
    const { queryClient } = await import('@/api/query');
    const { LIST_KEY, patchList, readList } = await import('../lib/cache');
    queryClient.clear();
    const a = e(r('movie', 'a'), 'A');
    const b = e(r('movie', 'b'), 'B');
    queryClient.setQueryData(LIST_KEY, [a]);
    let land: (list: WatchlistEntry[]) => void = () => {};
    const inFlight = queryClient.fetchQuery({
      queryKey: LIST_KEY,
      queryFn: () => new Promise<WatchlistEntry[]>((resolve) => (land = resolve)),
      staleTime: 0,
    });

    const previous = patchList((list) => [b, ...list]);
    expect(titles(previous ?? [])).toEqual(['A']);
    expect(titles(readList() ?? [])).toEqual(['B', 'A']);

    land([a]);
    await inFlight.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(titles(readList() ?? [])).toEqual(['B', 'A']);
    expect(queryClient.getQueryState(LIST_KEY)?.status).toBe('success');
    queryClient.clear();
  });
});
