/**
 * Small marks that say something is running away from its page: a download in the queue on the
 * rail's Downloads row, a recording being written on its Scheduled row, and either on Library's
 * folded More row and the phone tab bar's More tab. A dot in the mark tone (no count, no motion),
 * so it never competes with the current page's tick, with its meaning in screen-reader text that
 * joins the row's name. Each mark reads its own query, so a progress burst re-renders the dot and
 * not the rail.
 */

import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { useActiveDownloads } from '@/features/library/hooks/useActiveDownloads';
import { cn } from '@/ui';

export type ActivityKind = 'downloads' | 'recording' | 'any';

/** The words for what runs, or null when nothing does. */
function useActivityText(kind: ActivityKind): string | null {
  const { t } = useTranslation('shell');
  const { downloading, queued } = useActiveDownloads();
  // The Scheduled page's own query (recordings.update keeps it fresh); only the writing ones count.
  const recordings = useRpcQuery('recordings.list', undefined, { staleTime: 30_000 });
  const recording = recordings.data?.some((r) => r.status === 'recording') ?? false;
  const parts: string[] = [];
  if (kind !== 'recording') {
    if (downloading > 0) parts.push(t('library:summaryDownloading', { count: downloading }));
    else if (queued > 0) parts.push(t('library:summaryQueued', { count: queued }));
  }
  if (kind !== 'downloads' && recording) parts.push(t('live:recordingNow'));
  return parts.length ? parts.join(', ') : null;
}

/**
 * The dot. `corner`: on the top end of an icon (the icon rail, the tab bar), whose box must be
 * `relative`. `end`: at the end of a labelled row. Hidden from assistive tech: `ActivityText`,
 * placed after the row's label, says the same.
 */
export function ActivityMark({ kind, placement }: { kind: ActivityKind; placement: 'corner' | 'end' }) {
  const text = useActivityText(kind);
  if (!text) return null;
  return (
    <span
      aria-hidden
      data-activity-mark={kind}
      className={cn(
        'size-2 shrink-0 rounded-full bg-accent-mark',
        placement === 'corner' ? 'absolute -top-0.5 -end-0.5 ring-2 ring-surface' : 'ms-auto',
      )}
    />
  );
}

/** What the dot means, for screen readers, joining the name of the row it is in: ", 2 downloading". */
export function ActivityText({ kind }: { kind: ActivityKind }) {
  const text = useActivityText(kind);
  return text ? <span className="sr-only">{`, ${text}`}</span> : null;
}
