/**
 * Quick picks: live channels watched lately or kept as favorites, offered in the wall's next free
 * slot so one click puts one up (the picker stays a click further for anything else).
 */

import { useMemo } from 'react';

import { useRpcQuery } from '@/api/query';
import { itemKey, type ItemRef } from '@/api/types';

import type { MultiviewTile } from './types';

/** Most quick picks a free slot offers. */
export const QUICK_PICKS = 3;

export interface QuickPick {
  ref: ItemRef;
  title: string;
  logo?: string;
}

/** A channel name as the quick picks compare it: case, spacing and width variants do not count. */
export function pickName(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Live channels from Recent, then Favorites, without repeats and without what is already on the
 * wall; `loading` until both lists answered. A repeat is the same channel, or one with the same
 * name from another source (two playlists that both carry France 24 English): two identical rows
 * would not say which is which, so only the first, the most recently watched, is offered
 * (L3-visual-13). A channel on the wall is left out the same way, by itself or by its name.
 */
export function useQuickPicks(tiles: readonly MultiviewTile[]): { picks: QuickPick[]; loading: boolean } {
  const recent = useRpcQuery('recent.list', { limit: 24 }, { staleTime: 30_000 });
  const favorites = useRpcQuery('favorites.list', {}, { staleTime: 30_000 });
  const picks = useMemo(() => {
    const out: QuickPick[] = [];
    const seen = new Set<string>(tiles.map((x) => itemKey(x.ref)));
    const names = new Set<string>(tiles.map((x) => pickName(x.title)));
    for (const e of [...(recent.data ?? []), ...(favorites.data ?? [])]) {
      if (out.length >= QUICK_PICKS) break;
      if (e.ref.contentType !== 'live' || e.snapshot.contentType !== 'live') continue;
      const k = itemKey(e.ref);
      const name = pickName(e.snapshot.title);
      if (seen.has(k) || names.has(name)) continue;
      seen.add(k);
      names.add(name);
      out.push(e.snapshot.posterUrl ? { ref: e.ref, title: e.snapshot.title, logo: e.snapshot.posterUrl } : { ref: e.ref, title: e.snapshot.title });
    }
    return out;
  }, [recent.data, favorites.data, tiles]);
  return { picks, loading: recent.isPending || favorites.isPending };
}
