/**
 * The shell redesign (stage 1 of the SaaS polish): the grouped rail with its one-row footer and
 * zero-sources state (SH-rail-ia, SH-welcome-generic), the phone tab bar and its More sheet
 * (CB-PHONE-NAV), the palette's empty view and the quieter shortcut reference, and the one-time
 * notice for a server reached over plain HTTP (SR-4).
 */

import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        { path: 'dashboard', element: <Page>home page</Page> },
        { path: 'favorites', element: <Page>favorites page</Page> },
        { path: 'my-list', element: <Page>my list page</Page> },
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
    expect(within(group('Watch')).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Search', 'TV guide', 'Multi-view']);
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

  it('opens the only source, so its Live TV, Movies and Series are one click away', async () => {
    handlers([makeSource('s1', { name: 'Only One' })]);
    renderRoutes(routes(), '/favorites');
    const entry = await screen.findByRole('button', { name: /Only One/ });
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/s1/live');
  });

  it('with no sources: Library steps back and one dashed Add source row stands in, except where onboarding shows', async () => {
    handlers([]);
    const { router } = renderRoutes(routes(), '/favorites');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const add = await within(nav).findByTestId('rail-add-source');
    expect(add.getAttribute('href')).toBe('/sources?add=1');
    expect(add.className).toContain('border-dashed');
    expect(within(nav).getByRole('link', { name: 'My List' }).className).toContain('text-fg-subtle');
    // No "+" beside the Sources label: the row is the one way in.
    expect(within(within(nav).getByRole('group', { name: 'Sources' })).queryByRole('link', { name: 'Add source' })).toBe(add);
    await act(() => router.navigate('/dashboard'));
    expect(within(nav).queryByTestId('rail-add-source')).toBeNull();
  });
});

describe('rail at laptop heights (stage 2)', () => {
  it('Library folds away from its label, stays folded next launch, and opens again for one of its pages', async () => {
    renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const library = within(nav).getByRole('group', { name: 'Library' });
    const toggle = within(library).getByRole('button', { name: 'Library' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(library).queryByRole('link', { name: 'My List' })).toBeNull();
    // The group keeps its name; the Watch links and the sources are untouched.
    expect(within(nav).getByRole('link', { name: 'TV guide' })).toBeTruthy();
    cleanup();

    renderRoutes(routes(), '/dashboard');
    const again = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(again).getByRole('button', { name: 'Library' }).getAttribute('aria-expanded')).toBe('false');
    cleanup();

    // A Library page opens it (from a card or the palette), so the current page is never a hidden link.
    const { router } = renderRoutes(routes(), '/dashboard');
    const nav2 = await screen.findByRole('navigation', { name: 'Main navigation' });
    const toggle2 = within(nav2).getByRole('button', { name: 'Library' });
    expect(toggle2.getAttribute('aria-expanded')).toBe('false');
    await act(() => router.navigate('/favorites'));
    expect(toggle2.getAttribute('aria-expanded')).toBe('true');
    expect(within(nav2).getByRole('link', { name: 'Favorites' }).getAttribute('aria-current')).toBe('page');
    // Leaving keeps it open: only a press folds it.
    await act(() => router.navigate('/dashboard'));
    expect(toggle2.getAttribute('aria-expanded')).toBe('true');
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
    // The only source opens by itself, until the user closes it.
    cleanup();
    handlers([makeSource('s1', { name: 'Night Portal' })]);
    renderRoutes(routes(), '/dashboard');
    const only = await screen.findByRole('button', { name: /^Night Portal/ });
    expect(only.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(only);
    cleanup();
    renderRoutes(routes(), '/dashboard');
    expect((await screen.findByRole('button', { name: /^Night Portal/ })).getAttribute('aria-expanded')).toBe('false');
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
    // No group toggles in the icon-only rail: every link shows.
    expect(nav.querySelector('[data-rail-group-toggle]')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'My List' })).toBeTruthy();
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
    expect(screen.queryByTestId('open-palette')).toBeNull();
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
    cleanup();
    expect(document.documentElement.style.getPropertyValue('--shell-bottom-inset')).toBe('');
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

  it('follows the source the user opened, and More holds the Library, the sources and Settings', async () => {
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
    expect(within(sheet).getByRole('link', { name: 'My List' })).toBeTruthy();
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
