/**
 * Every routed library page renders exactly one h1, in every state, and its
 * text equals the title the page puts in the shell header (C16).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource, Source } from '@/api/types';

import { DownloadsPage } from '../pages/DownloadsPage';
import { FavoritesPage } from '../pages/FavoritesPage';
import { MyVideoDetailPage } from '../pages/MyVideoDetailPage';
import { MyVideosPage } from '../pages/MyVideosPage';
import { RecentPage } from '../pages/RecentPage';
import { stopTrackingDownloadPosition } from '../lib/positionSync';
import { makeDownload, makeEpisode, makeFavorite, makePosition, makeRecent } from './fixtures';
import { fakePlayer, installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : Object.assign(new RpcError(String(err)), {});
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
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const sources: Partial<Source>[] = [{ id: 'src1', kind: 'xtream', name: 'Home portal' }];
const library = [
  makeDownload({ id: 1, status: 'completed', title: 'Heat', completedAt: '2026-10-01T00:00:00Z', totalBytes: 2048, fileAvailable: true }),
  makeEpisode('s1', 'Severance', 'S01E02 Half Loop', { id: 2, completedAt: '2026-10-03T00:00:00Z' }),
  makeEpisode('s1', 'Severance', 'S01E01 Good News', { id: 3, completedAt: '2026-10-02T00:00:00Z' }),
];
const never = () => new Promise<never>(() => undefined);
const fail = () => {
  throw new Error('boom');
};

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['sources.list'] = () => sources;
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  rpc.handlers['positions.continueWatching'] = () => [makePosition('p1', 600, 2400)];
  fakePlayer.usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
});
afterEach(() => {
  stopTrackingDownloadPosition();
  cleanup();
});

/** Exactly one h1, and it reads the same as the header title. */
async function expectSingleH1(title: string) {
  await waitFor(() => expect(screen.getByTestId('page-title').textContent).toBe(title));
  const h1s = screen.getAllByRole('heading', { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]!.textContent).toBe(title);
}

interface Case {
  name: string;
  path: string;
  route: string;
  element: ReactNode;
  cmd: string;
  data: () => unknown;
  title: string;
}
const favorites = () => [makeFavorite('movie', 'v1', 0)];
const recent = () => [makeRecent('a', new Date().toISOString())];
const cases: Case[] = [
  {
    name: 'downloads',
    path: '/downloads',
    route: '/downloads',
    element: <DownloadsPage />,
    cmd: 'downloads.list',
    data: () => [makeDownload({ id: 7, status: 'downloading' })],
    title: 'Downloads',
  },
  { name: 'my videos', path: '/my-videos', route: '/my-videos', element: <MyVideosPage />, cmd: 'myvideos.list', data: () => library, title: 'My Videos' },
  { name: 'favorites', path: '/favorites', route: '/favorites', element: <FavoritesPage />, cmd: 'favorites.list', data: favorites, title: 'Favorites' },
  {
    name: 'per-source favorites',
    path: '/s/src1/favorites',
    route: '/s/:sourceId/favorites',
    element: <FavoritesPage />,
    cmd: 'favorites.list',
    data: favorites,
    title: 'Favorites in Home portal',
  },
  { name: 'recent', path: '/recent', route: '/recent', element: <RecentPage />, cmd: 'recent.list', data: recent, title: 'Recently watched' },
  {
    name: 'per-source recent',
    path: '/s/src1/recent',
    route: '/s/:sourceId/recent',
    element: <RecentPage />,
    cmd: 'recent.list',
    data: recent,
    title: 'Recently watched in Home portal',
  },
];

describe.each(cases)('$name page has one h1', ({ path, route, element, cmd, data, title }) => {
  const at = () => renderAt(path, [{ path: route, element }]);

  it('with content', async () => {
    rpc.handlers[cmd] = data;
    at();
    await expectSingleH1(title);
  });
  it('while loading', async () => {
    rpc.handlers[cmd] = never;
    at();
    await expectSingleH1(title);
  });
  it('when empty', async () => {
    rpc.handlers[cmd] = () => [];
    at();
    await expectSingleH1(title);
  });
  it('on error', async () => {
    rpc.handlers[cmd] = fail;
    at();
    await screen.findByRole('button', { name: /retry/i });
    await expectSingleH1(title);
  });
});

describe('my video detail page has one h1', () => {
  const at = (id: number) => renderAt(`/my-videos/${id}`, [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);

  it('browsing a movie', async () => {
    rpc.handlers['myvideos.list'] = () => library;
    at(1);
    await screen.findByTestId('play-offline');
    await expectSingleH1('Heat');
  });

  it('watching a series episode keeps the series title as the h1', async () => {
    rpc.handlers['myvideos.list'] = () => library;
    rpc.handlers['myvideos.playSource'] = () => ({ url: 'file:///severance-1.mkv', kind: 'file' });
    at(2);
    fireEvent.click(await screen.findByTestId('play-offline'));
    await screen.findByTestId('player-stage');
    fakePlayer.usePlayerStore.setState({ source: { url: 'file:///severance-1.mkv', title: 'S01E02 Half Loop' } as PlayerSource });
    expect((await screen.findByTestId('now-playing-title')).textContent).toBe('S01E02 Half Loop');
    await expectSingleH1('Severance');
  });

  it('while loading', async () => {
    rpc.handlers['myvideos.list'] = never;
    at(1);
    await expectSingleH1('My Videos');
  });

  it('on error', async () => {
    rpc.handlers['myvideos.list'] = fail;
    at(1);
    await screen.findByRole('button', { name: /retry/i });
    await expectSingleH1('My Videos');
  });

  it('not found', async () => {
    rpc.handlers['myvideos.list'] = () => library;
    at(99);
    await screen.findByText('This video is not in your library');
    await expectSingleH1('My Videos');
  });
});
