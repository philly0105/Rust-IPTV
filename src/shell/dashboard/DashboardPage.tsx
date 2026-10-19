import { ListPlus, Play, Tv } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { HOME_RAIL_LIMIT, homeContinueArgs, homeFavoritesArgs, homeRecentArgs, homeRecentlyAddedArgs } from '@/api/bootPrefetch';
import { useRpcQuery } from '@/api/query';
import {
  itemKey,
  type FavoriteEntry,
  type ItemRef,
  type ItemSnapshot,
  type PlaybackPosition,
  type RecentEntry,
  type SeriesItem,
  type Source,
  type TmdbBrief,
  type VodItem,
} from '@/api/types';
import { CustomListRails } from '@/features/lists/rails';
import { MyListRail } from '@/features/mylist/components/MyListRail';
import { useMyList } from '@/features/mylist/hooks/useMyList';
import { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';
import { RpcError, type RpcResult } from '@/api/transport';
import { snapshotTitle } from '@/lib/title';
import { Badge, Button, EmptyState, ErrorState, buttonClass, useToast } from '@/ui';

import { useShell } from '../store';
import { useVisibleSources } from '../useVisibleSources';
import { useSettings } from '../useSettings';
// account:
import { AccountAlerts } from './AccountAlerts';
import { ChannelCard, PosterCard, SourceCard, SourceKindContext, itemPath, joinList } from './cards';
import { ChannelMenuHost, snapshotChannel } from './ChannelCardMenu';
import { DashboardRail } from './DashboardRail';
import { HeroCarousel } from './HeroCarousel';
import { HeroSkeleton } from './HeroSkeleton';
import { buildHeroSlides, titleEndsWithYear, type HeroSlide } from './heroSlides';
import { minutesLeft, watchedFraction } from './progress';

const RAIL_LIMIT = HOME_RAIL_LIMIT;

// The rails that read their own queries, memoized here (SH-4): Home's re-renders for other rails'
// answers pass them by.
const HomeMyListRail = memo(MyListRail);
const HomeCustomListRails = memo(CustomListRails);

export { minutesLeft, watchedFraction } from './progress';

/** Sources ordered by latest activity in `recent`, then refresh/creation time. */
export function rankSources(sources: readonly Source[], recent: readonly RecentEntry[]): Source[] {
  const lastUse = new Map<string, string>();
  for (const r of recent) {
    const prev = lastUse.get(r.ref.sourceId);
    if (!prev || r.viewedAt > prev) lastUse.set(r.ref.sourceId, r.viewedAt);
  }
  const stamp = (s: Source) => lastUse.get(s.id) ?? '';
  const fallback = (s: Source) => s.lastRefreshAt ?? s.updatedAt ?? s.createdAt ?? '';
  return [...sources].sort((a, b) => {
    const ua = stamp(a);
    const ub = stamp(b);
    if (ua !== ub) return ua < ub ? 1 : -1;
    const fa = fallback(a);
    const fb = fallback(b);
    return fa === fb ? a.position - b.position : fa < fb ? 1 : -1;
  });
}

/** Movies and series interleaved by `added`, newest first. */
export function mergeRecentlyAdded(movies: readonly VodItem[], series: readonly SeriesItem[], limit: number): (VodItem | SeriesItem)[] {
  return [...movies, ...series]
    .sort((a, b) => ((a.added ?? '') < (b.added ?? '') ? 1 : (a.added ?? '') > (b.added ?? '') ? -1 : 0))
    .slice(0, limit);
}

/** The My List target of a new arrival: the title without its year, which the snapshot carries itself. */
function myListTarget(item: VodItem | SeriesItem): { itemRef: ItemRef; snapshot: ItemSnapshot } {
  const snapshot: ItemSnapshot = { title: item.titleBase || item.title, contentType: item.ref.contentType };
  if (item.posterUrl) snapshot.posterUrl = item.posterUrl;
  if (item.year) snapshot.subtitle = String(item.year);
  return { itemRef: item.ref, snapshot };
}

/** Identity of an error for "same failure" checks: its RpcError code and message. */
function errorSignature(err: unknown): string {
  const e = RpcError.from(err);
  return `${e.code}|${e.message}`;
}

/**
 * The single error to show instead of per-rail errors, or undefined. When
 * every rail query on screen failed (two or more) and they all failed the same
 * way (typically the server is gone), five identical error panels say nothing
 * one panel would not; the dashboard collapses them into one with one retry.
 * Any rail still loading or loaded keeps per-rail errors.
 */
export function sharedRailError(errors: readonly unknown[]): unknown {
  if (errors.length < 2) return undefined;
  const first = errors[0];
  if (first === null || first === undefined) return undefined;
  const sig = errorSignature(first);
  return errors.every((e) => e !== null && e !== undefined && errorSignature(e) === sig) ? first : undefined;
}

/** `offsetMinutes`: `settings.epgOffsetMinutes`; the programme is shown moved by it. */
function programmeProgress(start?: string, end?: string, offsetMinutes = 0): number | undefined {
  if (!start || !end) return undefined;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  return Math.max(0, Math.min(1, (Date.now() - offsetMinutes * 60_000 - s) / (e - s)));
}

/**
 * The page's single <h1> (sr-only; the header shows the visible title) in every state, and the
 * channel card menu (Run 2 C2) for every live and radio card below, custom list rails included.
 */
export function DashboardPage() {
  const { t } = useTranslation('shell');
  return (
    <ChannelMenuHost>
      <h1 className="sr-only">{t('navDashboard')}</h1>
      <DashboardBody />
    </ChannelMenuHost>
  );
}

function DashboardBody() {
  const { t } = useTranslation('shell');
  const shell = useShell();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    shell.setHeader({ title: t('navDashboard') });
  }, [shell, t]);

  const settings = useSettings();
  const rails = settings.data?.dashboardRails;
  const show = (k: keyof NonNullable<typeof rails>) => rails?.[k] ?? true;
  type Section = keyof NonNullable<typeof rails>;
  const tmdbEnabled = settings.data?.tmdb.enabled ?? false;

  const sources = useVisibleSources();
  const hasSources = (sources.data?.length ?? 0) > 0;
  // Home plays streams: with something to play, warm hls.js and mpegts.js once the browser is idle
  // (preloadEngines waits for it), so the first play from here does not fetch them after the click.
  // Behind import(), like playItem below (performance audit SH-2): Rollup puts the small
  // enginePreload module in the player store's chunk, and a static import made Home's route chunk
  // wait for about 97 kB of player code before its first render. The module itself, not the
  // barrel: the barrel mocks in tests leave it alone.
  useEffect(() => {
    if (!hasSources) return;
    void import('@/features/player/enginePreload').then((m) => m.preloadEngines()).catch(() => undefined);
  }, [hasSources]);
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  // Hover prefetch targets (C4) need each card's source kind.
  const sourceKinds = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s.kind])), [sources.data]);

  // The arguments come from bootPrefetch, which asks for the same queries at boot (SH-3).
  const continueWatching = useRpcQuery('positions.continueWatching', homeContinueArgs(), { enabled: hasSources });
  const favorites = useRpcQuery('favorites.list', homeFavoritesArgs(), { enabled: hasSources });
  const recent = useRpcQuery('recent.list', homeRecentArgs(), { enabled: hasSources });
  // The hero rotates new arrivals too, so it loads them even when their rail is off.
  const wantAdded = hasSources && (show('hero') || show('recentlyAdded'));
  const addedMovies = useRpcQuery('catalog.recentlyAdded', homeRecentlyAddedArgs('movie'), { enabled: wantAdded });
  const addedSeries = useRpcQuery('catalog.recentlyAdded', homeRecentlyAddedArgs('series'), { enabled: wantAdded });
  // The shared My List query its rail reads (C3): one fetch, so the quiet state, the
  // pending check and the shared retry below see the same list the rail shows.
  const myList = useMyList({ enabled: hasSources });
  const trending = useRpcQuery('tmdb.trending', undefined, {
    enabled: hasSources && tmdbEnabled && show('tmdbTrending'),
    staleTime: 60 * 60_000,
  });

  // Sources in their delete-undo window are already gone from the rail and the palette
  // (useVisibleSources); every rail and the hero drop their titles too, as My List does.
  const removingSources = usePendingRemovals((s) => s.ids);
  const keep = <T extends { ref: ItemRef }>(rows: readonly T[] | undefined): T[] =>
    removingSources.size === 0 ? [...(rows ?? [])] : (rows ?? []).filter((r) => !removingSources.has(r.ref.sourceId));
  const continueRows = useMemo(() => keep(continueWatching.data), [continueWatching.data, removingSources]);
  const favoriteRows = useMemo(() => keep(favorites.data), [favorites.data, removingSources]);
  const recentRows = useMemo(() => keep(recent.data), [recent.data, removingSources]);
  const movieRows = useMemo(() => keep(addedMovies.data as VodItem[] | undefined), [addedMovies.data, removingSources]);
  const seriesRows = useMemo(() => keep(addedSeries.data as SeriesItem[] | undefined), [addedSeries.data, removingSources]);

  const liveFavorites = useMemo(
    () =>
      favoriteRows
        .filter((f) => f.ref.contentType === 'live' || f.ref.contentType === 'radio')
        .slice(0, RAIL_LIMIT),
    [favoriteRows],
  );
  const vodFavorites = useMemo(
    () => favoriteRows.filter((f) => f.ref.contentType === 'movie' || f.ref.contentType === 'series').slice(0, RAIL_LIMIT),
    [favoriteRows],
  );
  const recentLive = useMemo(
    () => recentRows.filter((r) => r.ref.contentType === 'live' || r.ref.contentType === 'radio').slice(0, RAIL_LIMIT),
    [recentRows],
  );
  // Counted like MyListRail counts it: entries of sources in their delete-undo window are already gone.
  const myListCount = useMemo(
    () => (myList.data ?? []).filter((e) => !removingSources.has(e.ref.sourceId)).length,
    [myList.data, removingSources],
  );
  const rankedSources = useMemo(() => rankSources(sources.data ?? [], recentRows), [sources.data, recentRows]);
  const recentlyAdded = useMemo(() => mergeRecentlyAdded(movieRows, seriesRows, RAIL_LIMIT), [movieRows, seriesRows]);

  const heroSlides = useMemo(() => buildHeroSlides(continueRows, recentlyAdded), [continueRows, recentlyAdded]);
  // The live favourites tell same-named channels apart by source once there is more than one.
  const manySources = (sources.data?.length ?? 0) > 1;

  const nowRefs = useMemo(() => liveFavorites.map((f) => f.ref), [liveFavorites]);
  const epgOffset = settings.data?.epgOffsetMinutes ?? 0;
  // The cards read only the programme's title and times: no descriptions, about half the bytes (L3-serve-ui-8).
  const nowNext = useRpcQuery(
    'epg.nowNext',
    epgOffset ? { refs: nowRefs, offsetMinutes: epgOffset, withDescription: false } : { refs: nowRefs, withDescription: false },
    { enabled: nowRefs.length > 0, staleTime: 60_000 },
  );

  // Rail queries actually on screen (each query once), for the shared-error collapse.
  const railQueries = [
    ...(show('hero') || show('continueWatching') ? [continueWatching] : []),
    ...(show('liveFavorites') || show('favoriteMoviesAndSeries') ? [favorites] : []),
    ...(show('recentlyWatchedLive') ? [recent] : []),
    ...(show('recentlyAdded') ? [addedMovies, addedSeries] : []),
    ...(show('tmdbTrending') && tmdbEnabled ? [trending] : []),
  ];
  const sharedError = hasSources ? sharedRailError(railQueries.map((q) => q.error)) : undefined;
  // My List stays out of the collapse: an empty list draws no rail, so its answer must not
  // split one shared error back into five; it still counts as a rail for the quiet state.
  const myListOn = show('myList');
  const anyRailError = railQueries.some((q) => q.isError) || (myListOn && myList.isError);
  /** Per-rail error, hidden when the dashboard shows the shared one. */
  const railError = (err: unknown) => (sharedError ? undefined : err);
  const showSharedError = sharedError !== undefined;
  const retryAllRails = () => {
    for (const q of railQueries) if (q.isError) void q.refetch();
    // Its rail hides its own error behind the shared one, so the shared retry covers it too.
    if (myListOn && myList.isError) void myList.refetch();
  };

  // Stable while the sources hold, so the memoized rails keep their render (SH-4).
  const play = useCallback<PlayFn>(
    (args) => {
      const source = sourceById.get(args.ref.sourceId);
      if (!source) {
        toast({ variant: 'error', title: t('sourceMissing'), description: t('sourceMissingHint') });
        return;
      }
      const isLive = args.ref.contentType === 'live' || args.ref.contentType === 'radio';
      // The player loads on the click (as the command palette does), not with Home's chunk (SH-2).
      import('@/features/player')
        .then(({ playItem }) =>
          playItem({
            ...args,
            isLive,
            isRadio: args.ref.contentType === 'radio',
            sourceKind: source.kind,
          }),
        )
        .catch((err: unknown) => {
          toast({ variant: 'error', title: t('playFailed', { title: args.title }), description: err instanceof Error ? err.message : undefined });
        });
    },
    [sourceById, toast, t],
  );
  const heroSourceName = useCallback((id: string) => sourceById.get(id)?.name, [sourceById]);
  const heroCanPlay = useCallback((ref: ItemRef) => sourceById.has(ref.sourceId), [sourceById]);
  const playSlide = useCallback(
    (s: HeroSlide) => play({ ref: s.ref, episodeId: s.episodeId, title: s.title ?? '', subtitle: s.subtitle, posterUrl: s.posterUrl }),
    [play],
  );
  const retryAdded = useCallback(() => {
    void addedMovies.refetch();
    void addedSeries.refetch();
  }, [addedMovies.refetch, addedSeries.refetch]);

  // First run: nothing to show yet.
  if (sources.isSuccess && !hasSources) {
    return (
      <div className="flex min-h-full items-center justify-center p-8" data-testid="dashboard-welcome">
        <EmptyState
          icon={<Tv size={28} />}
          title={t('welcomeTitle')}
          description={t('welcomeBody')}
          action={
            // `from`: the first add returns to Home (/dashboard; `/` would go through StartupRedirect).
            <Link to="/sources?add=1&from=%2Fdashboard" className={buttonClass('primary', 'lg')}>
              <ListPlus size={18} aria-hidden />
              {t('addFirstSource')}
            </Link>
          }
        />
      </div>
    );
  }
  if (settings.isPending) {
    return (
      <div className="flex flex-col gap-10 pt-8" aria-busy="true" data-testid="dashboard-loading">
        <HeroSkeleton />
      </div>
    );
  }
  if (sources.isError) {
    return <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />;
  }

  // Continue watching leads the rotation and gates the layout below the hero. New arrivals
  // are only awaited when there is nothing to resume: the hero keeps its skeleton for them,
  // but a slow catalog query must not hold back the rails underneath.
  const heroLayoutPending = sources.isPending || continueWatching.isPending;
  const heroLoading =
    heroLayoutPending || (continueRows.length === 0 && (addedMovies.isPending || addedSeries.isPending));
  // Only rails the user has switched on count: hidden rails with data must not suppress the quiet state.
  const anyRailVisible =
    (show('hero') && heroSlides.length > 0) ||
    (show('continueWatching') && continueRows.length > 0) ||
    (myListOn && myListCount > 0) ||
    (show('liveFavorites') && liveFavorites.length > 0) ||
    (show('recentlyWatchedLive') && recentLive.length > 0) ||
    (show('favoriteMoviesAndSeries') && vodFavorites.length > 0) ||
    (show('recentlyAdded') && recentlyAdded.length > 0) ||
    (show('tmdbTrending') && tmdbEnabled && (trending.data?.length ?? 0) > 0);
  // Wait for every rail on screen (and a hero still waiting for new arrivals), so
  // "Nothing to show yet" never flashes above content still loading.
  const anyRailPending = railQueries.some((q) => q.isPending) || (myListOn && myList.isPending) || (show('hero') && heroLoading);

  // Layout stability: nothing renders below the first section still loading. A skeleton
  // that collapses (empty rail, shared error) or a flagged rail that appears then moves
  // nothing, because everything after it is inserted only once it has settled.
  const sections: [Section, boolean][] = [
    ['hero', heroLayoutPending],
    ['continueWatching', continueWatching.isPending],
    // My List loads inside its own rail (skeleton first), so it never holds back the rest.
    ['myList', false],
    ['liveFavorites', favorites.isPending],
    ['recentlyWatchedLive', recent.isPending],
    ['favoriteMoviesAndSeries', favorites.isPending],
    ['recentSources', sources.isPending],
    ['recentlyAdded', addedMovies.isPending || addedSeries.isPending],
    ['tmdbTrending', tmdbEnabled && trending.isPending],
  ];
  const firstPending = sections.findIndex(([k, pending]) => show(k) && pending);
  /** The section is on and nothing above it is still loading. */
  const visible = (k: Section) => show(k) && (firstPending < 0 || sections.findIndex(([x]) => x === k) <= firstPending);

  return (
    // gap-10 pt-8 match the startup frame (StartupRedirect), and both follow density through --spacing.
    <SourceKindContext.Provider value={sourceKinds}>
      <div className="flex flex-col gap-10 pt-8 pb-16" data-testid="dashboard">
        {/* account: subscription expiry alerts, above everything else. */}
        {hasSources && <AccountAlerts sources={sources.data ?? []} />}
        {/*
          The shared error takes the hero's place in the normal flow. With the hero on,
          an invisible hero skeleton shares its grid cell, so the slot keeps at least the
          loading state's height and the content below doesn't jump up under it.
        */}
        {showSharedError && (
          <div className="grid" data-testid="dashboard-error-slot">
            {visible('hero') && (
              <div aria-hidden className="invisible col-start-1 row-start-1" data-hero-spacer="">
                <HeroSkeleton />
              </div>
            )}
            <div className="col-start-1 row-start-1 mx-4 flex rounded-lg border border-divider bg-surface sm:mx-8" data-testid="dashboard-error">
              <ErrorState
                error={sharedError}
                size="inline"
                className="flex-1"
                title={t('dashboardLoadFailed')}
                hint={t('dashboardLocalDataHint')}
                onRetry={retryAllRails}
              />
            </div>
          </div>
        )}
        {show('hero') &&
          (heroLoading ? (
            <HeroSkeleton />
          ) : heroSlides.length > 0 ? (
            <HeroCarousel slides={heroSlides} sourceName={heroSourceName} canPlay={heroCanPlay} onPlay={playSlide} />
          ) : null)}

        {visible('continueWatching') && (
          <ContinueWatchingRail
            items={continueWatching.data ? continueRows : undefined}
            loading={continueWatching.isPending}
            loaded={continueWatching.isSuccess}
            error={railError(continueWatching.error)}
            refetch={continueWatching.refetch}
            play={play}
          />
        )}

        {/* My List (C3): the rail checks settings.dashboardRails.myList and its own emptiness itself. */}
        {visible('myList') && <HomeMyListRail hideError={showSharedError} />}
        {/* Run 2 C3: one rail per custom list with "Show on Home" on, in list order. */}
        <HomeCustomListRails />

        {visible('liveFavorites') && (
          <LiveFavoritesRail
            items={liveFavorites}
            loading={favorites.isPending}
            loaded={favorites.isSuccess}
            error={railError(favorites.error)}
            refetch={favorites.refetch}
            nowNext={nowNext.data}
            epgOffset={epgOffset}
            sourceById={sourceById}
            manySources={manySources}
            play={play}
          />
        )}

        {visible('recentlyWatchedLive') && (
          <RecentLiveRail
            items={recentLive}
            loading={recent.isPending}
            loaded={recent.isSuccess}
            error={railError(recent.error)}
            refetch={recent.refetch}
            sourceById={sourceById}
            play={play}
          />
        )}

        {visible('favoriteMoviesAndSeries') && (
          <FavoriteVodRail
            items={vodFavorites}
            loading={favorites.isPending}
            loaded={favorites.isSuccess}
            // Both favorites rails read one query: only one of them shows its error.
            error={show('liveFavorites') ? undefined : railError(favorites.error)}
            refetch={favorites.refetch}
          />
        )}

        {visible('recentSources') && <RecentSourcesRail items={rankedSources} loading={sources.isPending} />}

        {visible('recentlyAdded') && (
          <RecentlyAddedRail
            items={recentlyAdded}
            loading={addedMovies.isPending || addedSeries.isPending}
            loaded={addedMovies.isSuccess && addedSeries.isSuccess}
            error={railError(addedMovies.error ?? addedSeries.error)}
            refetch={retryAdded}
            sourceById={sourceById}
          />
        )}

        {visible('tmdbTrending') && tmdbEnabled && (
          <TrendingRail
            items={trending.data}
            loading={trending.isPending}
            loaded={trending.isSuccess}
            error={railError(trending.error)}
            refetch={trending.refetch}
          />
        )}

        {hasSources && !anyRailVisible && !anyRailError && !anyRailPending && (
            <EmptyState
              size="inline"
              icon={<Play size={22} />}
              title={t('dashboardQuietTitle')}
              description={t('dashboardQuietBody')}
              action={
                <Button variant="primary" onClick={() => navigate(`/s/${encodeURIComponent(rankedSources[0]!.id)}/live`)}>
                  {t('browseLive')}
                </Button>
              }
            />
          )}
      </div>
    </SourceKindContext.Provider>
  );
}

