/** Loop 2 fixes on the library pages (L2-guide-library-*, L2-visual-*). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackPosition, RecordingFile } from '@/api/types';

import { ContinueRail } from '../components/ContinueRail';
import { EntryRow } from '../components/EntryRow';
import { splitPath } from '../components/FolderBar';
import { DownloadsPage } from '../pages/DownloadsPage';
import { MyVideoDetailPage } from '../pages/MyVideoDetailPage';
import { MyVideosPage } from '../pages/MyVideosPage';
import { scheduledSubtitle } from '../pages/ScheduledPage';
import { makeDownload } from './fixtures';
import { I18nWrap, fakePlayer, installDomStubs, renderAt } from './harness';

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

function recording(over: Partial<RecordingFile> = {}): RecordingFile {
  return {
    id: 'r.r1.0',
    fileName: 'Alpha - Evening News - 2026-10-15 1800.ts',
    recordingId: 'r1',
    channelName: 'Alpha',
    title: 'Evening News',
    sizeBytes: 2_500_000,
    date: '2026-10-15T18:00:00Z',
    fileAvailable: true,
    status: 'completed',
    ...over,
  };
}

const movies = [
  makeDownload({ id: 1, status: 'completed', title: 'Heat', fileAvailable: true, completedAt: '2026-10-14T00:00:00Z' }),
  makeDownload({ id: 2, status: 'completed', title: 'Ronin', fileAvailable: true, completedAt: '2026-10-16T00:00:00Z' }),
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['sources.list'] = () => [];
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  rpc.handlers['myvideos.list'] = () => movies;
  rpc.handlers['recordings.library'] = () => [];
  fakePlayer.usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
  fakePlayer.played.length = 0;
});
afterEach(cleanup);

const libraryRoutes = [
  { path: '/my-videos', element: <MyVideosPage /> },
  { path: '/my-videos/:id', element: <MyVideoDetailPage /> },
];

describe('Back to My Videos lands on the opened card (L1-guide-library-13 carry-over)', () => {
  it('focuses the card that was opened, after the in-page Back', async () => {
    renderAt('/my-videos?filter=movies', libraryRoutes);
    const cards = await screen.findAllByRole('listitem');
    // Newest first: Ronin, then Heat. Open the second card.
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Ronin', 'Heat']);
    fireEvent.click(cards[1]!);
    expect(await screen.findByTestId('play-offline')).toBeTruthy();
    fireEvent.click(await screen.findByRole('link', { name: 'Back to My Videos' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Heat'));
    // The opened card is the grid's tab stop again.
    expect(screen.getByRole('listitem', { name: 'Heat' }).tabIndex).toBe(0);
  });

  it('a fresh visit starts at the top with nothing focused', async () => {
    renderAt('/my-videos', libraryRoutes);
    await screen.findAllByRole('listitem');
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement?.getAttribute('role')).not.toBe('listitem');
  });
});

describe('My Videos All includes recordings (L2-guide-library-8)', () => {
  it('lists and counts recording files in All, newest first, and plays one from its card', async () => {
    rpc.handlers['recordings.library'] = () => [recording()];
    rpc.handlers['recordings.playSource'] = () => ({ url: 'http://x/r.r1.0', kind: 'vod', title: 'Evening News' });
    renderAt('/my-videos', libraryRoutes);
    const grid = await screen.findByTestId('my-videos-grid');
    await waitFor(() => expect(within(grid).getAllByTestId('library-card')).toHaveLength(3));
    // Recordings are TV: a section of wide cards of their own above the poster grid, newest first in each.
    const recordings = within(grid).getByRole('list', { name: 'Recordings' });
    expect(within(recordings).getAllByRole('button').map((c) => c.getAttribute('aria-label'))).toEqual(['Evening News, Recording']);
    const titles = within(grid).getByRole('list', { name: 'My Videos' });
    expect(within(titles).getAllByRole('listitem').map((c) => c.getAttribute('aria-label'))).toEqual(['Ronin', 'Heat']);
    expect(screen.getByRole('tab', { name: /All/ }).textContent).toContain('3');
    expect(screen.getByRole('tab', { name: /Movies/ }).textContent).toContain('2');

    fireEvent.click(within(recordings).getByRole('button', { name: 'Evening News, Recording' }));
    await waitFor(() => expect(fakePlayer.played.map((s) => s.url)).toEqual(['http://x/r.r1.0']));
  });

  it('keeps recordings out of Movies, and a missing one counts under Missing', async () => {
    rpc.handlers['recordings.library'] = () => [recording({ fileAvailable: false })];
    renderAt('/my-videos?filter=movies', libraryRoutes);
    const grid = await screen.findByTestId('my-videos-grid');
    expect(within(grid).getAllByTestId('library-card').map((c) => c.dataset['kind'])).toEqual(['movie', 'movie']);
    const missing = await screen.findByRole('tab', { name: /Missing/ });
    expect(missing.textContent).toContain('1');
  });

  it('shows only recordings in All when there are no downloads', async () => {
    rpc.handlers['myvideos.list'] = () => [];
    rpc.handlers['recordings.library'] = () => [recording()];
    renderAt('/my-videos', libraryRoutes);
    const grid = await screen.findByTestId('my-videos-grid');
    expect(within(grid).getAllByTestId('library-card').map((c) => c.dataset['kind'])).toEqual(['recording']);
  });

  it('names the queue link with its label, which shows on a phone too (L2-visual-4)', async () => {
    renderAt('/my-videos', libraryRoutes);
    const link = await screen.findByRole('link', { name: 'Open download queue' });
    // On a phone the link sits on its own line under the tabs, with room for its label.
    expect(within(link).getByText('Open download queue').className).not.toContain('sr-only');
  });
});

describe('Pause and Resume answer at once (L2-guide-library-11)', () => {
  it('flips the row before the call returns and refetches only the list', async () => {
    let status: 'downloading' | 'paused' = 'downloading';
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 5, status, title: 'Big', totalBytes: 100, bytesDownloaded: 10 })];
    let release!: () => void;
    rpc.handlers['downloads.pause'] = () =>
      new Promise<null>((r) => {
        release = () => {
          status = 'paused';
          r(null);
        };
      });
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const row = await screen.findByTestId('download-row');
    await waitFor(() => expect(rpc.callsOf('downloads.dir')).toHaveLength(1));
    const listCalls = rpc.callsOf('downloads.list').length;

    fireEvent.click(within(row).getByRole('button', { name: 'Pause Big' }));
    await waitFor(() => expect(screen.getByTestId('download-row').dataset['status']).toBe('paused'));
    expect(within(screen.getByTestId('download-row')).getByRole('button', { name: 'Resume Big' })).toBeTruthy();
    expect(rpc.callsOf('downloads.pause')).toHaveLength(1);

    release();
    await waitFor(() => expect(rpc.callsOf('downloads.list').length).toBe(listCalls + 1));
    expect(rpc.callsOf('downloads.dir')).toHaveLength(1);
    expect(rpc.callsOf('myvideos.list')).toHaveLength(0);
    expect(screen.getByTestId('download-row').dataset['status']).toBe('paused');
  });

  it('puts the row back when the call fails', async () => {
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 6, status: 'paused', title: 'Gone' })];
    rpc.handlers['downloads.resume'] = () => {
      throw new Error('boom');
    };
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const row = await screen.findByTestId('download-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Resume Gone' }));
    await waitFor(() => expect(rpc.callsOf('downloads.resume')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('download-row').dataset['status']).toBe('paused'));
  });
});

describe('Scheduled header counts (L2-guide-library-13)', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    key === 'scheduledSummaryNow' ? `${String(vars?.['count'])} recording in progress` : `${String(vars?.['count'])} items coming up`;
  const subtitle = (now: number, upcoming: number) => scheduledSubtitle({ now, upcoming, lang: 'en', t }).replace(/[⁨⁩]/g, '');

  it('does not count a running recording as coming up', () => {
    expect(subtitle(1, 4)).toBe('1 recording in progress, 4 items coming up');
    expect(subtitle(0, 4)).toBe('4 items coming up');
    expect(subtitle(1, 0)).toBe('1 recording in progress');
    expect(subtitle(0, 0)).toBe('0 items coming up');
  });
});

describe('Downloads folder bar (L2-guide-library-14)', () => {
  it('splits a path before its last folder, for a middle cut', () => {
    expect(splitPath('C:\\Users\\aideo\\Videos\\Tsrust IPTV')).toEqual({ head: 'C:\\Users\\aideo\\Videos\\', tail: 'Tsrust IPTV' });
    expect(splitPath('/home/me/Videos/')).toEqual({ head: '/home/me/', tail: 'Videos' });
    expect(splitPath('Videos')).toEqual({ head: '', tail: 'Videos' });
  });

  it('shows the status summary once (in the header) and the full path in a tooltip', async () => {
    rpc.handlers['downloads.dir'] = () => ({ path: 'D:\\Media\\Downloads\\Tsrust' });
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 7, status: 'queued' }), makeDownload({ id: 8, status: 'paused' })];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const dir = await screen.findByTestId('downloads-dir');
    expect(dir.getAttribute('title')).toBe('D:\\Media\\Downloads\\Tsrust');
    // Once: the fake header renders the subtitle since loop 3, so the summary is there and nowhere else.
    expect(screen.getAllByText(/1 queued/).map((el) => el.dataset.testid)).toEqual(['page-subtitle']);
  });
});

describe('Continue watching rail (L2-visual-3, -7, -11)', () => {
  const position = (title: string): PlaybackPosition =>
    ({ ref: { sourceId: 's', contentType: 'movie', itemId: 'm1' }, positionSeconds: 600, durationSeconds: 6000, updatedAt: '2026-10-16T00:00:00Z', snapshot: { title, contentType: 'movie' } }) as PlaybackPosition;

  it('captions with the cleaned title, isolated for RTL, and snaps the first card to the heading', () => {
    render(
      <I18nWrap>
        <ContinueRail positions={[position('EN - Black Harbor (2026) [4K]')]} onOpen={() => undefined} onRemove={() => undefined} />
      </I18nWrap>,
    );
    const caption = screen.getByText('Black Harbor');
    expect(caption.getAttribute('dir')).toBe('auto');
    expect(caption.className).toContain('text-match-parent');
    expect(screen.getByTestId('continue-rail').className).toContain('scroll-px-1');
  });

  // The title rules themselves are pinned against the core's cases in src/lib/title.test.ts.
  it('Recent and Favorites rows clean old movie and series snapshot titles; channel names stay as saved', () => {
    const row = (contentType: 'movie' | 'series' | 'live', title: string) => (
      <EntryRow
        key={contentType}
        entryRef={{ sourceId: 's', contentType, itemId: contentType }}
        snapshot={{ title, contentType }}
        showSource={false}
        time=""
        removeLabel="Remove"
        menuRemoveLabel="Remove from favorites"
        onOpen={() => undefined}
        onRemove={() => undefined}
      />
    );
    render(
      <I18nWrap>
        {row('movie', 'EN - The Matrix (1999) [4K]')}
        {row('series', '|FR| Le Bureau FHD')}
        {row('live', 'US: News HD')}
      </I18nWrap>,
    );
    expect(screen.getByText('The Matrix')).toBeTruthy();
    expect(screen.getByText('Le Bureau')).toBeTruthy();
    expect(screen.getByText('US: News HD')).toBeTruthy();
    expect(screen.queryByText(/EN - The Matrix/)).toBeNull();
  });
});

describe('Favorites and Recent time column (L2-visual-10)', () => {
  it('keeps the time on one line instead of wrapping in a fixed width', () => {
    render(
      <I18nWrap>
        <EntryRow
          entryRef={{ sourceId: 's', contentType: 'movie', itemId: 'm1' }}
          snapshot={{ title: 'Heat', contentType: 'movie' }}
          showSource={false}
          time="Added 2 minutes ago"
          removeLabel="Remove"
          menuRemoveLabel="Remove from favorites"
          onOpen={() => undefined}
          onRemove={() => undefined}
        />
      </I18nWrap>,
    );
    const time = screen.getByTestId('entry-time');
    expect(time.className).toContain('whitespace-nowrap');
    // Round 2: one fixed width that holds "Added 2 weeks ago" (w-28 wrapped it, a min-width let a
    // longer date push the source column left on its row); a longer one truncates, never wraps.
    expect(time.className).toMatch(/(^|\s)w-36(\s|$)/);
    expect(time.className).toContain('truncate');
    expect(time.className).not.toMatch(/(^|\s)min-w-/);
    expect(time.getAttribute('title')).toBe('Added 2 minutes ago');
  });
});
