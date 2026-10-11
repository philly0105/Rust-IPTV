import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarClock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, History, Play, Radio, Tv, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type EpgProgram, type ItemKey, type SourceKind } from '@/api/types';

import { Button, EmptyState, ErrorState, Skeleton, useShell, useToast } from '../_shim';
import { useNow } from '../hooks/useNow';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useStalkerPreviews } from '../hooks/useStalkerPreviews';
import { mergePrograms } from '../lib/epgMerge';
import {
  DAY,
  HOUR,
  MINUTE,
  canCatchUp,
  floorTo,
  formatClock,
  formatDay,
  formatRange,
  layoutBlocks,
  ms,
  programIndexAt,
  programWhen,
} from '../lib/epgTime';
import { playCatchup, playChannel } from '../lib/playback';
import { ChannelLogo } from './ChannelLogo';

export const GRID_ROW = 56;
export const GRID_SLOT_MIN = 30;
export const GRID_SLOT_PX = 150;
export const GRID_WINDOW = 6 * HOUR;
export const GRID_CHUNK = 40;
const PX_PER_MIN = GRID_SLOT_PX / GRID_SLOT_MIN;
const HEADER_H = 36;
/** Portal programmes per row: enough to fill the 6 h window from now. */
const STALKER_GRID_LIMIT = 12;

function defaultStart(now: number): number {
  return floorTo(now, GRID_SLOT_MIN * MINUTE) - GRID_SLOT_MIN * MINUTE;
}

interface Selection {
  channel: Channel;
  program: EpgProgram;
  rect: { left: number; top: number; bottom: number };
}

