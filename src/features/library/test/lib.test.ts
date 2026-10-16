import { describe, expect, it, vi } from 'vitest';

import type { DownloadStatus, PlayerSource } from '@/api/types';

import { buildFavoriteRows, groupFavorites, moveWithinGroup, reorderArgs, sortFavorites, withPositions } from '../lib/favorites';
import { etaSeconds, formatBytes, formatClock, formatDuration, percentOf } from '../lib/format';
import { k } from '../lib/keys';
import { buildLibrary, filterLibrary, findEntry, groupBySeason, parseEpisodeCode, resumePoint, seriesTitle, type SeriesEntry } from '../lib/myvideos';
import { positionToSave, SAVE_EVERY_MS, trackDownloadPosition, type PositionStore } from '../lib/positionSync';
import { effectiveProgress, ProgressStore, STALE_MS } from '../lib/progress';
import { actionsFor, buildQueueRows, partitionQueue, queueCounts } from '../lib/queue';
import { bucketOf, buildRecentRows, continueForSource, watchedFraction } from '../lib/recent';
import { makeDownload, makeEpisode, makeFavorite, makePosition, makeRecent } from './fixtures';

vi.mock('@/api/transport', () => ({ rpc: vi.fn(), isDesktop: false, RpcError: class extends Error {} }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

describe('queue', () => {
  const statuses: DownloadStatus[] = ['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled'];
  const all = statuses.map((status, i) =>
    makeDownload({ id: 100 + i, status, createdAt: `2026-10-01T10:0${i}:00Z`, updatedAt: `2026-10-01T11:0${i}:00Z` }),
  );

  it('drops completed rows and orders active then attention', () => {
    const { active, attention } = partitionQueue(all);
    // Active rows stay in the order they were added, whatever their status.
    expect(active.map((d) => d.status)).toEqual(['queued', 'downloading', 'paused']);
    expect(attention.map((d) => d.status)).toEqual(['canceled', 'failed']);
  });

  it('keeps queued rows in FIFO order', () => {
    const a = makeDownload({ id: 1, status: 'queued', createdAt: '2026-10-01T09:00:00Z' });
    const b = makeDownload({ id: 2, status: 'queued', createdAt: '2026-10-01T08:00:00Z' });
    expect(partitionQueue([a, b]).active.map((d) => d.id)).toEqual([2, 1]);
  });

  it('keeps a row in place when it is paused or resumed', () => {
    const rows = [1, 2, 3].map((id) => makeDownload({ id, status: 'downloading', createdAt: `2026-10-01T09:0${id}:00Z` }));
    const before = partitionQueue(rows).active.map((d) => d.id);
    const paused = rows.map((d) => (d.id === 2 ? { ...d, status: 'paused' as const } : d));
    const resumed = rows.map((d) => (d.id === 3 ? { ...d, status: 'queued' as const } : d));
    expect(partitionQueue(paused).active.map((d) => d.id)).toEqual(before);
    expect(partitionQueue(resumed).active.map((d) => d.id)).toEqual(before);
  });

  it('builds section headers with counts', () => {
    const rows = buildQueueRows(all);
    expect(rows.map((r) => r.key)).toEqual(['h-active', 'd-100', 'd-101', 'd-102', 'h-attention', 'd-105', 'd-104']);
    expect(rows[0]).toMatchObject({ kind: 'header', count: 3 });
    expect(buildQueueRows([makeDownload({ status: 'completed' })])).toEqual([]);
  });

  it('offers the right actions per status', () => {
    const o = { canReveal: true, hasFile: true };
    expect(actionsFor('downloading', o)).toEqual(['pause', 'cancel']);
    expect(actionsFor('queued', o)).toEqual(['pause', 'cancel']);
    // Two buttons in the same places as when downloading: Pause/Resume, then Cancel/Remove.
    expect(actionsFor('paused', o)).toEqual(['resume', 'remove']);
    expect(actionsFor('failed', o)).toEqual(['retry', 'reveal', 'remove']);
    expect(actionsFor('failed', { canReveal: false, hasFile: true })).toEqual(['retry', 'remove']);
    expect(actionsFor('canceled', o)).toEqual(['retry', 'remove']);
  });

  it('counts by status', () => {
    expect(queueCounts(all)).toEqual({ downloading: 1, queued: 1, paused: 1, attention: 2 });
  });
});

describe('progress', () => {
  it('smooths speed and resets after a stall', () => {
    const store = new ProgressStore(() => () => undefined);
    store.ingest({ id: 1, bytesDownloaded: 100, totalBytes: 1000, bytesPerSecond: 100 }, 0);
    store.ingest({ id: 1, bytesDownloaded: 300, bytesPerSecond: 200 }, 1000);
    expect(store.get(1)?.bytesPerSecond).toBeCloseTo(135);
    store.ingest({ id: 1, bytesDownloaded: 400, bytesPerSecond: 50 }, 1000 + STALE_MS + 1);
    expect(store.get(1)?.bytesPerSecond).toBe(50);
    store.prune([]);
    expect(store.get(1)).toBeUndefined();
  });

  it('only applies live data to downloading rows and never moves bytes back', () => {
    const live = { bytesDownloaded: 500, totalBytes: 1000, bytesPerSecond: 10, at: 0 };
    expect(effectiveProgress(makeDownload({ status: 'paused', bytesDownloaded: 200 }), live, 0).bytesDownloaded).toBe(200);
    const d = makeDownload({ status: 'downloading', bytesDownloaded: 700 });
    expect(effectiveProgress(d, live, 0)).toEqual({ bytesDownloaded: 700, totalBytes: 1000, bytesPerSecond: 10 });
    expect(effectiveProgress(d, live, STALE_MS + 1).bytesPerSecond).toBeUndefined();
  });
});

describe('format', () => {
  it('formats bytes, durations and clocks', () => {
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(undefined)).toBe('');
    expect(formatDuration(185)).toBe('3m 5s');
    expect(formatDuration(185, { locale: 'en' })).toBe('3m 5s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(3720)).toBe('1h 2m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(52 * 3600)).toBe('2d 4h');
    expect(formatDuration(0)).toBe('0s');
    // Localized units, not hardcoded English letters (shared with the VOD runtimes).
    expect(formatDuration(185, { locale: 'ja' })).toContain('分');
    expect(formatDuration(3720, { locale: 'de' })).toContain('Min');
    // No CLDR data: hours/minutes come from the vod runtime keys.
    expect(formatDuration(3720, { locale: 'ary', t: (k, v) => `${k}:${v.h ?? ''}:${v.m ?? ''}` })).toBe('runtimeHoursMinutes:1:2');
    expect(formatClock(3729)).toBe('1:02:09');
    expect(etaSeconds(500, 1000, 100)).toBe(5);
    expect(etaSeconds(500, undefined, 100)).toBeUndefined();
    expect(percentOf(333, 1000)).toBe(33);
    expect(k('status', 'downloading')).toBe('statusDownloading');
  });
});

describe('my videos grouping', () => {
  it('parses episode codes', () => {
    expect(parseEpisodeCode('S01E03 Pilot')).toEqual({ season: 1, episode: 3, rest: 'Pilot' });
    expect(parseEpisodeCode('Show - 2x10')).toEqual({ season: 2, episode: 10, rest: 'Show' });
    expect(parseEpisodeCode('Season 3 Episode 4')).toMatchObject({ season: 3, episode: 4 });
    expect(parseEpisodeCode('Heat')).toBeUndefined();
  });

  it('picks the shared series title', () => {
    const a = makeEpisode('s1', 'Severance', 'S01E02 Half Loop');
    const b = makeEpisode('s1', 'Severance', 'S01E01 Good News');
    expect(seriesTitle([a, b])).toBe('Severance');
    expect(seriesTitle([makeEpisode('s2', 'S02E01 Hello', 'Andor')])).toBe('Andor');
  });

  it('groups episodes by series, sorts them, and ignores unfinished rows', () => {
    const movie = makeDownload({ id: 1, status: 'completed', title: 'Heat', completedAt: '2026-10-01T00:00:00Z' });
    const e2 = makeEpisode('s1', 'Severance', 'S01E02 Half Loop', { id: 2, completedAt: '2026-10-03T00:00:00Z' });
    const e1 = makeEpisode('s1', 'Severance', 'S01E01 Good News', { id: 3, completedAt: '2026-10-02T00:00:00Z', fileAvailable: false });
    const s2 = makeEpisode('s1', 'Severance', 'S02E01 Hello', { id: 5, completedAt: '2026-09-01T00:00:00Z' });
    const pending = makeDownload({ id: 4, status: 'downloading' });

    const lib = buildLibrary([movie, e2, e1, s2, pending]);
    expect(lib.map((e) => e.kind)).toEqual(['series', 'movie']);
    const series = lib[0] as SeriesEntry;
    expect(series.title).toBe('Severance');
    expect(series.episodes.map((ep) => [ep.season, ep.episode, ep.name])).toEqual([
      [1, 1, 'Good News'],
      [1, 2, 'Half Loop'],
      [2, 1, 'Hello'],
    ]);
    expect(series.latest.id).toBe(2);
    expect(series.missingCount).toBe(1);
    expect(groupBySeason(series.episodes).map((g) => [g.season, g.episodes.length])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(findEntry(lib, 3)).toBe(series);

    expect(filterLibrary(lib, 'movies', '').map((e) => e.title)).toEqual(['Heat']);
    expect(filterLibrary(lib, 'missing', '')).toEqual([series]);
    expect(filterLibrary(lib, 'all', 'half')).toEqual([series]);
  });

  it('keeps movies with the same title separate', () => {
    const a = makeDownload({ status: 'completed', title: 'Heat' });
    const b = makeDownload({ status: 'completed', title: 'Heat' });
    expect(buildLibrary([a, b])).toHaveLength(2);
  });

  it('resumes only between 5 s and 95 %', () => {
    expect(resumePoint(makeDownload({ positionSeconds: 3 }))).toBeUndefined();
    expect(resumePoint(makeDownload({ positionSeconds: 60 }), 100)).toBe(60);
    expect(resumePoint(makeDownload({ positionSeconds: 96 }), 100)).toBeUndefined();
  });
});

describe('favorites', () => {
  const live1 = makeFavorite('live', 'c1', 0);
  const movie1 = makeFavorite('movie', 'v1', 1);
  const live2 = makeFavorite('radio', 'r1', 2);
  const series1 = makeFavorite('series', 's1', 3);
  const movie2 = makeFavorite('movie', 'v2', 4, 'src2');
  const all = [series1, movie2, live2, movie1, live1];

  it('groups live and radio together, in stored order', () => {
    const g = groupFavorites(all);
    expect(g.live).toEqual([live1, live2]);
    expect(g.movies).toEqual([movie1, movie2]);
    expect(g.series).toEqual([series1]);
  });

  it('builds rows with group headers and in-group indexes', () => {
    const rows = buildFavoriteRows(all);
    expect(rows.map((r) => (r.kind === 'header' ? r.key : `${r.group}:${r.indexInGroup}/${r.groupSize}`))).toEqual([
      'h-live',
      'live:0/2',
      'live:1/2',
      'h-movies',
      'movies:0/2',
      'movies:1/2',
      'h-series',
      'series:0/1',
    ]);
    const filtered = buildFavoriteRows(all, 'v2');
    expect(filtered).toHaveLength(2);
    expect(filtered[1]).toMatchObject({ indexInGroup: 1, groupSize: 2 });
  });

  it('moves within a group and leaves other groups in their slots', () => {
    const next = moveWithinGroup(all, movie2.ref, 0);
    expect(next).toEqual([live1, movie2, live2, series1, movie1]);
    expect(moveWithinGroup(all, movie2.ref, 99)).toEqual(sortFavorites(all));
  });

  it('builds reorder args for the global and per-source pages', () => {
    const next = moveWithinGroup(all, live2.ref, 0);
    expect(reorderArgs(next)).toEqual({ refs: [live2.ref, movie1.ref, live1.ref, series1.ref, movie2.ref] });
    expect(reorderArgs([live1], 'src1')).toEqual({ sourceId: 'src1', refs: [live1.ref] });
    expect('sourceId' in reorderArgs([live1])).toBe(false);
    expect(withPositions(next).map((e) => e.position)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('recent', () => {
  const now = new Date(2026, 9, 11, 15, 0, 0).getTime();
  const at = (days: number, hour = 12) => new Date(2026, 9, 11 - days, hour).toISOString();

  it('buckets by calendar day', () => {
    expect(bucketOf(at(0, 1), now)).toBe('today');
    expect(bucketOf(at(1, 23), now)).toBe('yesterday');
    expect(bucketOf(at(5), now)).toBe('thisWeek');
    expect(bucketOf(at(30), now)).toBe('earlier');
    expect(bucketOf('not a date', now)).toBe('earlier');
  });

  it('builds newest-first rows with bucket headers', () => {
    const rows = buildRecentRows([makeRecent('a', at(30)), makeRecent('b', at(0)), makeRecent('c', at(0, 2))], '', now);
    expect(rows.map((r) => r.key)).toEqual(['h-today', 'r-src1|movie|b', 'r-src1|movie|c', 'h-earlier', 'r-src1|movie|a']);
    expect(rows[0]).toMatchObject({ count: 2 });
  });

  it('filters continue watching by source and computes fractions', () => {
    const ps = [makePosition('a', 30, 120), makePosition('b', 10, undefined, 'src2')];
    expect(continueForSource(ps, 'src2').map((p) => p.ref.itemId)).toEqual(['b']);
    expect(continueForSource(ps)).toHaveLength(2);
    expect(watchedFraction(ps[0]!)).toBe(0.25);
    expect(watchedFraction(ps[1]!)).toBeUndefined();
  });
});

describe('position sync', () => {
  type S = { source?: PlayerSource; positionSeconds: number; durationSeconds?: number };
  function fakeStore(initial: S) {
    let state = initial;
    const listeners = new Set<(s: S) => void>();
    const store: PositionStore = {
      getState: () => state,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const set = (patch: Partial<S>) => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l(state);
    };
    return { store, set, listeners };
  }

  it('treats 95 % as finished', () => {
    expect(positionToSave(95, 100)).toBe(0);
    expect(positionToSave(42.9, 100)).toBe(42);
  });

  it('saves at most every 5 s and flushes when the source changes', () => {
    const src: PlayerSource = { url: 'file:///a.mp4', kind: 'file', title: 'A', isLive: false, isRadio: false };
    const { store, set, listeners } = fakeStore({ source: src, positionSeconds: 0 });
    let t = 0;
    const save = vi.fn(() => Promise.resolve());
    trackDownloadPosition(store, 7, src.url, { save, now: () => t });

    t = 1000;
    set({ positionSeconds: 1, durationSeconds: 600 });
    expect(save).not.toHaveBeenCalled();
    t = SAVE_EVERY_MS;
    set({ positionSeconds: 5 });
    expect(save).toHaveBeenLastCalledWith(7, 5);
    t += 1000;
    set({ positionSeconds: 6 });
    expect(save).toHaveBeenCalledTimes(1);
    set({ source: { url: 'http://other', kind: 'hls', title: 'B', isLive: true, isRadio: false } });
    expect(save).toHaveBeenLastCalledWith(7, 6);
    expect(listeners.size).toBe(0);
  });
});
