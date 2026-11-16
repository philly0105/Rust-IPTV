/**
 * One /my-list row: the rank in the user's order, the artwork, the title with
 * its facts and how far you got, and the row's actions (Play, watched tick for
 * movies, move up/down, remove). VL-mylist-rows: the list is a place to start
 * watching from, so a row plays (resuming where you left off) as well as opens.
 *
 * The row itself is the keyboard stop (VirtualRows roves focus between rows),
 * so its buttons stay out of the Tab order: Enter, Delete, W and Alt+arrows
 * act on the focused row, and the buttons serve pointer and screen reader
 * users. From `sm` up the row is one line with the actions at its end; on
 * fine pointers the move buttons appear on hover or focus and a grip starts a
 * drag, and on touch they stay visible, since there is no hover. Below `sm`
 * (a phone, or a narrow window) the title gets the row's full width: the rank
 * sits on the poster's corner, the grip is gone, and the actions take a line
 * of their own under the title, always visible.
 */

import { ArrowDown, ArrowUp, Check, CircleCheck, Clapperboard, EllipsisVertical, Film, GripVertical, Play, X } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Source, WatchlistEntry } from '@/api/types';
import { snapshotTitle } from '@/lib/title';
import { joinList } from '@/shell/dashboard/cards';

import { IconButton, Poster, PosterCellWidthContext, ProgressBar, cn, useMediaQuery, usePosterWidthBox, useScaledPx } from '../deps';

/**
 * Fixed row height for the virtual list: a 48 x 72 poster plus breathing room,
 * and room below `sm` for a two-line title, its facts and the actions line.
 */
export const ROW_HEIGHT = 104;

/**
 * The page's reorder handlers. One object serves every row and stays the same
 * across renders, so a row re-renders only when its own props change.
 */
