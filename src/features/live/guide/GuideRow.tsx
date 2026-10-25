/**
 * One channel row of the guide grid (L2-perf-ui-1): memoised, so a scroll frame, a cursor move or
 * the programme popover re-renders only the rows whose props changed. Cells are plain elements:
 * the schedule index and every label come from the page, so a cell subscribes to nothing.
 *
 * Cells are laid out from the fixed origin of the native horizontal track. A horizontal gesture
 * scrolls the track itself, so the rows' props and cell positions stay still.
 */

import { AudioLines, History } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

import type { Channel, EpgProgram, SourceKind } from '@/api/types';
import { cn, Skeleton } from '@/ui';
import { markFor, ScheduleMarkView, type ScheduleIndex } from '@/features/recording';

import { ChannelLogo, ChannelName } from '../components/ChannelLogo';
import { useLongPress } from '../hooks/useLongPress';
import { displayChannelName } from '../lib/channelName';
import { MINUTE, canCatchUp, cellTextMaxPx, cellTextPadPx, formatRange, hasUsableArchive, layoutBlocks, ms, programWhen } from '../lib/epgTime';
import { inlineStart } from '../lib/rtl';
import { genreColor, genreOf, type Genre } from './genre';
import type { GuideHydrator, HydrationTicket } from './hydration';
import { programmeChunks, sameProgrammeChunk, type ProgrammeChunk } from './programmeChunks';

export { CELL_TEXT_MIN_PX, cellTextPadPx } from '../lib/epgTime';

/**
 * The CSS variable set only on an airing cell's two clock markers, in px from the rows' origin.
 * Keeping it off the canvas avoids invalidating inherited styles across every programme tile.
 */
export const GRID_NOW_VAR = '--grid-now';

/** Advance only the mounted clock markers; memoised rows and all their other styles stay put. */
export function updateGuideClock(root: ParentNode, nowPosition: number): void {
  const value = `${nowPosition}px`;
  for (const marker of root.querySelectorAll<HTMLElement>('[data-guide-clock]')) {
    if (marker.style.getPropertyValue(GRID_NOW_VAR) !== value) marker.style.setProperty(GRID_NOW_VAR, value);
  }
}

const fitted = new WeakMap<HTMLElement, { max: number | undefined; offset: number }>();

function fitTextCell(el: HTMLElement, scroll: number, left: number, width: number) {
  const max = scroll < left + width ? cellTextMaxPx(scroll, left, width) : undefined;
  // Only the clipped title moves inside its programme; the horizontal track scrolls natively.
  const pad = scroll < left + width ? cellTextPadPx(scroll, left, width) : 0;
  const offset = el.dataset.padRtl === 'true' ? -pad : pad;
  const previous = fitted.get(el);
  if (previous?.max !== max) el.style.maxWidth = max === undefined ? '' : `${max}px`;
  if ((previous?.offset ?? 0) !== offset) el.style.transform = offset ? `translateX(${offset}px)` : '';
  fitted.set(el, { max, offset });
}

/**
 * Keeps a clipped programme's title readable beside the channel column. Only that title gets
 * a local transform and width cap; programme cells themselves scroll entirely natively.
 * Giving every offscreen title position:sticky creates thousands of compositor constraints,
 * making layer updates dominate scrolling. This fitter reads stored times, never layout.
 */
export function fitCellText(root: ParentNode, scroll: number): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-pad-left]')) {
    fitTextCell(el, scroll, Number(el.dataset.padLeft), Number(el.dataset.padWidth));
  }
}

/** Keep row text positions for fitting at rest, without changing title styles during scrolling. */
export function createCellTextFitter() {
  type Cell = { el: HTMLElement; left: number; width: number };
  const rows = new Map<HTMLElement, { cells: Cell[]; at: number }>();
  const fit = (cell: Cell, at: number) => {
    fitTextCell(cell.el, at, cell.left, cell.width);
  };
  let scrolling = false;
  const fitter = {
    register(row: HTMLElement, scroll: number) {
      const cells = Array.from(row.querySelectorAll<HTMLElement>('[data-pad-left]'), (el) => ({
        el,
        left: Number(el.dataset.padLeft),
        width: Number(el.dataset.padWidth),
      }));
      const at = scrolling ? 0 : scroll;
      cells.forEach((cell) => fit(cell, at));
      rows.set(row, { cells, at });
      return () => {
        rows.delete(row);
      };
    },
    update(scroll: number) {
      if (scrolling) return;
      const at = scroll;
      for (const row of rows.values()) {
        const low = Math.min(row.at, at);
        const high = Math.max(row.at, at);
        row.at = at;
        if (low === high) continue;
        // layoutBlocks yields cells in time order without overlap, so their ends are ordered too.
        let lo = 0;
        let hi = row.cells.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          const cell = row.cells[mid]!;
          if (cell.left + cell.width < low) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < row.cells.length && row.cells[i]!.left <= high; i++) fit(row.cells[i]!, at);
      }
    },
    setScrolling(active: boolean, scroll: number) {
      if (active === scrolling) return;
      scrolling = false;
      // During a gesture labels travel with their cells, with no per-frame layout or paint
      // mutations. Fit the clipped title once the native viewport has settled.
      fitter.update(active ? 0 : scroll);
      scrolling = active;
    },
  };
  return fitter;
}

