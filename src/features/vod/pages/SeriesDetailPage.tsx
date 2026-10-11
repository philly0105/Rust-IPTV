import { Clapperboard, ListVideo, Play, MonitorPlay } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Episode, ItemRef } from '@/api/types';

import { FavoriteButton } from '../components/detail/actions';
import { DetailHero, DetailHeroSkeleton } from '../components/detail/DetailHero';
import { EpisodeList, SeasonTabs } from '../components/detail/EpisodeList';
import { TrailerDialog } from '../components/detail/TrailerDialog';
import { NextEpisodeCard, UpNextRail, upcoming } from '../components/detail/UpNext';
import { WatchStage } from '../components/detail/WatchStage';
import { TmdbAttribution } from '../components/TmdbAttribution';
import { TmdbRail } from '../components/TmdbRail';
import { useIsFavorite, useSeriesDetail, useSettings, useSource, useTmdbSimilar, useTmdbTv } from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { useItemDownloads, usePlayback, type PlayTarget } from '../hooks/usePlayback';
import { useEscapeToClose, useWatchState } from '../hooks/useWatchState';
import { cleanEpisodeTitle, episodeCode, episodeSubtitle } from '../lib/format';
import { episodeOrder, mergeSeasonEpisodes, mergeSeriesDetail, nextEpisode, resumeTarget, sortSeasons, youtubeKey } from '../lib/merge';
import { Button, EmptyState, ErrorState } from '../_shim';

export function SeriesDetailPage() {
  const { t } = useTranslation('vod');
  const { sourceId = '', itemId = '' } = useParams();
  const ref = useMemo<ItemRef>(() => ({ sourceId, contentType: 'series', itemId }), [sourceId, itemId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const tmdbOn = settings.tmdb.enabled;
  const source = useSource(sourceId);
  const detail = useSeriesDetail(source.data, ref);
  const item = detail.data?.item;
  const tmdb = useTmdbTv(item, tmdbOn);
  const model = useMemo(() => (detail.data ? mergeSeriesDetail(detail.data, tmdb.data) : undefined), [detail.data, tmdb.data]);
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
  const start = resumeTarget(order, positionList);

  const watch = useWatchState(ref);
  const [season, setSeason] = useState<number | undefined>(undefined);
  const playingSeason = order.find((e) => e.id === watch.episodeId)?.season;
  const selectedSeason = season ?? playingSeason ?? start?.episode.season ?? seasons[0]?.number;
  // Follow the playing episode into its season (autoplay crossing a season boundary).
  useEffect(() => {
    const s = order.find((e) => e.id === watch.episodeId)?.season;
    if (s !== undefined) setSeason(s);
  }, [watch.episodeId, order]);

  const seasonObj = seasons.find((s) => s.number === selectedSeason);
  const tmdbSeason = useRpcQuery(
    'tmdb.season',
    { tmdbId: model?.tmdbId ?? 0, season: selectedSeason ?? 0 },
    { enabled: tmdbOn && !!model?.tmdbId && selectedSeason !== undefined && selectedSeason > 0, staleTime: Infinity },
  );
  const episodes = useMemo(() => (seasonObj ? mergeSeasonEpisodes(seasonObj, tmdbSeason.data) : []), [seasonObj, tmdbSeason.data]);

  const isFavorite = useIsFavorite(ref);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const target = useMemo<PlayTarget | undefined>(
    () => (item && source.data ? { ref, sourceKind: source.data.kind, title: model?.title ?? item.title, posterUrl: model?.posterUrl } : undefined),
    [item, source.data, ref, model?.title, model?.posterUrl],
  );
  const playback = usePlayback(target);
  const downloads = useItemDownloads(ref, playback.canDownload);
  useEscapeToClose(watch.active, playback.stop);

  // Until the title is known, the page (sr-only h1) and the shell header both read the section name.
  const pageTitle = model?.title ?? t('series');
  usePageHeader({ title: pageTitle, subtitle: source.data?.name }, [pageTitle, source.data?.name]);

  const playEpisode = (ep: Episode) =>
    void playback.play({ episodeId: ep.id, subtitle: episodeSubtitle(ep.season, ep.episode, ep.title) });
  const downloadEpisode = (ep: Episode) =>
    void playback.download({ episodeId: ep.id, subtitle: episodeSubtitle(ep.season, ep.episode, ep.title), extension: ep.containerExtension });

  const next = nextEpisode(seasons, watch.episodeId);
  const [dismissedFor, setDismissedFor] = useState<string | undefined>(undefined);
  const showNextCard = watch.ended && !!next && dismissedFor !== watch.episodeId;
  const playing = order.find((e) => e.id === watch.episodeId);

  if (source.isError || detail.isError) {
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
  const favorite = (
    <FavoriteButton
      itemRef={ref}
      snapshot={{ title: model.title, posterUrl: model.posterUrl, contentType: 'series' }}
      isFavorite={isFavorite}
      compact={watch.active}
    />
  );

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto pb-12" data-testid="vod-series-detail">
      {watch.active ? (
        <WatchStage
          title={model.title}
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
          actions={
            <>
              {start && (
                <Button size="lg" variant="primary" icon={<Play aria-hidden size={18} className="fill-current" />} onClick={() => playEpisode(start.episode)}>
                  {t(start.resume ? 'resumeEpisode' : 'playEpisode', { code: episodeCode(start.episode.season, start.episode.episode) })}
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
        {watch.active && <div className="flex flex-wrap items-center gap-2">{favorite}</div>}

        <section aria-labelledby="vod-episodes-heading" className="flex flex-col gap-4">
          <h2 id="vod-episodes-heading" className="text-lg text-fg">
            {t('episodes')}
          </h2>
          {seasons.length === 0 ? (
            <EmptyState size="inline" icon={<ListVideo size={20} />} title={t('noEpisodesTitle')} description={t('noEpisodesHint')} />
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
                scrollRef={scrollRef}
                layoutKey={`${selectedSeason}|${watch.active}|${showNextCard}`}
              />
            </>
          )}
        </section>

        {tmdbOn && (
          <div className="flex flex-col gap-4">
            <TmdbRail
              title={t('similar')}
              items={similar}
              loading={tmdb.isPending || similarFallback.isFetching}
              sourceId={sourceId}
              empty={
                tmdb.isError || similarFallback.isError ? (
                  <ErrorState
                    size="inline"
                    title={t('tmdbUnavailable')}
                    error={tmdb.error ?? similarFallback.error}
                    onRetry={() => {
                      void tmdb.refetch();
                      void similarFallback.refetch();
                    }}
                  />
                ) : (
                  <EmptyState size="inline" icon={<Clapperboard size={20} />} title={t('noSimilar')} />
                )
              }
            />
            <TmdbAttribution />
          </div>
        )}
      </div>

      {trailer && <TrailerDialog open={trailerOpen} onClose={() => setTrailerOpen(false)} youtubeKey={trailer} title={model.title} />}
    </div>
  );
}
