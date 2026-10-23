import { useQueries } from '@tanstack/react-query';
import type { Virtualizer } from '@tanstack/react-virtual';
import { History, Radio, RotateCw, Search, SearchX, TriangleAlert, Tv, X } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { rpcRaw } from '@/api/transport';
import { itemKey, type Channel, type GuideSearchHit, type Page as PageOf, type RecentEntry, type SeriesItem, type Source, type VodItem } from '@/api/types';
import { guideHitLink, useProgrammeSearch } from '@/features/live/guide/programmeSearch';
import { useDebounced } from '@/features/live/hooks/useDebounced';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { displayChannelName } from '@/features/live/lib/channelName';
import { ms } from '@/features/live/lib/epgTime';
// The Scheduled list's clock and day words, from the module itself (pure helpers, no hooks).
import { clockTime, dayHeading } from '@/features/recording/lib/schedule';
import { useParentalStatus } from '@/features/parental/status';
import type { PlayItemArgs } from '@/features/player';
import { joinList } from '@/shell/dashboard/cards';
import { snapshotTitle } from '@/lib/title';

import { GridMyListProvider, myListTarget, PosterCard } from '../components/PosterCard';
import { PosterRail } from '../components/PosterRail';
import { isSourceMissing, SourceMissing } from '../components/SourceMissing';
import { resumeKey, useResumeLookup, useSettings, useSource, useSourcesList } from '../hooks/queries';
import { rememberSpot, useScrollMemory } from '../hooks/useScrollMemory';
import { useSearchLocks } from '../hooks/useSearchLocks';
import { useWatchedKeys } from '../hooks/useWatched';
import { usePageHeader } from '../hooks/usePageHeader';
import { useUrlSearchDraft } from '../hooks/useUrlSearchDraft';
import { handleGridKeyDown } from '../lib/gridNav';
import { itemLanguage } from '../lib/language';
import { clearSearches, forgetSearch, rememberSearch, setRecentSearchesPaused, useRecentSearches } from '../lib/recentSearches';
import {
  SEARCH_LIMIT,
  capSearchResult,
  detailHref,
  groupDuplicateHits,
  groupSearchResults,
  narrowsQuery,
  nextSearchLimit,
  normalizeQuery,
  previewGroups,
  searchRequestLimit,
  searchTerms,
  sourceFacets,
  splitStalkerResults,
  type GroupedHit,
  type SearchGroup,
  type SearchGroupKind,
  type SearchHit,
  type SearchMore,
  type SourceSearch,
} from '../lib/search';
import { useCoverWidth } from '../hooks/useCoverWidth';
import { useRailCardWidth } from '../hooks/useRailCardWidth';
import { Badge, Button, EmptyState, ErrorState, FilterChip, IconButton, Page, Poster, PosterCellWidthContext, SectionHeader, Skeleton, Tabs, cn, filterChipClass, gridLayout, tabPanelProps, useListVirtualizer, useScaledPx, useToast, errorDescription } from '@/ui';

/**
 * Pause after the last keystroke before the query runs (L2-perf-ui-5): with `catalog.search`
 * under 50 ms this answers inside the 150 ms budget. A request a newer query replaced is aborted
 * (its query loses its observer, and `useRpcQuery` hands the signal to the transport).
 */
const DEBOUNCE_MS = 100;

/**
 * Portal searches wait longer and need a few characters (VD-6): each one asks every Stalker
 * source for movies and series, up to 4 portal pages a call, so the library's 100 ms pause sent
 * dozens of portal requests per typed word.
 */
const PORTAL_DEBOUNCE_MS = 450;
const PORTAL_MIN_CHARS = 3;

/** The URL keeps the text as typed (spaces too); blank text removes `q`. */
const keepTyped = (draft: string) => (draft.trim() ? draft : '');

/** The shell header's search field, which this page feeds through `usePageHeader`. */
const headerField = () => document.querySelector<HTMLInputElement>('[data-shell-search]');

/**
 * Focuses the header search field once it exists and holds focus (the header mounts or swaps
 * it after this page publishes its header), checking every 50 ms for a moment. Focus the user
 * has moved anywhere else meanwhile is left alone; only `<body>` and the control that opened
 * the page (a rail link) give way. Returns the cancel function.
 */
function focusFieldWhenReady(timeoutMs = 1500): () => void {
  const opener = document.activeElement;
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const field = headerField();
    const active = document.activeElement;
    if (field && active === field) return;
    if (active && active !== document.body && active !== opener) return;
    field?.focus();
    if (Date.now() < deadline) timer = setTimeout(step, 50);
  };
  step();
  return () => clearTimeout(timer);
}

/**
 * Focuses result `index` once its row is mounted (rows are virtualized, so a row scrolled to a
 * moment ago mounts a frame or two later). `reveal` scrolls it into view; without it, focus
 * already taken elsewhere is never stolen. `section` picks the Top results section that numbers
 * the index (each counts from 0); without one, the first result with that index.
 */
function focusResult(scroller: HTMLElement, index: number, reveal: boolean, section?: string, frames = 10): void {
  if (!reveal) {
    const active = document.activeElement;
    if (active && active !== document.body) return;
  }
  // Matched by value, not in a selector: a remembered section is read back from storage.
  const scope = section ? [...scroller.querySelectorAll<HTMLElement>('[data-search-section]')].find((el) => el.dataset['searchSection'] === section) : scroller;
  const cell = scope?.querySelector<HTMLElement>(`[data-grid-index="${index}"]`);
  if (cell) {
    cell.focus({ preventScroll: true });
    if (reveal) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } else if (frames > 0) {
    requestAnimationFrame(() => focusResult(scroller, index, reveal, section, frames - 1));
  }
}

const EMPTY_STALKER = splitStalkerResults([]);

/** Guide programmes the Programmes tab lists for one query (`epg.search`, per source and in all). */
const PROGRAMME_LIMIT = 50;

/**
 * Stalker portals keep VOD out of SQLite, so their movies and series are searched on the portal,
 * once the query has rested for PORTAL_DEBOUNCE_MS and has PORTAL_MIN_CHARS characters. A query
 * the page opens with (a link, Back) goes out at once.
 */
