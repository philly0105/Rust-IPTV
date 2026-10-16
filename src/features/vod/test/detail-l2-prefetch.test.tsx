// Loop 2 VOD detail (L2-vod-10): the detail route chunks warm once per session, shared by the
// grids' idle warm-up and the hover or focus prefetch; a failed load is tried again later.
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

import { preloadDetailChunk, prefetchVodDetail, resetPrefetchMemory } from '../hooks/prefetch';

const chunks = vi.hoisted(() => ({ loaded: [] as string[], fail: false }));
vi.mock('../routes', () => {
  const load = (kind: string) => async () => {
    chunks.loaded.push(kind);
    if (chunks.fail) throw new Error('chunk failed');
    return {};
  };
  return { loadMovieDetailPage: load('movie'), loadSeriesDetailPage: load('series'), loadSearchPage: load('search') };
});
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpcRaw: async () => ({ item: { ref: { sourceId: 'x1', contentType: 'series', itemId: '7' }, title: 'S' }, seasons: [], cast: [], backdrops: [] }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
const series = (itemId: string): ItemRef => ({ sourceId: 'x1', contentType: 'series', itemId });

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  chunks.loaded = [];
  chunks.fail = false;
  resetPrefetchMemory();
});
afterEach(() => client.clear());

describe('preloadDetailChunk (L2-vod-10)', () => {
  it('loads each detail chunk once per session', async () => {
    preloadDetailChunk('series');
    preloadDetailChunk('series');
    preloadDetailChunk('movie');
    await flush();
    preloadDetailChunk('movie');
    expect(chunks.loaded).toEqual(['series', 'movie']);
  });

  it('shares the load with the hover and focus prefetch', async () => {
    preloadDetailChunk('series');
    prefetchVodDetail(client, { ref: series('7'), sourceKind: 'xtream' });
    prefetchVodDetail(client, { ref: series('8'), sourceKind: 'xtream' });
    await flush();
    expect(chunks.loaded).toEqual(['series']);
  });

  it('swallows a failed load and tries again on the next call', async () => {
    chunks.fail = true;
    preloadDetailChunk('series');
    await flush();
    chunks.fail = false;
    preloadDetailChunk('series');
    await flush();
    preloadDetailChunk('series');
    expect(chunks.loaded).toEqual(['series', 'series']);
  });
});
