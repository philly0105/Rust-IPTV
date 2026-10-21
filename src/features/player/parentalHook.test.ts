/**
 * The player's parental hook point (C2/C5) runs the real gate: controls off plays at once,
 * Ask mode asks for the PIN (named after the title) before anything about a locked item shows,
 * a cancelled prompt or a failed check leaves what was playing untouched. Hide mode refuses the
 * items it hides that the player still holds (history, resume record), a refused zap steps on
 * past the locked channel, and controls locking again re-check what plays (parentalGuard).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, ParentalStatus } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

const eventHandlers = new Map<string, Set<(p: unknown) => void>>();
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, h: (p: unknown) => void) => {
    const set = eventHandlers.get(type) ?? new Set<(p: unknown) => void>();
    set.add(h);
    eventHandlers.set(type, set);
    return () => set.delete(h);
  },
}));
const emit = (type: string, payload: unknown): void => {
  for (const h of eventHandlers.get(type) ?? []) h(payload);
};

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const store = await import('./store');
const { onPlaybackHidden } = await import('./parentalLocks');
const history = await import('./history');
const { bindParentalGuard } = await import('./parentalGuard');
const { useMediaStore } = await import('./media');
const { queryClient } = await import('@/api/query');
const { registerGateHost, settleGate, useGateStore } = await import('@/features/parental/gate');
const { applyStatus } = await import('@/features/parental/status');
const { openChannelSource } = await import('@/features/live/lib/playback');
const { usePlayerStore, playItem, zap } = store;

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
  history.__resetHistoryForTests();
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
  history.__resetHistoryForTests();
});

const args = (ref: ItemRef, title: string) => ({ ref, title, isLive: true, sourceKind: 'xtream' as const, categoryId: 'news' });

/** Plays the locked channel with the PIN accepted (the session unlocked). */
async function playUnlocked(): Promise<void> {
  const pending = playItem(args(locked, 'Late Night'));
  await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
  settleGate(useGateStore.getState().queue[0]!.id, true);
  await pending;
  expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
}

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
    await playUnlocked();
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

  it('plays what Hide mode does not hide, without a prompt', async () => {
    handlers['parental.status'] = () => status({ mode: 'hide' });
    await playItem(args(open, 'News 24'));
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/101.m3u8');
    expect(useGateStore.getState().queue).toEqual([]);
  });

  it('refuses a hidden item in Hide mode without a prompt, and drops it from the B history', async () => {
    // Watched while unlocked, so it is in the history; then the unlock ended.
    await playUnlocked();
    await playItem(args(open, 'News 24'));
    expect(history.useHistoryStore.getState().entries.map((e) => e.ref.itemId)).toEqual(['101', '666']);

    handlers['parental.status'] = () => status({ mode: 'hide' });
    queryClient.clear();
    const hidden = vi.fn();
    const off = onPlaybackHidden(hidden);
    const entry = history.playPreviousChannel();
    expect(entry?.ref).toEqual(locked);
    await vi.waitFor(() => expect(hidden).toHaveBeenCalledTimes(1));
    off();
    expect(useGateStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().source?.ref).toEqual(open);
    expect(calls('xtream.streamUrl')).toHaveLength(2);
    expect(history.useHistoryStore.getState().entries.map((e) => e.ref.itemId)).toEqual(['101']);
  });

  it('does not replay a hidden item from the resume record', async () => {
    handlers['parental.status'] = () => status({ mode: 'hide' });
    sessionStorage.setItem(
      store.RESUME_KEY,
      JSON.stringify({
        source: { url: 'http://x/live/666.m3u8', kind: 'hls', title: 'Late Night', isLive: true, isRadio: false, ref: locked },
        positionSeconds: 0,
        mode: 'inline',
        savedAt: 1,
      }),
    );
    expect(await store.restorePlayback()).toBe(false);
    expect(usePlayerStore.getState().source).toBeUndefined();
    expect(sessionStorage.getItem(store.RESUME_KEY)).toBeNull();
  });
});

