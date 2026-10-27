/**
 * Product redesign, review fixes (movies, series, search): a download plays from the title's saved
 * position, the one its Resume label shows; the round download button draws its progress; search
 * programmes sit under a heading per day with the clock alone; Top results counts what the tabs
 * count, puts two short poster lists in one rail, leads with the type it found most of, drops step
 * buttons where nothing scrolls, finds a result again in its own section on Back, and "See all"
 * leaves focus in the results; the landing's chip row reaches every category from the top.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, Download, GuideSearchHit, ItemRef, PlaybackPosition, SeriesDetail, SeriesItem, VodDetail, VodItem } from '@/api/types';
import { useShellStore } from '@/shell/store';
import { useToastStore } from '@/ui';

import { DownloadButton } from '../components/detail/actions';
import { forgetSpots } from '../hooks/useScrollMemory';
import { resetRecentSearchCache } from '../lib/recentSearches';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { CATEGORY_CHIP_LIMIT, CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
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
const played = vi.hoisted(() => ({ sources: [] as { resumeSeconds?: number; url?: string }[] }));

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
    playSource: async (src: { resumeSeconds?: number }) => {
      played.sources.push(src);
    },
  };
});

const vod = (sourceId: string, i: number, title: string, year = 2024): VodItem => ({ ref: { sourceId, contentType: 'movie', itemId: `m${i}` }, title, titleBase: title, year, categoryId: 'c1' });
const show = (sourceId: string, i: number, title: string): SeriesItem => ({ ref: { sourceId, contentType: 'series', itemId: `s${i}` }, title, year: 2012, categoryId: 'c1' });
const channel = (sourceId: string, i: number, name: string): Channel =>
  ({ ref: { sourceId, contentType: 'live', itemId: `c${i}` }, name, number: i, categoryId: 'news', isRadio: false }) as Channel;
const download = (patch: Partial<Download>): Download => ({
  id: 42,
  ref: { sourceId: 'src1', contentType: 'movie', itemId: 'm7' },
  title: 'Dune',
  url: 'http://provider/m7.mkv',
  status: 'completed',
  bytesDownloaded: 10,
  totalBytes: 10,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
  fileAvailable: true,
  positionSeconds: 0,
  ...patch,
});

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
  const a = makeSource('src1', 'xtream', 'Northwind');
  const b = makeSource('src2', 'm3u', 'Harbor Lights');
  h['sources.get'] = (args) => ((args as { id: string }).id === 'src2' ? b : a);
  h['sources.list'] = () => [a, b];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
  h['epg.search'] = () => [];
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['catalog.categories'] = () => [];
  h['catalog.movies'] = () => ({ items: [], total: 0, offset: 0, limit: 60 });
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['myvideos.playSource'] = () => ({ url: 'http://local/files/42', title: 'Dune', isLive: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => localStorage.clear());

describe('offline play resumes where the title says', () => {
  const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
  const detail: VodDetail = { item: { ref: mref, title: 'Dune', categoryId: 'c1', durationSeconds: 7200 }, cast: [], backdrops: [], providerDetailsUnavailable: false };
  const route = [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }];

  it('a movie whose download never moved resumes at its saved position, and still offers Start over', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => detail;
    // Streamed for 30 minutes; the download finished meanwhile, its own spot still 0.
    rpcMock.handlers['positions.get'] = (): PlaybackPosition => ({ ref: mref, positionSeconds: 1800, durationSeconds: 7200, updatedAt: '2026-10-12T00:00:00Z', watched: false });
    rpcMock.handlers['downloads.list'] = () => [download({ positionSeconds: 0 })];
    renderAt('/s/src1/movie/m7', route);
    expect(await screen.findByTestId('vod-offline-chip')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume from 30:00' }));
    await waitFor(() => expect(played.sources).toHaveLength(1));
    expect(played.sources[0]).toMatchObject({ url: 'http://local/files/42', resumeSeconds: 1800 });
    // The bar under it says the same.
    expect(screen.getByText('90 minutes left')).toBeTruthy();
    fireEvent.click(within(await openHeroMenu()).getByRole('menuitem', { name: 'Start over' }));
    await waitFor(() => expect(played.sources).toHaveLength(2));
    expect(played.sources[1]).toMatchObject({ url: 'http://local/files/42', resumeSeconds: 0 });
  });

  it('a movie watched to the end plays the file from the start, whatever the download remembers', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => detail;
    rpcMock.handlers['positions.get'] = (): PlaybackPosition => ({ ref: mref, positionSeconds: 7150, durationSeconds: 7200, updatedAt: '2026-10-12T00:00:00Z', watched: true });
    rpcMock.handlers['downloads.list'] = () => [download({ positionSeconds: 900 })];
    renderAt('/s/src1/movie/m7', route);
    expect(await screen.findByTestId('vod-offline-chip')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await waitFor(() => expect(played.sources).toHaveLength(1));
    expect(played.sources[0]).toMatchObject({ resumeSeconds: 0 });
  });

  it('an episode whose download never moved resumes where its Resume label says', async () => {
    const sref: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
    const ep = (n: number) => ({ id: `e${n}`, seriesRef: sref, season: 1, episode: n, title: `Episode ${n}`, durationSeconds: 2520 });
    const series: SeriesDetail = { item: { ref: sref, title: 'Severance', categoryId: 'c1' }, seasons: [{ number: 1, episodes: [ep(1), ep(2), ep(3)] }], cast: [], backdrops: [], providerDetailsUnavailable: false };
    rpcMock.handlers['xtream.seriesDetail'] = () => series;
    rpcMock.handlers['positions.forSeries'] = (): PlaybackPosition[] => [
      { ref: sref, episodeId: 'e2', positionSeconds: 1200, durationSeconds: 2520, updatedAt: '2026-10-12T00:00:00Z', watched: false },
    ];
    rpcMock.handlers['downloads.list'] = () => [download({ id: 9, ref: sref, episodeId: 'e2', positionSeconds: 0 })];
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    // The episode's row says it is on disk once the queue has loaded.
    expect(await screen.findByTestId('episode-offline')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume S01E02' }));
    await waitFor(() => expect(played.sources).toHaveLength(1));
    expect(rpcMock.calls.filter((c) => c.cmd === 'myvideos.playSource').map((c) => c.args)).toEqual([{ id: 9 }]);
    expect(played.sources[0]).toMatchObject({ resumeSeconds: 1200 });
  });
});

describe('the round download button shows its progress', () => {
  const renderButton = (d: Download) =>
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <DownloadButton download={d} pending={false} round onStart={() => undefined} />
        </MemoryRouter>
      </I18nextProvider>,
    );

  it('draws a ring for the share downloaded around the download glyph, in the accent while it moves', () => {
    renderButton(download({ status: 'downloading', bytesDownloaded: 45, totalBytes: 100 }));
    const button = screen.getByTestId('vod-download-button');
    expect(button.getAttribute('aria-label')).toBe('Downloading 45%');
    const fill = within(button).getByTestId('vod-download-ring-fill');
    expect(fill.getAttribute('stroke-dasharray')).toBe('45 100');
    expect(fill.getAttribute('class')).toContain('stroke-accent');
    // No spinner: the ring is the progress, and it reads under reduced motion too.
    expect(button.querySelector('.motion-safe\\:animate-spin')).toBeNull();
  });

  it('keeps the ring neutral while paused, and spins only when the size is unknown', () => {
    const { unmount } = renderButton(download({ status: 'paused', bytesDownloaded: 30, totalBytes: 100 }));
    const fill = screen.getByTestId('vod-download-ring-fill');
    expect(fill.getAttribute('stroke-dasharray')).toBe('30 100');
    expect(fill.getAttribute('class')).toContain('stroke-fg-muted');
    unmount();
    renderButton(download({ status: 'downloading', bytesDownloaded: 30, totalBytes: 0 }));
    expect(screen.queryByTestId('vod-download-ring')).toBeNull();
    expect(screen.getByTestId('vod-download-button').querySelector('.motion-safe\\:animate-spin')).not.toBeNull();
  });
});

/** A guide hit on day `day` (0 = today) at `hour`:`minute` local time. */
function programme(i: number, day: number, hour: number, minute: number, title = 'Glass Harbor Blues'): GuideSearchHit {
  const start = new Date();
  start.setDate(start.getDate() + day);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + 3600_000);
  return {
    ref: { sourceId: 'src1', contentType: 'live', itemId: `c${i}` },
    channelName: `Starling ${i}`,
    program: { channelId: `c${i}`, start: start.toISOString(), end: end.toISOString(), title },
  };
}

