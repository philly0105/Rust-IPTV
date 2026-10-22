import { ChevronRight, Clapperboard, ListFilter, Lock, SearchX, Tv } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { categoriesArgs } from '@/api/bootPrefetch';
import { useRpcQuery } from '@/api/query';
import { itemKey, type Category, type ItemSnapshot, type PlaybackPosition, type SeriesItem, type SourceKind, type VodItem } from '@/api/types';
// The module itself, not the player barrel: small, no imports, already in the player core chunk.
import { preloadEngines } from '@/features/player/enginePreload';
import { snapshotTitle } from '@/lib/title';

import { CatalogRail } from '../components/CatalogRail';
import { CategoryIndex, FROM_LANDING, categoryEntries, type CategoryEntry } from '../components/CategoryIndex';
import { HiddenCategoriesDialog } from '../components/HiddenCategoriesDialog';
import { myListTarget, PosterCard } from '../components/PosterCard';
import { itemLanguage } from '../lib/language';
import { PosterRail, type RailCardProps } from '../components/PosterRail';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
import { resumeKey, useRecentlyAdded, useResumeMap, useSectionContinue, useSettings, useSource } from '../hooks/queries';
import { useEdgeFades } from '../hooks/useEdgeFades';
import { usePageHeader } from '../hooks/usePageHeader';
import { useWatchedKeys } from '../hooks/useWatched';
import { rememberSpot, useScrollMemory } from '../hooks/useScrollMemory';
import { useVodLocks, type VodLocks } from '../hooks/useVodLocks';
import { loadSearchPage } from '../routes';
import { ALL_CATEGORIES, effectiveMinRating, type GridQueryInput, type VodKind } from '../lib/paging';
import { detailHref } from '../lib/search';
import { Button, EmptyState, ErrorState, IconButton, Page, SearchInput, Skeleton, buttonClass, cn, filterChipClass } from '@/ui';
import { intlLocale } from '@/lib/intl';

/** Category rails under the top rails; the rest of the categories are one click away in the index. */
export const CATEGORY_RAIL_LIMIT = 12;

/** Category chips in the row under the header; "All categories" at its start opens the whole index. */
export const CATEGORY_CHIP_LIMIT = 24;

/** Whether "Browse all categories" is open, kept between visits (a UI preference, so localStorage). */
export const CATEGORY_INDEX_KEY = 'vod.categoryIndexOpen';

function readIndexOpen(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CATEGORY_INDEX_KEY) === '1';
  } catch {
    return false;
  }
}

function writeIndexOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(CATEGORY_INDEX_KEY, '1');
    else localStorage.removeItem(CATEGORY_INDEX_KEY);
  } catch {
    // Storage full or blocked: the disclosure still works for this visit.
  }
}

