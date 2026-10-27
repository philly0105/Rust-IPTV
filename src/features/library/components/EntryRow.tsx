/**
 * Row for a favorite or recent entry: artwork, title, what is on (live) or what it is (VOD),
 * source, time, actions.
 *
 * Drawn like Live TV's channel rows, so a channel looks the same here as in its list: the
 * channel's own logo tile (or its monogram), its name, the programme on now with the time left,
 * and a quiet progress line under them; a movie or series keeps a small poster in the same 40 px
 * column, so every title in the list starts at one x.
 *
 * The row itself is the keyboard stop (VirtualRows roves focus between rows), so its buttons stay
 * out of the Tab order. On a fine pointer the actions (the move arrows, Play, remove) and the drag
 * grip float over the row's end on hover or keyboard focus, as Live's do, so they take no width at
 * rest and the time sits at the row's end. On touch a tap on the row already plays or opens it, so
 * the row carries one menu button instead (Play, the moves, remove), and a stray tap at the row's
 * end no longer removes anything.
 */

import { k } from '../lib/keys';
import { ArrowDown, ArrowUp, GripVertical, Play, Trash2, X } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemSnapshot, ItemRef, Source } from '@/api/types';
import { snapshotTitle } from '@/lib/title';
import { ChannelName } from '@/ui/ChannelName';
import { cn } from '@/ui/cn';

import { ChannelLogo, IconButton, Menu, Poster, PosterCellWidthContext, ProgressBar, Skeleton, usePosterWidthBox, useScaledPx, type MenuItem } from '../deps';
import type { NowOn } from '../hooks/useNowOn';
import { ContentIcon, SourceBadge } from './bits';

/** Live TV's channel row height (CHANNEL_ROW_HEIGHT): the two lists read as one design. */
export const ENTRY_ROW_HEIGHT = 60;

