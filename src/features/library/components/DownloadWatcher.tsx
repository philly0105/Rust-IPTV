/**
 * App-wide download feedback (VL-download-feedback): a download that finishes or fails says so
 * wherever the user is, not only on the Downloads page. A finished one toasts with Play (it plays
 * from the file); a failed one with Retry. One toast id per download, so a retry that fails again
 * replaces its toast instead of stacking.
 *
 * `downloads.update` carries no payload, so the watcher keeps the list observed (the event
 * invalidates it, and an observed query refetches) and compares each answer with the last one.
 * The first answer only sets the baseline: what finished before the app opened stays quiet.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Download, DownloadStatus } from '@/api/types';
import { toast } from '@/ui';

import { errorDescription } from '../deps';
import { playDownload } from '../lib/playDownload';

/** The toast of one download: a later change of the same download updates it in place. */
export const downloadToastId = (id: number) => `download-${id}`;

/** Downloads whose status moved to completed or failed since `before` (new rows that are already done count too). */
export function downloadTransitions(before: ReadonlyMap<number, DownloadStatus>, after: readonly Download[]): { finished: Download[]; failed: Download[] } {
  const finished: Download[] = [];
  const failed: Download[] = [];
  for (const d of after) {
    const was = before.get(d.id);
    if (was === d.status) continue;
    if (d.status === 'completed') finished.push(d);
    else if (d.status === 'failed') failed.push(d);
  }
  return { finished, failed };
}

const nameOf = (d: Download) => (d.subtitle ? `${d.title} · ${d.subtitle}` : d.title);

export function DownloadWatcher() {
  const { t } = useTranslation('library');
  const list = useRpcQuery('downloads.list', undefined, { staleTime: 10_000 });
  const seen = useRef<Map<number, DownloadStatus> | null>(null);

  useEffect(() => {
    const data = list.data;
    if (!data) return;
    const before = seen.current;
    seen.current = new Map(data.map((d) => [d.id, d.status]));
    if (!before) return;
    const { finished, failed } = downloadTransitions(before, data);
    for (const d of finished) {
      toast({
        id: downloadToastId(d.id),
        variant: 'success',
        title: t('downloadDone', { title: nameOf(d) }),
        action: {
          label: t('playOffline'),
          onClick: () => {
            playDownload(d).catch((err: unknown) => toast({ variant: 'error', title: t('playFailed', { title: d.title }), description: errorDescription(err) }));
          },
        },
      });
    }
    for (const d of failed) {
      toast({
        id: downloadToastId(d.id),
        variant: 'error',
        title: t('downloadFailedNamed', { title: nameOf(d) }),
        ...(d.errorMessage ? { description: d.errorMessage } : {}),
        action: {
          label: t('actionRetry'),
          onClick: () => {
            rpc('downloads.retry', { id: d.id }).catch((err: unknown) =>
              toast({ variant: 'error', title: t('actionFailedRetry', { title: d.title }), description: errorDescription(err) }),
            );
          },
        },
      });
    }
  }, [list.data, t]);

  return null;
}
