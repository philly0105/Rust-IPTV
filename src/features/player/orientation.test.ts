/**
 * Fullscreen video on a phone turns the screen to landscape, and leaving fullscreen lets it turn
 * freely again. Engines that refuse the lock (iOS Safari, desktop browsers) change nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lockLandscapeForVideo, unlockOrientation } from './fullscreen';

const realOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
const realMatchMedia = window.matchMedia;

let lock: ReturnType<typeof vi.fn>;
let unlock: ReturnType<typeof vi.fn>;

/** A window that answers `matches` for the queries listed, and no others. */
function media(matching: string[]): void {
  window.matchMedia = ((q: string) => ({ matches: matching.includes(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  lock = vi.fn(async () => undefined);
  unlock = vi.fn();
  Object.defineProperty(screen, 'orientation', { configurable: true, value: { lock, unlock, type: 'portrait-primary' } });
});

afterEach(async () => {
  // Leaves the module's lock flag clear for the next test.
  unlockOrientation();
  await flush();
  if (realOrientation) Object.defineProperty(screen, 'orientation', realOrientation);
  else delete (screen as { orientation?: unknown }).orientation;
  window.matchMedia = realMatchMedia;
  document.querySelectorAll('video[data-player-video]').forEach((v) => v.remove());
});

describe('landscape for fullscreen video', () => {
  it('a phone locks to landscape, and leaving fullscreen unlocks', async () => {
    media(['(max-width: 639px)']);
    lockLandscapeForVideo('inline');
    expect(lock).toHaveBeenCalledWith('landscape');
    await flush();
    unlockOrientation();
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('a tablet held in the hand (coarse pointer) locks too', () => {
    media(['(pointer: coarse)']);
    lockLandscapeForVideo('inline');
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('radio and a desktop window keep the screen as held', () => {
    media(['(max-width: 639px)']);
    lockLandscapeForVideo('radio');
    media([]);
    lockLandscapeForVideo('inline');
    expect(lock).not.toHaveBeenCalled();
  });

  it('a portrait picture is not turned sideways', () => {
    media(['(max-width: 639px)']);
    const video = document.createElement('video');
    video.setAttribute('data-player-video', '');
    Object.defineProperty(video, 'videoWidth', { value: 720 });
    Object.defineProperty(video, 'videoHeight', { value: 1280 });
    document.body.appendChild(video);
    lockLandscapeForVideo('inline');
    expect(lock).not.toHaveBeenCalled();
  });

  it('a refused lock is ignored, and nothing is unlocked afterwards', async () => {
    media(['(max-width: 639px)']);
    lock.mockImplementation(async () => {
      throw new DOMException('not supported', 'NotSupportedError');
    });
    lockLandscapeForVideo('inline');
    await flush();
    unlockOrientation();
    expect(unlock).not.toHaveBeenCalled();
  });

  it('an engine without a lock does nothing', () => {
    media(['(max-width: 639px)']);
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    expect(() => lockLandscapeForVideo('inline')).not.toThrow();
    expect(() => unlockOrientation()).not.toThrow();
  });
});
