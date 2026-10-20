import { CalendarX2, Download, History, Play, Radio, SearchX } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, ItemRef, SourceKind } from '@/api/types';
import { useShell } from '@/shell';
import { Badge, Button, buttonClass, cn, EmptyState, ErrorState, IconButton, LivePill, Skeleton, useToast, errorDescription } from '@/ui';

import { useArchiveDay } from '../hooks/useArchiveDay';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useNow } from '../hooks/useNow';
import { useShortEpgEnabled } from '../hooks/useShortEpg';
import {
  archiveDayCount,
  archiveDays,
  archiveHourSlots,
  archiveProgramState,
  canBrowseArchive,
  dayRange,
  initialProgramIndex,
  type ArchiveProgramState,
} from '../lib/archive';
import { displayChannelName } from '../lib/channelName';
import { formatClock, formatDay, formatRange, HOUR, ms } from '../lib/epgTime';
import { catchupDownloadArgs, playCatchup, playChannel } from '../lib/playback';
import { timeStep, useIsRtl } from '../lib/rtl';
import { ChannelLogo } from './ChannelLogo';

function isChannel(item: { ref: ItemRef } | undefined): item is Channel {
  return !!item && item.ref.contentType === 'live' && 'isRadio' in item && 'name' in item;
}

/** Catch-up archive of one channel: a day picker and that day's programmes. */
export function ArchivePage() {
  const { t } = useTranslation('live');
  const { sourceId = '', channelId = '' } = useParams();
  const ref = useMemo<ItemRef>(() => ({ sourceId, contentType: 'live', itemId: channelId }), [sourceId, channelId]);
  const item = useRpcQuery('catalog.item', { ref }, { enabled: !!sourceId && !!channelId });
  const source = useRpcQuery('sources.get', { id: sourceId }, { enabled: !!sourceId });
  const prefs = useDisplayPrefs();
  const channel = isChannel(item.data) ? item.data : undefined;
  const kind = source.data?.kind;
  const name = channel ? displayChannelName(channel.name, prefs.stripCountryPrefix) : '';

  const shell = useShell();
  const subtitle = name || source.data?.name;
  useEffect(() => {
    shell.setHeader({ title: t('archiveTitle'), subtitle });
  }, [shell, t, subtitle]);

  const livePath = `/s/${encodeURIComponent(sourceId)}/live`;
  const backLink = (
    <Link to={livePath} className={buttonClass('secondary', 'md')}>
      {t('backToLive')}
    </Link>
  );

  let body;
  if (item.isPending || source.isPending) {
    body = <ArchiveSkeleton />;
  } else if (item.error?.code === 'not_found' || (item.data && !channel)) {
    body = <EmptyState icon={<SearchX size={28} />} title={t('archiveNotFound')} description={t('archiveNotFoundHint')} action={backLink} />;
  } else if (item.error || source.error) {
    body = <ErrorState error={item.error ?? source.error} onRetry={() => void Promise.all([item.refetch(), source.refetch()])} action={backLink} />;
  } else if (channel && kind && canBrowseArchive(channel, kind)) {
    body = <ArchiveBrowser channel={channel} kind={kind} name={name} offsetMinutes={prefs.epgOffsetMinutes} />;
  } else {
    body = <EmptyState icon={<CalendarX2 size={28} />} title={t('archiveUnsupported')} description={t('archiveUnsupportedHint')} action={backLink} />;
  }

  return (
    // Fills the shell's main area: the channel header and day tabs stay put while the programme list scrolls inside.
    <div className="mx-auto flex min-h-0 w-full max-w-[1100px] min-w-0 flex-1 flex-col gap-4 px-4 pt-4 sm:px-6" data-testid="archive-page">
      <h1 className="sr-only">{name ? t('archiveOf', { name }) : t('archiveTitle')}</h1>
      {body}
    </div>
  );
}

function ArchiveSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-12 w-72" />
      <div className="flex gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

