import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FavoriteEntry, PlaybackPosition, RecentEntry, VodItem } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from './harness';

/** Matches toast text in the visible stack, not its copy in the screen-reader live region. */
const VISIBLE_TOAST = { ignore: 'script, style, [data-toast-live] *' };

const events = vi.hoisted(() => ({ handlers: new Map<string, (p: unknown) => void>() }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, h: (p: unknown) => void) => {
    events.handlers.set(type, h);
    return () => events.handlers.delete(type);
  },
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));
vi.mock('@/features/player', () => ({
  playItem: (...a: unknown[]) => (playerMock.playItem as (...x: unknown[]) => Promise<void>)(...a),
  restorePlayback: async () => false,
  PlayerDock: () => <div data-testid="player-dock" />,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../ShellLayout');
const { shellRoutes } = await import('../routes');
const { useShell, useShellStore } = await import('../store');
const { sharedRailError } = await import('../dashboard/DashboardPage');
const { RpcError } = await import('@/api/transport');
const { useEffect, useState } = await import('react');

/** A page that fills the context panel with two links. */
function PanelPage() {
  const shell = useShell();
  useEffect(() => {
    shell.setContextPanel(
      <div>
        <a href="#one">Panel link one</a>
        <a href="#two">Panel link two</a>
      </div>,
    );
  }, [shell]);
  return <Page>panel page</Page>;
}
const { useThemeStore } = await import('../theme');
const { useToastStore } = await import('@/ui');

function routes(searchPage = <Page>search page</Page>) {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        ...shellRoutes,
        { path: 'favorites', element: <Page>favorites page</Page> },
        { path: 'panel', element: <PanelPage /> },
        { path: 'recent', element: <Page>recent page</Page> },
        { path: 'search', element: searchPage },
        { path: 'sources', element: <Page>sources page</Page> },
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
      ],
    },
  ];
}

const snapshot = (title: string, contentType: 'movie' | 'series' | 'live' = 'movie') => ({ title, contentType, posterUrl: undefined });

function baseHandlers(opts: { sources?: number } = {}) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  const sources = Array.from({ length: opts.sources ?? 2 }, (_, i) => makeSource(`s${i + 1}`, { name: i === 0 ? 'Night Portal' : `Backup ${i}`, position: i }));
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => sources;
  // An empty My List: its rail stays out of the way (mylist tests cover it).
  h['watchlist.list'] = () => [];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = (): PlaybackPosition[] => [
    { ref: { sourceId: 's1', contentType: 'movie', itemId: '10' }, positionSeconds: 1800, durationSeconds: 5400, watched: false, updatedAt: '2026-10-10T20:00:00Z', snapshot: snapshot('The Long Signal') },
  ];
  h['favorites.list'] = (): FavoriteEntry[] => [
    { ref: { sourceId: 's1', contentType: 'live', itemId: '1' }, addedAt: '2026-10-01T00:00:00Z', position: 0, snapshot: snapshot('Harbor News', 'live') },
    { ref: { sourceId: 's1', contentType: 'series', itemId: '7' }, addedAt: '2026-10-01T00:00:00Z', position: 1, snapshot: snapshot('Quiet Coast', 'series') },
  ];
  h['recent.list'] = (): RecentEntry[] => [
    { ref: { sourceId: 's2', contentType: 'live', itemId: '3' }, viewedAt: '2026-10-11T08:00:00Z', snapshot: snapshot('Metro Sport', 'live') },
  ];
  h['catalog.recentlyAdded'] = (a) =>
    (a as { contentType: string }).contentType === 'movie'
      ? ([{ ref: { sourceId: 's1', contentType: 'movie', itemId: '99' }, title: 'Fresh Arrival', added: '2026-10-09T00:00:00Z', categoryId: 'c' }] satisfies VodItem[])
      : [];
  h['epg.nowNext'] = () => ({ 's1|live|1': { now: { channelId: 'x', start: '2026-10-11T08:00:00Z', end: '2026-10-11T09:00:00Z', title: 'Morning Bulletin' } } });
}

beforeAll(installDomStubs);
beforeEach(() => {
  baseHandlers();
  playerMock.playItem.mockClear();
  events.handlers.clear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false });
  useThemeStore.setState({ theme: 'dark' });
  useToastStore.setState({ toasts: [] });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key: k, ...init });

