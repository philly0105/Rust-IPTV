/**
 * Single settings the palette (and the Search page's "Settings and actions") lists by name, so
 * "subtitles" or "font size" opens the group that holds the setting rather than the top of a long
 * section. Each opens `/settings/<section>#<id>`; the Settings page finds the setting by its label
 * (the same i18n key the row draws) and scrolls to and marks its group, so the entries hold
 * whichever group a setting is moved into. Keyed by setting, never by position.
 *
 * Plain data (no React, no settings feature import), so the palette's chunk stays light.
 */

/**
 * Every Settings section, in page order. A copy of the settings feature's `SECTION_IDS` (importing
 * it would pull that module into the main chunk); a shell test fails when the two drift apart.
 */
export const SETTINGS_SECTIONS = [
  'general',
  'playback',
  'players',
  'epg',
  'recording',
  'metadata',
  'appearance',
  'parental',
  'remote',
  'backup',
  'shortcuts',
  'about',
] as const;

export interface SettingTarget {
  /** The URL hash, and the palette item's id (`setting.<id>`). */
  id: string;
  /** The Settings section that holds it (`SETTINGS_SECTIONS`). */
  section: string;
  /** The setting's own label, namespaced (`settings:uiScale`): the palette row's title and what the page looks for. */
  label: string;
  /** More words it is found by, in English (the UI language's label always counts). */
  keywords: readonly string[];
}

export const SETTING_TARGETS: readonly SettingTarget[] = [
  { id: 'language', section: 'general', label: 'settings:language', keywords: ['language', 'translation'] },
  { id: 'startup', section: 'general', label: 'settings:startupBehavior', keywords: ['start page', 'startup', 'on startup'] },
  { id: 'min-rating', section: 'general', label: 'settings:vodMinRating', keywords: ['rating', 'minimum rating'] },
  { id: 'source-refresh', section: 'general', label: 'settings:refreshInterval', keywords: ['refresh', 'auto refresh', 'refresh interval'] },
  { id: 'subtitles', section: 'playback', label: 'player:subtitleStyle.title', keywords: ['subtitles', 'subtitle style', 'subtitle size', 'subtitle color'] },
  { id: 'captions', section: 'playback', label: 'settings:showCaptions', keywords: ['captions', 'closed captions', 'cc'] },
  { id: 'autoplay', section: 'playback', label: 'settings:autoplayNext', keywords: ['autoplay', 'next episode', 'up next'] },
  { id: 'stream-format', section: 'playback', label: 'settings:streamFormat', keywords: ['hls', 'mpeg-ts', 'stream quality', 'quality'] },
  { id: 'reconnect', section: 'playback', label: 'settings:streamReconnect', keywords: ['reconnect', 'failover', 'dropped'] },
  { id: 'guide-offset', section: 'epg', label: 'settings:epgOffset', keywords: ['time offset', 'time shift', 'time zone', 'timezone'] },
  { id: 'theme', section: 'appearance', label: 'settings:theme', keywords: ['theme', 'dark mode', 'light mode', 'oled'] },
  { id: 'accent', section: 'appearance', label: 'settings:accent', keywords: ['accent', 'colour', 'color'] },
  { id: 'interface-size', section: 'appearance', label: 'settings:uiScale', keywords: ['font size', 'text size', 'zoom', 'bigger text', 'scale'] },
  { id: 'density', section: 'appearance', label: 'settings:density', keywords: ['density', 'compact'] },
  { id: 'poster-size', section: 'appearance', label: 'settings:coverSize', keywords: ['poster size', 'cover size'] },
  { id: 'tmdb-key', section: 'metadata', label: 'settings:tmdbApiKey', keywords: ['tmdb', 'api key', 'the movie database'] },
  { id: 'recordings-folder', section: 'recording', label: 'settings:recordingsFolder', keywords: ['recordings', 'folder', 'dvr'] },
  { id: 'reminders', section: 'recording', label: 'settings:remindersEnabled', keywords: ['reminders', 'notifications', 'alerts'] },
  { id: 'remote', section: 'remote', label: 'settings:remoteEnabled', keywords: ['remote', 'phone', 'pairing'] },
  { id: 'backup-secrets', section: 'backup', label: 'settings:backupIncludeSecrets', keywords: ['password', 'passwords', 'credentials', 'keys'] },
];

/** The target a Settings URL hash names (`#interface-size`), if any. */
export function settingTarget(hash: string): SettingTarget | undefined {
  const id = hash.replace(/^#/, '');
  return SETTING_TARGETS.find((s) => s.id === id);
}

/** True when every typed word appears, unbroken, in `text` (case-insensitive), as the palette matches. */
export function containsWords(text: string, search: string): boolean {
  const hay = text.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}
