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
  Clapperboard,
  Download,
  HardDrive,
  Heart,
  History,
  House,
  Layers,
  LayoutGrid,
  ListOrdered,
  Radio,
  Search,
  Trophy,
  Tv,
  type LucideIcon,
} from 'lucide-react';

import type { Source } from '@/api/types';

import { railLinkCurrent, railLinkIds, routeSourceId, sourceBasePath, sourceHomePath } from './railLinks';

/** The sections of a source that the Watch group links to directly. */
export type SourceSection = 'live' | 'movies' | 'series';

export interface NavLinkDef {
  to: string;
  /** i18n key; a bare key is in the `shell` namespace. */
  labelKey: string;
  icon: LucideIcon;
  end?: boolean;
  /** First-run tour anchor (Run 3 C7, `src/features/onboarding/tour/steps.ts`). */
  tour?: 'live' | 'vod';
  /**
   * Live TV, Movies or Series: the link opens that section of a source, picked for the page on
   * show (`watchLinks`), and is current by `sectionCurrent`. Its `to` here is where it leads while
   * there are no sources.
   */
  section?: SourceSection;
  /** Stepped back: there are no sources, and the page has nothing to show until one is added. */
  dim?: boolean;
  /** Its page is of use with no sources (Home's welcome, Search, Sports, Lists): never stepped back. */
  noSourceNeeded?: boolean;
  /**
   * Left out of the rail, kept in the palette's Go to list: the header's search box stands for
   * it on every page from sm up, and Ctrl+F opens the page (Search). Phones have their Search tab.
   */
  notInRail?: boolean;
  /** One of Library's less used pages: the rail folds it under the group's More row. */
  more?: boolean;
}

/**
 * Where Live TV, Movies or Series leads with no sources: the Sources page, as the phone tab's Live
 * TV, saying which row led there (`for`), so that row stays current there (sectionCurrent) rather
 * than giving its mark to Manage sources.
 */
export function noSourcesTarget(section: SourceSection): string {
  return `/sources?for=${section}`;
}

/** The section whose row led to the Sources page (`/sources?for=…`), else null. */
export function sourcesFor(pathname: string, search: string): SourceSection | null {
  if (pathname !== '/sources') return null;
  const section = new URLSearchParams(search).get('for');
  return section === 'live' || section === 'movies' || section === 'series' ? section : null;
}

// Home is a house, not a layout glyph: collapsed, the rail is icons only, and a
// tile-shaped Home would echo Multi-view's grid (LayoutGrid, as in its page and menus).
export const WATCH_LINKS: readonly NavLinkDef[] = [
  { to: '/dashboard', labelKey: 'navDashboard', icon: House, noSourceNeeded: true },
  // The header's search box sat a hand's width away from this row on every page: one way in is enough.
  { to: '/search', labelKey: 'navSearch', icon: Search, notInRail: true, noSourceNeeded: true },
  // A source's sections, with the icons of its own links (railLinks). Most people have one source,
  // and these three, the most used pages, sat in its entry at the foot of the rail, under Library.
  // The tour's first step points here: Live TV leads to a source with channels to watch (liveTabTarget).
  { to: noSourcesTarget('live'), labelKey: 'railLive', icon: Tv, section: 'live', tour: 'live' },
  { to: '/epg', labelKey: 'navGuide', icon: CalendarRange },
  // The tour's movies step points here, or at My List when no source has movies.
  { to: noSourcesTarget('movies'), labelKey: 'railMovies', icon: Clapperboard, section: 'movies', tour: 'vod' },
  { to: noSourcesTarget('series'), labelKey: 'railSeries', icon: Layers, section: 'series' },
  // Games from ESPN with the channels that carry them; the label is the page's title.
  // ESPN's games show with no sources too, only without channels to watch them on.
  { to: '/sports', labelKey: 'sports:title', icon: Trophy, noSourceNeeded: true },
  { to: '/multiview', labelKey: 'navMultiview', icon: LayoutGrid },
];

export const LIBRARY_LINKS: readonly NavLinkDef[] = [
  // The tour's "Movies, series and My List" step falls back on this row: unlike Movies, which a
  // rail with no movies leaves out, it is always on screen, also collapsed.
  { to: '/my-list', labelKey: 'navMyList', icon: Bookmark, tour: 'vod' },
  { to: '/favorites', labelKey: 'navFavorites', icon: Heart },
  // Run 2: custom channel lists and watch stats reuse their pages' titles.
  // A list can be created before any source is added.
  { to: '/lists', labelKey: 'lists:title', icon: ListOrdered, noSourceNeeded: true },
  { to: '/recent', labelKey: 'navRecent', icon: History },
  // The rest are visited now and then, not every evening: the rail folds them under More.
  { to: '/downloads', labelKey: 'navDownloads', icon: Download, more: true },
  { to: '/my-videos', labelKey: 'navMyVideos', icon: HardDrive, more: true },
  // recording:
  { to: '/scheduled', labelKey: 'navScheduled', icon: AlarmClock, more: true },
  { to: '/stats', labelKey: 'stats:title', icon: ChartColumn, more: true },
];