describe('ShellLayout', () => {
  it('renders rail sources, header, outlet, and player dock', async () => {
    renderRoutes(routes(), '/favorites');
    expect(await screen.findByText('favorites page')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(await within(nav).findByText('Night Portal')).toBeTruthy();
    expect(within(nav).getByText('Backup 1')).toBeTruthy();
    expect(screen.getByTestId('player-dock')).toBeTruthy();
  });

  it('startup redirect sends / to the dashboard, or lastRoute when restoring', async () => {
    const first = renderRoutes(routes(), '/');
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/dashboard'));
    cleanup();

    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/recent' });
    const second = renderRoutes(routes(), '/');
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/recent'));
  });

  it('mod+k opens the palette and running a command navigates', async () => {
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('k', { ctrlKey: true });
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByPlaceholderText('Type a command or search');
    fireEvent.change(input, { target: { value: 'recently watched' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/recent'));
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('mod+f focuses the search field even when the search page mounts late (lazy chunk)', async () => {
    function LateSearchPage() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const id = setTimeout(() => setReady(true), 300);
        return () => clearTimeout(id);
      }, []);
      return ready ? <input data-page-search="" aria-label="late search" /> : <Page>loading search</Page>;
    }
    const { router } = renderRoutes(routes(<LateSearchPage />), '/favorites');
    await screen.findByText('favorites page');
    key('f', { ctrlKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    const field = await screen.findByLabelText('late search');
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('mod+k toggles the palette closed from inside its input, and Escape still closes it', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('k', { ctrlKey: true });
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByPlaceholderText('Type a command or search');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    expect(useShellStore.getState().paletteOpen).toBe(false);

    key('k', { ctrlKey: true });
    const again = await screen.findByTestId('command-palette');
    fireEvent.keyDown(within(again).getByPlaceholderText('Type a command or search'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
  });

  it('shell landmarks are unique and the header title is not a heading', async () => {
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(1);
    const title = screen.getByTestId('page-title');
    expect(title.tagName).toBe('P');
    expect(title.textContent).toBe('Home');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe('Home');
    await waitFor(() => expect(document.title).toBe('Home · Tsrust IPTV'));

    // A dialog's title row and footer add no banner/contentinfo landmarks.
    act(() => useShellStore.getState().setPaletteOpen(true));
    await screen.findByTestId('command-palette');
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.queryAllByRole('contentinfo')).toHaveLength(0);
  });

  it('palette offers a search fallback for free text', async () => {
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByPlaceholderText('Type a command or search');
    fireEvent.change(input, { target: { value: 'zzqx nothing' } });
    fireEvent.click(await within(palette).findByText('Search for "zzqx nothing"'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('?q=zzqx%20nothing');
  });

  it('? opens the shortcut overlay grouped by area, and escape closes it', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('?', { shiftKey: true });
    const overlay = await screen.findByTestId('shortcut-overlay');
    expect(within(overlay).getByText('Everywhere')).toBeTruthy();
    expect(within(overlay).getByText('Playback')).toBeTruthy();
    expect(overlay.querySelector('[data-combo="mod+k"]')).toBeTruthy();
    fireEvent.change(within(overlay).getByRole('searchbox', { name: 'Filter shortcuts' }), { target: { value: 'volume' } });
    expect(within(overlay).getByText('Volume up')).toBeTruthy();
    expect(within(overlay).queryByText('Open the command palette')).toBeNull();
    // First Escape clears the filter, the second closes the overlay.
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    expect(within(overlay).getByText('Open the command palette')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('shortcut-overlay')).toBeNull());
  });

  it('theme toggle flips data-theme and persists through settings.update', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
    fireEvent.click(screen.getByTestId('theme-toggle'));
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'));
    await waitFor(() =>
      expect(rpcMock.calls.some((c) => c.cmd === 'settings.update' && (c.args as { patch: { theme?: string } }).patch.theme === 'light')).toBe(true),
    );
  });

  it('deeplink.open navigates to the add-source flow', async () => {
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    await waitFor(() => expect(events.handlers.has('deeplink.open')).toBe(true));
    act(() => events.handlers.get('deeplink.open')!({ urls: ['iptv://add?url=http%3A%2F%2Fexample.test%2Flist.m3u'] }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sources'));
    expect(new URLSearchParams(router.state.location.search).get('add')).toBe('http://example.test/list.m3u');
  });

  it('import.progress shows one updating toast per source', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('Night Portal');
    await waitFor(() => expect(events.handlers.has('import.progress')).toBe(true));
    const emit = events.handlers.get('import.progress')!;
    act(() => emit({ sourceId: 's1', phase: 'parsing', done: 50, total: 200 }));
    expect(await screen.findByText('Importing Night Portal')).toBeTruthy();
    expect(screen.getByText('Reading the playlist: 50 of 200')).toBeTruthy();
    act(() => emit({ sourceId: 's1', phase: 'done', done: 200 }));
    expect(await screen.findByText('Night Portal is ready')).toBeTruthy();
    expect(screen.queryByText('Importing Night Portal')).toBeNull();
  });

  it('import.progress does not toast progress or done on the Sources page (no duplicate of its own toast)', async () => {
    useToastStore.setState({ toasts: [] });
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('Night Portal');
    await waitFor(() => expect(events.handlers.has('import.progress')).toBe(true));
    // Started elsewhere: the shell shows progress.
    act(() => events.handlers.get('import.progress')!({ sourceId: 's1', phase: 'parsing', done: 50, total: 200 }));
    expect(await screen.findByText('Importing Night Portal')).toBeTruthy();

    // On Sources the page owns progress and success: the stale toast goes, done adds nothing.
    await act(() => router.navigate('/sources'));
    await screen.findByText('sources page');
    act(() => events.handlers.get('import.progress')!({ sourceId: 's1', phase: 'saving', done: 150, total: 200 }));
    await waitFor(() => expect(screen.queryByText('Importing Night Portal')).toBeNull());
    act(() => events.handlers.get('import.progress')!({ sourceId: 's1', phase: 'done', done: 200 }));
    expect(screen.queryByText('Night Portal is ready')).toBeNull();
    expect(useToastStore.getState().toasts.some((t) => t.id === 'import-s1')).toBe(false);

    // Errors still surface on Sources, without the redundant "open Sources" action.
    act(() => events.handlers.get('import.progress')!({ sourceId: 's2', phase: 'error', done: 0, message: 'HTTP 503' }));
    const err = useToastStore.getState().toasts.find((t) => t.id === 'import-s2');
    expect(err?.variant).toBe('error');
    expect(err?.action).toBeUndefined();

    // Back elsewhere (background refresh), done toasts again.
    await act(() => router.navigate('/favorites'));
    await screen.findByText('favorites page');
    act(() => events.handlers.get('import.progress')!({ sourceId: 's1', phase: 'done', done: 200 }));
    expect(await screen.findByText('Night Portal is ready')).toBeTruthy();
  });

  it('import errors toast a translated summary, and stay quiet while the Add Source dialog shows them', async () => {
    useToastStore.setState({ toasts: [] });
    renderRoutes(routes(), '/favorites');
    await screen.findByText('Night Portal');
    await waitFor(() => expect(events.handlers.has('import.progress')).toBe(true));
    const emit = events.handlers.get('import.progress')!;

    act(() => emit({ sourceId: 's1', phase: 'error', done: 0, message: 'error sending request for url (http://127.0.0.1:7399/x.m3u)' }));
    const err = useToastStore.getState().toasts.find((t) => t.id === 'import-s1');
    expect(err?.title).toBe("Night Portal didn't import");
    expect(err?.description).toBe("Couldn't reach the server. Check the source URL and sign-in details, then refresh it.");
    expect(String(err?.description)).not.toContain('error sending request');

    // Unknown (just-created) source: the generic name, never a blank one.
    act(() => emit({ sourceId: 'new-one', phase: 'error', done: 0, message: 'boom' }));
    expect(useToastStore.getState().toasts.find((t) => t.id === 'import-new-one')?.title).toBe("This source didn't import");

    // The open Add Source dialog claims the source it created: no second error surface.
    const { claimImportErrors } = await import('@/features/sources/lib/errors');
    const release = claimImportErrors((id) => id === 'claimed');
    act(() => emit({ sourceId: 'claimed', phase: 'error', done: 0, message: 'HTTP 404 not found' }));
    expect(useToastStore.getState().toasts.some((t) => t.id === 'import-claimed')).toBe(false);
    release();
    act(() => emit({ sourceId: 'claimed', phase: 'error', done: 0, message: 'HTTP 404 not found' }));
    expect(useToastStore.getState().toasts.find((t) => t.id === 'import-claimed')?.description).toMatch(/^The server has no playlist at that address\./);
  });
});

describe('ContextPanel drawer (below 1440 px)', () => {
  it('is a modal dialog that traps focus, and the toggle exposes aria-expanded', async () => {
    renderRoutes(routes(), '/panel');
    await screen.findByText('panel page');
    const toggle = await screen.findByTestId('panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-haspopup')).toBe('dialog');
    expect(toggle.hasAttribute('aria-pressed')).toBe(false);
    toggle.focus();
    fireEvent.click(toggle);

    const drawer = await screen.findByRole('dialog', { name: 'Details' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.getAttribute('data-testid')).toBe('context-panel');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(drawer).getByText('Panel link one'));

    // Tab past the last link wraps inside the drawer instead of reaching the page behind the scrim.
    const last = within(drawer).getByText('Panel link two');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(drawer.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Details' })).toBeNull());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });
});

describe('sharedRailError', () => {
  const down = new RpcError('network', 'server unreachable');
  it('collapses two or more identical failures', () => {
    expect(sharedRailError([down, new RpcError('network', 'server unreachable'), { code: 'network', message: 'server unreachable' }])).toBe(down);
  });
  it('keeps per-rail errors when any rail succeeded, is loading, or failed differently', () => {
    expect(sharedRailError([down])).toBeUndefined();
    expect(sharedRailError([down, null])).toBeUndefined();
    expect(sharedRailError([null, down])).toBeUndefined();
    expect(sharedRailError([down, new RpcError('network', 'other')])).toBeUndefined();
    expect(sharedRailError([down, new RpcError('timeout', 'server unreachable')])).toBeUndefined();
    expect(sharedRailError([])).toBeUndefined();
  });
});

describe('DashboardPage', () => {
  it('renders the hero and every rail with mocked data', async () => {
    renderRoutes(routes(), '/dashboard');
    const hero = await screen.findByTestId('dashboard-hero');
    expect(within(hero).getByText('The Long Signal')).toBeTruthy();
    expect(within(hero).getByText('60 minutes left')).toBeTruthy();
    expect(await screen.findByTestId('dashboard-rail-continue-watching')).toBeTruthy();
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    expect(within(live).getByText('Harbor News')).toBeTruthy();
    expect(await within(live).findByText('Morning Bulletin')).toBeTruthy();
    expect(within(await screen.findByTestId('dashboard-rail-recent-live')).getByText('Metro Sport')).toBeTruthy();
    expect(within(await screen.findByTestId('dashboard-rail-favorite-vod')).getByText('Quiet Coast')).toBeTruthy();
    expect(within(await screen.findByTestId('dashboard-rail-recently-added')).getByText('Fresh Arrival')).toBeTruthy();
    const srcRail = await screen.findByTestId('dashboard-rail-recent-sources');
    // s2 was used most recently, so it ranks first.
    expect(within(srcRail).getAllByRole('link')[1]!.textContent).toContain('Backup 1');
    expect(screen.getByTestId('page-title').textContent).toBe('Home');
  });

  it('hero resume calls playItem with the source kind', async () => {
    renderRoutes(routes(), '/dashboard');
    const hero = await screen.findByTestId('dashboard-hero');
    fireEvent.click(within(hero).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledTimes(1));
    expect(playerMock.playItem).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { sourceId: 's1', contentType: 'movie', itemId: '10' }, isLive: false, sourceKind: 'xtream', title: 'The Long Signal' }),
    );
  });

  it('respects settings.dashboardRails', async () => {
    rpcMock.handlers['settings.get'] = () =>
      settings({ dashboardRails: { ...settings().dashboardRails, hero: false, liveFavorites: false } });
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-rail-continue-watching');
    expect(screen.queryByTestId('dashboard-hero')).toBeNull();
    expect(screen.queryByTestId('dashboard-rail-live-favorites')).toBeNull();
  });

  it('shows a welcome state with no sources', async () => {
    baseHandlers({ sources: 0 });
    renderRoutes(routes(), '/dashboard');
    const welcome = await screen.findByTestId('dashboard-welcome');
    expect(within(welcome).getByRole('link', { name: 'Add your first source' }).getAttribute('href')).toBe('/sources?add=1');
  });

  it('shows a rail error with retry', async () => {
    let fail = true;
    rpcMock.handlers['favorites.list'] = () => {
      if (fail) throw { code: 'network', message: 'down' };
      return [];
    };
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-live-favorites');
    expect(await within(rail).findByText("Couldn't reach the server")).toBeTruthy();
    expect(within(rail).getByText(/stored on this computer/)).toBeTruthy();
    fail = false;
    fireEvent.click(within(rail).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByTestId('dashboard-rail-live-favorites')).toBeNull());
  });

  it('collapses identical failures of every rail into one dashboard error with one retry', async () => {
    let fail = true;
    const failing = (ok: (args: unknown) => unknown) => (args: unknown) => {
      if (fail) throw { code: 'network', message: 'down' };
      return ok(args);
    };
    const h = rpcMock.handlers;
    h['positions.continueWatching'] = failing(h['positions.continueWatching']!);
    h['favorites.list'] = failing(h['favorites.list']!);
    h['recent.list'] = failing(h['recent.list']!);
    h['catalog.recentlyAdded'] = failing(() => []);
    renderRoutes(routes(), '/dashboard');

    const banner = await screen.findByTestId('dashboard-error');
    // Local-data copy, not the provider-network hint.
    expect(within(banner).getByRole('heading', { name: "Couldn't load your dashboard" })).toBeTruthy();
    expect(within(banner).getByText(/stored on this computer/)).toBeTruthy();
    expect(within(banner).queryByText(/provider URL/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    // Failed rails collapse; the card sits in the normal flow (never over live content) and
    // shares a grid cell with an invisible hero skeleton, so it is at least the hero's height.
    for (const id of ['continue-watching', 'live-favorites', 'recent-live', 'favorite-vod', 'recently-added']) {
      expect(screen.queryByTestId(`dashboard-rail-${id}`)).toBeNull();
    }
    expect(banner.className).not.toMatch(/absolute/);
    const slot = screen.getByTestId('dashboard-error-slot');
    expect(slot.className).toContain('grid');
    const spacer = slot.querySelector('[data-hero-spacer]')!;
    expect(spacer.className).toContain('invisible');
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(banner.className).toContain('col-start-1');
    expect(spacer.className).toContain('col-start-1');
    // Not "nothing to watch yet": the dashboard failed, it is not empty.
    expect(screen.queryByText('Nothing to show yet')).toBeNull();
    // Sources still loaded, so their rail stays.
    expect(screen.getByTestId('dashboard-rail-recent-sources')).toBeTruthy();

    fail = false;
    fireEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('dashboard-rail-live-favorites')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-error')).toBeNull();
    expect(await screen.findByTestId('dashboard-hero')).toBeTruthy();
  });

  it('keeps per-rail errors when rails fail differently', async () => {
    rpcMock.handlers['favorites.list'] = () => {
      throw { code: 'network', message: 'down' };
    };
    rpcMock.handlers['recent.list'] = () => {
      throw { code: 'internal', message: 'database is locked' };
    };
    renderRoutes(routes(), '/dashboard');
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    expect(await within(live).findByText("Couldn't reach the server")).toBeTruthy();
    expect(screen.queryByTestId('dashboard-error')).toBeNull();
  });

  it('arrow keys move between cards and rails', async () => {
    renderRoutes(routes(), '/dashboard');
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    const first = await within(live).findByRole('button', { name: 'Play Harbor News' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const recentRail = screen.getByTestId('dashboard-rail-recent-live');
    expect(recentRail.contains(document.activeElement)).toBe(true);
  });
});

describe('keyboard reach (theme, toasts, outlet)', () => {
  it('mod+shift+l flips the theme and persists it', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('L', { code: 'KeyL', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'));
    expect(useThemeStore.getState().theme).toBe('light');
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'settings.update' && JSON.stringify(c.args).includes('"theme":"light"'))).toBe(true));
    key('L', { code: 'KeyL', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(useThemeStore.getState().theme).toBe('dark'));
  });

  it('F8 jumps into the toast stack, Escape dismisses and returns focus', async () => {
    const { toast } = await import('@/ui');
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const origin = screen.getByTestId('open-palette');
    origin.focus();
    act(() => {
      toast({ id: 'a', title: 'First', duration: 0 });
      toast({ id: 'b', title: 'Second', duration: 0, action: { label: 'Open', onClick: () => {} } });
    });
    const second = await screen.findByText('Second', VISIBLE_TOAST);
    key('F8');
    expect(document.activeElement?.textContent).toBe('Open');

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement?.closest('[data-toast-id]')?.getAttribute('data-toast-id')).toBe('a');

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('First', VISIBLE_TOAST)).toBeNull());
    // Focus moved to the surviving toast, not <body>.
    expect(document.activeElement?.closest('[data-toast-id]')?.getAttribute('data-toast-id')).toBe('b');
    expect(second.isConnected).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Second', VISIBLE_TOAST)).toBeNull());
    expect(document.activeElement).toBe(origin);
  });

  it('F8 does nothing harmful with no toasts', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const before = document.activeElement;
    key('F8');
    expect(document.activeElement).toBe(before);
  });

  it('keeps focus off <body> when a focused toast is dismissed from code', async () => {
    const { toast, dismissToast } = await import('@/ui');
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => void toast({ id: 'solo', title: 'Solo', duration: 0 }));
    await screen.findByText('Solo', VISIBLE_TOAST);
    key('F8');
    expect(document.activeElement?.closest('[data-toast-id]')).toBeTruthy();
    act(() => dismissToast('solo'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('gives the outlet a bounded flex column for virtualized pages', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const main = document.getElementById('main')!;
    for (const c of ['flex', 'flex-col', 'flex-1', 'min-h-0', 'overflow-y-auto']) expect(main.classList).toContain(c);
    for (const c of ['flex', 'min-h-0', 'flex-1']) expect(main.parentElement!.classList).toContain(c);
    const column = main.parentElement!.parentElement!;
    for (const c of ['flex-col', 'min-h-0', 'h-full']) expect(column.classList).toContain(c);
    expect(screen.getByTestId('shell').classList).toContain('h-dvh');
  });

  it('lists the theme and notification shortcuts in the overlay', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setHelpOpen(true));
    const overlay = await screen.findByTestId('shortcut-overlay');
    expect(overlay.querySelector('[data-combo="mod+shift+l"]')).toBeTruthy();
    expect(overlay.querySelector('[data-combo="f8"]')).toBeTruthy();
    expect(within(overlay).getByRole('region', { name: 'Shortcut list' }).tabIndex).toBe(0);
  });
});

describe('polish pass (B7)', () => {
  it('rail shows a retry when sources fail, and retrying recovers the list', async () => {
    let fail = true;
    const ok = rpcMock.handlers['sources.list']!;
    rpcMock.handlers['sources.list'] = (a) => {
      if (fail) throw new Error('boom');
      return ok(a);
    };
    renderRoutes(routes(), '/favorites');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const box = await within(nav).findByTestId('rail-sources-error');
    expect(within(box).getByText("Sources didn't load")).toBeTruthy();
    fail = false;
    fireEvent.click(within(box).getByRole('button', { name: 'Try again' }));
    expect(await within(nav).findByText('Night Portal')).toBeTruthy();
    expect(within(nav).queryByTestId('rail-sources-error')).toBeNull();
  });

  it('palette matches titles and keywords, not internal ids', async () => {
    const { paletteFilter } = await import('../CommandPalette');
    const sep = '\u001f';
    expect(paletteFilter(`Favorites${sep}nav.favorites`, 'nav')).toBe(0);
    expect(paletteFilter(`Favorites${sep}nav.favorites`, 'fav')).toBeGreaterThan(0);
    expect(paletteFilter(`Home${sep}nav.dashboard`, 'home')).toBeGreaterThan(0);
    expect(paletteFilter(`Add source${sep}nav.addSource`, 'm3u', ['playlist', 'm3u'])).toBeGreaterThan(0);
  });

  it('palette shows the empty state with a search fallback for unmatched text', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'navx' } });
    expect(await within(palette).findByText('Search for "navx"')).toBeTruthy();
    expect(within(palette).queryByText('Favorites')).toBeNull();
  });

  it('palette reaches every settings section and the Scheduled page', async () => {
    const { SETTINGS_SECTIONS } = await import('../CommandPalette');
    const { SECTION_IDS } = await import('@/features/settings/sections/types');
    expect([...SETTINGS_SECTIONS]).toEqual([...SECTION_IDS]);
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByPlaceholderText('Type a command or search');
    fireEvent.change(input, { target: { value: 'recording' } });
    expect(await within(palette).findByText('Settings: Recording')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'scheduled' } });
    expect(await within(palette).findByText('Scheduled')).toBeTruthy();
  });

  it('overlay lists captions and channel zap, with labelled sections', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setHelpOpen(true));
    const overlay = await screen.findByTestId('shortcut-overlay');
    for (const combo of ['c', 'pageup', 'pagedown', 'mod+b', 'digit', '/']) expect(overlay.querySelector(`[data-combo="${combo}"]`), combo).toBeTruthy();
    expect(within(overlay).getByText('Back 10 seconds')).toBeTruthy();
    expect(within(overlay).getByText('Exit picture in picture')).toBeTruthy();
    expect(within(overlay).getByText('Search channels')).toBeTruthy();
    expect(within(overlay).getAllByText('In the search box: move to the list')).toHaveLength(2);
    for (const section of overlay.querySelectorAll('section')) {
      const ids = section.getAttribute('aria-labelledby')!.split(/\s+/);
      expect(ids).toHaveLength(1);
      expect(document.getElementById(ids[0]!)?.textContent).toBeTruthy();
    }
    expect(within(overlay).getByRole('region', { name: 'Live TV' })).toBeTruthy();
  });
});

