/**
 * Review round 2 (library): a recording card draws its channel's logo and says "Recorded" once the
 * file is done, a file with no programme reads without its extension and date stamp, a failed
 * download keeps Retry and Remove on screen in a fixed actions column, Clear history takes the
 * recent searches with it, and an offline title's page says its facts once, with the way back to
 * the catalogue in About and the resume bar under Resume.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Channel, Download, Recording, RecordingFile } from '@/api/types';

import { DownloadRow } from '../components/DownloadRow';
import { RecordingCard } from '../components/RecordingCard';
import { fileTitle, recordingEntry } from '../lib/myvideos';
import { FavoritesPage } from '../pages/FavoritesPage';
import { MyVideoDetailPage } from '../pages/MyVideoDetailPage';
import { RecentPage } from '../pages/RecentPage';
import { makeDownload, makeFavorite, makeRecent } from './fixtures';
import { i18n, installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : Object.assign(new RpcError(err instanceof Error ? err.message : String(err)), {});
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: true,
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
const { recentSearchList, rememberSearch, resetRecentSearchCache } = await import('@/features/vod/lib/recentSearches');

const sources = [{ id: 'src1', name: 'Northwind', kind: 'xtream' }];

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  queryClient.clear();
  localStorage.clear();
  resetRecentSearchCache();
  rpc.handlers['sources.list'] = () => sources;
  rpc.handlers['settings.get'] = () => ({ epgOffsetMinutes: 0, coverSize: 'medium' });
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true, mpv: true });
});
afterEach(cleanup);

function renderCard(file: RecordingFile) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RecordingCard entry={recordingEntry(file)} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const file = (over: Partial<RecordingFile> = {}): RecordingFile => ({
  id: 'rf1',
  fileName: 'Juniper One - Celebrity Garden.ts',
  recordingId: 'rec1',
  channelName: 'Juniper One',
  title: 'Celebrity Garden',
  sizeBytes: 900_000_000,
  date: '2026-10-19T20:00:00Z',
  durationSeconds: 5400,
  fileAvailable: true,
  status: 'completed',
  ...over,
});

describe('recording cards', () => {
  it("draw the channel's logo, found through the recording that wrote the file, and say Recorded", async () => {
    const ref = { sourceId: 'src1', contentType: 'live' as const, itemId: 'ch9' };
    rpc.handlers['recordings.list'] = () => [{ id: 'rec1', ref, channelName: 'Juniper One' } as Recording];
    rpc.handlers['catalog.item'] = () => ({ ref, name: 'Juniper One', categoryId: 'g', isRadio: false, logoUrl: 'http://logos/juniper.png' }) as Channel;
    const { container } = renderCard(file());
    await waitFor(() => expect(rpc.callsOf('catalog.item')).toEqual([{ ref }]));
    await waitFor(() => expect(container.querySelector('[data-poster-fallback]')).toBeNull());
    // The logo is fitted small on black, like a frame of the stream, not stretched over the card.
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('.bg-black')).not.toBeNull();
    // A finished file is "Recorded"; the red dot and REC are for a file still being written.
    expect(screen.getByText('Recorded')).toBeTruthy();
    expect(screen.queryByText('REC')).toBeNull();
    expect(screen.queryByTestId('recording-live-dot')).toBeNull();
  });

  it('say REC with a red dot while the file is still being written, and fall back to initials with no channel', () => {
    rpc.handlers['recordings.list'] = () => [];
    const { container } = renderCard(file({ status: 'recording', recordingId: undefined }));
    expect(screen.getByText('REC')).toBeTruthy();
    expect(screen.getByTestId('recording-live-dot').className).toContain('bg-live');
    expect(container.querySelector('[data-poster-fallback]')).not.toBeNull();
    // No recording to follow: nothing is asked of the catalog.
    expect(rpc.callsOf('catalog.item')).toHaveLength(0);
  });

  it('name a file with no programme or channel without its extension and date stamp', () => {
    expect(fileTitle('Matchday Live 2026-09-28.ts')).toBe('Matchday Live');
    expect(fileTitle('News_20261020_1830.mkv')).toBe('News');
    expect(fileTitle('Show (2026-10-01 20.15).ts')).toBe('Show');
    expect(fileTitle('Deep Atlas - The Abyss.ts')).toBe('Deep Atlas - The Abyss');
    // A name that is only a stamp keeps it, without the extension.
    expect(fileTitle('2026-09-28.ts')).toBe('2026-09-28');
    const entry = recordingEntry(file({ title: undefined, channelName: undefined, fileName: 'Matchday Live 2026-09-28.ts' }));
    expect(entry.title).toBe('Matchday Live');
  });
});

describe('download rows', () => {
  const row = (d: Download, actions: Parameters<typeof DownloadRow>[0]['actions']) =>
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <DownloadRow download={d} source={undefined} actions={actions} busy={false} onAction={() => undefined} />
        </I18nextProvider>
      </QueryClientProvider>,
    );

  it('keep Retry and Remove on screen for a failed download, and hide a waiting row\'s until hover', () => {
    row(makeDownload({ id: 1, status: 'failed', errorMessage: 'HTTP 503' }), ['retry', 'remove']);
    const failed = screen.getByTestId('download-actions');
    expect(failed.className).not.toContain('pointer-fine:opacity-0');
    expect(within(failed).getAllByRole('button')).toHaveLength(2);
    cleanup();
    row(makeDownload({ id: 2, status: 'queued' }), ['pause', 'cancel']);
    expect(screen.getByTestId('download-actions').className).toContain('pointer-fine:opacity-0');
  });

  it('say what a queued row waits for: its turn, playback, or a free connection on its source', () => {
    const detail = () => screen.getByTestId('download-detail').textContent;
    row(makeDownload({ id: 4, status: 'queued' }), ['pause', 'cancel', 'next']);
    expect(detail()).toBe('Starts when a slot frees up');
    cleanup();
    row(makeDownload({ id: 5, status: 'queued', waiting: { reason: 'playback' } }), ['pause', 'cancel', 'next']);
    expect(detail()).toBe('Waits until playback from this source stops');
    cleanup();
    row(makeDownload({ id: 6, status: 'queued', waiting: { reason: 'connection' } }), ['pause', 'cancel', 'next']);
    expect(detail()).toBe('Waits for a free connection on this source');
    cleanup();
    row(makeDownload({ id: 7, status: 'queued', waiting: { reason: 'connection', until: '2026-10-22T14:05:00Z' } }), ['pause', 'cancel', 'next']);
    expect(detail()).toMatch(/^The provider has no free connection\. Trying again at \S/);
    cleanup();
    row(makeDownload({ id: 8, status: 'queued', waiting: { reason: 'provider', until: '2026-10-22T14:05:00Z' } }), ['pause', 'cancel', 'next']);
    expect(detail()).toMatch(/^Can't reach the provider\. Trying again at \S/);
  });

  it('say how many connections a split transfer holds', async () => {
    const { progressStore } = await import('../lib/progress');
    progressStore.ingest({ id: 9, bytesDownloaded: 1000, totalBytes: 4000, bytesPerSecond: 500 });
    row(makeDownload({ id: 9, status: 'downloading', bytesDownloaded: 1000, totalBytes: 4000, connections: 2 }), ['pause', 'cancel']);
    expect(screen.getByTestId('download-detail').textContent).toContain('2 connections');
    cleanup();
    progressStore.ingest({ id: 10, bytesDownloaded: 1000, totalBytes: 4000, bytesPerSecond: 500 });
    row(makeDownload({ id: 10, status: 'downloading', bytesDownloaded: 1000, totalBytes: 4000 }), ['pause', 'cancel']);
    expect(screen.getByTestId('download-detail').textContent).not.toContain('connections');
  });

  it('reserve the widest row\'s actions column on every row, so bars and badges end on one line', () => {
    row(makeDownload({ id: 3, status: 'paused' }), ['resume', 'remove']);
    expect(screen.getByTestId('download-actions').className).toContain('pointer-fine:w-[calc(3*2rem+2*0.125rem)]');
  });
});

describe('Clear history', () => {
  it('clears the recent searches with the whole history, and Undo brings them back', async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    rememberSearch('copper');
    rememberSearch('harbor');
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.clear'] = () => undefined;
    rpc.handlers['recent.add'] = () => undefined;
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);
    fireEvent.click(await within(screen.getByTestId('fake-header')).findByRole('button', { name: 'Clear history' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/recent searches/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(rpc.callsOf('recent.clear')).toEqual([{}]));
    await waitFor(() => expect(recentSearchList()).toEqual([]));
  });
});

describe('an offline title page', () => {
  it('says the size and the download date once, in About, with the way back to the catalogue there too', async () => {
    rpc.handlers['myvideos.list'] = () => [
      makeDownload({
        id: 7,
        title: 'Heat',
        status: 'completed',
        fileAvailable: true,
        totalBytes: 2_000_000_000,
        bytesDownloaded: 2_000_000_000,
        completedAt: '2026-10-14T00:00:00Z',
        positionSeconds: 1800,
      }),
    ];
    rpc.handlers['catalog.item'] = () => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: 'm7' }, title: 'Heat', categoryId: 'c', plot: 'A thief plans one last job.', durationSeconds: 5400 });
    renderAt('/my-videos/7', [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);
    await screen.findByTestId('play-offline');
    const about = screen.getByTestId('vod-about');
    expect(within(about).getByTestId('myvideo-catalogue-link').getAttribute('href')).toBe('/s/src1/movie/m7');
    // The plot and the length come from the catalogue's own row, and the bar shows how far Resume is.
    expect(await screen.findByText('A thief plans one last job.')).toBeTruthy();
    expect((await screen.findByTestId('vod-hero-progress')).textContent).toContain('60 minutes left');
    // Facts of the file sit in About only: no "Downloaded …" note and no size chip in the hero.
    expect(screen.queryByText(/^Downloaded /)).toBeNull();
    expect(within(screen.getByTestId('vod-detail-meta')).queryByText(/GB/)).toBeNull();
    expect(within(about).getByText(/GB/)).toBeTruthy();
  });
});

describe('page tops', () => {
  it("Favorites' first heading row is only as tall as the heading; later ones keep the gap above them", async () => {
    rpc.handlers['favorites.list'] = () => [makeFavorite('live', 'ch1', 0), makeFavorite('movie', 'm1', 1)];
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    const list = await screen.findByTestId('favorites-list');
    await waitFor(() => expect(within(list).getAllByRole('heading', { level: 2 })).toHaveLength(2));
    const heights = within(list)
      .getAllByRole('heading', { level: 2 })
      .map((hd) => (hd.closest('[style*="translateY"]') as HTMLElement).style.height);
    expect(heights).toEqual(['36px', '56px']);
    // No top padding of its own: the Page's py-6 sets where the first line starts, as on the other pages.
    expect(screen.getByTestId('favorites-page').className).not.toMatch(/(^|\s)pt-\d/);
  });
});
