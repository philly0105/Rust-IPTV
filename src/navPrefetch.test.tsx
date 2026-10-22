/**
 * NAV-1: a navigation that still has page chunks to load starts its screen's first data at once,
 * in parallel with the chunk, instead of after the page has rendered. This is what covers the
 * rail, the palette, keyboard shortcuts and Back.
 */
import { waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { channelPageArgs, guideCategoriesArgs } from '@/api/bootPrefetch';
import { queryClient } from '@/api/query';
import { rpcRaw } from '@/api/transport';

import { prefetchNavigations } from './routes';

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpcRaw: vi.fn(async (cmd: string) => {
    if (cmd === 'catalog.channels') return { items: [], total: 0, offset: 0, limit: 120 };
    if (cmd === 'sources.list') return [{ id: 's1', kind: 'm3u', channelCount: 10 }];
    if (cmd === 'catalog.categories') return [];
    return {};
  }),
}));

const raw = vi.mocked(rpcRaw);
const sent = () => raw.mock.calls.map(([cmd]) => cmd);

afterEach(() => {
  queryClient.clear();
  raw.mockClear();
});

/** A router whose pages wait for `load()` to deliver their chunk, as a lazy route does. */
function routerWithChunk() {
  let load!: () => void;
  const chunk = new Promise<void>((resolve) => (load = resolve));
  const lazy = async () => {
    await chunk;
    return { element: null };
  };
  const router = createMemoryRouter(
    [
      { path: '/', element: null },
      { path: '/s/:sourceId/live/:categoryId', lazy },
      { path: '/epg', lazy },
    ],
    { initialEntries: ['/'] },
  );
  return { router, load };
}

describe('prefetchNavigations', () => {
  it("asks for the next screen's data while its page chunk loads, once per navigation", async () => {
    const { router, load } = routerWithChunk();
    const stop = prefetchNavigations(router);
    const navigation = router.navigate('/s/s1/live/c9');

    await waitFor(() => expect(sent()).toEqual(['sources.get', 'catalog.categories', 'catalog.channels']));
    // The old screen is still up: the page has not rendered, its chunk is on its way.
    expect(router.state.navigation.state).toBe('loading');
    expect(router.state.location.pathname).toBe('/');
    expect(raw.mock.calls[2]![1]).toEqual(channelPageArgs({ sourceId: 's1', categoryId: 'c9' }, 0));

    load();
    await navigation;
    expect(router.state.location.pathname).toBe('/s/s1/live/c9');
    expect(sent()).toHaveLength(3);
    stop();
  });

  it("starts the TV guide's channels before the guide page mounts", async () => {
    const { router, load } = routerWithChunk();
    const stop = prefetchNavigations(router);
    const navigation = router.navigate('/epg?category=c4');

    await waitFor(() => expect(sent()).toContain('catalog.channels'));
    expect(router.state.location.pathname).toBe('/');
    expect(raw.mock.calls.filter(([c]) => c === 'catalog.categories').map(([, a]) => a)).toEqual([guideCategoriesArgs('s1')]);
    expect(raw.mock.calls.find(([c]) => c === 'catalog.channels')![1]).toEqual(channelPageArgs({ sourceId: 's1', categoryId: 'c4' }, 0));

    load();
    await navigation;
    stop();
  });
});
