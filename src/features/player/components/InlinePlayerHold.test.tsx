/**
 * A zap between live channels keeps the last frame up until the next channel draws its own
 * (L3-player-ui-x4): no black flash between engines. A retry, a stop or a move to VOD does not.
 * Also: which element errors on an extensionless live channel get a retry through mpegts.js (PB-2),
 * a new play of the same URL (Start over of the movie playing) builds the engine again, and the
 * player leaves to an engine that restarts MPEG-TS what it does itself (PL-2).
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

const { createEngine } = await import('../engines');
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

describe('element errors on an extensionless live channel (PB-2)', () => {
  const channel: PlayerSource = { url: 'http://h/live/u/p/101', kind: 'direct', title: 'News', isLive: true, isRadio: false };
  const rejects = (): void => {
    Object.defineProperty(video(), 'error', { value: { code: 4, message: '' }, configurable: true });
    act(() => void video().dispatchEvent(new Event('error')));
  };

  beforeEach(() => {
    (window as unknown as { MediaSource?: unknown }).MediaSource = function MediaSource() {};
    vi.mocked(createEngine).mockClear();
  });
  afterEach(() => {
    delete (window as unknown as { MediaSource?: unknown }).MediaSource;
    vi.mocked(createEngine).mockImplementation(async () => ({ destroy: vi.fn() }) as never);
  });

  it('the element (a host remembered as not MPEG-TS) gets one retry through mpegts.js', async () => {
    vi.mocked(createEngine).mockImplementation(async () => ({ kind: 'native', destroy: vi.fn() }) as never);
    render(<InlinePlayer />);
    await tune(channel);
    await vi.waitFor(() => expect(createEngine).toHaveBeenCalledTimes(1));
    rejects();
    await vi.waitFor(() => expect(createEngine).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createEngine).mock.calls[1]![4]).toMatchObject({ forceMpegts: true });
  });

  it('the element that took over after mpegts.js found no MPEG-TS gets no second mpegts.js try', async () => {
    vi.mocked(createEngine).mockImplementation(async () => ({ kind: 'native', fellBack: true, destroy: vi.fn() }) as never);
    render(<InlinePlayer />);
    await tune(channel);
    await vi.waitFor(() => expect(createEngine).toHaveBeenCalledTimes(1));
    rejects();
    await vi.waitFor(() => expect(usePlayerStore.getState().status).toBe('error'));
    expect(createEngine).toHaveBeenCalledTimes(1);
  });
});

describe('a new play of the media playing (Start over, a recovery that resolved the same link)', () => {
  beforeEach(() => vi.mocked(createEngine).mockClear());

  it('builds the engine again, so it starts from 0; an update that only renames the item does not', async () => {
    const destroy = vi.fn();
    vi.mocked(createEngine).mockImplementation(async () => ({ destroy }) as never);
    await act(async () => {
      await usePlayerStore.getState().play(vod);
    });
    render(<InlinePlayer />);
    await vi.waitFor(() => expect(createEngine).toHaveBeenCalledTimes(1));
    await act(async () => {
      usePlayerStore.setState({ source: { ...usePlayerStore.getState().source!, title: 'Renamed' } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(createEngine).toHaveBeenCalledTimes(1);
    await act(async () => {
      await usePlayerStore.getState().play({ ...vod });
    });
    await vi.waitFor(() => expect(createEngine).toHaveBeenCalledTimes(2));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createEngine).mock.calls[1]![2]).toBe(vod.url);
  });
});

describe('MPEG-TS that the engine restarts (PL-2)', () => {
  const recording: PlayerSource = { url: 'http://h/rec/1.ts', kind: 'file', title: 'Rec', isLive: false, isRadio: false, resumeSeconds: 600 };
  /** Plays `recording` on an engine stub with `engine`'s members and waits until it is attached. */
  const playOn = async (engine: Record<string, unknown>): Promise<{ el: HTMLVideoElement; writes: number[] }> => {
    vi.mocked(createEngine).mockImplementation(async () => ({ kind: 'mpegts', destroy: vi.fn(), ...engine }) as never);
    render(<InlinePlayer />);
    await tune(recording);
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    const el = video();
    const writes: number[] = [];
    Object.defineProperty(el, 'duration', { configurable: true, get: () => 700 });
    Object.defineProperty(el, 'currentTime', { configurable: true, get: () => writes.at(-1) ?? 0, set: (v: number) => void writes.push(v) });
    return { el, writes };
  };

  beforeEach(() => vi.mocked(createEngine).mockClear());
  afterEach(() => vi.mocked(createEngine).mockImplementation(async () => ({ destroy: vi.fn() }) as never));

  it("leaves the resume to an engine that started there, and shows the engine's length", async () => {
    const { el, writes } = await playOn({ resumes: true, duration: () => 5400 });
    act(() => void el.dispatchEvent(new Event('loadedmetadata')));
    expect(writes).toEqual([]);
    act(() => void el.dispatchEvent(new Event('timeupdate')));
    // The element's own length covers only the stream since the restart.
    expect(usePlayerStore.getState().durationSeconds).toBe(5400);
  });

  it('an engine that did not resume gets the element seek at loadedmetadata, and the element length', async () => {
    const { el, writes } = await playOn({});
    act(() => void el.dispatchEvent(new Event('loadedmetadata')));
    expect(writes).toEqual([600]);
    act(() => void el.dispatchEvent(new Event('timeupdate')));
    expect(usePlayerStore.getState().durationSeconds).toBe(700);
  });

  it('a pause or play between two pipelines goes to the engine, and the status follows it', async () => {
    let between = true;
    const setPaused = vi.fn(() => between);
    await playOn({ setPaused });
    act(() => usePlayerStore.setState({ status: 'playing' }));
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    act(() => usePlayerStore.getState().togglePlay());
    expect(setPaused).toHaveBeenLastCalledWith(true);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe('paused');
    act(() => usePlayerStore.getState().togglePlay());
    expect(setPaused).toHaveBeenLastCalledWith(false);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
    expect(usePlayerStore.getState().status).toBe('playing');
    // With the new pipeline attached the element pauses itself.
    between = false;
    act(() => usePlayerStore.getState().togglePlay());
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  });
});

