// Hidden-channels dialog (C2): designed loading, error and empty states, a
// filter, Unhide per row and Unhide all (both with Undo), channels the
// provider dropped, and the count for the sidebar entry.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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
    await waitFor(() => expect(cnnRow!.textContent).toContain('No longer in the source'));
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

  it('treats a channel parental Hide mode locks as still in the playlist', async () => {
    hide(bbc, cnn, tve);
    core.lock(cnn.ref);
    core.drop(tve.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [tveRow, cnnRow] = rows();
    await waitFor(() => expect(tveRow!.textContent).toContain('No longer in the source'));
    await waitFor(() => expect(core.itemRefsAsked()).toHaveLength(3));
    expect(cnnRow!.textContent).not.toContain('No longer in the source');

    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    // The locked channel is back (not removed); only the dropped one is counted apart.
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    const back = useToastStore.getState().toasts.find((t) => t.title === '2 channels are back')!;
    expect(back.description).toBe('1 channel the provider no longer lists was removed.');

    act(() => back.action!.onClick());
    await waitFor(() => expect(core.isHidden(bbc.ref) && core.isHidden(cnn.ref)).toBe(true));
    expect(core.callsOf('channels.setHidden').slice(1)[0]).toEqual({ refs: [cnn.ref, bbc.ref], hidden: true });
  });

  it('unhides a locked channel from its row as back, with Undo', async () => {
    hide(cnn);
    core.lock(cnn.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(core.itemRefsAsked()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByTestId('hidden-channel-unhide'));
    await waitFor(() => expect(lastToast()?.title).toBe('CNN International is back'));
    expect(lastToast()?.action?.label).toBe('Undo');
    act(() => lastToast()!.action!.onClick());
    await waitFor(() => expect(core.isHidden(cnn.ref)).toBe(true));
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
    expect(lastToast()?.title).toBe("Couldn't unhide BBC One");
    expect(render(<>{lastToast()?.description}</>).container.querySelector('[data-error-message]')?.textContent).toBe('Database is locked.');
    expect(rowNames()).toEqual(['BBC One']);
  });

  it('unhides all, counting a channel the provider dropped apart, and Undo hides the rest again', async () => {
    hide(bbc, tve, cnn);
    core.drop(tve.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    // One batch: the core unhides a dropped channel too.
    expect(core.callsOf('channels.setHidden')).toEqual([{ refs: [cnn.ref, tve.ref, bbc.ref], hidden: false }]);
    expect(core.edits.size).toBe(0);
    const back = useToastStore.getState().toasts.find((t) => t.title === '2 channels are back')!;
    expect(back.description).toBe('1 channel the provider no longer lists was removed.');
    expect(back.action?.label).toBe('Undo');
    expect(useToastStore.getState().toasts.filter((t) => t.variant === 'error')).toEqual([]);
    expect(await screen.findByText('No hidden channels')).toBeTruthy();

    act(() => back.action!.onClick());
    await waitFor(() => expect(core.isHidden(bbc.ref) && core.isHidden(cnn.ref)).toBe(true));
    // The channels still listed go back in one batch; the dropped one is offered
    // alone and its refusal stays quiet (the toast already called it removed).
    await waitFor(() => expect(core.callsOf('channels.setHidden').slice(1)).toHaveLength(2));
    expect(core.callsOf('channels.setHidden').slice(1)).toEqual([
      { refs: [cnn.ref, bbc.ref], hidden: true },
      { refs: [tve.ref], hidden: true },
    ]);
    expect(core.isHidden(tve.ref)).toBe(false);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(useToastStore.getState().toasts.filter((t) => t.variant === 'error')).toEqual([]);
  });

  it('says how many could not be hidden again when the provider drops one before Undo', async () => {
    hide(bbc, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    const back = useToastStore.getState().toasts.find((t) => t.title === '2 channels are back')!;
    expect(back.description).toBeUndefined();

    core.drop(cnn.ref);
    act(() => back.action!.onClick());
    await waitFor(() => expect(lastToast()?.variant).toBe('error'));
    expect(lastToast()?.title).toBe("1 channel couldn't be hidden again");
    expect(lastToast()?.description).toBe('The provider no longer lists this channel.');
    // The batch was refused for the dropped ref, so each ref went alone.
    expect(core.isHidden(bbc.ref)).toBe(true);
    expect(core.isHidden(cnn.ref)).toBe(false);
  });

  it('says Undo failed when nothing could be hidden again', async () => {
    hide(bbc, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    core.override('channels.setHidden', () => fail('internal', 'Database is locked.'));
    act(() => useToastStore.getState().toasts.find((t) => t.title === '2 channels are back')!.action!.onClick());
    await waitFor(() => expect(lastToast()?.variant).toBe('error'));
    expect(lastToast()?.title).toBe("Couldn't undo");
    expect(render(<>{lastToast()?.description}</>).container.querySelector('[data-error-message]')?.textContent).toBe('Database is locked.');
  });

  it('says channels the provider dropped were removed, without Undo, when none of them came back', async () => {
    hide(tve, cnn);
    core.drop(tve.ref);
    core.drop(cnn.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(lastToast()?.title).toBe('2 channels removed from Hidden channels'));
    expect(lastToast()?.description).toBe('The provider no longer lists these channels.');
    expect(lastToast()?.action).toBeUndefined();
    expect(toastTitles().some((t) => t.includes('back'))).toBe(false);
    expect(core.edits.size).toBe(0);
  });

  it('unhides a dropped channel from its row with its own toast and no Undo', async () => {
    hide(bbc, cnn);
    core.drop(cnn.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(rows()[0]!.textContent).toContain('No longer in the source'));
    // The row has asked catalog.item already; the toast reuses that answer
    // (asking again now would fail differently and count as listed).
    core.override('catalog.item', () => fail('internal', 'Database is locked.'));
    fireEvent.click(within(rows()[0]!).getByTestId('hidden-channel-unhide'));
    await waitFor(() => expect(lastToast()?.title).toBe('CNN International removed from Hidden channels'));
    expect(lastToast()?.description).toBe('The provider no longer lists this channel.');
    expect(lastToast()?.action).toBeUndefined();
    expect(core.isHidden(cnn.ref)).toBe(false);
    expect(rowNames()).toEqual(['BBC One']);
  });

  it('retries one ref at a time when an older core refuses a batch for a dropped channel', async () => {
    const strict = (raw: unknown) => {
      const a = raw as { refs: import('@/api/types').ItemRef[]; hidden: boolean };
      if (!a.hidden && a.refs.some((r) => r.itemId === tve.ref.itemId)) fail('not_found', 'Channel c2 is not in the catalog.');
      return core.base('channels.setHidden')(raw);
    };
    core.override('channels.setHidden', strict);
    hide(bbc, tve, cnn);
    core.drop(tve.ref);
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('2 channels are back'));
    expect(toastTitles()).toContain("1 channel couldn't be unhidden");
    const failed = useToastStore.getState().toasts.find((t) => t.variant === 'error')!;
    expect(failed.description).toBe('The provider no longer lists this channel.');
    // One batch, refused for the missing ref, then each ref alone.
    const sent = core.callsOf('channels.setHidden') as { refs: unknown[] }[];
    expect(sent[0]!.refs).toHaveLength(3);
    expect(sent.slice(1).every((c) => c.refs.length === 1)).toBe(true);
    expect(core.isHidden(bbc.ref)).toBe(false);
    expect(core.isHidden(cnn.ref)).toBe(false);
    await waitFor(() => expect(rowNames()).toEqual(['TVE España']));
  });

  it('asks the rows’ channels in one catalog.items call, and Unhide all over 1,000 in two (F5-4)', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => makeChannel(`m${i}`, `Channel ${i}`));
    core.add(...many);
    hide(...many);
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const shown = rows().length;
    await waitFor(() => expect(core.itemRefsAsked()).toHaveLength(shown));
    // Before F5-4: one catalog.item call per mounted row.
    expect(core.callsOf('catalog.item')).toEqual([]);
    expect(core.callsOf('catalog.items')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('hidden-channels-unhide-all'));
    await waitFor(() => expect(toastTitles()).toContain('1,000 channels are back'));
    expect(core.callsOf('channels.setHidden')).toHaveLength(2);
    // The rows' answers are reused; the rest go 500 refs a call, one call after the other (before:
    // a catalog.item call per ref, six at a time). The edit's own refresh may then refetch the rows
    // still mounted (here the core answers within one task, before the list re-renders empty).
    const sizes = (core.callsOf('catalog.items') as { refs: unknown[] }[]).map((a) => a.refs.length);
    expect(sizes.slice(0, 3)).toEqual([shown, 500 - shown, 500]);
    expect(sizes.length).toBeLessThanOrEqual(4);
    expect(new Set(core.itemRefsAsked().map((r) => r.itemId)).size).toBe(1000);
    expect(core.callsOf('catalog.item')).toEqual([]);
  });

  it('sizes the list to its rows, up to a cap', async () => {
    hide(bbc, cnn);
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const list = screen.getByTestId('hidden-channels-list');
    expect(list.className).toMatch(/(^|\s)max-h-\[/);
    expect(list.className).not.toMatch(/(^|\s)h-\[/);
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

  it('resets every edit of the source after asking, renames included (channels.reset)', async () => {
    hide(bbc);
    core.seed(cnn.ref, { name: 'CNN' });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(await screen.findByTestId('hidden-channels-reset'));
    expect(screen.getByTestId('hidden-channels-reset-confirm').textContent).toMatch(/provider's name back/);
    expect(core.callsOf('channels.reset')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('hidden-channels-reset-yes'));
    await waitFor(() => expect(toastTitles()).toContain('Channel edits reset'));
    expect(core.callsOf('channels.reset')).toEqual([{ sourceId: 'src1' }]);
    expect(core.isHidden(bbc.ref)).toBe(false);
    expect(core.nameOf(cnn.ref)).toBeUndefined();
    await waitFor(() => expect(screen.queryByText('No hidden channels')).toBeTruthy());
  });

  it('offers the reset for renames alone, and Cancel keeps them', async () => {
    core.seed(cnn.ref, { name: 'CNN' });
    open();
    expect(await screen.findByText('No hidden channels')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('hidden-channels-reset'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('hidden-channels-reset-confirm')).toBeNull();
    expect(core.callsOf('channels.reset')).toHaveLength(0);
    expect(core.nameOf(cnn.ref)).toBe('CNN');
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
