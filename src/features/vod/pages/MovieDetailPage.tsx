import { Layers, Lock, Play, RotateCcw, MonitorPlay } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';

import { useQueryClient } from '@tanstack/react-query';

import { useRpcQuery } from '@/api/query';
import type { ItemRef, VodItem } from '@/api/types';
import { MyListButton } from '@/features/mylist/components/MyListButton';
import { useLockMenuItems } from '@/features/parental/lockMenu';

import { DownloadButton, FavoriteButton, WatchedButton } from '../components/detail/actions';
import { DetailHero, DetailHeroSkeleton } from '../components/detail/DetailHero';
import { OtherSourcesDialog } from '../components/detail/OtherSourcesDialog';
import { ParentalLocked, useOpenGate } from '../components/detail/ParentalLocked';
import { TrailerDialog } from '../components/detail/TrailerDialog';
import { WatchStage } from '../components/detail/WatchStage';
import { SimilarSection } from '../components/SimilarSection';
import {
  useIsFavorite,
  useMovieDetail,
  useSettings,
  useSource,
  useSourceMap,
  useTmdbKeyMissing,
  useTmdbMovie,
  useTmdbSimilar,
  useTwinProbe,
} from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { useItemDownloads, usePlayback, type PlayTarget } from '../hooks/usePlayback';
import { useSourcePin } from '../hooks/useSourcePin';
import { useDetailEscapeBack } from '../hooks/useBackKey';
import { useEscapeToClose, useWatchState } from '../hooks/useWatchState';
import { formatClock, isResumable, isWatched } from '../lib/format';
import { mergeMovieDetail, youtubeKey } from '../lib/merge';
import { detailHref, isCachedStalkerSeries } from '../lib/search';
import { Button, ErrorState } from '@/ui';

