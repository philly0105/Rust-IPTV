import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type ItemRef, type LiveAlternate, type PlayerSource, type Settings } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
// The parental gate has its own tests (parentalHook.test.ts); here everything may play.
vi.mock('./parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));

const store = await import('./store');
const media = await import('./media');
const failover = await import('./failover');
const reconnect = await import('./reconnect');
const pins = await import('./livePins');
const history = await import('./history');
const { useToastStore } = await import('@/ui/Toast');
const { usePlayerStore, reportStatus } = store;

const ref = (sourceId: string, itemId: string): ItemRef => ({ sourceId, contentType: 'live', itemId });
const origin: PlayerSource = {
  url: 'http://s1/live/1.m3u8',
  kind: 'hls',
  title: 'Sky Sports 1',
  isLive: true,
  isRadio: false,
  ref: ref('s1', '1'),
};
function alt(sourceId: string, itemId: string, name = 'Sky Sports 1 HD'): LiveAlternate {
  return {
    channel: { ref: ref(sourceId, itemId), name, categoryId: 'c', categoryName: 'C', isRadio: false },
    sourceName: `Source ${sourceId}`,
    sourceKind: 'xtream',
    quality: 'hd',
    matchedBy: 'name',
  };
}
const ALTS = [alt('s2', '20'), alt('s3', '30')];

const sourceIdNow = (): string | undefined => usePlayerStore.getState().source?.ref?.sourceId;
const streamUrlCalls = (): string[] =>
  rpcMock.mock.calls.filter(([n]) => n === 'xtream.streamUrl').map(([, a]) => (a as { ref: ItemRef }).ref.sourceId);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let unbind: () => void = () => undefined;

function settings(patch: Partial<Settings> = {}): void {
  store.setSettingsCache({ ...DEFAULT_SETTINGS, ...patch });
}

beforeEach(async () => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  localStorage.clear();
  pins.__resetLivePins();
  store.__resetPlayerForTests();
  failover.__resetFailover();
  media.resetMedia();
  useToastStore.setState({ toasts: [] });
  settings();
  handlers['live.alternates'] = () => ({ key: 'sky sports 1', quality: 'hd', alternates: ALTS });
  handlers['recent.add'] = () => undefined;
  handlers['positions.get'] = () => null;
  handlers['sources.get'] = (a) => ({ id: (a as { id: string }).id, kind: 'xtream', name: 'S' });
  handlers['epg.nowNext'] = () => [];
  handlers['xtream.streamUrl'] = (a) => {
    const r = (a as { ref: ItemRef }).ref;
    return { url: `http://${r.sourceId}/live/${r.itemId}.m3u8`, kind: 'hls', title: 'x', isLive: true, isRadio: false };
  };
  unbind = reconnect.bindRecovery();
  await store.usePlayerStore.getState().play(origin);
  reportStatus('playing');
  await settle();
});

afterEach(() => {
  unbind();
  store.__resetPlayerForTests();
});

