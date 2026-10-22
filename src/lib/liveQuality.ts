/**
 * The Live TV quality filter as one comparable value. The shell refetches the lists the core
 * filters when it changes (shell/effects.ts), and the player asks for the playing channel's
 * failover copies again (player/failover.ts). A leaf module, so neither pulls in the other.
 */

import type { Settings } from '@/api/types';

/** The live quality filter in effect ('' = off: the untagged toggle needs a minimum). */
export function liveQualityKey(s: Pick<Settings, 'liveMinQuality' | 'liveHideUntagged'>): string {
  return s.liveMinQuality == null ? '' : `${s.liveMinQuality}|${s.liveHideUntagged === true}`;
}
