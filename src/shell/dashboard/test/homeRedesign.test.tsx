/**
 * The Home redesign (stage 1 of the SaaS polish): 16:9 Continue watching cards with their menu
 * (CB-CONTINUE-MENU), the On now rail with programme art (CB-PROGRAM-ART), live TV on Home for a
 * user with nothing watched yet (SH-home-empty-m3u), the quiet state's way out
 * (SH-quiet-live-path), the trending cards that say they search (SH-trending-dead-end) and the
 * calm wait behind the shell's offline strip (SH-offline-stack).
 */

import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgNowNext, FavoriteEntry, PlaybackPosition, RecentEntry } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from '../../test/harness';

configure({ asyncUtilTimeout: 4000 });

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
  getConnectionState: () => 'closed',
}));
vi.mock('@/features/player', () => ({
  playItem: (...a: unknown[]) => (playerMock.playItem as (...x: unknown[]) => Promise<void>)(...a),
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');
const { queryClient } = await import('@/api/query');
const { useConnectionStore } = await import('../../connection');
const { liveCandidates, onNowItems, trendingMatch } = await import('../DashboardPage');
const { useToastStore } = await import('@/ui');

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        ...shellRoutes,
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
        { path: 'recent', element: <Page>recent page</Page> },
        { path: 'search', element: <Page>search page</Page> },
      ],
    },
  ];
}

const movie = { sourceId: 's1', contentType: 'movie' as const, itemId: 'm1' };
const series = { sourceId: 's1', contentType: 'series' as const, itemId: 'v1' };
const news = { sourceId: 's1', contentType: 'live' as const, itemId: 'c1' };
const sport = { sourceId: 's1', contentType: 'live' as const, itemId: 'c2' };

const position = (ref: PlaybackPosition['ref'], title: string, over: Partial<PlaybackPosition> = {}): PlaybackPosition => ({
  ref,
  positionSeconds: 1200,
  durationSeconds: 4800,
  updatedAt: '2026-10-12T00:00:00Z',
  watched: false,
  snapshot: { title, contentType: ref.contentType },
  ...over,
});

const channel = (ref: Channel['ref'], name: string): Channel => ({ ref, name, categoryId: 'g', categoryName: 'News', isRadio: false, logoUrl: `https://img.test/${ref.itemId}.png` });

/** Now ± 30 minutes, so a programme is on air whatever the clock says. */
function onAir(title: string, icon?: string): EpgNowNext {
  const now = Date.now();
  return { now: { channelId: title, title, start: new Date(now - 30 * 60_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString(), ...(icon ? { icon } : {}) } };
}

function home(over: { continue?: PlaybackPosition[]; favorites?: FavoriteEntry[]; recent?: RecentEntry[]; channels?: Channel[]; nowNext?: Record<string, EpgNowNext> } = {}) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = () => over.continue ?? [];
  h['favorites.list'] = () => over.favorites ?? [];
  h['recent.list'] = () => over.recent ?? [];
  h['catalog.recentlyAdded'] = () => [];
  h['catalog.channels'] = () => ({ items: over.channels ?? [], total: over.channels?.length ?? 0 });
  h['epg.nowNext'] = () => over.nowNext ?? {};
  h['watchlist.list'] = () => [];
  h['lists.list'] = () => [];
  h['catalog.item'] = () => null;
}

beforeAll(installDomStubs);
beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  playerMock.playItem.mockClear();
  useToastStore.setState({ toasts: [] });
  useConnectionStore.setState({ offline: false, backOnline: false });
});
afterEach(cleanup);

