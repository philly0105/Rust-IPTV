/**
 * Product redesign, stage 1 (movies, series, search): the rails-first landing (CB-VOD-LANDING,
 * VL-landing-index), the detail hero's one primary action and More menu (VL-hero-actions), offline
 * play (VL-offline-play), "More in <category>" without TMDB (VL-detail-empty-no-tmdb), TMDB titles
 * resolved against the catalog (VL-tmdb-deadend), the search zero state and search locks.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Download, ItemRef, Page, PageQuery, PlaybackPosition, VodDetail, VodItem } from '@/api/types';
import { useToastStore } from '@/ui';

import { matchBrief } from '../hooks/useCatalogMatches';
import { forgetSpots } from '../hooks/useScrollMemory';
import { clearSearches, forgetSearch, rememberSearch, RECENT_SEARCHES_KEY, resetRecentSearchCache, useRecentSearches } from '../lib/recentSearches';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { CATEGORY_INDEX_KEY, CATEGORY_RAIL_LIMIT, VodLandingPage } from '../pages/VodLandingPage';
import { currentLocation, i18n, installDomStubs, makeSource, openHeroMenu, renderAt, settings } from './harness';

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
const played = vi.hoisted(() => ({ sources: [] as unknown[] }));

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => {
  const h = await import('./harness');
  return {
    ...h.playerModule,
    playSource: async (src: unknown) => {
      played.sources.push(src);
    },
  };
});

/** An IntersectionObserver that reports every observed element as on screen at once. */
class EagerObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const cat = (id: string, name: string, itemCount: number, position = 0): Category => ({ id, sourceId: 'src1', contentType: 'movie', name, hidden: false, itemCount, position });
const movie = (i: number, categoryId = 'c1'): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` }, title: `Movie ${i}`, categoryId, year: 2020 });
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  resetRecentSearchCache();
  played.sources.length = 0;
  rpcMock.calls.length = 0;
  useToastStore.setState({ toasts: [] });
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [cat('c1', 'Action', 12), cat('c2', 'Drama', 30, 1)];
  h['catalog.recentlyAdded'] = () => [movie(1)];
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
  h['catalog.movies'] = (a) => {
    const q = (a as { query: PageQuery; categoryId?: string }).query;
    const categoryId = (a as { categoryId?: string }).categoryId ?? 'all';
    return { items: [movie(100 + q.offset, categoryId), movie(101 + q.offset, categoryId)], total: 2, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => localStorage.clear());

const landing = () => renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);

describe('CB-VOD-LANDING / VL-landing-index: the landing is rails first', () => {
  it('keeps the category index behind "Browse all categories", and remembers it open', async () => {
    landing();
    const toggle = await screen.findByRole('button', { name: 'Browse all categories' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Categories' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByRole('list', { name: 'Categories' })).toBeTruthy();
    expect(localStorage.getItem(CATEGORY_INDEX_KEY)).toBe('1');
    cleanup();
    landing();
    expect(await screen.findByRole('list', { name: 'Categories' })).toBeTruthy();
  });

  it("shows Continue watching for this source and section only, each card resuming on the title's page", async () => {
    const at = (ref: ItemRef, positionSeconds: number, extra: Partial<PlaybackPosition> = {}): PlaybackPosition => ({
      ref,
      positionSeconds,
      durationSeconds: 6000,
      updatedAt: '2026-10-19T00:00:00Z',
      watched: false,
      snapshot: { title: `T ${ref.itemId}`, contentType: ref.contentType },
      ...extra,
    });
    rpcMock.handlers['positions.continueWatching'] = () => [
      at({ sourceId: 'src1', contentType: 'movie', itemId: 'a' }, 600),
      at({ sourceId: 'src2', contentType: 'movie', itemId: 'b' }, 600),
      at({ sourceId: 'src1', contentType: 'series', itemId: 'c' }, 600),
      at({ sourceId: 'src1', contentType: 'movie', itemId: 'd' }, 600, { watched: true }),
    ];
    landing();
    const rail = (await screen.findByRole('heading', { name: 'Continue watching' })).closest('section')!;
    const links = within(rail).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/s/src1/movie/a']);
    // 100 of 6000 seconds: the caption says the time left, the poster how far it got.
    expect(within(rail).getByText('90 minutes left')).toBeTruthy();
  });

  it('mounts a rail per category as it nears the screen, with the grid arguments, and See all to the grid', async () => {
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    landing();
    await screen.findByRole('heading', { name: /^Action/ });
    await waitFor(() => expect(callsOf('catalog.movies').some((a) => (a as { categoryId?: string }).categoryId === 'c2')).toBe(true));
    const action = callsOf('catalog.movies').find((a) => (a as { categoryId?: string }).categoryId === 'c1') as { query: PageQuery };
    expect(action.query).toMatchObject({ offset: 0, sort: 'added', dir: 'desc' });
    // Top rated: the whole section by rating.
    expect(callsOf('catalog.movies').some((a) => !(a as { categoryId?: string }).categoryId && (a as { query: PageQuery }).query.sort === 'rating')).toBe(true);
    const actionRail = screen.getByRole('heading', { name: /^Action/ }).closest('section')!;
    expect(within(actionRail).getByRole('link', { name: /See all/ }).getAttribute('href')).toBe('/s/src1/movies/c/c1');
    expect(await within(actionRail).findByRole('link', { name: /^Movie 100/ })).toBeTruthy();
  });

  it(`stops at ${CATEGORY_RAIL_LIMIT} category rails and asks for none before they near the screen`, async () => {
    rpcMock.handlers['catalog.categories'] = () => Array.from({ length: 20 }, (_, i) => cat(`k${i}`, `Group ${i}`, 5, i));
    landing();
    await screen.findByRole('heading', { name: /^Group 0/ });
    expect(screen.getAllByTestId('vod-rail-placeholder')).toHaveLength(CATEGORY_RAIL_LIMIT + 1); // + Top rated
    expect(screen.queryByRole('heading', { name: /^Group 12/ })).toBeNull();
    expect(callsOf('catalog.movies')).toHaveLength(0);
  });
});

describe('VL-hero-actions / VL-offline-play / VL-detail-empty-no-tmdb: the movie detail page', () => {
  const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
  const detail: VodDetail = { item: { ref: mref, title: 'Dune: Part Two', categoryId: 'c1', containerExtension: 'mkv', added: '2026-10-01T00:00:00Z' }, cast: [], backdrops: [], providerDetailsUnavailable: false };
  const route = [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }];
  beforeEach(() => {
    const h = rpcMock.handlers;
    h['xtream.vodDetail'] = () => detail;
    h['favorites.contains'] = () => [];
    h['downloads.list'] = () => [];
    h['catalog.sameTitle'] = () => [];
    h['positions.get'] = () => null;
  });

  it('has one primary action and icon buttons; the rest waits in More', async () => {
    renderAt('/s/src1/movie/m7', route);
    const actions = await screen.findByTestId('vod-hero-actions');
    const play = within(actions).getByRole('button', { name: 'Play' });
    expect(play.className).toContain('bg-accent-solid');
    // Every other control in the row is an icon button, named for screen readers.
    for (const b of within(actions).getAllByRole('button').filter((x) => x !== play)) {
      expect(b.textContent?.trim()).toBe('');
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
    expect(within(actions).getByTestId('mylist-button').dataset['variant']).toBe('round');
    expect(within(actions).getByRole('button', { name: 'Mark as watched' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Download' })).toBeTruthy();
    // Favorite sits between My List and Watched, so the page says whether the title is one.
    const favorite = within(actions).getByRole('button', { name: 'Favorite', pressed: false });
    // The text buttons' rounded square, not a circle: one shape per row.
    expect(favorite.className).toContain('rounded-md');
    expect(favorite.className).not.toContain('rounded-full');
    const order = within(actions).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(order.indexOf('Favorite')).toBe(order.indexOf('Mark as watched') - 1);
    // Nothing else to offer: no Start over (no saved spot), no other copies, no lock, so no More.
    expect(within(actions).queryByRole('button', { name: 'More actions' })).toBeNull();
    // The provider's facts sit under the hero with TMDB off.
    const about = screen.getByTestId('vod-about');
    expect(within(about).getByText('Alpha IPTV')).toBeTruthy();
    expect(within(about).getByText('MKV')).toBeTruthy();
  });

  it('a downloaded copy plays from the file, says so, and still offers the stream', async () => {
    const d: Download = {
      id: 42,
      ref: mref,
      title: 'Dune: Part Two',
      url: 'http://provider/m7.mkv',
      status: 'completed',
      bytesDownloaded: 10,
      totalBytes: 10,
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
      fileAvailable: true,
      positionSeconds: 754,
    };
    rpcMock.handlers['downloads.list'] = () => [d];
    rpcMock.handlers['myvideos.playSource'] = () => ({ url: 'http://local/files/42', title: 'Dune: Part Two', isLive: false });
    renderAt('/s/src1/movie/m7', route);
    expect(await screen.findByTestId('vod-offline-chip')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume from 12:34' }));
    await waitFor(() => expect(callsOf('myvideos.playSource')).toEqual([{ id: 42 }]));
    await waitFor(() => expect(played.sources).toHaveLength(1));
    expect(played.sources[0]).toMatchObject({ url: 'http://local/files/42', resumeSeconds: 754 });
    // The finished download links to its own My Videos page.
    expect(screen.getByRole('link', { name: 'Downloaded' }).getAttribute('href')).toBe('/my-videos/42');
    expect(within(await openHeroMenu()).getByRole('menuitem', { name: 'Stream instead' })).toBeTruthy();
  });

  it('shows "More in <category>" from the catalog, without the title itself', async () => {
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    rpcMock.handlers['catalog.movies'] = (a) => {
      const q = (a as { query: PageQuery }).query;
      return { items: [{ ...movie(7), ref: mref, title: 'Dune: Part Two' }, movie(8)], total: 2, offset: q.offset, limit: q.limit };
    };
    renderAt('/s/src1/movie/m7', route);
    const rail = (await screen.findByRole('heading', { name: 'More in Action' })).closest('section')!;
    expect(await within(rail).findByRole('link', { name: /^Movie 8/ })).toBeTruthy();
    expect(within(rail).queryByRole('link', { name: /^Dune/ })).toBeNull();
    expect(callsOf('catalog.movies')[0]).toMatchObject({ sourceId: 'src1', categoryId: 'c1' });
  });

  it('keeps the title in the header, so the window and tab title name it while the hero shows it', async () => {
    // Every observed element reports on screen at once: the hero's h1 is in view.
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    const { useShellStore } = await import('@/shell/store');
    renderAt('/s/src1/movie/m7', route);
    await screen.findByRole('heading', { name: 'Dune: Part Two', level: 1 });
    // The shell's document title follows the header title, so the section name there would put
    // "Movies" on every movie's window, tab and history entry.
    await waitFor(() => expect(useShellStore.getState().header?.title).toBe('Dune: Part Two'));
    await new Promise((r) => setTimeout(r, 50));
    expect(useShellStore.getState().header?.title).toBe('Dune: Part Two');
  });
});

describe('VL-tmdb-deadend: TMDB titles match catalog titles', () => {
  const hit = (title: string, year?: number, tmdbId?: number): VodItem => ({
    ref: { sourceId: 's', contentType: 'movie', itemId: title },
    title,
    categoryId: 'c',
    ...(year ? { year } : {}),
    ...(tmdbId ? { tmdbId } : {}),
  });

  it('by TMDB id first, then by name with years at most one apart', () => {
    expect(matchBrief({ tmdbId: 9, title: 'Other name' }, [hit('X', 2000, 9)])?.title).toBe('X');
    expect(matchBrief({ tmdbId: 1, title: 'Amélie', year: 2001 }, [hit('amelie', 2002)])?.title).toBe('amelie');
    expect(matchBrief({ tmdbId: 1, title: 'Heat', year: 1995 }, [hit('Heat', 1986)])).toBeUndefined();
    expect(matchBrief({ tmdbId: 1, title: 'Heat' }, [hit('Heat', 1995)])?.title).toBe('Heat');
    expect(matchBrief({ tmdbId: 1, title: 'Heat', year: 1995 }, [hit('Heated', 1995)])).toBeUndefined();
  });
});

describe('Search zero state (critique: search; CB "Search zero state")', () => {
  it('keeps the last eight searches, newest first, one entry per query', () => {
    for (let i = 0; i < 10; i++) rememberSearch(`query ${i}`);
    rememberSearch('Query   3');
    const stored = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!) as string[];
    expect(stored[0]).toBe('Query 3');
    expect(stored).toHaveLength(8);
    expect(stored.filter((q) => q.toLowerCase() === 'query 3')).toHaveLength(1);
    forgetSearch('query 9');
    expect((JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!) as string[]).includes('query 9')).toBe(false);
    clearSearches();
    expect(localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
    // The hook reads the same store.
    void useRecentSearches;
  });

  it('offers recent searches before a query; one press searches it again', async () => {
    rpcMock.handlers['recent.list'] = () => [];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    rpcMock.handlers['epg.search'] = () => [];
    rememberSearch('harbor');
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    const start = await screen.findByTestId('vod-search-start');
    expect(within(start).getByText('Search every source')).toBeTruthy();
    fireEvent.click(within(start).getByRole('button', { name: 'harbor' }));
    await waitFor(() => expect(currentLocation).toBe('/search?q=harbor'));
  });

  it('removes one recent search with its X', async () => {
    rpcMock.handlers['recent.list'] = () => [];
    rememberSearch('harbor');
    rememberSearch('copper');
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('vod:removeRecentSearch', { query: 'copper' }) }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'copper' })).toBeNull());
    expect(screen.getByRole('button', { name: 'harbor' })).toBeTruthy();
  });
});

describe('VL-search-locks: search results carry the parental lock', () => {
  it('marks a title whose category is locked in Ask mode', async () => {
    rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpcMock.handlers['parental.locks'] = () => [{ sourceId: 'src1', contentType: 'movie', kind: 'category', targetId: 'late', name: 'Late', createdAt: '2026-10-01T00:00:00Z' }];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1), movie(2, 'late')], series: [] });
    rpcMock.handlers['epg.search'] = () => [];
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
    const locked = await screen.findByRole('link', { name: /^Movie 2/ });
    await waitFor(() => expect(locked.getAttribute('aria-label')).toContain('Locked'));
    expect(within(locked).getByTestId('poster-locked')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Movie 1/ }).getAttribute('aria-label')).not.toContain('Locked');
  });
});
