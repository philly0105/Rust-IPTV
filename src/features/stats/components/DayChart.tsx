/**
 * Watch time per day: one stacked bar per day, live at the base in the solid
 * accent and movies/series above it in a lighter tone of it, with a 2 px gap
 * between the parts (the accent is the user's choice, so the second series is
 * a step of the same hue; the pair is about 21 OKLab ΔE apart for every kind
 * of colour vision, and the legend, the table and the readout name the parts).
 * Under forced colours the movies part turns to hatching. Gridlines carry
 * their own labels.
 *
 * Pointer: resting on a day shows a small card above its bar with the total
 * and the split (VL-stats-interaction), and dims the other days; clicking
 * keeps that day picked.
 * Keyboard: the bar area is one tab stop exposed as a slider over the days;
 * ArrowLeft/ArrowRight follow the screen (mirrored in RTL), Home and End jump
 * to the first and last day, and the value text reads the picked day aloud.
 * The same numbers are in a table, always in the accessibility tree and
 * shown on screen with the table toggle.
 *
 * The 7-day axis prints short weekday names, which are whole words in some
 * locales (Arabic "الأربعاء"). A hidden probe holds them in the label font;
 * when the widest is wider than a column (a phone, a long locale) the axis
 * switches to narrow names ("ر", "T") and back when the row widens.
 */

import { Table2 } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { WatchStatsDay } from '@/api/types';

import { Button, cn } from '../deps';
import { barPercent, chartScale, labelsFit, showDayLabel } from '../lib/chart';
import { dayOfMonthLabel, formatAxisHours, formatAxisMinutes, formatWatchTime, longDayLabel, narrowWeekdayLabel, weekdayLabel } from '../lib/format';

/**
 * Movies and series: a lighter step of the mark tone; hatching under forced colours, where fills
 * are dropped. The legend tiles, the tooltip and the table view name both series, so the pair is
 * never told apart by colour alone.
 */
export const VOD_FILL = 'bg-accent-mark/50 forced-colors:bg-[repeating-linear-gradient(135deg,CanvasText_0_1.5px,transparent_1.5px_5px)]';
/**
 * Live: the accent's mark tone (design-system.md), the amber of the progress bars in both themes.
 * `bg-accent` is the text tone, deep brown in light, which made the light chart read as another brand.
 */
export const LIVE_FILL = 'bg-accent-mark forced-colors:bg-[CanvasText]';

export interface DayChartProps {
  days: readonly WatchStatsDay[];
  /** Today's local date; its label is always printed and drawn in full colour. */
  today: string;
}

