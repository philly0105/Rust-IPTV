/**
 * Keys typed right after Ctrl+K, while the palette's lazy chunk is still loading (v-shell-home-04,
 * w-a11y-05): they land in the palette's field and never reach the page's own shortcuts.
 */
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDomStubs, Page, renderRoutes, rpcMock, settings } from './harness';

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

// The palette's chunk arrives only when the test lets it: a slow first download.
let release: () => void = () => undefined;
const arrived = new Promise<void>((resolve) => {
  release = resolve;
});
vi.mock('../CommandPalette', async (orig) => {
  await arrived;
  return orig();
});

const { ShellLayout } = await import('../ShellLayout');
const { useShortcut } = await import('../shortcuts');
const { useShellStore } = await import('../store');

const pageKeys = vi.fn();
function ShortcutPage() {
  // A page shortcut on a letter, as Live's "s" (favourite) and "e" are.
  useShortcut('s', () => pageKeys('s'), { description: 'star', area: 'Page' });
  useShortcut('e', () => pageKeys('e'), { description: 'edit', area: 'Page' });
  return <Page>shortcut page</Page>;
}

const routes = [
  {
    path: '/',
    element: <ShellLayout />,
    children: [{ path: 'favorites', element: <ShortcutPage /> }],
  },
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  pageKeys.mockClear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false });
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['sources.list'] = () => [];
  h['catalog.search'] = () => ({ live: [], movies: [], series: [] });
  h['epg.search'] = () => [];
  h['favorites.list'] = () => [];
  h['recent.list'] = () => [];
});
afterEach(cleanup);

describe('keys typed right after Ctrl+K', () => {
  it('wait for the palette chunk, land in its field, and never run the page shortcuts', async () => {
    renderRoutes(routes, '/favorites');
    await screen.findByText('shortcut page');
    // Typed at once, while the palette's chunk is still on its way.
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
    for (const key of ['e', 's', 'x', 'Backspace', 'p', 'n']) fireEvent.keyDown(document.body, { key });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(pageKeys).not.toHaveBeenCalled();
    release();
    const input = (await screen.findByRole('combobox')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('espn'));
    expect(document.activeElement).toBe(input);
    expect(pageKeys).not.toHaveBeenCalled();

    // Closed, the page's shortcuts work again, and the next open starts empty.
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(useShellStore.getState().paletteOpen).toBe(false));
    fireEvent.keyDown(document.body, { key: 's' });
    expect(pageKeys).toHaveBeenCalledWith('s');
    act(() => useShellStore.getState().setPaletteOpen(true));
    expect(((await screen.findByRole('combobox')) as HTMLInputElement).value).toBe('');
  });
});
