import { Clapperboard, Radio, Tv } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { cn } from './cn';
import { useImageChain } from './image';
import { pauseWhenOffscreen } from './offscreen';

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

/** Up to two initials for fallback tiles ("BBC One HD" -> "BO"). */
export function initialsOf(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(hd|fhd|uhd|4k|sd|the)$/i.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** A load this soon after the picture mounted came from a cache: it shows at once, without the fade. */
export const INSTANT_REVEAL_MS = 120;

/** URLs that already loaded in this session; a remount (Back, a re-render of a rail) shows them at once. */
const revealed = new Set<string>();
const REVEALED_MAX = 2000;

function rememberRevealed(url: string): void {
  if (revealed.size >= REVEALED_MAX) revealed.clear();
  revealed.add(url);
}

/** Test hook: forget which pictures already loaded. */
export function forgetRevealedPosters(): void {
  revealed.clear();
}

/**
 * Artwork frame with lazy loading, a fade-in reveal, and a designed fallback
 * tile (initials on a per-title tint plus a glyph) when the image is missing
 * or fails.
 *
 * Remote artwork loads through the image cache (`imageUrl`). When the cache
 * route errors, the original URL is tried once, then `fallbackSrc` the same
 * way, and only then the initials tile. The reveal animates opacity only: a
 * blur or scale transition on every card of a grid costs a filter pass per
 * card per frame (C5, src/perf-budget.test.ts). Only a slow network load
 * fades (150 ms): a picture that is already decoded, loaded before in this
 * session, or arrives within {@link INSTANT_REVEAL_MS} of mounting shows at
 * once, so cached artwork never waits on the fade (L2-perf-desktop-9). The
 * placeholder's shimmer stops while the frame is out of view (offscreen.ts).
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
}: PosterProps) {
  const image = useImageChain([src, fallbackSrc], sourceId);
  // Keyed by URL so a new attempt or a new picture never inherits the previous one's state.
  const [loaded, setLoaded] = useState<{ url: string; instant: boolean } | null>(null);
  const url = image.url;
  const state: 'loading' | 'loaded' | 'error' = !url ? 'error' : loaded?.url === url ? 'loaded' : 'loading';
  const instant = state === 'loaded' && loaded!.instant;
  const mountedAt = useRef(0);
  // One element per URL (key below), so this runs once per attempt.
  const imgRef = useCallback(
    (el: HTMLImageElement | null) => {
      if (!el || !url) return;
      mountedAt.current = performance.now();
      // Already decoded (memory cache): show it in this commit, before the first paint.
      if (el.complete && el.naturalWidth > 0) {
        rememberRevealed(url);
        setLoaded({ url, instant: true });
      }
    },
    [url],
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
      {state !== 'loaded' && (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-1',
            state === 'loading' && 'skeleton-surface motion-safe:animate-shimmer',
          )}
          ref={state === 'loading' ? pauseWhenOffscreen : undefined}
          style={
            state === 'error'
              ? {
                  background: `linear-gradient(150deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 50% 18%))`,
                }
              : undefined
          }
        >
          {state === 'error' && (
            <>
              <span
                className={cn(
                  'font-display font-semibold tracking-wide text-white/90',
                  aspect === 'poster' ? 'text-3xl' : 'text-2xl',
                )}
              >
                {initialsOf(fallbackText)}
              </span>
              <Glyph size={16} className="text-white/60" />
            </>
          )}
        </div>
      )}
      {url && (
        <img
          // A new element per attempt: the browser never shows the failed attempt's broken-image box.
          key={url}
          ref={imgRef}
          src={url}
          alt={alt}
          loading={priority || eager ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : undefined}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          data-poster-state={state}
          onLoad={() => {
            const fast = revealed.has(url) || performance.now() - mountedAt.current < INSTANT_REVEAL_MS;
            rememberRevealed(url);
            setLoaded((prev) => (prev?.url === url ? prev : { url, instant: fast }));
          }}
          onError={image.onError}
          className={cn(
            'absolute inset-0 h-full w-full',
            fit === 'cover' ? 'object-cover' : 'object-contain p-[12%]',
            !instant && 'motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-out',
            state === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      {children}
    </div>
  );
}
