import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarClock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, History, Play, Radio, Tv, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { rpcKey, useRpcQuery } from '@/api/query';
import { rpc, rpcRaw } from '@/api/transport';
import { itemKey, type Channel, type EpgProgram, type GuideSearchHit, type ItemKey, type ItemRef, type SourceKind } from '@/api/types';

import { Button, buttonClass, cn, EmptyState, ErrorState, Select, Skeleton, useToast, type MenuAction, type SelectOption } from '@/ui';
import { joinList } from '@/shell/dashboard/cards';
import { useShell, useShortcut } from '@/shell';
// Run 2 C2/C3 and Run 1 C2/C4: the channel row menu, as on the Live page.
import { useChannelEditMenuItems } from '@/features/channeledit';
import { useAddToListMenuItem } from '@/features/lists';
import { channelInput } from '@/features/multiview/addChannel';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useNow } from '../hooks/useNow';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useStalkerPreviews } from '../hooks/useStalkerPreviews';
import { useShortEpgEnabled, useShortEpgPreviews } from '../hooks/useShortEpg';
import { displayChannelName } from '../lib/channelName';
import { mergePrograms } from '../lib/epgMerge';
import {
  HOUR,
  MAX_LOOKBACK_HOURS,
  MINUTE,
  addLocalDays,
  canCatchUp,
  floorLocal,
  formatClock,
  formatDay,
  formatRange,
  localDayKey,
  ms,
  parseWindowAt,
  programIndexAt,
  programWhen,
  shiftPrograms,
} from '../lib/epgTime';
import { archivePath, canBrowseArchive } from '../lib/archive';
import { playCatchup, playChannel } from '../lib/playback';
import { inlineStart, scrollLeftFor, scrollStart, timeStep, useIsRtl } from '../lib/rtl';
import { GuideUnavailableNotice } from './ChannelList';
import { ContextMenu, type MenuItem } from './ContextMenu';
// recording:
import { ProgramActions, usePrefetchSchedule, useScheduleIndex } from '@/features/recording';
// guide (Run 2 C5): jump to a date and time, guide search.
import { GuideSearch } from '../guide/GuideSearchPanel';
import { JumpToDialog } from '../guide/JumpToDialog';
import { findChannelIndex, groupForHit } from '../guide/search';
import { fitCellText, GRID_SHIFT_VAR, GuideRow, type GuideRowHandlers } from '../guide/GuideRow';
import { useStable } from '../guide/useStable';
import { prefetchProgramDescription, useProgramDescription } from '../guide/programDescription';

export const GRID_ROW = 56;
export const GRID_SLOT_MIN = 30;
export const GRID_SLOT_PX = 150;
export const GRID_WINDOW = 6 * HOUR;
export const GRID_CHUNK = 40;
const PX_PER_MIN = GRID_SLOT_PX / GRID_SLOT_MIN;
const HEADER_H = 36;
/** How long a window's guide answer counts as fresh (also for the windows prefetched beside it). */
const GRID_STALE_MS = 5 * 60_000;
/** Portal programmes per row: enough to fill the 6 h window from now. */
const STALKER_GRID_LIMIT = 12;

/**
 * `stalker.epg` arguments for the archive channels of a grid window: `from` (the window start)
 * while the window reaches into the archived past, and only the airing programme when the whole
 * window is over (the past comes from the day tables, not the short EPG `limit` caps).
 */
export function stalkerArchiveQuery(start: number, end: number, now: number, limit = STALKER_GRID_LIMIT): { from?: number; limit: number } {
  const inArchive = start < now && end > now - MAX_LOOKBACK_HOURS * HOUR;
  return { from: inArchive ? start : undefined, limit: end <= now ? 1 : limit };
}

/**
 * Grid window length for a page `width` px wide: whole 30-minute slots that fill the track
 * beside the channel column, never less than 6 h (wide screens get a longer window, not a gap).
 */
export function gridWindowFor(width: number, channelCol: number): number {
  const slots = Math.ceil(Math.max(0, width - channelCol) / GRID_SLOT_PX);
  return Math.max(GRID_WINDOW, slots * GRID_SLOT_MIN * MINUTE);
}

/** How far the window moves when a horizontal scroll (or a key) runs into its edge. */
export const GRID_EXTEND = 3 * HOUR;
/** Scrolling within this many px of the window's edge, toward it, moves the window on. */
export const GRID_EXTEND_EDGE_PX = GRID_SLOT_PX;
/**
 * Room the window keeps beyond the page width, so a scroll that moves the window by
 * {@link GRID_EXTEND} can hold the view still (the scroll position moves by the same px)
 * without landing in the other edge's zone, at any page width.
 */
export const GRID_SCROLL_ROOM_PX = (GRID_EXTEND / MINUTE) * PX_PER_MIN + 2 * GRID_EXTEND_EDGE_PX;

/**
 * Which way a horizontal scroll to `x` px from the inline start (moving `dx` px since the last
 * one) should move the window: +1 later, -1 earlier, 0 not at all. `max` is the farthest the
 * track scrolls.
 */
export function extendDirection(x: number, dx: number, max: number): 1 | -1 | 0 {
  if (max <= 0) return 0;
  if (dx > 0 && x >= max - GRID_EXTEND_EDGE_PX) return 1;
  if (dx < 0 && x <= GRID_EXTEND_EDGE_PX) return -1;
  return 0;
}

/** Channel column of a phone-width guide: the logo and number only, so the track gets the room. */
export const GRID_CHANNEL_COMPACT = 72;

/**
 * How far into the visible track (`view` px wide) the now line sits when the guide opens: one
 * slot of the past, but never more than a quarter of a narrow track (0: not measured yet).
 */
export function nowLead(view: number): number {
  return view > 0 ? Math.min(GRID_SLOT_PX, Math.round(view / 4)) : GRID_SLOT_PX;
}

/** Portal programmes per row for a window: 12 for 6 h, more for a longer window. */
export function stalkerGridLimit(windowMs: number): number {
  return Math.max(STALKER_GRID_LIMIT, Math.ceil((STALKER_GRID_LIMIT * windowMs) / GRID_WINDOW));
}

/** The guide page's width at its last measurement: a later visit lays out (and asks for its window) at that width from the first render. */
let lastGuideWidth = 0;

/**
 * Width of the element the callback ref is attached to, kept current by a ResizeObserver, and
 * whether it has been measured yet (seeded from the last guide visit's width).
 */
function useElementWidth(): [(el: HTMLElement | null) => void, number, boolean] {
  const [state, setState] = useState(() => ({ width: lastGuideWidth, measured: false }));
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const set = (width: number) => {
      if (width > 0) lastGuideWidth = width;
      setState((s) => (s.measured && s.width === width ? s : { width, measured: true }));
    };
    set(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) set(w);
    });
    observer.current.observe(el);
  }, []);
  return [ref, state.width, state.measured];
}

/** Below this page width the time controls take a row of their own and the window label stacks its day over its times. */
export const GUIDE_BAR_STACK_PX = 640;
/** Below this page width the day buttons give way; the window label's Jump dialog (and `t`) has every day. */
export const GUIDE_BAR_DAYS_PX = 440;

/**
 * The toolbar's layout for a page `width` px wide (0 before the first measurement): `full` keeps
 * everything on the toolbar's rows as space allows; `stacked` gives the time controls a full row
 * of their own; `phone` also drops the day buttons, so Now and the times fit beside the chevrons.
 */
export function guideBarLayout(width: number): 'full' | 'stacked' | 'phone' {
  if (!(width > 0) || width >= GUIDE_BAR_STACK_PX) return 'full';
  return width >= GUIDE_BAR_DAYS_PX ? 'stacked' : 'phone';
}

/** Half an hour before the current local :00/:30 slot (local, so +5:45 zones get :00/:30 columns too). */
export function defaultStart(now: number): number {
  return floorLocal(now, GRID_SLOT_MIN) - GRID_SLOT_MIN * MINUTE;
}

/** Column labels: the day where the local date changes (midnight, or the first slot after a DST jump over it), else the time. */
export function slotLabels(slots: readonly number[], locale: string): string[] {
  return slots.map((s, i) => (i > 0 && localDayKey(s) !== localDayKey(slots[i - 1]!) ? formatDay(s, locale) : formatClock(s, locale)));
}

interface Selection {
  channel: Channel;
  program: EpgProgram;
  /** The programme cell that opened the popover; the popover follows it while the grid scrolls. */
  anchor: HTMLElement;
}

/** How long a channel row stays highlighted after a guide search hit moved the grid to it. */
export const HIGHLIGHT_MS = 3000;

/** A search hit the grid is moving to: its channel's row is looked up once the list is loaded. */
interface Reveal {
  key: ItemKey;
  /** Display time of the hit's start; the keyboard cursor lands on it. */
  time: number;
  channelName: string;
  /** The group the list must show before the lookup (undefined: all channels). */
  categoryId: string | undefined;
}

