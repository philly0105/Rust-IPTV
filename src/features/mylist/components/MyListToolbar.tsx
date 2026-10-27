/**
 * The /my-list toolbar: the type filter as pill tabs with counts, then the
 * search, the Hide watched switch, the sort and the grid/list switch. The search lives here rather
 * than in the shell header, so a phone-width header keeps room for the page
 * title (as on the category grid); Ctrl+F finds it through `data-page-search`.
 * On a phone the tabs, the search and the other two controls take a line
 * each; from about 1000 px up everything fits on one line. Every control is
 * the md height (37.5 px at 100 %), the height the pill tabs and the view
 * switch have: the search at sm and the sort at h-9 left three heights in one
 * row.
 */

import { LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { intlLocale, numberFormat } from '@/lib/intl';

import { SearchInput, SegmentedControl, Select, Tabs, Toggle, cn } from '../deps';
import { FILTERS, SORTS, type MyListFilter, type MyListSort } from '../lib/list';
import type { MyListView } from '../lib/view';

export interface MyListToolbarProps {
  filter: MyListFilter;
  sort: MyListSort;
  hideWatched: boolean;
  counts: Record<MyListFilter, number>;
  /** Watched entries in the current filter; the switch shows only when there are some (or it is on). */
  watchedCount: number;
  /** The search text (mirrored in the URL by the page). */
  query: string;
  onQuery: (q: string) => void;
  /** Enter or ArrowDown in the search box: move on to the list. */
  onLeaveSearch?: () => void;
  onFilter: (f: MyListFilter) => void;
  onSort: (s: MyListSort) => void;
  onHideWatched: (on: boolean) => void;
  /** Grid or list; the switch shows when `onView` is given. */
  view?: MyListView;
  onView?: (view: MyListView) => void;
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
  query,
  onQuery,
  onLeaveSearch,
  onFilter,
  onSort,
  onHideWatched,
  view = 'grid',
  onView,
  className,
}: MyListToolbarProps) {
  const { t, i18n } = useTranslation('mylist');
  const nf = numberFormat(intlLocale(i18n.language));
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
      {/* L4-vod-5: below sm, Hide watched and the sort menu share one row; the menu takes the rest of it. */}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-5 lg:ms-auto lg:w-auto">
        <SearchInput
          value={query}
          onChange={onQuery}
          onSubmit={() => onLeaveSearch?.()}
          onKeyDown={(e) => {
            // ArrowDown leaves the search box for the list, as on the category grid.
            if (e.key === 'ArrowDown' && onLeaveSearch) {
              e.preventDefault();
              onLeaveSearch();
            }
          }}
          placeholder={t('searchPlaceholder')}
          // Below sm the search shares its line with the grid/list switch only.
          className="min-w-0 flex-1 basis-[calc(100%-6rem)] sm:basis-auto sm:min-w-48 lg:w-56 lg:flex-none"
          data-page-search=""
          data-testid="mylist-search"
        />
        {onView && (
          <SegmentedControl<MyListView>
            label={t('viewLabel')}
            value={view}
            onChange={onView}
            // Beside the search on a phone, at the end of the toolbar from lg up.
            className="shrink-0 lg:order-last"
            itemClassName="px-2"
            testId="mylist-view"
            options={[
              { value: 'grid', label: t('viewGrid'), content: <LayoutGrid aria-hidden size={16} /> },
              { value: 'list', label: t('viewList'), content: <List aria-hidden size={16} /> },
            ]}
          />
        )}
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
          wrapperClassName="ms-auto min-w-0 flex-1 sm:flex-none"
          className="sm:min-w-[11rem]"
          data-testid="mylist-sort"
        />
      </div>
    </div>
  );
}
