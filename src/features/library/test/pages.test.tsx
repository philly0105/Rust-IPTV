import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DownloadStatus, Source } from '@/api/types';

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

const sources: Partial<Source>[] = [
  { id: 'src1', kind: 'xtream', name: 'Home portal' },
  { id: 'src2', kind: 'm3u', name: 'Backup list' },
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['sources.list'] = () => sources;
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  fakePlayer.usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
  fakePlayer.played.length = 0;
});
afterEach(() => {
  stopTrackingDownloadPosition();
  cleanup();
});

describe('DownloadsPage', () => {
  const statuses: DownloadStatus[] = ['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled'];
  const list = statuses.map((status, i) =>
    makeDownload({
      id: 10 + i,
      status,
      title: `Title ${status}`,
      bytesDownloaded: status === 'downloading' ? 500 : 0,
      totalBytes: 1000,
      ...(status === 'failed' ? { errorMessage: 'HTTP 403' } : {}),
    }),
  );

  it('renders one row per non-completed status with its actions', async () => {
    rpc.handlers['downloads.list'] = () => list;
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    const rows = await screen.findAllByTestId('download-row');
    expect(rows.map((r) => r.dataset['status'])).toEqual(['queued', 'downloading', 'paused', 'canceled', 'failed']);
    const actions = (status: string) =>
      within(rows.find((r) => r.dataset['status'] === status)!)
        .getAllByRole('button')
        .map((b) => b.dataset['action'])
        .filter(Boolean);
    expect(actions('downloading')).toEqual(['pause', 'cancel']);
    expect(actions('queued')).toEqual(['pause', 'cancel']);
    expect(actions('paused')).toEqual(['resume', 'remove']);
    expect(actions('failed')).toEqual(['retry', 'remove']);
    expect(actions('canceled')).toEqual(['retry', 'remove']);
    expect(screen.getByText('Queue')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('HTTP 403')).toBeTruthy();
    expect(screen.queryByText('Title completed')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Download progress for Title downloading' })).toBeTruthy();
  });

  it('calls the matching rpc for row actions', async () => {
    rpc.handlers['downloads.list'] = () => list;
    rpc.handlers['downloads.pause'] = () => undefined;
    rpc.handlers['downloads.retry'] = () => undefined;
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Pause Title downloading' }));
    await waitFor(() => expect(rpc.callsOf('downloads.pause')).toEqual([{ id: 11 }]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry Title failed' }));
    await waitFor(() => expect(rpc.callsOf('downloads.retry')).toEqual([{ id: 14 }]));
  });

  it('offers Try again on a retryable failure and re-issues the command', async () => {
    const { useToastStore } = await import('@/ui');
    const { RpcError } = await import('@/api/transport');
    useToastStore.getState().clear();
    rpc.handlers['downloads.list'] = () => list;
    let attempts = 0;
    rpc.handlers['downloads.pause'] = () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new RpcError('timeout', 'timed out'), { code: 'timeout', retryable: true });
      return undefined;
    };
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Title downloading' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const toast = useToastStore.getState().toasts[0]!;
    expect(toast.action?.label).toBe('Try again');
    toast.action!.onClick();
    await waitFor(() => expect(rpc.callsOf('downloads.pause')).toEqual([{ id: 11 }, { id: 11 }]));
  });

  it('shows no Try again when the failure is not retryable', async () => {
    const { useToastStore } = await import('@/ui');
    const { RpcError } = await import('@/api/transport');
    useToastStore.getState().clear();
    rpc.handlers['downloads.list'] = () => list;
    rpc.handlers['downloads.pause'] = () => {
      throw Object.assign(new RpcError('invalid', 'bad'), { code: 'invalid', retryable: false });
    };
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Title downloading' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]!.action).toBeUndefined();
  });

  it('confirms before canceling a partial download', async () => {
    rpc.handlers['downloads.list'] = () => list;
    rpc.handlers['downloads.cancel'] = () => undefined;
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Title downloading' }));
    expect(rpc.callsOf('downloads.cancel')).toEqual([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(rpc.callsOf('downloads.cancel')).toEqual([{ id: 11 }]));
  });

  it('offers to delete the partial file of an unfinished download and sends the choice', async () => {
    const paused = makeDownload({ id: 30, status: 'paused', title: 'Half done', bytesDownloaded: 400, totalBytes: 1000 });
    rpc.handlers['downloads.list'] = () => [paused];
    rpc.handlers['downloads.remove'] = () => undefined;
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Half done' }));
    const toggle = await screen.findByRole('switch', { name: 'Delete the partial file' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Frees the disk space. When off, the partial file stays in the downloads folder.')).toBeTruthy();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(rpc.callsOf('downloads.remove')).toEqual([{ id: 30, deleteFile: false }]));
  });

  it('hides the partial-file toggle once the download has finished and keeps the finished file', async () => {
    const { invalidate } = await import('@/api/query');
    const paused = makeDownload({ id: 31, status: 'paused', title: 'Almost', bytesDownloaded: 900, totalBytes: 1000 });
    let current = paused;
    rpc.handlers['downloads.list'] = () => [current];
    rpc.handlers['downloads.remove'] = () => undefined;
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Almost' }));
    expect(await screen.findByRole('switch', { name: 'Delete the partial file' })).toBeTruthy();
    // Resumed elsewhere and finished while the dialog was open.
    current = { ...paused, status: 'completed', bytesDownloaded: 1000 };
    await invalidate('downloads.');
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Delete the partial file' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(rpc.callsOf('downloads.remove')).toEqual([{ id: 31, deleteFile: false }]));
  });

  it('shows the full error of a failed download in a tooltip', async () => {
    const long = 'HTTP 403 Forbidden: the provider refused this title because the account has reached its connection limit';
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 32, status: 'failed', title: 'Blocked', errorMessage: long })];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    const detail = within(await screen.findByTestId('download-row')).getByTestId('download-detail');
    expect(detail.textContent).toBe(long);
    expect(detail.getAttribute('title')).toBe(long);
  });

  it('shows the empty state when only completed items remain', async () => {
    rpc.handlers['downloads.list'] = () => [list[3]];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    expect(await screen.findByText('Nothing is downloading')).toBeTruthy();
    expect(screen.getByText('Your 1 finished download is in My Videos.')).toBeTruthy();
  });

  it('shows the error state', async () => {
    rpc.handlers['downloads.list'] = () => {
      throw new Error('boom');
    };
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByTestId('download-row')).toBeNull();
  });
});

