/**
 * Polish pass (B4): back navigation keeps your place, Escape goes back, failed
 * later pages retry in place, grid posters show resume progress, the designed
 * empty/loading/error states, and a 10k-title grid budget.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavigate } from 'react-router';

import type { Category, Page, PageQuery, SeriesDetail, VodDetail, VodItem } from '@/api/types';
import { useShellStore } from '@/shell';

import { isBackEscape } from '../hooks/useBackKey';
import { forgetSpots, recallSpot, rememberSpot } from '../hooks/useScrollMemory';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
import { currentLocation, installDomStubs, keyboardFocus, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

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

const movie = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` },
  title: `Movie ${i}`,
  categoryId: 'c1',
});
const cats: Category[] = [
  { id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: 1200, position: 0 } as Category,
  { id: 'c2', sourceId: 'src1', contentType: 'movie', name: 'Drama', hidden: false, itemCount: 800, position: 1 } as Category,
];

function pages(total: number, fail?: (offset: number) => boolean) {
  return (a: unknown): Page<VodItem> => {
    const q = (a as { query: PageQuery }).query;
    if (fail?.(q.offset)) throw { code: 'timeout', message: 'Portal timed out' };
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, total - q.offset)) }, (_, i) => movie(q.offset + i));
    return { items, total, offset: q.offset, limit: q.limit };
  };
}

function baseHandlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['settings.get'] = () => settings();
  // Parental controls off: detail pages open without a lock check (C2).
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [movie(1)];
  h['catalog.movies'] = pages(5000);
  h['positions.continueWatching'] = () => [];
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
  h['xtream.vodDetail'] = (): VodDetail => ({
    item: { ...movie(7), title: 'Dune: Part Two', containerExtension: 'mkv' },
    cast: [],
    providerDetailsUnavailable: false,
    backdrops: [],
  });
}

// jsdom has no scrolling: back scrollTop with a per-element store so offsets can be written and read.
const scrollTops = new WeakMap<Element, number>();
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
beforeAll(() => {
  installDomStubs();
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrollTops.set(this, v);
    },
  });
});
afterAll(() => {
  if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
});
beforeEach(() => {
  baseHandlers();
  forgetSpots();
  played.length = 0;
  usePlayerStore.setState({ source: undefined, status: 'idle', mode: 'inline', positionSeconds: 0 });
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false });
});
afterEach(() => cleanup());

const gridRoute = { path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> };
const landingRoute = { path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> };

/** A detail page stand-in with a Back button (history -1). */
function BackStub() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      back-stub
    </button>
  );
}
const detailStub = { path: '/s/:sourceId/movie/:itemId', element: <BackStub /> };

const listbox = () => screen.getByTestId('vod-grid');
const optionAt = (i: number) => listbox().querySelector<HTMLElement>(`[role="option"][data-index="${i}"]`);

describe('scroll memory', () => {
  it('merges patches and keeps the last opened index', () => {
    rememberSpot('/a', { scrollTop: 10 });
    rememberSpot('/a', { index: 4 });
    rememberSpot('/a', { scrollTop: 30 });
    expect(recallSpot('/a')).toEqual({ scrollTop: 30, index: 4 });
  });

  it('caps the number of remembered pages', () => {
    for (let i = 0; i < 100; i++) rememberSpot(`/p${i}`, { scrollTop: i });
    expect(recallSpot('/p0')).toBeUndefined();
    expect(recallSpot('/p99')).toEqual({ scrollTop: 99 });
  });
});

describe('CategoryGridPage: back from a detail view', () => {
  it('restores the scroll offset, the cursor on the opened title, and focus, with one Back press', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute, detailStub]);
    await screen.findByText('Movie 2');
    const lb = listbox();
    lb.scrollTop = 120;
    fireEvent.scroll(lb);
    fireEvent.click(screen.getByRole('option', { name: 'Movie 2' }));
    await screen.findByText('back-stub');
    expect(currentLocation).toBe('/s/src1/movie/m2');

    // One Back press returns to the grid (the click pushed a single entry).
    fireEvent.click(screen.getByText('back-stub'));
    await screen.findByText('Movie 2');
    await waitFor(() => expect(optionAt(2)?.getAttribute('data-active')).toBe('true'));
    expect(listbox().scrollTop).toBe(120);
    // Focus comes in the frame after the restore (useScrollMemory's onRestored), the cursor at mount.
    await waitFor(() => expect(document.activeElement).toBe(listbox()));
    expect(currentLocation).toBe('/s/src1/movies/c/c1');
  });

  it('Enter on the cursor opens the title and remembers it', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute, detailStub]);
    await screen.findByText('Movie 0');
    const lb = listbox();
    keyboardFocus(lb);
    fireEvent.keyDown(lb, { key: 'ArrowRight' });
    fireEvent.keyDown(lb, { key: 'Enter' });
    await screen.findByText('back-stub');
    expect(currentLocation).toBe('/s/src1/movie/m1');
    expect(recallSpot('/s/src1/movies/c/c1')?.index).toBe(1);
  });
});

