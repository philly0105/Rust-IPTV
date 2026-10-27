import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, matchRoutes, RouterProvider, useLocation } from 'react-router';

import { queryClient, rpcKey } from '@/api/query';

import { DEFAULT_SETTINGS } from '@/api/types';
import i18n from '@/i18n';
import { useShellStore } from '@/shell';
import { startupTarget } from '@/shell/StartupRedirect';

import { RpcError } from '@/api/transport';
import { ErrorState } from '@/ui';

import { AppLoading, isKnownPath, NotFoundPage, resetChunkFailureForTests, RouteErrorPage, routeErrorAsRpc, routes, SourceIndexRedirect } from './routes';

/** Every C7 path; each must resolve to a real page, never the `*` fallback. */
const C7_PATHS = [
  '/',
  '/dashboard',
  '/sources',
  '/settings',
  '/settings/general',
  '/favorites',
  '/recent',
  '/downloads',
  '/my-videos',
  '/my-videos/abc',
  '/scheduled',
  '/my-list',
  '/multiview',
  '/lists',
  '/lists/l1',
  '/stats',
  '/sports',
  '/search',
  '/epg',
  '/live/archive/x/1',
  '/s/x',
  '/s/x/live',
  '/s/x/live/cat',
  '/s/x/radio',
  '/s/x/favorites',
  '/s/x/recent',
  '/s/x/movies',
  '/s/x/movies/c/1',
  '/s/x/series',
  '/s/x/series/c/1',
  '/s/x/movie/1',
  '/s/x/series/1',
  '/s/x/actor/1',
  '/s/x/search',
];

function leafPath(pathname: string): string | undefined {
  const matches = matchRoutes(routes, pathname);
  const leaf = matches?.[matches.length - 1];
  return leaf?.route.index ? '(index)' : leaf?.route.path;
}

describe('route tree (C7)', () => {
  it.each(C7_PATHS)('%s resolves to a page', (path) => {
    const leaf = leafPath(path);
    expect(leaf).toBeDefined();
    expect(leaf).not.toBe('*');
  });

  it('keeps params for nested source routes', () => {
    const m = matchRoutes(routes, '/s/abc/movies/c/42');
    expect(m?.at(-1)?.params).toMatchObject({ sourceId: 'abc', categoryId: '42' });
  });

  it('sends unknown paths to the not-found page inside the shell', () => {
    const m = matchRoutes(routes, '/no/such/page');
    expect(m?.[0]?.route.path).toBe('/');
    expect(m?.at(-1)?.route.path).toBe('*');
  });

  it('knows which saved paths still render a page', () => {
    expect(isKnownPath('/no/such/page')).toBe(false);
    expect(isKnownPath('/live/archive/a/ch1')).toBe(true);
    expect(isKnownPath('/lists/l1')).toBe(true);
    expect(isKnownPath('/settings/general')).toBe(true);
  });
});

describe('startup default (D22)', () => {
  it('restores the last screen by default', () => {
    expect(DEFAULT_SETTINGS.startupBehavior).toBe('restore-last-view');
    expect(startupTarget({ ...DEFAULT_SETTINGS, lastRoute: '/s/a/movies' })).toBe('/s/a/movies');
  });

  it('falls back to the dashboard on a fresh install with no saved screen', () => {
    expect(DEFAULT_SETTINGS.lastRoute).toBeUndefined();
    expect(startupTarget(DEFAULT_SETTINGS)).toBe('/dashboard');
    expect(startupTarget({ ...DEFAULT_SETTINGS, lastRoute: '/' })).toBe('/dashboard');
  });
});

describe('lazy shell', () => {
  it('loads the dashboard lazily, not in the entry chunk', () => {
    const leaf = matchRoutes(routes, '/dashboard')?.at(-1)?.route;
    expect(leaf?.lazy).toBeTypeOf('function');
    expect(leaf?.element).toBeUndefined();
  });

  it('has a hydrate fallback and error boundaries at the shell and page level', () => {
    const m = matchRoutes(routes, '/s/x/live');
    expect(m?.[0]?.route.HydrateFallback).toBe(AppLoading);
    expect(m?.[0]?.route.errorElement).toBeTruthy();
    expect(m?.[1]?.route.path).toBeUndefined();
    expect(m?.[1]?.route.errorElement).toBeTruthy();
  });
});

