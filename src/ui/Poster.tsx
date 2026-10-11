import { Clapperboard, Radio, Tv } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { cn } from './cn';

export type PosterAspect = 'poster' | 'wide' | 'square';

export interface PosterProps {
  src?: string | null;
  alt: string;
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

/**
 * Artwork frame with lazy loading, a blurred-in reveal, and a designed
 * fallback tile (initials on a per-title tint plus a glyph) when the image is
 * missing or fails.
 */
export function Poster({
  src,
  alt,
  aspect = 'poster',
  className,
  kind = 'movie',
  children,
  fit = 'cover',
  eager,
  rounded = 'md',
}: PosterProps) {
  // Keyed by src so a src change never inherits the previous image's state.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const state: 'loading' | 'loaded' | 'error' =
    !src || failedSrc === src ? 'error' : loadedSrc === src ? 'loaded' : 'loading';

  const hue = hueOf(alt);
  const Glyph = kind === 'live' ? Tv : kind === 'radio' ? Radio : Clapperboard;
  const radius = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg' }[rounded];

  return (
    <div className={cn('relative w-full overflow-hidden bg-surface-2', ASPECTS[aspect], radius, className)}>
      {state !== 'loaded' && (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-1',
            state === 'loading' && 'skeleton-surface motion-safe:animate-shimmer',
          )}
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
                {initialsOf(alt)}
              </span>
              <Glyph size={16} className="text-white/60" />
            </>
          )}
        </div>
      )}
      {src && state !== 'error' && (
        <img
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
          className={cn(
            'absolute inset-0 h-full w-full',
            fit === 'cover' ? 'object-cover' : 'object-contain p-[12%]',
            'motion-safe:transition-[opacity,filter,transform] motion-safe:duration-500',
            state === 'loaded' ? 'scale-100 opacity-100 blur-0' : 'scale-105 opacity-0 blur-md',
          )}
        />
      )}
      {children}
    </div>
  );
}