describe('Continue watching (CB-CONTINUE-MENU)', () => {
  const cards = [position(movie, 'The Long Signal'), position(series, 'Harbor Nine', { episodeId: 'e4', snapshot: { title: 'Harbor Nine', subtitle: 'S2 E4 · Calm Before', contentType: 'series' } })];

  it('shows 16:9 stills with the episode and the time left in the caption, and See all leads to Recently watched', async () => {
    home({ continue: cards });
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    const card = await within(rail).findByRole('button', { name: 'Resume Harbor Nine' });
    expect(card.querySelector('.aspect-video')).toBeTruthy();
    // The episode moved off the artwork into the caption.
    expect(within(card).getByText('S2 E4 · Calm Before')).toBeTruthy();
    expect(within(card).getByText('60 minutes left')).toBeTruthy();
    expect(within(rail).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/recent');
  });

  it('right click, Shift+F10 and the card button open Go to details, Mark watched and Remove', async () => {
    home({ continue: cards });
    const { router } = renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    const card = await within(rail).findByRole('button', { name: 'Resume The Long Signal' });
    fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
    let menu = await screen.findByRole('menu', { name: 'The Long Signal' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Go to details', 'Mark as watched', 'Remove from continue watching']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    card.focus();
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    menu = await screen.findByRole('menu', { name: 'The Long Signal' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    // The visible button beside the card, for touch and the mouse.
    fireEvent.click(within(rail).getByRole('button', { name: 'More actions for The Long Signal' }));
    menu = await screen.findByRole('menu', { name: 'The Long Signal' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Go to details' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/s1/movie/m1'));
  });

  it('Remove takes every unfinished episode of a series card, with an Undo that puts them back', async () => {
    home({ continue: cards });
    const rows = [position(series, 'Harbor Nine', { episodeId: 'e4' }), position(series, 'Harbor Nine', { episodeId: 'e3', updatedAt: '2026-10-11T00:00:00Z' })];
    rpcMock.handlers['positions.forSeries'] = () => rows;
    rpcMock.handlers['positions.remove'] = () => null;
    rpcMock.handlers['positions.set'] = () => null;
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    fireEvent.contextMenu(await within(rail).findByRole('button', { name: 'Resume Harbor Nine' }), { clientX: 30, clientY: 40 });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Remove from continue watching' }));
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'positions.remove' && JSON.stringify(c.args) === JSON.stringify({ ref: series, allEpisodes: true }))).toBe(true));
    const toast = await waitFor(() => {
      const t = useToastStore.getState().toasts.find((x) => x.title === 'Removed Harbor Nine from continue watching');
      expect(t).toBeTruthy();
      return t!;
    });
    act(() => toast.action!.onClick());
    await waitFor(() => expect(rpcMock.calls.filter((c) => c.cmd === 'positions.set')).toHaveLength(2));
  });

  it('Mark watched marks the episode the card resumes, not the whole series', async () => {
    home({ continue: cards });
    rpcMock.handlers['positions.forSeries'] = () => [];
    rpcMock.handlers['userstate.setWatched'] = () => null;
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    fireEvent.contextMenu(await within(rail).findByRole('button', { name: 'Resume Harbor Nine' }), { clientX: 30, clientY: 40 });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Mark as watched' }));
    await waitFor(() => expect(rpcMock.calls.filter((c) => c.cmd === 'userstate.setWatched').map((c) => c.args)).toEqual([{ ref: series, episodeId: 'e4', watched: true }]));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === 'Harbor Nine marked watched')).toBe(true));
  });

  it("the hero's continue slide offers the same menu behind a third button", async () => {
    home({ continue: cards });
    rpcMock.handlers['positions.remove'] = () => null;
    const { router } = renderRoutes(routes(), '/dashboard');
    const slide = await screen.findByTestId('hero-slide');
    const more = within(slide).getByRole('button', { name: 'More actions for The Long Signal' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(more);
    let menu = await screen.findByRole('menu', { name: 'The Long Signal' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Go to details', 'Mark as watched', 'Remove from continue watching']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from continue watching' }));
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'positions.remove' && JSON.stringify(c.args) === JSON.stringify({ ref: movie }))).toBe(true));
    fireEvent.click(within(await screen.findByTestId('hero-slide')).getByRole('button', { name: /^More actions for/ }));
    menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Go to details' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/s\/s1\/(movie|series)\//));
  });

  it('a new arrival in the hero has no menu: there is nothing to remove or mark', async () => {
    home();
    rpcMock.handlers['catalog.recentlyAdded'] = (a) =>
      (a as { contentType: string }).contentType === 'movie'
        ? [{ ref: { sourceId: 's1', contentType: 'movie', itemId: 'n1' }, title: 'Fresh Arrival', posterUrl: 'https://img.test/p.jpg', added: '2026-10-09T00:00:00Z', categoryId: 'c' }]
        : [];
    renderRoutes(routes(), '/dashboard');
    const slide = await screen.findByTestId('hero-slide');
    expect(within(slide).getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(within(slide).queryByRole('button', { name: /More actions/ })).toBeNull();
  });
});

