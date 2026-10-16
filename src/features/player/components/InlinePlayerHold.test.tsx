/**
 * A zap between live channels keeps the last frame up until the next channel draws its own
 * (L3-player-ui-x4): no black flash between engines. A retry, a stop or a move to VOD does not.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { PlayerSource } from '@/api/types';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('../parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// The engines have their own tests: here each one is a stub that only gets torn down.
vi.mock('../engines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engines')>()),
  createEngine: vi.fn(async () => ({ destroy: vi.fn() })),
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { resetMedia } = await import('../media');
const { InlinePlayer, holdLastFrame, ZAP_HOLD_MAX_MS } = await import('./InlinePlayer');

const live = (id: string): PlayerSource => ({ url: `http://h/live/${id}.m3u8`, kind: 'hls', title: `Channel ${id}`, isLive: true, isRadio: false });
const vod: PlayerSource = { url: 'http://h/movie/7.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false };

const drawImage = vi.fn();
const video = (): HTMLVideoElement => document.querySelector<HTMLVideoElement>('video[data-player-video]')!;
const hold = (): HTMLCanvasElement => document.querySelector<HTMLCanvasElement>('canvas[data-zap-hold]')!;
/** jsdom decodes nothing: the element reports a 1280x720 frame on screen. */
function showsFrame(el: HTMLVideoElement): void {
  Object.defineProperty(el, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(el, 'videoWidth', { configurable: true, get: () => 1280 });
  Object.defineProperty(el, 'videoHeight', { configurable: true, get: () => 720 });
}
const tune = async (source: PlayerSource): Promise<void> => {
  await act(async () => {
    usePlayerStore.setState({ source, mode: 'inline', status: 'loading' });
    await Promise.resolve();
  });
};

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage })) as never);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetPlayerForTests();
  resetMedia();
});

describe('the last frame across a zap (L3-player-ui-x4)', () => {
  it('stays up from one live channel to the next until the next one has a frame', async () => {
    await tune(live('1'));
    render(<InlinePlayer />);
    showsFrame(video());
    expect(hold().hidden).toBe(true);
    await tune(live('2'));
    expect(drawImage).toHaveBeenCalledWith(video(), 0, 0, 1280, 720);
    expect(hold().hidden).toBe(false);
    expect([hold().width, hold().height]).toEqual([1280, 720]);
    // The next channel decodes its first frame.
    act(() => void video().dispatchEvent(new Event('loadeddata')));
    expect(hold().hidden).toBe(true);
    expect(hold().width).toBe(0);
  });

  it('a zap on before the next channel drew keeps the first held frame', async () => {
    await tune(live('1'));
    render(<InlinePlayer />);
    showsFrame(video());
    await tune(live('2'));
    // Channel 2 never drew: the element has nothing of its own.
    Object.defineProperty(video(), 'readyState', { configurable: true, get: () => 0 });
    await tune(live('3'));
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(hold().hidden).toBe(false);
  });

  it('goes after a while when the next channel never draws', async () => {
    vi.useFakeTimers();
    await tune(live('1'));
    render(<InlinePlayer />);
    showsFrame(video());
    await tune(live('2'));
    expect(hold().hidden).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ZAP_HOLD_MAX_MS);
    });
    expect(hold().hidden).toBe(true);
  });

  it('is not kept for a move to VOD, a stop, or a channel with no frame yet', async () => {
    await tune(live('1'));
    render(<InlinePlayer />);
    showsFrame(video());
    await tune(vod);
    expect(hold().hidden).toBe(true);
    await tune(live('1'));
    showsFrame(video());
    act(() => usePlayerStore.getState().stop());
    expect(hold().hidden).toBe(true);
    expect(drawImage).not.toHaveBeenCalled();
    const el = document.createElement('video');
    expect(holdLastFrame(el, document.createElement('canvas'))).toBe(false);
  });
});
