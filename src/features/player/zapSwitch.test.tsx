/**
 * A burst that follows a press which already opened its channel (a source with more than one
 * connection, L3-player-core-x3): the channels passed open nothing, and the first channel's
 * stream is torn down (its load aborted, the engine destroyed) before the last one's engine
 * starts. Embedded mpv gets one `mpv.load` per opened channel, never one for a channel passed:
 * the core sends it as `loadfile <url> replace`, so the last channel replaces the first.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { Channel, ItemRef } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: async (name: string, args?: unknown) => {
    const h = handlers[name];
    if (!h) throw new Error(`unmocked rpc ${name}`);
    return h(args);
  },
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

/** What happened to the engines, in order: `create <url>`, `destroy <url>`, `aborted <url>`. */
const log: string[] = [];
vi.mock('./engines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./engines')>()),
  createEngine: vi.fn(async (_el: HTMLMediaElement, _source: unknown, loadUrl: string, _cb: unknown, opts: { signal?: AbortSignal }) => {
    log.push(`create ${loadUrl}`);
    opts.signal?.addEventListener('abort', () => log.push(`aborted ${loadUrl}`));
    return { kind: 'hls', setQuality() {}, setAudio() {}, setText() {}, recover() {}, destroy: () => log.push(`destroy ${loadUrl}`) };
  }),
}));

const store = await import('./store');
const { queryClient, rpcKey } = await import('@/api/query');
const { InlinePlayer } = await import('./components/InlinePlayer');
const { mpvLoadKey } = await import('./components/MpvSurface');
const { usePlayerStore, playItem, zap } = store;

function channel(n: number): Channel {
  return { ref: { sourceId: 's1', contentType: 'live', itemId: String(100 + n) }, name: `Channel ${n}`, number: n, isRadio: false } as Channel;
}
const url = (n: number): string => `http://x/live/${100 + n}.m3u8`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  log.length = 0;
  queryClient.clear();
  store.__resetPlayerForTests();
  handlers['settings.get'] = () => ({ player: 'html5' });
  handlers['parental.status'] = () => ({ enabled: false });
  handlers['recent.add'] = () => undefined;
  handlers['positions.get'] = () => null;
  handlers['positions.set'] = () => undefined;
  handlers['epg.nowNext'] = () => ({});
  handlers['account.status'] = () => ({ sourceId: 's1', kind: 'xtream', isTrial: false, maxConnections: 2, checkedAt: new Date().toISOString() });
  handlers['xtream.streamUrl'] = (a) => {
    const id = Number((a as { ref: ItemRef }).ref.itemId) - 100;
    return { url: url(id), kind: 'hls', title: String(id), isLive: true, isRadio: false };
  };
  handlers['catalog.neighbors'] = (a) => {
    const n = Number((a as { ref: ItemRef }).ref.itemId) - 100;
    return { prev: n > 0 ? channel(n - 1) : null, next: n < 20 ? channel(n + 1) : null };
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  store.__resetPlayerForTests();
});

describe('a burst after a press that already opened its channel (L3-player-core-x3)', () => {
  it("tears the first channel's stream down before the last channel's opens, and opens none passed", async () => {
    await playItem({ title: 'Channel 1', isLive: true, ref: channel(1).ref, sourceKind: 'xtream' });
    // What embedded mpv would load: one `mpv.load` per distinct key (MpvSurface keys its load on it).
    const mpvLoads: string[] = [mpvLoadKey(usePlayerStore.getState().source!)];
    const unsub = usePlayerStore.subscribe((s) => {
      const key = s.source ? mpvLoadKey(s.source) : '';
      if (key && key !== mpvLoads[mpvLoads.length - 1]) mpvLoads.push(key);
    });
    render(<InlinePlayer />);
    await vi.waitFor(() => expect(log).toEqual([`create ${url(1)}`]));
    await vi.waitFor(() => expect(queryClient.getQueryData(rpcKey('account.status', { sourceId: 's1' }))).toBeTruthy());

    // The first press opens channel 2 at once; the presses 80 ms behind it pass 3 and stop on 4.
    let presses: Promise<Channel | undefined>[] = [];
    await act(async () => {
      presses = [zap('down')];
      await vi.waitFor(() => expect(log).toContain(`create ${url(2)}`));
      await wait(80);
      presses.push(zap('down'));
      await wait(80);
      presses.push(zap('down'));
      // One burst: every press lands on channel 4.
      expect((await Promise.all(presses)).map((c) => c?.number)).toEqual([4, 4, 4]);
    });
    await vi.waitFor(() => expect(log).toContain(`create ${url(4)}`));
    unsub();

    expect(usePlayerStore.getState().source?.url).toBe(url(4));
    // Channel 3 was passed: no engine, no mpv load.
    expect(log.some((e) => e.endsWith(url(3)))).toBe(false);
    // Channel 2's load is aborted and its engine destroyed before channel 4's engine starts.
    const tail = log.slice(log.indexOf(`create ${url(2)}`));
    expect(tail).toEqual([`create ${url(2)}`, `aborted ${url(2)}`, `destroy ${url(2)}`, `create ${url(4)}`]);
    expect(mpvLoads).toEqual([`${url(1)}|`, `${url(2)}|`, `${url(4)}|`]);
  });
});
