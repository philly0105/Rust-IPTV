/**
 * The shell redesign (stage 1 of the SaaS polish): the grouped rail with its one-row footer and
 * zero-sources state (SH-rail-ia, SH-welcome-generic), the phone tab bar and its More sheet
 * (CB-PHONE-NAV), the palette's empty view and the quieter shortcut reference, and the one-time
 * notice for a server reached over plain HTTP (SR-4).
 */

import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackPosition, RecentEntry } from '@/api/types';

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
const { isLiveRoute, liveTabTarget, rememberRouteSource, readLastSource } = await import('../navigation');
const { SECURE_NOTICE_DELAY_MS } = await import('../SecureContextNotice');
const { useToastStore } = await import('@/ui');
const { TOAST_AVOID_SELECTOR } = await import('@/ui/Toast');

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        { path: 'dashboard', element: <Page>home page</Page> },
        { path: 'favorites', element: <Page>favorites page</Page> },
        { path: 'my-list', element: <Page>my list page</Page> },
        { path: 'downloads', element: <Page>downloads page</Page> },
        { path: 'stats', element: <Page>stats page</Page> },
        { path: 'sources', element: <Page>sources page</Page> },
        { path: 'search', element: <Page>search page</Page> },
        { path: 'epg', element: <Page>guide page</Page> },
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
      ],
    },
  ];
}

function handlers(sources = [makeSource('s1', { name: 'Night Portal' }), makeSource('s2', { name: 'Backup', position: 1 })]) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => sources;
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['recent.list'] = (): RecentEntry[] => [];
  h['positions.continueWatching'] = (): PlaybackPosition[] => [];
  h['favorites.list'] = () => [];
}

let matchMedia: typeof window.matchMedia;
/** Matches the given media queries only. */
function media(...queries: string[]) {
  window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: queries.includes(query) })) as typeof window.matchMedia;
}
const PHONE = ['(max-width: 639px)', '(max-width: 1023px)'];

beforeAll(installDomStubs);
beforeEach(() => {
  matchMedia = window.matchMedia;
  handlers();
  localStorage.clear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false, railHidden: false });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  window.matchMedia = matchMedia;
  vi.useRealTimers();
});