describe('startup without layout jumps (B7)', () => {
  it('the pending startup frame uses the dashboard hero skeleton geometry', async () => {
    rpcMock.handlers['settings.get'] = () => new Promise(() => {});
    renderRoutes([{ path: '/', element: <StartupOnly /> }], '/');
    const pending = await screen.findByTestId('startup-pending');
    expect(pending.querySelector('[data-testid="hero-skeleton"]')).toBeTruthy();
    expect(pending.className).toContain('gap-10');
    expect(pending.className).toContain('pt-8');
  });
});

function StartupOnly() {
  const { StartupRedirect } = startupModule;
  return <StartupRedirect />;
}
const startupModule = await import('../StartupRedirect');

describe('B7 shell fixes', () => {
  it('digit zap accepts Shift so AZERTY number rows work', async () => {
    const { matches, parseCombo } = await import('../shortcuts');
    const p = parseCombo('digit');
    expect(matches(p, new KeyboardEvent('keydown', { key: '7', code: 'Digit7', shiftKey: true }))).toBe(true);
    // Shift+7 on QWERTY is "&": still not a digit.
    expect(matches(p, new KeyboardEvent('keydown', { key: '&', code: 'Digit7', shiftKey: true }))).toBe(false);
    expect(matches(p, new KeyboardEvent('keydown', { key: '7', ctrlKey: true }))).toBe(false);
  });

  it('an older theme reply arriving last does not undo the newer choice', async () => {
    const { persistTheme } = await import('../theme');
    const { queryClient, rpcKey } = await import('@/api/query');
    queryClient.setQueryData(rpcKey('settings.get'), settings({ theme: 'dark' }));
    const pending: { theme: string; resolve: (s: unknown) => void }[] = [];
    rpcMock.handlers['settings.update'] = (a) =>
      new Promise((resolve) => pending.push({ theme: (a as { patch: { theme: string } }).patch.theme, resolve }));
    const first = persistTheme('light');
    const second = persistTheme('dark');
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.resolve(settings({ theme: 'dark' }));
    await second;
    pending[0]!.resolve(settings({ theme: 'light' }));
    await first;
    expect(queryClient.getQueryData<{ theme: string }>(rpcKey('settings.get'))?.theme).toBe('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('the quiet dashboard state waits for every visible rail', async () => {
    const h = rpcMock.handlers;
    h['positions.continueWatching'] = () => [];
    h['favorites.list'] = () => [];
    h['recent.list'] = () => [];
    h['catalog.recentlyAdded'] = () => new Promise(() => {});
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-rail-recent-sources');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText('Nothing to show yet')).toBeNull();
    cleanup();
    h['catalog.recentlyAdded'] = () => [];
    renderRoutes(routes(), '/dashboard');
    expect(await screen.findByText('Nothing to show yet')).toBeTruthy();
  });

  it('rails the user switched off do not count as content', async () => {
    const h = rpcMock.handlers;
    h['settings.get'] = () => settings({ dashboardRails: { ...settings().dashboardRails, hero: false, continueWatching: false } });
    h['favorites.list'] = () => [];
    h['recent.list'] = () => [];
    h['catalog.recentlyAdded'] = () => [];
    renderRoutes(routes(), '/dashboard');
    expect(await screen.findByText('Nothing to show yet')).toBeTruthy();
  });

  it('poster cards are named once by their caption', async () => {
    rpcMock.handlers['catalog.recentlyAdded'] = (a) =>
      (a as { contentType: string }).contentType === 'movie'
        ? ([{ ref: { sourceId: 's1', contentType: 'movie', itemId: '99' }, title: 'Fresh Arrival', posterUrl: 'http://x.test/p.jpg', added: '2026-10-09T00:00:00Z', categoryId: 'c' }] satisfies VodItem[])
        : [];
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recently-added');
    const link = await within(rail).findByRole('link', { name: /Fresh Arrival/ });
    expect(link.querySelector('img')!.getAttribute('alt')).toBe('');
    expect(within(rail).queryByRole('img', { name: 'Fresh Arrival' })).toBeNull();
  });

  it('rail source errors are spoken, and ids with spaces stay valid IDREFs', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('my source', { name: 'Broken One', lastError: 'boom' } as never)];
    renderRoutes(routes(), '/favorites');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const btn = await within(nav).findByRole('button', { name: /Broken One.*The last refresh failed/ });
    expect(nav.querySelector('span[aria-label]')).toBeNull();
    const controls = btn.getAttribute('aria-controls')!;
    expect(controls).not.toMatch(/\s/);
    if (btn.getAttribute('aria-expanded') !== 'true') fireEvent.click(btn);
    expect(document.getElementById(controls)).toBeTruthy();
    cleanup();
    act(() => useShellStore.setState({ railCollapsed: true }));
    renderRoutes(routes(), '/favorites');
    const nav2 = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(await within(nav2).findByRole('link', { name: 'Broken One, The last refresh failed' })).toBeTruthy();
  });

  it('saves the last screen at once when the window hides inside the debounce', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'settings.get')).toBe(true));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(rpcMock.calls.some((c) => c.cmd === 'settings.update')).toBe(false);
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(rpcMock.calls.some((c) => c.cmd === 'settings.update' && JSON.stringify(c.args).includes('"lastRoute":"/favorites"'))).toBe(true);
  });
  it('a cancelled import replaces the progress toast with a short notice that times out', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('Night Portal');
    await waitFor(() => expect(events.handlers.has('import.progress')).toBe(true));
    const emit = events.handlers.get('import.progress')!;
    act(() => emit({ sourceId: 's1', phase: 'parsing', done: 50, total: 200 }));
    expect(await screen.findByText('Importing Night Portal', VISIBLE_TOAST)).toBeTruthy();
    act(() => emit({ sourceId: 's1', phase: 'cancelled', done: 50 }));
    expect(await screen.findByText('Import of Night Portal cancelled', VISIBLE_TOAST)).toBeTruthy();
    const rec = useToastStore.getState().toasts.find((t) => t.id === 'import-s1')!;
    expect(rec.progress).toBeUndefined();
    expect(rec.duration).toBeGreaterThan(0);
  });

  it('passes the classified error code to the import summary', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('Night Portal');
    await waitFor(() => expect(events.handlers.has('import.progress')).toBe(true));
    const { importSummaryKey } = await import('@/features/sources/lib/errors');
    const { default: i18n } = await import('i18next');
    act(() => events.handlers.get('import.progress')!({ sourceId: 's1', phase: 'error', done: 0, message: 'something odd', code: 'auth' }));
    const expected = i18n.t(`sources:${importSummaryKey('something odd', 'auth')}`);
    await waitFor(() =>
      expect(String(useToastStore.getState().toasts.find((t) => t.id === 'import-s1')?.description)).toContain(expected),
    );
  });

  it('sources waiting out their delete-undo window leave the rail, dashboard and palette', async () => {
    const { usePendingRemovals } = await import('@/features/sources/lib/pendingRemoval');
    act(() => usePendingRemovals.setState({ ids: new Set(['s2']) }));
    try {
      renderRoutes(routes(), '/dashboard');
      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      await within(nav).findByText('Night Portal');
      expect(within(nav).queryByText('Backup 1')).toBeNull();
      const sourcesRail = await screen.findByTestId('dashboard-rail-recent-sources');
      expect(within(sourcesRail).queryByText('Backup 1')).toBeNull();
      act(() => usePendingRemovals.setState({ ids: new Set() }));
      expect(await within(nav).findByText('Backup 1')).toBeTruthy();
    } finally {
      act(() => usePendingRemovals.setState({ ids: new Set() }));
    }
  });
});


