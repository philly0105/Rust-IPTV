import { History, Lock, Star } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgNowNext, SourceKind } from '@/api/types';
import { listSeparator } from '@/lib/intl';
import { Tooltip } from '@/ui/Tooltip';

import { displayChannelName } from '../lib/channelName';
import { formatClock, hasUsableArchive, isValidProgram, minutesLeft, ms, programProgress, shiftNowNext } from '../lib/epgTime';
import { ChannelLogo } from './ChannelLogo';

export const CHANNEL_ROW_HEIGHT = 64;
/**
 * The part of {@link CHANNEL_ROW_HEIGHT} made of Tailwind spacing at 100 %,
 * which compact density tightens: py-2 (15 px at the 15 px root) plus the two
 * gap-0.5 between name, programme and progress bar (3.75 px).
 */
export const CHANNEL_ROW_SPACING = 19;

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
  /** Parental Ask mode: the channel asks for the PIN, so the row carries a lock and keeps its programmes back. */
  locked?: boolean;
  onActivate(index: number, how: 'click' | 'double' | 'key'): void;
  onToggleFavorite(channel: Channel, favorite: boolean): void;
  onContextMenu(e: MouseEvent, channel: Channel, index: number): void;
}

/** Same columns and height as a loaded row, so nothing moves when the data lands. */
export function RowSkeleton({ pulse = false }: { pulse?: boolean }) {
  return (
    <div className={`flex h-full items-center gap-3 ps-3 pe-3 ${pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden>
      <span className="h-3 w-8 shrink-0 rounded-xs bg-surface-3" />
      <span className="size-9 shrink-0 rounded-md bg-surface-3" />
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="h-3 w-2/5 rounded-xs bg-surface-3" />
        <span className="h-2.5 w-3/5 rounded-xs bg-surface-2" />
      </span>
    </div>
  );
}

export const ChannelRow = memo(function ChannelRow(props: ChannelRowProps) {
  const { t, i18n } = useTranslation('live');
  const { channel, nowNext, favorite, playing, active, index, now, compact } = props;
  if (!channel) return <RowSkeleton />;

  const locked = props.locked ?? false;
  // A locked channel's programme titles wait for the PIN, like its stream.
  const shifted = locked ? undefined : shiftNowNext(nowNext, props.epgOffsetMinutes ?? 0);
  // A programme with unreadable times would read as airing since 1970: show the group instead.
  const cur = shifted?.now && isValidProgram(shifted.now) ? shifted.now : undefined;
  const nxt = shifted?.next && isValidProgram(shifted.next) ? shifted.next : undefined;
  const progress = cur ? programProgress(cur, now) : 0;
  const archive = hasUsableArchive(channel, props.sourceKind);
  const name = displayChannelName(channel.name, props.stripPrefix);
  const left = cur ? minutesLeft(cur, now) : 0;

  return (
    <div
      className={`group relative flex h-full items-stretch border-b border-divider ${
        playing ? 'bg-selected' : active ? 'bg-hover' : 'hover:bg-hover'
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
          locked ? t('locked') : '',
          cur ? t('nowShowing', { title: cur.title }) : '',
          playing ? t('playingNow') : '',
        ]
          .filter(Boolean)
          .join(listSeparator(i18n.language))}
        onClick={() => props.onActivate(index, 'click')}
        onDoubleClick={() => props.onActivate(index, 'double')}
        className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-3 pe-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <span className="w-8 shrink-0 text-end font-numeric text-sm tabular-nums text-fg-subtle">{channel.number ?? ''}</span>
        {!compact ? <ChannelLogo src={channel.logoUrl} name={name} sourceId={channel.ref.sourceId} /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className={`truncate text-sm text-match-parent ${playing ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>{name}</span>
            {locked ? <Lock data-testid="row-locked" aria-hidden className="size-3 shrink-0 text-fg-subtle" /> : null}
          </span>
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
                {/* Neutral on every row, the accent on the one playing: a list of red bars read as "all live, all alerting". */}
                <span
                  data-testid="channel-progress"
                  className={`absolute inset-y-0 start-0 rounded-full ${playing ? 'bg-accent' : 'bg-fg-subtle'}`}
                  style={{ width: `${progress * 100}%` }}
                />
              </span>
              {nxt && !compact ? (
                // Only the title truncates, in its own direction: one RTL truncate over clock and a Latin
                // title put the ellipsis at the title's start ("…ews Today").
                <span className="flex min-w-0 items-baseline gap-1 text-[calc(11rem/15)] text-fg-subtle" data-testid="row-next">
                  <span className="shrink-0 tabular-nums">{formatClock(ms(nxt.start), i18n.language)}</span>
                  <span dir="auto" className="min-w-0 truncate text-match-parent" data-testid="row-next-title" title={nxt.title}>
                    {nxt.title}
                  </span>
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
        ) : (
          // The slot stays when a row has no archive, so progress bars and times line up row to row.
          <span aria-hidden className="size-6" />
        )}
        <Tooltip content={favorite ? t('removeFavorite') : t('addFavorite')} describe={false}>
          <button
            type="button"
            tabIndex={-1}
            aria-pressed={favorite}
            aria-label={favorite ? t('removeFavorite') : t('addFavorite')}
            onClick={() => props.onToggleFavorite(channel, favorite)}
            className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-surface-3 ${
              favorite ? 'text-warning' : 'text-fg-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            }`}
          >
            <Star className="size-4" fill={favorite ? 'currentColor' : 'none'} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
});
