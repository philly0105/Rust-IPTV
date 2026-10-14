import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Recording, RecordingFile, Reminder } from '@/api/types';
import { minuteChoices } from '@/features/settings/sections/RecordingSection';
import { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';

import { RecordingsPanel, filterRecordings } from '../components/RecordingsPanel';
import { recordingNote } from '../lib/recordingNote';
import { ScheduledPage } from '../pages/ScheduledPage';
import { fakePlayer, installDomStubs, renderAt } from './harness';

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

const ref = { sourceId: 's1', contentType: 'live' as const, itemId: '7' };
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function rec(over: Partial<Recording>): Recording {
  return {
    id: 'r1',
    ref,
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
    ...over,
  };
}

function file(over: Partial<RecordingFile>): RecordingFile {
  return { id: 'r.r1.0', fileName: 'Alpha - Film - 2026-10-12 1800.ts', recordingId: 'r1', channelName: 'Alpha', title: 'Film', sizeBytes: 2_500_000, date: at(-60), fileAvailable: true, status: 'completed', ...over };
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true, mpv: true });
  fakePlayer.played.length = 0;
});
afterEach(cleanup);

describe('pure helpers', () => {
  it('filterRecordings matches name, channel and title', () => {
    const files = [file({ id: 'a' }), file({ id: 'b', fileName: 'Beta.ts', channelName: 'Beta', title: undefined })];
    expect(filterRecordings(files, '').map((f) => f.id)).toEqual(['a', 'b']);
    expect(filterRecordings(files, ' film ').map((f) => f.id)).toEqual(['a']);
    expect(filterRecordings(files, 'BETA').map((f) => f.id)).toEqual(['b']);
  });

  it('recordingNote translates the core messages and keeps free text', () => {
    const t = (key: string) => `t:${key}`;
    expect(recordingNote({ error: 'Stopped.', errorCode: 'stopped' }, t)).toBe('t:recErrorStopped');
    expect(recordingNote({ error: 'Reconnecting: x', errorCode: 'reconnecting' }, t)).toBe('t:scheduledReconnecting');
    expect(recordingNote({ error: 'HTTP 404' }, t)).toBe('HTTP 404');
    expect(recordingNote({}, t)).toBeUndefined();
  });

  it('minuteChoices keeps an off-list saved value', () => {
    expect(minuteChoices([0, 5, 10], 5)).toEqual([0, 5, 10]);
    expect(minuteChoices([0, 5, 10], 7)).toEqual([0, 5, 7, 10]);
  });
});

