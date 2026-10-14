/**
 * The dashboard's My List rail (contract C3): saved movies and series in the
 * user's order, a "See all" link to /my-list, and a Watched tag on finished
 * titles. Renders nothing when the rail is switched off in Settings or the
 * list is empty; the detail pages and posters carry the invitation to save
 * something instead, so an empty dashboard does not grow an empty shelf.
 */

import { Check } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type WatchlistEntry } from '@/api/types';

import { DashboardRail, PosterCard, itemPath, joinList, usePendingRemovals, useSettings } from '../deps';
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
  // staleTime 0: watched tags change from the player, so a dashboard visit re-reads them.
  const query = useMyList({ staleTime: 0 });
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
          <span className="shrink-0 text-sm text-fg-subtle tabular" data-testid="mylist-rail-count">
            {t('count', { count: total })}
          </span>
        ) : undefined
      }
      getKey={(e) => itemKey(e.ref)}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(e, rail) => {
        const subtitle = e.snapshot.subtitle ?? (e.ref.contentType === 'series' ? t('typeSeries') : t('typeMovie'));
        return (
          <PosterCard
            rail={rail}
            title={e.snapshot.title}
            subtitle={subtitle}
            posterUrl={e.snapshot.posterUrl}
            to={itemPath(e.ref)}
            badge={e.watched ? <WatchedTag label={t('watched')} /> : undefined}
            ariaLabel={joinList([e.snapshot.title, subtitle, e.watched && t('watched')], i18n.language)}
          />
        );
      }}
    />
  );
}

/** Frosted tag over the artwork: readable on any poster. */
function WatchedTag({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border border-glass-border bg-glass px-1.5 py-0.5 text-[calc(11rem/15)] font-medium leading-4 text-on-glass backdrop-blur-glass"
      data-testid="mylist-watched-tag"
    >
      <Check aria-hidden size={12} strokeWidth={2.75} className="text-success" />
      {label}
    </span>
  );
}
