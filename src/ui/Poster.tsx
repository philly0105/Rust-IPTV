import { Clapperboard, Radio, Tv } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';

import { sizedImageUrl } from '@/api/images';

import { cn } from './cn';
import { useImageChain } from './image';
import { gateImage, imageLoadedBefore, noteImageLoaded, resetImageGate } from './imageGate';
import { pauseWhenOffscreen, releaseOffscreen } from './offscreen';

export type PosterAspect = 'poster' | 'wide' | 'square';

export interface PosterProps {
  src?: string | null;
  alt: string;
  /**
   * Text for the fallback tile (initials and tint). Defaults to `alt`; pass the
   * title here when `alt` is "" because a caption already names the item.
   */
  label?: string;
  aspect?: PosterAspect;
  className?: string;
  /** Fallback glyph kind when there is no image. */
  kind?: 'movie' | 'live' | 'radio';
  /** Overlay content (badges, progress) positioned inside the frame. */
  children?: ReactNode;
  /** `contain` for channel logos, `cover` (default) for artwork. */
  fit?: 'cover' | 'contain';
  /** Load immediately (above the fold). */
  eager?: boolean;
  /**
   * The picture the user is looking at first (the visible hero slide, a detail
   * page's poster): `loading="eager"` and `fetchPriority="high"`.
   */
  priority?: boolean;
  /** The source the artwork belongs to, so the image cache can apply that source's network rules. */
  sourceId?: string;
  /**
   * CSS px the picture is drawn at, for the cache's resized copy. Without it the width comes from
   * {@link PosterWidthContext} or {@link PosterCellWidthContext}, or else the frame is measured when
   * the picture mounts; a `priority` picture (a detail hero) loads full size.
   */
  width?: number;
  /**
   * A second picture to try when `src` fails both through the cache and
   * directly (the TMDB poster behind a broken provider poster).
   */
  fallbackSrc?: string | null;
  rounded?: 'sm' | 'md' | 'lg';
}

const ASPECTS: Record<PosterAspect, string> = {
  poster: 'aspect-[2/3]',
  wide: 'aspect-video',
  square: 'aspect-square',
};

/** Deterministic hue from a string, so fallback tiles differ per title. */
export function hueOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Quality, codec and copy markers, and "the": never what a name's initials stand for. */
const NAME_MARKERS = /^(?:sd|hd|fhd|uhd|qhd|4k|8k|hevc|hdr|raw|\d{3,4}[pi]|\d+fps|backup|bkp|the)$/i;

/**
 * The words a name's initials come from: compatibility-folded ("ᴴᴰ" is "HD"), with the punctuation
 * around each word trimmed ("(Backup)" is "Backup") and the markers above dropped, unless the name
 * is nothing but markers. Shared with Live's channel monograms (live/lib/monogram.ts).
 */
export function initialWords(text: string): string[] {
  const words = text
    .normalize('NFKC')
    .split(/\s+/)
    // Punctuation only: an emoji (a symbol) stays an initial, as in "🎵 Music".
    .map((w) => w.replace(/^\p{P}+|\p{P}+$/gu, ''))
    .filter(Boolean);
  const named = words.filter((w) => !NAME_MARKERS.test(w));
  return named.length > 0 ? named : words;
}

/** Two letters from `words`, by code point: the first of each of the first two words, or one word's first two letters or digits. */
export function twoInitials(words: readonly string[]): string {
  if (words.length === 0) return '?';
  if (words.length === 1) return Array.from(words[0]!.replace(/[^\p{L}\p{N}]/gu, '') || words[0]!).slice(0, 2).join('').toUpperCase();
  return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}

/** A provider's country or group tag before a name ("US| ", "UK: ", "[DE] "), which no initial should come from. */
const NAME_TAG = /^(?:\[[A-Z0-9+-]{2,8}\]|[A-Z]{2,3}\s*[|:])\s*/;

/** Up to two initials for fallback tiles ("BBC One HD" -> "BO", "US| ESPN HD" -> "ES", "US| CBS (Backup)" -> "CB"). */
export function initialsOf(text: string): string {
  const trimmed = text.trim();
  const untagged = trimmed.replace(NAME_TAG, '');
  return twoInitials(initialWords(untagged || trimmed));
}

