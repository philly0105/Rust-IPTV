import { Download, ListVideo, Lock, Play, MonitorPlay, RotateCcw, SkipBack } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigationType, useParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { sameRef, type Episode, type ItemRef } from '@/api/types';
import { MyListButton } from '@/features/mylist/components/MyListButton';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { usePlayerStore } from '@/features/player';

import { FavoriteButton, WatchedButton } from '../components/detail/actions';
import { DetailHero, DetailHeroSkeleton } from '../components/detail/DetailHero';
import { EpisodeList, SeasonTabs } from '../components/detail/EpisodeList';
import { ParentalLocked, useOpenGate } from '../components/detail/ParentalLocked';
import { TrailerDialog } from '../components/detail/TrailerDialog';
import { useFocusOnOpen } from '../components/detail/useFocusOnOpen';
import { NextEpisodeCard, UpNextRail, upcoming } from '../components/detail/UpNext';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
import { WatchStage } from '../components/detail/WatchStage';
import { SimilarSection } from '../components/SimilarSection';
import {
  useIsFavorite,
  useSeriesDetail,
  useSetWatched,
  useSettings,
  useSource,
  useTmdbKeyMissing,
  useTmdbSimilar,
  useTmdbTv,
  useTwinProbe,
} from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { recallSeason, rememberSeason, useScrollMemory } from '../hooks/useScrollMemory';
import { useItemDownloads, usePlayback, type PlayTarget } from '../hooks/usePlayback';
import { useDetailEscapeBack } from '../hooks/useBackKey';
import { useEscapeToClose, useWatchState } from '../hooks/useWatchState';
import { cleanEpisodeTitle, episodeCode, episodeSubtitle, isWatched } from '../lib/format';
import { episodeOrder, mergeSeasonEpisodes, mergeSeriesDetail, nextEpisode, previousEpisode, resumeTarget, sortSeasons, youtubeKey } from '../lib/merge';
import { Button, EmptyState, ErrorState, IconButton, useToast, errorDescription } from '@/ui';
import { detailHref } from '../lib/search';
import { startEpisodeQueue } from '../lib/episodeQueue';
import { captureWatched } from '@/features/library/lib/watchedUndo';
import { seriesWatchedTargets, seriesWatchedWrite, watchedToastId, watchedUndoAll } from '../lib/seriesWatched';

