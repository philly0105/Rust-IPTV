import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarX2,
  CircleCheck,
  Clapperboard,
  FolderX,
  Info,
  Play,
  RotateCw,
  SearchX,
  SlidersHorizontal,
  Star,
  TriangleAlert,
} from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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

import { GridMyListProvider, PosterCard, PosterCardSkeleton, myListTarget } from '../components/PosterCard';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
import { DecadeChips, YearRangeFields, useYearFilter } from '../components/VodFilterBar';
import { preloadDetailChunk, usePrefetchOnRest, type PrefetchTarget } from '../hooks/prefetch';
import { usePlayTitle, type PlayTarget } from '../hooks/usePlayTitle';
import { resumeKey, useResumeMap, useSettings, useSource, useVodPage, useVodPagesInOrder } from '../hooks/queries';
import { useEscapeBack } from '../hooks/useBackKey';
import { useToggleWatched, useWatchedKeys, useWatchedPages } from '../hooks/useWatched';
import { useCoverWidth } from '../hooks/useCoverWidth';
import { PageGate, PageGateProvider, usePageOpen } from '../hooks/pageGate';
import { usePageHeader } from '../hooks/usePageHeader';
import { useShowSourceName } from '../hooks/useShowSourceName';
import { useUrlSearchDraft } from '../hooks/useUrlSearchDraft';
import { useVodLocks, type VodLocks } from '../hooks/useVodLocks';
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
import { BackButton, EmptyState, ErrorState, IconButton, SearchInput, Select, SkeletonGrid, Toggle, Tooltip, VirtualGrid, buttonClass, cn, filterChipClass, type VirtualItemState } from '@/ui';
import { intlLocale } from '@/lib/intl';

const SEARCH_DEBOUNCE_MS = 250;

/** Below this many visible titles, a rating-filtered Stalker grid keeps loading pages on its own. */
const FILTERED_MIN_VISIBLE = 60;

/** Characters of the query the no-results title echoes; a longer one ends in an ellipsis. */
const ECHO_QUERY_MAX = 60;

/** The query as the no-results title echoes it: at most {@link ECHO_QUERY_MAX} characters (code points). */
function echoQuery(query: string): string {
  const chars = Array.from(query);
  return chars.length > ECHO_QUERY_MAX ? `${chars.slice(0, ECHO_QUERY_MAX - 1).join('')}…` : query;
}

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
        className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md bg-surface-2 p-3 text-center ring-1 ring-edge hover:ring-fg-subtle"
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

/**
 * A loaded page's titles that pass the rating, year and language filters, kept per page object
 * (VD-9): a new page filters only itself instead of every page loaded before it. Watched titles
 * are taken out after this, since their lookup changes as pages arrive.
 */
const filteredPages = new WeakMap<object, { key: string; items: (VodItem | SeriesItem)[] }>();

function filteredPage(
  page: { items: (VodItem | SeriesItem)[] },
  f: { minRating: number; years: YearRange; englishOnly: boolean; key: string },
): (VodItem | SeriesItem)[] {
  const hit = filteredPages.get(page);
  if (hit && hit.key === f.key) return hit.items;
  const kept = filterByYear(filterByRating(page.items, f.minRating), f.years);
  const items = f.englishOnly ? kept.filter((i) => !isNonEnglish(i.title, i.categoryName)) : kept;
  filteredPages.set(page, { key: f.key, items });
  return items;
}

interface GridCellProps {
  input: GridQueryInput;
  index: number;
  pageSize: number;
  active: boolean;
  /** The listbox has focus, so `active` is a live keyboard cursor. */
  gridFocused: boolean;
  resume: Map<string, number>;
  locks: VodLocks;
}

/**
 * One grid cell: subscribes to the page that contains `index`, so only pages near the viewport
 * stay loaded. Memoised on stable props (L2-vod-1): a scroll re-renders only the cells it mounts,
 * not every cell on screen, and a page's arrival re-renders only that page's cells.
 */
const GridCell = memo(function GridCell({ input, index, pageSize, active, gridFocused, resume, locks }: GridCellProps) {
  const page = pageOf(index, pageSize);
  const q = useVodPage(input, page, usePageOpen(page));
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
      locked={locks.itemLocked(item)}
    />
  );
});

const GridPoster = memo(function GridPoster({
  item,
  sourceKind,
  active,
  gridFocused,
  resume,
  watched,
  locked,
}: {
  item: VodItem | SeriesItem;
  sourceKind: SourceKind;
  active: boolean;
  gridFocused: boolean;
  resume: Map<string, number>;
  watched: boolean;
  locked: boolean;
}) {
  const prefetch = useMemo<PrefetchTarget>(
    () => ({ ref: item.ref, sourceKind, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl }),
    [item, sourceKind],
  );
  const myList = useMemo(() => myListTarget(item), [item]);
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
      myList={myList}
      prefetch={prefetch}
      locked={locked}
    />
  );
});