/** Multi-channel guide: virtualized channel rows x 30-minute columns over a 6 h window. */
export function EpgGridPage() {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const now = useNow(30_000);
  const wide = useMediaQuery('(min-width: 1024px)');
  const channelCol = wide ? 220 : 168;

  const sources = useRpcQuery('sources.list', undefined);
  const sourceId = params.get('source') ?? sources.data?.[0]?.id ?? '';
  const categoryId = params.get('category') ?? undefined;
  const source = sources.data?.find((s) => s.id === sourceId);
  const kind: SourceKind | undefined = source?.kind;
  const categories = useRpcQuery('catalog.categories', { sourceId, contentType: 'live' }, { enabled: !!sourceId });

  const [start, setStart] = useState(() => defaultStart(Date.now()));
  const end = start + GRID_WINDOW;
  const fromIso = new Date(start).toISOString();
  const toIso = new Date(end).toISOString();

  const paged = usePagedChannels({ sourceId, categoryId, withExtras: false });
  const count = paged.total ?? 0;

  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: t('guide'), subtitle: source?.name });
  }, [source?.name]);

  // ---- virtual rows + chunked grid data --------------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => GRID_ROW,
    overscan: 6,
    scrollPaddingStart: HEADER_H,
    initialRect: { width: 1200, height: 720 },
  });
  const vItems = virtualizer.getVirtualItems();
  const first = vItems[0]?.index ?? 0;
  const last = vItems[vItems.length - 1]?.index ?? 0;
  const { setVisibleRange } = paged;
  useEffect(() => setVisibleRange(first, last), [first, last, setVisibleRange]);

  const chunkA = Math.floor(first / GRID_CHUNK);
  const chunkB = Math.floor(last / GRID_CHUNK);
  const chunkRefs = (c: number) => {
    const refs = [];
    for (let i = c * GRID_CHUNK; i < Math.min(count, (c + 1) * GRID_CHUNK); i++) {
      const ch = paged.getChannel(i);
      if (ch) refs.push(ch.ref);
    }
    return refs;
  };
  const refsA = chunkRefs(chunkA);
  const refsB = chunkB !== chunkA ? chunkRefs(chunkB) : [];
  const gridA = useRpcQuery('epg.grid', { refs: refsA, from: fromIso, to: toIso }, { enabled: refsA.length > 0, staleTime: 5 * 60_000 });
  const gridB = useRpcQuery('epg.grid', { refs: refsB, from: fromIso, to: toIso }, { enabled: refsB.length > 0, staleTime: 5 * 60_000 });
  // Stalker: the portal's own guide for the visible rows, laid over the XMLTV grid.
  const isStalker = kind === 'stalker';
  const { getChannel } = paged;
  const visibleRefs = useMemo(() => {
    if (!isStalker) return [];
    const refs = [];
    for (let i = first; i <= last; i++) {
      const ch = getChannel(i);
      if (ch) refs.push(ch.ref);
    }
    return refs;
  }, [isStalker, first, last, getChannel]);
  const portalPrograms = useStalkerPreviews(sourceId, isStalker, visibleRefs, now, STALKER_GRID_LIMIT);
  const programsFor = useCallback(
    (ch: Channel | undefined): EpgProgram[] | undefined => {
      if (!ch) return undefined;
      const k: ItemKey = itemKey(ch.ref);
      const list = gridA.data?.[k] ?? gridB.data?.[k];
      const portal = isStalker ? portalPrograms(ch.ref) : undefined;
      if (portal && portal.length > 0) return mergePrograms(portal, list ?? []);
      if (list) return [...list].sort((a, b) => ms(a.start) - ms(b.start));
      return gridA.data || gridB.data ? [] : undefined;
    },
    [gridA.data, gridB.data, isStalker, portalPrograms],
  );
  const gridError = gridA.error ?? gridB.error;
  const noEpgAnywhere =
    !isStalker &&
    !!gridA.data && Object.values(gridA.data).every((l) => l.length === 0) && (!gridB.data || Object.values(gridB.data).every((l) => l.length === 0));

  // ---- navigation ---------------------------------------------------------
  const shift = useCallback((delta: number) => setStart((s) => s + delta), []);
  const toNow = useCallback(() => setStart(defaultStart(Date.now())), []);
  const setQuery = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'source') next.delete('category');
    setParams(next, { replace: true });
  };

  // ---- keyboard cursor ------------------------------------------------------
  const [cursor, setCursor] = useState<{ row: number; time: number }>({ row: 0, time: now });
  const focusPending = useRef(false);
  const cursorProgram = (row: number, time: number) => {
    const list = programsFor(paged.getChannel(row)) ?? [];
    const inWindow = list.filter((p) => ms(p.end) > start && ms(p.start) < end);
    const i = programIndexAt(inWindow, time);
    return i >= 0 ? inWindow[i] : undefined;
  };

  useEffect(() => {
    if (!focusPending.current) return;
    const root = scroller.current;
    if (!root) return;
    const p = cursorProgram(cursor.row, cursor.time);
    const sel = p ? `[data-cell-row="${cursor.row}"][data-start="${p.start}"]` : `[data-channel-row="${cursor.row}"]`;
    const el = root.querySelector<HTMLElement>(sel);
    if (el) {
      el.focus({ preventScroll: true });
      focusPending.current = false;
      const r = el.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      if (r.left < box.left + channelCol) root.scrollLeft -= box.left + channelCol - r.left + 8;
      else if (r.right > box.right) root.scrollLeft += Math.min(r.right - box.right + 8, r.left - box.left - channelCol);
    }
  });

  const [selection, setSelection] = useState<Selection | null>(null);
  const open = (channel: Channel, program: EpgProgram, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSelection({ channel, program, rect: { left: r.left, top: r.top, bottom: r.bottom } });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0 || selection) return;
    let { row, time } = cursor;
    const cur = cursorProgram(row, time);
    switch (e.key) {
      case 'ArrowDown':
        row = Math.min(count - 1, row + 1);
        break;
      case 'ArrowUp':
        row = Math.max(0, row - 1);
        break;
      case 'PageDown':
        row = Math.min(count - 1, row + 8);
        break;
      case 'PageUp':
        row = Math.max(0, row - 8);
        break;
      case 'ArrowRight': {
        const nextT = cur ? ms(cur.end) : time + GRID_SLOT_MIN * MINUTE;
        if (nextT >= end) shift(3 * HOUR);
        time = nextT;
        break;
      }
      case 'ArrowLeft': {
        const prevT = cur ? ms(cur.start) - 1 : time - GRID_SLOT_MIN * MINUTE;
        if (prevT < start) shift(-3 * HOUR);
        time = Math.max(prevT, start - 3 * HOUR);
        break;
      }
      case 'Home':
        toNow();
        time = Date.now();
        break;
      default:
        return;
    }
    e.preventDefault();
    focusPending.current = true;
    setCursor({ row, time });
    virtualizer.scrollToIndex(row, { align: 'auto' });
  };

  // When the window moves, keep the scroll at its left edge (or at now).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nowX = ((now - start) / MINUTE) * PX_PER_MIN;
    el.scrollLeft = now > start && now < end ? Math.max(0, nowX - GRID_SLOT_PX) : 0;
  }, [start]);

  // ---- actions --------------------------------------------------------------
  const playLive = (channel: Channel) => {
    if (!kind) return;
    playChannel(channel, kind).catch((err: unknown) =>
      toast({ title: t('playFailed', { name: channel.name }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
    );
  };
  const catchup = (channel: Channel, program: EpgProgram) => {
    if (!kind) return;
    playCatchup(channel, kind, program).catch((err: unknown) =>
      toast({ title: t('catchupFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
    );
  };

  // ---- render ---------------------------------------------------------------
  const slots = useMemo(() => {
    const out: number[] = [];
    for (let s = start; s < end; s += GRID_SLOT_MIN * MINUTE) out.push(s);
    return out;
  }, [start, end]);
  const trackWidth = (GRID_WINDOW / MINUTE) * PX_PER_MIN;
  const nowInWindow = now >= start && now < end;
  const nowX = ((now - start) / MINUTE) * PX_PER_MIN;

  // The shell header title is a <p>; the page owns its single h1 (same text as the header title).
  const heading = <h1 className="sr-only">{t('guide')}</h1>;
  if (sources.error) {
    return (
      <>
        {heading}
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      </>
    );
  }
  if (sources.data && sources.data.length === 0) {
    return (
      <>
      {heading}
      <EmptyState
        icon={<CalendarClock className="size-8" />}
        title={t('guideNoSources')}
        description={t('guideNoSourcesHint')}
        action={
          <Link to="/sources" className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">
            {t('openSources')}
          </Link>
        }
      />
      </>
    );
  }

  const selectClass =
    'h-8 max-w-48 min-w-0 rounded-md border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg" data-testid="epg-grid-page">
      {heading}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <select aria-label={t('guideSource')} className={selectClass} value={sourceId} onChange={(e) => setQuery('source', e.target.value)}>
          {(sources.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select aria-label={t('guideGroup')} className={selectClass} value={categoryId ?? ''} onChange={(e) => setQuery('category', e.target.value || undefined)}>
          <option value="">{t('allChannels')}</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('guideTime')}>
          <Button size="sm" variant="ghost" icon={<ChevronsLeft className="size-4" />} onClick={() => shift(-DAY)} aria-label={t('previousDay')} title={t('previousDay')} />
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => shift(-3 * HOUR)} aria-label={t('earlier')} title={t('earlier')} />
          <span className="min-w-36 px-1 text-center text-sm tabular-nums text-fg" aria-live="polite">
            {formatDay(start, i18n.language)} {formatClock(start, i18n.language)}–{formatClock(end, i18n.language)}
          </span>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => shift(3 * HOUR)} aria-label={t('later')} title={t('later')} />
          <Button size="sm" variant="ghost" icon={<ChevronsRight className="size-4" />} onClick={() => shift(DAY)} aria-label={t('nextDay')} title={t('nextDay')} />
          <Button size="sm" variant={nowInWindow ? 'ghost' : 'primary'} onClick={toNow}>
            {t('jumpToNow')}
          </Button>
        </div>
      </div>

      {gridError ? (
        <div role="alert" className="border-b border-border bg-surface-2 px-3 py-2 text-sm text-danger">
          {t('guideLoadFailed')}{' '}
          <button type="button" className="underline" onClick={() => void (gridA.error ? gridA.refetch() : gridB.refetch())}>
            {t('retry')}
          </button>
        </div>
      ) : noEpgAnywhere ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-sm text-fg-muted">
          {t('guideNoData')}
          <Link to="/settings/epg" className="text-accent hover:underline">
            {t('epgSettings')}
          </Link>
        </div>
      ) : null}

      {paged.error ? (
        <ErrorState error={paged.error} onRetry={paged.retry} />
      ) : paged.isLoading || !sourceId ? (
        <div className="flex flex-col gap-2 p-3" aria-busy="true" aria-label={t('loadingGuide')}>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex gap-2">
              <Skeleton className="h-12 w-40" />
              <Skeleton className="h-12 flex-1" />
            </div>
          ))}
        </div>
      ) : count === 0 ? (
        <EmptyState icon={<Tv className="size-8" />} title={t('noChannels')} description={t('noChannelsHint')} />
      ) : (
        <div
          ref={scroller}
          role="grid"
          aria-label={t('guide')}
          aria-rowcount={count + 1}
          onKeyDown={onGridKey}
          data-testid="epg-grid"
          className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
        >
          <div style={{ width: channelCol + trackWidth, height: virtualizer.getTotalSize() + HEADER_H, position: 'relative' }}>
            {/* time header */}
            <div role="row" className="sticky top-0 z-20 flex border-b border-border bg-surface" style={{ height: HEADER_H, width: channelCol + trackWidth }}>
              <div role="columnheader" className="sticky left-0 z-10 flex items-center border-r border-border bg-surface px-3 text-xs text-fg-subtle" style={{ width: channelCol }}>
                {t('channels')}
              </div>
              {slots.map((s) => (
                <div
                  role="columnheader"
                  key={s}
                  className="flex items-center border-l border-border/50 px-2 text-xs tabular-nums text-fg-muted"
                  style={{ width: GRID_SLOT_PX }}
                >
                  {new Date(s).getHours() === 0 && new Date(s).getMinutes() === 0 ? formatDay(s, i18n.language) : formatClock(s, i18n.language)}
                </div>
              ))}
            </div>

            {vItems.map((v) => {
              const ch = paged.getChannel(v.index);
              const programs = programsFor(ch);
              return (
                <div
                  key={v.key}
                  role="row"
                  aria-rowindex={v.index + 2}
                  className="absolute left-0 flex border-b border-border/60"
                  style={{ top: HEADER_H + v.start, height: GRID_ROW, width: channelCol + trackWidth }}
                >
                  <div role="rowheader" className="sticky left-0 z-10 border-r border-border bg-surface" style={{ width: channelCol }}>
                    {ch ? (
                      <button
                        type="button"
                        data-channel-row={v.index}
                        tabIndex={v.index === cursor.row && (!programs || programs.length === 0) ? 0 : -1}
                        onClick={() => playLive(ch)}
                        title={t('playChannel', { name: ch.name })}
                        className="flex h-full w-full items-center gap-2 px-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                      >
                        <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
                        <ChannelLogo src={ch.logoUrl} name={ch.name} size={30} />
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{ch.name}</span>
                        {ch.archive?.enabled ? <History className="size-3.5 shrink-0 text-fg-subtle" aria-label={t('archive')} /> : null}
                      </button>
                    ) : (
                      <div className="flex h-full items-center gap-2 px-2">
                        <Skeleton className="size-7" />
                        <Skeleton className="h-3 flex-1" />
                      </div>
                    )}
                  </div>
                  <div role="gridcell" className="relative" style={{ width: trackWidth }}>
                    {programs === undefined ? (
                      <div className="absolute inset-1.5 rounded bg-surface-2/60" aria-hidden />
                    ) : programs.length === 0 ? (
                      <div className="absolute inset-1.5 flex items-center rounded border border-dashed border-border px-3 text-xs text-fg-subtle">
                        {t('noGuideShort')}
                      </div>
                    ) : (
                      layoutBlocks(programs, start, end, PX_PER_MIN, now).map((b) => {
                        const isCursor = v.index === cursor.row && cursorProgram(cursor.row, cursor.time)?.start === b.program.start;
                        const catchupOk = ch ? canCatchUp(b.program, ch, kind, now) : false;
                        return (
                          <button
                            key={b.program.start}
                            type="button"
                            data-cell-row={v.index}
                            data-start={b.program.start}
                            tabIndex={isCursor ? 0 : -1}
                            aria-label={`${b.program.title}, ${formatRange(b.program, i18n.language)}${b.when === 'now' ? `, ${t('onNow')}` : ''}`}
                            onClick={(e) => {
                              setCursor({ row: v.index, time: ms(b.program.start) });
                              if (ch) open(ch, b.program, e.currentTarget);
                            }}
                            onFocus={() => setCursor((c) => (c.row === v.index && c.time >= ms(b.program.start) && c.time < ms(b.program.end) ? c : { row: v.index, time: Math.max(ms(b.program.start), start) }))}
                            className={`absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                              b.when === 'now'
                                ? 'border-accent/60 bg-accent/12 text-fg'
                                : b.when === 'past'
                                  ? 'border-border/60 bg-surface-2/60 text-fg-muted'
                                  : 'border-border bg-surface-2 text-fg hover:bg-surface-3'
                            }`}
                            style={{ left: b.left + 1, width: Math.max(2, b.width - 2) }}
                          >
                            <span className="flex items-center gap-1 truncate text-xs font-medium">
                              {b.when === 'past' && catchupOk ? <History className="size-3 shrink-0" aria-hidden /> : null}
                              <span className="truncate">{b.program.title}</span>
                            </span>
                            <span className={`block truncate text-[11px] tabular-nums ${b.when === 'future' ? 'text-fg-muted' : ''}`}>{formatRange(b.program, i18n.language)}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}

            {nowInWindow ? (
              <div
                aria-hidden
                className="pointer-events-none absolute z-10 w-0.5 bg-live"
                style={{ left: channelCol + nowX - 1, top: HEADER_H - 6, height: virtualizer.getTotalSize() + 6 }}
              >
                <span className="sticky top-[30px] -ml-[3px] block size-2 rounded-full bg-live" />
              </div>
            ) : null}
          </div>
        </div>
      )}

      {selection ? (
        <ProgramPopover
          selection={selection}
          kind={kind}
          now={now}
          onClose={() => {
            setSelection(null);
            focusPending.current = true;
            setCursor((c) => ({ ...c }));
          }}
          onLive={() => {
            playLive(selection.channel);
            setSelection(null);
          }}
          onCatchup={() => {
            catchup(selection.channel, selection.program);
            setSelection(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ProgramPopover({
  selection,
  kind,
  now,
  onClose,
  onLive,
  onCatchup,
}: {
  selection: Selection;
  kind?: SourceKind;
  now: number;
  onClose(): void;
  onLive(): void;
  onCatchup(): void;
}) {
  const { t, i18n } = useTranslation('live');
  const ref = useRef<HTMLDivElement>(null);
  const { program, channel, rect } = selection;
  const when = programWhen(program, now);
  const catchupOk = canCatchUp(program, channel, kind, now);
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 6 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - r.width - 8));
    const top = rect.bottom + 6 + r.height > window.innerHeight - 8 ? Math.max(8, rect.top - r.height - 6) : rect.bottom + 6;
    setPos({ left, top });
    el.querySelector<HTMLElement>('button')?.focus();
  }, [rect]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={program.title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 w-[min(360px,calc(100vw-16px))] rounded-lg border border-border bg-surface p-4 text-fg shadow-2"
      data-testid="program-popover"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg-muted">
            {channel.name} · <span className="tabular-nums">{formatRange(program, i18n.language)}</span>
          </p>
          <h3 className="mt-0.5 text-base font-semibold">{program.title}</h3>
          {program.category ? <p className="text-xs text-fg-subtle">{program.category}</p> : null}
        </div>
        <button type="button" aria-label={t('close')} onClick={onClose} className="rounded-md p-1 text-fg-muted hover:bg-surface-2">
          <X className="size-4" />
        </button>
      </div>
      {program.description ? <p className="mt-2 line-clamp-6 text-sm text-fg-muted">{program.description}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {when === 'now' ? (
          <Button size="sm" variant="primary" icon={<Radio className="size-3.5" />} onClick={onLive}>
            {t('watchLive')}
          </Button>
        ) : null}
        {catchupOk ? (
          <Button size="sm" variant={when === 'now' ? 'secondary' : 'primary'} icon={<History className="size-3.5" />} onClick={onCatchup}>
            {when === 'now' ? t('startOver') : t('watchCatchup')}
          </Button>
        ) : null}
        {when !== 'now' ? (
          <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} onClick={onLive}>
            {t('playChannel', { name: channel.name })}
          </Button>
        ) : null}
        {when === 'past' && !catchupOk ? <p className="w-full text-xs text-fg-subtle">{t('noCatchup')}</p> : null}
        {when === 'future' ? <p className="w-full text-xs text-fg-subtle">{t('startsAt', { time: formatClock(ms(program.start), i18n.language) })}</p> : null}
      </div>
    </div>
  );
}