/**
 * How long key and scroll moves of the window must pause before the URL follows them
 * (L2-perf-ui-4): the window moves at once in the page's state, the router hears of it once.
 */
export const GRID_URL_SETTLE_MS = 400;
/**
 * Guide chunks are fetched once the visible chunk holds still this long (L2-perf-desktop-6): a
 * fling past twenty chunks asks for the one it stops on, not every chunk on the way. A chunk
 * that is already cached, or the first change after a pause, shows at once.
 */
export const GRID_CHUNK_SETTLE_MS = 120;
/**
 * No scroll event for this long and the scroll has stopped: the chunks it stopped on are fetched
 * then, not GRID_CHUNK_SETTLE_MS after the last chunk change (L3-live-guide-x1). A fling sends an
 * event every frame or wheel step, well inside this.
 */
export const GRID_SCROLL_IDLE_MS = 50;
/**
 * Slower than this (px/ms) a chunk stays on screen at least twice GRID_CHUNK_SETTLE_MS, so the
 * chunk a slowing scroll reaches is fetched at once (L3-live-guide-x1).
 */
export const GRID_SLOW_PX_PER_MS = (GRID_CHUNK * GRID_ROW) / (2 * GRID_CHUNK_SETTLE_MS);

/**
 * How much longer a chunk change waits before its chunks are fetched (L3-live-guide-x1). None for
 * the first change after a pause (`quiet`) or a scroll slower than GRID_SLOW_PX_PER_MS; otherwise
 * until the scroll has been idle GRID_SCROLL_IDLE_MS or the chunk has held GRID_CHUNK_SETTLE_MS,
 * whichever comes first.
 */
export function chunkSettleWait(quiet: boolean, pxPerMs: number, idleMs: number, heldMs: number): number {
  if (quiet || pxPerMs < GRID_SLOW_PX_PER_MS) return 0;
  return Math.max(0, Math.min(GRID_SCROLL_IDLE_MS - idleMs, GRID_CHUNK_SETTLE_MS - heldMs));
}

export interface ChunkPair {
  a: number;
  b: number;
}

/**
 * The chunks the two grid queries ask for. Each slot shows its visible chunk at once when that
 * chunk is cached, whatever the other's state (L3-live-guide-x1); one that is not keeps the
 * settled chunk until the settle, so a fling does not ask for every chunk it passes.
 */
export function shownChunks(view: ChunkPair, settled: ChunkPair, all: boolean, cached: (chunk: number) => boolean): ChunkPair {
  return {
    a: all || cached(view.a) ? view.a : settled.a,
    b: all || cached(view.b) ? view.b : settled.b,
  };
}
/** Rows of programme lists kept per channel before the cache starts over. */
const PROGRAMS_CACHE_MAX = 2000;
const NO_PROGRAMS: EpgProgram[] = [];

/**
 * How far past now the provider's short guide reaches: it holds the airing programme and the next
 * few (SHORT_EPG_LIMIT), so a window that starts later than this cannot be filled by it
 * (L3-guide-library-4).
 */
export const SHORT_EPG_REACH_MS = 6 * HOUR;
/**
 * The short-guide fallback asks for the visible rows once they hold still this long, so key
 * repeat or a fling asks for the rows it stops on, not every row it passes (L3-perf-ui-5).
 */
export const SHORT_EPG_SETTLE_MS = 200;

/** True when the Xtream short guide can fill anything in the window `[start, end)` at `now`. */
export function shortEpgReaches(start: number, end: number, now: number): boolean {
  return end > now && start < now + SHORT_EPG_REACH_MS;
}

/**
 * The args of every grid query and prefetch, so their keys match. The cells never show a
 * description, so the grid goes without (about half of every answer, L3-serve-ui-6); the
 * selected programme's detail asks epg.programs for it.
 */
export function gridArgs(refs: ItemRef[], from: string, to: string) {
  return { refs, from, to, withDescription: false };
}

/** A window `[from, to)` an answer of the grid is for. */
type Span = readonly [number, number];

