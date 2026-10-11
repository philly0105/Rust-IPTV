import { History, Star } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgNowNext, SourceKind } from '@/api/types';

import { displayChannelName } from '../lib/channelName';
import { formatClock, hasUsableArchive, minutesLeft, ms, programProgress, shiftNowNext } from '../lib/epgTime';
import { ChannelLogo } from './ChannelLogo';

export const CHANNEL_ROW_HEIGHT = 64;

export interface ChannelRowProps {
  index: number;
  channel?: Channel;
  nowNext?: EpgNowNext;
  favorite: boolean;
  playing: boolean;
  active: boolean;
  compact?: boolean;
  now: number;
  /** Hides the archive icon when the source cannot play this channel's catch-up. */
  sourceKind?: SourceKind;
  /** `settings.stripCountryPrefix` */
  stripPrefix?: boolean;
  /** `settings.epgOffsetMinutes` */
  epgOffsetMinutes?: number;
  /** Stalker: the portal's guide is not answering, so a row without a programme says so. */
  guideUnavailable?: boolean;
  onActivate(index: number, how: 'click' | 'double' | 'key'): void;
  onToggleFavorite(channel: Channel, favorite: boolean): void;
  onContextMenu(e: MouseEvent, channel: Channel, index: number): void;
}

function RowSkeleton() {
  return (
    <div className="flex h-full items-center gap-3 px-3" aria-hidden>
      <span className="h-3 w-6 rounded bg-surface-3" />
      <span className="size-9 rounded-md bg-surface-3" />
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="h-3 w-2/5 rounded bg-surface-3" />
        <span className="h-2.5 w-3/5 rounded bg-surface-2" />
      </span>
    </div>
  );
}

export const ChannelRow = memo(function ChannelRow(props: ChannelRowProps) {
  const { t, i18n } = useTranslation('live');
  const { channel, nowNext, favorite, playing, active, index, now, compact } = props;
  if (!channel) return <RowSkeleton />;

  const shifted = shiftNowNext(nowNext, props.epgOffsetMinutes ?? 0);
  const cur = shifted?.now;
  const nxt = shifted?.next;
  const progress = cur ? programProgress(cur, now) : 0;
  const archive = hasUsableArchive(channel, props.sourceKind);
  const name = displayChannelName(channel.name, props.stripPrefix);
  const left = cur ? minutesLeft(cur, now) : 0;

  return (
    <div
      className={`group relative flex h-full items-stretch border-b border-border/60 ${
        playing ? 'bg-accent/10' : active ? 'bg-surface-2' : 'hover:bg-surface-2/70'
      }`}
      onContextMenu={(e) => props.onContextMenu(e, channel, index)}
    >
      {playing ? <span aria-hidden className="absolute inset-y-2 start-0 w-[3px] rounded-e bg-accent" /> : null}
      <button
        type="button"
        data-row-index={index}
        tabIndex={active ? 0 : -1}
        aria-current={playing ? 'true' : undefined}
        aria-label={[
          channel.number !== undefined ? `${channel.number}` : '',
          name,
          cur ? t('nowShowing', { title: cur.title }) : '',
          playing ? t('playingNow') : '',
        ]
          .filter(Boolean)
          .join(', ')}
        onClick={() => props.onActivate(index, 'click')}
        onDoubleClick={() => props.onActivate(index, 'double')}
        className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-3 pe-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <span className="w-8 shrink-0 text-end text-xs tabular-nums text-fg-subtle">{channel.number ?? ''}</span>
        {!compact ? <ChannelLogo src={channel.logoUrl} name={name} /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span dir="auto" className={`truncate text-sm text-match-parent ${playing ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>{name}</span>
          {cur ? (
            <>
              {/* The title takes the width; the remaining time stays a compact "38m" so narrow lists keep the title readable. */}
              <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-fg-muted">
                <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent" title={cur.title}>
                  {cur.title}
                </span>
                <span className="shrink-0 tabular-nums text-fg-subtle" title={t('minutesLeft', { count: left })}>
                  {t('minutesLeftShort', { count: left })}
                </span>
              </span>
              <span className="relative h-[3px] w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
                <span data-testid="channel-progress" className="absolute inset-y-0 start-0 rounded-full bg-live" style={{ width: `${progress * 100}%` }} />
              </span>
              {nxt && !compact ? (
                <span className="truncate text-[11px] text-fg-subtle">
                  {formatClock(ms(nxt.start), i18n.language)}{' '}
                  <bdi>{nxt.title}</bdi>
                </span>
              ) : null}
            </>
          ) : props.guideUnavailable ? (
            <span className="truncate text-xs text-fg-subtle" data-testid="row-guide-unavailable">
              {t('guideNotAnswering')}
            </span>
          ) : (
            <span className="truncate text-xs text-fg-subtle">{channel.categoryName}</span>
          )}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 pe-2">
        {archive ? (
          <span
            title={
              channel.archive?.durationHours
                ? t('archiveDays', { count: Math.max(1, Math.round(channel.archive.durationHours / 24)) })
                : t('archive')
            }
            className="inline-flex size-6 items-center justify-center text-fg-subtle"
          >
            <History className="size-3.5" aria-label={t('archive')} />
          </span>
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          aria-pressed={favorite}
          aria-label={favorite ? t('removeFavorite') : t('addFavorite')}
          title={favorite ? t('removeFavorite') : t('addFavorite')}
          onClick={() => props.onToggleFavorite(channel, favorite)}
          className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-surface-3 ${
            favorite ? 'text-warning' : 'text-fg-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <Star className="size-4" fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </span>
    </div>
  );
});