function BackStub() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Back
    </button>
  );
}

/** The shell header's search field, fed by the page's usePageHeader. */
function FakeHeader() {
  const search = useShellStore((s) => s.header?.search);
  if (!search) return null;
  return <input data-shell-search="" aria-label="Header search" value={search.value} onChange={(e) => search.onChange(e.target.value)} />;
}

function renderSearch(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/start']}>
          <FakeHeader />
          <Link to={path}>Open search</Link>
          <Routes>
            <Route path="/start" element={<p>start</p>} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/s/:sourceId/movie/:itemId" element={<BackStub />} />
            <Route path="/s/:sourceId/series/:itemId" element={<BackStub />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('search programmes', () => {
  it('sit under a heading per day, with the clock alone in the time column', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    rpcMock.handlers['epg.search'] = (a) =>
      (a as { sourceId?: string }).sourceId === 'src2' ? [] : [programme(1, 0, 23, 30), programme(2, 1, 4, 50), programme(3, 1, 16, 10)];
    renderAt('/search?q=harbor', [{ path: '/search', element: <SearchPage /> }]);
    const list = await screen.findByTestId('search-programmes');
    await waitFor(() => expect(within(list).getAllByTestId('search-programme-time')).toHaveLength(3));
    const days = within(list).getAllByTestId('search-programme-day').map((d) => d.textContent);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatch(/^today/i);
    expect(days[1]).toMatch(/^tomorrow/i);
    // 12-hour English drops the leading zero, as the Scheduled list does; the day is in the heading.
    expect(within(list).getAllByTestId('search-programme-time').map((t) => t.textContent?.replace(/\s/g, ' '))).toEqual(['11:30 PM', '4:50 AM', '4:10 PM']);
    // Each day's rows are a list named by its heading.
    const tomorrow = within(list).getAllByRole('list')[1]!;
    expect(tomorrow.getAttribute('aria-labelledby')).toBe(within(list).getAllByTestId('search-programme-day')[1]!.id);
    expect(within(tomorrow).getAllByRole('button')).toHaveLength(2);
  });
});

describe('search programmes on several channels', () => {
  it('fold a show airing on several channels at once into one row, with a link to each other channel', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    /** Hit `i`, starting `minutes` from now. */
    const at = (i: number, minutes: number): GuideSearchHit => {
      const hit = programme(i, 0, 0, 0);
      const start = Date.now() + minutes * 60_000;
      return { ...hit, program: { ...hit.program, start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() } };
    };
    // On the air now on three channels (one start), and later on a fourth.
    const now = at(1, -10);
    const airing = [now, { ...at(2, 0), program: { ...now.program, channelId: 'c2' } }, { ...at(3, 0), program: { ...now.program, channelId: 'c3' } }];
    rpcMock.handlers['epg.search'] = (a) => ((a as { sourceId?: string }).sourceId === 'src2' ? [] : [...airing, at(4, 120)]);
    renderAt('/search?q=harbor&type=programmes', [
      { path: '/search', element: <SearchPage /> },
      { path: '/epg', element: <p>guide page</p> },
    ]);
    const list = await screen.findByTestId('search-programmes');
    await waitFor(() => expect(within(list).getAllByTestId('search-programme')).toHaveLength(2));
    const [first, second] = within(list).getAllByTestId('search-programme');
    // The first channel names the row; the others are links under it (with their source, as there are two).
    expect(within(first!).getByText('Starling 1 · Northwind')).toBeTruthy();
    const also = within(first!).getByTestId('search-programme-also');
    expect(within(also).getAllByRole('button').map((b) => b.textContent)).toEqual(['Starling 2 · Northwind', 'Starling 3 · Northwind']);
    // On the air now: LIVE beside its time; the later airing has none.
    expect(first!.querySelector('[data-live-pill]')).toBeTruthy();
    expect(second!.querySelector('[data-live-pill]')).toBeNull();
    // Past eight other channels the rest wait behind Show all (covered below).
    expect(within(also).queryByRole('button', { name: /Show all/ })).toBeNull();
    fireEvent.click(within(also).getByRole('button', { name: 'Starling 3 · Northwind' }));
    await screen.findByText('guide page');
    expect(currentLocation).toBe(`/epg?source=src1&at=${Date.parse(now.program.start)}`);
  });
});