/** The row's UI strings are translated once by the page. */
export interface GuideRowLabels {
  onNow: string;
  archive: string;
  playingNow: string;
  noGuideShort: string;
  playChannel(name: string): string;
}

/** What a row does with its cells; one stable object for every row. */
export interface GuideRowHandlers {
  play(channel: Channel): void;
  open(row: number, channel: Channel, program: EpgProgram, el: HTMLElement): void;
  focusCell(row: number, program: EpgProgram): void;
  menu(channel: Channel, x: number, y: number, program?: EpgProgram): void;
  /** Fits the text of the row's cells to the grid's current scroll (fitCellText). */
  fitText(row: HTMLElement): () => void;
  /** A press on a cell, before its click opens the detail: the detail's data can be fetched ahead. */
  press(channel: Channel, program: EpgProgram): void;
  /** The pointer is over a cell (undefined: it left the row): the preview band follows it. */
  hover(row: number, channel: Channel, program: EpgProgram | undefined): void;
  /** Populates far-offscreen time groups without one large synchronous DOM insertion. */
  hydration?: GuideHydrator;
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
   * The time the cells are laid out from. Native scrolling does not change this prop.
   */
  origin: number;
  now: number;
  pxPerMin: number;
  channelCol: number;
  compact: boolean;
  rtl: boolean;
  kind: SourceKind | undefined;
  highlighted: boolean;
  /** The channel playing in the app (LG-01): its channel cell carries the tick and a playing mark. */
  playing: boolean;
  /** Start of the programme playing on this channel, if it is in the guide. */
  playingProgramStart?: string;
  /** The genre the guide is filtered to: cells of other genres step back (CB-GUIDE-GENRE). */
  genreFilter: Genre | null;
  /** Each genre's name in the UI language: a cell's accessible name ends with its genre. */
  genreNames: Record<Genre, string>;
  labels: GuideRowLabels;
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
  compact,
  rtl,
  kind,
  highlighted,
  playing,
  playingProgramStart,
  genreFilter,
  genreNames,
  labels,
  cursorStart,
  lang,
  stripCountryPrefix,
  schedule,
  handlers,
}: GuideRowProps) {
  // LG-04: touch has no right click; a long press on the channel cell opens the same menu.
  const longPress = useLongPress((x, y) => {
    if (ch) handlers.menu(ch, x, y);
  });
  const chName = displayChannelName(ch?.name, stripCountryPrefix);
  // Catch-up remains in the accessible name and tooltip.
  const archive = !!ch && hasUsableArchive(ch, kind);
  const populatedChannel = useRef<string | null>(null);
  const channelKey = ch ? `${ch.ref.sourceId}|${ch.ref.contentType}|${ch.ref.itemId}` : null;
  const initialPopulation = populatedChannel.current !== channelKey;
  useLayoutEffect(() => {
    if (programs?.length) populatedChannel.current = channelKey;
  }, [programs, channelKey]);

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
  const layer = `${base}px`;
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      className="absolute start-0 flex border-b border-divider"
      style={{ top, height, width: 'var(--grid-total-width)', contain: 'layout style' }}
      // Right click anywhere on the row (its channel cell or a programme): the channel's menu.
      onContextMenu={(e: MouseEvent) => {
        if (!ch) return;
        e.preventDefault();
        // Keep the programme under the pointer when the context menu is opened from a cell. The
        // row itself still opens the channel menu, while a programme can resolve its archive URL.
        const cell = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-start]') : null;
        const program = cell ? programs?.find((p) => p.start === cell.dataset.start) : undefined;
        handlers.menu(ch, e.clientX, e.clientY, program);
      }}
    >
      <div
        role="rowheader"
        className={cn(
          'sticky start-0 z-10 border-e border-divider select-none [-webkit-touch-callout:none] motion-safe:transition-colors motion-safe:duration-500',
          // Playing: the "you are here" of every list (LG-01, LG-15); a search hit's row flashes.
          playing ? 'tuning-tick bg-selected' : highlighted ? 'bg-surface-3' : 'bg-surface',
        )}
        style={{ width: channelCol }}
        {...longPress}
      >
        {/* guide search: the row a hit moved to, marked for a moment. */}
        {highlighted ? <span aria-hidden className="pointer-events-none absolute inset-y-0 start-0 w-[3px] bg-accent-mark" /> : null}
        {ch ? (
          <button
            type="button"
            data-channel-row={index}
            data-highlighted={highlighted ? '' : undefined}
            tabIndex={cursorStart !== null && (!programs || programs.length === 0) ? 0 : -1}
            onClick={() => handlers.play(ch)}
            title={archive ? `${labels.playChannel(chName)}\n${labels.archive}` : labels.playChannel(chName)}
            aria-current={playing ? 'true' : undefined}
            data-playing={playing ? '' : undefined}
            data-compact={compact ? '' : undefined}
            className={cn(
              'relative flex h-full w-full outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
              compact ? 'flex-col items-center justify-center gap-0.5 px-1' : 'items-center gap-2 px-2 text-start',
            )}
          >
            {compact ? (
              // Phones: the logo over the number; the name is the button's label and tooltip.
              <>
                <ChannelLogo src={ch.logoUrl} name={chName} size={32} sourceId={ch.ref.sourceId} />
                <span className={cn('max-w-full truncate font-numeric text-xs leading-none tabular-nums', playing ? 'text-fg' : 'text-fg-muted')}>{ch.number ?? ''}</span>
                <span className="sr-only">{playing ? `${chName}, ${labels.playingNow}` : chName}</span>
                {archive ? <span className="sr-only" data-testid="guide-archive-mark">, {labels.archive}</span> : null}
              </>
            ) : (
              <>
                {/* Playing: the tick and the playing mark are the amber; the number steps up to the text colour. */}
                <span className={cn('w-7 shrink-0 text-end font-numeric text-sm tabular-nums', playing ? 'text-fg' : 'text-fg-muted')}>{ch.number ?? ''}</span>
                <ChannelLogo src={ch.logoUrl} name={chName} size={32} sourceId={ch.ref.sourceId} />
                {/* Named as Live TV's list names it: the country tag after the name, quiet, so a
                    narrow column cuts the tag, not what tells ESPN2 from ESPNU. */}
                <ChannelName
                  name={ch.name}
                  strip={stripCountryPrefix}
                  className={cn('min-w-0 flex-1 truncate text-body-sm text-match-parent text-fg', playing && 'font-semibold')}
                />
                {archive ? <span className="sr-only" data-testid="guide-archive-mark">, {labels.archive}</span> : null}
                {playing ? (
                  <span className="inline-flex shrink-0 text-accent-mark" data-testid="guide-playing-mark">
                    <AudioLines size={14} aria-label={labels.playingNow} />
                  </span>
                ) : null}
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
      <div role="gridcell" className="relative overflow-x-clip" style={{ width: 'var(--grid-track-width)' }}>
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
          // A flat, quiet band: a wall of dashed boxes read as a broken guide (LG-10). Opaque, like
          // the cells, so the now line (drawn before the rows) does not cross its label.
          <div data-testid="no-guide-band" className="absolute inset-y-1 inset-x-0.5 flex items-center rounded-md bg-surface-2 text-xs text-fg-subtle dark:bg-surface">
            {/* Sticks just past the channel column, so a grid scrolled to now still shows it. */}
            <span data-testid="no-guide-label" className="sticky px-3" style={{ insetInlineStart: channelCol }}>
              {labels.noGuideShort}
            </span>
          </div>
        ) : (
          <div
            data-testid="cell-layer"
            className="absolute inset-y-0"
            style={rtl ? { right: layer } : { left: layer }}
            onMouseLeave={() => {
              if (ch) handlers.hover(index, ch, undefined);
            }}
          >
            {programmeChunks(blocks).map((chunk) => (
              <GuideProgrammeChunk
                key={`${channelKey}:${chunk.key}`}
                chunk={chunk}
                initialPopulation={initialPopulation}
                base={base}
                index={index}
                channel={ch}
                kind={kind}
                now={now}
                lang={lang}
                genreFilter={genreFilter}
                genreNames={genreNames}
                labels={labels}
                playing={playing}
                playingProgramStart={chunk.blocks.some((b) => b.program.start === playingProgramStart) ? playingProgramStart : undefined}
                cursorStart={chunk.blocks.some((b) => b.program.start === cursorStart) ? cursorStart : null}
                rtl={rtl}
                schedule={schedule}
                handlers={handlers}
              />
            ))}
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

type ProgrammeChunkProps = Pick<GuideRowProps,
  'index' | 'channel' | 'kind' | 'now' | 'lang' | 'genreFilter' | 'genreNames' |
  'labels' | 'playing' | 'playingProgramStart' | 'cursorStart' | 'rtl' | 'schedule' | 'handlers'> & {
  chunk: ProgrammeChunk;
  base: number;
  initialPopulation: boolean;
};

/** Buffer edges mount independently; the overlapping hours do not rebuild their cell trees. */
const GuideProgrammeChunk = memo(function GuideProgrammeChunk({
  chunk, base, initialPopulation, index, channel: ch, kind, now, lang, genreFilter, genreNames, labels,
  playing, playingProgramStart, cursorStart, rtl, schedule, handlers,
}: ProgrammeChunkProps) {
  const { onNow, playingNow } = labels;
  const ref = useRef<HTMLDivElement>(null);
  const hydration = handlers.hydration;
  const left = base + chunk.left;
  const right = left + chunk.width;
  const [ready, setReady] = useState(() => initialPopulation || !hydration || cursorStart !== null || hydration.isVisible({ left, right, row: index }));
  // A keyboard target must exist in this commit: the page's focus effect runs before a
  // child-only ready update could make it visible, and would otherwise remain pending.
  const renderReady = ready || initialPopulation || cursorStart !== null || !hydration;
  const granted = useRef<HydrationTicket | null>(null);
  useLayoutEffect(() => {
    if (ready) return;
    if (!hydration || initialPopulation || cursorStart !== null) {
      setReady(true);
      return;
    }
    const ticket = hydration.enqueue({ left, right, row: index }, (grant) => {
      granted.current = grant;
      setReady(true);
    });
    return () => {
      // The granted group releases the global budget only after its DOM has committed.
      if (granted.current !== ticket) ticket.cancel();
    };
  }, [ready, hydration, initialPopulation, cursorStart, left, right, index]);
  useLayoutEffect(() => () => granted.current?.cancel(), []);
  useLayoutEffect(() => {
    if (!renderReady || !ref.current) return;
    const unregister = handlers.fitText(ref.current);
    granted.current?.committed();
    granted.current = null;
    return unregister;
  });
  return (
    <div
      ref={ref}
      data-programme-chunk={chunk.key}
      className="absolute"
      // Reserve the entire group's bounds before its cells hydrate. Each later insertion
      // stays inside this existing layout/paint boundary instead of invalidating the track.
      // Four pixels around it preserve the cells' focus rings and raised-cell shadows.
      style={{ ...inlineStart(chunk.left - 4, rtl), width: chunk.width + 8, top: -4, bottom: -4, contain: 'strict' }}
    >
      <div className="absolute" style={{ inset: 4 }}>
        {renderReady && chunk.blocks.map((b) => {
          const p = b.program;
          const catchupOk = ch ? canCatchUp(p, ch, kind, now) : false;
          const range = formatRange(p, lang);
          const genre = genreOf(p.category);
          // Filtered to a genre: the others step back to plain text on no fill.
          const muted = !!genreFilter && genre !== genreFilter;
          const isPlaying = p.start === playingProgramStart;
          return (
            <button
              key={p.start}
              type="button"
              data-cell-row={index}
              data-start={p.start}
              data-playing={isPlaying ? '' : undefined}
              aria-current={isPlaying ? 'true' : undefined}
              tabIndex={cursorStart === p.start ? 0 : -1}
              // The genre too: the filter dims cells, which a screen reader does not see.
              aria-label={`${p.title}, ${range}${b.when === 'now' ? `, ${onNow}` : ''}${isPlaying ? `, ${playingNow}` : ''}${genre ? `, ${genreNames[genre]}` : ''}`}
              // The full title on hover: a narrow or clipped cell truncates it (L3-visual-12).
              title={p.title}
              onPointerDown={() => {
                if (ch) handlers.press(ch, p);
              }}
              onClick={(e) => {
                if (ch) handlers.open(index, ch, p, e.currentTarget);
              }}
              onFocus={() => handlers.focusCell(index, p)}
              onMouseEnter={() => {
                if (ch) handlers.hover(index, ch, p);
              }}
              data-genre={genre ?? undefined}
              // Clip shifted labels at the programme boundary without creating a scroll container.
              // Flat fills with 2 px gutters, no outlines: a wall of boxed cells read as a spreadsheet.
              className={cn(
                'absolute top-1 bottom-1 overflow-clip rounded-md px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus',
                // Every cell a now line can cross is opaque: the line (drawn before the rows)
                // shows only in the gutters, the ruler and the airing cell's foot, so it never
                // strikes through a title or a time. A see-through airing cell let it through
                // every glyph gap.
                isPlaying
                  ? 'bg-selected font-medium text-fg ring-1 ring-accent-mark ring-inset hover:bg-selected'
                  : muted
                  ? // Filtered to another genre: plain text on the page's own colour, no fill to see.
                    'bg-bg text-fg-subtle hover:bg-surface'
                  : // On now: the raised cell (white with a shadow in light, the next surface step
                    // in dark), never a grey or amber wash. Light rows sit on the grey page:
                    // there a cell is the white panel; dark keeps the lifted surface step.
                    b.when === 'now'
                    ? 'bg-surface text-fg shadow-2 hover:bg-surface-3 dark:bg-raised dark:shadow-1 dark:hover:bg-pressed'
                    : b.when === 'past'
                      ? 'bg-surface-2 text-fg-subtle hover:bg-surface-3 dark:bg-surface-2 dark:hover:bg-surface-3'
                      : 'bg-surface-2 text-fg hover:bg-surface-3 dark:bg-surface-2 dark:hover:bg-surface-3',
              )}
              style={{ ...inlineStart(b.left - chunk.left + 1, rtl), width: Math.max(2, b.width - 2) }}
            >
              {/* CB-GUIDE-GENRE: the bucket's stripe on the inline start. */}
              {genre && !muted && !isPlaying ? (
                <span aria-hidden data-testid="cell-genre" className="absolute inset-y-1 start-0 w-[3px] rounded-e-full" style={{ background: genreColor(genre) }} />
              ) : null}
              {/* The airing programme's progress along its foot (LG-18): the accent's mark tone, a mark of progress. */}
              {b.when === 'now' && !muted ? (
                <span
                  aria-hidden
                  data-testid="cell-progress"
                  data-guide-clock=""
                  className={cn('absolute start-0 bottom-0 h-0.5', playing ? 'bg-accent-mark' : 'bg-fg-subtle/55')}
                  style={{ width: `max(0px, calc(var(${GRID_NOW_VAR}, 0px) - ${base + b.left + 1}px))` }}
                />
              ) : null}
              {/* The now line's stub at the cell's foot: the line runs on in the gutters
                  above and below, and the opaque cell keeps it off the title. */}
              {b.when === 'now' ? (
                <span
                  aria-hidden
                  data-testid="cell-now-tick"
                  data-guide-clock=""
                  className="absolute bottom-0 h-1.5 w-0.5 bg-live"
                  style={{ insetInlineStart: `max(0px, calc(var(${GRID_NOW_VAR}, 0px) - ${base + b.left + 2}px))` }}
                />
              ) : null}
              {/* The clipped title is shifted inside its fixed programme cell and capped before
                  its end. Offscreen titles stay ordinary text with no sticky constraints. */}
              <span
                data-testid="cell-text"
                className="block w-max max-w-full"
                data-pad-left={b.left + base}
                data-pad-width={b.width}
                data-pad-rtl={rtl || undefined}
              >
                <span className={cn('flex items-center gap-1 truncate text-body-sm', b.when === 'now' && !muted ? 'font-semibold' : 'font-medium')}>
                  {b.when === 'past' && catchupOk ? <History className="size-3.5 shrink-0" aria-hidden /> : null}
                  <span dir="auto" className="truncate text-match-parent">
                    {p.title}
                  </span>
                  {/* recording: */}
                  <ScheduleMarkView index={schedule} channelRef={ch?.ref} program={p} />
                </span>
                <span className={cn('block truncate text-caption tabular-nums', !muted && b.when !== 'past' && 'text-fg-muted')}>{range}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}, sameChunk);

function sameChunk(prev: ProgrammeChunkProps, next: ProgrammeChunkProps): boolean {
  for (const key of Object.keys(next) as (keyof ProgrammeChunkProps)[]) {
    if (key !== 'chunk' && key !== 'now' && key !== 'schedule' && key !== 'initialPopulation' && prev[key] !== next[key]) return false;
  }
  if (!sameProgrammeChunk(prev.chunk, next.chunk)) return false;
  for (const { program } of next.chunk.blocks) {
    if (prev.now !== next.now && next.channel &&
      canCatchUp(program, next.channel, next.kind, prev.now) !== canCatchUp(program, next.channel, next.kind, next.now)) return false;
    if (prev.schedule !== next.schedule) {
      const before = markFor(prev.schedule, prev.channel?.ref, program);
      const after = markFor(next.schedule, next.channel?.ref, program);
      if (before.reminder !== after.reminder || before.recording !== after.recording) return false;
    }
  }
  return true;
}