describe('On now (CB-PROGRAM-ART)', () => {
  const fav = (ref: FavoriteEntry['ref'], title: string): FavoriteEntry => ({ ref, addedAt: '2026-10-01T00:00:00Z', position: 0, snapshot: { title, contentType: 'live' } });

  it('orders history, then the source fill, one entry per channel, no radio, and leaves the favourites out', () => {
    const radio = { sourceId: 's1', contentType: 'radio' as const, itemId: 'r1' };
    const weather = { sourceId: 's1', contentType: 'live' as const, itemId: 'c3' };
    const seen = (ref: RecentEntry['ref'], title: string): RecentEntry => ({ ref, viewedAt: '2026-10-12T00:00:00Z', snapshot: { title, contentType: ref.contentType } });
    const list = liveCandidates(
      // Their own rail shows them with the same programmes, just below.
      [fav(news, 'News 24'), fav(radio, 'Jazz FM')],
      [seen(weather, 'Weather Now'), seen(news, 'News 24'), seen(radio, 'Jazz FM')],
      [channel(news, 'News 24'), channel(sport, 'Sport 1'), channel(weather, 'Weather Now')],
    );
    expect(list.map((c) => c.name)).toEqual(['Weather Now', 'Sport 1']);
  });

  it('keeps only programmes on air, with their share and minutes left', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const candidates = liveCandidates([], [], [channel(news, 'News 24'), channel(sport, 'Sport 1')]);
    const items = onNowItems(
      candidates,
      {
        's1|live|c1': { now: { channelId: 'n', title: 'Noon Bulletin', start: '2026-10-12T11:30:00Z', end: '2026-10-12T12:30:00Z' } },
        's1|live|c2': { now: { channelId: 's', title: 'Over', start: '2026-10-12T10:00:00Z', end: '2026-10-12T11:00:00Z' } },
      },
      0,
      now,
    );
    expect(items.map((i) => i.programme.title)).toEqual(['Noon Bulletin']);
    expect(items[0]!.progress).toBeCloseTo(0.5);
    expect(items[0]!.left).toBe(30);
  });

  it('draws what is on air with the programme picture and the channel logo, and plays the channel', async () => {
    home({
      channels: [channel(news, 'News 24'), channel(sport, 'Sport 1')],
      favorites: [fav(sport, 'Sport 1')],
      nowNext: { 's1|live|c1': onAir('Morning Bulletin', 'https://img.test/bulletin.jpg'), 's1|live|c2': onAir('Match Day') },
    });
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-on-now');
    const card = await within(rail).findByRole('button', { name: /Play News 24/ });
    expect(within(card).getByText('Morning Bulletin')).toBeTruthy();
    expect(within(card).getByText('News 24')).toBeTruthy();
    expect(card.innerHTML).toContain(encodeURIComponent('https://img.test/bulletin.jpg'));
    expect(within(rail).getByRole('link', { name: 'Full guide' }).getAttribute('href')).toBe('/epg');
    fireEvent.click(card);
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: news, isLive: true })));
    // One guide call for the rail and the favourites under it.
    expect(rpcMock.calls.filter((c) => c.cmd === 'epg.nowNext')).toHaveLength(1);
  });

  it('does not repeat a channel another live rail shows: a favourite, or a recent one while its rail is on', async () => {
    const weather = { sourceId: 's1', contentType: 'live' as const, itemId: 'c3' };
    const recent: RecentEntry[] = [{ ref: weather, viewedAt: '2026-10-12T00:00:00Z', snapshot: { title: 'Weather Now', contentType: 'live' } }];
    const nowNext = { 's1|live|c1': onAir('Morning Bulletin'), 's1|live|c2': onAir('Match Day'), 's1|live|c3': onAir('Forecast') };
    home({ favorites: [fav(news, 'News 24')], recent, channels: [channel(news, 'News 24'), channel(sport, 'Sport 1'), channel(weather, 'Weather Now')], nowNext });
    renderRoutes(routes(), '/dashboard');
    const onNow = await screen.findByTestId('dashboard-rail-on-now');
    await within(onNow).findByRole('button', { name: /Play Sport 1/ });
    const programmes = (rail: HTMLElement) =>
      [...rail.querySelectorAll('[data-on-now]')].map((b) => ['Morning Bulletin', 'Match Day', 'Forecast'].find((p) => b.textContent!.includes(p)));
    expect(programmes(onNow)).toEqual(['Match Day']);
    // The favourites rail just below shows the programme itself; both read the one guide answer.
    const favorite = within(await screen.findByTestId('dashboard-rail-live-favorites')).getByRole('button', { name: 'Play News 24' });
    await waitFor(() => expect(within(favorite).getByText('Morning Bulletin')).toBeTruthy());
    expect(within(screen.getByTestId('dashboard-rail-recent-live')).getByRole('button', { name: 'Play Weather Now' })).toBeTruthy();
    expect(rpcMock.calls.filter((c) => c.cmd === 'epg.nowNext')).toHaveLength(1);
    cleanup();

    // With the recent channels rail off, On now leads with them again.
    queryClient.clear();
    rpcMock.handlers['settings.get'] = () => settings({ dashboardRails: { ...settings().dashboardRails, recentlyWatchedLive: false } });
    renderRoutes(routes(), '/dashboard');
    const again = await screen.findByTestId('dashboard-rail-on-now');
    await within(again).findByRole('button', { name: /Play Weather Now/ });
    expect(programmes(again)).toEqual(['Forecast', 'Match Day']);
  });

  it('with no guide data and nothing watched yet, Home lists the source’s channels (SH-home-empty-m3u)', async () => {
    home({ channels: [channel(news, 'News 24'), channel(sport, 'Sport 1')] });
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-source-channels');
    expect(within(rail).getByRole('heading', { name: 'Channels in Night Portal' })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: 'Play Sport 1' })).toBeTruthy();
    expect(within(rail).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/s/s1/live');
    expect(screen.queryByText('Nothing to show yet')).toBeNull();
  });
});

