import { useQueries } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Radio, Search, SearchX, Tv } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { rpcKey, useRpcQuery } from '@/api/query';
import type { CatalogSearchResult } from '@/api/rpc';
import { RpcError, rpcRaw } from '@/api/transport';
import type { Channel, Page, SeriesItem, Source, VodItem } from '@/api/types';
import { playItem } from '@/features/player';

import { PosterCard } from '../components/PosterCard';
import { PosterRail } from '../components/PosterRail';
import { useSource, useSourcesList } from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { handleGridKeyDown } from '../lib/gridNav';
import {
  SEARCH_LIMIT,
  capSearchResult,
  groupSearchResults,
  nextSearchLimit,
  normalizeQuery,
  searchRequestLimit,
  sourceFacets,
  splitStalkerResults,
  type SearchGroup,
  type SearchHit,
  type SearchMore,
  type SourceSearch,
} from '../lib/search';
import { Badge, Button, EmptyState, ErrorState, Poster, Skeleton, cn, gridLayout, useToast } from '@/ui';

const DEBOUNCE_MS = 250;

/** Stalker portals keep VOD out of SQLite, so their movies and series are searched on the portal. */
function useStalkerSearch(sources: Source[], query: string) {
  const targets = sources.filter((s) => s.kind === 'stalker');
  const results = useQueries({
    queries: targets.flatMap((s) =>
      (['movie', 'series'] as const).map((contentType) => {
        const args = { sourceId: s.id, query, contentType };
        return {
          queryKey: ['stalker.search', args],
          queryFn: async () => (await rpcRaw('stalker.search', args)) as Page<VodItem | SeriesItem>,
          enabled: !!query,
          staleTime: 60_000,
        };
      }),
    ),
  });
  const items = results.flatMap((r) => r.data?.items ?? []);
  const failed = results.filter((r) => r.isError);
  return {
    ...splitStalkerResults(items),
    pending: !!query && results.some((r) => r.isPending),
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
  const [draft, setDraft] = useState(q);
  const query = normalizeQuery(q);

  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const h = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (draft.trim()) next.set('q', draft);
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [draft, q, setParams]);

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
  // The chips keep counting every source while a facet narrows the results.
  const facetBase = useRpcQuery(
    'catalog.search',
    { query, limit: searchRequestLimit(SEARCH_LIMIT) },
    { enabled: !!query && !!facet, staleTime: 30_000 },
  );
  const stalker = useStalkerSearch(searchSources, query);

  // While a larger page loads, the previous page stays on screen: cap it by the limit it was fetched with.
  const [settledLimit, setSettledLimit] = useState(limit);
  useEffect(() => {
    if (catalog.data && !catalog.isPlaceholderData) setSettledLimit(limit);
  }, [catalog.data, catalog.isPlaceholderData, limit]);
  const dataLimit = catalog.isPlaceholderData ? settledLimit : limit;
  const capped = useMemo(() => capSearchResult(catalog.data, dataLimit), [catalog.data, dataLimit]);
  const loadingMore = catalog.isPlaceholderData && catalog.isFetching && cap.key === capKey && limit > settledLimit;

  const groups = useMemo(
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
  const facetCapped = useMemo(
    () => (facet ? capSearchResult(facetBase.data, SEARCH_LIMIT) : capped),
    [facet, facetBase.data, capped],
  );
  // When a type hits its cap, the global list cannot tell how many hits each
  // source lost, so every source is also searched alone, with exactly the args
  // its facet uses (choosing a chip then reads the cache). Chips count from these.
  const anyCapped = facetCapped.more.live || facetCapped.more.movies || facetCapped.more.series;
  const perSourceTargets = useMemo(() => (!scoped && !!query && anyCapped ? allSources : []), [scoped, query, anyCapped, allSources]);
  const perSourceQ = useQueries({
    queries: perSourceTargets.map((s) => {
      const args = { query, sourceId: s.id, limit: searchRequestLimit(SEARCH_LIMIT) };
      return {
        queryKey: rpcKey('catalog.search', args),
        queryFn: async () => (await rpcRaw('catalog.search', args)) as CatalogSearchResult,
        staleTime: 30_000,
      };
    }),
  });
  const perSourceStamp = perSourceQ.map((r) => r.dataUpdatedAt).join(',');
  const perSource = useMemo(() => {
    const map = new Map<string, SourceSearch>();
    perSourceTargets.forEach((s, i) => {
      const data = perSourceQ[i]?.data;
      if (!data) return;
      const own = capSearchResult(data, SEARCH_LIMIT);
      map.set(s.id, {
        groups: groupSearchResults({ result: own.result, extraMovies: stalker.movies, extraSeries: stalker.series, sources: allSources, sourceFilter: s.id }),
        more: own.more,
      });
    });
    return map;
  }, [perSourceStamp, perSourceTargets, stalker.movies, stalker.series, allSources]); // eslint-disable-line react-hooks/exhaustive-deps
  const facets = useMemo(
    () =>
      scoped
        ? []
        : sourceFacets(
            groupSearchResults({ result: facetCapped.result, extraMovies: stalker.movies, extraSeries: stalker.series, sources: allSources }),
            facetCapped.more,
            perSource,
          ),
    [scoped, facetCapped.result, facetCapped.more, stalker.movies, stalker.series, allSources, perSource],
  );

  const scopeName = scopedSource.data?.name;
  const placeholder = scoped && scopeName ? t('searchInSource', { source: scopeName }) : t('searchEverything');
  usePageHeader(
    {
      title: t('search'),
      subtitle: scoped ? scopeName : undefined,
      search: { value: draft, onChange: setDraft, placeholder, onSubmit: (v) => setDraft(v) },
    },
    [draft, placeholder, scopeName],
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

  const playChannel = (c: Channel, hit: SearchHit) => {
    if (!hit.sourceKind) return;
    const args: Parameters<typeof playItem>[0] = { ref: c.ref, title: c.name, isLive: true, isRadio: c.isRadio, sourceKind: hit.sourceKind };
    if (c.logoUrl) args.posterUrl = c.logoUrl;
    playItem(args).catch((err: unknown) => toast({ title: t('playFailed'), description: RpcError.from(err).message, variant: 'error' }));
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const showBadges = !scoped && allSources.length > 1;
  const loading = !!query && (catalog.isPending || (groups.length === 0 && stalker.pending));

  let body;
  if (!query) {
    body = (
      <EmptyState
        icon={<Search size={28} />}
        title={scoped && scopeName ? t('searchSourceTitle', { source: scopeName }) : t('searchTitle')}
        description={draft.trim().length === 1 ? t('searchMinLength', { count: 2 }) : t('searchHint')}
      />
    );
  } else if (catalog.isError && groups.length === 0) {
    body = <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;
  } else if (loading) {
    body = <SearchSkeleton />;
  } else if (groups.length === 0 && stalker.error) {
    body = <ErrorState error={stalker.error} onRetry={stalker.retry} />;
  } else if (groups.length === 0 && facet) {
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
  } else if (groups.length === 0) {
    body = <EmptyState icon={<SearchX size={28} />} title={t('noResultsTitle', { query })} description={t('noResultsHint')} />;
  } else {
    body = (
      <>
        {facets.length > 1 && (
          <div role="group" aria-label={t('filterBySource')} className="flex flex-wrap gap-2">
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
        {groups.map((g) => (
          <ResultGroup
            key={g.kind}
            group={g}
            more={capped.more[g.kind]}
            showBadges={showBadges}
            onPlayChannel={playChannel}
            pendingMore={stalker.pending && g.kind !== 'live'}
            scrollRef={scrollRef}
          />
        ))}
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
    <div ref={scrollRef} className="h-full overflow-y-auto" data-testid={scoped ? 'vod-search-source' : 'vod-search'}>
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-8 px-4 py-6 md:px-8">
        <div className="-mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[clamp(24px,2.4vw,36px)] leading-tight font-semibold text-fg">{t('search')}</h1>
          {scoped && scopeName && <p className="min-w-0 truncate text-sm text-fg-muted">{scopeName}</p>}
        </div>
        {body}
      </div>
    </div>
  );
}

function FacetChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number | string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus',
        active ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-fg-muted hover:text-fg',
      )}
    >
      {label}
      {count !== undefined && <span className="tabular text-xs opacity-80">{count}</span>}
    </button>
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
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-surface px-4 py-3 text-sm text-fg-muted"
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

function ResultGroup({
  group,
  more,
  showBadges,
  onPlayChannel,
  pendingMore,
  scrollRef,
}: {
  group: SearchGroup;
  /** The type hit its cap; the count reads `60+`. */
  more: boolean;
  showBadges: boolean;
  onPlayChannel: (c: Channel, hit: SearchHit) => void;
  pendingMore: boolean;
  /** The page scroller; the channel grid virtualizes its rows against it. */
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation('vod');
  const title = (
    <>
      {t(`group_${group.kind}`)}
      <span className="tabular ms-2 text-sm font-normal text-fg-subtle">
        {more ? t('searchCountMore', { count: group.hits.length }) : group.hits.length}
      </span>
    </>
  );
  if (group.kind !== 'live') {
    return (
      <PosterRail<SearchHit>
        title={title}
        items={group.hits}
        loading={pendingMore && group.hits.length === 0}
        render={(h, i) => (
          <PosterCard
            index={i}
            title={(h.item as VodItem | SeriesItem).titleBase || h.title}
            fullTitle={h.title}
            href={h.href ?? '#'}
            posterUrl={h.imageUrl}
            meta={h.meta}
            badge={showBadges ? <Badge variant="neutral" className="max-w-[120px] truncate bg-scrim text-white">{h.sourceName}</Badge> : undefined}
          />
        )}
      />
    );
  }
  return (
    <section aria-label={t('group_live')} className="flex flex-col gap-3">
      <h2 className="text-lg text-fg">{title}</h2>
      <ChannelGrid hits={group.hits} showBadges={showBadges} onPlayChannel={onPlayChannel} scrollRef={scrollRef} />
    </section>
  );
}

const CHANNEL_MIN_WIDTH = 260;
const CHANNEL_GAP = 8;
/** One channel button: 48px logo plus padding and border. Rows are measured after render; this is the estimate. */
const CHANNEL_ROW_HEIGHT = 66;

/**
 * Channel hits in a responsive grid whose rows are virtualized against the
 * page scroller, so a 1000-result step mounts only the rows near the
 * viewport. Arrow keys still move by cell and row (`handleGridKeyDown`
 * scrolls the page when the target row is not mounted yet).
 */
function ChannelGrid({
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
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Offset of the grid inside the page scroller; rails and facets above it can change height between renders.
  useLayoutEffect(() => {
    const el = listRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const margin = Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    if (margin !== scrollMargin) setScrollMargin(margin);
  });

  const { columns } = gridLayout(width, CHANNEL_MIN_WIDTH, CHANNEL_GAP);
  const rowCount = Math.ceil(hits.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANNEL_ROW_HEIGHT + CHANNEL_GAP,
    overscan: 4,
    scrollMargin,
    initialRect: { width: 960, height: 720 },
  });

  useEffect(() => {
    virtualizer.measure();
  }, [columns, virtualizer]);

  return (
    <div
      ref={listRef}
      role="list"
      data-testid="vod-search-channels"
      data-columns={columns}
      style={{ position: 'relative', height: virtualizer.getTotalSize() }}
      onKeyDown={(e) => handleGridKeyDown(e, { count: hits.length })}
    >
      {virtualizer.getVirtualItems().map((row) => {
        const first = row.index * columns;
        return (
          <div
            key={row.key}
            role="presentation"
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="grid gap-2"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              paddingBottom: CHANNEL_GAP,
              transform: `translateY(${row.start - scrollMargin}px)`,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {hits.slice(first, first + columns).map((h, j) => {
              const i = first + j;
              const c = h.item as Channel;
              return (
                <div key={h.key} role="listitem" aria-posinset={i + 1} aria-setsize={hits.length} className="min-w-0">
                  <button
                    type="button"
                    data-grid-index={i}
                    onClick={() => onPlayChannel(c, h)}
                    className="flex w-full items-center gap-3 rounded-md border border-border bg-surface p-2 text-start outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <div className="w-12 shrink-0">
                      <Poster src={h.imageUrl} alt={h.title} aspect="square" fit="contain" kind={c.isRadio ? 'radio' : 'live'} rounded="sm" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div dir="auto" className="truncate text-sm font-medium text-fg text-match-parent">{h.title}</div>
                      <div className="tabular truncate text-xs text-fg-subtle">{h.meta}</div>
                    </div>
                    {showBadges && <Badge variant="outline" className="max-w-[110px] shrink-0 truncate">{h.sourceName}</Badge>}
                    {c.isRadio ? <Radio aria-hidden size={16} className="shrink-0 text-fg-subtle" /> : <Tv aria-hidden size={16} className="shrink-0 text-fg-subtle" />}
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function SearchSkeleton() {
  const { t } = useTranslation('vod');
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-8">
      <span className="sr-only">{t('searching')}</span>
      {[0, 1].map((r) => (
        <div key={r} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="w-[150px] shrink-0">
                <div className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer" style={{ aspectRatio: 2 / 3 }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
