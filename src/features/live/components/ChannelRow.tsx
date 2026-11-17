import type { TFunction } from 'i18next';
import { EllipsisVertical, Heart, History, Lock } from 'lucide-react';
import { memo, type MouseEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgNowNext, SourceKind } from '@/api/types';
import { listSeparator } from '@/lib/intl';
import { IconButton } from '@/ui/Button';
import { cn } from '@/ui/cn';

import { useLongPress } from '../hooks/useLongPress';
import { displayChannelName, isSeparatorName, separatorLabel } from '../lib/channelName';
import { documentIsRtl } from '../lib/rtl';
import { hasUsableArchive, isValidProgram, minutesLeft, programProgress, shiftNowNext } from '../lib/epgTime';
import { ChannelLogo, ChannelName } from './ChannelLogo';

/**
 * Three lines (LG-03): the name, the programme on now with its time left, and the progress bar.
 * What comes next is in the stage column's Up next for the channel the stage follows; the old
 * fourth line crammed four lines into 64 px and ran into the dividers. The three lines take about
 * 45 px, so 60 px leaves them 7 px above and below: at 68 px a 900 px window listed under twelve
 * channels, at 60 px over thirteen, and a 57k-channel list is mostly scrolling.
 */
export const CHANNEL_ROW_HEIGHT = 60;
/**
 * The part of {@link CHANNEL_ROW_HEIGHT} made of Tailwind spacing at 100 %, which compact
 * density tightens: py-2 (15 px at the 15 px root) plus the gaps between name, programme and
 * progress bar (gap-0.5 and mt-1).
 */
export const CHANNEL_ROW_SPACING = 22;

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
  /**
   * The list mixes groups (a search across All channels): the programme line leads with the
   * channel's group, which is what tells a dozen "ESPN HD" feeds apart.
   */
  showGroup?: boolean;
  /**
   * The group the list is open on. Its rows without a programme say there is no guide instead of
   * repeating the group's name, which the header and the group column already show.
   */
  groupId?: string;
  /** The list is the Favorites view: every row is one, so the heart mark says nothing. */
  hideFavoriteMark?: boolean;
  onActivate(index: number, how: 'click' | 'double' | 'key'): void;
  onToggleFavorite(channel: Channel, favorite: boolean): void;
  onContextMenu(e: MouseEvent, channel: Channel, index: number): void;
  /**
   * The row's menu from its ⋮ button or a long press (touch has no right click): `at` is where it
   * opens, in viewport px.
   */
  onMenuAt?(at: { x: number; y: number }, channel: Channel, index: number): void;
}

/**
 * The number column: 26 px, or as many digits as the list's highest number has when ChannelList
 * sets `--num-w` (a source numbered to 57,000 spilled "57012" past the row's padding). In `ch` of
 * the number's own tabular figures, so every row's logo stays on one line.
 */
const NUMBER_WIDTH = 'w-[var(--num-w,1.75rem)] min-w-7';