export function MovieDetailPage() {
  const { t } = useTranslation('vod');
  const navigate = useNavigate();
  const { sourceId = '', itemId = '' } = useParams();
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const ref = useMemo<ItemRef>(() => ({ sourceId, contentType: 'movie', itemId }), [sourceId, itemId]);
  const settings = useSettings();
  const tmdbOn = settings.tmdb.enabled;
  const source = useSource(sourceId);
  const sources = useSourceMap();
  const qc = useQueryClient();
  // A Stalker VOD-as-series row belongs on the series page (seasons and episodes come from stalker.seriesDetail).
  const seriesTwin = useMemo(() => {
    if (source.data?.kind !== 'stalker') return false;
    const cached = ['stalker.movies', 'stalker.search'].flatMap((cmd) => qc.getQueriesData({ queryKey: [cmd] }).map(([, data]) => data));
    return isCachedStalkerSeries(cached, sourceId, itemId);
  }, [qc, source.data?.kind, sourceId, itemId]);
  const detail = useMovieDetail(seriesTwin ? undefined : source.data, ref);
  // A failed lookup may be a series id on the movie route (cold link, Stalker VOD-as-series): look it up as a series.
  const probeTwin = detail.isError && detail.error.code !== 'auth' && !!source.data;
  const twin = useTwinProbe(source.data, ref, probeTwin);
  const keyMissing = useTmdbKeyMissing(settings);
  const item = detail.data?.item;
  // C2: in Ask mode a locked movie shows nothing until the PIN is entered. Stalker titles are not
  // in the local catalog, so the core learns their group only from the details: wait for them.
  const stalkerSource = source.data?.kind === 'stalker';
  const gate = useOpenGate(ref, {
    categoryId: stalkerSource ? item?.categoryId : undefined,
    waitForCategory: source.isPending || (stalkerSource && detail.isPending),
  });
  const tmdb = useTmdbMovie(item, tmdbOn);
  const model = useMemo(() => (detail.data ? mergeMovieDetail(detail.data, tmdb.data) : undefined), [detail.data, tmdb.data]);
  const similarFallback = useTmdbSimilar('movie', model?.tmdbId, tmdbOn && !!model && model.similar.length === 0 && !tmdb.isPending);
  const similar = model && model.similar.length > 0 ? model.similar : (similarFallback.data ?? []);

  const position = useRpcQuery('positions.get', { ref }, { staleTime: 5_000 });
  const watched = isWatched(position.data);
  const isFavorite = useIsFavorite(ref);
  // Stalker VOD is paged live from the portal, not stored in the local catalog, so the core's
  // same-title lookup has nothing to match (it answers not_found); no "other sources" there.
  const inLocalCatalog = !!source.data && source.data.kind !== 'stalker';
  const sameTitle = useRpcQuery('catalog.sameTitle', { ref }, { enabled: !!item && inLocalCatalog, staleTime: 5 * 60_000 });
  const others = useMemo(() => (sameTitle.data ?? []).filter((o) => o.ref.sourceId !== sourceId || o.ref.itemId !== itemId), [sameTitle.data, sourceId, itemId]);
  const { pin, setPin, pinnedOther } = useSourcePin(item, others);

  const [trailerOpen, setTrailerOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);

  const ownTarget = useMemo<PlayTarget | undefined>(
    () =>
      item && source.data
        ? { ref, sourceKind: source.data.kind, title: model?.title ?? item.title, posterUrl: model?.posterUrl, categoryId: item.categoryId }
        : undefined,
    [item, source.data, ref, model?.title, model?.posterUrl],
  );
  const targetFor = (copy: VodItem): PlayTarget | undefined => {
    const kind = sources.get(copy.ref.sourceId)?.kind;
    return kind ? { ref: copy.ref, sourceKind: kind, title: model?.title ?? copy.title, posterUrl: model?.posterUrl ?? copy.posterUrl } : undefined;
  };
  const pinnedTarget = pinnedOther ? targetFor(pinnedOther) : undefined;
  const playback = usePlayback(ownTarget);
  const downloads = useItemDownloads(ref, playback.canDownload);

  const ownWatch = useWatchState(ref);
  const pinnedWatch = useWatchState(pinnedOther?.ref ?? ref);
  const watching = ownWatch.active || (!!pinnedOther && pinnedWatch.active);
  useEscapeToClose(watching, playback.stop);
  useDetailEscapeBack(!watching, `/s/${encodeURIComponent(sourceId)}/movies`);
  // Back from an actor or a similar title: the page opens where you left it.
  const { pathname } = useLocation();
  useScrollMemory({ key: pathname, getScroller: () => detailScrollRef.current, ready: !!model && !!item });

  // Until the title is known (or while it is locked), the page (sr-only h1) and the shell header both read the section name.
  const pageTitle = (gate.state === 'open' ? model?.title : undefined) ?? t('movies');
  const lockItems = useLockMenuItems(model ? { sourceId, contentType: 'movie', kind: 'item', targetId: itemId, name: model.title } : null);
  usePageHeader({ title: pageTitle, subtitle: source.data?.name }, [pageTitle, source.data?.name]);

  const resumable = isResumable(position.data);
  const play = (fromStart = false) => void playback.play(pinnedTarget ? { target: pinnedTarget, fromStart } : { fromStart });
  const playCopy = (copy: VodItem) => {
    setOthersOpen(false);
    const tgt = targetFor(copy);
    if (!tgt) return;
    void playback.play({ target: tgt });
    const href = detailHref(copy.ref);
    if (href && (copy.ref.sourceId !== sourceId || copy.ref.itemId !== itemId)) navigate(href);
  };

  if (seriesTwin) {
    return <Navigate replace to={detailHref({ sourceId, contentType: 'series', itemId }) ?? '/'} />;
  }
  if (twin.data) {
    return <Navigate replace to={detailHref(twin.data) ?? '/'} />;
  }
  if (gate.state !== 'open') {
    return (
      <div className="h-full overflow-y-auto" data-testid="vod-movie-detail">
        <h1 className="sr-only">{pageTitle}</h1>
        {gate.state === 'checking' ? (
          <DetailHeroSkeleton />
        ) : (
          <ParentalLocked
            itemRef={ref}
            categoryId={stalkerSource ? item?.categoryId : undefined}
            title={model?.title}
            failed={gate.state === 'failed'}
            onRetry={gate.retry}
            fallbackHref={`/s/${encodeURIComponent(sourceId)}/movies`}
          />
        )}
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
      <div className="h-full overflow-y-auto" data-testid="vod-movie-detail">
        <h1 className="sr-only">{pageTitle}</h1>
        <DetailHeroSkeleton />
      </div>
    );
  }

  const trailer = youtubeKey(model.trailerKey ?? model.trailerUrl);
  const download = downloads.get('');
  const sourceName = source.data?.name ?? sourceId;

  const snapshot = { title: model.title, posterUrl: model.posterUrl, contentType: 'movie' as const };
  // My List saves what a poster card saves (myListTarget): the base title, with the year as the subtitle.
  const listSnapshot = { ...snapshot, title: model.titleBase ?? model.title, ...(model.year ? { subtitle: String(model.year) } : {}) };
  const secondary = (
    <>
      <MyListButton itemRef={ref} snapshot={listSnapshot} size={watching ? 'sm' : 'lg'} />
      <FavoriteButton itemRef={ref} snapshot={snapshot} isFavorite={isFavorite} compact={watching} />
      <WatchedButton itemRef={ref} watched={watched} compact={watching} />
      {playback.canDownload && (
        <DownloadButton
          download={download}
          pending={playback.pendingDownload === ''}
          compact={watching}
          onStart={() => void playback.download({ extension: item.containerExtension })}
        />
      )}
      {others.length > 0 && (
        <Button size={watching ? 'sm' : 'lg'} variant="ghost" icon={<Layers aria-hidden size={18} />} onClick={() => setOthersOpen(true)}>
          {t('otherSourcesCount', { count: others.length })}
        </Button>
      )}
      {/* C2: lock or remove the lock (only while parental controls are on). */}
      {lockItems.map((a) => (
        <Button key={a.id} size={watching ? 'sm' : 'lg'} variant="ghost" icon={a.icon ?? <Lock aria-hidden size={18} />} disabled={a.disabled} onClick={a.onSelect}>
          {a.label}
        </Button>
      ))}
    </>
  );

  return (
    <div ref={detailScrollRef} className="isolate h-full overflow-y-auto pb-12" data-testid="vod-movie-detail">
      {watching ? (
        <>
          <WatchStage title={model.title} subtitle={pinnedOther ? t('playsFrom', { source: sources.get(pinnedOther.ref.sourceId)?.name ?? '' }) : sourceName} onClose={playback.stop} />
          <section className="mx-auto mt-6 flex w-full max-w-[1800px] flex-col gap-3 px-4 md:px-8" aria-label={t('about')}>
            <div className="flex flex-wrap items-center gap-2">{secondary}</div>
            {model.plot && <p dir="auto" className="max-w-[72ch] text-[calc(15rem/15)] leading-relaxed text-fg-muted text-match-parent">{model.plot}</p>}
          </section>
        </>
      ) : (
        <DetailHero
          model={model}
          sourceId={sourceId}
          note={pinnedOther ? t('playsFrom', { source: sources.get(pinnedOther.ref.sourceId)?.name ?? '' }) : undefined}
          notice={detail.data?.providerDetailsUnavailable ? t('providerDetailsUnavailable') : undefined}
          actions={
            <>
              <Button size="lg" variant="primary" icon={<Play aria-hidden size={18} className="fill-current" />} onClick={() => play(false)}>
                {resumable && position.data && !pinnedTarget
                  ? t('resumeAt', { time: formatClock(position.data.positionSeconds) })
                  : t('play')}
              </Button>
              {resumable && !pinnedTarget && (
                <Button size="lg" variant="ghost" icon={<RotateCcw aria-hidden size={18} />} onClick={() => play(true)}>
                  {t('startOver')}
                </Button>
              )}
              {trailer && (
                <Button size="lg" variant="secondary" icon={<MonitorPlay aria-hidden size={18} />} onClick={() => setTrailerOpen(true)}>
                  {t('trailer')}
                </Button>
              )}
              {secondary}
            </>
          }
        />
      )}

      <div className="mx-auto mt-8 flex w-full max-w-[1800px] flex-col gap-8 px-4 md:px-8">
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

      {trailer && <TrailerDialog open={trailerOpen} onClose={() => setTrailerOpen(false)} youtubeKey={trailer} title={model.title} />}
      {others.length > 0 && (
        <OtherSourcesDialog
          open={othersOpen}
          onClose={() => setOthersOpen(false)}
          current={item}
          currentSourceName={sourceName}
          others={others}
          sources={sources}
          pin={pin}
          onPin={setPin}
          onPlay={playCopy}
        />
      )}
    </div>
  );
}
