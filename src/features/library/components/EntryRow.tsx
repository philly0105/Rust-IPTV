/** Row for a favorite or recent entry: artwork, title, type, source, time, actions. */

import { k } from '../lib/keys';
import { ArrowDown, ArrowUp, GripVertical, Play, X } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemSnapshot, ItemRef, Source } from '@/api/types';
import { snapshotTitle } from '@/lib/title';
import { cn } from '@/ui/cn';

import { IconButton, Poster } from '../deps';
import { ContentIcon, SourceBadge } from './bits';

export const ENTRY_ROW_HEIGHT = 68;

export interface EntryRowProps {
  entryRef: ItemRef;
  snapshot: ItemSnapshot;
  /** Shown when the page aggregates several sources. */
  source?: Source | undefined;
  showSource: boolean;
  time: string;
  removeLabel: string;
  busy?: boolean;
  onOpen: () => void;
  onRemove: () => void;
  /** Reorder affordances (favorites only). */
  reorder?: {
    canUp: boolean;
    canDown: boolean;
    onMove: (delta: -1 | 1) => void;
    dragging: boolean;
    dropTarget: 'before' | 'after' | null;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
}

function EntryRowImpl({ entryRef, snapshot, source, showSource, time, removeLabel, busy, onOpen, onRemove, reorder }: EntryRowProps) {
  const { t } = useTranslation('library');
  const type = entryRef.contentType;
  const playable = type === 'live' || type === 'radio';
  const square = playable;
  // Older movie and series snapshots hold the provider's raw name ("EN - Heat (1995)"); show what the VOD cards show.
  const title = snapshotTitle(entryRef, snapshot.title).title;
  return (
    <div
      className={cn(
        'group relative flex h-full items-center gap-3 rounded-md px-2 hover:bg-surface-2',
        reorder?.dragging && 'opacity-40',
      )}
      data-testid="entry-row"
      data-content-type={type}
      onDragOver={reorder?.onDragOver}
      onDrop={reorder?.onDrop}
      onDoubleClick={onOpen}
    >
      {reorder?.dropTarget && (
        <div
          aria-hidden
          className={cn('pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent', reorder.dropTarget === 'before' ? 'top-0' : 'bottom-0')}
        />
      )}
      {reorder && (
        <span
          draggable
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
          className="flex h-10 w-5 shrink-0 cursor-grab items-center justify-center text-fg-subtle hover:text-fg active:cursor-grabbing"
          title={t('dragToReorder')}
          aria-hidden
        >
          <GripVertical size={16} />
        </span>
      )}
      {/* Artwork is a mouse shortcut only: the title button beside it and the Play button carry the name for keyboard and AT. */}
      <div aria-hidden data-testid="entry-artwork" onClick={onOpen} className={cn('shrink-0 cursor-pointer overflow-hidden rounded-sm', square ? 'w-12' : 'w-9')}>
        <Poster src={snapshot.posterUrl} sourceId={entryRef.sourceId} alt="" label={title} aspect={square ? 'square' : 'poster'} />
      </div>
      <button type="button" tabIndex={-1} onClick={onOpen} className="flex min-w-0 flex-1 flex-col items-start text-start">
        <span dir="auto" className="w-full truncate text-match-parent text-sm font-medium text-fg">
          {title}
        </span>
        <span className="flex w-full min-w-0 items-center gap-2 text-xs text-fg-muted">
          <ContentIcon type={type} size={13} className="shrink-0 text-fg-subtle" />
          <span className="shrink-0">{t(k('type', type))}</span>
          {snapshot.subtitle && (
            <span dir="auto" className="truncate text-match-parent">
              {snapshot.subtitle}
            </span>
          )}
        </span>
      </button>
      {showSource && <SourceBadge source={source} className="hidden shrink-0 md:inline-flex" />}
      {/* One line at any length ("Added 2 minutes ago"): rows keep one height, and the end-aligned
          column still lines up with the actions beside it. */}
      <span className="hidden min-w-28 shrink-0 whitespace-nowrap text-end text-xs text-fg-subtle sm:block" data-testid="entry-time">
        {time}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {reorder && (
          <>
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveUp', { title })}
              icon={<ArrowUp size={15} aria-hidden />}
              disabled={!reorder.canUp || busy}
              onClick={() => reorder.onMove(-1)}
              className={REORDER_ARROW}
            />
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveDown', { title })}
              icon={<ArrowDown size={15} aria-hidden />}
              disabled={!reorder.canDown || busy}
              onClick={() => reorder.onMove(1)}
              className={REORDER_ARROW}
            />
          </>
        )}
        <IconButton
          size="sm"
          tabIndex={-1}
          variant="secondary"
          label={playable ? t('playTitle', { title }) : t('openTitle', { title })}
          icon={<Play size={15} aria-hidden />}
          onClick={onOpen}
          data-action="open"
        />
        <IconButton size="sm" tabIndex={-1} label={removeLabel} icon={<X size={15} aria-hidden />} disabled={busy} onClick={onRemove} data-action="remove" />
      </div>
    </div>
  );
}

/**
 * Move up/down arrows: shown on hover or focus only when they can move the row
 * (a disabled arrow stays invisible, overriding the kit's disabled:opacity-50),
 * and left out of the layout below sm so titles keep their width on a phone
 * (drag and Alt+arrow still reorder there).
 */
const REORDER_ARROW = 'hidden sm:inline-flex opacity-0 disabled:opacity-0 enabled:group-hover:opacity-100 enabled:group-focus-within:opacity-100';

export const EntryRow = memo(EntryRowImpl);
