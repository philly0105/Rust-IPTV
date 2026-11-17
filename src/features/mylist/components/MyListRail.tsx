/**
 * The dashboard's My List rail (contract C3): saved movies and series in the
 * user's order, a "See all" link to /my-list, and the kit's watched tick on
 * finished titles. Renders nothing when the rail is switched off in Settings or the
 * list is empty; the detail pages and posters carry the invitation to save
 * something instead, so an empty dashboard does not grow an empty shelf.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type WatchlistEntry } from '@/api/types';
import { snapshotTitle } from '@/lib/title';
import { PosterCard, itemPath, joinList } from '@/shell/dashboard/cards';

import { DashboardRail, usePendingRemovals, useSettings } from '../deps';
import { useMyList } from '../hooks/useMyList';
import { MY_LIST_PATH } from '../paths';

/** Same cap as the dashboard's other rails; the page shows everything. */
export const MY_LIST_RAIL_LIMIT = 24;

export interface MyListRailProps {
  /**
   * The dashboard already shows one error for every rail (the server is
   * unreachable): this rail then stays quiet instead of repeating it.
   */
  hideError?: boolean;
}

export function MyListRail({ hideError = false }: MyListRailProps = {}) {
  const { t, i18n } = useTranslation('mylist');
  const settings = useSettings();
  // The command's default staleTime: every write that changes a Watched tag invalidates the key
  // (watchlist.changed, the player's finishing save and the mark-watched actions through
  // invalidateWatched), so a dashboard visit need not re-read it.
  const query = useMyList();
  const hidden = usePendingRemovals((s) => s.ids);
  const items = useMemo<WatchlistEntry[] | undefined>(() => {
    if (!query.data) return undefined;
    const visible = hidden.size > 0 ? query.data.filter((e) => !hidden.has(e.ref.sourceId)) : query.data;
    return visible.slice(0, MY_LIST_RAIL_LIMIT);
  }, [query.data, hidden]);

  if (settings.data?.dashboardRails.myList === false) return null;
  const total = query.data ? query.data.filter((e) => !hidden.has(e.ref.sourceId)).length : 0;

  return (
    <DashboardRail<WatchlistEntry>
      id="my-list"
      title={t('title')}
      items={items}
      loading={query.isPending}
      loaded={query.isSuccess}
      error={hideError ? undefined : (query.error ?? undefined)}
      errorHint={t('errorHint')}
      onRetry={() => void query.refetch()}
      seeAll={{ to: MY_LIST_PATH, label: t('seeAll') }}
      meta={
        total > 0 ? (
          <span className="shrink-0 text-caption text-fg-subtle tabular-nums" data-testid="mylist-rail-count">
            {t('count', { count: total })}
          </span>
        ) : undefined
      }
      getKey={(e) => itemKey(e.ref)}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(e, rail) => {
        const subtitle = e.snapshot.subtitle ?? (e.ref.contentType === 'series' ? t('typeSeries') : t('typeMovie'));
        // Older snapshots hold the provider's raw name ("EN - Heat (1995)"); show what the VOD cards show.
        const title = snapshotTitle(e.ref, e.snapshot.title).title;
        return (
          <PosterCard
            rail={rail}
            title={title}
            subtitle={subtitle}
            posterUrl={e.snapshot.posterUrl}
            to={itemPath(e.ref)}
            myList={{ itemRef: e.ref, snapshot: e.snapshot }}
            // Every title here is saved: the toggle shows on hover and focus only, not on every poster.
            myListMark="hover"
            watched={e.watched}
            ariaLabel={joinList([title, subtitle, e.watched && t('watched')], i18n.language)}
          />
        );
      }}
    />
  );
}
