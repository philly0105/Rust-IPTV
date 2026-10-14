// Channel menu entries (C2): Rename..., Reset name only while renamed, Hide
// with an Undo toast, Unhide for a channel that is hidden already.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Channel } from '@/api/types';
import { useToastStore } from '@/ui';

import { ChannelEditDialogHost, useChannelEditMenuItems } from '..';
import { core, installDomStubs, makeChannel, Providers, renderUi } from './harness';

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

/** Renders the entries as buttons, the way a context menu would. */
function Menu({ channel }: { channel: Channel | null }) {
  const items = useChannelEditMenuItems(channel);
  return (
    <>
      <ul data-testid="menu" data-count={items.length}>
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" data-id={i.id} data-hint={i.hint} onClick={i.onSelect}>
              {i.label}
            </button>
          </li>
        ))}
      </ul>
      <ChannelEditDialogHost />
    </>
  );
}

const bbc = makeChannel('c1', 'BBC One');
const jazz = makeChannel('r1', 'Jazz FM', 'radio');
const ids = () => [...screen.getByTestId('menu').querySelectorAll('button')].map((b) => b.dataset['id']);
const lastToast = () => useToastStore.getState().toasts.at(-1);

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset();
  core.add(bbc, jazz);
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('useChannelEditMenuItems', () => {
  it('gives nothing without a channel, or for movies and series', () => {
    const { rerender } = renderUi(<Menu channel={null} />, queryClient);
    expect(screen.getByTestId('menu').dataset['count']).toBe('0');
    const movie = { ...bbc, ref: { ...bbc.ref, contentType: 'movie' as const } };
    rerender(
      <Providers client={queryClient}>
        <Menu channel={movie} />
      </Providers>,
    );
    expect(screen.getByTestId('menu').dataset['count']).toBe('0');
    expect(core.callsOf('channels.edits')).toHaveLength(0);
  });

  it('offers Rename and Hide with their shortcut hints, and no Reset for a plain channel', async () => {
    renderUi(<Menu channel={bbc} />, queryClient);
    await waitFor(() => expect(core.callsOf('channels.edits')).toHaveLength(1));
    expect(ids()).toEqual(['channel-rename', 'channel-hide']);
    expect(screen.getByRole('button', { name: 'Rename…' }).dataset['hint']).toBe('F2');
    expect(screen.getByRole('button', { name: 'Hide channel' }).dataset['hint']).toMatch(/Shift\+Del/);
  });

  it('says station for radio', async () => {
    renderUi(<Menu channel={jazz} />, queryClient);
    expect(await screen.findByRole('button', { name: 'Hide station' })).toBeTruthy();
  });

  it('hides with a toast whose Undo shows the channel again', async () => {
    renderUi(<Menu channel={bbc} />, queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Hide channel' }));
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(true));
    expect(core.callsOf('channels.setHidden')).toEqual([{ refs: [bbc.ref], hidden: true }]);
    const toast = lastToast()!;
    expect(toast.variant).toBe('success');
    expect(toast.title).toBe('BBC One hidden');
    expect(toast.description).toBe('Find it under Hidden channels.');
    expect(toast.action?.label).toBe('Undo');

    act(() => toast.action!.onClick());
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(false));
    expect(core.callsOf('channels.setHidden').at(-1)).toEqual({ refs: [bbc.ref], hidden: false });
    await waitFor(() => expect(lastToast()?.title).toBe('BBC One is back'));
    // Undoing a hide does not offer to hide again.
    expect(lastToast()?.action).toBeUndefined();
  });

  it('says why a hide failed', async () => {
    core.drop(bbc.ref);
    renderUi(<Menu channel={bbc} />, queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Hide channel' }));
    await waitFor(() => expect(lastToast()?.variant).toBe('error'));
    expect(lastToast()?.title).toBe('Could not hide BBC One');
    expect(lastToast()?.description).toBe('The provider no longer lists this channel.');
  });

  it('sends one hide for a double click', async () => {
    renderUi(<Menu channel={bbc} />, queryClient);
    const hide = screen.getByRole('button', { name: 'Hide channel' });
    fireEvent.click(hide);
    fireEvent.click(hide);
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(true));
    expect(core.callsOf('channels.setHidden')).toHaveLength(1);
  });

  it('offers Reset name only while renamed, with Undo back to the custom name', async () => {
    core.seed(bbc.ref, { name: 'My News', originalName: 'BBC One' });
    const renamed = { ...bbc, name: 'My News' };
    renderUi(<Menu channel={renamed} />, queryClient);
    const reset = await screen.findByRole('button', { name: 'Reset name' });
    expect(ids()).toEqual(['channel-rename', 'channel-reset-name', 'channel-hide']);

    fireEvent.click(reset);
    await waitFor(() => expect(core.nameOf(bbc.ref)).toBeUndefined());
    expect(core.callsOf('channels.rename')).toEqual([{ ref: bbc.ref, name: null }]);
    await waitFor(() => expect(lastToast()?.title).toBe('Name reset to BBC One'));
    // The edit list refreshed: no custom name, no Reset.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset name' })).toBeNull());

    act(() => lastToast()!.action!.onClick());
    await waitFor(() => expect(core.nameOf(bbc.ref)).toBe('My News'));
  });

  it('offers Unhide for a channel that is hidden already', async () => {
    core.seed(bbc.ref, { hidden: true });
    renderUi(<Menu channel={bbc} />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide' }));
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(false));
    await waitFor(() => expect(lastToast()?.title).toBe('BBC One is back'));
    expect(lastToast()?.action?.label).toBe('Undo');
  });

  it('opens the rename dialog from Rename…', async () => {
    renderUi(<Menu channel={bbc} />, queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const dialog = await screen.findByTestId('channel-rename-dialog');
    expect(dialog.textContent).toContain('Rename channel');
  });
});
