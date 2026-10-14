/**
 * Dashboard hero slides, built from data the dashboard already loads:
 * continue-watching positions first (the most likely next action), then
 * recently added movies and series that have artwork. Pure, so the carousel's
 * choice of slides is testable without rendering.
 */

import { itemKey, type ItemRef, type PlaybackPosition, type SeriesItem, type VodItem } from '@/api/types';

import { minutesLeft, watchedFraction } from './progress';

export type HeroSlideKind = 'continue' | 'new';

export interface HeroSlide {
  /** Stable React key (item plus episode). */
  key: string;
  kind: HeroSlideKind;
  ref: ItemRef;
  episodeId?: string;
  title?: string;
  /** Continue watching: the snapshot subtitle (episode name, channel). */
  subtitle?: string;
  posterUrl?: string;
  backdropUrl?: string;
  plot?: string;
  year?: number;
  rating?: number;
  genres?: string[];
  /** Continue watching: share watched (0..1) and whole minutes left, when the duration is known. */
  fraction?: number;
  minutesLeft?: number;
}

/** Continue-watching slides at most; the rest of the rotation is new arrivals. */
export const HERO_MAX_CONTINUE = 3;
/** Slides in one rotation. */
export const HERO_MAX_SLIDES = 6;
/** Time each slide stays up while the carousel rotates. */
export const HERO_DWELL_MS = 8000;

function fromPosition(p: PlaybackPosition): HeroSlide {
  return {
    key: `${itemKey(p.ref)}|${p.episodeId ?? ''}`,
    kind: 'continue',
    ref: p.ref,
    episodeId: p.episodeId,
    title: p.snapshot?.title,
    subtitle: p.snapshot?.subtitle,
    posterUrl: p.snapshot?.posterUrl,
    fraction: watchedFraction(p),
    minutesLeft: minutesLeft(p),
  };
}

function fromItem(v: VodItem | SeriesItem): HeroSlide {
  return {
    key: itemKey(v.ref),
    kind: 'new',
    ref: v.ref,
    title: v.title,
    posterUrl: v.posterUrl,
    backdropUrl: v.backdropUrl,
    plot: v.plot,
    year: v.year,
    rating: v.rating,
    genres: v.genres,
  };
}

/**
 * Up to {@link HERO_MAX_CONTINUE} continue-watching entries, then recently
 * added titles with artwork (those with a backdrop first, newest first within
 * each group), skipping anything already shown, up to {@link HERO_MAX_SLIDES}.
 */
export function buildHeroSlides(
  continueWatching: readonly PlaybackPosition[],
  recentlyAdded: readonly (VodItem | SeriesItem)[],
  max = HERO_MAX_SLIDES,
): HeroSlide[] {
  const slides = continueWatching.slice(0, Math.min(HERO_MAX_CONTINUE, max)).map(fromPosition);
  const seen = new Set(slides.map((s) => itemKey(s.ref)));
  const withArt = recentlyAdded.filter((v) => !seen.has(itemKey(v.ref)) && (v.backdropUrl || v.posterUrl));
  const ranked = [...withArt.filter((v) => v.backdropUrl), ...withArt.filter((v) => !v.backdropUrl)];
  for (const v of ranked) {
    if (slides.length >= max) break;
    const key = itemKey(v.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    slides.push(fromItem(v));
  }
  return slides;
}

/** Index `step` slides away from `index`, wrapping both ways. */
export function wrapIndex(index: number, step: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}
