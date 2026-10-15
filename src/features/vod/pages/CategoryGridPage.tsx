import { ArrowDownWideNarrow, ArrowLeft, ArrowUpNarrowWide, CalendarX2, CircleCheck, Clapperboard, FolderX, Info, RotateCw, SearchX, Star, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router';

import { useQueryClient } from '@tanstack/react-query';

import { useRpcQuery } from '@/api/query';
import { itemKey, type ItemRef, type SeriesItem, type SourceKind, type VodItem } from '@/api/types';

import { useMyListMenuItem } from '@/features/mylist/hooks/useMyListMenuItem';
import { useMyListToggle } from '@/features/mylist/hooks/useMyListToggle';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { useUpdateSettings } from '@/features/settings/lib/useUpdateSettings';
import { useShortcut } from '@/shell';

import { PosterCard, PosterCardSkeleton, myListTarget } from '../components/PosterCard';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
import { VodFilterBar } from '../components/VodFilterBar';
import { usePrefetchOnRest, type PrefetchTarget } from '../hooks/prefetch';
import { resumeKey, useResumeMap, useSettings, useSource, useVodPage, useVodPagesInOrder } from '../hooks/queries';
import { useEscapeBack } from '../hooks/useBackKey';
import { useToggleWatched, useWatchedKeys, useWatchedPages } from '../hooks/useWatched';
import { useCoverWidth } from '../hooks/useCoverWidth';
import { usePageHeader } from '../hooks/usePageHeader';
import { recallSpot, rememberSpot, useScrollMemory } from '../hooks/useScrollMemory';
import { formatRating } from '../lib/format';
import { isNonEnglish, itemLanguage } from '../lib/language';
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
import { filterByYear, hasYearRange, writeYearRange, yearRangeKey, type YearRange } from '../lib/years';
import { EmptyState, ErrorState, IconButton, SearchInput, Select, SkeletonGrid, VirtualGrid, buttonClass } from '@/ui';

const SEARCH_DEBOUNCE_MS = 250;

/** Below this many visible titles, a rating-filtered Stalker grid keeps loading pages on its own. */
const FILTERED_MIN_VISIBLE = 60;

/**
 * Grid cell for a page that failed to load (a later page timing out on a slow
 * portal). It sits inside a listbox option, so it holds no button of its own:
 * clicking the cell or pressing Enter on it retries through the grid's onSelect.
 */
function GridCellError() {
  const { t } = useTranslation('vod');
  const { t: tc } = useTranslation('common');
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="vod-grid-cell-error">
      <div
        className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md bg-surface-2 p-3 text-center ring-1 ring-border/60 hover:ring-fg-subtle"
        style={{ aspectRatio: 2 / 3 }}
      >
        <TriangleAlert aria-hidden size={20} className="text-warning" />
        <p className="text-xs text-fg-muted">{t('pageLoadFailed')}</p>
        <span className={buttonClass('secondary', 'sm')}>
          <RotateCw aria-hidden size={14} />
          {tc('retry')}
        </span>
      </div>
    </div>
  );
}

interface GridCellProps {
  input: GridQueryInput;
  index: number;
  pageSize: number;
  active: boolean;
  /** The listbox has focus, so `active` is a live keyboard cursor. */
  gridFocused: boolean;
  resume: Map<string, number>;
}

/** One grid cell: subscribes to the page that contains `index`, so only pages near the viewport stay loaded. */
function GridCell({ input, index, pageSize, active, gridFocused, resume }: GridCellProps) {
  const page = pageOf(index, pageSize);
  const q = useVodPage(input, page);
  const item = q.data?.items[index - page * pageSize];
  // C4: one watched lookup per loaded page, shared by its cells.
  const watched = useWatchedKeys(q.data?.items);
  if (!item) {
    if (q.isError && !q.isFetching) return <GridCellError />;
    return <PosterCardSkeleton />;
  }
  return (
    <GridPoster
      item={item}
      sourceKind={input.sourceKind}
      active={active}
      gridFocused={gridFocused}
      resume={resume}
      watched={watched.has(itemKey(item.ref))}
    />
  );
}

