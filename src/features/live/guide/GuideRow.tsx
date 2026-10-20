/**
 * One channel row of the guide grid (L2-perf-ui-1): memoised, so a scroll frame, a cursor move or
 * the programme popover re-renders only the rows whose props changed. Cells are plain elements:
 * the schedule index and every label come from the page, so a cell subscribes to nothing.
 *
 * Cells are laid out from a fixed origin, not from the window's start, and the page moves every
 * row's cells to the window with one CSS variable ({@link GRID_SHIFT_VAR}): a window move at the
 * edge of a sideways scroll leaves the rows' props alone, so no row re-renders inside the scroll
 * event (L3-perf-ui-4). The track clips the cells that fall outside the window.
 */

import { History } from 'lucide-react';
import { memo, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgProgram, SourceKind } from '@/api/types';
import { cn, Skeleton } from '@/ui';
import { ScheduleMarkView, type ScheduleIndex } from '@/features/recording';

import { ChannelLogo } from '../components/ChannelLogo';
import { displayChannelName } from '../lib/channelName';
import { MINUTE, canCatchUp, cellTextMaxPx, formatRange, hasUsableArchive, layoutBlocks, ms, programWhen } from '../lib/epgTime';
import { inlineStart } from '../lib/rtl';

export { CELL_TEXT_MIN_PX, cellTextPadPx } from '../lib/epgTime';

/** The CSS variable the page sets to the window's offset from the rows' origin, in px (0 or less after a later move). */
export const GRID_SHIFT_VAR = '--grid-shift';

const fitted = new WeakMap<HTMLElement, number | undefined>();

/**
 * Fits the text of the cells under `root` to a track scrolled `scroll` px, with the cells moved
 * `shift` px from their origin (see {@link GRID_SHIFT_VAR}). The text itself sticks just past the
 * sticky channel column (position: sticky: the compositor moves it with the scroll, and it is
 * never a layout shift, L3-perf-ui-4). A cell that began before the visible edge only gets a
 * narrower text box here, so a long title ends in an ellipsis inside the cell instead of starting
 * under the column. Writes only the cells whose width changes; reads nothing from layout.
 */
export function fitCellText(root: ParentNode, scroll: number, shift = 0): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-pad-left]')) {
    const max = cellTextMaxPx(scroll, Number(el.dataset.padLeft) + shift, Number(el.dataset.padWidth));
    if (fitted.has(el) && fitted.get(el) === max) continue;
    fitted.set(el, max);
    el.style.maxWidth = max === undefined ? '' : `${max}px`;
  }
}

/** What a row does with its cells; one stable object for every row. */
export interface GuideRowHandlers {
  play(channel: Channel): void;
  open(row: number, channel: Channel, program: EpgProgram, el: HTMLElement): void;
  focusCell(row: number, program: EpgProgram): void;
  menu(channel: Channel, x: number, y: number): void;
  /** Fits the text of the row's cells to the grid's current scroll (fitCellText). */
  fitText(row: HTMLElement): void;
  /** A press on a cell, before its click opens the detail: the detail's data can be fetched ahead. */
  press(channel: Channel, program: EpgProgram): void;
}

export interface GuideRowProps {
  index: number;
  /** px from the top of the grid content (the header included). */
  top: number;
  height: number;
  channel: Channel | undefined;
  /** Display-time programmes; undefined while loading, [] when the guide has none. */
  programs: EpgProgram[] | undefined;
  /**
   * The time the cells are laid out from (fixed for the page's life). The page moves the cells to
   * the window with {@link GRID_SHIFT_VAR}, so a window move does not change this prop.
   */
  origin: number;
  now: number;
  pxPerMin: number;
  channelCol: number;
  trackWidth: number;
  compact: boolean;
  rtl: boolean;
  kind: SourceKind | undefined;
  highlighted: boolean;
  /**
   * The keyboard cursor, when it is on this row: the start of the programme it is on, or '' when
   * it is on none (the channel cell takes it). null when the cursor is on another row.
   */
  cursorStart: string | null;
  lang: string;
  stripCountryPrefix: boolean;
  schedule: ScheduleIndex;
  handlers: GuideRowHandlers;
}

