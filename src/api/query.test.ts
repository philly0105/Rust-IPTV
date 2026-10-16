import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent } from './types';
import {
  DEFAULT_QUERY_TIMING,
  EVENT_BURST_MS,
  bindEventInvalidation,
  invalidate,
  invalidationPrefixes,
  queryClient,
  queryDefaultsFor,
  rpcKey,
  useRpcQuery,
  type RpcCommand,
} from './query';
import { rpcRaw } from './transport';

const bus = vi.hoisted(() => ({ handlers: new Set<(e: AppEvent) => void>() }));

vi.mock('./events', () => ({
  onAnyAppEvent: (h: (e: AppEvent) => void) => {
    bus.handlers.add(h);
    return () => bus.handlers.delete(h);
  },
}));

vi.mock('./transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport')>()),
  rpcRaw: vi.fn(async () => ({})),
}));

function emit(type: string, payload?: unknown): void {
  for (const h of bus.handlers) h({ type, payload } as AppEvent);
}

const MIN = 60_000;

describe('queryDefaultsFor (C4)', () => {
  // Every row of the C4 table, one command per prefix.
  const rows: [RpcCommand, number, number][] = [
    ['settings.get', Infinity, 10 * MIN],
    ['app.info', Infinity, 10 * MIN],
    ['sources.list', 5 * MIN, 10 * MIN],
    ['sources.get', 5 * MIN, 10 * MIN],
    ['catalog.categories', 5 * MIN, 10 * MIN],
    ['catalog.channels', 2 * MIN, 10 * MIN],
    ['catalog.movies', 2 * MIN, 10 * MIN],
    ['catalog.series', 2 * MIN, 10 * MIN],
    ['catalog.yearFacets', 2 * MIN, 10 * MIN],
    ['epg.grid', 5 * MIN, 5 * MIN],
    ['epg.programs', 5 * MIN, 5 * MIN],
    ['tmdb.movie', Infinity, 30 * MIN],
    ['tmdb.similar', Infinity, 30 * MIN],
    ['tmdb.person', Infinity, 30 * MIN],
    ['positions.continueWatching', 15_000, 10 * MIN],
    ['positions.forSeries', 15_000, 10 * MIN],
    ['stats.summary', 15_000, 10 * MIN],
  ];

  it.each(rows)('%s -> staleTime %d, gcTime %d', (cmd, staleTime, gcTime) => {
    expect(queryDefaultsFor(cmd)).toEqual({ staleTime, gcTime });
  });

  // L2-perf-ui-10: an entry dropped before it goes stale is refetched on every reopen.
  it.each(rows.filter(([, staleTime]) => Number.isFinite(staleTime)))('%s keeps cached data at least as long as it is fresh', (cmd) => {
    const { staleTime, gcTime } = queryDefaultsFor(cmd);
    expect(gcTime).toBeGreaterThanOrEqual(staleTime);
  });

  it('falls back to 30 s / 10 min for commands outside the table', () => {
    expect(DEFAULT_QUERY_TIMING).toEqual({ staleTime: 30_000, gcTime: 10 * MIN });
    for (const cmd of ['catalog.search', 'catalog.item', 'favorites.list', 'epg.now', 'watchlist.list', 'sources.status'] as RpcCommand[]) {
      expect(queryDefaultsFor(cmd)).toEqual({ staleTime: 30_000, gcTime: 10 * MIN });
    }
  });

  it('returns a fresh object, so callers cannot change the defaults', () => {
    const t = queryDefaultsFor('catalog.item');
    t.staleTime = 1;
    expect(queryDefaultsFor('catalog.item').staleTime).toBe(30_000);
  });
});

