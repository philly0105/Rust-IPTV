import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import { notifyServerAnswered } from '@/api/reachability';
import type { Settings, Theme } from '@/api/types';

import { rpcMock, settings } from './harness';

type ConnState = 'connecting' | 'open' | 'closed';

const conn = vi.hoisted(() => ({ handlers: new Set<(s: ConnState) => void>(), current: 'open' as ConnState }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onConnectionState: (h: (s: ConnState) => void) => {
    conn.handlers.add(h);
    h(conn.current);
    return () => conn.handlers.delete(h);
  },
}));

const { RpcError } = await import('@/api/transport');
const { ThemeSync, persistTheme, useThemeStore } = await import('../theme');

function setConnection(s: ConnState): void {
  act(() => {
    conn.current = s;
    for (const h of [...conn.handlers]) h(s);
  });
}

const themeWrites = () => rpcMock.calls.filter((c) => c.cmd === 'settings.update').map((c) => (c.args as { patch: { theme: Theme } }).patch.theme);
const cachedTheme = () => queryClient.getQueryData<Settings>(rpcKey('settings.get'))?.theme;
const serverDown = () => {
  rpcMock.handlers['settings.update'] = () => {
    throw new RpcError('network', 'Cannot reach the server: Failed to fetch');
  };
};
const serverUp = () => {
  rpcMock.handlers['settings.update'] = (a) => settings({ theme: (a as { patch: { theme: Theme } }).patch.theme });
};

beforeEach(() => {
  rpcMock.reset();
  queryClient.clear();
  queryClient.setQueryData(rpcKey('settings.get'), settings({ theme: 'dark' }));
  useThemeStore.getState().set('dark');
  conn.current = 'open';
});
afterEach(() => {
  cleanup();
  conn.handlers.clear();
});

describe('theme toggled while the server is down', () => {
  it('keeps the choice through the reconnect refetch and writes it again once the socket reopens', async () => {
    const view = render(<ThemeSync settingsTheme="dark" />);
    serverDown();
    // The socket has not noticed the outage yet: the state seen at subscribe time replays nothing.
    await act(() => persistTheme('light'));
    expect(useThemeStore.getState().theme).toBe('light');
    expect(themeWrites()).toEqual(['light']);

    setConnection('closed');
    setConnection('connecting');
    // The reconnect's settings refetch can land with the server's old theme: it must not flip the theme back.
    view.rerender(<ThemeSync settingsTheme="dark" />);
    expect(useThemeStore.getState().theme).toBe('light');
    expect(themeWrites()).toEqual(['light']);

    serverUp();
    setConnection('open');
    await vi.waitFor(() => expect(cachedTheme()).toBe('light'));
    expect(themeWrites()).toEqual(['light', 'light']);
    expect(useThemeStore.getState().theme).toBe('light');

    // Confirmed: the server's theme applies again (a change made in another window), and nothing replays.
    view.rerender(<ThemeSync settingsTheme="system" />);
    expect(useThemeStore.getState().theme).toBe('system');
    setConnection('closed');
    setConnection('open');
    expect(themeWrites()).toEqual(['light', 'light']);
  });

  it('replays the newest choice only, as soon as any request gets an answer', async () => {
    serverDown();
    await act(() => persistTheme('light'));
    await act(() => persistTheme('system'));
    expect(useThemeStore.getState().theme).toBe('system');

    serverUp();
    act(() => notifyServerAnswered());
    await vi.waitFor(() => expect(cachedTheme()).toBe('system'));
    expect(themeWrites()).toEqual(['light', 'system', 'system']);
    act(() => notifyServerAnswered());
    expect(themeWrites()).toHaveLength(3);
  });

  it('a write the server refused is not replayed, and the server theme applies again', async () => {
    const view = render(<ThemeSync settingsTheme="dark" />);
    rpcMock.handlers['settings.update'] = () => {
      throw new RpcError('db', 'database is locked');
    };
    await act(() => persistTheme('light'));
    expect(useThemeStore.getState().theme).toBe('light');
    setConnection('closed');
    setConnection('open');
    expect(themeWrites()).toEqual(['light']);
    view.rerender(<ThemeSync settingsTheme="system" />);
    expect(useThemeStore.getState().theme).toBe('system');
  });
});
