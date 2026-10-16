import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FavoriteEntry, PlaybackPosition, RecentEntry, VodItem, WatchlistEntry } from '@/api/types';

import { installDomStubs, makeSource, renderRoutes, rpcMock, settings } from '../../test/harness';

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

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');

const snap = (title: string, contentType: 'movie' | 'series' | 'live' = 'movie') => ({ title, contentType });

function handlers() {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' }), makeSource('s2', { name: 'Backup', position: 1 })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['watchlist.list'] = (): WatchlistEntry[] => [
    { ref: { sourceId: 's1', contentType: 'movie', itemId: '50' }, snapshot: snap('Saved Film'), addedAt: '2026-10-02T00:00:00Z', watched: false },
  ];
  h['positions.continueWatching'] = (): PlaybackPosition[] => [
    { ref: { sourceId: 's1', contentType: 'movie', itemId: '10' }, positionSeconds: 1800, durationSeconds: 5400, watched: false, updatedAt: '2026-10-10T20:00:00Z', snapshot: snap('The Long Signal') },
  ];
  h['favorites.list'] = (): FavoriteEntry[] => [
    { ref: { sourceId: 's1', contentType: 'live', itemId: '1' }, addedAt: '2026-10-01T00:00:00Z', position: 0, snapshot: snap('Harbor News', 'live') },
  ];
  h['recent.list'] = (): RecentEntry[] => [
    { ref: { sourceId: 's2', contentType: 'live', itemId: '3' }, viewedAt: '2026-10-11T08:00:00Z', snapshot: snap('Metro Sport', 'live') },
  ];
  h['catalog.recentlyAdded'] = (a) =>
    (a as { contentType: string }).contentType === 'movie'
      ? ([{ ref: { sourceId: 's1', contentType: 'movie', itemId: '99' }, title: 'Fresh Arrival', added: '2026-10-09T00:00:00Z', categoryId: 'c' }] satisfies VodItem[])
      : [];
  h['epg.nowNext'] = () => ({});
  h['lists.list'] = () => [];
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeAll(installDomStubs);
beforeEach(handlers);
afterEach(cleanup);

describe('L1-sources-home-14: the dashboard asks for each list once', () => {
  it('sends every dashboard RPC once on a cold load', async () => {
    renderRoutes([{ path: '/', element: <ShellLayout />, children: shellRoutes }], '/dashboard');
    expect(await screen.findByTestId('dashboard-rail-my-list')).toBeTruthy();
    await flush();
    const counts = new Map<string, number>();
    for (const c of rpcMock.calls) {
      const k = `${c.cmd} ${JSON.stringify(c.args ?? null)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // watchlist.list was asked twice in loop 1: the My List rail re-read it with staleTime 0.
    expect(counts.get('watchlist.list {}')).toBe(1);
    const dupes = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes).toEqual([]);
  });
});
