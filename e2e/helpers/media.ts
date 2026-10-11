import { expect, type Page } from '@playwright/test';

export interface MediaState {
  tag: string;
  readyState: number;
  currentTime: number;
  duration: number | null;
  paused: boolean;
  muted: boolean;
  volume: number;
  src: string;
  error: string | null;
}

/** State of the first in-app <video>/<audio> element, or null when none is mounted. */
export async function mediaState(page: Page, selector = 'video, audio'): Promise<MediaState | null> {
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll<HTMLMediaElement>(sel)].find((m) => m.currentSrc || m.src) ?? document.querySelector<HTMLMediaElement>(sel);
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      readyState: el.readyState,
      currentTime: el.currentTime,
      duration: Number.isFinite(el.duration) ? el.duration : null,
      paused: el.paused,
      muted: el.muted,
      volume: el.volume,
      src: el.currentSrc || el.src,
      error: el.error ? `${el.error.code}: ${el.error.message}` : null,
    };
  }, selector);
}

/**
 * Waits until the media element has enough data (readyState >= 3) and its
 * clock moves forward by at least `advance` seconds. Returns the last state.
 */
export async function expectPlaying(page: Page, opts: { advance?: number; timeout?: number; selector?: string } = {}): Promise<MediaState> {
  const advance = opts.advance ?? 1;
  const timeout = opts.timeout ?? 30_000;
  let first: number | null = null;
  let last: MediaState | null = null;
  await expect
    .poll(
      async () => {
        last = await mediaState(page, opts.selector);
        if (!last) return 'no media element';
        if (last.error) throw new Error(`media error ${last.error} (src ${last.src})`);
        if (last.readyState < 3) return `readyState ${last.readyState}`;
        if (first === null) first = last.currentTime;
        return last.currentTime - first >= advance ? 'playing' : `t=${last.currentTime.toFixed(2)}`;
      },
      { timeout, intervals: [250, 500, 500, 1000], message: `media should reach readyState>=3 and advance ${advance}s` },
    )
    .toBe('playing');
  return last as unknown as MediaState;
}

/** Media source url (works for hls.js blob sources too: the resume record keeps the real url). */
export async function resumeRecord(page: Page): Promise<{ source: { url: string; title: string; isLive: boolean; ref?: { itemId: string } }; positionSeconds: number } | null> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('player.resume');
    return raw ? JSON.parse(raw) : null;
  });
}