function useStalkerSearch(sources: Source[], typed: string) {
  const targets = sources.filter((s) => s.kind === 'stalker');
  const wanted = [...typed].length >= PORTAL_MIN_CHARS ? typed : '';
  const rested = useDebounced(wanted, PORTAL_DEBOUNCE_MS);
  // Too short (or cleared): the portal results go at once rather than after the pause.
  const query = wanted ? rested : '';
  const results = useQueries({
    queries: targets.flatMap((s) =>
      (['movie', 'series'] as const).map((contentType) => {
        const args = { sourceId: s.id, query, contentType };
        return {
          queryKey: ['stalker.search', args],
          // The signal aborts a portal search that a newer query replaced.
          queryFn: async ({ signal }) => (await rpcRaw('stalker.search', args, { signal })) as PageOf<VodItem | SeriesItem>,
          enabled: !!query,
          staleTime: 60_000,
        };
      }),
    ),
  });
  // Waiting out the pause counts as pending, so the last portal results stay on screen meanwhile.
  const pending = (targets.length > 0 && !!wanted && wanted !== query) || (!!query && results.some((r) => r.isPending));
  // The same answers give the same arrays, so the result groups only rebuild when a portal answers.
  const stamp = `${query}\u0000${targets.map((s) => s.id).join(',')}\u0000${results.map((r) => r.dataUpdatedAt).join(',')}`;
  const fresh = useMemo(
    () => (query ? splitStalkerResults(results.flatMap((r) => r.data?.items ?? [])) : EMPTY_STALKER),
    [stamp], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // While the portals answer a new query, the last answered results stay on screen (useQueries
  // has no keepPreviousData across keys), so the list never flashes short or empty.
  const [settled, setSettled] = useState(fresh);
  if (!pending && settled !== fresh) setSettled(fresh);
  const failed = results.filter((r) => r.isError);
  return {
    ...(pending ? settled : fresh),
    pending,
    error: failed[0]?.error ?? undefined,
    retry: () => failed.forEach((r) => void r.refetch()),
  };
}

/** `/search` (every source) and `/s/:sourceId/search` (one source). Movies and series open details; channels play. */
export function SearchPage({ scoped }: { scoped?: boolean }) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const { sourceId: routeSourceId } = useParams();
  const sourceId = scoped ? routeSourceId : undefined;
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const facet = scoped ? undefined : (params.get('source') ?? undefined);
  const typeParam = params.get('type');
  // The field's text, debounced into `q`; a write of its own never comes back over newer typing (L3-vod-1).
  const [draft, setDraft] = useUrlSearchDraft({ delayMs: DEBOUNCE_MS, toParam: keepTyped });
  const query = normalizeQuery(q);

  // While parental controls are set, recent searches are neither kept nor offered, and setting
  // them clears the list (lib/recentSearches). Before paint, so a stored chip never flashes up;
  // until the status says controls are off (a cold start, a status that failed to load), the
  // zero state offers none either.
  const parental = useParentalStatus();
  const parentalOn = parental.data?.enabled;
  useLayoutEffect(() => {
    if (parentalOn !== undefined) setRecentSearchesPaused(parentalOn);
  }, [parentalOn]);

  const sourcesQ = useSourcesList();
  const scopedSource = useSource(sourceId);
  const allSources = useMemo(() => sourcesQ.data ?? [], [sourcesQ.data]);
  const searchSources = useMemo(
    () => (sourceId ? (scopedSource.data ? [scopedSource.data] : []) : allSources),
    [sourceId, scopedSource.data, allSources],
  );

  // Per-type cap, raised by "Show more"; any new query, scope, or source facet starts again at the first step.
  const capKey = `${sourceId ?? ''}\u0000${facet ?? ''}\u0000${query}`;
  const [cap, setCap] = useState({ key: capKey, limit: SEARCH_LIMIT });
  const limit = cap.key === capKey ? cap.limit : SEARCH_LIMIT;
  const nextLimit = nextSearchLimit(limit);

  const requestLimit = searchRequestLimit(limit);
  // A source facet searches that source alone, so its results and caps are its own.
  const searchSourceId = sourceId ?? facet;
  const catalogArgs = searchSourceId ? { query, sourceId: searchSourceId, limit: requestLimit } : { query, limit: requestLimit };
  const catalog = useRpcQuery('catalog.search', catalogArgs, { enabled: !!query, staleTime: 30_000, keepPrevious: true });
  // The chips keep counting every source while a facet narrows the results (the same args as the
  // unfiltered first page, so picking a chip reads it from the cache).
  const facetBase = useRpcQuery(
    'catalog.search',
    { query, limit: searchRequestLimit(SEARCH_LIMIT) },
    { enabled: !!query && !!facet, staleTime: 30_000, keepPrevious: true },
  );
  const stalker = useStalkerSearch(searchSources, query);
  // Guide programmes: every searched source's, or the picked chip's.
  const prefs = useDisplayPrefs();
  const programmeSources = useMemo(() => (facet ? [facet] : searchSources.map((s) => s.id)), [facet, searchSources]);
  const programmes = useProgrammeSearch(programmeSources, query, { enabled: !!query, limit: PROGRAMME_LIMIT, offsetMinutes: prefs.epgOffsetMinutes });

  // While a larger page loads, the previous page stays on screen: cap it by the limit it was fetched with.
  const [settledLimit, setSettledLimit] = useState(limit);
  useEffect(() => {
    if (catalog.data && !catalog.isPlaceholderData) setSettledLimit(limit);
  }, [catalog.data, catalog.isPlaceholderData, limit]);
  const dataLimit = catalog.isPlaceholderData ? settledLimit : limit;
  const capped = useMemo(() => capSearchResult(catalog.data, dataLimit), [catalog.data, dataLimit]);
  const loadingMore = catalog.isPlaceholderData && catalog.isFetching && cap.key === capKey && limit > settledLimit;

  const answerGroups = useMemo(
    () =>
      groupSearchResults({
        result: capped.result,
        extraMovies: stalker.movies,
        extraSeries: stalker.series,
        sources: allSources.length ? allSources : searchSources,
        sourceFilter: facet,
      }),
    [capped.result, stalker.movies, stalker.series, allSources, searchSources, facet],
  );
  // L3-vod-5: the query the results on screen answer (catalog.search keeps the last answer while a
  // newer one loads). While the box holds a longer query than that, the results narrow to it at
  // once, from the frame of the key, and the full answer replaces them when it arrives.
  const [answered, setAnswered] = useState(query);
  if (catalog.data && !catalog.isPlaceholderData && !catalog.isFetching && answered !== query) setAnswered(query);
  const draftQuery = normalizeQuery(draft);
  const previewTerms = useMemo(
    () => (draftQuery && narrowsQuery(draftQuery, answered) ? searchTerms(draftQuery) : undefined),
    [draftQuery, answered],
  );
  const groups = useMemo(() => (previewTerms ? previewGroups(answerGroups, previewTerms) : answerGroups), [answerGroups, previewTerms]);
  const facetCapped = useMemo(
    () => (facet ? capSearchResult(facetBase.data, SEARCH_LIMIT) : capped),
    [facet, facetBase.data, capped],
  );
  // L2-perf-desktop-11: chips count from the all-sources result (every hit names its source); no
  // source is searched alone just to count it. Where a type hit its cap those counts are lower
  // bounds ("N+"). The picked chip's own search is on screen already, so its count comes from it.
  const facetOwn = useMemo(
    () => (facet && catalog.data && !catalog.isPlaceholderData ? new Map<string, SourceSearch>([[facet, { groups: answerGroups, more: capped.more }]]) : undefined),
    [facet, catalog.data, catalog.isPlaceholderData, answerGroups, capped.more],
  );
  const facets = useMemo(
    () =>
      scoped
        ? []
        : sourceFacets(
            groupSearchResults({ result: facetCapped.result, extraMovies: stalker.movies, extraSeries: stalker.series, sources: allSources }),
            facetCapped.more,
            facetOwn,
          ),
    [scoped, facetCapped.result, facetCapped.more, stalker.movies, stalker.series, allSources, facetOwn],
  );

  const scopeName = scopedSource.data?.name;
  const placeholder = scoped && scopeName ? t('searchInSource', { source: scopeName }) : t('searchEverything');
  // ArrowDown in the header field moves into the results (when there are any on screen).
  // Reads only refs, so the header the shell holds never calls a stale copy.
  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowDown' || e.defaultPrevented || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const scroller = scrollRef.current;
    if (!scroller?.querySelector('[data-grid-index]')) return;
    e.preventDefault();
    // Scrolled far down, the first row is not mounted: go back up to it.
    if (!scroller.querySelector('[data-grid-index="0"]')) scroller.scrollTop = 0;
    focusResult(scroller, 0, true);
  };
  usePageHeader(
    {
      title: t('search'),
      subtitle: scoped ? scopeName : undefined,
      search: {
        value: draft,
        onChange: setDraft,
        placeholder,
        onSubmit: (v) => {
          setDraft(v);
          // Enter on an empty field moves to the first recent search, as on a TV remote.
          if (!v.trim()) scrollRef.current?.querySelector<HTMLElement>('[data-recent-search]')?.focus();
          else rememberSearch(v);
        },
        onKeyDown: onFieldKeyDown,
      },
    },
    [draft, placeholder, scopeName],
  );

  const setType = (kind: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('type', kind);
        return next;
      },
      { replace: true },
    );

  const setFacet = (id: string | undefined) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('source', id);
        else next.delete('source');
        return next;
      },
      { replace: true },
    );

  // Stable, so typing in the field does not re-render the result grids.
  const playChannel = useCallback(
    (c: Channel, hit: SearchHit) => {
      if (!hit.sourceKind) return;
      const args: PlayItemArgs = { ref: c.ref, title: c.name, isLive: true, isRadio: c.isRadio, sourceKind: hit.sourceKind };
      if (c.logoUrl) args.posterUrl = c.logoUrl;
      if (c.categoryId) args.categoryId = c.categoryId;
      // The player loads on the press, as on Home (performance audit SH-2): a static import of the
      // player barrel made a cold Search wait for the player's controls before its first render.
      import('@/features/player')
        .then(({ playItem }) => playItem(args))
        .catch((err: unknown) => toast({ title: t('playFailed'), description: errorDescription(err), variant: 'error' }));
    },
    [toast, t],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  // VL-page-rhythm: the grids' column width at the UI scale (VirtualGrid scales its own the same way),
  // so a search poster is the size of a category poster at every scale.
  const coverWidth = useScaledPx(useCoverWidth(useSettings().coverSize), true);
  const resume = useResumeLookup(!!query);
  // One result type at a time, chosen by tab; a type missing from these results falls back to the first one present.
  const activeGroup = groups.find((g) => g.kind === typeParam) ?? groups[0];
  // Programmes are a tab of their own, after the catalog's; the only one when nothing else matched.
  const programmeHits = programmes.hits;
  // Top results (critique: search): when the answer spans more than one type, the page opens on a
  // slice of each (a rail of movies, of series, the first channels and programmes), each with
  // "See all" to its tab, instead of the first type alone and a mostly empty screen.
  const topAvailable = groups.length + (programmeHits.length > 0 ? 1 : 0) > 1;
  const showTop = topAvailable && (typeParam === 'top' || typeParam === null || (!groups.some((g) => g.kind === typeParam) && typeParam !== 'programmes'));
  const showProgrammes = !showTop && programmeHits.length > 0 && (typeParam === 'programmes' || groups.length === 0);
  /** The URL of one type's tab, for a Top results section's "See all". */
  const typeHref = (kind: string) => {
    const next = new URLSearchParams(params);
    next.set('type', kind);
    return `${location.pathname}?${next.toString()}`;
  };
  const anyResults = groups.length > 0 || programmeHits.length > 0;
  const showBadges = !scoped && allSources.length > 1;
  const loading = !!query && (catalog.isPending || (groups.length === 0 && stalker.pending));
  // Back from a title: the results open where you left them (same query, type and source in the
  // URL), with focus on the title you opened. A link here (PUSH) is a fresh visit from the top.
  const navigationType = useNavigationType();
  const memoryKey = `${location.pathname}${location.search}`;
  useScrollMemory({
    key: memoryKey,
    getScroller: () => scrollRef.current,
    ready: !!query && !loading && groups.length > 0,
    restore: navigationType !== 'PUSH',
    onRestored: (spot, scroller) => {
      if (spot.index !== undefined) focusResult(scroller, spot.index, false, spot.section);
    },
  });
  // Enter on a focused result also fires click, so this covers the keyboard too. In Top results
  // the section goes with the index: series #3 is not movie #3.
  const rememberResult = (e: MouseEvent<HTMLElement>) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-grid-index]') : null;
    const index = Number(cell?.dataset['gridIndex']);
    const section = cell?.closest<HTMLElement>('[data-search-section]')?.dataset['searchSection'];
    if (cell && Number.isInteger(index)) rememberSpot(memoryKey, { scrollTop: scrollRef.current?.scrollTop ?? 0, index, ...(section ? { section } : {}) });
    // Opening a result makes the query one worth offering again.
    if (cell) rememberSearch(query);
  };
  // VL-search-locks: the parental lock on every source with hits, as the grids and rails show it.
  const lockedHit = useSearchLocks(useMemo(() => [...new Set(groups.flatMap((g) => g.hits.map((h) => h.sourceId)))], [groups]));

  // L1-vod-3: opened from a link, the rail or the palette, the cursor lands in the field, so
  // typing searches at once. Back (POP) leaves focus to the restore above; typing replaces.
  // A Top results "See all" is a PUSH too (Back returns to Top results), but it stays on this
  // search: the page starts again at the top with focus on the opened tab's first result.
  const lastSearch = useRef<{ key: string; pathname: string; q: string | null } | null>(null);
  useEffect(() => {
    const prev = lastSearch.current;
    const q = params.get('q');
    lastSearch.current = { key: location.key, pathname: location.pathname, q };
    if (navigationType !== 'PUSH') return;
    const scroller = scrollRef.current;
    const sameSearch = !!prev && prev.key !== location.key && prev.pathname === location.pathname && prev.q === q && !!q;
    if (sameSearch && scroller) {
      scroller.scrollTop = 0;
      focusResult(scroller, 0, false);
      return;
    }
    return focusFieldWhenReady();
    // params is read for the query only; the location key marks a new visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, navigationType]);

  // Some results arrived but one lookup failed (the library or a portal): say so instead of showing a silently short list.
  const partialError = groups.length > 0 ? (catalog.isError ? catalog.error : stalker.error) : undefined;

  let body;
  if (scoped && scopedSource.isError && isSourceMissing(scopedSource.error)) {
    // L1-vod-13: the scoped source was removed; nothing to search, so offer the way back instead.
    body = <SourceMissing />;
  } else if (!query) {
    body = (
      <SearchStart
        sourceId={sourceId}
        sources={allSources}
        offerRecent={parentalOn === false}
        onPick={(q) => {
          setDraft(q);
          rememberSearch(q);
        }}
        title={scoped && scopeName ? t('searchSourceTitle', { source: scopeName }) : t('searchTitle')}
        hint={draft.trim().length === 1 ? t('searchMinLength', { count: 2 }) : t('searchHint')}
        empty={
          <EmptyState
            icon={<Search size={28} />}
            title={scoped && scopeName ? t('searchSourceTitle', { source: scopeName }) : t('searchTitle')}
            description={draft.trim().length === 1 ? t('searchMinLength', { count: 2 }) : t('searchHint')}
          />
        }
      />
    );
  } else if (catalog.isError && !anyResults) {
    body = <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;
  } else if (loading && programmeHits.length === 0) {
    body = <SearchSkeleton />;
  } else if (!anyResults && stalker.error) {
    body = <ErrorState error={stalker.error} onRetry={stalker.retry} />;
  } else if (!anyResults && facet) {
    // A facet kept from an earlier query: say so, and offer the way out (the chips only render with results).
    const facetName = allSources.find((s) => s.id === facet)?.name ?? facets.find((f) => f.sourceId === facet)?.sourceName;
    body = (
      <EmptyState
        icon={<SearchX size={28} />}
        title={facetName ? t('noResultsInSourceTitle', { query, source: facetName }) : t('noResultsTitle', { query })}
        description={t('noResultsInSourceHint')}
        action={
          <Button variant="secondary" onClick={() => setFacet(undefined)}>
            {t('searchAllSources')}
          </Button>
        }
      />
    );
  } else if (!anyResults) {
    body = <EmptyState icon={<SearchX size={28} />} title={t('noResultsTitle', { query })} description={t('noResultsHint')} />;
  } else {
    body = (
      <>
        {facets.length > 1 && (
          // One row that scrolls sideways on a phone instead of three rows of chips (critique: search, phone).
          <div
            role="group"
            aria-label={t('filterBySource')}
            className="flex gap-2 max-sm:-mx-(--page-gutter) max-sm:overflow-x-auto max-sm:px-(--page-gutter) max-sm:scrollbar-none sm:flex-wrap"
          >
            <FacetChip active={!facet} onClick={() => setFacet(undefined)} label={t('allSources')} />
            {facets.map((f) => (
              <FacetChip
                key={f.sourceId}
                active={facet === f.sourceId}
                onClick={() => setFacet(f.sourceId)}
                label={f.sourceName}
                count={f.partial ? t('searchCountMore', { count: f.count }) : f.count}
              />
            ))}
          </div>
        )}
        <Tabs
          label={t('search')}
          panelIdPrefix="search-results"
          value={showTop ? 'top' : showProgrammes ? 'programmes' : (activeGroup?.kind ?? '')}
          onChange={setType}
          items={[
            ...(topAvailable ? [{ id: 'top', label: t('topResults') }] : []),
            ...groups.map((g) => ({
              id: g.kind,
              label: t(`group_${g.kind}`),
              badge: capped.more[g.kind] ? t('searchCountMore', { count: g.hits.length }) : g.hits.length,
            })),
            ...(programmeHits.length > 0
              ? [{ id: 'programmes', label: t('group_programmes'), badge: programmeHits.length >= PROGRAMME_LIMIT ? t('searchCountMore', { count: programmeHits.length }) : programmeHits.length }]
              : []),
          ]}
        />
        {showTop ? (
          <div {...tabPanelProps('search-results', 'top')} onClickCapture={rememberResult} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <TopResults
              groups={groups}
              more={capped.more}
              programmes={programmeHits}
              programmesMore={programmeHits.length >= PROGRAMME_LIMIT}
              sources={allSources}
              showBadges={showBadges}
              stripCountryPrefix={prefs.stripCountryPrefix}
              resume={resume}
              locked={lockedHit}
              typeHref={typeHref}
              onPlayChannel={playChannel}
            />
          </div>
        ) : showProgrammes ? (
          <div {...tabPanelProps('search-results', 'programmes')} onClickCapture={rememberResult} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <ProgrammeList hits={programmeHits} sources={allSources} showSource={showBadges} stripCountryPrefix={prefs.stripCountryPrefix} />
          </div>
        ) : activeGroup && (
          <div
            {...tabPanelProps('search-results', activeGroup.kind)}
            onClickCapture={rememberResult}
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {activeGroup.kind === 'live' ? (
              <ChannelGrid hits={activeGroup.hits} showBadges={showBadges} onPlayChannel={playChannel} scrollRef={scrollRef} />
            ) : (
              <PosterGrid
                key={activeGroup.kind}
                kind={activeGroup.kind}
                hits={activeGroup.hits}
                showBadges={showBadges}
                minWidth={coverWidth}
                scrollRef={scrollRef}
                resume={resume}
                locked={lockedHit}
              />
            )}
          </div>
        )}
        {partialError && (
          <PartialErrorNotice
            message={partialError.message}
            onRetry={() => {
              if (catalog.isError) void catalog.refetch();
              stalker.retry();
            }}
          />
        )}
        <CappedNotice
          more={capped.more}
          limit={dataLimit}
          nextLimit={nextLimit}
          loading={loadingMore}
          onShowMore={() => nextLimit !== undefined && setCap({ key: capKey, limit: nextLimit })}
        />
      </>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-x-hidden overflow-y-auto" data-testid={scoped ? 'vod-search-source' : 'vod-search'}>
      <Page width="wide" className="flex flex-col gap-6">
        {/* VL-search-title-dup: the header says "Search" (and the source); the page's h1 is for screen readers. */}
        <h1 className="sr-only">{t('search')}</h1>
        {body}
      </Page>
    </div>
  );
}

/** A source filter chip (the kit's): one line however long the name (it truncates, the native title has it all). */
function FacetChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number | string }) {
  return (
    <FilterChip pressed={active} onClick={onClick} title={label} count={count} className="max-w-[min(100%,16rem)]">
      {label}
    </FilterChip>
  );
}

