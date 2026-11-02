/**
 * F1-3: the command palette and the `?` overlay mount the first time they open, not with the
 * shell. Their chunks load on hover or focus of their buttons and at idle after the player's load,
 * never at boot. The rail reads the pathname alone and the shell's stable navigate, so a typed
 * `?q=` re-renders neither it nor its source entries and their links.
 */

import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDomStubs, makeSource, Page, renderRoutes, rpcMock, settings } from './harness';

configure({ asyncUtilTimeout: 4000 });

const seen = vi.hoisted(() => ({ paletteLoads: 0, paletteMounts: 0, overlayLoads: 0, railRenders: 0, sourceEntryRenders: 0, railLinkRenders: 0 }));

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
vi.mock('@/features/player', () => ({ playItem: async () => undefined, restorePlayback: async () => false, PlayerDock: () => null, ExternalPlaybackFooter: () => null }));
vi.mock('@/features/player/dock', () => ({ restorePlayback: async () => false, PlayerDock: () => null, ExternalPlaybackFooter: () => null }));
// Stand-ins that count when their module loads and when they mount.
vi.mock('../CommandPalette', async () => {
  seen.paletteLoads += 1;
  const { useShellStore } = await import('../store');
  return {
    CommandPalette: function CommandPalette() {
      useEffect(() => {
        seen.paletteMounts += 1;
      }, []);
      return useShellStore((s) => s.paletteOpen) ? <div data-testid="command-palette" /> : null;
    },
  };
});
vi.mock('../ShortcutOverlay', async () => {
  seen.overlayLoads += 1;
  const { useShellStore } = await import('../store');
  return { ShortcutOverlay: () => (useShellStore((s) => s.helpOpen) ? <div data-testid="shortcut-overlay" /> : null) };
});
// The rail is the shell's only reader of the visible sources on a desktop-wide window: one call per render.
vi.mock('../useVisibleSources', async (orig) => {
  const real = await orig<typeof import('../useVisibleSources')>();
  return {
    useVisibleSources: () => {
      seen.railRenders += 1;
      return real.useVisibleSources();
    },
  };
});

// Each source entry builds its links once per render, and each rail link asks its route intent once.
vi.mock('../railLinks', async (orig) => {
  const real = await orig<typeof import('../railLinks')>();
  return {
    ...real,
    railLinks: (...args: Parameters<typeof real.railLinks>) => {
      seen.sourceEntryRenders += 1;
      return real.railLinks(...args);
    },
  };
});
vi.mock('../routeIntent', async (orig) => {
  const real = await orig<typeof import('../routeIntent')>();
  return {
    ...real,
    useRouteIntent: (to: string) => {
      seen.railLinkRenders += 1;
      return real.useRouteIntent(to);
    },
  };
});

const { ShellLayout } = await import('../ShellLayout');
const { useShellStore } = await import('../store');

const routes = [
  {
    path: '/',
    element: <ShellLayout />,
    children: [
      { path: 'favorites', element: <Page>favorites page</Page> },
      { path: 'recent', element: <Page>recent page</Page> },
      { path: 's/:sourceId/favorites', element: <Page>source favorites page</Page> },
    ],
  },
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  localStorage.clear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false, railHidden: false });
});
afterEach(cleanup);

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

describe('overlays on demand (F1-3)', () => {
  it('loads neither overlay at boot, warms on hover and after the player, and mounts on first open for good', async () => {
    renderRoutes(routes, '/favorites');
    await screen.findByText('favorites page');
    await screen.findAllByText('Night Portal');
    await settle();
    expect(seen).toMatchObject({ paletteLoads: 0, paletteMounts: 0, overlayLoads: 0 });

    // A hover on the header's palette button starts the palette's chunk; nothing mounts.
    fireEvent.pointerEnter(screen.getByTestId('open-palette'));
    await waitFor(() => expect(seen.paletteLoads).toBe(1));
    await settle();
    expect(seen.paletteMounts).toBe(0);
    expect(seen.overlayLoads).toBe(0);

    // The first press loads the player; the overlays' chunks follow at the next idle moment.
    fireEvent.pointerDown(window);
    await waitFor(() => expect(seen.overlayLoads).toBe(1));
    expect(seen.paletteLoads).toBe(1);
    expect(screen.queryByTestId('shortcut-overlay')).toBeNull();

    // Ctrl+K mounts the palette; closing keeps it mounted for its next opening.
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    await screen.findByTestId('command-palette');
    act(() => useShellStore.getState().setPaletteOpen(false));
    expect(screen.queryByTestId('command-palette')).toBeNull();
    act(() => useShellStore.getState().setPaletteOpen(true));
    expect(screen.getByTestId('command-palette')).toBeTruthy();
    expect(seen.paletteMounts).toBe(1);

    act(() => useShellStore.getState().setHelpOpen(true));
    await screen.findByTestId('shortcut-overlay');
  });

  it('leaves the rail alone while a search types into the location, and follows a new page', async () => {
    const { router } = renderRoutes(routes, '/favorites');
    await screen.findByText('favorites page');
    await screen.findAllByText('Night Portal');
    await settle();

    const before = seen.railRenders;
    for (const q of ['b', 'bb', 'bbc']) {
      await act(() => router.navigate(`/favorites?q=${q}`, { replace: true }));
    }
    await settle();
    // Each replace re-rendered the whole rail (54 components per keystroke) when it read useLocation.
    expect(seen.railRenders - before).toBe(0);

    await act(() => router.navigate('/recent'));
    await screen.findByText('recent page');
    expect(seen.railRenders).toBeGreaterThan(before);
    const recent = screen.getByRole('link', { name: 'Recently watched' });
    expect(recent.getAttribute('aria-current')).toBe('page');
  });

  it("leaves the source entries and their links alone while a source page's search types", async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' }), makeSource('s2', { name: 'Day Portal', position: 1 })];
    const { router } = renderRoutes(routes, '/s/s1/favorites');
    await screen.findByText('source favorites page');
    await screen.findAllByText('Night Portal');
    await settle();
    // The page's source is expanded: its links are on screen.
    expect(screen.getAllByRole('link', { name: 'Favorites' }).length).toBeGreaterThan(0);

    const before = { ...seen };
    for (const q of ['b', 'bb', 'bbc']) {
      await act(() => router.navigate(`/s/s1/favorites?q=${q}`, { replace: true }));
    }
    await settle();
    // useNavigate reads the route context, which the router builds again on every location change:
    // 6 source entry and 18 rail link renders here before the entries took the shell's navigate.
    expect(seen.railRenders - before.railRenders).toBe(0);
    expect(seen.sourceEntryRenders - before.sourceEntryRenders).toBe(0);
    expect(seen.railLinkRenders - before.railLinkRenders).toBe(0);
  });
});
