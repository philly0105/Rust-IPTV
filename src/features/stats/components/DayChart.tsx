/**
 * Watch time per day: one stacked bar per day, live at the base in solid
 * accent and movies/series above it in accent hatching, so the two parts
 * differ by pattern as well as by shade. Gridlines carry their own labels.
 *
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

/** Movies and series: accent hatching inside an accent outline. */
export const VOD_FILL = 'border border-accent bg-[repeating-linear-gradient(135deg,var(--color-accent)_0_1.5px,transparent_1.5px_5px)]';

export interface DayChartProps {
  days: readonly WatchStatsDay[];
  /** Today's local date; its label is always printed and drawn in full colour. */
  today: string;
}

export function DayChart({ days, today }: DayChartProps) {
  const { t, i18n } = useTranslation('stats');
  const lang = i18n.language;
  const [picked, setPicked] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const headingId = useId();
  const tableId = useId();
  const scale = useMemo(() => chartScale(days), [days]);

  const found = picked ? days.findIndex((d) => d.day === picked) : -1;
  const index = found >= 0 ? found : days.length - 1;
  const current = days[index];
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
        <h2 id={headingId} className="font-display text-[calc(15rem/15)] font-semibold">
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

      {/* The plot. ms-12 leaves the gutter the gridline labels hang into. */}
      <div className="relative ms-12 mt-2 h-44 sm:h-56">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border" />
        {scale.ticks.map((s) => (
          <div
            key={s}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-divider"
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
            return (
              <div
                key={d.day}
                className="relative flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center"
                onClick={() => setPicked(d.day)}
                data-day={d.day}
                data-selected={i === index || undefined}
              >
                {i === index && <div aria-hidden className="absolute inset-0 rounded-sm bg-surface-2" />}
                <div
                  aria-hidden
                  className="relative flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-[3px] motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-out"
                  style={{ height: `${height}%` }}
                >
                  {d.liveSeconds > 0 && <div className="shrink-0 bg-accent" style={{ height: `${livePart}%` }} />}
                  {d.vodSeconds > 0 && <div className={cn('min-h-0 flex-1 rounded-t-[3px]', VOD_FILL)} />}
                </div>
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
