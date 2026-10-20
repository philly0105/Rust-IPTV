/**
 * What airs on one channel now and next, for the player's own chrome (zap banner, sleep timer
 * "until the programme ends"). The player can render outside the router (the dock outlives
 * pages), so this keeps a small cache of its own, of answers ready to show. The guide request
 * itself goes through the shared query cache under the key the live page uses
 * (`rpcKey('epg.nowNext', { refs: [ref] })`), so a zap or a click asks the core once per channel.
 * An answer any view already holds there (the live list's pages, the wall) is used as it is.
 * A zap burst asks only for the channels it stops on (`holdNowNext`), not every one it passes.
 *
 * Times come back on the wall clock: `settings.epgOffsetMinutes` (a guide published in the
 * wrong time zone) is already applied, so callers compare them with `Date.now()` as they are.
 * Channels without XMLTV around now fall back to the provider's short EPG (Xtream while
 * `settings.epgShortFallback` is on, Stalker always), like the live views.
 */

import { queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, type EpgNowNext, type EpgProgram, type ItemRef } from '@/api/types';
import { nowNextFrom, preferNowNext } from '@/features/live/lib/epgMerge';
import { ms, MINUTE, shiftNowNext } from '@/features/live/lib/epgTime';
import { markFromProvider, SHORT_EPG_LIMIT } from '@/features/live/lib/shortEpg';

import { getSettings, isLockedZap, isPendingZap, knownSourceKind, peekSettings, usePlayerStore } from './store';

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

/**
 * A current answer for `ref` that another view's `epg.nowNext` request already holds in the query
 * cache (with or without descriptions: the player shows none). Only one with a programme airing
 * now: without one, `load` also asks the provider's short EPG.
 */
function sharedAnswer(ref: ItemRef, now: number): Entry | undefined {
  const key = itemKey(ref);
  const offset = peekSettings()?.epgOffsetMinutes ?? 0;
  let best: Entry | undefined;
  for (const q of queryClient.getQueryCache().findAll({ queryKey: ['epg.nowNext'] })) {
    const args = q.queryKey[1] as { offsetMinutes?: number } | null | undefined;
    if ((args?.offsetMinutes ?? 0) !== offset || q.state.status !== 'success') continue;
    const guide = (q.state.data as Record<string, EpgNowNext> | undefined)?.[key];
    const entry = { at: q.state.dataUpdatedAt, value: shiftNowNext(guide, offset) ?? null };
    if (entry.value?.now && fresh(entry, now) && (!best || entry.at > best.at)) best = entry;
  }
  if (best) cache.set(key, best);
  return best;
}

/** The cached answer for `ref` when still current: `null` = the guide has nothing, `undefined` = not asked yet. */
export function peekNowNext(ref: ItemRef, now = Date.now()): EpgNowNext | null | undefined {
  const entry = cache.get(itemKey(ref));
  if (fresh(entry, now)) return entry.value;
  return sharedAnswer(ref, now)?.value;
}

/**
 * Channels a zap burst is passing through (`itemKey`): a request for one waits until the burst
 * stops on it. Each resolves true when the channel is to be asked, false when the burst moved on.
 */
const holds = new Map<string, Promise<boolean>>();
/** Lets a locked step's hold go once its PIN let it through (its tune waits on the guide answer). */
const passes = new Map<string, () => void>();

/** The channel on screen is `key`, and a step whose guide may be asked (a locked one shows none). */
function stoppedOn(key: string): boolean {
  const s = usePlayerStore.getState().source;
  return !!s?.ref && itemKey(s.ref) === key && !isLockedZap(s);
}

/**
 * A zap burst stepped onto `ref`. Its guide is asked only once the step stayed on screen for
 * `dwellMs` (the burst settled there, or paused on it); a step passed sooner asks nothing. A
 * locked step is asked once its PIN let it play, and not at all when the burst moves on.
 */
export function holdNowNext(ref: ItemRef, dwellMs: number): void {
  const key = itemKey(ref);
  const hold = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      const s = usePlayerStore.getState().source;
      if (!s?.ref || itemKey(s.ref) !== key || !isPendingZap(s) || !isLockedZap(s)) {
        resolve(stoppedOn(key));
        return;
      }
      // Behind its PIN prompt: wait for what the prompt decides (the tune passes it on accept).
      const unsub = usePlayerStore.subscribe((st) => {
        if (st.source === s) return;
        unsub();
        resolve(stoppedOn(key));
      });
      passes.set(key, () => {
        unsub();
        resolve(true);
      });
    }, dwellMs);
  });
  holds.set(key, hold);
  // Decided: a later request for the channel is not held by it.
  void hold.then(() => {
    if (holds.get(key) !== hold) return;
    holds.delete(key);
    passes.delete(key);
  });
}

/**
 * The PIN prompt let `ref` through: a hold waiting on it is asked now. The tune waits for the
 * guide answer before it plays, so waiting for the play itself would never end.
 */
export function passNowNext(ref: ItemRef): void {
  passes.get(itemKey(ref))?.();
}

