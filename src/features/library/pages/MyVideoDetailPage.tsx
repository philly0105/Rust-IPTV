/**
 * /my-videos/:id: focused offline detail. Two states: browse (artwork, facts,
 * actions, episode list) and watch (<PlayerStage /> on top, the same list
 * below to switch episodes). Stopping playback returns to browse.
 */

import { ArrowLeft, FileWarning, FolderOpen, Play, RotateCcw, SearchX, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import { RpcError, isDesktop } from '@/api/transport';
import type { Download } from '@/api/types';
import { buttonClass } from '@/ui/Button';
import { cn } from '@/ui/cn';

import { Button, EmptyState, ErrorState, PlayerStage, Poster, Skeleton, Toggle, useShortcut, useToast, usePlayerStore } from '../deps';
import { ConfirmDialog, PageTitle, SectionHeading, SourceBadge } from '../components/bits';
import { EPISODE_ROW_HEIGHT, EpisodeRow, episodeActions, episodeCode, type EpisodeAction } from '../components/EpisodeRow';
import { VirtualRows } from '../components/VirtualRows';
import { useDownloadActions } from '../hooks/useDownloadActions';
import { useMyVideos, useSourcesById } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatBytes, formatClock } from '../lib/format';
import { entryTargetId, findEntry, groupBySeason, buildLibrary, type EpisodeEntry, type LibraryEntry } from '../lib/myvideos';
import { playDownload } from '../lib/playDownload';

type EpisodeListRow = { kind: 'header'; key: string; season?: number; count: number } | { kind: 'item'; key: string; episode: EpisodeEntry };

const SEASON_HEADER_HEIGHT = 44;

function episodeRows(entry: LibraryEntry | undefined): EpisodeListRow[] {
  if (!entry || entry.kind !== 'series') return [];
  const rows: EpisodeListRow[] = [];
  const groups = groupBySeason(entry.episodes);
  for (const g of groups) {
    if (groups.length > 1 || g.season !== undefined) {
      const header: EpisodeListRow = { kind: 'header', key: `season-${g.season ?? 'x'}`, count: g.episodes.length };
      if (g.season !== undefined) header.season = g.season;
      rows.push(header);
    }
    for (const ep of g.episodes) rows.push({ kind: 'item', key: `ep-${ep.download.id}`, episode: ep });
  }
  return rows;
}

function DetailSkeleton() {
  return (
    <div className="flex gap-8 p-6" role="status" aria-busy="true">
      <Skeleton className="aspect-[2/3] w-56 shrink-0 rounded-lg" />
      <div className="flex flex-1 flex-col gap-4 pt-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-6 h-10 w-48" />
      </div>
    </div>
  );
}

