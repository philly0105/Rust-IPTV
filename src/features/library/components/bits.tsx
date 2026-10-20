/** Small presentational pieces shared by the library pages. */

import { k } from '../lib/keys';
import { Clapperboard, Film, Pause, Radio, Tv } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ContentType, DownloadStatus, Source } from '@/api/types';
import { buttonClass } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { hueOf, initialsOf } from '@/ui/Poster';

import { Badge, Button, Dialog } from '../deps';

/**
 * Source provenance: the rail's monogram (same hue, so a source is recognised at a glance) and
 * the name in quiet text, no outline. Rows show it only where the page mixes sources, and a page
 * whose rows all share one source can leave it out. Deleted sources read as such.
 */
export function SourceBadge({ source, className }: { source: Source | undefined; className?: string }) {
  const { t } = useTranslation('library');
  const name = source?.name ?? t('sourceRemoved');
  return (
    <span className={cn('inline-flex min-w-0 max-w-[14rem] items-center gap-1.5 text-caption text-fg-subtle', className)} title={name} data-testid="source-badge">
      {source && <SourceMonogram name={source.name} />}
      <span dir="auto" className="truncate">
        {name}
      </span>
    </span>
  );
}

/** The rail's source monogram at 16 px: two initials on the source's own hue. Decorative; the name sits beside it. */
export function SourceMonogram({ name, className }: { name: string; className?: string }) {
  const hue = hueOf(name);
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-xs font-display text-[calc(8rem/15)] font-semibold leading-none text-white', className)}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 42% 38%), hsl(${(hue + 36) % 360} 48% 24%))` }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function ContentIcon({ type, size = 16, className }: { type: ContentType; size?: number; className?: string }) {
  const Icon = type === 'live' ? Tv : type === 'radio' ? Radio : type === 'series' ? Clapperboard : Film;
  return <Icon aria-hidden size={size} className={className} />;
}

/**
 * Only the running transfer takes the accent (as text on a neutral chip); paused and queued are
 * neutral, paused with its glyph, so a paused row no longer reads as the warning-yellow twin of a
 * downloading one.
 */
const STATUS_VARIANT: Record<DownloadStatus, 'accent' | 'neutral' | 'warning' | 'danger' | 'outline' | 'success'> = {
  downloading: 'accent',
  queued: 'neutral',
  paused: 'neutral',
  failed: 'danger',
  canceled: 'outline',
  completed: 'success',
};

export function StatusBadge({ status, className }: { status: DownloadStatus; className?: string }) {
  const { t } = useTranslation('library');
  return (
    <Badge variant={STATUS_VARIANT[status]} className={className} data-status={status}>
      {status === 'paused' && <Pause aria-hidden size={12} className="shrink-0" />}
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

/**
 * A section's heading row in a virtual list: title, count, an optional hint and an action at the
 * end. The lists bleed their rows' hover fill into the gutter (`-mx-2` on the scroller, `px-2` on
 * each row), and the heading takes the rows' padding too, so heading, artwork and the header
 * title share one line.
 */
export function SectionHeading({ title, count, hint, action }: { title: string; count: number; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full items-end gap-3 px-2 pb-2">
      <h2 className="text-title-sm text-fg">{title}</h2>
      <span className="text-body-sm tabular-nums text-fg-subtle">{count}</span>
      {hint && <span className="ms-auto hidden min-w-0 truncate text-xs text-fg-subtle sm:inline">{hint}</span>}
      {action && <span className={cn('ms-auto shrink-0', hint && 'sm:ms-0')}>{action}</span>}
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