/** Multi-channel guide: virtualized channel rows x 30-minute columns over a window of at least 6 h that fills the page width. */
export function EpgGridPage() {
  const { t, i18n } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const now = useNow(30_000);
  const prefs = useDisplayPrefs();
  const wide = useMediaQuery('(min-width: 1024px)');
  // Phones: a logo-and-number column, so the track shows more than one slot beside it.
  const compact = !useMediaQuery(`(min-width: ${GUIDE_BAR_STACK_PX}px)`);
  const channelCol = compact ? GRID_CHANNEL_COMPACT : wide ? 220 : 168;
  const rtl = useIsRtl();
  const queryClient = useQueryClient();
  // Reminders, recordings, rules and recording support load with the page (L2-guide-library-15).
  const schedule = useScheduleIndex();
  usePrefetchSchedule();

  const sources = useRpcQuery('sources.list', undefined);
  const sourceId = params.get('source') ?? sources.data?.[0]?.id ?? '';
  const categoryId = params.get('category') ?? undefined;
  const source = sources.data?.find((s) => s.id === sourceId);
  const kind: SourceKind | undefined = source?.kind;
  const categories = useRpcQuery('catalog.categories', { sourceId, contentType: 'live' }, { enabled: !!sourceId });

  // ---- the window ----------------------------------------------------------
  // The window start comes from the URL (`at`, epoch ms on a 30-minute slot), so back and forward
  // restore it, and lives in state, so every move shows at once. Clicks push a history entry; a
  // key or scroll that runs into the window's edge moves the state alone, and the URL follows once
  // those moves pause (L2-perf-ui-4, L2-guide-library-5: a router navigation per move re-rendered
  // the shell and, while it was pending, dropped scroll distance). Without `at` the window
  // follows "now" as it was when the page opened or Jump to now was last pressed.
  const atParam = parseWindowAt(params.get('at'));
  const [winAt, setWinAt] = useState(atParam);
  // `seen`: the URL's `at` this page last rendered; `wrote`: the one it last wrote (or adopted).
  // A URL change that is not the echo of a write (back, forward, a link) moves the window.
  const [url, setUrl] = useState({ seen: atParam, wrote: atParam });
  if (atParam !== url.seen) {
    const external = atParam !== url.wrote;
    setUrl({ seen: atParam, wrote: external ? atParam : url.wrote });
    if (external) setWinAt(atParam);
  }
  const [nowStart, setNowStart] = useState(() => defaultStart(Date.now()));
  const start = winAt ?? nowStart;
  const [measurePage, pageWidth, pageMeasured] = useElementWidth();
  // Measured pages get room to scroll past the page width, so horizontal scrolling can move the window on.
  const windowMs = gridWindowFor(pageWidth > 0 ? pageWidth + GRID_SCROLL_ROOM_PX : 0, channelCol);
  const end = start + windowMs;
  // Rows lay their cells out from this fixed time; the window's offset from it is one CSS
  // variable on the grid, so a window move leaves every row's props alone (L3-perf-ui-4).
  const [origin] = useState(start);
  const gridShift = ((origin - start) / MINUTE) * PX_PER_MIN;
  const shiftPx = useRef(gridShift);
  shiftPx.current = gridShift;
  // The window the guide is asked for follows the one on screen at a lower priority: a move at
  // the edge of a sideways scroll renders the header, the now line and the scroll at once, and the
  // rows' new programmes in a background render that a scroll event can interrupt (L3-perf-ui-4).
  const dataStart = useDeferredValue(start);
  const dataEnd = useDeferredValue(end);

  const paged = usePagedChannels({ sourceId, categoryId, withExtras: false });
  const count = paged.total ?? 0;

  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: t('guide'), subtitle: source?.name });
  }, [source?.name, i18n.language]);

  // ---- virtual rows + chunked grid data --------------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => GRID_ROW,
    overscan: 6,
    scrollPaddingStart: HEADER_H,
    initialRect: { width: 1200, height: 720 },
    // A scroll tick re-renders through React's normal batching, not a synchronous render inside
    // the scroll event (L3-perf-desktop-4; VirtualGrid does the same).
    useFlushSync: false,
  });
  const vItems = virtualizer.getVirtualItems();
  const first = vItems[0]?.index ?? 0;
  const last = vItems[vItems.length - 1]?.index ?? 0;
  const { setVisibleRange } = paged;
  useEffect(() => setVisibleRange(first, last), [first, last, setVisibleRange]);

  // `[start, end)` is display time. Programmes are shown `epgOffsetMinutes` later than the guide
  // says, so the guide is asked for the window moved back by the offset, then shifted for display.
  const offsetMs = prefs.epgOffsetMinutes * MINUTE;
  const fromIso = new Date(dataStart - offsetMs).toISOString();
  const toIso = new Date(dataEnd - offsetMs).toISOString();

  const chunkRefs = (c: number) => {
    const refs = [];
    for (let i = c * GRID_CHUNK; i < Math.min(count, (c + 1) * GRID_CHUNK); i++) {
      const ch = paged.getChannel(i);
      if (ch) refs.push(ch.ref);
    }
    return refs;
  };
  const chunkCached = (c: number) => {
    const refs = chunkRefs(c);
    return refs.length > 0 && queryClient.getQueryData(rpcKey('epg.grid', gridArgs(refs, fromIso, toIso))) !== undefined;
  };
  // The chunks on screen, and the ones asked for: those follow once the visible chunk settles.
  const viewA = Math.floor(first / GRID_CHUNK);
  const viewB = Math.floor(last / GRID_CHUNK);
  const listKey = `${sourceId}|${categoryId ?? ''}`;
  const [settled, setSettled] = useState({ key: listKey, a: viewA, b: viewB });
  const atRest = settled.key === listKey && settled.a === viewA && settled.b === viewB;
  const { a: chunkA, b: chunkB } = shownChunks({ a: viewA, b: viewB }, settled, atRest || settled.key !== listKey, chunkCached);
  const lastChunkMove = useRef(0);
  /** The last vertical scroll event: when, where, and how fast (px/ms) since the one before. */
  const vScroll = useRef({ t: Number.NEGATIVE_INFINITY, y: 0, v: Number.POSITIVE_INFINITY });
  useEffect(() => {
    if (atRest) return;
    const t0 = performance.now();
    const quiet = t0 - lastChunkMove.current > GRID_CHUNK_SETTLE_MS;
    lastChunkMove.current = t0;
    let id = 0;
    const check = () => {
      const t = performance.now();
      const wait = chunkSettleWait(quiet, vScroll.current.v, t - vScroll.current.t, t - t0);
      if (wait > 0) id = window.setTimeout(check, wait);
      else setSettled({ key: listKey, a: viewA, b: viewB });
    };
    check();
    return () => window.clearTimeout(id);
  }, [listKey, viewA, viewB, atRest]);

  const refsA = chunkRefs(chunkA);
  const refsB = chunkB !== chunkA ? chunkRefs(chunkB) : [];
  // The previous answer stays while the next chunk or window loads (keepPrevious): rows it
  // covers keep their programmes and the no-guide notice does not blink. Rows it does not
  // cover show as loading (see `programsFor`). Nothing is asked before the page is measured: the
  // first measurement sets the window's length (L2-perf-desktop-12).
  const gridA = useRpcQuery('epg.grid', gridArgs(refsA, fromIso, toIso), { enabled: pageMeasured && refsA.length > 0, staleTime: GRID_STALE_MS, keepPrevious: true });
  const gridB = useRpcQuery('epg.grid', gridArgs(refsB, fromIso, toIso), { enabled: pageMeasured && refsB.length > 0, staleTime: GRID_STALE_MS, keepPrevious: true });
  const keysA = new Set(refsA.map(itemKey));
  const keysB = new Set(refsB.map(itemKey));

  // At rest, the chunks above and below are fetched ahead, so the next rows arrive drawn.
  const prefetchChunk = useStable((c: number) => {
    if (c < 0 || c * GRID_CHUNK >= count) return;
    const refs = chunkRefs(c);
    // A chunk whose channels are not all loaded yet would be asked again once they are.
    if (refs.length < Math.min(GRID_CHUNK, count - c * GRID_CHUNK)) return;
    const args = gridArgs(refs, fromIso, toIso);
    void queryClient.prefetchQuery({ queryKey: rpcKey('epg.grid', args), queryFn: () => rpcRaw('epg.grid', args), staleTime: GRID_STALE_MS });
  });
  const gridsLoaded = !!gridA.data && !gridA.isPlaceholderData && (refsB.length === 0 || (!!gridB.data && !gridB.isPlaceholderData));
  useEffect(() => {
    if (!atRest || !gridsLoaded) return;
    const id = window.setTimeout(() => {
      prefetchChunk(chunkB + 1);
      prefetchChunk(chunkA - 1);
    }, GRID_CHUNK_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [atRest, gridsLoaded, chunkA, chunkB, fromIso, toIso, prefetchChunk]);

  // Stalker: the portal's own guide for the visible rows, laid over the XMLTV grid. Archive
  // channels also get the archived past of the window (`from`), so earlier rows and catch-up
  // work without XMLTV; the others keep the plain airing-onwards answer.
  const isStalker = kind === 'stalker';
  const { getChannel } = paged;
  const [plainRefs, archiveRefs] = useMemo(() => {
    const plain: ItemRef[] = [];
    const archive: ItemRef[] = [];
    if (!isStalker) return [plain, archive];
    for (let i = first; i <= last; i++) {
      const ch = getChannel(i);
      if (ch) (ch.archive?.enabled ? archive : plain).push(ch.ref);
    }
    return [plain, archive];
  }, [isStalker, first, last, getChannel]);
  const portalLimit = stalkerGridLimit(windowMs);
  const archiveQuery = stalkerArchiveQuery(dataStart - offsetMs, dataEnd - offsetMs, now, portalLimit);
  const plainPortal = useStalkerPreviews(sourceId, isStalker, plainRefs, now, portalLimit);
  const archivePortal = useStalkerPreviews(sourceId, isStalker, archiveRefs, now, archiveQuery.limit, archiveQuery.from);
  // guide: Xtream short-EPG fallback for visible rows the XMLTV guide leaves empty, while the
  // window reaches now or the next few hours (the provider's short guide starts at the airing
  // programme and holds a handful after it: a window days ahead asks nothing, L3-guide-library-4).
  const shortEpgOn = useShortEpgEnabled(kind) && shortEpgReaches(dataStart, dataEnd, now);

  // The window each grid answer is for: its own once it has one, else (a placeholder standing in
  // while the next one loads) the last one this page showed.
  const spanA = useRef<Span | null>(null);
  const spanB = useRef<Span | null>(null);
  const spanOf = (q: typeof gridA, seen: { current: Span | null }): Span | null => {
    if (!q.data) return null;
    if (!q.isPlaceholderData && (seen.current?.[0] !== dataStart || seen.current[1] !== dataEnd)) seen.current = [dataStart, dataEnd];
    return seen.current;
  };
  const answers = [
    { q: gridA, keys: keysA, span: spanOf(gridA, spanA) },
    { q: gridB, keys: keysB, span: spanOf(gridB, spanB) },
  ] as const;
  /**
   * A row's XMLTV programmes, and whether they are the answer for the window on screen (`fresh`).
   * While that answer loads, the row keeps what an answer for an overlapping window said (the
   * window before a move, or the placeholder standing in): the same arrays, so a memoised row
   * holds still through a window move. undefined while loading, [] when the guide has none.
   */
  const gridEntry = (k: ItemKey): { list: EpgProgram[] | undefined; fresh: boolean } => {
    for (const { q, keys, span } of answers) {
      if (!q.data || !span || !(span[0] < end && span[1] > start)) continue;
      const list = q.data[k];
      const own = !q.isPlaceholderData;
      if (own && span[0] === start && span[1] === end && (list || keys.has(k))) return { list: list ?? NO_PROGRAMS, fresh: true };
      if (list) return { list, fresh: false };
      // An answer for these channels (not a placeholder for others) that had nothing for the row.
      if (own && keys.has(k)) return { list: NO_PROGRAMS, fresh: false };
    }
    return { list: undefined, fresh: false };
  };
  const gridList = (k: ItemKey): EpgProgram[] | undefined => gridEntry(k).list;
  // The rows the short guide is asked for follow the visible rows once they hold still.
  const [shortRows, setShortRows] = useState({ first, last });
  useEffect(() => {
    if (shortRows.first === first && shortRows.last === last) return;
    const id = window.setTimeout(() => setShortRows({ first, last }), SHORT_EPG_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [first, last, shortRows]);
  const shortRefs = useMemo(() => {
    const out: ItemRef[] = [];
    if (!shortEpgOn) return out;
    for (let i = shortRows.first; i <= shortRows.last; i++) {
      const ch = getChannel(i);
      if (!ch) continue;
      const list = gridList(itemKey(ch.ref));
      if (list && list.length === 0) out.push(ch.ref);
    }
    return out;
    // gridList reads gridA/gridB, listed by their answers, and the window.
  }, [shortEpgOn, shortRows, getChannel, gridA.data, gridB.data, gridA.isPlaceholderData, gridB.isPlaceholderData, start, end]); // eslint-disable-line react-hooks/exhaustive-deps
  const shortFor = useShortEpgPreviews(sourceId, shortEpgOn, shortRefs, now);
  const hasShortData = shortRefs.some((r) => (shortFor(r)?.length ?? 0) > 0);
  // Each row's display list is kept while its sources are the same objects, so a memoised row
  // sees the same array from render to render (L2-perf-ui-1).
  const programsCache = useRef(new Map<ItemKey, { list?: EpgProgram[]; portal?: EpgProgram[]; short?: readonly EpgProgram[]; offset: number; out: EpgProgram[] | undefined }>());
  const programsFor = (ch: Channel | undefined): EpgProgram[] | undefined => {
    if (!ch) return undefined;
    const k = itemKey(ch.ref);
    const list = gridList(k);
    const portal = isStalker ? (ch.archive?.enabled ? archivePortal : plainPortal).get(ch.ref) : undefined;
    // guide: an empty XMLTV row takes the provider's short guide.
    const short = !(portal && portal.length > 0) && shortEpgOn && list?.length === 0 ? shortFor(ch.ref) : undefined;
    const offset = prefs.epgOffsetMinutes;
    const cache = programsCache.current;
    const hit = cache.get(k);
    if (hit && hit.list === list && hit.portal === portal && hit.short === short && hit.offset === offset) return hit.out;
    let out: EpgProgram[] | undefined;
    if (portal && portal.length > 0) out = shiftPrograms(mergePrograms(portal, list ?? []), offset);
    else if (short && short.length > 0) out = shiftPrograms([...short], offset);
    else if (list) out = list.length === 0 ? NO_PROGRAMS : shiftPrograms([...list].sort((a, b) => ms(a.start) - ms(b.start)), offset);
    if (cache.size >= PROGRAMS_CACHE_MAX) cache.clear();
    cache.set(k, { list, portal, short, offset, out });
    return out;
  };
  const gridError = gridA.error ?? gridB.error;
  const noEpgAnywhere =
    !isStalker &&
    !hasShortData && // guide
    !!gridA.data && Object.values(gridA.data).every((l) => l.length === 0) && (!gridB.data || Object.values(gridB.data).every((l) => l.length === 0));

  // ---- navigation ---------------------------------------------------------
  // Clicks and key repeat can outrun renders: each move starts from here, not from a stale render.
  const startRef = useRef(start);
  startRef.current = start;
  /** The URL the next write starts from: the router's, or the last one written ahead of it. */
  const latestParams = useRef(params);
  const seenParams = useRef(params);
  if (seenParams.current !== params) {
    seenParams.current = params;
    latestParams.current = params;
  }
  const urlTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(urlTimer.current), []);
  /** Writes the URL (a new history entry, or `replace`); `at` is the window start it now holds. */
  const writeUrl = (edit: (p: URLSearchParams) => void, at: number | null, replace: boolean) => {
    window.clearTimeout(urlTimer.current);
    const next = new URLSearchParams(latestParams.current);
    edit(next);
    if (at === null) next.delete('at');
    else next.set('at', String(at));
    latestParams.current = next;
    setUrl((u) => (u.wrote === at ? u : { ...u, wrote: at }));
    setParams(next, { replace });
  };
  /** Moves the window to `at` (floored to its slot), with a new history entry. */
  const goTo = useStable((at: number, opts: { category?: null } = {}) => {
    const slot = floorLocal(at, GRID_SLOT_MIN);
    startRef.current = slot;
    setWinAt(slot);
    writeUrl((p) => {
      if (opts.category === null) p.delete('category');
    }, slot, false);
  });
  const keepView = useRef(false);
  /**
   * A key or scroll ran into the window's edge: the window moves by `delta` at once and the view
   * stays put (keepView); the URL follows once such moves pause.
   */
  const drift = (delta: number) => {
    const slot = floorLocal(startRef.current + delta, GRID_SLOT_MIN);
    startRef.current = slot;
    keepView.current = true;
    setWinAt(slot);
    window.clearTimeout(urlTimer.current);
    // Back, forward or a link in the meantime wins: the URL is then no longer the one this move left.
    const base = latestParams.current.toString();
    urlTimer.current = window.setTimeout(() => {
      if (latestParams.current.toString() === base) writeUrl(() => undefined, slot, true);
    }, GRID_URL_SETTLE_MS);
  };
  const shift = useStable((delta: number) => goTo(startRef.current + delta));
  // A calendar day, not 24 h: across a DST change the window keeps its wall-clock time.
  const shiftDay = useStable((days: number) => goTo(addLocalDays(startRef.current, days)));
  const toNow = useStable(() => {
    const s = defaultStart(Date.now());
    setNowStart(s);
    startRef.current = s;
    setWinAt(null);
    window.clearTimeout(urlTimer.current);
    if (latestParams.current.has('at')) writeUrl(() => undefined, null, false);
  });
  // Back to an entry without `at` (or a link without it): the window follows now again.
  const followsNow = winAt === null;
  useEffect(() => {
    if (followsNow) setNowStart(defaultStart(Date.now()));
  }, [followsNow]);
  const setQuery = useStable((key: string, value: string | undefined) => {
    writeUrl(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        if (key === 'source') p.delete('category');
      },
      winAt === null ? null : startRef.current,
      true,
    );
  });

  // ---- keyboard cursor ------------------------------------------------------
  const [cursor, setCursor] = useState<{ row: number; time: number }>({ row: 0, time: now });
  const focusPending = useRef(false);
  const windowPrograms = (row: number) => (programsFor(paged.getChannel(row)) ?? []).filter((p) => ms(p.end) > start && ms(p.start) < end);
  const cursorProgram = (row: number, time: number) => {
    const inWindow = windowPrograms(row);
    const i = programIndexAt(inWindow, time);
    return i >= 0 ? inWindow[i] : undefined;
  };
  /**
   * True once the row's guide answer for the window on screen is in. Until then the row shows the
   * previous window's programmes (or none), and a cell picked from those would be the wrong one:
   * the cell the cursor just left, or the channel cell (L3-guide-library-1, L3-guide-library-3).
   */
  const rowReady = (row: number) => {
    const ch = paged.getChannel(row);
    // A guide that failed is not coming: the row is as ready as it gets (its channel cell takes the cursor).
    return !!ch && dataStart === start && dataEnd === end && (gridEntry(itemKey(ch.ref)).fresh || !!gridError);
  };

  // Key repeat can outrun renders: keys read the cursor from here, not from a stale render.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** The element in the grid that last had focus, to notice when a re-render removes it. */
  const lastFocused = useRef<HTMLElement | null>(null);
  /** The cell the cursor is on; null while its row's guide for this window is still loading. */
  const cursorElement = (row: number, time: number) => {
    if (!rowReady(row)) return null;
    const p = cursorProgram(row, time);
    const sel = p ? `[data-cell-row="${row}"][data-start="${p.start}"]` : `[data-channel-row="${row}"]`;
    return scroller.current?.querySelector<HTMLElement>(sel) ?? null;
  };

  // When the window moves (or the grid first mounts after loading), put the scroll at the track's
  // inline-start edge, or just before now. A move that keeps the view (a scroll or a key that ran
  // into the window's edge) moves the scroll by the same px instead, so the screen stays put.
  // RTL scrollers count scrollLeft down from 0. Declared before the focus effect, which then only
  // has to bring the cursor cell into view.
  const gridMounted = !paged.error && !paged.isLoading && !!sourceId && count > 0;
  const laidStart = useRef(start);
  /** The scroll's distance from the inline start, at the last scroll event or scroll write. */
  const scrollX = useRef(0);
  /** The scroller's clientWidth at the last scroll event or scroll write (read with the scroll, never after a write). */
  const viewWidth = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const moved = start - laidStart.current;
    laidStart.current = start;
    if (keepView.current) {
      keepView.current = false;
      el.scrollLeft = scrollLeftFor(Math.max(0, scrollStart(el) - (moved / MINUTE) * PX_PER_MIN), rtl);
    } else {
      const nowX = ((now - start) / MINUTE) * PX_PER_MIN;
      el.scrollLeft = scrollLeftFor(now > start && now < end ? Math.max(0, nowX - nowLead(el.clientWidth - channelCol)) : 0, rtl);
    }
    scrollX.current = scrollStart(el);
    viewWidth.current = el.clientWidth;
    fitCellText(el, scrollX.current, shiftPx.current); // before first paint: cells already clipped by the edge fit their text
  }, [start, rtl, gridMounted]);

  /** Scrolls the track so that `x` px from its inline start is at the visible start. */
  const scrollTrackTo = (root: HTMLElement, x: number) => {
    root.scrollLeft = scrollLeftFor(Math.max(0, x), rtl);
    scrollX.current = Math.max(0, x);
    fitCellText(root, scrollX.current, shiftPx.current);
  };

  // Focus never sits on a cell that is about to unmount: while the cursor's row is off screen or
  // still loading, the grid itself holds focus (and takes the keys); the cell gets it once rendered.
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const focused = document.activeElement;
    if (lastFocused.current && !lastFocused.current.isConnected && (focused === document.body || focused === null)) {
      lastFocused.current = null;
      focusPending.current = true;
      root.focus({ preventScroll: true });
    }
    if (!focusPending.current) return;
    if (!root.contains(document.activeElement)) {
      focusPending.current = false; // focus went elsewhere meanwhile: leave it there
      return;
    }
    // The window a move asked for is not on screen yet: its cell does not exist, and a cell of
    // the old window would take focus by mistake. Stay pending until it renders, and until the
    // row's guide for it is in (cursorElement is null until then): the grid holds focus meanwhile,
    // not the cell the cursor left (L3-guide-library-1).
    const el = startRef.current === start ? cursorElement(cursor.row, cursor.time) : null;
    if (!el) {
      if (document.activeElement !== root) root.focus({ preventScroll: true });
      return;
    }
    el.focus({ preventScroll: true });
    focusPending.current = false;
    // Bring the cell into the visible track, worked out from its times rather than measured
    // (L2-guide-library-3): the sticky channel column covers the track's inline start.
    const p = cursorProgram(cursor.row, cursor.time);
    if (!p) return;
    const left = ((Math.max(ms(p.start), start) - start) / MINUTE) * PX_PER_MIN;
    const right = ((Math.min(ms(p.end), end) - start) / MINUTE) * PX_PER_MIN;
    const x = scrollX.current;
    const view = (viewWidth.current || root.clientWidth) - channelCol;
    if (left < x) scrollTrackTo(root, left - 8);
    else if (right > x + view) scrollTrackTo(root, x + Math.min(right - x - view + 8, left - x));
  });

  const [selection, setSelection] = useState<Selection | null>(null);
  /** The cell that opened the popover; focus returns to it when the popover closes. */
  const invoker = useRef<HTMLElement | null>(null);
  const closePopover = () => {
    setSelection(null);
    const el = invoker.current;
    invoker.current = null;
    if (el?.isConnected) {
      el.focus({ preventScroll: true });
    } else {
      // The cell left the virtual window: the grid holds focus until the cursor cell renders.
      scroller.current?.focus({ preventScroll: true });
      focusPending.current = true;
      setCursor((c) => ({ ...c }));
    }
  };

  // ---- channel row menu (C2: rename and hide from the guide, plus the Live page's other entries) ----
  const [rowMenu, setRowMenu] = useState<{ pos: { x: number; y: number }; channel: Channel } | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  /** The keyboard's way in: the menu of the cursor row's channel, anchored at its channel cell. */
  const openRowMenuAt = (row: number) => {
    const ch = paged.getChannel(row);
    const cell = scroller.current?.querySelector<HTMLElement>(`[data-channel-row="${row}"]`);
    if (!ch || !cell) return;
    const r = cell.getBoundingClientRect();
    // Near the cell's inline start, which is its right edge in RTL.
    setRowMenu({ pos: { x: rtl ? r.right - 48 : r.left + 48, y: r.bottom - 8 }, channel: ch });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0 || selection) return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      openRowMenuAt(cursorRef.current.row);
      return;
    }
    let { row, time } = cursorRef.current;
    const cur = cursorProgram(row, time);
    // Arrow keys follow the screen, so in RTL ArrowLeft moves later in time.
    const step = timeStep(e.key, rtl);
    const key = step > 0 ? 'later' : step < 0 ? 'earlier' : e.key;
    // The row's guide for this window is still loading and nothing shown holds the cursor's time
    // (it just crossed the window's edge): which programme comes next is not known yet, and a
    // guess would skip one. The press waits for the answer instead (L3-guide-library-1). A guide
    // that failed answers nothing: the keys then step by slot as before.
    if (step !== 0 && !gridError && !rowReady(row) && !(cur && ms(cur.start) <= time && time < ms(cur.end)) && paged.getChannel(row)) {
      e.preventDefault();
      return;
    }
    switch (key) {
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
      // Past the window's edge the window moves on and the view stays put; the focus effect then
      // brings the cell into view.
      case 'later': {
        const nextT = cur ? ms(cur.end) : time + GRID_SLOT_MIN * MINUTE;
        if (nextT >= startRef.current + windowMs) drift(GRID_EXTEND);
        time = nextT;
        break;
      }
      case 'earlier': {
        const prevT = cur ? ms(cur.start) - 1 : time - GRID_SLOT_MIN * MINUTE;
        const from = startRef.current;
        if (prevT < from) drift(-GRID_EXTEND);
        time = Math.max(prevT, from - GRID_EXTEND);
        break;
      }
      case 'Home':
        // Home: back to now on this row; Ctrl+Home also goes to the first channel.
        if (e.ctrlKey || e.metaKey) row = 0;
        toNow();
        time = Date.now();
        break;
      case 'End': {
        // End: the last programme of this row in the window; Ctrl+End also goes to the last channel.
        if (e.ctrlKey || e.metaKey) row = count - 1;
        const last = windowPrograms(row).at(-1);
        time = last ? Math.max(ms(last.start), start) : end - 1;
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    cursorRef.current = { row, time };
    focusPending.current = true;
    virtualizer.scrollToIndex(row, { align: 'auto' });
    // A row that isn't rendered yet (or still loading) has no cell to take focus: the grid holds it.
    if (!cursorElement(row, time)) scroller.current?.focus({ preventScroll: true });
    setCursor({ row, time });
    // Within a programme of the window's edge, the window past it is fetched now, so the press
    // that crosses the edge finds it drawn (L3-guide-library-1).
    const shown = windowPrograms(row);
    const at = programIndexAt(shown, time);
    if (at >= 0 && at >= shown.length - 2 && ms(shown.at(-1)!.end) >= startRef.current + windowMs) prefetchWindow(GRID_EXTEND);
    if (at >= 0 && at <= 1 && ms(shown[0]!.start) <= startRef.current) prefetchWindow(-GRID_EXTEND);
  };

  /** Fetches the visible chunks' guide for the window `delta` from this one, before a move needs it. */
  const prefetchWindow = (delta: number) => {
    const s = startRef.current + delta;
    const from = new Date(s - offsetMs).toISOString();
    const to = new Date(s + windowMs - offsetMs).toISOString();
    for (const refs of [refsA, refsB]) {
      if (refs.length === 0) continue;
      const args = gridArgs(refs, from, to);
      void queryClient.prefetchQuery({ queryKey: rpcKey('epg.grid', args), queryFn: () => rpcRaw('epg.grid', args), staleTime: GRID_STALE_MS });
    }
  };
  // Horizontal scrolling runs on past the window: near an edge, scrolling toward it moves the
  // window by GRID_EXTEND (the layout effect above keeps the view still), and within a screen of
  // the edge the next window's guide is fetched ahead, so it arrives drawn. Layout is read once,
  // before anything is written (L2-guide-library-2).
  const onGridScroll = (el: HTMLDivElement) => {
    const x = scrollStart(el);
    const max = el.scrollWidth - el.clientWidth;
    viewWidth.current = el.clientWidth;
    const dx = x - scrollX.current;
    scrollX.current = x;
    const y = el.scrollTop;
    const vs = vScroll.current;
    if (y !== vs.y) {
      const t = performance.now();
      vs.v = Math.abs(y - vs.y) / Math.max(1, t - vs.t);
      vs.t = t;
      vs.y = y;
    }
    // A vertical scroll leaves the cell text as it is: rows it brings in fit theirs.
    if (dx === 0) return;
    fitCellText(el, x, shiftPx.current);
    const dir = extendDirection(x, dx, max);
    if (dir !== 0) {
      // Rendered and scrolled back at once, so the next wheel step lands on the moved window
      // instead of the clamped edge (L2-guide-library-5). The synchronous render is the header,
      // the now line and the track's shift: the rows keep their props (cells sit from a fixed
      // origin, and the guide for the new window renders deferred), L3-perf-ui-4.
      flushSync(() => drift(dir * GRID_EXTEND));
    } else if (dx > 0 && x >= max - GRID_EXTEND_EDGE_PX - el.clientWidth) {
      prefetchWindow(GRID_EXTEND);
    } else if (dx < 0 && x <= GRID_EXTEND_EDGE_PX + el.clientWidth) {
      prefetchWindow(-GRID_EXTEND);
    }
  };

  // ---- guide search and jump (Run 2 C5) ----------------------------------------
  const [jumpOpen, setJumpOpen] = useState(false);
  const openJump = useCallback(() => setJumpOpen(true), []);
  const closeJump = useCallback(() => setJumpOpen(false), []);
  const searchRef = useRef<HTMLInputElement>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [highlight, setHighlight] = useState<ItemKey | null>(null);
  const guideArea = tg('shortcutArea');
  useShortcut(
    '/',
    (e) => {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { description: tg('searchLabel'), area: guideArea },
  );
  useShortcut(
    't',
    (e) => {
      e.preventDefault();
      setJumpOpen(true);
    },
    { description: tg('jumpTitle'), area: guideArea },
  );

  /** A search hit (display time): move the window to its start, in a group that holds the channel. */
  const selectHit = useStable((hit: GuideSearchHit) => {
    const time = ms(hit.program.start);
    const group = groupForHit(categoryId, hit);
    goTo(time, { category: group === categoryId ? undefined : null });
    setHighlight(null);
    setReveal({ key: itemKey(hit.ref), time, channelName: displayChannelName(hit.channelName, prefs.stripCountryPrefix), categoryId: group });
  });

  // Once the list the hit needs is on screen, find the channel's row, scroll to it, put the
  // keyboard cursor on the programme and highlight the row for a moment.
  const listReady = !!sourceId && !paged.isLoading && !paged.refreshing && !paged.error;
  useEffect(() => {
    if (!reveal || !listReady || categoryId !== reveal.categoryId) return;
    let cancelled = false;
    const known = paged.loaded.find((l) => itemKey(l.channel.ref) === reveal.key)?.index;
    const lookup =
      known !== undefined
        ? Promise.resolve(known)
        : findChannelIndex((offset, limit) => rpc('catalog.channels', { sourceId, categoryId, query: { offset, limit } }), reveal.key, () => cancelled);
    lookup
      .then((index) => {
        if (cancelled) return;
        setReveal(null);
        if (index === null) {
          toast({ title: tg('hitNotFound', { channel: reveal.channelName }) });
          return;
        }
        virtualizer.scrollToIndex(index, { align: 'center' });
        cursorRef.current = { row: index, time: reveal.time };
        setCursor({ row: index, time: reveal.time });
        focusPending.current = true;
        scroller.current?.focus({ preventScroll: true });
        setHighlight(reveal.key);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReveal(null);
        toast({ title: tg('hitNotFound', { channel: reveal.channelName }), description: err instanceof Error ? err.message : undefined, variant: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `paged.loaded` is read once the list is ready; later page loads must not start another lookup.
  }, [reveal, listReady, sourceId, categoryId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!highlight) return;
    const id = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [highlight]);

  // ---- actions --------------------------------------------------------------
  // `kind` is the selected source's; rows kept on screen from the previous source while the new
  // one loads must not be played as this kind.
  const ownKind = (channel: Channel) => (channel.ref.sourceId === source?.id ? kind : undefined);
  const playLive = useStable((channel: Channel) => {
    const kind = ownKind(channel);
    if (!kind) return;
    playChannel(channel, kind, undefined, displayChannelName(channel.name, prefs.stripCountryPrefix)).catch((err: unknown) =>
      toast({ title: t('playFailed', { name: displayChannelName(channel.name, prefs.stripCountryPrefix) }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
    );
  });
  /** Watch on an airing search hit: the hit carries what playback needs of the channel. */
  const watchHit = useStable((hit: GuideSearchHit) =>
    playLive({
      ref: hit.ref,
      name: hit.channelName,
      number: hit.channelNumber,
      logoUrl: hit.logoUrl,
      categoryId: hit.categoryId ?? '',
      categoryName: '',
      isRadio: hit.ref.contentType === 'radio',
    }),
  );
  const catchup = (channel: Channel, program: EpgProgram) => {
    const kind = ownKind(channel);
    if (!kind) return;
    playCatchup(channel, kind, program, undefined, displayChannelName(channel.name, prefs.stripCountryPrefix)).catch((err: unknown) =>
      toast({ title: t('catchupFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
    );
  };

  // What the memoised rows do: one stable object, each entry reading the latest render.
  const openCell = useStable((row: number, channel: Channel, program: EpgProgram, el: HTMLElement) => {
    setCursor({ row, time: ms(program.start) });
    invoker.current = el;
    setSelection({ channel, program, anchor: el });
  });
  const focusCell = useStable((row: number, program: EpgProgram) =>
    setCursor((c) => (c.row === row && c.time >= ms(program.start) && c.time < ms(program.end) ? c : { row, time: Math.max(ms(program.start), start) })),
  );
  const rowMenuAt = useStable((channel: Channel, x: number, y: number) => setRowMenu({ pos: { x, y }, channel }));
  const fitText = useCallback((row: HTMLElement) => fitCellText(row, scrollX.current, shiftPx.current), []);
  const pressCell = useStable((channel: Channel, program: EpgProgram) => prefetchProgramDescription(queryClient, channel.ref, program, offsetMs));
  const rowHandlers = useMemo<GuideRowHandlers>(
    () => ({ play: playLive, open: openCell, focusCell, menu: rowMenuAt, fitText, press: pressCell }),
    [playLive, openCell, focusCell, rowMenuAt, fitText, pressCell],
  );

  // ---- render ---------------------------------------------------------------
  const slots = useMemo(() => {
    const out: number[] = [];
    for (let s = start; s < end; s += GRID_SLOT_MIN * MINUTE) out.push(s);
    return out;
  }, [start, end]);
  const labels = useMemo(() => slotLabels(slots, i18n.language), [slots, i18n.language]);
  const trackWidth = (windowMs / MINUTE) * PX_PER_MIN;
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
          <Link to="/sources" className={buttonClass('primary', 'sm')}>
            {t('openSources')}
          </Link>
        }
      />
      </>
    );
  }

  const bar = guideBarLayout(pageWidth);
  const cursorStart = cursorProgram(cursor.row, cursor.time)?.start ?? '';
  const lang = i18n.language;

  return (
    // data-guide-search-bounds (SEARCH_BOUNDS_ATTR): the search panel stays inside the page, clear of the rail.
    <div ref={measurePage} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg" data-testid="epg-grid-page" data-guide-bar={bar} data-guide-search-bounds="">
      {heading}
      <GuideToolbar
        sources={sources.data}
        sourceId={sourceId}
        categories={categories.data}
        categoryId={categoryId}
        bar={bar}
        start={start}
        end={end}
        nowInWindow={nowInWindow}
        now={now}
        offsetMinutes={prefs.epgOffsetMinutes}
        stripCountryPrefix={prefs.stripCountryPrefix}
        searchRef={searchRef}
        onQuery={setQuery}
        onShift={shift}
        onShiftDay={shiftDay}
        onNow={toNow}
        onJump={openJump}
        onSelectHit={selectHit}
        onWatchHit={watchHit}
      />
      <MemoJumpToDialog open={jumpOpen} onClose={closeJump} start={start} now={now} onJump={goTo} onNow={toNow} />

      {gridError ? (
        <div role="alert" className="border-b border-divider bg-surface-2 px-3 py-2 text-sm text-danger">
          {t('guideLoadFailed')}{' '}
          <button type="button" className="rounded-sm font-medium underline underline-offset-2 hover:decoration-2 active:opacity-80" onClick={() => void (gridA.error ? gridA.refetch() : gridB.refetch())}>
            {t('retry')}
          </button>
        </div>
      ) : plainPortal.unavailable || archivePortal.unavailable ? (
        <GuideUnavailableNotice
          onRetry={() => {
            plainPortal.retry();
            archivePortal.retry();
          }}
        />
      ) : null}

      {paged.error ? (
        <ErrorState error={paged.error} onRetry={paged.retry} />
      ) : paged.isLoading || !sourceId ? (
        <div className="flex flex-col gap-2 p-3" aria-busy="true" aria-label={t('loadingGuide')}>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex gap-2">
              <Skeleton className={compact ? 'h-12 w-16 shrink-0' : 'h-12 w-40 shrink-0'} />
              <Skeleton className="h-12 flex-1" />
            </div>
          ))}
        </div>
      ) : count === 0 ? (
        <EmptyState icon={<Tv className="size-8" />} title={t('noChannels')} description={t('noChannelsHint')} />
      ) : (
        // The grid with the no-guide notice floating over its foot: the notice comes and goes as
        // chunks load without moving the grid (L1-perf-1).
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroller}
            role="grid"
            aria-label={t('guide')}
            aria-rowcount={count + 1}
            // Focusable from script only: it holds focus while the cursor's row is still loading.
            tabIndex={-1}
            onKeyDown={onGridKey}
            onScroll={(e) => onGridScroll(e.currentTarget)}
            onFocus={(e) => {
              lastFocused.current = e.target as HTMLElement;
            }}
            data-testid="epg-grid"
            // The ring shows only once the grid has held focus for 150 ms: the brief holds of a
            // window shift (16-98 ms) would otherwise flash a frame around the whole grid. It goes
            // at once when a cell takes focus (no delay out of the focused state).
            className="relative min-h-0 flex-1 overflow-auto overscroll-contain outline-none transition-shadow duration-0 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset focus-visible:delay-150"
          >
            <div
              style={
                {
                  width: channelCol + trackWidth,
                  height: virtualizer.getTotalSize() + HEADER_H,
                  position: 'relative',
                  // Moves every row's cells to the window (GuideRow lays them out from `origin`).
                  [GRID_SHIFT_VAR]: `${gridShift}px`,
                } as CSSProperties
              }
            >
              <GuideHeader slots={slots} labels={labels} channelCol={channelCol} trackWidth={trackWidth} compact={compact} />

              {nowInWindow ? (
                // Under the sticky channel column (z-10) and time header (z-20), and under the cells'
                // text too: drawn before the rows, it shows through the airing cell's tinted
                // background and gaps without striking through its title (L3-visual-3).
                <div
                  aria-hidden
                  data-testid="epg-now-line"
                  className="pointer-events-none absolute w-0.5 bg-live"
                  style={{ ...inlineStart(channelCol + nowX - 1, rtl), top: HEADER_H - 6, height: virtualizer.getTotalSize() + 6 }}
                >
                  <span className="sticky top-[30px] -ms-[3px] block size-2 rounded-full bg-live" />
                </div>
              ) : null}

              {vItems.map((v) => {
                const ch = paged.getChannel(v.index);
                return (
                  <GuideRow
                    key={v.key}
                    index={v.index}
                    top={HEADER_H + v.start}
                    height={GRID_ROW}
                    channel={ch}
                    programs={programsFor(ch)}
                    origin={origin}
                    now={now}
                    pxPerMin={PX_PER_MIN}
                    channelCol={channelCol}
                    trackWidth={trackWidth}
                    compact={compact}
                    rtl={rtl}
                    kind={kind}
                    highlighted={!!ch && highlight === itemKey(ch.ref)}
                    cursorStart={v.index === cursor.row ? cursorStart : null}
                    lang={lang}
                    stripCountryPrefix={prefs.stripCountryPrefix}
                    schedule={schedule}
                    handlers={rowHandlers}
                  />
                );
              })}
            </div>
          </div>
          {noEpgAnywhere ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
              <div
                data-testid="guide-no-data"
                className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-fg-muted shadow-2 motion-safe:animate-fade-in"
              >
                <span className="min-w-0 truncate" title={t('guideNoData')}>
                  {t('guideNoData')}
                </span>
                <Link to="/settings/epg" className="shrink-0 text-accent hover:underline">
                  {t('epgSettings')}
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {rowMenu ? <GuideRowMenu menu={rowMenu} kind={ownKind(rowMenu.channel)} onPlay={playLive} onClose={closeRowMenu} /> : null}

      {selection ? (
        <ProgramPopover
          selection={selection}
          kind={kind}
          now={now}
          rtl={rtl}
          scroller={scroller.current}
          channelCol={channelCol}
          sheet={compact}
          onClose={closePopover}
          onLive={() => {
            playLive(selection.channel);
            closePopover();
          }}
          onCatchup={() => {
            catchup(selection.channel, selection.program);
            closePopover();
          }}
        />
      ) : null}
    </div>
  );
}

const MemoJumpToDialog = memo(JumpToDialog);

/** The time header: the channel column's corner and a label per 30-minute slot. */
const GuideHeader = memo(function GuideHeader({
  slots,
  labels,
  channelCol,
  trackWidth,
  compact,
}: {
  slots: readonly number[];
  labels: readonly string[];
  channelCol: number;
  trackWidth: number;
  compact: boolean;
}) {
  const { t } = useTranslation('live');
  return (
    <div role="row" className="sticky top-0 z-20 flex border-b border-divider bg-surface" style={{ height: HEADER_H, width: channelCol + trackWidth }}>
      <div role="columnheader" className="sticky start-0 z-10 flex items-center border-e border-divider bg-surface px-3 text-xs text-fg-subtle" style={{ width: channelCol }}>
        <span className={compact ? 'sr-only' : undefined}>{t('channels')}</span>
      </div>
      {slots.map((s, i) => (
        <div role="columnheader" key={s} className="flex items-center border-s border-divider px-2 text-xs tabular-nums text-fg-muted" style={{ width: GRID_SLOT_PX }}>
          {labels[i]}
        </div>
      ))}
    </div>
  );
});

/**
 * The guide's toolbar: source and group, the search field and the time controls. Memoised with
 * stable handlers, so a scroll frame or a cursor move of the grid does not re-render it
 * (L2-perf-ui-1).
 */
const GuideToolbar = memo(function GuideToolbar({
  sources,
  sourceId,
  categories,
  categoryId,
  bar,
  start,
  end,
  nowInWindow,
  now,
  offsetMinutes,
  stripCountryPrefix,
  searchRef,
  onQuery,
  onShift,
  onShiftDay,
  onNow,
  onJump,
  onSelectHit,
  onWatchHit,
}: {
  sources: readonly { id: string; name: string }[] | undefined;
  sourceId: string;
  categories: readonly { id: string; name: string }[] | undefined;
  categoryId: string | undefined;
  bar: 'full' | 'stacked' | 'phone';
  start: number;
  end: number;
  nowInWindow: boolean;
  now: number;
  offsetMinutes: number;
  stripCountryPrefix: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery(key: string, value: string | undefined): void;
  onShift(delta: number): void;
  onShiftDay(days: number): void;
  onNow(): void;
  onJump(): void;
  onSelectHit(hit: GuideSearchHit): void;
  onWatchHit(hit: GuideSearchHit): void;
}) {
  const { t, i18n } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const lang = i18n.language;
  // The kit's Select, sized down to the toolbar's 32 px buttons.
  const selectClass = 'h-8 max-w-48';
  const sourceOptions: SelectOption[] = useMemo(() => (sources ?? []).map((s) => ({ value: s.id, label: s.name })), [sources]);
  const groupOptions: SelectOption[] = useMemo(
    () => [{ value: '', label: t('allChannels') }, ...(categories ?? []).map((c) => ({ value: c.id, label: c.name }))],
    [categories, t],
  );
  const stacked = bar !== 'full';
  const range = `${formatClock(start, lang)}–${formatClock(end, lang)}`;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-surface px-3 py-2">
      <Select aria-label={t('guideSource')} className={selectClass} wrapperClassName="min-w-0" value={sourceId} options={sourceOptions} onValueChange={(v) => onQuery('source', v)} />
      <Select
        aria-label={t('guideGroup')}
        className={selectClass}
        wrapperClassName="min-w-0"
        value={categoryId ?? ''}
        options={groupOptions}
        onValueChange={(v) => onQuery('category', v || undefined)}
      />
      {/* While the sources load the field holds its place, disabled, so the toolbar does not shift (L2-visual-2). */}
      <GuideSearch
        inputRef={searchRef}
        sourceId={sourceId}
        disabled={!sourceId}
        offsetMinutes={offsetMinutes}
        now={now}
        stripCountryPrefix={stripCountryPrefix}
        onSelect={onSelectHit}
        onWatch={onWatchHit}
        // Narrow pages: the field fills what the selects leave on their row, or a row of its own.
        className={stacked ? 'min-w-48 flex-1' : 'w-60'}
      />
      {/* Narrow pages give the time controls a full row; the window label takes what the buttons leave. */}
      <div className={stacked ? 'flex w-full min-w-0 items-center gap-1' : 'ms-auto flex items-center gap-1'} role="group" aria-label={t('guideTime')} data-testid="guide-time">
        {bar !== 'phone' ? (
          <Button size="sm" variant="ghost" icon={<ChevronsLeft className="size-4 rtl:rotate-180" />} onClick={() => onShiftDay(-1)} aria-label={t('previousDay')} title={t('previousDay')} />
        ) : null}
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4 rtl:rotate-180" />} onClick={() => onShift(-3 * HOUR)} aria-label={t('earlier')} title={t('earlier')} />
        {/* The window's span; pressing it opens Jump to date and time (`t`). The text is the same in
            both layouts (day, space, times); stacked, the day sits small over the times. */}
        <button
          type="button"
          aria-haspopup="dialog"
          title={tg('jumpTitle')}
          onClick={onJump}
          data-testid="guide-window"
          className={cn(
            'inline-flex h-8 items-center justify-center rounded-md px-2 tabular-nums text-fg outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors',
            stacked ? 'min-w-0 flex-1 bg-surface-2 hover:bg-surface-3' : 'min-w-36 gap-1.5 text-sm whitespace-nowrap hover:bg-surface-2',
          )}
        >
          {stacked ? null : <CalendarClock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
          <span aria-live="polite" className={stacked ? 'flex max-w-full min-w-0 flex-col items-center leading-tight' : undefined}>
            <span className={stacked ? 'max-w-full truncate text-[calc(11rem/15)] text-fg-muted' : undefined}>{formatDay(start, lang)}</span>{' '}
            <span className={stacked ? 'max-w-full truncate text-[calc(13rem/15)] font-medium' : undefined}>{range}</span>
          </span>
          <span className="sr-only">, {tg('jumpTitle')}</span>
        </button>
        <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4 rtl:rotate-180" />} onClick={() => onShift(3 * HOUR)} aria-label={t('later')} title={t('later')} />
        {bar !== 'phone' ? (
          <Button size="sm" variant="ghost" icon={<ChevronsRight className="size-4 rtl:rotate-180" />} onClick={() => onShiftDay(1)} aria-label={t('nextDay')} title={t('nextDay')} />
        ) : null}
        <Button size="sm" variant={nowInWindow ? 'ghost' : 'primary'} className="shrink-0" onClick={onNow}>
          {t('jumpToNow')}
        </Button>
      </div>
    </div>
  );
});


/**
 * A channel row's menu (right click on the row, or the context-menu key / Shift+F10 in the grid):
 * play, the archive, multi-view, lists, rename / hide (C2) and the parental lock, as on the Live
 * page. Mounted only while open, so the guide asks for list, edit and lock state on demand.
 */
function GuideRowMenu({
  menu,
  kind,
  onPlay,
  onClose,
}: {
  menu: { pos: { x: number; y: number }; channel: Channel };
  kind?: SourceKind;
  onPlay(channel: Channel): void;
  onClose(): void;
}) {
  const { t } = useTranslation('live');
  const navigate = useNavigate();
  const { stripCountryPrefix } = useDisplayPrefs();
  const ch = menu.channel;
  const name = displayChannelName(ch.name, stripCountryPrefix);
  // C4: radio has no picture, so a station gets no multi-view entry.
  const live = ch.ref.contentType === 'live';
  const multiviewItem = useMultiviewMenuItem(live ? channelInput(ch) : null);
  const addToListItem = useAddToListMenuItem(ch);
  const editItems = useChannelEditMenuItems(ch);
  const lockItems = useLockMenuItems(
    { sourceId: ch.ref.sourceId, contentType: ch.ref.contentType, kind: 'item', targetId: ch.ref.itemId, name },
    { categoryId: ch.categoryId },
  );
  // F2 and Shift+Delete belong to the Live list; the guide does not bind them, so no key hints here.
  const plain = ({ id, label, icon, disabled, onSelect }: MenuAction): MenuItem => ({ id, label, icon, disabled, onSelect });
  const items: MenuItem[] = [
    { id: 'play', label: t('play'), icon: <Play className="size-4" />, onSelect: () => onPlay(ch) },
    ...(canBrowseArchive(ch, kind) ? [{ id: 'archive', label: t('browseArchive'), icon: <History className="size-4" />, onSelect: () => void navigate(archivePath(ch.ref)) }] : []),
    ...(live ? [plain(multiviewItem)] : []),
    ...(addToListItem ? [plain(addToListItem)] : []),
    ...editItems.map(plain),
    ...lockItems.map(plain),
  ];
  return <ContextMenu pos={menu.pos} items={items} label={name} onClose={onClose} />;
}

function ProgramPopover({
  selection,
  kind,
  now,
  rtl,
  scroller,
  channelCol,
  sheet,
  onClose,
  onLive,
  onCatchup,
}: {
  selection: Selection;
  kind?: SourceKind;
  now: number;
  rtl: boolean;
  /** The grid: the popover follows its cell while it scrolls, and closes once the cell is out of view. */
  scroller: HTMLElement | null;
  channelCol: number;
  /** Phones: a bottom sheet over a scrim instead of a popover beside the cell. */
  sheet: boolean;
  onClose(): void;
  onLive(): void;
  onCatchup(): void;
}) {
  const { t, i18n } = useTranslation('live');
  const navigate = useNavigate(); // guide: "Browse archive"
  const ref = useRef<HTMLDivElement>(null);
  const { program, channel, anchor } = selection;
  const when = programWhen(program, now);
  const catchupOk = canCatchUp(program, channel, kind, now);
  const { stripCountryPrefix, epgOffsetMinutes } = useDisplayPrefs();
  const channelName = displayChannelName(channel.name, stripCountryPrefix);
  // The grid comes without descriptions: this one is asked for when the detail opens.
  const { description, pending: descriptionPending } = useProgramDescription(channel.ref, program, epgOffsetMinutes * MINUTE);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Placed from the cell before paint, then kept on it while the grid scrolls (written straight to
  // the element's style: a scroll frame does not re-render). Once the cell leaves the visible
  // track (or unmounts), the popover closes rather than float over unrelated rows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelector<HTMLElement>('button')?.focus();
    if (sheet) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // Align with the cell's inline-start edge: its left in LTR, its right in RTL.
      const x = rtl ? a.right - r.width : a.left;
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
      el.style.top = `${a.bottom + 6 + r.height > window.innerHeight - 8 ? Math.max(8, a.top - r.height - 6) : a.bottom + 6}px`;
    };
    place();
    // A description that arrives after the popover opened grows it: placed again, so a popover
    // above its cell still ends just above it.
    const grow = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
    grow?.observe(el);
    if (!scroller) return () => grow?.disconnect();
    const follow = () => {
      if (!anchor.isConnected || !cellInView(anchor, scroller, channelCol, rtl)) closeRef.current();
      else place();
    };
    scroller.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
    return () => {
      grow?.disconnect();
      scroller.removeEventListener('scroll', follow);
      window.removeEventListener('resize', follow);
    };
  }, [anchor, rtl, sheet, scroller, channelCol]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // A dialog opened from the popover (Record series) is a portal: pressing in it is not outside.
      if (e.target instanceof Element && e.target.closest('[data-dialog-layer]')) return;
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <>
      {/* The sheet's scrim: pressing it is a press outside, which closes the sheet. */}
      {sheet ? <div aria-hidden data-scrim="" className="fixed inset-0 z-40 bg-scrim motion-safe:animate-fade-in" /> : null}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={program.title}
        onKeyDown={(e) => {
          // Keys from a portal dialog opened here bubble through React; they are the dialog's.
          if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) return;
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === 'Tab') {
            // Tab cycles inside the popover; Escape or Close hands focus back to the cell.
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])];
            const first = items[0];
            const last = items[items.length - 1];
            if (!first || !last) return;
            const active = document.activeElement;
            const inside = !!active && !!ref.current?.contains(active);
            if (e.shiftKey && (active === first || !inside)) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && (active === last || !inside)) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
        className={
          sheet
            ? 'fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-xl border-t border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-fg shadow-2 motion-safe:animate-toast-in'
            : 'fixed z-50 w-[min(360px,calc(100vw-16px))] rounded-lg border border-border bg-surface p-4 text-fg shadow-2'
        }
        data-testid="program-popover"
        data-sheet={sheet ? '' : undefined}
      >
        {sheet ? <span aria-hidden className="mx-auto -mt-1 mb-3 block h-1 w-10 rounded-full bg-border" /> : null}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs tabular-nums text-fg-muted">{joinList([channelName, formatRange(program, i18n.language)], i18n.language)}</p>
            <h3 dir="auto" className="mt-0.5 text-base font-semibold text-match-parent">{program.title}</h3>
            {program.category ? <p className="text-xs text-fg-subtle">{program.category}</p> : null}
            {/* guide: programmes from the provider's own guide, not XMLTV. */}
            {program.fromProvider ? <p className="text-xs text-fg-subtle" data-testid="program-from-provider">{t('fromProvider')}</p> : null}
          </div>
          <button type="button" aria-label={t('close')} onClick={onClose} className="rounded-md p-1 text-fg-muted hover:bg-surface-2">
            <X className="size-4" />
          </button>
        </div>
        {description ? (
          <p dir="auto" data-testid="program-description" className="mt-2 line-clamp-6 text-sm text-fg-muted text-match-parent motion-safe:animate-fade-in">
            {description}
          </p>
        ) : descriptionPending ? (
          // Two lines held while the description is asked for, so the actions below rarely move.
          <div aria-hidden data-testid="program-description-pending" className="mt-2 flex flex-col gap-2 py-1">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : null}
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
              {t('playChannel', { name: channelName })}
            </Button>
          ) : null}
          {/* guide: K6, the one archive entry point of the programme dialog. */}
          {canBrowseArchive(channel, kind) ? (
            <Button size="sm" variant="ghost" icon={<CalendarClock className="size-3.5" />} onClick={() => navigate(archivePath(channel.ref))} data-testid="program-browse-archive">
              {t('browseArchive')}
            </Button>
          ) : null}
          {/* recording: */}
          <ProgramActions channelRef={channel.ref} channelName={channelName} program={program} now={now} />
          {when === 'past' && !catchupOk ? <p className="w-full text-xs text-fg-subtle">{t('noCatchup')}</p> : null}
          {when === 'future' ? <p className="w-full text-xs text-fg-subtle">{t('startsAt', { time: formatClock(ms(program.start), i18n.language) })}</p> : null}
        </div>
      </div>
    </>
  );
}

/** Whether `cell` still shows in the grid's track: below the time header and clear of the channel column. */
function cellInView(cell: HTMLElement, grid: HTMLElement, channelCol: number, rtl: boolean): boolean {
  const box = grid.getBoundingClientRect();
  if (!(box.width > 0)) return true; // not laid out (tests): nothing to measure against
  const a = cell.getBoundingClientRect();
  const left = rtl ? box.left : box.left + channelCol;
  const right = rtl ? box.right - channelCol : box.right;
  return a.right > left && a.left < right && a.bottom > box.top + HEADER_H && a.top < box.bottom;
}
