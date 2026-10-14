/**
 * The /my-list toolbar: the type filter as pill tabs with counts, then the
 * sort and the Hide watched switch. It wraps onto two lines on a phone and
 * keeps one line from about 640 px up.
 */

import { useTranslation } from 'react-i18next';

import { Select, Tabs, Toggle, cn } from '../deps';
import { FILTERS, SORTS, type MyListFilter, type MyListSort } from '../lib/list';

export interface MyListToolbarProps {
  filter: MyListFilter;
  sort: MyListSort;
  hideWatched: boolean;
  counts: Record<MyListFilter, number>;
  /** Watched entries in the current filter; the switch shows only when there are some (or it is on). */
  watchedCount: number;
  onFilter: (f: MyListFilter) => void;
  onSort: (s: MyListSort) => void;
  onHideWatched: (on: boolean) => void;
  className?: string;
}

const FILTER_KEY: Record<MyListFilter, string> = { all: 'filterAll', movie: 'filterMovies', series: 'filterSeries' };
const SORT_KEY: Record<MyListSort, string> = { order: 'sortOrder', added: 'sortAdded', title: 'sortTitle' };

export function MyListToolbar({
  filter,
  sort,
  hideWatched,
  counts,
  watchedCount,
  onFilter,
  onSort,
  onHideWatched,
  className,
}: MyListToolbarProps) {
  const { t, i18n } = useTranslation('mylist');
  const nf = new Intl.NumberFormat(i18n.language);
  return (
    <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-3', className)} data-testid="mylist-toolbar">
      <Tabs
        variant="pill"
        label={t('filterLabel')}
        value={filter}
        onChange={(id) => onFilter(id as MyListFilter)}
        items={FILTERS.map((f) => ({
          id: f,
          label: t(FILTER_KEY[f]),
          badge: nf.format(counts[f]),
        }))}
      />
      <div className="ms-auto flex flex-wrap items-center gap-x-5 gap-y-2">
        {(watchedCount > 0 || hideWatched) && (
          <Toggle
            checked={hideWatched}
            onChange={onHideWatched}
            label={t('hideWatched')}
            className="items-center gap-3"
          />
        )}
        <Select
          aria-label={t('sortLabel')}
          value={sort}
          onValueChange={(v) => onSort(v as MyListSort)}
          options={SORTS.map((s) => ({ value: s, label: t(SORT_KEY[s]) }))}
          className="h-9 min-w-[11rem]"
          data-testid="mylist-sort"
        />
      </div>
    </div>
  );
}
