import { hashKey, type QueryKey } from '@tanstack/react-query';

import type { EpgNowNext, EpgProgram, ItemRef } from '@/api/types';

import { isValidProgram as valid, ms } from './epgTime';

/**
 * Unions two programme lists into one start-ordered schedule. `primary` wins: a `secondary`
 * programme that a primary one mostly covers is dropped, and one that only grazes a primary
 * programme (guides from two providers often disagree by a minute or two) is trimmed to the
 * free time. Used to lay a Stalker portal's own guide (primary) over an XMLTV guide (secondary),
 * so the portal's now/next and its archived past (`stalker.epg` with `from`) stay exact and
 * XMLTV fills the hours the portal does not return.
 */
export function mergePrograms(primary: readonly EpgProgram[], secondary: readonly EpgProgram[]): EpgProgram[] {
  const main = primary.filter(valid);
  if (main.length === 0) return [...secondary].filter(valid).sort((a, b) => ms(a.start) - ms(b.start));
  const spans = main.map((p) => [ms(p.start), ms(p.end)] as const);
  const extra: EpgProgram[] = [];
  for (const p of secondary) {
    if (!valid(p)) continue;
    const s0 = ms(p.start);
    const e0 = ms(p.end);
    let s = s0;
    let e = e0;
    for (const [ps, pe] of spans) {
      if (s >= pe || e <= ps) continue;
      if (ps <= s && pe >= e) {
        e = s; // fully covered
        break;
      }
      if (ps > s) e = Math.min(e, ps); // primary starts inside: keep the head
      else s = Math.max(s, pe); // primary covers the start: keep the tail
    }
    if (e - s < (e0 - s0) / 2) continue;
    extra.push(s === s0 && e === e0 ? p : { ...p, start: new Date(s).toISOString(), end: new Date(e).toISOString() });
  }
  const out = [...main, ...extra].sort((a, b) => ms(a.start) - ms(b.start));
  return out.filter((p, i) => i === 0 || p.start !== out[i - 1]!.start);
}

/** The last answer of {@link nowNextFrom} per programme list, for the `now` it was asked at. */
const nowNextCache = new WeakMap<readonly EpgProgram[], { now: number; value: EpgNowNext | undefined }>();

/**
 * Airing and following programme at `now`, from any (unsorted) list. The same list at the same
 * `now` gives the same object, so a memoized row fed from it keeps its render (LV-3).
 */
export function nowNextFrom(programs: readonly EpgProgram[] | undefined, now: number): EpgNowNext | undefined {
  if (!programs || programs.length === 0) return undefined;
  const cached = nowNextCache.get(programs);
  if (cached && cached.now === now) return cached.value;
  const value = computeNowNext(programs, now);
  nowNextCache.set(programs, { now, value });
  return value;
}

function computeNowNext(programs: readonly EpgProgram[], now: number): EpgNowNext | undefined {
  const sorted = [...programs].filter(valid).sort((a, b) => ms(a.start) - ms(b.start));
  const i = sorted.findIndex((p) => ms(p.end) > now);
  if (i < 0) return undefined;
  const first = sorted[i]!;
  if (ms(first.start) > now) return { next: first };
  return { now: first, next: sorted[i + 1] };
}

/** `primary` (the portal's guide) when it has something airing, else `fallback` (XMLTV) when that does. */
export function preferNowNext(primary: EpgNowNext | undefined, fallback: EpgNowNext | undefined): EpgNowNext | undefined {
  if (primary?.now) return primary;
  if (fallback?.now) return fallback;
  return primary ?? fallback;
}

/** Per refs array, the hash of each key made from it (by command and the other arguments). */
const refsKeyHashes = new WeakMap<readonly ItemRef[], Map<string, string>>();

/**
 * TanStack's own hash of a `[command, { refs, ... }]` key, worked out once per refs array and
 * the other arguments, so prefetches (bootPrefetch) and readers still share the entry. TanStack
 * hashes a query's key on every render of its observer: the now/next and favourite keys of a
 * page hold 120 refs each, and a list or guide renders on every range change of a scroll, with
 * four of them (two pages) even while they are disabled, as on the guide.
 */
export function refsKeyHash(key: QueryKey): string {
  const args = key[1] as { refs?: readonly ItemRef[] } | null | undefined;
  if (!args || !Array.isArray(args.refs)) return hashKey(key);
  const { refs, ...rest } = args;
  const sub = `${String(key[0])}|${JSON.stringify(rest)}`;
  let byArgs = refsKeyHashes.get(refs);
  if (!byArgs) {
    byArgs = new Map();
    refsKeyHashes.set(refs, byArgs);
  }
  let hash = byArgs.get(sub);
  if (hash === undefined) {
    hash = hashKey(key);
    byArgs.set(sub, hash);
  }
  return hash;
}