describe('CategoryGridPage: keyboard', () => {
  it('Escape returns to the category list', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('Movie 0');
    act(() => listbox().focus());
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies'));
  });

  it('Escape in the search box does not leave the page', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('Movie 0');
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(currentLocation).toBe('/s/src1/movies/c/c1');
  });

  it('ArrowDown in the search box moves focus to the posters', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('Movie 0');
    const search = screen.getByRole('searchbox');
    act(() => search.focus());
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(listbox());
  });

  it('isBackEscape leaves Escape to inputs, dialogs, modifiers and the shell overlays', () => {
    const ev = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(e, 'target', { value: target });
      return e;
    };
    expect(isBackEscape(ev({ key: 'Escape' }))).toBe(true);
    expect(isBackEscape(ev({ key: 'Enter' }))).toBe(false);
    expect(isBackEscape(ev({ key: 'Escape', ctrlKey: true }))).toBe(false);
    expect(isBackEscape(ev({ key: 'Escape' }, document.createElement('input')))).toBe(false);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.append(item);
    expect(isBackEscape(ev({ key: 'Escape' }, item))).toBe(false);
    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
    expect(isBackEscape(ev({ key: 'Escape' }))).toBe(false);
    tip.remove();
    useShellStore.setState({ paletteOpen: true });
    expect(isBackEscape(ev({ key: 'Escape' }))).toBe(false);
  });
});

