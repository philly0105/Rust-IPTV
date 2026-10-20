import { AudioLines, CalendarX2, Download, History, Play, Radio, SearchX } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { sameRef, type Channel, type EpgProgram, type ItemRef, type SourceKind } from '@/api/types';
import { PlayerStage, usePlayerStore } from '@/features/player';
import { useShell } from '@/shell';
import { BackButton, Button, buttonClass, cn, EmptyState, ErrorState, IconButton, LivePill, MetaLine, Page, Skeleton, Tabs, useToast, errorDescription } from '@/ui';

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
import { canDownloadCatchup, catchupDownloadArgs, playCatchup, playChannel } from '../lib/playback';
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
  // Navigation to the Live TV page, not "Back to live" (which returns a catch-up to the stream), LG-08.
  const backLink = (
    <Link to={livePath} className={buttonClass('secondary', 'md')}>
      {t('liveTv')}
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
    body = <ArchiveBrowser channel={channel} kind={kind} name={name} sourceName={source.data?.name} offsetMinutes={prefs.epgOffsetMinutes} />;
  } else {
    body = <EmptyState icon={<CalendarX2 size={28} />} title={t('archiveUnsupported')} description={t('archiveUnsupportedHint')} action={backLink} />;
  }

  return (
    // Fills the shell's main area: the player, the channel header and the day tabs stay put while
    // the programme list scrolls inside. Side by side from lg, stacked below.
    <Page width="wide" className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 pt-4 pb-0 lg:flex-row lg:gap-8" data-testid="archive-page">
      <h1 className="sr-only">{name ? t('archiveOf', { name }) : t('archiveTitle')}</h1>
      {body}
    </Page>
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
  sourceName?: string;
  offsetMinutes: number;
}

