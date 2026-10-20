/**
 * Row for a favorite or recent entry: artwork, title, what is on (live) or what it is (VOD),
 * source, time, actions.
 *
 * The row itself is the keyboard stop (VirtualRows roves focus between rows), so its buttons stay
 * out of the Tab order. On a fine pointer the actions (Play, the move arrows, remove) and the drag
 * grip appear on hover or keyboard focus, so a page of rows is not a page of buttons; on touch
 * they stay visible, since there is no hover.
 */

import { k } from '../lib/keys';
import { ArrowDown, ArrowUp, GripVertical, Play, X } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemSnapshot, ItemRef, Source } from '@/api/types';
import { snapshotTitle } from '@/lib/title';
import { cn } from '@/ui/cn';

import { IconButton, Poster, ProgressBar } from '../deps';
import type { NowOn } from '../hooks/useNowOn';
import { ContentIcon, SourceBadge } from './bits';

export const ENTRY_ROW_HEIGHT = 64;

export interface EntryRowProps {
  entryRef: ItemRef;
  snapshot: ItemSnapshot;
  /** Shown when the page aggregates several sources. */
  source?: Source | undefined;
  showSource: boolean;
  time: string;
  removeLabel: string;
  busy?: boolean;
  /** The programme on air now, for a live or radio entry with a guide. */
  now?: NowOn | undefined;
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

/**
 * Hidden until hover or keyboard focus on a fine pointer; always visible on touch. `in-focus-visible`
 * covers the focused list item around the row, `focus-within` a focused button inside it.
 */
export const REVEAL_ON_FINE =
  'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:in-focus-visible:opacity-100 pointer-fine:focus-within:opacity-100 motion-safe:transition-opacity';

function EntryRowImpl({ entryRef, snapshot, source, showSource, time, removeLabel, busy, now, onOpen, onRemove, reorder }: EntryRowProps) {
  const { t } = useTranslation('library');
  const type = entryRef.contentType;
  const playable = type === 'live' || type === 'radio';
  const square = playable;
  // Older movie and series snapshots hold the provider's raw name ("EN - Heat (1995)"); show what the VOD cards show.
  const title = snapshotTitle(entryRef, snapshot.title).title;
  const minutesLeft = now ? Math.max(1, Math.round(now.leftSeconds / 60)) : 0;
  return (
    <div
      className={cn(
        'group relative flex h-full items-center gap-3 rounded-md px-2 hover:bg-hover in-focus-visible:bg-hover motion-safe:transition-colors',
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
      {/* Artwork is a mouse shortcut only: the title button beside it and the Play button carry the name for keyboard and AT. */}
      <div
        aria-hidden
        data-testid="entry-artwork"
        onClick={onOpen}
        className={cn('shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-edge', square ? 'w-11' : 'w-8')}
      >
        <Poster src={snapshot.posterUrl} sourceId={entryRef.sourceId} alt="" label={title} aspect={square ? 'square' : 'poster'} />
      </div>
      <button type="button" tabIndex={-1} onClick={onOpen} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start">
        <span dir="auto" className="w-full truncate text-match-parent text-body-sm font-medium text-fg">
          {title}
        </span>
        {now ? (
          // What is on now, as the dashboard's channel cards say it: a guide answers "what is this?"
          // better than "Live channel" under a heading that already says so.
          <span className="flex w-full min-w-0 items-center gap-2 text-caption text-fg-muted" data-testid="entry-now">
            <ProgressBar value={Math.round(now.progress * 100)} max={100} size="xs" className="w-10 shrink-0" label={t('nowProgress', { title: now.title })} />
            <span dir="auto" className="min-w-0 truncate text-match-parent">
              {now.title}
            </span>
            {/* On a phone the programme's name gets the room; the bar still says how far it is. */}
            <span className="shrink-0 tabular-nums text-fg-subtle max-sm:hidden">{t('minutesLeft', { count: minutesLeft })}</span>
          </span>
        ) : (
          <span className="flex w-full min-w-0 items-center gap-1.5 text-caption text-fg-muted">
            <ContentIcon type={type} size={12} className="shrink-0 text-fg-subtle" />
            <span className="shrink-0">{t(k('type', type))}</span>
            {snapshot.subtitle && (
              <span dir="auto" className="truncate text-match-parent">
                {snapshot.subtitle}
              </span>
            )}
          </span>
        )}
      </button>
      {/* A fixed column, so the monograms line up down the list. */}
      {showSource && <SourceBadge source={source} className="hidden w-40 shrink-0 md:inline-flex" />}
      {/* One line at any length ("Added 2 minutes ago"): rows keep one height, and the end-aligned
          column still lines up with the actions beside it. */}
      <span className="hidden min-w-28 shrink-0 whitespace-nowrap text-end text-caption tabular-nums text-fg-subtle sm:block" data-testid="entry-time">
        {time}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {reorder && (
          <>
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveUp', { title })}
              icon={<ArrowUp size={14} aria-hidden />}
              disabled={!reorder.canUp || busy}
              onClick={() => reorder.onMove(-1)}
              className={REORDER_ARROW}
            />
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveDown', { title })}
              icon={<ArrowDown size={14} aria-hidden />}
              disabled={!reorder.canDown || busy}
              onClick={() => reorder.onMove(1)}
              className={REORDER_ARROW}
            />
          </>
        )}
        <IconButton
          size="sm"
          tabIndex={-1}
          variant="ghost"
          label={playable ? t('playTitle', { title }) : t('openTitle', { title })}
          icon={<Play size={14} aria-hidden className="fill-current" />}
          onClick={onOpen}
          className={cn('rounded-full', REVEAL_ON_FINE)}
          data-action="open"
        />
        <IconButton
          size="sm"
          tabIndex={-1}
          label={removeLabel}
          icon={<X size={14} aria-hidden />}
          disabled={busy}
          onClick={onRemove}
          className={cn('hover:text-danger', REVEAL_ON_FINE)}
          data-action="remove"
        />
      </div>
      {/* The drag handle sits last, after the row's buttons (the iOS reorder control's place), so
          the artwork keeps the page's left edge with the headings. */}
      {reorder && (
        <span
          draggable
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
          className={cn(
            '-me-1 hidden h-10 w-5 shrink-0 cursor-grab items-center justify-center text-fg-subtle hover:text-fg active:cursor-grabbing pointer-fine:flex',
            REVEAL_ON_FINE,
          )}
          title={t('dragToReorder')}
          aria-hidden
        >
          <GripVertical size={16} />
        </span>
      )}
    </div>
  );
}

/**
 * Move up/down arrows: shown on hover or focus only when they can move the row
 * (a disabled arrow stays invisible, overriding the kit's disabled:opacity-50),
 * and left out of the layout below sm so titles keep their width on a phone
 * (drag and Alt+arrow still reorder there).
 */
const REORDER_ARROW =
  'hidden sm:inline-flex opacity-0 disabled:opacity-0 enabled:group-hover:opacity-100 enabled:group-focus-within:opacity-100 enabled:in-focus-visible:opacity-100';

export const EntryRow = memo(EntryRowImpl);
