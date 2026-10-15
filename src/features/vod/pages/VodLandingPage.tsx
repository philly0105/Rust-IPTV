import { Clapperboard, ListFilter, Search, SearchX, Tv } from 'lucide-react';
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { itemKey, type SeriesItem, type VodItem } from '@/api/types';

import { CategoryIndex, categoryEntries, type CategoryEntry } from '../components/CategoryIndex';
import { HiddenCategoriesDialog } from '../components/HiddenCategoriesDialog';
import { myListTarget, PosterCard } from '../components/PosterCard';
import { itemLanguage } from '../lib/language';
import { PosterRail } from '../components/PosterRail';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
import { resumeKey, useRecentlyAdded, useResumeMap, useSource } from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { useWatchedKeys } from '../hooks/useWatched';
import { rememberSpot, useScrollMemory } from '../hooks/useScrollMemory';
import { ALL_CATEGORIES, type VodKind } from '../lib/paging';
import { detailHref } from '../lib/search';
import { Button, EmptyState, ErrorState, SearchInput, Skeleton, buttonClass } from '@/ui';

export function VodLandingPage({ kind }: { kind: VodKind }) {
  const { t, i18n } = useTranslation('vod');
  const { sourceId = '' } = useParams();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const source = useSource(sourceId);
  const contentType = kind;
  const section = kind === 'movie' ? 'movies' : 'series';
  const cats = useRpcQuery('catalog.categories', { sourceId, contentType }, { enabled: !!sourceId });
  const allCats = useRpcQuery('catalog.categories', { sourceId, contentType, includeHidden: true }, { enabled: !!sourceId });
  const recent = useRecentlyAdded(source.data, kind);
  const resume = useResumeMap(sourceId, kind);
  const watched = useWatchedKeys(recent.data);

  const title = kind === 'movie' ? t('movies') : t('series');
  usePageHeader(
    {
      title,
      subtitle: source.data?.name,
      actions: (
        <Link to={`/s/${encodeURIComponent(sourceId)}/search`} className={buttonClass('secondary', 'sm')} aria-label={t('searchSource')}>
          <Search aria-hidden size={16} />
          <span className="hidden md:inline">{t('searchSource')}</span>
        </Link>
      ),
    },
    [title, source.data?.name, sourceId],
  );

  const sourceCount = source.data ? (kind === 'movie' ? source.data.movieCount : source.data.seriesCount) : undefined;
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const hiddenCount = (allCats.data ?? []).filter((c) => c.hidden).length;

  const entries = useMemo<CategoryEntry[]>(() => {
    const list = categoryEntries(cats.data ?? [], filter);
    if (filter.trim()) return list;
    const all: CategoryEntry = {
      id: ALL_CATEGORIES,
      name: kind === 'movie' ? t('allMovies') : t('allSeries'),
      emphasis: true,
    };
    if (sourceCount) all.count = sourceCount;
    return [all, ...list];
  }, [cats.data, filter, kind, sourceCount, t]);

  const hrefFor = (id: string) => `/s/${encodeURIComponent(sourceId)}/${section}/c/${encodeURIComponent(id)}`;

  // Back from a category: same scroll offset, focus on the category you opened.
  const { pathname } = useLocation();
  useScrollMemory({
    key: pathname,
    getScroller: () => scrollRef.current,
    ready: !!cats.data && !filter.trim(),
    onRestored: (spot, scroller) => {
      if (spot.index === undefined) return;
      scroller.querySelector<HTMLElement>(`[data-grid-index="${spot.index}"]`)?.focus({ preventScroll: true });
    },
  });
  // Enter on a focused link also fires click, so this covers the keyboard too.
  const rememberCategory = (e: MouseEvent<HTMLElement>) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-grid-index]') : null;
    const index = Number(cell?.dataset['gridIndex']);
    // Indices shift while the filter is on, so only unfiltered positions are kept.
    if (cell && Number.isFinite(index) && !filter.trim()) rememberSpot(pathname, { scrollTop: scrollRef.current?.scrollTop ?? 0, index });
  };

  if (source.isError) {
    return (
      <div className="h-full overflow-y-auto">
        <h1 className="sr-only">{title}</h1>
        {isSourceMissing(source.error) ? <SourceMissing /> : <ErrorState error={source.error} onRetry={() => void source.refetch()} />}
      </div>
    );
  }

  const isEmptySource =
    source.data && source.data.kind !== 'stalker' && sourceCount === 0 && cats.data && cats.data.length === 0 && hiddenCount === 0;

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto" data-testid={`vod-landing-${kind}`}>
      <div className="mx-auto flex w-full max-w-[2200px] flex-col gap-10 px-4 py-6 md:px-8">
        <div className="-mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[clamp(24px,2.4vw,36px)] leading-tight font-semibold text-fg">{title}</h1>
          {source.data && (
            <p className="min-w-0 truncate text-sm text-fg-muted">
              {source.data.name}
              {sourceCount ? (
                <span className="tabular ms-2 text-fg-subtle">{t('titleCount', { count: sourceCount, formatted: fmt.format(sourceCount) })}</span>
              ) : null}
            </p>
          )}
        </div>
        {isEmptySource ? (
          <EmptyState
            icon={kind === 'movie' ? <Clapperboard size={32} /> : <Tv size={32} />}
            title={kind === 'movie' ? t('noMoviesTitle') : t('noSeriesTitle')}
            description={t('noVodDescription')}
            action={
              <Link to="/sources" className={buttonClass('secondary', 'sm')}>
                {t('openSources')}
              </Link>
            }
          />
        ) : (
          <>
            <PosterRail<VodItem | SeriesItem>
              title={t('recentlyAdded')}
              items={recent.data ?? []}
              loading={recent.isPending && !!source.data}
              empty={recent.isError ? <ErrorState size="inline" error={recent.error} onRetry={() => void recent.refetch()} /> : undefined}
              myList={myListTarget}
              render={(item, i, rail) => (
                <PosterCard
                  index={i}
                  tabIndex={rail.tabIndex}
                  title={item.titleBase || item.title}
                  fullTitle={item.title}
                  href={detailHref(item.ref) ?? '#'}
                  posterUrl={item.posterUrl}
                  year={item.year}
                  rating={item.rating}
                  progress={resume.get(resumeKey(item.ref))}
                  watched={watched.has(itemKey(item.ref))}
                  language={itemLanguage(item.title, item.categoryName)}
                  myList={myListTarget(item)}
                  prefetch={
                    source.data
                      ? { ref: item.ref, sourceKind: source.data.kind, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl }
                      : undefined
                  }
                />
              )}
            />

            <section aria-labelledby="vod-categories-heading" className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <h2 id="vod-categories-heading" className="text-base text-fg">
                  {t('categories')}
                </h2>
                {cats.data && (
                  <span className="tabular text-sm text-fg-subtle">{t('categoryCount', { count: cats.data.length })}</span>
                )}
                <div className="ms-auto flex flex-wrap items-center gap-2">
                  <SearchInput
                    value={filter}
                    onChange={setFilter}
                    size="sm"
                    placeholder={t('filterCategories')}
                    className="w-56"
                  />
                  <Button size="sm" variant="secondary" icon={<ListFilter aria-hidden size={15} />} onClick={() => setManageOpen(true)}>
                    {hiddenCount > 0 ? t('manageCategoriesHidden', { count: hiddenCount }) : t('manageCategories')}
                  </Button>
                </div>
              </div>
              {cats.isError ? (
                <ErrorState error={cats.error} onRetry={() => void cats.refetch()} />
              ) : cats.isPending ? (
                <div role="status" aria-busy="true" className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                  <span className="sr-only">{t('loading')}</span>
                  {Array.from({ length: 12 }, (_, i) => (
                    <Skeleton key={i} className="h-11 rounded-md" />
                  ))}
                </div>
              ) : entries.length === 0 ? (
                <EmptyState
                  size="inline"
                  icon={<SearchX size={20} />}
                  title={t('noCategoryMatch')}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setFilter('')}>
                      {t('clearFilter')}
                    </Button>
                  }
                />
              ) : (
                <div onClickCapture={rememberCategory}>
                  <CategoryIndex entries={entries} hrefFor={hrefFor} scrollRef={scrollRef} label={t('categories')} />
                </div>
              )}
            </section>
          </>
        )}
      </div>
      <HiddenCategoriesDialog open={manageOpen} onClose={() => setManageOpen(false)} sourceId={sourceId} contentType={contentType} />
    </div>
  );
}