describe('B7 review round 1', () => {
  it('palette ranks a source named for the query above a keyword-only command', async () => {
    const { paletteFilter } = await import('../CommandPalette');
    const sep = '\u0000';
    const named = paletteFilter(`Mock Xtream: Live TV${sep}source.m.live`, 'xtream', ['Mock Xtream', 'xtream', 'live']);
    const keywordOnly = paletteFilter(`Add source${sep}nav.addSource`, 'xtream', ['playlist', 'm3u', 'xtream']);
    expect(keywordOnly).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(keywordOnly);

    rpcMock.handlers['sources.list'] = () => [makeSource('m', { name: 'Mock Xtream' })];
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    // Sources loaded (the rail shows it) before the palette filters.
    await screen.findAllByText('Mock Xtream');
    key('k', { ctrlKey: true });
    const palette = await screen.findByTestId('command-palette');
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'xtream' } });
    await waitFor(() => {
      const first = palette.querySelector('[cmdk-item]');
      expect(first?.textContent).toContain('Mock Xtream');
      expect(first?.getAttribute('data-selected')).toBe('true');
    });
  });

  it('header: page title follows its own script, and the palette button has no Mac-only glyph', async () => {
    renderRoutes(routes(), '/dashboard');
    expect((await screen.findByTestId('page-title')).getAttribute('dir')).toBe('auto');
    const open = screen.getByTestId('open-palette');
    expect(open.querySelector('svg.lucide-command')).toBeNull();
    expect(open.querySelector('svg.lucide-square-chevron-right')).not.toBeNull();
  });

  it('rail links press darker', async () => {
    renderRoutes(routes(), '/favorites');
    const link = await screen.findByRole('link', { name: /Favorites/ });
    expect(link.className).toContain('active:bg-surface-3');
  });

  it('joins card counts with the locale list format, and names carry dir="auto"', async () => {
    const { joinList } = await import('../dashboard/cards');
    const iso = (x: string) => `⁨${x}⁩`;
    expect(joinList(['120 channels', '40 movies'], 'en')).toBe(`${iso('120 channels')}, ${iso('40 movies')}`);
    for (const lng of ['ru', 'fr', 'ko', 'tr', 'de']) expect(joinList(['a', 'b'], lng)).toBe(`${iso('a')}, ${iso('b')}`);
    expect(joinList(['a', false, undefined, '', 'b'], 'en')).toBe(`${iso('a')}, ${iso('b')}`);
    expect(joinList(['a', 'b'], 'ja')).toBe(`${iso('a')}、${iso('b')}`);
    expect(joinList(['a', 'b'], 'zh-TW')).toBe(`${iso('a')}、${iso('b')}`);
    // Arabic: Arabic comma, no "و" conjunction, and the year isolated so it stays in place.
    expect(joinList(['مصدر', 2019], 'ar')).toBe(`${iso('مصدر')}، ${iso('2019')}`);
    expect(joinList([2019], 'ary')).toBe(iso('2019'));
    // Parts with no letters or digits are left bare (PosterCard derives the separator this way).
    expect(joinList(['', ''], 'en').slice(1, -1)).toBe(', ');
    expect(joinList([], 'en')).toBe('');

    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recent-sources');
    const name = await within(rail).findByText('Night Portal');
    expect(name.getAttribute('dir')).toBe('auto');
    const counts = joinList(['120 channels', '40 movies'], 'en');
    expect(within(rail).getAllByText(counts).length).toBeGreaterThan(0);
  });
});

