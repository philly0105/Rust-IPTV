/** /downloads: the transfer queue. Completed items leave this page for My Videos. */

import { Download as DownloadIcon, Eraser, Library } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate } from '@/api/query';
import { isDesktop } from '@/api/transport';
import type { Download } from '@/api/types';
import { buttonClass } from '@/ui/Button';
import { errorDescription, toast } from '@/ui';
import { formatList } from '@/lib/intl';

import { Button, EmptyState, ErrorState, Page, SkeletonList, Toggle, useShortcut } from '../deps';
import { BrowseMoviesAction, ConfirmDialog, PageTitle, SectionHeading } from '../components/bits';
import { DOWNLOAD_ROW_HEIGHT, DownloadRow } from '../components/DownloadRow';
import { FolderBar } from '../components/FolderBar';
import { VirtualRows, type RowRenderInfo } from '../components/VirtualRows';
import { useDownloadActions } from '../hooks/useDownloadActions';
import { useDownloads, useSourcesById } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { actionsFor, buildQueueRows, queueCounts, type QueueAction, type QueueRow } from '../lib/queue';
import { playActiveCatchupDownload } from '../lib/playDownload';

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
  const { byId: sources, isLoading: sourcesLoading } = useSourcesById();
  const { pending, perform } = useDownloadActions();

  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [deletePartial, setDeletePartial] = useState(true);
  const [clearing, setClearing] = useState(false);

  const all = useMemo(() => query.data ?? [], [query.data]);
  const rows = useMemo(() => buildQueueRows(all), [all]);
  const counts = useMemo(() => queueCounts(all), [all]);
  const completedCount = useMemo(() => all.filter((d) => d.status === 'completed').length, [all]);
  const attention = useMemo(() => all.filter((d) => d.status === 'failed' || d.status === 'canceled'), [all]);
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
      toast({ title: t('playFailed', { title: d.subtitle?.split(' · ')[0] || d.title }), description: errorDescription(err), variant: 'error' }),
    );
  }, [t]);

  const runFocused = (pick: (d: Download, actions: readonly QueueAction[]) => QueueAction | undefined) => {
    const id = focusedDownloadId();
    const d = id !== undefined ? all.find((x) => x.id === id) : undefined;
    if (!d) return;
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
    // Icon only on a phone, so the folder line keeps its room (L3-visual-6).
    <Link to="/my-videos" className={buttonClass('ghost', 'sm', 'ms-auto shrink-0')} title={myVideosLabel} data-testid="downloads-my-videos">
      <Library size={16} aria-hidden />
      <span className="max-sm:sr-only">{myVideosLabel}</span>
    </Link>
  );
  const title = t('title');
  usePageHeader(title, summary || undefined);

  // The download the dialog is about as the list shows it now: it may have
  // finished since the dialog opened.
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
            title={t(row.section === 'active' ? 'sectionActive' : 'sectionAttention')}
            count={row.count}
            {...(row.section === 'attention'
              ? {
                  hint: t('sectionAttentionHint'),
                  // VL-clear-finished-copy: beside the rows it removes, and named for them.
                  action: (
                    <Button size="sm" variant="ghost" icon={<Eraser size={16} aria-hidden />} onClick={() => setConfirm({ action: 'clear' })}>
                      {t('clearFailedDownloads')}
                    </Button>
                  ),
                }
              : {})}
          />
        );
      }
      const d = row.download;
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
        />
      );
    },
    // Each row subscribes to its own live sample (VD-4): a progress event re-renders that row only.
    [mixedSources, onAction, onPlayCatchup, pending, sources, t],
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
    body = (
      <EmptyState
        icon={<DownloadIcon size={28} aria-hidden />}
        title={t('queueEmptyTitle')}
        description={completedCount > 0 ? t('queueEmptyWithLibrary', { count: completedCount }) : t('queueEmptyBody')}
        action={
          completedCount > 0 ? (
            <Link to="/my-videos" className={buttonClass('primary', 'md')}>
              {t('openMyVideos')}
            </Link>
          ) : (
            // Nothing saved either: the catalogue, where a download starts.
            <BrowseMoviesAction sources={sources} loading={sourcesLoading} />
          )
        }
      />
    );
  } else {
    body = (
      <VirtualRows
        rows={rows}
        label={t('queueListLabel')}
        rowHeight={(r) => (r.kind === 'header' ? HEADER_HEIGHT : DOWNLOAD_ROW_HEIGHT)}
        isFocusable={(r) => r.kind === 'item'}
        renderRow={renderRow}
        onRowKeyDown={(r, e) => {
          if (r.kind !== 'item' || e.key !== 'Enter') return;
          e.preventDefault();
          const d = r.download;
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
      <div className="-mx-2 flex min-w-0 max-w-5xl items-center gap-3 px-2">
        <FolderBar pageError={query.isError} />
        {myVideosLink}
      </div>
      {body}
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
            ? t('cancelConfirmBody', { title: confirm.download?.title ?? '' })
            : confirm?.action === 'clear'
              ? t('clearConfirmBody')
              : t('removeConfirmBody', { title: confirm?.download?.title ?? '' })
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