describe('a show on many channels', () => {
  it('lists eight other channels, and the rest behind Show all', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    const first = programme(1, 1, 9, 0);
    const hits = Array.from({ length: 12 }, (_, i) => ({ ...programme(i + 1, 1, 9, 0), program: { ...first.program, channelId: `c${i + 1}` } }));
    rpcMock.handlers['epg.search'] = (a) => ((a as { sourceId?: string }).sourceId === 'src2' ? [] : hits);
    renderAt('/search?q=harbor&type=programmes', [{ path: '/search', element: <SearchPage /> }]);
    const also = await screen.findByTestId('search-programme-also');
    const links = () => within(also).getAllByRole('button').filter((b) => b.textContent?.startsWith('Starling'));
    expect(links()).toHaveLength(8);
    const more = within(also).getByRole('button', { name: 'Show all (11)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(links()).toHaveLength(11);
    fireEvent.click(within(also).getByRole('button', { name: 'Show less' }));
    expect(links()).toHaveLength(8);
  });
});

describe('Top results', () => {
  beforeEach(() => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [channel('src1', 1, 'Harbor News')],
      movies: [vod('src1', 1, 'Glass Harbor Blues'), vod('src2', 2, 'Glass Harbor Blues')],
      series: [show('src1', 1, 'Harbor Nine'), show('src1', 2, 'Harbor Ten')],
    });
  });

  it('puts two short poster lists in one rail, counts what the tabs count, and has no step buttons where nothing scrolls', async () => {
    renderAt('/search?q=harbor', [{ path: '/search', element: <SearchPage /> }]);
    const top = await screen.findByTestId('search-top');
    // Movies and series, three titles or fewer each, share one rail instead of two half-width
    // columns of one poster each; no "See all", since no single tab holds both.
    const headings = within(top).getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Movies and series4', 'Channels1']);
    const rail = within(top).getByRole('heading', { name: /^Movies and series/ }).closest('section')!;
    expect(within(rail).getAllByRole('link').filter((a) => a.getAttribute('data-grid-index') !== null)).toHaveLength(3);
    expect(within(rail).queryByRole('link', { name: /See all/ })).toBeNull();
    // The heading counts copies, as the tabs do: the film from two sources is one card that says so.
    expect(screen.getByRole('tab', { name: /Movies/ }).textContent).toContain('2');
    expect(screen.getByRole('tab', { name: /Series/ }).textContent).toContain('2');
    expect(within(rail).getByRole('link', { name: /^Glass Harbor Blues/ }).getAttribute('aria-label')).toContain('2 sources');
    // jsdom lays nothing out, so no rail scrolls: no disabled arrows beside See all.
    expect(within(top).queryByRole('button', { name: 'Scroll forward' })).toBeNull();
    expect(within(top).queryByRole('button', { name: 'Scroll back' })).toBeNull();
  });

  it('keeps a long list in a rail of its own, and leads with the type it found most of', async () => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [1, 2, 3, 4, 5].map((i) => channel('src1', i, `Harbor ${i} TV`)),
      movies: [1, 2, 3, 4].map((i) => vod('src1', i, `Harbor ${i}`)),
      series: [show('src1', 1, 'Harbor Nine')],
    });
    renderAt('/search?q=harbor', [{ path: '/search', element: <SearchPage /> }]);
    const top = await screen.findByTestId('search-top');
    // Five channels, four movies, one series: the channels come first, on a phone too.
    expect(within(top).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Channels5', 'Movies4', 'Series1']);
    // A rail of one type keeps its "See all" to that type's tab.
    expect(within(within(top).getByRole('heading', { name: /^Movies/ }).closest('section')!).getByRole('link', { name: /See all/ })).toBeTruthy();
  });

  it('Back from a series puts focus on that series, not on the movie with the same place', async () => {
    // Four movies keep the two rails apart, so the first series and the first movie share index 0.
    rpcMock.handlers['catalog.search'] = () => ({
      live: [],
      movies: [1, 2, 3, 4].map((i) => vod('src1', i, `Harbor ${i}`)),
      series: [show('src1', 1, 'Harbor Nine'), show('src1', 2, 'Harbor Ten')],
    });
    renderSearch('/search?q=harbor');
    fireEvent.click(screen.getByRole('link', { name: 'Open search' }));
    const top = await screen.findByTestId('search-top');
    const series = await within(top).findByRole('link', { name: /^Harbor Nine/ });
    expect(series.getAttribute('data-grid-index')).toBe('0');
    fireEvent.click(series);
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await screen.findByTestId('search-top');
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Harbor Nine/));
  });

  it('See all opens the tab with focus on its first result, not in the search field', async () => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [],
      movies: [1, 2, 3, 4].map((i) => vod('src1', i, `Harbor ${i}`)),
      series: [show('src1', 1, 'Harbor Nine'), show('src1', 2, 'Harbor Ten')],
    });
    renderSearch('/search?q=harbor');
    fireEvent.click(screen.getByRole('link', { name: 'Open search' }));
    const field = screen.getByLabelText('Header search');
    await waitFor(() => expect(document.activeElement).toBe(field));
    const top = await screen.findByTestId('search-top');
    const seeAll = within(within(top).getByRole('heading', { name: /^Series/ }).closest('section')!).getByRole('link', { name: /See all/ });
    seeAll.focus();
    fireEvent.click(seeAll);
    const grid = await screen.findByTestId('vod-search-series');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-grid-index')).toBe('0'));
    expect(grid.contains(document.activeElement)).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(document.activeElement).not.toBe(field);
  });
});