export function MyVideoDetailPage() {
  const { t, i18n } = useTranslation('library');
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const { toast } = useToast();
  const query = useMyVideos();
  const { byId: sources } = useSourcesById();
  const { pending, perform } = useDownloadActions();

  const library = useMemo(() => buildLibrary(query.data ?? []), [query.data]);
  const entry = useMemo(() => (Number.isFinite(id) ? findEntry(library, id) : undefined), [library, id]);
  const rows = useMemo(() => episodeRows(entry), [entry]);

  const [playing, setPlaying] = useState<{ id: number; url?: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Download | null>(null);
  const [deleteFile, setDeleteFile] = useState(false);
  const removedEntry = useRef(false);
  const playerUrl = usePlayerStore((s) => s.source?.url);
  const playerTitle = usePlayerStore((s) => s.source?.title);

  // Watch state lasts while the player still plays what we started.
  const watching = playing !== null && (playing.url === undefined || playerUrl === playing.url);
  useEffect(() => {
    if (playing?.url && playerUrl !== playing.url) setPlaying(null);
  }, [playerUrl, playing]);

  // The URL names one download. Removing that episode from a series must not
  // strand the page: it follows the series to another of its episodes. An
  // entry that vanished because its last file was removed returns to the library.
  const entryKey = useRef<string | undefined>(undefined);
  if (entry) entryKey.current = entry.key;
  useEffect(() => {
    if (!query.data || entry) return;
    const same = entryKey.current ? library.find((e) => e.key === entryKey.current) : undefined;
    if (same) navigate(`/my-videos/${entryTargetId(same)}`, { replace: true });
    else if (removedEntry.current) navigate('/my-videos', { replace: true });
  }, [entry, library, navigate, query.data]);

  const primary: Download | undefined = useMemo(() => {
    if (!entry) return undefined;
    if (entry.kind === 'movie') return entry.download;
    // Resume the episode that was played last or the first available one.
    const available = entry.episodes.filter((e) => !e.missing);
    const inProgress = available
      .filter((e) => e.download.positionSeconds > 5)
      .sort((a, b) => b.download.updatedAt.localeCompare(a.download.updatedAt))[0];
    const byId = available.find((e) => e.download.id === id);
    return (inProgress ?? byId ?? available[0])?.download;
  }, [entry, id]);

  const play = useCallback(
    async (d: Download, fromStart = false) => {
      setStarting(true);
      setPlaying({ id: d.id });
      try {
        await playDownload(fromStart ? { ...d, positionSeconds: 0 } : d);
        setPlaying({ id: d.id, url: usePlayerStore.getState().source?.url ?? '' });
      } catch (err) {
        setPlaying(null);
        const e = RpcError.from(err);
        toast({ title: t('playFailed', { title: d.title }), description: e.code === 'not_found' ? t('fileGoneHint') : e.message, variant: 'error' });
        if (e.code === 'not_found') void query.refetch();
      } finally {
        setStarting(false);
      }
    },
    [query, t, toast],
  );

  const onEpisodeAction = useCallback(
    (a: EpisodeAction, d: Download) => {
      if (a === 'play') void play(d);
      else if (a === 'remove') {
        setDeleteFile(false);
        setRemoveTarget(d);
      } else void perform(a, d);
    },
    [perform, play],
  );

  // One toast for the whole series; failures still report per episode.
  const redownloadSeries = async (downloads: Download[], title: string) => {
    const results = await Promise.all(downloads.map((dl) => perform('redownload', dl, { quiet: true })));
    const count = results.filter(Boolean).length;
    if (count > 0) toast({ title: t('redownloadQueuedMany', { count, title }), variant: 'success' });
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    const lastOne = entry?.kind === 'movie' || (entry?.kind === 'series' && entry.episodes.length === 1);
    if (lastOne) removedEntry.current = true;
    const ok = await perform('remove', target, { deleteFile: deleteFile && target.fileAvailable !== false });
    if (!ok) removedEntry.current = false;
    if (ok && playing?.id === target.id) usePlayerStore.getState().stop();
    setRemoveTarget(null);
  };

  const backAction = useMemo(
    () => (
      <Link to="/my-videos" className={buttonClass('ghost', 'sm')}>
        <ArrowLeft size={16} aria-hidden className="rtl:rotate-180" />
        {t('backToLibrary')}
      </Link>
    ),
    [t],
  );
  const pageTitle = entry?.title ?? t('myVideosTitle');
  usePageHeader(pageTitle, entry ? t(entry.kind === 'movie' ? 'movie' : 'series') : undefined, backAction);

  useShortcut('backspace', () => navigate('/my-videos'), { description: t('backToLibrary'), area: t('myVideosTitle') });

  if (query.isLoading)
    return (
      <>
        <PageTitle>{pageTitle}</PageTitle>
        <DetailSkeleton />
      </>
    );
  if (query.isError)
    return (
      <>
        <PageTitle>{pageTitle}</PageTitle>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  if (!entry) {
    return (
      <>
        <PageTitle>{pageTitle}</PageTitle>
        <EmptyState
          icon={<SearchX size={28} aria-hidden />}
          title={t('detailNotFoundTitle')}
          description={t('detailNotFoundBody')}
          action={
            <div className="flex gap-2">
              <Link to="/my-videos" className={buttonClass('primary', 'md')}>
                {t('backToLibrary')}
              </Link>
              <Link to="/downloads" className={buttonClass('secondary', 'md')}>
                {t('openQueue')}
              </Link>
            </div>
          }
        />
      </>
    );
  }

  const source = sources.get((entry.kind === 'movie' ? entry.download : entry.latest).ref.sourceId);
  const movieMissing = entry.kind === 'movie' && entry.missing;
  const allMissing = entry.kind === 'series' && entry.missingCount === entry.episodes.length;
  const totalSize = (entry.kind === 'movie' ? [entry.download] : entry.episodes.map((e) => e.download)).reduce(
    (n, d) => n + (d.fileAvailable === false ? 0 : (d.totalBytes ?? d.bytesDownloaded)),
    0,
  );
  const completed = new Date(entry.completedAt);
  const completedText = Number.isFinite(completed.getTime()) ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(completed) : '';
  const resume = primary && primary.positionSeconds > 5 ? primary.positionSeconds : 0;
  const primaryEpisode = entry.kind === 'series' && primary ? entry.episodes.find((e) => e.download.id === primary.id) : undefined;

  const actionsBar = (
    <div className="flex flex-wrap items-center gap-2">
      {movieMissing || allMissing ? (
        <Button
          variant="primary"
          size="lg"
          icon={<RotateCcw size={18} aria-hidden />}
          loading={entry.kind === 'movie' ? pending.has(entry.download.id) : entry.episodes.some((ep) => pending.has(ep.download.id))}
          onClick={() => {
            if (entry.kind === 'movie') void perform('redownload', entry.download);
            else void redownloadSeries(entry.episodes.map((ep) => ep.download), entry.title);
          }}
        >
          {t('redownload')}
        </Button>
      ) : (
        primary && (
          <Button
            variant="primary"
            size="lg"
            icon={<Play size={18} aria-hidden />}
            loading={starting}
            onClick={() => void play(primary)}
            data-testid="play-offline"
          >
            {resume
              ? t('resumeFrom', { time: formatClock(resume) })
              : primaryEpisode
                ? t('playEpisode', { code: episodeCode(primaryEpisode) || primaryEpisode.name })
                : t('playOffline')}
          </Button>
        )
      )}
      {primary && resume > 0 && !movieMissing && (
        <Button variant="secondary" size="lg" onClick={() => void play(primary, true)}>
          {t('startOver')}
        </Button>
      )}
      {entry.kind === 'movie' && isDesktop && !movieMissing && (
        <Button variant="ghost" size="lg" icon={<FolderOpen size={18} aria-hidden />} onClick={() => void perform('reveal', entry.download)}>
          {t('actionReveal')}
        </Button>
      )}
      {entry.kind === 'movie' && (
        <Button
          variant="ghost"
          size="lg"
          icon={<Trash2 size={18} aria-hidden />}
          onClick={() => {
            setDeleteFile(false);
            setRemoveTarget(entry.download);
          }}
        >
          {t('removeFromLibrary')}
        </Button>
      )}
    </div>
  );

  const facts = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[calc(13rem/15)] text-fg-muted">
      <SourceBadge source={source} />
      {entry.kind === 'series' && <span>{t('episodeCount', { count: entry.episodes.length })}</span>}
      {totalSize > 0 && <span className="font-display tabular-nums">{formatBytes(totalSize, i18n.language)}</span>}
      {completedText && <span>{t('downloadedOn', { date: completedText })}</span>}
    </div>
  );

  const missingPanel = (movieMissing || (entry.kind === 'series' && entry.missingCount > 0)) && (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
      <FileWarning size={18} aria-hidden className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="font-medium text-fg">
          {movieMissing ? t('fileMissingTitle') : t('episodesMissingTitle', { count: entry.kind === 'series' ? entry.missingCount : 0 })}
        </p>
        <p className="text-fg-muted">{t('fileMissingBody')}</p>
      </div>
    </div>
  );

  const episodeList = entry.kind === 'series' && (
    <VirtualRows
      rows={rows}
      label={t('downloadedEpisodes')}
      rowHeight={(r) => (r.kind === 'header' ? SEASON_HEADER_HEIGHT : EPISODE_ROW_HEIGHT)}
      isFocusable={(r) => r.kind === 'item'}
      testId="episode-list"
      renderRow={(r) =>
        r.kind === 'header' ? (
          <SectionHeading title={r.season !== undefined ? t('seasonN', { season: r.season }) : t('otherEpisodes')} count={r.count} />
        ) : (
          <EpisodeRow
            episode={r.episode}
            playing={watching && playing?.id === r.episode.download.id}
            busy={pending.has(r.episode.download.id)}
            onAction={onEpisodeAction}
          />
        )
      }
      onRowKeyDown={(r, e) => {
        if (r.kind !== 'item') return;
        const actions = episodeActions(r.episode);
        if (e.key === 'Enter' && actions[0]) {
          e.preventDefault();
          onEpisodeAction(actions[0], r.episode.download);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          onEpisodeAction('remove', r.episode.download);
        }
      }}
    />
  );

  const removeDialog = (
    <ConfirmDialog
      open={removeTarget !== null}
      onClose={() => setRemoveTarget(null)}
      busy={removeTarget ? pending.has(removeTarget.id) : false}
      danger={deleteFile}
      title={t('removeLibraryTitle')}
      description={
        deleteFile
          ? t('removeLibraryDeleteBody', { title: removeTarget?.subtitle ?? removeTarget?.title ?? '' })
          : t('removeLibraryKeepBody', { title: removeTarget?.subtitle ?? removeTarget?.title ?? '' })
      }
      confirmLabel={deleteFile ? t('removeAndDelete') : t('removeFromLibrary')}
      onConfirm={() => void confirmRemove()}
    >
      {removeTarget && removeTarget.fileAvailable !== false && (
        <Toggle checked={deleteFile} onChange={setDeleteFile} label={t('alsoDeleteFile')} description={t('alsoDeleteFileHint')} />
      )}
    </ConfirmDialog>
  );

  if (watching) {
    return (
      <div
        className="mx-auto flex h-[calc(100dvh-var(--header-height))] w-full max-w-[1800px] min-w-0 flex-col gap-4 px-6 pb-4 pt-4"
        data-state="watch"
      >
        <PlayerStage className="aspect-video max-h-[62vh] w-full shrink-0 overflow-hidden rounded-lg bg-black shadow-2" />
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            {/* The h1 matches the header title (C16); a playing episode's own title sits under it. */}
            <h1 className="truncate text-xl text-fg">{pageTitle}</h1>
            {playerTitle && playerTitle !== pageTitle && (
              <p className="truncate text-sm text-fg-muted" data-testid="now-playing-title">
                {playerTitle}
              </p>
            )}
            {facts}
          </div>
          <Button variant="ghost" icon={<ArrowLeft size={16} aria-hidden className="rtl:rotate-180" />} onClick={() => setPlaying(null)}>
            {t('backToDetails')}
          </Button>
        </div>
        {episodeList}
        {removeDialog}
      </div>
    );
  }

  return (
    <div
      className="mx-auto flex h-[calc(100dvh-var(--header-height))] w-full max-w-[1800px] min-w-0 flex-col gap-6 px-6 pb-4 pt-6"
      data-state="browse"
    >
      <div className="relative flex shrink-0 gap-6 lg:gap-10">
        {entry.posterUrl && (
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-6 -top-6 h-72 overflow-hidden opacity-25 [mask-image:linear-gradient(to_bottom,black,transparent)]"
          >
            <img src={entry.posterUrl} alt="" className="h-full w-full scale-110 object-cover blur-2xl" />
          </div>
        )}
        <div className={cn('relative w-32 shrink-0 md:w-44 xl:w-56', (movieMissing || allMissing) && 'opacity-60 grayscale')}>
          <Poster src={entry.posterUrl} alt={entry.title} aspect="poster" />
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col justify-end gap-4 pb-1">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl text-fg lg:text-[calc(34rem/15)] lg:leading-tight">{pageTitle}</h1>
            {facts}
          </div>
          {missingPanel}
          {actionsBar}
        </div>
      </div>
      {entry.kind === 'series' && <div className="flex min-h-0 flex-1 flex-col">{episodeList}</div>}
      {removeDialog}
    </div>
  );
}

export default MyVideoDetailPage;
