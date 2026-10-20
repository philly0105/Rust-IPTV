/**
 * Release notes for What's new (contract C7), newest release first. Each
 * item's strings live in `onboarding.json` as `<key>Title` and `<key>Text`;
 * the i18n parity test keeps them in all 19 languages, and
 * `test/notes.test.ts` checks that every key has both strings.
 *
 * Adding a release: put a new entry at the top with the version the app will
 * report (`app.info.version`), add its keys to every locale, and keep each
 * list short (the dialog is read once, at startup).
 */

import {
  BookmarkPlus,
  CalendarClock,
  CalendarRange,
  CalendarSearch,
  Camera,
  Captions,
  ChartColumn,
  Clapperboard,
  Download,
  Gamepad2,
  Gauge,
  Languages,
  LayoutGrid,
  ListPlus,
  Maximize,
  MoonStar,
  Palette,
  RefreshCw,
  Scaling,
  ShieldCheck,
  Smartphone,
  TextSearch,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export interface ReleaseNoteItem {
  /** String key prefix in `onboarding.json` (`<key>Title`, `<key>Text`). */
  key: string;
  icon: LucideIcon;
  /**
   * Only where this runs: `desktop` for a feature of the desktop app (the window, phone
   * pairing), `server` for one of the browser. Unset: everywhere. What's new leaves the item out
   * elsewhere, so nobody reads about a setting they cannot find (SR-9).
   */
  platform?: 'desktop' | 'server';
}

export interface ReleaseNotes {
  version: string;
  items: readonly ReleaseNoteItem[];
}

export const RELEASE_NOTES: readonly ReleaseNotes[] = [
  {
    // Loops 1-5 and the feature and performance audit fixes.
    version: '0.2.0',
    items: [
      { key: 'noteM3uSeries', icon: Clapperboard },
      { key: 'noteFaster', icon: Zap },
      { key: 'noteProgrammeSearch', icon: TextSearch },
      { key: 'noteGuideTools', icon: CalendarClock },
      { key: 'notePicture', icon: Scaling },
      { key: 'noteSourceUpdates', icon: RefreshCw },
      { key: 'noteDownloadsMore', icon: Download },
      // Phones pair with the desktop app only; in server mode the remote page is local to the server.
      { key: 'noteRemotePlay', icon: Gamepad2, platform: 'desktop' },
      { key: 'notePhoneLayout', icon: Smartphone },
      { key: 'noteMessages', icon: Languages },
      // Settings > General shows Window at startup only in the desktop app.
      { key: 'noteWindowStart', icon: Maximize, platform: 'desktop' },
      { key: 'noteFixes', icon: Wrench },
    ],
  },
  {
    version: '0.1.0',
    items: [
      { key: 'noteMultiview', icon: LayoutGrid },
      { key: 'noteParental', icon: ShieldCheck },
      { key: 'noteMyList', icon: BookmarkPlus },
      { key: 'noteLists', icon: ListPlus },
      { key: 'noteGuide', icon: CalendarSearch },
      { key: 'noteSubtitles', icon: Captions },
      { key: 'noteSleep', icon: MoonStar },
      { key: 'noteVodFilters', icon: CalendarRange },
      { key: 'noteStats', icon: ChartColumn },
      { key: 'noteLooks', icon: Palette },
      { key: 'noteScreenshot', icon: Camera },
      { key: 'noteSpeed', icon: Gauge },
    ],
  },
];

/** A release's items for this host (`desktop`: the desktop app; otherwise a browser on a server). */
export function itemsFor(release: ReleaseNotes, desktop: boolean): readonly ReleaseNoteItem[] {
  const here = desktop ? 'desktop' : 'server';
  return release.items.filter((i) => i.platform === undefined || i.platform === here);
}

/** The releases with their items for this host; a release left with nothing drops out. */
export function notesFor(releases: readonly ReleaseNotes[], desktop: boolean): ReleaseNotes[] {
  return releases.map((r) => ({ ...r, items: itemsFor(r, desktop) })).filter((r) => r.items.length > 0);
}
