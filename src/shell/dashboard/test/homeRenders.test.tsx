/**
 * Performance audit SH-1 and SH-4: what an update re-renders.
 *
 * - SH-4: each Home rail is memoized with stable props, so an answer for one rail re-renders that
 *   rail's cards, not every rail's.
 * - SH-1: the shell's router and settings readers live in leaf components, so a navigation (a
 *   typed `?q=` included) and a settings write (the `lastRoute` save) leave ShellLayout, and the
 *   player dock under it, alone.
 */
import { configure, act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { homeRecentArgs } from '@/api/bootPrefetch';
import { queryClient, rpcKey } from '@/api/query';
import type { FavoriteEntry, PlaybackPosition, RecentEntry, VodItem, WatchlistEntry } from '@/api/types';

import { installDomStubs, makeSource, renderRoutes, rpcMock, settings } from '../../test/harness';

// The whole shell renders here, with Home and its lazy overlays (palette, shortcut help): a cold
// first render under a loaded full-suite run can pass the 1 s default.
configure({ asyncUtilTimeout: 4000 });

const counts = vi.hoisted(() => ({ cards: new Map<string, number>(), dock: 0 }));

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
  PlayerDock: () => {
    counts.dock++;
    return null;
  },
  ExternalPlaybackFooter: () => null,
}));
// Counts each card's renders by its title; the real card renders underneath.
vi.mock('../cards', async (orig) => {
  const real = await orig<typeof import('../cards')>();
  const { createElement } = await import('react');
  const seen = (title: string) => counts.cards.set(title, (counts.cards.get(title) ?? 0) + 1);
  return {
    ...real,
    PosterCard: (p: Parameters<typeof real.PosterCard>[0]) => (seen(p.title), createElement(real.PosterCard, p)),
    ChannelCard: (p: Parameters<typeof real.ChannelCard>[0]) => (seen(p.name), createElement(real.ChannelCard, p)),
    ContinueCard: (p: Parameters<typeof real.ContinueCard>[0]) => (seen(p.title), createElement(real.ContinueCard, p)),
    OnNowCard: (p: Parameters<typeof real.OnNowCard>[0]) => (seen(`on now: ${p.channelName}`), createElement(real.OnNowCard, p)),
  };
});

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');

const snap = (title: string, contentType: 'movie' | 'series' | 'live' = 'movie') => ({ title, contentType });
const recentEntry = (itemId: string, title: string, viewedAt: string): RecentEntry => ({
  ref: { sourceId: 's2', contentType: 'live', itemId },
  viewedAt,
  snapshot: snap(title, 'live'),
});

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
  h['recent.list'] = (): RecentEntry[] => [recentEntry('3', 'Metro Sport', '2026-10-11T08:00:00Z')];
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

function renderHome() {
  return renderRoutes([{ path: '/', element: <ShellLayout />, children: shellRoutes }], '/dashboard');
}

beforeAll(installDomStubs);
beforeEach(() => {
  handlers();
  counts.cards.clear();
  counts.dock = 0;
});
afterEach(cleanup);

describe('Home rails (SH-4)', () => {
  it("an answer for one rail re-renders that rail's cards only", async () => {
    renderHome();
    expect(await screen.findByText('Metro Sport')).toBeTruthy();
    expect(await screen.findByText('Saved Film')).toBeTruthy();
    await flush();
    const before = new Map(counts.cards);
    for (const title of ['The Long Signal', 'Harbor News', 'Fresh Arrival', 'Saved Film']) expect(before.get(title), title).toBeGreaterThan(0);

    await act(async () => {
      queryClient.setQueryData(rpcKey('recent.list', homeRecentArgs()), [
        recentEntry('4', 'City FM', '2026-10-12T08:00:00Z'),
        recentEntry('3', 'Metro Sport', '2026-10-11T08:00:00Z'),
      ]);
    });
    await flush();

    expect(await screen.findByText('City FM')).toBeTruthy();
    expect(counts.cards.get('Metro Sport')).toBeGreaterThan(before.get('Metro Sport')!);
    for (const title of ['The Long Signal', 'Harbor News', 'Fresh Arrival', 'Saved Film']) {
      expect(counts.cards.get(title), title).toBe(before.get(title));
    }
  });
});

describe('the shell (SH-1)', () => {
  it('a navigation and a settings write leave the shell and the player dock alone', async () => {
    const { router } = renderHome();
    expect(await screen.findByTestId('dashboard')).toBeTruthy();
    // The first press loads the player module (schedulePlayerLoad).
    fireEvent.pointerDown(window);
    await flush();
    expect(counts.dock).toBeGreaterThan(0);
    const dock = counts.dock;

    // A query-only change on the same screen, as typing in a page's search field writes.
    await act(async () => {
      await router.navigate('/dashboard?q=a');
    });
    await flush();
    // The lastRoute save's answer lands in the settings cache.
    await act(async () => {
      queryClient.setQueryData(rpcKey('settings.get'), settings({ lastRoute: '/dashboard?q=a' }));
    });
    await flush();

    expect(router.state.location.search).toBe('?q=a');
    expect(counts.dock).toBe(dock);
  });
});
