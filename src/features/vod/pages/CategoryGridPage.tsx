import { ArrowDownWideNarrow, ArrowLeft, ArrowUpNarrowWide, Clapperboard, SearchX, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { useQueryClient } from '@tanstack/react-query';

import { useRpcQuery } from '@/api/query';
import type { CoverSize, ItemRef, SeriesItem, VodItem } from '@/api/types';

import { PosterCard, PosterCardSkeleton } from '../components/PosterCard';
import { useSettings, useSource, useVodPage, useVodPagesInOrder } from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatRating } from '../lib/format';
import {
  ALL_CATEGORIES,
  ALL_RATINGS_PARAM,
  VOD_SORT_KEYS,
  buildPageRequest,
  defaultDir,
  effectiveMinRating,
  filterByRating,
  pageOf,
  pageSizeFor,
  ratingFilterInCore,
  readGridParams,
  type GridQueryInput,
  type VodKind,
  type VodSortKey,
} from '../lib/paging';
import { detailHref } from '../lib/search';
import { EmptyState, ErrorState, IconButton, SearchInput, Select, SkeletonGrid, VirtualGrid, buttonClass } from '@/ui';

export const COVER_WIDTH: Record<CoverSize, number> = { small: 128, medium: 164, large: 212 };
const SEARCH_DEBOUNCE_MS = 250;

/** Below this many visible titles, a rating-filtered Stalker grid keeps loading pages on its own. */
const FILTERED_MIN_VISIBLE = 60;

/** One grid cell: subscribes to the page that contains `index`, so only pages near the viewport stay loaded. */
function GridCell({ input, index, pageSize, active }: { input: GridQueryInput; index: number; pageSize: number; active: boolean }) {
  const page = pageOf(index, pageSize);
  const q = useVodPage(input, page);
  const item = q.data?.items[index - page * pageSize];
  if (!item) return <PosterCardSkeleton />;
  return (
    <PosterCard
      tabIndex={-1}
      active={active}
      title={item.title}
      href={detailHref(item.ref) ?? '#'}
      posterUrl={item.posterUrl}
      year={item.year}
      rating={item.rating}
    />
  );
}