describe('rail (SH-rail-ia)', () => {
  it('groups the links under Watch, Library and Sources, with the brand mark and a one-row footer', async () => {
    renderRoutes(routes(), '/favorites');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await within(nav).findByText('Night Portal');
    const group = (name: string) => within(nav).getByRole('group', { name });
    expect(within(group('Watch')).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Home',
      'Live TV',
      'TV guide',
      'Movies',
      'Series',
      'Sports',
      'Multi-view',
    ]);
    // On Favorites the less used pages stay folded under More, which opens them in place.
    expect(within(group('Library')).getAllByRole('link').map((l) => l.textContent)).toEqual(['My List', 'Favorites', 'Lists', 'Recently watched']);
    fireEvent.click(within(group('Library')).getByRole('button', { name: 'More' }));
    expect(within(group('Library')).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'My List',
      'Favorites',
      'Lists',
      'Recently watched',
      'Downloads',
      'My videos',
      'Scheduled',
      'Watch stats',
    ]);
    expect(within(group('Sources')).getByText('Backup')).toBeTruthy();
    // No Search row: the header's search box is the way in, and the palette still goes to the page.
    expect(within(nav).queryByRole('link', { name: 'Search' })).toBeNull();
    expect(within(screen.getByTestId('shell-header')).getByTestId('open-palette')).toBeTruthy();
    // The app's own mark, not a CSS drawing.
    expect(within(nav).getByRole('link', { name: 'Tsrust IPTV' }).querySelector('svg')).toBeTruthy();
    // The footer: Settings, then the keyboard reference and the collapse toggle as icon buttons.
    const settingsLink = within(nav).getByRole('link', { name: 'Settings' });
    const footer = settingsLink.closest('[class*="border-t"]') as HTMLElement;
    expect(within(footer).getByRole('button', { name: 'Keyboard shortcuts' }).className).toContain('pointer-coarse:hidden');
    expect(within(footer).getByRole('button', { name: 'Collapse sidebar' })).toBeTruthy();
    expect(within(footer).getAllByRole('button')).toHaveLength(2);
    // Kinds are spoken, not printed as "XC" or "STB" (SH-kind-labels-copy).
    expect(within(nav).queryByText('XC')).toBeNull();
    expect(within(nav).getByRole('button', { name: /Night Portal, Xtream/ })).toBeTruthy();
  });

  it('makes the only source one row to the Sources page: its Live TV, Radio, Movies and Series are in the Watch group', async () => {
    handlers([makeSource('s1', { name: 'Only One' })]);
    renderRoutes(routes(), '/favorites');
    const row = await screen.findByRole('link', { name: /^Only One.*Manage sources$/ });
    expect(row.getAttribute('href')).toBe('/sources');
    expect(screen.queryByRole('button', { name: /Only One/ })).toBeNull();
    // It stands for Manage sources, which no longer has a row of its own.
    const sources = screen.getByRole('group', { name: 'Sources' });
    expect(within(sources).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/sources?add=1', '/sources']);
    const watch = screen.getByRole('group', { name: 'Watch' });
    expect(within(watch).getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/s1/live');
    // Radio was the one link of the source's own that no Watch or Library row had: it follows Live TV.
    expect(within(watch).getByRole('link', { name: 'Radio' }).getAttribute('href')).toBe('/s/s1/radio');
    expect(within(watch).getAllByRole('link').map((l) => l.textContent).slice(1, 4)).toEqual(['Live TV', 'Radio', 'TV guide']);
    expect(within(watch).getByRole('link', { name: 'Movies' }).getAttribute('href')).toBe('/s/s1/movies');
    expect(within(watch).getByRole('link', { name: 'Series' }).getAttribute('href')).toBe('/s/s1/series');
  });

  it('with no sources: Library steps back and one dashed Add source row stands in, except where onboarding shows', async () => {
    handlers([]);
    const { router } = renderRoutes(routes(), '/favorites');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const add = await within(nav).findByTestId('rail-add-source');
    expect(add.getAttribute('href')).toBe('/sources?add=1');
    expect(add.className).toContain('border-dashed');
    // The rows whose pages need a source step back; Lists, Home and Sports work without one.
    const dimmed = (name: string) => within(nav).getByRole('link', { name }).className.includes('text-fg-subtle');
    // (Favorites is the page on show, so it wears the current mark instead.)
    for (const name of ['My List', 'Recently watched', 'TV guide', 'Multi-view']) expect(dimmed(name), name).toBe(true);
    for (const name of ['Lists', 'Home', 'Sports']) expect(dimmed(name), name).toBe(false);
    // Live TV, Movies and Series step back too, and lead to the Sources page, as the phone tab does.
    const watch = within(nav).getByRole('group', { name: 'Watch' });
    for (const name of ['Live TV', 'Movies', 'Series']) {
      const link = within(watch).getByRole('link', { name });
      expect(link.getAttribute('href'), name).toBe(`/sources?for=${name === 'Live TV' ? 'live' : name.toLowerCase()}`);
      expect(link.className, name).toContain('text-fg-subtle');
    }
    // No "+" beside the Sources label: the row is the one way in.
    expect(within(within(nav).getByRole('group', { name: 'Sources' })).queryByRole('link', { name: 'Add source' })).toBe(add);
    await act(() => router.navigate('/dashboard'));
    expect(within(nav).queryByTestId('rail-add-source')).toBeNull();
    // The row the user picked keeps the mark on the Sources page, not Manage sources.
    fireEvent.click(within(watch).getByRole('link', { name: 'Movies' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sources'));
    expect(within(watch).getByRole('link', { name: 'Movies' }).getAttribute('aria-current')).toBe('page');
    expect(within(watch).getByRole('link', { name: 'Live TV' }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Manage sources' }).getAttribute('aria-current')).toBeNull();
    await act(() => router.navigate('/sources'));
    expect(within(nav).getByRole('link', { name: 'Manage sources' }).getAttribute('aria-current')).toBe('page');
    expect(within(watch).getByRole('link', { name: 'Movies' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('rail at laptop heights (stage 2)', () => {
  it("Library's less used pages fold under More, which remembers a press and opens for one of its pages", async () => {
    renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const library = within(nav).getByRole('group', { name: 'Library' });
    // The label is a plain heading again: the group no longer folds as a whole.
    expect(within(library).queryByRole('button', { name: 'Library' })).toBeNull();
    const more = within(library).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(within(library).getByRole('link', { name: 'My List' })).toBeTruthy();
    expect(within(library).queryByRole('link', { name: 'Downloads' })).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(within(list).getAllByRole('link').map((l) => l.textContent)).toEqual(['Downloads', 'My videos', 'Scheduled', 'Watch stats']);
    cleanup();

    // The press is kept for the next launch.
    renderRoutes(routes(), '/dashboard');
    const again = await screen.findByRole('navigation', { name: 'Main navigation' });
    const moreAgain = within(again).getByRole('button', { name: 'More' });
    expect(moreAgain.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(moreAgain);
    cleanup();

    // One of its pages opens it (from a card or the palette), so the current page is never a hidden link.
    const { router } = renderRoutes(routes(), '/dashboard');
    const nav2 = await screen.findByRole('navigation', { name: 'Main navigation' });
    const more2 = within(nav2).getByRole('button', { name: 'More' });
    expect(more2.getAttribute('aria-expanded')).toBe('false');
    await act(() => router.navigate('/downloads'));
    expect(more2.getAttribute('aria-expanded')).toBe('true');
    expect(within(nav2).getByRole('link', { name: 'Downloads' }).getAttribute('aria-current')).toBe('page');
    // Leaving keeps it open: only a press folds it, and the reopening is not saved.
    await act(() => router.navigate('/dashboard'));
    expect(more2.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem('tsrust.railLibraryMore')).toBe('0');
  });

  // library-navigation-stays-folded: tracked by page, not by "one of them is open", so a fold on
  // one of the folded pages does not hide the next one's link.
  it('folded on one of its pages, More opens again when another of them opens', async () => {
    const { router } = renderRoutes(routes(), '/downloads');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const more = within(nav).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await act(() => router.navigate('/stats'));
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(within(nav).getByRole('link', { name: 'Watch stats' }).getAttribute('aria-current')).toBe('page');
    // Folding there stays a choice: a page inside the same entry does not undo it.
    fireEvent.click(more);
    await act(() => router.navigate('/stats?days=7'));
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('remembers which sources the user opened or closed', async () => {
    renderRoutes(routes(), '/dashboard');
    const backup = await screen.findByRole('button', { name: /^Backup/ });
    expect(backup.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(backup);
    cleanup();
    renderRoutes(routes(), '/dashboard');
    expect((await screen.findByRole('button', { name: /^Backup/ })).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^Night Portal/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('collapsed: the footer keeps Settings and the toggle, and the current source is marked for the scroll', async () => {
    act(() => useShellStore.setState({ railCollapsed: true }));
    renderRoutes(routes(), '/s/s2/live');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await within(nav).findByRole('button', { name: 'Backup' });
    expect(within(nav).queryByTestId('rail-shortcuts')).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    const current = nav.querySelectorAll('[data-rail-current]');
    expect(current).toHaveLength(1);
    expect(within(current[0] as HTMLElement).getByRole('button', { name: 'Backup' })).toBeTruthy();
    // The icon-only rail folds the same pages: More is an icon named by its tooltip, and opens them in place.
    expect(within(nav).getByRole('link', { name: 'My List' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Downloads' })).toBeNull();
    const more = within(nav).getByRole('button', { name: 'More' });
    expect(more.textContent).toBe('');
    fireEvent.click(more);
    expect(within(nav).getByRole('link', { name: 'Downloads' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Watch stats' })).toBeTruthy();
  });
});

describe('phone tab bar (CB-PHONE-NAV)', () => {
  it('replaces the rail below sm, exposes its height to overlays, and the header keeps only the title', async () => {
    media(...PHONE);
    renderRoutes(routes(), '/dashboard');
    const bar = await screen.findByTestId('tab-bar');
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toEqual([bar]);
    expect(screen.queryByTestId('shell-rail')).toBeNull();
    expect(screen.queryByTestId('rail-show')).toBeNull();
    expect(within(bar).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Live TV', 'TV guide', 'Search']);
    expect(within(bar).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(document.documentElement.style.getPropertyValue('--shell-bottom-inset')).toContain('safe-area-inset-bottom');
    // Toasts lift above the bar instead of covering its labels (ui/Toast.tsx measures it).
    expect(bar.matches(TOAST_AVOID_SELECTOR)).toBe(true);
    expect(screen.queryByTestId('open-palette')).toBeNull();
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
    cleanup();
    expect(document.documentElement.style.getPropertyValue('--shell-bottom-inset')).toBe('');
  });

  it('the tabs have short labels of their own that fit a 360 px phone in every locale', async () => {
    // Measured at 360 px (scratch shots): eleven letters fit a tab at its text size, and the
    // rail's longer names (Programmführer, Telewizja na żywo) were cut off.
    const { LANGUAGES } = await import('@/i18n');
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const { code } of LANGUAGES) {
      const shell = JSON.parse(fs.readFileSync(path.join(__dirname, '../../i18n', code, 'shell.json'), 'utf8')) as Record<string, string>;
      for (const key of ['tabHome', 'tabLive', 'tabGuide', 'navSearch', 'tabMore']) {
        expect([...shell[key]!].length, `${code} ${key} "${shell[key]}"`).toBeLessThanOrEqual(11);
      }
    }
  });

  it('Live TV opens the source last opened, else the first that imported cleanly with channels', () => {
    const a = makeSource('a', { channelCount: 0, movieCount: 10 });
    const b = makeSource('b', { channelCount: 50, lastError: 'timeout' });
    const c = makeSource('c', { channelCount: 80 });
    expect(liveTabTarget([a, b, c], null)).toBe('/s/c/live');
    expect(liveTabTarget([a, b, c], 'b')).toBe('/s/b/live');
    // The last source has no channels: the best one with channels instead.
    expect(liveTabTarget([a, b, c], 'a')).toBe('/s/c/live');
    expect(liveTabTarget([a], null)).toBe('/s/a/movies');
    expect(liveTabTarget([], null)).toBeNull();
    expect(isLiveRoute('/s/x/live/12')).toBe(true);
    expect(isLiveRoute('/s/x/radio')).toBe(true);
    expect(isLiveRoute('/live/archive/x/1')).toBe(true);
    expect(isLiveRoute('/s/x/movies')).toBe(false);
    rememberRouteSource('/s/b/movies');
    expect(readLastSource()).toBe('b');
    rememberRouteSource('/favorites');
    expect(readLastSource()).toBe('b');
  });

  it('follows the source the user opened, and More holds the Watch pages without a tab, the Library, the sources and Settings', async () => {
    media(...PHONE);
    const { router } = renderRoutes(routes(), '/s/s2/movies');
    const bar = await screen.findByTestId('tab-bar');
    await waitFor(() => expect(within(bar).getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/s2/live'));
    // Movies of a source is under More.
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more.className).toContain('before:bg-accent');
    fireEvent.click(more);
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    // The Watch pages the bar has no tab for lead the sheet: Movies and Series of the source on
    // show, marked current as in the rail, then Sports and Multi-view.
    const watch = within(sheet).getByRole('region', { name: 'Watch' });
    const tiles = within(watch).getAllByRole('link');
    expect(tiles.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Movies', '/s/s2/movies'],
      ['Series', '/s/s2/series'],
      ['Sports', '/sports'],
      ['Multi-view', '/multiview'],
    ]);
    expect(tiles.map((l) => l.getAttribute('aria-current'))).toEqual(['page', null, null, null]);
    expect(within(sheet).getByRole('link', { name: 'My List' })).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Manage sources' }).getAttribute('href')).toBe('/sources');
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toBeTruthy();
    const backup = within(sheet).getByRole('list', { name: 'Backup' });
    // What the source holds; its favourites and history are in Library above.
    const links = within(backup).getAllByRole('link').map((l) => l.textContent);
    expect(links).toEqual(['Live TV', 'Radio', 'Movies', 'Series']);
    fireEvent.click(within(sheet).getByRole('link', { name: 'My List' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/my-list'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull());
  });
});

describe('phone tab bar with no sources', () => {
  it('Live TV leads to the Sources page and stays the current tab there', async () => {
    media(...PHONE);
    handlers([]);
    const { router } = renderRoutes(routes(), '/favorites');
    const bar = await screen.findByTestId('tab-bar');
    const live = within(bar).getByRole('link', { name: 'Live TV' });
    await waitFor(() => expect(live.getAttribute('href')).toBe('/sources?for=live'));
    fireEvent.click(live);
    await waitFor(() => expect(router.state.location.pathname).toBe('/sources'));
    expect(live.getAttribute('aria-current')).toBe('page');
    expect(within(bar).getByRole('button', { name: 'More' }).getAttribute('aria-current')).toBeNull();
    // Nor does the sheet's Manage sources row say it is current, as it is not drawn so.
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    const manage = within(sheet).getByRole('link', { name: 'Manage sources' });
    expect(manage.getAttribute('aria-current')).toBeNull();
    expect(manage.className).not.toContain('bg-selected');
  });
});

describe('phone More sheet with one source', () => {
  it("is one row to the Sources page, its Radio, Movies and Series Watch tiles, and no chips", async () => {
    media(...PHONE);
    handlers([makeSource('s1', { name: 'Night Portal', radioCount: 4 })]);
    const { router } = renderRoutes(routes(), '/s/s1/series');
    const bar = await screen.findByTestId('tab-bar');
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    const watch = within(sheet).getByRole('region', { name: 'Watch' });
    await waitFor(() => expect(within(watch).getAllByRole('link').map((l) => l.textContent)).toEqual(['Radio', 'Movies', 'Series', 'Sports', 'Multi-view']));
    expect(within(watch).getByRole('link', { name: 'Radio' }).getAttribute('href')).toBe('/s/s1/radio');
    expect(within(watch).getByRole('link', { name: 'Series' }).getAttribute('aria-current')).toBe('page');
    // The source's row stands for Manage sources; a card of chips would repeat the tiles and the Live TV tab.
    const row = within(sheet).getByRole('link', { name: 'Night Portal, Manage sources' });
    expect(row.getAttribute('href')).toBe('/sources');
    expect(within(sheet).queryByRole('list', { name: 'Night Portal' })).toBeNull();
    expect(within(sheet).getAllByRole('link', { name: /Manage sources/ })).toEqual([row]);
    fireEvent.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe('/sources'));
  });

  it("says the Movies tile is current on a movie's detail page, as it draws it", async () => {
    media(...PHONE);
    handlers([makeSource('s1', { name: 'Night Portal' })]);
    renderRoutes(routes(), '/s/s1/movie/9');
    const bar = await screen.findByTestId('tab-bar');
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    const watch = within(sheet).getByRole('region', { name: 'Watch' });
    const movies = await within(watch).findByRole('link', { name: 'Movies' });
    expect(movies.getAttribute('href')).toBe('/s/s1/movies');
    // The path is not under /s/s1/movies: only the section's own rule makes the tile current.
    expect(movies.className).toContain('bg-selected');
    expect(movies.getAttribute('aria-current')).toBe('page');
    expect(within(watch).getByRole('link', { name: 'Series' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('the Sources page a Watch row led to, once a source exists', () => {
  // `for` outlives the first add (the Sources page keeps it when its dialog closes), but once there
  // is a source the page is the sources' own again: one current row, never two.
  const currentLinks = (el: HTMLElement) => within(el).queryAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');

  it("marks only the lone source's row in the rail", async () => {
    handlers([makeSource('s1', { name: 'Night Portal' })]);
    renderRoutes(routes(), '/sources?for=live');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const row = await within(nav).findByRole('link', { name: /^Night Portal/ });
    expect(currentLinks(nav)).toEqual([row]);
  });

  it('marks Manage sources, not Movies, with two sources', async () => {
    renderRoutes(routes(), '/sources?for=movies');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await within(nav).findByText('Backup');
    expect(currentLinks(nav)).toEqual([within(nav).getByRole('link', { name: 'Manage sources' })]);
  });

  it("marks only the lone source's row on a phone, under More", async () => {
    media(...PHONE);
    handlers([makeSource('s1', { name: 'Night Portal' })]);
    renderRoutes(routes(), '/sources?for=live');
    const bar = await screen.findByTestId('tab-bar');
    await waitFor(() => expect(within(bar).getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/s1/live'));
    expect(currentLinks(bar)).toEqual([]);
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-current')).toBe('true');
    fireEvent.click(more);
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    expect(currentLinks(sheet)).toEqual([within(sheet).getByRole('link', { name: 'Night Portal, Manage sources' })]);
  });

  it('marks Manage sources in the sheet, not the Movies tile, with two sources', async () => {
    media(...PHONE);
    renderRoutes(routes(), '/sources?for=movies');
    const bar = await screen.findByTestId('tab-bar');
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    await within(sheet).findByRole('list', { name: 'Backup' });
    expect(currentLinks(sheet)).toEqual([within(sheet).getByRole('link', { name: 'Manage sources' })]);
    expect(within(within(sheet).getByRole('region', { name: 'Watch' })).getByRole('link', { name: 'Movies' }).className).not.toContain('bg-selected');
  });
});

describe('palette and shortcut reference polish', () => {
  it('opens on recent channels, titles to resume and suggestions; sources and settings wait for a query', async () => {
    rpcMock.handlers['recent.list'] = (): RecentEntry[] => [
      { ref: { sourceId: 's1', contentType: 'live', itemId: '1' }, viewedAt: '2026-10-11T08:00:00Z', snapshot: { title: 'Harbor News', contentType: 'live' } },
    ];
    rpcMock.handlers['positions.continueWatching'] = (): PlaybackPosition[] => [
      { ref: { sourceId: 's1', contentType: 'movie', itemId: '9' }, positionSeconds: 10, durationSeconds: 100, updatedAt: '2026-10-11T08:00:00Z', watched: false, snapshot: { title: 'Long Signal', contentType: 'movie' } },
    ];
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const headings = () => [...palette.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
    await waitFor(() => expect(headings()).toEqual(['Recent channels', 'Continue watching', 'Suggested', 'Go to']));
    expect(within(palette).getByText('Harbor News')).toBeTruthy();
    expect(within(palette).getByText('Switch to light theme')).toBeTruthy();
    expect(within(palette).queryByText('Settings: Recording')).toBeNull();
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'recording' } });
    expect(await within(palette).findByText('Settings: Recording')).toBeTruthy();
    expect(within(palette).queryByText('Recent channels')).toBeNull();
  });

  it('labels the shortcut groups in the quiet heading style, not the accent', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setHelpOpen(true));
    const overlay = await screen.findByTestId('shortcut-overlay');
    const heading = within(overlay).getByRole('heading', { name: 'Everywhere' });
    expect(heading.className).toContain('text-fg-subtle');
    expect(heading.className).not.toContain('text-accent');
  });
});

describe('plain HTTP notice (SR-4)', () => {
  it('says once which features the browser turned off, with the HTTPS docs a click away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const was = window.isSecureContext;
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    try {
      renderRoutes(routes(), '/favorites');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SECURE_NOTICE_DELAY_MS + 50);
      });
      const notice = useToastStore.getState().toasts.find((t) => t.id === 'insecure-context');
      expect(notice?.title).toBe('Some features need HTTPS');
      expect(String(notice?.description)).toContain('ClearKey');
      expect(notice?.action?.label).toBe('How to set up HTTPS');
      expect(localStorage.getItem('tsrust.insecureNoticeShown')).toBe('1');

      cleanup();
      useToastStore.setState({ toasts: [] });
      renderRoutes(routes(), '/favorites');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SECURE_NOTICE_DELAY_MS + 50);
      });
      expect(useToastStore.getState().toasts.find((t) => t.id === 'insecure-context')).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: was });
    }
  });
});

describe('a page that could not load behind the offline strip (SH-offline-stack)', () => {
  function Boom(): never {
    throw new Error('Failed to fetch dynamically imported module: /assets/stats.js');
  }

  it('waits quietly: no second error title or Try again under the strip, and no error in the header', async () => {
    const { RouteErrorPage, resetChunkFailureForTests } = await import('@/routes');
    const { useConnectionStore } = await import('../connection');
    act(() => useConnectionStore.setState({ offline: true }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteErrorPage /> }])} />);
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Waiting for the server');
      expect(screen.getByText('This page opens as soon as the server answers.')).toBeTruthy();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(useShellStore.getState().header?.title).toBe('');
      // Back online but not reloaded yet (or the strip went for another reason): the full error and its Try again.
      act(() => useConnectionStore.setState({ offline: false }));
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(useShellStore.getState().header?.title).toBe("Couldn't reach the server");
    } finally {
      spy.mockRestore();
      act(() => useConnectionStore.setState({ offline: false, backOnline: false }));
      resetChunkFailureForTests();
    }
  });
});
