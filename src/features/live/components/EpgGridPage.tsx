import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarClock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, History, Play, Radio, Tv, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
  hasUsableArchive,
  layoutBlocks,
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
import { ChannelLogo } from './ChannelLogo';
import { ContextMenu, type MenuItem } from './ContextMenu';
// recording:
import { ProgramActions, ScheduleMark } from '@/features/recording';
// guide (Run 2 C5): jump to a date and time, guide search.
import { GuideSearch } from '../guide/GuideSearchPanel';
import { JumpToDialog } from '../guide/JumpToDialog';
import { findChannelIndex, groupForHit } from '../guide/search';

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

/** CSS variable on the grid scroller: how far the track is scrolled from its inline-start edge, in px. */
export const GRID_SCROLL_VAR = '--grid-scroll';
/** Room a clipped cell keeps for its text before the cell's end pushes the text out. */
const CELL_TEXT_MIN_PX = 48;

/**
 * Inline-start padding for the text of a programme cell at `left` px into the track (`width` px
 * wide). A show that began before the visible edge has its text pushed just past the sticky
 * channel column. Pure CSS on a scroll variable, so a scroll restyles the cells without a render.
 * (`position: sticky` cannot do this: the text fills its cell, so it has no room to stick in.)
 */
export function cellTextPad(left: number, width: number): string {
  // The button sits at left + 1 with a 1 px border and 8 px padding: its text starts at left + 10,
  // and should start 8 px past the edge, at scroll + 8.
  const max = Math.max(0, width - 20 - CELL_TEXT_MIN_PX);
  return `clamp(0px, calc(var(${GRID_SCROLL_VAR}, 0px) - ${left + 2}px), ${max}px)`;
}

/** Copies the scroller's inline-start scroll distance into GRID_SCROLL_VAR. */
function syncGridScroll(el: HTMLElement): void {
  el.style.setProperty(GRID_SCROLL_VAR, `${scrollStart(el)}px`);
}

