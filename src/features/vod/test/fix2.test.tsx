import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Page, PageQuery, SeriesDetail, VodDetail, VodItem } from '@/api/types';
import { useShellStore } from '@/shell';

import { ActorPage } from '../pages/ActorPage';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { VodLandingPage } from '../pages/VodLandingPage';
import { installDomStubs, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const movie = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` },
  title: `Movie ${i}`,
  year: 2020,
  categoryId: 'c1',
});
const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: 30, position: 0 } as Category];
const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: 's1' };
const ep = (id: string, season: number, episode: number) => ({ id, seriesRef: sref, season, episode, title: `Episode ${season}.${episode}` });

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings({ tmdb: { enabled: true } });
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [movie(1), movie(2)];
  h['catalog.movies'] = (a): Page<VodItem> => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, 30 - q.offset)) }, (_, i) => movie(q.offset + i));
    return { items, total: 30, offset: q.offset, limit: q.limit };
  };
  h['catalog.search'] = () => ({ live: [], movies: [movie(1)], series: [] });
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['xtream.vodDetail'] = (): VodDetail => ({
    item: { ...movie(7), title: 'Dune: Part Two', containerExtension: 'mkv' },
    cast: [],
    providerDetailsUnavailable: false,
    backdrops: ['http://img/backdrop.jpg'],
  });
  h['xtream.seriesDetail'] = (): SeriesDetail => ({
    item: { ref: sref, title: 'Severance', categoryId: 'c1' },
    seasons: [
      { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
      { number: 2, episodes: [ep('e21', 2, 1)] },
      { number: 3, episodes: [ep('e31', 3, 1)] },
    ],
    cast: [],
    providerDetailsUnavailable: false,
    backdrops: ['http://img/backdrop.jpg'],
  });
  h['tmdb.movie'] = () => null;
  h['tmdb.tv'] = () => null;
  h['tmdb.similar'] = () => [];
  h['tmdb.person'] = () => ({ id: 9, name: 'Britt Lower', knownFor: [] });
  played.length = 0;
  usePlayerStore.setState({ source: undefined, status: 'idle', mode: 'inline', positionSeconds: 0 });
  useShellStore.setState({ header: null, headerOwner: null });
  localStorage.clear();
});
afterEach(() => cleanup());

const seriesRoute = [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }];
const h1Texts = () => screen.queryAllByRole('heading', { level: 1 }).map((h) => h.textContent?.trim());
const headerTitle = () => useShellStore.getState().header?.title;
const selected = (name: RegExp) => screen.getByRole('tab', { name }).getAttribute('aria-selected');

describe('U4-fix2: the detail backdrop never takes pointer events', () => {
  it('marks the backdrop and its gradient layers pointer-events-none', async () => {
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByRole('heading', { name: 'Severance', level: 1 });
    const backdrop = screen.getByTestId('vod-detail-backdrop');
    expect(backdrop.className).toContain('pointer-events-none');
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    const layers = Array.from(backdrop.children).filter((c) => c.tagName === 'DIV');
    expect(layers.length).toBe(2);
    for (const layer of layers) expect(layer.className).toContain('pointer-events-none');
  });

  it('switches seasons by pointer and by keyboard', async () => {
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByRole('tab', { name: /Season 1/ });
    expect(selected(/Season 1/)).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: /Season 2/ }));
    await waitFor(() => expect(selected(/Season 2/)).toBe('true'));
    expect(await screen.findByRole('button', { name: 'Play S02E01 Episode 2.1' })).toBeTruthy();

    act(() => {
      fireEvent.keyDown(screen.getByRole('tab', { name: /Season 2/ }), { key: 'ArrowRight' });
    });
    await waitFor(() => expect(selected(/Season 3/)).toBe('true'));
    expect(await screen.findByRole('button', { name: 'Play S03E01 Episode 3.1' })).toBeTruthy();

    act(() => {
      fireEvent.keyDown(screen.getByRole('tab', { name: /Season 3/ }), { key: 'Home' });
    });
    await waitFor(() => expect(selected(/Season 1/)).toBe('true'));
  });
});

describe('U4-fix2: one h1 per page, matching the shell header title', () => {
  it('movie landing', async () => {
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    await screen.findByText('Movie 1');
    expect(h1Texts()).toEqual(['Movies']);
    expect(headerTitle()).toBe('Movies');
  });

  it('category grid', async () => {
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Movie 0');
    await waitFor(() => expect(h1Texts()).toEqual(['Action']));
    expect(headerTitle()).toBe('Action');
  });

  it('category grid for all movies', async () => {
    renderAt('/s/src1/movies/c/all', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Movie 0');
    expect(h1Texts()).toEqual(['All movies']);
    expect(headerTitle()).toBe('All movies');
  });

  it('movie detail, browse and watch states', async () => {
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    expect(h1Texts()).toEqual(['Dune: Part Two']);
    await waitFor(() => expect(headerTitle()).toBe('Dune: Part Two'));
    fireEvent.click(screen.getByRole('button', { name: /^Play/ }));
    await screen.findByTestId('player-stage');
    expect(h1Texts()).toEqual(['Dune: Part Two']);
  });

  it('series detail', async () => {
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByRole('heading', { name: 'Severance', level: 1 });
    expect(h1Texts()).toEqual(['Severance']);
    await waitFor(() => expect(headerTitle()).toBe('Severance'));
  });

  it('actor', async () => {
    renderAt('/s/src1/actor/9', [{ path: '/s/:sourceId/actor/:personId', element: <ActorPage /> }]);
    await screen.findByRole('heading', { name: 'Britt Lower', level: 1 });
    expect(h1Texts()).toEqual(['Britt Lower']);
    await waitFor(() => expect(headerTitle()).toBe('Britt Lower'));
  });

  it('search, empty and with results', async () => {
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    await screen.findByText('Search every source');
    expect(h1Texts()).toEqual(['Search']);
    expect(headerTitle()).toBe('Search');
    cleanup();
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
    await screen.findByText('Movie 1');
    expect(h1Texts()).toEqual(['Search']);
  });
});

describe('U4-fix2: exactly one h1 in every other state of every routed page', () => {
  const pending = () => new Promise<never>(() => undefined);
  const fail = () => {
    throw { code: 'network', message: 'Portal unreachable' };
  };

  it('series landing', async () => {
    rpcMock.handlers['catalog.recentlyAdded'] = () => [];
    renderAt('/s/src1/series', [{ path: '/s/:sourceId/series', element: <VodLandingPage kind="series" /> }]);
    await screen.findByText('Recently added');
    expect(h1Texts()).toEqual(['Series']);
    expect(headerTitle()).toBe('Series');
  });

  it('landing error', async () => {
    rpcMock.handlers['sources.get'] = fail;
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    await screen.findByText('Portal unreachable');
    expect(h1Texts()).toEqual(['Movies']);
  });

  it('series category grid', async () => {
    rpcMock.handlers['catalog.series'] = () => ({ items: [], total: 0, offset: 0, limit: 60 });
    renderAt('/s/src1/series/c/all', [{ path: '/s/:sourceId/series/c/:categoryId', element: <CategoryGridPage kind="series" /> }]);
    await waitFor(() => expect(h1Texts()).toEqual(['All series']));
    expect(headerTitle()).toBe('All series');
  });

  it('movie detail loading and error', async () => {
    rpcMock.handlers['xtream.vodDetail'] = pending;
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await waitFor(() => expect(h1Texts()).toEqual(['Movies']));
    expect(headerTitle()).toBe('Movies');
    cleanup();
    rpcMock.handlers['xtream.vodDetail'] = fail;
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByText('Portal unreachable');
    expect(h1Texts()).toEqual(['Movies']);
  });

  it('series detail loading and error', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = pending;
    renderAt('/s/src1/series/s1', seriesRoute);
    await waitFor(() => expect(h1Texts()).toEqual(['Series']));
    expect(headerTitle()).toBe('Series');
    cleanup();
    rpcMock.handlers['xtream.seriesDetail'] = fail;
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByText('Portal unreachable');
    expect(h1Texts()).toEqual(['Series']);
  });

  it('actor with TMDB off, not found, and error', async () => {
    const route = [{ path: '/s/:sourceId/actor/:personId', element: <ActorPage /> }];
    rpcMock.handlers['settings.get'] = () => settings();
    renderAt('/s/src1/actor/9', route);
    await screen.findByText('TMDB metadata is off');
    expect(h1Texts()).toEqual(['Actor']);
    expect(headerTitle()).toBe('Actor');
    cleanup();
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { enabled: true } });
    rpcMock.handlers['tmdb.person'] = () => null;
    renderAt('/s/src1/actor/9', route);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(h1Texts()).toEqual(['Actor']);
    cleanup();
    rpcMock.handlers['tmdb.person'] = fail;
    renderAt('/s/src1/actor/9', route);
    await screen.findByText('Portal unreachable');
    expect(h1Texts()).toEqual(['Actor']);
  });

  it('scoped search', async () => {
    renderAt('/s/src1/search?q=movie', [{ path: '/s/:sourceId/search', element: <SearchPage scoped /> }]);
    await screen.findByText('Movie 1');
    expect(h1Texts()).toEqual(['Search']);
    expect(headerTitle()).toBe('Search');
  });
});
