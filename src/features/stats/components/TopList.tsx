/**
 * The two ranked lists under the chart. Channels (live and radio) get a
 * meter against the most-watched one and a Play button; titles (movies and
 * series) link to their detail page. Both are ordered lists, so the rank is
 * part of the semantics and the printed number is decoration.
 */

import { Play } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { WatchStatsTop } from '@/api/types';

import { IconButton, Poster, itemPath } from '../deps';
import { formatWatchTime } from '../lib/format';

function TopSection({ title, empty, testId, children }: { title: string; empty: string | null; testId: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 border-t border-divider pt-4" data-testid={testId}>
      <h2 id={headingId} className="mb-2 font-display text-[calc(15rem/15)] font-semibold">
        {title}
      </h2>
      {empty ? <p className="py-6 text-sm text-fg-muted">{empty}</p> : <ol className="flex flex-col">{children}</ol>}
    </section>
  );
}

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
        <li key={`${item.ref.sourceId}|${item.ref.contentType}|${item.ref.itemId}`} className="flex items-center gap-3 py-2" data-testid="stats-channel">
          <Rank n={i + 1} />
          <Poster
            src={item.posterUrl ?? null}
            sourceId={item.ref.sourceId}
            alt=""
            label={item.title}
            aspect="square"
            fit="contain"
            kind={item.ref.contentType === 'radio' ? 'radio' : 'live'}
            rounded="sm"
            className="w-10 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="truncate font-medium">{item.title}</p>
              <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-fg-muted">{formatWatchTime(item.seconds, i18n.language)}</span>
            </div>
            {item.sourceName && <p className="truncate text-xs text-fg-subtle">{item.sourceName}</p>}
            <div aria-hidden className="mt-1.5 h-1 rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${most > 0 ? Math.max(2, (item.seconds / most) * 100) : 0}%` }} />
            </div>
          </div>
          {canPlay(item) && (
            <IconButton
              label={t('playLabel', { title: item.title })}
              icon={<Play size={16} aria-hidden />}
              variant="ghost"
              size="sm"
              onClick={() => onPlay(item)}
              data-testid="stats-play"
            />
          )}
        </li>
      ))}
    </TopSection>
  );
}

export function TopTitles({ items }: { items: readonly WatchStatsTop[] }) {
  const { t, i18n } = useTranslation('stats');
  return (
    <TopSection title={t('topTitles')} empty={items.length === 0 ? t('noTitles') : null} testId="stats-top-titles">
      {items.map((item, i) => (
        <li key={`${item.ref.sourceId}|${item.ref.contentType}|${item.ref.itemId}`} className="flex items-center gap-3 py-1.5" data-testid="stats-title">
          <Rank n={i + 1} />
          <Link
            to={itemPath(item.ref)}
            aria-label={t('openLabel', { title: item.title })}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-0.5 hover:bg-surface-2 motion-safe:transition-colors"
            data-testid="stats-open"
          >
            <Poster src={item.posterUrl ?? null} sourceId={item.ref.sourceId} alt="" label={item.title} aspect="poster" rounded="sm" className="w-9 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{item.title}</span>
              {item.sourceName && <span className="block truncate text-xs text-fg-subtle">{item.sourceName}</span>}
            </span>
            <span className="shrink-0 whitespace-nowrap pe-1 text-sm tabular-nums text-fg-muted">{formatWatchTime(item.seconds, i18n.language)}</span>
          </Link>
        </li>
      ))}
    </TopSection>
  );
}