describe('zapping past a locked channel (Ask mode)', () => {
  // Channel list 101, 666 (locked), 667 (locked), 103.
  let order: string[] = [];
  const channel = (id: string): Channel =>
    ({ ref: { sourceId: 's1', contentType: 'live', itemId: id }, name: `Ch ${id}`, number: Number(id), categoryId: 'news' }) as Channel;

  beforeEach(() => {
    order = ['101', '666', '667', '103'];
    handlers['catalog.neighbors'] = (a) => {
      const i = order.indexOf((a as { ref: ItemRef }).ref.itemId);
      return { prev: i > 0 ? channel(order[i - 1]!) : null, next: i < order.length - 1 ? channel(order[i + 1]!) : null };
    };
    handlers['epg.nowNext'] = () => ({});
    handlers['parental.check'] = (a) =>
      (a as { items: { ref: ItemRef }[] }).items.map((i) => i.ref).filter((r) => r.itemId === '666' || r.itemId === '667');
  });

  it('a cancelled PIN prompt moves the zap on, past further locked channels, without a second prompt', async () => {
    await store.playChannel(channel('101'));
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('101');
    useMediaStore.setState({ osd: undefined });

    const pending = zap('down');
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    // L3-live-10: Ask mode names the locked channel behind the prompt (number and name, marked
    // locked so the readout draws the lock instead of its logo and guide). This line used to
    // expect no readout at all, which was the reported bug.
    expect(useMediaStore.getState().osd).toMatchObject({ primary: '666', secondary: 'Ch 666', locked: true });
    expect(store.isLockedZap(usePlayerStore.getState().source)).toBe(true);
    expect(usePlayerStore.getState().source?.posterUrl).toBeUndefined();
    settleGate(useGateStore.getState().queue[0]!.id, false);
    const played = await pending;

    expect(played?.ref.itemId).toBe('103');
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('103');
    expect(useMediaStore.getState().osd?.primary).toBe('103');
    expect(useGateStore.getState().queue).toEqual([]);
    // 666 and 667 were never resolved.
    expect(calls('xtream.streamUrl').map((a) => (a as { ref: ItemRef }).ref.itemId)).toEqual(['101', '103']);
  });

  it('plays the locked neighbour once the PIN is accepted', async () => {
    await store.playChannel(channel('101'));
    const pending = zap('down');
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    settleGate(useGateStore.getState().queue[0]!.id, true);
    expect((await pending)?.ref.itemId).toBe('666');
    expect(useMediaStore.getState().osd?.primary).toBe('666');
  });

  it('on a one-connection account, plays the locked neighbour once the PIN is accepted after the quiet (L4-zap-gap)', async () => {
    // The tune waits for the quiet, and for the guide answer held behind the PIN prompt.
    handlers['account.status'] = () => ({ sourceId: 's1', kind: 'xtream', isTrial: false, maxConnections: 1, checkedAt: new Date().toISOString() });
    await store.playChannel(channel('101'));
    await vi.waitFor(() => expect(calls('account.status')).toHaveLength(1));
    const pending = zap('down');
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    settleGate(useGateStore.getState().queue[0]!.id, true);
    expect((await pending)?.ref.itemId).toBe('666');
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
    expect(calls('xtream.streamUrl').map((a) => (a as { ref: ItemRef }).ref.itemId)).toEqual(['101', '666']);
  });

  it('on a one-connection account, plays a locked channel zapped away from and back onto in one burst', async () => {
    // Down, down, up lands on 666 twice: its first hold must not wait for a pass the second one takes.
    handlers['account.status'] = () => ({ sourceId: 's1', kind: 'xtream', isTrial: false, maxConnections: 1, checkedAt: new Date().toISOString() });
    await store.playChannel(channel('101'));
    await vi.waitFor(() => expect(queryClient.getQueryState(['account.status', { sourceId: 's1' }])?.status).toBe('success'));
    void zap('down');
    void zap('down');
    const pending = zap('up');
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    settleGate(useGateStore.getState().queue[0]!.id, true);
    expect((await pending)?.ref.itemId).toBe('666');
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
  });

  it('on a one-connection account, plays a locked neighbour the gate lets through before its guide hold looked', async () => {
    // The press holds 666's guide answer behind its lock, on a timer as long as the quiet. Here an
    // unlock lands before the quiet, so the tune's gate passes unasked in the quiet's own timer
    // turn, ahead of the hold's timer: that pass must still release the answer the tune waits on.
    handlers['account.status'] = () => ({ sourceId: 's1', kind: 'xtream', isTrial: false, maxConnections: 1, checkedAt: new Date().toISOString() });
    await store.playChannel(channel('101'));
    await vi.waitFor(() => expect(queryClient.getQueryState(['account.status', { sourceId: 's1' }])?.status).toBe('success'));
    const pending = zap('down');
    await vi.waitFor(() => expect(store.isLockedZap(usePlayerStore.getState().source)).toBe(true));
    handlers['parental.check'] = () => [];
    applyStatus(status({ unlocked: true }));
    expect((await pending)?.ref.itemId).toBe('666');
    expect(useGateStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().source?.url).toBe('http://x/live/666.m3u8');
  });

  it('stays put at the end of the list when everything past the refusal is locked', async () => {
    order = ['101', '666', '667'];
    await store.playChannel(channel('101'));
    const pending = zap('down');
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    settleGate(useGateStore.getState().queue[0]!.id, false);
    expect(await pending).toBeUndefined();
    expect(usePlayerStore.getState().source?.ref?.itemId).toBe('101');
  });
});

