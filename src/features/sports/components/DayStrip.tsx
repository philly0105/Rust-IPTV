/**
 * The day picker: underline tabs over the Eastern dates ESPN files games under, a week back and a
 * week ahead. Yesterday, Today and Tomorrow by name, the rest as a short weekday and date in the UI
 * language. The kit's tabs scroll sideways with faded edges and take arrows, Home and End.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Tabs, formatDay } from '../deps';

const DAY_MS = 86_400_000;

function utcOf(day: string): number {
  const [y = NaN, m = NaN, d = NaN] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Midday of `day` on the viewer's calendar, so the formatter names that date whatever the zone. */
function localNoon(day: string): number {
  const [y = NaN, m = NaN, d = NaN] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

export function DayStrip({
  days,
  value,
  today,
  onChange,
  panelIdPrefix,
}: {
  /** 'YYYY-MM-DD' Eastern dates, oldest first. */
  days: readonly string[];
  value: string;
  today: string;
  onChange(day: string): void;
  panelIdPrefix: string;
}) {
  const { t, i18n } = useTranslation('sports');
  const lang = i18n.language;
  const items = useMemo(
    () =>
      days.map((day) => {
        const diff = Math.round((utcOf(day) - utcOf(today)) / DAY_MS);
        const label = diff === 0 ? t('today') : diff === -1 ? t('yesterday') : diff === 1 ? t('tomorrow') : formatDay(localNoon(day), lang);
        return { id: day, label: <span className="tabular-nums">{label}</span> };
      }),
    [days, today, t, lang],
  );
  return (
    <div data-testid="sports-days">
      <Tabs items={items} value={value} onChange={onChange} label={t('days')} panelIdPrefix={panelIdPrefix} />
    </div>
  );
}