describe('B7 review round 2', () => {
  const railsOff = (over: Record<string, boolean>) =>
    settings({ dashboardRails: { ...settings().dashboardRails, ...over } as ReturnType<typeof settings>['dashboardRails'] });

  it('with the hero off, the shared error sits in the flow with no hero spacer', async () => {
    const h = rpcMock.handlers;
    h['settings.get'] = () => railsOff({ hero: false, continueWatching: false, recentlyWatchedLive: false, favoriteMoviesAndSeries: false });
    const fail = () => {
      throw { code: 'db', message: 'database is locked' };
    };
    h['favorites.list'] = fail;
    h['catalog.recentlyAdded'] = fail;
    renderRoutes(routes(), '/dashboard');
    const slot = await screen.findByTestId('dashboard-error-slot');
    expect(slot.querySelector('[data-hero-spacer]')).toBeNull();
    // The error slot comes before the sources rail in document order, both in flow.
    const sources = screen.getByTestId('dashboard-rail-recent-sources');
    expect(slot.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('dashboard-error').className).not.toMatch(/\babsolute\b/);
  });

  it('a rail error reserves its skeleton card height and lays out in a row', async () => {
    rpcMock.handlers['recent.list'] = () => {
      throw { code: 'db', message: 'locked' };
    };
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recent-live');
    const box = await within(rail).findByTestId('dashboard-rail-error');
    const spacer = box.querySelector<HTMLElement>('[data-rail-error-spacer]')!;
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.className).toContain('invisible');
    // Same skeleton card as the loading state: the rail's card width and aspect.
    expect((spacer.firstElementChild as HTMLElement).style.width).toBe('232px');
    expect(within(box).getByRole('alert').className).toContain('flex-row');
  });

  it('the one favorites query shows one error panel, not two', async () => {
    rpcMock.handlers['favorites.list'] = () => {
      throw { code: 'db', message: 'locked' };
    };
    renderRoutes(routes(), '/dashboard');
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    expect(await within(live).findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-rail-favorite-vod')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('the favorite-vod rail shows the favorites error when the live rail is off', async () => {
    rpcMock.handlers['settings.get'] = () => railsOff({ liveFavorites: false });
    rpcMock.handlers['favorites.list'] = () => {
      throw { code: 'db', message: 'locked' };
    };
    renderRoutes(routes(), '/dashboard');
    const vod = await screen.findByTestId('dashboard-rail-favorite-vod');
    expect(await within(vod).findByRole('alert')).toBeTruthy();
  });

  it('a rail that loaded empty last time shows no skeleton while it loads', async () => {
    const { readRailEmpty } = await import('../dashboard/railEmpty');
    let resolve!: (v: unknown) => void;
    rpcMock.handlers['favorites.list'] = () => [];
    renderRoutes(routes(), '/dashboard');
    await waitFor(() => expect(readRailEmpty('live-favorites')).toBe(true));
    cleanup();
    const { queryClient } = await import('@/api/query');
    queryClient.clear();
    rpcMock.handlers['favorites.list'] = () => new Promise((r) => (resolve = r));
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-rail-continue-watching');
    expect(screen.queryByTestId('dashboard-rail-live-favorites')).toBeNull();
    expect(screen.queryByTestId('dashboard-rail-favorite-vod')).toBeNull();
    // Rails below the still-loading favorites wait for it (round 3 hold rule), then appear.
    expect(screen.queryByTestId('dashboard-rail-recent-live')).toBeNull();
    resolve([]);
    expect(await screen.findByTestId('dashboard-rail-recent-live')).toBeTruthy();
  });

  it('rail source names follow their own script', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('a', { name: 'مصدر عربي' })];
    renderRoutes(routes(), '/favorites');
    const name = (await screen.findAllByText('مصدر عربي')).find((el) => el.closest('nav'))!;
    expect(name.getAttribute('dir')).toBe('auto');
    expect(name.className).toContain('text-match-parent');
  });

  it('rail "See all" links and scroll arrows have pressed states', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'dashboard', 'DashboardRail.tsx'), 'utf8');
    expect(src.match(/active:text-accent-pressed/g)).toHaveLength(3);
    renderRoutes(routes(), '/dashboard');
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    expect((await within(live).findByRole('link', { name: 'See all' })).className).toContain('active:text-accent-pressed');
  });

  it('typing in the palette scrolls the list back to the selected top result', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('k', { ctrlKey: true });
    const palette = await screen.findByTestId('command-palette');
    const list = palette.querySelector<HTMLElement>('[cmdk-list]')!;
    // jsdom has no layout, so give the list a scroll position it keeps.
    Object.defineProperty(list, 'scrollTop', { value: 284, writable: true, configurable: true });
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'mo' } });
    await waitFor(() => expect(list.scrollTop).toBe(0));
  });
});

