/**
 * Live TV, Movies and Series at the top of the rail (navigation pass, 2026-10-25): the Watch
 * group's links to a source's sections, the source each one opens, their current mark, the icon
 * rail, the palette's Go to list, and the sources' accordion, whose only source no longer opens by
 * itself.
 */

import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackPosition, RecentEntry, Source } from '@/api/types';

import { installDomStubs, makeSource, Page, renderRoutes, rpcMock, settings } from './harness';

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
}));
vi.mock('@/features/player', () => ({
  playItem: async () => undefined,
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../ShellLayout');
const { useShellStore } = await import('../store');
const { sectionCurrent, sectionTarget, vodTarget, watchLinks } = await import('../navigation');
const { resetRouteIntentForTests, setRouteWarmer } = await import('../routeIntent');

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        { path: 'dashboard', element: <Page>home page</Page> },
        { path: 'favorites', element: <Page>favorites page</Page> },
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
        { path: 'live/archive/:sourceId/:channel', element: <Page>archive page</Page> },
      ],
    },
  ];
}

/** An Xtream account after its first import: its counts are answers, so empty sections drop out. */
const imported = (id: string, over: Partial<Source> = {}) =>
  makeSource(id, { lastRefreshAt: '2026-10-24T10:00:00Z', radioCount: 0, seriesCount: 0, ...over });

/** Movies but no series, and a backup with series but no movies. */
const night = imported('s1', { name: 'Night Portal', movieCount: 40 });
const backup = imported('s2', { name: 'Backup', position: 1, channelCount: 80, movieCount: 0, seriesCount: 5 });

function handlers(sources: Source[]) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => sources;
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['recent.list'] = (): RecentEntry[] => [];
  h['positions.continueWatching'] = (): PlaybackPosition[] => [];
  h['favorites.list'] = () => [];
  h['catalog.channels'] = () => ({ items: [], total: 0 });
}

const watchGroup = async () => {
  const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
  return within(nav).getByRole('group', { name: 'Watch' });
};
const href = (group: HTMLElement, name: string) => within(group).getByRole('link', { name }).getAttribute('href');

beforeAll(installDomStubs);
beforeEach(() => {
  handlers([night, backup]);
  localStorage.clear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false, railHidden: false });
});
afterEach(() => {
  cleanup();
  resetRouteIntentForTests();
  setRouteWarmer(() => undefined);
});

