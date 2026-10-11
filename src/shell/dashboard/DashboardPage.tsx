import { Info, ListPlus, Play, Tv } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import {
  itemKey,
  type FavoriteEntry,
  type ItemRef,
  type PlaybackPosition,
  type RecentEntry,
  type SeriesItem,
  type Source,
  type TmdbBrief,
  type VodItem,
} from '@/api/types';
import { playItem } from '@/features/player';
import { Badge, Button, EmptyState, ErrorState, Poster, ProgressBar, Skeleton, buttonClass, useToast } from '@/ui';

import { useShell } from '../store';
import { useSettings } from '../useSettings';
import { ChannelCard, PosterCard, SourceCard, itemPath } from './cards';
import { DashboardRail } from './DashboardRail';

const RAIL_LIMIT = 24;

/** Fraction watched, or undefined when duration is unknown. */
export function watchedFraction(p: Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'>): number | undefined {
  if (!p.durationSeconds || p.durationSeconds <= 0) return undefined;
  return Math.max(0, Math.min(1, p.positionSeconds / p.durationSeconds));
}

/** Whole minutes left (at least 1), or undefined. */
export function minutesLeft(p: Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'>): number | undefined {
  if (!p.durationSeconds || p.durationSeconds <= 0) return undefined;
  return Math.max(1, Math.round((p.durationSeconds - p.positionSeconds) / 60));
}

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

function programmeProgress(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  return Math.max(0, Math.min(1, (Date.now() - s) / (e - s)));
}

