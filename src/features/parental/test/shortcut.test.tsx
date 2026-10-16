// Lock-now shortcut: Mod+Alt+L ends a session unlock, and is bound only while
// parental controls are on and unlocked.
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useToastStore } from '@/ui';

import { useParentalEvents, useParentalStatus } from '..';
import { core } from './harness';

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

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

function pressLockNow(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
}

/** Mounts the shell's parental effects and waits for the first status. */
async function mount() {
  const view = renderHook(
    () => {
      useParentalEvents();
      return useParentalStatus();
    },
    { wrapper },
  );
  await vi.waitFor(() => expect(view.result.current.data).toBeDefined());
  return view;
}

beforeEach(() => {
  shortcutRegistry.reset();
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('lock-now shortcut', () => {
  it('locks at once with Mod+Alt+L while unlocked, and says so', async () => {
    core.reset({ pin: '2580', unlockedUntil: Date.now() + 60_000 });
    const { result } = await mount();
    expect(result.current.data?.unlocked).toBe(true);
    expect(shortcutRegistry.list().some((s) => s.combo === 'mod+alt+l' && s.description === 'Lock parental controls now')).toBe(true);

    let e: KeyboardEvent | undefined;
    act(() => {
      e = pressLockNow();
    });
    expect(e?.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(result.current.data?.unlocked).toBe(false));
    expect(core.callsOf('parental.lockNow')).toHaveLength(1);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ variant: 'success', title: 'Parental controls locked' });
    // Locked again: the shortcut is gone.
    expect(shortcutRegistry.list().some((s) => s.combo === 'mod+alt+l')).toBe(false);
  });

  it('does nothing while locked', async () => {
    core.reset({ pin: '2580' });
    const { result } = await mount();
    expect(result.current.data).toMatchObject({ enabled: true, unlocked: false });
    const e = pressLockNow();
    expect(e.defaultPrevented).toBe(false);
    expect(core.callsOf('parental.lockNow')).toHaveLength(0);
    expect(shortcutRegistry.list().some((s) => s.combo === 'mod+alt+l')).toBe(false);
  });

  it('does nothing while parental controls are off', async () => {
    core.reset();
    const { result } = await mount();
    expect(result.current.data?.enabled).toBe(false);
    const e = pressLockNow();
    expect(e.defaultPrevented).toBe(false);
    expect(core.callsOf('parental.lockNow')).toHaveLength(0);
  });
});
