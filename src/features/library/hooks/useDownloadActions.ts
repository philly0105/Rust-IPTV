/**
 * Download item commands with duplicate-click protection, list refresh, and
 * error toasts. Confirmation for destructive actions is the caller's job.
 */

import { k } from '../lib/keys';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { Download } from '@/api/types';

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

export function useDownloadActions() {
  const { t } = useTranslation('library');
  const { toast } = useToast();
  const { pending, run } = usePending<number>();

  const perform = useCallback(
    async function perform(action: DownloadCommand, d: Download, opts?: { deleteFile?: boolean; quiet?: boolean }): Promise<boolean> {
      let ok = false;
      await run(d.id, async () => {
        try {
          await dispatch(action, d, opts?.deleteFile ?? false);
          ok = true;
          // `quiet` lets a batch caller report once instead of per item.
          if (action === 'redownload' && !opts?.quiet) toast({ title: t('redownloadQueued', { title: d.title }), variant: 'success' });
        } catch (err) {
          const e = RpcError.from(err);
          toast({
            title: t(k('actionFailed', action), { title: d.title }),
            description: e.code === 'not_found' ? t('notFoundHint') : e.message,
            variant: 'error',
            // A timeout or dropped connection may succeed on a second attempt.
            action: e.retryable ? { label: t('tryAgain'), onClick: () => void perform(action, d, opts) } : undefined,
          });
        } finally {
          await Promise.all([invalidate('downloads.'), invalidate('myvideos.')]);
        }
      });
      return ok;
    },
    [run, t, toast],
  );

  return { pending, perform };
}
