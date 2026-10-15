/**
 * My Videos > Recordings: files in the recordings folder (the player's record
 * button and scheduled recordings). Play, show in folder, delete (to the
 * Recycle Bin on Windows) with Undo; a file that went missing says so.
 */

import { Disc3, FolderOpen, Play, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import type { RecordingFile } from '@/api/types';
import { scheduleRemoval, usePendingRemovals } from '@/features/sources/lib/pendingRemoval';
import { buttonClass } from '@/ui/Button';

import { Badge, EmptyState, ErrorState, IconButton, SkeletonList, playSource, useToast } from '../deps';
import { formatBytes, formatDuration } from '../lib/format';

/** Entries whose name, channel or title contains `query` (case-insensitive). */
export function filterRecordings(files: readonly RecordingFile[], query: string): RecordingFile[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...files];
  return files.filter((f) => [f.fileName, f.channelName, f.title].some((s) => s?.toLocaleLowerCase().includes(q)));
}

export function useRecordingFiles() {
  return useRpcQuery('recordings.library', undefined, { staleTime: 10_000 });
}

export function RecordingsPanel({ search }: { search: string }) {
  const { t } = useTranslation('library');
  const query = useRecordingFiles();
  const hidden = usePendingRemovals((s) => s.ids);
  const visible = useMemo(() => filterRecordings(query.data ?? [], search).filter((f) => !hidden.has(`recording:${f.id}`)), [query.data, search, hidden]);

  if (query.isLoading) return <SkeletonList rows={6} className="pt-2" />;
  if (query.isError) return <ErrorState error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />;
  if ((query.data ?? []).length === 0) {
    return (
      <EmptyState
        icon={<Disc3 size={28} aria-hidden />}
        title={t('recordingsEmptyTitle')}
        description={t('recordingsEmptyBody')}
        action={
          <Link to="/epg" className={buttonClass('secondary', 'md')}>
            {t('scheduledOpenGuide')}
          </Link>
        }
      />
    );
  }
  if (visible.length === 0) return <EmptyState title={t('noMatchTitle')} description={t('noMatchSearch', { query: search })} />;
  return (
    <ul aria-label={t('filterRecordings')} className="flex min-h-0 flex-col divide-y divide-divider overflow-y-auto rounded-lg border border-border bg-surface" data-testid="recordings-list">
      {visible.map((f) => (
        <RecordingFileRow key={f.id} file={f} />
      ))}
    </ul>
  );
}

function RecordingFileRow({ file: f }: { file: RecordingFile }) {
  const { t, i18n } = useTranslation('library');
  const { toast } = useToast();
  const lang = i18n.language;
  // The programme title leads and the channel sits in the line under it, as on the Scheduled page.
  const name = f.title ?? f.channelName ?? f.fileName;
  const writing = f.status === 'recording';
  const date = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(Date.parse(f.date));
  const duration = f.durationSeconds ? formatDuration(f.durationSeconds, { locale: lang, t: (key, vars) => i18n.t(`vod:${key}`, vars) }) : '';

  const play = async () => {
    try {
      await playSource(await rpc('recordings.playSource', { id: f.id }));
    } catch (e) {
      toast({ variant: 'error', title: t('recPlayFailed'), description: RpcError.from(e).message });
      void invalidate('recordings.');
    }
  };

  const reveal = async () => {
    try {
      await rpc('recordings.reveal', { id: f.id });
    } catch (e) {
      toast({ variant: 'error', title: t('recRevealFailed'), description: RpcError.from(e).message });
    }
  };

  const remove = () => {
    scheduleRemoval({
      id: `recording:${f.id}`,
      // A server may run on a system without a Recycle Bin, where the file is deleted.
      toast: { title: f.fileAvailable ? t(isDesktop ? 'recDeleted' : 'recDeletedNoBin', { name: f.fileName }) : t('recForgotten', { name: f.fileName }) },
      undoLabel: t('recUndo'),
      remove: () => rpc('recordings.delete', { id: f.id }),
      onRemoved: () => void invalidate('recordings.'),
      onFailed: (e) => toast({ variant: 'error', title: t('recDeleteFailed'), description: RpcError.from(e).message }),
    });
  };

  return (
    <li className="flex items-center gap-4 px-4 py-3" data-testid="recording-file" data-available={f.fileAvailable}>
      <IconButton
        variant="secondary"
        label={t('recPlay', { name: f.fileName })}
        icon={<Play size={16} aria-hidden />}
        disabled={!f.fileAvailable}
        onClick={() => void play()}
        data-testid="recording-play"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span dir="auto" className="truncate text-sm font-medium text-fg" title={f.fileName}>
            {name}
          </span>
          {f.part ? <span className="shrink-0 text-xs text-fg-muted">{t('recPart', { n: f.part })}</span> : null}
          {writing ? (
            <Badge variant="live" className="shrink-0">
              {t('recStatusRecording')}
            </Badge>
          ) : null}
          {!f.fileAvailable ? (
            <Badge variant="warning" className="shrink-0" data-testid="recording-missing">
              {t('fileMissing')}
            </Badge>
          ) : null}
        </div>
        <span className="flex min-w-0 gap-3 text-xs text-fg-muted">
          {f.title && f.channelName ? (
            <span dir="auto" className="min-w-0 truncate">
              {f.channelName}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">{date}</span>
          {duration ? <span className="shrink-0 tabular-nums">{duration}</span> : null}
          {f.fileAvailable ? <span className="shrink-0 font-display tabular-nums">{formatBytes(f.sizeBytes, lang)}</span> : null}
          <span dir="auto" className="hidden truncate text-fg-subtle lg:inline">
            {f.fileName}
          </span>
        </span>
      </div>
      {isDesktop && f.fileAvailable ? (
        <IconButton label={t('recReveal', { name: f.fileName })} icon={<FolderOpen size={16} aria-hidden />} onClick={() => void reveal()} data-testid="recording-reveal" />
      ) : null}
      <IconButton
        label={t('recDelete', { name: f.fileName })}
        icon={<Trash2 size={16} aria-hidden />}
        disabled={writing}
        onClick={remove}
        data-testid="recording-delete"
      />
    </li>
  );
}
