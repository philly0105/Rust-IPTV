import { Layers, Play, RotateCcw, MonitorPlay } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';

import { useQueryClient } from '@tanstack/react-query';

import { categoriesArgs } from '@/api/bootPrefetch';
import { useRpcQuery } from '@/api/query';
import type { ItemRef, VodItem } from '@/api/types';
import { resumePoint } from '@/features/library/lib/myvideos';
import { playDownload } from '@/features/library/lib/playDownload';
import { MyListButton } from '@/features/mylist/components/MyListButton';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { intlLocale } from '@/lib/intl';

import { CatalogRail, useCategoryRail } from '../components/CatalogRail';
import { AboutSection } from '../components/detail/AboutSection';
import { DownloadButton, FavoriteButton, WatchedButton } from '../components/detail/actions';
import { TmdbPromo } from '../components/detail/TmdbPromo';
import { DetailHero, DetailHeroSkeleton, HERO_MENU_TRIGGER, HeroActionGroup, HeroIcon, HeroIconGroup } from '../components/detail/DetailHero';
import { OtherSourcesDialog, OtherSourcesList } from '../components/detail/OtherSourcesDialog';
import { ParentalLocked, useOpenGate } from '../components/detail/ParentalLocked';
import { TrailerDialog } from '../components/detail/TrailerDialog';
import { useFocusOnOpen } from '../components/detail/useFocusOnOpen';
import { WatchStage } from '../components/detail/WatchStage';
import { SimilarSection } from '../components/SimilarSection';
import { SourceMissing, isSourceMissing } from '../components/SourceMissing';
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
import { useFormatRuntime } from '../hooks/useFormatRuntime';
import { usePageHeader } from '../hooks/usePageHeader';
import { useShowSourceName } from '../hooks/useShowSourceName';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { useItemDownloads, usePlayback, type PlayTarget } from '../hooks/usePlayback';
import { useSourcePin } from '../hooks/useSourcePin';
import { useDetailEscapeBack, useGoBack } from '../hooks/useBackKey';
import { useEscapeToClose, useWatchState } from '../hooks/useWatchState';
import { formatClock, isResumable, isWatched, offlineResumeSeconds } from '../lib/format';
import { itemLanguage, languageName } from '../lib/language';
import { mergeMovieDetail, youtubeKey } from '../lib/merge';
import { detailHref, isCachedStalkerSeries } from '../lib/search';
import { Badge, Button, ErrorState, Menu, Page, SectionHeader, Skeleton, errorDescription, useToast, type MenuItem } from '@/ui';

