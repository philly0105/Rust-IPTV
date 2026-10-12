import type { EpgNowNext, EpgProgram } from '@/api/types';

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

/** Airing and following programme at `now`, from any (unsorted) list. */
export function nowNextFrom(programs: readonly EpgProgram[] | undefined, now: number): EpgNowNext | undefined {
  if (!programs || programs.length === 0) return undefined;
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
