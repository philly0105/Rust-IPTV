import { memo, useCallback, useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';

import { TINT_THEME, cn, gateImage, tintVars, useImageChain } from '@/ui';

import { channelNameParts } from '../lib/channelName';
import { monogramHue, monogramText, slotNumber } from '../lib/monogram';

export type LogoPlate = 'light' | 'dark';

/** What a logo's pixels say: the plate it needs and its colour's hue (null: none to read). */
export interface LogoReading {
  plate: LogoPlate | null;
  hue: number | null;
}

/** Reading per logo address, measured once per session (see {@link measureLogo}). */
const readings = new Map<string, LogoReading>();
const UNREAD: LogoReading = { plate: null, hue: null };
let probe: CanvasRenderingContext2D | null | undefined;

/** Hue in degrees of an RGB colour (0 to 255 per channel); its chroma must not be 0. */
function hueOfRgb(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return Math.round((h * 60 + 360) % 360);
}

/**
 * Reads a logo from a 16 px copy of the loaded image (an unreadable one, such as a cross-origin
 * fallback, reads as {@link UNREAD}):
 * - `plate`: which plate a transparent logo needs, a light one for dark ink (a black wordmark
 *   vanishes on the dark plate), the dark one otherwise; null for an opaque logo, which brings its
 *   own background.
 * - `hue`: the hue of its coloured pixels, weighted by how coloured each is; null when under a
 *   sixth of the logo is coloured (a grey, black or white wordmark).
 */
export function measureLogo(img: HTMLImageElement): LogoReading {
  if (probe === undefined) {
    try {
      probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe || !img.naturalWidth) return UNREAD;
  try {
    probe.clearRect(0, 0, 16, 16);
    probe.drawImage(img, 0, 0, 16, 16);
    const d = probe.getImageData(0, 0, 16, 16).data;
    let clear = 0;
    let ink = 0;
    let n = 0;
    let coloured = 0;
    let weight = 0;
    let wr = 0;
    let wg = 0;
    let wb = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 128) {
        clear++;
        continue;
      }
      const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
      ink += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      n++;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 40) {
        coloured++;
        weight += chroma;
        wr += r * chroma;
        wg += g * chroma;
        wb += b * chroma;
      }
    }
    // Under a tenth see-through: the logo fills its own box, the plate hardly shows.
    const plate = n === 0 || clear < 26 ? null : ink / n < 0.32 ? 'light' : 'dark';
    const [r, g, b] = [wr / weight, wg / weight, wb / weight];
    const hue = weight > 0 && coloured * 6 >= n && Math.max(r, g, b) > Math.min(r, g, b) ? hueOfRgb(r, g, b) : null;
    return { plate, hue };
  } catch {
    return UNREAD; // tainted by a cross-origin image
  }
}

/** A monogram tile's look: the name's two letters on its tint. */
const MONOGRAM = 'inline-flex shrink-0 items-center justify-center font-display leading-none font-semibold tracking-tight';

function monogramStyle(name: string, size: number) {
  return { ...tintVars(name), fontSize: Math.max(9, Math.round(size * 0.36)) };
}

/**
 * Channel logo on a plate that stays the same in every theme, with a coloured monogram when there
 * is no logo (LG-14), in the channel's tint (src/ui/tint.ts): pale in the light theme, like a light
 * plate, so a list of them is not a column of dark slabs on the pale page. The plate is dark (a deep slate, so white and coloured logos read), or light
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
 * most `maxActive()` at once (4 in server mode, 6 on desktop), the ones in view first, none while the page
 * scrolls unless one has stayed in view, and a logo whose row goes is dropped. Rows flung past never ask; a
 * waiting logo shows the monogram, and the logo fades in over it once it loads (an empty plate sat there
 * for seconds while a dead logo went through every attempt, and in light it was a dark square on the pale
 * list). A logo already showing stays, since its <img> is kept while the address is the same, and one
 * this session has loaded before shows at once.
 *
 * Memoized (P2-LIVE-3): a channel row renders again when the guide's now/next lands, and its logo
 * rendered again with it.
 */