function GridPoster({
  item,
  sourceKind,
  active,
  gridFocused,
  resume,
  watched,
}: {
  item: VodItem | SeriesItem;
  sourceKind: SourceKind;
  active: boolean;
  gridFocused: boolean;
  resume: Map<string, number>;
  watched: boolean;
}) {
  const prefetch = useMemo<PrefetchTarget>(
    () => ({ ref: item.ref, sourceKind, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl }),
    [item, sourceKind],
  );
  // C4: the keyboard cursor moves aria-activedescendant, not focus, so a cursor that rests on a
  // poster for 120 ms warms its detail page the way a resting pointer does.
  usePrefetchOnRest(active && gridFocused ? prefetch : null);
  return (
    <PosterCard
      interactive={false}
      active={active}
      title={item.titleBase || item.title}
      fullTitle={item.title}
      href={detailHref(item.ref) ?? '#'}
      posterUrl={item.posterUrl}
      year={item.year}
      rating={item.rating}
      progress={watched ? undefined : resume.get(resumeKey(item.ref))}
      watched={watched}
      language={itemLanguage(item.title, item.categoryName)}
      // C3: the saved marker and pointer toggle on the corner; S toggles it from the keyboard.
      myList={myListTarget(item)}
      prefetch={prefetch}
    />
  );
}

