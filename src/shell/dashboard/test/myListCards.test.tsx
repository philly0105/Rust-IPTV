/** V1-9: dashboard rail posters carry My List (C3): the toggle beside a linked card, the saved marker on a play card, nothing on live. */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FavoriteEntry, PlaybackPosition, WatchlistEntry } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from '../../test/harness';

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
  playItem: (...a: unknown[]) => (playerMock.playItem as (...x: unknown[]) => Promise<void>)(...a),
  restorePlayback: async () => false,
  PlayerDock: () => <div data-testid="player-dock" />,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');
const { queryClient } = await import('@/api/query');

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [...shellRoutes, { path: 's/:sourceId/*', element: <Page>source page</Page> }],
    },
  ];
}

const savedRef = { sourceId: 's1', contentType: 'movie' as const, itemId: 'm1' };
const otherRef = { sourceId: 's1', contentType: 'movie' as const, itemId: 'm2' };
const liveRef = { sourceId: 's1', contentType: 'live' as const, itemId: 'c1' };

function favorite(ref: FavoriteEntry['ref'], title: string): FavoriteEntry {
  return { ref, addedAt: '2026-10-12T00:00:00Z', position: 0, snapshot: { title, contentType: ref.contentType } };
}

function dashboard(list: () => unknown) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = (): PlaybackPosition[] => [
    {
      ref: savedRef,
      positionSeconds: 1200,
      durationSeconds: 4800,
      updatedAt: '2026-10-12T00:00:00Z',
      watched: false,
      snapshot: { title: 'Saved Film', contentType: 'movie' },
    },
  ];
  h['favorites.list'] = () => [favorite(savedRef, 'Saved Film'), favorite(otherRef, 'Other Film'), favorite(liveRef, 'News 24')];
  h['recent.list'] = () => [];
  h['catalog.recentlyAdded'] = () => [];
  h['epg.nowNext'] = () => ({});
  h['watchlist.list'] = list;
}

const savedEntry: WatchlistEntry = {
  ref: savedRef,
  snapshot: { title: 'Saved Film', contentType: 'movie' },
  addedAt: '2026-10-12T00:00:00Z',
  watched: false,
} as WatchlistEntry;

beforeAll(installDomStubs);
beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe('dashboard rail posters and My List', () => {
  it('a linked movie card has the toggle beside its link, pressed and on show once saved', async () => {
    dashboard(() => [savedEntry]);
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-favorite-vod');
    const savedLink = await within(rail).findByRole('link', { name: /Saved Film/ });
    const otherLink = within(rail).getByRole('link', { name: /Other Film/ });

    // Beside the link, not inside it (axe nested-interactive).
    expect(rail.querySelectorAll('a button, a [role="button"]')).toHaveLength(0);
    const savedToggle = within(savedLink.parentElement!).getByRole('button', { name: 'Save Saved Film to My List' });
    const otherToggle = within(otherLink.parentElement!).getByRole('button', { name: 'Save Other Film to My List' });
    expect(savedLink.contains(savedToggle)).toBe(false);

    // The saved marker: pressed, accent, and always on show.
    await waitFor(() => expect(savedToggle.getAttribute('aria-pressed')).toBe('true'));
    expect(savedToggle.hasAttribute('data-in-list')).toBe(true);
    expect(otherToggle.getAttribute('aria-pressed')).toBe('false');
    expect(otherToggle.hasAttribute('data-in-list')).toBe(false);

    // One Tab stop per rail: only the card holding it offers its toggle.
    expect(savedLink.getAttribute('tabindex')).toBe('0');
    expect(savedToggle.getAttribute('tabindex')).toBe('0');
    expect(otherToggle.getAttribute('tabindex')).toBe('-1');
  });

  it('the My List rail cards get the toggle too, from their detail links', async () => {
    dashboard(() => [savedEntry]);
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-my-list');
    const toggle = await within(rail).findByRole('button', { name: 'Save Saved Film to My List' });
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
  });

  it('a Continue watching card of a saved title shows the saved marker inside its play button', async () => {
    dashboard(() => [savedEntry]);
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    const card = await within(rail).findByRole('button', { name: /In My List/ });
    expect(within(card).getByTestId('mylist-saved-marker').getAttribute('aria-hidden')).toBe('true');
    expect(within(rail).queryByTestId('mylist-button')).toBeNull();
  });

  it('a title not in the list gets no marker', async () => {
    dashboard(() => []);
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    await within(rail).findByRole('button', { name: /Saved Film/ });
    expect(within(rail).queryByTestId('mylist-saved-marker')).toBeNull();
  });

  it('a live channel card gets neither the toggle nor the marker', async () => {
    dashboard(() => [savedEntry]);
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-live-favorites');
    await within(rail).findByText('News 24');
    // Let the list arrive first, so the absence is not just "still loading".
    const vod = await screen.findByTestId('dashboard-rail-favorite-vod');
    await waitFor(() => expect(within(vod).getByRole('button', { name: 'Save Saved Film to My List' }).getAttribute('aria-pressed')).toBe('true'));
    expect(within(rail).queryByTestId('mylist-button')).toBeNull();
    expect(within(rail).queryByTestId('mylist-saved-marker')).toBeNull();
  });
});
