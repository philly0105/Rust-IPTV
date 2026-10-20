import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DownloadStatus } from '@/api/types';

import { DialProgress } from '../components/DownloadRow';
import { downloadStartSeconds, playDownload } from '../lib/playDownload';
import { stopTrackingDownloadPosition } from '../lib/positionSync';
import { DownloadsPage } from '../pages/DownloadsPage';
import { MyVideoDetailPage } from '../pages/MyVideoDetailPage';
import { MyVideosPage, librarySubtitle } from '../pages/MyVideosPage';
import { makeDownload } from './fixtures';
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

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['sources.list'] = () => [];
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  fakePlayer.usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
  fakePlayer.played.length = 0;
});
afterEach(() => {
  stopTrackingDownloadPosition();
  cleanup();
});

describe('Start over (L1-guide-library-3)', () => {
  const watched = makeDownload({ id: 7, status: 'completed', positionSeconds: 600 });

  it('names 0 as the start, so neither the core nor the player resumes', () => {
    expect(downloadStartSeconds(watched, { fromStart: true })).toBe(0);
    expect(downloadStartSeconds(watched)).toBe(600);
    expect(downloadStartSeconds(makeDownload({ positionSeconds: 3 }))).toBe(0);
  });

  it('overrides the resume point the core fills in', async () => {
    rpc.handlers['myvideos.playSource'] = () => ({ url: 'file:///x.mp4', kind: 'vod', title: 'X', resumeSeconds: 600 });
    await playDownload(watched, { fromStart: true });
    expect(fakePlayer.played.at(-1)?.resumeSeconds).toBe(0);
    await playDownload(watched);
    expect(fakePlayer.played.at(-1)?.resumeSeconds).toBe(600);
  });
});

describe('DialProgress (L1-guide-library-6)', () => {
  it('draws no fill without a known size, and an indeterminate segment only while downloading', () => {
    const { rerender } = render(<DialProgress percent={undefined} tone="accent" label="p" />);
    const bar = screen.getByRole('progressbar');
    // Only the empty track: no fill, no needle.
    expect(bar.children).toHaveLength(0);
    expect(within(bar).queryByTestId('dial-indeterminate')).toBeNull();
    rerender(<DialProgress percent={undefined} tone="accent" indeterminate label="p" />);
    expect(within(bar).getByTestId('dial-indeterminate')).toBeTruthy();
    rerender(<DialProgress percent={40} tone="accent" indeterminate label="p" />);
    expect(within(bar).queryByTestId('dial-indeterminate')).toBeNull();
  });

  it('a paused row with an unknown size shows an empty track', async () => {
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 1, status: 'paused', totalBytes: undefined, bytesDownloaded: 0 })];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const row = await screen.findByTestId('download-row');
    expect(within(row).queryByTestId('dial-indeterminate')).toBeNull();
  });
});

describe('row actions on the keyboard (L1-guide-library-17)', () => {
  it('puts the tab-stop row actions in the Tab order and shows their shortcut keys', async () => {
    const statuses: DownloadStatus[] = ['downloading', 'queued', 'failed'];
    rpc.handlers['downloads.list'] = () =>
      statuses.map((status, i) => makeDownload({ id: 20 + i, status, title: `T${i}`, createdAt: `2026-10-01T10:0${i}:00Z` }));
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const rows = await screen.findAllByTestId('download-row');
    const tabbable = rows.map((r) => within(r).getAllByRole('button').some((b) => b.tabIndex === 0));
    expect(tabbable).toEqual([true, false, false]);
    // The shortcut shows as a key cap in the button's tooltip (no native title).
    const pause = within(rows[0]!).getByRole('button', { name: 'Pause T0' });
    expect(pause.hasAttribute('title')).toBe(false);
    fireEvent.mouseEnter(pause);
    const tip = await screen.findByRole('tooltip');
    expect([...tip.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['P']);
  });
});

describe('My Videos header (L1-guide-library-18)', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    key === 'libraryTitleCount' ? `${String(vars?.['count'])} titles` : `${String(vars?.['count'])} recordings`;

  // joinList bidi-isolates each part; compare the visible text.
  const subtitle = (args: { titles: number; recordings: number; size: string; lang: string }) =>
    librarySubtitle({ ...args, t }).replace(/[⁨⁩]/g, '');

  it('counts recordings next to titles and joins the parts with the locale separator', () => {
    expect(subtitle({ titles: 8, recordings: 3, size: '94.6 MB', lang: 'en' })).toBe('8 titles, 3 recordings, 94.6 MB');
    expect(subtitle({ titles: 0, recordings: 2, size: '1 GB', lang: 'en' })).toBe('2 recordings, 1 GB');
    expect(subtitle({ titles: 0, recordings: 0, size: '0 B', lang: 'en' })).toBe('0 titles, 0 B');
    expect(subtitle({ titles: 2, recordings: 1, size: '1 GB', lang: 'ja' })).toBe('2 titles、1 recordings、1 GB');
  });
});

describe('Back from a My Videos detail page (L1-guide-library-13)', () => {
  it('returns to the tab the title was opened from', async () => {
    rpc.handlers['myvideos.list'] = () => [makeDownload({ id: 1, status: 'completed', title: 'Heat', fileAvailable: true, completedAt: '2026-10-01T00:00:00Z' })];
    renderAt('/my-videos?filter=movies', [
      { path: '/my-videos', element: <MyVideosPage /> },
      { path: '/my-videos/:id', element: <MyVideoDetailPage /> },
    ]);
    expect((await screen.findByRole('tab', { name: /Movies/ })).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(await screen.findByTestId('library-card'));
    expect(await screen.findByTestId('play-offline')).toBeTruthy();
    fireEvent.click(await screen.findByRole('link', { name: 'Back to My Videos' }));
    expect((await screen.findByRole('tab', { name: /Movies/ })).getAttribute('aria-selected')).toBe('true');
  });
});
