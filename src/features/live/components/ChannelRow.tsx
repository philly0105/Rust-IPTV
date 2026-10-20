import { EllipsisVertical, History, Lock, Star } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgNowNext, SourceKind } from '@/api/types';
import { listSeparator } from '@/lib/intl';
import { IconButton } from '@/ui/Button';
import { cn } from '@/ui/cn';

import { useLongPress } from '../hooks/useLongPress';
import { displayChannelName } from '../lib/channelName';
import { documentIsRtl } from '../lib/rtl';
import { hasUsableArchive, isValidProgram, minutesLeft, programProgress, shiftNowNext } from '../lib/epgTime';
import { ChannelLogo } from './ChannelLogo';

/**
 * Three lines with room around them (LG-03): the name, the programme on now with its time left,
 * and the progress bar. What comes next is in the stage column's Up next for the channel the
 * stage follows; the old fourth line crammed four lines into 64 px and ran into the dividers.
 */
export const CHANNEL_ROW_HEIGHT = 68;
/**
 * The part of {@link CHANNEL_ROW_HEIGHT} made of Tailwind spacing at 100 %, which compact
 * density tightens: py-3 (22.5 px at the 15 px root) plus the two gaps between name,
 * programme and progress bar (gap-0.5 and mt-1, 3.75 px each).
 */
export const CHANNEL_ROW_SPACING = 30;

export interface ChannelRowProps {
  index: number;
  channel?: Channel;
  nowNext?: EpgNowNext;
  favorite: boolean;
  playing: boolean;
  active: boolean;
  compact?: boolean;
  /**
   * Radio: a station is known by its logo, and a show has no picture to follow, so the logo is
   * larger and the progress bar goes; the current show stays on its one line.
   */
  station?: boolean;
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
  /**
   * The row's menu from its ⋮ button or a long press (touch has no right click): `at` is where it
   * opens, in viewport px.
   */
  onMenuAt?(at: { x: number; y: number }, channel: Channel, index: number): void;
}