/** The Watch links the rail and its boot skeleton show. */
export const RAIL_WATCH_LINKS = WATCH_LINKS.filter((l) => !l.notInRail);

/** The phone tab bar's width limit (Tailwind `sm`): below it the rail goes and the bar shows. */
export const PHONE_QUERY = '(max-width: 639px)';

// ---------------------------------------------------------------------------
// The last source the user opened, for the phone tab bar's Live TV tab and the Watch group's
// Live TV, Movies and Series.

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

/**
 * Where the Movies or Series link goes: that section of `preferredId` when that source has it,
 * else of the first source that has it. "Has it" is the rail's own rule (railLinkIds): always for
 * a Stalker portal and for an Xtream account before its first import, otherwise by the count.
 * Null when no source has it.
 */
export function vodTarget(sources: readonly Source[] | undefined, section: 'movies' | 'series', preferredId: string | null): string | null {
  const having = (sources ?? []).filter((s) => railLinkIds(s).includes(section));
  const pick = having.find((s) => s.id === preferredId) ?? having[0];
  return pick ? `${sourceBasePath(pick.id)}/${section}` : null;
}

/**
 * Where a section link goes. `preferredId` is the source on show, else the one last opened
 * (`routeSourceId(pathname) ?? readLastSource()`, as the phone tab reads it). Live TV goes where
 * the phone tab goes (liveTabTarget), Movies and Series by vodTarget. With no sources, or before
 * they have loaded, all three lead to the Sources page. Null when there are sources and none has
 * the section.
 */
export function sectionTarget(section: SourceSection, sources: readonly Source[] | undefined, preferredId: string | null): string | null {
  if (!sources?.length) return noSourcesTarget(section);
  return section === 'live' ? liveTabTarget(sources, preferredId) : vodTarget(sources, section, preferredId);
}

/**
 * Whether the page on show belongs to a section link, in any source: Live TV stands for the live
 * pages and the archive (isLiveRoute without radio, which has its own row), Movies and Series for what
 * railLinkCurrent counts for a source's own link (a movie's detail and player beside Movies). With
 * no sources, the Sources page the link led to (`search` holds its `for`).
 */
export function sectionCurrent(section: SourceSection, pathname: string, search = ''): boolean {
  if (sourcesFor(pathname, search) === section) return true;
  // Radio has a row of its own (the lone source's in Watch, a source's own link otherwise), so
  // Live TV leaves its pages to that row rather than lighting up beside it.
  if (section === 'live') return isLiveRoute(pathname) && !/^\/s\/[^/]+\/radio(\/|$)/.test(pathname);
  // The route's own source segment, as it is in the path: decoding and encoding it again could
  // spell it differently.
  const base = /^\/s\/[^/?#]+/.exec(pathname)?.[0];
  return base !== undefined && railLinkCurrent({ id: section, to: `${base}/${section}` }, pathname);
}

/**
 * The Watch links as the rail and the palette offer them: Live TV, Movies and Series pointed at a
 * source by sectionTarget, Movies or Series left out while no source has them, and every link
 * whose page needs a source stepped back (`dim`) while there are none.
 */
export function watchLinks(sources: readonly Source[] | undefined, preferredId: string | null): NavLinkDef[] {
  const none = sources?.length === 0;
  return WATCH_LINKS.flatMap((l) => {
    const dim = none && !l.noSourceNeeded;
    if (!l.section) return [dim ? { ...l, dim } : l];
    const to = sectionTarget(l.section, sources, preferredId);
    return to === null ? [] : [{ ...l, to, dim }];
  });
}

/**
 * Radio as a Watch link, for the rail and the phone's More sheet: only with exactly one source,
 * whose entry is then a single row to the Sources page (its other links were Watch's and
 * Library's own pages over again), and only when that source has stations by railLinkIds' rules.
 * Null otherwise: with two or more sources each one's Radio stays in its own entry.
 */
export function loneSourceRadio(sources: readonly Source[] | undefined): NavLinkDef | null {
  if (sources?.length !== 1) return null;
  const only = sources[0]!;
  if (!railLinkIds(only, { hasRadio: only.radioCount > 0 }).includes('radio')) return null;
  return { to: `${sourceBasePath(only.id)}/radio`, labelKey: 'railRadio', icon: Radio };
}