interface BrowserProps {
  channel: Channel;
  kind: SourceKind;
  name: string;
  offsetMinutes: number;
}

function ArchiveBrowser({ channel, kind, name, offsetMinutes }: BrowserProps) {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const navigate = useNavigate();
  const rtl = useIsRtl();
  const now = useNow(30_000);
  const shortEpg = useShortEpgEnabled(kind);
  const count = archiveDayCount(channel);
  // Day boundaries follow the clock but only change at midnight.
  const todayKey = new Date(now).toDateString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => archiveDays(now, count), [todayKey, count]);
  const [dayIndex, setDayIndex] = useState(0);
  const selected = Math.min(dayIndex, days.length - 1);
  const day = days[selected] ?? days[0] ?? now;
  const { start, end } = dayRange(day);

  const query = useArchiveDay({ ref: channel.ref, kind, start, end, offsetMinutes, isToday: selected === 0, shortEpg });
  // No guide at all for the day: hourly slots across the archive window, so a channel that
  // advertises catch-up can still be rewound to a time.
  const slotted = !!query.data && query.data.length === 0;
  const slots = useMemo(
    () => (slotted ? archiveHourSlots(start, end, now, channel, (s) => t('archiveSlotTitle', { time: formatClock(s, i18n.language) })) : []),
    // `now` moves every 30 s; the slots only change when a new hour starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotted, start, end, Math.floor(now / HOUR), channel, t, i18n.language],
  );
  const programs = useMemo(() => (slotted ? slots : (query.data ?? [])), [slotted, slots, query.data]);
  const states = useMemo(() => programs.map((p) => archiveProgramState(p, channel, kind, now)), [programs, channel, kind, now]);
  const fromProvider = programs.some((p) => p.fromProvider);

  const dayLabel = (d: number, i: number) => (i === 0 ? t('archiveToday') : i === 1 ? t('archiveYesterday') : formatDay(d, i18n.language));

  // ---- day tabs ---------------------------------------------------------------
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectDay = (i: number) => {
    const next = Math.max(0, Math.min(days.length - 1, i));
    setDayIndex(next);
    tabRefs.current[next]?.focus();
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = timeStep(e.key, rtl);
    if (step) selectDay(selected + step);
    else if (e.key === 'Home') selectDay(0);
    else if (e.key === 'End') selectDay(days.length - 1);
    else return;
    e.preventDefault();
  };

  // ---- programme list (roving focus) ---------------------------------------------
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(-1);
  const initial = initialProgramIndex(states);
  const current = active >= 0 && active < programs.length ? active : initial;
  // A new day starts at its airing or latest playable programme.
  useEffect(() => {
    setActive(-1);
  }, [day, query.data]);
  // Opens on the airing (or latest playable) programme by scrolling the list alone. scrollIntoView
  // scrolled every ancestor too, which pushed the channel header and day tabs out of view.
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const box = panelRef.current;
    const row = initial >= 0 ? rowRefs.current[initial] : null;
    if (!box || !row) return;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    box.scrollTop = Math.max(0, box.scrollTop + r.top - b.top - (b.height - r.height) / 2);
  }, [initial, query.data]);

  const moveRow = (i: number) => {
    const next = Math.max(0, Math.min(programs.length - 1, i));
    setActive(next);
    rowRefs.current[next]?.focus();
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') moveRow(current + 1);
    else if (e.key === 'ArrowUp') moveRow(current - 1);
    else if (e.key === 'Home') moveRow(0);
    else if (e.key === 'End') moveRow(programs.length - 1);
    else return;
    e.preventDefault();
  };

  const play = (p: EpgProgram, state: ArchiveProgramState) => {
    if (state === 'live') {
      playChannel(channel, kind, p.title, name).catch((err: unknown) =>
        toast({ title: t('playFailed', { name }), description: errorDescription(err), variant: 'error' }),
      );
      return;
    }
    if (state !== 'playable' && state !== 'airing') return;
    playCatchup(channel, kind, p, now, name).catch((err: unknown) =>
      toast({ title: t('catchupFailed'), description: errorDescription(err), variant: 'error' }),
    );
  };

  // Queues a finished programme as a download; My Videos lists it under the channel.
  const download = (p: EpgProgram) => {
    const at = ms(p.start);
    const subtitle = `${p.title} · ${formatDay(at, i18n.language)} ${formatClock(at, i18n.language)}`;
    catchupDownloadArgs(channel, kind, p, { now, displayName: name, subtitle, notFileMessage: t('downloadNotFile', { ns: 'vod' }) })
      .then(async (args) => {
        if (!args) return;
        await rpc('downloads.start', args);
        void invalidate('downloads.');
        toast({
          title: t('downloadQueued', { ns: 'vod' }),
          description: `${name}  ${p.title}`,
          variant: 'success',
          action: { label: t('openDownloads', { ns: 'vod' }), onClick: () => void navigate('/downloads') },
        });
      })
      .catch((err: unknown) =>
        toast({ title: t('downloadFailed', { ns: 'vod' }), description: errorDescription(err), variant: 'error' }),
      );
  };

  const watchLive = () =>
    playChannel(channel, kind, undefined, name).catch((err: unknown) =>
      toast({ title: t('playFailed', { name }), description: errorDescription(err), variant: 'error' }),
    );

  const panelId = `archive-day-panel`;
  const tabId = (i: number) => `archive-day-${i}`;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <ChannelLogo src={channel.logoUrl} name={name} size={44} sourceId={channel.ref.sourceId} />
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-lg font-semibold text-fg">
            {name}
          </p>
          <p className="text-sm text-fg-muted">{t('archiveDays', { count })}</p>
        </div>
        <Button variant="secondary" icon={<Radio className="size-4" />} onClick={() => void watchLive()}>
          {t('watchLive')}
        </Button>
        <Link to={`/s/${encodeURIComponent(channel.ref.sourceId)}/live`} className={buttonClass('ghost', 'md')}>
          {t('backToLive')}
        </Link>
      </div>

      <div
        role="tablist"
        aria-label={t('archiveDayPicker')}
        onKeyDown={onTabKey}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
        data-testid="archive-days"
      >
        {days.map((d, i) => (
          <button
            key={d}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            id={tabId(i)}
            type="button"
            role="tab"
            aria-selected={i === selected}
            aria-controls={panelId}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => setDayIndex(i)}
            className={cn(
              'h-9 shrink-0 rounded-md border px-3 text-sm tabular-nums transition-colors',
              i === selected ? 'border-transparent bg-selected text-fg font-semibold' : 'border-edge text-fg-muted hover:bg-hover hover:text-fg',
            )}
          >
            {dayLabel(d, i)}
          </button>
        ))}
      </div>

      <section
        ref={panelRef}
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(selected)}
        data-testid="archive-panel"
        className="-mx-1 flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-1 pt-1 pb-8"
      >
        {query.isPending ? (
          <div className="flex flex-col gap-1" aria-busy="true">
            <span className="sr-only">{t('archiveLoading')}</span>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : query.error ? (
          <ErrorState size="inline" error={query.error} title={t('archiveFailed')} onRetry={() => void query.refetch()} />
        ) : programs.length === 0 ? (
          <EmptyState size="inline" icon={<CalendarX2 size={24} />} title={t('archiveEmptyDay')} description={t('archiveEmptyDayHint')} />
        ) : (
          <>
            {fromProvider ? <p className="text-xs text-fg-subtle">{t('archiveFromProvider')}</p> : null}
            {slotted ? (
              <p className="text-xs text-fg-subtle" data-testid="archive-slots-note">
                {t('archiveSlotsNote')}
              </p>
            ) : null}
            <ul aria-label={t('archivePrograms', { day: dayLabel(day, selected) })} onKeyDown={onListKey} className="flex flex-col gap-1" data-testid="archive-programs">
              {programs.map((p, i) => (
                <ProgramRow
                  key={`${p.start}-${i}`}
                  program={p}
                  state={states[i] ?? 'future'}
                  tabIndex={i === current ? 0 : -1}
                  buttonRef={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  onFocus={() => setActive(i)}
                  onPlay={() => play(p, states[i] ?? 'future')}
                  onDownload={states[i] === 'playable' ? () => download(p) : undefined}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

interface RowProps {
  program: EpgProgram;
  state: ArchiveProgramState;
  tabIndex: number;
  buttonRef(el: HTMLButtonElement | null): void;
  onFocus(): void;
  onPlay(): void;
  /** Finished programmes only: queue the archive as a download. */
  onDownload?: () => void;
}

function ProgramRow({ program, state, tabIndex, buttonRef, onFocus, onPlay, onDownload }: RowProps) {
  const { t, i18n } = useTranslation('live');
  const disabled = state === 'future' || state === 'expired';
  const action =
    state === 'playable'
      ? { icon: <Play className="size-3.5" />, label: t('watchCatchup') }
      : state === 'airing'
        ? { icon: <History className="size-3.5" />, label: t('archiveWatchFromStart') }
        : state === 'live'
          ? { icon: <Radio className="size-3.5" />, label: t('watchLive') }
          : null;
  const note = state === 'future' ? t('startsAt', { time: formatClock(ms(program.start), i18n.language) }) : state === 'expired' ? t('archiveExpired') : null;
  const onNow = state === 'airing' || state === 'live';

  return (
    <li className="flex items-start gap-1">
      <button
        ref={buttonRef}
        type="button"
        tabIndex={tabIndex}
        aria-disabled={disabled || undefined}
        onFocus={onFocus}
        onClick={disabled ? undefined : onPlay}
        data-state={state}
        className={cn(
          // A phone stacks it (time and action on top, the programme below); from sm it is one line.
          'group flex w-full min-w-0 flex-1 flex-wrap items-start gap-x-4 gap-y-1 rounded-md px-3 py-2.5 text-start transition-colors sm:flex-nowrap',
          onNow ? 'tuning-tick bg-selected' : '',
          disabled ? 'cursor-default text-fg-subtle' : 'text-fg hover:bg-hover',
        )}
      >
        <span className={cn('order-1 shrink-0 pt-0.5 text-sm whitespace-nowrap tabular-nums sm:min-w-36', disabled ? 'text-fg-subtle' : 'text-fg-muted')}>
          {formatRange(program, i18n.language)}
        </span>
        <span className="order-3 min-w-0 basis-full sm:order-2 sm:basis-0 sm:flex-1">
          <span className="flex items-center gap-2">
            <span dir="auto" className={cn('truncate text-sm', disabled ? '' : 'font-medium')}>
              {program.title}
            </span>
            {onNow ? <LivePill /> : null}
          </span>
          {program.description ? (
            <span dir="auto" className="mt-0.5 line-clamp-1 text-xs text-fg-muted">
              {program.description}
            </span>
          ) : null}
          {note ? <span className="mt-0.5 block text-xs">{note}</span> : null}
        </span>
        {action ? (
          <Badge
            variant={state === 'playable' ? 'outline' : 'accent'}
            className="order-2 ms-auto mt-0.5 shrink-0 opacity-80 group-hover:opacity-100 group-focus-visible:opacity-100 sm:order-3"
          >
            {action.icon}
            {action.label}
          </Badge>
        ) : null}
      </button>
      {onDownload ? (
        <IconButton
          size="sm"
          label={t('downloadCatchup', { title: program.title })}
          icon={<Download aria-hidden className="size-4" />}
          tabIndex={tabIndex}
          onClick={onDownload}
          className="mt-1.5 shrink-0"
          data-testid="archive-download"
        />
      ) : null}
    </li>
  );
}
