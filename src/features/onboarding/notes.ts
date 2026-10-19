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
      { key: 'noteRemotePlay', icon: Gamepad2 },
      { key: 'notePhoneLayout', icon: Smartphone },
      { key: 'noteMessages', icon: Languages },
      { key: 'noteWindowStart', icon: Maximize },
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