describe('B7 review round 3', () => {
  it('a failed rail, or one whose error is hidden, never writes the "loaded empty" flag', async () => {
    const { readRailEmpty } = await import('../dashboard/railEmpty');
    rpcMock.handlers['favorites.list'] = () => {
      throw { code: 'db', message: 'locked' };
    };
    renderRoutes(routes(), '/dashboard');
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    expect(await within(live).findByRole('alert')).toBeTruthy();
    // favorite-vod reads the same failed query with its error hidden: still no flag.
    expect(readRailEmpty('live-favorites')).toBe(false);
    expect(readRailEmpty('favorite-vod')).toBe(false);
  });

  it('a shared failure of every rail writes no flags', async () => {
    const { readRailEmpty } = await import('../dashboard/railEmpty');
    const fail = () => {
      throw { code: 'network', message: 'down' };
    };
    const h = rpcMock.handlers;
    for (const c of ['positions.continueWatching', 'favorites.list', 'recent.list', 'catalog.recentlyAdded']) h[c] = fail;
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-error');
    for (const id of ['continue-watching', 'live-favorites', 'recent-live', 'favorite-vod', 'recently-added']) {
      expect(readRailEmpty(id), id).toBe(false);
    }
  });

  it('maps query results to the rails they feed', async () => {
    const { railsWithContent } = await import('../dashboard/railEmpty');
    const live = { ref: { contentType: 'live' } };
    const movie = { ref: { contentType: 'movie' } };
    expect(railsWithContent('favorites.list', [live, movie])).toEqual(['live-favorites', 'favorite-vod']);
    expect(railsWithContent('favorites.list', [movie])).toEqual(['favorite-vod']);
    expect(railsWithContent('recent.list', [movie])).toEqual([]);
    expect(railsWithContent('recent.list', [live])).toEqual(['recent-live']);
    expect(railsWithContent('positions.continueWatching', [movie])).toEqual(['continue-watching']);
    expect(railsWithContent('catalog.recentlyAdded', [movie])).toEqual(['recently-added']);
    expect(railsWithContent('favorites.list', [])).toEqual([]);
    expect(railsWithContent('sources.list', [movie])).toEqual([]);
  });

  it('content arriving anywhere in the query cache clears a stale flag', async () => {
    const { QueryClient } = await import('@tanstack/react-query');
    const { bindRailEmptySync, readRailEmpty, writeRailEmpty } = await import('../dashboard/railEmpty');
    const client = new QueryClient();
    const off = bindRailEmptySync(client);
    writeRailEmpty('live-favorites', true);
    writeRailEmpty('favorite-vod', true);
    // E.g. the Favorites page after the first live favorite.
    client.setQueryData(['favorites.list', null], [{ ref: { contentType: 'live' } }]);
    expect(readRailEmpty('live-favorites')).toBe(false);
    expect(readRailEmpty('favorite-vod')).toBe(true);
    off();
    client.setQueryData(['favorites.list', {}], [{ ref: { contentType: 'series' } }]);
    expect(readRailEmpty('favorite-vod')).toBe(true);
  });

  it('nothing renders below the first section still loading', async () => {
    let resolve!: () => void;
    const recent = rpcMock.handlers['recent.list']!;
    rpcMock.handlers['recent.list'] = (a) => new Promise((r) => (resolve = () => r(recent(a))));
    renderRoutes(routes(), '/dashboard');
    // Above the pending rail: settled content. The pending rail: its skeleton.
    await screen.findByTestId('dashboard-rail-live-favorites');
    expect(screen.getByTestId('dashboard-rail-recent-live')).toBeTruthy();
    for (const id of ['favorite-vod', 'recent-sources', 'recently-added']) {
      expect(screen.queryByTestId(`dashboard-rail-${id}`), id).toBeNull();
    }
    resolve();
    expect(await screen.findByTestId('dashboard-rail-recent-sources')).toBeTruthy();
    expect(screen.getByTestId('dashboard-rail-favorite-vod')).toBeTruthy();
    expect(await screen.findByTestId('dashboard-rail-recently-added')).toBeTruthy();
  });

  it('card names follow their own script inside an RTL page', async () => {
    renderRoutes(routes(), '/dashboard');
    const live = await screen.findByTestId('dashboard-rail-live-favorites');
    const name = within(live).getByText('Harbor News');
    expect(name.getAttribute('dir')).toBe('auto');
    expect(name.className).toContain('text-match-parent');
    expect((await within(live).findByText('Morning Bulletin')).className).toContain('text-match-parent');
    const src = await screen.findByTestId('dashboard-rail-recent-sources');
    const srcName = within(src).getByText('Night Portal');
    expect(srcName.getAttribute('dir')).toBe('auto');
    expect(srcName.className).toContain('text-match-parent');
  });

  it('source and recently-added cards read the name first', async () => {
    rpcMock.handlers['catalog.recentlyAdded'] = (a) =>
      (a as { contentType: string }).contentType === 'movie'
        ? ([
            { ref: { sourceId: 's1', contentType: 'movie', itemId: '99' }, title: 'Fresh Arrival', year: 2024, rating: 7.46, added: '2026-10-09T00:00:00Z', categoryId: 'c' },
          ] as VodItem[])
        : [];
    renderRoutes(routes(), '/dashboard');
    const src = await screen.findByTestId('dashboard-rail-recent-sources');
    // Monogram "NP" and the kind badge are decorative; the kind follows the name.
    const link = within(src).getByRole('link', { name: /^Night Portal, Xtream/ });
    expect(within(link).getByText('NP').getAttribute('aria-hidden')).toBe('true');
    const added = await screen.findByTestId('dashboard-rail-recently-added');
    const strip = (s: string | null) => (s ?? '').replace(/[⁨⁩]/g, '');
    expect(strip(within(added).getByRole('link').getAttribute('aria-label'))).toBe('Fresh Arrival, Night Portal, 2024, rated 7.5');
    const vod = await screen.findByTestId('dashboard-rail-favorite-vod');
    expect(strip(within(vod).getByRole('link', { name: /Quiet Coast/ }).getAttribute('aria-label'))).toBe('Quiet Coast, Series');
  });
});

