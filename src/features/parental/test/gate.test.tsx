// The parental gate (contract C2, SC3): Ask mode asks for the PIN before
// locked content plays; Hide mode, controls off and an active unlock let it
// through unasked; concurrent requests share one dialog; failures refuse.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { ItemRef } from '@/api/types';
import { useToastStore } from '@/ui';

import { ensureUnlocked, ParentalGateHost, removalMayNeedPin, unlockToRemoveSources, useParentalEvents } from '..';
import { useGateStore } from '../gate';
import { channelRef, core, emitEvent, installDomStubs, renderUi } from './harness';

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

const PIN = '2580';

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset();
  queryClient.clear();
  useGateStore.setState({ queue: [] });
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

function Shell() {
  useParentalEvents();
  return <ParentalGateHost />;
}

const lockChannel = (itemId: string, name = itemId) => core.lock({ sourceId: 'src1', contentType: 'live', kind: 'item', targetId: itemId, name });

function enterPin(dialog: HTMLElement, pin: string) {
  const input = within(dialog).getByLabelText('PIN');
  fireEvent.change(input, { target: { value: pin } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }));
}

/** A player's play path with the gate in front of it. */
function player() {
  const played: ItemRef[] = [];
  const play = async (ref: ItemRef, title?: string, categoryId?: string) => {
    if (await ensureUnlocked([{ ref, ...(title ? { title } : {}), ...(categoryId ? { categoryId } : {}) }])) played.push(ref);
  };
  return { played, play };
}