export interface RowReorder {
  onMove: (entry: WatchlistEntry, delta: -1 | 1) => void;
  onDragStart: (entry: WatchlistEntry, e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (entry: WatchlistEntry, e: DragEvent<HTMLElement>) => void;
  onDrop: (entry: WatchlistEntry, e: DragEvent<HTMLElement>) => void;
}

/**
 * Every prop is a value or a handler the page keeps stable (the handlers take
 * the entry), so the memoized row skips a re-render when a refetch returns
 * the same list (L3-vod-7).
 */
export interface MyListRowProps {
  entry: WatchlistEntry;
  /** 1-based place in the user's order; omitted when another sort is active. */
  rank?: string;
  /** Shown when the list spans several sources. */
  source?: Source;
  added: string;
  addedTitle: string;
  busy: boolean;
  /** Set while the user's order is shown: the row can be moved. */
  reorder?: RowReorder;
  canUp?: boolean;
  canDown?: boolean;
  /** This row is being dragged. */
  dragging?: boolean;
  /** A drag hovers this row: the drop lands before or after it. */
  dropTarget?: 'before' | 'after' | null;
  onOpen: (entry: WatchlistEntry) => void;
  onRemove: (entry: WatchlistEntry) => void;
  onToggleWatched: (entry: WatchlistEntry) => void;
  /**
   * The title's menu at `pos` (library-05/07): a right click, or on touch the row's one ⋮ button,
   * which stands in for the inline move, watched and remove buttons.
   */
  onMenu?: ((entry: WatchlistEntry, pos: { x: number; y: number }) => void) | undefined;
  /** Plays the title, resuming a saved position; absent when it cannot play from here (a series not started). */
  onPlay?: ((entry: WatchlistEntry) => void) | undefined;
  /** 0..1 of the saved position, drawn as a bar under the facts. */
  progress?: number | undefined;
  /** What the bar stands for: "12 minutes left", or the episode a series resumes. */
  progressLabel?: string | undefined;
}

/**
 * From `sm` up, hidden until hover or focus on a fine pointer; always visible
 * on touch. Below `sm` the actions have their own line, so they never hide.
 */
const revealOnFine =
  'sm:pointer-fine:opacity-0 sm:pointer-fine:group-hover:opacity-100 sm:pointer-fine:in-focus-visible:opacity-100 sm:pointer-fine:focus-within:opacity-100 motion-safe:transition-opacity';

/** On touch these sit in the row's one menu (library-07) instead of on the row. */
const TOUCH_IN_MENU = 'pointer-coarse:hidden';

/** The artwork's box, `w-12 sm:w-14`: spacing steps of 3.75 px at 100 % scale. */
const ART_PX = 45;
const ART_SM_PX = 52.5;
/** Tailwind's `sm` breakpoint. */
const SM_QUERY = '(min-width: 40rem)';

function MyListRowImpl({
  entry,
  rank,
  source,
  added,
  addedTitle,
  busy,
  reorder,
  canUp = false,
  canDown = false,
  dragging = false,
  dropTarget = null,
  onOpen: openEntry,
  onRemove: removeEntry,
  onToggleWatched: toggleEntry,
  onMenu,
  onPlay: playEntry,
  progress,
  progressLabel,
}: MyListRowProps) {
  const { t, i18n } = useTranslation('mylist');
  const { ref, snapshot, watched } = entry;
  // Older snapshots hold the provider's raw name ("EN - Heat (1995)"); show what the VOD cards show.
  const title = snapshotTitle(ref, snapshot.title).title;
  const movie = ref.contentType === 'movie';
  const TypeIcon = movie ? Film : Clapperboard;
  // P2-POSTERS-2: the artwork's width is known, so it does not read its frame as it mounts.
  const artWidth = usePosterWidthBox(useScaledPx(useMediaQuery(SM_QUERY) ? ART_SM_PX : ART_PX, true));
  const onOpen = () => openEntry(entry);

  return (
    <div
      className={cn(
        // Below sm a grid: the poster spans two lines, the title above the actions. From sm up one flex line.
        'group relative grid h-full grid-cols-[3rem_minmax(0,1fr)] content-center items-center gap-x-3 gap-y-1 rounded-lg px-1.5',
        'sm:flex sm:gap-4 sm:px-3',
        'hover:bg-hover in-focus-visible:bg-hover motion-safe:transition-colors',
        dragging && 'opacity-40',
        busy && 'cursor-progress',
      )}
      data-mylist-key={`${ref.sourceId}|${ref.contentType}|${ref.itemId}`}
      data-testid="mylist-row"
      data-content-type={ref.contentType}
      data-watched={watched || undefined}
      onDragOver={reorder ? (e) => reorder.onDragOver(entry, e) : undefined}
      onDrop={reorder ? (e) => reorder.onDrop(entry, e) : undefined}
      onDoubleClick={onOpen}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(entry, { x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      {reorder && dropTarget && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent-mark',
            dropTarget === 'before' ? 'top-0' : 'bottom-0',
          )}
        />
      )}

      {rank !== undefined && (
        // The place in the queue: a quiet number, so the artwork and the title lead the row.
        <span
          aria-hidden
          className={cn(
            'leading-none font-medium tabular',
            // Below sm: a small plate on the poster's top corner, so the title keeps the width.
            'absolute start-2.5 top-[calc(50%-32px)] z-10 min-w-5 rounded-sm bg-glass-strong px-1 py-0.5 text-center text-xs text-on-glass',
            'sm:static sm:w-6 sm:min-w-0 sm:shrink-0 sm:rounded-none sm:bg-transparent sm:p-0 sm:text-end sm:text-sm sm:text-fg-subtle',
            'sm:group-hover:text-fg-muted sm:in-focus-visible:text-fg-muted motion-safe:transition-colors',
          )}
          data-testid="mylist-rank"
        >
          {rank}
        </span>
      )}

      {reorder && (
        <span
          draggable
          onDragStart={(e) => reorder.onDragStart(entry, e)}
          onDragEnd={reorder.onDragEnd}
          title={t('dragHandle')}
          aria-hidden
          className={cn(
            'hidden h-12 w-4 shrink-0 cursor-grab items-center justify-center text-fg-subtle hover:text-fg active:cursor-grabbing sm:pointer-fine:flex',
            revealOnFine,
          )}
          data-testid="mylist-drag"
        >
          <GripVertical size={16} />
        </span>
      )}

      {/* Artwork is a mouse shortcut: the title button carries the name for keyboard and AT. */}
      <div aria-hidden onClick={onOpen} className="row-span-2 w-12 shrink-0 cursor-pointer self-center overflow-hidden rounded-md shadow-1 ring-1 ring-edge sm:w-14">
        <PosterCellWidthContext.Provider value={artWidth}>
          <Poster src={snapshot.posterUrl} sourceId={ref.sourceId} alt="" label={title} aspect="poster" />
        </PosterCellWidthContext.Provider>
      </div>

      <button
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        className="col-start-2 row-start-1 flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm text-start sm:gap-1"
        data-action="open"
        data-testid="mylist-open"
      >
        {/* Two lines before the ellipsis: a phone row is narrow and titles run long. */}
        <span
          dir="auto"
          className="line-clamp-2 w-full text-match-parent text-[calc(15rem/15)] leading-5 font-medium [overflow-wrap:anywhere] text-fg"
          title={title}
          data-testid="mylist-title"
        >
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
        {progress !== undefined && progress > 0 && (
          <span className="flex w-full min-w-0 items-center gap-2 text-xs text-fg-muted" data-testid="mylist-progress">
            <ProgressBar value={progress} max={1} size="xs" className="w-24 shrink-0 sm:w-32" label={progressLabel} />
            {progressLabel && <span className="tabular min-w-0 truncate">{progressLabel}</span>}
          </span>
        )}
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

      {/* Below sm the actions line sits under the title (grid column 2); move first, remove at the far end. */}
      <div className="col-start-2 row-start-2 flex min-w-0 items-center gap-1 sm:shrink-0" data-testid="mylist-actions">
        {playEntry ? (
          <IconButton
            size="sm"
            variant="secondary"
            tabIndex={-1}
            label={progress ? t('resumeTitle', { title }) : t('playTitle', { title })}
            icon={<Play aria-hidden size={14} className="fill-current" />}
            disabled={busy}
            onClick={() => playEntry(entry)}
            // On touch the Play circle stays only for a title with progress to resume (library-07).
            className={cn('rounded-full', revealOnFine, onMenu && !(progress && progress > 0) && 'pointer-coarse:hidden')}
            data-action="play"
          />
        ) : (
          <span aria-hidden className={cn('h-8 w-8 shrink-0', onMenu && 'pointer-coarse:hidden')} />
        )}
        {movie ? (
          <IconButton
            size="sm"
            tabIndex={-1}
            label={t('markWatched', { title })}
            tooltip={watched ? t('watchedHintOn') : t('watchedHintOff')}
            pressed={watched}
            disabled={busy}
            // One glyph in both states (an empty circle read as a radio button); the colour and the pressed state carry it.
            icon={<CircleCheck aria-hidden size={18} />}
            onClick={() => toggleEntry(entry)}
            className={cn(watched ? 'bg-transparent text-success hover:text-success' : cn('text-fg-subtle', revealOnFine), onMenu && TOUCH_IN_MENU)}
            data-action="watched"
          />
        ) : (
          // Series are marked watched on their own page, episode by episode; keep the columns aligned.
          <span aria-hidden className={cn('h-8 w-8 shrink-0', onMenu && TOUCH_IN_MENU)} />
        )}
        {reorder && (
          <div className={cn('order-first flex gap-1 sm:order-none sm:flex-col sm:gap-0', revealOnFine, onMenu && TOUCH_IN_MENU)} data-testid="mylist-move">
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveUp', { title })}
              icon={<ArrowUp aria-hidden size={14} />}
              disabled={!canUp || busy}
              onClick={() => reorder.onMove(entry, -1)}
              // The end a row cannot move past is not drawn (library-08), as on Favorites; invisible,
              // so the other arrow keeps its place in the stack.
              className={cn('sm:h-7 sm:rounded-b-none', !canUp && 'invisible')}
              data-action="move-up"
            />
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t('moveDown', { title })}
              icon={<ArrowDown aria-hidden size={14} />}
              disabled={!canDown || busy}
              onClick={() => reorder.onMove(entry, 1)}
              className={cn('sm:h-7 sm:rounded-t-none', !canDown && 'invisible')}
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
          onClick={() => removeEntry(entry)}
          className={cn('ms-auto hover:text-danger sm:ms-0', revealOnFine, onMenu && TOUCH_IN_MENU)}
          data-action="remove"
        />
        {onMenu && (
          // Touch: one button for the moves, the watched mark and remove, as a Favorites row has
          // (library-07): five always-visible targets put remove a thumb away from Play.
          <IconButton
            tabIndex={-1}
            label={t('library:entryMenu', { title })}
            aria-haspopup="menu"
            icon={<EllipsisVertical aria-hidden size={18} />}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(entry, { x: document.documentElement.dir === 'rtl' ? r.right : r.left, y: r.bottom + 2 });
            }}
            className="ms-auto shrink-0 not-pointer-coarse:hidden sm:ms-0"
            data-action="menu"
          />
        )}
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
        <div key={i} aria-hidden className="flex items-center gap-3 px-1.5 sm:gap-4 sm:px-3" style={{ height: ROW_HEIGHT }}>
          <div className="hidden w-6 shrink-0 sm:block" />
          <div className="skeleton-surface h-[72px] w-12 shrink-0 rounded-md motion-safe:animate-shimmer sm:h-[84px] sm:w-14" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="skeleton-surface h-3.5 rounded-sm motion-safe:animate-shimmer" style={{ width: `${70 - (i % 3) * 12}%` }} />
            <div className="skeleton-surface h-3 w-1/3 rounded-sm opacity-70 motion-safe:animate-shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}