export function MovieDetailPage() {
  const { t, i18n } = useTranslation('vod');
  const { toast } = useToast();
  const formatRuntime = useFormatRuntime();
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
  // An Xtream title opened from a list shows that list's catalog row until the provider answers
  // (VOD-DETAIL-PLACEHOLDER): the hero and Play at once, the rest of the details after.
  const placeholder = detail.isPlaceholderData;
  // C2: in Ask mode a locked movie shows nothing until the PIN is entered. Stalker titles are not
  // in the local catalog, so the core learns their group only from the details: wait for them.
  const stalkerSource = source.data?.kind === 'stalker';
  const gate = useOpenGate(ref, {
    categoryId: stalkerSource ? item?.categoryId : undefined,
    waitForCategory: source.isPending || (stalkerSource && detail.isPending),
  });
  // After the provider's answer, which may bring the tmdbId: a lookup from the row would be a second one.
  const tmdb = useTmdbMovie(placeholder ? undefined : item, tmdbOn);
  // A disabled query still returns what it cached while TMDB was on: merge it only while TMDB is on.
  const model = useMemo(
    () => (detail.data ? mergeMovieDetail(detail.data, tmdbOn ? tmdb.data : undefined) : undefined),
    [detail.data, tmdb.data, tmdbOn],
  );
  const similarFallback = useTmdbSimilar('movie', model?.tmdbId, tmdbOn && !!model && !placeholder && model.similar.length === 0 && !tmdb.isPending);
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
        ? { ref, sourceKind: source.data.kind, title: model?.titleBase ?? model?.title ?? item.title, posterUrl: model?.posterUrl, categoryId: item.categoryId }
        : undefined,
    [item, source.data, ref, model?.titleBase, model?.title, model?.posterUrl],
  );
  const targetFor = (copy: VodItem): PlayTarget | undefined => {
    const kind = sources.get(copy.ref.sourceId)?.kind;
    return kind ? { ref: copy.ref, sourceKind: kind, title: model?.titleBase ?? model?.title ?? copy.title, posterUrl: model?.posterUrl ?? copy.posterUrl } : undefined;
  };
  const pinnedTarget = pinnedOther ? targetFor(pinnedOther) : undefined;
  const playback = usePlayback(ownTarget);
  const downloads = useItemDownloads(ref, playback.canDownload);

  const ownWatch = useWatchState(ref);
  const pinnedWatch = useWatchState(pinnedOther?.ref ?? ref);
  const watching = ownWatch.active || (!!pinnedOther && pinnedWatch.active);
  useEscapeToClose(watching, playback.stop);
  const moviesHref = `/s/${encodeURIComponent(sourceId)}/movies`;
  useDetailEscapeBack(!watching, moviesHref);
  // The header's Back does what Escape does: back where you came from, or to the movies landing.
  const goBack = useGoBack(moviesHref);
  // Back from an actor or a similar title: the page opens where you left it.
  const { pathname } = useLocation();
  useScrollMemory({ key: pathname, getScroller: () => detailScrollRef.current, ready: !!model && !!item && !placeholder });
  // L2-vod-9: opened from a grid or a rail, focus lands on Play (or Resume).
  const playRef = useRef<HTMLButtonElement>(null);
  useFocusOnOpen(gate.state === 'open' && !!model && !!item && !watching, () => playRef.current);

  // Until the title is known (or while it is locked), the page (sr-only h1) and the shell header both read the section name.
  const pageTitle = (gate.state === 'open' ? (model?.titleBase ?? model?.title) : undefined) ?? t('movies');
  const lockItems = useLockMenuItems(model ? { sourceId, contentType: 'movie', kind: 'item', targetId: itemId, name: model.titleBase ?? model.title } : null, {
    categoryId: item?.categoryId,
  });
  // The header title is also the window and tab title (and the history entry), so while browsing
  // it is the title's own name. On screen the header leads with Back and names the section while
  // the hero shows the title large; the title fades into the header once the hero's h1 scrolls
  // away (section). Watching, the stage's own bar names the title and the source right under the
  // header, so the header names the section and the window keeps the title (documentTitle).
  // The source is named only when there are others (useShowSourceName); the About facts always name it.
  const showSource = useShowSourceName();
  const headerSource = showSource ? source.data?.name : undefined;
  const header = watching
    ? { title: t('movies'), documentTitle: pageTitle }
    : { title: pageTitle, subtitle: headerSource, section: t('movies'), back: { onClick: goBack } };
  usePageHeader(header, [watching, pageTitle, headerSource, t]);
  const categories = useRpcQuery('catalog.categories', categoriesArgs(sourceId, 'movie'), { enabled: !!sourceId && !!item, staleTime: 5 * 60_000 });
  // Stable across the page's renders, so later answers do not re-render the rail's cards (F4-6).
  const moreRail = useCategoryRail(source.data?.kind, 'movie', sourceId, item?.categoryId, settings);
  // L1-visual-6: favorites, My List and the player keep the base title; the year is the subtitle only
  // (My List saves what a poster card saves, myListTarget).
  const snapshot = {
    title: model?.titleBase ?? model?.title ?? '',
    posterUrl: model?.posterUrl,
    contentType: 'movie' as const,
    ...(model?.year ? { subtitle: String(model.year) } : {}),
  };

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
            title={model?.titleBase ?? model?.title}
            failed={gate.state === 'failed'}
            onRetry={gate.retry}
            fallbackHref={`/s/${encodeURIComponent(sourceId)}/movies`}
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
      <div className="h-full overflow-y-auto" data-testid="vod-movie-detail">
        <h1 className="sr-only">{pageTitle}</h1>
        <DetailHeroSkeleton />
      </div>
    );
  }

  const trailer = youtubeKey(model.trailerKey ?? model.trailerUrl);
  const download = downloads.get('');
  const sourceName = source.data?.name ?? sourceId;
  const listSnapshot = snapshot;
  // VL-offline-play: a finished download whose file is on disk plays from the file, so Play works
  // offline and past a provider's connection limit. It resumes where the title's saved position
  // says (what the label and the bar show; streaming never moves the download's own spot), and
  // from the download's own spot only when the title has no saved row.
  const offline = download?.status === 'completed' && download.fileAvailable !== false ? download : undefined;
  const offlineResume = offline ? offlineResumeSeconds(position.data, resumePoint(offline, item.durationSeconds)) : undefined;
  const myVideoHref = offline ? `/my-videos/${offline.id}` : '/my-videos';
  const playOffline = (fromStart = false) => {
    if (!offline) return;
    playDownload(offline, fromStart ? { fromStart: true } : { resumeSeconds: offlineResume ?? 0 }).catch((err: unknown) =>
      toast({ title: t('playFailed'), description: errorDescription(err), variant: 'error' }),
    );
  };
  // Where Play resumes, if it does: the file's start point offline, else the stream's saved spot
  // (not for a copy pinned from another source, which has a position of its own).
  const resumeAt = offline ? offlineResume : resumable && position.data && !pinnedTarget ? position.data.positionSeconds : undefined;
  const duration = position.data?.durationSeconds ?? item.durationSeconds;
  const progress =
    resumeAt !== undefined && duration
      ? {
          fraction: Math.min(1, resumeAt / duration),
          label: t('minutesLeft', { count: Math.max(1, Math.round((duration - resumeAt) / 60)) }),
        }
      : undefined;

  // VL-hero-actions: what is not Play, Trailer or one of the round icon buttons waits in More.
  const moreItems: MenuItem[] = [
    // Offline as well: the file from its beginning.
    ...(resumeAt !== undefined
      ? [{ id: 'start-over', label: t('startOver'), icon: <RotateCcw aria-hidden size={16} />, onSelect: () => (offline ? playOffline(true) : play(true)) }]
      : []),
    // Offline, the stream is still one choice away (a newer copy, a file that will not play).
    ...(offline ? [{ id: 'stream', label: t('streamInstead'), icon: <Play aria-hidden size={16} />, onSelect: () => play(false) }] : []),
    ...(others.length > 0
      ? [{ id: 'other-sources', label: t('otherSourcesCount', { count: others.length }), icon: <Layers aria-hidden size={16} />, onSelect: () => setOthersOpen(true) }]
      : []),
    ...(lockItems.length > 0 ? [{ id: 'sep-lock', type: 'separator' as const }, ...lockItems] : []),
  ];

  // The round icon buttons: in the hero beside Play, and under the player in watch state, so the
  // two states share one set and one look.
  const iconActions = (
    <>
      <HeroIcon caption={t('captionMyList')}>
        <MyListButton itemRef={ref} snapshot={listSnapshot} variant="round" size="lg" />
      </HeroIcon>
      <HeroIcon caption={t('captionFavorite')}>
        <FavoriteButton itemRef={ref} snapshot={snapshot} isFavorite={isFavorite} round />
      </HeroIcon>
      <HeroIcon caption={t('watched')}>
        <WatchedButton itemRef={ref} watched={watched} round />
      </HeroIcon>
      {playback.canDownload && (
        <DownloadButton
          download={download}
          pending={playback.pendingDownload === ''}
          round
          downloadedHref={myVideoHref}
          onStart={() => void playback.download({ extension: item.containerExtension })}
        />
      )}
      {moreItems.length > 0 && (
        <HeroIcon caption={t('captionMore')}>
          <Menu items={moreItems} triggerClassName={HERO_MENU_TRIGGER} />
        </HeroIcon>
      )}
    </>
  );

  const heroActions = (
    <HeroActionGroup className="max-sm:w-full">
      <Button
        ref={playRef}
        size="lg"
        variant="primary"
        icon={<Play aria-hidden size={18} className="fill-current" />}
        aria-describedby="vod-detail-title"
        onClick={() => (offline ? playOffline() : play(false))}
        className="max-sm:flex-1"
      >
        {resumeAt !== undefined ? t('resumeAt', { time: formatClock(resumeAt) }) : t('play')}
      </Button>
      {trailer ? (
        <Button size="lg" variant="secondary" icon={<MonitorPlay aria-hidden size={18} />} onClick={() => setTrailerOpen(true)}>
          {t('trailer')}
        </Button>
      ) : placeholder || (tmdbOn && tmdb.isLoading) ? (
        // VD-8: the provider's or TMDB's answer may bring a trailer; its place is held so the buttons after it do not jump.
        <span data-testid="vod-trailer-slot" className="inline-flex">
          <Skeleton className="h-12 w-32 rounded-md" />
        </span>
      ) : null}
    </HeroActionGroup>
  );

  const categoryName = item.categoryName || categories.data?.find((c) => c.id === item.categoryId)?.name;
  const fmtDate = (iso: string | undefined) => {
    if (!iso) return undefined;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : new Intl.DateTimeFormat(intlLocale(i18n.language), { dateStyle: 'medium' }).format(d);
  };
  const language = itemLanguage(item.title, item.categoryName);

  return (
    <div ref={detailScrollRef} className="isolate h-full overflow-x-hidden overflow-y-auto pb-12" data-testid="vod-movie-detail">
      {watching ? (
        <>
          <WatchStage
            title={model.titleBase ?? model.title}
            subtitle={pinnedOther ? t('playsFrom', { source: sources.get(pinnedOther.ref.sourceId)?.name ?? '' }) : headerSource}
            onClose={playback.stop}
          />
          <section className="mt-4 flex w-full max-w-[120rem] flex-col gap-4 px-(--page-gutter)" aria-label={t('about')}>
            <HeroIconGroup>{iconActions}</HeroIconGroup>
            {model.plot && <p dir="auto" className="max-w-[72ch] text-body leading-relaxed text-fg-muted text-match-parent">{model.plot}</p>}
          </section>
        </>
      ) : (
        <DetailHero
          model={model}
          sourceId={sourceId}
          castLinks={tmdbOn}
          chips={[
            item.containerExtension && (
              <Badge key="format" variant="outline" className="h-4.5 px-1 text-2xs tracking-wide uppercase">
                {item.containerExtension}
              </Badge>
            ),
            offline && (
              <Badge key="offline" variant="success" data-testid="vod-offline-chip">
                {t('downloaded')}
              </Badge>
            ),
          ]}
          note={pinnedOther ? t('playsFrom', { source: sources.get(pinnedOther.ref.sourceId)?.name ?? '' }) : undefined}
          notice={detail.data?.providerDetailsUnavailable ? t('providerDetailsUnavailable') : undefined}
          pending={placeholder}
          progress={progress}
          actions={heroActions}
          icons={iconActions}
        />
      )}

      <Page width="wide" className="flex flex-col gap-10 pt-2">
        {/* VL-detail-empty-no-tmdb: everything below comes from the provider, so it is there with TMDB off. */}
        {others.length > 0 && !watching && (
          <section aria-labelledby="vod-other-sources" className="flex flex-col gap-3" data-testid="vod-other-sources">
            <SectionHeader id="vod-other-sources" title={t('otherSourcesTitle')} count={others.length + 1} />
            <div className="rounded-lg border border-edge bg-surface px-4">
              <OtherSourcesList
                current={item}
                currentSourceName={sourceName}
                others={others}
                sources={sources}
                pin={pin}
                onPin={setPin}
                onPlay={playCopy}
              />
            </div>
          </section>
        )}
        {moreRail.input && moreRail.seeAll && (
          <CatalogRail
            title={categoryName ? t('moreInCategory', { category: categoryName }) : t('moreFromSource', { source: sourceName })}
            seeAll={moreRail.seeAll}
            input={moreRail.input}
            rootRef={detailScrollRef}
            exclude={ref}
            card={moreRail.card}
          />
        )}
        {tmdbOn && (
          <SimilarSection
            items={similar}
            loading={tmdb.isPending || similarFallback.isFetching}
            sourceId={sourceId}
            kind="movie"
            sourceKind={source.data?.kind}
            error={tmdb.isError || similarFallback.isError ? (tmdb.error ?? similarFallback.error) : undefined}
            onRetry={() => {
              void tmdb.refetch();
              void similarFallback.refetch();
            }}
            keyMissing={keyMissing}
            enriched={model.enriched}
            rootRef={detailScrollRef}
          />
        )}
        <AboutSection
          facts={[
            { label: t('detailSource'), value: sourceName },
            { label: t('detailCategory'), value: categoryName },
            { label: t('detailAdded'), value: fmtDate(item.added) },
            { label: t('detailRuntime'), value: formatRuntime(model.durationSeconds) },
            { label: t('detailFormat'), value: item.containerExtension?.toUpperCase() },
            {
              label: t('detailLanguage'),
              value: language ? languageName(language, i18n.language, (g) => t(`languageGroup_${g}`)) : undefined,
            },
            { label: t('detailGenres'), value: model.genres.length > 0 ? model.genres.join(', ') : undefined },
          ]}
        />
        {/* Last, after what the provider has: an offer, not something in the way of the title. */}
        {!tmdbOn && !watching && <TmdbPromo />}
      </Page>

      {trailer && <TrailerDialog open={trailerOpen} onClose={() => setTrailerOpen(false)} youtubeKey={trailer} title={model.titleBase ?? model.title} />}
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