describe('ensureUnlocked', () => {
  it('ask mode asks for the PIN before playback', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1', 'Late Night');
    renderUi(<Shell />, queryClient);
    const { played, play } = player();

    const playing = play(channelRef('c1'), 'Late Night');
    const dialog = await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    expect(within(dialog).getByText('"Late Night" is locked by parental controls.')).toBeTruthy();
    expect(within(dialog).getByText('Locked content stays open for 15 minutes, or until you lock it again.')).toBeTruthy();
    expect(played).toEqual([]);

    // A wrong PIN keeps it locked and says how many tries are left.
    enterPin(dialog, '1111');
    expect(await within(dialog).findByText('Wrong PIN. 4 tries left before a short wait.')).toBeTruthy();
    expect(played).toEqual([]);
    expect((within(dialog).getByLabelText('PIN') as HTMLInputElement).value).toBe('');

    enterPin(dialog, PIN);
    await act(() => playing);
    expect(played).toEqual([channelRef('c1')]);
    expect(core.callsOf('parental.unlock')).toEqual([{ pin: '1111' }, { pin: PIN }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The session is unlocked now: the next play goes through without a dialog.
    await act(() => play(channelRef('c1')));
    expect(played).toHaveLength(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the PIN dialog keeps playback from starting', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    const { played, play } = player();

    const playing = play(channelRef('c1'));
    const dialog = await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(() => playing);
    expect(played).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(core.callsOf('parental.unlock')).toEqual([]);
  });

  it('lets unlocked items in Ask mode through without asking', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    await expect(ensureUnlocked([{ ref: channelRef('c2') }])).resolves.toBe(true);
    expect(core.callsOf('parental.check')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('passes the category to the check, so locked groups ask too', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    core.lock({ sourceId: 'src1', contentType: 'live', kind: 'category', targetId: 'g9', name: 'Late' });
    renderUi(<Shell />, queryClient);
    const { played, play } = player();
    const playing = play(channelRef('c7'), undefined, 'g9');
    const dialog = await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    expect(core.callsOf('parental.check')[0]).toEqual({ items: [{ ref: channelRef('c7'), categoryId: 'g9' }] });
    expect(within(dialog).getByText('This is locked by parental controls.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(() => playing);
    expect(played).toEqual([]);
  });

  it('asks for adult groups the automatic rule locks', async () => {
    core.reset({ pin: PIN, mode: 'ask', adult: { 'src1|live': ['xxx'] } });
    renderUi(<Shell />, queryClient);
    const pending = ensureUnlocked([{ ref: channelRef('c8'), categoryId: 'xxx' }]);
    expect(await screen.findByRole('dialog', { name: 'Enter the parental PIN' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(pending).resolves.toBe(false);
  });

  it('never asks in Hide mode: the core already keeps locked items out', async () => {
    core.reset({ pin: PIN, mode: 'hide' });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    await expect(ensureUnlocked([{ ref: channelRef('c1') }])).resolves.toBe(true);
    expect(core.callsOf('parental.check')).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never asks while parental controls are off', async () => {
    core.reset({ mode: 'ask' });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    await expect(ensureUnlocked([{ ref: channelRef('c1') }])).resolves.toBe(true);
    expect(core.callsOf('parental.check')).toEqual([]);
  });

  it('never asks while the session is unlocked', async () => {
    core.reset({ pin: PIN, mode: 'ask', unlockedUntil: Date.now() + 60_000 });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    await expect(ensureUnlocked([{ ref: channelRef('c1') }])).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves true at once for nothing to check', async () => {
    await expect(ensureUnlocked([])).resolves.toBe(true);
    expect(core.calls).toEqual([]);
  });

  it('concurrent calls share one dialog and one PIN entry', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    lockChannel('c2');
    renderUi(<Shell />, queryClient);

    const a = ensureUnlocked([{ ref: channelRef('c1') }]);
    const b = ensureUnlocked([{ ref: channelRef('c2') }]);
    const dialog = await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    await within(dialog).findByText('2 locked items are waiting to open.');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    enterPin(dialog, PIN);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(core.callsOf('parental.unlock')).toHaveLength(1);
    expect(useGateStore.getState().queue).toEqual([]);
  });

  it('cancelling the shared dialog refuses every waiting call', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    const a = ensureUnlocked([{ ref: channelRef('c1') }]);
    const b = ensureUnlocked([{ ref: channelRef('c1') }]);
    await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    await waitFor(() => expect(useGateStore.getState().queue[0]?.waiters).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(Promise.all([a, b])).resolves.toEqual([false, false]);
  });

  it('lets a waiting request through when the session is unlocked elsewhere', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);
    const pending = ensureUnlocked([{ ref: channelRef('c1') }]);
    await screen.findByRole('dialog', { name: 'Enter the parental PIN' });

    // The remote or another window entered the PIN: the core announces the unlock.
    core.state.unlockedUntil = Date.now() + 15 * 60_000;
    act(() => emitEvent('parental.changed', core.status()));
    await expect(pending).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('fails closed when the check fails, and says why', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    core.override('parental.check', () => {
      throw { code: 'db', message: 'database is locked' };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderUi(<Shell />, queryClient);
    await expect(ensureUnlocked([{ ref: channelRef('c1') }])).resolves.toBe(false);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.variant).toBe('error');
    expect(toast?.title).toBe("Couldn't check parental locks");
  });

  it('lets everything through on a core without parental controls', async () => {
    core.override('parental.status', () => {
      throw { code: 'unsupported', message: 'not built in' };
    });
    renderUi(<Shell />, queryClient);
    await expect(ensureUnlocked([{ ref: channelRef('c1') }])).resolves.toBe(true);
  });

  it('refuses rather than waiting forever when no host is mounted', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(ensureUnlocked([{ ref: channelRef('c1') }])).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses open requests when the host unmounts', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    lockChannel('c1');
    const view = renderUi(<Shell />, queryClient);
    const pending = ensureUnlocked([{ ref: channelRef('c1') }]);
    await screen.findByRole('dialog', { name: 'Enter the parental PIN' });
    view.unmount();
    await expect(pending).resolves.toBe(false);
  });

  it('checks long lists in batches of 500, once per item', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    renderUi(<Shell />, queryClient);
    const items = Array.from({ length: 1200 }, (_, i) => ({ ref: channelRef(`c${i}`) }));
    await expect(ensureUnlocked([...items, ...items.slice(0, 50)])).resolves.toBe(true);
    const sizes = core.callsOf('parental.check').map((a) => (a as { items: unknown[] }).items.length);
    expect(sizes).toEqual([500, 500, 200]);
  });
});

describe('unlockToRemoveSources', () => {
  const prompt = { title: 'Enter the PIN to remove News', description: 'Its parental locks go with it.', confirmLabel: 'Unlock' };

  it('goes ahead unasked while controls are off, or when the source has no locks', async () => {
    renderUi(<Shell />, queryClient);
    await expect(unlockToRemoveSources('src1', prompt)).resolves.toBe(true);
    expect(removalMayNeedPin()).toBe(false);

    core.reset({ pin: PIN });
    queryClient.clear();
    core.lock({ sourceId: 'src2', contentType: 'live', kind: 'item', targetId: 'c9', name: 'Elsewhere' });
    await expect(unlockToRemoveSources('src1', prompt)).resolves.toBe(true);
    expect(removalMayNeedPin()).toBe(true);
    expect(core.callsOf('parental.locks')).toEqual([{ sourceId: 'src1' }]);
    expect(useGateStore.getState().queue).toEqual([]);
  });

  it('asks for the PIN when a source has locks, and unlocks the session with it', async () => {
    core.reset({ pin: PIN });
    lockChannel('c1', 'Late Night');
    renderUi(<Shell />, queryClient);

    const removing = unlockToRemoveSources(undefined, prompt);
    const dialog = await screen.findByRole('dialog', { name: prompt.title });
    expect(within(dialog).getByText(prompt.description)).toBeTruthy();
    enterPin(dialog, PIN);
    await act(async () => {
      await expect(removing).resolves.toBe(true);
    });
    expect(core.callsOf('parental.locks')).toEqual([{}]);
    expect(core.status().unlocked).toBe(true);
    expect(removalMayNeedPin()).toBe(false);
  });

  it('a cancelled prompt stops the removal and unlocks nothing', async () => {
    core.reset({ pin: PIN });
    lockChannel('c1');
    renderUi(<Shell />, queryClient);

    const removing = unlockToRemoveSources('src1', prompt);
    const dialog = await screen.findByRole('dialog', { name: prompt.title });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {
      await expect(removing).resolves.toBe(false);
    });
    expect(core.callsOf('parental.unlock')).toEqual([]);
    expect(core.status().unlocked).toBe(false);
  });
});