export const ChannelLogo = memo(function ChannelLogo({
  src,
  name,
  size = 36,
  sourceId,
  className,
  fallback,
  onHue,
}: {
  src?: string;
  name: string;
  size?: number;
  sourceId?: string;
  className?: string;
  /** Drawn instead of the monogram when there is no logo to show (none, or none that loads). */
  fallback?: ReactNode;
  /**
   * Told the hue of what the tile shows: the monogram's, or the loaded logo's (null while it
   * loads, or when it has no colour to read). The idle stage tints its glow with it.
   */
  onHue?(hue: number | null): void;
}) {
  // The chain is keyed by address: virtual rows are reused for other channels, and one broken logo must not
  // stick to the slot and hide the next channel's good one.
  const image = useImageChain([src], sourceId, size);
  const url = image.url;
  // One <img> per address (key below), so this runs once per attempt; React renders no `src`, the gate sets it.
  const imgRef = useCallback((el: HTMLImageElement | null) => (el && url ? gateImage(el, url) : undefined), [url]);
  const [, setMeasured] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const plate = url ? readings.get(url)?.plate : undefined;
  // Not loaded yet, here or by another tile this session: the monogram shows under the hidden <img>.
  const waiting = url !== undefined && loadedUrl !== url && !readings.has(url);
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    if (!url) return;
    let reading = readings.get(url);
    if (!reading) {
      reading = measureLogo(e.currentTarget);
      readings.set(url, reading);
    }
    if (waiting) setLoadedUrl(url);
    // Also when another tile of this address measured it after this one rendered: memoized, this
    // tile gets no parent render to pick up the plate (P2-LIVE-6).
    else if (reading.plate !== (plate ?? null)) setMeasured((n) => n + 1);
    onHue?.(reading.hue);
  };
  // The monogram's hue is known from the name; a logo's once it has loaded (onLoad, or an
  // earlier load of the same address).
  useEffect(() => {
    onHue?.(url ? (readings.get(url)?.hue ?? null) : monogramHue(name));
  }, [url, name, onHue]);
  // Rounded to the tile: large tiles (the idle stage, the archive header) round more.
  const radius = size >= 56 ? 'rounded-lg' : size >= 28 ? 'rounded-md' : 'rounded-sm';
  const style = { width: size, height: size };
  if (!url) {
    if (fallback !== undefined) return fallback;
    const slot = slotNumber(name);
    if (slot !== null) {
      // An empty event slot: its number on a neutral plate, not letters in a colour of its own.
      return (
        <span
          aria-hidden
          data-monogram=""
          data-slot=""
          style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.36)) }}
          className={cn('inline-flex shrink-0 items-center justify-center bg-surface-2 font-numeric leading-none text-fg-subtle ring-1 ring-edge ring-inset', radius, className)}
        >
          {slot || '–'}
        </span>
      );
    }
    return (
      <span aria-hidden data-monogram="" style={{ ...style, ...monogramStyle(name, size) }} className={cn(MONOGRAM, TINT_THEME, radius, className)}>
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
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-inset',
        // Plates chosen by the logo's own colours, not the theme (tokens.css --color-logo-plate*).
        plate === 'light' ? 'bg-(--color-logo-plate) ring-black/5' : 'bg-(--color-logo-plate-dark) ring-white/6',
        radius,
        className,
      )}
    >
      {/* With a `fallback` (a name instead of letters), the tint alone. */}
      {waiting ? (
        <span data-monogram={fallback === undefined ? '' : undefined} style={monogramStyle(name, size)} className={cn('absolute inset-0', MONOGRAM, TINT_THEME)}>
          {fallback === undefined ? monogramText(name) : null}
        </span>
      ) : null}
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
        className={cn(
          'max-h-full max-w-full object-contain p-[8%] [&:not([src])]:size-full motion-safe:transition-opacity motion-safe:duration-150',
          waiting && 'opacity-0',
        )}
      />
    </span>
  );
});

/*
 * ChannelName shares this module with ChannelLogo, and so its chunk: every screen that names a
 * channel draws its logo beside it. In a module of its own it made a chunk under 4 kB, which the
 * build's small-chunk merge put in a player chunk that imports the controls. Favorites, Recently
 * watched and Downloads then loaded the player's controls before their first render, and so did
 * Search once the merge shifted again (pnpm size:check caught that one).
 */

export interface ChannelNameProps {
  /** The provider's name as it is ("US| ESPN HD"). */
  name: string | null | undefined;
  /** `settings.stripCountryPrefix`: the tag is left out altogether. */
  strip?: boolean | undefined;
  /**
   * The group the list is open on: a leading "PRIME: " the group's name also has is left out
   * (`channelNameParts`). Only where the header names the group.
   */
  group?: string | undefined;
  /** The name's span: size, weight, colour and `truncate`, as the plain text had them. */
  className?: string | undefined;
  /** The tag's tone where the theme's quiet text does not apply (glass on the dark stage). */
  tagClassName?: string | undefined;
  title?: string | undefined;
  testId?: string | undefined;
  /** Up to two lines instead of one (the guide's channel column, whose row has room for them). */
  twoLines?: boolean | undefined;
}