/** Same columns and height as a loaded row, so nothing moves when the data lands. */
export function RowSkeleton({ pulse = false }: { pulse?: boolean }) {
  return (
    <div className={`flex h-full items-center gap-3 ps-3 pe-3 ${pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden>
      <span className={`h-3 shrink-0 rounded-xs bg-surface-3 ${NUMBER_WIDTH}`} />
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
 * the ⋮ stays: the heart is one of its items.
 */
const ROW_ACTIONS =
  'absolute inset-y-0 end-1.5 my-auto flex h-fit items-center gap-0.5 rounded-lg border border-edge bg-surface-2 p-0.5 opacity-0 shadow-2 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 pointer-coarse:static pointer-coarse:me-1 pointer-coarse:border-transparent pointer-coarse:bg-transparent pointer-coarse:opacity-100 pointer-coarse:shadow-none';

/** The UI language as ChannelList hands it to its rows (P2-LIVE-3). */
interface RowLanguage {
  t: TFunction<'live'>;
  /** `listSeparator` of the UI language: between the parts of the row button's name. */
  separator: string;
}

/**
 * What every row says alike, read once per `t` (P2-LIVE-3): each row of a screen made six to nine
 * i18next calls, and again on every re-render (the guide's now/next landing, the favourite flags).
 * react-i18next makes a new `t` when the language changes, so these never outlive their language.
 */
interface RowText {
  favorite: string;
  locked: string;
  playingNow: string;
  addFavorite: string;
  removeFavorite: string;
  channelMenu: string;
  guideNotAnswering: string;
  noGuide: string;
  archive: string;
  archiveIcon: ReactElement;
  /** Plural texts by key and count, filled as rows ask for them. */
  counted: Map<string, string>;
}
const rowTexts = new WeakMap<TFunction<'live'>, RowText>();

function rowText(t: TFunction<'live'>): RowText {
  let text = rowTexts.get(t);
  if (!text) {
    text = {
      favorite: t('favorite'),
      locked: t('locked'),
      playingNow: t('playingNow'),
      addFavorite: t('addFavorite'),
      removeFavorite: t('removeFavorite'),
      channelMenu: t('channelMenu'),
      guideNotAnswering: t('guideNotAnswering'),
      noGuide: t('noGuideShort'),
      archive: t('archive'),
      archiveIcon: <History size={12} aria-label={t('archive')} data-testid="row-archive" />,
      counted: new Map(),
    };
    rowTexts.set(t, text);
  }
  return text;
}

function countedText(t: TFunction<'live'>, key: 'archiveDays' | 'minutesLeft' | 'minutesLeftShort', count: number): string {
  const { counted } = rowText(t);
  const k = `${key}|${count}`;
  let s = counted.get(k);
  if (s === undefined) {
    s = t(key, { count });
    counted.set(k, s);
  }
  return s;
}

/**
 * The icons that look the same on every row, made once (P2-LIVE-3): an element that is the same
 * object as last render is not rendered again, so a row's re-render skips its lucide icons.
 */
const FAVORITE_MARK = (
  <Heart
    data-testid="row-favorite"
    aria-hidden
    size={12}
    className="shrink-0 fill-current text-fg-subtle not-pointer-coarse:group-hover/row:invisible not-pointer-coarse:group-has-[:focus-visible]/row:invisible"
  />
);
const LOCKED_MARK = <Lock data-testid="row-locked" aria-hidden size={12} className="shrink-0 text-fg-subtle" />;
const HEART_ON = <Heart size={16} className="fill-current text-fg" />;
const HEART_OFF = <Heart size={16} />;
const MENU_ICON = <EllipsisVertical size={16} />;

/** A channel row that reads the UI language itself; ChannelList's rows take the list's (ListChannelRow). */
export const ChannelRow = memo(function ChannelRow(props: ChannelRowProps) {
  const { t, i18n } = useTranslation('live');
  return <ListChannelRow {...props} t={t} separator={listSeparator(i18n.language)} />;
});

/**
 * A row of ChannelList. The list hands it `t` and the separator (P2-LIVE-3): `useTranslation` per
 * row subscribed each of a screen of rows to i18next and copied the i18next instance for each.
 */
export const ListChannelRow = memo(function ListChannelRow(props: ChannelRowProps & RowLanguage) {
  const { t } = props;
  const { channel, nowNext, favorite, playing, active, index, now, compact } = props;
  const longPress = useLongPress((x, y) => {
    if (channel) props.onMenuAt?.({ x, y }, channel, index);
  });
  if (!channel) return <RowSkeleton />;
  if (isSeparatorName(channel.name)) {
    // A provider's heading ("#### PRIME ᴿᴬᵂ ####") is no channel: a quiet label over the names it
    // heads, in the row's slot so the list keeps one height. Not playable and passed by the arrows;
    // a right click or a long press still reaches its menu (Hide).
    return (
      <div
        className="flex h-full touch-manipulation items-end gap-3 ps-2.5 pe-3 pb-2 select-none [-webkit-touch-callout:none]"
        onContextMenu={(e) => props.onContextMenu(e, channel, index)}
        data-testid="row-separator"
        {...longPress}
      >
        {/* On the names' line: the number and logo columns stay, empty. */}
        {/* In the number's font: its width is in ch, so another font set the caption off the names (v-live-08). */}
        <span aria-hidden className={cn('shrink-0 font-numeric text-sm', NUMBER_WIDTH)} />
        {compact ? null : <span aria-hidden className="shrink-0" style={{ width: props.station ? 44 : 40 }} />}
        <span dir="auto" className="min-w-0 truncate text-caption font-semibold tracking-wide text-fg-subtle uppercase">
          {separatorLabel(channel.name)}
        </span>
      </div>
    );
  }

  const locked = props.locked ?? false;
  // A locked channel's programme titles wait for the PIN, like its stream.
  const shifted = locked ? undefined : shiftNowNext(nowNext, props.epgOffsetMinutes ?? 0);
  // A programme with unreadable times would read as airing since 1970: show the group instead.
  const cur = shifted?.now && isValidProgram(shifted.now) ? shifted.now : undefined;
  const progress = cur ? programProgress(cur, now) : 0;
  const archive = hasUsableArchive(channel, props.sourceKind);
  const name = displayChannelName(channel.name, props.stripPrefix);
  const left = cur ? minutesLeft(cur, now) : 0;
  const text = rowText(t);
  const group = props.showGroup ? channel.categoryName : '';
  // In its own group a row without a programme says so; elsewhere its group tells it apart.
  const inOpenGroup = !!props.groupId && channel.categoryId === props.groupId;

  return (
    <div
      className={cn(
        // `group/row` for the floating actions; the list is `group/list`, so the keyboard cursor's
        // row is marked only while the list has focus (a phantom "selected" first row otherwise).
        // No rule between rows: the 60 px rhythm, the logo column and the hover and selected fills
        // keep them apart. A divider under each row on top of its progress track drew two lines
        // per channel, and a screen of channels read as ruled paper, more so in light.
        'group/row relative flex h-full touch-manipulation items-stretch select-none [-webkit-touch-callout:none]',
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
          group,
          favorite ? text.favorite : '',
          locked ? text.locked : '',
          cur ? t('nowShowing', { title: cur.title }) : '',
          playing ? text.playingNow : '',
        ]
          .filter(Boolean)
          .join(props.separator)}
        onClick={() => props.onActivate(index, 'click')}
        onDoubleClick={() => props.onActivate(index, 'double')}
        className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-2.5 pe-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        {/* The playing row's number steps up to the text colour: the tick and the progress are
            its amber marks, a third amber mark in the number read as noise. The others are quiet,
            so the logo and the name lead the row. */}
        <span
          className={cn(
            'shrink-0 text-end font-numeric text-sm tabular-nums',
            NUMBER_WIDTH,
            playing ? 'text-fg' : 'text-fg-subtle',
          )}
        >
          {channel.number ?? ''}
        </span>
        {!compact ? <ChannelLogo src={channel.logoUrl} name={name} size={props.station ? 44 : 40} sourceId={channel.ref.sourceId} /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChannelName
              name={channel.name}
              strip={props.stripPrefix}
              // In its own group, a "PRIME: " the header already names is left out.
              group={inOpenGroup ? channel.categoryName : undefined}
              // The provider's whole name when the column cuts it (event channels differ at the end).
              title={channel.name}
              // A step up on touch, held at arm's length: the desktop's dense 13.5 px name and 12 px
              // programme fit the same 60 px row at 15 and 13.5.
              className={cn('truncate text-body-sm text-match-parent text-fg pointer-coarse:text-body', playing ? 'font-semibold' : 'font-medium')}
            />
            {/* Marks, not slots: an empty row gives their room to the title. */}
            {/* A favourite is a state, so its mark is neutral (never amber or the warning tone).
                It steps aside while the floating actions show their own heart. */}
            {favorite && !props.hideFavoriteMark ? FAVORITE_MARK : null}
            {archive ? (
              <span
                title={
                  channel.archive?.durationHours
                    ? countedText(t, 'archiveDays', Math.max(1, Math.round(channel.archive.durationHours / 24)))
                    : text.archive
                }
                className="inline-flex shrink-0 text-fg-subtle"
              >
                {text.archiveIcon}
              </span>
            ) : null}
            {locked ? LOCKED_MARK : null}
          </span>
          {cur ? (
            <>
              {/* Only the title truncates, in its own direction; the remaining time is a sibling in
                  compact "38m" form, so narrow lists keep the title readable (and RTL titles put the
                  ellipsis at their own end, not before the clock). */}
              <span className="flex min-w-0 items-baseline gap-2 text-caption text-fg-muted pointer-coarse:text-body-sm" data-testid="row-now">
                {group ? (
                  // Quiet, and it gives way before the title does.
                  <>
                    <span dir="auto" className="max-w-[45%] min-w-0 shrink-0 truncate text-fg-subtle" title={group} data-testid="row-group">
                      {group}
                    </span>
                    <span aria-hidden className="shrink-0 text-fg-subtle">
                      ·
                    </span>
                  </>
                ) : null}
                <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent" data-testid="row-now-title" title={cur.title}>
                  {cur.title}
                </span>
                {/* A phone's playing TV row leaves the time left and the progress to the guide
                    ribbon's bar right above the list, which shows both for the same programme. */}
                <span className={cn('shrink-0 tabular-nums text-fg-subtle', playing && !props.station && 'max-md:hidden')} title={countedText(t, 'minutesLeft', left)}>
                  {countedText(t, 'minutesLeftShort', left)}
                </span>
              </span>
              {props.station ? null : (
                <span
                  className={cn(
                    'relative mt-1 w-full overflow-hidden rounded-full',
                    // A hairline on every row and a firmer bar on the one playing: a 3 px grey bar
                    // under each name was the darkest mark in the list after the text.
                    playing ? 'h-[3px] bg-surface-3 max-md:hidden' : 'h-0.5 bg-fg/7',
                  )}
                  aria-hidden
                  data-testid="channel-progress-track"
                >
                  {/* Quiet on every row, the accent on the one playing: a list of bright bars read as
                      stripes, and red ones as "all live, all alerting". */}
                  <span
                    data-testid="channel-progress"
                    className={cn('absolute inset-y-0 start-0 rounded-full', playing ? 'bg-accent-mark' : 'bg-fg-subtle/50')}
                    style={{ width: `${progress * 100}%` }}
                  />
                </span>
              )}
            </>
          ) : props.guideUnavailable ? (
            <span className="truncate text-caption text-fg-subtle" data-testid="row-guide-unavailable">
              {text.guideNotAnswering}
            </span>
          ) : inOpenGroup ? (
            <span className="truncate text-caption text-fg-subtle" data-testid="row-no-guide">
              {locked ? text.locked : text.noGuide}
            </span>
          ) : (
            <span dir="auto" className="truncate text-caption text-match-parent text-fg-subtle">
              {channel.categoryName}
            </span>
          )}
        </span>
      </button>
      <RowActions channel={channel} index={index} favorite={favorite} text={text} onToggleFavorite={props.onToggleFavorite} onMenuAt={props.onMenuAt} />
    </div>
  );
});

/**
 * The row's floating actions (LG-04), memoized (P2-LIVE-3): the guide's now/next landing
 * re-renders every row on screen, and each row's two IconButtons, with a tooltip's hooks each,
 * rendered again with it.
 */
const RowActions = memo(function RowActions({
  channel,
  index,
  favorite,
  text,
  onToggleFavorite,
  onMenuAt,
}: {
  channel: Channel;
  index: number;
  favorite: boolean;
  text: RowText;
  onToggleFavorite: ChannelRowProps['onToggleFavorite'];
  onMenuAt: ChannelRowProps['onMenuAt'];
}) {
  return (
    <span className={ROW_ACTIONS} data-testid="row-actions">
      <IconButton
        size="sm"
        tabIndex={-1}
        // One name with the pressed state; the tooltip says what a press does.
        pressed={favorite}
        label={text.favorite}
        tooltip={favorite ? text.removeFavorite : text.addFavorite}
        shortcut="s"
        icon={favorite ? HEART_ON : HEART_OFF}
        onClick={() => onToggleFavorite(channel, favorite)}
        // A pressed toggle draws the selected fill; the filled heart says enough here. On touch the
        // actions sit in the row's flow, so a 44 px heart beside the ⋮ cut a tablet's narrow list to
        // "M…": the ⋮ menu (and a long press) has Add to favorites, and the row keeps its mark.
        className={cn('aria-pressed:bg-transparent hover:bg-hover', onMenuAt ? 'pointer-coarse:hidden' : 'pointer-coarse:max-sm:hidden')}
      />
      {onMenuAt ? (
        <IconButton
          size="sm"
          tabIndex={-1}
          label={text.channelMenu}
          aria-haspopup="menu"
          icon={MENU_ICON}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // Opens under the button from its inline start (the menu grows toward the inline end and
            // stays on screen).
            onMenuAt?.({ x: documentIsRtl() ? r.right : r.left, y: r.bottom + 2 }, channel, index);
          }}
          className="hover:bg-hover"
        />
      ) : null}
    </span>
  );
});
