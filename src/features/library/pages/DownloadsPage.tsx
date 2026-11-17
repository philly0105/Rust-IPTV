/** /downloads: the transfer queue, then the latest finished downloads. My Videos keeps every finished one. */

import { Download as DownloadIcon, Eraser, Gauge, Library, Pause } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate } from '@/api/query';
import { isDesktop } from '@/api/transport';
import type { Download } from '@/api/types';
import { buttonClass } from '@/ui/Button';
import { errorDescription, toast } from '@/ui';
import { formatList } from '@/lib/intl';

import { Button, EmptyState, ErrorState, Page, SkeletonList, Toggle, useMediaQuery, useSettings, useShortcut } from '../deps';
import { BrowseMoviesAction, ConfirmDialog, PageTitle, SectionHeading } from '../components/bits';
import { DownloadRow, FinishedRow, SM_QUERY, downloadRowHeight, finishedRowHeight } from '../components/DownloadRow';
import { DownloadDetailsPopover } from '../components/DownloadDetailsPopover';
import { DownloadSpeedDialog } from '../components/DownloadSpeedDialog';
import { FolderBar } from '../components/FolderBar';
import { SpeedSparkline } from '../components/SpeedSparkline';
import { VirtualRows, type RowRenderInfo } from '../components/VirtualRows';
import { useDownloadActions } from '../hooks/useDownloadActions';
import { useDownloads, useSourcesById } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatSpeedLimit } from '../lib/format';
import { statsStore } from '../lib/progress';
import { actionsFor, buildQueueRows, downloadNames, queueCounts, type QueueAction, type QueueRow } from '../lib/queue';
import { playActiveCatchupDownload, playDownload } from '../lib/playDownload';
import type { NameOf } from '../lib/transferText';

const HEADER_HEIGHT = 52;

type Pending = { action: 'cancel' | 'remove' | 'clear'; download?: Download };

/** Finds the download row that currently holds keyboard focus (the row itself or one of its buttons). */
function focusedDownloadId(): number | undefined {
  const active = document.activeElement;
  const el = active?.closest('[data-row-index]')?.querySelector<HTMLElement>('[data-download-id]');
  const raw = el?.dataset['downloadId'];
  return raw ? Number(raw) : undefined;
}

