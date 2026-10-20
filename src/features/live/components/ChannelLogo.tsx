import { useCallback, useState, type SyntheticEvent } from 'react';

import { cn, gateImage, useImageChain } from '@/ui';

import { monogramFill, monogramText } from '../lib/monogram';

export type LogoPlate = 'light' | 'dark';

/** Plate per logo address, measured once per session (see {@link measurePlate}). */
const plates = new Map<string, LogoPlate | null>();
let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Which plate a transparent logo needs: a light one for dark ink (a black wordmark vanishes on the
 * dark plate), the dark one otherwise. Read from a 16 px copy of the loaded image; null for an opaque
 * logo (it brings its own background) or one the canvas may not read (a cross-origin fallback).
 */
export function measurePlate(img: HTMLImageElement): LogoPlate | null {
  if (probe === undefined) {
    try {
      probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe || !img.naturalWidth) return null;
  try {
    probe.clearRect(0, 0, 16, 16);
    probe.drawImage(img, 0, 0, 16, 16);
    const d = probe.getImageData(0, 0, 16, 16).data;
    let clear = 0;
    let ink = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 128) {
        clear++;
        continue;
      }
      ink += (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
      n++;
    }
    // Under a tenth see-through: the logo fills its own box, the plate hardly shows.
    if (n === 0 || clear < 26) return null;
    return ink / n < 0.32 ? 'light' : 'dark';
  } catch {
    return null; // tainted by a cross-origin image
  }
}

/**
 * Channel logo on a plate that stays the same in every theme, with a coloured monogram when there
 * is no logo (LG-14). The plate is dark (a deep slate, so white and coloured logos read), or light
 * for a transparent logo drawn in dark ink, chosen once per logo from its pixels. A theme-coloured
 * plate lost dark logos in the dark themes and white ones in light.
 *
 * Remote logos load through the image cache; when the cache route errors the original URL is tried once
 * before the monogram shows (C3). Pass `sourceId` so the cache applies that source's network rules.
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
  className,
}: {
  src?: string;
  name: string;
  size?: number;
  sourceId?: string;
  className?: string;
}) {
  // The chain is keyed by address: virtual rows are reused for other channels, and one broken logo must not
  // stick to the slot and hide the next channel's good one.
  const image = useImageChain([src], sourceId, size);
  const url = image.url;
  // One <img> per address (key below), so this runs once per attempt; React renders no `src`, the gate sets it.
  const imgRef = useCallback((el: HTMLImageElement | null) => (el && url ? gateImage(el, url) : undefined), [url]);
  const [, setMeasured] = useState(0);
  const plate = url ? plates.get(url) : undefined;
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    if (!url || plates.has(url)) return;
    plates.set(url, measurePlate(e.currentTarget));
    if (plates.get(url)) setMeasured((n) => n + 1);
  };
  // Rounded to the tile: large tiles (the idle stage, the archive header) round more.
  const radius = size >= 56 ? 'rounded-lg' : size >= 28 ? 'rounded-md' : 'rounded-sm';
  const style = { width: size, height: size };
  if (!url) {
    return (
      <span
        aria-hidden
        data-monogram=""
        style={{ ...style, background: monogramFill(name), fontSize: Math.max(9, Math.round(size * 0.36)) }}
        className={cn('inline-flex shrink-0 items-center justify-center font-display leading-none font-semibold tracking-tight text-white', radius, className)}
      >
        {monogramText(name)}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={style}
      data-plate={plate ?? 'dark'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-inset',
        // Fixed plates, not theme surfaces: the logo's own colours decide what it needs.
        plate === 'light' ? 'bg-[#eef1f5] ring-black/5' : 'bg-[#161d2a] ring-white/6',
        radius,
        className,
      )}
    >
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
        onLoad={onLoad}
        // Waiting (no src yet), the box fills the plate, so the gate sees a row half past the list's
        // edge as in view; otherwise only the plate's centre counts and that row never asks.
        className="max-h-full max-w-full object-contain p-[8%] [&:not([src])]:size-full"
      />
    </span>
  );
}