/**
 * Shown when any result type hit its cap: says the list is partial, offers
 * the next step, and at the last step asks for a narrower query instead.
 */
function CappedNotice({
  more,
  limit,
  nextLimit,
  loading,
  onShowMore,
}: {
  more: SearchMore;
  limit: number;
  nextLimit: number | undefined;
  loading: boolean;
  onShowMore: () => void;
}) {
  const { t } = useTranslation('vod');
  if (!more.live && !more.movies && !more.series) return null;
  return (
    <div
      data-testid="vod-search-capped"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-edge bg-surface px-4 py-3 text-sm text-fg-muted"
    >
      <p role="status" className="min-w-0 flex-1">
        {t('searchShowingFirst', { count: limit })} {t(nextLimit === undefined ? 'searchRefineAll' : 'searchRefineHint')}
      </p>
      {nextLimit !== undefined && (
        <Button size="sm" variant="secondary" loading={loading} onClick={onShowMore}>
          {t('searchShowMore', { count: nextLimit })}
        </Button>
      )}
    </div>
  );
}

/** Inline notice when part of a search failed while other results are shown. */
function PartialErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation('vod');
  const { t: tc } = useTranslation('common');
  return (
    <div
      role="alert"
      data-testid="vod-search-partial-error"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-edge bg-surface px-4 py-3 text-sm text-fg-muted"
    >
      <TriangleAlert aria-hidden size={16} className="shrink-0 text-warning" />
      <p className="min-w-0 flex-1">
        <span className="text-fg">{t('searchPartialError')}</span> <span className="text-fg-subtle">{message}</span>
      </p>
      <Button size="sm" variant="secondary" icon={<RotateCw aria-hidden size={14} />} onClick={onRetry}>
        {tc('retry')}
      </Button>
    </div>
  );
}