describe('quiet state and trending', () => {
  it("'Browse' goes to a VOD-only source's own home, named for what it holds (SH-quiet-live-path)", async () => {
    home();
    rpcMock.handlers['sources.list'] = () => [makeSource('vod', { name: 'Films Only', channelCount: 0, movieCount: 30 })];
    const { router } = renderRoutes(routes(), '/dashboard');
    fireEvent.click(await screen.findByRole('link', { name: /^Browse movies/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/vod/movies'));
  });

  it('a custom list on Home is content: no quiet state under its rail', async () => {
    home();
    rpcMock.handlers['settings.get'] = () => settings({ dashboardRails: { ...settings().dashboardRails, liveFavorites: false } });
    rpcMock.handlers['lists.list'] = () => [{ id: 'l1', name: 'Weekend', position: 0, onDashboard: true, itemCount: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }];
    rpcMock.handlers['lists.items'] = () => [];
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-rail-recent-sources');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByTestId('dashboard-quiet')).toBeNull();
  });

  it('the quiet state offers three ways in: the source, the guide and search; no guide without channels', async () => {
    home();
    rpcMock.handlers['settings.get'] = () => settings({ dashboardRails: { ...settings().dashboardRails, liveFavorites: false } });
    renderRoutes(routes(), '/dashboard');
    const quiet = await screen.findByTestId('dashboard-quiet');
    expect(within(quiet).getByRole('heading', { name: 'Nothing to show yet' })).toBeTruthy();
    const links = within(quiet).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Browse live TVNight Portal', '/s/s1/live'],
      ["TV guideWhat's on now and next", '/epg'],
      ['SearchChannels, movies and series', '/search'],
    ]);
    cleanup();
    rpcMock.handlers['sources.list'] = () => [makeSource('vod', { name: 'Films Only', channelCount: 0, movieCount: 0, seriesCount: 4 })];
    renderRoutes(routes(), '/dashboard');
    const vodOnly = await screen.findByTestId('dashboard-quiet');
    expect(within(vodOnly).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/s/vod/series', '/search']);
  });

  it('a trending card says it searches: a search mark, not the play disc (SH-trending-dead-end)', async () => {
    home();
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { ...settings().tmdb, enabled: true } });
    rpcMock.handlers['tmdb.trending'] = () => [{ tmdbId: 1, mediaType: 'movie', title: 'Far Shore', year: 2026 }];
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-tmdb-trending');
    const card = within(rail).getByRole('link', { name: 'Find Far Shore in your sources' });
    expect(card.getAttribute('href')).toBe('/search?q=Far%20Shore');
    expect(card.querySelector('svg.lucide-search')).toBeTruthy();
    expect(card.textContent).toContain('Find in your sources');
  });

  it('a trending title the catalog has opens its detail page instead of a search (SH-trending-dead-end)', async () => {
    home();
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { ...settings().tmdb, enabled: true } });
    rpcMock.handlers['tmdb.trending'] = () => [
      { tmdbId: 1, mediaType: 'movie', title: 'Far Shore', year: 2026 },
      { tmdbId: 2, mediaType: 'tv', title: 'Elsewhere', year: 2025 },
    ];
    rpcMock.handlers['catalog.search'] = (a) => {
      const { query } = a as { query: string };
      return query === 'Far Shore'
        ? { live: [], movies: [{ ref: { sourceId: 's1', contentType: 'movie', itemId: 'fs' }, title: 'Far Shore (2026) [4K]', titleBase: 'Far Shore', year: 2026, categoryId: 'c' }], series: [] }
        : { live: [], movies: [], series: [] };
    };
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-tmdb-trending');
    const found = await within(rail).findByRole('link', { name: /Far Shore.*Night Portal/ });
    expect(found.getAttribute('href')).toBe('/s/s1/movie/fs');
    expect(found.textContent).toContain('Night Portal');
    expect(found.querySelector('svg.lucide-search')).toBeNull();
    // Not in the catalog: still a search, and it says so.
    expect(within(rail).getByRole('link', { name: 'Find Elsewhere in your sources' }).getAttribute('href')).toBe('/search?q=Elsewhere');
    expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.search').map((c) => c.args)).toEqual([
      { query: 'Far Shore', contentTypes: ['movie'], limit: 8 },
      { query: 'Elsewhere', contentTypes: ['series'], limit: 8 },
    ]);
  });

  it('matches a trending title by name and kind, with the year give or take one', () => {
    const film = (title: string, year?: number, titleBase?: string) => ({ ref: { sourceId: 's1', contentType: 'movie' as const, itemId: title }, title, titleBase, year, categoryId: 'c' });
    const found = { live: [], movies: [film('Far Shore 2', 2026), film('FAR SHORE!', 2025), film('Far Shore', 2019)], series: [] };
    expect(trendingMatch({ tmdbId: 1, mediaType: 'movie', title: 'Far Shore', year: 2026 }, found)?.title).toBe('FAR SHORE!');
    expect(trendingMatch({ tmdbId: 1, mediaType: 'movie', title: 'Far Shore', year: 2010 }, found)).toBeUndefined();
    expect(trendingMatch({ tmdbId: 1, mediaType: 'tv', title: 'Far Shore', year: 2026 }, found)).toBeUndefined();
    expect(trendingMatch({ tmdbId: 1, mediaType: 'movie', title: 'Amélie' }, { live: [], movies: [film('Amelie (2001)', 2001, 'Amelie')], series: [] })?.titleBase).toBe('Amelie');
  });
});