export function CategoryGridPage({ kind }: { kind: VodKind }) {
  const { t, i18n } = useTranslation('vod');
  const navigate = useNavigate();
  const { sourceId = '', categoryId = ALL_CATEGORIES } = useParams();
  const [params, setParams] = useSearchParams();
  const { sort, dir, search } = readGridParams(params);
  const [searchDraft, setSearchDraft] = useState(search);
  const settings = useSettings();
  const source = useSource(sourceId);
  const cats = useRpcQuery('catalog.categories', { sourceId, contentType: kind, includeHidden: true }, { enabled: !!sourceId });
  const section = kind === 'movie' ? 'movies' : 'series';

  // URL is the source of truth for search; the input debounces into it.
  useEffect(() => setSearchDraft(search), [search]);
  useEffect(() => {
    if (searchDraft.trim() === search.trim()) return;
    const h = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (searchDraft.trim()) next.set('q', searchDraft.trim());
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [searchDraft, search, setParams]);

  const setSort = (s: VodSortKey) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('sort', s);
      next.set('dir', defaultDir(s));
      return next;
    });
  const flipDir = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('sort', sort);
      next.set('dir', dir === 'asc' ? 'desc' : 'asc');
      return next;
    });

  const settingMinRating = effectiveMinRating(settings.vodMinRating, new URLSearchParams());
  const minRating = effectiveMinRating(settingMinRating, params);
  const ratingFilterSet = settingMinRating > 0;
  const filtered = minRating > 0;
  const input = useMemo<GridQueryInput | undefined>(
    () =>
      source.data
        ? { sourceKind: source.data.kind, kind, sourceId, categoryId, sort, dir, search, minRating }
        : undefined,
    [source.data, kind, sourceId, categoryId, sort, dir, search, minRating],
  );
  // m3u/xtream filter in SQLite and page like any grid. Stalker portals cannot
  // filter by rating, so only there the grid loads pages in order and filters them.
  const clientFiltered = filtered && !!source.data && !ratingFilterInCore(source.data.kind);
  const inOrder = useVodPagesInOrder(input, clientFiltered);
  const filteredItems = useMemo(
    () => (clientFiltered ? filterByRating((inOrder.data?.pages ?? []).flatMap((p) => p.items), minRating) : []),
    [clientFiltered, inOrder.data, minRating],
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = inOrder;
  // Keep loading while the filter leaves too few titles to fill the view.
  useEffect(() => {
    if (clientFiltered && hasNextPage && !isFetchingNextPage && filteredItems.length < FILTERED_MIN_VISIBLE) void fetchNextPage();
  }, [clientFiltered, hasNextPage, isFetchingNextPage, filteredItems.length, fetchNextPage]);
  const setAllRatings = (all: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (all) next.set(ALL_RATINGS_PARAM, 'all');
        else next.delete(ALL_RATINGS_PARAM);
        return next;
      },
      { replace: true },
    );

  const first = useVodPage(clientFiltered ? undefined : input, 0);
  // With the client-side filter, the count is known only once every page has arrived.
  const filteredDone = clientFiltered && inOrder.isSuccess && !hasNextPage;
  const total = clientFiltered ? filteredItems.length : (first.data?.total ?? 0);
  const firstReady = clientFiltered ? filteredDone : !!first.data;
  const indices = useMemo(() => Array.from({ length: total }, (_, i) => i), [total]);
  const pageSize = pageSizeFor(source.data?.kind ?? 'xtream');

  const qc = useQueryClient();
  /** Item at a grid index, read from the page cache (Enter on the keyboard cursor). */
  const queryItem = (i: number) => {
    if (!input) return undefined;
    const page = pageOf(i, pageSize);
    const { cmd, args } = buildPageRequest(input, page);
    const data = qc.getQueryData<{ items: { ref: ItemRef }[] }>([cmd, args]);
    return data?.items[i - page * pageSize];
  };

  const category = cats.data?.find((c) => c.id === categoryId);
  const categoryName =
    categoryId === ALL_CATEGORIES ? (kind === 'movie' ? t('allMovies') : t('allSeries')) : (category?.name ?? '');
  const fmt = useMemo(() => new Intl.NumberFormat(), []);
  // One string for the page h1 and the shell header title (C16), so they always agree.
  const pageTitle = categoryName || (kind === 'movie' ? t('movies') : t('series'));

  usePageHeader(
    {
      title: pageTitle,
      subtitle: source.data ? `${source.data.name}${firstReady ? `  ${t('titleCount', { count: total, formatted: fmt.format(total) })}` : ''}` : undefined,
    },
    [pageTitle, source.data?.name, firstReady ? total : -1],
  );

  const sortOptions = VOD_SORT_KEYS.map((k) => ({ value: k, label: t(`sort_${k}`) }));
  const coverWidth = COVER_WIDTH[settings.coverSize] ?? COVER_WIDTH.medium;
  const backHref = `/s/${encodeURIComponent(sourceId)}/${section}`;
  const dirLabel = dir === 'asc' ? t('sortAscending') : t('sortDescending');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`vod-grid-${kind}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 md:px-8">
        <Link to={backHref} className={buttonClass('ghost', 'sm')}>
          <ArrowLeft aria-hidden size={16} />
          {kind === 'movie' ? t('movies') : t('series')}
        </Link>
        <div className="mr-auto flex min-w-0 items-baseline gap-3">
          <h1 className="min-w-0 truncate text-lg text-fg">{pageTitle}</h1>
          {firstReady && (
            <span className="tabular shrink-0 text-sm font-normal text-fg-subtle">
              {fmt.format(total)}
            </span>
          )}
        </div>
        <SearchInput
          value={searchDraft}
          onChange={setSearchDraft}
          size="sm"
          className="w-full sm:w-64"
          placeholder={t('searchInCategory')}
        />
        <Select
          aria-label={t('sortBy')}
          options={sortOptions}
          value={sort}
          onValueChange={(v) => setSort(v as VodSortKey)}
          className="h-8 w-36"
        />
        <IconButton
          size="sm"
          variant="secondary"
          label={dirLabel}
          icon={dir === 'asc' ? <ArrowUpNarrowWide aria-hidden size={16} /> : <ArrowDownWideNarrow aria-hidden size={16} />}
          onClick={flipDir}
        />
      </div>

      {ratingFilterSet && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2 text-sm text-fg-muted md:px-8" data-testid="vod-rating-filter">
          <Star aria-hidden size={14} className="fill-current text-accent" />
          {filtered ? (
            <>
              <span>{t('ratingFilterNote', { rating: formatRating(minRating, i18n.language) })}</span>
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => setAllRatings(true)}>
                {t('ratingFilterClear')}
              </button>
            </>
          ) : (
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setAllRatings(false)}>
              {t('ratingFilterApply', { rating: formatRating(settingMinRating, i18n.language) })}
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 px-4 pt-4 md:px-8">
        {source.isError || (clientFiltered ? inOrder.isError : first.isError) ? (
          <ErrorState
            error={source.error ?? (clientFiltered ? inOrder.error : first.error)}
            onRetry={() => {
              void source.refetch();
              void (clientFiltered ? inOrder.refetch() : first.refetch());
            }}
          />
        ) : !input || (clientFiltered ? inOrder.isPending || (filteredItems.length === 0 && !filteredDone) : first.isPending) ? (
          <SkeletonGrid count={18} minColumnWidth={coverWidth} />
        ) : total === 0 ? (
          filtered ? (
            <EmptyState
              icon={<Star size={32} />}
              title={t('ratingFilterEmptyTitle', { rating: formatRating(minRating, i18n.language) })}
              description={t('ratingFilterEmptyHint')}
              action={
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setAllRatings(true)}>
                  {t('ratingFilterClear')}
                </button>
              }
            />
          ) : search ? (
            <EmptyState
              icon={<SearchX size={32} />}
              title={t('noSearchMatchTitle', { query: search })}
              description={t('noSearchMatchHint')}
              action={
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setSearchDraft('')}>
                  {t('clearSearch')}
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<Clapperboard size={32} />}
              title={t('emptyCategoryTitle')}
              description={t('emptyCategoryHint')}
              action={
                <Link to={backHref} className={buttonClass('secondary', 'sm')}>
                  {t('backToCategories')}
                </Link>
              }
            />
          )
        ) : clientFiltered ? (
          <VirtualGrid<VodItem | SeriesItem>
            key={`${categoryId}|${sort}|${dir}|${search}|${minRating}`}
            items={filteredItems}
            minColumnWidth={coverWidth}
            aspect="poster"
            label={categoryName}
            testId="vod-grid"
            getKey={(item) => item.ref.itemId}
            render={(item, _index, state) => (
              <PosterCard
                tabIndex={-1}
                active={state.active}
                title={item.title}
                href={detailHref(item.ref) ?? '#'}
                posterUrl={item.posterUrl}
                year={item.year}
                rating={item.rating}
              />
            )}
            onEndReached={() => {
              if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
            }}
            footer={
              isFetchingNextPage ? (
                <p role="status" className="py-4 text-center text-sm text-fg-subtle">
                  {t('ratingFilterLoading')}
                </p>
              ) : undefined
            }
            onSelect={(item) => {
              const href = detailHref(item.ref);
              if (href) navigate(href);
            }}
            className="rounded-md pb-8 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        ) : (
          <VirtualGrid<number>
            key={`${categoryId}|${sort}|${dir}|${search}|${minRating}`}
            items={indices}
            minColumnWidth={coverWidth}
            aspect="poster"
            label={categoryName}
            testId="vod-grid"
            render={(i, _index, state) => <GridCell input={input} index={i} pageSize={pageSize} active={state.active} />}
            onSelect={(i) => {
              const item = queryItem(i);
              const href = item && detailHref(item.ref);
              if (href) navigate(href);
            }}
            className="rounded-md pb-8 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        )}
      </div>
    </div>
  );
}

