import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

type GapHandler = {
  appendSyncPoints(points: { dts: number; pts: number; originalDts: number }[]): void;
  appendArchiveGaps(gaps: { start: number; end: number }[]): void;
  destroy(): void;
};
type GapHandlerCtor = new (config: Record<string, boolean>, video: HTMLMediaElement, onSeek: () => void) => GapHandler;
// Load the vendored TypeScript with Vite; the application tsconfig does not type-check vendor sources.
const vendorModule = '../../../vendor/mpegts.js/src/player/' + 'seeking-handler';
// The fork checkout comes from `node tools/prepare-mpegts.mjs`; without it these tests skip.
const vendored = existsSync(new URL('../../../vendor/mpegts.js/src', import.meta.url));
const { default: SeekingHandler } = vendored
  ? await vi.importActual<{ default: GapHandlerCtor }>(vendorModule)
  : { default: undefined as unknown as GapHandlerCtor };
const remuxerModule = '../../../vendor/mpegts.js/src/remux/' + 'mp4-remuxer';
const { default: MP4Remuxer } = vendored
  ? await vi.importActual<{ default: new (config: Record<string, boolean>) => Record<string, unknown> }>(remuxerModule)
  : { default: undefined as unknown as new (config: Record<string, boolean>) => Record<string, unknown> };

class FakeVideo extends EventTarget {
  currentTime = 8;
  paused = false;
  seeking = false;
  ended = false;
  readyState = 4;
  frames = 100;
  buffered = { length: 1, start: () => 0, end: () => 40 };
  getVideoPlaybackQuality() { return { totalVideoFrames: this.frames }; }
}

function watch(syncs: number[]) {
  const video = new FakeVideo();
  const handler = new SeekingHandler(
    { archiveSkipTimestampGaps: true, archiveTrace: false, accurateSeek: false },
    video as unknown as HTMLMediaElement,
    () => undefined,
  );
  handler.appendSyncPoints(syncs.map((dts) => ({ dts, pts: dts, originalDts: dts })));
  return { video, handler };
}

afterEach(() => vi.useRealTimers());

describe.skipIf(!vendored)('catch-up timestamp gap recovery', () => {
  it('finds a gap between video samples before the playback clock reaches it', () => {
    const remuxer = new MP4Remuxer({ archiveSkipTimestampGaps: true }) as {
      _dtsBase: number;
      _videoMeta: { refSampleDuration: number };
      _onMediaSegment: (type: string, segment: { info: { videoGaps: { start: number; end: number }[] } }) => void;
      _remuxVideo: (track: Record<string, unknown>, force: boolean) => void;
    };
    remuxer._dtsBase = 0;
    remuxer._videoMeta = { refSampleDuration: 40 };
    const gaps: { start: number; end: number }[] = [];
    remuxer._onMediaSegment = (_type, segment) => gaps.push(...segment.info.videoGaps);
    const sample = (dts: number) => ({ dts, cts: 0, isKeyframe: true, fileposition: 0, length: 4,
      units: [{ data: new Uint8Array([0, 0, 0, 1]) }] });
    remuxer._remuxVideo({ id: 1, sequenceNumber: 1, length: 12,
      samples: [sample(28_000), sample(28_040), sample(35_000)] }, false);
    expect(gaps).toEqual([{ start: 28_080, end: 35_000 }]);
  });

  it('skips a known video sample gap as soon as playback reaches it', () => {
    const { video, handler } = watch([27_000, 35_000]);
    handler.appendArchiveGaps([{ start: 28_040, end: 35_000 }]);
    video.currentTime = 28.1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBeCloseTo(35.01);
    handler.destroy();
  });

  it('advances the play cursor across a seven-second video gap', () => {
    vi.useFakeTimers();
    const { video, handler } = watch([27_000, 35_000]);
    video.currentTime = 28;
    video.dispatchEvent(new Event('timeupdate'));
    vi.advanceTimersByTime(2_100);
    video.currentTime = 30.1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBeCloseTo(35.01);
    handler.destroy();
  });

  it('jumps to a buffered keyframe when the clock advances without decoded video', () => {
    vi.useFakeTimers();
    const { video, handler } = watch([1_000, 30_000]);
    video.dispatchEvent(new Event('timeupdate'));
    vi.advanceTimersByTime(2_100);
    video.currentTime = 11;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBeCloseTo(30.01);
    handler.destroy();
  });

  it('recovers frozen decoding even when keyframes are normally spaced', () => {
    vi.useFakeTimers();
    const { video, handler } = watch([1_000, 10_000, 20_000, 30_000]);
    video.dispatchEvent(new Event('timeupdate'));
    vi.advanceTimersByTime(2_100);
    video.currentTime = 11;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBeCloseTo(20.01);
    handler.destroy();
  });

  it('leaves ordinary playback alone when frames are decoding', () => {
    vi.useFakeTimers();
    const { video, handler } = watch([1_000, 10_000, 20_000]);
    video.dispatchEvent(new Event('timeupdate'));
    vi.advanceTimersByTime(2_100);
    video.currentTime = 11;
    video.frames++;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBe(11);
    handler.destroy();
  });

  it('does not jump into media that has not buffered yet', () => {
    vi.useFakeTimers();
    const { video, handler } = watch([1_000, 30_000]);
    video.buffered.end = () => 20;
    video.dispatchEvent(new Event('timeupdate'));
    vi.advanceTimersByTime(2_100);
    video.currentTime = 11;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBe(11);
    handler.destroy();
  });
});