type PlayArgs = { ref: ItemRef; episodeId?: string; title: string; subtitle?: string; posterUrl?: string };
type PlayFn = (args: PlayArgs) => void;

/**
 * What a rail gets from its query. `refetch` is TanStack's bound method (or a stable callback), so
 * it stays the same function across renders.
 */
interface RailQueryProps {
  loading: boolean;
  loaded: boolean;
  error: unknown;
  refetch: () => unknown;
}

// Home's rails (performance audit SH-4). Each one is memoized and gets stable props (its rows,
// its query's state, the shared `play`), so one of the ten or so answers of a cold start
// re-renders the rail it belongs to, not every rail of up to 24 cards. The page keeps the queries:
// the shared error, the layout gate and the quiet state read all of them.

const continueKey = (p: PlaybackPosition) => `${itemKey(p.ref)}|${p.episodeId ?? ''}`;
const refKey = (e: { ref: ItemRef }) => itemKey(e.ref);
const sourceKey = (s: Source) => s.id;
const trendingKey = (b: TmdbBrief) => `${b.mediaType}-${b.tmdbId}`;

const seriesBadge = (p: PlaybackPosition) => (p.ref.contentType === 'series' && p.snapshot?.subtitle ? <Badge variant="neutral">{p.snapshot.subtitle}</Badge> : undefined);

