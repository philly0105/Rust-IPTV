// Performance audit, VOD detail: a detail page refetches the download list only for its own
// transfers (VD-3), and the hover prefetch also starts the TMDB lookup the page sends next (VD-8).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { Download, ItemRef } from '@/api/types';
import { DEFAULT_SETTINGS } from '@/api/types';

import { prefetchVodDetail, resetPrefetchMemory } from '../hooks/prefetch';
import { useItemDownloads } from '../hooks/usePlayback';

const events = vi.hoisted(() => new Map<string, Set<(p: unknown) => void>>());
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, handler: (p: unknown) => void) => {
    const set = events.get(type) ?? new Set();
    events.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
  onAnyAppEvent: () => () => undefined,
}));
const emit = (type: string, payload: unknown) => events.get(type)?.forEach((h) => h(payload));

const rpcState = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[], downloads: [] as unknown[] }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpcRaw: async (cmd: string, args: unknown) => {
    rpcState.calls.push({ cmd, args });
    if (cmd === 'downloads.list') return rpcState.downloads;
    if (cmd === 'xtream.vodDetail' || cmd === 'catalog.item')
      return { item: { ref: movie('7'), title: 'EN - Dune (2021)', titleBase: 'Dune', year: 2021, categoryId: 'c' }, cast: [], backdrops: [] };
    if (cmd === 'tmdb.movie') return null;
    return null;
  },
}));
vi.mock('../routes', () => ({ loadMovieDetailPage: async () => ({}), loadSeriesDetailPage: async () => ({}), loadSearchPage: async () => ({}) }));
vi.mock('@/features/player', () => ({ playItem: vi.fn(), usePlayerStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

function movie(itemId: string): ItemRef {
  return { sourceId: 'x1', contentType: 'movie', itemId };
}

function download(id: number, ref: ItemRef): Download {
  return { id, ref, title: `T${id}`, status: 'downloading', bytesDownloaded: 0, createdAt: '2026-10-19T00:00:00Z' } as Download;
}

const listCalls = () => rpcState.calls.filter((c) => c.cmd === 'downloads.list').length;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

beforeEach(() => {
  rpcState.calls = [];
  queryClient.clear();
});
afterEach(() => queryClient.clear());

describe('useItemDownloads (VD-3)', () => {
  it('refetches the list for progress of its own rows only', async () => {
    const own = movie('7');
    rpcState.downloads = [download(1, own), download(2, movie('8'))];
    const { result } = renderHook(() => useItemDownloads(own, true), { wrapper });
    await waitFor(() => expect(result.current.get('')?.id).toBe(1));
    const before = listCalls();

    emit('downloads.progress', { id: 2, bytesDownloaded: 10, bytesPerSecond: 1 });
    await new Promise((r) => setTimeout(r, 700));
    expect(listCalls()).toBe(before);

    emit('downloads.progress', { id: 1, bytesDownloaded: 10, bytesPerSecond: 1 });
    await waitFor(() => expect(listCalls()).toBe(before + 1), { timeout: 2000 });
  });
});

describe('prefetchVodDetail TMDB lookup (VD-8)', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    resetPrefetchMemory();
  });
  afterEach(() => client.clear());

  const tmdbCalls = () => rpcState.calls.filter((c) => c.cmd === 'tmdb.movie').map((c) => c.args);

  it('starts the lookup the detail page sends, with the same key', async () => {
    client.setQueryData(rpcKey('settings.get', undefined), { ...DEFAULT_SETTINGS, tmdb: { ...DEFAULT_SETTINGS.tmdb, enabled: true } });
    prefetchVodDetail(client, { ref: movie('7'), sourceKind: 'xtream' });
    await waitFor(() => expect(tmdbCalls()).toEqual([{ title: 'Dune', year: 2021 }]));
    await waitFor(() => expect(client.getQueryState(rpcKey('tmdb.movie', { title: 'Dune', year: 2021 }))?.status).toBe('success'));
  });

  it('leaves TMDB alone while enrichment is off', async () => {
    client.setQueryData(rpcKey('settings.get', undefined), { ...DEFAULT_SETTINGS, tmdb: { ...DEFAULT_SETTINGS.tmdb, enabled: false } });
    prefetchVodDetail(client, { ref: movie('7'), sourceKind: 'xtream' });
    await waitFor(() => expect(rpcState.calls.some((c) => c.cmd !== 'tmdb.movie')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(tmdbCalls()).toEqual([]);
  });
});