export const GuideRow = memo(function GuideRow({
  index,
  top,
  height,
  channel: ch,
  programs,
  origin,
  now,
  pxPerMin,
  channelCol,
  trackWidth,
  compact,
  rtl,
  kind,
  highlighted,
  cursorStart,
  lang,
  stripCountryPrefix,
  schedule,
  handlers,
}: GuideRowProps) {
  const { t } = useTranslation('live');
  const ref = useRef<HTMLDivElement>(null);
  const chName = displayChannelName(ch?.name, stripCountryPrefix);
  const onNow = t('onNow');
  // Cells this render added get their text fitted before paint.
  useLayoutEffect(() => {
    if (ref.current) handlers.fitText(ref.current);
  });

  // Cells sit at their true times, from the row's first programme (or the origin, if later): one
  // that began before the window is clipped by the track, and its text sticks at the visible edge.
  let from = origin;
  for (const p of programs ?? []) {
    const s = ms(p.start);
    if (s < from) from = s;
  }
  const blocks = programs && programs.length > 0 ? layoutBlocks(programs, from, Infinity, pxPerMin, now) : [];
  /** px from the origin to `from` (0 or less): where the row's cell layer starts. */
  const base = ((from - origin) / MINUTE) * pxPerMin;
  const layer = `calc(var(${GRID_SHIFT_VAR}, 0px) + ${base}px)`;
  return (
    <div
      ref={ref}
      role="row"
      aria-rowindex={index + 2}
      className="absolute start-0 flex border-b border-divider"
      style={{ top, height, width: channelCol + trackWidth }}
      // Right click anywhere on the row (its channel cell or a programme): the channel's menu.
      onContextMenu={(e: MouseEvent) => {
        if (!ch) return;
        e.preventDefault();
        handlers.menu(ch, e.clientX, e.clientY);
      }}
    >
      <div
        role="rowheader"
        className={`sticky start-0 z-10 border-e border-divider motion-safe:transition-colors motion-safe:duration-500 ${highlighted ? 'bg-surface-3' : 'bg-surface'}`}
        style={{ width: channelCol }}
      >
        {/* guide search: the row a hit moved to, marked for a moment. */}
        {highlighted ? <span aria-hidden className="pointer-events-none absolute inset-y-0 start-0 w-[3px] bg-accent" /> : null}
        {ch ? (
          <button
            type="button"
            data-channel-row={index}
            data-highlighted={highlighted ? '' : undefined}
            tabIndex={cursorStart !== null && (!programs || programs.length === 0) ? 0 : -1}
            onClick={() => handlers.play(ch)}
            title={t('playChannel', { name: chName })}
            data-compact={compact ? '' : undefined}
            className={cn(
              'relative flex h-full w-full outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
              compact ? 'flex-col items-center justify-center gap-0.5 px-1' : 'items-center gap-2 px-2 text-start',
            )}
          >
            {compact ? (
              // Phones: the logo over the number; the name is the button's label and tooltip.
              <>
                <ChannelLogo src={ch.logoUrl} name={chName} size={30} sourceId={ch.ref.sourceId} />
                <span className="max-w-full truncate font-numeric text-xs leading-none tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
                <span className="sr-only">{chName}</span>
                {hasUsableArchive(ch, kind) ? <History className="absolute end-1 top-1 size-3 text-fg-subtle" aria-label={t('archive')} /> : null}
              </>
            ) : (
              <>
                <span className="w-7 shrink-0 text-end font-numeric text-xs tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
                <ChannelLogo src={ch.logoUrl} name={chName} size={30} sourceId={ch.ref.sourceId} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{chName}</span>
                {hasUsableArchive(ch, kind) ? <History className="size-3.5 shrink-0 text-fg-subtle" aria-label={t('archive')} /> : null}
              </>
            )}
          </button>
        ) : (
          <div className="flex h-full items-center gap-2 px-2">
            <Skeleton className="size-7" />
            <Skeleton className="h-3 flex-1" />
          </div>
        )}
      </div>
      {/* Clips the cells outside the window without becoming a scroll container, so the cell text
          still sticks to the grid's own scroll. */}
      <div role="gridcell" className="relative overflow-x-clip" style={{ width: trackWidth }}>
        {programs === undefined ? (
          // Guide data still on its way: a cell-shaped skeleton, like the channel column's, so a row
          // that waits after a fast fling does not read as an empty guide (L4-live-3).
          <div data-testid="row-guide-pending" className="absolute inset-1.5 flex items-center rounded-md bg-surface-2/60" aria-hidden>
            <span className="sticky flex w-44 max-w-[60%] flex-col gap-1.5 px-3" style={{ insetInlineStart: channelCol }}>
              <Skeleton className="h-3" />
              <Skeleton className="h-2.5 w-3/5 opacity-70" />
            </span>
          </div>
        ) : programs.length === 0 ? (
          <div className="absolute inset-1.5 flex items-center rounded-xs border border-dashed border-divider text-xs text-fg-subtle">
            {/* Sticks just past the channel column, so a grid scrolled to now still shows it. */}
            <span data-testid="no-guide-label" className="sticky px-3" style={{ insetInlineStart: channelCol }}>
              {t('noGuideShort')}
            </span>
          </div>
        ) : (
          <div data-testid="cell-layer" className="absolute inset-y-0" style={rtl ? { right: layer } : { left: layer }}>
            {blocks.map((b) => {
              const p = b.program;
              const catchupOk = ch ? canCatchUp(p, ch, kind, now) : false;
              const range = formatRange(p, lang);
              return (
                <button
                  key={p.start}
                  type="button"
                  data-cell-row={index}
                  data-start={p.start}
                  tabIndex={cursorStart === p.start ? 0 : -1}
                  aria-label={`${p.title}, ${range}${b.when === 'now' ? `, ${onNow}` : ''}`}
                  // The full title on hover: a narrow or clipped cell truncates it (L3-visual-12).
                  title={p.title}
                  onPointerDown={() => {
                    if (ch) handlers.press(ch, p);
                  }}
                  onClick={(e) => {
                    if (ch) handlers.open(index, ch, p, e.currentTarget);
                  }}
                  onFocus={() => handlers.focusCell(index, p)}
                  // overflow-clip, not hidden: the cell is then no scroll container, so its text can stick.
                  className={`absolute top-1 bottom-1 overflow-clip rounded-md border px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                    // On now: the see-through active layer, so the live now line (drawn before the
                    // rows) shows through at nearly full strength; an opaque or 85 % fill greyed
                    // it out across the whole now column. No amber wash either.
                    b.when === 'now'
                      ? 'border-edge bg-active text-fg'
                      : b.when === 'past'
                        ? 'border-edge/60 bg-surface-2/60 text-fg-muted'
                        : 'border-edge bg-surface-2 text-fg hover:bg-surface-3'
                  }`}
                  style={{ ...inlineStart(b.left + 1, rtl), width: Math.max(2, b.width - 2) }}
                >
                  {/* A show that began before the visible edge keeps its title readable: the text sticks
                      8 px past the sticky channel column until the cell's end pushes it out, and
                      fitCellText narrows it so the title ends in an ellipsis inside the cell. */}
                  <span
                    data-testid="cell-text"
                    className="sticky block w-max max-w-full"
                    style={{ insetInlineStart: channelCol + 8 }}
                    data-pad-left={b.left + base}
                    data-pad-width={b.width}
                  >
                    <span className="flex items-center gap-1 truncate text-xs font-medium">
                      {b.when === 'past' && catchupOk ? <History className="size-3 shrink-0" aria-hidden /> : null}
                      <span dir="auto" className="truncate text-match-parent">
                        {p.title}
                      </span>
                      {/* recording: */}
                      <ScheduleMarkView index={schedule} channelRef={ch?.ref} program={p} />
                    </span>
                    <span className={`block truncate text-[calc(11rem/15)] tabular-nums ${b.when === 'future' ? 'text-fg-muted' : ''}`}>{range}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}, sameRow);

/**
 * GuideRow's memo test. The page's clock ticks every 30 s; a tick re-renders the row (layout and
 * every cell's labels, LV-8) only when it moves one of its programmes between past, now and
 * future, or in or out of the catch-up window. Every other prop compares by identity.
 */
function sameRow(prev: GuideRowProps, next: GuideRowProps): boolean {
  for (const k of Object.keys(next) as (keyof GuideRowProps)[]) {
    if (k !== 'now' && prev[k] !== next[k]) return false;
  }
  if (prev.now === next.now) return true;
  const ch = next.channel;
  for (const p of next.programs ?? []) {
    if (programWhen(p, prev.now) !== programWhen(p, next.now)) return false;
    if (ch && canCatchUp(p, ch, next.kind, prev.now) !== canCatchUp(p, ch, next.kind, next.now)) return false;
  }
  return true;
}
