import { ArrowDownWideNarrow, ArrowLeft, ArrowUpNarrowWide, Clapperboard, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { useQueryClient } from '@tanstack/react-query';

import { useRpcQuery } from '@/api/query';
import type { CoverSize, ItemRef } from '@/api/types';

import { PosterCard, PosterCardSkeleton } from '../components/PosterCard';
import { useSettings, useSource, useVodPage } from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import {
  ALL_CATEGORIES,
  VOD_SORT_KEYS,
  buildPageRequest,
  defaultDir,
  pageOf,
  pageSizeFor,
  readGridParams,
  type GridQueryInput,
  type VodKind,
  type VodSortKey,
} from '../lib/paging';
import { detailHref } from '../lib/search';
import { EmptyState, ErrorState, IconButton, SearchInput, Select, SkeletonGrid, VirtualGrid, buttonClass } from '../_shim';

export const COVER_WIDTH: Record<CoverSize, number> = { small: 128, medium: 164, large: 212 };
const SEARCH_DEBOUNCE_MS = 250;

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
  const { t } = useTranslation('vod');
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

  const input = useMemo<GridQueryInput | undefined>(
    () =>
      source.data
        ? { sourceKind: source.data.kind, kind, sourceId, categoryId, sort, dir, search }
        : undefined,
    [source.data, kind, sourceId, categoryId, sort, dir, search],
  );
  const first = useVodPage(input, 0);
  const total = first.data?.total ?? 0;
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
      subtitle: source.data ? `${source.data.name}${first.data ? `  ${t('titleCount', { count: total, formatted: fmt.format(total) })}` : ''}` : undefined,
    },
    [pageTitle, source.data?.name, first.data ? total : -1],
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
          {first.data && (
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

      <div className="min-h-0 flex-1 px-4 pt-4 md:px-8">
        {source.isError || first.isError ? (
          <ErrorState
            error={source.error ?? first.error}
            onRetry={() => {
              void source.refetch();
              void first.refetch();
            }}
          />
        ) : !input || first.isPending ? (
          <SkeletonGrid count={18} minColumnWidth={coverWidth} />
        ) : total === 0 ? (
          search ? (
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
        ) : (
          <VirtualGrid<number>
            key={`${categoryId}|${sort}|${dir}|${search}`}
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

