/**
 * The two ranked lists under the chart, on one row template so they line up
 * side by side: the same rank column, the same artwork frame (a 2:3 box that
 * holds a poster whole and a channel logo centred), the same row height, and
 * the same trailing column (a channel's Play button, a title's chevron), so
 * rank 5 sits on one line in both and the meters end at one edge. Each row has
 * a meter against the list's most-watched item (VL-stats-interaction), neutral
 * because it is a share, not progress. Channels (live and radio) get a Play
 * button on hover or focus; titles (movies and series) link to their detail
 * page. Both are ordered lists, so the rank is part of the semantics and the
 * printed number is decoration.
 */

import { ChevronRight, Play } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { WatchStatsTop } from '@/api/types';

import { IconButton, Poster, cn, itemPath } from '../deps';
import { formatWatchTime } from '../lib/format';

function TopSection({ title, empty, testId, children }: { title: string; empty: string | null; testId: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="@container min-w-0 border-t border-divider pt-4" data-testid={testId}>
      <h2 id={headingId} className="mb-2 text-title-sm">
        {title}
      </h2>
      {empty ? <p className="py-6 text-sm text-fg-muted">{empty}</p> : <ol className="flex flex-col">{children}</ol>}
    </section>
  );
}

/** A row's share of the list's most-watched item. */
function Meter({ seconds, most }: { seconds: number; most: number }) {
  return (
    <div aria-hidden className="mt-1.5 h-1 rounded-full bg-surface-3 @sm:col-span-2" data-testid="stats-meter">
      <div className="h-full rounded-full bg-fg-subtle" style={{ width: `${most > 0 ? Math.max(2, (seconds / most) * 100) : 0}%` }} />
    </div>
  );
}

/** From sm, on a fine pointer, a row's Play button waits for hover or focus. */
const revealOnFine =
  'sm:pointer-fine:opacity-0 sm:pointer-fine:group-hover:opacity-100 sm:pointer-fine:group-focus-within:opacity-100 motion-safe:transition-opacity';

/** One row, either list: a fixed height for one-line names (a long name wraps only in a narrow list). */
const ROW = 'flex min-h-17 items-center gap-3 py-1';
/** The artwork frame: a poster fills it, a square logo sits centred in it. */
const ART = 'flex h-15 w-10 shrink-0 items-center';
/** The trailing column: an IconButton's footprint (44 px under a coarse pointer), kept in every row. */
const TRAILING = 'flex h-8 w-8 shrink-0 items-center justify-center pointer-coarse:w-[calc(44rem/15)]';
/** The name: two lines at most in a narrow list, one beside the time from @sm, so rows keep one height. */
const NAME = 'line-clamp-2 font-medium [overflow-wrap:anywhere] @sm:line-clamp-1';

function Rank({ n }: { n: number }) {
  return (
    <span aria-hidden className="w-5 shrink-0 text-end text-sm tabular-nums text-fg-subtle">
      {n}
    </span>
  );
}

export interface TopChannelsProps {
  items: readonly WatchStatsTop[];
  /** False when the channel's source is gone or being removed: no Play button then. */
  canPlay: (item: WatchStatsTop) => boolean;
  onPlay: (item: WatchStatsTop) => void;
}

export function TopChannels({ items, canPlay, onPlay }: TopChannelsProps) {
  const { t, i18n } = useTranslation('stats');
  const most = items[0]?.seconds ?? 0;
  return (
    <TopSection title={t('topChannels')} empty={items.length === 0 ? t('noChannels') : null} testId="stats-top-channels">
      {items.map((item, i) => (
        <li key={`${item.ref.sourceId}|${item.ref.contentType}|${item.ref.itemId}`} className={cn('group', ROW)} data-testid="stats-channel">
          <Rank n={i + 1} />
          <span className={ART}>
            <Poster
              src={item.posterUrl ?? null}
              sourceId={item.ref.sourceId}
              alt=""
              label={item.title}
              aspect="square"
              fit="contain"
              kind={item.ref.contentType === 'radio' ? 'radio' : 'live'}
              rounded="sm"
              className="w-full"
            />
          </span>
          {/* Narrow list: name (two lines at most), time, source. From @sm the time moves to the end of the name's line. */}
          <div className="grid min-w-0 flex-1 grid-cols-1 items-baseline @sm:grid-cols-[minmax(0,1fr)_auto] @sm:gap-x-3">
            <p className={NAME} title={item.title}>
              {item.title}
            </p>
            <span className="whitespace-nowrap text-sm tabular-nums text-fg-muted">{formatWatchTime(item.seconds, i18n.language)}</span>
            {item.sourceName && <p className="truncate text-xs text-fg-subtle @sm:col-span-2">{item.sourceName}</p>}
            <Meter seconds={item.seconds} most={most} />
          </div>
          {canPlay(item) ? (
            <IconButton
              label={t('playLabel', { title: item.title })}
              icon={<Play size={16} aria-hidden />}
              variant="ghost"
              size="sm"
              onClick={() => onPlay(item)}
              className={cn('shrink-0', revealOnFine)}
              data-testid="stats-play"
            />
          ) : (
            // The source is gone: the column stays, so this row's meter ends where the others do.
            <span aria-hidden className={TRAILING} />
          )}
        </li>
      ))}
    </TopSection>
  );
}

export function TopTitles({ items }: { items: readonly WatchStatsTop[] }) {
  const { t, i18n } = useTranslation('stats');
  const most = items[0]?.seconds ?? 0;
  return (
    <TopSection title={t('topTitles')} empty={items.length === 0 ? t('noTitles') : null} testId="stats-top-titles">
      {items.map((item, i) => (
        <li key={`${item.ref.sourceId}|${item.ref.contentType}|${item.ref.itemId}`} className={ROW} data-testid="stats-title">
          <Rank n={i + 1} />
          {/* The link's box is the channel row's (no padding of its own); its hover surface reaches a little past it. */}
          <Link
            to={itemPath(item.ref)}
            aria-label={t('openLabel', { title: item.title })}
            className="group relative isolate flex min-w-0 flex-1 items-center gap-3 rounded-md before:absolute before:-inset-1 before:-z-10 before:rounded-md before:content-[''] hover:before:bg-hover motion-safe:before:transition-colors"
            data-testid="stats-open"
          >
            <span className={ART}>
              <Poster src={item.posterUrl ?? null} sourceId={item.ref.sourceId} alt="" label={item.title} aspect="poster" rounded="sm" className="w-full" />
            </span>
            {/* The channel rows' template: name and time on one line from @sm, the source under it, then the meter. */}
            <span className="grid min-w-0 flex-1 grid-cols-1 items-baseline @sm:grid-cols-[minmax(0,1fr)_auto] @sm:gap-x-3">
              <span className={NAME} title={item.title}>
                {item.title}
              </span>
              <span className="whitespace-nowrap text-sm tabular-nums text-fg-muted">{formatWatchTime(item.seconds, i18n.language)}</span>
              {item.sourceName && <span className="block truncate text-xs text-fg-subtle @sm:col-span-2">{item.sourceName}</span>}
              <Meter seconds={item.seconds} most={most} />
            </span>
            {/* Where a channel row has Play: says the row opens, and keeps the meters to one edge. */}
            <span aria-hidden className={cn(TRAILING, 'text-fg-subtle', revealOnFine)}>
              <ChevronRight size={16} className="rtl:rotate-180" />
            </span>
          </Link>
        </li>
      ))}
    </TopSection>
  );
}