export function VodLandingPage({ kind }: { kind: VodKind }) {
  const { t, i18n } = useTranslation('vod');
  const { sourceId = '' } = useParams();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [indexOpen, setIndexOpenState] = useState(readIndexOpen);
  const setIndexOpen = (open: boolean) => {
    writeIndexOpen(open);
    setIndexOpenState(open);
  };
  // "All categories" in the chip row opens the index under the rails and takes you there.
  const indexToggleRef = useRef<HTMLButtonElement>(null);
  const [indexVisits, setIndexVisits] = useState(0);
  const showIndex = () => {
    setIndexOpen(true);
    setIndexVisits((n) => n + 1);
  };
  useEffect(() => {
    const toggle = indexToggleRef.current;
    if (!indexVisits || !toggle) return;
    // The heading at the top of the view, and focus on its disclosure (now expanded), so Tab
    // goes on to the filter and the list.
    toggle.scrollIntoView({ block: 'start' });
    toggle.focus({ preventScroll: true });
  }, [indexVisits]);
  const source = useSource(sourceId);
  const settings = useSettings();
  const contentType = kind;
  const section = kind === 'movie' ? 'movies' : 'series';
  // One request for the shown and the hidden categories (L3-perf-desktop-7); the grid and the
  // Manage dialog ask with the same arguments, so they read it from the cache.
  const allCats = useRpcQuery('catalog.categories', categoriesArgs(sourceId, contentType), { enabled: !!sourceId });
  const shownCats = useMemo(() => allCats.data?.filter((c) => !c.hidden), [allCats.data]);
  const recent = useRecentlyAdded(source.data, kind);
  const resume = useResumeMap(sourceId, kind);
  const continuing = useSectionContinue(sourceId, kind);
  const watched = useWatchedKeys(recent.data);
  const locks = useVodLocks(sourceId, kind);

  const title = kind === 'movie' ? t('movies') : t('series');
  const sourceCount = source.data ? (kind === 'movie' ? source.data.movieCount : source.data.seriesCount) : undefined;
  // What the user can open (L3-app-4): the shown categories' counts, which leave out hidden
  // categories and what parental Hide mode drops, not the raw import count. A child must not
  // read "60,000 titles" over an empty grid. Stalker portals may not count their categories;
  // there the source's count stands in while any category is shown.
  const visibleCount = useMemo(() => {
    if (!shownCats || !source.data) return undefined;
    const sum = shownCats.reduce((n, c) => n + Math.max(0, c.itemCount), 0);
    return sum === 0 && shownCats.length > 0 && source.data.kind === 'stalker' ? sourceCount : sum;
  }, [shownCats, source.data, sourceCount]);
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const countText = visibleCount ? t('titleCount', { count: visibleCount, formatted: fmt.format(visibleCount) }) : undefined;
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

  const hrefFor = (id: string) => `/s/${encodeURIComponent(sourceId)}/${section}/c/${encodeURIComponent(id)}`;

  // The rails ask for each grid's first page with the grid's own arguments (sort, the minimum
  // rating and Hide watched from settings), so See all opens on a page already in the cache.
  const sourceKind = source.data?.kind;
  const minRating = effectiveMinRating(settings.vodMinRating, new URLSearchParams());
  const hideWatched = settings.vodHideWatched === true;
  const gridInput = useCallback(
    (categoryId: string, sort: GridQueryInput['sort']): GridQueryInput | undefined =>
      sourceKind
        ? {
            sourceKind,
            kind,
            sourceId,
            categoryId,
            sort,
            dir: 'desc',
            search: '',
            minRating,
            ...(hideWatched ? { hideWatched } : {}),
          }
        : undefined,
    [sourceKind, kind, sourceId, minRating, hideWatched],
  );
  // Categories with titles (a Stalker portal may not count them), in the provider's order. Locked
  // categories stay out of the rails: their posters would show before the PIN is asked.
  const railCats = useMemo(
    () =>
      (shownCats ?? [])
        .filter((c) => (c.itemCount > 0 || sourceKind === 'stalker') && !locks.categoryLocked(c.id))
        .slice(0, CATEGORY_RAIL_LIMIT),
    [shownCats, sourceKind, locks],
  );

  // The chip row: the shown categories with titles in the provider's order, locked ones marked.
  const chipCats = useMemo(
    () =>
      (shownCats ?? [])
        .filter((c) => c.itemCount > 0 || sourceKind === 'stalker')
        .slice(0, CATEGORY_CHIP_LIMIT)
        .map((c) => ({ id: c.id, name: c.name, locked: locks.categoryLocked(c.id) })),
    [shownCats, sourceKind, locks],
  );
  const manageLabel = hiddenCount > 0 ? t('manageCategoriesHidden', { count: hiddenCount }) : t('manageCategories');

  const card = useCallback(
    (item: VodItem | SeriesItem, i: number, rail: RailCardProps, isWatched: boolean) => (
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
        watched={isWatched}
        language={itemLanguage(item.title, item.categoryName)}
        myList={myListTarget(item)}
        locked={locks.itemLocked(item)}
        prefetch={sourceKind ? { ref: item.ref, sourceKind, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl } : undefined}
      />
    ),
    [resume, locks, sourceKind],
  );

  if (source.isError) {
    return (
      <div className="h-full overflow-y-auto">
        <h1 className="sr-only">{title}</h1>
        {isSourceMissing(source.error) ? <SourceMissing /> : <ErrorState error={source.error} onRetry={() => void source.refetch()} />}
      </div>
    );
  }

  const isEmptySource =
    source.data && source.data.kind !== 'stalker' && sourceCount === 0 && shownCats && shownCats.length === 0 && hiddenCount === 0;
  const allHref = hrefFor(ALL_CATEGORIES);

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto overflow-x-hidden" data-testid={`vod-landing-${kind}`}>
      <Page width="wide" className="flex flex-col gap-10 max-sm:gap-8">
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
            {/* The categories one press from the top: the index itself waits under the rails. */}
            <CategoryChips
              cats={chipCats}
              total={shownCats?.length}
              loading={allCats.isPending}
              hrefFor={hrefFor}
              onShowAll={showIndex}
              manage={<IconButton label={manageLabel} icon={<ListFilter aria-hidden size={16} />} onClick={() => setManageOpen(true)} className="shrink-0" />}
            />
            {/* CB-VOD-LANDING: rails first, the way Plex and Apple TV open a library. */}
            {continuing.length > 0 && <ContinueSectionRail positions={continuing} locked={locks.itemLocked} sourceKind={sourceKind} />}
            <PosterRail<VodItem | SeriesItem>
              title={t('recentlyAdded')}
              seeAll={{ to: allHref }}
              items={recent.data ?? []}
              bleed
              // Placeholder cards from the first frame (L2-vod-5): the rail never pops in and pushes the categories down.
              loading={recent.isPending}
              empty={recent.isError ? <ErrorState size="inline" error={recent.error} onRetry={() => void recent.refetch()} /> : undefined}
              myList={myListTarget}
              render={(item, i, rail) => card(item, i, rail, watched.has(itemKey(item.ref)))}
            />
            {/* A Stalker portal sorts by name or by date added only: its "top rated" would be the newest. */}
            {sourceKind !== 'stalker' && (
              <CatalogRail
                title={t('topRated')}
                seeAll={{ to: `${allHref}?sort=rating&dir=desc` }}
                input={gridInput(ALL_CATEGORIES, 'rating')}
                rootRef={scrollRef}
                card={card}
              />
            )}
            {railCats.map((c) => (
              <CatalogRail
                key={c.id}
                title={c.name}
                count={c.itemCount > 0 ? fmt.format(c.itemCount) : undefined}
                seeAll={{ to: hrefFor(c.id) }}
                input={gridInput(c.id, 'added')}
                rootRef={scrollRef}
                card={card}
              />
            ))}

            {/* The full index: providers with hundreds of groups need it, so it stays one click away (VL-landing-index). */}
            <CategoryIndexSection
              kind={kind}
              cats={allCats}
              shownCats={shownCats}
              visibleCount={visibleCount}
              locks={locks}
              hrefFor={hrefFor}
              scrollRef={scrollRef}
              open={indexOpen}
              onOpenChange={setIndexOpen}
              toggleRef={indexToggleRef}
              manageLabel={manageLabel}
              onManage={() => setManageOpen(true)}
            />
          </>
        )}
      </Page>
      <HiddenCategoriesDialog open={manageOpen} onClose={() => setManageOpen(false)} sourceId={sourceId} contentType={contentType} />
    </div>
  );
}