/** Width of the element the callback ref is attached to, kept current by a ResizeObserver. */
function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    observer.current.observe(el);
  }, []);
  return [ref, width];
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

  const sources = useRpcQuery('sources.list', undefined);
  const sourceId = params.get('source') ?? sources.data?.[0]?.id ?? '';
  const categoryId = params.get('category') ?? undefined;
  const source = sources.data?.find((s) => s.id === sourceId);
  const kind: SourceKind | undefined = source?.kind;
  const categories = useRpcQuery('catalog.categories', { sourceId, contentType: 'live' }, { enabled: !!sourceId });

  // The window start lives in the URL (`at`, epoch ms on a 30-minute slot), so back and forward
  // restore it. Without `at` the window follows "now" as it was when the page opened or Jump to
  // now was last pressed.
  const atParam = parseWindowAt(params.get('at'));
  const [nowStart, setNowStart] = useState(() => defaultStart(Date.now()));
  const start = atParam ?? nowStart;
  const [measurePage, pageWidth] = useElementWidth();
  // Measured pages get room to scroll past the page width, so horizontal scrolling can move the window on.
  const windowMs = gridWindowFor(pageWidth > 0 ? pageWidth + GRID_SCROLL_ROOM_PX : 0, channelCol);
  const end = start + windowMs;

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
  });
  const vItems = virtualizer.getVirtualItems();
  const first = vItems[0]?.index ?? 0;
  const last = vItems[vItems.length - 1]?.index ?? 0;
  const { setVisibleRange } = paged;
  useEffect(() => setVisibleRange(first, last), [first, last, setVisibleRange]);

  // `[start, end)` is display time. Programmes are shown `epgOffsetMinutes` later than the guide
  // says, so the guide is asked for the window moved back by the offset, then shifted for display.
  const offsetMs = prefs.epgOffsetMinutes * MINUTE;
  const fromIso = new Date(start - offsetMs).toISOString();
  const toIso = new Date(end - offsetMs).toISOString();

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
  // The previous answer stays while the next chunk or window loads (keepPrevious): rows it
  // covers keep their programmes and the no-guide notice does not blink. Rows it does not
  // cover show as loading (see `programsFor`).
  const gridA = useRpcQuery('epg.grid', { refs: refsA, from: fromIso, to: toIso }, { enabled: refsA.length > 0, staleTime: GRID_STALE_MS, keepPrevious: true });
  const gridB = useRpcQuery('epg.grid', { refs: refsB, from: fromIso, to: toIso }, { enabled: refsB.length > 0, staleTime: GRID_STALE_MS, keepPrevious: true });
  const keysA = new Set(refsA.map(itemKey));
  const keysB = new Set(refsB.map(itemKey));
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
  const archiveQuery = stalkerArchiveQuery(start - offsetMs, end - offsetMs, now, portalLimit);
  const plainPortal = useStalkerPreviews(sourceId, isStalker, plainRefs, now, portalLimit);
  const archivePortal = useStalkerPreviews(sourceId, isStalker, archiveRefs, now, archiveQuery.limit, archiveQuery.from);
  // guide: Xtream short-EPG fallback for visible rows the XMLTV guide leaves empty, while the
  // window reaches now or later (the provider's short guide starts at the airing programme).
  const shortEpgOn = useShortEpgEnabled(kind) && end > now;
  /**
   * A row's XMLTV programmes: from an answer for this window, or (while that loads) the previous
   * answer's programmes for the row; undefined while loading, [] when the answer has none.
   */
  const gridList = (k: ItemKey): EpgProgram[] | undefined => {
    for (const [q, keys] of [
      [gridA, keysA],
      [gridB, keysB],
    ] as const) {
      const list = q.data?.[k];
      if (q.isPlaceholderData) {
        if (list && list.length > 0) return list;
      } else if (q.data && (list || keys.has(k))) {
        return list ?? [];
      }
    }
    return undefined;
  };
  const shortRefs = useMemo(() => {
    const out: ItemRef[] = [];
    if (!shortEpgOn) return out;
    for (let i = first; i <= last; i++) {
      const ch = getChannel(i);
      if (!ch) continue;
      const list = gridList(itemKey(ch.ref));
      if (list && list.length === 0) out.push(ch.ref);
    }
    return out;
    // gridList reads gridA/gridB, listed by their answers.
  }, [shortEpgOn, first, last, getChannel, gridA.data, gridB.data, gridA.isPlaceholderData, gridB.isPlaceholderData]); // eslint-disable-line react-hooks/exhaustive-deps
  const shortFor = useShortEpgPreviews(sourceId, shortEpgOn, shortRefs, now);
  const hasShortData = shortRefs.some((r) => (shortFor(r)?.length ?? 0) > 0);
  const programsFor = (ch: Channel | undefined): EpgProgram[] | undefined => {
    if (!ch) return undefined;
    const list = gridList(itemKey(ch.ref));
    const portal = isStalker ? (ch.archive?.enabled ? archivePortal : plainPortal).get(ch.ref) : undefined;
    if (portal && portal.length > 0) return shiftPrograms(mergePrograms(portal, list ?? []), prefs.epgOffsetMinutes);
    // guide: an empty XMLTV row takes the provider's short guide.
    const short = shortEpgOn && list?.length === 0 ? shortFor(ch.ref) : undefined;
    if (short && short.length > 0) return shiftPrograms([...short], prefs.epgOffsetMinutes);
    if (list) return shiftPrograms([...list].sort((a, b) => ms(a.start) - ms(b.start)), prefs.epgOffsetMinutes);
    return undefined;
  };
  const gridError = gridA.error ?? gridB.error;
  const noEpgAnywhere =
    !isStalker &&
    !hasShortData && // guide
    !!gridA.data && Object.values(gridA.data).every((l) => l.length === 0) && (!gridB.data || Object.values(gridB.data).every((l) => l.length === 0));

  // ---- navigation ---------------------------------------------------------
  // A move writes the window start to the URL, which the router applies in a transition: a commit
  // or more after the cursor moved. Until the window the move asked for is on screen (or the URL
  // changes some other way), `pending` holds it: moves start from it, and the keyboard cursor
  // waits for it before it takes focus (otherwise it lands on a cell of the old window).
  const pending = useRef<{ start: number; params: URLSearchParams } | null>(null);
  /** The router's params as last rendered (`paramsRef` runs ahead of them while a move is pending). */
  const routerParams = useRef(params);
  routerParams.current = params;
  // Clicks and key repeat can outrun renders: each move starts from here, not from a stale render.
  const startRef = useRef(start);
  startRef.current = pending.current?.start ?? start;
  const paramsRef = useRef(params);
  if (!pending.current) paramsRef.current = params;
  useLayoutEffect(() => {
    const p = pending.current;
    if (p && (p.start === start || p.params !== params)) {
      pending.current = null;
      startRef.current = start;
      paramsRef.current = params;
    }
  });
  /** Records a move to `slot`; the URL it was made from tells when the router has moved on. */
  const markPending = (slot: number) => {
    pending.current = { start: slot, params: pending.current?.params ?? routerParams.current };
    startRef.current = slot;
  };
  /** Moves the window to `at` (floored to its slot): a new history entry, or `replace` for key-driven moves. */
  const goTo = useCallback(
    (at: number, opts: { replace?: boolean; category?: null } = {}) => {
      const next = new URLSearchParams(paramsRef.current);
      const slot = floorLocal(at, GRID_SLOT_MIN);
      next.set('at', String(slot));
      if (opts.category === null) next.delete('category');
      markPending(slot);
      paramsRef.current = next;
      setParams(next, { replace: opts.replace });
    },
    [setParams], // eslint-disable-line react-hooks/exhaustive-deps -- markPending only touches refs
  );
  const shift = useCallback((delta: number, replace = false) => goTo(startRef.current + delta, { replace }), [goTo]);
  // A calendar day, not 24 h: across a DST change the window keeps its wall-clock time.
  const shiftDay = useCallback((days: number) => goTo(addLocalDays(startRef.current, days)), [goTo]);
  const toNow = useCallback(() => {
    const s = defaultStart(Date.now());
    setNowStart(s);
    markPending(s);
    if (!paramsRef.current.has('at')) return;
    const next = new URLSearchParams(paramsRef.current);
    next.delete('at');
    paramsRef.current = next;
    setParams(next);
  }, [setParams]); // eslint-disable-line react-hooks/exhaustive-deps -- markPending only touches refs
  // Back to an entry without `at` (or a link without it): the window follows now again.
  const followsNow = atParam === null;
  useEffect(() => {
    if (followsNow) setNowStart(defaultStart(Date.now()));
  }, [followsNow]);
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
  const windowPrograms = (row: number) => (programsFor(paged.getChannel(row)) ?? []).filter((p) => ms(p.end) > start && ms(p.start) < end);
  const cursorProgram = (row: number, time: number) => {
    const inWindow = windowPrograms(row);
    const i = programIndexAt(inWindow, time);
    return i >= 0 ? inWindow[i] : undefined;
  };

  // Key repeat can outrun renders: keys read the cursor from here, not from a stale render.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** The element in the grid that last had focus, to notice when a re-render removes it. */
  const lastFocused = useRef<HTMLElement | null>(null);
  const cursorElement = (row: number, time: number) => {
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
  const keepView = useRef(false);
  const laidStart = useRef(start);
  /** The scroll's distance from the inline start at the last scroll event, for its direction. */
  const lastScrollX = useRef(0);
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
    lastScrollX.current = scrollStart(el);
    syncGridScroll(el); // before first paint: cells already clipped by the edge show their text
  }, [start, rtl, gridMounted]);

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
    // The window the move asked for is not on screen yet: its cell does not exist, and a cell
    // of the old window would take focus by mistake. Stay pending until it renders.
    if (pending.current) return;
    const el = cursorElement(cursor.row, cursor.time);
    if (el) {
      el.focus({ preventScroll: true });
      focusPending.current = false;
      // The sticky channel column covers the track at its inline start: left in LTR, right in RTL.
      // scrollLeft deltas are physical in both directions, so only the visible span flips.
      const r = el.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const trackLeft = rtl ? box.left : box.left + channelCol;
      const trackRight = rtl ? box.right - channelCol : box.right;
      if (r.left < trackLeft) root.scrollLeft -= trackLeft - r.left + 8;
      else if (r.right > trackRight) root.scrollLeft += Math.min(r.right - trackRight + 8, r.left - trackLeft);
    }
  });

  const [selection, setSelection] = useState<Selection | null>(null);
  /** The cell that opened the popover; focus returns to it when the popover closes. */
  const invoker = useRef<HTMLElement | null>(null);
  const open = (channel: Channel, program: EpgProgram, el: HTMLElement) => {
    invoker.current = el;
    setSelection({ channel, program, anchor: el });
  };
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
      // Past the window's edge the window moves on and the view stays put (keepView); the focus
      // effect then brings the cell into view.
      case 'later': {
        const nextT = cur ? ms(cur.end) : time + GRID_SLOT_MIN * MINUTE;
        if (nextT >= startRef.current + windowMs) {
          keepView.current = true;
          shift(GRID_EXTEND, true);
        }
        time = nextT;
        break;
      }
      case 'earlier': {
        const prevT = cur ? ms(cur.start) - 1 : time - GRID_SLOT_MIN * MINUTE;
        const from = startRef.current;
        if (prevT < from) {
          keepView.current = true;
          shift(-GRID_EXTEND, true);
        }
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
  };

  /** Fetches the visible chunks' guide for the window `delta` from this one, before a move needs it. */
  const prefetchWindow = (delta: number) => {
    const s = startRef.current + delta;
    const from = new Date(s - offsetMs).toISOString();
    const to = new Date(s + windowMs - offsetMs).toISOString();
    for (const refs of [refsA, refsB]) {
      if (refs.length === 0) continue;
      const args = { refs, from, to };
      void queryClient.prefetchQuery({ queryKey: rpcKey('epg.grid', args), queryFn: () => rpcRaw('epg.grid', args), staleTime: GRID_STALE_MS });
    }
  };
  // Horizontal scrolling runs on past the window: near an edge, scrolling toward it moves the
  // window by GRID_EXTEND (the layout effect above keeps the view still), and within a screen of
  // the edge the next window's guide is fetched ahead, so it arrives drawn.
  const onGridScroll = (el: HTMLDivElement) => {
    syncGridScroll(el);
    const x = scrollStart(el);
    const dx = x - lastScrollX.current;
    lastScrollX.current = x;
    if (dx === 0 || pending.current) return;
    const max = el.scrollWidth - el.clientWidth;
    const dir = extendDirection(x, dx, max);
    if (dir !== 0) {
      keepView.current = true;
      shift(dir * GRID_EXTEND, true);
    } else if (dx > 0 && x >= max - GRID_EXTEND_EDGE_PX - el.clientWidth) {
      prefetchWindow(GRID_EXTEND);
    } else if (dx < 0 && x <= GRID_EXTEND_EDGE_PX + el.clientWidth) {
      prefetchWindow(-GRID_EXTEND);
    }
  };

  // ---- guide search and jump (Run 2 C5) ----------------------------------------
  const [jumpOpen, setJumpOpen] = useState(false);
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
  const selectHit = (hit: GuideSearchHit) => {
    const time = ms(hit.program.start);
    const group = groupForHit(categoryId, hit);
    goTo(time, { category: group === categoryId ? undefined : null });
    setHighlight(null);
    setReveal({ key: itemKey(hit.ref), time, channelName: displayChannelName(hit.channelName, prefs.stripCountryPrefix), categoryId: group });
  };

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
  const playLive = (channel: Channel) => {
    const kind = ownKind(channel);
    if (!kind) return;
    playChannel(channel, kind, undefined, displayChannelName(channel.name, prefs.stripCountryPrefix)).catch((err: unknown) =>
      toast({ title: t('playFailed', { name: displayChannelName(channel.name, prefs.stripCountryPrefix) }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
    );
  };
  /** Watch on an airing search hit: the hit carries what playback needs of the channel. */
  const watchHit = (hit: GuideSearchHit) =>
    playLive({
      ref: hit.ref,
      name: hit.channelName,
      number: hit.channelNumber,
      logoUrl: hit.logoUrl,
      categoryId: hit.categoryId ?? '',
      categoryName: '',
      isRadio: hit.ref.contentType === 'radio',
    });
  const catchup = (channel: Channel, program: EpgProgram) => {
    const kind = ownKind(channel);
    if (!kind) return;
    playCatchup(channel, kind, program, undefined, displayChannelName(channel.name, prefs.stripCountryPrefix)).catch((err: unknown) =>
      toast({ title: t('catchupFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
    );
  };

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

  // The kit's Select, sized down to the toolbar's 32 px buttons.
  const selectClass = 'h-8 max-w-48';
  const sourceOptions: SelectOption[] = (sources.data ?? []).map((s) => ({ value: s.id, label: s.name }));
  const groupOptions: SelectOption[] = [
    { value: '', label: t('allChannels') },
    ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
  ];

  const bar = guideBarLayout(pageWidth);
  const stacked = bar !== 'full';
  const range = `${formatClock(start, i18n.language)}–${formatClock(end, i18n.language)}`;

  return (
    // data-guide-search-bounds (SEARCH_BOUNDS_ATTR): the search panel stays inside the page, clear of the rail.
    <div ref={measurePage} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg" data-testid="epg-grid-page" data-guide-bar={bar} data-guide-search-bounds="">
      {heading}
      <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-surface px-3 py-2">
        <Select
          aria-label={t('guideSource')}
          className={selectClass}
          wrapperClassName="min-w-0"
          value={sourceId}
          options={sourceOptions}
          onValueChange={(v) => setQuery('source', v)}
        />
        <Select
          aria-label={t('guideGroup')}
          className={selectClass}
          wrapperClassName="min-w-0"
          value={categoryId ?? ''}
          options={groupOptions}
          onValueChange={(v) => setQuery('category', v || undefined)}
        />
        {sourceId ? (
          <GuideSearch
            inputRef={searchRef}
            sourceId={sourceId}
            offsetMinutes={prefs.epgOffsetMinutes}
            now={now}
            stripCountryPrefix={prefs.stripCountryPrefix}
            onSelect={selectHit}
            onWatch={watchHit}
            // Narrow pages: the field fills what the selects leave on their row, or a row of its own.
            className={stacked ? 'min-w-48 flex-1' : 'w-60'}
          />
        ) : null}
        {/* Narrow pages give the time controls a full row; the window label takes what the buttons leave. */}
        <div className={stacked ? 'flex w-full min-w-0 items-center gap-1' : 'ms-auto flex items-center gap-1'} role="group" aria-label={t('guideTime')} data-testid="guide-time">
          {bar !== 'phone' ? (
            <Button size="sm" variant="ghost" icon={<ChevronsLeft className="size-4 rtl:rotate-180" />} onClick={() => shiftDay(-1)} aria-label={t('previousDay')} title={t('previousDay')} />
          ) : null}
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4 rtl:rotate-180" />} onClick={() => shift(-3 * HOUR)} aria-label={t('earlier')} title={t('earlier')} />
          {/* The window's span; pressing it opens Jump to date and time (`t`). The text is the same in
              both layouts (day, space, times); stacked, the day sits small over the times. */}
          <button
            type="button"
            aria-haspopup="dialog"
            title={tg('jumpTitle')}
            onClick={() => setJumpOpen(true)}
            data-testid="guide-window"
            className={cn(
              'inline-flex h-8 items-center justify-center rounded-md px-2 tabular-nums text-fg outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors',
              stacked ? 'min-w-0 flex-1 bg-surface-2 hover:bg-surface-3' : 'min-w-36 gap-1.5 text-sm whitespace-nowrap hover:bg-surface-2',
            )}
          >
            {stacked ? null : <CalendarClock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
            <span aria-live="polite" className={stacked ? 'flex max-w-full min-w-0 flex-col items-center leading-tight' : undefined}>
              <span className={stacked ? 'max-w-full truncate text-[calc(11rem/15)] text-fg-muted' : undefined}>{formatDay(start, i18n.language)}</span>{' '}
              <span className={stacked ? 'max-w-full truncate text-[calc(13rem/15)] font-medium' : undefined}>{range}</span>
            </span>
            <span className="sr-only">, {tg('jumpTitle')}</span>
          </button>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4 rtl:rotate-180" />} onClick={() => shift(3 * HOUR)} aria-label={t('later')} title={t('later')} />
          {bar !== 'phone' ? (
            <Button size="sm" variant="ghost" icon={<ChevronsRight className="size-4 rtl:rotate-180" />} onClick={() => shiftDay(1)} aria-label={t('nextDay')} title={t('nextDay')} />
          ) : null}
          <Button size="sm" variant={nowInWindow ? 'ghost' : 'primary'} className="shrink-0" onClick={toNow}>
            {t('jumpToNow')}
          </Button>
        </div>
      </div>
      <JumpToDialog open={jumpOpen} onClose={() => setJumpOpen(false)} start={start} now={now} onJump={(at) => goTo(at)} onNow={toNow} />

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
            className="relative min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
          >
            <div style={{ width: channelCol + trackWidth, height: virtualizer.getTotalSize() + HEADER_H, position: 'relative' }}>
              {/* time header */}
              <div role="row" className="sticky top-0 z-20 flex border-b border-divider bg-surface" style={{ height: HEADER_H, width: channelCol + trackWidth }}>
                <div role="columnheader" className="sticky start-0 z-10 flex items-center border-e border-divider bg-surface px-3 text-xs text-fg-subtle" style={{ width: channelCol }}>
                  <span className={compact ? 'sr-only' : undefined}>{t('channels')}</span>
                </div>
                {slots.map((s, i) => (
                  <div
                    role="columnheader"
                    key={s}
                    className="flex items-center border-s border-divider px-2 text-xs tabular-nums text-fg-muted"
                    style={{ width: GRID_SLOT_PX }}
                  >
                    {labels[i]}
                  </div>
                ))}
              </div>

              {vItems.map((v) => {
                const ch = paged.getChannel(v.index);
                const programs = programsFor(ch);
                const chName = displayChannelName(ch?.name, prefs.stripCountryPrefix);
                const highlighted = !!ch && highlight === itemKey(ch.ref);
                return (
                  <div
                    key={v.key}
                    role="row"
                    aria-rowindex={v.index + 2}
                    className="absolute start-0 flex border-b border-divider"
                    style={{ top: HEADER_H + v.start, height: GRID_ROW, width: channelCol + trackWidth }}
                    // Right click anywhere on the row (its channel cell or a programme): the channel's menu.
                    onContextMenu={(e) => {
                      if (!ch) return;
                      e.preventDefault();
                      setRowMenu({ pos: { x: e.clientX, y: e.clientY }, channel: ch });
                    }}
                  >
                    <div
                      role="rowheader"
                      className={`sticky start-0 z-10 border-e border-divider motion-safe:transition-colors motion-safe:duration-500 ${highlighted ? 'bg-surface-3' : 'bg-surface'}`}
                      style={{ width: channelCol }}
                    >
                      {/* guide search: the row a hit moved to, marked for a moment. */}
                      {highlighted ? <span aria-hidden className="pointer-events-none absolute inset-y-0 start-0 w-[3px] bg-accent" /> : null}
                      {ch ? (
                        <button
                          type="button"
                          data-channel-row={v.index}
                          data-highlighted={highlighted ? '' : undefined}
                          tabIndex={v.index === cursor.row && (!programs || programs.length === 0) ? 0 : -1}
                          onClick={() => playLive(ch)}
                          title={t('playChannel', { name: chName })}
                          data-compact={compact ? '' : undefined}
                          className={cn(
                            'relative flex h-full w-full outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                            compact ? 'flex-col items-center justify-center gap-0.5 px-1' : 'items-center gap-2 px-2 text-start',
                          )}
                        >
                          {compact ? (
                            // Phones: the logo over the number; the name is the button's label and tooltip.
                            <>
                              <ChannelLogo src={ch.logoUrl} name={chName} size={30} sourceId={ch.ref.sourceId} />
                              <span className="max-w-full truncate text-[calc(11rem/15)] leading-none tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
                              <span className="sr-only">{chName}</span>
                              {hasUsableArchive(ch, kind) ? <History className="absolute end-1 top-1 size-3 text-fg-subtle" aria-label={t('archive')} /> : null}
                            </>
                          ) : (
                            <>
                              <span className="w-7 shrink-0 text-end text-[calc(11rem/15)] tabular-nums text-fg-subtle">{ch.number ?? ''}</span>
                              <ChannelLogo src={ch.logoUrl} name={chName} size={30} sourceId={ch.ref.sourceId} />
                              <span className="min-w-0 flex-1 truncate text-sm text-fg">{chName}</span>
                              {hasUsableArchive(ch, kind) ? <History className="size-3.5 shrink-0 text-fg-subtle" aria-label={t('archive')} /> : null}
                            </>
                          )}
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
                        <div className="absolute inset-1.5 flex items-center rounded border border-dashed border-divider text-xs text-fg-subtle">
                          {/* Sticks just past the channel column, so a grid scrolled to now still shows it. */}
                          <span data-testid="no-guide-label" className="sticky px-3" style={{ insetInlineStart: channelCol }}>
                            {t('noGuideShort')}
                          </span>
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
                              className={`absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                b.when === 'now'
                                  ? 'border-accent/60 bg-accent/12 text-fg'
                                  : b.when === 'past'
                                    ? 'border-border/60 bg-surface-2/60 text-fg-muted'
                                    : 'border-border bg-surface-2 text-fg hover:bg-surface-3'
                              }`}
                              style={{ ...inlineStart(b.left + 1, rtl), width: Math.max(2, b.width - 2) }}
                            >
                              {/* A show that began before the visible edge keeps its title readable: the text is
                                  padded past the sticky channel column until the cell's end pushes it out. */}
                              <span data-testid="cell-text" className="block" style={{ paddingInlineStart: cellTextPad(b.left, b.width) }}>
                                <span className="flex items-center gap-1 truncate text-xs font-medium">
                                  {b.when === 'past' && catchupOk ? <History className="size-3 shrink-0" aria-hidden /> : null}
                                  <span dir="auto" className="truncate text-match-parent">{b.program.title}</span>
                                  {/* recording: */}
                                  <ScheduleMark channelRef={ch?.ref} program={b.program} />
                                </span>
                                <span className={`block truncate text-[calc(11rem/15)] tabular-nums ${b.when === 'future' ? 'text-fg-muted' : ''}`}>{formatRange(b.program, i18n.language)}</span>
                              </span>
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
                  data-testid="epg-now-line"
                  className="pointer-events-none absolute z-10 w-0.5 bg-live"
                  style={{ ...inlineStart(channelCol + nowX - 1, rtl), top: HEADER_H - 6, height: virtualizer.getTotalSize() + 6 }}
                >
                  <span className="sticky top-[30px] -ms-[3px] block size-2 rounded-full bg-live" />
                </div>
              ) : null}
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
  const { stripCountryPrefix } = useDisplayPrefs();
  const channelName = displayChannelName(channel.name, stripCountryPrefix);
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
    if (!scroller) return;
    const follow = () => {
      if (!anchor.isConnected || !cellInView(anchor, scroller, channelCol, rtl)) closeRef.current();
      else place();
    };
    scroller.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
    return () => {
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
      {sheet ? <div aria-hidden className="fixed inset-0 z-40 bg-scrim motion-safe:animate-fade-in" /> : null}
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
        {program.description ? <p dir="auto" className="mt-2 line-clamp-6 text-sm text-fg-muted text-match-parent">{program.description}</p> : null}
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