const ContinueWatchingRail = memo(function ContinueWatchingRail({
  items,
  loading,
  loaded,
  error,
  refetch,
  play,
}: RailQueryProps & { items: readonly PlaybackPosition[] | undefined; play: PlayFn }) {
  const { t } = useTranslation('shell');
  return (
    <DashboardRail<PlaybackPosition>
      id="continue-watching"
      title={t('railContinueWatching')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      errorHint={t('dashboardLocalDataHint')}
      onRetry={() => void refetch()}
      getKey={continueKey}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(p, rail) => {
        // L2-visual-3: a snapshot saved before the player stored the base title still carries
        // the provider's tags and year; show (and save to My List) what the detail page shows.
        const base = p.snapshot?.title ? snapshotTitle(p.ref, p.snapshot.title) : undefined;
        const title = base?.title ?? t('untitled');
        const left = minutesLeft(p);
        const snapshot: ItemSnapshot = p.snapshot
          ? { ...p.snapshot, title, ...(base?.year && !p.snapshot.subtitle ? { subtitle: String(base.year) } : {}) }
          : { title, contentType: p.ref.contentType };
        return (
          <PosterCard
            rail={rail}
            title={title}
            subtitle={left !== undefined ? t('minutesLeft', { count: left }) : p.snapshot?.subtitle}
            posterUrl={p.snapshot?.posterUrl}
            progress={watchedFraction(p)}
            badge={seriesBadge(p)}
            ariaLabel={t('resumeTitle', { title })}
            myList={{ itemRef: p.ref, snapshot }}
            onPlay={() => play({ ref: p.ref, episodeId: p.episodeId, title, subtitle: p.snapshot?.subtitle, posterUrl: p.snapshot?.posterUrl })}
          />
        );
      }}
    />
  );
});