describe('ScheduledPage', () => {
  it('shows an empty state that points at the guide', async () => {
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.list'] = () => [];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open TV guide/ }).getAttribute('href')).toBe('/epg');
  });

  it('lists running, upcoming and finished items and cancels a reminder', async () => {
    const reminder: Reminder = { id: 'm1', ref, channelName: 'Alpha', title: 'News', start: at(30), end: at(60), status: 'pending' };
    let reminders = [reminder];
    rpc.handlers['reminders.list'] = () => reminders;
    rpc.handlers['reminders.remove'] = () => {
      reminders = [];
      return null;
    };
    rpc.handlers['recordings.list'] = () => [
      rec({ id: 'run', status: 'recording', start: at(-10), end: at(20), startedAt: at(-11), bytes: 1_000_000 }),
      rec({ id: 'next' }),
      rec({ id: 'bad', status: 'failed', error: 'The stream stopped', end: at(-100) }),
    ];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);

    const now = await screen.findByTestId('scheduled-now');
    expect(within(now).getByText('Film')).toBeTruthy();
    expect(within(now).getByRole('button', { name: 'Stop recording Film' })).toBeTruthy();
    const next = screen.getByTestId('scheduled-upcoming');
    expect(within(next).getByText('News')).toBeTruthy();
    expect(within(screen.getByTestId('scheduled-finished')).getByText('The stream stopped')).toBeTruthy();

    fireEvent.click(within(next).getByRole('button', { name: 'Cancel reminder for News' }));
    await waitFor(() => expect(rpc.callsOf('reminders.remove')).toEqual([{ id: 'm1' }]));
    await waitFor(() => expect(within(screen.getByTestId('scheduled-upcoming')).queryByText('News')).toBeNull());
  });

  it('puts series rules above Upcoming when there are any, and last when there are none (wiring-r1 F4)', async () => {
    const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.list'] = () => [rec({ id: 'next' }), rec({ id: 'old', status: 'completed', end: at(-100) })];
    rpc.handlers['recordings.rules'] = () => [
      { id: 'rule1', ref, channelName: 'Alpha', title: 'Film', enabled: true, createdAt: at(-1000), upcoming: 1, nextStart: at(60) },
    ];
    const view = renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const upcomingList = await screen.findByTestId('scheduled-upcoming');
    const panel = screen.getByTestId('recording-rules');
    expect(within(panel).getByText('Film')).toBeTruthy();
    expect(before(panel, upcomingList)).toBe(true);
    expect(before(panel, screen.getByTestId('scheduled-finished'))).toBe(true);
    expect(screen.getAllByTestId('recording-rules')).toHaveLength(1);
    view.unmount();

    rpc.handlers['recordings.rules'] = () => [];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const upcomingAgain = await screen.findByTestId('scheduled-upcoming');
    expect(before(upcomingAgain, screen.getByTestId('recording-rules'))).toBe(true);
    expect(before(screen.getByTestId('scheduled-finished'), screen.getByTestId('recording-rules'))).toBe(true);
  });

  it('shows a finished recording note in the UI language', async () => {
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.list'] = () => [
      rec({ id: 'gone', status: 'cancelled', error: 'core text A', errorCode: 'sourceRemoved', end: at(-100) }),
      rec({ id: 'missed', status: 'missed', error: 'core text B', errorCode: 'missedNotRunning', end: at(-200) }),
    ];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const done = await screen.findByTestId('scheduled-finished');
    expect(within(done).getByText('The source of this channel was removed.')).toBeTruthy();
    expect(within(done).getByText('The app was not running when this recording was due.')).toBeTruthy();
    expect(within(done).queryByText('core text A')).toBeNull();
  });

  it('explains when the server cannot record', async () => {
    rpc.handlers['recordings.capabilities'] = () => ({ supported: false, mpv: false, reason: 'no mpv' });
    rpc.handlers['reminders.list'] = () => [{ id: 'm1', ref, channelName: 'Alpha', title: 'News', start: at(30), end: at(60), status: 'pending' }];
    rpc.handlers['recordings.list'] = () => [];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    expect(await screen.findByText(/server has no mpv/)).toBeTruthy();
  });
});

describe('RecordingsPanel', () => {
  beforeEach(() => usePendingRemovals.setState({ ids: new Set() }));

  it('plays, flags missing files and filters', async () => {
    rpc.handlers['recordings.library'] = () => [file({}), file({ id: 'r.r1.1', fileName: 'Alpha - Film - 2026-10-12 1800 (part 2).ts', part: 2, fileAvailable: false })];
    rpc.handlers['recordings.playSource'] = (args) => ({ url: `http://x/${(args as { id: string }).id}`, kind: 'vod', title: 'Film' });
    renderAt('/', [{ path: '/', element: <RecordingsPanel search="" /> }]);

    const [first, second, ...rest] = await screen.findAllByTestId('recording-file');
    expect(rest).toHaveLength(0);
    if (!first || !second) throw new Error('expected two rows');
    expect(within(second).getByTestId('recording-missing')).toBeTruthy();
    expect((within(second).getByTestId('recording-play') as HTMLButtonElement).disabled).toBe(true);
    expect(within(second).queryByTestId('recording-reveal')).toBeNull();
    expect(within(first).getByText('2.4 MB', { exact: false })).toBeTruthy();

    fireEvent.click(within(first).getByTestId('recording-play'));
    await waitFor(() => expect(fakePlayer.played.map((s) => s.url)).toEqual(['http://x/r.r1.0']));
  });

  it('deletes with undo: nothing is removed until the undo window passes', async () => {
    rpc.handlers['recordings.library'] = () => [file({})];
    rpc.handlers['recordings.delete'] = () => null;
    renderAt('/', [{ path: '/', element: <RecordingsPanel search="" /> }]);
    fireEvent.click(await screen.findByTestId('recording-delete'));
    await waitFor(() => expect(screen.queryByTestId('recording-file')).toBeNull());
    expect(rpc.callsOf('recordings.delete')).toEqual([]);
  });

  it('shows the empty state', async () => {
    rpc.handlers['recordings.library'] = () => [];
    renderAt('/', [{ path: '/', element: <RecordingsPanel search="" /> }]);
    expect(await screen.findByText('No recordings yet')).toBeTruthy();
  });
});
