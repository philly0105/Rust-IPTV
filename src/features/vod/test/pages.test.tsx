import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Page, PageQuery, SeriesDetail, TmdbMovie, VodDetail, VodItem } from '@/api/types';

import { ActorPage } from '../pages/ActorPage';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { VodLandingPage } from '../pages/VodLandingPage';
import { forgetSpots } from '../hooks/useScrollMemory';
import { vodRoutes } from '../routes';
import { currentLocation, i18n, installDomStubs, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

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
  // Parental controls off: detail pages open without a lock check (C2).
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
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
    providerDetailsUnavailable: false,
    backdrops: [],
  });
  h['tmdb.movie'] = () => tmdbMovie;
  h['tmdb.similar'] = () => [];
}

beforeAll(installDomStubs);
beforeEach(() => {
  baseHandlers();
  forgetSpots();
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

  it('marks saved titles and toggles My List from the poster corner and the S key (C3)', async () => {
    const saved = movie(1);
    const toggles: unknown[] = [];
    const list = [{ ref: saved.ref, snapshot: { title: saved.title, contentType: 'movie' as const }, addedAt: '2026-10-10T00:00:00Z', watched: false }];
    rpcMock.handlers['watchlist.list'] = () => list;
    // The toggle reads the app-wide list cache (the harness renders with its own client).
    const { queryClient } = await import('@/api/query');
    queryClient.setQueryData(['watchlist.list', {}], list);
    rpcMock.handlers['watchlist.toggle'] = (a) => {
      toggles.push(a);
      return { inList: true };
    };
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Movie 0');
    // The saved title says so in its option name and keeps its marker; others have a hover toggle.
    await waitFor(() => expect(screen.getByRole('group', { name: /^Movie 1 \(.*, In My List$/ })).toBeTruthy());
    const marker = (name: RegExp) => screen.getByRole('group', { name }).querySelector('[data-testid="mylist-grid-toggle"]');
    expect(marker(/^Movie 1 \(/)?.getAttribute('data-in-list')).toBe('true');
    expect(marker(/^Movie 0 \(/)?.hasAttribute('data-in-list')).toBe(false);
    // Nothing focusable inside an option (axe nested-interactive).
    expect(document.querySelectorAll('[role="option"] button, [role="option"] a, [role="option"] [tabindex]')).toHaveLength(0);

    // The corner toggles without opening the title.
    const before = currentLocation;
    fireEvent.click(marker(/^Movie 0 \(/)!);
    await waitFor(() => expect(toggles).toHaveLength(1));
    expect((toggles[0] as { ref: { itemId: string } }).ref.itemId).toBe(movie(0).ref.itemId);
    expect(currentLocation).toBe(before);

    // S toggles the title under the keyboard cursor.
    const grid = screen.getByTestId('vod-grid');
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 's' });
    await waitFor(() => expect(toggles).toHaveLength(2));
    expect((toggles[1] as { ref: { itemId: string } }).ref.itemId).toBe(movie(1).ref.itemId);

    // A poster's menu (right click, or Shift+F10 on the cursor) offers My List too.
    fireEvent.contextMenu(screen.getByRole('group', { name: /^Movie 2 \(/ }), { clientX: 30, clientY: 30 });
    let menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open details' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /menuAdd|Add to My List/ }));
    await waitFor(() => expect(toggles).toHaveLength(3));
    expect((toggles[2] as { ref: { itemId: string } }).ref.itemId).toBe(movie(2).ref.itemId);
    grid.focus();
    // The cursor's card shows its toggle (S acts on it).
    expect(screen.getByRole('group', { name: /^Movie 1 \(/ }).querySelector('[data-testid="mylist-grid-toggle"]')!.className).toContain('opacity-100');
    fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open details' })).toBeTruthy();
    queryClient.clear();
  });

  it('binds S (and the other cursor keys) only while the grid listbox has focus (Run 3 amendment 15:19)', async () => {
    const list: unknown[] = [];
    rpcMock.handlers['watchlist.list'] = () => list;
    rpcMock.handlers['watchlist.toggle'] = () => ({ inList: true });
    const { queryClient } = await import('@/api/query');
    queryClient.setQueryData(['watchlist.list', {}], list);
    const { shortcutRegistry } = await import('@/shell');
    let offOther: (() => void) | undefined;
    try {
      renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
      await screen.findByText('Movie 0');
      const grid = screen.getByTestId('vod-grid');
      expect(document.activeElement).not.toBe(grid);

      // Unfocused grid: S, W and the poster menu keys are not claimed (fireEvent returns false
      // when a handler cancelled the event), and S is not in the live shortcut list.
      expect(fireEvent.keyDown(document.body, { key: 's' })).toBe(true);
      expect(fireEvent.keyDown(document.body, { key: 'w' })).toBe(true);
      expect(fireEvent.keyDown(document.body, { key: 'F10', shiftKey: true })).toBe(true);
      expect(shortcutRegistry.list().some((x) => x.area === 'Vod' && x.combo === 's')).toBe(false);

      // Another page-wide S (the player's screenshot) registered while the grid is shown gets the key.
      const otherS = vi.fn();
      offOther = shortcutRegistry.register('s', otherS, { description: 'other', area: 'Playback' });
      fireEvent.keyDown(document.body, { key: 's' });
      expect(otherS).toHaveBeenCalledTimes(1);
      offOther();
      offOther = undefined;

      // Focused grid: S belongs to the grid's cursor.
      act(() => grid.focus());
      fireEvent.keyDown(grid, { key: 'ArrowRight' });
      expect(fireEvent.keyDown(grid, { key: 's' })).toBe(false);
      await waitFor(() => expect(callsOf('watchlist.toggle')).toHaveLength(1));
      expect(shortcutRegistry.list().some((x) => x.area === 'Vod' && x.combo === 's')).toBe(true);

      // Focus moves to the search box: S is free again.
      act(() => screen.getByPlaceholderText('Search this category').focus());
      expect(fireEvent.keyDown(document.body, { key: 's' })).toBe(true);
      expect(callsOf('watchlist.toggle')).toHaveLength(1);
    } finally {
      offOther?.();
      queryClient.clear();
    }
  });

  it('the corner toggle is busy and neither pressed nor saved until My List has loaded (C3)', async () => {
    let resolve: ((v: unknown) => void) | undefined;
    rpcMock.handlers['watchlist.list'] = () => new Promise((r) => (resolve = r));
    rpcMock.handlers['watchlist.toggle'] = () => ({ inList: true });
    renderAt('/s/src1/movies/c/c1', [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }]);
    await screen.findByText('Movie 0');
    const corner = () => screen.getByRole('group', { name: /^Movie 0 \(/ }).querySelector('[data-testid="mylist-grid-toggle"]')!;
    expect(corner().getAttribute('aria-busy')).toBe('true');
    expect(corner().hasAttribute('aria-pressed')).toBe(false);
    expect(corner().hasAttribute('data-in-list')).toBe(false);

    // Neither the corner nor S sends a toggle from the unknown state.
    fireEvent.click(corner());
    const grid = screen.getByTestId('vod-grid');
    grid.focus();
    fireEvent.keyDown(grid, { key: 's' });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(callsOf('watchlist.toggle')).toHaveLength(0);

    resolve?.([]);
    await waitFor(() => expect(corner().getAttribute('aria-pressed')).toBe('false'));
    expect(corner().hasAttribute('aria-busy')).toBe(false);
    expect(corner().getAttribute('data-state')).toBe('ready');
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

  it('B4-vod-D20: a Stalker movie (not in the local catalog) never asks catalog.sameTitle and shows no other sources', async () => {
    baseHandlers('stalker');
    rpcMock.handlers['stalker.vodDetail'] = rpcMock.handlers['xtream.vodDetail']!;
    rpcMock.handlers['catalog.sameTitle'] = () => {
      throw { code: 'not_found', message: 'item m7 not found' };
    };
    renderAt('/s/src1/movie/m7', route);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    expect(await screen.findByRole('button', { name: 'Resume from 12:34' })).toBeTruthy();
    expect(callsOf('catalog.sameTitle')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /other source/ })).toBeNull();
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
      providerDetailsUnavailable: false,
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

  it('groups global results into type tabs with source badges and portal results', async () => {
    renderAt('/search?q=dune', [{ path: '/search', element: <SearchPage /> }]);
    // Movies come first and fill the page as a vertical grid; the other types wait behind their tabs.
    const moviesTab = await screen.findByRole('tab', { name: /Movies\s*2/ });
    expect(moviesTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('vod-search-movies')).toBeTruthy();
    expect(await screen.findByText('Movie 1')).toBeTruthy();
    expect(screen.getAllByText('Beta Portal').length).toBeGreaterThan(0);
    expect(screen.queryByText('Dune TV')).toBeNull();
    expect(callsOf('catalog.search')[0]!.args).toEqual({ query: 'dune', limit: 61 });

    fireEvent.click(await screen.findByRole('tab', { name: /Series\s*1/ }));
    expect(await screen.findByText('Portal Show')).toBeTruthy();
    expect(currentLocation).toBe('/search?q=dune&type=series');

    fireEvent.click(screen.getByRole('tab', { name: /Channels\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Dune TV/ }));
    await waitFor(() => expect(played).toHaveLength(1));
  });

  it('labels each search result with the language the provider gives it', async () => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [],
      movies: [
        { ...movie(1), title: 'EN - Interstellar (2014)', titleBase: 'Interstellar' },
        { ...movie(2), title: 'IT - Interstellar (2014)', titleBase: 'Interstellar', categoryName: 'VOD - FILM [IT]' },
        { ...movie(3), title: 'NF - Interstellar (2014)', titleBase: 'Interstellar', categoryName: 'VOD - NETFLIX [MULTISUB]' },
        { ...movie(4), title: 'Interstellar (2014)', titleBase: 'Interstellar', categoryName: 'VOD - GERMANY [DE]' },
      ],
      series: [],
    });
    renderAt('/search?q=interstellar', [{ path: '/search', element: <SearchPage /> }]);
    const grid = await screen.findByTestId('vod-search-movies');
    await within(grid).findByRole('link', { name: /English/ });
    const names = within(grid).getAllByRole('link').map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual([
      expect.stringMatching(/English/),
      expect.stringMatching(/Italian/),
      expect.stringMatching(/Multi-sub/),
      expect.stringMatching(/German/),
    ]);
    expect(within(grid).getByText('EN')).toBeTruthy();
    expect(within(grid).getByText('IT')).toBeTruthy();
  });

  it('scopes to one source and asks a stalker portal directly', async () => {
    baseHandlers('stalker');
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    rpcMock.handlers['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
    renderAt('/s/src1/search?q=dune', [{ path: '/s/:sourceId/search', element: <SearchPage scoped /> }]);
    await screen.findByText('No results for "dune"');
    expect(callsOf('catalog.search')[0]!.args).toEqual({ query: 'dune', sourceId: 'src1', limit: 61 });
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
    providerDetailsUnavailable: false,
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
    // Grid cells are listbox options (no links inside); selecting one navigates by the item's own content type.
    const card = await screen.findByRole('option', { name: 'Severance' });
    expect(screen.getByRole('option', { name: /^Movie 1 / })).toBeTruthy();
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
    rpcMock.handlers['tmdb.tv'] = () => ({ tmdbId: 95396, mediaType: 'tv', title: 'Severance', genres: [], cast: [], crew: [], creators: ['Dan Erickson'], seasons: [], similar: [] });
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

describe('U4-fix4: backdrop stacking, capped search, localized runtimes', () => {
  const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: 's1' };
  const seriesWithSeasons = (): SeriesDetail => ({
    item: { ref: sref, title: 'Severance', categoryId: 'c1', backdropUrl: 'http://img/bd.jpg' } as SeriesDetail['item'],
    seasons: [
      { number: 1, episodes: [{ id: 'e11', seriesRef: sref, season: 1, episode: 1, title: 'Good News', durationSeconds: 5580 }] },
      { number: 2, episodes: [{ id: 'e21', seriesRef: sref, season: 2, episode: 1, title: 'Hello', durationSeconds: 2700 }] },
    ],
    cast: [],
    providerDetailsUnavailable: false,
    backdrops: [],
  });

  /** Nearest ancestor that creates a stacking context through Tailwind `isolate`. */
  const stackingRoot = (el: Element | null): Element | null => {
    let cur = el?.parentElement ?? null;
    while (cur && !cur.classList.contains('isolate')) cur = cur.parentElement;
    return cur;
  };

  it('F1: the series backdrop paints in the page stacking context, under the season tabs', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = seriesWithSeasons;
    rpcMock.handlers['positions.forSeries'] = () => [];
    rpcMock.handlers['tmdb.tv'] = () => null;
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    const tab = await screen.findByRole('tab', { name: /Season 1/ });
    const page = screen.getByTestId('vod-series-detail');
    const backdrop = screen.getByTestId('vod-detail-backdrop');
    expect(backdrop.className).toContain('-z-10');
    // The hero must not isolate: its -z-10 bleed would then paint over later in-flow content.
    expect(backdrop.closest('section')?.classList.contains('isolate')).toBe(false);
    expect(stackingRoot(backdrop)).toBe(page);
    expect(stackingRoot(tab)).toBe(page);
  });

  it('F1: the movie backdrop also resolves against the page root', async () => {
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    expect(stackingRoot(screen.getByTestId('vod-detail-backdrop'))).toBe(screen.getByTestId('vod-movie-detail'));
  });

  it('F11: episode and hero runtimes follow the active language', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = seriesWithSeasons;
    rpcMock.handlers['positions.forSeries'] = () => [];
    rpcMock.handlers['tmdb.tv'] = () => null;
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    await screen.findByRole('tab', { name: /Season 1/ });
    expect(await screen.findByText('1h 33m')).toBeTruthy();
    cleanup();
    await i18n.changeLanguage('ja');
    try {
      renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
      await screen.findByRole('tab', { name: /Season 1/ });
      expect(await screen.findByText(/1\s*時間\s*33\s*分/)).toBeTruthy();
      expect(screen.queryByText('1h 33m')).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  describe('F9: search beyond the first page', () => {
    const many = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => movie(i + offset));
    const liveMany = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ref: { sourceId: 'src1', contentType: 'live' as const, itemId: `c${i}` }, name: `News ${i}`, categoryId: 'g', isRadio: false }));

    it('requests limit + 1, shows "60+" and steps to the server clamp with Show more', async () => {
      rpcMock.handlers['catalog.search'] = (a) => {
        const limit = (a as { limit: number }).limit;
        // 1500 matching channels, 5 movies: the server returns at most `limit` per type.
        return { live: liveMany(Math.min(limit, 1500)), movies: many(5), series: [] };
      };
      rpcMock.handlers['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
      renderAt('/search?q=news', [{ path: '/search', element: <SearchPage /> }]);
      fireEvent.click(await screen.findByRole('tab', { name: /Channels/ }));
      await screen.findByText('News 0');
      expect(callsOf('catalog.search')[0]!.args).toEqual({ query: 'news', limit: 61 });
      // Capped at 60 on screen; the 61st probe row is not rendered.
      expect(within(screen.getByTestId('vod-search-channels')).getAllByRole('listitem')[0]!.getAttribute('aria-setsize')).toBe('60');
      expect(screen.queryByText('News 60')).toBeNull();
      expect(screen.getByRole('tab', { name: /Channels\s*60\+/ })).toBeTruthy();
      expect(screen.getByRole('tab', { name: /Movies\s*5$/ })).toBeTruthy();
      const notice = screen.getByTestId('vod-search-capped');
      expect(within(notice).getByText(/Showing the first 60 results of each type/)).toBeTruthy();

      fireEvent.click(within(notice).getByRole('button', { name: 'Show up to 200' }));
      await screen.findByRole('tab', { name: /Channels\s*200\+/ });
      expect(callsOf('catalog.search').at(-1)!.args).toEqual({ query: 'news', limit: 201 });

      fireEvent.click(within(screen.getByTestId('vod-search-capped')).getByRole('button', { name: 'Show up to 1000' }));
      await screen.findByRole('tab', { name: /Channels\s*1000\+/ });
      // The 1000 step still probes one row past the cap, which the 1001 server clamp allows.
      expect(callsOf('catalog.search').at(-1)!.args).toEqual({ query: 'news', limit: 1001 });
      // Rows are virtualized: a thousand channels mount only a window of buttons.
      const grid = screen.getByTestId('vod-search-channels');
      const mounted = grid.querySelectorAll('[data-grid-index]').length;
      expect(mounted).toBeGreaterThan(0);
      expect(mounted).toBeLessThan(200);
      // Last reachable step: no button, ask for a narrower query.
      const last = screen.getByTestId('vod-search-capped');
      expect(within(last).queryByRole('button')).toBeNull();
      expect(within(last).getByText(/Showing the first 1,?000 results of each type\. Refine your search to find the rest\./)).toBeTruthy();
    });

    it('shows no cap notice when every type fits', async () => {
      rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: many(60), series: [] });
      rpcMock.handlers['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
      renderAt('/search?q=dune', [{ path: '/search', element: <SearchPage /> }]);
      await screen.findByRole('tab', { name: /Movies\s*60$/ });
      expect(screen.queryByTestId('vod-search-capped')).toBeNull();
    });

    it('a source facet searches that source and marks capped chip counts "N+" (R2-r2 F4)', async () => {
      // Each source has 100 matching movies; the all-sources page interleaves them.
      rpcMock.handlers['catalog.search'] = (a) => {
        const { limit, sourceId } = a as { limit: number; sourceId?: string };
        const all = Array.from({ length: 200 }, (_, i) => movie(i, i % 2 === 0 ? 'src1' : 'src2'));
        return { live: [], movies: all.filter((m) => !sourceId || m.ref.sourceId === sourceId).slice(0, limit), series: [] };
      };
      rpcMock.handlers['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
      renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
      // Each chip counts its own source's capped search (R6-r3 F8): 60 shown of 100, so "60+",
      // not the 30 rows each source holds in the interleaved all-sources page.
      const chips = await screen.findByRole('group', { name: 'Filter by source' });
      expect(await within(chips).findByRole('button', { name: /Beta Portal\s*60\+/ })).toBeTruthy();
      expect(within(chips).getByRole('button', { name: /Alpha IPTV\s*60\+/ })).toBeTruthy();

      fireEvent.click(within(chips).getByRole('button', { name: /Beta Portal/ }));
      await screen.findByRole('tab', { name: /Movies\s*60\+/ });
      expect(currentLocation).toBe('/search?q=movie&source=src2');
      expect(callsOf('catalog.search').at(-1)!.args).toEqual({ query: 'movie', sourceId: 'src2', limit: 61 });
      // Every card belongs to the facet's source, and the chips still list both sources.
      expect(document.querySelectorAll('a[href^="/s/src1/movie/"]')).toHaveLength(0);
      expect(document.querySelectorAll('a[href^="/s/src2/movie/"]').length).toBeGreaterThan(30);
      const after = screen.getByRole('group', { name: 'Filter by source' });
      expect(within(after).getByRole('button', { name: /Alpha IPTV\s*60\+/ }).getAttribute('aria-pressed')).toBe('false');
      expect(within(after).getByRole('button', { name: /Beta Portal\s*60\+/ }).getAttribute('aria-pressed')).toBe('true');

      // "Show more" steps the facet's own search.
      fireEvent.click(within(screen.getByTestId('vod-search-capped')).getByRole('button', { name: 'Show up to 200' }));
      await screen.findByRole('tab', { name: /Movies\s*100$/ });
      expect(callsOf('catalog.search').at(-1)!.args).toEqual({ query: 'movie', sourceId: 'src2', limit: 201 });
    });
  });
});