/**
 * The CSS width of the cards below, from a rail that sizes its cards itself (DashboardRail,
 * PosterRail). A Poster without `width` uses it instead of reading its frame's `clientWidth` on
 * mount, which forced a layout per card when the artwork was already cached (performance audit
 * SH-6). Only for pictures that fill the card's width.
 */
export const PosterWidthContext = createContext<number | undefined>(undefined);

/**
 * The column width of a grid whose posters fill their cells (VirtualGrid's `postersFillCells`),
 * rounded as the frame's `clientWidth` is. A Poster with neither `width` nor
 * {@link PosterWidthContext} sizes its picture to it instead of reading `clientWidth` as it
 * mounts: read between the cells' DOM writes, that forced a layout per poster, 599 ms of a 30-step
 * fling of the movie grid (P2-GRID-1). Like the measured width it is taken once per picture, when
 * the picture mounts, so a window resize does not start the pictures on screen again. The grid
 * keeps the width in a box that keeps its identity, so a resize does not re-render the posters
 * either.
 */
export const PosterCellWidthContext = createContext<{ readonly current: number } | undefined>(undefined);

/**
 * A {@link PosterCellWidthContext} box holding `px`, for pictures in a box whose width is known
 * (P2-POSTERS-6). Like the measured width, each picture takes it as it mounts and keeps it: a new
 * width (UI scale, density, a breakpoint) starts no picture on screen again, where a changed
 * `width` loads every picture again, and a picture mounted later loads at the new width.
 */
export function usePosterWidthBox(px: number): { readonly current: number } {
  const box = useRef(px);
  box.current = px;
  return box;
}

/** A load this soon after the picture mounted came from a cache: it shows at once, without the fade. */
export const INSTANT_REVEAL_MS = 120;

/** Test hook: forget which pictures already loaded (imageGate.ts keeps the list). */
export function forgetRevealedPosters(): void {
  resetImageGate();
}

/**
 * Shows a loaded picture. Written on the DOM, not kept in React state, so an image arriving
 * re-renders nothing (L3-perf-ui-7: a fast scroll of the movie grid made 486 Poster commits).
 * CSS keys the fade off the attributes; the placeholder before the <img> is hidden and stops
 * being watched for visibility.
 */
function reveal(img: HTMLImageElement, url: string, instant: boolean): void {
  if (img.dataset['posterState'] === 'loaded') return;
  noteImageLoaded(url);
  // Set first, so the opacity change below never runs the transition.
  if (instant) img.dataset['instant'] = '';
  img.dataset['posterState'] = 'loaded';
  const ph = img.previousElementSibling;
  if (ph instanceof HTMLElement && ph.dataset['posterPlaceholder'] !== undefined) {
    ph.hidden = true;
    releaseOffscreen(ph);
  }
}

/**
 * Artwork frame with lazy loading, a fade-in reveal, and a designed fallback
 * tile (initials on a per-title tint plus a glyph) when the image is missing
 * or fails.
 *
 * Remote artwork loads through the image cache (`imageUrl`). When the cache
 * route errors, the original URL is tried once and then the cache once more,
 * then `fallbackSrc` the same way, and only then the initials tile. The
 * reveal animates opacity only: a blur or scale transition on every card of a
 * grid costs a filter pass per card per frame (C5, src/perf-budget.test.ts).
 * Only a slow network load fades (150 ms): a picture that is already decoded,
 * loaded before in this session, or arrives within {@link INSTANT_REVEAL_MS}
 * of mounting shows at once, so cached artwork never waits on the fade
 * (L2-perf-desktop-9). The placeholder's shimmer stops while the frame is out
 * of view (offscreen.ts).
 * Cache-route pictures start through the fetch gate (imageGate.ts), which in
 * server mode keeps connections free for RPCs, and skips rows that only fly
 * past in a fast scroll.
 */