/**
 * "Browse all categories": the heading that opens the index, its filter and the index itself. The
 * filter is this section's own state, so a keystroke re-renders the index, not the page and its
 * rails (VOD-LANDING-RENDERS). The landing's scroll memory lives here too: it keeps the index's
 * unfiltered positions only.
 */
function CategoryIndexSection({
  kind,
  cats,
  shownCats,
  visibleCount,
  locks,
  hrefFor,
  scrollRef,
  open,
  onOpenChange,
  toggleRef,
  manageLabel,
  onManage,
}: {
  kind: VodKind;
  /** The categories query, for its loading and error states. */
  cats: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  shownCats: Category[] | undefined;
  visibleCount: number | undefined;
  locks: VodLocks;
  hrefFor: (id: string) => string;
  scrollRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  manageLabel: string;
  onManage: () => void;
}) {
  const { t } = useTranslation('vod');
  const indexId = useId();
  const indexRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');

  const entries = useMemo<CategoryEntry[]>(() => {
    const list = categoryEntries(shownCats ?? [], filter).map((e) => (locks.categoryLocked(e.id) ? { ...e, locked: true } : e));
    if (filter.trim()) return list;
    const all: CategoryEntry = {
      id: ALL_CATEGORIES,
      name: kind === 'movie' ? t('allMovies') : t('allSeries'),
      emphasis: true,
    };
    if (visibleCount) all.count = visibleCount;
    return [all, ...list];
  }, [shownCats, filter, kind, visibleCount, t, locks]);

  // Back from a category: same scroll offset, focus on the category you opened. The index's own
  // positions only (the rails above hold grid indices of their own).
  const { pathname } = useLocation();
  useScrollMemory({
    key: pathname,
    getScroller: () => scrollRef.current,
    ready: !!shownCats && !filter.trim(),
    onRestored: (spot) => {
      if (spot.index === undefined) return;
      indexRef.current?.querySelector<HTMLElement>(`[data-grid-index="${spot.index}"]`)?.focus({ preventScroll: true });
    },
  });
  // Enter on a focused link also fires click, so this covers the keyboard too.
  const rememberCategory = (e: MouseEvent<HTMLElement>) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-grid-index]') : null;
    const index = Number(cell?.dataset['gridIndex']);
    // Indices shift while the filter is on, so only unfiltered positions are kept.
    if (cell && Number.isFinite(index) && !filter.trim()) rememberSpot(pathname, { scrollTop: scrollRef.current?.scrollTop ?? 0, index });
  };

  return (
    <section aria-labelledby="vod-categories-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="vod-categories-heading" className="text-title-sm text-fg">
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={open}
            aria-controls={indexId}
            onClick={() => onOpenChange(!open)}
            className="-ms-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-hover active:bg-active"
          >
            <ChevronRight aria-hidden size={18} className={cn('text-fg-muted motion-safe:transition-transform rtl:rotate-180', open && 'rotate-90 rtl:rotate-90')} />
            {t('browseAllCategories')}
          </button>
        </h2>
        {shownCats && <span className="tabular text-sm text-fg-subtle">{t('categoryCount', { count: shownCats.length })}</span>}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {open && <SearchInput value={filter} onChange={setFilter} size="sm" placeholder={t('filterCategories')} className="w-56 max-sm:w-full" />}
          <Button size="sm" variant="ghost" icon={<ListFilter aria-hidden size={16} />} onClick={onManage}>
            {manageLabel}
          </Button>
        </div>
      </div>
      <div id={indexId} hidden={!open}>
        {!open ? null : cats.isError ? (
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
          <div ref={indexRef} onClickCapture={rememberCategory}>
            <CategoryIndex entries={entries} hrefFor={hrefFor} scrollRef={scrollRef} label={t('categories')} lockedLabel={t('locked')} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The row of category chips under the header: the first categories in the provider's order, each
 * opening its grid, then "All categories" with the count, which opens the full index under the
 * rails and moves there, and Manage categories beside it. A provider with hundreds of groups
 * reaches any of them from the top of the page, not past a dozen rails. The chips are links in the
 * kit's filter-chip look; "All categories" follows them as a quiet link with a chevron, so it does
 * not read as a chosen filter, and the manage button sits next to it rather than at the far end.
 * The chips scroll sideways; the edge that hides chips fades out and a vertical wheel moves them.
 */
function CategoryChips({
  cats,
  total,
  loading,
  hrefFor,
  onShowAll,
  manage,
}: {
  cats: readonly { id: string; name: string; locked: boolean }[];
  total: number | undefined;
  loading: boolean;
  hrefFor: (id: string) => string;
  onShowAll: () => void;
  manage: ReactNode;
}) {
  const { t, i18n } = useTranslation('vod');
  const fades = useEdgeFades(`${loading}|${cats.map((c) => c.id).join(',')}|${i18n.language}`);
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  return (
    <nav aria-label={t('categories')} className="-mb-4 flex min-w-0 items-center gap-2 max-sm:-mb-2" data-testid="vod-category-chips">
      {/* Room for the focus halo, which the scroller would clip. */}
      <ul ref={fades.ref} style={fades.style} className="-m-1.5 flex min-w-0 items-center gap-2 overflow-x-auto p-1.5 scrollbar-none">
        {loading
          ? [0, 1, 2, 3, 4].map((i) => (
              <li key={i} aria-hidden className="shrink-0">
                <Skeleton className="h-7 w-24 rounded-full" />
              </li>
            ))
          : cats.map((c) => (
              <li key={c.id} className="shrink-0">
                <Link to={hrefFor(c.id)} state={FROM_LANDING} className={filterChipClass(false, 'max-w-[16rem]')} title={c.name} data-testid="vod-category-chip">
                  {c.locked && <Lock aria-hidden size={12} className="shrink-0" />}
                  <span dir="auto" className="truncate">
                    {c.name}
                  </span>
                  {c.locked && <span className="sr-only">, {t('locked')}</span>}
                </Link>
              </li>
            ))}
      </ul>
      <button
        type="button"
        onClick={onShowAll}
        aria-label={total !== undefined ? `${t('allCategories')}, ${t('categoryCount', { count: total })}` : undefined}
        className={buttonClass('ghost', 'sm', 'shrink-0 gap-1 px-2')}
        data-testid="vod-chip-all"
      >
        {t('allCategories')}
        {total !== undefined && <span className="tabular text-caption font-normal text-fg-subtle">{fmt.format(total)}</span>}
        <ChevronRight aria-hidden size={16} className="rtl:rotate-180" />
      </button>
      {manage}
    </nav>
  );
}

/**
 * Continue watching for this source and section (CB-VOD-LANDING): the titles started here, newest
 * first, each opening its detail page, where Resume is the primary action. The poster shows how
 * far you got; the caption says the episode or the time left.
 */
function ContinueSectionRail({
  positions,
  locked,
  sourceKind,
}: {
  positions: PlaybackPosition[];
  locked: (item: { ref: PlaybackPosition['ref'] }) => boolean;
  sourceKind: SourceKind | undefined;
}) {
  const { t } = useTranslation('vod');
  const myList = (p: PlaybackPosition) => {
    const name = p.snapshot?.title ? snapshotTitle(p.ref, p.snapshot.title).title : p.ref.itemId;
    const snapshot: ItemSnapshot = { title: name, contentType: p.ref.contentType };
    if (p.snapshot?.posterUrl) snapshot.posterUrl = p.snapshot.posterUrl;
    return { itemRef: p.ref, snapshot };
  };
  return (
    <PosterRail<PlaybackPosition>
      title={t('continueWatching')}
      items={positions}
      bleed
      myList={myList}
      render={(p, i, rail) => {
        const name = p.snapshot?.title ? snapshotTitle(p.ref, p.snapshot.title).title : p.ref.itemId;
        const left = p.durationSeconds ? Math.max(0, p.durationSeconds - p.positionSeconds) : 0;
        const fraction = p.durationSeconds ? Math.min(1, p.positionSeconds / p.durationSeconds) : undefined;
        return (
          <PosterCard
            index={i}
            tabIndex={rail.tabIndex}
            title={name}
            href={detailHref(p.ref) ?? '#'}
            posterUrl={p.snapshot?.posterUrl}
            // A series names the episode it resumes; a movie, the time left.
            meta={p.episodeId && p.snapshot?.subtitle ? p.snapshot.subtitle : t('minutesLeft', { count: Math.max(1, Math.round(left / 60)) })}
            progress={fraction}
            myList={myList(p)}
            locked={locked(p)}
            prefetch={sourceKind ? { ref: p.ref, sourceKind, posterUrl: p.snapshot?.posterUrl } : undefined}
          />
        );
      }}
    />
  );
}