/**
 * Waits out the holds on `key`: true when it is to be asked. A decided hold has left the map by
 * the time this resumes, so a step zapped back onto (a newer hold) is waited for in turn.
 */
async function released(key: string): Promise<boolean> {
  let go = true;
  for (let hold = holds.get(key); hold; hold = holds.get(key)) go = await hold;
  return go;
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

/** `again`: ask the core even when the query cache holds a recent answer (it is out of date). */
async function load(ref: ItemRef, again: boolean): Promise<EpgNowNext | null> {
  const settings = await getSettings();
  const offset = settings?.epgOffsetMinutes ?? 0;
  let guide: EpgNowNext | undefined;
  try {
    const args = offset ? { refs: [ref], offsetMinutes: offset } : { refs: [ref] };
    const res = await queryClient.fetchQuery({
      queryKey: rpcKey('epg.nowNext', args),
      queryFn: () => rpc('epg.nowNext', args),
      staleTime: again ? 0 : NOW_NEXT_TTL_MS,
      retry: false,
    });
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
  const hit = cache.get(key);
  if (!opts.force && fresh(hit, Date.now())) return Promise.resolve(hit.value);
  if (!opts.force) {
    const shared = sharedAnswer(ref, Date.now());
    if (shared) return Promise.resolve(shared.value);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;
  // An answer held here that went out of date (its programme ended) is asked again, past the
  // query cache, which may still hold the same answer.
  const again = !!opts.force || hit !== undefined;
  const ask = (): Promise<EpgNowNext | null> =>
    load(ref, again)
      .catch(() => null)
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
        return value;
      });
  // A channel a zap burst passed: nothing asked, and nothing cached, so a later look asks.
  const job: Promise<EpgNowNext | null> = (opts.force || !holds.has(key) ? ask() : released(key).then((go) => (go ? ask() : (peekNowNext(ref) ?? null)))).finally(
    () => {
      if (pending.get(key) === job) pending.delete(key);
    },
  );
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

/** The programme airing at `now` and the one after it, from a guide answer that may have aged. */
export function airingPair(guide: EpgNowNext | null | undefined, now: number): { current?: EpgProgram; upcoming?: EpgProgram } {
  if (!guide) return {};
  const airs = (p: EpgProgram | undefined): p is EpgProgram => !!p && ms(p.start) <= now && ms(p.end) > now;
  // The guide's "now" ended while the banner was up: its next is what airs.
  const current = airs(guide.now) ? guide.now : airs(guide.next) ? guide.next : undefined;
  const upcoming = current !== guide.next && guide.next && ms(guide.next.end) > now ? guide.next : undefined;
  const out: { current?: EpgProgram; upcoming?: EpgProgram } = {};
  if (current) out.current = current;
  if (upcoming) out.upcoming = upcoming;
  return out;
}

/** How often the playing channel's airing programme is looked at (a cache read; a request only when it ended). */
export const LIVE_PROGRAMME_CHECK_MS = 30_000;

/**
 * Keeps a live source's subtitle on the programme airing now (PL-STALE-PROGRAMME). A live
 * source is subtitled with the airing title once, at tune time; an hour on one channel left the
 * previous show under its name in the player's title bar and in the system's media controls
 * (`mediaSession.ts`). Every `LIVE_PROGRAMME_CHECK_MS` the cached guide answer is read (and asked
 * again once its programme ended), and a new airing title patches `source.subtitle`: the same
 * media (`watchKey`), so nothing restarts. A guide with nothing airing leaves the subtitle as it
 * is. Bound once by the dock; returns the unbind.
 */
export function bindLiveProgramme(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let followed: string | undefined;
  const check = async (): Promise<void> => {
    const s = usePlayerStore.getState().source;
    const ref = s?.isLive && !isPendingZap(s) && !isLockedZap(s) ? s.ref : undefined;
    if (!ref) return;
    const key = itemKey(ref);
    const now = Date.now();
    const guide = peekNowNext(ref, now) ?? (await fetchNowNext(ref));
    const title = airingPair(guide, Date.now()).current?.title;
    const cur = usePlayerStore.getState().source;
    if (!title || !cur?.ref || itemKey(cur.ref) !== key || !cur.isLive || cur.subtitle === title) return;
    usePlayerStore.setState({ source: { ...cur, subtitle: title } });
  };
  const follow = (): void => {
    const s = usePlayerStore.getState().source;
    const key = s?.isLive && s.ref && !isPendingZap(s) ? itemKey(s.ref) : undefined;
    if (key === followed) return;
    followed = key;
    if (timer) clearInterval(timer);
    timer = key ? setInterval(() => void check(), LIVE_PROGRAMME_CHECK_MS) : null;
  };
  follow();
  const unsub = usePlayerStore.subscribe(follow);
  return () => {
    unsub();
    if (timer) clearInterval(timer);
    timer = null;
    followed = undefined;
  };
}

/** Testing only. */
export function __resetNowNextForTests(): void {
  cache.clear();
  pending.clear();
  holds.clear();
  passes.clear();
  queryClient.removeQueries({ queryKey: ['epg.nowNext'] });
}
