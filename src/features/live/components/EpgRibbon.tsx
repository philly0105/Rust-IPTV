import { CalendarClock, ChartGantt, CircleAlert, History, LayoutList, Link2, Lock, Radio, RotateCcw } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, SourceKind } from '@/api/types';

// The gate module itself, not the parental barrel (which pulls in the settings section and dialogs).
import { ensureUnlocked } from '@/features/parental/gate';
import { Button, IconButton, Skeleton, useListVirtualizer, useToast } from '@/ui';
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
  programProgress,
  programWhen,
  shiftPrograms,
  type Block,
} from '../lib/epgTime';
import { playCatchup } from '../lib/playback';
import { inlineStart, scrollLeftFor, scrollStart, timeStep, useIsRtl } from '../lib/rtl';
// recording:
import { RibbonActions, ScheduleMark } from '@/features/recording';

export const RIBBON_PX_PER_MIN = 4;
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
  onMapEpg(channel: Channel): void;
  guideHref?: string;
}

export function EpgRibbon(props: EpgRibbonProps) {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const now = useNow(30_000);
  const settings = useRpcQuery('settings.get', undefined, { staleTime: 60_000 });
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
  const [focused, setFocused] = useState<EpgProgram | undefined>(undefined);
  useEffect(() => setFocused(undefined), [channel?.ref.itemId]);
  // Ask mode: a locked channel's programmes stay back until the PIN, like its stream.
  const locks = useParentalLocks(channel?.ref.sourceId, channel?.ref.contentType === 'radio' ? 'radio' : 'live');
  const locked = locks.channelLocked(channel);
  const shown = locked ? undefined : (focused ?? current);

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
          toast({ title: t('catchupFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
        }
        return;
      }
      setFocused(p);
    },
    [channel, channelName, now, props, sourceKind, t, toast],
  );

  const liveLabel = props.watchingArchive ? t('backToLive') : t('watchLive');
  const header = (
    // Below 480 px the programme lines take the full width and the buttons wrap under them, so the
    // time range and title are not cut to "01:45 AM – 0…" beside five buttons (L2-live-15).
    <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-4 pt-3 pb-2" data-testid="ribbon-header">
      {/* Three lines tall with or without a programme (time, title, description), so a zap never moves the video. */}
      <div className="flex min-h-[3.25rem] min-w-0 flex-1 flex-col justify-center max-[480px]:basis-full">
        {shown ? (
          <>
            {/* Clipped, never overflowing: in long locales (ar, ru) the remaining time truncates rather than running under the buttons. */}
            <p className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-fg-muted">
              {programWhen(shown, now) === 'now' ? (
                <span className="inline-flex items-center gap-1 rounded-sm bg-live px-1.5 py-px text-2xs font-semibold text-white dark:text-bg">{t('liveBadge')}</span>
              ) : null}
              <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="ribbon-time">
                {programWhen(shown, now) !== 'now' && localDayKey(ms(shown.start)) !== localDayKey(now) ?`${formatDay(ms(shown.start), i18n.language)} ` : ''}
                {formatRange(shown, i18n.language)}
              </span>
              {programWhen(shown, now) === 'now' ? (
                <span className="min-w-0 truncate whitespace-nowrap" data-testid="ribbon-remaining" title={t('minutesLeft', { count: minutesLeft(shown, now) })}>
                  {t('minutesLeft', { count: minutesLeft(shown, now) })}
                </span>
              ) : null}
              {/* The category is the first thing to go: below 1440 px the pane is too narrow for it to be more than "Ne…". */}
              {shown.category ? (
                <span className="hidden min-w-0 truncate text-fg-subtle min-[1440px]:block" data-testid="ribbon-category">
                  {shown.category}
                </span>
              ) : null}
              {/* guide: the provider's short guide, not XMLTV. */}
              {shown.fromProvider ? (
                <span className="min-w-0 truncate whitespace-nowrap text-fg-subtle" data-testid="ribbon-from-provider">
                  {t('fromProvider')}
                </span>
              ) : null}
            </p>
            <p dir="auto" className="truncate text-match-parent text-sm font-semibold text-fg">
              {shown.title}
            </p>
            {shown.description ? (
              <p dir="auto" className="line-clamp-1 text-match-parent text-xs text-fg-muted">
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
      <div className="flex shrink-0 items-center gap-1 max-[480px]:ms-auto">
        {/* recording: */}
        {channel ? <RibbonActions channel={channel} channelName={channelName} program={shown} now={now} /> : null}
        {channel && !props.watchingLive ? (
          // Icon-only below 1440 px, where the pane is too narrow for the label and the programme line together.
          // "Back to live" only means something while this channel's catch-up plays; otherwise it starts the stream.
          <Button
            size="sm"
            variant="secondary"
            icon={<Radio className="size-3.5" />}
            aria-label={liveLabel}
            title={liveLabel}
            data-testid="ribbon-back-to-live"
            onClick={() => props.onPlayLive(channel)}
          >
            <span className="hidden min-[1440px]:inline">{liveLabel}</span>
          </Button>
        ) : null}
        <div role="group" aria-label={t('guideView')} className="flex rounded-md border border-border p-0.5">
          <IconButton
            size="sm"
            label={t('timelineView')}
            pressed={mode === 'timeline'}
            className={mode === 'timeline' ? 'bg-surface-3 text-fg' : ''}
            icon={<ChartGantt className="size-4" />}
            onClick={() => void setMode('timeline')}
          />
          <IconButton
            size="sm"
            label={t('listView')}
            pressed={mode === 'list'}
            className={mode === 'list' ? 'bg-surface-3 text-fg' : ''}
            icon={<LayoutList className="size-4" />}
            onClick={() => void setMode('list')}
          />
        </div>
        {props.guideHref ? (
          <Link
            to={props.guideHref}
            title={t('openGuide')}
            aria-label={t('openGuide')}
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <CalendarClock className="size-4" />
          </Link>
        ) : null}
      </div>
    </div>
  );

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
          className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-sm whitespace-nowrap text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
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
        onFocusProgram={setFocused}
      />
    );
  } else {
    body = <ProgramList programs={list} now={now} channel={channel} kind={sourceKind} watchingLive={props.watchingLive} onActivate={activate} onFocusProgram={setFocused} />;
  }

  return (
    <section aria-label={t('guide')} data-testid="epg-ribbon" className="flex min-h-0 shrink-0 flex-col border-t border-divider bg-surface">
      {header}
      <div className={`${BODY_HEIGHT[mode]} overflow-hidden`} data-testid="ribbon-body">
        {body}
      </div>
    </section>
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

function Timeline(props: ViewProps & { from: number; to: number; resetKey: string }) {
  const { t, i18n } = useTranslation('live');
  const { programs, from, to, now, channel, kind } = props;
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
      const left = Math.max(0, nowX - w * 0.25);
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ left: scrollLeftFor(left, rtl), behavior: smooth && !reduced ? 'smooth' : 'auto' });
      setView({ left, width: w });
    },
    [nowX, rtl],
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
        tabIndex={scrollerTabbable ? 0 : undefined}
        data-testid="ribbon-timeline"
        className="relative h-full overflow-x-auto overflow-y-hidden pb-2 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        role="group"
        aria-label={t('timelineView')}
      >
        <div style={{ width, height: '100%', position: 'relative', minHeight: 92 }}>
          {/* First: the hour labels and the blocks' text paint over it, so it shows through the
              airing block's tint and never strikes through a title, a time or a tick label
              (L3-visual-3). */}
          <div aria-hidden data-testid="ribbon-now-line" className="pointer-events-none absolute top-3 bottom-1 w-0.5 bg-live" style={inlineStart(nowX - 1, rtl)}>
            <span className="absolute -top-1 -start-[3px] size-2 rounded-full bg-live" />
          </div>
          {ticks.map((tt, i) => {
            const x = ((tt - from) / MINUTE) * RIBBON_PX_PER_MIN;
            const midnight = localDayKey(tt) !== localDayKey(i > 0 ? ticks[i - 1]! : from);
            return (
              <div key={tt} className="absolute top-0 bottom-0" style={inlineStart(x, rtl)}>
                <span className="absolute top-0 start-1 text-[calc(11rem/15)] whitespace-nowrap text-fg-subtle tabular-nums">
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
              onActivate={props.onActivate}
              onFocusProgram={props.onFocusProgram}
            />
          ))}
        </div>
      </div>
      {Math.abs(view.left + view.width * 0.25 - nowX) > view.width * 0.6 ? (
        <button
          type="button"
          onClick={() => scrollToNow(true)}
          className="absolute end-3 bottom-3 z-20 inline-flex items-center gap-1 rounded-full bg-live px-3 py-1 text-xs font-semibold text-white shadow-2 hover:brightness-110 active:brightness-95 dark:text-bg"
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
  onActivate,
  onFocusProgram,
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
  onActivate(p: EpgProgram): void;
  onFocusProgram(p: EpgProgram | undefined): void;
}) {
  const { t, i18n } = useTranslation('live');
  const p = block.program;
  const catchup = canCatchUp(p, channel, kind, now);
  const progress = block.when === 'now' ? programProgress(p, now) : 0;
  const tone =
    block.when === 'now'
      ? 'border-accent bg-accent/12 text-fg'
      : block.when === 'past'
        ? catchup
          ? 'border-border bg-surface-2 text-fg-muted hover:border-accent hover:text-fg'
          : 'border-border/60 bg-surface-2/50 text-fg-subtle'
        : 'border-border bg-surface-2 text-fg hover:bg-surface-3';
  const label = [
    p.title,
    formatRange(p, i18n.language),
    block.when === 'now' ? t('onNow') : '',
    block.when === 'past' && catchup ? t('catchupAvailable') : '',
    block.when === 'now' && catchup && watchingLive ? t('startOverAvailable') : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      data-start={p.start}
      data-when={block.when}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      title={p.description ? `${p.title}\n${p.description}` : p.title}
      onClick={() => onActivate(p)}
      onMouseEnter={() => onFocusProgram(p)}
      onFocus={() => onFocusProgram(p)}
      // overflow-clip, not hidden: the block is then no scroll container, so its text can stick.
      className={`absolute top-5 bottom-2 overflow-clip rounded-md border px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent ${tone}`}
      style={{ ...inlineStart(block.left + 1, rtl), width: Math.max(2, block.width - 2) }}
    >
      {block.when === 'now' ? (
        <span aria-hidden className="absolute inset-y-0 start-0 bg-accent/15" style={{ width: `${progress * 100}%` }} />
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
                className={`flex h-full w-full items-center gap-3 border-b border-divider px-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                  when === 'now' ? 'bg-accent/10' : 'hover:bg-surface-2'
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
                      <span className="block h-full bg-live" style={{ width: `${programProgress(p, now) * 100}%` }} />
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
                  <span className="shrink-0 rounded-sm bg-live px-1.5 py-px text-2xs font-semibold text-white dark:text-bg">{t('liveBadge')}</span>
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