export function Poster({
  src,
  alt,
  label,
  aspect = 'poster',
  className,
  kind = 'movie',
  children,
  fit = 'cover',
  eager,
  priority,
  sourceId,
  fallbackSrc,
  rounded = 'md',
  width,
}: PosterProps) {
  const railWidth = useContext(PosterWidthContext);
  const cellWidth = useContext(PosterCellWidthContext);
  const drawnWidth = width ?? (priority ? undefined : railWidth);
  const image = useImageChain([src, fallbackSrc], sourceId, drawnWidth);
  const url = image.url;
  // One element per URL (key below), so this runs once per attempt. React renders no `src`:
  // the gate sets it when the picture may start, and holds it while the page scrolls.
  const imgRef = useCallback(
    (el: HTMLImageElement | null) => {
      if (!el || !url) return;
      // A card's width comes from its grid or rail, so the cache sends a copy that size
      // (L3-serve-ui-1): a grid's column width, else the frame is measured once it is in the page
      // (the <img> fills it).
      const sized = priority || drawnWidth !== undefined ? url : sizedImageUrl(url, cellWidth?.current ?? el.clientWidth);
      const mountedAt = performance.now();
      const before = imageLoadedBefore(sized);
      const onLoad = () => reveal(el, sized, before || performance.now() - mountedAt < INSTANT_REVEAL_MS);
      el.addEventListener('load', onLoad);
      const cancel = gateImage(el, sized, priority || eager);
      // Already decoded (memory cache): shown before the first paint.
      if (el.complete && el.naturalWidth > 0) reveal(el, sized, true);
      return () => {
        el.removeEventListener('load', onLoad);
        cancel();
      };
    },
    [url, priority, eager, drawnWidth, cellWidth],
  );

  const fallbackText = label ?? alt;
  const hue = hueOf(fallbackText);
  const Glyph = kind === 'live' ? Tv : kind === 'radio' ? Radio : Clapperboard;
  const radius = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg' }[rounded];

  return (
    <div
      className={cn(
        'relative w-full overflow-hidden bg-surface-2',
        // Inner hairline: keeps dark artwork from melting into OLED-black and ink surfaces.
        'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-fg/8',
        ASPECTS[aspect],
        radius,
        className,
      )}
    >
      {url ? (
        // Keyed with the <img>: each attempt starts with a shimmering placeholder, which reveal() hides.
        <div
          key={`placeholder:${url}`}
          aria-hidden
          data-poster-placeholder=""
          className="skeleton-surface absolute inset-0 motion-safe:animate-shimmer"
          ref={pauseWhenOffscreen}
        />
      ) : (
        // A size container: the letters and glyph scale with the tile's shorter side, so a 36 px row
        // thumbnail fits "WM" and its glyph; from about 70 px up they keep the full text-3xl / text-2xl.
        <div
          aria-hidden
          data-poster-fallback=""
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 [container-type:size]"
          style={{ background: `linear-gradient(150deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 50% 18%))` }}
        >
          <span
            className={cn(
              'font-display font-semibold tracking-wide text-white/90',
              // text-3xl / text-2xl, with their line heights, capped by the tile.
              aspect === 'poster' ? 'text-[length:min(1.875rem,40cqmin)] leading-[1.2]' : 'text-[length:min(1.5rem,40cqmin)] leading-[calc(4/3)]',
            )}
          >
            {initialsOf(fallbackText)}
          </span>
          <Glyph size={16} className="size-[min(16px,30cqmin)] shrink-0 text-white/60" />
        </div>
      )}
      {url && (
        <img
          // A new element per attempt: the browser never shows the failed attempt's broken-image box.
          key={url}
          ref={imgRef}
          alt={alt}
          loading={priority || eager ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : undefined}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          // Rendered once and never changed by React; reveal() writes 'loaded' on the element.
          data-poster-state="loading"
          onError={image.onError}
          className={cn(
            'absolute inset-0 h-full w-full opacity-0 data-[poster-state=loaded]:opacity-100',
            fit === 'cover' ? 'object-cover' : 'object-contain p-[12%]',
            // Only a slow network load fades; reveal() marks a fast one data-instant first.
            'motion-safe:not-data-instant:transition-opacity motion-safe:not-data-instant:duration-150 motion-safe:not-data-instant:ease-out',
          )}
        />
      )}
      {children}
    </div>
  );
}
