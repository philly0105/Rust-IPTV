/**
 * Dashboard hero slides, built from data the dashboard already loads:
 * continue-watching positions first (the most likely next action), then
 * recently added movies and series that have artwork. Pure, so the carousel's
 * choice of slides is testable without rendering.
 */

import { itemKey, type ItemRef, type PlaybackPosition, type SeriesItem, type VodItem } from '@/api/types';
import { snapshotTitle } from '@/lib/title';

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
  /** Continue watching: the resume point itself, which the slide's menu acts on. */
  position?: PlaybackPosition;
}

/** Continue-watching slides at most; the rest of the rotation is new arrivals. */
export const HERO_MAX_CONTINUE = 3;
/** Slides in one rotation. */
export const HERO_MAX_SLIDES = 6;
/** Time each slide stays up while the carousel rotates. */
export const HERO_DWELL_MS = 8000;

function fromPosition(p: PlaybackPosition): HeroSlide {
  const raw = p.snapshot?.title;
  const base = raw ? snapshotTitle(p.ref, raw) : undefined;
  return {
    key: `${itemKey(p.ref)}|${p.episodeId ?? ''}`,
    kind: 'continue',
    ref: p.ref,
    episodeId: p.episodeId,
    // A snapshot saved before the base title existed still carries the provider's year and tags.
    title: base?.title,
    year: base?.year,
    subtitle: p.snapshot?.subtitle,
    posterUrl: p.snapshot?.posterUrl,
    fraction: watchedFraction(p),
    minutesLeft: minutesLeft(p),
    position: p,
  };
}

function fromItem(v: VodItem | SeriesItem): HeroSlide {
  return {
    key: itemKey(v.ref),
    kind: 'new',
    ref: v.ref,
    // The title the detail page shows: no trailing year or provider tag (the year has its own fact).
    title: v.titleBase || v.title,
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

/**
 * True when `title` already ends with `year`, as provider titles often do ("Summer Static (2025)",
 * "Summer Static [2025]", "Summer Static - 2025"), so a facts line need not repeat it.
 */
export function titleEndsWithYear(title: string | undefined, year: number | string | undefined): boolean {
  if (!title || year === undefined || year === '') return false;
  const y = String(year).trim();
  if (!/^\d{4}$/.test(y)) return false;
  const m = /(?:\((\d{4})\)|\[(\d{4})\]|[-–—]\s*(\d{4}))\s*$/.exec(title.trim());
  return !!m && (m[1] ?? m[2] ?? m[3]) === y;
}

/** Index `step` slides away from `index`, wrapping both ways. */
export function wrapIndex(index: number, step: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}