/** Local midnight of the day `at` falls on. */
function dayStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Programme hits (in start order) grouped by the day they start on, each with its place in the whole list. */
function programmeDays(hits: readonly GuideSearchHit[]): { day: number; items: { hit: GuideSearchHit; index: number; at: number }[] }[] {
  const days: { day: number; items: { hit: GuideSearchHit; index: number; at: number }[] }[] = [];
  hits.forEach((hit, index) => {
    const at = ms(hit.program.start);
    const day = dayStart(at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push({ hit, index, at });
    else days.push({ day, items: [{ hit, index, at }] });
  });
  return days;
}

/**
 * Guide programmes that match: start, title, channel (and source), under a heading per day, so
 * the time column holds the clock alone ("4:50 AM", "16:50"). One grid serves every row
 * (rows are subgrids): the column takes the widest clock in the locale and the titles share one
 * edge. One opens the guide at the programme, where its row takes the cursor (as a hit of the
 * guide's own search does).
 */
const ProgrammeList = memo(function ProgrammeList({
  hits,
  sources,
  showSource,
  stripCountryPrefix,
}: {
  hits: readonly GuideSearchHit[];
  sources: readonly Source[];
  showSource: boolean;
  stripCountryPrefix: boolean;
}) {
  const { i18n } = useTranslation('vod');
  const navigate = useNavigate();
  const lang = i18n.language;
  const listId = useId();
  const names = useMemo(() => new Map(sources.map((s) => [s.id, s.name])), [sources]);
  const days = useMemo(() => programmeDays(hits), [hits]);
  const now = Date.now();
  // Up and Down move between the rows; ArrowDown in the search field lands on the first.
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-grid-index]')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  return (
    <ul className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4" onKeyDown={onKeyDown} data-testid="search-programmes">
      {days.map(({ day, items }, d) => {
        const heading = dayHeading(day, now, lang);
        const headingId = `${listId}-${day}`;
        return (
          <li key={day} className="col-span-full grid grid-cols-subgrid">
            <p id={headingId} className={cn('col-span-full flex items-baseline gap-2 px-3 pb-1 text-caption', d > 0 && 'pt-3')} data-testid="search-programme-day">
              <span className="font-medium text-fg-muted first-letter:uppercase">{heading.label}</span>
              {heading.date ? <span className="text-fg-subtle">{heading.date}</span> : null}
            </p>
            <ul aria-labelledby={headingId} className="col-span-full grid grid-cols-subgrid gap-y-1">
              {items.map(({ hit, index, at }) => {
                const link = guideHitLink(hit);
                const channel = displayChannelName(hit.channelName, stripCountryPrefix);
                const source = showSource ? names.get(hit.ref.sourceId) : undefined;
                return (
                  <li key={`${itemKey(hit.ref)}@${at}`} className="col-span-full grid grid-cols-subgrid">
                    <button
                      type="button"
                      data-grid-index={index}
                      onClick={() => void navigate(link.to, { state: link.state })}
                      className="col-span-full grid grid-cols-subgrid items-start rounded-md px-3 py-2.5 text-start outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span className="pt-0.5 text-sm whitespace-nowrap tabular-nums text-fg-muted" data-testid="search-programme-time">
                        {clockTime(at, lang)}
                      </span>
                      <span className="min-w-0">
                        <span dir="auto" className="block truncate text-sm font-medium text-fg">
                          {hit.program.title}
                        </span>
                        <span dir="auto" className="block truncate text-xs text-fg-muted">
                          {source ? `${channel} · ${source}` : channel}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
});

const CHANNEL_MIN_WIDTH = 260;
const CHANNEL_GAP = 8;
/** One channel button: 48px logo plus padding and border. Rows are measured after layout; this is the estimate. */
const CHANNEL_ROW_HEIGHT = 66;
const POSTER_GAP = 16;
/** Title (two lines) and meta line under a poster; rows are measured after layout. */
const POSTER_CAPTION_HEIGHT = 64;

/**
 * Whether the grid growing or shrinking by the rows' reported sizes would start or stop its page
 * scroller scrolling (P2-POSTERS-5). Called in the rows' observer callback, after the browser's
 * layout, so its reads force none. The scroller's content ends at its last child's bottom edge
 * (the search page's `Page`, with its own bottom padding).
 */
function changesOverflow(
  scroller: HTMLElement | null,
  list: HTMLElement,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  sizes: readonly { index: number; size: number }[],
): boolean {
  if (!scroller) return false;
  // The list's height on screen against the virtualizer's total with these sizes in (which counts
  // any it was given since it last rendered).
  let grow = virtualizer.getTotalSize() - (parseFloat(list.style.height) || 0);
  for (const { index, size } of sizes) {
    const item = Number.isInteger(index) ? virtualizer.measurementsCache[index] : undefined;
    if (item) grow += size - (virtualizer.itemSizeCache.get(item.key) ?? item.size);
  }
  if (Math.abs(grow) < 0.5) return false;
  const room = scroller.clientHeight;
  const last = scroller.lastElementChild;
  const content =
    scroller.scrollHeight > room || !last
      ? scroller.scrollHeight
      : last.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
  const after = content + grow;
  // Within a pixel of the edge counts as a change: rounding could put either side over it.
  return (content > room) !== (after > room) || Math.abs(after - room) < 1;
}

/**
 * Hits in a responsive grid whose rows are virtualized against the page
 * scroller, so a 1000-result step mounts only the rows near the viewport.
 * Arrow keys still move by cell and row (`handleGridKeyDown` scrolls the page
 * when the target row is not mounted yet); ArrowUp on the first row returns
 * to the search field, where ArrowDown came in.
 *
 * P2-POSTERS-1: nothing reads layout while cells mount. The grid reads its
 * width and offset once, in a layout effect before it has cells (a page
 * layout without them), and mounts its cells at that width, so a poster grid
 * hands its posters the column width instead of each reading its frame. Rows
 * are measured by an observer of the grid's own, after the browser's layout,
 * where each new row read its offsetHeight as it mounted (react-virtual's
 * measureElement), a forced layout per row between the posters' DOM writes,
 * and the offset was read after every render. A changed row height commits in
 * the observer's callback (flushSync), before paint, so rows do not show a
 * frame at their estimate; unless that would start or stop the page scrolling
 * (P2-POSTERS-5), when it renders as the next task.
 */
function HitGrid({
  hits,
  minWidth,
  gap,
  rowHeight,
  renderCell,
  scrollRef,
  testId,
  postersFillCells,
}: {
  hits: SearchHit[];
  minWidth: number;
  gap: number;
  /** Estimated row height (without the gap) for a cell width. */
  rowHeight: (cellWidth: number) => number;
  renderCell: (hit: SearchHit, index: number, cellWidth: number) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  testId: string;
  /** Each cell's poster is as wide as the cell (poster cards): it loads at the column width (P2-POSTERS-1). */
  postersFillCells?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [scrollMargin, setScrollMargin] = useState(0);
  // The cells mount once the grid has read its own width, not at the 960 px guess: a poster keeps
  // the column width it mounted with (P2-POSTERS-1).
  const [measured, setMeasured] = useState(false);
  /**
   * The rows' observer. A row mounted while its callback commits is observed from the next frame:
   * observed in the callback, at the depth of the rows it just reported, the browser would hold
   * its first report back and raise a ResizeObserver loop error.
   */
  const rowsSeen = useRef<{ ro: ResizeObserver | null; flushing: boolean; late: Element[] }>({ ro: null, flushing: false, late: [] });

  const latestVirtualizer = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);

  // Before the virtualizer's own observer is made, so this one's callback runs first in a frame,
  // while the layout is still the browser's own.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // The offset of the grid inside the page scroller: the tabs, facets and notices above it can
    // change height. Only the range of mounted rows depends on it, not where a row is drawn.
    const read = () => {
      const scroller = scrollRef.current;
      const margin = scroller ? Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop) : 0;
      return { width: el.clientWidth, margin };
    };
    const first = read();
    if (first.width > 0) setWidth(first.width);
    setScrollMargin(first.margin);
    setMeasured(true);
    if (typeof ResizeObserver === 'undefined') return;
    const seen = rowsSeen.current;
    const ro = new ResizeObserver((entries) => {
      // After the browser's layout: these reads force none. A row's width is the grid's, so a
      // resize reports the rows too.
      const now = read();
      const sizes = entries.map((entry) => ({
        index: Number((entry.target as HTMLElement).dataset['index']),
        size: Math.round(entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight),
      }));
      const virtualizer = latestVirtualizer.current;
      const commit = () => {
        setScrollMargin(now.margin);
        for (const { index, size } of sizes) if (Number.isInteger(index)) virtualizer?.resizeItem(index, size);
      };
      // P2-POSTERS-5: a commit that starts or stops the page scrolling shows or hides a classic
      // scrollbar (Windows, Linux), which narrows or widens every row and the tabs above them
      // inside this callback: the browser holds those reports back and raises a loop error. That
      // one renders as the next task instead, as react-virtual rendered a row's later size
      // changes, and its rows show one frame at their old sizes.
      if (virtualizer && !changesOverflow(scrollRef.current, el, virtualizer, sizes)) {
        seen.flushing = true;
        try {
          flushSync(commit);
        } finally {
          seen.flushing = false;
        }
      } else commit();
      // A new width lays the rows out again, which this callback must not commit (the rows' new
      // sizes would be a loop error); it renders as the next task, as it did before.
      if (now.width > 0) setWidth(now.width);
      if (seen.late.length > 0) {
        const late = seen.late.splice(0);
        requestAnimationFrame(() => {
          for (const row of late) if (row.isConnected) seen.ro?.observe(row);
        });
      }
    });
    seen.ro = ro;
    return () => {
      ro.disconnect();
      seen.ro = null;
    };
  }, []);

  const { columns, cellWidth } = gridLayout(width, minWidth, gap);
  const rowCount = Math.ceil(hits.length / columns);
  const virtualizer = useListVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight(cellWidth) + gap,
    overscan: 4,
    scrollMargin,
    initialRect: { width: 960, height: 720 },
  });
  latestVirtualizer.current = virtualizer;

  const observeRow = useCallback((row: HTMLDivElement | null) => {
    const seen = rowsSeen.current;
    if (!row || !seen.ro) return;
    if (seen.flushing) seen.late.push(row);
    else seen.ro.observe(row);
    return () => seen.ro?.unobserve(row);
  }, []);

  useEffect(() => {
    virtualizer.measure();
  }, [columns, cellWidth, virtualizer]);

  // Rounded as the frame's clientWidth is, in a box with one identity: posters read it as their
  // pictures mount, so a new width re-renders none of them (P2-POSTERS-1, as P2-GRID-1).
  const posterWidth = useRef(0);
  posterWidth.current = Math.round(cellWidth);

  return (
    <div
      ref={listRef}
      role="list"
      data-testid={testId}
      data-columns={columns}
      style={{ position: 'relative', height: virtualizer.getTotalSize() }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-grid-index]') : null;
          const index = Number(cell?.dataset['gridIndex']);
          const field = Number.isInteger(index) && index < columns ? headerField() : null;
          if (field) {
            e.preventDefault();
            field.focus();
            return;
          }
        }
        handleGridKeyDown(e, { count: hits.length });
      }}
    >
      <PosterCellWidthContext.Provider value={postersFillCells ? posterWidth : undefined}>
        {(measured ? virtualizer.getVirtualItems() : []).map((row) => {
          const first = row.index * columns;
          return (
            <div
              key={row.key}
              role="presentation"
              data-index={row.index}
              ref={observeRow}
              className="grid"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                columnGap: gap,
                paddingBottom: gap,
                transform: `translateY(${row.start - scrollMargin}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {hits.slice(first, first + columns).map((h, j) => {
                const i = first + j;
                return (
                  <div key={h.key} role="listitem" aria-posinset={i + 1} aria-setsize={hits.length} className="min-w-0">
                    {renderCell(h, i, cellWidth)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </PosterCellWidthContext.Provider>
    </div>
  );
}

/** Widest a poster's source badge gets; a narrower poster (phones) keeps its 6px inset on both sides. */
const POSTER_BADGE_MAX = 120;
const POSTER_BADGE_INSETS = 12;
/** Room the rating chip takes on the poster's top-end corner, so the source badge stops short of it. */
const POSTER_RATING_ROOM = 52;
/** Below this poster width the source name moves from the art into the caption. */
const POSTER_BADGE_MIN_CELL = 132;

/**
 * Movie or series hits as poster cards, with the language the provider gives each title.
 * Memoized: typing in the field re-renders the page, not the cards.
 */
const PosterGrid = memo(function PosterGrid({
  kind,
  hits,
  showBadges,
  minWidth,
  scrollRef,
  resume,
  locked,
}: {
  kind: Exclude<SearchGroupKind, 'live'>;
  hits: SearchHit[];
  showBadges: boolean;
  minWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Watched fraction by `resumeKey`, for the poster progress bar. */
  resume: Map<string, number>;
  /** Parental Ask mode: the title asks for the PIN before it opens (VL-search-locks). */
  locked: (item: VodItem | SeriesItem) => boolean;
}) {
  // L1-vod-6: the watched tick, as on the category grid (the first 500 hits; the rest show none).
  const items = useMemo(() => hits.map((h) => h.item as VodItem | SeriesItem), [hits]);
  const watched = useWatchedKeys(items);
  // VD-1: one My List subscription for the grid, and cells whose props are the hit and a few
  // primitives, so a scroll step re-renders only the rows it mounts, not every card.
  return (
    <GridMyListProvider>
      <HitGrid
        hits={hits}
        minWidth={minWidth}
        gap={POSTER_GAP}
        rowHeight={(w) => w * 1.5 + POSTER_CAPTION_HEIGHT}
        scrollRef={scrollRef}
        testId={`vod-search-${kind}`}
        postersFillCells
        renderCell={(h, i, cellWidth) => {
          const item = h.item as VodItem | SeriesItem;
          return (
            <PosterHitCell
              hit={h}
              index={i}
              cellWidth={cellWidth}
              showBadges={showBadges}
              progress={resume.get(resumeKey(item.ref))}
              watched={watched.has(itemKey(item.ref))}
              locked={locked(item)}
            />
          );
        }}
      />
    </GridMyListProvider>
  );
});

/** One poster hit. Memoized on the hit and primitives; the props PosterCard needs are built once per change. */
const PosterHitCell = memo(function PosterHitCell({
  hit: h,
  index,
  cellWidth,
  showBadges,
  progress,
  watched,
  locked,
  tabIndex,
  otherSources = 0,
}: {
  hit: SearchHit;
  index: number;
  cellWidth: number;
  showBadges: boolean;
  progress: number | undefined;
  watched: boolean;
  locked: boolean;
  /** A rail's roving tab index (Top results); a grid leaves it to the grid. */
  tabIndex?: number | undefined;
  /** More sources carry this title (groupDuplicateHits): the badge counts them instead of naming one. */
  otherSources?: number;
}) {
  const { t, i18n } = useTranslation('vod');
  const item = h.item as VodItem | SeriesItem;
  const language = useMemo(() => itemLanguage(item.title, item.categoryName), [item.title, item.categoryName]);
  const myList = useMemo(() => myListTarget(item), [item]);
  // C4: warm the detail page on hover or focus (needs the source kind for its command).
  const prefetch = useMemo(
    () => (h.sourceKind ? { ref: item.ref, sourceKind: h.sourceKind, posterUrl: h.imageUrl, backdropUrl: item.backdropUrl } : undefined),
    [h.sourceKind, h.imageUrl, item],
  );
  const badgeWidth = Math.max(0, Math.min(POSTER_BADGE_MAX, cellWidth - POSTER_BADGE_INSETS - (item.rating ? POSTER_RATING_ROOM : 0)));
  // A phone's posters are too narrow for the source name on the art: it collapsed to "N…" beside
  // the rating. There the source goes into the caption, after the year, in full.
  const narrow = cellWidth < POSTER_BADGE_MIN_CELL;
  const sourceText = otherSources > 0 ? t('sourcesCount', { count: otherSources + 1 }) : h.sourceName;
  const badge = useMemo(
    () =>
      showBadges && !narrow ? (
        // Badge is inline-flex, so the ellipsis needs a block inside it (L2-visual-8).
        <Badge variant="neutral" dir="auto" title={sourceText} className="bg-glass-strong text-on-glass" style={{ maxWidth: badgeWidth }}>
          {sourceText}
        </Badge>
      ) : undefined,
    [showBadges, narrow, sourceText, badgeWidth],
  );
  const meta = showBadges && narrow ? joinList([h.meta, sourceText], i18n.language) : h.meta;
  return (
    <PosterCard
      index={index}
      title={item.titleBase || h.title}
      fullTitle={h.title}
      href={h.href ?? '#'}
      posterUrl={h.imageUrl}
      meta={meta}
      // L4-vod-3: the rating chip, as on the category grid and the rails.
      rating={item.rating}
      progress={progress}
      watched={watched}
      language={language}
      badge={badge}
      badgeLabel={showBadges && !narrow ? sourceText : undefined}
      myList={myList}
      prefetch={prefetch}
      locked={locked}
      tabIndex={tabIndex}
    />
  );
});

/** Channel hits; choosing one plays it. Memoized like PosterGrid. */
const ChannelGrid = memo(function ChannelGrid({
  hits,
  showBadges,
  onPlayChannel,
  scrollRef,
}: {
  hits: SearchHit[];
  showBadges: boolean;
  onPlayChannel: (c: Channel, hit: SearchHit) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <HitGrid
      hits={hits}
      minWidth={CHANNEL_MIN_WIDTH}
      gap={CHANNEL_GAP}
      rowHeight={() => CHANNEL_ROW_HEIGHT}
      scrollRef={scrollRef}
      testId="vod-search-channels"
      renderCell={(h, i) => <ChannelHitButton hit={h} index={i} showBadges={showBadges} onPlayChannel={onPlayChannel} />}
    />
  );
});

/** The channel logo's box, `w-12`: twelve spacing steps of 3.75 px at 100 % scale. */
const CHANNEL_LOGO_PX = 45;

/** One channel hit; choosing it plays the channel. The source is quiet text, not an outlined chip. */
function ChannelHitButton({
  hit: h,
  index,
  showBadges,
  onPlayChannel,
}: {
  hit: SearchHit;
  index: number;
  showBadges: boolean;
  onPlayChannel: (c: Channel, hit: SearchHit) => void;
}) {
  const c = h.item as Channel;
  // The logo's width is known, so it does not read its frame as it mounts (P2-GRID-2).
  const logoWidth = useScaledPx(CHANNEL_LOGO_PX, true);
  return (
    <button
      type="button"
      data-grid-index={index}
      onClick={() => onPlayChannel(c, h)}
      className="flex w-full items-center gap-3 rounded-lg border border-edge bg-surface p-2 text-start outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus motion-safe:transition-colors"
    >
      <div className="w-12 shrink-0">
        {/* The channel's source: the image cache fetches a LAN logo with that source's trust and headers (C2). */}
        <Poster src={h.imageUrl} sourceId={c.ref.sourceId} width={logoWidth} alt={h.title} aspect="square" fit="contain" kind={c.isRadio ? 'radio' : 'live'} rounded="sm" />
      </div>
      <div className="min-w-0 flex-1">
        <div dir="auto" className="truncate text-body-sm font-medium text-fg text-match-parent">
          {h.title}
        </div>
        {/* The source as quiet text after the number (no outlined chip); a long name truncates, with a tooltip. */}
        <div className="flex min-w-0 gap-1.5 text-caption text-fg-subtle">
          {h.meta && <span className="tabular shrink-0">{h.meta}</span>}
          {showBadges && h.meta && <span aria-hidden>·</span>}
          {showBadges && (
            <span dir="auto" title={h.sourceName} className="min-w-0 truncate" data-testid="search-channel-source">
              {h.sourceName}
            </span>
          )}
        </div>
      </div>
      {c.isRadio ? <Radio aria-hidden size={16} className="shrink-0 text-fg-subtle" /> : <Tv aria-hidden size={16} className="shrink-0 text-fg-subtle" />}
    </button>
  );
}

/** How many of each type Top results shows before "See all". */
const TOP_POSTERS = 12;
const TOP_CHANNELS = 6;
const TOP_PROGRAMMES = 5;
/**
 * Movies and series each this short (in folded titles) share one "Movies and series" rail in Top
 * results: two half-width rails of one poster each left two empty areas and pushed the channels
 * below the first screen on a phone.
 */
const TOP_SHORT_RAIL = 3;

/** One Top results section and the number of results it stands for (the count its tab shows). */
interface TopSection {
  key: string;
  count: number;
  node: ReactNode;
}

/**
 * The Top results view: a section per result type. Posters fold the same title from several
 * sources into one card ("2 sources"), so a film is not listed twice side by side; short movie and
 * series lists share one rail. The sections come in order of how many results they have (the
 * guide's programmes last), so the type the query mostly found leads, and each heading counts what
 * its tab counts, every copy, with the "2 sources" chip explaining a card that stands for two.
 * Each section's "See all" opens its tab. Each section numbers its results from 0, so it carries
 * its kind (`data-search-section`), and Back from a result finds it again in its own section.
 */
function TopResults({
  groups,
  more,
  programmes,
  programmesMore,
  sources,
  showBadges,
  stripCountryPrefix,
  resume,
  locked,
  typeHref,
  onPlayChannel,
}: {
  groups: SearchGroup[];
  more: SearchMore;
  programmes: readonly GuideSearchHit[];
  programmesMore: boolean;
  sources: readonly Source[];
  showBadges: boolean;
  stripCountryPrefix: boolean;
  resume: Map<string, number>;
  locked: (item: VodItem | SeriesItem) => boolean;
  typeHref: (kind: string) => string;
  onPlayChannel: (c: Channel, hit: SearchHit) => void;
}) {
  const { t } = useTranslation('vod');
  const count = (n: number, capped: boolean | undefined) => (capped ? t('searchCountMore', { count: n }) : n);
  const posterGroups = useMemo(
    () =>
      groups
        .filter((g) => g.kind !== 'live')
        .map((g) => ({ group: g, folded: showBadges ? groupDuplicateHits(g.hits) : g.hits.map((hit): GroupedHit => ({ hit, others: [] })) })),
    [groups, showBadges],
  );
  const live = groups.find((g) => g.kind === 'live');
  const sections: TopSection[] = [];
  if (posterGroups.length === 2 && posterGroups.every((p) => p.folded.length <= TOP_SHORT_RAIL)) {
    const hits = posterGroups.reduce((n, p) => n + p.group.hits.length, 0);
    sections.push({
      key: 'titles',
      count: hits,
      node: (
        <TopPosterRail
          key="titles"
          section="titles"
          title={t('group_titles')}
          count={count(hits, posterGroups.some((p) => more[p.group.kind]))}
          folded={posterGroups.flatMap((p) => p.folded)}
          showBadges={showBadges}
          resume={resume}
          locked={locked}
        />
      ),
    });
  } else {
    for (const { group, folded } of posterGroups) {
      sections.push({
        key: group.kind,
        count: group.hits.length,
        node: (
          <TopPosterRail
            key={group.kind}
            section={group.kind}
            title={t(`group_${group.kind}`)}
            count={count(group.hits.length, more[group.kind])}
            folded={folded}
            showBadges={showBadges}
            resume={resume}
            locked={locked}
            seeAll={typeHref(group.kind)}
          />
        ),
      });
    }
  }
  if (live) {
    sections.push({
      key: 'live',
      count: live.hits.length,
      node: (
        <section key="live" aria-labelledby="search-top-live" className="flex flex-col gap-3" data-search-section="live">
          <SectionHeader id="search-top-live" title={t('group_live')} count={count(live.hits.length, more.live)} seeAll={{ to: typeHref('live') }} />
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${CHANNEL_MIN_WIDTH}px, 1fr))` }} role="list">
            {live.hits.slice(0, TOP_CHANNELS).map((h, i) => (
              <div key={h.key} role="listitem" className="min-w-0">
                <ChannelHitButton hit={h} index={i} showBadges={showBadges} onPlayChannel={onPlayChannel} />
              </div>
            ))}
          </div>
        </section>
      ),
    });
  }
  // Most results first; a tie keeps the order above (movies, series, channels). Sort is stable.
  sections.sort((a, b) => b.count - a.count);
  return (
    <div className="flex flex-col gap-10" data-testid="search-top">
      {sections.map((x) => x.node)}
      {programmes.length > 0 && (
        <section aria-labelledby="search-top-programmes" className="flex flex-col gap-3" data-search-section="programmes">
          <SectionHeader
            id="search-top-programmes"
            title={t('group_programmes')}
            count={count(programmes.length, programmesMore)}
            seeAll={{ to: typeHref('programmes') }}
          />
          <ProgrammeList hits={programmes.slice(0, TOP_PROGRAMMES)} sources={sources} showSource={showBadges} stripCountryPrefix={stripCountryPrefix} />
        </section>
      )}
    </div>
  );
}

