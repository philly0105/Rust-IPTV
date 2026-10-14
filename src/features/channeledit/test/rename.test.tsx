// Rename dialog (C2): validation before anything is sent, unchanged names
// send nothing, empty or the provider's name resets, the core's refusal
// stays next to the field, and the toast can undo.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Channel } from '@/api/types';
import { useToastStore } from '@/ui';

import { ChannelEditDialogHost, openRenameDialog } from '..';
import { useRenameStore } from '../store';
import { core, fail, installDomStubs, makeChannel, renderUi } from './harness';

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
const lastToast = () => useToastStore.getState().toasts.at(-1);
const input = () => screen.getByTestId<HTMLInputElement>('channel-rename-input');
const save = () => screen.getByTestId<HTMLButtonElement>('channel-rename-save');

/** Mounts the host, opens the dialog for `channel` and waits until Save is ready. */
async function open(channel: Channel = bbc) {
  const view = renderUi(<ChannelEditDialogHost />, queryClient);
  act(() => {
    expect(openRenameDialog(channel)).toBe(true);
  });
  await screen.findByTestId('channel-rename-dialog');
  await waitFor(() => expect(save().disabled).toBe(false));
  return view;
}

function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

const closed = () => waitFor(() => expect(screen.queryByTestId('channel-rename-dialog')).toBeNull());

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset();
  core.add(bbc);
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
  useRenameStore.setState({ request: null });
});
afterEach(cleanup);

describe('rename dialog', () => {
  it('does nothing without a host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(openRenameDialog(bbc)).toBe(false);
    expect(useRenameStore.getState().request).toBeNull();
    warn.mockRestore();
  });

  it('starts with the shown name selected and the provider name in view', async () => {
    await open();
    expect(input().value).toBe('BBC One');
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('BBC One'.length);
    expect(screen.getByTestId('channel-rename-provider').textContent).toContain("Provider's name: BBC One");
    expect(screen.getByTestId('channel-rename-count').textContent).toBe('7/120');
    // Nothing to go back to while the field holds the provider's name.
    expect(screen.queryByRole('button', { name: 'Use this' })).toBeNull();
  });

  it('renames to the trimmed name, then Undo goes back to the provider name', async () => {
    await open();
    type('  My News  ');
    fireEvent.click(save());
    await closed();
    expect(core.callsOf('channels.rename')).toEqual([{ ref: bbc.ref, name: 'My News' }]);
    expect(core.nameOf(bbc.ref)).toBe('My News');
    expect(lastToast()?.title).toBe('Renamed to My News');

    act(() => lastToast()!.action!.onClick());
    await waitFor(() => expect(core.nameOf(bbc.ref)).toBeUndefined());
    expect(core.callsOf('channels.rename').at(-1)).toEqual({ ref: bbc.ref, name: null });
  });

  it('submits with Enter', async () => {
    await open();
    type('My News');
    fireEvent.submit(input().form!);
    await closed();
    expect(core.nameOf(bbc.ref)).toBe('My News');
  });

  it('closes without a call when the name did not change', async () => {
    await open();
    type(' BBC One ');
    fireEvent.click(save());
    await closed();
    expect(core.callsOf('channels.rename')).toHaveLength(0);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('refuses an empty name for a channel that was never renamed', async () => {
    await open();
    type('   ');
    // "Empty" waits for Save, so retyping does not flash an error.
    expect(input().getAttribute('aria-invalid')).not.toBe('true');
    fireEvent.click(save());
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(core.callsOf('channels.rename')).toHaveLength(0);
    expect(screen.getByTestId('channel-rename-dialog')).toBeTruthy();
  });

  it('refuses a name of only invisible characters, and one with a line break, without a call', async () => {
    await open();
    type('\u{200B}\u{200F}\u{3164}');
    fireEvent.click(save());
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    type('BBC\u{2028}One');
    fireEvent.click(save());
    expect(await screen.findByText('Remove line breaks and control characters.')).toBeTruthy();
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(core.callsOf('channels.rename')).toHaveLength(0);
  });

  it('flags a name over 120 characters at once and never sends it', async () => {
    await open();
    type('x'.repeat(121));
    expect(screen.getByText('Use at most 120 characters.')).toBeTruthy();
    expect(screen.getByTestId('channel-rename-count').textContent).toBe('121/120');
    fireEvent.click(save());
    expect(core.callsOf('channels.rename')).toHaveLength(0);
    type('x'.repeat(120));
    expect(screen.queryByText('Use at most 120 characters.')).toBeNull();
  });

  describe('a renamed channel', () => {
    const renamed = { ...bbc, name: 'My News' };
    beforeEach(() => core.seed(bbc.ref, { name: 'My News', originalName: 'BBC One' }));

    it("shows the provider's name and fills it in with one click", async () => {
      await open(renamed);
      expect(input().value).toBe('My News');
      expect(screen.getByTestId('channel-rename-provider').textContent).toContain('BBC One');
      fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
      expect(input().value).toBe('BBC One');
      expect(document.activeElement).toBe(input());
      fireEvent.click(save());
      await closed();
      expect(core.callsOf('channels.rename')).toEqual([{ ref: bbc.ref, name: null }]);
      expect(lastToast()?.title).toBe('Name reset to BBC One');

      act(() => lastToast()!.action!.onClick());
      await waitFor(() => expect(core.nameOf(bbc.ref)).toBe('My News'));
    });

    it('resets when the field is cleared', async () => {
      await open(renamed);
      type('');
      fireEvent.click(save());
      await closed();
      expect(core.callsOf('channels.rename')).toEqual([{ ref: bbc.ref, name: null }]);
      expect(core.nameOf(bbc.ref)).toBeUndefined();
    });
  });

  it("keeps the core's refusal next to the field", async () => {
    core.override('channels.rename', () => fail('invalid', 'That name is taken by the provider.'));
    await open();
    type('My News');
    fireEvent.click(save());
    expect(await screen.findByText('That name is taken by the provider.')).toBeTruthy();
    expect(screen.getByTestId('channel-rename-dialog')).toBeTruthy();
    expect(save().getAttribute('aria-busy')).toBeNull();
    // Editing clears the message.
    type('My News 2');
    expect(screen.queryByText('That name is taken by the provider.')).toBeNull();
  });

  it('says when the channel is gone from the provider', async () => {
    await open();
    core.drop(bbc.ref);
    type('My News');
    fireEvent.click(save());
    expect(await screen.findByText('Could not rename. The provider no longer lists this channel.')).toBeTruthy();
  });

  it('closes with Cancel and Escape without a call', async () => {
    await open();
    type('Something');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await closed();
    act(() => {
      openRenameDialog(bbc);
    });
    await screen.findByTestId('channel-rename-dialog');
    // A fresh request starts from the shown name again.
    expect(input().value).toBe('BBC One');
    fireEvent.keyDown(input(), { key: 'Escape' });
    await closed();
    expect(core.callsOf('channels.rename')).toHaveLength(0);
  });

  it('says Rename station for radio', async () => {
    const jazz = makeChannel('r1', 'Jazz FM', 'radio');
    core.add(jazz);
    await open(jazz);
    expect(screen.getByTestId('channel-rename-dialog').textContent).toContain('Rename station');
  });
});
