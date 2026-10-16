import { act, cleanup, screen } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSource, renderRoutes, rpcMock, settings } from './harness';

// L2-shell-4: the dashboard chunk graph downloads only when startup lands on the dashboard.
const dashboard = vi.hoisted(() => ({ loads: 0 }));

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
// Evaluated on its first import only, so `loads` counts the chunk download.
vi.mock('../dashboard/DashboardPage', () => {
  dashboard.loads += 1;
  return { DashboardPage: () => <div>real dashboard</div> };
});

const { StartupRedirect } = await import('../StartupRedirect');

/** The index redirect plus plain pages, so only the startup prefetch can import the dashboard. */
const routes: RouteObject[] = [
  {
    path: '/',
    children: [
      { index: true, element: <StartupRedirect /> },
      { path: 'dashboard', element: <div>dashboard page</div> },
      { path: 'settings/*', element: <div>settings page</div> },
      { path: 's/:sourceId/*', element: <div>source page</div> },
    ],
  },
];

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['sources.list'] = () => [makeSource('s1')];
  rpcMock.handlers['settings.update'] = () => settings();
});
afterEach(cleanup);

// In this order: the module registry keeps the dashboard once a test imported it.
describe('L2-shell-4: startup prefetches the dashboard only when it goes there', () => {
  it('restoring a settings screen does not download the dashboard', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/settings/general' });
    renderRoutes(routes, '/');
    expect(await screen.findByText('settings page')).toBeTruthy();
    await flush();
    expect(dashboard.loads).toBe(0);
  });

  it('restoring a source screen does not download it, before or after the source check', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/s/s1/live' });
    renderRoutes(routes, '/');
    expect(await screen.findByText('source page')).toBeTruthy();
    await flush();
    expect(dashboard.loads).toBe(0);
  });

  it('downloads it when startup lands on the dashboard', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ showDashboard: true });
    renderRoutes(routes, '/');
    expect(await screen.findByText('dashboard page')).toBeTruthy();
    await flush();
    expect(dashboard.loads).toBe(1);
  });
});

describe('a saved screen of a removed source (XB2 lastRoute)', () => {
  it('lands on the dashboard and puts the forgotten route into the settings cache', async () => {
    const { queryClient, rpcKey } = await import('@/api/query');
    rpcMock.handlers['settings.get'] = () => settings({ startupBehavior: 'restore-last-view', lastRoute: '/s/gone/live', showDashboard: true });
    rpcMock.handlers['settings.update'] = (a) =>
      settings({ startupBehavior: 'restore-last-view', showDashboard: true, ...(a as { patch: object }).patch });
    renderRoutes(routes, '/');
    expect(await screen.findByText('dashboard page')).toBeTruthy();
    await flush();
    expect(rpcMock.calls.filter((c) => c.cmd === 'settings.update').map((c) => c.args)).toEqual([{ patch: { lastRoute: '/dashboard' } }]);
    expect(queryClient.getQueryData<{ lastRoute?: string }>(rpcKey('settings.get'))?.lastRoute).toBe('/dashboard');
  });
});
