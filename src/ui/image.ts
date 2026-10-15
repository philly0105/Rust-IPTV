/**
 * Artwork loading shared by Poster, ChannelLogo, the dashboard hero and the
 * detail pages (Run 3 C3 and C5).
 */

import { useCallback, useMemo, useState } from 'react';

import { imageAttempts } from '@/api/images';

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

/**
 * Walks the attempts for one picture: the cache URL of each source, then its
 * original URL once, then the next source (`imageAttempts`). State is keyed by
 * the attempt list, so a new picture (a virtual row reused for another item)
 * starts from the top and never inherits the previous one's failures.
 */
export function useImageChain(sources: readonly (string | null | undefined)[], sourceId?: string): ImageChain {
  const sourcesKey = sources.map((s) => s ?? '').join('\n');
  const attempts = useMemo(() => imageAttempts(sourcesKey.split('\n'), sourceId), [sourcesKey, sourceId]);
  const listKey = `${sourceId ?? ''}\n${attempts.map((a) => a.url).join('\n')}`;
  const [state, setState] = useState<{ key: string; step: number }>({ key: listKey, step: 0 });
  const step = state.key === listKey ? state.step : 0;
  const current = attempts[step];
  const onError = useCallback(() => {
    // Functional and keyed: a late error from an attempt already left behind is ignored.
    setState((prev) => {
      const at = prev.key === listKey ? prev.step : 0;
      return at === step ? { key: listKey, step: step + 1 } : prev;
    });
  }, [listKey, step]);
  return { url: current?.url, source: current?.source, failed: !current, onError };
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