export function DownloadsPage() {
  const { t, i18n } = useTranslation('library');
  const query = useDownloads();
  const settings = useSettings();
  const globalLimit = settings.data?.downloadRateLimitBps ?? 0;
  const [speedTarget, setSpeedTarget] = useState<Download | 'global' | null>(null);
  const editSpeed = useCallback((download: Download) => setSpeedTarget(download), []);
  const { byId: sources, isLoading: sourcesLoading } = useSourcesById();
  // The speed details dialog's row, by id: it reads the row as the list has it now.
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const openDetails = useCallback((d: Download) => setDetailsId(d.id), []);
  // Mirrors are other sources: rows name them through this.
  const nameOf: NameOf = useCallback((id: string) => sources.get(id)?.name ?? t('sourceRemoved'), [sources, t]);
  const { pending, perform } = useDownloadActions();

  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [deletePartial, setDeletePartial] = useState(true);
  const [clearing, setClearing] = useState(false);

  const all = useMemo(() => query.data ?? [], [query.data]);
  // A breakdown only means something while its row downloads.
  useEffect(() => {
    if (query.data) statsStore.prune(query.data.filter((d) => d.status === 'downloading').map((d) => d.id));
  }, [query.data]);
  const wide = useMediaQuery(SM_QUERY);
  // `wide`: a new array when the breakpoint flips, so the list measures its rows again (downloadRowHeight).
  const rows = useMemo(() => buildQueueRows(all), [all, wide]);
  const counts = useMemo(() => queueCounts(all), [all]);
  const completedCount = useMemo(() => all.filter((d) => d.status === 'completed').length, [all]);
  const attention = useMemo(() => all.filter((d) => d.status === 'failed' || d.status === 'canceled'), [all]);
  // Pause all while anything moves or waits its turn, else Resume all while anything is paused.
  const bulk = useMemo(() => {
    const running = all.filter((d) => d.status === 'downloading' || d.status === 'queued');
    if (running.length > 0) return { action: 'pause' as const, rows: running };
    const paused = all.filter((d) => d.status === 'paused');
    return paused.length > 0 ? { action: 'resume' as const, rows: paused } : undefined;
  }, [all]);
  // Every row from one source: naming it on each row says nothing.
  const mixedSources = useMemo(() => new Set(all.map((d) => d.ref.sourceId)).size > 1, [all]);

  const summary = useMemo(() => {
    const parts: string[] = [];
    if (counts.downloading) parts.push(t('summaryDownloading', { count: counts.downloading }));
    if (counts.queued) parts.push(t('summaryQueued', { count: counts.queued }));
    if (counts.paused) parts.push(t('summaryPaused', { count: counts.paused }));
    if (counts.attention) parts.push(t('summaryAttention', { count: counts.attention }));
    return formatList(parts, i18n.language);
  }, [counts, t, i18n.language]);

  const onAction = useCallback(
    (action: QueueAction, d: Download) => {
      if (action === 'cancel' && d.bytesDownloaded > 0) {
        setConfirm({ action: 'cancel', download: d });
        return;
      }
      if (action === 'remove') {
        setDeletePartial(true);
        setConfirm({ action: 'remove', download: d });
        return;
      }
      void perform(action, d);
    },
    [perform],
  );

  const onPlayCatchup = useCallback((d: Download) => {
    void playActiveCatchupDownload(d).catch((err: unknown) =>
      toast({ title: t('playFailed', { title: downloadNames(d).title }), description: errorDescription(err), variant: 'error' }),
    );
  }, [t]);

  const onPlayFinished = useCallback((d: Download) => {
    void playDownload(d).catch((err: unknown) =>
      toast({ title: t('playFailed', { title: downloadNames(d).title }), description: errorDescription(err), variant: 'error' }),
    );
  }, [t]);
  const onRedownload = useCallback((d: Download) => void perform('redownload', d), [perform]);

  const runFocused = (pick: (d: Download, actions: readonly QueueAction[]) => QueueAction | undefined) => {
    const id = focusedDownloadId();
    const d = id !== undefined ? all.find((x) => x.id === id) : undefined;
    // A finished row's own buttons are its actions; removing one belongs to My Videos.
    if (!d || d.status === 'completed') return;
    const actions = actionsFor(d.status, { canReveal: isDesktop, hasFile: !!d.filePath });
    const action = pick(d, actions);
    if (action && actions.includes(action)) onAction(action, d);
  };

  const area = t('title');
  useShortcut('p', () => runFocused((d) => (d.status === 'paused' ? 'resume' : 'pause')), { description: t('shortcutPause'), area });
  useShortcut('r', () => runFocused(() => 'retry'), { description: t('shortcutRetry'), area });
  useShortcut('x', () => runFocused(() => 'cancel'), { description: t('shortcutCancel'), area });
  useShortcut('delete', () => runFocused(() => 'remove'), { description: t('shortcutRemove'), area });
  useShortcut('o', () => runFocused(() => 'reveal'), { description: t('shortcutReveal'), area, enabled: isDesktop });

  // In the page's own toolbar line, beside the folder (as My Videos keeps its queue link beside its
  // tabs), so the header search keeps its place from page to page.
  const myVideosLabel = completedCount > 0 ? t('openMyVideosCount', { count: completedCount }) : t('openMyVideos');
  const myVideosLink = (
    // On a phone the folder takes its own line and the two actions the next, with short labels so
    // they share it, their icons under the folder's: as bare glyphs they squeezed the path to
    // "/ho… downloads" and said nothing on touch.
    <Link
      to="/my-videos"
      className={buttonClass('ghost', 'sm', 'shrink-0 max-sm:-ms-3 sm:ms-auto')}
      title={myVideosLabel}
      aria-label={myVideosLabel}
      data-testid="downloads-my-videos"
    >
      <Library size={16} aria-hidden />
      <span className="sm:hidden">{completedCount > 0 ? myVideosLabel : t('myVideosTitle')}</span>
      <span className="max-sm:hidden">{myVideosLabel}</span>
    </Link>
  );
  const title = t('title');
  // The total speed and its last minute, in the header beside the summary; it hides itself while nothing moves.
  const headerActions = useMemo(() => <SpeedSparkline />, []);
  usePageHeader(title, summary || undefined, headerActions);
  const speedText = settings.data ? (globalLimit === 0 ? t('speedUnlimited') : formatSpeedLimit(globalLimit, i18n.language)) : '…';
  const speedButtonLabel = t('speedGlobalButton', { speed: speedText });

  // The download the dialog is about as the list shows it now: it may have
  // finished since the dialog opened.
  const detailsRow = detailsId !== null ? all.find((x) => x.id === detailsId) : undefined;

  const opened = confirm?.download;
  const confirmTarget = opened ? (all.find((x) => x.id === opened.id) ?? opened) : undefined;
  const confirmUnfinished = confirmTarget !== undefined && confirmTarget.status !== 'completed';

  const confirmAction = async () => {
    if (!confirm) return;
    if (confirm.action === 'clear') {
      setClearing(true);
      for (const d of attention) await perform('remove', d, { deleteFile: true });
      setClearing(false);
    } else if (confirm.download) {
      // Close first so focus returns to the row while it still exists; when the
      // row then leaves the list, the list moves focus to its neighbour instead
      // of dropping it to the page.
      const { action, download } = confirm;
      // Only an unfinished download offers the partial-file toggle; a finished
      // one keeps its file (deleting it is My Videos' choice, off by default).
      const deleteFile = action === 'remove' && confirmUnfinished && deletePartial;
      setConfirm(null);
      await perform(action, download, { deleteFile });
      return;
    }
    setConfirm(null);
  };

  const renderRow = useCallback(
    (row: QueueRow, info: RowRenderInfo) => {
      if (row.kind === 'header') {
        return (
          <SectionHeading
            title={t(row.section === 'active' ? 'sectionActive' : row.section === 'attention' ? 'sectionAttention' : 'sectionFinished')}
            count={row.count}
            {...(row.section === 'finished'
              ? {}
              : row.section === 'attention'
              ? {
                  hint: t('sectionAttentionHint'),
                  // VL-clear-finished-copy: beside the rows it removes.
                  action: (
                    <Button size="sm" variant="ghost" icon={<Eraser size={16} aria-hidden />} onClick={() => setConfirm({ action: 'clear' })}>
                      {t('clearFailedDownloads')}
                    </Button>
                  ),
                }
              : bulk
                ? {
                    // Both undo themselves, so neither asks first.
                    action: (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={bulk.action === 'pause' ? <Pause size={16} aria-hidden /> : <DownloadIcon size={16} aria-hidden />}
                        onClick={() => void Promise.all(bulk.rows.map((d) => perform(bulk.action, d)))}
                        data-testid="downloads-bulk"
                      >
                        {t(bulk.action === 'pause' ? 'pauseAll' : 'resumeAll')}
                      </Button>
                    ),
                  }
                : {})}
          />
        );
      }
      const d = row.download;
      if (row.section === 'finished') {
        return <FinishedRow download={d} busy={pending.has(d.id)} tabbable={info.tabStop} onPlay={onPlayFinished} onRedownload={onRedownload} />;
      }
      return (
        <DownloadRow
          download={d}
          source={sources.get(d.ref.sourceId)}
          showSource={mixedSources}
          actions={actionsFor(d.status, { canReveal: isDesktop, hasFile: !!d.filePath })}
          busy={pending.has(d.id)}
          tabbable={info.tabStop}
          onAction={onAction}
          onPlayCatchup={onPlayCatchup}
          onSpeedLimit={editSpeed}
          onDetails={openDetails}
          nameOf={nameOf}
          globalRateLimitBps={globalLimit}
        />
      );
    },
    // Each row subscribes to its own live sample (VD-4): a progress event re-renders that row only.
    [mixedSources, onAction, onPlayCatchup, onPlayFinished, onRedownload, pending, sources, t, editSpeed, openDetails, nameOf, globalLimit, bulk, perform],
  );

  let body;
  if (query.isLoading) {
    body = <SkeletonList rows={6} className="pt-4" />;
  } else if (query.isError) {
    // One error state for the page: its retry also re-reads the folder bar.
    body = (
      <ErrorState
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => {
          void query.refetch();
          void invalidate('downloads.dir');
        }}
      />
    );
  } else if (rows.length === 0) {
    // Nothing queued and nothing saved (a finished one would be listed): the catalogue, where a download starts.
    body = (
      <EmptyState
        icon={<DownloadIcon size={28} aria-hidden />}
        title={t('queueEmptyTitle')}
        description={!sourcesLoading && sources.size === 0 ? t('queueEmptyNoSources') : t('queueEmptyBody')}
        action={<BrowseMoviesAction sources={sources} loading={sourcesLoading} />}
      />
    );
  } else {
    body = (
      <VirtualRows
        rows={rows}
        label={t('queueListLabel')}
        rowHeight={(r) =>
          r.kind === 'header' ? HEADER_HEIGHT : r.section === 'finished' ? finishedRowHeight(r.download, wide) : downloadRowHeight(r.download, wide)
        }
        isFocusable={(r) => r.kind === 'item'}
        renderRow={renderRow}
        onRowKeyDown={(r, e) => {
          if (r.kind !== 'item' || e.key !== 'Enter') return;
          e.preventDefault();
          const d = r.download;
          if (r.section === 'finished') {
            if (d.fileAvailable === false) onRedownload(d);
            else onPlayFinished(d);
            return;
          }
          const primary = actionsFor(d.status, { canReveal: isDesktop, hasFile: !!d.filePath })[0];
          if (primary) onAction(primary, d);
        }}
        testId="downloads-list"
        className="-mx-2"
        listClassName="max-w-5xl"
      />
    );
  }

  return (
    <Page width="default" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 pb-4">
      <PageTitle>{title}</PageTitle>
      {/* The list's own box (-mx-2, max-w-5xl, rows padded px-2), so the folder line, the section
          headings and the rows end on one line. */}
      <div className="-mx-2 flex min-w-0 max-w-5xl items-center gap-3 px-2 max-sm:flex-wrap max-sm:gap-y-1">
        <FolderBar pageError={query.isError} />
        {myVideosLink}
        {/* The default speed, a rarely changed setting (also in Settings > General), as one quiet
            button at the end of the folder line. A page that failed to load has one Retry, its
            error state's. */}
        {!query.isError &&
          (settings.isError ? (
            <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void settings.refetch()}>
              {t('speedLoadRetry')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              icon={<Gauge size={16} aria-hidden />}
              disabled={!settings.data}
              title={speedButtonLabel}
              aria-label={speedButtonLabel}
              onClick={() => setSpeedTarget('global')}
              data-testid="downloads-speed"
            >
              <span className="sm:hidden">{t('speedInherited', { speed: speedText })}</span>
              <span className="max-sm:hidden">{speedButtonLabel}</span>
            </Button>
          ))}
      </div>
      {body}
      {speedTarget !== null && (
        <DownloadSpeedDialog
          download={speedTarget === 'global' ? undefined : speedTarget}
          globalLimit={globalLimit}
          onClose={() => setSpeedTarget(null)}
        />
      )}
      {/* A row that left the list (removed, or the list reloaded without it) closes its dialog. */}
      {detailsRow && <DownloadDetailsPopover download={detailsRow} sources={sources} onClose={() => setDetailsId(null)} />}
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        busy={clearing || (confirm?.download ? pending.has(confirm.download.id) : false)}
        danger
        title={
          confirm?.action === 'cancel'
            ? t('cancelConfirmTitle')
            : confirm?.action === 'clear'
              ? t('clearConfirmTitle', { count: attention.length })
              : t('removeConfirmTitle')
        }
        description={
          confirm?.action === 'cancel'
            ? t('cancelConfirmBody', { title: confirm.download ? downloadNames(confirm.download).title : '' })
            : confirm?.action === 'clear'
              ? t('clearConfirmBody')
              : t('removeConfirmBody', { title: confirm?.download ? downloadNames(confirm.download).title : '' })
        }
        confirmLabel={confirm?.action === 'cancel' ? t('actionCancel') : confirm?.action === 'clear' ? t('clearFailedDownloads') : t('actionRemove')}
        onConfirm={() => void confirmAction()}
      >
        {confirm?.action === 'remove' && confirmUnfinished && confirmTarget.bytesDownloaded > 0 && (
          <Toggle checked={deletePartial} onChange={setDeletePartial} label={t('deletePartial')} description={t('deletePartialHint')} />
        )}
      </ConfirmDialog>
    </Page>
  );
}

export default DownloadsPage;