describe('section targets', () => {
  it('vodTarget: the preferred source when it has the section, else the first that has it, by the rail rules', () => {
    expect(vodTarget([night, backup], 'movies', 's2')).toBe('/s/s1/movies');
    expect(vodTarget([night, backup], 'series', null)).toBe('/s/s2/series');
    const more = imported('s3', { movieCount: 7 });
    expect(vodTarget([night, more], 'movies', 's3')).toBe('/s/s3/movies');
    expect(vodTarget([night, more], 'movies', 'gone')).toBe('/s/s1/movies');
    // A portal keeps both (its totals may be missing), and an account not imported yet has every section.
    expect(vodTarget([night, imported('p', { kind: 'stalker', movieCount: 0 })], 'series', null)).toBe('/s/p/series');
    expect(vodTarget([night, makeSource('new', { movieCount: 0 })], 'series', null)).toBe('/s/new/series');
    // An M3U playlist only by its counts.
    expect(vodTarget([makeSource('m', { kind: 'm3u', movieCount: 0, seriesCount: 0 })], 'movies', 'm')).toBeNull();
    expect(vodTarget([night], 'series', 's1')).toBeNull();
    expect(vodTarget(undefined, 'movies', null)).toBeNull();
    // Ids are encoded in the path.
    expect(vodTarget([imported('a b', { movieCount: 1 })], 'movies', null)).toBe('/s/a%20b/movies');
  });

  it('sectionTarget: Live TV as the phone tab, the Sources page while there are no sources', () => {
    expect(sectionTarget('live', [night, backup], 's2')).toBe('/s/s2/live');
    expect(sectionTarget('live', [night, backup], null)).toBe('/s/s1/live');
    // A VOD-only account opens on its movies, as from the phone tab.
    expect(sectionTarget('live', [imported('v', { channelCount: 0, movieCount: 3 })], null)).toBe('/s/v/movies');
    expect(sectionTarget('movies', [night, backup], 's2')).toBe('/s/s1/movies');
    expect(sectionTarget('series', [night], null)).toBeNull();
    for (const section of ['live', 'movies', 'series'] as const) {
      expect(sectionTarget(section, [], null)).toBe('/sources');
      expect(sectionTarget(section, undefined, null)).toBe('/sources');
    }
  });

  it("sectionCurrent: a section's pages in any source, with the pages beside them", () => {
    expect(sectionCurrent('live', '/s/x/live')).toBe(true);
    expect(sectionCurrent('live', '/s/x/radio/4')).toBe(true);
    expect(sectionCurrent('live', '/live/archive/x/ch1')).toBe(true);
    expect(sectionCurrent('live', '/s/x/movies')).toBe(false);
    expect(sectionCurrent('movies', '/s/x/movies')).toBe(true);
    expect(sectionCurrent('movies', '/s/x/movies/c/7')).toBe(true);
    expect(sectionCurrent('movies', '/s/a%20b/movie/9')).toBe(true);
    expect(sectionCurrent('movies', '/s/x/series/4')).toBe(false);
    expect(sectionCurrent('series', '/s/x/series/4')).toBe(true);
    expect(sectionCurrent('series', '/s/x/seriesx')).toBe(false);
    expect(sectionCurrent('series', '/s/x')).toBe(false);
    for (const section of ['live', 'movies', 'series'] as const) expect(sectionCurrent(section, '/dashboard')).toBe(false);
  });

  it('watchLinks: rail order, a section no source has left out, and stepped back with no sources', () => {
    const labels = (links: { labelKey: string }[]) => links.map((l) => l.labelKey);
    const all = watchLinks([night, backup], 's1');
    expect(labels(all)).toEqual(['navDashboard', 'navSearch', 'railLive', 'navGuide', 'railMovies', 'railSeries', 'sports:title', 'navMultiview']);
    expect(all.filter((l) => l.section).map((l) => l.to)).toEqual(['/s/s1/live', '/s/s1/movies', '/s/s2/series']);
    expect(all.some((l) => l.dim)).toBe(false);
    expect(labels(watchLinks([night], 's1'))).not.toContain('railSeries');
    const none = watchLinks([], null).filter((l) => l.section);
    expect(none.map((l) => [l.to, l.dim])).toEqual([
      ['/sources', true],
      ['/sources', true],
      ['/sources', true],
    ]);
    // Still loading: every row holds its place, at full strength.
    expect(watchLinks(undefined, null).filter((l) => l.section).map((l) => l.dim)).toEqual([false, false, false]);
  });
});

