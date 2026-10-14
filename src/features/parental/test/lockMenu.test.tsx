// Context-menu entries (C2): lock without a PIN, remove a lock with the PIN
// unless the session is unlocked, adult groups show the automatic rule.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { ParentalLockTarget } from '@/api/types';
import { useToastStore } from '@/ui';

import { ParentalGateHost, useLockMenuItems, useParentalEvents } from '..';
import { useGateStore } from '../gate';
import { core, installDomStubs, renderUi } from './harness';

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
const channel: ParentalLockTarget = { sourceId: 'src1', contentType: 'live', kind: 'item', targetId: 'c1', name: 'Late Night' };
const group: ParentalLockTarget = { sourceId: 'src1', contentType: 'live', kind: 'category', targetId: 'xxx', name: 'XXX' };

/** Renders the entries as buttons, the way a context menu would. */
function Menu({ target }: { target: ParentalLockTarget | null }) {
  useParentalEvents();
  const items = useLockMenuItems(target);
  return (
    <>
      <ul data-testid="menu" data-count={items.length}>
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" data-id={i.id} disabled={i.disabled} onClick={i.onSelect}>
              {i.label}
            </button>
          </li>
        ))}
      </ul>
      <ParentalGateHost />
    </>
  );
}

const lastToast = () => useToastStore.getState().toasts.at(-1);

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset();
  queryClient.clear();
  useGateStore.setState({ queue: [] });
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('useLockMenuItems', () => {
  it('adds nothing while parental controls are off', async () => {
    renderUi(<Menu target={channel} />, queryClient);
    await waitFor(() => expect(core.callsOf('parental.status')).toHaveLength(1));
    expect(screen.getByTestId('menu').dataset.count).toBe('0');
    expect(core.callsOf('parental.locks')).toEqual([]);
  });

  it('adds nothing without a target', async () => {
    core.reset({ pin: PIN });
    renderUi(<Menu target={null} />, queryClient);
    await waitFor(() => expect(core.callsOf('parental.status')).toHaveLength(1));
    expect(screen.getByTestId('menu').dataset.count).toBe('0');
  });

  it('locks a channel without asking for the PIN', async () => {
    core.reset({ pin: PIN });
    renderUi(<Menu target={channel} />, queryClient);
    const lock = await screen.findByRole('button', { name: 'Lock channel' });
    await waitFor(() => expect((lock as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(lock);

    await waitFor(() => expect(core.state.locks).toHaveLength(1));
    expect(core.callsOf('parental.setLocked')).toEqual([{ target: channel, locked: true }]);
    await waitFor(() => expect(lastToast()?.title).toBe('Locked Late Night'));
    expect(lastToast()?.description).toBe('It is hidden until someone enters the PIN.');
    // The entry turns into "Remove" once the lock list refetches.
    expect(await screen.findByRole('button', { name: 'Remove parental lock' })).toBeTruthy();
  });

  it('names the content type it locks', async () => {
    core.reset({ pin: PIN, mode: 'ask' });
    const cases: [ParentalLockTarget, string][] = [
      [{ ...channel, contentType: 'movie' }, 'Lock movie'],
      [{ ...channel, contentType: 'series' }, 'Lock series'],
      [{ ...channel, contentType: 'radio' }, 'Lock station'],
      [{ ...group, targetId: 'g1', name: 'Films' }, 'Lock group'],
    ];
    for (const [target, label] of cases) {
      const view = renderUi(<Menu target={target} />, queryClient);
      expect(await screen.findByRole('button', { name: label })).toBeTruthy();
      view.unmount();
    }
  });

  it('asks for the PIN to remove a lock', async () => {
    core.reset({ pin: PIN });
    core.lock(channel);
    renderUi(<Menu target={channel} />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove parental lock' }));

    const dialog = await screen.findByRole('dialog', { name: 'Enter the PIN to remove the lock' });
    expect(within(dialog).getByText('Late Night will open without the PIN.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('PIN'), { target: { value: '1111' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove lock' }));
    expect(await within(dialog).findByTestId('pin-error')).toBeTruthy();
    expect(core.state.locks).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText('PIN'), { target: { value: PIN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove lock' }));
    await waitFor(() => expect(core.state.locks).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(lastToast()?.title).toBe('Lock removed from Late Night');
    expect(await screen.findByRole('button', { name: 'Lock channel' })).toBeTruthy();
  });

  it('cancelling the PIN keeps the lock', async () => {
    core.reset({ pin: PIN });
    core.lock(channel);
    renderUi(<Menu target={channel} />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove parental lock' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(core.state.locks).toHaveLength(1);
    expect(core.callsOf('parental.setLocked')).toEqual([]);
  });

  it('removes a lock at once while the session is unlocked', async () => {
    core.reset({ pin: PIN, unlockedUntil: Date.now() + 60_000 });
    core.lock(channel);
    renderUi(<Menu target={channel} />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove parental lock' }));
    await waitFor(() => expect(core.state.locks).toEqual([]));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(core.callsOf('parental.setLocked')).toEqual([{ target: channel, locked: false }]);
  });

  it('shows adult groups as locked by the automatic rule, without an action', async () => {
    core.reset({ pin: PIN, adult: { 'src1|live': ['xxx'] } });
    renderUi(<Menu target={group} />, queryClient);
    const entry = await screen.findByRole('button', { name: 'Locked as adult content' });
    expect((entry as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a normal lock for adult groups when the automatic rule is off', async () => {
    core.reset({ pin: PIN, autoAdult: false, adult: { 'src1|live': ['xxx'] } });
    renderUi(<Menu target={group} />, queryClient);
    expect(await screen.findByRole('button', { name: 'Lock group' })).toBeTruthy();
    expect(core.callsOf('parental.adultCategories')).toEqual([]);
  });

  it('says so when the lock cannot be saved', async () => {
    core.reset({ pin: PIN });
    core.override('parental.setLocked', () => {
      throw { code: 'db', message: 'database is locked' };
    });
    renderUi(<Menu target={channel} />, queryClient);
    const lock = await screen.findByRole('button', { name: 'Lock channel' });
    await waitFor(() => expect((lock as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(lock);
    await waitFor(() => expect(lastToast()?.title).toBe('Could not change the lock'));
    expect(lastToast()?.variant).toBe('error');
    expect(lastToast()?.description).toBe('database is locked');
  });
});
