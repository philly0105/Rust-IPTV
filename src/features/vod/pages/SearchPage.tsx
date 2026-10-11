import { useQueries } from '@tanstack/react-query';
import { Radio, Search, SearchX, Tv } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
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
  groupSearchResults,
  normalizeQuery,
  sourceFacets,
  splitStalkerResults,
  type SearchGroup,
  type SearchHit,
} from '../lib/search';
import { Badge, EmptyState, ErrorState, Poster, Skeleton, cn, useToast } from '../_shim';

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

  const catalogArgs = sourceId ? { query, sourceId, limit: SEARCH_LIMIT } : { query, limit: SEARCH_LIMIT };
  const catalog = useRpcQuery('catalog.search', catalogArgs, { enabled: !!query, staleTime: 30_000, keepPrevious: true });
  const stalker = useStalkerSearch(searchSources, query);

  const groups = useMemo(
    () =>
      groupSearchResults({
        result: catalog.data,
        extraMovies: stalker.movies,
        extraSeries: stalker.series,
        sources: allSources.length ? allSources : searchSources,
        sourceFilter: facet,
      }),
    [catalog.data, stalker.movies, stalker.series, allSources, searchSources, facet],
  );
  const facets = useMemo(
    () =>
      scoped
        ? []
        : sourceFacets(
            groupSearchResults({ result: catalog.data, extraMovies: stalker.movies, extraSeries: stalker.series, sources: allSources }),
          ),
    [scoped, catalog.data, stalker.movies, stalker.series, allSources],
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
  } else if (groups.length === 0) {
    body = <EmptyState icon={<SearchX size={28} />} title={t('noResultsTitle', { query })} description={t('noResultsHint')} />;
  } else {
    body = (
      <>
        {facets.length > 1 && (
          <div role="group" aria-label={t('filterBySource')} className="flex flex-wrap gap-2">
            <FacetChip active={!facet} onClick={() => setFacet(undefined)} label={t('allSources')} />
            {facets.map((f) => (
              <FacetChip key={f.sourceId} active={facet === f.sourceId} onClick={() => setFacet(f.sourceId)} label={f.sourceName} count={f.count} />
            ))}
          </div>
        )}
        {groups.map((g) => (
          <ResultGroup key={g.kind} group={g} showBadges={showBadges} onPlayChannel={playChannel} pendingMore={stalker.pending && g.kind !== 'live'} />
        ))}
      </>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid={scoped ? 'vod-search-source' : 'vod-search'}>
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

function FacetChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
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

function ResultGroup({
  group,
  showBadges,
  onPlayChannel,
  pendingMore,
}: {
  group: SearchGroup;
  showBadges: boolean;
  onPlayChannel: (c: Channel, hit: SearchHit) => void;
  pendingMore: boolean;
}) {
  const { t } = useTranslation('vod');
  const title = (
    <>
      {t(`group_${group.kind}`)}
      <span className="tabular ml-2 text-sm font-normal text-fg-subtle">{group.hits.length}</span>
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
            title={h.title}
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
      <ul
        className="grid gap-2"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
        onKeyDown={(e) => handleGridKeyDown(e, { count: group.hits.length })}
      >
        {group.hits.map((h, i) => {
          const c = h.item as Channel;
          return (
            <li key={h.key}>
              <button
                type="button"
                data-grid-index={i}
                onClick={() => onPlayChannel(c, h)}
                className="flex w-full items-center gap-3 rounded-md border border-border bg-surface p-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus"
              >
                <div className="w-12 shrink-0">
                  <Poster src={h.imageUrl} alt={h.title} aspect="square" fit="contain" kind={c.isRadio ? 'radio' : 'live'} rounded="sm" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{h.title}</div>
                  <div className="tabular truncate text-xs text-fg-subtle">{h.meta}</div>
                </div>
                {showBadges && <Badge variant="outline" className="max-w-[110px] shrink-0 truncate">{h.sourceName}</Badge>}
                {c.isRadio ? <Radio aria-hidden size={16} className="shrink-0 text-fg-subtle" /> : <Tv aria-hidden size={16} className="shrink-0 text-fg-subtle" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
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
