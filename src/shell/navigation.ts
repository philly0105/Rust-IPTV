/**
 * The shell's destinations, grouped the way the rail shows them (SH-rail-ia): Watch (where
 * playback starts), Library (what the user kept, downloaded, recorded or watched) and the
 * sources below them. The rail, the phone tab bar's More sheet, the boot skeleton and the
 * command palette's order all read these lists, so the groups never drift apart.
 */

import {
  AlarmClock,
  Bookmark,
  CalendarRange,
  ChartColumn,
  Download,
  HardDrive,
  Heart,
  History,
  House,
  LayoutGrid,
  ListOrdered,
  Search,
  type LucideIcon,
} from 'lucide-react';

import type { Source } from '@/api/types';

import { routeSourceId, sourceBasePath, sourceHomePath } from './railLinks';

export interface NavLinkDef {
  to: string;
  /** i18n key; a bare key is in the `shell` namespace. */
  labelKey: string;
  icon: LucideIcon;
  end?: boolean;
  /** First-run tour anchor (Run 3 C7, `src/features/onboarding/tour/steps.ts`). */
  tour?: 'vod';
}

export interface NavGroupDef {
  id: 'watch' | 'library';
  /** i18n key of the group's small label, in the `shell` namespace. */
  labelKey: string;
  links: readonly NavLinkDef[];
}

// Home is a house, not a layout glyph: collapsed, the rail is icons only, and a
// tile-shaped Home would echo Multi-view's grid (LayoutGrid, as in its page and menus).
export const WATCH_LINKS: readonly NavLinkDef[] = [
  { to: '/dashboard', labelKey: 'navDashboard', icon: House },
  { to: '/search', labelKey: 'navSearch', icon: Search },
  { to: '/epg', labelKey: 'navGuide', icon: CalendarRange },
  { to: '/multiview', labelKey: 'navMultiview', icon: LayoutGrid },
];

export const LIBRARY_LINKS: readonly NavLinkDef[] = [
  // The tour's "Movies, series and My List" step points here: unlike a source's Movies link, it
  // is always on screen, also in the collapsed rail.
  { to: '/my-list', labelKey: 'navMyList', icon: Bookmark, tour: 'vod' },
  { to: '/favorites', labelKey: 'navFavorites', icon: Heart },
  // Run 2: custom channel lists and watch stats reuse their pages' titles.
  { to: '/lists', labelKey: 'lists:title', icon: ListOrdered },
  { to: '/recent', labelKey: 'navRecent', icon: History },
  { to: '/downloads', labelKey: 'navDownloads', icon: Download },
  { to: '/my-videos', labelKey: 'navMyVideos', icon: HardDrive },
  // recording:
  { to: '/scheduled', labelKey: 'navScheduled', icon: AlarmClock },
  { to: '/stats', labelKey: 'stats:title', icon: ChartColumn },
];

export const NAV_GROUPS: readonly NavGroupDef[] = [
  { id: 'watch', labelKey: 'navGroupWatch', links: WATCH_LINKS },
  { id: 'library', labelKey: 'navGroupLibrary', links: LIBRARY_LINKS },
];

/** Every global destination, in rail order. */
export const ALL_NAV_LINKS: readonly NavLinkDef[] = NAV_GROUPS.flatMap((g) => g.links);

/** The phone tab bar's width limit (Tailwind `sm`): below it the rail goes and the bar shows. */
export const PHONE_QUERY = '(max-width: 639px)';

// ---------------------------------------------------------------------------
// The last source the user opened, for the phone tab bar's Live TV tab.

const LAST_SOURCE_KEY = 'tsrust.lastSource';

export function readLastSource(): string | null {
  try {
    return localStorage.getItem(LAST_SOURCE_KEY);
  } catch {
    return null;
  }
}

/** Remembers the source of a `/s/:id/...` (or archive) route; other routes leave it alone. */
export function rememberRouteSource(pathname: string): void {
  const id = routeSourceId(pathname);
  if (!id) return;
  try {
    if (localStorage.getItem(LAST_SOURCE_KEY) !== id) localStorage.setItem(LAST_SOURCE_KEY, id);
  } catch {
    // storage blocked: the tab falls back to the first source with channels
  }
}

/**
 * Where the Live TV tab goes: the live channels of the source the user last opened, when it still
 * exists and has channels; else the first source with channels that imported cleanly (as the
 * tour's Live step picks it), else the first with channels at all, else the first source's home
 * (a VOD-only account opens on its movies). Null with no sources.
 */
export function liveTabTarget(sources: readonly Source[] | undefined, lastSourceId: string | null): string | null {
  const list = sources ?? [];
  if (list.length === 0) return null;
  const live = (s: Source) => `${sourceBasePath(s.id)}/live`;
  const last = lastSourceId ? list.find((s) => s.id === lastSourceId) : undefined;
  if (last && last.channelCount > 0) return live(last);
  const watchable = list.filter((s) => s.channelCount > 0);
  const pick = watchable.find((s) => !s.lastError) ?? watchable[0];
  if (pick) return live(pick);
  return sourceHomePath(last ?? list[0]!);
}

/** True for the routes the Live TV tab stands for: a source's live or radio pages and the archive. */
export function isLiveRoute(pathname: string): boolean {
  return /^\/s\/[^/]+\/(live|radio)(\/|$)/.test(pathname) || pathname.startsWith('/live/archive/');
}
