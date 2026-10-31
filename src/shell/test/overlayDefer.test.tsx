/**
 * The command palette (with cmdk) and the `?` overlay stay out of the shell's first render: their
 * modules load on the player's schedule or when they first open, and once open they stay mounted.
 * This file has its own module graph, so the two modules start unloaded; the tests run in order.
 */
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDomStubs, Page, renderRoutes, rpcMock, settings } from './harness';

configure({ asyncUtilTimeout: 4000 });

const loads = vi.hoisted(() => ({ palette: 0, overlay: 0, paletteMounts: 0 }));

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
vi.mock('@/features/player', () => ({ playItem: async () => {} }));
vi.mock('@/features/player/dock', () => ({
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));
vi.mock('../CommandPalette', async () => {
  loads.palette += 1;
  const { useShellStore } = await import('../store');
  return {
    CommandPalette: function CommandPalette() {
      const open = useShellStore((s) => s.paletteOpen);
      useEffect(() => {
        loads.paletteMounts += 1;
      }, []);
      return open ? <div data-testid="command-palette" /> : null;
    },
  };
});
vi.mock('../ShortcutOverlay', async () => {
  loads.overlay += 1;
  const { useShellStore } = await import('../store');
  return { ShortcutOverlay: () => (useShellStore((s) => s.helpOpen) ? <div data-testid="shortcut-overlay" /> : null) };
});

const { ShellLayout, openPalette, openShortcutHelp } = await import('../ShellLayout');
const { useShellStore } = await import('../store');

const routes = () => [{ path: '/', element: <ShellLayout />, children: [{ path: 'favorites', element: <Page>page body</Page> }] }];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['settings.update'] = (a) => settings((a as { patch: object }).patch);
  rpcMock.handlers['sources.list'] = () => [];
  useShellStore.setState({ paletteOpen: false, helpOpen: false });
});
afterEach(cleanup);

describe('the palette and the shortcut overlay wait until they are wanted', () => {
  it('the shell renders without loading either module', async () => {
    renderRoutes(routes(), '/favorites');
    expect(await screen.findByText('page body')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(loads).toMatchObject({ palette: 0, overlay: 0 });
  });

  it('the first press warms both modules without mounting either', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('page body');
    fireEvent.pointerDown(window);
    await waitFor(() => expect(loads).toMatchObject({ palette: 1, overlay: 1 }));
    expect(loads.paletteMounts).toBe(0);
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('the palette mounts on its first open and stays mounted while closed', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('page body');
    act(() => openPalette());
    expect(await screen.findByTestId('command-palette')).toBeTruthy();
    act(() => useShellStore.getState().setPaletteOpen(false));
    expect(screen.queryByTestId('command-palette')).toBeNull();
    act(() => openPalette());
    expect(await screen.findByTestId('command-palette')).toBeTruthy();
    expect(loads.paletteMounts).toBe(1);
  });

  it('the shortcut overlay mounts on its first open', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('page body');
    expect(screen.queryByTestId('shortcut-overlay')).toBeNull();
    act(() => openShortcutHelp());
    expect(await screen.findByTestId('shortcut-overlay')).toBeTruthy();
  });
});
