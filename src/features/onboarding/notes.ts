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
  CalendarRange,
  CalendarSearch,
  Camera,
  Captions,
  ChartColumn,
  Gauge,
  LayoutGrid,
  ListPlus,
  MoonStar,
  Palette,
  ShieldCheck,
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