export function SeriesDetailPage() {
  const { t, i18n } = useTranslation('vod');
  const { sourceId = '', itemId = '' } = useParams();
  const ref = useMemo<ItemRef>(() => ({ sourceId, contentType: 'series', itemId }), [sourceId, itemId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const tmdbOn = settings.tmdb.enabled;
  const source = useSource(sourceId);
  const detail = useSeriesDetail(source.data, ref);
  // A failed lookup may be a movie id on the series route (cold link): look it up as a movie.
  const probeTwin = detail.isError && detail.error.code !== 'auth' && !!source.data;
  const twin = useTwinProbe(source.data, ref, probeTwin);
  const keyMissing = useTmdbKeyMissing(settings);
  const item = detail.data?.item;
  // C2: in Ask mode a locked series shows nothing until the PIN is entered. Stalker titles are not
  // in the local catalog, so the core learns their group only from the details: wait for them.
  const stalkerSource = source.data?.kind === 'stalker';
  const gate = useOpenGate(ref, {
    categoryId: stalkerSource ? item?.categoryId : undefined,
    waitForCategory: source.isPending || (stalkerSource && detail.isPending),
  });
  const tmdb = useTmdbTv(item, tmdbOn);
  // A disabled query still returns what it cached while TMDB was on: merge it only while TMDB is on.
  const model = useMemo(
    () => (detail.data ? mergeSeriesDetail(detail.data, tmdbOn ? tmdb.data : undefined, i18n.language) : undefined),
    [detail.data, tmdb.data, tmdbOn, i18n.language],
  );
  const similarFallback = useTmdbSimilar('tv', model?.tmdbId, tmdbOn && !!model && model.similar.length === 0 && !tmdb.isPending);
  const similar = model && model.similar.length > 0 ? model.similar : (similarFallback.data ?? []);

  // Panels often name episodes "Show - S01E02 - Title"; the list already shows the code, so keep only the title.
  const seasons = useMemo(() => {
    const show = detail.data?.item.title;
    return sortSeasons(detail.data?.seasons ?? []).map((s) => ({
      ...s,
      episodes: s.episodes.map((e) => ({ ...e, title: cleanEpisodeTitle(e.title, show, e.season, e.episode) || e.title })),
    }));
  }, [detail.data?.seasons, detail.data?.item.title]);
  const order = useMemo(() => episodeOrder(seasons), [seasons]);
  const positionsQ = useRpcQuery('positions.forSeries', { ref }, { staleTime: 5_000 });
  const positionList = useMemo(() => positionsQ.data ?? [], [positionsQ.data]);
  const positions = useMemo(() => new Map(positionList.filter((p) => p.episodeId).map((p) => [p.episodeId!, p])), [positionList]);
  const setWatched = useSetWatched();
  const { toast } = useToast();
  const allEpisodeIds = useMemo(() => order.map((e) => e.id), [order]);
  const toggleEpisodeWatched = async (ep: Episode) => {
    const next = !isWatched(positions.get(ep.id));
    // L1-vod-1: the last unwatched episode also marks the series; unmarking one clears it.
    const write = seriesWatchedWrite(allEpisodeIds, positionList, { episodeIds: [ep.id], watched: next });
    const targets = seriesWatchedTargets(ref, write);
    // The rows about to change, so Undo can put them back; without them the toast has no Undo.
    const before = await Promise.all(targets.map((x) => captureWatched(x))).catch(() => undefined);
    const name = episodeCode(ep.season, ep.episode);
    setWatched.mutate(
      { ref, episodeIds: write.episodeIds, series: write.series, watched: next },
      {
        onSuccess: () =>
          toast({
            // One toast per series: marking episode after episode replaces it (L1-vod-14).
            id: watchedToastId(ref),
            title: t(next ? 'namedMarkedWatched' : 'namedMarkedUnwatched', { name }),
            variant: 'success',
            ...(before
              ? {
                  action: watchedUndoAll(targets, before, {
                    label: t('undo', { ns: 'library' }),
                    onFailed: () => toast({ title: t('undoFailed', { ns: 'library' }), variant: 'error' }),
                  }),
                }
              : {}),
          }),
        onError: (err) => toast({ title: t('watchedFailed'), description: errorDescription(err), variant: 'error' }),
      },
    );
  };
  const start = resumeTarget(order, positionList);

  const watch = useWatchState(ref);
  const seasonKey = `${sourceId}|${itemId}`;
  // L1-vod-11: a season you picked is kept for Back and Forward (back from an actor or a similar
  // title). A fresh visit opens on the season Play/Resume points at, so the two never disagree.
  const navigationType = useNavigationType();
  const recalled = () => (navigationType === 'POP' ? recallSeason(seasonKey) : undefined);
  const [season, setSeasonState] = useState<number | undefined>(recalled);
  const setSeason = (n: number) => {
    rememberSeason(seasonKey, n);
    setSeasonState(n);
  };
  // Another series in the same page instance (similar titles): start from its own pick.
  useEffect(() => setSeasonState(recalled()), [seasonKey]);
  const playingSeason = order.find((e) => e.id === watch.episodeId)?.season;
  // A remembered pick that the provider no longer lists falls back to the default choice.
  const pickedSeason = season !== undefined && seasons.some((x) => x.number === season) ? season : undefined;
  const selectedSeason = pickedSeason ?? playingSeason ?? start?.episode.season ?? seasons[0]?.number;
  // Follow the playing episode into its season (autoplay crossing a season boundary).
  useEffect(() => {
    const s = order.find((e) => e.id === watch.episodeId)?.season;
    if (s !== undefined) setSeasonState(s);
  }, [watch.episodeId, order]);

  const seasonObj = seasons.find((s) => s.number === selectedSeason);
  const tmdbSeason = useRpcQuery(
    'tmdb.season',
    { tmdbId: model?.tmdbId ?? 0, season: selectedSeason ?? 0 },
    { enabled: tmdbOn && !!model?.tmdbId && selectedSeason !== undefined && selectedSeason > 0, staleTime: Infinity },
  );
  const episodes = useMemo(
    () => (seasonObj ? mergeSeasonEpisodes(seasonObj, tmdbOn ? tmdbSeason.data : undefined) : []),
    [seasonObj, tmdbSeason.data, tmdbOn],
  );

  const isFavorite = useIsFavorite(ref);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const target = useMemo<PlayTarget | undefined>(
    () =>
      item && source.data
        ? { ref, sourceKind: source.data.kind, title: model?.titleBase ?? model?.title ?? item.title, posterUrl: model?.posterUrl, categoryId: item.categoryId }
        : undefined,
    [item, source.data, ref, model?.titleBase, model?.title, model?.posterUrl],
  );
  const playback = usePlayback(target);
  const downloads = useItemDownloads(ref, playback.canDownload);
  useEscapeToClose(watch.active, playback.stop);
  useDetailEscapeBack(!watch.active, `/s/${encodeURIComponent(sourceId)}/series`);
  // Back from an actor or a similar title: the page opens where you left it.
  const { pathname } = useLocation();
  useScrollMemory({ key: pathname, getScroller: () => scrollRef.current, ready: !!model && !!item });
  // L2-vod-9: opened from a grid or a rail, focus lands on Play (or Resume), or on the title when nothing plays.
  const playRef = useRef<HTMLButtonElement>(null);
  useFocusOnOpen(
    gate.state === 'open' && !!model && !!item && !watch.active,
    () => playRef.current ?? scrollRef.current?.querySelector<HTMLElement>('#vod-detail-title'),
  );

  // Until the title is known (or while it is locked), the page (sr-only h1) and the shell header both read the section name.
  const pageTitle = (gate.state === 'open' ? (model?.titleBase ?? model?.title) : undefined) ?? t('series');
  const lockItems = useLockMenuItems(model ? { sourceId, contentType: 'series', kind: 'item', targetId: itemId, name: model.titleBase ?? model.title } : null, {
    categoryId: item?.categoryId,
  });
  usePageHeader({ title: pageTitle, subtitle: source.data?.name }, [pageTitle, source.data?.name]);

  // Playing an episode hands the player the rest of the season (and the next one), so it auto-advances anywhere.
  const playEpisode = (ep: Episode, fromStart = false) => {
    const opts = { episodeId: ep.id, subtitle: episodeSubtitle(ep.season, ep.episode, ep.title), fromStart };
    void playback.play(opts).then(() => {
      if (!target) return;
      const ctx: Parameters<typeof startEpisodeQueue>[0] = { ref, sourceKind: target.sourceKind, title: target.title, order, positions };
      if (target.posterUrl) ctx.posterUrl = target.posterUrl;
      return startEpisodeQueue(ctx, ep.id);
    });
  };
  const downloadEpisode = (ep: Episode) =>
    void playback.download({ episodeId: ep.id, subtitle: episodeSubtitle(ep.season, ep.episode, ep.title), extension: ep.containerExtension });

  const next = nextEpisode(seasons, watch.episodeId);
  const previous = previousEpisode(seasons, watch.episodeId);
  const [dismissedFor, setDismissedFor] = useState<string | undefined>(undefined);
  // When the player's queue already holds the next episode, the player shows its own Up next card.
  const queuedNext = usePlayerStore((s) => !!next && (s.queue ?? []).some((q) => q.episodeId === next.id && sameRef(q.ref, ref)));
  const showNextCard = watch.ended && !!next && !queuedNext && dismissedFor !== watch.episodeId;
  const playing = order.find((e) => e.id === watch.episodeId);

  if (twin.data) {
    return <Navigate replace to={detailHref(twin.data) ?? '/'} />;
  }
  if (gate.state !== 'open') {
    return (
      <div className="h-full overflow-y-auto" data-testid="vod-series-detail">
        <h1 className="sr-only">{pageTitle}</h1>
        {gate.state === 'checking' ? (
          <DetailHeroSkeleton />
        ) : (
          <ParentalLocked
            itemRef={ref}
            categoryId={stalkerSource ? item?.categoryId : undefined}
            title={model?.titleBase ?? model?.title}
            failed={gate.state === 'failed'}
            onRetry={gate.retry}
            fallbackHref={`/s/${encodeURIComponent(sourceId)}/series`}
          />
        )}
      </div>
    );
  }
  if (source.isError && isSourceMissing(source.error)) {
    return (
      <div className="h-full overflow-y-auto">
        <h1 className="sr-only">{pageTitle}</h1>
        <SourceMissing />
      </div>
    );
  }
  if (source.isError || (detail.isError && !(probeTwin && twin.isPending))) {
    return (
      <div className="h-full overflow-y-auto">
        <h1 className="sr-only">{pageTitle}</h1>
        <ErrorState
          error={source.error ?? detail.error}
          onRetry={() => {
            void source.refetch();
            void detail.refetch();
          }}
        />
      </div>
    );
  }
  if (!model || !item) {
    return (
      <div className="h-full overflow-y-auto" data-testid="vod-series-detail">
        <h1 className="sr-only">{pageTitle}</h1>
        <DetailHeroSkeleton />
      </div>
    );
  }

  const trailer = youtubeKey(model.trailerKey ?? model.trailerUrl);
  const seasonEpisodeIds = episodes.map((e) => e.id);
  const seasonWatched = episodes.length > 0 && episodes.every((e) => isWatched(positions.get(e.id)));
  // Watched as a whole: the item-level row (no episode id), as `positions.watchedContains` reads it.
  // The marks below keep it and the episode rows in step (lib/seriesWatched, L1-vod-1).
  const seriesWatched = positionList.some((p) => !p.episodeId && p.watched === true);
  const seriesWrite = seriesWatchedWrite(allEpisodeIds, positionList, { watched: !seriesWatched });
  const seasonWrite = seriesWatchedWrite(allEpisodeIds, positionList, { episodeIds: seasonEpisodeIds, watched: !seasonWatched });
  const seasonName = selectedSeason !== undefined && selectedSeason <= 0 ? t('specials') : t('seasonNumber', { number: selectedSeason });
  // Queues the season's episodes that have no download yet (or only a failed, cancelled or missing one).
  const downloadSeason = () => {
    const todo = episodes.filter((ep) => {
      const d = downloads.get(ep.id);
      return !d || d.status === 'failed' || d.status === 'canceled' || (d.status === 'completed' && d.fileAvailable === false);
    });
    void playback.downloadSeason(
      todo.map((ep) => ({ episodeId: ep.id, subtitle: episodeSubtitle(ep.season, ep.episode, ep.title), extension: ep.containerExtension })),
      seasonName,
    );
  };
  // L1-visual-6: favorites, My List and the player keep the base title; the year is the subtitle only
  // (My List saves what a poster card saves, myListTarget).
  const snapshot = {
    title: model.titleBase ?? model.title,
    posterUrl: model.posterUrl,
    contentType: 'series' as const,
    ...(model.year ? { subtitle: String(model.year) } : {}),
  };
  const listSnapshot = snapshot;
  const favorite = (
    <>
      <MyListButton itemRef={ref} snapshot={listSnapshot} size={watch.active ? 'sm' : 'lg'} />
      <FavoriteButton itemRef={ref} snapshot={snapshot} isFavorite={isFavorite} compact={watch.active} />
      {/* C4: the series as a whole, which ticks its poster; marking it marks every episode too. */}
      <WatchedButton
        itemRef={ref}
        episodeIds={seriesWrite.episodeIds}
        series={seriesWrite.series}
        name={model.titleBase ?? model.title}
        watched={seriesWatched}
        compact={watch.active}
        labels={{ mark: t('markSeriesWatched'), unmark: t('markSeriesUnwatched') }}
      />
      {/* C2: lock or remove the lock (only while parental controls are on). */}
      {lockItems.map((a) => (
        <Button key={a.id} size={watch.active ? 'sm' : 'lg'} variant="ghost" icon={a.icon ?? <Lock aria-hidden size={18} />} disabled={a.disabled} onClick={a.onSelect}>
          {a.label}
        </Button>
      ))}
    </>
  );

  return (
    <div ref={scrollRef} className="isolate h-full overflow-y-auto pb-12" data-testid="vod-series-detail">
      {watch.active ? (
        <WatchStage
          title={model.titleBase ?? model.title}
          subtitle={playing ? episodeSubtitle(playing.season, playing.episode, playing.title) : source.data?.name}
          onClose={playback.stop}
          aside={
            settings.playerUpNextRail ? (
              <UpNextRail episodes={upcoming(order, watch.episodeId)} positions={positions} onPlay={playEpisode} />
            ) : undefined
          }
        />
      ) : (
        <DetailHero
          model={model}
          sourceId={sourceId}
          chips={model.status ? <span>{model.status}</span> : undefined}
          notice={detail.data?.providerDetailsUnavailable ? t('providerDetailsUnavailable') : undefined}
          actions={
            <>
              {start && (
                <Button
                  ref={playRef}
                  size="lg"
                  variant="primary"
                  icon={<Play aria-hidden size={18} className="fill-current" />}
                  aria-describedby="vod-detail-title"
                  onClick={() => playEpisode(start.episode)}
                >
                  {t(start.resume ? 'resumeEpisode' : 'playEpisode', { code: episodeCode(start.episode.season, start.episode.episode) })}
                </Button>
              )}
              {start?.resume && (
                <Button size="lg" variant="ghost" icon={<RotateCcw aria-hidden size={18} />} onClick={() => playEpisode(start.episode, true)}>
                  {t('startOverEpisode', { code: episodeCode(start.episode.season, start.episode.episode) })}
                </Button>
              )}
              {trailer && (
                <Button size="lg" variant="secondary" icon={<MonitorPlay aria-hidden size={18} />} onClick={() => setTrailerOpen(true)}>
                  {t('trailer')}
                </Button>
              )}
              {favorite}
            </>
          }
        />
      )}

      <div className="mx-auto mt-6 flex w-full max-w-[1800px] flex-col gap-8 px-4 md:px-8">
        {watch.active && showNextCard && next && (
          <NextEpisodeCard
            key={watch.episodeId}
            next={next}
            autoplay={settings.playerAutoplayNextEpisode}
            onPlay={() => playEpisode(next)}
            onDismiss={() => setDismissedFor(watch.episodeId)}
          />
        )}
        {watch.active && (
          <div className="flex flex-wrap items-center gap-2">
            {previous && (
              <Button
                variant="secondary"
                icon={<SkipBack aria-hidden size={18} />}
                title={`${episodeCode(previous.season, previous.episode)} (Shift+P)`}
                aria-keyshortcuts="Shift+P"
                onClick={() => playEpisode(previous)}
              >
                {t('previousEpisode')}
              </Button>
            )}
            {favorite}
          </div>
        )}

        <section aria-labelledby="vod-episodes-heading" className="relative flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="vod-episodes-heading" className="text-lg text-fg">
              {t('episodes')}
            </h2>
            {episodes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {playback.canDownload &&
                  (watch.active ? (
                    <IconButton
                      label={t('downloadSeason')}
                      icon={<Download aria-hidden size={18} />}
                      disabled={playback.pendingSeason}
                      onClick={downloadSeason}
                      data-testid="vod-download-season"
                    />
                  ) : (
                    <Button
                      size="lg"
                      variant="ghost"
                      icon={<Download aria-hidden size={18} />}
                      loading={playback.pendingSeason}
                      onClick={downloadSeason}
                      data-testid="vod-download-season"
                    >
                      {t('downloadSeason')}
                    </Button>
                  ))}
                <WatchedButton
                  key={selectedSeason}
                  itemRef={ref}
                  episodeIds={seasonWrite.episodeIds}
                  series={seasonWrite.series}
                  name={seasonName}
                  watched={seasonWatched}
                  compact={watch.active}
                  labels={{ mark: t('markSeasonWatched'), unmark: t('markSeasonUnwatched') }}
                />
              </div>
            )}
          </div>
          {seasons.length === 0 ? (
            <EmptyState
              size="inline"
              icon={<ListVideo size={20} />}
              title={t('noEpisodesTitle')}
              description={t('noEpisodesHintProvider')}
            />
          ) : (
            <>
              {seasons.length > 1 && selectedSeason !== undefined && <SeasonTabs seasons={seasons} value={selectedSeason} onChange={setSeason} />}
              <EpisodeList
                episodes={episodes}
                positions={positions}
                downloads={downloads}
                playingEpisodeId={watch.current ? watch.episodeId : undefined}
                onPlay={playEpisode}
                canDownload={playback.canDownload}
                pendingDownload={playback.pendingDownload}
                onDownload={downloadEpisode}
                onToggleWatched={(ep) => void toggleEpisodeWatched(ep)}
                scrollRef={scrollRef}
                layoutKey={`${selectedSeason}|${watch.active}|${showNextCard}`}
              />
            </>
          )}
        </section>

        {tmdbOn && (
          <SimilarSection
            items={similar}
            loading={tmdb.isPending || similarFallback.isFetching}
            sourceId={sourceId}
            error={tmdb.isError || similarFallback.isError ? (tmdb.error ?? similarFallback.error) : undefined}
            onRetry={() => {
              void tmdb.refetch();
              void similarFallback.refetch();
            }}
            keyMissing={keyMissing}
            enriched={model.enriched}
          />
        )}
      </div>

      {trailer && <TrailerDialog open={trailerOpen} onClose={() => setTrailerOpen(false)} youtubeKey={trailer} title={model.titleBase ?? model.title} />}
    </div>
  );
}
