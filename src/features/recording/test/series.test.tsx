/**
 * Record series from a guide programme (Run 2 C5): the confirm dialog names the series and
 * the channel, Cancel adds nothing, confirm sends `recordings.addRule`, a conflict reads as
 * "already a series", an existing rule shows as on or paused and offers removal, and a
 * recording a rule made carries the series mark.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { RpcError } from '@/api/transport';
import type { EpgProgram, ItemRef, Recording } from '@/api/types';
import { createRpcMock, installDomStubs, LIVE_REF, renderGuide, rule, settings } from '@/features/live/guide/test/harness';
import { useToastStore } from '@/ui';

import { ProgramActions } from '../components/ProgramActions';
import { ScheduleMark } from '../components/ScheduleMark';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('@/features/live/guide/test/harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../live/test/fakes'));
vi.mock('@/features/player', async () => await import('../../live/test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../live/test/fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const REF = LIVE_REF('c1');
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();
const PROGRAM: EpgProgram = { channelId: 'ch', title: 'Evening News', start: iso(NOW + 3_600_000), end: iso(NOW + 7_200_000) };

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'rec1',
    ref: REF,
    channelName: 'Channel 1',
    title: 'Evening News',
    kind: 'programme',
    start: PROGRAM.start,
    end: PROGRAM.end,
    paddingBeforeMinutes: 1,
    paddingAfterMinutes: 5,
    status: 'scheduled',
    fileNames: [],
    bytes: 0,
    ...over,
  };
}

beforeAll(installDomStubs);
beforeEach(() => {
  // The actions invalidate through the app's client, so the tests render with it.
  queryClient.clear();
  rpc.reset();
  useToastStore.setState({ toasts: [] });
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true });
  rpc.handlers['settings.get'] = () => settings();
  rpc.handlers['reminders.list'] = () => [];
  rpc.handlers['recordings.list'] = () => [];
  rpc.handlers['recordings.rules'] = () => [];
});
afterEach(cleanup);

const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

function actions(over: { ref?: ItemRef; program?: EpgProgram; variant?: 'buttons' | 'icons' } = {}) {
  return renderGuide(
    <div>
      <ProgramActions channelRef={over.ref ?? REF} channelName="Channel 1" program={over.program ?? PROGRAM} now={NOW} variant={over.variant} />
    </div>,
    queryClient,
  );
}

const seriesButton = () => screen.findByTestId('program-record-series');

describe('Record series', () => {
  it('asks first, naming the series and the channel; Cancel adds nothing', async () => {
    actions();
    const button = await seriesButton();
    expect(button.textContent).toContain('Record series');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    const dialog = await screen.findByTestId('series-confirm');
    expect(within(dialog).getByRole('heading', { name: 'Record series?' })).toBeTruthy();
    expect(within(dialog).getByText('Evening News')).toBeTruthy();
    expect(within(dialog).getByText('Channel 1')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByTestId('series-confirm-ok')));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('series-confirm')).toBeNull());
    expect(rpc.of('recordings.addRule')).toEqual([]);
  });

  it('confirming adds the rule, says so and refreshes the schedule', async () => {
    rpc.handlers['recordings.addRule'] = (args) => rule({ ...(args as object), id: 'new', upcoming: 4 });
    actions();
    fireEvent.click(await seriesButton());
    const rulesBefore = rpc.of('recordings.rules').length;
    fireEvent.click(await screen.findByTestId('series-confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId('series-confirm')).toBeNull());
    expect(rpc.of('recordings.addRule')).toEqual([{ ref: REF, channelName: 'Channel 1', title: 'Evening News' }]);
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.title).toBe('Recording every “Evening News”');
    expect(toast.description).toBe('Scheduled now: 4');
    await waitFor(() => expect(rpc.of('recordings.rules').length).toBeGreaterThan(rulesBefore));
  });

  it('a conflict reads as "already a series" and keeps the dialog open', async () => {
    rpc.handlers['recordings.addRule'] = () => {
      throw new RpcError('conflict', 'rule exists');
    };
    actions();
    fireEvent.click(await seriesButton());
    fireEvent.click(await screen.findByTestId('series-confirm-ok'));
    await waitFor(() => expect(toastTitles()).toContain('“Evening News” is already a series'));
    expect(screen.getByTestId('series-confirm')).toBeTruthy();
  });

  it('another failure shows its message', async () => {
    rpc.handlers['recordings.addRule'] = () => {
      throw new RpcError('io', 'disk is full');
    };
    actions();
    fireEvent.click(await seriesButton());
    fireEvent.click(await screen.findByTestId('series-confirm-ok'));
    await waitFor(() => expect(toastTitles()).toContain('Could not add the series'));
    expect(render(<>{useToastStore.getState().toasts.at(-1)!.description}</>).container.querySelector('[data-error-message]')?.textContent).toBe('disk is full');
  });

  it('an existing rule shows as on, and pressing it asks to remove the series', async () => {
    rpc.handlers['recordings.rules'] = () => [rule({ title: 'EVENING NEWS!', upcoming: 2 })];
    rpc.handlers['recordings.removeRule'] = () => null;
    actions();
    await waitFor(() => expect(screen.getByTestId('program-record-series').textContent).toContain('Series on'));
    const button = screen.getByTestId('program-record-series');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    const dialog = await screen.findByTestId('rule-remove-confirm');
    expect((within(dialog).getByTestId('rule-remove-cancel-scheduled') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByTestId('rule-remove-ok'));
    await waitFor(() => expect(rpc.of('recordings.removeRule')).toEqual([{ id: 'rule1', keepScheduled: false }]));
    await waitFor(() => expect(screen.queryByTestId('rule-remove-confirm')).toBeNull());
  });

  it('a paused rule reads "Series paused"', async () => {
    rpc.handlers['recordings.rules'] = () => [rule({ enabled: false })];
    actions();
    await waitFor(() => expect(screen.getByTestId('program-record-series').textContent).toContain('Series paused'));
  });

  it('the icon variant labels the same button', async () => {
    actions({ variant: 'icons' });
    const button = await seriesButton();
    expect(button.getAttribute('aria-label')).toBe('Record series');
    fireEvent.click(button);
    expect(await screen.findByTestId('series-confirm')).toBeTruthy();
  });

  it('is not offered for films, titles without letters, or without recording support', async () => {
    const vod: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm1' };
    actions({ ref: vod });
    await screen.findByTestId('program-record');
    expect(screen.queryByTestId('program-record-series')).toBeNull();
    cleanup();

    actions({ program: { ...PROGRAM, title: '***' } });
    await screen.findByTestId('program-record');
    expect(screen.queryByTestId('program-record-series')).toBeNull();
    cleanup();

    queryClient.clear();
    rpc.handlers['recordings.capabilities'] = () => ({ supported: false });
    actions();
    await screen.findByTestId('record-unavailable');
    expect(screen.queryByTestId('program-record-series')).toBeNull();
  });
});

describe('ScheduleMark', () => {
  it('marks a recording a series rule made', async () => {
    rpc.handlers['recordings.list'] = () => [recording({ ruleId: 'rule1' })];
    renderGuide(<ScheduleMark channelRef={REF} program={PROGRAM} />, queryClient);
    const mark = await screen.findByTestId('mark-recording');
    expect(mark.hasAttribute('data-series')).toBe(true);
    expect(mark.getAttribute('title')).toBe('Series');
    expect(mark.textContent).toContain(', Series');
  });

  it('a one-off recording has no series mark', async () => {
    rpc.handlers['recordings.list'] = () => [recording()];
    renderGuide(<ScheduleMark channelRef={REF} program={PROGRAM} />, queryClient);
    const mark = await screen.findByTestId('mark-recording');
    expect(mark.hasAttribute('data-series')).toBe(false);
    expect(mark.textContent).not.toContain('Series');
  });
});
