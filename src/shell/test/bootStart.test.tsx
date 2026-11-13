import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { Outlet, type RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { makeSource, rpcMock, settings } from './harness';

// BOOT-1: main.tsx starts the router at the startup target, so a cold start at `/` renders the
// target page in its first render instead of the index route and a redirect.
const env = vi.hoisted(() => ({ desktop: false, indexRenders: 0, prefetched: [] as string[] }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return env.desktop;
  },
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));
vi.mock('@/i18n', () => ({ initI18n: async () => undefined }));
vi.mock('@/api/images', () => ({ imageBaseReady: async () => undefined }));
vi.mock('@/api/window', () => ({ bindWindowFullscreen: () => undefined }));
vi.mock('@/api/bootPrefetch', () => ({ prefetchScreenData: (path: string) => void env.prefetched.push(path) }));
// The app's route tree, cut down to plain pages; the index route is the real StartupRedirect.
vi.mock('@/routes', async () => {
  const { createBrowserRouter, matchRoutes } = await import('react-router');
  const { StartupRedirect } = await import('@/shell/StartupRedirect');
  const page = (text: string) => () => <div>{text}</div>;
  function Index() {
    env.indexRenders++;
    return <StartupRedirect isKnownPath={isKnownPath} />;
  }
  const routes: RouteObject[] = [
    {
      path: '/',
      element: <Outlet />,
      children: [
        { index: true, element: <Index /> },
        // Lazy like the real Home: the first render waits for its module.
        { path: 'dashboard', lazy: async () => ({ Component: page('home page') }) },
        { path: 'sources', Component: page('sources page') },
        { path: 'favorites', Component: page('favorites page') },
        { path: 'search', Component: page('search page') },
        { path: 's/:sourceId/movies', Component: page('movies page') },
        { path: 'lists/:id', Component: page('list page') },
        { path: '*', Component: page('not found') },
      ],
    },
  ];
  function isKnownPath(pathname: string): boolean {
    const leaf = matchRoutes(routes, pathname)?.at(-1)?.route;
    return !!leaf && leaf.path !== '*';
  }
  return { isKnownPath, preloadRoute: () => undefined, createAppRouter: () => createBrowserRouter(routes) };
});

/** Loads main.tsx afresh at `path` and waits for `text`; returns the history length before it. */
async function boot(path: string, text: string): Promise<number> {
  window.history.replaceState(null, '', path);
  const before = window.history.length;
  vi.resetModules();
  await act(async () => {
    await import('@/main');
  });
  expect(await screen.findByText(text, undefined, { timeout: 3000 })).toBeTruthy();
  return before;
}

beforeEach(() => {
  rpcMock.reset();
  env.desktop = false;
  env.indexRenders = 0;
  env.prefetched.length = 0;
  rpcMock.handlers['sources.list'] = () => [makeSource('s1')];
  rpcMock.handlers['lists.list'] = () => [{ id: 'l1', name: 'L', count: 0 }];
  rpcMock.handlers['settings.update'] = (a) => settings((a as { patch: Partial<Settings> }).patch);
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
});
afterEach(() => {
  cleanup();
  document.getElementById('root')?.remove();
});

describe('BOOT-1: the router starts at the startup target', () => {
  it('opens the saved screen from `/` without rendering the index route, replacing the `/` entry', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/favorites' });
    const before = await boot('/', 'favorites page');
    expect(window.location.pathname).toBe('/favorites');
    expect(env.indexRenders).toBe(0);
    // Replaced, not pushed: Back leaves the app as it did after StartupRedirect's replace.
    expect(window.history.length).toBe(before);
    expect(env.prefetched).toContain('/favorites');
    expect(rpcMock.calls.filter((c) => c.cmd === 'settings.update')).toHaveLength(0);
  });

  it('opens Home, a lazy route, from `/` on a fresh install (the welcome is on Home)', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ lastRoute: '' });
    rpcMock.handlers['sources.list'] = () => [];
    const before = await boot('/', 'home page');
    expect(window.location.pathname).toBe('/dashboard');
    expect(env.indexRenders).toBe(0);
    expect(window.history.length).toBe(before);
  });

  it('opens Sources when Home is off and nothing is saved', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ lastRoute: '', showDashboard: false });
    await boot('/', 'sources page');
    expect(window.location.pathname).toBe('/sources');
  });

  it('keeps the query of a saved screen, and checks its source first', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/s/s1/movies?sort=az' });
    await boot('/', 'movies page');
    expect(window.location.pathname + window.location.search).toBe('/s/s1/movies?sort=az');
    expect(env.indexRenders).toBe(0);
  });

  it('goes to the default target and forgets a saved screen whose source is gone', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/s/gone/movies' });
    await boot('/', 'home page');
    expect(window.location.pathname).toBe('/dashboard');
    await waitFor(() => expect(rpcMock.calls.find((c) => c.cmd === 'settings.update')?.args).toEqual({ patch: { lastRoute: '/dashboard' } }));
  });

  it('drops a deleted custom list as StartupRedirect does', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/lists/l9' });
    await boot('/', 'home page');
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('opens Home instead of the saved screen when startup is set to Home', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'first-view', lastRoute: '/favorites' });
    await boot('/', 'home page');
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('never replaces a typed URL with the startup page', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/favorites' });
    const before = await boot('/search?q=news', 'search page');
    expect(window.location.pathname + window.location.search).toBe('/search?q=news');
    expect(env.indexRenders).toBe(0);
    expect(window.history.length).toBe(before);
    expect(env.prefetched).toEqual(['/search?q=news']);
  });

  it('starts at `/` and lets StartupRedirect decide when the settings come too late', async () => {
    let answer!: (s: Settings) => void;
    rpcMock.handlers['settings.get'] = () => new Promise<Settings>((r) => (answer = r));
    window.history.replaceState(null, '', '/');
    const before = window.history.length;
    vi.resetModules();
    await act(async () => {
      await import('@/main');
    });
    expect(await screen.findByTestId('startup-pending', undefined, { timeout: 3000 })).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    await act(async () => answer(settings({ startupBehavior: 'restore-last-view', lastRoute: '/favorites' })));
    expect(await screen.findByText('favorites page')).toBeTruthy();
    expect(window.location.pathname).toBe('/favorites');
    expect(window.history.length).toBe(before);
  });

  it('starts at `/` when settings fail, and StartupRedirect falls back to Home', async () => {
    rpcMock.handlers['settings.get'] = () => Promise.reject(new Error('down'));
    await boot('/', 'home page');
    expect(window.location.pathname).toBe('/dashboard');
    expect(env.indexRenders).toBeGreaterThan(0);
  });

  it('desktop: a link that launched the app wins over the saved screen, and is handled once', async () => {
    env.desktop = true;
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/favorites' });
    rpcMock.handlers['app.pendingDeepLinks'] = () => ['iptv://search?q=x'];
    const before = await boot('/', 'search page');
    expect(window.location.pathname + window.location.search).toBe('/search?q=x');
    expect(env.indexRenders).toBe(0);
    expect(window.history.length).toBe(before);
    const { pendingStartupDeepLink } = await import('@/shell/effects');
    expect(pendingStartupDeepLink()).toBeNull();
    expect(rpcMock.calls.filter((c) => c.cmd === 'app.pendingDeepLinks')).toHaveLength(1);
  });
});
