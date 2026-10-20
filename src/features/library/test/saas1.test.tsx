/**
 * Product redesign, stage 1 (library): download feedback (VL-download-feedback), Undo on a
 * cancelled recording or reminder (VL-cancel-recording), the library pages fill the outlet instead
 * of hard-coding the window height (VL-fixed-height-pages), the Clear failed button
 * (VL-clear-finished-copy) and the kit card style on My Videos (VL-library-cards).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Download, Recording, Reminder } from '@/api/types';
import { useToastStore } from '@/ui';

import { DownloadWatcher, downloadToastId, downloadTransitions } from '../components/DownloadWatcher';
import { DownloadsPage } from '../pages/DownloadsPage';
import { ScheduledPage } from '../pages/ScheduledPage';
import { fakePlayer, i18n, installDomStubs, renderAt } from './harness';

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

const ref = { sourceId: 's1', contentType: 'movie' as const, itemId: 'm1' };
const dl = (over: Partial<Download>): Download => ({
  id: 1,
  ref,
  title: 'Heat',
  url: 'http://x/heat.mkv',
  status: 'downloading',
  bytesDownloaded: 10,
  totalBytes: 100,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
  positionSeconds: 0,
  ...over,
});
const toasts = () => useToastStore.getState().toasts;

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true, mpv: true });
  fakePlayer.played.length = 0;
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('VL-download-feedback: a download says when it finishes or fails', () => {
  it('finds the downloads whose status turned completed or failed', () => {
    const before = new Map([
      [1, 'downloading' as const],
      [2, 'downloading' as const],
      [3, 'completed' as const],
    ]);
    const { finished, failed } = downloadTransitions(before, [dl({ id: 1, status: 'completed' }), dl({ id: 2, status: 'failed' }), dl({ id: 3, status: 'completed' })]);
    expect(finished.map((d) => d.id)).toEqual([1]);
    expect(failed.map((d) => d.id)).toEqual([2]);
  });

  it('stays quiet on the first answer, then toasts Play for a finished one and Retry for a failed one', async () => {
    let list = [dl({ id: 1 }), dl({ id: 2, title: 'Ronin' })];
    rpc.handlers['downloads.list'] = () => list;
    rpc.handlers['myvideos.playSource'] = () => ({ url: 'http://local/1', title: 'Heat', isLive: false });
    rpc.handlers['downloads.retry'] = () => null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <DownloadWatcher />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    // The first answer has landed (a refetch while it is in flight would replace it).
    await waitFor(() => expect(client.getQueryData(['downloads.list', null])).toHaveLength(2));
    expect(toasts()).toHaveLength(0);

    list = [dl({ id: 1, status: 'completed' }), dl({ id: 2, title: 'Ronin', status: 'failed', errorMessage: 'HTTP 503' })];
    await act(() => client.invalidateQueries({ queryKey: ['downloads.list'] }));
    await waitFor(() => expect(toasts()).toHaveLength(2));
    const done = toasts().find((x) => x.id === downloadToastId(1))!;
    expect(done.title).toBe('Downloaded Heat');
    act(() => done.action!.onClick());
    await waitFor(() => expect(fakePlayer.played).toHaveLength(1));
    const failed = toasts().find((x) => x.id === downloadToastId(2))!;
    expect(failed.variant).toBe('error');
    expect(failed.description).toBe('HTTP 503');
    act(() => failed.action!.onClick());
    await waitFor(() => expect(rpc.callsOf('downloads.retry')).toEqual([{ id: 2 }]));
  });
});

describe('VL-cancel-recording: cancelling from Scheduled can be undone', () => {
  const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const live = { sourceId: 's1', contentType: 'live' as const, itemId: '7' };
  const rec: Recording = {
    id: 'r1',
    ref: live,
    channelName: 'Alpha',
    title: 'Film',
    kind: 'programme',
    start: at(60),
    end: at(120),
    paddingBeforeMinutes: 1,
    paddingAfterMinutes: 5,
    status: 'scheduled',
    fileNames: [],
    bytes: 0,
  };

  it('a cancelled recording toasts Undo, which schedules the same programme again', async () => {
    let recordings = [rec];
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.list'] = () => recordings;
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.library'] = () => [];
    rpc.handlers['recordings.cancel'] = () => {
      recordings = [];
      return null;
    };
    rpc.handlers['recordings.schedule'] = () => ({ recording: rec });
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const row = await screen.findByTestId('upcoming-row');
    fireEvent.click(within(row).getByTestId('upcoming-cancel'));
    await waitFor(() => expect(rpc.callsOf('recordings.cancel')).toEqual([{ id: 'r1' }]));
    const toast = await waitFor(() => {
      const found = toasts().find((x) => x.action);
      expect(found).toBeTruthy();
      return found!;
    });
    act(() => toast.action!.onClick());
    await waitFor(() =>
      expect(rpc.callsOf('recordings.schedule')).toEqual([{ ref: live, channelName: 'Alpha', title: 'Film', start: rec.start, end: rec.end }]),
    );
  });

  it('a removed reminder toasts Undo, which adds it back', async () => {
    const reminder: Reminder = { id: 'm1', ref: live, channelName: 'Alpha', title: 'News', start: at(30), end: at(60), status: 'pending' };
    let reminders = [reminder];
    rpc.handlers['reminders.list'] = () => reminders;
    rpc.handlers['recordings.list'] = () => [];
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.library'] = () => [];
    rpc.handlers['reminders.remove'] = () => {
      reminders = [];
      return null;
    };
    rpc.handlers['reminders.add'] = () => reminder;
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    fireEvent.click(within(await screen.findByTestId('upcoming-row')).getByTestId('upcoming-cancel'));
    const toast = await waitFor(() => {
      const found = toasts().find((x) => x.action);
      expect(found).toBeTruthy();
      return found!;
    });
    act(() => toast.action!.onClick());
    await waitFor(() =>
      expect(rpc.callsOf('reminders.add')).toEqual([{ ref: live, channelName: 'Alpha', title: 'News', start: reminder.start, end: reminder.end }]),
    );
  });
});

describe('VL-clear-finished-copy: the clear button names what it removes and sits with those rows', () => {
  it('shows "Clear failed" in the Needs attention heading', async () => {
    rpc.handlers['downloads.list'] = () => [dl({ id: 1 }), dl({ id: 2, status: 'failed' })];
    rpc.handlers['downloads.dir'] = () => ({ path: '/data' });
    rpc.handlers['sources.list'] = () => [];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    // The kit's SectionHeader: the count is part of the heading ("Needs attention 1").
    const heading = await screen.findByRole('heading', { name: /^Needs attention/ });
    expect(within(heading.parentElement!).getByRole('button', { name: 'Clear failed' })).toBeTruthy();
    expect(screen.queryByText('Clear finished')).toBeNull();
  });
});

describe('VL-fixed-height-pages: library pages fill the outlet', () => {
  it('no page in the library or My List sets its height from the window', () => {
    const dirs = [join(__dirname, '..', 'pages'), join(__dirname, '..', '..', 'mylist', 'pages')];
    const offenders = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.tsx'))
        .filter((f) => /100dvh|100vh/.test(readFileSync(join(dir, f), 'utf8')))
        .map((f) => f),
    );
    // With the external-player footer up, a 100dvh page was ~41px taller than <main> (ShellLayout).
    expect(offenders).toEqual([]);
  });
});
