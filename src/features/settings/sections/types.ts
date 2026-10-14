import type { Settings } from '@/api/types';

import type { ParitySettings, SettingsPatch } from '../lib/patch';

export type { ParitySettings };

export const PARITY_DEFAULTS: ParitySettings = {
  stripCountryPrefix: false,
  epgOffsetMinutes: 0,
  playerReuseInstance: true,
  showExternalBar: true,
  vodMinRating: 0,
  recordingsDir: null,
};

export function parity(s: Settings): ParitySettings {
  const o = s as Settings & Partial<ParitySettings>;
  return {
    stripCountryPrefix: typeof o.stripCountryPrefix === 'boolean' ? o.stripCountryPrefix : PARITY_DEFAULTS.stripCountryPrefix,
    epgOffsetMinutes: typeof o.epgOffsetMinutes === 'number' ? o.epgOffsetMinutes : PARITY_DEFAULTS.epgOffsetMinutes,
    playerReuseInstance: typeof o.playerReuseInstance === 'boolean' ? o.playerReuseInstance : PARITY_DEFAULTS.playerReuseInstance,
    showExternalBar: typeof o.showExternalBar === 'boolean' ? o.showExternalBar : PARITY_DEFAULTS.showExternalBar,
    vodMinRating: typeof o.vodMinRating === 'number' ? o.vodMinRating : PARITY_DEFAULTS.vodMinRating,
    recordingsDir: typeof o.recordingsDir === 'string' && o.recordingsDir.trim() ? o.recordingsDir : null,
  };
}

export interface SectionProps {
  settings: Settings;
  update: (patch: SettingsPatch) => Promise<boolean>;
}

export const SECTION_IDS = [
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
export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(v: string | undefined): v is SectionId {
  return (SECTION_IDS as readonly string[]).includes(v ?? '');
}
