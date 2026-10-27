import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Source } from '@/api/types';
import { useToastStore } from '@/ui';

import { ENTRY_ROW_HEIGHT } from '../components/EntryRow';
import { FavoritesPage } from '../pages/FavoritesPage';
import { MyVideosPage } from '../pages/MyVideosPage';
import { RecentPage } from '../pages/RecentPage';
import { makeFavorite, makePosition, makeRecent } from './fixtures';
import { installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : new RpcError(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: false,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
const headerSpy = vi.hoisted(() => ({ last: null as null | { search?: { value: string; onChange: (v: string) => void } } }));
vi.mock('@/shell', () => {
  const setHeader = (h: typeof headerSpy.last) => {
    headerSpy.last = h;
  };
  return { useShell: () => ({ setHeader }), useShortcut: () => undefined };
});
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const sources: Partial<Source>[] = [{ id: 'src1', kind: 'xtream', name: 'Home portal' }];
const never = () => new Promise<never>(() => undefined);
const fail = () => {
  throw new Error('portal timed out');
};

const favoritesRoute = [{ path: '/favorites', element: <FavoritesPage /> }];
const recentRoute = [{ path: '/recent', element: <RecentPage /> }];

function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  useToastStore.setState({ toasts: [] });
  rpc.handlers['sources.list'] = () => sources;
});
afterEach(cleanup);

