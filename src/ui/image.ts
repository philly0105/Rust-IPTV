/**
 * Artwork loading shared by Poster, ChannelLogo, the dashboard hero and the
 * detail pages (Run 3 C3 and C5).
 */

import { useCallback, useState } from 'react';

import { imageAttempts, imageFailedRecently, imageWidthBucket, markImageFailed, type ImageAttempt } from '@/api/images';

export interface ImageChain {
  /** The URL to put on the <img> now; undefined once every attempt failed or there is no picture. */
  url: string | undefined;
  /** The source picture `url` stands for (its original URL), e.g. to style a poster used as a backdrop. */
  source: string | undefined;
  /** Every attempt failed (or there was nothing to try): show the fallback. */
  failed: boolean;
  /** Wire to the <img>'s onError: moves on to the next attempt. */
  onError: () => void;
}

/** One picture's attempts, fixed when the picture starts, and the one on screen. */
interface Chain {
  key: string;
  attempts: readonly ImageAttempt[];
  step: number;
}

/** The first attempt at or after `from` that has not failed lately (`attempts.length` when none is left). */
function nextLive(attempts: readonly ImageAttempt[], from: number): number {
  let i = from;
  while (i < attempts.length && imageFailedRecently(attempts[i]!.url)) i++;
  return i;
}

function startChain(
  key: string,
  sources: readonly (string | null | undefined)[],
  sourceId: string | undefined,
  width: number | undefined,
): Chain {
  const attempts = imageAttempts(sources, sourceId, width);
  return { key, attempts, step: nextLive(attempts, 0) };
}

/**
 * Walks the attempts for one picture: the cache URL of each source, then its
 * original URL once, then the cache URL once more, then the next source
 * (`imageAttempts`).
 *
 * - The attempts are fixed when the picture starts. When the desktop cache
 *   base or the cache generation changes later, a picture already on screen
 *   keeps its URL (no remount, no second fade-in); the next picture uses the
 *   new one.
 * - State is keyed by the sources, so a new picture (a virtual row reused for
 *   another item) starts from the top and never inherits the previous one's
 *   failures.
 * - A failed URL is remembered for a few minutes (`markImageFailed`): a row
 *   scrolled out and back in starts at the first attempt that has not failed,
 *   or at the fallback, without asking the cache and the provider again.
 * - `width` (CSS px the picture is drawn at) asks the cache for a resized copy (`imageUrl`); a
 *   width that lands in another size bucket starts the picture again.
 */
export function useImageChain(sources: readonly (string | null | undefined)[], sourceId?: string, width?: number): ImageChain {
  const bucket = imageWidthBucket(width);
  const key = `${sourceId ?? ''}\n${bucket ?? ''}\n${sources.map((s) => s?.trim() ?? '').join('\n')}`;
  const [stored, setStored] = useState<Chain>(() => startChain(key, sources, sourceId, width));
  let chain = stored;
  if (stored.key !== key) {
    // A new picture: start it during this render (React's derived-state pattern), so no frame shows the old one.
    chain = startChain(key, sources, sourceId, width);
    setStored(chain);
  }
  const { step } = chain;
  const current = chain.attempts[step];
  const currentUrl = current?.url;
  const onError = useCallback(() => {
    if (currentUrl) markImageFailed(currentUrl);
    // Functional and keyed: a late error from an attempt already left behind is ignored.
    setStored((prev) => (prev.key === key && prev.step === step ? { ...prev, step: nextLive(prev.attempts, step + 1) } : prev));
  }, [key, step, currentUrl]);
  return { url: currentUrl, source: current?.source, failed: !current, onError };
}

/**
 * Cheap blur for a soft colour field made from artwork (C5): the image is laid
 * out at a quarter of the frame in each direction, centred, blurred by 12 px
 * and scaled up 4.4x (a little past 4x, so the blur's faded rim stays outside
 * the frame). The filter runs over 1/16 of the pixels a full-size blur would,
 * and reads like a 48 px blur. Put it on an <img> inside a positioned,
 * `overflow-hidden` frame. Symmetric, so it needs no RTL variant.
 */
export const QUARTER_BLUR = 'absolute inset-[37.5%] h-1/4 w-1/4 max-w-none scale-[4.4] object-cover blur-md';

/**
 * Runs `cb` once the main thread is idle (requestIdleCallback, at most
 * `timeout` ms later), or after a short delay where idle callbacks are
 * missing (Safari, jsdom). Returns a cancel function for effect cleanups.
 */
export function whenIdle(cb: () => void, timeout = 2000): () => void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => cb(), { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(cb, 200);
  return () => clearTimeout(id);
}