describe('the landing reaches every category from the top', () => {
  const cat = (i: number): Category => ({ id: `k${i}`, sourceId: 'src1', contentType: 'movie', name: `Group ${i}`, hidden: false, itemCount: 5, position: i });

  it('lists the first categories as chips above the rails, and All categories opens the index there', async () => {
    rpcMock.handlers['catalog.categories'] = () => [...Array.from({ length: 30 }, (_, i) => cat(i)), { ...cat(99), name: 'Hidden one', hidden: true }];
    rpcMock.handlers['catalog.recentlyAdded'] = () => [];
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    const chips = await screen.findByRole('navigation', { name: 'Categories' });
    await waitFor(() => expect(within(chips).getAllByTestId('vod-category-chip')).toHaveLength(CATEGORY_CHIP_LIMIT));
    expect(within(chips).getByRole('link', { name: 'Group 0' }).getAttribute('href')).toBe('/s/src1/movies/c/k0');
    // Before the rails in the page.
    const recent = screen.getByRole('heading', { name: /Recently added/ });
    expect(chips.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Manage is at the top as well.
    expect(within(chips).getByRole('button', { name: 'Manage categories (1 hidden)' })).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Browse all categories' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(chips).getByRole('button', { name: 'All categories, 30 categories' }));
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(await screen.findByRole('list', { name: 'Categories' })).toBeTruthy();
    expect(localStorage.getItem(CATEGORY_INDEX_KEY)).toBe('1');
  });
});
