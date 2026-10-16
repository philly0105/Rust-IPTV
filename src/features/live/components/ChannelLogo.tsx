import { useCallback } from 'react';

import { gateImage, useImageChain } from '@/ui';

function initials(name: string): string {
  const words = name
    .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
    .split(/\s+/)
    .filter(Boolean);
  // Code points, not UTF-16 units: an emoji or astral-plane letter must not split into half a surrogate pair.
  const first = Array.from(words[0] ?? '?');
  const second = Array.from(words[1] ?? '');
  return (second.length > 0 ? `${first[0]}${second[0]}` : first.slice(0, 2).join('')).toUpperCase();
}

/**
 * Channel logo with a lettered fallback; logos sit on a neutral plate so transparent PNGs read in both themes.
 * Remote logos load through the image cache; when the cache route errors the original URL is tried once
 * before the letters show (C3). Pass `sourceId` so the cache applies that source's network rules.
 *
 * `size` is also the width the cache resizes the logo to (L3-serve-ui-4): 36 px fetches a 64 px copy at
 * 1x and 96 px at 2x instead of the provider's full-size image.
 *
 * Cache-route logos start through the fetch gate (src/ui/imageGate.ts, L3-live-ch-x3), as posters do: at
 * most four at once, the ones in view first, none while the page scrolls unless one has stayed in view, and
 * a logo whose row goes is dropped. Rows flung past never ask; a waiting logo shows the plate alone (no
 * letters flashing before it), and a logo already showing stays, since its <img> is kept while the address
 * is the same.
 */
export function ChannelLogo({
  src,
  name,
  size = 36,
  sourceId,
}: {
  src?: string;
  name: string;
  size?: number;
  sourceId?: string;
}) {
  // The chain is keyed by address: virtual rows are reused for other channels, and one broken logo must not
  // stick to the slot and hide the next channel's good one.
  const image = useImageChain([src], sourceId, size);
  const url = image.url;
  // One <img> per address (key below), so this runs once per attempt; React renders no `src`, the gate sets it.
  const imgRef = useCallback((el: HTMLImageElement | null) => (el && url ? gateImage(el, url) : undefined), [url]);
  const style = { width: size, height: size };
  if (!url) {
    return (
      <span
        aria-hidden
        style={style}
        className="inline-flex shrink-0 items-center justify-center rounded-md bg-surface-3 text-[calc(11rem/15)] font-semibold text-fg-muted"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <span aria-hidden style={style} className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2">
      <img
        key={url}
        ref={imgRef}
        alt=""
        loading="lazy"
        decoding="async"
        // Low priority: a screen of logos must not hold the guide's RPCs behind it on the connection pool.
        fetchPriority="low"
        draggable={false}
        onError={image.onError}
        // Waiting (no src yet), the box fills the plate, so the gate sees a row half past the list's
        // edge as in view; otherwise only the plate's centre counts and that row never asks.
        className="max-h-full max-w-full object-contain p-0.5 [&:not([src])]:size-full"
      />
    </span>
  );
}
