/**
 * The player's parental hook point (C2/C5) runs the real gate: controls off plays at once,
 * Ask mode asks for the PIN (named after the title) before anything about a locked item shows,
 * a cancelled prompt or a failed check leaves what was playing untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, ParentalStatus } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const store = await import('./store');
const { queryClient } = await import('@/api/query');
const { registerGateHost, settleGate, useGateStore } = await import('@/features/parental/gate');
const { usePlayerStore, playItem } = store;

const locked: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '666' };
const open: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '101' };

const status = (patch: Partial<ParentalStatus> = {}): ParentalStatus => ({
  enabled: true,
  mode: 'ask',
  autoAdult: true,
  unlockMinutes: 15,
  unlocked: false,
  failedAttempts: 0,
  ...patch,
});

const calls = (name: string): unknown[] => rpcMock.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let unregister: (() => void) | null = null;

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  queryClient.clear();
  sessionStorage.clear();
  store.__resetPlayerForTests();
  handlers['settings.get'] = () => ({ player: 'html5' });
  handlers['recent.add'] = () => undefined;
  handlers['positions.set'] = () => undefined;
  handlers['positions.get'] = () => null;
  handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
  handlers['xtream.streamUrl'] = (a) => {
    const id = (a as { ref: ItemRef }).ref.itemId;
    return { url: `http://x/live/${id}.m3u8`, kind: 'hls', title: id, isLive: true, isRadio: false };
  };
  handlers['parental.status'] = () => status();
  handlers['parental.check'] = (a) => (a as { items: { ref: ItemRef }[] }).items.map((i) => i.ref).filter((r) => r.itemId === locked.itemId);
  unregister = registerGateHost();
});

afterEach(() => {
  unregister?.();
  unregister = null;
  useGateStore.setState({ queue: [] });
  store.__resetPlayerForTests();
});

const args = (ref: ItemRef, title: string) => ({ ref, title, isLive: true, sourceKind: 'xtream' as const, categoryId: 'news' });

describe('parental hook in the play path', () => {
  it('plays at once with controls off, without checking locks', async () => {
    handlers['parental.status'] = () => status({ enabled: false });
    await playItem(args(locked, 'Late Night'));
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
    expect(calls('parental.check')).toEqual([]);
  });

  it('plays an item that is not locked without asking', async () => {
    await playItem(args(open, 'News 24'));
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/101.m3u8');
    expect(calls('parental.check')).toEqual([{ items: [{ ref: open, categoryId: 'news' }] }]);
    expect(useGateStore.getState().queue).toEqual([]);
  });

  it('asks for the PIN, named after the title, before a locked item shows; cancelling keeps what was playing', async () => {
    await playItem(args(open, 'News 24'));
    const pending = playItem(args(locked, 'Late Night'));
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    const req = useGateStore.getState().queue[0]!;
    expect(req.kind).toBe('unlock');
    expect(req.kind === 'unlock' && req.items.map((i) => i.title)).toEqual(['Late Night']);
    // Nothing about the locked item shows behind the prompt.
    expect(usePlayerStore.getState().source?.ref).toEqual(open);
    expect(calls('xtream.streamUrl')).toHaveLength(1);

    settleGate(req.id, false);
    await pending;
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/101.m3u8');
    expect(calls('xtream.streamUrl')).toHaveLength(1);
  });

  it('plays the locked item once the PIN is accepted', async () => {
    const pending = playItem(args(locked, 'Late Night'));
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    settleGate(useGateStore.getState().queue[0]!.id, true);
    await pending;
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
  });

  it('fails closed when the lock check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    handlers['parental.check'] = () => {
      throw new Error('database is locked');
    };
    await playItem(args(locked, 'Late Night'));
    await flush();
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(calls('xtream.streamUrl')).toEqual([]);
  });

  it('lets everything through in Hide mode (the core never lists locked items there)', async () => {
    handlers['parental.status'] = () => status({ mode: 'hide' });
    await playItem(args(locked, 'Late Night'));
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
    expect(calls('parental.check')).toEqual([]);
  });
});
