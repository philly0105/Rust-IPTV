import { CalendarClock, ChartGantt, ChevronDown, CircleAlert, History, LayoutList, Link2, Lock, Radio, RotateCcw, Undo2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, SourceKind } from '@/api/types';

// The gate module itself, not the parental barrel (which pulls in the settings section and dialogs).
import { ensureUnlocked } from '@/features/parental/gate';
import { Button, cn, IconButton, LivePill, SegmentedControl, Skeleton, TEXT_LINK, Tooltip, useImageChain, useListVirtualizer, useToast, errorDescription } from '@/ui';
import { useChannelPrograms } from '../hooks/useChannelPrograms';
import { useParentalLocks } from '../hooks/useParentalLocks';
import { useShortEpgEnabled } from '../hooks/useShortEpg';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useNow } from '../hooks/useNow';
import { displayChannelName } from '../lib/channelName';
import {
  HOUR,
  MINUTE,
  canCatchUp,
  cellTextMaxPx,
  floorTo,
  formatClock,
  formatDay,
  formatRange,
  layoutBlocks,
  localDayKey,
  localHourTicks,
  lookbackMs,
  minutesLeft,
  ms,
  nowRestLeft,
  programProgress,
  programWhen,
  shiftPrograms,
  type Block,
} from '../lib/epgTime';
import { playCatchup } from '../lib/playback';
import { inlineStart, scrollLeftFor, scrollStart, timeStep, useIsRtl } from '../lib/rtl';
// recording:
import { RibbonActions, ScheduleMark } from '@/features/recording';
import { listSeparator } from '@/lib/intl';
import { ChannelLogo } from './ChannelLogo';
import { UpNext } from './UpNext';

export const RIBBON_PX_PER_MIN = 4;
/**
 * An hour label ("10:00 PM" at 11 px) and the now line's dot, in px: the timeline keeps this much
 * before now when it rests, so the dot never sits under the label at the edge.
 */
export const RIBBON_NOW_LEAD_PX = 60;
const AHEAD = 12 * HOUR;
const LIST_ROW = 52;

type Mode = 'timeline' | 'list';
/**
 * The body keeps one height per view whatever it shows (programmes, loading, no guide, locked,
 * an error, no channel yet), so the video above never resizes on a zap or a source switch.
 */
const BODY_HEIGHT: Record<Mode, string> = { timeline: 'h-[104px]', list: 'h-56' };

export interface EpgRibbonProps {
  channel?: Channel;
  sourceKind?: SourceKind;
  /** true when the live stream of `channel` is what is playing (not a catch-up) */
  watchingLive: boolean;
  /** true when a catch-up of `channel` is what is playing: the live button then reads "Back to live" */
  watchingArchive?: boolean;
  onPlayLive(channel: Channel): void;
  /**
   * The idle stage above already offers `channel` (its Resume or Play button): the ribbon leaves
   * its own Watch live out, so the column has one way to start it.
   */
  stageOffersChannel?: boolean;
  onMapEpg(channel: Channel): void;
  guideHref?: string;
  /**
   * The stage column's full ribbon (Live and custom lists, LG-02): from md up the header is a
   * Now card (the channel, programme art, a progress bar, three lines of description) and Up next
   * fills the column under the timeline. Below md the ribbon folds to one line until it is opened
   * (LG-17).
   */
  details?: boolean;
}

/** After the pointer leaves the timeline, the header waits this long before it goes back (LG-06). */
export const RIBBON_PREVIEW_LINGER_MS = 300;