/**
 * The minimum rating from Settings as a chip in the grid's toolbar (VL-grid-toolbars), instead of
 * a bar of its own: "★ 7.0+" while it filters, struck out while the grid shows every rating.
 * Pressing it switches between the two; the tooltip and the name say which way.
 */
function RatingFloorChip({ setting, on, onChange, className }: { setting: number; on: boolean; onChange: (on: boolean) => void; className?: string }) {
  const { t, i18n } = useTranslation('vod');
  const rating = formatRating(setting, i18n.language);
  const label = on ? `${t('ratingFilterNote', { rating })}. ${t('ratingFilterClear')}` : t('ratingFilterApply', { rating });
  return (
    <Tooltip content={on ? t('ratingFilterClear') : t('ratingFilterApply', { rating })} describe={false}>
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        data-testid="vod-rating-filter"
        // The kit's filter chip, as the decade chips beside it: inverted while it filters.
        className={filterChipClass(on, cn('tabular gap-1 whitespace-nowrap', !on && 'text-fg-subtle line-through', className))}
      >
        <Star aria-hidden size={14} className="fill-current" />
        {`${rating}+`}
      </button>
    </Tooltip>
  );
}

/** Below this many titles a category drops its decade chips and its search field. */
const FEW_TITLES = 12;

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
  // URL is the source of truth for search; the input debounces into it (L3-vod-1: never over newer typing).
  const [searchDraft, setSearchDraft] = useUrlSearchDraft({ delayMs: SEARCH_DEBOUNCE_MS });
  const settings = useSettings();
  const source = useSource(sourceId);
  const cats = useRpcQuery('catalog.categories', { sourceId, contentType: kind, includeHidden: true }, { enabled: !!sourceId });
  const section = kind === 'movie' ? 'movies' : 'series';

  // Warm the detail page's chunk while the grid idles (L2-vod-10): touch screens get no hover
  // prefetch, so the first title opened otherwise waits for its code too.
  useEffect(() => {
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const warm = () => preloadDetailChunk(kind);
    if (typeof requestIdleCallback === 'function') {
      const h = requestIdleCallback(warm, { timeout: 2000 });
      return () => cancelIdleCallback(h);
    }
    const h = setTimeout(warm, 500);
    return () => clearTimeout(h);
  }, [kind]);

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
    const filter = { minRating, years, englishOnly, key: `${minRating}|${yearRangeKey(years)}|${englishOnly}` };
    const kept = (hideWatched ? pages.slice(0, watchedPages.settled) : pages).flatMap((p) => filteredPage(p, filter));
    return hideWatched ? kept.filter((i) => !watchedPages.keys.has(itemKey(i.ref))) : kept;
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
  // VD-2: cells fetch their page once the grid rests on it, not every page a drag passes.
  const pageGate = useMemo(() => new PageGate(), [categoryId]);
  useEffect(() => () => pageGate.dispose(), [pageGate]);

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
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  // One string for the page h1 and the shell header title (C16), so they always agree. The shell
  // header shows it; the page's h1 is for assistive technology only, so the title shows once.
  const pageTitle = categoryName || (kind === 'movie' ? t('movies') : t('series'));
  const countText = firstReady ? t('titleCount', { count: total, formatted: fmt.format(total) }) : undefined;
  // The source's name only when there are others to tell it from; with one, the count alone.
  const sourceName = useShowSourceName() ? source.data?.name : undefined;

  usePageHeader(
    {
      title: pageTitle,
      subtitle: sourceName ? (countText ? `${sourceName} · ${countText}` : sourceName) : countText,
    },
    [pageTitle, sourceName, countText],
  );
  const locks = useVodLocks(sourceId, kind);
  // Phones: sort, years and Hide watched fold behind one Filters button, so the grid starts under the search row.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const activeFilters = (yearFiltered ? 1 : 0) + (hideWatched ? 1 : 0);
  const yearFilter = useYearFilter({
    sourceId,
    kind,
    categoryId,
    ready: !!source.data,
    stalker,
    yearsLikely: source.data?.kind !== 'm3u',
    range: years,
    onRangeChange: setYears,
    hideWatched,
  });

  // A small category (a row or two of posters) needs no decade chips and no search of its own:
  // they were most of the page for five titles. Counted from the category itself, so the toolbar
  // does not change as filters narrow the grid, and kept while one of them is in use.
  const fewTitles = category !== undefined && category.itemCount < FEW_TITLES;
  const showChips = !fewTitles || yearFiltered;
  const showSearch = !fewTitles || searchDraft !== '';

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
  // The grid stays mounted across a new sort, search or filter (L3-vod-3), so it goes back to the
  // top itself; on a return, the scroll memory below then puts the old offset back. Not on Hide
  // watched, which keeps the place (L2-vod-8).
  const filterKey = `${sort}|${dir}|${search}|${minRating}|${englishOnly}|${yearKey}`;
  const shownFilterKey = useRef(filterKey);
  useLayoutEffect(() => {
    if (shownFilterKey.current === filterKey) return;
    shownFilterKey.current = filterKey;
    const listbox = getListbox();
    if (listbox) listbox.scrollTop = 0;
  }, [filterKey]);
  // The old titles stay while the new ones load: dimmed once the wait is long enough to notice.
  const refreshing = !clientFiltered && first.isPlaceholderData && first.isFetching;
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
  // L4-vod-4: the menu also plays the title (resuming like the detail page's Play) and marks it watched.
  const menuTitle = useMemo(() => (menu ? [menu.item] : undefined), [menu]);
  const menuWatched = useWatchedKeys(menuTitle).has(menu ? itemKey(menu.item.ref) : '');
  const play = usePlayTitle();
  const playFromMenu = (item: VodItem | SeriesItem, index: number) => {
    // A series has no single thing to play from here: its details pick the episode.
    if (item.ref.contentType !== 'movie' || !input) return openTitle(item.ref, index);
    const target: PlayTarget = { ref: item.ref, sourceKind: input.sourceKind, title: item.title, categoryId: item.categoryId };
    if (item.posterUrl) target.posterUrl = item.posterUrl;
    void play(target);
  };
  const menuItems: MenuItem[] = menu
    ? [
        { id: 'play', label: t('play'), icon: <Play aria-hidden className="size-4" />, onSelect: () => playFromMenu(menu.item, menu.index) },
        { id: 'open', label: t('openDetails'), icon: <Info aria-hidden className="size-4" />, onSelect: () => openTitle(menu.item.ref, menu.index) },
        ...(myListItem ? [myListItem] : []),
        {
          id: 'watched',
          label: menuWatched ? t('markUnwatched') : t('markWatched'),
          icon: <CircleCheck aria-hidden className="size-4" />,
          onSelect: () => void toggleWatched(menu.item.ref),
        },
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

  // VD-9: stable cell renderers, so VirtualGrid's memoised slots hold while the page re-renders
  // (menus, header, focus). Only the cursor's cell sees `gridFocused`: focusing the grid
  // re-renders that one poster, not every cell on screen.
  const sourceKind = input?.sourceKind;
  const watchedKeys = watchedPages.keys;
  const renderFilteredCell = useCallback(
    (item: VodItem | SeriesItem, _index: number, state: VirtualItemState) =>
      sourceKind ? (
        <GridPoster
          item={item}
          sourceKind={sourceKind}
          active={state.active}
          gridFocused={state.active && gridFocused}
          resume={resume}
          watched={watchedKeys.has(itemKey(item.ref))}
          locked={locks.itemLocked(item)}
        />
      ) : null,
    [sourceKind, gridFocused, resume, watchedKeys, locks],
  );
  const renderPagedCell = useCallback(
    (i: number, _index: number, state: VirtualItemState) =>
      input ? (
        <GridCell input={input} index={i} pageSize={pageSize} active={state.active} gridFocused={state.active && gridFocused} resume={resume} locks={locks} />
      ) : null,
    [input, pageSize, gridFocused, resume, locks],
  );

  return (
    // The grid's posters share one My List subscription (L2-vod-1).
    <GridMyListProvider>
      <div className="flex h-full min-h-0 flex-col" data-testid={`vod-grid-${kind}`}>
        {/*
          VL-grid-toolbars: one toolbar under the header, one hairline. Back, the decade chips, the
          rating floor, search and sort share a row; From/To and Hide watched wait behind Filters,
          whose badge counts what is on. Below sm the row wraps: the search takes a line, and the
          sort and the chips move into the Filters panel.
        */}
        <div className="flex flex-col gap-2 border-b border-divider px-(--page-gutter) py-2.5" data-testid="vod-grid-toolbar">
          <div className="flex flex-wrap items-center gap-2">
            <BackButton to={backHref} label={kind === 'movie' ? t('movies') : t('series')} className="-ms-2" />
            <h1 className="sr-only">{pageTitle}</h1>
            {/* The shell header carries the count from md up; below it the header has room for the title only. */}
            {countText && (
              <span title={countText} className="tabular min-w-0 flex-1 truncate text-sm text-fg-subtle sm:hidden">
                {countText}
              </span>
            )}
            {/* Mounted from the first frame (L2-vod-5): its placeholder chips hold the row while the source loads. */}
            <div id={`${filtersId}-chips`} className={cn('min-w-0 sm:flex-1', 'max-sm:order-3 max-sm:basis-full', !filtersOpen && 'max-sm:hidden')}>
              {sourceId && !source.isError && showChips && <DecadeChips filter={yearFilter} />}
            </div>
            {ratingFilterSet && (
              <RatingFloorChip
                setting={settingMinRating}
                on={filtered}
                onChange={(on) => setAllRatings(!on)}
                className="max-sm:order-2"
              />
            )}
            {showSearch && (
              <SearchInput
                value={searchDraft}
                onChange={setSearchDraft}
                size="sm"
                className="w-full max-sm:order-1 sm:w-56"
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
            )}
            <div id={`${filtersId}-sort`} className={cn('flex items-center gap-1', 'max-sm:order-2', !filtersOpen && 'max-sm:hidden')}>
              <Select
                aria-label={t('sortBy')}
                options={sortOptions}
                value={sort}
                onValueChange={(v) => setSort(v as VodSortKey)}
                className="h-8 w-auto min-w-36"
              />
              <IconButton
                size="sm"
                label={dirLabel}
                icon={dir === 'asc' ? <ArrowUpNarrowWide aria-hidden size={16} /> : <ArrowDownWideNarrow aria-hidden size={16} />}
                onClick={flipDir}
              />
            </div>
            <button
              type="button"
              aria-expanded={filtersOpen}
              aria-controls={`${filtersId}-sort ${filtersId}-bar`}
              onClick={() => setFiltersOpen((o) => !o)}
              className={cn(buttonClass('ghost', 'sm'), filtersOpen && 'bg-selected text-fg')}
              data-testid="vod-filters-toggle"
            >
              <SlidersHorizontal aria-hidden size={16} />
              {t('filters')}
              {activeFilters > 0 && <span className="sr-only">{t('filtersActive', { n: activeFilters })}</span>}
              {activeFilters > 0 && (
                <span aria-hidden className="tabular inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-fg px-1 text-xs leading-none font-semibold text-bg">
                  {activeFilters}
                </span>
              )}
            </button>
          </div>
          <div
            id={`${filtersId}-bar`}
            className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', !filtersOpen && 'hidden max-sm:hidden')}
            data-testid="vod-filter-bar"
          >
            {sourceId && !source.isError && <YearRangeFields filter={yearFilter} />}
            <Toggle className="shrink-0 items-center gap-2" label={t('hideWatched')} checked={hideWatched} onChange={setHideWatched} />
          </div>
        </div>

        {/* Right clicks bubble here from the grid's options; so do focus changes (React's focusin/focusout). */}
        <div
          ref={gridWrapRef}
          aria-busy={refreshing || undefined}
          data-refreshing={refreshing || undefined}
          className={cn(
            'min-h-0 flex-1 px-(--page-gutter) pt-4 motion-safe:transition-opacity motion-safe:duration-200',
            refreshing && 'motion-safe:opacity-60 motion-safe:delay-150',
          )}
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
                // A pasted paragraph would fill the page: the title echoes about 60 characters, the full query on hover.
                title={<span title={echoQuery(search) !== search ? search : undefined}>{t('noSearchMatchTitle', { query: echoQuery(search) })}</span>}
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
              // Keyed on the category only (L3-vod-3): a new sort or filter refills the mounted cells.
              key={categoryId}
              items={filteredItems}
              minColumnWidth={coverWidth}
              aspect="poster"
              postersFillCells
              label={categoryName}
              testId="vod-grid"
              initialActiveIndex={restoredIndex}
              resetKey={filterKey}
              getKey={(item) => item.ref.itemId}
              render={renderFilteredCell}
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
            <PageGateProvider value={pageGate}>
              <VirtualGrid<number>
                // Keyed on the category only (L2-vod-8, L3-vod-3): a new sort, search or filter refills the
                // mounted cells, whose pages keep their titles until the new ones arrive (useVodPage).
                key={categoryId}
                items={indices}
                minColumnWidth={coverWidth}
                aspect="poster"
                postersFillCells
                label={categoryName}
                testId="vod-grid"
                initialActiveIndex={restoredIndex}
                resetKey={filterKey}
                render={renderPagedCell}
                onSelect={(i) => {
                  const item = queryItem(i);
                  // A cell whose page failed: selecting it retries that page.
                  if (!item) return retryPageOf(i);
                  openTitle(item.ref, i);
                }}
                className="rounded-md pb-8 outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
            </PageGateProvider>
          )}
        </div>
        <ContextMenu pos={menu?.pos ?? null} items={menuItems} label={menu ? menu.item.titleBase || menu.item.title : ''} onClose={closeMenu} />
      </div>
    </GridMyListProvider>
  );
}

