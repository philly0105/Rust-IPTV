/**
 * The day picker: underline tabs over the Eastern dates ESPN files games under, a week back and a
 * week ahead. Each tab is two short lines, so the whole fortnight fits a laptop window: Yesterday,
 * Today and Tomorrow by name or the weekday, over the date, in the UI language. The kit's tabs
 * scroll sideways with faded edges where the window is narrower, and take arrows, Home and End.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Tabs } from '../deps';

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

const formatters = new Map<string, { weekday: Intl.DateTimeFormat; date: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();

function formattersFor(lang: string) {
  let f = formatters.get(lang);
  if (!f) {
    f = {
      weekday: new Intl.DateTimeFormat(lang, { weekday: 'short' }),
      date: new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' }),
      full: new Intl.DateTimeFormat(lang, { weekday: 'long', month: 'long', day: 'numeric' }),
    };
    formatters.set(lang, f);
  }
  return f;
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
  const items = useMemo(() => {
    const f = formattersFor(lang);
    return days.map((day) => {
      const at = localNoon(day);
      const diff = Math.round((utcOf(day) - utcOf(today)) / DAY_MS);
      const near = diff === 0 ? t('today') : diff === -1 ? t('yesterday') : diff === 1 ? t('tomorrow') : null;
      return {
        id: day,
        label: (
          <span className="flex flex-col items-center gap-0.5 leading-tight" title={f.full.format(at)}>
            <span className={near ? 'text-xs font-semibold' : 'text-xs font-normal opacity-80'}>{near ?? f.weekday.format(at)}</span>
            {/* Not drawn between the two flex lines, but it keeps the tab's name "Today Oct 25", not "TodayOct 25". */}{' '}
            <span className="text-xs tabular-nums font-normal opacity-80">{f.date.format(at)}</span>
          </span>
        ),
      };
    });
  }, [days, today, t, lang]);
  return (
    <div data-testid="sports-days" className="min-w-0">
      <Tabs
        items={items}
        value={value}
        onChange={onChange}
        label={t('days')}
        panelIdPrefix={panelIdPrefix}
        // Two lines a tab: taller and narrower than the kit's one-line tabs.
        className="[&>button]:h-12 [&>button]:min-w-16 [&>button]:justify-center [&>button]:px-2"
      />
    </div>
  );
}