function ArchiveBrowser({ channel, kind, name, sourceName, offsetMinutes }: BrowserProps) {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const navigate = useNavigate();
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

  // ---- day tabs (the kit's: arrows, Home and End choose) -------------------------
  const dayItems = useMemo(() => days.map((d, i) => ({ id: String(i), label: <span className="tabular-nums">{dayLabel(d, i)}</span> })), [days, i18n.language]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // LG-09: the programme playing from here is marked in the list while the player holds it.
  const [playedStart, setPlayedStart] = useState<string | null>(null);
  const playerSource = usePlayerStore((st) => st.source);
  const playingStart =
    playedStart && playerSource && !playerSource.isLive && playerSource.ref && sameRef(playerSource.ref, channel.ref) ? playedStart : null;
  const play = (p: EpgProgram, state: ArchiveProgramState) => {
    if (state === 'live') {
      setPlayedStart(null);
      playChannel(channel, kind, p.title, name).catch((err: unknown) =>
        toast({ title: t('playFailed', { name }), description: errorDescription(err), variant: 'error' }),
      );
      return;
    }
    if (state !== 'playable' && state !== 'airing') return;
    setPlayedStart(p.start);
    playCatchup(channel, kind, p, now, name).catch((err: unknown) => {
      setPlayedStart(null);
      toast({ title: t('catchupFailed'), description: errorDescription(err), variant: 'error' });
    });
  };
  // FW-ARCHIVE-DOWNLOAD-UNBOUNDED: only archive links that end by themselves can be saved.
  const downloadable = canDownloadCatchup(channel, kind);

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

  const panelPrefix = 'archive-day';
  const panelId = `${panelPrefix}-${selected}`;

  return (
    <>
      <div className="@container/archive flex shrink-0 flex-col gap-4 lg:sticky lg:top-0 lg:w-[min(46%,44rem)] lg:self-start">
        <div className="flex flex-wrap items-center gap-3">
          <BackButton to={`/s/${encodeURIComponent(channel.ref.sourceId)}/live`} label={t('liveTv')} />
        </div>
        {/* A narrow column (a phone, the sticky column of a 1024 px window) puts Watch live under the
            name: beside it, the name was cut to "Wildf…" and the line under it wrapped a word to a line. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <ChannelLogo src={channel.logoUrl} name={name} size={56} sourceId={channel.ref.sourceId} />
          <div className="min-w-0 flex-1">
            <p dir="auto" className="truncate text-title text-fg" title={name}>
              {name}
            </p>
            <MetaLine className="mt-0.5" items={[t('archiveDays', { count }), sourceName]} />
          </div>
          <Button variant="secondary" icon={<Radio className="size-4" />} onClick={() => void watchLive()} className="shrink-0 @max-[24rem]/archive:w-full">
            {t('watchLive')}
          </Button>
        </div>
        {/* LG-09: catch-up plays here, in a full player, not in the corner mini player. */}
        <div className="relative aspect-video max-h-[50vh] w-full overflow-hidden rounded-xl bg-black shadow-2 ring-1 ring-edge" data-testid="archive-stage">
          <PlayerStage className="h-full w-full">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[radial-gradient(120%_90%_at_50%_20%,rgb(38_48_66)_0%,transparent_70%)] px-6 text-center">
              <History size={24} aria-hidden className="text-on-glass-muted" />
              <p className="text-body-sm text-on-glass-muted">{t('archiveStageIdle')}</p>
            </div>
          </PlayerStage>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 lg:max-w-3xl">
        <div data-testid="archive-days" className="shrink-0">
          <Tabs
            items={dayItems}
            value={String(selected)}
            onChange={(id) => setDayIndex(Number(id))}
            label={t('archiveDayPicker')}
            panelIdPrefix={panelPrefix}
          />
        </div>

        <section
          ref={panelRef}
          role="tabpanel"
          id={panelId}
          aria-labelledby={`${panelPrefix}-tab-${selected}`}
          data-testid="archive-panel"
          // A short fade under the tabs, so a row scrolling up never ends sliced at a hard edge.
          className="-mx-1 flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-1 pt-2 pb-8 [mask-image:linear-gradient(to_bottom,transparent,#000_12px)]"
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
              {fromProvider ? <p className="px-3 text-caption text-fg-subtle">{t('archiveFromProvider')}</p> : null}
              {slotted ? (
                <p className="px-3 text-caption text-fg-subtle" data-testid="archive-slots-note">
                  {t('archiveSlotsNote')}
                </p>
              ) : null}
              <ul aria-label={t('archivePrograms', { day: dayLabel(day, selected) })} onKeyDown={onListKey} className="flex flex-col gap-0.5" data-testid="archive-programs">
                {programs.map((p, i) => (
                  <ProgramRow
                    key={`${p.start}-${i}`}
                    program={p}
                    state={states[i] ?? 'future'}
                    playing={playingStart === p.start}
                    tabIndex={i === current ? 0 : -1}
                    buttonRef={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    onFocus={() => setActive(i)}
                    onPlay={() => play(p, states[i] ?? 'future')}
                    onDownload={states[i] === 'playable' && downloadable ? () => download(p) : undefined}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}

interface RowProps {
  program: EpgProgram;
  state: ArchiveProgramState;
  /** This programme's catch-up is what the player holds (LG-09). */
  playing: boolean;
  tabIndex: number;
  buttonRef(el: HTMLButtonElement | null): void;
  onFocus(): void;
  onPlay(): void;
  /** Finished programmes whose archive link ends by itself: queue it as a download. */
  onDownload?: () => void;
}

/** Shown on hover, while the row has focus, and always on touch, where nothing hovers. */
const REVEAL = 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100';

function ProgramRow({ program, state, playing, tabIndex, buttonRef, onFocus, onPlay, onDownload }: RowProps) {
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
  // The time column already says when a future programme starts: only expiry needs a note.
  const note = state === 'expired' ? t('archiveExpired') : null;
  const onNow = state === 'airing' || state === 'live';

  return (
    <li className={cn('group/row flex items-center gap-1 rounded-md', playing || onNow ? 'tuning-tick bg-selected' : '')}>
      <button
        ref={buttonRef}
        type="button"
        tabIndex={tabIndex}
        aria-disabled={disabled || undefined}
        aria-current={playing ? 'true' : undefined}
        onFocus={onFocus}
        onClick={disabled ? undefined : onPlay}
        data-state={state}
        data-playing={playing ? '' : undefined}
        className={cn(
          // A phone stacks it (time and action on top, the programme below); from sm it is one line.
          'flex w-full min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-2.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset sm:flex-nowrap motion-safe:transition-colors',
          disabled ? 'cursor-default text-fg-subtle' : cn('text-fg', !(playing || onNow) && 'hover:bg-hover'),
        )}
      >
        <span className={cn('order-1 shrink-0 font-numeric text-sm whitespace-nowrap tabular-nums sm:w-32', disabled ? 'text-fg-subtle' : 'text-fg-muted')}>
          {formatRange(program, i18n.language)}
        </span>
        <span className="order-3 min-w-0 basis-full sm:order-2 sm:basis-0 sm:flex-1">
          <span className="flex items-center gap-2">
            <span dir="auto" className={cn('truncate text-body-sm', disabled ? '' : 'font-medium')}>
              {program.title}
            </span>
            {onNow ? <LivePill size="sm" dot="none" /> : null}
            {playing ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-caption text-accent" data-testid="archive-playing">
                <AudioLines size={12} aria-hidden />
                {t('playingNow')}
              </span>
            ) : null}
          </span>
          {program.description ? (
            <span dir="auto" className="mt-0.5 line-clamp-1 text-caption text-fg-muted">
              {program.description}
            </span>
          ) : null}
          {note ? <span className="mt-0.5 block text-caption">{note}</span> : null}
        </span>
        {action && !playing ? (
          // What a press does, as a quiet button shape: on hover or focus, and always on the airing row.
          <span
            aria-hidden
            className={cn(
              'order-2 ms-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium sm:order-3',
              onNow ? 'bg-surface-3 text-fg' : cn('text-fg-muted group-hover/row:bg-hover group-hover/row:text-fg', REVEAL),
            )}
          >
            {action.icon}
            {/* A phone's row keeps the time and the action on one line: the icon says it there, and
                the whole row is the button. The airing row keeps its words. */}
            <span className={onNow ? undefined : 'max-sm:hidden'}>{action.label}</span>
          </span>
        ) : null}
      </button>
      {onDownload ? (
        <IconButton
          size="sm"
          label={t('downloadCatchup', { title: program.title })}
          icon={<Download aria-hidden className="size-4" />}
          tabIndex={tabIndex}
          onClick={onDownload}
          className={cn('shrink-0', REVEAL, 'focus-visible:opacity-100')}
          data-testid="archive-download"
        />
      ) : null}
    </li>
  );
}
