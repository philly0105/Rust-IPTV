/**
 * Review round 2 (movies, series, search): recent searches are not kept or offered while parental
 * controls are set or unknown, and follow the other tabs' writes; the row under the player is the hero's round icon set; a favourite shows in
 * the hero; on a phone the icons carry captions and the resume bar sits under Resume; pages that
 * draw no player load it on the press; "More like this" asks the catalog only near the screen and
 * never for a Stalker portal; a small category drops its decade chips and search; the landing's
 * "All categories" follows the chips instead of reading as a chosen filter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, ItemRef, Page, PageQuery, PlaybackPosition, TmdbBrief, VodDetail, VodItem } from '@/api/types';
import { useToastStore } from '@/ui';

import { SimilarSection } from '../components/SimilarSection';
import { forgetSpots } from '../hooks/useScrollMemory';
import { RECENT_SEARCHES_KEY, forgetSearch, recentSearchList, rememberSearch, resetRecentSearchCache, setRecentSearchesPaused, useRecentSearches } from '../lib/recentSearches';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { VodLandingPage } from '../pages/VodLandingPage';
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
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

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

const OFF = { enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 };
const cat = (id: string, name: string, itemCount: number, position = 0): Category => ({ id, sourceId: 'src1', contentType: 'movie', name, hidden: false, itemCount, position });
const movie = (i: number, categoryId = 'c1'): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` }, title: `Movie ${i}`, categoryId, year: 2020 });
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const detail: VodDetail = { item: { ref: mref, title: 'Dune: Part Two', categoryId: 'c1', containerExtension: 'mkv', durationSeconds: 3600 }, cast: [], backdrops: [], providerDetailsUnavailable: false };
const detailRoute = [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }];

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  resetRecentSearchCache();
  played.length = 0;
  usePlayerStore.getState().stop();
  rpcMock.calls.length = 0;
  useToastStore.setState({ toasts: [] });
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => OFF;
  h['catalog.categories'] = () => [cat('c1', 'Action', 30), cat('c2', 'Drama', 5, 1)];
  h['catalog.recentlyAdded'] = () => [movie(1)];
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
  h['recent.list'] = () => [];
  h['catalog.yearFacets'] = () => [
    { year: 2021, count: 2 },
    { year: 2012, count: 3 },
  ];
  h['catalog.movies'] = (a) => {
    const q = (a as { query: PageQuery; categoryId?: string }).query;
    const categoryId = (a as { categoryId?: string }).categoryId ?? 'all';
    return { items: [movie(100 + q.offset, categoryId), movie(101 + q.offset, categoryId)], total: 2, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
  h['xtream.vodDetail'] = () => detail;
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => localStorage.clear());

describe('recent searches and parental controls', () => {
  it('keeps and offers nothing while paused, and pausing clears what was kept', () => {
    rememberSearch('harbor');
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['harbor']);
    const { result } = renderHook(() => useRecentSearches());
    act(() => setRecentSearchesPaused(true));
    expect(result.current).toEqual([]);
    expect(localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
    rememberSearch('late night');
    expect(recentSearchList()).toEqual([]);
    expect(localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
    // Controls off again: the list starts over (nothing from the paused time comes back).
    act(() => setRecentSearchesPaused(false));
    act(() => rememberSearch('copper'));
    expect(result.current).toEqual(['copper']);
  });

  it('the search page offers no recent search while a PIN is set, and forgets the stored ones', async () => {
    rpcMock.handlers['parental.status'] = () => ({ ...OFF, enabled: true });
    rememberSearch('after dark');
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    await waitFor(() => expect(localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull());
    expect(screen.queryByRole('button', { name: 'after dark' })).toBeNull();
    expect(screen.queryByText('Recent searches')).toBeNull();
  });

  it('the search page offers none until the parental status is known', async () => {
    let answer: (s: typeof OFF) => void = () => undefined;
    rpcMock.handlers['parental.status'] = () => new Promise((resolve) => (answer = resolve));
    rememberSearch('harbor');
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    await waitFor(() => expect(callsOf('parental.status')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'harbor' })).toBeNull();
    // Off, as it turns out: the stored chip shows up and stays stored.
    act(() => answer(OFF));
    expect(await screen.findByRole('button', { name: 'harbor' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['harbor']);
  });

  it('the search page still offers them with parental controls off', async () => {
    rememberSearch('harbor');
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    expect(await screen.findByRole('button', { name: 'harbor' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['harbor']);
  });

  it('the search page offers none when the parental status cannot be read (controls may be on)', async () => {
    rpcMock.handlers['parental.status'] = () => {
      throw new Error('core busy');
    };
    rememberSearch('after dark');
    renderAt('/search', [{ path: '/search', element: <SearchPage /> }]);
    await waitFor(() => expect(callsOf('parental.status')).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('button', { name: 'after dark' })).toBeNull();
    expect(screen.queryByText('Recent searches')).toBeNull();
  });
});

describe('recent searches across tabs', () => {
  /** Another tab of the app writes the list (or empties the whole storage, `key` null). */
  const otherTab = (list: string[] | null, key: string | null = RECENT_SEARCHES_KEY) => {
    if (key === null) localStorage.clear();
    else if (list === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(list));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: list ? JSON.stringify(list) : null }));
  };

  it('a clear in another tab clears them here, and the next search does not bring them back', () => {
    rememberSearch('harbor');
    rememberSearch('late night');
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current).toEqual(['late night', 'harbor']);
    act(() => otherTab(null));
    expect(result.current).toEqual([]);
    act(() => rememberSearch('copper'));
    expect(result.current).toEqual(['copper']);
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['copper']);
  });

  it('follows another tab emptying the whole storage, and its new searches', () => {
    rememberSearch('harbor');
    const { result } = renderHook(() => useRecentSearches());
    act(() => otherTab(null, null));
    expect(result.current).toEqual([]);
    act(() => otherTab(['dune']));
    expect(result.current).toEqual(['dune']);
  });

  it('starts every change from what is stored now, even before the other tab’s event arrives', () => {
    rememberSearch('harbor');
    expect(recentSearchList()).toEqual(['harbor']);
    // Cleared in another tab; this tab has not heard of it yet.
    localStorage.removeItem(RECENT_SEARCHES_KEY);
    rememberSearch('copper');
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['copper']);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(['dune', 'copper']));
    forgetSearch('copper');
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(['dune']);
    expect(recentSearchList()).toEqual(['dune']);
  });

  it('with storage full or blocked, the list still builds up for this session', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      rememberSearch('harbor');
      rememberSearch('copper');
      expect(recentSearchList()).toEqual(['copper', 'harbor']);
      forgetSearch('harbor');
      expect(recentSearchList()).toEqual(['copper']);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('the movie page', () => {
  it('shows a favourite in the hero as a pressed round toggle with the heart filled in', async () => {
    rpcMock.handlers['favorites.contains'] = () => [mref];
    renderAt('/s/src1/movie/m7', detailRoute);
    const actions = await screen.findByTestId('vod-hero-actions');
    const favorite = await within(actions).findByRole('button', { name: 'Favorite', pressed: true });
    expect(favorite.className).toContain('bg-selected');
    expect(favorite.querySelector('svg')!.getAttribute('class')).toContain('fill-current');
  });

  it('under the player keeps the hero\'s round icon set, not a labelled button beside bare glyphs', async () => {
    renderAt('/s/src1/movie/m7', detailRoute);
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await screen.findByTestId('player-stage');
    const row = screen.getByTestId('vod-hero-icons');
    const buttons = within(row).getAllByRole('button');
    // My List first (its label comes from the mylist namespace, not loaded here), then the toggles.
    expect(buttons[0]!.dataset['testid']).toBe('mylist-button');
    expect(buttons.slice(1).map((b) => b.getAttribute('aria-label'))).toEqual(['Favorite', 'Mark as watched', 'Download']);
    for (const b of buttons) {
      expect(b.textContent?.trim()).toBe('');
      expect(b.className).toContain('rounded-md');
      expect(b.className).not.toContain('rounded-full');
    }
    // The title is named once on the page: the stage's bar; the header names the section.
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Dune: Part Two']);
  });

  it('on a phone, captions the icons and puts the resume bar right under Resume', async () => {
    rpcMock.handlers['positions.get'] = (): PlaybackPosition => ({ ref: mref, positionSeconds: 1200, durationSeconds: 3600, updatedAt: 'x', watched: false });
    renderAt('/s/src1/movie/m7', detailRoute);
    await screen.findByRole('button', { name: 'Resume from 20:00' });
    const icons = screen.getByTestId('vod-hero-icons');
    // Each round button has its caption under it, below sm only, hidden from assistive tech.
    const captions = [...icons.querySelectorAll('span[aria-hidden]')].filter((s) => s.className.includes('sm:hidden')).map((s) => s.textContent);
    expect(captions).toEqual(['My List', 'Favorite', 'Watched', 'Download', 'More']);
    expect(icons.className).toContain('max-sm:grid');
    // Resume, then its progress, then the icons, in the DOM as on a phone's screen.
    const progress = screen.getByTestId('vod-hero-progress');
    const resume = screen.getByRole('button', { name: 'Resume from 20:00' });
    expect(resume.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(progress.compareDocumentPosition(icons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(progress.className).toContain('sm:order-last');
  });
});

describe('pages that draw no player load it on the press (size:check guards the build)', () => {
  const ROOT = join(__dirname, '..');
  const STATIC_PLAYER = /^import (?!type )[^;]*from '@\/features\/player';/m;
  it.each(['pages/SearchPage.tsx', 'pages/CategoryGridPage.tsx', 'hooks/usePlayTitle.ts'])('%s has no static import of the player barrel', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(STATIC_PLAYER);
  });

  it('a channel found by Search plays through the player loaded on the press', async () => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [{ ref: { sourceId: 'src1', contentType: 'live', itemId: 'c1' }, name: 'Harbor News', categoryId: 'g', isRadio: false }],
      movies: [],
      series: [],
    });
    rpcMock.handlers['epg.search'] = () => [];
    renderAt('/search?q=harbor', [{ path: '/search', element: <SearchPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: /Harbor News/ }));
    await waitFor(() => expect(played).toHaveLength(1));
    expect(played[0]).toMatchObject({ ref: { itemId: 'c1' }, isLive: true, sourceKind: 'xtream' });
  });
});

