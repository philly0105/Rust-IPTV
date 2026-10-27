/**
 * The day picker: underline tabs over the Eastern dates ESPN files games under, a week back and a
 * week ahead. Each tab is two short lines, so the whole fortnight fits a laptop window: Yesterday,
 * Today and Tomorrow by name or the weekday, over the date, in the UI language. The kit's tabs
 * scroll sideways with faded edges where the window is narrower, and take arrows, Home and End;
 * there the picked day sits in the middle, with the days either side of it in view.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Tabs, cn, intlLocale } from '../deps';

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

/**
 * Scrolls a strip that is wider than its box so the picked tab sits in the middle. The kit only
 * keeps a picked tab clear of the faded edge, which on a phone opened the strip with Today at its
 * end and Tomorrow, the likeliest next pick, cut off. Physical coordinates, so RTL works as is.
 */
function centreTab(list: HTMLElement, smooth: boolean) {
  const tab = list.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
  if (!tab || list.scrollWidth - list.clientWidth <= 1) return;
  const box = list.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  if (box.width <= 0) return;
  const by = r.left + r.width / 2 - (box.left + box.width / 2);
  if (Math.abs(by) < 1) return;
  if (smooth && typeof list.scrollBy === 'function') list.scrollBy({ left: by, behavior: 'smooth' });
  else list.scrollLeft += by;
}

const formatters = new Map<string, { weekday: Intl.DateTimeFormat; date: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();

function formattersFor(lang: string) {
  let f = formatters.get(lang);
  if (!f) {
    // The app's language codes are not all Intl's (Moroccan Arabic formats as Arabic).
    const locale = intlLocale(lang);
    f = {
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
      date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
      full: new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }),
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
  className,
}: {
  /** 'YYYY-MM-DD' Eastern dates, oldest first. */
  days: readonly string[];
  value: string;
  today: string;
  onChange(day: string): void;
  panelIdPrefix: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation('sports');
  const lang = i18n.language;
  const boxRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // On opening, and on every pick after it: the first jump is instant, a pick glides where motion is
  // welcome. From a one-shot observer, as the kit's own reveal, so it runs after the browser's layout
  // and after that reveal, and the strip opens centred in its first frame.
  useLayoutEffect(() => {
    const list = boxRef.current?.querySelector<HTMLElement>('[role=tablist]');
    if (!list) return;
    const smooth = opened.current && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    opened.current = true;
    if (typeof ResizeObserver === 'undefined') return centreTab(list, smooth);
    const ro = new ResizeObserver(() => {
      ro.disconnect();
      centreTab(list, smooth);
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, [value, days]);
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
    <div ref={boxRef} data-testid="sports-days" className={cn('min-w-0', className)}>
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
