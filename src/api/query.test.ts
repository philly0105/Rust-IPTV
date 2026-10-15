import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_QUERY_TIMING, invalidationPrefixes, queryClient, queryDefaultsFor, rpcKey, useRpcQuery, type RpcCommand } from './query';

vi.mock('./transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport')>()),
  rpcRaw: vi.fn(async () => ({})),
}));

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
    ['epg.grid', 5 * MIN, 2 * MIN],
    ['epg.programs', 5 * MIN, 2 * MIN],
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
    expect(epg.gcTime).toBe(2 * MIN);
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

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useRpcQuery('stats.summary', null as never, { enabled: false }), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('event invalidation', () => {
  it('maps core events to query prefixes', () => {
    expect(invalidationPrefixes({ type: 'epg.changed' })).toEqual(['epg.']);
    expect(invalidationPrefixes({ type: 'sources.changed' })).toEqual(['catalog.', 'sources.', 'lists.']);
    expect(invalidationPrefixes({ type: 'downloads.update' })).toEqual(['downloads.', 'myvideos.']);
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