export function CategoryGridPage({ kind }: { kind: VodKind }) {
  const { t, i18n } = useTranslation('vod');
  const navigate = useNavigate();
  const { sourceId = '', categoryId = ALL_CATEGORIES } = useParams();
  const [params, setParams] = useSearchParams();
  const { sort, dir, search, yearFrom, yearTo } = readGridParams(params);
  const years = useMemo<YearRange>(
    () => ({ ...(yearFrom !== undefined ? { from: yearFrom } : {}), ...(yearTo !== undefined ? { to: yearTo } : {}) }),
    [yearFrom, yearTo],
  );
  const yearKey = yearRangeKey(years);
  const yearFiltered = hasYearRange(years);
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

  // C4: the year range lives in the URL (yf/yt); "Hide watched" is a setting.
  const setYears = (range: YearRange) => setParams((prev) => writeYearRange(prev, range));
  const hideWatched = settings.vodHideWatched === true;
  const updateSettings = useUpdateSettings();
  const setHideWatched = (on: boolean) => void updateSettings({ vodHideWatched: on });

  const settingMinRating = effectiveMinRating(settings.vodMinRating, new URLSearchParams());
  const minRating = effectiveMinRating(settingMinRating, params);
  const ratingFilterSet = settingMinRating > 0;
  const filtered = minRating > 0;
  const input = useMemo<GridQueryInput | undefined>(
    () =>
      source.data
        ? {
            sourceKind: source.data.kind,
            kind,
            sourceId,
            categoryId,
            sort,
            dir,
            search,
            minRating,
            ...(yearFrom !== undefined ? { yearFrom } : {}),
            ...(yearTo !== undefined ? { yearTo } : {}),
            ...(hideWatched ? { hideWatched } : {}),
          }
        : undefined,
    [source.data, kind, sourceId, categoryId, sort, dir, search, minRating, yearFrom, yearTo, hideWatched],
  );
  // m3u/xtream filter in SQLite and page like any grid. Stalker portals cannot filter by
  // rating, language, year or watched, so only there the grid loads pages in order and filters them.
  const stalker = !!source.data && !ratingFilterInCore(source.data.kind);
  const englishOnly = stalker && settings.englishOnly === true;
  const clientFiltered = stalker && (filtered || englishOnly || yearFiltered || hideWatched);
  const inOrder = useVodPagesInOrder(input, clientFiltered);
  // Watched ticks for the loaded pages; with Hide watched, a page shows once its lookup has answered.
  const watchedPages = useWatchedPages(inOrder.data?.pages, clientFiltered);
  const filteredItems = useMemo(() => {
    if (!clientFiltered) return [];
    const pages = inOrder.data?.pages ?? [];
    const loaded = (hideWatched ? pages.slice(0, watchedPages.settled) : pages).flatMap((p) => p.items);
    const unwatched = hideWatched ? loaded.filter((i) => !watchedPages.keys.has(itemKey(i.ref))) : loaded;
    const kept = filterByYear(filterByRating(unwatched, minRating), years);
    return englishOnly ? kept.filter((i) => !isNonEnglish(i.title, i.categoryName)) : kept;
  }, [clientFiltered, englishOnly, inOrder.data, minRating, years, hideWatched, watchedPages]);
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
  const filteredDone =
    clientFiltered && inOrder.isSuccess && !hasNextPage && (!hideWatched || watchedPages.settled >= (inOrder.data?.pages.length ?? 0));
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

  const retryPageOf = (i: number) => {
    if (!input) return;
    const { cmd, args } = buildPageRequest(input, pageOf(i, pageSize));
    void qc.refetchQueries({ queryKey: [cmd, args], exact: true });
  };

  const category = cats.data?.find((c) => c.id === categoryId);
  // A link to a category the source no longer has (removed upstream, or a stale bookmark). Decided
  // only once the categories have loaded, so a slow list never flashes this state.
  const categoryMissing = categoryId !== ALL_CATEGORIES && cats.isSuccess && !category;
  const categoryName =
    categoryId === ALL_CATEGORIES ? (kind === 'movie' ? t('allMovies') : t('allSeries')) : (category?.name ?? '');
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
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
  const coverWidth = useCoverWidth(settings.coverSize);
  const backHref = `/s/${encodeURIComponent(sourceId)}/${section}`;
  const dirLabel = dir === 'asc' ? t('sortAscending') : t('sortDescending');
  const resume = useResumeMap(sourceId, kind);

  // Back from a detail view: put the grid where it was and the keyboard cursor
  // on the title you opened. The grid's listbox is the scroller.
  const location = useLocation();
  const memoryKey = `${location.pathname}${location.search}`;
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const getListbox = () => gridWrapRef.current?.querySelector<HTMLElement>('[role="listbox"]') ?? null;
  const gridShown = firstReady && total > 0;
  // The cursor keys below (S, W, the poster menu) act on the keyboard cursor, so they are bound
  // only while the listbox has focus. The registry claims a key before its handler runs: bound
  // all the time, S would swallow the player's screenshot key on this page (amendment 15:19).
  const [gridFocused, setGridFocused] = useState(false);
  const cursorKeys = gridShown && gridFocused;
  // Only a return comes back to the old spot: Back/Forward (POP), and the restart and fallback
  // redirects, which replace the entry (StartupRedirect's <Navigate replace>). A link or a new sort
  // (PUSH) is a fresh visit and starts at the top.
  const returning = useNavigationType() !== 'PUSH';
  useScrollMemory({
    key: memoryKey,
    getScroller: getListbox,
    ready: gridShown,
    restore: returning,
    // The cursor itself comes back through VirtualGrid's initialActiveIndex.
    onRestored: (_spot, listbox) => listbox.focus({ preventScroll: true }),
  });
  /** Title opened from this grid last time (read by VirtualGrid on mount only). */
  const restoredIndex = returning ? recallSpot(memoryKey)?.index : undefined;
  const openTitle = (ref: ItemRef | undefined, index: number) => {
    const href = ref && detailHref(ref);
    if (!href) return;
    rememberSpot(memoryKey, { scrollTop: getListbox()?.scrollTop ?? 0, index });
    navigate(href);
  };
  const focusGrid = () => getListbox()?.focus();

  // C3: S saves the title under the grid's keyboard cursor to My List (or takes it off). The
  // posters sit inside listbox options, so they cannot hold a focusable button of their own.
  const toggleMyList = useMyListToggle();
  const itemAt = (i: number): VodItem | SeriesItem | undefined =>
    clientFiltered ? filteredItems[i] : (queryItem(i) as VodItem | SeriesItem | undefined);
  /** The grid cell (and its index) the keyboard cursor rests on, while the grid has focus. */
  const activeCell = (): { cell: HTMLElement; index: number } | undefined => {
    const listbox = getListbox();
    if (!listbox || document.activeElement !== listbox) return undefined;
    const activeId = listbox.getAttribute('aria-activedescendant');
    const cell = activeId ? document.getElementById(activeId) : null;
    const index = Number(cell?.dataset.index);
    return cell && Number.isInteger(index) ? { cell, index } : undefined;
  };
  useShortcut(
    's',
    () => {
      const at = activeCell();
      const item = at ? itemAt(at.index) : undefined;
      if (!item) return;
      const { itemRef, snapshot } = myListTarget(item);
      void toggleMyList(itemRef, snapshot);
    },
    { description: t('shortcutMyList'), area: 'Vod', enabled: cursorKeys },
  );
  // C4: W marks the title under the cursor watched (or unwatched); Shift+W hides or shows watched titles.
  const toggleWatched = useToggleWatched();
  useShortcut(
    'w',
    () => {
      const at = activeCell();
      const item = at ? itemAt(at.index) : undefined;
      if (item) void toggleWatched(item.ref);
    },
    { description: t('shortcutWatched'), area: 'Vod', enabled: cursorKeys },
  );
  // Shift+W changes what the grid holds, so the grid remounts and the focused listbox goes away.
  // A toggle made from the grid puts focus back on the new listbox (VirtualGrid clamps the cursor),
  // so the arrow keys keep working; it never takes focus from somewhere the user moved it.
  const refocusFor = useRef<boolean | null>(null);
  useShortcut(
    'shift+w',
    () => {
      refocusFor.current = document.activeElement === getListbox() ? !hideWatched : null;
      setHideWatched(!hideWatched);
    },
    { description: t('shortcutHideWatched'), area: 'Vod', enabled: !!input },
  );
  useEffect(() => {
    if (refocusFor.current === null || refocusFor.current !== hideWatched) return;
    const listbox = gridWrapRef.current?.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) {
      refocusFor.current = null;
      const dropped = !document.activeElement || document.activeElement === document.body;
      if (dropped) listbox.focus({ preventScroll: true });
    } else if (firstReady && total === 0) {
      refocusFor.current = null;
    }
  });

  // A poster's menu (right click, Shift+F10, the context-menu key): open it, or My List.
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; item: VodItem | SeriesItem; index: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const myListItem = useMyListMenuItem(menu ? { ref: menu.item.ref, snapshot: myListTarget(menu.item).snapshot } : null);
  const menuItems: MenuItem[] = menu
    ? [
        { id: 'open', label: t('openDetails'), icon: <Info aria-hidden className="size-4" />, onSelect: () => openTitle(menu.item.ref, menu.index) },
        ...(myListItem ? [myListItem] : []),
      ]
    : [];
  const onGridContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    const index = Number(cell?.dataset.index);
    const item = cell && Number.isInteger(index) ? itemAt(index) : undefined;
    if (!item) return;
    e.preventDefault();
    setMenu({ pos: { x: e.clientX, y: e.clientY }, item, index });
  };
  const openCursorMenu = () => {
    const at = activeCell();
    const item = at ? itemAt(at.index) : undefined;
    if (!at || !item) return;
    const r = at.cell.getBoundingClientRect();
    setMenu({ pos: { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) }, item, index: at.index });
  };
  useShortcut('shift+f10', openCursorMenu, { description: t('shortcutPosterMenu'), area: 'Vod', enabled: cursorKeys });
  useShortcut('contextmenu', openCursorMenu, { description: t('shortcutPosterMenu'), area: 'Vod', enabled: cursorKeys });

  // Escape on the grid returns to the category list. Opened from the landing, that is one step
  // back; otherwise the landing replaces the grid, so Escape never stacks grid/landing pairs.
  const fromLanding = (location.state as { fromLanding?: unknown } | null)?.fromLanding === true;
  useEscapeBack(true, () => void (fromLanding ? navigate(-1) : navigate(backHref, { replace: true })));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`vod-grid-${kind}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-3 md:px-8">
        <Link to={backHref} className={buttonClass('ghost', 'sm')}>
          <ArrowLeft aria-hidden size={16} className="rtl:rotate-180" />
          {kind === 'movie' ? t('movies') : t('series')}
        </Link>
        <div className="me-auto flex min-w-0 items-baseline gap-3">
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
          onSubmit={focusGrid}
          onKeyDown={(e) => {
            // ArrowDown leaves the search box for the posters.
            if (e.key === 'ArrowDown' && getListbox()) {
              e.preventDefault();
              focusGrid();
            }
          }}
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

      {input && (
        <VodFilterBar
          sourceId={sourceId}
          kind={kind}
          categoryId={categoryId}
          stalker={stalker}
          yearsLikely={source.data?.kind !== 'm3u'}
          range={years}
          onRangeChange={setYears}
          hideWatched={hideWatched}
          onHideWatchedChange={setHideWatched}
        />
      )}

      {ratingFilterSet && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-divider px-4 py-2 text-sm text-fg-muted md:px-8" data-testid="vod-rating-filter">
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

      {/* Right clicks bubble here from the grid's options; so do focus changes (React's focusin/focusout). */}
      <div
        ref={gridWrapRef}
        className="min-h-0 flex-1 px-4 pt-4 md:px-8"
        onContextMenu={onGridContextMenu}
        onFocus={(e) => setGridFocused(e.target.getAttribute('role') === 'listbox')}
        onBlur={(e) => {
          if (e.target.getAttribute('role') === 'listbox') setGridFocused(false);
        }}
      >
        {source.isError && isSourceMissing(source.error) ? (
          <SourceMissing />
        ) : !source.isError && categoryMissing ? (
          <EmptyState
            icon={<FolderX size={32} />}
            title={t('categoryMissingTitle')}
            description={t('categoryMissingBody')}
            action={
              <Link to={backHref} className={buttonClass('secondary', 'sm')}>
                {t('backToCategories')}
              </Link>
            }
          />
        ) : source.isError || (clientFiltered ? inOrder.isError : first.isError) ? (
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
          // The search query is the narrowest thing the user typed, so it names the empty result
          // first; clearing it falls through to the rating, year and watched states below.
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
          ) : filtered ? (
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
          ) : yearFiltered ? (
            <EmptyState
              icon={<CalendarX2 size={32} />}
              title={t('yearEmptyTitle')}
              action={
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setYears({})}>
                  {t('yearAll')}
                </button>
              }
            />
          ) : hideWatched ? (
            <EmptyState
              icon={<CircleCheck size={32} />}
              title={t('watchedEmptyTitle')}
              action={
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setHideWatched(false)}>
                  {t('showWatched')}
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
            key={`${categoryId}|${sort}|${dir}|${search}|${minRating}|${englishOnly}|${yearKey}|${hideWatched}`}
            items={filteredItems}
            minColumnWidth={coverWidth}
            aspect="poster"
            label={categoryName}
            testId="vod-grid"
            initialActiveIndex={restoredIndex}
            getKey={(item) => item.ref.itemId}
            render={(item, _index, state) => (
              <GridPoster
                item={item}
                sourceKind={input.sourceKind}
                active={state.active}
                gridFocused={gridFocused}
                resume={resume}
                watched={watchedPages.keys.has(itemKey(item.ref))}
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
            onSelect={(item, index) => openTitle(item.ref, index)}
            className="rounded-md pb-8 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        ) : (
          <VirtualGrid<number>
            key={`${categoryId}|${sort}|${dir}|${search}|${minRating}|${yearKey}|${hideWatched}`}
            items={indices}
            minColumnWidth={coverWidth}
            aspect="poster"
            label={categoryName}
            testId="vod-grid"
            initialActiveIndex={restoredIndex}
            render={(i, _index, state) => (
              <GridCell input={input} index={i} pageSize={pageSize} active={state.active} gridFocused={gridFocused} resume={resume} />
            )}
            onSelect={(i) => {
              const item = queryItem(i);
              // A cell whose page failed: selecting it retries that page.
              if (!item) return retryPageOf(i);
              openTitle(item.ref, i);
            }}
            className="rounded-md pb-8 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        )}
      </div>
      <ContextMenu pos={menu?.pos ?? null} items={menuItems} label={menu ? menu.item.titleBase || menu.item.title : ''} onClose={closeMenu} />
    </div>
  );
}