/**
 * One Top results rail of posters, duplicates folded (one film from two sources is one card that
 * says "2 sources"). `section` keys Back's return to the card; the combined movies-and-series
 * rail has no single tab to open, so no "See all".
 */
function TopPosterRail({
  section,
  title,
  count,
  folded,
  showBadges,
  resume,
  locked,
  seeAll,
}: {
  section: string;
  title: string;
  count: ReactNode;
  folded: readonly GroupedHit[];
  showBadges: boolean;
  resume: Map<string, number>;
  locked: (item: VodItem | SeriesItem) => boolean;
  seeAll?: string;
}) {
  const cardWidth = useRailCardWidth();
  const items = useMemo(() => folded.slice(0, TOP_POSTERS), [folded]);
  const watched = useWatchedKeys(useMemo(() => items.map((g) => g.hit.item as VodItem | SeriesItem), [items]));
  return (
    <div className="min-w-0" data-search-section={section}>
      <PosterRail<GroupedHit>
        title={title}
        count={count}
        seeAll={seeAll ? { to: seeAll } : undefined}
        items={items}
        cardWidth={cardWidth}
        bleed
        myList={(g) => myListTarget(g.hit.item as VodItem | SeriesItem)}
        render={(g, i, rail) => {
          const item = g.hit.item as VodItem | SeriesItem;
          return (
            <PosterHitCell
              hit={g.hit}
              index={i}
              cellWidth={cardWidth}
              showBadges={showBadges}
              progress={resume.get(resumeKey(item.ref))}
              watched={watched.has(itemKey(item.ref))}
              locked={locked(item)}
              tabIndex={rail.tabIndex}
              otherSources={g.others.length}
            />
          );
        }}
      />
    </div>
  );
}