describe('Run 3 onboarding wiring', () => {
  const onboarding = () => import('@/features/onboarding/store');

  afterEach(async () => (await onboarding()).resetOnboardingStore());

  it('the rail and header carry one tour anchor per step', async () => {
    renderRoutes(routes(), '/favorites');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await within(nav).findByText('Night Portal');
    const live = nav.querySelectorAll('[data-tour="live"]');
    expect(live).toHaveLength(1);
    expect(live[0]!.textContent).toContain('Night Portal');
    expect(within(nav).getByRole('link', { name: /My List/ }).getAttribute('data-tour')).toBe('vod');
    expect(document.querySelector('[data-tour="search"]')).not.toBeNull();
  });

  it('the palette starts the tour and opens What\'s new', async () => {
    const { useOnboardingStore } = await onboarding();
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    for (const [query, kind] of [
      ['take the tour', 'tour'],
      ["what's new", 'whatsNew'],
    ] as const) {
      (await onboarding()).resetOnboardingStore();
      act(() => useShellStore.getState().setPaletteOpen(true));
      const palette = await screen.findByTestId('command-palette');
      const input = within(palette).getByPlaceholderText('Type a command or search');
      fireEvent.change(input, { target: { value: query } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(useOnboardingStore.getState().overlay?.kind).toBe(kind));
      expect(useOnboardingStore.getState().overlay?.auto).toBe(false);
      await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    }
  });
});
