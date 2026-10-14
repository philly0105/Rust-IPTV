// The playback reporter (contract C7) under fake timers: it counts wall time
// only while the player store says `playing`, never in external mode, sends
// `stats.record` every 30 s and whenever counting stops, caps sleep gaps, and
// dates each flush with the local day.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, PlayerSource } from '@/api/types';

const calls = vi.hoisted(() => ({ list: [] as { cmd: string; args: unknown; opts?: unknown }[], fail: false }));
vi.mock('@/api/transport', async (importOriginal) => {
  const call = (cmd: string, args?: unknown, opts?: unknown) => {
    calls.list.push({ cmd, args, ...(opts ? { opts } : {}) });
    return calls.fail ? Promise.reject(new Error('core gone')) : Promise.resolve(undefined);
  };
  return { ...(await importOriginal<typeof import('@/api/transport')>()), rpc: call, rpcRaw: call, isDesktop: false };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const { usePlayerStore } = await import('@/features/player/store');
const { FLUSH_MS, MAX_TITLE_CHARS, localDay, startWatchStatsReporter, useWatchStatsReporter } = await import('../reporter');

interface Recorded {
  ref: ItemRef;
  title: string;
  posterUrl?: string;
  seconds: number;
  day: string;
}

const NEWS: ItemRef = { sourceId: 'src1', contentType: 'live', itemId: '7' };
const FILM: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: '201' };

function source(ref: ItemRef | undefined, title: string, extra: Partial<PlayerSource> = {}): PlayerSource {
  return {
    url: 'http://stream/x.m3u8',
    kind: 'hls',
    title,
    isLive: ref?.contentType === 'live',
    isRadio: false,
    ...(ref ? { ref } : {}),
    ...extra,
  };
}

const records = () => calls.list.filter((c) => c.cmd === 'stats.record').map((c) => c.args as Recorded);
const total = () => records().reduce((n, r) => n + r.seconds, 0);
const set = (patch: Partial<ReturnType<typeof usePlayerStore.getState>>) => usePlayerStore.setState(patch);
const play = (src: PlayerSource, mode: 'inline' | 'embedded-mpv' | 'external' | 'radio' = 'inline') => set({ source: src, mode, status: 'playing' });
const wait = (ms: number) => vi.advanceTimersByTime(ms);

let initial: ReturnType<typeof usePlayerStore.getState>;
let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 14, 20, 0, 0));
  initial ??= usePlayerStore.getState();
  usePlayerStore.setState(initial, true);
  calls.list.length = 0;
  calls.fail = false;
});

afterEach(() => {
  stop?.();
  stop = null;
  usePlayerStore.setState(initial, true);
  vi.useRealTimers();
});