export interface EntryRowProps {
  entryRef: ItemRef;
  snapshot: ItemSnapshot;
  /** Shown when the page aggregates several sources. */
  source?: Source | undefined;
  showSource: boolean;
  time: string;
  /** The hover strip's remove button's name, with the title ("Remove Heat from favorites"). */
  removeLabel: string;
  /**
   * The touch menu's remove item, without the title ("Remove from favorites"): the menu is already
   * named for the row, and a long channel name cut the titled label to "Remove US| ESPN Alt…",
   * losing what the one destructive item does.
   */
  menuRemoveLabel: string;
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

/** A poster's width, `w-8`: 30 px at 100 % scale, centred in the 40 px art column. */
const ART_PX = 30;
/** Live TV's logo tile, so a channel's tile is the same size in both lists. */
const LOGO_PX = 40;

/**
 * The floating action strip of Live TV's rows (ChannelRow's ROW_ACTIONS): over the row's end on
 * hover or keyboard focus, on a fine pointer only (touch gets the menu button).
 */
const HOVER_ACTIONS =
  'absolute inset-y-0 end-1 my-auto hidden h-fit items-center gap-0.5 rounded-lg border border-edge bg-surface-2 p-0.5 shadow-2 opacity-0 group-hover:opacity-100 in-focus-visible:opacity-100 focus-within:opacity-100 not-pointer-coarse:flex';

/**
 * The time hides while the strip shows over it (on the same hover, keyboard focus or focused strip
 * button), as Live's row hides its marks: a strip of two buttons is narrower than "4 minutes ago"
 * and left a cut-off "4 m" beside it. Invisible, not removed, so the row does not reflow.
 */
const HIDE_UNDER_ACTIONS =
  'not-pointer-coarse:group-hover:invisible not-pointer-coarse:in-focus-visible:invisible not-pointer-coarse:group-has-[[data-testid=entry-actions]:focus-within]:invisible';

function EntryRowImpl({ entryRef, snapshot, source, showSource, time, removeLabel, menuRemoveLabel, busy, now, onOpen, onRemove, reorder }: EntryRowProps) {
  const { t } = useTranslation('library');
  const type = entryRef.contentType;
  const playable = type === 'live' || type === 'radio';
  // Older movie and series snapshots hold the provider's raw name ("EN - Heat (1995)"); show what the VOD cards show.
  const title = snapshotTitle(entryRef, snapshot.title).title;
  const minutesLeft = now ? Math.max(1, Math.round(now.leftSeconds / 60)) : 0;
  // P2-POSTERS-2: the artwork's width is known, so it does not read its frame as it mounts.
  const artWidth = usePosterWidthBox(useScaledPx(ART_PX, true));
  const openLabel = playable ? t('playTitle', { title }) : t('openTitle', { title });
  const menuItems: MenuItem[] = [
    { id: 'open', label: playable ? t('episodePlay') : t('rowOpen'), icon: <Play size={16} aria-hidden />, onSelect: onOpen },
    ...(reorder
      ? [
          { id: 'up', label: t('rowMoveUp'), icon: <ArrowUp size={16} aria-hidden />, disabled: !reorder.canUp || !!busy, onSelect: () => reorder.onMove(-1) },
          { id: 'down', label: t('rowMoveDown'), icon: <ArrowDown size={16} aria-hidden />, disabled: !reorder.canDown || !!busy, onSelect: () => reorder.onMove(1) },
        ]
      : []),
    { id: 'sep', type: 'separator' as const },
    { id: 'remove', label: menuRemoveLabel, icon: <Trash2 size={16} aria-hidden />, danger: true, disabled: !!busy, onSelect: onRemove },
  ];
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
          className={cn('pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent-mark', reorder.dropTarget === 'before' ? 'top-0' : 'bottom-0')}
        />
      )}
      {/* Artwork is a mouse shortcut only: the title button beside it and the Play button carry the name for keyboard and AT. */}
      <div aria-hidden data-testid="entry-artwork" onClick={onOpen} className="flex w-10 shrink-0 cursor-pointer justify-center">
        {playable ? (
          <ChannelLogo src={snapshot.posterUrl ?? undefined} name={title} size={LOGO_PX} sourceId={entryRef.sourceId} />
        ) : (
          <div className="w-8 overflow-hidden rounded-sm ring-1 ring-edge">
            <PosterCellWidthContext.Provider value={artWidth}>
              <Poster src={snapshot.posterUrl} sourceId={entryRef.sourceId} alt="" label={title} aspect="poster" rounded="sm" />
            </PosterCellWidthContext.Provider>
          </div>
        )}
      </div>
      <button type="button" tabIndex={-1} onClick={onOpen} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start">
        {/* A channel's provider tag trails its name, quiet, as in Live TV's rows. */}
        {playable ? (
          <ChannelName name={title} className="w-full truncate text-match-parent text-body-sm font-medium text-fg" />
        ) : (
          <span dir="auto" className="w-full truncate text-match-parent text-body-sm font-medium text-fg">
            {title}
          </span>
        )}
        {now ? (
          // What is on now, as Live TV's rows say it: a guide answers "what is this?" better than
          // "Live channel" under a heading that already says so.
          <span className="flex w-full min-w-0 flex-col" data-testid="entry-now">
            <span className="flex w-full min-w-0 items-baseline gap-2 text-caption text-fg-muted">
              <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent">
                {now.title}
              </span>
              {/* Live's compact "48m": in full it read as one phrase with the "34 minutes ago" beside
                  it. The full words stay for the pointer's tooltip and for a screen reader. */}
              <span className="shrink-0 tabular-nums text-fg-subtle" title={t('minutesLeft', { count: minutesLeft })} data-testid="entry-left">
                <span aria-hidden>{t('minutesLeftShort', { count: minutesLeft })}</span>
                <span className="sr-only">{t('minutesLeft', { count: minutesLeft })}</span>
              </span>
            </span>
            {/* Quiet, as on Live TV's rows that are not playing: a hairline track with a neutral fill,
                since a list of amber bars read as stripes and 3 px grey ones as ruled paper. */}
            <ProgressBar
              value={Math.round(now.progress * 100)}
              max={100}
              size="xs"
              className="mt-1 h-0.5 bg-fg/7 [&>div]:bg-fg-subtle/50"
              label={t('nowProgress', { title: now.title })}
            />
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
      {/* One line at any length ("Added 2 minutes ago"): rows keep one height. A fixed width, so a
          longer date ("Added 2 weeks ago") never pushes the source column left on its row. With the
          move arrows and the grip the strip is five controls wide, so the column is wider there and
          the strip stays over it, clear of the programme line and its time left. */}
      <span
        className={cn(
          'hidden shrink-0 truncate whitespace-nowrap text-end text-caption tabular-nums text-fg-subtle sm:block',
          reorder ? 'w-40' : 'w-36',
          HIDE_UNDER_ACTIONS,
        )}
        title={time}
        data-testid="entry-time"
      >
        {time}
      </span>
      <div className={HOVER_ACTIONS} data-testid="entry-actions">
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
          label={openLabel}
          icon={<Play size={14} aria-hidden className="fill-current" />}
          onClick={onOpen}
          className="rounded-full"
          data-action="open"
        />
        <IconButton
          size="sm"
          tabIndex={-1}
          label={removeLabel}
          icon={<X size={14} aria-hidden />}
          disabled={busy}
          onClick={onRemove}
          className="hover:text-danger"
          data-action="remove"
        />
        {/* The drag handle sits last, after the row's buttons (the iOS reorder control's place), so
            the artwork keeps the page's left edge with the headings. */}
        {reorder && (
          <span
            draggable
            onDragStart={reorder.onDragStart}
            onDragEnd={reorder.onDragEnd}
            className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-fg-subtle hover:text-fg active:cursor-grabbing"
            title={t('dragToReorder')}
            aria-hidden
          >
            <GripVertical size={16} />
          </span>
        )}
      </div>
      {/* Touch: one button at the row's end, and its menu holds every action the hover strip has. */}
      <Menu
        items={menuItems}
        label={t('entryMenu', { title })}
        align="end"
        triggerClassName="-me-1 shrink-0 not-pointer-coarse:hidden"
      />
    </div>
  );
}

/**
 * Move up/down arrows in the floating strip: a disabled one (the first row's up, the last row's
 * down) is left out, so the strip never shows a dead button.
 */
const REORDER_ARROW = 'disabled:hidden';

export const EntryRow = memo(EntryRowImpl);

/**
 * The loading stand-in for a page of these rows (Favorites, Recently watched): the first
 * heading's row, then rows of the real height with the 40 px art column, two text lines and the
 * time at the end, in the list's box (-mx-2, the reading width), so nothing moves when the rows
 * arrive. The kit's SkeletonList ran the full page width with shorter rows and smaller art.
 */
export function EntryRowsSkeleton({ rows = 8 }: { rows?: number }) {
  const { t } = useTranslation('common');
  return (
    <div role="status" aria-busy="true" className="-mx-2 flex max-w-4xl flex-col" data-testid="entry-rows-skeleton">
      <span className="sr-only">{t('loading')}</span>
      <div className="flex h-9 items-end px-2 pb-2" aria-hidden>
        <Skeleton className="h-4 w-32" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2" style={{ height: ENTRY_ROW_HEIGHT }} aria-hidden>
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5 opacity-70" />
          </div>
          <Skeleton className="hidden h-3 w-24 shrink-0 opacity-70 sm:block" />
        </div>
      ))}
    </div>
  );
}
