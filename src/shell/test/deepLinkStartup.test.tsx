import { act, cleanup, screen } from '@testing-library/react';
import { Outlet, type RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { renderRoutes, rpcMock, settings } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const { useShellEvents, resetStartupDeepLinkForTests } = await import('../effects');
const { StartupRedirect } = await import('../StartupRedirect');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Just the shell pieces in the race: the event hook and the index redirect. */
function Layout() {
  useShellEvents();
  return <Outlet />;
}

function routes(searchChunk: Promise<void>): RouteObject[] {
  return [
    {
      path: '/',
      element: <Layout />,
      children: [
        { index: true, element: <StartupRedirect /> },
        { path: 'dashboard', element: <div>dashboard page</div> },
        { path: 'favorites', element: <div>favorites page</div> },
        {
          // Lazy like the real /search route: navigation stays pending while the chunk loads.
          path: 'search',
          lazy: async () => {
            await searchChunk;
            return { Component: () => <div>search page</div> };
          },
        },
      ],
    },
  ];
}

const flush = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
});

beforeEach(() => {
  rpcMock.reset();
  resetStartupDeepLinkForTests();
});
afterEach(cleanup);

describe('cold-start deep link', () => {
  it('lands on a lazy deep-link route even when settings resolve after the pull', async () => {
    const links = deferred<string[]>();
    const settingsGate = deferred<Settings>();
    const chunk = deferred<void>();
    rpcMock.handlers['app.pendingDeepLinks'] = () => links.promise;
    rpcMock.handlers['settings.get'] = () => settingsGate.promise;
    rpcMock.handlers['settings.update'] = (a) => settings((a as { patch: Partial<Settings> }).patch);

    const { router } = renderRoutes(routes(chunk.promise), '/');
    await flush();
    links.resolve(['iptv://search?q=x']);
    await flush();
    settingsGate.resolve(settings({ showDashboard: true }));
    await flush();
    chunk.resolve();

    expect(await screen.findByText('search page')).toBeTruthy();
    await flush();
    expect(router.state.location.pathname + router.state.location.search).toBe('/search?q=x');
    expect(screen.queryByText('dashboard page')).toBeNull();
    expect(rpcMock.calls.filter((c) => c.cmd === 'app.pendingDeepLinks')).toHaveLength(1);
  });

  it('keeps the skeleton until the pull answers when settings are already there', async () => {
    const links = deferred<string[]>();
    const chunk = deferred<void>();
    rpcMock.handlers['app.pendingDeepLinks'] = () => links.promise;
    rpcMock.handlers['settings.get'] = () => settings({ showDashboard: true });

    const { router } = renderRoutes(routes(chunk.promise), '/');
    await flush();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByText('dashboard page')).toBeNull();
    links.resolve(['iptv://search?q=late']);
    chunk.resolve();
    expect(await screen.findByText('search page')).toBeTruthy();
    expect(router.state.location.search).toBe('?q=late');
  });

  it('falls back to the startup target when no link is pending', async () => {
    rpcMock.handlers['app.pendingDeepLinks'] = () => [];
    rpcMock.handlers['settings.get'] = () => settings({ showDashboard: true });
    renderRoutes(routes(Promise.resolve()), '/');
    expect(await screen.findByText('dashboard page')).toBeTruthy();
  });

  it('navigates from the shell when the app did not start at the index route', async () => {
    rpcMock.handlers['app.pendingDeepLinks'] = () => ['iptv://search?q=reload'];
    rpcMock.handlers['settings.get'] = () => settings();
    const { router } = renderRoutes(routes(Promise.resolve()), '/favorites');
    expect(await screen.findByText('search page')).toBeTruthy();
    expect(router.state.location.search).toBe('?q=reload');
  });

  it('uses the link once: a later visit to / goes to the startup target', async () => {
    rpcMock.handlers['app.pendingDeepLinks'] = () => ['iptv://search?q=once'];
    rpcMock.handlers['settings.get'] = () => settings({ showDashboard: true });
    const { router } = renderRoutes(routes(Promise.resolve()), '/');
    expect(await screen.findByText('search page')).toBeTruthy();
    await act(() => router.navigate('/'));
    expect(await screen.findByText('dashboard page')).toBeTruthy();
  });
});