describe('live failover', () => {
  it('switches a channel that cannot recover to the best copy, with an undo toast', async () => {
    reportStatus('error', 'HTTP 404');
    expect(reconnectPhase()).toBe('switching');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.id).toBe('live-failover');
    expect(toast?.action).toBeDefined();
  });

  it('names the channels in the toast with a place tag after the name, or none with the strip setting', async () => {
    const t = vi.spyOn(i18next, 't');
    handlers['live.alternates'] = () => ({ key: 'sky sports 1', quality: 'hd', alternates: [alt('s2', '20', 'UK| Sky Sports 1 HD')] });
    // Other channels than the one beforeEach played: its copies are cached already.
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/5.m3u8', title: 'UK| Sky Sports 1', ref: ref('s1', '5') });
    reportStatus('playing');
    await settle();
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    expect(t).toHaveBeenCalledWith('player:liveFailoverSwitched', { channel: 'Sky Sports 1 HD (UK)', source: 'Source s2' });
    expect(t).toHaveBeenCalledWith('player:liveFailoverSwitchedDetail', { channel: 'Sky Sports 1 (UK)' });

    // With the setting on, the player holds the stripped names and the toast says just those.
    failover.__resetFailover();
    t.mockClear();
    settings({ stripCountryPrefix: true });
    handlers['live.alternates'] = () => ({ key: 'sky sports 1', quality: 'hd', alternates: [alt('s3', '30', 'UK| Sky Sports 1 HD')] });
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/6.m3u8', title: 'Sky Sports 1', ref: ref('s1', '6') });
    reportStatus('playing');
    await settle();
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
    expect(t).toHaveBeenCalledWith('player:liveFailoverSwitched', { channel: 'Sky Sports 1 HD', source: 'Source s3' });
    expect(t).toHaveBeenCalledWith('player:liveFailoverSwitchedDetail', { channel: 'Sky Sports 1' });
  });

  it('tries the next copy when one fails before playing, and never loops back', async () => {
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    // The new copy fails right away: no retries, the next copy.
    reportStatus('error', 'Network error');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
    reportStatus('error', 'HTTP 404');
    await settle();
    // Out of copies: the error shows on the last one; the original and s2 are not tried again.
    await vi.waitFor(() => expect(usePlayerStore.getState().status).toBe('error'));
    expect(sourceIdNow()).toBe('s3');
    expect(streamUrlCalls()).toEqual(['s2', 's3']);
  });

  it('skips a copy whose link cannot be resolved', async () => {
    const base = handlers['xtream.streamUrl']!;
    handlers['xtream.streamUrl'] = (a) => {
      if ((a as { ref: ItemRef }).ref.sourceId === 's2') throw Object.assign(new Error('gone'), { code: 'not_found' });
      return base(a);
    };
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
  });

  it('Undo goes back to the original and stops switching it', async () => {
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    useToastStore.getState().toasts.at(-1)?.action?.onClick();
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s1'));
    expect(usePlayerStore.getState().source?.url).toBe('http://s1/live/1.m3u8');
    const before = streamUrlCalls().length;
    reportStatus('error', 'HTTP 404');
    await settle();
    expect(usePlayerStore.getState().status).toBe('error');
    expect(sourceIdNow()).toBe('s1');
    expect(streamUrlCalls().length).toBe(before);
  });

  it('tuning another channel takes the "Switched to" toast away, and a stale Undo does nothing', async () => {
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    const undo = useToastStore.getState().toasts.at(-1)?.action?.onClick;
    expect(undo).toBeDefined();
    await usePlayerStore.getState().play({ ...origin, url: 'http://s9/live/9.m3u8', title: 'News', ref: ref('s9', '9') });
    await settle();
    expect(useToastStore.getState().toasts.some((t) => t.id === 'live-failover')).toBe(false);
    // An Undo pressed on its way out must not pull the user back to the channel that failed.
    undo?.();
    await settle();
    expect(sourceIdNow()).toBe('s9');
  });

  it('a stale Undo of a pin redirect does nothing once another channel plays', async () => {
    pins.setLivePin('sky sports 1', ref('s3', '30'));
    failover.__resetFailover();
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/1b.m3u8', ref: ref('s1', '2') });
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
    const undo = useToastStore.getState().toasts.at(-1)?.action?.onClick;
    // Another channel, with no pin of its own.
    handlers['live.alternates'] = () => ({ key: 'news', quality: 'hd', alternates: [] });
    await usePlayerStore.getState().play({ ...origin, url: 'http://s9/live/9.m3u8', title: 'News', ref: ref('s9', '9') });
    await settle();
    expect(useToastStore.getState().toasts.some((t) => t.id === 'live-failover')).toBe(false);
    undo?.();
    await settle();
    expect(sourceIdNow()).toBe('s9');
  });

  it('prefers the pinned source', async () => {
    pins.setLivePin('sky sports 1', ref('s3', '30'));
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
  });

  it('retries first, and switches when retries give up', async () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      media.setMediaCommands({ setQuality: vi.fn(), setAudio: vi.fn(), setText: vi.fn(), setRate: vi.fn(), togglePip: vi.fn(), retry });
      for (const d of reconnect.RECONNECT_DELAYS_MS) {
        reportStatus('error', 'Network error');
        expect(sourceIdNow()).toBe('s1');
        vi.advanceTimersByTime(d);
      }
      expect(retry).toHaveBeenCalledTimes(3);
      reportStatus('error', 'Network error');
      vi.useRealTimers();
      await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when live failover is off', async () => {
    settings({ liveFailover: false });
    reportStatus('error', 'HTTP 404');
    await settle();
    expect(usePlayerStore.getState().status).toBe('error');
    expect(sourceIdNow()).toBe('s1');
  });

  it('a pin moves a channel started elsewhere to the preferred source', async () => {
    pins.setLivePin('sky sports 1', ref('s3', '30'));
    failover.__resetFailover();
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/1b.m3u8', ref: ref('s1', '2') });
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
    expect(useToastStore.getState().toasts.at(-1)?.id).toBe('live-failover');
  });

  it('a full account skips the copies on the same account; an auth refusal tries them last', async () => {
    handlers['live.alternates'] = () => ({ key: 'sky sports 1', quality: 'hd', alternates: [alt('s1', '5'), alt('s2', '20')] });
    failover.__resetFailover();
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/1c.m3u8' });
    reportStatus('playing');
    await settle();
    reportStatus('error', 'Max connections reached');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    reportStatus('error', 'Max connections reached');
    await vi.waitFor(() => expect(usePlayerStore.getState().status).toBe('error'));
    expect(streamUrlCalls()).toEqual(['s2']);

    failover.__resetFailover();
    rpcMock.mockClear();
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/1d.m3u8' });
    reportStatus('playing');
    await settle();
    reportStatus('error', 'HTTP 403');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.ref?.itemId).toBe('5'));
    expect(streamUrlCalls()).toEqual(['s2', 's1']);
  });

  it('B after a failover goes back to the channel before, not to the copy it left', async () => {
    const other: PlayerSource = { ...origin, url: 'http://s9/live/9.m3u8', title: 'News', ref: ref('s9', '9') };
    history.__resetHistoryForTests();
    history.recordVisit(other);
    history.recordVisit(usePlayerStore.getState().source);
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s2'));
    const keys = (): string[] => history.useHistoryStore.getState().entries.map((e) => e.key);
    expect(keys()).toEqual(['s2|live|20', 's9|live|9']);
    expect(history.previousEntry(history.useHistoryStore.getState().entries, history.currentLiveKey())?.ref.sourceId).toBe('s9');
    // Undo is the same channel too.
    useToastStore.getState().toasts.at(-1)?.action?.onClick();
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s1'));
    expect(keys()).toEqual(['s1|live|1', 's9|live|9']);
  });

  it('a pin redirect replaces the history entry of the copy it left', async () => {
    pins.setLivePin('sky sports 1', ref('s3', '30'));
    failover.__resetFailover();
    history.__resetHistoryForTests();
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/1b.m3u8', ref: ref('s1', '2') });
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
    expect(history.useHistoryStore.getState().entries.map((e) => e.key)).toEqual(['s3|live|30']);
  });

  it('lists the playing channel’s alternates for the menu', async () => {
    await vi.waitFor(() => expect(failover.useAlternatesStore.getState().status).toBe('ready'));
    expect(failover.useAlternatesStore.getState().data?.alternates).toHaveLength(2);
  });

  it('asks for the copies again when the quality filter changes, for the menu and for failover', async () => {
    await vi.waitFor(() => expect(alternates().status).toBe('ready'));
    const before = lookups();

    // Settings writes that leave the filter as it is ask nothing (the untagged toggle needs a minimum).
    settings({ lastRoute: '/live' });
    settings({ liveHideUntagged: true });
    await settle();
    expect(lookups()).toBe(before);

    // The core now leaves out the s2 copy; the lookup cached before the change is not used.
    handlers['live.alternates'] = () => ({ key: 'sky sports 1', quality: 'hd', alternates: [alt('s3', '30')] });
    settings({ liveMinQuality: 'fhd' });
    expect(lookups()).toBe(before + 1);
    await vi.waitFor(() => expect(alternates().status).toBe('ready'));
    expect(alternates().data?.alternates.map((a) => a.channel.ref.sourceId)).toEqual(['s3']);
    reportStatus('error', 'HTTP 404');
    await vi.waitFor(() => expect(sourceIdNow()).toBe('s3'));
    expect(streamUrlCalls()).toEqual(['s3']);
  });

  it('drops an answer asked for before the quality filter changed', async () => {
    await vi.waitFor(() => expect(alternates().status).toBe('ready'));
    let answer: (v: unknown) => void = () => undefined;
    handlers['live.alternates'] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await usePlayerStore.getState().play({ ...origin, url: 'http://s1/live/2.m3u8', ref: ref('s1', '2') });
    await settle();
    expect(alternates()).toMatchObject({ forKey: 's1|live|2', status: 'loading' });
    const unfiltered = answer;

    handlers['live.alternates'] = () => ({ key: 'sky sports 1', quality: 'hd', alternates: [alt('s3', '30')] });
    settings({ liveMinQuality: 'fhd', liveHideUntagged: true });
    await vi.waitFor(() => expect(alternates().status).toBe('ready'));
    // The lookup from before the change answers last, with a copy the filter now hides.
    unfiltered({ key: 'sky sports 1', quality: 'hd', alternates: ALTS });
    await settle();
    expect(alternates().forKey).toBe('s1|live|2');
    expect(alternates().data?.alternates.map((a) => a.channel.ref.sourceId)).toEqual(['s3']);
  });
});

function alternates(): ReturnType<typeof failover.useAlternatesStore.getState> {
  return failover.useAlternatesStore.getState();
}

function lookups(): number {
  return rpcMock.mock.calls.filter(([n]) => n === 'live.alternates').length;
}

function reconnectPhase(): string {
  return reconnect.useReconnectStore.getState().phase;
}
