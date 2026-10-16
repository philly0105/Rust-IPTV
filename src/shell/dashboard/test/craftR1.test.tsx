/** Run 1 craft fixes in the shell: the dashboard quiet state and My List (C3), the rail's Home glyph, the phone-width header search. */

import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WatchlistEntry } from '@/api/types';

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
const { RpcError } = await import('@/api/transport');
const { useShell } = await import('../../store');
const { useEffect, useState } = await import('react');

/** A page that puts its search in the header, as My List does. */
function SearchPage() {
  const shell = useShell();
  const [value, setValue] = useState('');
  useEffect(() => {
    shell.setHeader({ title: 'My List', search: { value, onChange: setValue, placeholder: 'Search My List' } });
  }, [shell, value]);
  return <Page>list page</Page>;
}

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        ...shellRoutes,
        { path: 'header-search', element: <SearchPage /> },
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
      ],
    },
  ];
}

const QUIET = 'Nothing to show yet';

function saved(id: string): WatchlistEntry {
  return {
    ref: { sourceId: 's1', contentType: 'movie', itemId: id },
    snapshot: { title: `Saved ${id}`, contentType: 'movie' },
    addedAt: '2026-10-12T00:00:00Z',
    watched: false,
  } as WatchlistEntry;
}

/** A source with nothing watched, no favourites and no new arrivals: only My List can fill the page. */
function emptyDashboard(list: () => unknown) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = () => [];
  h['favorites.list'] = () => [];
  h['recent.list'] = () => [];
  h['catalog.recentlyAdded'] = () => [];
  h['watchlist.list'] = list;
}

beforeAll(installDomStubs);
beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe('dashboard quiet state and My List', () => {
  it('a My List rail with titles is content: no "Nothing to show yet" under it', async () => {
    emptyDashboard(() => [saved('1'), saved('2')]);
    renderRoutes(routes(), '/dashboard');
    expect(await screen.findByText('Saved 1')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(QUIET)).toBeNull();
  });

  it('waits for My List before calling the page empty', async () => {
    emptyDashboard(() => new Promise(() => {}));
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-rail-recent-sources');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(QUIET)).toBeNull();
  });

  it('an empty My List still leaves the quiet state', async () => {
    emptyDashboard(() => []);
    renderRoutes(routes(), '/dashboard');
    expect(await screen.findByText(QUIET)).toBeTruthy();
  });

  it('a failed My List shows its error instead of the quiet state', async () => {
    emptyDashboard(() => {
      throw new RpcError('internal', 'watchlist table is gone');
    });
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-rail-recent-sources');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText(QUIET)).toBeNull();
  });

  it('server gone: one shared error, My List quiet behind it, and the one retry reloads My List too', async () => {
    let fail = true;
    emptyDashboard(() => {
      if (fail) throw { code: 'network', message: 'down' };
      return [saved('1')];
    });
    const h = rpcMock.handlers;
    for (const cmd of ['positions.continueWatching', 'favorites.list', 'recent.list', 'catalog.recentlyAdded']) {
      h[cmd] = () => {
        if (fail) throw { code: 'network', message: 'down' };
        return [];
      };
    }
    renderRoutes(routes(), '/dashboard');
    await screen.findByTestId('dashboard-error');
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(screen.queryByText(QUIET)).toBeNull();
    fail = false;
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(await screen.findByText('Saved 1')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-error')).toBeNull();
  });

  it('a switched-off My List does not count, even with titles in it', async () => {
    emptyDashboard(() => [saved('1')]);
    rpcMock.handlers['settings.get'] = () => settings({ dashboardRails: { ...settings().dashboardRails, myList: false } });
    renderRoutes(routes(), '/dashboard');
    expect(await screen.findByText(QUIET)).toBeTruthy();
    expect(screen.queryByText('Saved 1')).toBeNull();
  });
});

describe('rail glyphs', () => {
  it('Home and Multi-view use different glyphs, so the icon-only rail tells them apart', async () => {
    emptyDashboard(() => []);
    renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const home = within(nav).getByRole('link', { name: 'Home' }).querySelector('svg')!;
    const multiview = within(nav).getByRole('link', { name: 'Multi-view' }).querySelector('svg')!;
    expect(home.classList.contains('lucide-house')).toBe(true);
    expect(multiview.classList.contains('lucide-layout-grid')).toBe(true);
  });
});

describe('header search below sm', () => {
  it('folds into a search button that unfolds over the title while in use', async () => {
    emptyDashboard(() => []);
    renderRoutes(routes(), '/header-search');
    const field = await screen.findByRole('searchbox', { name: 'Search My List' });
    // Still the real input (Tab, click and Ctrl+F reach it); only its box folds.
    expect(field.hasAttribute('data-shell-search')).toBe(true);
    const box = field.parentElement!;
    expect(box.className).toContain('max-sm:w-8');
    expect(box.className).toContain('max-sm:focus-within:flex-1');
    expect(box.className).toContain('sm:w-[clamp(12rem,28vw,25rem)]');
    // The title yields to the search only while it is focused or holds a query.
    const titleBox = screen.getByTestId('page-title').parentElement!;
    expect(titleBox.className).toContain('max-sm:group-has-[[data-shell-search]:focus]/header:hidden');
    expect(titleBox.className).toContain('max-sm:group-has-[[data-shell-search]:not(:placeholder-shown)]/header:hidden');
    expect(screen.getByTestId('shell-header').classList.contains('group/header')).toBe(true);
  });
});
