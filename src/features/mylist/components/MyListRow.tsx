/**
 * One /my-list row: the rank in the user's order, the artwork, the title with
 * its facts, and the row's actions (watched tick for movies, move up/down,
 * remove).
 *
 * The row itself is the keyboard stop (VirtualRows roves focus between rows),
 * so its buttons stay out of the Tab order: Enter, Delete, W and Alt+arrows
 * act on the focused row, and the buttons serve pointer and screen reader
 * users. On fine pointers the move buttons appear on hover or focus and a grip
 * starts a drag; on touch they stay visible, since there is no hover.
 */

import { Check, ChevronDown, ChevronUp, Circle, CircleCheck, Clapperboard, Film, GripVertical, X } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Source, WatchlistEntry } from '@/api/types';

import { IconButton, Poster, cn, joinList } from '../deps';

/** Fixed row height for the virtual list: a 48 x 72 poster plus breathing room. */
export const ROW_HEIGHT = 88;

export interface RowReorder {
  canUp: boolean;
  canDown: boolean;
  onMove: (delta: -1 | 1) => void;
  dragging: boolean;
  dropTarget: 'before' | 'after' | null;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

export interface MyListRowProps {
  entry: WatchlistEntry;
  /** 1-based place in the user's order; omitted when another sort is active. */
  rank?: string;
  /** Shown when the list spans several sources. */
  source?: Source;
  added: string;
  addedTitle: string;
  busy: boolean;
  reorder?: RowReorder;
  onOpen: () => void;
  onRemove: () => void;
  onToggleWatched: () => void;
}

/** Hidden until hover or focus on a fine pointer; always visible on touch. */
const revealOnFine =
  'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:in-focus-visible:opacity-100 pointer-fine:focus-within:opacity-100 motion-safe:transition-opacity';

function MyListRowImpl({ entry, rank, source, added, addedTitle, busy, reorder, onOpen, onRemove, onToggleWatched }: MyListRowProps) {
  const { t, i18n } = useTranslation('mylist');
  const { ref, snapshot, watched } = entry;
  const title = snapshot.title;
  const movie = ref.contentType === 'movie';
  const TypeIcon = movie ? Film : Clapperboard;

  return (
    <div
      className={cn(
        'group relative flex h-full items-center gap-2.5 rounded-lg px-1.5 sm:gap-4 sm:px-3',
        'hover:bg-surface-2 in-focus-visible:bg-surface-2 motion-safe:transition-colors',
        reorder?.dragging && 'opacity-40',
        busy && 'cursor-progress',
      )}
      data-mylist-key={`${ref.sourceId}|${ref.contentType}|${ref.itemId}`}
      data-testid="mylist-row"
      data-content-type={ref.contentType}
      data-watched={watched || undefined}
      onDragOver={reorder?.onDragOver}
      onDrop={reorder?.onDrop}
      onDoubleClick={onOpen}
    >
      {reorder?.dropTarget && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-glow)]',
            reorder.dropTarget === 'before' ? 'top-0' : 'bottom-0',
          )}
        />
      )}

      {rank !== undefined && (
        // The place in the queue, set like a tuner preset: the one loud element on the page.
        <span
          aria-hidden
          className={cn(
            'w-7 shrink-0 text-end font-display text-2xl leading-none font-semibold tabular text-fg-subtle sm:w-12 sm:text-4xl',
            'group-hover:text-accent in-focus-visible:text-accent motion-safe:transition-colors',
          )}
          data-testid="mylist-rank"
        >
          {rank}
        </span>
      )}

      {reorder && (
        <span
          draggable
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
          title={t('dragHandle')}
          aria-hidden
          className={cn(
            'hidden h-12 w-4 shrink-0 cursor-grab items-center justify-center text-fg-subtle hover:text-fg active:cursor-grabbing pointer-fine:flex',
            revealOnFine,
          )}
          data-testid="mylist-drag"
        >
          <GripVertical size={16} />
        </span>
      )}

      {/* Artwork is a mouse shortcut: the title button carries the name for keyboard and AT. */}
      <div aria-hidden onClick={onOpen} className="w-12 shrink-0 cursor-pointer overflow-hidden rounded-md shadow-1">
        <Poster src={snapshot.posterUrl} alt="" label={title} aspect="poster" />
      </div>

      <button
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-sm text-start"
        data-action="open"
      >
        <span dir="auto" className="w-full truncate text-match-parent text-[calc(15rem/15)] leading-5 font-medium text-fg">
          {title}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <TypeIcon aria-hidden size={13} className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 truncate">{joinList([movie ? t('typeMovie') : t('typeSeries'), snapshot.subtitle], i18n.language)}</span>
          {watched && (
            <span className="ms-1 inline-flex shrink-0 items-center gap-1 font-medium text-success" data-testid="mylist-watched">
              <Check aria-hidden size={12} strokeWidth={2.75} />
              {t('watched')}
            </span>
          )}
        </span>
        <span className="hidden w-full min-w-0 items-center gap-2 text-xs text-fg-subtle sm:flex">
          {source && (
            <span
              className="inline-flex max-w-[14rem] min-w-0 items-center truncate rounded-sm border border-divider px-1.5 leading-[18px] text-fg-muted"
              title={source.name}
              data-testid="mylist-source"
            >
              <span dir="auto" className="truncate">
                {source.name}
              </span>
            </span>
          )}
          <span className="truncate" title={addedTitle}>
            {added}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {movie ? (
          <IconButton
            size="sm"
            tabIndex={-1}
            label={t('markWatched', { title })}
            title={watched ? t('watchedHintOn') : t('watchedHintOff')}
            pressed={watched}
            disabled={busy}
            icon={watched ? <CircleCheck aria-hidden size={18} /> : <Circle aria-hidden size={18} />}
            onClick={onToggleWatched}
            className={cn(watched ? 'bg-transparent text-success hover:text-success' : 'text-fg-subtle')}
            data-action="watched"
          />
        ) : (
          // Series are marked watched on their own page, episode by episode; keep the columns aligned.
          <span aria-hidden className="h-8 w-8 shrink-0" />
        )}
        {reorder && (
          <div className={cn('flex flex-col', revealOnFine)}>
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveUp', { title })}
              icon={<ChevronUp aria-hidden size={16} />}
              disabled={!reorder.canUp || busy}
              onClick={() => reorder.onMove(-1)}
              className="h-7 rounded-b-none"
              data-action="move-up"
            />
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveDown', { title })}
              icon={<ChevronDown aria-hidden size={16} />}
              disabled={!reorder.canDown || busy}
              onClick={() => reorder.onMove(1)}
              className="h-7 rounded-t-none"
              data-action="move-down"
            />
          </div>
        )}
        <IconButton
          size="sm"
          tabIndex={-1}
          label={t('remove', { title })}
          icon={<X aria-hidden size={16} />}
          disabled={busy}
          onClick={onRemove}
          className="hover:text-danger"
          data-action="remove"
        />
      </div>
    </div>
  );
}

export const MyListRow = memo(MyListRowImpl);

/** Placeholder rows with the real geometry, so nothing jumps when the list arrives. */
export function MyListSkeleton({ rows = 7, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col" data-testid="mylist-loading">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex items-center gap-2.5 px-1.5 sm:gap-4 sm:px-3" style={{ height: ROW_HEIGHT }}>
          <div className="w-7 shrink-0 sm:w-12" />
          <div className="skeleton-surface h-[72px] w-12 shrink-0 rounded-md motion-safe:animate-shimmer" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="skeleton-surface h-3.5 rounded-sm motion-safe:animate-shimmer" style={{ width: `${70 - (i % 3) * 12}%` }} />
            <div className="skeleton-surface h-3 w-1/3 rounded-sm opacity-70 motion-safe:animate-shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}