/**
 * A channel's name with the provider's place tag after it, quiet: "ESPN HD US" for "US| ESPN HD".
 * The tag led every name in the same weight, so "US|" was the most repeated string on screen and a
 * narrow column cut "US| ESPN..." before it reached what tells ESPN2 from ESPNU. After the name, in
 * the caption size and the subtle tone, the tag is what a narrow column drops first, whole and
 * without an ellipsis, so an ellipsis always means the name itself is cut.
 *
 * A feed's quality and copy words at the end ("HD (BACKUP 2)", "ᴿᴬᵂ ⁶⁰ᶠᵖˢ") stay whole too, and the
 * station's name is cut before them: providers list one station as several feeds that differ only
 * there, and cutting the end drew them as identical rows.
 *
 * Only a place's code moves (`splitPlaceTag`): "NBA: Lakers vs Celtics" and "Sky Sports | Main
 * Event" are drawn as the provider wrote them. Screen readers get the provider's name as it is (the
 * drawn parts are hidden), which matches the row's accessible name, search and menus. With the
 * strip setting on, the tag is gone as before. Callers truncate through `className`. The station's
 * name has `dir="auto"`, which puts an RTL name's ellipsis at its own end, while the parts keep the
 * page's order, so an Arabic name's tag sits where every other row has it.
 */
/**
 * The feed's quality words: whole, after the station's name in the page's direction. They lead with
 * the space between them and the name, kept (`whitespace-pre`), so the gap sits on their side
 * whatever the name's own direction, and the drawn text reads as the name did.
 */
const VARIANT = 'shrink-0 whitespace-pre';

export function ChannelName({ name, strip, group, className, tagClassName, title, testId, twoLines }: ChannelNameProps) {
  const parts = channelNameParts(name, strip, group);
  if (!parts.tag && !parts.variant && parts.name === parts.full) {
    return (
      <span dir="auto" className={cn(className, twoLines && 'line-clamp-2 break-words text-balance')} title={title} data-testid={testId}>
        {parts.full}
      </span>
    );
  }
  const tag = parts.tag ? (
    <span
      className={cn(!twoLines && 'ms-1.5 whitespace-nowrap', 'text-caption font-medium tracking-wide text-fg-subtle', tagClassName)}
      data-testid="channel-name-tag"
      dir={twoLines ? 'auto' : undefined}
    >
      {parts.tag}
    </span>
  ) : null;
  if (twoLines) {
    return (
      <span className={className} title={title} data-testid={testId}>
        {/* Two lines, as running text: the station wraps onto the second line rather than being
            cut on the first, and its quality words and tag follow it, kept together so neither is
            left alone on a line. The space before them is an ordinary one, so a wrapped tail
            starts flush. Balanced, so "SKY SPORTS / ACTION HD US" rather than a full first line
            and a short tail. Each part is isolated, so they keep the page's order, as the one-line
            form's flex row does ("US HD" to the left of an Arabic page's name). */}
        <span aria-hidden className="line-clamp-2 break-words text-balance">
          <span dir="auto">{parts.name}</span>
          {parts.variant || tag ? ' ' : null}
          {parts.variant || tag ? (
            <span className="whitespace-nowrap">
              {parts.variant ? <bdi>{parts.variant}</bdi> : null}
              {parts.variant && tag ? ' ' : null}
              {tag}
            </span>
          ) : null}
        </span>
        <span className="sr-only">{parts.full}</span>
      </span>
    );
  }
  return (
    <span className={className} title={title} data-testid={testId}>
      {/* One line tall: a tag that does not fit beside the name wraps to a second line, out of
          sight, so it goes whole (a clipped "U" read as part of the name). The name never shrinks
          below its own width (up to the whole line), so its ellipsis means it is cut; shrinking
          the tag first by flex-shrink weights also took a fraction of a pixel from the name, and
          that was enough to draw an ellipsis on a complete one. Within the name, the station's
          words give way and the feed's quality words stay. */}
      <span aria-hidden className="flex h-[1lh] min-w-0 flex-wrap items-baseline overflow-hidden">
        <span className="flex max-w-full min-w-0 shrink-0">
          <span dir="auto" className="min-w-0 truncate">
            {parts.name}
          </span>
          {parts.variant ? <span className={VARIANT}>{` ${parts.variant}`}</span> : null}
        </span>
        {tag}
      </span>
      <span className="sr-only">{parts.full}</span>
    </span>
  );
}