function Hero({
  position,
  sourceKind,
  onPlay,
}: {
  position: PlaybackPosition;
  sourceKind: Source['kind'] | undefined;
  onPlay: () => void;
}) {
  const { t } = useTranslation('shell');
  const snap = position.snapshot;
  const title = snap?.title ?? t('untitled');
  const fraction = watchedFraction(position);
  const left = minutesLeft(position);
  const isVod = position.ref.contentType === 'movie' || position.ref.contentType === 'series';
  return (
    <section
      aria-labelledby="dash-hero-title"
      data-testid="dashboard-hero"
      className="relative mx-8 overflow-hidden rounded-lg border border-border bg-surface"
    >
      {snap?.posterUrl && (
        <div aria-hidden className="absolute inset-0">
          <img src={snap.posterUrl} alt="" className="h-full w-full scale-110 object-cover opacity-40 blur-2xl" referrerPolicy="no-referrer" />
        </div>
      )}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-surface via-surface/85 to-surface/30" />
      <div className="relative flex items-end gap-8 p-8">
        <div className="hidden w-[150px] shrink-0 md:block">
          <Poster src={snap?.posterUrl} alt={title} aspect="poster" eager className="shadow-2" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="text-sm font-semibold text-accent">{t('heroEyebrow')}</p>
          <h2 id="dash-hero-title" className="max-w-[22ch] text-[clamp(28px,3.4vw,48px)] leading-[1.05] font-semibold">
            {title}
          </h2>
          {snap?.subtitle && <p className="max-w-[60ch] text-base text-fg-muted">{snap.subtitle}</p>}
          {fraction !== undefined && (
            <div className="flex max-w-md items-center gap-3">
              <ProgressBar value={fraction * 100} label={t('watchedPercent', { percent: Math.round(fraction * 100) })} />
              {left !== undefined && <span className="shrink-0 text-sm text-fg-muted tabular">{t('minutesLeft', { count: left })}</span>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-3">
            <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" aria-hidden />} onClick={onPlay} disabled={!sourceKind}>
              {fraction ? t('resume') : t('play')}
            </Button>
            {isVod && (
              <Link to={itemPath(position.ref)} className={buttonClass('secondary', 'lg')}>
                <Info size={18} aria-hidden />
                {t('details')}
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroSkeleton() {
  return (
    <div className="mx-8 flex items-end gap-8 rounded-lg border border-border bg-surface p-8" aria-hidden>
      <Skeleton className="hidden aspect-[2/3] w-[150px] rounded-md md:block" />
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-3 h-12 w-40 rounded-md" />
      </div>
    </div>
  );
}

/** The page's single <h1> (sr-only; the header shows the visible title) in every state. */
export function DashboardPage() {
  const { t } = useTranslation('shell');
  return (
    <>
      <h1 className="sr-only">{t('navDashboard')}</h1>
      <DashboardBody />
    </>
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
  const tmdbEnabled = settings.data?.tmdb.enabled ?? false;

  const sources = useRpcQuery('sources.list', undefined);
  const hasSources = (sources.data?.length ?? 0) > 0;
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);

  const continueWatching = useRpcQuery('positions.continueWatching', { limit: RAIL_LIMIT }, { enabled: hasSources });
  const favorites = useRpcQuery('favorites.list', {}, { enabled: hasSources });
  const recent = useRpcQuery('recent.list', { limit: 60 }, { enabled: hasSources });
  const addedMovies = useRpcQuery(
    'catalog.recentlyAdded',
    { contentType: 'movie', limit: RAIL_LIMIT },
    { enabled: hasSources && show('recentlyAdded') },
  );
  const addedSeries = useRpcQuery(
    'catalog.recentlyAdded',
    { contentType: 'series', limit: RAIL_LIMIT },
    { enabled: hasSources && show('recentlyAdded') },
  );
  const trending = useRpcQuery('tmdb.trending', undefined, {
    enabled: hasSources && tmdbEnabled && show('tmdbTrending'),
    staleTime: 60 * 60_000,
  });

  const liveFavorites = useMemo(
    () =>
      (favorites.data ?? [])
        .filter((f) => f.ref.contentType === 'live' || f.ref.contentType === 'radio')
        .slice(0, RAIL_LIMIT),
    [favorites.data],
  );
  const vodFavorites = useMemo(
    () =>
      (favorites.data ?? [])
        .filter((f) => f.ref.contentType === 'movie' || f.ref.contentType === 'series')
        .slice(0, RAIL_LIMIT),
    [favorites.data],
  );
  const recentLive = useMemo(
    () =>
      (recent.data ?? [])
        .filter((r) => r.ref.contentType === 'live' || r.ref.contentType === 'radio')
        .slice(0, RAIL_LIMIT),
    [recent.data],
  );
  const rankedSources = useMemo(() => rankSources(sources.data ?? [], recent.data ?? []), [sources.data, recent.data]);
  const recentlyAdded = useMemo(
    () => mergeRecentlyAdded((addedMovies.data ?? []) as VodItem[], (addedSeries.data ?? []) as SeriesItem[], RAIL_LIMIT),
    [addedMovies.data, addedSeries.data],
  );

  const nowRefs = useMemo(() => liveFavorites.map((f) => f.ref), [liveFavorites]);
  const nowNext = useRpcQuery('epg.nowNext', { refs: nowRefs }, { enabled: nowRefs.length > 0, staleTime: 60_000 });

  const play = (args: { ref: ItemRef; episodeId?: string; title: string; subtitle?: string; posterUrl?: string }) => {
    const source = sourceById.get(args.ref.sourceId);
    if (!source) {
      toast({ variant: 'error', title: t('sourceMissing'), description: t('sourceMissingHint') });
      return;
    }
    const isLive = args.ref.contentType === 'live' || args.ref.contentType === 'radio';
    playItem({
      ...args,
      isLive,
      isRadio: args.ref.contentType === 'radio',
      sourceKind: source.kind,
    }).catch((err: unknown) => {
      toast({ variant: 'error', title: t('playFailed', { title: args.title }), description: err instanceof Error ? err.message : undefined });
    });
  };

  // First run: nothing to show yet.
  if (sources.isSuccess && !hasSources) {
    return (
      <div className="flex min-h-full items-center justify-center p-8" data-testid="dashboard-welcome">
        <EmptyState
          icon={<Tv size={28} />}
          title={t('welcomeTitle')}
          description={t('welcomeBody')}
          action={
            <Link to="/sources?add=1" className={buttonClass('primary', 'lg')}>
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

  const hero: PlaybackPosition | undefined = continueWatching.data?.[0];
  const heroLoading = sources.isPending || continueWatching.isPending;

  const seriesBadge = (p: PlaybackPosition) => (p.ref.contentType === 'series' && p.snapshot?.subtitle ? <Badge variant="neutral">{p.snapshot.subtitle}</Badge> : undefined);

  const anyRailVisible =
    (continueWatching.data?.length ?? 0) +
      liveFavorites.length +
      recentLive.length +
      vodFavorites.length +
      recentlyAdded.length +
      (trending.data?.length ?? 0) >
    0;

  return (
    <div className="flex flex-col gap-10 pt-8 pb-16" data-testid="dashboard">
      {show('hero') && (heroLoading ? <HeroSkeleton /> : hero ? (
        <Hero
          position={hero}
          sourceKind={sourceById.get(hero.ref.sourceId)?.kind}
          onPlay={() =>
            play({
              ref: hero.ref,
              episodeId: hero.episodeId,
              title: hero.snapshot?.title ?? '',
              subtitle: hero.snapshot?.subtitle,
              posterUrl: hero.snapshot?.posterUrl,
            })
          }
        />
      ) : null)}

      {show('continueWatching') && (
        <DashboardRail<PlaybackPosition>
          id="continue-watching"
          title={t('railContinueWatching')}
          items={continueWatching.data}
          loading={continueWatching.isPending}
          error={continueWatching.error}
          onRetry={() => void continueWatching.refetch()}
          getKey={(p) => `${itemKey(p.ref)}|${p.episodeId ?? ''}`}
          cardWidth={168}
          skeletonAspect={2 / 3}
          renderCard={(p, rail) => {
            const title = p.snapshot?.title ?? t('untitled');
            const left = minutesLeft(p);
            return (
              <PosterCard
                rail={rail}
                title={title}
                subtitle={left !== undefined ? t('minutesLeft', { count: left }) : p.snapshot?.subtitle}
                posterUrl={p.snapshot?.posterUrl}
                progress={watchedFraction(p)}
                badge={seriesBadge(p)}
                ariaLabel={t('resumeTitle', { title })}
                onPlay={() =>
                  play({ ref: p.ref, episodeId: p.episodeId, title, subtitle: p.snapshot?.subtitle, posterUrl: p.snapshot?.posterUrl })
                }
              />
            );
          }}
        />
      )}

      {show('liveFavorites') && (
        <DashboardRail<FavoriteEntry>
          id="live-favorites"
          title={t('railLiveFavorites')}
          items={liveFavorites}
          loading={favorites.isPending}
          error={favorites.error}
          onRetry={() => void favorites.refetch()}
          seeAll={{ to: '/favorites' }}
          getKey={(f) => itemKey(f.ref)}
          cardWidth={232}
          skeletonAspect={16 / 9}
          renderCard={(f, rail) => {
            const nn = nowNext.data?.[itemKey(f.ref)];
            return (
              <ChannelCard
                rail={rail}
                name={f.snapshot.title}
                logoUrl={f.snapshot.posterUrl}
                now={nn?.now?.title}
                nowProgress={programmeProgress(nn?.now?.start, nn?.now?.end)}
                sourceName={sourceById.get(f.ref.sourceId)?.name}
                isRadio={f.ref.contentType === 'radio'}
                ariaLabel={t('playTitle', { title: f.snapshot.title })}
                onPlay={() => play({ ref: f.ref, title: f.snapshot.title, posterUrl: f.snapshot.posterUrl })}
              />
            );
          }}
        />
      )}

      {show('recentlyWatchedLive') && (
        <DashboardRail<RecentEntry>
          id="recent-live"
          title={t('railRecentLive')}
          items={recentLive}
          loading={recent.isPending}
          error={recent.error}
          onRetry={() => void recent.refetch()}
          seeAll={{ to: '/recent' }}
          getKey={(r) => itemKey(r.ref)}
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
            />
          )}
        />
      )}

      {show('favoriteMoviesAndSeries') && (
        <DashboardRail<FavoriteEntry>
          id="favorite-vod"
          title={t('railFavoriteVod')}
          items={vodFavorites}
          loading={favorites.isPending}
          error={favorites.error}
          onRetry={() => void favorites.refetch()}
          seeAll={{ to: '/favorites' }}
          getKey={(f) => itemKey(f.ref)}
          cardWidth={168}
          skeletonAspect={2 / 3}
          renderCard={(f, rail) => (
            <PosterCard
              rail={rail}
              title={f.snapshot.title}
              subtitle={f.snapshot.subtitle ?? (f.ref.contentType === 'series' ? t('series') : t('movie'))}
              posterUrl={f.snapshot.posterUrl}
              to={itemPath(f.ref)}
            />
          )}
        />
      )}

      {show('recentSources') && (
        <DashboardRail<Source>
          id="recent-sources"
          title={t('railRecentSources')}
          items={rankedSources}
          loading={sources.isPending}
          seeAll={{ to: '/sources', label: t('manageSources') }}
          getKey={(s) => s.id}
          cardWidth={232}
          skeletonAspect={16 / 9}
          renderCard={(s, rail) => <SourceCard rail={rail} source={s} />}
        />
      )}

      {show('recentlyAdded') && (
        <DashboardRail<VodItem | SeriesItem>
          id="recently-added"
          title={t('railRecentlyAdded')}
          items={recentlyAdded}
          loading={addedMovies.isPending || addedSeries.isPending}
          error={addedMovies.error ?? addedSeries.error}
          onRetry={() => {
            void addedMovies.refetch();
            void addedSeries.refetch();
          }}
          getKey={(v) => itemKey(v.ref)}
          cardWidth={168}
          skeletonAspect={2 / 3}
          renderCard={(v, rail) => (
            <PosterCard
              rail={rail}
              title={v.title}
              subtitle={[sourceById.get(v.ref.sourceId)?.name, v.year].filter(Boolean).join(', ')}
              posterUrl={v.posterUrl}
              badge={v.rating ? <Badge variant="neutral">{v.rating.toFixed(1)}</Badge> : undefined}
              to={itemPath(v.ref)}
            />
          )}
        />
      )}

      {show('tmdbTrending') && tmdbEnabled && (
        <DashboardRail<TmdbBrief>
          id="tmdb-trending"
          title={t('railTrending')}
          items={trending.data}
          loading={trending.isPending}
          error={trending.error}
          onRetry={() => void trending.refetch()}
          getKey={(b) => `${b.mediaType}-${b.tmdbId}`}
          cardWidth={168}
          skeletonAspect={2 / 3}
          renderCard={(b, rail) => (
            <PosterCard
              rail={rail}
              title={b.title}
              subtitle={[b.mediaType === 'tv' ? t('series') : t('movie'), b.year].filter(Boolean).join(', ')}
              posterUrl={b.posterUrl}
              badge={b.rating ? <Badge variant="neutral">{b.rating.toFixed(1)}</Badge> : undefined}
              to={`/search?q=${encodeURIComponent(b.title)}`}
              ariaLabel={t('findTitle', { title: b.title })}
            />
          )}
        />
      )}

      {hasSources &&
        !anyRailVisible &&
        !continueWatching.isPending &&
        !favorites.isPending &&
        !recent.isPending && (
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
  );
}
