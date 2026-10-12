/** Small presentational pieces shared by the library pages. */

import { k } from '../lib/keys';
import { Clapperboard, Film, Radio, Tv } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ContentType, DownloadStatus, Source, SourceKind } from '@/api/types';
import { buttonClass } from '@/ui/Button';
import { cn } from '@/ui/cn';

import { Badge, Button, Dialog } from '../deps';

const KIND_LABEL: Record<SourceKind, string> = { m3u: 'M3U', xtream: 'Xtream', stalker: 'Stalker' };

/** Source provenance chip: name plus a tiny kind tag. Deleted sources read as such. */
export function SourceBadge({ source, className }: { source: Source | undefined; className?: string }) {
  const { t } = useTranslation('library');
  return (
    <span
      className={cn(
        'inline-flex max-w-[14rem] items-center gap-1.5 truncate rounded-sm border border-border px-1.5 py-0.5 text-[11px] leading-4 text-fg-muted',
        className,
      )}
      title={source?.name ?? t('sourceRemoved')}
    >
      {source && <span className="font-display text-[10px] font-semibold tracking-wide text-fg-subtle">{KIND_LABEL[source.kind]}</span>}
      <span className="truncate">{source?.name ?? t('sourceRemoved')}</span>
    </span>
  );
}

export function ContentIcon({ type, size = 16, className }: { type: ContentType; size?: number; className?: string }) {
  const Icon = type === 'live' ? Tv : type === 'radio' ? Radio : type === 'series' ? Clapperboard : Film;
  return <Icon aria-hidden size={size} className={className} />;
}

const STATUS_VARIANT: Record<DownloadStatus, 'accent' | 'neutral' | 'warning' | 'danger' | 'outline' | 'success'> = {
  downloading: 'accent',
  queued: 'neutral',
  paused: 'warning',
  failed: 'danger',
  canceled: 'outline',
  completed: 'success',
};

export function StatusBadge({ status, className }: { status: DownloadStatus; className?: string }) {
  const { t } = useTranslation('library');
  return (
    <Badge variant={STATUS_VARIANT[status]} className={className} data-status={status}>
      {t(k('status', status))}
    </Badge>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, danger, busy, children, onConfirm, onClose }: ConfirmDialogProps) {
  const { t } = useTranslation('library');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('keep')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/**
 * The page's single `<h1>`. The shell header shows the same text as a styled
 * paragraph (C16), so this one is visually hidden; pass the exact string given
 * to `usePageHeader` so assistive tech and the window title agree.
 */
export function PageTitle({ children }: { children: string }) {
  return <h1 className="sr-only">{children}</h1>;
}

/** Section header row used inside the virtual lists. */
export function SectionHeading({ title, count, hint }: { title: string; count: number; hint?: string }) {
  return (
    <div className="flex h-full items-end gap-3 px-1 pb-2">
      <h2 className="font-display text-[15px] font-semibold text-fg">{title}</h2>
      <span className="font-display text-[13px] tabular-nums text-fg-subtle">{count}</span>
      {hint && <span className="ms-auto truncate text-xs text-fg-subtle">{hint}</span>}
    </div>
  );
}

/**
 * Empty-state action for Favorites and History: points at where items come
 * from. Inside a source (or when any source exists) it opens that source's
 * channels; with no sources at all it leads to adding one. Renders nothing
 * while sources are still loading so the button never flips.
 */
export function BrowseAction({ sourceId, sources, loading }: { sourceId?: string | undefined; sources: ReadonlyMap<string, Source>; loading?: boolean }) {
  const { t } = useTranslation('library');
  if (loading && !sourceId) return null;
  const target = sourceId ?? sources.keys().next().value;
  if (target) {
    return (
      <Link to={`/s/${encodeURIComponent(target)}/live`} className={buttonClass('primary', 'md')} data-testid="library-empty-browse">
        {t('browseChannels')}
      </Link>
    );
  }
  return (
    <Link to="/sources" className={buttonClass('primary', 'md')} data-testid="library-empty-add-source">
      {t('addSourceAction')}
    </Link>
  );
}
