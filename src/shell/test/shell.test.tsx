import { configure, act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FavoriteEntry, PlaybackPosition, RecentEntry, VodItem } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from './harness';

// The whole shell renders here, with Home and its lazy overlays (palette, shortcut help): a cold
// first render under a loaded full-suite run can pass the 1 s default.
configure({ asyncUtilTimeout: 4000 });

/** Matches toast text in the visible stack, not its copy in the screen-reader live region. */
const VISIBLE_TOAST = { ignore: 'script, style, [data-toast-live] *' };

/**
 * The event bus: `handlers.get(type)` emits to every subscriber of that type, like the real
 * bus (the shell and the parental hook both listen to `import.progress` and `sources.changed`).
 */
const events = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const handlers = new Map<string, (p: unknown) => void>();
  const open = (type: string) => {
    const subs = new Set<(p: unknown) => void>();
    listeners.set(type, subs);
    handlers.set(type, (p) => [...subs].forEach((fn) => fn(p)));
    return subs;
  };
  return {
    handlers,
    subscribe(type: string, h: (p: unknown) => void): () => void {
      const subs = listeners.get(type) ?? open(type);
      subs.add(h);
      return () => {
        subs.delete(h);
        if (subs.size === 0 && listeners.get(type) === subs) {
          listeners.delete(type);
          handlers.delete(type);
        }
      };
    },
    clear(): void {
      listeners.clear();
      handlers.clear();
    },
  };
});

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, h: (p: unknown) => void) => events.subscribe(type, h),
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));
/** What the mocked player store reports to F11 (L2-desktop-8). */
const playerState = vi.hoisted(() => ({ source: null as unknown, mode: 'web', toggleFullscreen: () => {} }));
vi.mock('@/features/player', () => ({
  usePlayerStore: { getState: () => playerState },
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
  events.clear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false, railHidden: false });
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
    // L3-perf-ui-6: the player chunks wait PLAYER_PREFETCH_DELAY_MS past the first route, so the
    // dock is not there yet; the first press loads it at once.
    expect(screen.queryByTestId('player-dock')).toBeNull();
    fireEvent.pointerDown(window);
    expect(await screen.findByTestId('player-dock')).toBeTruthy();
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

  it('Ctrl+F and Ctrl+K do nothing over a dialog or in a text field; in a browser Ctrl+R stays the reload key (SH-ctrl-r-browser)', async () => {
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const field = document.createElement('input');
    dialog.appendChild(field);
    document.body.appendChild(dialog);
    try {
      field.focus();
      expect(fireEvent.keyDown(field, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(false);
      fireEvent.keyDown(field, { key: 'k', code: 'KeyK', ctrlKey: true });
      expect(useShellStore.getState().paletteOpen).toBe(false);
      // Not claimed: the browser reloads, as the user asked.
      expect(fireEvent.keyDown(field, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    } finally {
      dialog.remove();
    }

    // Nor on the page: Ctrl+R never leaves for Recently watched in a browser.
    expect(fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(router.state.location.pathname).toBe('/favorites');
    // The palette still leads there, with no Ctrl+R hint on the row.
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'recently watched' } });
    const row = await within(palette).findByText('Recently watched');
    expect(row.closest('[cmdk-item]')!.querySelector('kbd')).toBeNull();
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
    // Every run opens with `connecting`, before its first request.
    act(() => emit({ sourceId: 's1', phase: 'connecting', done: 0 }));
    expect(await screen.findByText('Importing Night Portal')).toBeTruthy();
    expect(screen.getByText('Starting…')).toBeTruthy();
    act(() => emit({ sourceId: 's1', phase: 'parsing', done: 50, total: 200 }));
    expect(await screen.findByText('Reading the playlist: 50 of 200')).toBeTruthy();
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

describe('phone layout (below 1024 px)', () => {
  let matchMedia: typeof window.matchMedia;
  const narrowWindow = (narrow: boolean) => {
    window.matchMedia = ((query: string) => ({
      ...matchMedia(query),
      matches: narrow && query === '(max-width: 1023px)',
    })) as typeof window.matchMedia;
  };
  beforeEach(() => {
    matchMedia = window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = matchMedia;
  });

  it('the rail can be hidden and shown again, and focus moves to the button that brings it back', async () => {
    narrowWindow(true);
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    // Below lg the rail never expands: its toggle hides it instead.
    expect(within(nav).queryByRole('button', { name: 'Expand sidebar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();

    fireEvent.click(within(nav).getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    const show = screen.getByRole('button', { name: 'Show sidebar' });
    expect(document.activeElement).toBe(show);
    expect(localStorage.getItem('tsrust.railHidden')).toBe('1');

    fireEvent.click(show);
    const back = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(document.activeElement).toBe(within(back).getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();
    expect(localStorage.getItem('tsrust.railHidden')).toBe('0');
  });

  it('from 1024 px up the rail shows even when it was hidden on a narrow window', async () => {
    narrowWindow(false);
    act(() => useShellStore.setState({ railHidden: true }));
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('button', { name: 'Collapse sidebar' })).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: 'Hide sidebar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();
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
    // The cards show titles and times only, so the programme descriptions stay off the wire (L3-serve-ui-8).
    const nowNextArgs = rpcMock.calls.filter((c) => c.cmd === 'epg.nowNext').map((c) => c.args as { withDescription?: boolean });
    expect(nowNextArgs.length).toBeGreaterThan(0);
    for (const a of nowNextArgs) expect(a.withDescription).toBe(false);
    // No LIVE pill on channel tiles (SH-live-pill-noise), and no animation per card: an infinite
    // pulse on every card kept an idle dashboard compositing (L3-perf-desktop-1).
    expect(live.querySelector('[data-live-pill]')).toBeNull();
    expect(live.querySelector('[class*="animate-"]:not([data-rail-skeleton-card] *)')).toBeNull();
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

  it('first run welcomes with the mark, the three kinds and the backup link, and adds a source right on Home (SH-welcome-generic)', async () => {
    baseHandlers({ sources: 0 });
    const { router } = renderRoutes(routes(), '/dashboard');
    const welcome = await screen.findByTestId('dashboard-welcome', {}, { timeout: 3000 });
    expect(within(welcome).getByRole('heading', { name: 'Welcome to Tsrust IPTV' })).toBeTruthy();
    expect(welcome.querySelector('svg')).toBeTruthy();
    for (const kind of ['m3u', 'xtream', 'stalker']) expect(within(welcome).getByTestId(`onboard-${kind}`)).toBeTruthy();
    expect(within(welcome).getByRole('link', { name: 'Import a backup' }).getAttribute('href')).toBe('/settings/backup');
    // The browser build keeps its data on the server.
    expect(within(welcome).getByText(/stay on your Tsrust server/)).toBeTruthy();
    // One call to action: the rail shows no add row of its own beside the welcome.
    expect(screen.queryByTestId('rail-add-source')).toBeNull();

    // A tile opens the add dialog here, on its kind; cancelling stays on Home (SH-cancel-returns).
    fireEvent.click(within(welcome).getByTestId('onboard-xtream'));
    const dialog = await screen.findByRole('dialog', { name: 'Add a source' }, { timeout: 3000 });
    expect(router.state.location.pathname).toBe('/dashboard');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a source' })).toBeNull());
    expect(router.state.location.pathname).toBe('/dashboard');
    expect(screen.getByTestId('dashboard-welcome')).toBeTruthy();
  });

  it('warms the playback engines at idle once there is something to play (XB2-14)', async () => {
    const { __setEngineLoadersForTests } = await import('@/features/player/enginePreload');
    const hls = vi.fn(async () => ({}));
    const mpegts = vi.fn(async () => ({}));
    __setEngineLoadersForTests({ hls, mpegts });
    try {
      baseHandlers({ sources: 0 });
      renderRoutes(routes(), '/dashboard');
      await screen.findByTestId('dashboard-welcome');
      // jsdom has no requestIdleCallback: the preload falls back to a 300 ms timer.
      await new Promise((r) => setTimeout(r, 400));
      expect(hls).not.toHaveBeenCalled();
      cleanup();
      (await import('@/api/query')).queryClient.clear();
      baseHandlers();
      renderRoutes(routes(), '/dashboard');
      await screen.findByTestId('dashboard-hero');
      await waitFor(() => expect(hls).toHaveBeenCalledTimes(1));
      expect(mpegts).toHaveBeenCalledTimes(1);
    } finally {
      __setEngineLoadersForTests(null);
    }
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
    // The browser build: the data lives on the server (SH-kind-labels-copy), not "this computer".
    expect(within(rail).getByText(/stored on your Tsrust server/)).toBeTruthy();
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
    expect(within(banner).getByText(/stored on your Tsrust server/)).toBeTruthy();
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

describe('startup without layout jumps (B7, SH-hero-skeleton-flash)', () => {
  it('the pending startup frame is a neutral line on the page gutter, not a hero that may never come', async () => {
    rpcMock.handlers['settings.get'] = () => new Promise(() => {});
    renderRoutes([{ path: '/', element: <StartupOnly /> }], '/');
    const pending = await screen.findByTestId('startup-pending');
    expect(pending.querySelector('[data-testid="hero-skeleton"]')).toBeNull();
    expect(pending.className).toContain('px-(--page-gutter)');
    expect(pending.getAttribute('aria-busy')).toBe('true');
  });

  it('a hero that loaded empty last time shows no skeleton while Home loads', async () => {
    const { writeRailEmpty } = await import('../dashboard/railEmpty');
    rpcMock.handlers['positions.continueWatching'] = () => [];
    rpcMock.handlers['catalog.recentlyAdded'] = () => [];
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard');
    await waitFor(() => expect(localStorage.getItem('tsrust.dashRailEmpty.hero')).toBe('1'));
    cleanup();
    (await import('@/api/query')).queryClient.clear();
    writeRailEmpty('hero', true);
    rpcMock.handlers['positions.continueWatching'] = () => new Promise(() => undefined);
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard');
    expect(screen.queryByTestId('hero-skeleton')).toBeNull();
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

  it('recently added cards show the title without its year or provider tag, as the detail page does', async () => {
    rpcMock.handlers['catalog.recentlyAdded'] = (a) =>
      (a as { contentType: string }).contentType === 'movie'
        ? ([
            {
              ref: { sourceId: 's1', contentType: 'movie', itemId: '98' },
              title: 'Dune: Part Two (2024) [MULTI]',
              titleBase: 'Dune: Part Two',
              year: 2024,
              added: '2026-10-09T00:00:00Z',
              categoryId: 'c',
            },
          ] satisfies VodItem[])
        : [];
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recently-added');
    const link = await within(rail).findByRole('link', { name: /Dune: Part Two/ });
    expect(link.getAttribute('aria-label')).not.toMatch(/MULTI|\(2024\)/);
    expect(within(link).getByText('Dune: Part Two')).toBeTruthy();
    expect(within(link).getByText(/2024/)).toBeTruthy();
    expect(within(rail).queryByText(/MULTI/)).toBeNull();
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
    // Collapsed, the monogram opens the source's links in a menu (L2-shell-2); the error rides on its name.
    expect(await within(nav2).findByRole('button', { name: 'Broken One, The last refresh failed' })).toBeTruthy();
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

  it('header: page title follows its own script, and the search trigger has no Mac-only glyph', async () => {
    renderRoutes(routes(), '/dashboard');
    expect((await screen.findByTestId('page-title')).getAttribute('dir')).toBe('auto');
    const open = screen.getByTestId('open-palette');
    expect(open.querySelector('svg.lucide-command')).toBeNull();
    expect(open.querySelector('svg.lucide-search')).not.toBeNull();
  });

  it('rail links press darker', async () => {
    renderRoutes(routes(), '/favorites');
    const link = await screen.findByRole('link', { name: /Favorites/ });
    expect(link.className).toContain('active:bg-active');
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

  it('a loading rail stands as tall as the loaded one (L3-visual-14)', async () => {
    rpcMock.handlers['recent.list'] = () => new Promise(() => undefined);
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recent-live');
    const busy = rail.querySelector<HTMLElement>('[aria-busy="true"]')!;
    // The track's padding, then per card the art and two caption lines one text-sm line tall,
    // the first after the cards' mt-2: no thinner bars that come up short and shift the page.
    expect(busy.className).toMatch(/\bpt-1\b/);
    expect(busy.className).toMatch(/\bpb-3\b/);
    const card = busy.querySelector<HTMLElement>('[data-rail-skeleton-card]')!;
    const title = card.children[1] as HTMLElement;
    const subtitle = card.children[2] as HTMLElement;
    // The cards' caption spec (CAPTION_TITLE in body-sm, CAPTION_META in caption size).
    expect(title.className).toMatch(/\bh-\[1lh\].*\btext-body-sm\b/);
    expect(subtitle.className).toMatch(/\bh-\[1lh\].*\btext-caption\b/);
    expect(title.className).toMatch(/\bmt-2\b/);
    expect(card.className).not.toMatch(/\bgap-/);
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
    // The hero rotates both, so either clears its flag too (SH-hero-skeleton-flash).
    expect(railsWithContent('positions.continueWatching', [movie])).toEqual(['continue-watching', 'hero']);
    expect(railsWithContent('catalog.recentlyAdded', [movie])).toEqual(['recently-added', 'hero']);
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
    // The header's one search trigger is the one search anchor, not the rail's Search link.
    const search = document.querySelectorAll('[data-tour="search"]');
    expect(search).toHaveLength(1);
    expect(screen.getByTestId('shell-header').contains(search[0]!)).toBe(true);
    expect(search[0]!.textContent).toContain('Search everything');
    expect(search[0]).toBe(screen.getByTestId('open-palette'));
  });

  describe('the search anchor follows the layout', () => {
    /** A page with a header search field, like Live or Search. */
    function SearchFieldPage() {
      const shell = useShell();
      useEffect(() => {
        shell.setHeader({ title: 'Find', search: { value: '', onChange: () => {}, placeholder: 'Filter here' } });
      }, [shell]);
      return <Page>search field page</Page>;
    }
    // The harness stub (installed in beforeAll) matches nothing; this one matches the rail's auto-collapse query.
    let stubbed: typeof window.matchMedia;
    beforeEach(() => {
      stubbed = window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = stubbed;
    });
    const setNarrow = (narrow: boolean) => {
      window.matchMedia = ((query: string) => ({ ...stubbed(query), matches: narrow && query === '(max-width: 1023px)' })) as typeof window.matchMedia;
    };

    it('from lg up the page search field holds it', async () => {
      setNarrow(false);
      renderRoutes(routes(<SearchFieldPage />), '/search');
      const field = await screen.findByPlaceholderText('Filter here');
      const search = document.querySelectorAll('[data-tour="search"]');
      expect(search).toHaveLength(1);
      expect(search[0]!.contains(field) || search[0] === field).toBe(true);
    });

    it.each([
      ['/favorites', 'favorites page'],
      ['/search', 'search field page'],
    ])('below lg the header search slot still holds it on %s: it stays on screen there now', async (path, text) => {
      setNarrow(true);
      renderRoutes(routes(<SearchFieldPage />), path);
      await screen.findByText(text);
      const search = document.querySelectorAll('[data-tour="search"]');
      expect(search).toHaveLength(1);
      expect(screen.getByTestId('shell-header').contains(search[0]!)).toBe(true);
      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      expect(within(nav).getByRole('link', { name: 'Search' }).hasAttribute('data-tour')).toBe(false);
    });

    it('on a phone the tab bar Search tab holds it, and the header has no search, palette or theme button', async () => {
      window.matchMedia = ((query: string) => ({ ...stubbed(query), matches: query === '(max-width: 639px)' || query === '(max-width: 1023px)' })) as typeof window.matchMedia;
      renderRoutes(routes(<SearchFieldPage />), '/favorites');
      await screen.findByText('favorites page');
      const search = document.querySelectorAll('[data-tour="search"]');
      expect(search).toHaveLength(1);
      expect(screen.getByTestId('tab-bar').contains(search[0]!)).toBe(true);
      expect(screen.queryByTestId('open-palette')).toBeNull();
      expect(screen.queryByTestId('theme-toggle')).toBeNull();
    });
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

describe('L1 shell polish', () => {
  it('Esc blurs a text field but leaves focus on a link', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const { isTextEntry } = await import('../ShellLayout');
    const link = within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link')[0]!;
    link.focus();
    key('Escape');
    expect(document.activeElement).toBe(link);
    const input = document.createElement('input');
    expect(isTextEntry(input)).toBe(true);
    input.type = 'checkbox';
    expect(isTextEntry(input)).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
  });

  it('palette opens with an empty query after Ctrl+K closed it', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('k', { ctrlKey: true });
    const input = (await screen.findByPlaceholderText('Type a command or search')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'night' } });
    key('k', { ctrlKey: true });
    await waitFor(() => expect(screen.queryByPlaceholderText('Type a command or search')).toBeNull());
    key('k', { ctrlKey: true });
    expect(((await screen.findByPlaceholderText('Type a command or search')) as HTMLInputElement).value).toBe('');
  });

  it('palette lists Radio for a playlist source that has radio channels', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('m1', { kind: 'm3u', name: 'Radio Box', radioCount: 3 }),
      makeSource('m2', { kind: 'm3u', name: 'Plain List', position: 1, radioCount: 0 }),
    ];
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('k', { ctrlKey: true });
    const input = await screen.findByPlaceholderText('Type a command or search');
    // Source links wait for a query; the empty palette leads with recent channels and suggestions.
    fireEvent.change(input, { target: { value: 'radio' } });
    expect(await screen.findByText('Radio Box: Radio')).toBeTruthy();
    expect(screen.queryByText('Plain List: Radio')).toBeNull();
  });

  it('navigation closes the palette and the shortcut help', async () => {
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    key('k', { ctrlKey: true });
    await screen.findByPlaceholderText('Type a command or search');
    act(() => useShellStore.setState({ helpOpen: true }));
    await act(() => router.navigate('/recent'));
    await screen.findByText('recent page');
    expect(useShellStore.getState().paletteOpen).toBe(false);
    expect(useShellStore.getState().helpOpen).toBe(false);
  });

  it('Back restores the outlet scroll offset; a new page opens at the top', async () => {
    const { forgetShellScrollForTests, focusSelector } = await import('../scrollMemory');
    forgetShellScrollForTests();
    const { router } = renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const main = document.getElementById('main')!;
    Object.defineProperty(main, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(main, 'clientHeight', { value: 500, configurable: true });
    main.scrollTop = 800;
    fireEvent.scroll(main);
    await act(() => router.navigate('/recent'));
    await screen.findByText('recent page');
    expect(main.scrollTop).toBe(0);
    await act(() => router.navigate(-1));
    await screen.findByText('favorites page');
    await waitFor(() => expect(main.scrollTop).toBe(800));
    const a = document.createElement('a');
    a.setAttribute('href', '/s/x y/live');
    expect(focusSelector(a)).toMatch(/^a\[href="/);
  });

  it('the dashboard hides a pending-removal source in continue watching and favourites', async () => {
    const { usePendingRemovals } = await import('@/features/sources/lib/pendingRemoval');
    act(() => usePendingRemovals.setState({ ids: new Set(['s1']) }));
    try {
      renderRoutes(routes(), '/dashboard');
      expect(await screen.findByText('Metro Sport')).toBeTruthy();
      expect(screen.queryByText('The Long Signal')).toBeNull();
      expect(screen.queryByText('Harbor News')).toBeNull();
      expect(screen.queryByText('Quiet Coast')).toBeNull();
      act(() => usePendingRemovals.setState({ ids: new Set() }));
      expect((await screen.findAllByText('Harbor News')).length).toBeGreaterThan(0);
    } finally {
      act(() => usePendingRemovals.setState({ ids: new Set() }));
    }
  });
});

describe('L2 shell header', () => {
  it('the header search trigger opens the palette, one width on every page, and its search row opens the search page (SH-header-search)', async () => {
    const shellRoute = routes()[0]!;
    function ScopedPage() {
      const shell = useShell();
      useEffect(() => {
        shell.setHeader({ title: 'Movies', search: { value: '', onChange: () => {}, placeholder: 'Search Night Portal' } });
      }, [shell]);
      return <Page>scoped page</Page>;
    }
    const tree = [
      {
        ...shellRoute,
        children: [
          ...shellRoutes,
          { path: 'mine', element: <section><input data-page-search="" aria-label="My filter" /></section> },
          { path: 'scoped', element: <ScopedPage /> },
          { path: 'search', element: <Page><input data-page-search="" aria-label="Search field" /></Page> },
        ],
      },
    ];
    const { router } = renderRoutes(tree, '/mine');
    await screen.findByLabelText('My filter');
    const trigger = screen.getByRole('button', { name: /Search everything/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    // One shortcut hint, Ctrl K; no separate palette button beside it.
    expect(trigger.querySelector('[class*="sr-only"]')?.textContent).toBe('Ctrl + K');
    expect(screen.queryByRole('button', { name: 'Open command palette' })).toBeNull();
    fireEvent.click(trigger);
    const palette = await screen.findByTestId('command-palette');
    fireEvent.change(within(palette).getByPlaceholderText('Type a command or search'), { target: { value: 'harbor' } });
    fireEvent.click(await within(palette).findByText('Search for "harbor"'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('?q=harbor');

    // A page's own field takes the same slot, at the same width.
    await act(() => router.navigate('/scoped'));
    const field = await screen.findByRole('searchbox', { name: 'Search Night Portal' });
    expect(field.parentElement!.className).toContain('sm:w-[clamp(15rem,24vw,22rem)]');
    expect(trigger.className).toContain('w-[clamp(15rem,24vw,22rem)]');
  });

  it('page actions sit in a shrinking wrapper, so the search trigger and theme button stay on screen (L2-visual-4)', async () => {
    function ActionsPage() {
      const shell = useShell();
      useEffect(() => {
        shell.setHeader({ title: 'My videos', subtitle: 'Recordings and downloads', actions: <button type="button">Open queue</button> });
      }, [shell]);
      return <Page>videos</Page>;
    }
    const shellRoute = routes()[0]!;
    renderRoutes([{ ...shellRoute, children: [...shellRoutes, { path: 'videos', element: <ActionsPage /> }] }], '/videos');
    const actions = await screen.findByTestId('header-actions');
    // Shrinkable (min-w-0, no shrink-0) and clipped sideways only: the shell buttons never are.
    expect(actions.className).toContain('min-w-0');
    expect(actions.className).not.toContain('shrink-0');
    expect(actions.className).toContain('overflow-x-clip');
    expect(screen.getByTestId('open-palette').parentElement!.className).toContain('shrink-0');
    // The subtitle gives way before the title (L2-visual-9) and shows its whole text on hover.
    const subtitle = screen.getByTestId('page-subtitle');
    expect(subtitle.className).toContain('basis-0');
    expect(subtitle.getAttribute('title')).toBe('Recordings and downloads');
  });

  it("the header search passes keys to the page's onKeyDown, and a claimed key skips its own Escape (XB2-23)", async () => {
    const keys: string[] = [];
    const onChange = vi.fn();
    function KeysPage() {
      const shell = useShell();
      useEffect(() => {
        shell.setHeader({
          title: 'Keys',
          search: {
            value: 'abc',
            onChange,
            onKeyDown: (e) => {
              keys.push(e.key);
              if (e.key === 'Escape') e.preventDefault();
            },
          },
        });
      }, [shell]);
      return <Page>keys</Page>;
    }
    const shellRoute = routes()[0]!;
    renderRoutes([{ ...shellRoute, children: [...shellRoutes, { path: 'keys', element: <KeysPage /> }] }], '/keys');
    await screen.findByText('keys');
    const field = document.querySelector<HTMLInputElement>('input[data-shell-search]')!;
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(keys).toEqual(['ArrowDown', 'Escape']);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('F11 (L2-desktop-8)', () => {
  afterEach(() => {
    playerState.source = null;
    playerState.mode = 'web';
  });

  it('fills the screen with the app when nothing plays, and with the player while something does', async () => {
    const request = vi.fn(async () => {});
    document.documentElement.requestFullscreen = request as never;
    const toggle = vi.fn();
    playerState.toggleFullscreen = toggle;
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    // The player chunk loads on the first idle moment; F11 reads its store once it is in.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    const e = new KeyboardEvent('keydown', { key: 'F11', bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
    playerState.source = { url: 'http://x' };
    key('F11');
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    // External playback has no in-app fullscreen: the app takes it.
    playerState.mode = 'external';
    key('F11');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('dashboard base titles (L2-visual-3)', () => {
  it('Continue watching and favourite VOD cards drop the provider tags an old snapshot still carries', async () => {
    rpcMock.handlers['positions.continueWatching'] = (): PlaybackPosition[] => [
      { ref: { sourceId: 's1', contentType: 'movie', itemId: '10' }, positionSeconds: 1800, durationSeconds: 5400, watched: false, updatedAt: '2026-10-10T20:00:00Z', snapshot: snapshot('|EN| 4K - Night Train [MULTI-SUB] (2019)') },
    ];
    rpcMock.handlers['favorites.list'] = (): FavoriteEntry[] => [
      { ref: { sourceId: 's1', contentType: 'live', itemId: '1' }, addedAt: '2026-10-01T00:00:00Z', position: 0, snapshot: snapshot('US: Harbor News', 'live') },
      { ref: { sourceId: 's1', contentType: 'series', itemId: '7' }, addedAt: '2026-10-01T00:00:00Z', position: 1, snapshot: snapshot('EN: Quiet Coast - 2021', 'series') },
    ];
    renderRoutes(routes(), '/dashboard');
    const cont = await screen.findByTestId('dashboard-rail-continue-watching');
    expect(await within(cont).findByText('Night Train')).toBeTruthy();
    expect(within(cont).queryByText(/MULTI-SUB|\|EN\|/)).toBeNull();
    const vod = await screen.findByTestId('dashboard-rail-favorite-vod');
    expect(within(vod).getByText('Quiet Coast')).toBeTruthy();
    // The stripped year moves under the title.
    expect(within(vod).getByText('2021')).toBeTruthy();
    // A channel's prefix is part of its name and stays.
    expect(within(await screen.findByTestId('dashboard-rail-live-favorites')).getByText('US: Harbor News')).toBeTruthy();
  });
});