export function EpgRibbon(props: EpgRibbonProps) {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const now = useNow(30_000);
  const settings = useRpcQuery('settings.get', undefined);
  const [localMode, setLocalMode] = useState<Mode | null>(null);
  const mode: Mode = localMode ?? settings.data?.epgViewMode ?? 'timeline';
  const { channel, sourceKind } = props;

  // Stable window: recomputed every 15 minutes so the query key does not churn.
  const anchor = floorTo(now, 15 * MINUTE);
  const from = anchor - lookbackMs(channel);
  const to = anchor + AHEAD;
  const prefs = useDisplayPrefs();
  // `[from, to)` is display time; programmes show `epgOffsetMinutes` later than the guide says,
  // so the guide is asked for the window that lands there once shifted (as the /epg grid does).
  const offsetMs = prefs.epgOffsetMinutes * MINUTE;
  // XMLTV for every kind; a Stalker portal's own guide on top (see useChannelPrograms).
  // guide: Xtream channels without an airing XMLTV programme fall back to the provider's short guide.
  const shortEpgOn = useShortEpgEnabled(sourceKind);
  const programs = useChannelPrograms(channel, sourceKind, from - offsetMs, to - offsetMs, { enabled: shortEpgOn, guideNow: now - offsetMs });
  const list = useMemo(() => shiftPrograms(programs.programs, prefs.epgOffsetMinutes), [programs.programs, prefs.epgOffsetMinutes]);
  const channelName = displayChannelName(channel?.name, prefs.stripCountryPrefix);
  const current = useMemo(() => list.find((p) => programWhen(p, now) === 'now'), [list, now]);
  // LG-06: the pointer previews (the header follows a hovered block and goes back once the pointer
  // leaves the timeline); a click, Enter or keyboard focus picks (the header stays on it, the
  // block is ringed, and "Back to now" returns). A zap clears both.
  const [hovered, setHovered] = useState<EpgProgram | undefined>(undefined);
  const [pinned, setPinned] = useState<EpgProgram | undefined>(undefined);
  const lingerTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(lingerTimer.current);
    setHovered(undefined);
    setPinned(undefined);
  }, [channel?.ref.itemId]);
  useEffect(() => () => window.clearTimeout(lingerTimer.current), []);
  const preview = useCallback((p: EpgProgram | undefined) => {
    window.clearTimeout(lingerTimer.current);
    if (p) setHovered(p);
    else lingerTimer.current = window.setTimeout(() => setHovered(undefined), RIBBON_PREVIEW_LINGER_MS);
  }, []);
  const pick = useCallback((p: EpgProgram | undefined) => {
    window.clearTimeout(lingerTimer.current);
    setHovered(undefined);
    setPinned(p);
  }, []);
  // Ask mode: a locked channel's programmes stay back until the PIN, like its stream.
  const locks = useParentalLocks(channel?.ref.sourceId, channel?.ref.contentType === 'radio' ? 'radio' : 'live');
  const locked = locks.channelLocked(channel);
  const chosen = pinned && !(current && samePrograms(pinned, current)) ? pinned : undefined;
  const shown = locked ? undefined : (hovered ?? chosen ?? current);
  const awayFromNow = !!shown && !!current && !samePrograms(shown, current);
  // LG-17: below md the ribbon is one line until it is opened, so a phone keeps room for the list.
  const [phoneOpen, setPhoneOpen] = useState(false);
  // Where the timeline's view ends while it rests on now: Up next starts after it, so the column
  // never lists a programme twice (the timeline above already shows the next hour or two).
  const [timelineEnd, setTimelineEnd] = useState<number | undefined>(undefined);

  const setMode = async (m: Mode) => {
    setLocalMode(m);
    try {
      await rpc('settings.update', { patch: { epgViewMode: m } });
      await invalidate('settings.');
    } catch {
      // keep the local choice; persistence is best effort
    }
  };

  const activate = useCallback(
    async (p: EpgProgram) => {
      if (!channel) return;
      const when = programWhen(p, now);
      if (when === 'now' && !props.watchingLive) {
        props.onPlayLive(channel);
        return;
      }
      if (when !== 'future' && canCatchUp(p, channel, sourceKind, now) && (when === 'past' || props.watchingLive)) {
        try {
          await playCatchup(channel, sourceKind!, p, undefined, channelName);
        } catch (err) {
          toast({ title: t('catchupFailed'), description: errorDescription(err), variant: 'error' });
        }
        return;
      }
      pick(p);
    },
    [channel, channelName, now, props, sourceKind, t, toast, pick],
  );

  const liveLabel = props.watchingArchive ? t('backToLive') : t('watchLive');
  // With nothing of this channel playing, the button names the channel it starts: something else
  // plays, and the ribbon follows the list's cursor.
  const liveName = props.watchingArchive || !channelName ? liveLabel : [liveLabel, channelName].join(listSeparator(i18n.language));
  const details = !!props.details;
  const shownWhen = shown ? programWhen(shown, now) : undefined;
  const header = (
    // Below 480 px (the Now card: below 26rem of stage column, as on a tablet) the programme
    // lines take the full width and the buttons wrap under them, so the time range and title are
    // not cut to "01:45 AM – 0…" beside five buttons (L2-live-15).
    <div
      className={cn('flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-4 pt-3 pb-2', details && !phoneOpen && 'max-md:hidden')}
      data-testid="ribbon-header"
      // LG-06: a hovered block stays in the header while the pointer is on its way to these buttons
      // (it went back 300 ms after the pointer left the timeline, so Record acted on the airing
      // programme), and a press here picks it, so a menu opened from here keeps it too.
      onPointerEnter={() => window.clearTimeout(lingerTimer.current)}
      onPointerLeave={() => {
        if (hovered) preview(undefined);
      }}
      onPointerDownCapture={() => {
        if (hovered) pick(hovered);
      }}
    >
      {/* Three lines tall with or without a programme (time, title, description), so a zap never
          moves what is under it. The Now card (details, md up) keeps its own fixed height: its four
          lines (channel, time, title, progress), or the channel's name alone without a guide. */}
      <div className={cn('flex min-h-[3.25rem] min-w-0 flex-1 gap-3', details ? '@max-[26rem]/now:basis-full md:min-h-[5.25rem]' : 'max-[480px]:basis-full')}>
        {details && shown?.icon ? <ProgrammeArt src={shown.icon} sourceId={channel?.ref.sourceId} /> : null}
        {/* A container: the meta line drops what does not fit by the pane's own width, not the window's. */}
        <div className="@container/ribbon flex min-w-0 flex-1 flex-col justify-center">
          {shown ? (
            <>
              {details && channel ? (
                // The card names its channel: with nothing playing it describes the channel the
                // idle stage above offers (the last watched, or the list's cursor once used).
                <p className="mb-0.5 flex min-w-0 items-center gap-1.5 text-caption text-fg-muted" data-testid="ribbon-channel">
                  <ChannelLogo src={channel.logoUrl} name={channelName} size={20} sourceId={channel.ref.sourceId} />
                  {channel.number !== undefined ? <span className="shrink-0 font-numeric tabular-nums">{channel.number}</span> : null}
                  <span dir="auto" className="min-w-0 truncate text-match-parent">
                    {channelName}
                  </span>
                </p>
              ) : null}
              {/* Clipped, never overflowing, and numbers are never cut: a narrow pane says "27m" for
                  "27 min left" and leaves the category out (it used to read "2.. N"). The Now card
                  makes room for them first (the art goes, then the buttons wrap). */}
              <p className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-fg-muted">
                {shownWhen === 'now' ? <LivePill size="sm" dot="none" /> : null}
                <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="ribbon-time">
                  {shownWhen !== 'now' && localDayKey(ms(shown.start)) !== localDayKey(now) ? `${formatDay(ms(shown.start), i18n.language)} ` : ''}
                  {formatRange(shown, i18n.language)}
                </span>
                {shownWhen === 'now' ? (
                  <span className="shrink-0 whitespace-nowrap" data-testid="ribbon-remaining" title={t('minutesLeft', { count: minutesLeft(shown, now) })}>
                    <span className="@[22rem]/ribbon:hidden">{t('minutesLeftShort', { count: minutesLeft(shown, now) })}</span>
                    <span className="hidden @[22rem]/ribbon:inline">{t('minutesLeft', { count: minutesLeft(shown, now) })}</span>
                  </span>
                ) : null}
                {/* The category is the first thing to go: in a narrow pane it would be no more than "Ne…". */}
                {shown.category ? (
                  <span className="hidden min-w-0 truncate text-fg-subtle @[30rem]/ribbon:block" data-testid="ribbon-category">
                    {shown.category}
                  </span>
                ) : null}
                {/* guide: the provider's short guide, not XMLTV. */}
                {shown.fromProvider ? (
                  <span className="min-w-0 truncate whitespace-nowrap text-fg-subtle" data-testid="ribbon-from-provider">
                    {t('fromProvider')}
                  </span>
                ) : null}
                {awayFromNow ? (
                  // LG-06: the header is on another programme than the airing one; this brings it back.
                  <button type="button" onClick={() => pick(undefined)} className={cn(TEXT_LINK, 'ms-auto inline-flex shrink-0 items-center gap-1 text-xs')} data-testid="ribbon-back-to-now">
                    <Undo2 className="size-3" aria-hidden />
                    {t('guideBackToNow')}
                  </button>
                ) : null}
              </p>
              <p dir="auto" title={shown.title} className={cn('truncate text-match-parent text-sm font-semibold text-fg', details && 'md:mt-0.5 md:text-title-sm')}>
                {shown.title}
              </p>
              {details ? (
                // The airing programme's progress; the row keeps its height for the others.
                <span aria-hidden className={cn('relative my-1.5 hidden h-[3px] w-full overflow-hidden rounded-full bg-surface-3 md:block', shownWhen !== 'now' && 'md:invisible')}>
                  <span className="absolute inset-y-0 start-0 rounded-full bg-accent-mark" style={{ width: `${shownWhen === 'now' ? programProgress(shown, now) * 100 : 0}%` }} />
                </span>
              ) : null}
              {shown.description && !details ? (
                <p dir="auto" className="line-clamp-1 text-match-parent text-xs text-fg-muted" data-testid="ribbon-description">
                  {shown.description}
                </p>
              ) : null}
            </>
          ) : (
            <p dir="auto" className="truncate text-match-parent text-sm font-semibold text-fg" data-testid="ribbon-channel-name">
              {channelName || t('guide')}
            </p>
          )}
        </div>
      </div>
      <div className={cn('flex shrink-0 items-center gap-1', details ? '@max-[26rem]/now:ms-auto' : 'max-[480px]:ms-auto')}>
        {/* recording: */}
        {channel ? <RibbonActions channel={channel} channelName={channelName} program={shown} now={now} /> : null}
        {channel && !props.watchingLive && !props.stageOffersChannel ? (
          // Icon-only below 1440 px, where the pane is too narrow for the label and the programme line together.
          // "Back to live" only means something while this channel's catch-up plays; otherwise it starts the stream.
          <Tooltip content={liveName} describe={false}>
            <Button
              size="sm"
              variant="secondary"
              icon={<Radio className="size-3.5" />}
              aria-label={liveName}
              data-testid="ribbon-back-to-live"
              onClick={() => props.onPlayLive(channel)}
            >
              <span className="hidden min-[1440px]:inline">{liveLabel}</span>
            </Button>
          </Tooltip>
        ) : null}
        <SegmentedControl<Mode>
          size="sm"
          label={t('guideView')}
          value={mode}
          onChange={(m) => void setMode(m)}
          options={[
            { value: 'timeline', label: t('timelineView'), content: <ChartGantt aria-hidden className="size-4" /> },
            { value: 'list', label: t('listView'), content: <LayoutList aria-hidden className="size-4" /> },
          ]}
        />
        {props.guideHref ? (
          <Tooltip content={t('openGuide')} describe={false}>
            <Link
              to={props.guideHref}
              aria-label={t('openGuide')}
              className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
            >
              <CalendarClock className="size-4" />
            </Link>
          </Tooltip>
        ) : null}
        {details ? (
          <IconButton
            size="sm"
            label={t('hideRibbon')}
            aria-expanded
            icon={<ChevronDown className="size-4 rotate-180" />}
            onClick={() => setPhoneOpen(false)}
            className="md:hidden"
          />
        ) : null}
      </div>
      {/* The Now card's description spans the card under the art, the title and the buttons, so a
          narrow stage column does not wrap it a few words to a line beside them. Three lines are
          kept from md up whether or not there is one, so a zap never moves what is under it. */}
      {details ? (
        <p
          dir="auto"
          className="line-clamp-1 basis-full text-match-parent text-xs text-fg-muted md:line-clamp-3 md:min-h-[3.75rem] md:text-body-sm"
          data-testid={shown?.description ? 'ribbon-description' : undefined}
        >
          {shown?.description}
        </p>
      ) : null}
    </div>
  );
  // LG-17: a phone's folded ribbon, one line: what is on, the time left, and a hairline of progress.
  const phoneLine =
    details && !phoneOpen ? (
      <div className="relative flex min-h-11 items-center gap-2 ps-4 pe-2 md:hidden" data-testid="ribbon-phone-line">
        {shownWhen === 'now' ? <LivePill size="sm" dot="none" /> : null}
        <p dir="auto" className="min-w-0 flex-1 truncate text-match-parent text-body-sm font-medium text-fg">
          {shown?.title ?? (channelName || t('guide'))}
        </p>
        {shown && shownWhen === 'now' ? (
          <span className="shrink-0 text-caption tabular-nums text-fg-muted">{t('minutesLeftShort', { count: minutesLeft(shown, now) })}</span>
        ) : null}
        <IconButton size="sm" label={t('showRibbon')} aria-expanded={false} icon={<ChevronDown className="size-4" />} onClick={() => setPhoneOpen(true)} />
        {shown && shownWhen === 'now' ? (
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-3">
            <span className="block h-full bg-accent-mark" style={{ width: `${programProgress(shown, now) * 100}%` }} />
          </span>
        ) : null}
      </div>
    ) : null;

  let body;
  if (!channel) {
    // Also what shows for a moment after a source switch, before the list reports its first row.
    body = <RibbonNote icon={<CalendarClock className="size-4" />} text={t('ribbonPickChannel')} />;
  } else if (locked) {
    body = (
      <RibbonNote icon={<Lock className="size-4" />} testId="ribbon-locked" text={t('lockedGuide')}>
        <Button
          size="sm"
          variant="secondary"
          icon={<Lock className="size-3.5" />}
          onClick={() => void ensureUnlocked([{ ref: channel.ref, categoryId: channel.categoryId, title: channelName }])}
        >
          {t('unlock')}
        </Button>
      </RibbonNote>
    );
  } else if (programs.error) {
    body = (
      <RibbonNote
        icon={<CircleAlert className="size-4 text-danger" />}
        role="alert"
        text={t('ribbonFailed')}
        detail={programs.error instanceof Error ? programs.error.message : undefined}
      >
        <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => void programs.refetch()}>
          {t('retry')}
        </Button>
      </RibbonNote>
    );
  } else if (programs.isLoading) {
    // Shaped like what lands: programme blocks for the timeline, rows for the list.
    body =
      mode === 'list' ? (
        <div className="flex flex-col" aria-busy="true" aria-label={t('loadingGuide')}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-divider px-4" style={{ height: LIST_ROW }}>
              <Skeleton className="h-3 w-24 shrink-0" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex gap-1 overflow-hidden px-4 pt-5 pb-2" aria-busy="true" aria-label={t('loadingGuide')}>
          {[160, 220, 120, 260, 180, 200].map((w, i) => (
            <div key={i} className="shrink-0" style={{ width: w }}>
              <Skeleton className="h-[77px]" />
            </div>
          ))}
        </div>
      );
  } else if (list.length === 0) {
    // One line: the channel's name is the heading just above, so this says only what is missing and how to fix it.
    body = (
      <RibbonNote icon={<CalendarClock className="size-4" />} testId="ribbon-no-guide" text={t('noGuideShort')} title={t('noGuideHint')}>
        <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />} onClick={() => props.onMapEpg(channel)}>
          {t('mapEpg')}
        </Button>
        <Link
          to="/settings/epg"
          className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-sm whitespace-nowrap text-accent hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {t('epgSettings')}
        </Link>
      </RibbonNote>
    );
  } else if (mode === 'timeline') {
    body = (
      <Timeline
        programs={list}
        from={from}
        to={to}
        now={now}
        channel={channel}
        kind={sourceKind}
        watchingLive={props.watchingLive}
        resetKey={channel.ref.itemId}
        onActivate={activate}
        onFocusProgram={pick}
        onPreview={preview}
        pinned={chosen}
        onRestEnd={details ? setTimelineEnd : undefined}
      />
    );
  } else {
    body = <ProgramList programs={list} now={now} channel={channel} kind={sourceKind} watchingLive={props.watchingLive} onActivate={activate} onFocusProgram={pick} />;
  }

  // The list view already lists every programme, so Up next comes with the timeline only.
  const showUpNext = details && mode === 'timeline' && !!channel && !locked && !programs.error && !programs.isLoading && list.length > 0;
  return (
    <section
      aria-label={t('guide')}
      data-testid="epg-ribbon"
      // The Now card lays itself out by the stage column's width (`now`), not the window's.
      className={cn('flex min-h-0 shrink-0 flex-col border-t border-divider bg-surface', details && '@container/now md:flex-1')}
    >
      {phoneLine}
      {header}
      <div className={cn(BODY_HEIGHT[mode], 'overflow-hidden', details && !phoneOpen && 'max-md:hidden')} data-testid="ribbon-body">
        {body}
      </div>
      {showUpNext ? <UpNext programs={list} now={now} after={timelineEnd} channel={channel} channelName={channelName} shown={shown} onSelect={pick} /> : null}
    </section>
  );
}