describe('app query client (C4)', () => {
  afterEach(() => queryClient.clear());

  it('applies the table to any query keyed by a command, raw useQuery and prefetch included', () => {
    const o = queryClient.defaultQueryOptions({ queryKey: ['tmdb.movie', { tmdbId: 1 }] });
    expect(o.staleTime).toBe(Infinity);
    expect(o.gcTime).toBe(30 * MIN);
    const epg = queryClient.defaultQueryOptions({ queryKey: ['epg.grid', null] });
    expect(epg.staleTime).toBe(5 * MIN);
    expect(epg.gcTime).toBe(5 * MIN);
  });

  it('uses the client defaults for other keys', () => {
    const o = queryClient.defaultQueryOptions({ queryKey: ['vod-pages', 1] });
    expect(o.staleTime).toBe(30_000);
    expect(o.gcTime).toBe(10 * MIN);
    expect(queryClient.defaultQueryOptions({ queryKey: [42] }).staleTime).toBe(30_000);
  });

  it('lets explicit per-call options and setQueryDefaults win over the table', () => {
    const o = queryClient.defaultQueryOptions({ queryKey: ['tmdb.movie', null], staleTime: 5, gcTime: 6 });
    expect(o.staleTime).toBe(5);
    expect(o.gcTime).toBe(6);
    queryClient.setQueryDefaults(['stats.summary'], { staleTime: 1 });
    try {
      expect(queryClient.defaultQueryOptions({ queryKey: ['stats.summary', null] }).staleTime).toBe(1);
      expect(queryClient.defaultQueryOptions({ queryKey: ['stats.summary', null] }).gcTime).toBe(10 * MIN);
    } finally {
      queryClient.setQueryDefaults(['stats.summary'], {});
    }
  });
});

describe('useRpcQuery (C4)', () => {
  afterEach(() => queryClient.clear());
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

  function observed(cmd: RpcCommand, args: unknown) {
    const q = queryClient.getQueryCache().find({ queryKey: rpcKey(cmd, args as never), exact: true });
    return q?.observers[0]?.options;
  }

  it('uses the command defaults when the call gives no timing', async () => {
    const { result } = renderHook(() => useRpcQuery('sources.list', null as never), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(observed('sources.list', null)?.staleTime).toBe(5 * MIN);
    expect(observed('sources.list', null)?.gcTime).toBe(10 * MIN);
  });

  it('passes explicit staleTime and gcTime through', async () => {
    const { result } = renderHook(() => useRpcQuery('tmdb.trending', null as never, { staleTime: 1000, gcTime: 2000 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(observed('tmdb.trending', null)?.staleTime).toBe(1000);
    expect(observed('tmdb.trending', null)?.gcTime).toBe(2000);
  });

  it('hands the query signal to the transport, so a replaced refetch is aborted', async () => {
    const { result } = renderHook(() => useRpcQuery('sources.list', null as never), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const call = vi.mocked(rpcRaw).mock.calls.at(-1)!;
    expect(call.slice(0, 2)).toEqual(['sources.list', null]);
    expect((call[2] as { signal?: unknown } | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useRpcQuery('stats.summary', null as never, { enabled: false }), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('event invalidation', () => {
  it('maps core events to query prefixes', () => {
    expect(invalidationPrefixes({ type: 'epg.changed' })).toEqual(['epg.']);
    expect(invalidationPrefixes({ type: 'sources.changed' })).toEqual(['catalog.', 'sources.', 'lists.']);
    // L2-guide-library-11: not downloads.dir, which a progress tick cannot change.
    expect(invalidationPrefixes({ type: 'downloads.update' })).toEqual(['downloads.list', 'myvideos.']);
    expect(invalidationPrefixes({ type: 'settings.changed' })).toEqual(['settings.']);
    expect(invalidationPrefixes({ type: 'epg.progress' })).toEqual([]);
  });

  it('maps the Run 2 events (C10)', () => {
    expect(invalidationPrefixes({ type: 'lists.changed', payload: {} })).toEqual(['lists.']);
    expect(invalidationPrefixes({ type: 'channels.changed', payload: { sourceId: 's1' } })).toEqual([
      'catalog.',
      'channels.',
      'lists.',
      'favorites.',
      'recent.',
      'epg.search',
    ]);
    // `recordings.rules` shares the prefix.
    expect(invalidationPrefixes({ type: 'recordings.update' })).toEqual(['recordings.']);
  });

  it('does not refetch settings when the event carries them', () => {
    expect(invalidationPrefixes({ type: 'settings.changed', payload: { language: 'en' } })).toEqual([]);
    expect(invalidationPrefixes({ type: 'settings.changed', payload: { language: 'en' } }, { 'settings.changed': ['sources.schedule'] })).toEqual([
      'sources.schedule',
    ]);
  });

  it('only touches source records after an unchanged import', () => {
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'done', message: 'unchanged' } })).toEqual(['sources.']);
  });

  it('only invalidates on a finished import', () => {
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'parsing' } })).toEqual([]);
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'done' } })).toEqual(['catalog.', 'sources.', 'lists.']);
  });

  it('merges caller prefixes without duplicates', () => {
    expect(invalidationPrefixes({ type: 'sources.changed' }, { 'sources.changed': ['sources.', 'favorites.'] })).toEqual([
      'catalog.',
      'sources.',
      'lists.',
      'favorites.',
    ]);
  });
});

