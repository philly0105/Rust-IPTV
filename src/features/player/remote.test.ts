import { afterEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => {
  const listeners = new Set<(p: unknown) => void>();
  return {
    listeners,
    emit: (p: unknown) => listeners.forEach((fn) => fn(p)),
  };
});
const store = vi.hoisted(() => ({
  zap: vi.fn(async () => undefined),
  zapToNumber: vi.fn(async () => undefined),
  adjustVolume: vi.fn(),
  togglePlay: vi.fn(),
  stop: vi.fn(),
  stopExternal: vi.fn(async () => undefined),
  mode: 'inline' as 'inline' | 'external',
}));
/** The player store and settings the remote follows, driven by the tests. */
const player = vi.hoisted(() => ({
  settings: null as null | { remoteControl: { enabled: boolean } },
  storeListeners: new Set<(s: unknown, prev: unknown) => void>(),
  settingsListeners: new Set<() => void>(),
}));

vi.mock('@/api/events', () => ({
  onAppEvent: (_type: string, fn: (p: unknown) => void) => {
    bus.listeners.add(fn);
    return () => bus.listeners.delete(fn);
  },
}));
vi.mock('@/api/transport', () => ({ rpc: vi.fn(async () => null) }));
vi.mock('./external', () => ({ stopExternalPlayback: store.stopExternal }));
const { rpc } = await import('@/api/transport');
vi.mock('./store', () => ({
  zap: store.zap,
  zapToNumber: store.zapToNumber,
  playChannel: vi.fn(async () => undefined),
  peekSettings: () => player.settings,
  subscribeSettings: (fn: () => void) => {
    player.settingsListeners.add(fn);
    return () => player.settingsListeners.delete(fn);
  },
  usePlayerStore: {
    getState: () => ({ adjustVolume: store.adjustVolume, togglePlay: store.togglePlay, stop: store.stop, mode: store.mode, volume: 1, muted: false }),
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      player.storeListeners.add(fn);
      return () => player.storeListeners.delete(fn);
    },
  },
}));

const { bindRemote, claimRemoteChannelCommands } = await import('./remote');

afterEach(() => {
  bus.listeners.clear();
  vi.clearAllMocks();
  store.mode = 'inline';
});

describe('bindRemote', () => {
  it('plays, pauses and stops for the remote; an external player closes through its own stop', () => {
    const unbind = bindRemote();
    bus.emit({ command: 'togglePlay' });
    bus.emit({ command: 'stop' });
    expect(store.togglePlay).toHaveBeenCalledTimes(1);
    expect(store.stop).toHaveBeenCalledTimes(1);
    store.mode = 'external';
    bus.emit({ command: 'stop' });
    expect(store.stopExternal).toHaveBeenCalledTimes(1);
    expect(store.stop).toHaveBeenCalledTimes(1);
    unbind();
  });

  it('handles channel commands when no live view is mounted', () => {
    const unbind = bindRemote();
    bus.emit({ command: 'channelUp' });
    bus.emit({ command: 'selectNumber', number: 5 });
    expect(store.zap).toHaveBeenCalledWith('up');
    expect(store.zapToNumber).toHaveBeenCalledWith(5);
    unbind();
  });

  it('leaves channel commands to a mounted live view, keeps volume', () => {
    const unbind = bindRemote();
    const release = claimRemoteChannelCommands();
    bus.emit({ command: 'channelUp' });
    bus.emit({ command: 'channelDown' });
    bus.emit({ command: 'selectNumber', number: 5 });
    bus.emit({ command: 'selectId', id: 'src1|c1' });
    bus.emit({ command: 'volumeUp' });
    expect(store.zap).not.toHaveBeenCalled();
    expect(store.zapToNumber).not.toHaveBeenCalled();
    expect(store.adjustVolume).toHaveBeenCalledWith(0.05);

    release();
    release(); // idempotent
    bus.emit({ command: 'channelDown' });
    expect(store.zap).toHaveBeenCalledTimes(1);
    unbind();
  });
});

describe('remote status reports (L2-player-10)', () => {
  const change = (n: number): void =>
    player.storeListeners.forEach((fn) => fn({ source: { title: `Ch ${n}` }, volume: 1, muted: false, mode: 'inline' }, {}));
  const reports = (): number => vi.mocked(rpc).mock.calls.filter((c) => c[0] === 'remote.reportStatus').length;

  afterEach(() => {
    player.settings = null;
    vi.useRealTimers();
  });

  it('sends nothing per channel change while the remote server is off, and catches up when it turns on', async () => {
    vi.useFakeTimers();
    player.settings = { remoteControl: { enabled: false } };
    const unbind = bindRemote();
    change(1);
    change(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reports()).toBe(0);

    player.settings = { remoteControl: { enabled: true } };
    player.settingsListeners.forEach((fn) => fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(reports()).toBe(1);
    unbind();
  });
});