describe('CategoryGridPage: states', () => {
  it('shows the loading skeleton while the first page is on its way', async () => {
    rpcMock.handlers['catalog.movies'] = () => new Promise(() => undefined);
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await waitFor(() => expect(document.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByTestId('vod-grid')).toBeNull();
  });

  it('shows the designed empty category state with a way back', async () => {
    rpcMock.handlers['catalog.movies'] = pages(0);
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('This category is empty');
    expect(screen.getByRole('link', { name: 'Back to categories' }).getAttribute('href')).toBe('/s/src1/movies');
  });

  it('shows an error with Try again when the first page fails, and recovers', async () => {
    let fail = true;
    rpcMock.handlers['catalog.movies'] = pages(5000, () => fail);
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('Portal timed out');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Movie 0');
  });

  it('a later page that fails shows a retry cell instead of endless skeletons', async () => {
    let fail = true;
    rpcMock.handlers['catalog.movies'] = pages(5000, (offset) => offset >= 60 && fail);
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('Movie 0');
    // Scroll far enough that page 2 (items 60..119) is in the window.
    const lb = listbox();
    lb.scrollTop = 4200;
    fireEvent.scroll(lb);
    const errors = await screen.findAllByTestId('vod-grid-cell-error');
    expect(errors.length).toBeGreaterThan(0);
    expect(within(errors[0]!).getByText("Couldn't load these titles")).toBeTruthy();
    fail = false;
    // The cell holds no button (it lives inside a listbox option): selecting the cell retries.
    expect(within(errors[0]!).queryByRole('button')).toBeNull();
    fireEvent.click(errors[0]!);
    await waitFor(() => expect(screen.queryAllByTestId('vod-grid-cell-error')).toHaveLength(0));
    expect(currentLocation).toBe('/s/src1/movies/c/c1');
  });

  it('draws resume progress on posters from continue watching', async () => {
    rpcMock.handlers['positions.continueWatching'] = () => [
      { ref: movie(1).ref, positionSeconds: 1800, durationSeconds: 3600, updatedAt: '2026-10-10T00:00:00Z', watched: false },
      { ref: { sourceId: 'other', contentType: 'movie', itemId: 'm2' }, positionSeconds: 10, durationSeconds: 100, updatedAt: '2026-10-10T00:00:00Z', watched: false },
    ];
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    const card = await screen.findByRole('option', { name: /^Movie 1(,|$)/ });
    await waitFor(() => expect(card.querySelector('[role="progressbar"]')).not.toBeNull());
    // The progress is also in the accessible name, not only drawn (B4-vod-D6).
    expect(screen.getByRole('option', { name: 'Movie 1, 50% watched' })).toBe(card);
    expect(screen.getByRole('option', { name: 'Movie 2' }).querySelector('[role="progressbar"]')).toBeNull();
  });

  it('opens a 10,000-title category mounting only a window of cells (B4-vod-D19: structural, no wall clock)', async () => {
    rpcMock.handlers['catalog.movies'] = pages(10_000);
    renderAt('/s/src1/movies/c/all', [gridRoute]);
    await screen.findByText('Movie 0');
    const mounted = () => listbox().querySelectorAll('[role="option"]');
    expect(mounted().length).toBeLessThan(120);
    expect(mounted()[0]?.getAttribute('aria-setsize')).toBe('10000');
    // End jumps the cursor to the last title without mounting the rest.
    act(() => listbox().focus());
    act(() => {
      fireEvent.keyDown(listbox(), { key: 'End' });
    });
    await waitFor(() => expect(listbox().getAttribute('aria-activedescendant')).toMatch(/-cell-9999$/));
    expect(mounted().length).toBeLessThan(120);
  });
});

describe('VodLandingPage', () => {
  // These are about the category index, which waits behind "Browse all categories" (VL-landing-index);
  // the open state is a remembered preference.
  beforeEach(() => localStorage.setItem(CATEGORY_INDEX_KEY, '1'));
  const indexed = async (name: string) => within(await screen.findByRole('list', { name: 'Categories' })).findByText(name);

  it('shows a loading status while categories load', async () => {
    rpcMock.handlers['catalog.categories'] = () => new Promise(() => undefined);
    renderAt('/s/src1/movies', [landingRoute]);
    await waitFor(() => expect(document.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull());
  });

  it('shows an error with Try again when categories fail', async () => {
    let fail = true;
    rpcMock.handlers['catalog.categories'] = () => {
      if (fail) throw { code: 'network', message: 'Portal unreachable' };
      return cats;
    };
    renderAt('/s/src1/movies', [landingRoute]);
    await screen.findByText('Portal unreachable');
    fail = false;
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    await indexed('Action');
  });

  it('shows the empty-source state with a link to sources', async () => {
    rpcMock.handlers['sources.get'] = () => ({ ...makeSource('src1', 'xtream', 'Alpha IPTV'), movieCount: 0 });
    rpcMock.handlers['catalog.categories'] = () => [];
    renderAt('/s/src1/movies', [landingRoute]);
    await screen.findByText('No movies in this source');
  });

  it('back from a category restores the landing scroll and focuses the category you opened', async () => {
    renderAt('/s/src1/movies', [landingRoute, { path: '/s/:sourceId/movies/c/:categoryId', element: <BackStub /> }]);
    const action = await indexed('Action');
    const scroller = screen.getByTestId('vod-landing-movie');
    scroller.scrollTop = 240;
    fireEvent.scroll(scroller);
    fireEvent.click(action.closest('a')!);
    await screen.findByText('back-stub');
    fireEvent.click(screen.getByText('back-stub'));
    const again = await indexed('Action');
    await waitFor(() => expect(document.activeElement).toBe(again.closest('a')));
    expect(screen.getByTestId('vod-landing-movie').scrollTop).toBe(240);
  });
});

describe('detail pages: Escape goes back', () => {
  it('a cold-opened movie detail goes to the movies landing on Escape', async () => {
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies'));
  });

  it('Escape while watching closes the player and stays on the page', async () => {
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await screen.findByTestId('player-stage');
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('player-stage')).toBeNull());
    expect(currentLocation).toBe('/s/src1/movie/m7');
  });

  it('series detail without episodes shows the designed empty state', async () => {
    const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: 's1' };
    rpcMock.handlers['xtream.seriesDetail'] = (): SeriesDetail => ({
      item: { ref: sref, title: 'Severance', categoryId: 'c1' },
      seasons: [],
      cast: [],
      providerDetailsUnavailable: false,
      backdrops: [],
    });
    rpcMock.handlers['positions.forSeries'] = () => [];
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    await screen.findByText('No episodes listed');
  });

  it('series detail shows an error with Try again when the provider fails', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = () => {
      throw { code: 'auth', message: 'Bad credentials' };
    };
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    await screen.findByText('Bad credentials');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('SeriesDetailPage: season memory', () => {
  it('keeps the season you picked when you come back to the series', async () => {
    const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: 's9' };
    const ep = (id: string, season: number, episode: number) => ({ id, seriesRef: sref, season, episode, title: `Episode ${season}.${episode}` });
    rpcMock.handlers['xtream.seriesDetail'] = (): SeriesDetail => ({
      item: { ref: sref, title: 'Severance', categoryId: 'c1' },
      seasons: [
        { number: 1, episodes: [ep('e11', 1, 1)] },
        { number: 2, episodes: [ep('e21', 2, 1)] },
      ],
      cast: [],
      providerDetailsUnavailable: false,
      backdrops: [],
    });
    rpcMock.handlers['positions.forSeries'] = () => [];
    const route = [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }];
    renderAt('/s/src1/series/s9', route);
    fireEvent.click(await screen.findByRole('tab', { name: /Season 2/ }));
    await screen.findByText('Episode 2.1');
    cleanup();

    renderAt('/s/src1/series/s9', route);
    await screen.findByText('Episode 2.1');
    expect(screen.getByRole('tab', { name: /Season 2/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('SearchPage: states', () => {
  const route = [{ path: '/search', element: <SearchPage scoped={false} /> }];
  beforeEach(() => {
    rpcMock.handlers['sources.list'] = () => [makeSource('src1', 'xtream', 'Alpha IPTV')];
  });

  it('prompts for a query before searching', async () => {
    renderAt('/search', route);
    await screen.findByText('Search every source');
  });

  it('shows the no-results state', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderAt('/search?q=zzz', route);
    await screen.findByText('No results for "zzz"');
  });

  it('shows an error with Try again and recovers', async () => {
    let fail = true;
    rpcMock.handlers['catalog.search'] = () => {
      if (fail) throw { code: 'timeout', message: 'Search timed out' };
      return { live: [], movies: [movie(3)], series: [] };
    };
    renderAt('/search?q=movie', route);
    await screen.findByText('Search timed out');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Movie 3');
  });

  it('shows the loading skeleton while results are on their way', async () => {
    rpcMock.handlers['catalog.search'] = () => new Promise(() => undefined);
    renderAt('/search?q=slow', route);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
  });
});

/** Navigates away (an actor page, a similar title) so a test can come back. */
function GoStub({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(to)}>
      go-stub
    </button>
  );
}

describe('MovieDetailPage: scroll memory', () => {
  it('opens where you left it when you come back from another page', async () => {
    renderAt('/s/src1/movie/m7', [
      { path: '/s/:sourceId/movie/:itemId', element: <><MovieDetailPage /><GoStub to="/s/src1/actor/1" /></> },
      { path: '/s/:sourceId/actor/:personId', element: <BackStub /> },
    ]);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    const page = screen.getByTestId('vod-movie-detail');
    page.scrollTop = 300;
    fireEvent.scroll(page);
    fireEvent.click(screen.getByText('go-stub'));
    fireEvent.click(await screen.findByText('back-stub'));
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    await waitFor(() => expect(screen.getByTestId('vod-movie-detail').scrollTop).toBe(300));
  });
});

describe('focus is always visible', () => {
  it('grid options hold no link or button (axe nested-interactive) and are named by the title', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    const option = await screen.findByRole('option', { name: 'Movie 1' });
    expect(option.querySelector('a, button, [tabindex]')).toBeNull();
  });

  it('the keyboard cursor draws the focus ring on the artwork', async () => {
    renderAt('/s/src1/movies/c/c1', [gridRoute]);
    await screen.findByText('Movie 0');
    keyboardFocus(listbox());
    await waitFor(() => expect(optionAt(0)?.getAttribute('data-active')).toBe('true'));
    expect(optionAt(0)!.querySelector('.ring-focus')).not.toBeNull();
  });

  it('the search results panel shows a ring when it takes keyboard focus', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('src1', 'xtream', 'Alpha IPTV')];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(3)], series: [] });
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage scoped={false} /> }]);
    const panel = (await screen.findByText('Movie 3')).closest('[role="tabpanel"]') as HTMLElement;
    expect(panel.className).toContain('focus-visible:ring-focus');
  });
});

describe('Escape in PiP', () => {
  it('does not stop playback while the PiP layer is shown', async () => {
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await screen.findByTestId('player-stage');
    const pip = document.createElement('div');
    pip.setAttribute('data-pip-layer', '');
    document.body.append(pip);
    try {
      act(() => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });
      expect(screen.getByTestId('player-stage')).toBeTruthy();
      expect(currentLocation).toBe('/s/src1/movie/m7');
      // Hidden layer (PiP closed): Escape closes the player again.
      pip.hidden = true;
      act(() => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });
      await waitFor(() => expect(screen.queryByTestId('player-stage')).toBeNull());
    } finally {
      pip.remove();
    }
  });
});
