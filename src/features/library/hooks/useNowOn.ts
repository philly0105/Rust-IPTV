/**
 * What is on air now for the live and radio entries of a library page (Favorites, Recently
 * watched), so a row can say "Business Close, 7 min left" instead of repeating "Live channel" under
 * a heading that already says it. One `epg.nowNext` call for the page, titles and times only (no
 * descriptions, as the dashboard's channel cards ask); a minute clock moves the progress, and a
 * programme that has ended refetches the answer.
 */

import { useEffect, useMemo, useState } from 'react';

import { invalidate, useRpcQuery } from '@/api/query';
import { itemKey, type ItemRef } from '@/api/types';

import { useSettings } from '../deps';

export interface NowOn {
  title: string;
  /** 0..1 through the programme. */
  progress: number;
  leftSeconds: number;
}

/** A page asks for at most this many channels: the first screenfuls, not a whole 500-entry history. */
export const NOW_ON_LIMIT = 120;

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** `entries`: the page's refs in display order; only live and radio ones are asked about. */
export function useNowOn(entries: readonly ItemRef[]): ReadonlyMap<string, NowOn> {
  const offset = useSettings().data?.epgOffsetMinutes ?? 0;
  const refs = useMemo(() => {
    const seen = new Set<string>();
    const out: ItemRef[] = [];
    for (const r of entries) {
      if (r.contentType !== 'live' && r.contentType !== 'radio') continue;
      const key = itemKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= NOW_ON_LIMIT) break;
    }
    return out;
  }, [entries]);
  const query = useRpcQuery(
    'epg.nowNext',
    offset ? { refs, offsetMinutes: offset, withDescription: false } : { refs, withDescription: false },
    { enabled: refs.length > 0, staleTime: 60_000 },
  );
  const clock = useMinuteClock();

  const map = useMemo(() => {
    const out = new Map<string, NowOn>();
    const at = clock - offset * 60_000;
    for (const [key, nn] of Object.entries(query.data ?? {})) {
      const p = nn.now;
      if (!p) continue;
      const s = Date.parse(p.start);
      const e = Date.parse(p.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || at >= e) continue;
      out.set(key, { title: p.title, progress: Math.max(0, Math.min(1, (at - s) / (e - s))), leftSeconds: Math.max(0, (e - at) / 1000) });
    }
    return out;
  }, [query.data, clock, offset]);

  // A programme that ended since the answer came: ask again, so the next one shows.
  const stale = useMemo(() => {
    const at = clock - offset * 60_000;
    return Object.values(query.data ?? {}).some((nn) => nn.now && Date.parse(nn.now.end) <= at);
  }, [query.data, clock, offset]);
  useEffect(() => {
    if (stale) void invalidate('epg.nowNext');
  }, [stale]);

  return map;
}
