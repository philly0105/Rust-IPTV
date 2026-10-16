import type { EpgNowNext, EpgProgram, Settings, SourceKind } from '@/api/types';

import { ms } from './epgTime';

/**
 * Xtream short-EPG fallback: channels without XMLTV programmes around now show the panel's own
 * now/next (`epg.shortEpg`, cached and rate-limited in core). These helpers decide when to ask
 * and tag what came back, so the UI can say where a programme came from.
 */

/** Programmes asked per channel: now, next and a few after. */
export const SHORT_EPG_LIMIT = 6;

/** Queue scope of the fallback answers (separate from the Stalker previews of the same source). */
export const SHORT_EPG_SCOPE = 'xtream-short';

/** The fallback runs for Xtream sources while `settings.epgShortFallback` is on (default on). */
export function shortEpgEnabled(kind: SourceKind | undefined, settings: Pick<Settings, 'epgShortFallback'> | undefined): boolean {
  return kind === 'xtream' && settings?.epgShortFallback !== false;
}

/** Marks programmes as the provider's, not XMLTV's. */
export function markFromProvider(list: readonly EpgProgram[]): EpgProgram[] {
  return list.map((p) => (p.fromProvider ? p : { ...p, fromProvider: true }));
}

/** True when XMLTV has a programme airing at `guideNow`; only channels without one need the fallback. */
export function hasAiring(list: readonly EpgProgram[] | undefined, guideNow: number): boolean {
  return !!list?.some((p) => ms(p.start) <= guideNow && ms(p.end) > guideNow);
}

/** True when an XMLTV now/next pair needs the fallback (nothing airing). */
export function needsFallback(nn: EpgNowNext | undefined): boolean {
  return !nn?.now;
}