describe('library loading and error states', () => {
  it('Favorites: skeleton while loading, error with a working retry', async () => {
    rpc.handlers['favorites.list'] = never;
    const view = renderAt('/favorites', favoritesRoute);
    expect(view.container.querySelector('[aria-busy="true"], [role="status"]')).toBeTruthy();
    // The stand-in has the loaded list's box and row height, so nothing moves when rows arrive.
    const skeleton = screen.getByTestId('entry-rows-skeleton');
    expect(skeleton.className).toContain('max-w-4xl');
    expect(skeleton.className).toContain('-mx-2');
    const rows = [...skeleton.querySelectorAll<HTMLElement>('[style]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.style.height).toBe(`${ENTRY_ROW_HEIGHT}px`);
    cleanup();

    rpc.handlers['favorites.list'] = fail;
    renderAt('/favorites', favoritesRoute);
    expect(await screen.findByText(/portal timed out/)).toBeTruthy();
    rpc.handlers['favorites.list'] = () => [makeFavorite('movie', 'm1', 0)];
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByTestId('favorites-list')).toBeTruthy();
  });

  it('Recent: skeleton while loading, error with retry', async () => {
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.list'] = never;
    const view = renderAt('/recent', recentRoute);
    expect(view.container.querySelector('[aria-busy="true"], [role="status"]')).toBeTruthy();
    expect(screen.getByTestId('entry-rows-skeleton')).toBeTruthy();
    cleanup();

    rpc.handlers['recent.list'] = fail;
    renderAt('/recent', recentRoute);
    expect(await screen.findByText(/portal timed out/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('My Videos: skeleton while loading, error with retry', async () => {
    rpc.handlers['myvideos.list'] = never;
    const view = renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    expect(view.container.querySelector('[aria-busy="true"], [role="status"]')).toBeTruthy();
    cleanup();

    rpc.handlers['myvideos.list'] = fail;
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    expect(await screen.findByText(/portal timed out/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });
});

describe('library empty states point to where items come from', () => {
  it('Favorites with a source: browse that source', async () => {
    rpc.handlers['favorites.list'] = () => [];
    renderAt('/favorites', favoritesRoute);
    const link = await screen.findByTestId('library-empty-browse');
    expect(link.getAttribute('href')).toBe('/s/src1/live');
    expect(link.textContent).toBe('Browse channels');
  });

  it('encodes a source id that contains a slash', async () => {
    rpc.handlers['sources.list'] = () => [{ id: 'portal/1 x', kind: 'm3u', name: 'Odd id' }];
    rpc.handlers['favorites.list'] = () => [];
    renderAt('/favorites', favoritesRoute);
    const link = await screen.findByTestId('library-empty-browse');
    expect(link.getAttribute('href')).toBe('/s/portal%2F1%20x/live');
  });

  it('Favorites with no sources: add one', async () => {
    rpc.handlers['sources.list'] = () => [];
    rpc.handlers['favorites.list'] = () => [];
    renderAt('/favorites', favoritesRoute);
    const link = await screen.findByTestId('library-empty-add-source');
    expect(link.getAttribute('href')).toBe('/sources');
    expect(screen.getByText(/Add a playlist or portal first/)).toBeTruthy();
  });

  it('Recent per source: browse that source', async () => {
    rpc.handlers['recent.list'] = () => [];
    rpc.handlers['positions.continueWatching'] = () => [];
    renderAt('/s/src9/recent', [{ path: '/s/:sourceId/recent', element: <RecentPage /> }]);
    expect(await screen.findByText('Nothing watched yet')).toBeTruthy();
    expect((await screen.findByTestId('library-empty-browse')).getAttribute('href')).toBe('/s/src9/live');
  });
});

describe('no-match search states offer a way back', () => {
  it('Favorites: Clear search empties the header search and brings the list back', async () => {
    rpc.handlers['favorites.list'] = () => [makeFavorite('movie', 'm1', 0)];
    renderAt('/favorites', favoritesRoute);
    await screen.findByTestId('favorites-list');
    act(() => headerSpy.last!.search!.onChange('zzz-nothing'));
    fireEvent.click(await screen.findByTestId('library-clear-search'));
    expect(await screen.findByTestId('favorites-list')).toBeTruthy();
    expect(headerSpy.last!.search!.value).toBe('');
  });

  it('Recent: Clear search is offered when nothing matches', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [];
    renderAt('/recent', recentRoute);
    await screen.findByTestId('recent-list');
    act(() => headerSpy.last!.search!.onChange('zzz-nothing'));
    expect((await screen.findByTestId('library-clear-search')).textContent).toBe('Clear search');
  });
});

describe('library removals can be undone', () => {
  it('removing a history entry offers Undo that re-adds it', async () => {
    const entry = makeRecent('a', new Date().toISOString());
    rpc.handlers['recent.list'] = () => [entry];
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.remove'] = () => undefined;
    rpc.handlers['recent.add'] = () => undefined;
    renderAt('/recent', recentRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Watched a from history' }));
    await waitFor(() => expect(lastToast()?.title).toBe('Removed Watched a from history'));
    lastToast()!.action!.onClick();
    await waitFor(() => expect(rpc.callsOf('recent.add')).toEqual([{ ref: entry.ref, snapshot: entry.snapshot, viewedAt: entry.viewedAt }]));
  });

  it('removing a continue-watching item offers Undo that restores the position', async () => {
    const pos = makePosition('p1', 600, 2400);
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [pos];
    rpc.handlers['positions.remove'] = () => undefined;
    rpc.handlers['positions.set'] = () => undefined;
    renderAt('/recent', recentRoute);

    await screen.findByTestId('continue-rail');
    fireEvent.click(screen.getByRole('button', { name: /from continue watching/ }));
    await waitFor(() => expect(lastToast()?.title).toMatch(/^Removed .* from continue watching$/));
    lastToast()!.action!.onClick();
    await waitFor(() =>
      expect(rpc.callsOf('positions.set')).toEqual([{ ref: pos.ref, positionSeconds: 600, durationSeconds: 2400, snapshot: pos.snapshot, updatedAt: pos.updatedAt }]),
    );
  });

  it('Delete on a continue-watching card removes it and keeps focus in the rail', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [makePosition('p1', 600, 2400), makePosition('p2', 300, 2400)];
    rpc.handlers['positions.remove'] = () => undefined;
    renderAt('/recent', recentRoute);

    const rail = await screen.findByTestId('continue-rail');
    const cards = rail.querySelectorAll<HTMLElement>('[data-continue-open]');
    expect(cards).toHaveLength(2);
    cards[0]!.focus();
    fireEvent.keyDown(cards[0]!, { key: 'Delete' });
    await waitFor(() => expect(rpc.callsOf('positions.remove')).toHaveLength(1));
    expect((rpc.callsOf('positions.remove')[0] as { ref: { itemId: string } }).ref.itemId).toBe('p1');
    expect(document.activeElement).toBe(cards[1]);
  });

  it('a failed undo says so instead of failing silently', async () => {
    const entry = makeRecent('a', new Date().toISOString());
    rpc.handlers['recent.list'] = () => [entry];
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.remove'] = () => undefined;
    rpc.handlers['recent.add'] = fail;
    renderAt('/recent', recentRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Watched a from history' }));
    await waitFor(() => expect(lastToast()?.action).toBeTruthy());
    lastToast()!.action!.onClick();
    await waitFor(() => expect(lastToast()?.title).toBe('Could not undo that'));
  });
});
