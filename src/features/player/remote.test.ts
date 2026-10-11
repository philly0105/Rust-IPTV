import { afterEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => {
  const listeners = new Set<(p: unknown) => void>();
  return {
    listeners,
    emit: (p: unknown) => listeners.forEach((fn) => fn(p)),
  };
});
const store = vi.hoisted(() => ({ zap: vi.fn(async () => undefined), zapToNumber: vi.fn(async () => undefined), adjustVolume: vi.fn() }));

vi.mock('@/api/events', () => ({
  onAppEvent: (_type: string, fn: (p: unknown) => void) => {
    bus.listeners.add(fn);
    return () => bus.listeners.delete(fn);
  },
}));
vi.mock('@/api/transport', () => ({ rpc: vi.fn(async () => null) }));
vi.mock('./store', () => ({
  zap: store.zap,
  zapToNumber: store.zapToNumber,
  playChannel: vi.fn(async () => undefined),
  usePlayerStore: {
    getState: () => ({ adjustVolume: store.adjustVolume, volume: 1, muted: false }),
    subscribe: () => () => undefined,
  },
}));

const { bindRemote, claimRemoteChannelCommands } = await import('./remote');

afterEach(() => {
  bus.listeners.clear();
  vi.clearAllMocks();
});

describe('bindRemote', () => {
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
