import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarClock, ChartGantt, History, LayoutList, Link2, Radio, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, SourceKind } from '@/api/types';

import { Button, EmptyState, ErrorState, IconButton, Skeleton, useToast } from '@/ui';
import { useChannelPrograms } from '../hooks/useChannelPrograms';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useNow } from '../hooks/useNow';
import { displayChannelName } from '../lib/channelName';
import {
  HOUR,
  MINUTE,
  canCatchUp,
  floorTo,
  formatClock,
  formatDay,
  formatRange,
  layoutBlocks,
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

export const RIBBON_PX_PER_MIN = 4;
const AHEAD = 12 * HOUR;
const LIST_ROW = 52;

export interface EpgRibbonProps {
  channel?: Channel;
  sourceKind?: SourceKind;
  /** true when the live stream of `channel` is what is playing (not a catch-up) */
  watchingLive: boolean;
  onPlayLive(channel: Channel): void;
  onMapEpg(channel: Channel): void;
  guideHref?: string;
}

type Mode = 'timeline' | 'list';

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
  // XMLTV for every kind; a Stalker portal's own guide on top (see useChannelPrograms).
  const programs = useChannelPrograms(channel, sourceKind, from, to);
  const prefs = useDisplayPrefs();
  const list = useMemo(() => shiftPrograms(programs.programs, prefs.epgOffsetMinutes), [programs.programs, prefs.epgOffsetMinutes]);
  const channelName = displayChannelName(channel?.name, prefs.stripCountryPrefix);
  const current = useMemo(() => list.find((p) => programWhen(p, now) === 'now'), [list, now]);
  const [focused, setFocused] = useState<EpgProgram | undefined>(undefined);
  useEffect(() => setFocused(undefined), [channel?.ref.itemId]);
  const shown = focused ?? current;

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
          await playCatchup(channel, sourceKind!, p);
        } catch (err) {
          toast({ title: t('catchupFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
        }
        return;
      }
      setFocused(p);
    },
    [channel, now, props, sourceKind, t, toast],
  );

  const header = (
    <div className="flex min-w-0 items-start gap-3 px-4 pt-3 pb-2">
      <div className="min-w-0 flex-1">
        {shown ? (
          <>
            <p className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
              {programWhen(shown, now) === 'now' ? (
                <span className="inline-flex items-center gap-1 rounded-sm bg-live px-1.5 py-px text-[10px] font-semibold text-white dark:text-bg">{t('liveBadge')}</span>
              ) : null}
              <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="ribbon-time">{formatRange(shown, i18n.language)}</span>
              {programWhen(shown, now) === 'now' ? (
                <span className="shrink-0 whitespace-nowrap" data-testid="ribbon-remaining">
                  {t('minutesLeft', { count: minutesLeft(shown, now) })}
                </span>
              ) : null}
              {/* The category is the first thing to go: below 1440 px the pane is too narrow for it to be more than "Ne…". */}
              {shown.category ? (
                <span className="hidden min-w-0 truncate text-fg-subtle min-[1440px]:block" data-testid="ribbon-category">
                  {shown.category}
                </span>
              ) : null}
            </p>
            <p className="truncate text-sm font-semibold text-fg">{shown.title}</p>
            {shown.description ? <p className="line-clamp-1 text-xs text-fg-muted">{shown.description}</p> : null}
          </>
        ) : (
          <p className="truncate text-sm font-semibold text-fg">{channelName || t('guide')}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {channel && !props.watchingLive ? (
          <Button size="sm" variant="secondary" icon={<Radio className="size-3.5" />} onClick={() => props.onPlayLive(channel)}>
            {t('backToLive')}
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
    body = <EmptyState icon={<CalendarClock className="size-6" />} title={t('ribbonPickChannel')} />;
  } else if (programs.error) {
    body = <ErrorState error={programs.error} onRetry={programs.refetch} />;
  } else if (programs.isLoading) {
    body = (
      <div className="flex gap-1 px-4 pt-6" aria-busy="true" aria-label={t('loadingGuide')}>
        {[160, 220, 120, 260, 180, 200].map((w, i) => (
          <div key={i} className="shrink-0" style={{ width: w }}>
            <Skeleton className="h-12" />
          </div>
        ))}
      </div>
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon={<CalendarClock className="size-6" />}
        title={t('noGuideFor', { name: channelName })}
        description={t('noGuideHint')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" icon={<Link2 className="size-3.5" />} onClick={() => props.onMapEpg(channel)}>
              {t('mapEpg')}
            </Button>
            <Link to="/settings/epg" className="inline-flex h-8 items-center rounded-md px-3 text-sm text-accent hover:underline">
              {t('epgSettings')}
            </Link>
          </div>
        }
      />
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
    <section aria-label={t('guide')} data-testid="epg-ribbon" className="flex min-h-0 flex-col border-t border-border bg-surface">
      {header}
      <div className={mode === 'list' && list.length > 0 ? 'h-56' : 'min-h-[104px]'}>{body}</div>
    </section>
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
  const ticks: number[] = [];
  for (let tt = floorTo(from, HOUR) + HOUR; tt < to; tt += HOUR) ticks.push(tt);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = [...(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-start]') ?? [])];
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

  return (
    <div className="relative h-full">
      <div ref={scroller} onScroll={onScroll} onKeyDown={onKeyDown} className="relative h-full overflow-x-auto overflow-y-hidden pb-2" role="group" aria-label={t('timelineView')}>
        <div style={{ width, height: '100%', position: 'relative', minHeight: 92 }}>
          {ticks.map((tt) => {
            const x = ((tt - from) / MINUTE) * RIBBON_PX_PER_MIN;
            const midnight = new Date(tt).getHours() === 0;
            return (
              <div key={tt} className="absolute top-0 bottom-0" style={inlineStart(x, rtl)}>
                <span className="absolute top-0 start-1 text-[11px] whitespace-nowrap text-fg-subtle tabular-nums">
                  {midnight ? formatDay(tt, i18n.language) : formatClock(tt, i18n.language)}
                </span>
                <span className={`absolute top-4 bottom-0 w-px ${midnight ? 'bg-border' : 'bg-border/50'}`} />
              </div>
            );
          })}
          {visible.map((b) => (
            <TimelineBlock
              key={`${b.program.start}|${b.program.title}`}
              block={b}
              now={now}
              channel={channel}
              kind={kind}
              watchingLive={props.watchingLive}
              rtl={rtl}
              tabbable={blocks.indexOf(b) === (nowIndex >= 0 ? nowIndex : 0)}
              onActivate={props.onActivate}
              onFocusProgram={props.onFocusProgram}
            />
          ))}
          <div aria-hidden data-testid="ribbon-now-line" className="pointer-events-none absolute top-3 bottom-1 z-10 w-0.5 bg-live" style={inlineStart(nowX - 1, rtl)}>
            <span className="absolute -top-1 -start-[3px] size-2 rounded-full bg-live" />
          </div>
        </div>
      </div>
      {Math.abs(view.left + view.width * 0.25 - nowX) > view.width * 0.6 ? (
        <button
          type="button"
          onClick={() => scrollToNow(true)}
          className="absolute end-3 bottom-3 z-20 inline-flex items-center gap-1 rounded-full bg-live px-3 py-1 text-xs font-semibold text-white shadow-2 dark:text-bg"
        >
          <RotateCcw className="size-3" aria-hidden />
          {t('jumpToNow')}
        </button>
      ) : null}
    </div>
  );
}

function TimelineBlock({
  block,
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
      className={`absolute top-5 bottom-2 overflow-hidden rounded-md border px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent ${tone}`}
      style={{ ...inlineStart(block.left + 1, rtl), width: Math.max(2, block.width - 2) }}
    >
      {block.when === 'now' ? (
        <span aria-hidden className="absolute inset-y-0 start-0 bg-accent/15" style={{ width: `${progress * 100}%` }} />
      ) : null}
      <span className="relative flex items-center gap-1 truncate text-xs font-medium">
        {catchup && (block.when === 'past' || watchingLive) ? <History className="size-3 shrink-0" aria-hidden /> : null}
        <span className="truncate">{p.title}</span>
      </span>
      {/* Muted by token, not opacity: opacity over the tinted block drops below 4.5:1 in the light theme. */}
      <span className={`relative block truncate text-[11px] tabular-nums ${block.when === 'future' ? 'text-fg-muted' : ''}`}>
        {formatClock(ms(p.start), i18n.language)}
      </span>
    </button>
  );
}

function ProgramList(props: ViewProps) {
  const { t, i18n } = useTranslation('live');
  const { programs, now, channel, kind } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
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
          return (
            <div key={v.key} role="listitem" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: LIST_ROW, transform: `translateY(${v.start}px)` }}>
              <button
                type="button"
                data-index={v.index}
                tabIndex={v.index === (nowIndex >= 0 ? nowIndex : 0) ? 0 : -1}
                onClick={() => props.onActivate(p)}
                onFocus={() => props.onFocusProgram(p)}
                className={`flex h-full w-full items-center gap-3 border-b border-border/50 px-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                  when === 'now' ? 'bg-accent/10' : 'hover:bg-surface-2'
                } ${when === 'past' && !catchup ? 'text-fg-subtle' : 'text-fg'}`}
              >
                <span className="w-24 shrink-0 text-xs tabular-nums text-fg-muted">{formatRange(p, i18n.language)}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{p.title}</span>
                  {when === 'now' ? (
                    <span className="mt-1 h-[3px] w-full max-w-48 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                      <span className="block h-full bg-live" style={{ width: `${programProgress(p, now) * 100}%` }} />
                    </span>
                  ) : p.description ? (
                    <span className="truncate text-xs text-fg-muted">{p.description}</span>
                  ) : null}
                </span>
                {when === 'now' && catchup && props.watchingLive ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
                    <History className="size-3.5" aria-hidden />
                    {t('startOver')}
                  </span>
                ) : null}
                {when === 'now' ? (
                  <span className="shrink-0 rounded-sm bg-live px-1.5 py-px text-[10px] font-semibold text-white dark:text-bg">{t('liveBadge')}</span>
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
