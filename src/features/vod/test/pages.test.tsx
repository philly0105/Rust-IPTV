import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Page, PageQuery, SeriesDetail, TmdbMovie, VodDetail, VodItem } from '@/api/types';

import { ActorPage } from '../pages/ActorPage';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { VodLandingPage } from '../pages/VodLandingPage';
import { vodRoutes } from '../routes';
import { installDomStubs, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

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

const TOTAL = 5000;
const movie = (i: number, sourceId = 'src1'): VodItem => ({
  ref: { sourceId, contentType: 'movie', itemId: `m${i}` },
  title: `Movie ${i}`,
  year: 2000 + (i % 25),
  categoryId: 'c1',
  rating: 7.5,
});
const cats: Category[] = [
  { id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: 1200, position: 0 } as Category,
  { id: 'c2', sourceId: 'src1', contentType: 'movie', name: 'Drama', hidden: false, itemCount: 800, position: 1 } as Category,
];

const ACTOR_ID = 1190668;
const tmdbMovie: TmdbMovie = {
  tmdbId: 693134,
  mediaType: 'movie',
  title: 'Dune: Part Two',
  overview: 'Paul Atreides unites with the Fremen.',
  genres: ['Science Fiction'],
  cast: [{ id: ACTOR_ID, name: 'Timothee Chalamet', role: 'Paul' }],
  crew: [],
  similar: [{ tmdbId: 438631, mediaType: 'movie', title: 'Dune' }],
};

function baseHandlers(sourceKind: 'xtream' | 'stalker' = 'xtream') {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', sourceKind, 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src, makeSource('src2', 'stalker', 'Beta Portal')];
  h['settings.get'] = () => settings({ tmdb: { enabled: true } });
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [movie(1), movie(2), movie(3)];
  const page = (a: unknown): Page<VodItem> => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => movie(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit };
  };
  h['catalog.movies'] = page;
  h['stalker.movies'] = page;
  h['favorites.contains'] = () => [];
  h['favorites.toggle'] = () => ({ isFavorite: true });
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [movie(7, 'src2')];
  h['positions.get'] = () => ({ ref: movie(7).ref, positionSeconds: 754, durationSeconds: 9960, updatedAt: '2026-10-10T00:00:00Z' });
  h['positions.remove'] = () => null;
  h['xtream.vodDetail'] = (): VodDetail => ({
    item: { ...movie(7), title: 'Dune: Part Two', containerExtension: 'mkv' },
    cast: [{ name: 'Timothee Chalamet' }],
    backdrops: [],
  });
  h['tmdb.movie'] = () => tmdbMovie;
  h['tmdb.similar'] = () => [];
}

beforeAll(installDomStubs);
beforeEach(() => {
  baseHandlers();
  played.length = 0;
  usePlayerStore.setState({ source: undefined, status: 'idle', mode: 'inline', positionSeconds: 0 });
  localStorage.clear();
});
afterEach(() => cleanup());

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

describe('vodRoutes', () => {
  it('exports every C7 route', () => {
    expect(vodRoutes.map((r) => r.path)).toEqual([
      'search',
      's/:sourceId/search',
      's/:sourceId/movies',
      's/:sourceId/movies/c/:categoryId',
      's/:sourceId/movie/:itemId',
      's/:sourceId/series',
      's/:sourceId/series/c/:categoryId',
      's/:sourceId/series/:itemId',
      's/:sourceId/actor/:personId',
    ]);
  });
});

describe('VodLandingPage', () => {
  it('shows the recently added rail and the category index with an all-movies entry', async () => {
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    await screen.findByText('Recently added');
    await screen.findByText('Movie 1');
    const index = await screen.findByRole('list', { name: 'Categories' });
    expect(within(index).getByText('All movies')).toBeTruthy();
    expect(within(index).getByText('Action').closest('a')?.getAttribute('href')).toBe('/s/src1/movies/c/c1');
  });
});

