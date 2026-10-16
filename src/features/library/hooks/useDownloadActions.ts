/**
 * Download item commands with duplicate-click protection, list refresh, and
 * error toasts. Confirmation for destructive actions is the caller's job.
 * Pause and Resume are certain to land, so the row flips at once (the list
 * cache is written before the call) and only `downloads.list` refetches.
 */

import { k } from '../lib/keys';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, queryClient, rpcKey } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { Download, DownloadStatus } from '@/api/types';

import { useToast } from '../deps';
import type { QueueAction } from '../lib/queue';
import { usePending } from './useLibraryData';

export type DownloadCommand = QueueAction | 'redownload';

async function dispatch(action: DownloadCommand, d: Download, deleteFile: boolean): Promise<void> {
  const id = d.id;
  switch (action) {
    case 'pause':
      return rpc('downloads.pause', { id });
    case 'resume':
      return rpc('downloads.resume', { id });
    case 'cancel':
      return rpc('downloads.cancel', { id });
    case 'retry':
    case 'redownload':
      return rpc('downloads.retry', { id });
    case 'remove':
      return rpc('downloads.remove', { id, deleteFile });
    case 'reveal':
      return rpc('downloads.reveal', { id });
  }
}

/** The status a command leaves a row in, for the ones whose outcome is known up front. */
const OPTIMISTIC: Partial<Record<DownloadCommand, DownloadStatus>> = { pause: 'paused', resume: 'queued' };

const LIST_KEY = rpcKey('downloads.list');

/**
 * Writes the expected status into the cached list. Returns the list before the
 * write so a failure can put it back, or undefined when nothing was cached.
 */
async function applyOptimistic(action: DownloadCommand, id: number): Promise<Download[] | undefined> {
  const status = OPTIMISTIC[action];
  const before = queryClient.getQueryData<Download[]>(LIST_KEY);
  if (!status || !before) return undefined;
  // A refetch already in flight would land after the write with the old status.
  await queryClient.cancelQueries({ queryKey: LIST_KEY });
  queryClient.setQueryData<Download[]>(LIST_KEY, (list) => list?.map((d) => (d.id === id ? { ...d, status } : d)));
  return before;
}

export function useDownloadActions() {
  const { t } = useTranslation('library');
  const { toast } = useToast();
  const { pending, run } = usePending<number>();

  const perform = useCallback(
    async function perform(action: DownloadCommand, d: Download, opts?: { deleteFile?: boolean; quiet?: boolean }): Promise<boolean> {
      let ok = false;
      const optimistic = OPTIMISTIC[action] !== undefined;
      await run(d.id, async () => {
        const before = await applyOptimistic(action, d.id);
        try {
          await dispatch(action, d, opts?.deleteFile ?? false);
          ok = true;
          // `quiet` lets a batch caller report once instead of per item.
          if (action === 'redownload' && !opts?.quiet) toast({ title: t('redownloadQueued', { title: d.title }), variant: 'success' });
        } catch (err) {
          if (before) queryClient.setQueryData(LIST_KEY, before);
          const e = RpcError.from(err);
          toast({
            title: t(k('actionFailed', action), { title: d.title }),
            description: e.code === 'not_found' ? t('notFoundHint') : e.message,
            variant: 'error',
            // A timeout or dropped connection may succeed on a second attempt.
            action: e.retryable ? { label: t('tryAgain'), onClick: () => void perform(action, d, opts) } : undefined,
          });
        } finally {
          // Pause and Resume cannot change My Videos or the folder; the row already shows
          // the result, so the confirming refetch does not hold the buttons.
          if (optimistic) void invalidate('downloads.list');
          else await Promise.all([invalidate('downloads.list'), invalidate('myvideos.')]);
        }
      });
      return ok;
    },
    [run, t, toast],
  );

  return { pending, perform };
}
