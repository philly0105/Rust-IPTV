// Hidden-channels dialog (C2): designed loading, error and empty states, a
// filter, Unhide per row and Unhide all (both with Undo), channels the
// provider dropped, and the count for the sidebar entry.
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { useToastStore } from '@/ui';

import { HiddenChannelsDialog, useHiddenChannelCount } from '..';
import { core, fail, installDomStubs, makeChannel, Providers, renderUi } from './harness';

vi.mock('@/api/transport', async (orig) => {
  const actual = await orig<typeof import('@/api/transport')>();
  const { core } = await import('./harness');
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await core.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', async () => (await import('./harness')).eventsMock);

const bbc = makeChannel('c1', 'BBC One');
const tve = makeChannel('c2', 'TVE España');
const cnn = makeChannel('c3', 'CNN International');
const jazz = makeChannel('r1', 'Jazz FM', 'radio');
const lastToast = () => useToastStore.getState().toasts.at(-1);
const toastTitles = () => useToastStore.getState().toasts.map((t) => String(t.title));
const rows = () => screen.queryAllByTestId('hidden-channel-row');
const rowNames = () => rows().map((r) => r.querySelector('[dir="auto"]')!.textContent);

function open(onOpenChange = vi.fn()) {
  const view = renderUi(<HiddenChannelsDialog sourceId="src1" open onOpenChange={onOpenChange} />, queryClient);
  return { ...view, onOpenChange };
}

/** Hides channels in the core, oldest first (the list shows newest first). */
function hide(...refs: { ref: import('@/api/types').ItemRef }[]) {
  for (const { ref } of refs) core.seed(ref, { hidden: true });
}

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset();
  core.add(bbc, tve, cnn, jazz);
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('HiddenChannelsDialog', () => {
  it('renders nothing while closed', () => {
    renderUi(<HiddenChannelsDialog sourceId="src1" open={false} onOpenChange={() => undefined} />, queryClient);
    expect(screen.queryByTestId('hidden-channels-dialog')).toBeNull();
    expect(core.callsOf('channels.edits')).toHaveLength(0);
  });

  it('shows a loading state, then the hidden channels newest first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    core.override('channels.edits', async (args) => {
      await gate;
      return core.base('channels.edits')(args);
    });
    hide(bbc, cnn);
    open();
    const loading = await within(await screen.findByTestId('hidden-channels-dialog')).findByRole('status');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    act(() => release());
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowNames()).toEqual(['CNN International', 'BBC One']);
    expect(core.callsOf('channels.edits')[0]).toEqual({ sourceId: 'src1', hiddenOnly: true });
    expect(screen.getByTestId('hidden-channels-summary').textContent).toBe('2 hidden channels');
  });

  it('says how to hide a channel when none is hidden, and Done closes', async () => {
    const { onOpenChange } = open();
    expect(await screen.findByText('No hidden channels')).toBeTruthy();
    expect(screen.getByText(/press Shift\+Delete/)).toBeTruthy();
    expect(screen.queryByTestId('hidden-channels-unhide-all')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows an error with Retry', async () => {
    hide(bbc);
    let broken = true;
    core.override('channels.edits', (args) => (broken ? fail('internal', 'Database is locked.') : core.base('channels.edits')(args)));
    open();
    const retry = await screen.findByRole('button', { name: /retry|try again/i });
    broken = false;
    fireEvent.click(retry);
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('shows the provider name of a renamed channel, the radio tag in a mixed list, and channels the provider dropped', async () => {
    core.seed(bbc.ref, { hidden: true, name: 'My News', originalName: 'BBC One' });
    hide(jazz, cnn);
    core.drop(cnn.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [cnnRow, jazzRow, bbcRow] = rows();
    expect(within(bbcRow!).getByText('My News')).toBeTruthy();
    expect(bbcRow!.textContent).toContain("Provider's name: BBC One");
    expect(within(jazzRow!).getByText('Radio')).toBeTruthy();
    await waitFor(() => expect(cnnRow!.textContent).toContain('No longer in the playlist'));
    const unhide = within(bbcRow!).getByTestId('hidden-channel-unhide');
    expect(unhide.getAttribute('aria-label')).toBe('Unhide My News');
  });

  it('filters by name, ignoring case and accents, and by provider name', async () => {
    core.seed(bbc.ref, { hidden: true, name: 'My News', originalName: 'BBC One' });
    hide(tve, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const filter = screen.getByTestId('hidden-channels-filter');
    fireEvent.change(filter, { target: { value: 'espana' } });
    expect(rowNames()).toEqual(['TVE España']);
    expect(screen.getByTestId('hidden-channels-summary').textContent).toBe('1 of 3');
    expect(screen.getByTestId('hidden-channels-unhide-all').textContent).toBe('Unhide shown');
    fireEvent.change(filter, { target: { value: 'bbc' } });
    expect(rowNames()).toEqual(['My News']);
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(rows()).toHaveLength(0);
    expect(screen.getByText('No hidden channel matches.')).toBeTruthy();
    expect((screen.getByTestId('hidden-channels-unhide-all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('unhides a row at once, with Undo that hides it again', async () => {
    hide(bbc, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(within(rows()[1]!).getByTestId('hidden-channel-unhide'));
    // Gone from the list before the core answers.
    expect(rowNames()).toEqual(['CNN International']);
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(false));
    expect(core.callsOf('channels.setHidden')).toEqual([{ refs: [bbc.ref], hidden: false }]);
    await waitFor(() => expect(lastToast()?.title).toBe('BBC One is back'));
    expect(screen.getByTestId('hidden-channels-summary').textContent).toBe('1 hidden channel');

    act(() => lastToast()!.action!.onClick());
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(true));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('puts a row back when the core refuses, and says why', async () => {
    hide(bbc);
    core.override('channels.setHidden', () => fail('internal', 'Database is locked.'));
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('hidden-channel-unhide'));
    await waitFor(() => expect(lastToast()?.variant).toBe('error'));
    expect(lastToast()?.title).toBe('Could not unhide BBC One');
    expect(lastToast()?.description).toBe('Database is locked.');
    expect(rowNames()).toEqual(['BBC One']);
  });

  it('unhides all, one by one where the provider dropped a channel, with Undo', async () => {
    hide(bbc, tve, cnn);
    core.drop(tve.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    expect(toastTitles()).toContain('1 channel could not be unhidden');
    const failed = useToastStore.getState().toasts.find((t) => t.variant === 'error')!;
    expect(failed.description).toBe('The provider no longer lists this channel.');
    // One batch, refused for the missing ref, then each ref alone.
    const sent = core.callsOf('channels.setHidden') as { refs: unknown[] }[];
    expect(sent[0]!.refs).toHaveLength(3);
    expect(sent.slice(1).every((c) => c.refs.length === 1)).toBe(true);
    expect(core.isHidden(bbc.ref)).toBe(false);
    expect(core.isHidden(cnn.ref)).toBe(false);
    await waitFor(() => expect(rowNames()).toEqual(['TVE España']));

    const done = useToastStore.getState().toasts.find((t) => t.title === '2 channels are back')!;
    act(() => done.action!.onClick());
    await waitFor(() => expect(core.isHidden(bbc.ref) && core.isHidden(cnn.ref)).toBe(true));
  });

  it('unhides only the filtered rows with Unhide shown', async () => {
    hide(bbc, tve, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.change(screen.getByTestId('hidden-channels-filter'), { target: { value: 'c' } });
    expect(rowNames()).toEqual(['CNN International', 'BBC One']);
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    expect(core.callsOf('channels.setHidden')).toEqual([{ refs: [cnn.ref, bbc.ref], hidden: false }]);
    expect(core.isHidden(tve.ref)).toBe(true);
  });

  it('moves between rows with the arrow keys, one Tab stop for the list', async () => {
    hide(bbc, tve, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const buttons = () => screen.getAllByTestId('hidden-channel-unhide');
    expect(buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    buttons()[0]!.focus();
    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(buttons()[1]));
    expect(buttons().map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(buttons()[1]!, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(buttons()[2]));
    fireEvent.keyDown(buttons()[2]!, { key: 'Home' });
    await waitFor(() => expect(document.activeElement).toBe(buttons()[0]));
    // Down from the filter enters the list.
    const filter = screen.getByTestId('hidden-channels-filter');
    filter.focus();
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(buttons()[0]));
  });

  it('gives focus to the next row after an unhide', async () => {
    hide(bbc, tve, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const middle = screen.getAllByTestId('hidden-channel-unhide')[1]!;
    middle.focus();
    fireEvent.click(middle);
    await waitFor(() => expect(rowNames()).toEqual(['CNN International', 'BBC One']));
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByTestId('hidden-channel-unhide')[1]));
  });
});

describe('useHiddenChannelCount', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <Providers client={queryClient}>{children}</Providers>;

  it('is undefined without a source and counts hidden channels with one', async () => {
    hide(bbc, cnn);
    core.seed(tve.ref, { name: 'Renamed only' });
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useHiddenChannelCount(id), {
      wrapper,
      initialProps: {} as { id?: string },
    });
    expect(result.current).toBeUndefined();
    rerender({ id: 'src1' });
    await waitFor(() => expect(result.current).toBe(2));
  });
});
