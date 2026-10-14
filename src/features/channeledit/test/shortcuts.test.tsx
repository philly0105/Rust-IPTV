// F2 renames and Shift+Delete hides the focused channel row (C2), bound only
// while there is one, never while typing, and once per key press.
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Channel } from '@/api/types';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useToastStore } from '@/ui';

import { ChannelEditDialogHost, useChannelEditShortcuts } from '..';
import { useRenameStore } from '../store';
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

function Live({ focused }: { focused: Channel | undefined }) {
  useChannelEditShortcuts(focused);
  return (
    <>
      <input aria-label="Search channels" />
      <ChannelEditDialogHost />
    </>
  );
}

const bbc = makeChannel('c1', 'BBC One');

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}
const f2 = (init: KeyboardEventInit = {}, target?: EventTarget) => press({ key: 'F2', code: 'F2', ...init }, target);
const shiftDelete = (init: KeyboardEventInit = {}, target?: EventTarget) =>
  press({ key: 'Delete', code: 'Delete', shiftKey: true, ...init }, target);

beforeAll(installDomStubs);
beforeEach(() => {
  shortcutRegistry.reset();
  core.reset();
  core.add(bbc);
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
  useRenameStore.setState({ request: null });
});
afterEach(cleanup);

describe('useChannelEditShortcuts', () => {
  it('registers both keys under Live TV for the shortcut overlay', () => {
    renderUi(<Live focused={bbc} />, queryClient);
    const list = shortcutRegistry.list();
    expect(list).toContainEqual({ combo: 'f2', description: 'Rename the focused channel', area: 'Live TV' });
    expect(list).toContainEqual({ combo: 'shift+delete', description: 'Hide the focused channel', area: 'Live TV' });
  });

  it('binds nothing without a focused channel, or for a movie', () => {
    const { rerender } = renderUi(<Live focused={undefined} />, queryClient);
    expect(shortcutRegistry.list().filter((s) => s.combo === 'f2')).toHaveLength(0);
    const e = f2();
    expect(e.defaultPrevented).toBe(false);
    rerender(
      <Providers client={queryClient}>
        <Live focused={{ ...bbc, ref: { ...bbc.ref, contentType: 'movie' } }} />
      </Providers>,
    );
    expect(shortcutRegistry.list().filter((s) => s.combo === 'shift+delete')).toHaveLength(0);
  });

  it('opens the rename dialog with F2', async () => {
    renderUi(<Live focused={bbc} />, queryClient);
    const e = f2();
    expect(e.defaultPrevented).toBe(true);
    expect(useRenameStore.getState().request?.channel).toEqual(bbc);
    expect(await screen.findByTestId('channel-rename-dialog')).toBeTruthy();
  });

  it('hides with Shift+Delete, once for a held key', async () => {
    renderUi(<Live focused={bbc} />, queryClient);
    shiftDelete();
    shiftDelete({ repeat: true });
    shiftDelete({ repeat: true });
    await waitFor(() => expect(core.isHidden(bbc.ref)).toBe(true));
    expect(core.callsOf('channels.setHidden')).toEqual([{ refs: [bbc.ref], hidden: true }]);
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('BBC One hidden'));
  });

  it('leaves the keys to a text field that has focus', () => {
    renderUi(<Live focused={bbc} />, queryClient);
    const search = screen.getByLabelText('Search channels');
    search.focus();
    shiftDelete({}, search);
    f2({}, search);
    expect(core.callsOf('channels.setHidden')).toHaveLength(0);
    expect(useRenameStore.getState().request).toBeNull();
  });

  it('acts on the channel focused now', async () => {
    const cnn = makeChannel('c3', 'CNN International');
    core.add(cnn);
    const { rerender } = renderUi(<Live focused={bbc} />, queryClient);
    rerender(
      <Providers client={queryClient}>
        <Live focused={cnn} />
      </Providers>,
    );
    shiftDelete();
    await waitFor(() => expect(core.isHidden(cnn.ref)).toBe(true));
    expect(core.isHidden(bbc.ref)).toBe(false);
  });
});
