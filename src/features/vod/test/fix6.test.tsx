/**
 * U-vod3. R2-r3 F1: a source facet kept from an earlier query can be cleared
 * from the empty state. F4: counts use the UI language's grouping. F5: cards
 * show `titleBase`, so a year in the title is not printed twice.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Page, PageQuery, VodItem } from '@/api/types';

import { CategoryGridPage } from '../pages/CategoryGridPage';
import { SearchPage } from '../pages/SearchPage';
import { VodLandingPage } from '../pages/VodLandingPage';
import { currentLocation, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const movie = (i: number, sourceId = 'src1'): VodItem => ({
  ref: { sourceId, contentType: 'movie', itemId: `m${i}` },
  title: `Alpha Movie ${i} (2021)`,
  titleBase: `Alpha Movie ${i}`,
  year: 2021,
  categoryId: 'c1',
});
const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: 1500, position: 0 } as Category];

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src, makeSource('src2', 'm3u', 'Zed M3U')];
  h['settings.get'] = () => settings();
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [movie(1)];
  h['catalog.movies'] = (a: unknown): Page<VodItem> => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, 3 - q.offset)) }, (_, i) => movie(q.offset + i + 1));
    return { items, total: 1500, offset: q.offset, limit: q.limit };
  };
  h['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
});
afterEach(() => cleanup());

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

describe('F1: a stale source facet can be cleared when it has no results', () => {
  it('names the facet source and offers "Search all sources"', async () => {
    // "zeta" only matches in src1; the facet from the previous query points at src2.
    rpcMock.handlers['catalog.search'] = (a) => {
      const { sourceId } = a as { sourceId?: string };
      return { live: [], movies: sourceId && sourceId !== 'src1' ? [] : [movie(9)], series: [] };
    };
    renderAt('/search?q=zeta&source=src2', [{ path: '/search', element: <SearchPage /> }]);
    expect(await screen.findByText('No results for "zeta" in Zed M3U')).toBeTruthy();
    expect(callsOf('catalog.search').some((c) => (c.args as { sourceId?: string }).sourceId === 'src2')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Search all sources' }));
    expect(await screen.findByText('Alpha Movie 9')).toBeTruthy();
    expect(currentLocation).toBe('/search?q=zeta');
    expect(screen.queryByText(/No results/)).toBeNull();
  });

  it('keeps the plain empty state when no facet is set', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderAt('/search?q=zeta', [{ path: '/search', element: <SearchPage /> }]);
    expect(await screen.findByText('No results for "zeta"')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search all sources' })).toBeNull();
  });
});

describe('F5: cards show the title without the year suffix', () => {
  it('grid cards use titleBase and keep the full title in the tooltip', async () => {
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    const caption = await screen.findByText('Alpha Movie 1');
    expect(screen.queryByText('Alpha Movie 1 (2021)')).toBeNull();
    expect(caption.closest('a')?.getAttribute('title')).toBe('Alpha Movie 1 (2021)');
  });

  it('search and recently-added rails use titleBase', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(4)], series: [] });
    renderAt('/search?q=alpha', [{ path: '/search', element: <SearchPage /> }]);
    const caption = await screen.findByText('Alpha Movie 4');
    expect(caption.closest('a')?.getAttribute('title')).toBe('Alpha Movie 4 (2021)');
    cleanup();

    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    expect(await screen.findByText('Alpha Movie 1')).toBeTruthy();
    expect(screen.queryByText('Alpha Movie 1 (2021)')).toBeNull();
  });
});

describe('F4: counts follow the UI language', () => {
  it('groups category counts with the active locale', async () => {
    await i18n.changeLanguage('de');
    try {
      renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
      const index = await screen.findByRole('list', { name: 'Categories' });
      expect(within(index).getAllByText('1.500').length).toBeGreaterThan(0);
      expect(within(index).queryByText('1,500')).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
