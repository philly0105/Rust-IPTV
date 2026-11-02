import { ChevronRight, Clapperboard, ListFilter, Lock, SearchX, Tv } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { categoriesArgs } from '@/api/bootPrefetch';
import { useRpcQuery } from '@/api/query';
import { itemKey, type Category, type ItemSnapshot, type PlaybackPosition, type SeriesItem, type SourceKind, type VodItem } from '@/api/types';
// The module itself, not the player barrel: small, no imports, already in the player core chunk.
import { preloadEngines } from '@/features/player/enginePreload';
import { snapshotTitle } from '@/lib/title';

import { CatalogPosterCard, CatalogRail, type CatalogRailProps } from '../components/CatalogRail';
import { CategoryIndex, FROM_LANDING, categoryEntries, type CategoryEntry } from '../components/CategoryIndex';
import { HiddenCategoriesDialog } from '../components/HiddenCategoriesDialog';
import { myListTarget, PosterCard } from '../components/PosterCard';
import { PosterRail, type RailCardProps } from '../components/PosterRail';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
import { resumeKey, useRecentlyAdded, useResumeMap, useSectionContinue, useSettings, useSource } from '../hooks/queries';
import { useClientHeight } from '../hooks/useContainerColumns';
import { useEdgeFades } from '../hooks/useEdgeFades';
import { usePageHeader } from '../hooks/usePageHeader';
import { useShowSourceName } from '../hooks/useShowSourceName';
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
  const indexRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  // The last press on this landing, a new object per press so the reveal runs for each. React
  // Router keeps this page mounted from one landing to the next (another source, or Movies to
  // Series), so a press belongs to the landing it was made on and is dropped when the path changes.
  const [indexAsked, setIndexAsked] = useState<{ pathname: string }>();
  if (indexAsked && indexAsked.pathname !== pathname) setIndexAsked(undefined);
  const revealPending = useRef(false);
  const showIndex = () => {
    setIndexOpen(true);
    setIndexAsked({ pathname });
    revealPending.current = true;
  };
  const source = useSource(sourceId);
  const settings = useSettings();
  const contentType = kind;
  const section = kind === 'movie' ? 'movies' : 'series';
  // One request for the shown and the hidden categories (L3-perf-desktop-7); the grid and the
  // Manage dialog ask with the same arguments, so they read it from the cache.
  const allCats = useRpcQuery('catalog.categories', categoriesArgs(sourceId, contentType), { enabled: !!sourceId });
  const shownCats = useMemo(() => allCats.data?.filter((c) => !c.hidden), [allCats.data]);
  const catsLoaded = shownCats !== undefined;
  // Back from a category: same scroll offset, focus on the category you opened. The index's own
  // positions only (the rails above hold grid indices of their own), and none while its filter is
  // on (the index section says when it starts or stops, not per keystroke). Called here, not in
  // that section: a child's layout effects run before React attaches this page's ref to the
  // scroller, so with the categories cached at mount (Back) the section found no scroller and
  // never restored or recorded. All categories pressed on this landing before the categories
  // arrived skips the restore (IDX-M1): it would undo the press.
  const [indexFiltered, setIndexFiltered] = useState(false);
  useScrollMemory({
    key: pathname,
    getScroller: () => scrollRef.current,
    ready: catsLoaded && !indexFiltered,
    restore: !indexAsked,
    onRestored: (spot) => {
      if (spot.index === undefined) return;
      indexRef.current?.querySelector<HTMLElement>(`[data-grid-index="${spot.index}"]`)?.focus({ preventScroll: true });
    },
  });
  // A layout effect: it runs after the index's own (children first), so the heading is at the top
  // before the frame is painted.
  useLayoutEffect(() => {
    const toggle = indexToggleRef.current;
    if (!revealPending.current || !toggle) return;
    // Pressed on the landing this page showed before: not this one's to reveal.
    if (!indexAsked) {
      revealPending.current = false;
      return;
    }
    // The heading at the top of the view, and focus on its disclosure (now expanded), so Tab
    // goes on to the filter and the list.
    toggle.scrollIntoView({ block: 'start' });
    toggle.focus({ preventScroll: true });
    // Pressed while the categories load (IDX-M1): their rails go in above the index when they
    // arrive, so the heading is taken to the top once more then.
    if (catsLoaded) revealPending.current = false;
  }, [indexAsked, catsLoaded]);
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
  // The source's name only when there are others to tell it from; with one, the count alone.
  const showSource = useShowSourceName();
  const sourceName = showSource ? source.data?.name : undefined;
  const sourceLine = sourceName ? (countText ? `${sourceName} · ${countText}` : sourceName) : countText;

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
  // With one source the field says "Search this source": short enough for the field on a 1024 px
  // tablet, where "Search channels, movies, and series" was cut off, and not "Search everything",
  // the name of the palette's button right beside it.
  const searchPlaceholder = sourceName ? t('searchInSource', { source: sourceName }) : t('searchSource');
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
  const grid = useMemo<RailGrid | undefined>(
    () => (sourceKind ? { sourceKind, kind, sourceId, dir: 'desc', search: '', minRating, ...(hideWatched ? { hideWatched } : {}) } : undefined),
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
      <CatalogPosterCard
        item={item}
        index={i}
        tabIndex={rail.tabIndex}
        progress={resume.get(resumeKey(item.ref))}
        watched={isWatched}
        locked={locks.itemLocked(item)}
        showLanguage
        sourceKind={sourceKind}
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
        {/* The shell header shows the title and the count, with the source when there are others (one place, L1-visual-13). Its
            subtitle folds away below md, so only there the source line shows here: in the category
            row's first line, or on its own over an empty source. */}
        <h1 className="sr-only">{title}</h1>
        {isEmptySource && sourceLine && <p className="-mb-6 min-w-0 truncate text-sm text-fg-muted md:hidden">{sourceLine}</p>}
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
              lead={sourceLine}
              cats={chipCats}
              total={shownCats?.length}
              loading={allCats.isPending}
              hrefFor={hrefFor}
              onShowAll={showIndex}
              manage={<IconButton size="sm" label={manageLabel} icon={<ListFilter aria-hidden size={16} />} onClick={() => setManageOpen(true)} className="shrink-0 max-md:order-last" />}
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
              <LandingRail
                title={t('topRated')}
                seeAllTo={`${allHref}?sort=rating&dir=desc`}
                grid={grid}
                categoryId={ALL_CATEGORIES}
                sort="rating"
                rootRef={scrollRef}
                card={card}
              />
            )}
            {railCats.map((c) => (
              <LandingRail
                key={c.id}
                title={c.name}
                count={c.itemCount > 0 ? fmt.format(c.itemCount) : undefined}
                seeAllTo={hrefFor(c.id)}
                grid={grid}
                categoryId={c.id}
                sort="added"
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
              onShowIndex={showIndex}
              onFilteredChange={setIndexFiltered}
              indexRef={indexRef}
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

/** The grid arguments every landing rail shares; each rail adds its category and sort. */
type RailGrid = Omit<GridQueryInput, 'categoryId' | 'sort'>;

/**
 * Top rated or a category's rail (VOD-LANDING-RENDERS). Memoized on plain props, and it builds its
 * grid's arguments and See all itself, so a page render (another query's answer) leaves it and
 * its cards alone.
 */
const LandingRail = memo(function LandingRail({
  title,
  count,
  seeAllTo,
  grid,
  categoryId,
  sort,
  rootRef,
  card,
}: {
  title: string;
  count?: string | undefined;
  seeAllTo: string;
  grid: RailGrid | undefined;
  categoryId: string;
  sort: GridQueryInput['sort'];
  rootRef: RefObject<HTMLDivElement | null>;
  card: CatalogRailProps['card'];
}) {
  const input = useMemo(() => (grid ? { ...grid, categoryId, sort } : undefined), [grid, categoryId, sort]);
  const seeAll = useMemo(() => ({ to: seeAllTo }), [seeAllTo]);
  return <CatalogRail title={title} count={count} seeAll={seeAll} input={input} rootRef={rootRef} card={card} />;
});

/**
 * "Browse all categories": the heading that opens the index, its filter and the index itself. The
 * filter is this section's own state, so a keystroke re-renders the index, not the page and its
 * rails (VOD-LANDING-RENDERS); the page hears only when filtering starts or stops, for its scroll
 * memory, which keeps the index's unfiltered positions only.
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
  onShowIndex,
  onFilteredChange,
  indexRef,
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
  /** Opens the index and takes its heading to the top of the view (the All categories chip). */
  onShowIndex: () => void;
  /** Whether the filter holds text: the page's scroll memory pauses while it does. */
  onFilteredChange: (filtered: boolean) => void;
  /** The index's list, where the scroll memory puts focus back on the category opened. */
  indexRef: RefObject<HTMLDivElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
  manageLabel: string;
  onManage: () => void;
}) {
  const { t } = useTranslation('vod');
  const indexId = useId();
  const [filter, setFilter] = useState('');
  const filtered = !!filter.trim();
  // In the commit that starts or stops filtering, before a scroll can record a filtered offset.
  useLayoutEffect(() => onFilteredChange(filtered), [filtered, onFilteredChange]);
  // Open, the index takes at least a screen (IDX-3). A narrowing filter otherwise shortened the
  // page under the view: the browser clamped the scroll, and the field being typed in dropped
  // toward the bottom, with the rails back in view. Measured while folded too, so the floor is in
  // the render that opens the index, before the reveal takes its heading to the top: a short index
  // at the bottom of the page would clamp that scroll as well. Read after the browser's layout
  // (P2-RAILS-4), except when the index is open as the landing mounts: Back puts back an offset
  // that may need the floor, and a floor that came after the restore's second try left the page
  // clamped above where it was left.
  const viewport = useClientHeight(scrollRef, open);

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

  const { pathname } = useLocation();
  // Enter on a focused link also fires click, so this covers the keyboard too.
  const rememberCategory = (e: MouseEvent<HTMLElement>) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-grid-index]') : null;
    const index = Number(cell?.dataset['gridIndex']);
    // Indices shift while the filter is on, so only unfiltered positions are kept.
    if (cell && Number.isFinite(index) && !filtered) rememberSpot(pathname, { scrollTop: scrollRef.current?.scrollTop ?? 0, index });
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
            onClick={(e) => {
              // At the bottom of the page, where scrolling down to it leaves the heading, the list
              // would open under the fold: take the heading to the top, as All categories does
              // (IDX-2). Higher up, and to close, the page stays where it is.
              const scroller = scrollRef.current;
              const lower = !!scroller && e.currentTarget.getBoundingClientRect().top > scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
              if (!open && lower) onShowIndex();
              else onOpenChange(!open);
            }}
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
      <div id={indexId} hidden={!open} style={open && viewport > 0 ? { minHeight: viewport } : undefined}>
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
 *
 * Below md the shell header drops its subtitle, so the row starts with the source line (`lead`)
 * with All categories at its end, and the chips take the next line, ended by Manage: beside the
 * two buttons a phone showed little more than one chip. The lines have no gap between them: the
 * buttons' boxes (44 px on touch) already space them, so the page grows by little.
 */
function CategoryChips({
  lead,
  cats,
  total,
  loading,
  hrefFor,
  onShowAll,
  manage,
}: {
  /** The title count (after the source's name when there are others), shown below md, where the header does not show it. */
  lead?: string | undefined;
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
    <nav aria-label={t('categories')} className="-mb-4 flex min-w-0 flex-wrap items-center gap-x-2 max-sm:-mb-2 md:flex-nowrap" data-testid="vod-category-chips">
      {lead && (
        <p className="min-w-0 flex-1 truncate text-sm text-fg-muted md:hidden" data-testid="vod-landing-source">
          {lead}
        </p>
      )}
      {/* Room for the focus halo, which the scroller would clip. Below md it is too wide to share the
          source line, so it starts the next line, and Manage (also order-last, after it) ends that line. */}
      <ul
        ref={fades.ref}
        style={fades.style}
        className="-m-1.5 flex min-w-0 items-center gap-2 overflow-x-auto p-1.5 scrollbar-none max-md:order-last max-md:grow max-md:basis-[calc(100%-5.5rem)]"
      >
        {loading
          ? [0, 1, 2, 3, 4].map((i) => (
              <li key={i} aria-hidden className="shrink-0">
                <Skeleton className="h-8 w-28 rounded-full" />
              </li>
            ))
          : cats.map((c) => (
              <li key={c.id} className="shrink-0">
                <Link to={hrefFor(c.id)} state={FROM_LANDING} className={filterChipClass(false, 'max-w-[16rem]')} title={c.name} data-testid="vod-category-chip">
                  {c.locked && <Lock aria-hidden size={14} className="shrink-0" />}
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
        className={buttonClass('ghost', 'sm', 'shrink-0 gap-1 px-2 max-md:ms-auto')}
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
 * far you got; the caption says the episode or the time left. Memoized: its props hold while the
 * page re-renders for other answers (VOD-LANDING-RENDERS).
 */
const ContinueSectionRail = memo(function ContinueSectionRail({
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
});
