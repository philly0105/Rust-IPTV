/**
 * One channel row of the guide grid (L2-perf-ui-1): memoised, so a scroll frame, a cursor move or
 * the programme popover re-renders only the rows whose props changed. Cells are plain elements:
 * the schedule index and every label come from the page, so a cell subscribes to nothing.
 */

import { History } from 'lucide-react';
import { memo, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgProgram, SourceKind } from '@/api/types';
import { cn, Skeleton } from '@/ui';
import { ScheduleMarkView, type ScheduleIndex } from '@/features/recording';

import { ChannelLogo } from '../components/ChannelLogo';
import { displayChannelName } from '../lib/channelName';
import { canCatchUp, formatRange, hasUsableArchive, layoutBlocks } from '../lib/epgTime';
import { inlineStart } from '../lib/rtl';

/** Room a clipped cell keeps for its text before the cell's end pushes the text out. */
export const CELL_TEXT_MIN_PX = 48;

/**
 * Inline-start padding, in px, for the text of a cell `left` px into the track and `width` px
 * wide, with the track scrolled `scroll` px from its inline start: a show that began before the
 * visible edge has its text pushed just past the sticky channel column, until only
 * {@link CELL_TEXT_MIN_PX} of it is left. The button sits at left + 1 with a 1 px border and
 * 8 px padding: its text starts at left + 10, and should start 8 px past the edge.
 */
export function cellTextPadPx(scroll: number, left: number, width: number): number {
  const max = Math.max(0, width - 20 - CELL_TEXT_MIN_PX);
  return Math.min(max, Math.max(0, scroll - (left + 2)));
}

const padded = new WeakMap<HTMLElement, number>();

/**
 * Pads the text of the cells under `root` for a track scrolled `scroll` px (L2-guide-library-2).
 * Only a cell clipped by the channel column gets padding, written straight to its style, so a
 * horizontal scroll restyles a cell or so per row instead of every cell of the grid. Reads
 * nothing from layout.
 */
export function padCellText(root: ParentNode, scroll: number): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-pad-left]')) {
    const pad = cellTextPadPx(scroll, Number(el.dataset.padLeft), Number(el.dataset.padWidth));
    if ((padded.get(el) ?? 0) === pad) continue;
    padded.set(el, pad);
    el.style.paddingInlineStart = pad > 0 ? `${pad}px` : '';
  }
}

/** What a row does with its cells; one stable object for every row. */
export interface GuideRowHandlers {
  play(channel: Channel): void;
  open(row: number, channel: Channel, program: EpgProgram, el: HTMLElement): void;
  focusCell(row: number, program: EpgProgram): void;
  menu(channel: Channel, x: number, y: number): void;
}

export interface GuideRowProps {
  index: number;
  /** px from the top of the grid content (the header included). */
  top: number;
  height: number;
  channel: Channel | undefined;
  /** Display-time programmes; undefined while loading, [] when the guide has none. */
  programs: EpgProgram[] | undefined;
  start: number;
  end: number;
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
  /** The track's inline-start scroll distance at the last scroll event (cell text padding). */
  scrollX: { readonly current: number };
}

export const GuideRow = memo(function GuideRow({
  index,
  top,
  height,
  channel: ch,
  programs,
  start,
  end,
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
  scrollX,
}: GuideRowProps) {
  const { t } = useTranslation('live');
  const ref = useRef<HTMLDivElement>(null);
  const chName = displayChannelName(ch?.name, stripCountryPrefix);
  const onNow = t('onNow');
  // Cells this render added or moved get their text padding before paint.
  useLayoutEffect(() => {
    if (ref.current) padCellText(ref.current, scrollX.current);
  });

  const blocks = programs && programs.length > 0 ? layoutBlocks(programs, start, end, pxPerMin, now) : [];
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
              'relative flex h-full w-full outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
              compact ? 'flex-col items-center justify-center gap-0.5 px-1' : 'items-center gap-2 px-2 text-start',
            )}
          >
            {compact ? (
              // Phones: the logo over the number; the name is the button's label and tooltip.
              <>
                <ChannelLogo src={ch.logoUrl} name={chName} size={30} sourceId={ch.ref.sourceId} />
                <span className="max-w-full truncate text-[calc(11rem/15)] leading-none tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
                <span className="sr-only">{chName}</span>
                {hasUsableArchive(ch, kind) ? <History className="absolute end-1 top-1 size-3 text-fg-subtle" aria-label={t('archive')} /> : null}
              </>
            ) : (
              <>
                <span className="w-7 shrink-0 text-end text-[calc(11rem/15)] tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
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
      <div role="gridcell" className="relative" style={{ width: trackWidth }}>
        {programs === undefined ? (
          <div className="absolute inset-1.5 rounded bg-surface-2/60" aria-hidden />
        ) : programs.length === 0 ? (
          <div className="absolute inset-1.5 flex items-center rounded border border-dashed border-divider text-xs text-fg-subtle">
            {/* Sticks just past the channel column, so a grid scrolled to now still shows it. */}
            <span data-testid="no-guide-label" className="sticky px-3" style={{ insetInlineStart: channelCol }}>
              {t('noGuideShort')}
            </span>
          </div>
        ) : (
          blocks.map((b) => {
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
                onClick={(e) => {
                  if (ch) handlers.open(index, ch, p, e.currentTarget);
                }}
                onFocus={() => handlers.focusCell(index, p)}
                className={`absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  b.when === 'now'
                    ? 'border-accent/60 bg-accent/12 text-fg'
                    : b.when === 'past'
                      ? 'border-border/60 bg-surface-2/60 text-fg-muted'
                      : 'border-border bg-surface-2 text-fg hover:bg-surface-3'
                }`}
                style={{ ...inlineStart(b.left + 1, rtl), width: Math.max(2, b.width - 2) }}
              >
                {/* A show that began before the visible edge keeps its title readable: padCellText pads
                    the text past the sticky channel column until the cell's end pushes it out. */}
                <span data-testid="cell-text" className="block" data-pad-left={b.left} data-pad-width={b.width}>
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
          })
        )}
      </div>
    </div>
  );
});