describe('a stream the browser loads from the provider directly (downloads)', () => {
  it('waits until the core has made room for it on the source before the engine connects', async () => {
    const { rpc } = await import('@/api/transport');
    const { bindPlaybackReport } = await import('../playbackReport');
    let answer: () => void = () => undefined;
    vi.mocked(rpc).mockImplementation(((cmd: string) =>
      cmd === 'downloads.playback' ? new Promise<void>((resolve) => (answer = resolve)) : Promise.reject(new Error('offline'))) as never);
    vi.mocked(createEngine).mockClear();
    const unbind = bindPlaybackReport();
    try {
      render(<InlinePlayer />);
      await tune({ ...vod, ref: { sourceId: 'xt', contentType: 'movie', itemId: '7' } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(createEngine).not.toHaveBeenCalled();
      await act(async () => {
        answer();
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(createEngine).toHaveBeenCalledTimes(1);
    } finally {
      unbind();
      vi.mocked(rpc).mockImplementation(() => Promise.reject(new Error('offline')));
    }
  });
});

describe('playback progress (P2-PLAYER-2)', () => {
  it('moves the position on timeupdate; progress, which only brings data, tells the store nothing', async () => {
    render(<InlinePlayer />);
    await tune(vod);
    const el = video();
    let at = 12;
    Object.defineProperty(el, 'currentTime', { configurable: true, get: () => at });
    Object.defineProperty(el, 'duration', { configurable: true, get: () => 600 });
    act(() => void el.dispatchEvent(new Event('timeupdate')));
    expect(usePlayerStore.getState().positionSeconds).toBe(12);
    const listener = vi.fn();
    const stop = usePlayerStore.subscribe(listener);
    try {
      at = 12.3;
      act(() => void el.dispatchEvent(new Event('progress')));
      expect(listener).not.toHaveBeenCalled();
      act(() => void el.dispatchEvent(new Event('timeupdate')));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().positionSeconds).toBe(12.3);
    } finally {
      stop();
    }
  });
});