describe('watch stats reporter', () => {
  it('counts only while the store says playing', () => {
    stop = startWatchStatsReporter();
    set({ source: source(NEWS, 'BBC One'), mode: 'inline', status: 'loading' });
    wait(10_000);
    expect(records()).toEqual([]);

    set({ status: 'playing' });
    wait(FLUSH_MS);
    expect(records()).toEqual([{ ref: NEWS, title: 'BBC One', seconds: 30, day: '2026-10-14' }]);

    set({ status: 'paused' });
    wait(120_000);
    set({ status: 'error' });
    wait(60_000);
    expect(total()).toBe(30);

    set({ status: 'playing' });
    wait(5_000);
    set({ status: 'paused' });
    expect(records().map((r) => r.seconds)).toEqual([30, 5]);
  });

  it('never counts an external player', () => {
    stop = startWatchStatsReporter();
    play(source(FILM, 'Black Harbor'), 'external');
    wait(5 * 60_000);
    set({ status: 'paused' });
    set({ status: 'playing' });
    wait(60_000);
    stop();
    stop = null;
    expect(records()).toEqual([]);
  });

  it('stops counting when playback moves to an external player', () => {
    stop = startWatchStatsReporter();
    play(source(FILM, 'Black Harbor'));
    wait(8_000);
    set({ mode: 'external' });
    expect(records().map((r) => r.seconds)).toEqual([8]);
    wait(10 * 60_000);
    expect(total()).toBe(8);
  });

  it('skips items without a catalog ref (local files)', () => {
    stop = startWatchStatsReporter();
    play(source(undefined, 'holiday.mkv'));
    wait(90_000);
    set({ status: 'idle', source: undefined });
    expect(records()).toEqual([]);
  });

  it('flushes every 30 s while playing', () => {
    stop = startWatchStatsReporter();
    play(source(NEWS, 'BBC One'));
    wait(29_000);
    expect(records()).toEqual([]);
    wait(1_000);
    expect(records().map((r) => r.seconds)).toEqual([30]);
    wait(FLUSH_MS * 3);
    expect(records().map((r) => r.seconds)).toEqual([30, 30, 30, 30]);
  });

  it('flushes on stop, rounding the last part second', () => {
    stop = startWatchStatsReporter();
    play(source(NEWS, 'BBC One'));
    wait(12_600);
    set({ status: 'idle', source: undefined });
    expect(records()).toEqual([{ ref: NEWS, title: 'BBC One', seconds: 13, day: '2026-10-14' }]);

    play(source(NEWS, 'BBC One'));
    wait(4_400);
    set({ status: 'paused' });
    expect(records().map((r) => r.seconds)).toEqual([13, 4]);
  });

  it('charges time to the item that was playing when the source changes', () => {
    stop = startWatchStatsReporter();
    play(source(NEWS, 'BBC One', { posterUrl: 'http://img/bbc.png' }));
    wait(10_000);
    play(source(FILM, 'Black Harbor'));
    wait(5_000);
    set({ status: 'idle', source: undefined });
    expect(records()).toEqual([
      { ref: NEWS, title: 'BBC One', posterUrl: 'http://img/bbc.png', seconds: 10, day: '2026-10-14' },
      { ref: FILM, title: 'Black Harbor', seconds: 5, day: '2026-10-14' },
    ]);
  });

  it('counts at most 2 s across a sleep', () => {
    stop = startWatchStatsReporter();
    play(source(FILM, 'Black Harbor'));
    wait(3_000);
    // The machine sleeps for an hour: the clock jumps, the interval does not run.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    wait(1_000);
    set({ status: 'paused' });
    expect(total()).toBe(5);
  });

  it('dates each flush with the local day at flush time', () => {
    vi.setSystemTime(new Date(2026, 9, 14, 23, 59, 50));
    stop = startWatchStatsReporter();
    play(source(NEWS, 'BBC One'));
    wait(20_000);
    set({ status: 'paused' });
    expect(records()).toEqual([{ ref: NEWS, title: 'BBC One', seconds: 20, day: '2026-10-15' }]);
    expect(localDay(new Date(2026, 0, 5, 0, 0, 1))).toBe('2026-01-05');
  });

  it('sends a trimmed title within the core limit, falling back to the item id', () => {
    stop = startWatchStatsReporter();
    play(source(FILM, `  ${'x'.repeat(MAX_TITLE_CHARS + 40)}  `));
    wait(2_000);
    play(source(NEWS, '   '));
    wait(2_000);
    set({ status: 'paused' });
    const [first, second] = records();
    expect(first?.title).toBe('x'.repeat(MAX_TITLE_CHARS));
    expect(second?.title).toBe('7');
  });

  it('drops a failed flush and keeps counting', async () => {
    stop = startWatchStatsReporter();
    play(source(NEWS, 'BBC One'));
    calls.fail = true;
    wait(FLUSH_MS);
    await Promise.resolve();
    calls.fail = false;
    wait(FLUSH_MS);
    expect(records().map((r) => r.seconds)).toEqual([30, 30]);
  });

  it('flushes on pagehide', () => {
    stop = startWatchStatsReporter();
    play(source(NEWS, 'BBC One'));
    wait(7_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(records().map((r) => r.seconds)).toEqual([7]);
    wait(3_000);
    set({ status: 'paused' });
    expect(records().map((r) => r.seconds)).toEqual([7, 3]);
    // Only the pagehide flush must outlive the page.
    expect(calls.list.filter((c) => c.cmd === 'stats.record').map((c) => c.opts)).toEqual([{ keepalive: true }, undefined]);
  });

  it('flushes on beforeunload with keepalive; the pagehide after it sends only what is left', () => {
    stop = startWatchStatsReporter();
    play(source(FILM, 'Black Harbor'));
    wait(4_000);
    window.dispatchEvent(new Event('beforeunload'));
    expect(records().map((r) => r.seconds)).toEqual([4]);
    wait(100);
    window.dispatchEvent(new Event('pagehide'));
    expect(records().map((r) => r.seconds)).toEqual([4]);
    // The navigation was slow to commit: the film played on until pagehide.
    wait(1_900);
    window.dispatchEvent(new Event('pagehide'));
    expect(records().map((r) => r.seconds)).toEqual([4, 2]);
    expect(calls.list.filter((c) => c.cmd === 'stats.record').map((c) => c.opts)).toEqual([{ keepalive: true }, { keepalive: true }]);
  });

  it('as a hook, starts on mount and flushes on unmount', () => {
    const hook = renderHook(() => useWatchStatsReporter());
    play(source(FILM, 'Black Harbor'));
    wait(9_000);
    hook.unmount();
    expect(records().map((r) => r.seconds)).toEqual([9]);
    play(source(FILM, 'Black Harbor'));
    wait(60_000);
    expect(total()).toBe(9);
  });
});