describe('the Watch group', () => {
  it('leads to the source on show, else the one last opened, else the first that has the section', async () => {
    localStorage.setItem('tsrust.lastSource', 's2');
    const { router } = renderRoutes(routes(), '/dashboard');
    const watch = await watchGroup();
    await waitFor(() => expect(href(watch, 'Live TV')).toBe('/s/s2/live'));
    // The last source has no movies: the first that has them.
    expect(href(watch, 'Movies')).toBe('/s/s1/movies');
    expect(href(watch, 'Series')).toBe('/s/s2/series');
    // The source on show wins over the remembered one at once, not a navigation later.
    await act(() => router.navigate('/s/s1/movies'));
    expect(href(watch, 'Live TV')).toBe('/s/s1/live');
    expect(href(watch, 'Movies')).toBe('/s/s1/movies');
    expect(href(watch, 'Series')).toBe('/s/s2/series');
  });

  it("marks Movies on a movie's page, Series under it, and Live TV on radio and the archive", async () => {
    handlers([imported('s1', { name: 'Night Portal', movieCount: 40, seriesCount: 3 })]);
    const { router } = renderRoutes(routes(), '/s/s1/movie/9');
    const watch = await watchGroup();
    const current = () =>
      within(watch)
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page')
        .map((l) => l.textContent);
    await waitFor(() => expect(current()).toEqual(['Movies']));
    const movies = within(watch).getByRole('link', { name: 'Movies' });
    expect(movies.className).toContain('tuning-tick');
    expect(movies.querySelector('svg')!.getAttribute('class')).toContain('text-accent');
    await act(() => router.navigate('/s/s1/series/4'));
    expect(current()).toEqual(['Series']);
    await act(() => router.navigate('/s/s1/radio'));
    expect(current()).toEqual(['Live TV']);
    await act(() => router.navigate('/live/archive/s1/ch1'));
    expect(current()).toEqual(['Live TV']);
    await act(() => router.navigate('/dashboard'));
    expect(current()).toEqual(['Home']);
    // The only source stayed closed on its own pages: the Watch links mark them.
    expect(screen.getByRole('button', { name: /^Night Portal/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves out Movies and Series when no source has them', async () => {
    handlers([makeSource('m', { kind: 'm3u', name: 'Playlist', movieCount: 0, seriesCount: 0 })]);
    renderRoutes(routes(), '/dashboard');
    const watch = await watchGroup();
    await waitFor(() => expect(href(watch, 'Live TV')).toBe('/s/m/live'));
    expect(within(watch).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Search', 'Live TV', 'TV guide', 'Sports', 'Multi-view']);
  });

  it('collapsed, they are icons named by their tooltips, and the current one is marked', async () => {
    act(() => useShellStore.setState({ railCollapsed: true }));
    renderRoutes(routes(), '/s/s2/series');
    const watch = await watchGroup();
    await waitFor(() => expect(href(watch, 'Series')).toBe('/s/s2/series'));
    const series = within(watch).getByRole('link', { name: 'Series' });
    expect(series.textContent).toBe('');
    expect(series.getAttribute('aria-current')).toBe('page');
    expect(within(watch).getByRole('link', { name: 'Live TV' }).getAttribute('aria-current')).toBeNull();
    fireEvent.mouseEnter(within(watch).getByRole('link', { name: 'Movies' }));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Movies');
  });

  it("a rest on one starts its source's page", async () => {
    const warm = vi.fn();
    setRouteWarmer(warm);
    renderRoutes(routes(), '/s/s2/live');
    const watch = await watchGroup();
    await waitFor(() => expect(href(watch, 'Movies')).toBe('/s/s1/movies'));
    fireEvent.pointerEnter(within(watch).getByRole('link', { name: 'Movies' }));
    await waitFor(() => expect(warm).toHaveBeenCalledWith('/s/s1/movies'));
  });
});

describe('the palette', () => {
  it('Go to lists Live TV, Movies and Series in rail order, and they open the source on show', async () => {
    const { router } = renderRoutes(routes(), '/s/s2/live');
    await screen.findByText('source page');
    await screen.findAllByText('Backup');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const goTo = () => {
      const group = [...palette.querySelectorAll('[cmdk-group]')].find((g) => g.querySelector('[cmdk-group-heading]')?.textContent === 'Go to');
      return [...(group?.querySelectorAll('[cmdk-item]') ?? [])].map((el) => el.textContent ?? '');
    };
    // Search carries its key hint.
    await waitFor(() => expect(goTo().slice(0, 8)).toEqual(['Home', expect.stringContaining('Search'), 'Live TV', 'TV guide', 'Movies', 'Series', 'Sports', 'Multi-view']));
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'series' } });
    fireEvent.click(await within(palette).findByRole('option', { name: 'Series' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/s2/series'));
  });

  it('finds them by the words people use, and leaves out a section no source has', async () => {
    handlers([night]);
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    await screen.findAllByText('Night Portal');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByPlaceholderText('Type a command or search');
    fireEvent.change(input, { target: { value: 'films' } });
    expect(await within(palette).findByRole('option', { name: 'Movies' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'channels' } });
    expect(await within(palette).findByRole('option', { name: 'Live TV' })).toBeTruthy();
    // Night Portal has no series: neither Go to nor its own entries offer them.
    fireEvent.change(input, { target: { value: 'series' } });
    await waitFor(() => expect(within(palette).queryByRole('option', { name: 'Series' })).toBeNull());
  });
});

describe('the sources accordion', () => {
  it('with two or more sources, a page opens its source, also when the sources arrive after the page', async () => {
    let answer: (list: Source[]) => void = () => undefined;
    rpcMock.handlers['sources.list'] = () => new Promise<Source[]>((resolve) => (answer = resolve));
    renderRoutes(routes(), '/s/s2/live');
    await screen.findByText('source page');
    await act(async () => answer([night, backup]));
    const entry = await screen.findByRole('button', { name: /^Backup/ });
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^Night Portal/ }).getAttribute('aria-expanded')).toBe('false');
    // Opened by its page, not a press: nothing is remembered.
    expect(localStorage.getItem('tsrust.railSource')).toBeNull();
  });

  it('the only source opens on a press, from any page, and stays as the user left it', async () => {
    handlers([night]);
    const { router } = renderRoutes(routes(), '/s/s1/live');
    const entry = await screen.findByRole('button', { name: /^Night Portal/ });
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(entry);
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem('tsrust.railSource')).toBe('s1');
    await act(() => router.navigate('/dashboard'));
    expect(entry.getAttribute('aria-expanded')).toBe('true');
  });
});
