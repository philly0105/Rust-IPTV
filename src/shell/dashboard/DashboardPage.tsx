// Icons Home already shares with the shell: a lucide glyph that the player also uses (Trash2) was
// grouped into a chunk with player code, which put the player store in Home's first render.
import { CalendarRange, CircleCheck, Clapperboard, CloudOff, Info, Layers, Search, Tv, X, type LucideIcon } from 'lucide-react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, type NavigateFunction } from 'react-router';

import { HOME_RAIL_LIMIT, homeContinueArgs, homeFavoritesArgs, homeRecentArgs, homeRecentlyAddedArgs } from '@/api/bootPrefetch';
import { useRpcQuery } from '@/api/query';
import type { CatalogSearchResult } from '@/api/rpc';
import {
  itemKey,
  type Channel,
  type EpgNowNext,
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
import { useLists } from '@/features/lists/hooks/useLists';
import { CustomListRails } from '@/features/lists/rails';
import { MyListRail } from '@/features/mylist/components/MyListRail';
import { useInMyList, useMyList } from '@/features/mylist/hooks/useMyList';
import { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';
import { formatRating } from '@/features/vod/lib/rating';
import { isDesktop, RpcError, type RpcResult } from '@/api/transport';
import { snapshotTitle } from '@/lib/title';
import { Badge, EmptyState, ErrorState, useToast, errorDescription, whenIdle } from '@/ui';

import { useOffline } from '../connection';
import { sourceBasePath, sourceHomePath } from '../railLinks';
import { useShell } from '../store';
import { useVisibleSources } from '../useVisibleSources';
import { useSettings } from '../useSettings';
// account:
import { AccountAlerts } from './AccountAlerts';
import { ChannelCard, ContinueCard, OnNowCard, PosterCard, SourceCard, SourceKindContext, itemPath, joinList, type CardMenuItem } from './cards';
import { ChannelMenuHost, snapshotChannel } from './ChannelCardMenu';
import { DashboardRail, type RailCardProps } from './DashboardRail';
import { HeroCarousel } from './HeroCarousel';
import { HeroSkeleton } from './HeroSkeleton';
import { buildHeroSlides, titleEndsWithYear, type HeroSlide } from './heroSlides';
import { useNearView } from './nearView';
import { minutesLeft, watchedFraction } from './progress';
import { readRailEmpty, writeRailEmpty } from './railEmpty';

// First run only: the welcome brings the Sources onboarding tiles and the add flow with it, in
// a chunk of its own, so a returning user's Home never downloads them.
const Welcome = lazy(() => import('./Welcome').then((m) => ({ default: m.Welcome })));

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
function programmeProgress(start?: string, end?: string, offsetMinutes = 0, now = Date.now()): number | undefined {
  if (!start || !end) return undefined;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  return Math.max(0, Math.min(1, (now - offsetMinutes * 60_000 - s) / (e - s)));
}

/** Whole minutes until `end` (at least 1), with the guide offset applied; undefined without an end. */
function programmeMinutesLeft(end: string | undefined, offsetMinutes = 0, now = Date.now()): number | undefined {
  const e = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(e)) return undefined;
  return Math.max(1, Math.round((e - (now - offsetMinutes * 60_000)) / 60_000));
}

/** A live channel Home can show on air: where it came from and the channel the menu acts on. */
export interface LiveCandidate {
  ref: ItemRef;
  name: string;
  logoUrl?: string;
  channel: Channel;
}

/** On now shows at most this many programmes. */
export const ON_NOW_LIMIT = 24;
/** At most this many channels are asked about in the one `epg.nowNext` call Home makes. */
const NOW_NEXT_LIMIT = 48;

/**
 * The channels On now asks the guide about, in order: recently watched channels, then the first
 * channels of the most used source (so a user with nothing watched yet, an M3U user above all,
 * still sees live TV on Home: SH-home-empty-m3u, CB-PROGRAM-ART). The channels in `skip` stay
 * out: those another rail on Home already shows (the live favourites, whose rail sits just below
 * with the same programmes, and recent channels while their rail is on). One entry per channel;
 * radio stays out (stations rarely have a guide). Exported for tests.
 */
export function liveCandidates(
  skip: readonly { ref: ItemRef }[],
  recent: readonly RecentEntry[],
  fill: readonly Channel[],
  limit = NOW_NEXT_LIMIT,
): LiveCandidate[] {
  const seen = new Set<string>(skip.map((e) => itemKey(e.ref)));
  const out: LiveCandidate[] = [];
  const add = (c: LiveCandidate) => {
    if (out.length >= limit || c.ref.contentType !== 'live') return;
    const key = itemKey(c.ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const e of recent) {
    add({ ref: e.ref, name: e.snapshot.title, logoUrl: e.snapshot.posterUrl, channel: snapshotChannel(e.ref, e.snapshot) });
  }
  for (const ch of fill) add({ ref: ch.ref, name: ch.name, logoUrl: ch.logoUrl, channel: ch });
  return out;
}

export type OnNowItem = LiveCandidate & { programme: NonNullable<EpgNowNext['now']>; progress: number | undefined; left: number | undefined };

/** The candidates with a programme on air now, in candidate order, at most `limit`. Exported for tests. */
export function onNowItems(
  candidates: readonly LiveCandidate[],
  nowNext: Readonly<Record<string, EpgNowNext>> | undefined,
  offsetMinutes = 0,
  now = Date.now(),
  limit = ON_NOW_LIMIT,
): OnNowItem[] {
  if (!nowNext) return [];
  const out: OnNowItem[] = [];
  for (const c of candidates) {
    const programme = nowNext[itemKey(c.ref)]?.now;
    if (!programme) continue;
    const progress = programmeProgress(programme.start, programme.end, offsetMinutes, now);
    // A programme the guide still lists as now but that ended (a stale cache) is not on air.
    if (progress !== undefined && progress >= 1) continue;
    out.push({ ...c, programme, progress, left: programmeMinutesLeft(programme.end, offsetMinutes, now) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The page's single <h1> (sr-only; the header shows the visible title) in every state, and the
 * card menus (Run 2 C2, CB-CONTINUE-MENU) for every card below, custom list rails included.
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
  const offline = useOffline();

  useEffect(() => {
    shell.setHeader({ title: t('navDashboard') });
  }, [shell, t]);

  const settings = useSettings();
  const rails = settings.data?.dashboardRails;
  const show = (k: keyof NonNullable<typeof rails>) => rails?.[k] ?? true;
  type Section = keyof NonNullable<typeof rails>;
  const tmdbEnabled = settings.data?.tmdb.enabled ?? false;
  // On now and the channels rail are live TV on Home, so they follow the live favourites
  // switch until they get one of their own (a core setting).
  const liveOn = show('liveFavorites');

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
  // The custom list rails read this same query; the quiet state counts the lists they show.
  const customLists = useLists();
  const customListsShown = (customLists.data ?? []).some((l) => l.onDashboard && l.itemCount > 0);
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

  // Live TV on Home. The most used source with channels fills in when favourites and history
  // are short. It is ranked by history, so it waits for that answer (one request, not two).
  const topLiveSource = rankedSources.find((s) => s.channelCount > 0);
  const recentSettled = recent.isSuccess || recent.isError;
  const fillArgs = { sourceId: topLiveSource?.id ?? '', query: { offset: 0, limit: RAIL_LIMIT } };
  const fill = useRpcQuery('catalog.channels', fillArgs, {
    enabled: hasSources && liveOn && !!topLiveSource && recentSettled,
    staleTime: 5 * 60_000,
  });
  const fillWanted = hasSources && liveOn && !!topLiveSource;
  const fillSettled = !fillWanted || fill.isSuccess || fill.isError;
  const fillChannels = useMemo(() => (fill.data?.items ?? []).filter((c) => !c.isRadio && !removingSources.has(c.ref.sourceId)), [fill.data, removingSources]);
  // On now leaves out the channels another live rail already shows: the live favourites (On now
  // shares their switch, so their rail is on too) and, while its rail is on, recent channels.
  // Otherwise it opened with the very cards of the rails below, in the same order.
  const recentLiveOn = show('recentlyWatchedLive');
  const candidates = useMemo(
    () =>
      liveOn
        ? recentLiveOn
          ? liveCandidates([...liveFavorites, ...recentLive], [], fillChannels)
          : liveCandidates(liveFavorites, recentLive, fillChannels)
        : [],
    [liveOn, recentLiveOn, liveFavorites, recentLive, fillChannels],
  );
  // The favourites rail shows its programmes from the same answer, so it is in the list first.
  const nowRefs = useMemo(() => {
    const refs = new Map<string, ItemRef>();
    for (const f of liveFavorites) refs.set(itemKey(f.ref), f.ref);
    for (const c of candidates) if (refs.size < NOW_NEXT_LIMIT) refs.set(itemKey(c.ref), c.ref);
    return [...refs.values()];
  }, [liveFavorites, candidates]);
  const epgOffset = settings.data?.epgOffsetMinutes ?? 0;
  // One call once the lists it asks about have all answered, so it is not made again with each.
  // The cards read only the programme's title and times: no descriptions, about half the bytes
  // (L3-serve-ui-8). Refreshed each minute while the window shows (a programme ends, the next starts).
  const nowNext = useRpcQuery(
    'epg.nowNext',
    epgOffset ? { refs: nowRefs, offsetMinutes: epgOffset, withDescription: false } : { refs: nowRefs, withDescription: false },
    // keepPrevious: a channel played (history changed) asks again for one more channel; the
    // rails keep what they show meanwhile instead of dropping back to their skeletons.
    { enabled: nowRefs.length > 0 && !favorites.isPending && recentSettled && fillSettled, staleTime: 60_000, keepPrevious: true },
  );
  // The favourites rail's own part of the answer, as one object for as long as that part holds:
  // a new answer for other channels (history changed) does not re-render its cards (SH-4).
  const favoriteNowSig = JSON.stringify(liveFavorites.map((f) => nowNext.data?.[itemKey(f.ref)]?.now ?? null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const favoriteNowNext = useMemo(() => nowNext.data, [favoriteNowSig]);
  // A minute tick while the window shows: the guide is asked again (a programme ended, the
  // next one started) and the progress bars move on. One timer a minute, nothing while hidden.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  const refetchNowNext = nowNext.refetch;
  const nowNextOn = nowRefs.length > 0;
  useEffect(() => {
    if (!nowNextOn) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setMinute(Math.floor(Date.now() / 60_000));
      void refetchNowNext();
    }, 60_000);
    return () => clearInterval(id);
  }, [nowNextOn, refetchNowNext]);
  // `minute` is in the list so the shares and minutes left are worked out again on each tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onNow = useMemo(() => onNowItems(candidates, nowNext.data, epgOffset), [candidates, nowNext.data, epgOffset, minute]);
  // No guide data and nothing personal yet: the most used source's channels themselves.
  const showChannels = liveOn && !nowNext.isPending && onNow.length === 0 && liveFavorites.length === 0 && recentLive.length === 0 && fillChannels.length > 0;

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
          toast({ variant: 'error', title: t('playFailed', { title: args.title }), description: errorDescription(err) });
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
  // A continue slide offers its card's menu (CB-CONTINUE-MENU), with the title the slide shows.
  const slideMenu = useCallback(
    (s: HeroSlide) => (s.position ? continueMenu(s.position, s.title || t('untitled'), navigate, t) : undefined),
    [navigate, t],
  );
  const retryAdded = useCallback(() => {
    void addedMovies.refetch();
    void addedSeries.refetch();
  }, [addedMovies.refetch, addedSeries.refetch]);

  // A hero that came back empty last time (a new or M3U-only user) skips its skeleton, so
  // nothing tall shows and collapses on every start (SH-hero-skeleton-flash).
  const [heroWasEmpty] = useState(() => readRailEmpty('hero'));
  const heroAnswered = continueWatching.isSuccess && (!wantAdded || (addedMovies.isSuccess && addedSeries.isSuccess));
  useEffect(() => {
    if (heroSlides.length > 0) writeRailEmpty('hero', false);
    else if (heroAnswered) writeRailEmpty('hero', true);
  }, [heroSlides.length, heroAnswered]);

  // First run: nothing to show yet.
  if (sources.isSuccess && !hasSources) {
    return (
      <Suspense fallback={null}>
        <Welcome />
      </Suspense>
    );
  }
  if (settings.isPending) {
    return (
      <div className="flex flex-col gap-10" aria-busy="true" data-testid="dashboard-loading">
        {heroWasEmpty ? <div className="h-6" /> : <HeroSkeleton />}
      </div>
    );
  }
  if (sources.isError) {
    // The shell's offline strip already says the server is gone (SH-offline-stack): wait quietly.
    if (offline) {
      return (
        <EmptyState
          icon={<CloudOff size={28} />}
          title={t('dashboardWaitingTitle')}
          description={t('dashboardWaitingBody')}
          className="min-h-[60vh]"
        />
      );
    }
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
    customListsShown ||
    (liveOn && onNow.length > 0) ||
    showChannels ||
    (show('liveFavorites') && liveFavorites.length > 0) ||
    (show('recentlyWatchedLive') && recentLive.length > 0) ||
    (show('favoriteMoviesAndSeries') && vodFavorites.length > 0) ||
    (show('recentlyAdded') && recentlyAdded.length > 0) ||
    (show('tmdbTrending') && tmdbEnabled && (trending.data?.length ?? 0) > 0);
  // Wait for every rail on screen (and a hero still waiting for new arrivals), so
  // "Nothing to show yet" never flashes above content still loading.
  const onNowPending = liveOn && (favorites.isPending || !recentSettled || !fillSettled || (nowRefs.length > 0 && nowNext.isPending));
  const anyRailPending =
    railQueries.some((q) => q.isPending) || (myListOn && myList.isPending) || customLists.isPending || (show('hero') && heroLoading) || onNowPending;

  // Layout stability: nothing renders below the first section still loading. A skeleton
  // that collapses (empty rail, shared error) or a flagged rail that appears then moves
  // nothing, because everything after it is inserted only once it has settled.
  type Slot = Section | 'onNow';
  const sections: [Slot, boolean][] = [
    ['hero', heroLayoutPending],
    ['continueWatching', continueWatching.isPending],
    // On now waits for the lists it reads and the guide's answer; its own skeleton holds its place.
    ['onNow', false],
    // My List loads inside its own rail (skeleton first), so it never holds back the rest.
    ['myList', false],
    ['liveFavorites', favorites.isPending],
    ['recentlyWatchedLive', recent.isPending],
    ['favoriteMoviesAndSeries', favorites.isPending],
    ['recentSources', sources.isPending],
    ['recentlyAdded', addedMovies.isPending || addedSeries.isPending],
    ['tmdbTrending', tmdbEnabled && trending.isPending],
  ];
  const on = (k: Slot) => (k === 'onNow' ? liveOn : show(k));
  const firstPending = sections.findIndex(([k, pending]) => on(k) && pending);
  /** The section is on and nothing above it is still loading. */
  const visible = (k: Slot) => on(k) && (firstPending < 0 || sections.findIndex(([x]) => x === k) <= firstPending);

  const heroShown = show('hero') && !showSharedError && ((heroLoading && !heroWasEmpty) || heroSlides.length > 0);

  return (
    // gap-10 follows density through --spacing. The hero runs flush under the header; with no
    // hero on top the first rail keeps the page's top padding.
    <SourceKindContext.Provider value={sourceKinds}>
      <div className={heroShown ? 'flex flex-col gap-10 pb-16' : 'flex flex-col gap-10 pt-6 pb-16'} data-testid="dashboard">
        {/* account: subscription expiry alerts, above everything else. */}
        {hasSources && (
          <div className={heroShown ? 'pt-6 empty:hidden' : 'empty:hidden'}>
            <AccountAlerts sources={sources.data ?? []} />
          </div>
        )}
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
            <div className="col-start-1 row-start-1 mx-(--page-gutter) flex self-start rounded-lg border border-edge bg-surface" data-testid="dashboard-error">
              <ErrorState
                error={sharedError}
                size="inline"
                className="flex-1"
                title={t('dashboardLoadFailed')}
                hint={t(isDesktop ? 'dashboardLocalDataHint' : 'dashboardServerDataHint')}
                onRetry={retryAllRails}
              />
            </div>
          </div>
        )}
        {show('hero') &&
          !showSharedError &&
          (heroLoading ? (
            heroWasEmpty ? null : <HeroSkeleton />
          ) : heroSlides.length > 0 ? (
            <HeroCarousel slides={heroSlides} sourceName={heroSourceName} canPlay={heroCanPlay} onPlay={playSlide} menuFor={slideMenu} />
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

        {visible('onNow') && (
          <OnNowRail items={onNowPending ? undefined : onNow} loading={onNowPending} loaded={!onNowPending} manySources={manySources} sourceById={sourceById} play={play} />
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
            nowNext={favoriteNowNext}
            epgOffset={epgOffset}
            sourceById={sourceById}
            manySources={manySources}
            play={play}
          />
        )}

        {visible('liveFavorites') && showChannels && topLiveSource && (
          <SourceChannelsRail source={topLiveSource} items={fillChannels} play={play} />
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
            sourceById={sourceById}
          />
        )}

        {hasSources && !anyRailVisible && !anyRailError && !anyRailPending && <GetStarted source={rankedSources[0]} hasLive={rankedSources.some((s) => s.channelCount > 0)} />}
      </div>
    </SourceKindContext.Provider>
  );
}

/** A tile of the quiet state: an icon, what it opens, and a line on what is there. */
interface StartTile {
  id: string;
  to: string;
  icon: LucideIcon;
  title: string;
  hint: string;
}

/**
 * Home with sources but nothing on it yet: a source still importing, a playlist of movies with
 * no dates, every rail switched off. It says what will fill the page and offers three ways in
 * rather than one button: the most used source's own home (a VOD-only account opens on its
 * movies, SH-quiet-live-path), the TV guide when there are channels, and search.
 */
function GetStarted({ source, hasLive }: { source: Source | undefined; hasLive: boolean }) {
  const { t } = useTranslation('shell');
  const live = !source || source.channelCount > 0;
  const tiles: StartTile[] = [
    {
      id: 'browse',
      to: source ? sourceHomePath(source) : '/sources',
      icon: live ? Tv : source.movieCount > 0 ? Clapperboard : Layers,
      title: live ? t('browseLive') : source.movieCount > 0 ? t('browseMovies') : t('browseSeries'),
      hint: source?.name ?? t('manageSources'),
    },
    ...(hasLive ? [{ id: 'guide', to: '/epg', icon: CalendarRange, title: t('navGuide'), hint: t('getStartedGuideHint') }] : []),
    { id: 'search', to: '/search', icon: Search, title: t('navSearch'), hint: t('getStartedSearchHint') },
  ];
  return (
    <section aria-labelledby="dashboard-quiet-title" className="flex flex-col gap-4 px-(--page-gutter)" data-testid="dashboard-quiet">
      <div className="flex flex-col gap-1">
        <h2 id="dashboard-quiet-title" className="text-title-sm text-fg">
          {t('dashboardQuietTitle')}
        </h2>
        <p className="text-body-sm text-fg-muted">{t('dashboardQuietBody')}</p>
      </div>
      <ul className="grid max-w-5xl gap-3 sm:grid-cols-3">
        {tiles.map(({ id, to, icon: Icon, title, hint }) => (
          <li key={id} className="min-w-0">
            <Link
              to={to}
              data-start-tile={id}
              className="group flex h-full items-center gap-3 rounded-lg border border-edge bg-surface p-4 shadow-1 hover:border-border hover:bg-surface-2 active:bg-pressed motion-safe:transition-colors"
            >
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2 text-fg-muted group-hover:text-fg">
                <Icon size={18} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body font-medium text-fg">{title}</span>
                <span dir="auto" title={hint} className="truncate text-match-parent text-caption text-fg-muted">
                  {hint}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
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
const candidateKey = (c: LiveCandidate) => itemKey(c.ref);
const channelKey = (c: Channel) => itemKey(c.ref);
const sourceKey = (s: Source) => s.id;
const trendingKey = (b: TmdbBrief) => `${b.mediaType}-${b.tmdbId}`;

/** Wide cards: Continue watching and On now, a 16:9 still with room for an episode line. */
const WIDE_CARD = 280;
const WIDE_CARD_PHONE = 240;

/**
 * The card menu's actions load on the click: their watched-state module shares a chunk with the
 * player store, and a static import put that store in Home's first render (C4, SH-2).
 */
const continueActions = () => import('./continueActions');

/**
 * The detail page's backdrop of a resumed movie or series (a local catalog read, shared with the
 * hero's query), read once the card is near the view: until then, and while it loads, the card
 * draws its poster (SH-home-rpc-fanout).
 */
function useBackdrop(ref: ItemRef, near: boolean): string | undefined {
  const vod = ref.contentType === 'movie' || ref.contentType === 'series';
  const item = useRpcQuery('catalog.item', { ref }, { enabled: vod && near, staleTime: 10 * 60_000 });
  const d = item.data as { backdropUrl?: string } | undefined;
  return d && 'backdropUrl' in d ? d.backdropUrl : undefined;
}

/**
 * The menu of a title to resume (CB-CONTINUE-MENU): Go to details, Mark watched (the episode
 * it resumes), Remove from continue watching, the last two with an Undo. Shared by the card in
 * the rail and the hero's continue slide, so the two never offer different things.
 */
function continueMenu(p: PlaybackPosition, title: string, navigate: NavigateFunction, t: TFunction): CardMenuItem[] {
  return [
    { id: 'details', label: t('goToDetails'), icon: <Info className="size-4" />, onSelect: () => navigate(itemPath(p.ref)) },
    { id: 'watched', label: t('vod:markWatched'), icon: <CircleCheck className="size-4" />, onSelect: () => void continueActions().then((m) => m.markContinueWatched(p, title, t)) },
    { id: 'remove', label: t('removeFromContinue'), icon: <X className="size-4" />, onSelect: () => void continueActions().then((m) => m.removeFromContinue(p, title, t)) },
  ];
}

/** One Continue watching card: the 16:9 still, the episode and the time left, and its menu (CB-CONTINUE-MENU). */
function ContinueItem({ p, rail, play, saved }: { p: PlaybackPosition; rail: RailCardProps; play: PlayFn; saved: boolean }) {
  const { t, i18n } = useTranslation('shell');
  const navigate = useNavigate();
  const [card, setCard] = useState<HTMLElement | null>(null);
  const backdropUrl = useBackdrop(p.ref, useNearView(card));
  // L2-visual-3: a snapshot saved before the player stored the base title still carries
  // the provider's tags and year; show (and save to My List) what the detail page shows.
  const base = p.snapshot?.title ? snapshotTitle(p.ref, p.snapshot.title) : undefined;
  const title = base?.title ?? t('untitled');
  const left = minutesLeft(p);
  const series = p.ref.contentType === 'series';
  const menu = continueMenu(p, title, navigate, t);
  return (
    <ContinueCard
      rail={{ ...rail, ref: setCard }}
      title={title}
      episode={series ? p.snapshot?.subtitle : undefined}
      left={left !== undefined ? t('minutesLeft', { count: left }) : !series ? p.snapshot?.subtitle : undefined}
      progress={watchedFraction(p)}
      posterUrl={p.snapshot?.posterUrl}
      backdropUrl={backdropUrl}
      sourceId={p.ref.sourceId}
      saved={saved}
      ariaLabel={saved ? joinList([t('resumeTitle', { title }), t('vod:posterInMyList')], i18n.language) : t('resumeTitle', { title })}
      menu={menu}
      onPlay={() => play({ ref: p.ref, episodeId: p.episodeId, title, subtitle: p.snapshot?.subtitle, posterUrl: p.snapshot?.posterUrl })}
    />
  );
}

const ContinueWatchingRail = memo(function ContinueWatchingRail({
  items,
  loading,
  loaded,
  error,
  refetch,
  play,
}: RailQueryProps & { items: readonly PlaybackPosition[] | undefined; play: PlayFn }) {
  const { t } = useTranslation('shell');
  const savedKeys = useInMyList(useMemo(() => (items ?? []).map((p) => p.ref), [items]));
  return (
    <DashboardRail<PlaybackPosition>
      id="continue-watching"
      title={t('railContinueWatching')}
      items={items}
      loading={loading}
      loaded={loaded}
      error={error}
      errorHint={t(isDesktop ? 'dashboardLocalDataHint' : 'dashboardServerDataHint')}
      onRetry={() => void refetch()}
      // The whole list, with remove and clear, is on Recently watched.
      seeAll={{ to: '/recent' }}
      getKey={continueKey}
      cardWidth={WIDE_CARD}
      phoneCardWidth={WIDE_CARD_PHONE}
      skeletonAspect={16 / 9}
      renderCard={(p, rail) => <ContinueItem p={p} rail={rail} play={play} saved={savedKeys.has(itemKey(p.ref))} />}
    />
  );
});

/** What is on air now, with the programme's picture (CB-PROGRAM-ART), on channels no other live rail below shows (liveCandidates). */
const OnNowRail = memo(function OnNowRail({
  items,
  loading,
  loaded,
  manySources,
  sourceById,
  play,
}: {
  items: readonly OnNowItem[] | undefined;
  loading: boolean;
  loaded: boolean;
  manySources: boolean;
  sourceById: ReadonlyMap<string, Source>;
  play: PlayFn;
}) {
  const { t, i18n } = useTranslation('shell');
  return (
    <DashboardRail<OnNowItem>
      id="on-now"
      title={t('railOnNow')}
      items={items}
      loading={loading}
      loaded={loaded}
      seeAll={{ to: '/epg', label: t('openGuide') }}
      getKey={candidateKey}
      cardWidth={WIDE_CARD}
      phoneCardWidth={WIDE_CARD_PHONE}
      skeletonAspect={16 / 9}
      renderCard={(c, rail) => {
        const left = c.left !== undefined ? t('minutesLeft', { count: c.left }) : undefined;
        const channelName = manySources ? joinList([c.name, sourceById.get(c.ref.sourceId)?.name], i18n.language) : c.name;
        return (
          <OnNowCard
            rail={rail}
            programme={c.programme.title}
            programmeArt={c.programme.icon}
            channelName={channelName}
            logoUrl={c.logoUrl}
            left={left}
            progress={c.progress}
            sourceId={c.ref.sourceId}
            ariaLabel={joinList([t('playTitle', { title: c.name }), c.programme.title, left], i18n.language)}
            onPlay={() => play({ ref: c.ref, title: c.name, posterUrl: c.logoUrl })}
            channel={c.channel}
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
      errorHint={t(isDesktop ? 'dashboardLocalDataHint' : 'dashboardServerDataHint')}
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

/**
 * The most used source's first channels, for a Home with no guide data and nothing watched or
 * favourited yet: an M3U user's Home after the first import (SH-home-empty-m3u).
 */
const SourceChannelsRail = memo(function SourceChannelsRail({ source, items, play }: { source: Source; items: readonly Channel[]; play: PlayFn }) {
  const { t } = useTranslation('shell');
  return (
    <DashboardRail<Channel>
      id="source-channels"
      title={t('railChannelsIn', { source: source.name })}
      items={items}
      loaded
      seeAll={{ to: `${sourceBasePath(source.id)}/live` }}
      getKey={channelKey}
      cardWidth={232}
      skeletonAspect={16 / 9}
      renderCard={(c, rail) => (
        <ChannelCard
          rail={rail}
          name={c.name}
          logoUrl={c.logoUrl}
          sourceName={c.categoryName || undefined}
          ariaLabel={t('playTitle', { title: c.name })}
          onPlay={() => play({ ref: c.ref, title: c.name, posterUrl: c.logoUrl })}
          channel={c}
        />
      )}
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
      errorHint={t(isDesktop ? 'dashboardLocalDataHint' : 'dashboardServerDataHint')}
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
      errorHint={t(isDesktop ? 'dashboardLocalDataHint' : 'dashboardServerDataHint')}
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
      errorHint={t(isDesktop ? 'dashboardLocalDataHint' : 'dashboardServerDataHint')}
      onRetry={() => void refetch()}
      getKey={refKey}
      cardWidth={168}
      skeletonAspect={2 / 3}
      renderCard={(v, rail) => {
        // Intl, like the hero: de reads "7,5" on both.
        const rating = formatRating(v.rating, i18n.language);
        // The title the detail page and the hero show: no trailing year or provider tag.
        const title = v.titleBase || v.title;
        return (
          <PosterCard
            rail={rail}
            title={title}
            subtitle={joinList([sourceById.get(v.ref.sourceId)?.name, !titleEndsWithYear(title, v.year) && v.year], i18n.language)}
            posterUrl={v.posterUrl}
            backdropUrl={v.backdropUrl}
            badge={rating ? <Badge variant="neutral" className="bg-glass-strong text-on-glass">{rating}</Badge> : undefined}
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

/** A title reduced for matching across catalogs: lower case, no accents, letters and digits only. */
function matchKey(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The catalog title a TMDB trending entry stands for (SH-trending-dead-end): the same name, of
 * the same kind, and the same year give or take one (release dates differ between regions and
 * providers) when both have a year. The first in the search's own order wins. Exported for tests.
 */
export function trendingMatch(b: TmdbBrief, found: CatalogSearchResult | undefined): VodItem | SeriesItem | undefined {
  if (!found) return undefined;
  const key = matchKey(b.title);
  if (!key) return undefined;
  const list: readonly (VodItem | SeriesItem)[] = b.mediaType === 'tv' ? found.series : found.movies;
  return list.find(
    (v) => matchKey(v.titleBase || v.title) === key && (b.year === undefined || v.year === undefined || Math.abs(v.year - b.year) <= 1),
  );
}

/**
 * A trending title, looked up in the local catalog. Found, it is an ordinary title card: it opens
 * the detail page and takes My List. Not found (or still looking), it stays a search, and says
 * so on hover and focus: a portal's catalog is only searched live, on the search page.
 *
 * The lookup waits until the card is near the view and the page has gone idle once (`ready`, from
 * the rail), so a cold Home does not send one search per trending title (up to 40) ahead of its
 * own reads, and a `sources.changed` searches again only for the cards on screen
 * (SH-home-rpc-fanout).
 */
function TrendingCard({ b, rail, sourceById, ready }: { b: TmdbBrief; rail: RailCardProps; sourceById: ReadonlyMap<string, Source>; ready: boolean }) {
  const { t, i18n } = useTranslation('shell');
  const [card, setCard] = useState<HTMLElement | null>(null);
  const near = useNearView(card);
  const found = useRpcQuery(
    'catalog.search',
    { query: b.title, contentTypes: [b.mediaType === 'tv' ? 'series' : 'movie'], limit: 8 },
    // As long as the trending list itself: neither changes within the hour.
    { enabled: ready && near, staleTime: 60 * 60_000 },
  );
  const cardRail: RailCardProps = { ...rail, ref: setCard };
  const match = trendingMatch(b, found.data);
  const rating = b.rating ? formatRating(b.rating, i18n.language) : undefined;
  const badge = rating ? <Badge variant="neutral" className="bg-glass-strong text-on-glass">{rating}</Badge> : undefined;
  if (match) {
    const title = match.titleBase || match.title;
    const sourceName = sourceById.get(match.ref.sourceId)?.name;
    const year = match.year ?? b.year;
    return (
      <PosterCard
        rail={cardRail}
        title={title}
        subtitle={joinList([sourceName, !titleEndsWithYear(title, year) && year], i18n.language)}
        posterUrl={match.posterUrl ?? b.posterUrl}
        backdropUrl={match.backdropUrl}
        badge={badge}
        to={itemPath(match.ref)}
        ariaLabel={joinList([title, sourceName, year, rating && t('ratedLabel', { rating })], i18n.language)}
        myList={myListTarget(match)}
      />
    );
  }
  return (
    <PosterCard
      rail={cardRail}
      title={b.title}
      subtitle={joinList([b.mediaType === 'tv' ? t('series') : t('movie'), b.year], i18n.language)}
      posterUrl={b.posterUrl}
      badge={badge}
      to={`/search?q=${encodeURIComponent(b.title)}`}
      search={t('findInSources')}
      ariaLabel={t('findTitle', { title: b.title })}
    />
  );
}

const TrendingRail = memo(function TrendingRail({
  items,
  loading,
  loaded,
  error,
  refetch,
  sourceById,
}: RailQueryProps & { items: readonly TmdbBrief[] | undefined; sourceById: ReadonlyMap<string, Source> }) {
  const { t } = useTranslation('shell');
  // The catalog lookups start once the page has gone idle after the rail appeared.
  const [ready, setReady] = useState(false);
  useEffect(() => whenIdle(() => setReady(true)), []);
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
      renderCard={(b, rail) => <TrendingCard b={b} rail={rail} sourceById={sourceById} ready={ready} />}
    />
  );
});