const LiveFavoritesRail = memo(function LiveFavoritesRail({
  items,
  loading,
  loaded,
  error,
  refetch,
  nowNext,
  epgOffset,
  sourceById,
  manySources,
  play,
}: RailQueryProps & {
  items: readonly FavoriteEntry[];
  nowNext: RpcResult<'epg.nowNext'> | undefined;
  epgOffset: number;
  sourceById: ReadonlyMap<string, Source>;
  manySources: boolean;
  play: PlayFn;
}) {
  const { t } = useTranslation('shell');
  return (
    <DashboardRail<FavoriteEntry>
      id="live-favorites"
      title={t('railLiveFavorites')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      errorHint={t('dashboardLocalDataHint')}
      onRetry={() => void refetch()}
      seeAll={{ to: '/favorites' }}
      getKey={refKey}
      cardWidth={232}
      skeletonAspect={16 / 9}
      renderCard={(f, rail) => {
        const nn = nowNext?.[itemKey(f.ref)];
        return (
          <ChannelCard
            rail={rail}
            name={f.snapshot.title}
            logoUrl={f.snapshot.posterUrl}
            now={nn?.now?.title}
            nowProgress={programmeProgress(nn?.now?.start, nn?.now?.end, epgOffset)}
            sourceName={sourceById.get(f.ref.sourceId)?.name}
            showSourceWithNow={manySources}
            isRadio={f.ref.contentType === 'radio'}
            ariaLabel={t('playTitle', { title: f.snapshot.title })}
            onPlay={() => play({ ref: f.ref, title: f.snapshot.title, posterUrl: f.snapshot.posterUrl })}
            channel={snapshotChannel(f.ref, f.snapshot)}
          />
        );
      }}
    />
  );
});

const RecentLiveRail = memo(function RecentLiveRail({
  items,
  loading,
  loaded,
  error,
  refetch,
  sourceById,
  play,
}: RailQueryProps & { items: readonly RecentEntry[]; sourceById: ReadonlyMap<string, Source>; play: PlayFn }) {
  const { t } = useTranslation('shell');
  return (
    <DashboardRail<RecentEntry>
      id="recent-live"
      title={t('railRecentLive')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      errorHint={t('dashboardLocalDataHint')}
      onRetry={() => void refetch()}
      seeAll={{ to: '/recent' }}
      getKey={refKey}
      cardWidth={232}
      skeletonAspect={16 / 9}
      renderCard={(r, rail) => (
        <ChannelCard
          rail={rail}
          name={r.snapshot.title}
          logoUrl={r.snapshot.posterUrl}
          sourceName={sourceById.get(r.ref.sourceId)?.name}
          isRadio={r.ref.contentType === 'radio'}
          ariaLabel={t('playTitle', { title: r.snapshot.title })}
          onPlay={() => play({ ref: r.ref, title: r.snapshot.title, posterUrl: r.snapshot.posterUrl })}
          channel={snapshotChannel(r.ref, r.snapshot)}
        />
      )}
    />
  );
});

const FavoriteVodRail = memo(function FavoriteVodRail({ items, loading, loaded, error, refetch }: RailQueryProps & { items: readonly FavoriteEntry[] }) {
  const { t, i18n } = useTranslation('shell');
  return (
    <DashboardRail<FavoriteEntry>
      id="favorite-vod"
      title={t('railFavoriteVod')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      errorHint={t('dashboardLocalDataHint')}
      onRetry={() => void refetch()}
      seeAll={{ to: '/favorites' }}
      getKey={refKey}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(f, rail) => {
        // L2-visual-3: the base title, as on the detail page; a year stripped from it becomes the subtitle.
        const base = snapshotTitle(f.ref, f.snapshot.title);
        const year = f.snapshot.subtitle || (base.year ? String(base.year) : undefined);
        // A year the title still ends with ("Summer Static (2025)") is not repeated under it.
        const own = year && !titleEndsWithYear(base.title, year) ? year : undefined;
        const subtitle = own ?? (f.ref.contentType === 'series' ? t('series') : t('movie'));
        return (
          <PosterCard
            rail={rail}
            title={base.title}
            subtitle={subtitle}
            posterUrl={f.snapshot.posterUrl}
            to={itemPath(f.ref)}
            ariaLabel={joinList([base.title, subtitle], i18n.language)}
            myList={{ itemRef: f.ref, snapshot: { ...f.snapshot, title: base.title, ...(year ? { subtitle: year } : {}) } }}
          />
        );
      }}
    />
  );
});

const RecentSourcesRail = memo(function RecentSourcesRail({ items, loading }: { items: readonly Source[]; loading: boolean }) {
  const { t } = useTranslation('shell');
  return (
    <DashboardRail<Source>
      id="recent-sources"
      title={t('railRecentSources')}
      items={items}
      loading={loading}
      seeAll={{ to: '/sources', label: t('manageSources') }}
      getKey={sourceKey}
      cardWidth={232}
      skeletonAspect={16 / 9}
      renderCard={(s, rail) => <SourceCard rail={rail} source={s} />}
    />
  );
});

const RecentlyAddedRail = memo(function RecentlyAddedRail({
  items,
  loading,
  loaded,
  error,
  refetch,
  sourceById,
}: RailQueryProps & { items: readonly (VodItem | SeriesItem)[]; sourceById: ReadonlyMap<string, Source> }) {
  const { t, i18n } = useTranslation('shell');
  return (
    <DashboardRail<VodItem | SeriesItem>
      id="recently-added"
      title={t('railRecentlyAdded')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      errorHint={t('dashboardLocalDataHint')}
      onRetry={() => void refetch()}
      getKey={refKey}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(v, rail) => {
        const rating = v.rating ? v.rating.toFixed(1) : undefined;
        // The title the detail page and the hero show: no trailing year or provider tag.
        const title = v.titleBase || v.title;
        return (
          <PosterCard
            rail={rail}
            title={title}
            subtitle={joinList([sourceById.get(v.ref.sourceId)?.name, !titleEndsWithYear(title, v.year) && v.year], i18n.language)}
            posterUrl={v.posterUrl}
            backdropUrl={v.backdropUrl}
            badge={rating ? <Badge variant="neutral">{rating}</Badge> : undefined}
            to={itemPath(v.ref)}
            // Name first: the rating badge sits before the caption in the DOM.
            ariaLabel={joinList([title, sourceById.get(v.ref.sourceId)?.name, v.year, rating && t('ratedLabel', { rating })], i18n.language)}
            myList={myListTarget(v)}
          />
        );
      }}
    />
  );
});

const TrendingRail = memo(function TrendingRail({ items, loading, loaded, error, refetch }: RailQueryProps & { items: readonly TmdbBrief[] | undefined }) {
  const { t, i18n } = useTranslation('shell');
  return (
    <DashboardRail<TmdbBrief>
      id="tmdb-trending"
      title={t('railTrending')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      onRetry={() => void refetch()}
      getKey={trendingKey}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(b, rail) => (
        <PosterCard
          rail={rail}
          title={b.title}
          subtitle={joinList([b.mediaType === 'tv' ? t('series') : t('movie'), b.year], i18n.language)}
          posterUrl={b.posterUrl}
          badge={b.rating ? <Badge variant="neutral">{b.rating.toFixed(1)}</Badge> : undefined}
          to={`/search?q=${encodeURIComponent(b.title)}`}
          ariaLabel={t('findTitle', { title: b.title })}
        />
      )}
    />
  );
});
