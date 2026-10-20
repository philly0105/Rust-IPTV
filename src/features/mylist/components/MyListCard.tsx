/**
 * One /my-list title in the grid view: the poster with the shared card states, how far you got as
 * a glass bar on the artwork, a watched chip, and a remove button that shows on hover or keyboard
 * focus (not on touch, where it would sit on every poster). The grid's list item is the card root and the keyboard stop, so the
 * button stays out of the Tab order; Enter, Delete, W and Alt+arrows act on the focused card, as
 * on a row of the list view.
 */

import { Check, X } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { WatchlistEntry } from '@/api/types';
import { snapshotTitle } from '@/lib/title';
import { joinList } from '@/shell/dashboard/cards';
import { CARD_ART } from '@/ui/card';

import { IconButton, Poster, ProgressBar, cn } from '../deps';

/** Caption under the poster: the title and one line of facts. */
export const CARD_CAPTION_HEIGHT = 52;

export interface MyListCardProps {
  entry: WatchlistEntry;
  busy: boolean;
  /** 0..1 of the saved position, drawn on the artwork. */
  progress?: number | undefined;
  /** What the bar stands for: "12 minutes left", or the episode a series resumes. */
  progressLabel?: string | undefined;
  onRemove: (entry: WatchlistEntry) => void;
}

/**
 * Hidden until hover or keyboard focus on a fine pointer. On touch there is no hover, and a
 * button on every poster covers the artwork (critique: phone posters), so it is left out there:
 * the list view, the title's page and Delete remove a title.
 */
const REVEAL =
  'pointer-coarse:hidden pointer-fine:opacity-0 pointer-fine:group-hover/card:opacity-100 pointer-fine:in-focus-visible:opacity-100 pointer-fine:focus-visible:opacity-100 motion-safe:transition-opacity';

function MyListCardImpl({ entry, busy, progress, progressLabel, onRemove }: MyListCardProps) {
  const { t, i18n } = useTranslation('mylist');
  const { ref, snapshot, watched } = entry;
  const title = snapshotTitle(ref, snapshot.title).title;
  const movie = ref.contentType === 'movie';
  const meta = joinList([movie ? t('typeMovie') : t('typeSeries'), progressLabel ?? snapshot.subtitle], i18n.language);

  return (
    <div
      className={cn('flex h-full flex-col gap-2', busy && 'cursor-progress')}
      data-mylist-key={`${ref.sourceId}|${ref.contentType}|${ref.itemId}`}
      data-testid="mylist-card"
      data-content-type={ref.contentType}
      data-watched={watched || undefined}
    >
      <div className={CARD_ART}>
        {/* The frame's ring is the edge; the poster's own hairline would double it. */}
        <Poster src={snapshot.posterUrl} sourceId={ref.sourceId} alt="" label={title} aspect="poster" className="after:hidden" />
        {watched && (
          <span
            className="absolute start-1.5 top-1.5 inline-flex items-center gap-1 rounded-sm bg-glass-strong px-1.5 py-0.5 text-xs font-medium text-on-glass"
            data-testid="mylist-watched"
          >
            <Check aria-hidden size={12} strokeWidth={2.75} />
            {t('watched')}
          </span>
        )}
        {progress !== undefined && progress > 0 && (
          <ProgressBar value={Math.round(progress * 100)} max={100} size="xs" tone="glass" className="absolute inset-x-2 bottom-2 w-auto" label={progressLabel} />
        )}
        <IconButton
          size="sm"
          tabIndex={-1}
          tooltipTone="glass"
          label={t('remove', { title })}
          icon={<X aria-hidden size={16} />}
          disabled={busy}
          onClick={(e) => {
            // The card itself opens the title; this button only removes it.
            e.stopPropagation();
            onRemove(entry);
          }}
          className={cn('absolute end-1.5 top-1.5 h-8 w-8 rounded-full bg-glass-strong text-on-glass hover:bg-glass hover:text-on-glass', REVEAL)}
          data-action="remove"
        />
      </div>
      <div className="flex min-w-0 flex-col" style={{ height: CARD_CAPTION_HEIGHT - 8 }}>
        <span dir="auto" className="truncate text-match-parent text-body-sm font-medium text-fg" title={title} data-testid="mylist-title">
          {title}
        </span>
        <span dir="auto" className="truncate text-match-parent text-caption text-fg-muted">
          {meta}
        </span>
      </div>
    </div>
  );
}

export const MyListCard = memo(MyListCardImpl);