const library = [
  makeDownload({ id: 1, status: 'completed', title: 'Heat', completedAt: '2026-10-01T00:00:00Z', totalBytes: 2048, fileAvailable: true }),
  makeEpisode('s1', 'Severance', 'S01E02 Half Loop', { id: 2, completedAt: '2026-10-03T00:00:00Z' }),
  makeEpisode('s1', 'Severance', 'S01E01 Good News', { id: 3, completedAt: '2026-10-02T00:00:00Z' }),
];

describe('MyVideosPage', () => {
  it('renders movie and series cards', async () => {
    rpc.handlers['myvideos.list'] = () => library;
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    const cards = await screen.findAllByTestId('library-card');
    expect(cards.map((c) => c.dataset['kind'])).toEqual(['series', 'movie']);
    expect(screen.getByText('2 episodes')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    rpc.handlers['myvideos.list'] = () => [];
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    expect(await screen.findByText('No offline videos yet')).toBeTruthy();
  });
});

describe('MyVideoDetailPage', () => {
  it('lists episodes and switches to the player when playing', async () => {
    rpc.handlers['myvideos.list'] = () => library;
    rpc.handlers['myvideos.playSource'] = () => ({ url: 'file:///severance-1.mkv', kind: 'file' });
    renderAt('/my-videos/2', [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);

    const rows = await screen.findAllByTestId('episode-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Season 1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('play-offline'));

    await waitFor(() => expect(rpc.callsOf('myvideos.playSource')).toHaveLength(1));
    expect(await screen.findByTestId('player-stage')).toBeTruthy();
    expect(fakePlayer.played[0]).toMatchObject({ url: 'file:///severance-1.mkv', title: 'Severance' });
  });

  it('shows not found for an unknown id', async () => {
    rpc.handlers['myvideos.list'] = () => library;
    renderAt('/my-videos/99', [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);
    expect(await screen.findByText('This video is not in your library')).toBeTruthy();
  });
});

describe('FavoritesPage', () => {
  const favs = [makeFavorite('live', 'c1', 0), makeFavorite('movie', 'v1', 1), makeFavorite('movie', 'v2', 2, 'src2'), makeFavorite('series', 's1', 3)];

  it('groups entries and reorders with the move buttons (global page)', async () => {
    rpc.handlers['favorites.list'] = () => favs;
    rpc.handlers['favorites.reorder'] = () => undefined;
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);

    expect(await screen.findByText('Live and radio')).toBeTruthy();
    expect(screen.getAllByTestId('entry-row')).toHaveLength(4);
    expect(screen.getByText('Backup list')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move movie v2 up' }));

    await waitFor(() => expect(rpc.callsOf('favorites.reorder')).toHaveLength(1));
    expect(rpc.callsOf('favorites.reorder')[0]).toEqual({ refs: [favs[0]!.ref, favs[2]!.ref, favs[1]!.ref, favs[3]!.ref] });
  });

  it('passes sourceId on the per-source page', async () => {
    const own = favs.filter((f) => f.ref.sourceId === 'src1');
    rpc.handlers['favorites.list'] = () => own;
    renderAt('/s/src1/favorites', [{ path: '/s/:sourceId/favorites', element: <FavoritesPage /> }]);

    expect(await screen.findAllByTestId('entry-row')).toHaveLength(3);
    expect(rpc.callsOf('favorites.list')[0]).toEqual({ sourceId: 'src1' });
    expect(await screen.findByRole('heading', { name: 'Favorites in Home portal' })).toBeTruthy();
  });

  it('a channel played from the page zaps through the page favorites (F-FAVORITES-ZAP)', async () => {
    const own = favs.filter((f) => f.ref.sourceId === 'src1');
    rpc.handlers['favorites.list'] = () => own;
    renderAt('/s/src1/favorites', [{ path: '/s/:sourceId/favorites', element: <FavoritesPage /> }]);
    const rows = await screen.findAllByTestId('entry-row');
    // The fake player does not change what plays: say the channel is playing once asked.
    fakePlayer.usePlayerStore.setState({ source: { url: 'u', kind: 'hls', title: 't', isLive: true, isRadio: false, ref: favs[0]!.ref } });
    fireEvent.click(within(rows[0]!).getByText('live c1'));
    await waitFor(() => expect(fakePlayer.items).toHaveLength(1));
    await waitFor(() =>
      expect((fakePlayer.usePlayerStore.getState() as { zapContext?: unknown }).zapContext).toEqual({ sourceId: 'src1', favorites: { sourceId: 'src1' } }),
    );
  });

  it('shows the empty state', async () => {
    rpc.handlers['favorites.list'] = () => [];
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    expect(await screen.findByText('No favorites yet')).toBeTruthy();
  });
});

describe('RecentPage', () => {
  it('renders history with continue watching and clears it', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString()), makeRecent('b', '2025-01-01T00:00:00Z')];
    rpc.handlers['positions.continueWatching'] = () => [makePosition('p1', 600, 2400)];
    rpc.handlers['recent.clear'] = () => undefined;
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);

    expect(await screen.findByTestId('continue-rail')).toBeTruthy();
    expect(screen.getAllByTestId('entry-row')).toHaveLength(2);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Older')).toBeTruthy();
    expect(rpc.callsOf('recent.list')[0]).toEqual({ limit: 500 });

    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(rpc.callsOf('recent.clear')).toEqual([{}]));
  });

  it('scopes to a source and removes one entry', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [makePosition('p1', 60, undefined, 'src2')];
    rpc.handlers['recent.remove'] = () => undefined;
    renderAt('/s/src1/recent', [{ path: '/s/:sourceId/recent', element: <RecentPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Watched a from history' }));
    await waitFor(() => expect(rpc.callsOf('recent.remove')).toHaveLength(1));
    expect(rpc.callsOf('recent.list')[0]).toEqual({ sourceId: 'src1', limit: 500 });
    expect(screen.queryByTestId('continue-rail')).toBeNull();
  });
});