describe('route error page', () => {
  afterEach(cleanup);

  function Boom(): never {
    throw new Error('Failed to fetch dynamically imported module: /assets/x.js');
  }

  it('shows a retryable error with one h1 instead of a blank screen', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteErrorPage /> }]);
    render(<RouterProvider router={router} />);
    spy.mockRestore();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(i18n.t('common:errorTitleNetwork'));
    expect(screen.getByRole('button', { name: i18n.t('common:retry') })).toBeTruthy();
  });

  it('marks a failed page chunk as the server being unreachable, and titles the header', () => {
    const err = routeErrorAsRpc(new Error('Failed to fetch dynamically imported module: /assets/x.js'));
    expect(err.code).toBe('network');
    expect(err.details).toEqual({ transport: 'unreachable' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteErrorPage /> }]);
    render(<RouterProvider router={router} />);
    spy.mockRestore();
    expect(useShellStore.getState().header?.title).toBe(i18n.t('common:errorTitleNetwork'));
    resetChunkFailureForTests();
  });

  it('offers no Retry for something that is not there', () => {
    render(<ErrorState error={new RpcError('not_found', 'gone', false)} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: i18n.t('common:retry') })).toBeNull();
    cleanup();
    render(<ErrorState error={new RpcError('internal', 'boom', false)} onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: i18n.t('common:retry') })).toBeTruthy();
  });

  it('renders the loading frame without text', () => {
    render(<AppLoading />);
    expect(screen.getByTestId('app-loading').textContent).toBe('');
  });
});

describe('not-found page', () => {
  afterEach(cleanup);

  function renderNotFound(path = '/definitely-missing') {
    const router = createMemoryRouter([{ path: '*', element: <NotFoundPage /> }], { initialEntries: [path] });
    return render(<RouterProvider router={router} />);
  }

  it('has exactly one h1, carrying the translated title', () => {
    renderNotFound();
    const title = i18n.t('common:pageNotFound');
    expect(title).toBe('Page not found');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe(title);
  });

  it('keeps the visible hint, the way home, and the shell header title', () => {
    renderNotFound();
    expect(screen.getByText(i18n.t('common:pageNotFoundHint'))).toBeTruthy();
    // A phone has a tab bar and no rail: the hint names neither.
    expect(i18n.t('common:pageNotFoundHint')).not.toMatch(/\brail\b|sidebar/i);
    expect(screen.getByRole('link', { name: i18n.t('shell:navDashboard') }).getAttribute('href')).toBe('/dashboard');
    expect(useShellStore.getState().header?.title).toBe(i18n.t('common:errorTitleNotFound'));
  });
});

describe('source root redirect (F-VOD-ONLY-SOURCE)', () => {
  function Where() {
    return <p>{useLocation().pathname}</p>;
  }
  const open = (path: string) => {
    const router = createMemoryRouter(
      [
        { path: '/s/:sourceId', element: <SourceIndexRedirect /> },
        { path: '/s/:sourceId/:section', element: <Where /> },
      ],
      { initialEntries: [path] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  };
  const source = (id: string, channelCount: number, movieCount: number, seriesCount: number) => ({ id, kind: 'xtream', name: id, channelCount, movieCount, seriesCount, radioCount: 0 });
  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('opens a source on Live, or on Movies or Series when it has no live channels', async () => {
    queryClient.setQueryData(rpcKey('sources.list'), [source('tv', 5, 9, 0), source('vod', 0, 9, 3), source('shows', 0, 0, 3)]);
    open('/s/vod');
    expect(await screen.findByText('/s/vod/movies')).toBeTruthy();
    cleanup();
    open('/s/shows');
    expect(await screen.findByText('/s/shows/series')).toBeTruthy();
    cleanup();
    open('/s/tv');
    expect(await screen.findByText('/s/tv/live')).toBeTruthy();
    cleanup();
    // A source the list does not know opens Live as before.
    open('/s/gone');
    expect(await screen.findByText('/s/gone/live')).toBeTruthy();
  });
});
