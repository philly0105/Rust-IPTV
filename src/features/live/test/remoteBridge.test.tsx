import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '@/api/types';

import { useRemoteBridge } from '../hooks/useRemoteBridge';
import { makeChannel } from './harness';

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  return {
    listeners,
    on(type: string, fn: (p: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
      return () => listeners.get(type)!.delete(fn);
    },
    emit(type: string, payload: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(payload);
    },
  };
});
const rpcMock = vi.hoisted(() => ({ running: false, calls: [] as { cmd: string; args: unknown }[] }));

vi.mock('@/api/events', () => ({ onAppEvent: bus.on, onAnyAppEvent: () => () => undefined }));
vi.mock('@/api/transport', () => ({
  rpc: async (cmd: string, args?: unknown) => {
    rpcMock.calls.push({ cmd, args });
    if (cmd === 'remote.status') return { running: rpcMock.running, port: 7310 };
    return null;
  },
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));
// The player's settings cache: null until loaded (counts as on).
const settingsMock = vi.hoisted(() => ({ value: null as null | { remoteControl: { enabled: boolean; port: number } } }));
vi.mock('@/features/player/store', () => ({ peekSettings: () => settingsMock.value }));

const fakes = await import('./fakes');

const published = () => rpcMock.calls.filter((c) => c.cmd === 'remote.publishSource');

function mount() {
  const spies = { up: vi.fn(), down: vi.fn(), selectNumber: vi.fn(), selectRef: vi.fn() };
  const hook = renderHook(() => useRemoteBridge({ sourceId: 'src1', ...spies }));
  return { ...spies, hook };
}

beforeEach(() => {
  rpcMock.running = false;
  rpcMock.calls.length = 0;
  bus.listeners.clear();
  settingsMock.value = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRemoteBridge', () => {
  it('publishes the channel list when remote control starts while the page is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'remote.status')).toBe(true));
    expect(published()).toHaveLength(0);

    // The user turns remote control on; the server comes up a moment later.
    act(() => bus.emit('settings.changed', { ...DEFAULT_SETTINGS, remoteControl: { enabled: true, port: 7310 } }));
    rpcMock.running = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    await waitFor(() => expect(published()).toHaveLength(1));
    expect(published()[0]!.args).toEqual({ sourceId: 'src1' });
  });

  it('publishes when a remote command shows the server is already running', async () => {
    mount();
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'remote.status')).toBe(true));
    rpcMock.running = true;
    act(() => bus.emit('remote.command', { command: 'volumeUp' }));
    await waitFor(() => expect(published()).toHaveLength(1));
  });

  it('names the source and leaves the catalog, and parental changes, to the core (LV-7)', async () => {
    rpcMock.running = true;
    mount();
    await waitFor(() => expect(published()).toHaveLength(1));
    // Hide mode dropping a locked channel is the core's refill now: nothing more is sent.
    act(() => bus.emit('parental.changed', { enabled: true, mode: 'hide', unlocked: false }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(published()).toHaveLength(1);
    expect(rpcMock.calls.some((c) => c.cmd === 'catalog.allLiveChannels' || c.cmd === 'remote.publishChannels')).toBe(false);
  });

  it('owns channel commands while mounted', () => {
    const { up, selectNumber, selectRef, hook } = mount();
    expect(fakes.remoteClaims.count).toBe(1);
    act(() => {
      bus.emit('remote.command', { command: 'channelUp' });
      bus.emit('remote.command', { command: 'selectNumber', number: 7 });
      bus.emit('remote.command', { command: 'selectId', id: 'src1|c4' });
    });
    expect(up).toHaveBeenCalledTimes(1);
    expect(selectNumber).toHaveBeenCalledWith(7);
    expect(selectRef).toHaveBeenCalledWith({ sourceId: 'src1', contentType: 'live', itemId: 'c4' });
    hook.unmount();
    expect(fakes.remoteClaims.count).toBe(0);
  });

  it('asks for the remote status on a channel change only while remote control is on (XB2-13)', async () => {
    settingsMock.value = { remoteControl: { enabled: false, port: 7310 } };
    const statusCalls = () => rpcMock.calls.filter((c) => c.cmd === 'remote.status').length;
    const reports = () => rpcMock.calls.filter((c) => c.cmd === 'remote.reportStatus');
    const spies = { up: vi.fn(), down: vi.fn(), selectNumber: vi.fn(), selectRef: vi.fn() };
    const hook = renderHook((p: { current: number }) => useRemoteBridge({ sourceId: 'src1', ...spies, current: makeChannel(p.current) }), {
      initialProps: { current: 1 },
    });
    // The mount's publish check is the only one.
    await waitFor(() => expect(statusCalls()).toBe(1));
    hook.rerender({ current: 2 });
    hook.rerender({ current: 3 });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(statusCalls()).toBe(1);
    expect(reports()).toHaveLength(0);

    // Turned on later: the next channel change finds the server and reports the channel.
    settingsMock.value = { remoteControl: { enabled: true, port: 7310 } };
    rpcMock.running = true;
    hook.rerender({ current: 4 });
    await waitFor(() => expect(reports()).toHaveLength(1));
    expect((reports()[0]!.args as { status: { channelName: string } }).status.channelName).toBe('Channel 4');
  });
});