describe('per-card lookups wait for the view (SH-home-rpc-fanout)', () => {
  /** An IntersectionObserver that reports only what the test says is in view. */
  function stubObserver() {
    const observers: { report: IntersectionObserverCallback; targets: Set<Element> }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(function (this: object, report: IntersectionObserverCallback) {
        const o = { report, targets: new Set<Element>() };
        observers.push(o);
        return Object.assign(this, {
          observe: (el: Element) => o.targets.add(el),
          unobserve: (el: Element) => o.targets.delete(el),
          disconnect: () => o.targets.clear(),
          takeRecords: () => [],
        });
      }),
    );
    return (el: Element) =>
      act(() => {
        for (const o of observers) if (o.targets.has(el)) o.report([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      });
  }
  afterEach(() => vi.unstubAllGlobals());

  it('a trending card searches the catalog once it is near the view and the page went idle, not on mount', async () => {
    const inView = stubObserver();
    home();
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { ...settings().tmdb, enabled: true } });
    rpcMock.handlers['tmdb.trending'] = () => [
      { tmdbId: 1, mediaType: 'movie', title: 'Far Shore', year: 2026 },
      { tmdbId: 2, mediaType: 'tv', title: 'Elsewhere', year: 2025 },
      { tmdbId: 3, mediaType: 'movie', title: 'Third Light', year: 2024 },
    ];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-tmdb-trending');
    // Past the idle wait (whenIdle falls back to 200 ms here): still nothing near, nothing asked.
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.search')).toEqual([]);
    inView(within(rail).getByRole('link', { name: 'Find Elsewhere in your sources' }));
    await waitFor(() =>
      expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.search').map((c) => c.args)).toEqual([{ query: 'Elsewhere', contentTypes: ['series'], limit: 8 }]),
    );
  });

  it('a Continue watching card reads its backdrop only once it is near the view', async () => {
    const inView = stubObserver();
    home({ continue: [position(movie, 'The Long Signal'), position(series, 'Harbor Nine')] });
    // The hero reads its own slides' details; off, so only the cards ask here.
    rpcMock.handlers['settings.get'] = () => settings({ dashboardRails: { ...settings().dashboardRails, hero: false } });
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    const card = await within(rail).findByRole('button', { name: 'Resume Harbor Nine' });
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.item')).toEqual([]);
    inView(card);
    await waitFor(() => expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.item').map((c) => c.args)).toEqual([{ ref: series }]));
  });
});

describe('offline (SH-offline-stack)', () => {
  it('behind the offline strip Home waits quietly instead of showing a red error, and so does the rail', async () => {
    home();
    rpcMock.handlers['sources.list'] = () => {
      throw { code: 'network', message: 'server unreachable', details: { transport: 'unreachable' } };
    };
    act(() => useConnectionStore.setState({ offline: true }));
    renderRoutes(routes(), '/dashboard');
    expect(await screen.findByText('Waiting for the server')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).queryByTestId('rail-sources-error')).toBeNull();
    expect(within(nav).getByTestId('rail-sources-pending')).toBeTruthy();
  });
});
