/**
 * The desktop app's own keys and window (the browser build is in shell.test.tsx): Ctrl+R opens
 * Recently watched there, since the app window has no reload (SH-ctrl-r-browser), and the
 * native title bar follows the app's theme (SH-titlebar-theme).
 */

import { cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDomStubs, makeSource, Page, renderRoutes, rpcMock, settings } from './harness';

configure({ asyncUtilTimeout: 4000 });

const win = vi.hoisted(() => ({ setTheme: vi.fn(async () => undefined) }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTheme: win.setTheme,
    onResized: async () => () => undefined,
    onMoved: async () => () => undefined,
    isMinimized: async () => false,
    isMaximized: async () => false,
    isFullscreen: async () => false,
    outerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: 1280, height: 800 }),
  }),
}));
vi.mock('@/features/player', () => ({
  playItem: async () => undefined,
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));
vi.mock('@/features/player/pip', () => ({ usePipStore: { getState: () => ({ active: false }) } }));

const { ShellLayout } = await import('../ShellLayout');
const { useThemeStore, resetWindowThemeForTests } = await import('../theme');
const { useShellStore } = await import('../store');

const routes = [
  {
    path: '/',
    element: <ShellLayout />,
    children: [
      { path: 'favorites', element: <Page>favorites page</Page> },
      { path: 'recent', element: <Page>recent page</Page> },
    ],
  },
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1')];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['app.pendingDeepLinks'] = () => [];
  h['window.getState'] = () => null;
  h['window.setState'] = () => null;
  win.setTheme.mockClear();
  resetWindowThemeForTests();
  useThemeStore.setState({ theme: 'dark' });
  useShellStore.setState({ paletteOpen: false, helpOpen: false });
});
afterEach(cleanup);

describe('desktop shell', () => {
  it('Ctrl+R opens Recently watched and is listed in the shortcut reference', async () => {
    const { router } = renderRoutes(routes, '/favorites');
    await screen.findByText('favorites page');
    expect(fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(router.state.location.pathname).toBe('/recent'));
    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    const overlay = await screen.findByTestId('shortcut-overlay');
    expect(overlay.querySelector('[data-combo="mod+r"]')).toBeTruthy();
  });

  it('the title bar takes the app theme, once per change', async () => {
    renderRoutes(routes, '/favorites');
    await screen.findByText('favorites page');
    await waitFor(() => expect(win.setTheme).toHaveBeenCalledWith('dark'));
    const calls = win.setTheme.mock.calls.length;
    fireEvent.click(screen.getByTestId('theme-toggle'));
    await waitFor(() => expect(win.setTheme).toHaveBeenLastCalledWith('light'));
    expect(win.setTheme.mock.calls.length).toBe(calls + 1);
  });
});
