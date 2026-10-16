import { Clapperboard, ListFilter, SearchX, Tv } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { itemKey, type SeriesItem, type VodItem } from '@/api/types';
// The module itself, not the player barrel: small, no imports, already in the player core chunk.
import { preloadEngines } from '@/features/player/enginePreload';

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
import { useVodLocks } from '../hooks/useVodLocks';
import { loadSearchPage } from '../routes';
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
  const locks = useVodLocks(sourceId, kind);

  const title = kind === 'movie' ? t('movies') : t('series');
  const sourceCount = source.data ? (kind === 'movie' ? source.data.movieCount : source.data.seriesCount) : undefined;
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const countText = sourceCount ? t('titleCount', { count: sourceCount, formatted: fmt.format(sourceCount) }) : undefined;
  const sourceLine = source.data ? (countText ? `${source.data.name} · ${countText}` : source.data.name) : undefined;

  // One search entry (L1-visual-13): the header field searches this source. Typing opens the
  // source's search page with the text so far; the field stays in the header there, so focus and
  // the caret carry over. Later keystrokes before it opens replace that entry instead of stacking.
  const navigate = useNavigate();
  const [searchDraft, setSearchDraft] = useState('');
  const searchStarted = useRef(false);
  const onSearch = (v: string) => {
    setSearchDraft(v);
    if (!v.trim()) return;
    void navigate(`/s/${encodeURIComponent(sourceId)}/search?q=${encodeURIComponent(v)}`, { replace: searchStarted.current });
    searchStarted.current = true;
  };
  // Warm the search page while the landing idles, so the first keystroke opens it at once.
  useEffect(() => {
    const warm = () => void loadSearchPage().catch(() => undefined);
    if (typeof requestIdleCallback === 'function') {
      const h = requestIdleCallback(warm);
      return () => cancelIdleCallback(h);
    }
    const h = setTimeout(warm, 200);
    return () => clearTimeout(h);
  }, []);
  // VOD starts here: warm hls.js and mpegts.js once the browser is idle (preloadEngines waits for
  // it), so the first movie or episode play does not fetch them after the click.
  useEffect(() => preloadEngines(), []);
  const searchPlaceholder = source.data ? t('searchInSource', { source: source.data.name }) : t('searchSource');
  usePageHeader(
    {
      title,
      subtitle: sourceLine,
      search: { value: searchDraft, onChange: onSearch, placeholder: searchPlaceholder, onSubmit: onSearch },
    },
    [title, sourceLine, searchDraft, searchPlaceholder, sourceId],
  );
  const hiddenCount = (allCats.data ?? []).filter((c) => c.hidden).length;

  const entries = useMemo<CategoryEntry[]>(() => {
    const list = categoryEntries(cats.data ?? [], filter).map((e) => (locks.categoryLocked(e.id) ? { ...e, locked: true } : e));
    if (filter.trim()) return list;
    const all: CategoryEntry = {
      id: ALL_CATEGORIES,
      name: kind === 'movie' ? t('allMovies') : t('allSeries'),
      emphasis: true,
    };
    if (sourceCount) all.count = sourceCount;
    return [all, ...list];
  }, [cats.data, filter, kind, sourceCount, t, locks]);

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
        {/* The shell header shows the title, the source and the count (one place, L1-visual-13). Its
            subtitle folds away below md, so only there the source line shows here. */}
        <h1 className="sr-only">{title}</h1>
        {sourceLine && <p className="-mb-6 min-w-0 truncate text-sm text-fg-muted md:hidden">{sourceLine}</p>}
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
              // Placeholder cards from the first frame (L2-vod-5): the rail never pops in and pushes the categories down.
              loading={recent.isPending}
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
                  locked={locks.itemLocked(item)}
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
                  <CategoryIndex entries={entries} hrefFor={hrefFor} scrollRef={scrollRef} label={t('categories')} lockedLabel={t('locked')} />
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
