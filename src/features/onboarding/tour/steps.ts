/**
 * The three tour steps (contract C7). Each points at a `[data-tour="<id>"]`
 * anchor that the shell puts on the Rail items and the search button; when
 * the anchor is missing or not on screen (phone layout, a collapsed source),
 * the step shows as a centred card instead.
 *
 * The `vod` anchor is the rail's My List entry, the one movie and series
 * entry on screen at every width (a source's Movies and Series links only
 * show while that source is expanded). The step's title, text and icon name
 * My List so the card matches what the spotlight shows.
 */

import { Bookmark, Search, Tv, type LucideIcon } from 'lucide-react';

export type TourAnchor = 'live' | 'vod' | 'search';

export interface TourStep {
  anchor: TourAnchor;
  icon: LucideIcon;
  /** Keys in `onboarding.json`. */
  titleKey: string;
  textKey: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { anchor: 'live', icon: Tv, titleKey: 'tourLiveTitle', textKey: 'tourLiveText' },
  { anchor: 'vod', icon: Bookmark, titleKey: 'tourVodTitle', textKey: 'tourVodText' },
  { anchor: 'search', icon: Search, titleKey: 'tourSearchTitle', textKey: 'tourSearchText' },
];

/**
 * The tour that opens by itself after the first source is added (SS-6): one coach mark on search
 * and the command palette, the two things the screen does not show on its own. The new source's
 * page is already on screen behind it; the full tour stays one press away on the card.
 */
export const COACH_STEPS: readonly TourStep[] = [{ anchor: 'search', icon: Search, titleKey: 'tourCoachTitle', textKey: 'tourCoachText' }];

/** CSS selector of a step's anchor. */
export function anchorSelector(anchor: TourAnchor): string {
  return `[data-tour="${anchor}"]`;
}

/**
 * The anchor to point at: the first element with the attribute that is laid
 * out and inside the window, else the first laid-out one (a rail scrolled
 * out of view; the tour scrolls it in), else null. Several elements may carry
 * the attribute (one per source, or a desktop and a phone variant); hidden
 * ones have an empty rect.
 */
export function findAnchor(anchor: TourAnchor, root: ParentNode = document): HTMLElement | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let fallback: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(anchorSelector(anchor))) {
    if (el.closest('[inert], [aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh) return el;
    fallback ??= el;
  }
  return fallback;
}
