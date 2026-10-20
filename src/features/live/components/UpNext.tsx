import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgProgram } from '@/api/types';
import { cn } from '@/ui/cn';
import { useRowHeight } from '@/ui/scale';
// recording:
import { ProgramActionsView, ScheduleMarkView, useProgramActionsShared } from '@/features/recording';

import { durationMinutes, formatClock, formatDay, localDayKey, ms, programWhen } from '../lib/epgTime';

/** One Up next row at 100 % (h-11). */
export const UP_NEXT_ROW_PX = 44;
/** The "Up next" label above the rows. */
const LABEL_PX = 32;
/** Never more than this many: it is a glance at what comes, the ribbon's list view has the rest. */
export const UP_NEXT_MAX = 5;
/** Rows drawn before the box is measured (and in tests, where nothing is). */
const UNMEASURED_ROWS = 3;

/** How many rows of `rowPx` fit a box `height` px tall under the label (0: hide the list). */
export function upNextRows(height: number, rowPx: number = UP_NEXT_ROW_PX): number {
  if (!(height > 0)) return UNMEASURED_ROWS;
  return Math.max(0, Math.min(UP_NEXT_MAX, Math.floor((height - LABEL_PX) / rowPx)));
}

export interface UpNextProps {
  /** The channel's display-time programmes, sorted. */
  programs: EpgProgram[];
  now: number;
  channel: Channel;
  channelName: string;
  /** The programme the ribbon's header describes: its row is marked. */
  shown?: EpgProgram;
  onSelect(p: EpgProgram): void;
}

/**
 * The next few programmes under the guide ribbon (LG-02): time, title, length, and Remind and
 * Record on hover or focus. It fills the stage column's free height and shows only as many rows
 * as fit, none on a short window: the box is measured, not scrolled, so a row is never cut in
 * half. Choosing a row puts it in the ribbon's header, whose bell and record menu act on it; that
 * is how a touch screen reaches them, as three 44 px buttons per row cut the titles to "Busines…".
 */
export function UpNext({ programs, now, channel, channelName, shown, onSelect }: UpNextProps) {
  const { t, i18n } = useTranslation('live');
  const lang = i18n.language;
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setHeight(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setHeight(entries[0]?.contentRect.height ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // h-11 and the label's padding are Tailwind spacing: they follow the UI scale and density.
  const rowPx = useRowHeight(UP_NEXT_ROW_PX, UP_NEXT_ROW_PX);
  const upcoming = programs.filter((p) => programWhen(p, now) === 'future').slice(0, upNextRows(height, rowPx));
  const shared = useProgramActionsShared();

  return (
    // Absolutely placed in a flex-1 box, so its rows never add to the column's height: the video
    // above keeps its size and this list takes what is left.
    <div className="relative min-h-0 flex-1 max-md:hidden" data-testid="up-next-box">
      <div ref={box} className="absolute inset-0 overflow-hidden">
        {upcoming.length > 0 ? (
          <section aria-labelledby="up-next-h" className="flex flex-col border-t border-divider px-2 pt-2" data-testid="up-next">
            <h3 id="up-next-h" className="px-2 pb-1 text-caption font-medium text-fg-muted">
              {t('upNext')}
            </h3>
            <ul className="flex flex-col">
              {upcoming.map((p) => {
                const at = ms(p.start);
                const isShown = !!shown && shown.start === p.start && shown.title === p.title;
                const otherDay = localDayKey(at) !== localDayKey(now);
                return (
                  <li
                    key={`${p.start}|${p.title}`}
                    className={cn('group/next relative flex h-11 items-center rounded-md', isShown ? 'bg-selected' : 'hover:bg-hover')}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(p)}
                      aria-current={isShown ? 'true' : undefined}
                      className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                    >
                      <span className="w-16 shrink-0 font-numeric text-sm whitespace-nowrap tabular-nums text-fg-muted">
                        {otherDay ? <span className="sr-only">{formatDay(at, lang)} </span> : null}
                        {formatClock(at, lang)}
                      </span>
                      <span dir="auto" className="min-w-0 flex-1 truncate text-body-sm font-medium text-match-parent text-fg">
                        {p.title}
                      </span>
                      {/* recording: what is set shows at rest; the buttons that set it come on hover. */}
                      <ScheduleMarkView index={shared.index} channelRef={channel.ref} program={p} />
                      <span className="shrink-0 text-caption tabular-nums text-fg-subtle not-pointer-coarse:group-hover/next:hidden not-pointer-coarse:group-focus-within/next:hidden">
                        {t('durationMinutes', { count: durationMinutes(p) })}
                      </span>
                    </button>
                    <span
                      className="hidden shrink-0 items-center pe-1 not-pointer-coarse:group-hover/next:flex not-pointer-coarse:group-focus-within/next:flex"
                      data-testid="up-next-actions"
                    >
                      <ProgramActionsView channelRef={channel.ref} channelName={channelName} program={p} now={now} variant="icons" shared={shared} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