describe('controls locking again while a locked item plays (parentalGuard)', () => {
  let unbind: (() => void) | null = null;
  beforeEach(() => {
    unbind = bindParentalGuard();
  });
  afterEach(() => {
    unbind?.();
    unbind = null;
  });

  const surface = () => ({ play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn() });

  it('Ask mode: pauses, asks for the PIN, and stops when it is cancelled', async () => {
    await playUnlocked();
    const c = surface();
    store.setController(c);
    usePlayerStore.setState({ status: 'playing' });
    emit('parental.changed', status());
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    expect(c.pause).toHaveBeenCalled();
    settleGate(useGateStore.getState().queue[0]!.id, false);
    await vi.waitFor(() => expect(usePlayerStore.getState().source).toBeUndefined());
  });

  it('Ask mode: the PIN resumes playback', async () => {
    await playUnlocked();
    const c = surface();
    store.setController(c);
    usePlayerStore.setState({ status: 'playing' });
    emit('parental.changed', status());
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    settleGate(useGateStore.getState().queue[0]!.id, true);
    await vi.waitFor(() => expect(c.play).toHaveBeenCalled());
    expect(usePlayerStore.getState().source?.ref).toEqual(locked);
  });

  it('Hide mode: stops a hidden item at once and drops it from the history', async () => {
    await playUnlocked();
    emit('parental.changed', status({ mode: 'hide' }));
    await vi.waitFor(() => expect(usePlayerStore.getState().source).toBeUndefined());
    expect(useGateStore.getState().queue).toEqual([]);
    expect(history.useHistoryStore.getState().entries).toEqual([]);
  });

  it('leaves an item that is not locked playing', async () => {
    await playItem(args(open, 'News 24'));
    emit('parental.changed', status());
    await flush();
    await flush();
    expect(usePlayerStore.getState().source?.ref).toEqual(open);
    expect(useGateStore.getState().queue).toEqual([]);
  });
});

describe('Play in MPV/VLC from the Live list, Ask mode (L3-player-core-x2)', () => {
  it('a channel the menu unlocked opens in the external player without a second PIN prompt', async () => {
    // The core: an unlock running answers parental.check with nothing locked (parental::check).
    let unlocked = false;
    const lockCheck = handlers['parental.check']!;
    handlers['parental.check'] = (a) => (unlocked ? [] : lockCheck(a));
    handlers['parental.status'] = () => status({ unlocked });
    handlers['parental.unlock'] = () => {
      unlocked = true;
      return status({ unlocked: true });
    };
    handlers['player.openExternal'] = () => undefined;
    const channel = { ref: locked, name: 'Late Night', categoryId: 'news', isRadio: false } as Channel;

    // The menu's own unlock (LivePage: openChannelSource), answered as the unlock dialog does.
    const resolving = openChannelSource(channel, { kind: 'xtream' }, 'Late Night');
    await vi.waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    applyStatus((await rpcMock('parental.unlock', { pin: '1234' })) as ParentalStatus);
    settleGate(useGateStore.getState().queue[0]!.id, true);
    const s = await resolving;
    expect(s).not.toBeNull();

    // Then the store opens it, and its gate runs again: the core's check passes it unasked.
    let prompts = 0;
    const unsub = useGateStore.subscribe((g) => {
      if (g.queue.length > 0) prompts++;
    });
    await usePlayerStore.getState().play({ ...s!, ref: s!.ref ?? channel.ref }, { mode: 'external', externalPlayer: 'vlc', queue: [] });
    unsub();

    expect(prompts).toBe(0);
    expect(calls('parental.check')).toHaveLength(2);
    expect(calls('player.openExternal')).toEqual([{ player: 'vlc', source: expect.objectContaining({ ref: locked, url: 'http://x/live/666.m3u8' }) }]);
    expect(usePlayerStore.getState()).toMatchObject({ mode: 'external', status: 'playing' });
  });
});
