/**
 * `CustomListRails`: the Home page's custom-list rails. The Home page is in
 * the entry chunk, so this module only reads `lists.list`; the rails
 * themselves (cards, guide, playback) are a separate chunk, fetched once some
 * list has "Show on Home" switched on. Nothing extra loads for everyone else.
 */

import { lazy, Suspense } from 'react';

import { useLists } from './hooks/useLists';

const ListRails = lazy(async () => ({ default: (await import('./components/ListRails')).ListRails }));

/** One `DashboardRail` per list with Show on Home, in list order; null when there is none. */
export function CustomListRails() {
  const lists = useLists();
  const shown = (lists.data ?? []).filter((l) => l.onDashboard);
  if (shown.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <ListRails lists={shown} />
    </Suspense>
  );
}