export function DayChart({ days, today }: DayChartProps) {
  const { t, i18n } = useTranslation('stats');
  const lang = i18n.language;
  const [picked, setPicked] = useState<string | null>(null);
  // The day under the pointer: its card shows above the bar while the pointer rests there.
  const [hovered, setHovered] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const headingId = useId();
  const tableId = useId();
  const scale = useMemo(() => chartScale(days), [days]);

  const found = picked ? days.findIndex((d) => d.day === picked) : -1;
  const index = found >= 0 ? found : days.length - 1;
  const current = days[index];
  const hoverIndex = hovered ? days.findIndex((d) => d.day === hovered) : -1;
  // A day singled out (resting pointer, or picked by click or key) lights up; the others step back.
  const focusIndex = hoverIndex >= 0 ? hoverIndex : found;
  const short = days.length <= 7;

  const labelsRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [narrow, setNarrow] = useState(false);
  const weekdays = useMemo(() => (short ? days.map((d) => weekdayLabel(d.day, lang)) : []), [short, days, lang]);

  useLayoutEffect(() => {
    const row = labelsRef.current;
    const probe = probeRef.current;
    if (!row || !probe) {
      setNarrow(false);
      return;
    }
    const check = () => setNarrow(!labelsFit(row.clientWidth, parseFloat(getComputedStyle(row).columnGap) || 0, weekdays.length, probe.offsetWidth));
    check();
    if (typeof ResizeObserver === 'undefined') return;
    // The probe too: its width changes when the web font arrives.
    const ro = new ResizeObserver(check);
    ro.observe(row);
    ro.observe(probe);
    return () => ro.disconnect();
  }, [weekdays]);

  const time = (s: number) => formatWatchTime(s, lang);
  const readout = (d: WatchStatsDay) =>
    d.seconds > 0
      ? t('dayReadout', { day: longDayLabel(d.day, lang), total: time(d.seconds), live: time(d.liveSeconds), vod: time(d.vodSeconds) })
      : t('dayNone', { day: longDayLabel(d.day, lang) });
  const tick = (s: number) => (s < 3600 ? formatAxisMinutes(s, lang) : formatAxisHours(s, lang));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
        next = index + (rtl ? 1 : -1);
        break;
      case 'ArrowRight':
        next = index + (rtl ? -1 : 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = days.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const day = days[Math.min(days.length - 1, Math.max(0, next))];
    if (day) setPicked(day.day);
  };

  return (
    <section aria-labelledby={headingId} data-testid="stats-chart">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-title-sm">
          {t('perDay')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          icon={<Table2 size={16} aria-hidden />}
          aria-controls={tableId}
          aria-expanded={showTable}
          onClick={() => setShowTable((v) => !v)}
          data-testid="stats-table-toggle"
        >
          {showTable ? t('hideTable') : t('showTable')}
        </Button>
      </div>

      {/* The plot. ms-12 leaves the gutter the gridline labels hang into; mt-8 the room for a day's card. */}
      <div className="relative ms-12 mt-8 h-44 sm:h-56" onPointerLeave={() => setHovered(null)}>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border" />
        {scale.ticks.map((s) => (
          <div
            key={s}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 border-t border-divider"
            style={{ bottom: `${(s / scale.top) * 100}%` }}
          >
            <span className="absolute end-full top-0 me-2 -translate-y-1/2 whitespace-nowrap text-[11px] tabular-nums text-fg-subtle">{tick(s)}</span>
          </div>
        ))}
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('perDay')}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, days.length - 1)}
          aria-valuenow={index}
          aria-valuetext={current ? readout(current) : undefined}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="absolute inset-0 flex items-end gap-0.5 rounded-sm sm:gap-1"
          data-testid="stats-bars"
        >
          {days.map((d, i) => {
            const height = barPercent(d.seconds, scale.top);
            const livePart = d.seconds > 0 ? (d.liveSeconds / d.seconds) * 100 : 0;
            const both = d.liveSeconds > 0 && d.vodSeconds > 0;
            return (
              <div
                key={d.day}
                // The whole column is the target, wider and taller than the bar.
                className="relative flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center"
                onClick={() => setPicked(d.day)}
                onPointerEnter={(e) => {
                  if (e.pointerType !== 'touch') setHovered(d.day);
                }}
                data-day={d.day}
                data-selected={i === index || undefined}
              >
                <div
                  aria-hidden
                  className={cn(
                    // A 4 px round top, a square foot on the baseline, and a 2 px gap between the two parts.
                    'relative flex w-full max-w-7 flex-col-reverse overflow-hidden rounded-t-xs',
                    'motion-safe:transition-[height,opacity] motion-safe:duration-300 motion-safe:ease-out',
                    both && 'gap-0.5',
                    focusIndex >= 0 && i !== focusIndex && 'opacity-55',
                  )}
                  style={{ height: `${height}%` }}
                  data-testid="stats-bar"
                >
                  {d.liveSeconds > 0 && <div className={cn('shrink-0', LIVE_FILL)} style={{ height: `calc(${livePart}% - ${both ? 1 : 0}px)` }} />}
                  {d.vodSeconds > 0 && <div className={cn('min-h-0 flex-1', VOD_FILL)} />}
                </div>
                {i === hoverIndex && <DayCard day={d} first={i === 0} last={i === days.length - 1} top={height} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Day labels under the bars, in the same columns. */}
      <div ref={labelsRef} aria-hidden className="relative ms-12 mt-1.5 flex gap-0.5 sm:gap-1" data-testid="stats-day-labels">
        {short && (
          // Measures the short names at the selected (semibold) weight; no height, so it never adds scroll.
          <span
            ref={probeRef}
            className="pointer-events-none invisible absolute start-0 top-0 flex h-0 w-max flex-col overflow-hidden whitespace-nowrap text-[11px] font-semibold tabular-nums"
            data-testid="stats-day-probe"
          >
            {weekdays.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </span>
        )}
        {days.map((d, i) => (
          <span
            key={d.day}
            className={cn(
              'min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[11px] tabular-nums',
              i === index || d.day === today ? 'font-semibold text-fg' : 'text-fg-subtle',
            )}
          >
            {showDayLabel(i, days.length) ? (short ? (narrow ? narrowWeekdayLabel(d.day, lang) : weekdays[i]) : dayOfMonthLabel(d.day, lang)) : ''}
          </span>
        ))}
      </div>

      {current && (
        <p className="mt-3 min-h-5 text-sm text-fg-muted" data-testid="stats-readout">
          {readout(current)}
        </p>
      )}

      <div id={tableId} className={cn(showTable ? 'mt-4 overflow-x-auto' : 'sr-only')}>
        <table className="w-full min-w-[20rem] border-collapse text-sm" data-testid="stats-table">
          <caption className="sr-only">{t('perDay')}</caption>
          <thead>
            <tr className="border-b border-divider text-start text-fg-muted">
              <th scope="col" className="py-2 pe-3 text-start font-medium">
                {t('colDay')}
              </th>
              <th scope="col" className="py-2 pe-3 text-end font-medium">
                {t('live')}
              </th>
              <th scope="col" className="py-2 pe-3 text-end font-medium">
                {t('vod')}
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                {t('colTotal')}
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day} className="border-b border-divider last:border-b-0">
                <th scope="row" className="py-2 pe-3 text-start font-normal">
                  {longDayLabel(d.day, lang)}
                </th>
                <td className="py-2 pe-3 text-end tabular-nums text-fg-muted">{time(d.liveSeconds)}</td>
                <td className="py-2 pe-3 text-end tabular-nums text-fg-muted">{time(d.vodSeconds)}</td>
                <td className="py-2 text-end tabular-nums">{time(d.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The resting pointer's day (VL-stats-interaction): the date, the total and the live and movies
 * split, in a small card above the bar. Decorative for assistive technology: the slider's value
 * text and the readout under the chart say the same.
 */
function DayCard({ day, first, last, top }: { day: WatchStatsDay; first: boolean; last: boolean; top: number }) {
  const { t, i18n } = useTranslation('stats');
  const lang = i18n.language;
  const time = (s: number) => formatWatchTime(s, lang);
  return (
    <div
      aria-hidden
      data-testid="stats-day-card"
      className={cn(
        'pointer-events-none absolute z-10 mb-2 w-max max-w-56 rounded-lg border border-edge bg-surface-3 px-3 py-2 text-xs shadow-2',
        // Edge days open inward, so the card never leaves the plot.
        first ? 'start-0' : last ? 'end-0' : 'start-1/2 -translate-x-1/2 rtl:translate-x-1/2',
      )}
      style={{ bottom: `${top}%` }}
    >
      <p className="font-medium text-fg">{longDayLabel(day.day, lang)}</p>
      <p className="text-body-sm font-semibold tabular-nums text-fg">{time(day.seconds)}</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-fg-muted">
        <li className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', LIVE_FILL)} />
          {t('live')} <span className="ms-auto ps-3 tabular-nums text-fg">{time(day.liveSeconds)}</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', VOD_FILL)} />
          {t('vod')} <span className="ms-auto ps-3 tabular-nums text-fg">{time(day.vodSeconds)}</span>
        </li>
      </ul>
    </div>
  );
}
