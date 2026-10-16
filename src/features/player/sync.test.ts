import { beforeEach, describe, expect, it } from 'vitest';

import type { PlayerSource } from '@/api/types';

import { usePlayerStore } from './store';
import { adjustDelay, DELAY_LIMIT_MS, formatDelay, resetDelay, stepDelay, streamKey, useSyncStore } from './sync';

const source = (url: string, extra: Partial<PlayerSource> = {}): PlayerSource => ({
  url,
  kind: 'hls',
  title: 'Channel',
  isLive: true,
  isRadio: false,
  ...extra,
});

describe('delay stepping', () => {
  it('moves in 100 ms steps and snaps odd values to the step', () => {
    expect(stepDelay(0, 1)).toBe(100);
    expect(stepDelay(0, -3)).toBe(-300);
    expect(stepDelay(250, 1)).toBe(400);
    expect(stepDelay(-100, 1)).toBe(0);
    expect(Object.is(stepDelay(-100, 1), -0)).toBe(false);
  });

  it('stops at the limit either way', () => {
    expect(stepDelay(DELAY_LIMIT_MS, 1)).toBe(DELAY_LIMIT_MS);
    expect(stepDelay(-DELAY_LIMIT_MS, -5)).toBe(-DELAY_LIMIT_MS);
  });
});

describe('delay formatting', () => {
  it('signs non-zero values and keeps zero unsigned', () => {
    expect(formatDelay(300, 'en')).toBe('+300 ms');
    expect(formatDelay(-1200, 'en')).toBe('-1,200 ms');
    expect(formatDelay(0, 'en')).toBe('0 ms');
    expect(formatDelay(-0, 'en')).toBe('0 ms');
  });

  it('uses the UI language', () => {
    expect(formatDelay(1500, 'de')).toMatch(/^\+1\.500\sms$/);
  });
});

describe('sync store', () => {
  beforeEach(() => {
    usePlayerStore.setState({ source: undefined });
    useSyncStore.setState({ audioMs: 0, subMs: 0 });
  });

  it('adjusts and resets each delay on its own', () => {
    expect(adjustDelay('sub', 2)).toBe(200);
    expect(adjustDelay('audio', -1)).toBe(-100);
    expect(useSyncStore.getState()).toEqual({ audioMs: -100, subMs: 200 });
    resetDelay('sub');
    expect(useSyncStore.getState()).toEqual({ audioMs: -100, subMs: 0 });
  });

  it('resets both delays when another stream starts, not on a same-stream update', () => {
    usePlayerStore.setState({ source: source('http://h/1.m3u8') });
    adjustDelay('sub', 3);
    adjustDelay('audio', 1);
    usePlayerStore.setState({ source: source('http://h/1.m3u8', { title: 'Renamed' }) });
    expect(useSyncStore.getState()).toEqual({ audioMs: 100, subMs: 300 });
    usePlayerStore.setState({ source: source('http://h/2.m3u8') });
    expect(useSyncStore.getState()).toEqual({ audioMs: 0, subMs: 0 });
  });

  it('keeps the delays when a reconnect swaps in a fresh link for the same item', () => {
    const ref = { sourceId: 'st', contentType: 'live' as const, itemId: '7' };
    usePlayerStore.setState({ source: source('http://portal/old.ts?token=a', { ref }) });
    adjustDelay('sub', 8);
    usePlayerStore.setState({ source: source('http://portal/new.ts?token=b', { ref }) });
    expect(useSyncStore.getState().subMs).toBe(800);
    // Another copy of the channel (failover) is another item: it starts at zero.
    usePlayerStore.setState({ source: source('http://other/7.ts', { ref: { ...ref, sourceId: 'b' } }) });
    expect(useSyncStore.getState().subMs).toBe(0);
  });

  it('treats another episode of the same URL as a new stream', () => {
    expect(streamKey(source('u', { episodeId: '1' }))).not.toBe(streamKey(source('u', { episodeId: '2' })));
    expect(streamKey(undefined)).toBe('');
  });
});
