import type { QueryClient } from '@tanstack/react-query';

/**
 * "This rail loaded empty last time" flags. A flagged rail skips its loading
 * skeleton on the next dashboard visit (it would most likely just collapse).
 * Set only by a rail whose own query succeeded with no items; cleared as soon
 * as data for that rail shows up anywhere in the query cache. The hero keeps
 * one too (`hero`, SH-hero-skeleton-flash): a new or M3U-only user has nothing
 * to rotate, and its 22rem placeholder showed and collapsed on every start.
 */
const RAIL_EMPTY_KEY = 'tsrust.dashRailEmpty.';

export function readRailEmpty(id: string): boolean {
  try {
    return localStorage.getItem(RAIL_EMPTY_KEY + id) === '1';
  } catch {
    return false;
  }
}

export function writeRailEmpty(id: string, empty: boolean): void {
  try {
    if (empty) localStorage.setItem(RAIL_EMPTY_KEY + id, '1');
    else localStorage.removeItem(RAIL_EMPTY_KEY + id);
  } catch {
    // Storage unavailable (private mode): rails just keep their skeletons.
  }
}

type Ref = { ref?: { contentType?: string } };
const isLive = (x: Ref) => x.ref?.contentType === 'live' || x.ref?.contentType === 'radio';
const isVod = (x: Ref) => x.ref?.contentType === 'movie' || x.ref?.contentType === 'series';

/** Which dashboard rails a successful query result feeds, given its data. Exported for tests. */
export function railsWithContent(cmd: string, data: unknown): string[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  const list = data as Ref[];
  switch (cmd) {
    case 'positions.continueWatching':
      return ['continue-watching', 'hero'];
    case 'favorites.list':
      return [...(list.some(isLive) ? ['live-favorites'] : []), ...(list.some(isVod) ? ['favorite-vod'] : [])];
    case 'recent.list':
      return list.some(isLive) ? ['recent-live'] : [];
    case 'catalog.recentlyAdded':
      return ['recently-added', 'hero'];
    default:
      return [];
  }
}

/**
 * Clears a rail's flag whenever any page loads data for it (the Favorites page
 * after a first favorite, Recent after playback, the dashboard itself), so a
 * rail that gained content shows its skeleton again next launch. Returns the
 * unsubscribe function.
 */
export function bindRailEmptySync(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const cmd = event.query.queryKey[0];
    if (typeof cmd !== 'string') return;
    for (const id of railsWithContent(cmd, event.query.state.data)) writeRailEmpty(id, false);
  });
}
