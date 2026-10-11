import type { Settings } from '@/api/types';

import type { SettingsPatch } from '../lib/patch';

export interface SectionProps {
  settings: Settings;
  update: (patch: SettingsPatch) => Promise<boolean>;
}

export const SECTION_IDS = ['general', 'playback', 'players', 'epg', 'metadata', 'appearance', 'remote', 'backup', 'shortcuts', 'about'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(v: string | undefined): v is SectionId {
  return (SECTION_IDS as readonly string[]).includes(v ?? '');
}