/** Same programme: the guide can answer the same airing as two objects. */
function samePrograms(a: EpgProgram, b: EpgProgram): boolean {
  return a.start === b.start && a.title === b.title;
}

/**
 * The programme's own picture in the Now card, when the guide has one (XMLTV `<icon>`): through
 * the image cache, and gone when it fails, never a placeholder.
 */
function ProgrammeArt({ src, sourceId }: { src: string; sourceId?: string }) {
  const image = useImageChain([src], sourceId, 128);
  if (!image.url) return null;
  return (
    <img
      key={image.url}
      src={image.url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={image.onError}
      data-testid="ribbon-art"
      // Only where the card has room for it beside the text and the buttons (36rem of stage column):
      // at 1280 px it left the time and title a few letters, and a tablet's column none.
      className="hidden aspect-video w-32 shrink-0 self-center rounded-md bg-surface-3 object-cover ring-1 ring-edge md:@[36rem]/now:block"
    />
  );
}

/** A one-line ribbon state (no channel, no guide, locked, failed): icon, text, then its actions. */
function RibbonNote({
  icon,
  text,
  detail,
  title,
  testId,
  role,
  children,
}: {
  icon: ReactNode;
  text: string;
  /** What happened, after the text (an error's message). */
  detail?: string;
  /** The longer explanation, on hover. */
  title?: string;
  testId?: string;
  role?: 'alert';
  children?: ReactNode;
}) {
  return (
    <div role={role} data-testid={testId} className="flex h-full min-w-0 items-center gap-3 px-4">
      <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-divider bg-surface-2 text-fg-muted">
        {icon}
      </span>
      <p className="min-w-0 truncate text-sm text-fg-muted" title={title ?? (detail ? `${text}
${detail}` : text)}>
        {text}
        {detail ? <span className="ms-2 text-fg-subtle">{detail}</span> : null}
      </p>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ViewProps {
  programs: EpgProgram[];
  now: number;
  channel: Channel;
  kind?: SourceKind;
  /** The channel's live stream is playing, so activating the airing programme restarts it from its start. */
  watchingLive: boolean;
  onActivate(p: EpgProgram): void;
  onFocusProgram(p: EpgProgram | undefined): void;
}

function Timeline(
  props: ViewProps & {
    from: number;
    to: number;
    resetKey: string;
    /** The pointer is over a block (undefined: it left the timeline): the header previews it. */
    onPreview(p: EpgProgram | undefined): void;
    /** The block the header was set to by a click or a key: it is ringed. */
    pinned?: EpgProgram;
    /** Told the time the view ends at each time it settles on now (Up next starts there). */
    onRestEnd?(time: number): void;
  },
) {
  const { t, i18n } = useTranslation('live');
  const { programs, from, to, now, channel, kind, onRestEnd } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const rtl = useIsRtl();
  // `view.left` is the distance from the track's inline start (time `from`), in both directions.
  const [view, setView] = useState({ left: 0, width: 1200 });
  const blocks = useMemo(() => layoutBlocks(programs, from, to, RIBBON_PX_PER_MIN, now), [programs, from, to, now]);
  const width = ((to - from) / MINUTE) * RIBBON_PX_PER_MIN;
  const nowX = ((now - from) / MINUTE) * RIBBON_PX_PER_MIN;

  const scrollToNow = useCallback(
    (smooth: boolean) => {
      const el = scroller.current;
      if (!el) return;
      const w = el.clientWidth || 1200;
      // From the local half hour now is in, as the guide opens: the airing block and the first
      // hour label start whole at the edge, not as a clipped sliver. Just past the half hour, the
      // half hour before, so the now line's head is not under the first label at the edge.
      const left = nowRestLeft(now, from, RIBBON_PX_PER_MIN, w, RIBBON_NOW_LEAD_PX);
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ left: scrollLeftFor(left, rtl), behavior: smooth && !reduced ? 'smooth' : 'auto' });
      setView({ left, width: w });
      onRestEnd?.(from + ((left + w) / RIBBON_PX_PER_MIN) * MINUTE);
    },
    [now, rtl, from, onRestEnd],
  );

  useLayoutEffect(() => {
    scrollToNow(false);
  }, [props.resetKey, programs.length, rtl]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current;
    if (el) setView({ left: scrollStart(el), width: el.clientWidth || 1200 });
  };

  // Window the blocks: only those near the viewport are in the DOM.
  const pad = 600;
  const visible = blocks.filter((b) => b.left + b.width >= view.left - pad && b.left <= view.left + view.width + pad);
  // Local hours (a +5:30 or +5:45 viewer gets :00 ticks too); the day shows where the local date changes.
  const ticks = useMemo(() => localHourTicks(from, to), [from, to]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = [...(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-start]') ?? [])];
    // No programme blocks in the window: leave the keys to the browser so the focused scroller scrolls natively.
    if (btns.length === 0) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    let target: HTMLButtonElement | undefined;
    // Arrow keys follow the screen, so in RTL ArrowLeft moves later in time.
    const step = timeStep(e.key, rtl);
    if (step > 0) target = btns[Math.min(btns.length - 1, i + 1)];
    else if (step < 0) target = btns[Math.max(0, i - 1)];
    else if (e.key === 'Home') {
      scrollToNow(true);
      target = btns.find((b) => b.dataset.when === 'now');
    } else return;
    e.preventDefault();
    target?.focus();
    target?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };

  const nowIndex = blocks.findIndex((b) => b.when === 'now');
  const tabStop = blocks[nowIndex >= 0 ? nowIndex : 0];
  // The tab-stop block can be windowed out (or there are no blocks at all); the
  // scroller then takes the tab stop itself so keyboard users can still reach and
  // scroll it (axe scrollable-region-focusable).
  const scrollerTabbable = !tabStop || !visible.includes(tabStop);

  return (
    <div className="relative h-full">
      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerLeave={() => props.onPreview(undefined)}
        tabIndex={scrollerTabbable ? 0 : undefined}
        data-testid="ribbon-timeline"
        className="relative h-full overflow-x-auto overflow-y-hidden pb-2 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        role="group"
        aria-label={t('timelineView')}
      >
        <div style={{ width, height: '100%', position: 'relative', minHeight: 92 }}>
          {/* First: the hour labels and the opaque airing block paint over it, so it never strikes
              through a title, a time or a tick label (L3-visual-3). It shows above and below the
              block, and the block carries its stub at the foot. */}
          <div aria-hidden data-testid="ribbon-now-line" className="pointer-events-none absolute top-3 bottom-1 w-0.5 bg-live" style={inlineStart(nowX - 1, rtl)}>
            <span className="absolute -top-1 -start-[3px] size-2 rounded-full bg-live" />
          </div>
          {ticks.map((tt, i) => {
            const x = ((tt - from) / MINUTE) * RIBBON_PX_PER_MIN;
            const midnight = localDayKey(tt) !== localDayKey(i > 0 ? ticks[i - 1]! : from);
            return (
              <div key={tt} className="absolute top-0 bottom-0" style={inlineStart(x, rtl)}>
                {/* On the ribbon's own surface, so the now line passes behind the label, not through it.
                    One the scroll has cut at the edge ("M" of "5:00 PM") steps aside. */}
                <span
                  className={cn(
                    'absolute top-0 start-0.5 rounded-xs bg-surface px-0.5 text-[calc(11rem/15)] whitespace-nowrap text-fg-subtle tabular-nums',
                    x < view.left && 'invisible',
                  )}
                  data-testid="ribbon-hour-label"
                >
                  {midnight ? formatDay(tt, i18n.language) : formatClock(tt, i18n.language)}
                </span>
                <span className={`absolute top-4 bottom-0 w-px ${midnight ? 'bg-border' : 'bg-divider'}`} />
              </div>
            );
          })}
          {visible.map((b) => (
            <TimelineBlock
              key={`${b.program.start}|${b.program.title}`}
              block={b}
              textMax={cellTextMaxPx(view.left, b.left, b.width)}
              now={now}
              channel={channel}
              kind={kind}
              watchingLive={props.watchingLive}
              rtl={rtl}
              tabbable={b === tabStop}
              pinned={!!props.pinned && props.pinned.start === b.program.start && props.pinned.title === b.program.title}
              onActivate={props.onActivate}
              onFocusProgram={props.onFocusProgram}
              onPreview={props.onPreview}
            />
          ))}
        </div>
      </div>
      {Math.abs(view.left + view.width * 0.25 - nowX) > view.width * 0.6 ? (
        <button
          type="button"
          onClick={() => scrollToNow(true)}
          // A way back, not a live mark (LG-15): the accent's filled control, not the LIVE red.
          className="absolute end-3 bottom-3 z-20 inline-flex items-center gap-1 rounded-full bg-accent-solid px-3 py-1 text-xs font-semibold text-accent-solid-fg shadow-2 outline-none hover:bg-accent-solid-hover focus-visible:ring-2 focus-visible:ring-focus active:bg-accent-solid-pressed"
        >
          <RotateCcw className="size-3" aria-hidden />
          {t('jumpToNow')}
        </button>
      ) : null}
    </div>
  );
}

/** Memoized: a scroll re-renders only the blocks whose text cap moves (the clipped ones), LV-8. */
const TimelineBlock = memo(function TimelineBlock({
  block,
  textMax,
  now,
  channel,
  kind,
  watchingLive,
  rtl,
  tabbable,
  pinned,
  onActivate,
  onFocusProgram,
  onPreview,
}: {
  block: Block;
  /** The text's width cap while the block began before the visible edge (cellTextMaxPx). */
  textMax: number | undefined;
  now: number;
  channel: Channel;
  kind?: SourceKind;
  watchingLive: boolean;
  rtl: boolean;
  tabbable: boolean;
  pinned: boolean;
  onActivate(p: EpgProgram): void;
  onFocusProgram(p: EpgProgram | undefined): void;
  onPreview(p: EpgProgram | undefined): void;
}) {
  const { t, i18n } = useTranslation('live');
  const p = block.program;
  const catchup = canCatchUp(p, channel, kind, now);
  const progress = block.when === 'now' ? programProgress(p, now) : 0;
  const tone =
    block.when === 'now'
      ? // On now: the raised block (white with a shadow in light, the next surface step in dark).
        // Opaque, so the now line (painted first) and the hour lines stay off its title; the line
        // shows above and below it and as a stub at its foot. Amber only in the elapsed share below.
        'border-edge bg-surface text-fg shadow-1 dark:bg-surface-3'
      : block.when === 'past'
        ? catchup
          ? 'border-edge bg-surface-2 text-fg-muted hover:border-border hover:text-fg'
          : 'border-edge/60 bg-surface-2/50 text-fg-subtle'
        : 'border-edge bg-surface-2 text-fg hover:bg-surface-3';
  const label = [
    p.title,
    formatRange(p, i18n.language),
    block.when === 'now' ? t('onNow') : '',
    block.when === 'past' && catchup ? t('catchupAvailable') : '',
    block.when === 'now' && catchup && watchingLive ? t('startOverAvailable') : '',
  ]
    .filter(Boolean)
    .join(listSeparator(i18n.language));
  return (
    <button
      type="button"
      data-start={p.start}
      data-when={block.when}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      title={p.description ? `${p.title}\n${p.description}` : p.title}
      aria-current={pinned ? 'true' : undefined}
      onClick={() => onActivate(p)}
      onMouseEnter={() => onPreview(p)}
      onFocus={() => onFocusProgram(p)}
      // overflow-clip, not hidden: the block is then no scroll container, so its text can stick.
      // A picked block (the header describes it, LG-06) carries a ring in the text colour.
      className={`absolute top-5 bottom-2 overflow-clip rounded-md border px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus ${tone} ${
        pinned ? 'ring-2 ring-fg-muted ring-inset' : ''
      }`}
      style={{ ...inlineStart(block.left + 1, rtl), width: Math.max(2, block.width - 2) }}
    >
      {block.when === 'now' ? (
        <>
          <span aria-hidden className="absolute start-0 end-0 bottom-0 h-0.5 bg-surface-3 dark:bg-pressed">
            <span className="block h-full bg-accent-mark" style={{ width: `${progress * 100}%` }} />
          </span>
          {/* The now line's stub at the foot, where the progress ends. */}
          <span aria-hidden data-testid="ribbon-now-tick" className="absolute bottom-0 h-1.5 w-0.5 bg-live" style={{ insetInlineStart: `calc(${progress * 100}% - 1px)` }} />
        </>
      ) : null}
      {/* A show that began before the visible edge keeps its title in view: the text sticks 8 px
          past the edge until the block's end pushes it out, and ends in an ellipsis inside the
          block (L3-live-5). */}
      <span data-testid="ribbon-block-text" className="sticky block w-max max-w-full" style={{ insetInlineStart: 8, maxWidth: textMax }}>
        <span className="relative flex items-center gap-1 truncate text-xs font-medium">
          {catchup && (block.when === 'past' || watchingLive) ? <History className="size-3 shrink-0" aria-hidden /> : null}
          <span dir="auto" className="truncate text-match-parent">
            {p.title}
          </span>
          {/* recording: */}
          <ScheduleMark channelRef={channel.ref} program={p} />
        </span>
        {/* Muted by token, not opacity: opacity over the tinted block drops below 4.5:1 in the light theme. */}
        <span className={`relative block truncate text-[calc(11rem/15)] tabular-nums ${block.when === 'future' ? 'text-fg-muted' : ''}`}>
          {formatClock(ms(p.start), i18n.language)}
        </span>
      </span>
    </button>
  );
});

function ProgramList(props: ViewProps) {
  const { t, i18n } = useTranslation('live');
  const { programs, now, channel, kind } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useListVirtualizer({
    count: programs.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => LIST_ROW,
    overscan: 6,
    initialRect: { width: 600, height: 224 },
  });
  const nowIndex = programs.findIndex((p) => programWhen(p, now) === 'now');

  useLayoutEffect(() => {
    if (nowIndex >= 0) virtualizer.scrollToIndex(nowIndex, { align: 'start' });
  }, [channel.ref.itemId, programs.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const cur = Number((document.activeElement as HTMLElement | null)?.dataset.index ?? nowIndex);
    const next = Math.max(0, Math.min(programs.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    virtualizer.scrollToIndex(next, { align: 'auto' });
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus());
  };

  return (
    <div ref={scroller} onKeyDown={onKeyDown} className="h-full overflow-y-auto" role="list" aria-label={t('listView')}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const p = programs[v.index]!;
          const when = programWhen(p, now);
          const catchup = canCatchUp(p, channel, kind, now);
          // A list can span a week of archive: the first programme of each local day carries the date.
          const prevDay = localDayKey(v.index > 0 ? ms(programs[v.index - 1]!.start) : now);
          const day = localDayKey(ms(p.start)) !== prevDay ? formatDay(ms(p.start), i18n.language) : null;
          return (
            <div key={v.key} role="listitem" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: LIST_ROW, transform: `translateY(${v.start}px)` }}>
              <button
                type="button"
                data-index={v.index}
                tabIndex={v.index === (nowIndex >= 0 ? nowIndex : 0) ? 0 : -1}
                onClick={() => props.onActivate(p)}
                onFocus={() => props.onFocusProgram(p)}
                className={`flex h-full w-full items-center gap-3 border-b border-divider px-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
                  when === 'now' ? 'tuning-tick bg-selected' : 'hover:bg-hover'
                } ${when === 'past' && !catchup ? 'text-fg-subtle' : 'text-fg'}`}
              >
                <span className="flex w-24 shrink-0 flex-col text-xs tabular-nums text-fg-muted">
                  {day ? (
                    <span className="truncate text-[calc(11rem/15)] font-medium text-fg" data-testid="ribbon-list-day">
                      {day}
                    </span>
                  ) : null}
                  <span>{formatRange(p, i18n.language)}</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span dir="auto" className="truncate text-match-parent text-sm font-medium">
                      {p.title}
                    </span>
                    {/* recording: */}
                    <ScheduleMark channelRef={channel.ref} program={p} />
                  </span>
                  {when === 'now' ? (
                    <span className="mt-1 h-[3px] w-full max-w-48 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                      <span className="block h-full bg-accent-mark" style={{ width: `${programProgress(p, now) * 100}%` }} />
                    </span>
                  ) : p.description ? (
                    <span dir="auto" className="truncate text-match-parent text-xs text-fg-muted">
                      {p.description}
                    </span>
                  ) : null}
                </span>
                {when === 'now' && catchup && props.watchingLive ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
                    <History className="size-3.5" aria-hidden />
                    {t('startOver')}
                  </span>
                ) : null}
                {when === 'now' ? (
                  <LivePill size="sm" dot="none" />
                ) : when === 'past' && catchup ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
                    <History className="size-3.5" aria-hidden />
                    {t('watch')}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