function SearchSkeleton() {
  const { t } = useTranslation('vod');
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-8">
      <span className="sr-only">{t('searching')}</span>
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-28" />
        ))}
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer" style={{ aspectRatio: 2 / 3 }} />
        ))}
      </div>
    </div>
  );
}

const NO_QUERIES: readonly string[] = [];
/** Titles in "Jump back in" on the search page's zero state. */
const JUMP_BACK_LIMIT = 16;
/** Category chips per section in a scoped search's zero state. */
const BROWSE_CHIPS = 12;

/**
 * What the search page shows before a query (critique: search; CB "Search zero state"): the recent
 * searches as chips (Enter in an empty field lands on the first), the titles you watched lately
 * ("Jump back in"), and in a source's own search its categories, one press from the grid. With
 * none of that yet, the plain prompt (`empty`) stays.
 */
function SearchStart({
  sourceId,
  sources,
  offerRecent,
  onPick,
  title,
  hint,
  empty,
}: {
  sourceId: string | undefined;
  sources: Source[];
  /** True once the parental status says controls are off: with a PIN set, or unknown, none are offered. */
  offerRecent: boolean;
  onPick: (query: string) => void;
  /** The prompt, as a short lead above the sections (the full empty state when there are none). */
  title: string;
  hint: string;
  empty: ReactNode;
}) {
  const { t } = useTranslation('vod');
  const stored = useRecentSearches();
  const queries = offerRecent ? stored : NO_QUERIES;
  const recent = useRpcQuery('recent.list', sourceId ? { sourceId, limit: 60 } : { limit: 60 }, { staleTime: 30_000 });
  const jump = useMemo(
    () => (recent.data ?? []).filter((e) => e.ref.contentType === 'movie' || e.ref.contentType === 'series').slice(0, JUMP_BACK_LIMIT),
    [recent.data],
  );
  // The same arguments as the landings ask, so the categories usually come from the cache.
  const movieCats = useRpcQuery('catalog.categories', { sourceId: sourceId ?? '', contentType: 'movie', includeHidden: true }, { enabled: !!sourceId });
  const seriesCats = useRpcQuery('catalog.categories', { sourceId: sourceId ?? '', contentType: 'series', includeHidden: true }, { enabled: !!sourceId });
  const browse = useMemo(
    () =>
      sourceId
        ? (
            [
              ['movies', movieCats.data],
              ['series', seriesCats.data],
            ] as const
          )
            .map(([section, cats]) => ({ section, cats: (cats ?? []).filter((c) => !c.hidden && c.itemCount > 0).slice(0, BROWSE_CHIPS) }))
            .filter((g) => g.cats.length > 0)
        : [],
    [sourceId, movieCats.data, seriesCats.data],
  );
  const sourceKind = (id: string) => sources.find((s) => s.id === id)?.kind;

  if (queries.length === 0 && jump.length === 0 && browse.length === 0) return <>{empty}</>;
  return (
    <div className="flex flex-col gap-10" data-testid="vod-search-start">
      <div className="flex flex-col gap-1">
        <p className="text-title-sm text-fg">{title}</p>
        <p className="text-body-sm text-fg-muted">{hint}</p>
      </div>
      {queries.length > 0 && (
        <section aria-labelledby="vod-recent-searches" className="flex flex-col gap-3">
          <SectionHeader
            id="vod-recent-searches"
            title={t('recentSearches')}
            action={
              <Button size="sm" variant="ghost" onClick={clearSearches}>
                {t('clearRecentSearches')}
              </Button>
            }
          />
          <ul className="flex flex-wrap gap-2">
            {queries.map((q) => (
              // The kit's filter-chip look (FilterChip at rest), with a remove button inside its end.
              <li
                key={q}
                className="inline-flex h-8 max-w-full items-center rounded-full border border-edge bg-surface-2 pe-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg motion-safe:transition-colors"
              >
                <button
                  type="button"
                  data-recent-search=""
                  onClick={() => onPick(q)}
                  className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-full ps-3 pe-1.5 text-caption font-medium"
                >
                  <History aria-hidden size={14} className="shrink-0 text-fg-subtle" />
                  <span dir="auto" className="min-w-0 truncate">
                    {q}
                  </span>
                </button>
                <IconButton
                  size="sm"
                  label={t('removeRecentSearch', { query: q })}
                  icon={<X aria-hidden size={14} />}
                  onClick={() => forgetSearch(q)}
                  className="h-7 w-7 rounded-full"
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {jump.length > 0 && (
        <PosterRail<RecentEntry>
          title={t('jumpBackIn')}
          items={jump}
          bleed
          render={(e, i, rail) => {
            const kind = sourceKind(e.ref.sourceId);
            return (
              <PosterCard
                index={i}
                tabIndex={rail.tabIndex}
                title={snapshotTitle(e.ref, e.snapshot.title).title}
                href={detailHref(e.ref) ?? '#'}
                posterUrl={e.snapshot.posterUrl}
                meta={e.snapshot.subtitle}
                sourceId={e.ref.sourceId}
                prefetch={kind ? { ref: e.ref, sourceKind: kind, posterUrl: e.snapshot.posterUrl } : undefined}
              />
            );
          }}
        />
      )}
      {browse.length > 0 && sourceId && (
        <section aria-labelledby="vod-browse-categories" className="flex flex-col gap-4">
          <SectionHeader id="vod-browse-categories" title={t('browseCategories')} />
          {browse.map((g) => (
            <div key={g.section} className="flex flex-col gap-2">
              <h3 className="text-caption font-medium text-fg-subtle">{t(g.section === 'movies' ? 'group_movies' : 'group_series')}</h3>
              <ul className="flex flex-wrap gap-2">
                {g.cats.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/s/${encodeURIComponent(sourceId)}/${g.section}/c/${encodeURIComponent(c.id)}`}
                      className={filterChipClass(false, 'max-w-[16rem]')}
                      title={c.name}
                    >
                      <span dir="auto" className="truncate">
                        {c.name}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