describe('"More like this" lookups', () => {
  const briefs: TmdbBrief[] = [
    { tmdbId: 1, mediaType: 'movie', title: 'Dune' },
    { tmdbId: 2, mediaType: 'movie', title: 'Arrival' },
  ];
  const similar = (sourceKind: 'xtream' | 'stalker') => (
    <SimilarSection items={briefs} loading={false} sourceId="src1" sourceKind={sourceKind} error={undefined} onRetry={() => undefined} keyMissing={false} enriched />
  );

  it('wait until the section nears the screen, then ask once per title', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderAt('/', [{ path: '/', element: similar('xtream') }]);
    // No IntersectionObserver in jsdom: the section never came near, so nothing is asked.
    await new Promise((r) => setTimeout(r, 300));
    expect(callsOf('catalog.search')).toHaveLength(0);
    cleanup();
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    renderAt('/', [{ path: '/', element: similar('xtream') }]);
    await waitFor(() => expect(callsOf('catalog.search')).toHaveLength(2));
  });

  it('ask nothing for a Stalker portal, whose VOD is not in the local catalog', async () => {
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderAt('/', [{ path: '/', element: similar('stalker') }]);
    expect(await screen.findByText('None of the similar titles TMDB lists are in this source.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(callsOf('catalog.search')).toHaveLength(0);
  });
});

describe('category pages', () => {
  const gridRoute = [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }];

  it('a small category drops the decade chips and its search field; a large one keeps them', async () => {
    renderAt('/s/src1/movies/c/c2', gridRoute);
    // The first grid of a cold test file takes longer than findBy's second to load its chunks.
    await screen.findByRole('option', { name: /^Movie 100/ }, { timeout: 5000 });
    await waitFor(() => expect(callsOf('catalog.categories').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('vod-year-filter')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    cleanup();
    renderAt('/s/src1/movies/c/c1', gridRoute);
    expect(await screen.findByTestId('vod-year-filter')).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('a decade picked in a small category keeps its chips, so it can be cleared', async () => {
    renderAt('/s/src1/movies/c/c2?yf=2010&yt=2019', gridRoute);
    const group = await screen.findByTestId('vod-year-filter');
    expect(within(group).getByRole('button', { name: 'All years' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('the landing lists the categories as kit chips, then "All categories" as a quiet link beside Manage', async () => {
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    const nav = await screen.findByTestId('vod-category-chips');
    const chips = await within(nav).findAllByTestId('vod-category-chip');
    expect(chips[0]!.className).toContain('rounded-full');
    expect(chips[0]!.className).toContain('border-edge');
    const all = within(nav).getByTestId('vod-chip-all');
    // After the chips, not first: it opens the index, it is not a filter that is on.
    expect(chips.at(-1)!.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all.className).not.toContain('bg-fg');
    expect(all.nextElementSibling?.getAttribute('aria-label')).toMatch(/categories/i);
    // One height across the row: the chips, All categories and Manage are all h-8, as tall as an sm button.
    for (const el of [chips[0]!, all, all.nextElementSibling!]) expect(el.className.split(' ')).toContain('h-8');
    expect(all.nextElementSibling!.className.split(' ')).not.toContain('h-10');
  });

  it('below md the source line leads the chip row beside All categories, and the chips and Manage take the next line', async () => {
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    const nav = await screen.findByTestId('vod-category-chips');
    await within(nav).findAllByTestId('vod-category-chip');
    // The header shows the source from md up; below it the row's first line does, beside All categories.
    const lead = await within(nav).findByTestId('vod-landing-source');
    expect(lead.className).toContain('md:hidden');
    expect(nav.firstElementChild).toBe(lead);
    expect(nav.className).toContain('flex-wrap');
    expect(nav.className).toContain('md:flex-nowrap');
    const list = within(nav).getAllByTestId('vod-category-chip')[0]!.closest('ul')!;
    expect(list.className).toContain('max-md:order-last');
    expect(list.className).toContain('max-md:grow');
    const all = within(nav).getByTestId('vod-chip-all');
    expect(all.className).toContain('max-md:ms-auto');
    expect(all.className).not.toContain('order-last');
    // Manage follows the chips (same order, later in the document), so it ends their line.
    expect(all.nextElementSibling!.className).toContain('max-md:order-last');
    // Only one source line on the page: the row's.
    expect(screen.getAllByText(lead.textContent!)).toHaveLength(1);
  });
});
