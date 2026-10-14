/**
 * What airs on one channel now and next, for the player's own chrome (zap banner, sleep timer
 * "until the programme ends"). The player can render outside the router and the query client
 * (the dock outlives pages), so this asks the core directly and keeps a small cache of its own.
 *
 * Times come back on the wall clock: `settings.epgOffsetMinutes` (a guide published in the
 * wrong time zone) is already applied, so callers compare them with `Date.now()` as they are.
 * Channels without XMLTV around now fall back to the provider's short EPG (Xtream while
 * `settings.epgShortFallback` is on, Stalker always), like the live views.
 */

import { rpc } from '@/api/transport';
import { itemKey, type EpgNowNext, type EpgProgram, type ItemRef } from '@/api/types';
import { nowNextFrom, preferNowNext } from '@/features/live/lib/epgMerge';
import { ms, MINUTE, shiftNowNext } from '@/features/live/lib/epgTime';
import { markFromProvider, SHORT_EPG_LIMIT } from '@/features/live/lib/shortEpg';

import { getSettings, knownSourceKind } from './store';

/** Answers are reused this long, and never past the end of the programme they call "now". */
export const NOW_NEXT_TTL_MS = 60_000;

interface Entry {
  at: number;
  value: EpgNowNext | null;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<EpgNowNext | null>>();

function fresh(entry: Entry | undefined, now: number): entry is Entry {
  if (!entry || now - entry.at > NOW_NEXT_TTL_MS) return false;
  const airing = entry.value?.now;
  return !airing || ms(airing.end) > now;
}

/** The cached answer for `ref` when still current: `null` = the guide has nothing, `undefined` = not asked yet. */
export function peekNowNext(ref: ItemRef, now = Date.now()): EpgNowNext | null | undefined {
  const entry = cache.get(itemKey(ref));
  return fresh(entry, now) ? entry.value : undefined;
}

async function shortFallback(ref: ItemRef, offset: number, enabled: boolean): Promise<EpgNowNext | undefined> {
  const kind = knownSourceKind(ref.sourceId);
  if (kind === 'm3u' || (kind === 'xtream' && !enabled)) return undefined;
  try {
    const list = markFromProvider(await rpc('epg.shortEpg', { ref, limit: SHORT_EPG_LIMIT }));
    return nowNextFrom(list, Date.now() - offset * MINUTE);
  } catch {
    // No portal guide for this channel (or not a portal source).
    return undefined;
  }
}

async function load(ref: ItemRef): Promise<EpgNowNext | null> {
  const settings = await getSettings();
  const offset = settings?.epgOffsetMinutes ?? 0;
  let guide: EpgNowNext | undefined;
  try {
    const res = await rpc('epg.nowNext', offset ? { refs: [ref], offsetMinutes: offset } : { refs: [ref] });
    guide = res[itemKey(ref)];
  } catch {
    // No guide loaded: try the provider's.
  }
  if (!guide?.now) guide = preferNowNext(guide, await shortFallback(ref, offset, settings?.epgShortFallback !== false));
  const shifted = shiftNowNext(guide, offset);
  return shifted && (shifted.now || shifted.next) ? shifted : null;
}

/**
 * Now and next on `ref` (wall-clock times), from the cache when current. Never rejects: no
 * guide is `null`. Concurrent calls for one channel share a request.
 */
export function fetchNowNext(ref: ItemRef, opts: { force?: boolean } = {}): Promise<EpgNowNext | null> {
  const key = itemKey(ref);
  if (!opts.force) {
    const hit = cache.get(key);
    if (fresh(hit, Date.now())) return Promise.resolve(hit.value);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const job = load(ref)
    .catch(() => null)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      pending.delete(key);
      return value;
    });
  pending.set(key, job);
  return job;
}

/** Share of `p` already aired at `now`, 0 to 1. */
export function airedShare(p: Pick<EpgProgram, 'start' | 'end'>, now: number): number {
  const start = ms(p.start);
  const end = ms(p.end);
  if (!(end > start)) return 0;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

/** Testing only. */
export function __resetNowNextForTests(): void {
  cache.clear();
  pending.clear();
}