/** Same columns and height as a loaded row, so nothing moves when the data lands. */
export function RowSkeleton({ pulse = false }: { pulse?: boolean }) {
  return (
    <div className={`flex h-full items-center gap-3 ps-3 pe-3 ${pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden>
      <span className="h-3 w-7 shrink-0 rounded-xs bg-surface-3" />
      <span className="size-10 shrink-0 rounded-md bg-surface-3" />
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="h-3 w-2/5 rounded-xs bg-surface-3" />
        <span className="h-2.5 w-3/5 rounded-xs bg-surface-2" />
      </span>
    </div>
  );
}

/**
 * The actions that float over a row's end (LG-04): shown on hover, while the row has keyboard
 * focus (a click's focus does not count, or the clicked row would keep them up), and always on
 * touch screens, where nothing hovers. A mouse at rest sees a clean row; the title runs on under
 * where they appear. On touch they sit in the row's flow, so they never cover the time, and only
 * the ⋮ stays: the star is one of its items.
 */
const ROW_ACTIONS =
  'absolute inset-y-0 end-1.5 my-auto flex h-fit items-center gap-0.5 rounded-lg border border-edge bg-surface-2 p-0.5 opacity-0 shadow-2 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 pointer-coarse:static pointer-coarse:me-1 pointer-coarse:border-transparent pointer-coarse:bg-transparent pointer-coarse:opacity-100 pointer-coarse:shadow-none';

export const ChannelRow = memo(function ChannelRow(props: ChannelRowProps) {
  const { t, i18n } = useTranslation('live');
  const { channel, nowNext, favorite, playing, active, index, now, compact } = props;
  const longPress = useLongPress((x, y) => {
    if (channel) props.onMenuAt?.({ x, y }, channel, index);
  });
  if (!channel) return <RowSkeleton />;

  const locked = props.locked ?? false;
  // A locked channel's programme titles wait for the PIN, like its stream.
  const shifted = locked ? undefined : shiftNowNext(nowNext, props.epgOffsetMinutes ?? 0);
  // A programme with unreadable times would read as airing since 1970: show the group instead.
  const cur = shifted?.now && isValidProgram(shifted.now) ? shifted.now : undefined;
  const progress = cur ? programProgress(cur, now) : 0;
  const archive = hasUsableArchive(channel, props.sourceKind);
  const name = displayChannelName(channel.name, props.stripPrefix);
  const left = cur ? minutesLeft(cur, now) : 0;
  const archiveLabel = channel.archive?.durationHours
    ? t('archiveDays', { count: Math.max(1, Math.round(channel.archive.durationHours / 24)) })
    : t('archive');

  return (
    <div
      className={cn(
        // `group/row` for the floating actions; the list is `group/list`, so the keyboard cursor's
        // row is marked only while the list has focus (a phantom "selected" first row otherwise).
        'group/row relative flex h-full touch-manipulation items-stretch border-b border-divider select-none [-webkit-touch-callout:none]',
        playing ? 'tuning-tick bg-selected' : cn('hover:bg-hover', active && 'group-focus-within/list:bg-hover'),
      )}
      onContextMenu={(e) => props.onContextMenu(e, channel, index)}
      {...longPress}
    >
      <button
        type="button"
        data-row-index={index}
        tabIndex={active ? 0 : -1}
        aria-current={playing ? 'true' : undefined}
        aria-label={[
          channel.number !== undefined ? `${channel.number}` : '',
          name,
          favorite ? t('favorite') : '',
          locked ? t('locked') : '',
          cur ? t('nowShowing', { title: cur.title }) : '',
          playing ? t('playingNow') : '',
        ]
          .filter(Boolean)
          .join(listSeparator(i18n.language))}
        onClick={() => props.onActivate(index, 'click')}
        onDoubleClick={() => props.onActivate(index, 'double')}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 ps-2.5 pe-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <span
          className={cn(
            'w-7 shrink-0 text-end font-numeric text-sm tabular-nums',
            playing ? 'text-accent' : 'text-fg-muted',
          )}
        >
          {channel.number ?? ''}
        </span>
        {!compact ? <ChannelLogo src={channel.logoUrl} name={name} size={props.station ? 44 : 40} sourceId={channel.ref.sourceId} /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className={cn('truncate text-body-sm text-match-parent text-fg', playing ? 'font-semibold' : 'font-medium')}>
              {name}
            </span>
            {/* Marks, not slots: an empty row gives their room to the title. */}
            {favorite ? <Star data-testid="row-favorite" aria-hidden size={12} className="shrink-0 fill-current text-warning" /> : null}
            {archive ? (
              <span title={archiveLabel} className="inline-flex shrink-0 text-fg-subtle">
                <History size={12} aria-label={t('archive')} data-testid="row-archive" />
              </span>
            ) : null}
            {locked ? <Lock data-testid="row-locked" aria-hidden size={12} className="shrink-0 text-fg-subtle" /> : null}
          </span>
          {cur ? (
            <>
              {/* Only the title truncates, in its own direction; the remaining time is a sibling in
                  compact "38m" form, so narrow lists keep the title readable (and RTL titles put the
                  ellipsis at their own end, not before the clock). */}
              <span className="flex min-w-0 items-baseline gap-2 text-caption text-fg-muted" data-testid="row-now">
                <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent" data-testid="row-now-title" title={cur.title}>
                  {cur.title}
                </span>
                <span className="shrink-0 tabular-nums text-fg-subtle" title={t('minutesLeft', { count: left })}>
                  {t('minutesLeftShort', { count: left })}
                </span>
              </span>
              {props.station ? null : (
                <span className="relative mt-1 h-[3px] w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  {/* Quiet on every row, the accent on the one playing: a list of bright bars read as
                      stripes, and red ones as "all live, all alerting". */}
                  <span
                    data-testid="channel-progress"
                    className={cn('absolute inset-y-0 start-0 rounded-full', playing ? 'bg-accent' : 'bg-fg-subtle/55')}
                    style={{ width: `${progress * 100}%` }}
                  />
                </span>
              )}
            </>
          ) : props.guideUnavailable ? (
            <span className="truncate text-caption text-fg-subtle" data-testid="row-guide-unavailable">
              {t('guideNotAnswering')}
            </span>
          ) : (
            <span dir="auto" className="truncate text-caption text-match-parent text-fg-subtle">
              {channel.categoryName}
            </span>
          )}
        </span>
      </button>
      <span className={ROW_ACTIONS} data-testid="row-actions">
        <IconButton
          size="sm"
          tabIndex={-1}
          pressed={favorite}
          label={favorite ? t('removeFavorite') : t('addFavorite')}
          shortcut="s"
          icon={<Star size={16} className={favorite ? 'fill-current text-warning' : undefined} />}
          onClick={() => props.onToggleFavorite(channel, favorite)}
          // A pressed toggle draws the selected fill; the filled star says enough here. On touch the
          // actions sit in the row's flow, so a 44 px star beside the ⋮ cut a tablet's narrow list to
          // "M…": the ⋮ menu (and a long press) has Add to favorites, and the row keeps its mark.
          className={cn('aria-pressed:bg-transparent hover:bg-hover', props.onMenuAt ? 'pointer-coarse:hidden' : 'pointer-coarse:max-sm:hidden')}
        />
        {props.onMenuAt ? (
          <IconButton
            size="sm"
            tabIndex={-1}
            label={t('channelMenu')}
            aria-haspopup="menu"
            icon={<EllipsisVertical size={16} />}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              // Opens under the button from its inline start (the menu grows toward the inline end and
              // stays on screen).
              props.onMenuAt?.({ x: documentIsRtl() ? r.right : r.left, y: r.bottom + 2 }, channel, index);
            }}
            className="hover:bg-hover"
          />
        ) : null}
      </span>
    </div>
  );
});