describe('event bursts', () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
  let unbind: () => void = () => undefined;

  afterEach(() => {
    unbind();
    queryClient.clear();
    vi.useRealTimers();
  });

  function callsOf(cmd: string): number {
    return vi.mocked(rpcRaw).mock.calls.filter(([c]) => c === cmd).length;
  }

  it('refetches each mounted query once for an import done + sources.changed burst', async () => {
    unbind = bindEventInvalidation({ 'sources.changed': ['sources.', 'catalog.', 'favorites.'] });
    const a = renderHook(() => useRpcQuery('catalog.categories', { sourceId: 's1', contentType: 'live' }), { wrapper });
    const b = renderHook(() => useRpcQuery('sources.list', null as never), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess && b.result.current.isSuccess).toBe(true));
    vi.mocked(rpcRaw).mockClear();

    emit('import.progress', { sourceId: 's1', phase: 'done', done: 1 });
    // A handler of the same event invalidating directly joins the burst.
    void invalidate('catalog.');
    void invalidate('sources.');
    emit('sources.changed', {});
    expect(callsOf('catalog.categories')).toBe(0); // nothing until the burst closes

    await waitFor(() => expect(callsOf('catalog.categories')).toBe(1));
    await waitFor(() => expect(callsOf('sources.list')).toBe(1));
    await new Promise((r) => setTimeout(r, EVENT_BURST_MS * 2));
    expect(callsOf('catalog.categories')).toBe(1);
    expect(callsOf('sources.list')).toBe(1);
  });

  it('writes the settings payload into the cache without a settings.get refetch', async () => {
    unbind = bindEventInvalidation();
    const q = renderHook(() => useRpcQuery('settings.get', undefined as never), { wrapper });
    await waitFor(() => expect(q.result.current.isSuccess).toBe(true));
    vi.mocked(rpcRaw).mockClear();

    emit('settings.changed', { language: 'de', lastRoute: '/live' });
    expect(queryClient.getQueryData(rpcKey('settings.get'))).toEqual({ language: 'de', lastRoute: '/live' });
    await new Promise((r) => setTimeout(r, EVENT_BURST_MS * 2));
    expect(callsOf('settings.get')).toBe(0);
  });

  it('refetches everything after events.lagged', async () => {
    unbind = bindEventInvalidation();
    const q = renderHook(() => useRpcQuery('stats.summary', null as never), { wrapper });
    await waitFor(() => expect(q.result.current.isSuccess).toBe(true));
    vi.mocked(rpcRaw).mockClear();
    emit('events.lagged', { skipped: 0 });
    await waitFor(() => expect(callsOf('stats.summary')).toBe(1));
  });

  it('runs a direct invalidation at once when no burst is open', async () => {
    const q = renderHook(() => useRpcQuery('stats.summary', null as never), { wrapper });
    await waitFor(() => expect(q.result.current.isSuccess).toBe(true));
    vi.mocked(rpcRaw).mockClear();
    void invalidate('stats.');
    expect(queryClient.getQueryState(rpcKey('stats.summary', null as never))?.isInvalidated).toBe(true);
    await waitFor(() => expect(callsOf('stats.summary')).toBe(1));
  });
});