describe('CategoryGridPage', () => {
  it('pages a 5000-title category through catalog.movies without rendering it all', async () => {
    renderAt('/s/src1/movies/c/c1?sort=name', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Movie 0');
    const pages = callsOf('catalog.movies');
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]!.args).toEqual({ sourceId: 'src1', categoryId: 'c1', query: { offset: 0, limit: 60, sort: 'name', dir: 'asc' } });
    expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(200);
  });

  it('uses stalker.movies for stalker portals', async () => {
    baseHandlers('stalker');
    renderAt('/s/src1/movies/c/all', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Movie 0');
    expect(callsOf('catalog.movies')).toHaveLength(0);
    expect(callsOf('stalker.movies')[0]!.args).toEqual({ sourceId: 'src1', query: { offset: 0, limit: 42, sort: 'added', dir: 'desc' } });
  });

  it('shows the empty search state when nothing matches', async () => {
    rpcMock.handlers['catalog.movies'] = () => ({ items: [], total: 0, offset: 0, limit: 60 });
    renderAt('/s/src1/movies/c/c1?q=zzz', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Nothing here matches "zzz"');
  });
});

describe('MovieDetailPage', () => {
  const route = [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }];

  it('renders the merged detail with resume, cast links, and other sources', async () => {
    renderAt('/s/src1/movie/m7', route);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    await screen.findByText('Paul Atreides unites with the Fremen.');
    expect(await screen.findByRole('button', { name: 'Resume from 12:34' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeTruthy();
    const actor = await screen.findByRole('link', { name: /Timothee Chalamet/ });
    expect(actor.getAttribute('href')).toBe(`/s/src1/actor/${ACTOR_ID}`);
    expect(await screen.findByRole('button', { name: '1 other source' })).toBeTruthy();
    expect(callsOf('tmdb.movie')[0]!.args).toMatchObject({ title: 'Dune: Part Two', year: 2007 });
  });

  it('plays inline and switches to the watch state; Escape closes it', async () => {
    renderAt('/s/src1/movie/m7', route);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume from 12:34' }));
    await screen.findByTestId('player-stage');
    expect(played).toHaveLength(1);
    // The watch stage's title is now the page's single h1 (the hero is gone).
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Dune: Part Two']);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('player-stage')).toBeNull());
  });

  it('shows an error state with retry when the provider fails', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => {
      throw { code: 'network', message: 'Portal unreachable' };
    };
    renderAt('/s/src1/movie/m7', route);
    await screen.findByText('Portal unreachable');
  });
});

describe('SeriesDetailPage', () => {
  it('lists seasons and episodes with progress, and plays an episode by id', async () => {
    const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: 's1' };
    const ep = (id: string, season: number, episode: number) => ({ id, seriesRef: sref, season, episode, title: `Episode ${season}.${episode}` });
    rpcMock.handlers['xtream.seriesDetail'] = (): SeriesDetail => ({
      item: { ref: sref, title: 'Severance', categoryId: 'c1' },
      seasons: [
        { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
        { number: 2, episodes: [ep('e21', 2, 1)] },
      ],
      cast: [],
      backdrops: [],
    });
    rpcMock.handlers['positions.forSeries'] = () => [
      { ref: sref, episodeId: 'e12', positionSeconds: 600, durationSeconds: 3000, updatedAt: '2026-10-10T00:00:00Z' },
    ];
    rpcMock.handlers['tmdb.tv'] = () => null;
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    await screen.findByRole('heading', { name: 'Severance', level: 1 });
    expect(await screen.findByRole('button', { name: 'Resume S01E02' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Season 1/ })).toBeTruthy();
    expect(screen.getByText('20% watched')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Season 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Play S02E01 Episode 2.1' }));
    await waitFor(() => expect(played).toHaveLength(1));
    expect(played[0]).toMatchObject({ ref: sref, episodeId: 'e21' });
  });
});

describe('ActorPage', () => {
  it('shows the person and links known-for titles into source search', async () => {
    rpcMock.handlers['tmdb.person'] = () => ({
      id: ACTOR_ID,
      name: 'Timothee Chalamet',
      biography: 'American actor.',
      knownFor: [{ tmdbId: 1, mediaType: 'movie', title: 'Wonka', year: 2023 }],
    });
    renderAt(`/s/src1/actor/${ACTOR_ID}`, [{ path: '/s/:sourceId/actor/:personId', element: <ActorPage /> }]);
    await screen.findByRole('heading', { name: 'Timothee Chalamet' });
    expect(screen.getByText('American actor.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Wonka/ }).getAttribute('href')).toBe('/s/src1/search?q=Wonka');
  });

  it('explains that TMDB is off', async () => {
    rpcMock.handlers['settings.get'] = () => settings();
    renderAt('/s/src1/actor/5', [{ path: '/s/:sourceId/actor/:personId', element: <ActorPage /> }]);
    await screen.findByText('TMDB metadata is off');
    expect(callsOf('tmdb.person')).toHaveLength(0);
  });
});

describe('SearchPage', () => {
  beforeEach(() => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [{ ref: { sourceId: 'src1', contentType: 'live', itemId: 'c1' }, name: 'Dune TV', number: 5, categoryId: 'g', categoryName: 'Films', isRadio: false }],
      movies: [movie(1), movie(2, 'src2')],
      series: [],
    });
    rpcMock.handlers['stalker.search'] = (a) =>
      (a as { contentType: string }).contentType === 'series'
        ? { items: [{ ref: { sourceId: 'src2', contentType: 'series', itemId: 'p1' }, title: 'Portal Show', categoryId: 'x' }], total: 1, offset: 0, limit: 14 }
        : { items: [], total: 0, offset: 0, limit: 14 };
  });

  it('groups global results with source badges and portal results', async () => {
    renderAt('/search?q=dune', [{ path: '/search', element: <SearchPage /> }]);
    await screen.findByText('Dune TV');
    expect(screen.getByRole('heading', { name: /Movies/ })).toBeTruthy();
    expect(await screen.findByText('Portal Show')).toBeTruthy();
    expect(screen.getAllByText('Beta Portal').length).toBeGreaterThan(0);
    expect(callsOf('catalog.search')[0]!.args).toEqual({ query: 'dune', limit: 60 });
    fireEvent.click(screen.getByRole('button', { name: /Dune TV/ }));
    await waitFor(() => expect(played).toHaveLength(1));
  });

  it('scopes to one source and asks a stalker portal directly', async () => {
    baseHandlers('stalker');
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    rpcMock.handlers['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
    renderAt('/s/src1/search?q=dune', [{ path: '/s/:sourceId/search', element: <SearchPage scoped /> }]);
    await screen.findByText('No results for "dune"');
    expect(callsOf('catalog.search')[0]!.args).toEqual({ query: 'dune', sourceId: 'src1', limit: 60 });
    expect(callsOf('stalker.search').map((c) => (c.args as { contentType: string }).contentType).sort()).toEqual(['movie', 'series']);
  });

  it('asks for a query when there is none', async () => {
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    await screen.findByText('Search every source');
    expect(callsOf('catalog.search')).toHaveLength(0);
  });
});

describe('U4-fix1: stalker VOD-as-series, episode downloads, TMDB attribution', () => {
  const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: '7001' };
  const seriesDetail = (): SeriesDetail => ({
    item: { ref: sref, title: 'Severance', categoryId: 'c1' },
    seasons: [{ number: 1, episodes: [{ id: 's|7001:1|2', seriesRef: sref, season: 1, episode: 2, title: 'Half Loop', containerExtension: 'mkv' }] }],
    cast: [],
    backdrops: [],
  });

  it('routes a series row from stalker.movies to the series page, which loads stalker.seriesDetail', async () => {
    baseHandlers('stalker');
    rpcMock.handlers['stalker.movies'] = () => ({
      items: [movie(1), { ref: sref, title: 'Severance', categoryId: 'c1' }],
      total: 2,
      offset: 0,
      limit: 42,
    });
    rpcMock.handlers['stalker.seriesDetail'] = seriesDetail;
    rpcMock.handlers['positions.forSeries'] = () => [];
    rpcMock.handlers['tmdb.tv'] = () => null;
    renderAt('/s/src1/movies/c/all', [
      { path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> },
      { path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> },
      { path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> },
    ]);
    const card = (await screen.findByText('Severance')).closest('a')!;
    expect(card.getAttribute('href')).toBe('/s/src1/series/7001');
    expect((await screen.findByText('Movie 1')).closest('a')!.getAttribute('href')).toBe('/s/src1/movie/m1');
    fireEvent.click(card);
    await screen.findByRole('heading', { name: 'Severance', level: 1 });
    expect(callsOf('stalker.seriesDetail')[0]!.args).toEqual({ ref: sref });
    expect(callsOf('stalker.vodDetail')).toHaveLength(0);
  });

  it('queues an episode download as title = series name, subtitle = S01E02 · Episode title', async () => {
    baseHandlers('stalker');
    rpcMock.handlers['stalker.seriesDetail'] = seriesDetail;
    rpcMock.handlers['positions.forSeries'] = () => [];
    rpcMock.handlers['tmdb.tv'] = () => null;
    rpcMock.handlers['stalker.streamUrl'] = () => ({ url: 'http://mock/ep.mkv', kind: 'direct', title: 'x', isLive: false, isRadio: false });
    rpcMock.handlers['downloads.start'] = (a) => ({ id: 1, ...(a as object), status: 'queued' });
    renderAt('/s/src1/series/7001', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Download S01E02 Half Loop' }));
    await waitFor(() => expect(callsOf('downloads.start')).toHaveLength(1));
    expect(callsOf('stalker.streamUrl')[0]!.args).toEqual({ ref: sref, episodeId: 's|7001:1|2' });
    expect(callsOf('downloads.start')[0]!.args).toMatchObject({
      ref: sref,
      episodeId: 's|7001:1|2',
      title: 'Severance',
      subtitle: 'S01E02 · Half Loop',
      url: 'http://mock/ep.mkv',
      fileNameHint: 'Severance - S01E02 - Half Loop.mkv',
    });
  });

  it('shows the TMDB notice and logo link on movie detail, series detail, and the actor page', async () => {
    const notice = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    expect((await screen.findByTestId('tmdb-attribution')).textContent).toContain(notice);
    expect(screen.getByRole('link', { name: /TMDB \(The Movie Database\)/ }).getAttribute('href')).toBe('https://www.themoviedb.org');
    cleanup();

    rpcMock.handlers['xtream.seriesDetail'] = seriesDetail;
    rpcMock.handlers['positions.forSeries'] = () => [];
    rpcMock.handlers['tmdb.tv'] = () => null;
    renderAt('/s/src1/series/7001', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    expect((await screen.findByTestId('tmdb-attribution')).textContent).toContain(notice);
    cleanup();

    rpcMock.handlers['tmdb.person'] = () => ({ id: ACTOR_ID, name: 'Timothee Chalamet', knownFor: [] });
    renderAt(`/s/src1/actor/${ACTOR_ID}`, [{ path: '/s/:sourceId/actor/:personId', element: <ActorPage /> }]);
    await screen.findByRole('heading', { name: 'Timothee Chalamet' });
    expect(screen.getByTestId('tmdb-attribution').textContent).toContain(notice);
  });

  it('omits the TMDB notice when enrichment is off', async () => {
    rpcMock.handlers['settings.get'] = () => settings();
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    expect(screen.queryByTestId('tmdb-attribution')).toBeNull();
  });

  it('tells a TMDB outage apart from "no similar titles"', async () => {
    rpcMock.handlers['tmdb.movie'] = () => {
      throw { code: 'network', message: 'TMDB unreachable', retryable: true };
    };
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByText('TMDB could not be reached');
    expect(screen.queryByText('TMDB has no similar titles for this one.')).toBeNull();
  });
});
