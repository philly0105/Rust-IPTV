import { hashKey, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Heart,
  History,
  LayoutList,
  ListFilter,
  ListVideo,
  LocateFixed,
  PanelTopClose,
  PanelTopOpen,
  Play,
  Radio,
  Tv,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router';

import { guideCategoriesArgs, setGuideGridPrefetch } from '@/api/bootPrefetch';
import { invalidate, queryClient as appQueryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc, rpcRaw } from '@/api/transport';
import { itemKey, sameRef, type Channel, type EpgProgram, type GuideSearchHit, type ItemKey, type ItemRef, type Settings, type Source, type SourceKind } from '@/api/types';

import { Button, buttonClass, cn, Dialog, EmptyState, ErrorState, FilterChip, IconButton, TEXT_LINK, Skeleton, Tooltip, TOUCH_TARGET, useListVirtualizer, useRowHeight, useScaledPx, useToast, errorDescription } from '@/ui';
import { portalContainer } from '@/ui/portal';
import { dateTimeFormat, intlLocale, relativeTimeFormat } from '@/lib/intl';
import { joinList } from '@/shell/dashboard/cards';
import { useShortcut } from '@/shell';
import { usePlayerStore } from '@/features/player';
// Run 2 C2/C3 and Run 1 C2/C4: the channel row menu, as on the Live page.
import { channelMenuHeader, useChannelMenuItems } from '../hooks/useChannelMenuItems';
import { useDigitEntry } from '../hooks/useDigitEntry';
import { displayPrefsOf, useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useNow } from '../hooks/useNow';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useStalkerPreviews } from '../hooks/useStalkerPreviews';
import { useXtreamGridPrograms } from '../hooks/useXtreamGridPrograms';
import { useShortEpgEnabled, useShortEpgPreviews } from '../hooks/useShortEpg';
import { displayChannelName } from '../lib/channelName';
import { mergePrograms } from '../lib/epgMerge';
import { hasGuideGap } from '../lib/guideCoverage';
import { hasProgramInRange, programsInRange } from '../lib/guideProgramIndex';
import { markFromProvider } from '../lib/shortEpg';
import {
  HOUR,
  MAX_LOOKBACK_HOURS,
  MINUTE,
  addLocalDays,
  canCatchUp,
  floorLocal,
  formatClock,
  formatClockBare,
  formatDay,
  formatRange,
  formatTimeRange,
  localDayDiff,
  localDayKey,
  ms,
  nowRestLeft,
  parseWindowAt,
  programIndexAt,
  programWhen,
  shiftPrograms,
} from '../lib/epgTime';
import { archivePath, canBrowseArchive } from '../lib/archive';
import { playCatchup, playChannel } from '../lib/playback';
import { inlineStart, scrollLeftFor, scrollStart, timeStep, useIsRtl } from '../lib/rtl';
import { GuideUnavailableNotice } from './ChannelList';
import { ContextMenu } from './ContextMenu';
import { DigitOsd, type ZapFeedback } from './DigitOsd';
import { ScopePicker, type PickerSection } from './ScopePicker';
import { QualityEmptyState, useLiveQuality } from './QualityFilterButton';
import { EpgMappingDialog } from './EpgMappingDialog';
// recording:
import { ProgramActions, usePrefetchSchedule, useScheduleIndex } from '@/features/recording';
// sources: the state every page shows until a source exists.
import { NoSourcesState, useNoSourcesAdding } from '@/features/sources/components/NoSourcesState';
// guide (Run 2 C5): jump to a date and time, guide search.
import { GuideHeaderSearch } from '../guide/GuideSearchPanel';
import { JumpToDialog } from '../guide/JumpToDialog';
import { defaultGuideSource, rememberGuideSource } from '../guide/lastSource';
import { findChannelIndex, groupForHit } from '../guide/search';
import { isGuideHitState } from '../guide/programmeSearch';
import { createStickyTitleManager, updateGuideClock, GuideRow, type GuideRowHandlers, type GuideRowLabels } from '../guide/GuideRow';
import { createGuideHydrator } from '../guide/hydration';
import { attachGuideDragPan } from '../guide/dragPan';
import { nextGuideRenderWindow } from '../guide/renderWindow';
import { createGuideWheelScroller, guideWheelMotionAllowed, isWheelStep } from '../guide/wheelScroll';
import { GENRES, genreColor, genreOf, storedGenreFilter, storeGenreFilter, type Genre } from '../guide/genre';
import { GuidePreview, storedPreviewOpen, storePreviewOpen } from '../guide/GuidePreview';
import { useStable } from '../guide/useStable';
import { clampGuideZoom, GUIDE_ZOOM_SLOT_PX, storedGuideZoom, storeGuideZoom } from '../guide/zoom';
import { guideViewParam, parseGuideView, useGuideViewChannels, type GuideView } from '../guide/viewChannels';
import { prefetchProgramDescription, useProgramDescription } from '../guide/programDescription';

/** A guide row at 100 % UI scale and comfortable density; the page scales it (LG-18). */
export const GRID_ROW = 56;
/**
 * The part of {@link GRID_ROW} made of Tailwind spacing, which compact density tightens: the
 * cells' top-1 and bottom-1 insets and their py-1 (3.75 px each at the 15 px root).
 */
const GRID_ROW_SPACING = 15;
export const GRID_SLOT_MIN = 30;
export const GRID_SLOT_PX = 150;
export const GRID_WINDOW = 6 * HOUR;
export const GRID_CHUNK = 40;
const HEADER_H = 36;
/** How long a window's guide answer counts as fresh (also for the windows prefetched beside it). */
const GRID_STALE_MS = 5 * 60_000;
/** Keep adjacent programme slices ready for a return scroll. */
const GRID_CACHE_MS = 15 * 60_000;
/** Keep toolbar updates off the browser's scroll frames. Data-window crossings still publish at once. */
const GRID_VIEWPORT_PUBLISH_MS = 100;
/** Delay optional buffer replacement until a horizontal gesture settles. */
export const GRID_HORIZONTAL_IDLE_MS = 180;
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
 * Grid window length for a page `width` px wide: whole 30-minute slots (`slotPx` wide, the zoom
 * step's) that fill the track beside the channel column, never less than 6 h (wide screens and
 * zoomed-out scales get a longer window, not a gap).
 */
export function gridWindowFor(width: number, channelCol: number, slotPx: number = GRID_SLOT_PX): number {
  const slots = Math.ceil(Math.max(0, width - channelCol) / slotPx);
  return Math.max(GRID_WINDOW, slots * GRID_SLOT_MIN * MINUTE);
}

/** Time increment used by the guide's three-hour navigation controls. */
export const GRID_EXTEND = 3 * HOUR;
/** Fixed horizontal canvas: enough room for the full archive and future guide without resizing mid-gesture. */
export const GRID_TRACK_BEFORE = (MAX_LOOKBACK_HOURS + 6) * HOUR;
export const GRID_TRACK_AFTER = 14 * 24 * HOUR;
/** At rest, programme data extends at least six hours beyond either visible edge. */
export const GRID_DATA_STEP = 2 * GRID_EXTEND;
export const GRID_DATA_BEFORE = GRID_DATA_STEP;
export const GRID_DATA_LENGTH = 4 * GRID_DATA_STEP;
/** UTC-aligned data slices keep their six-hour buffer even across daylight-saving changes. */
export function guideDataStart(viewAt: number): number {
  return Math.floor(viewAt / GRID_DATA_STEP) * GRID_DATA_STEP - GRID_DATA_BEFORE;
}
export function guideDataLength(viewportMs: number): number {
  return Math.max(GRID_DATA_LENGTH, Math.ceil(viewportMs / GRID_DATA_STEP) * GRID_DATA_STEP + 2 * GRID_DATA_BEFORE + GRID_DATA_STEP);
}
/** Channel column of a phone-width guide: the logo and number only, so the track gets the room. */
export const GRID_CHANNEL_COMPACT = 72;

/**
 * Half the now pill's width in the ruler ("12:42 PM" at the 125 % UI scale) with a margin, in px:
 * the track keeps at least this much before now, so the pill is never cut by the channel column.
 */
export const NOW_PILL_LEAD_PX = 40;

/**
 * Where the track scrolls to when the guide opens on now (or Now is pressed), in px from the
 * window's `start`: the start of the local half hour now is in, so the visible track begins on a
 * slot line, its first label is whole, and rows start with whole cells instead of 60 px slivers;
 * the half hour before when now is so close to that line that its pill would be cut. A narrow
 * track keeps a quarter of its width before now instead (`view` px wide; 0: not measured yet).
 * See {@link nowRestLeft}.
 */
export function nowScroll(now: number, start: number, pxPerMin: number, view: number): number {
  return nowRestLeft(now, start, pxPerMin, view, NOW_PILL_LEAD_PX);
}

/** The times under the visible track, rounded outward to five minutes for a steady toolbar label. */
export function visibleGuideTime(start: number, scroll: number, width: number, channelCol: number, pxPerMin: number, end: number): Span {
  if (width <= channelCol) return [start, end];
  const step = 5 * MINUTE;
  const first = start + (Math.max(0, scroll) / pxPerMin) * MINUTE;
  const last = Math.min(end, first + ((width - channelCol) / pxPerMin) * MINUTE);
  return [Math.floor(first / step) * step, Math.min(end, Math.ceil(last / step) * step)];
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

/** "Yesterday", "Today" or "Tomorrow" in the UI language, capitalised. */
function relativeDay(diff: -1 | 0 | 1, lang: string): string {
  const rel = relativeTimeFormat(intlLocale(lang), { numeric: 'auto' }).format(diff, 'day');
  return `${rel.charAt(0).toLocaleUpperCase(lang)}${rel.slice(1)}`;
}

/**
 * A phone's window label: "Today", "Tomorrow" or "Yesterday" in the UI language, else the month
 * and day ("Oct 29"), which is no wider than those words, so the label keeps its width from day
 * to day. The ruler right under the toolbar shows the times, so the label only needs to name the day.
 */
export function shortDay(at: number, now: number, lang: string): string {
  const diff = localDayDiff(at, now);
  if (diff < -1 || diff > 1) return dateTimeFormat(intlLocale(lang), { month: 'short', day: 'numeric' }).format(at);
  return relativeDay(diff as -1 | 0 | 1, lang);
}

/** The programme after `program` in a channel's sorted list, if the guide has it. */
function nextProgram(list: readonly EpgProgram[] | undefined, program: EpgProgram): EpgProgram | undefined {
  const end = ms(program.end);
  return list?.find((p) => ms(p.start) >= end);
}

/** Half an hour before the current local :00/:30 slot (local, so +5:45 zones get :00/:30 columns too). */
export function defaultStart(now: number): number {
  return floorLocal(now, GRID_SLOT_MIN) - GRID_SLOT_MIN * MINUTE;
}

/**
 * Column labels: the day where the local date changes (midnight, or the first slot after a DST
 * jump over it), else the time, which names AM/PM on the hour only ("8:00 PM", "8:30"): the
 * period repeated on every half hour was noise. 24-hour locales are unchanged.
 */
export function slotLabels(slots: readonly number[], locale: string): string[] {
  return slots.map((s, i) => {
    if (i > 0 && localDayKey(s) !== localDayKey(slots[i - 1]!)) return formatDay(s, locale);
    return new Date(s).getMinutes() === 0 || i === 0 ? formatClock(s, locale) : formatClockBare(s, locale);
  });
}

interface Selection {
  channel: Channel;
  program: EpgProgram;
  /** The programme cell that opened the popover; the popover follows it while the grid scrolls. */
  anchor: HTMLElement;
}

/** Ctrl+scroll zooms at most one step this often (a trackpad pinch sends a burst of wheel events). */
export const WHEEL_ZOOM_MS = 150;
/** A physical wheel can report lines or pages instead of pixels. */
function wheelDeltaPx(delta: number, mode: number, pagePx: number): number {
  if (mode === WheelEvent.DOM_DELTA_LINE) return delta * 40;
  if (mode === WheelEvent.DOM_DELTA_PAGE) return delta * pagePx;
  return delta;
}
/** The pointer rests on a cell this long before the preview band follows it (CB-GUIDE-PREVIEW). */
export const PREVIEW_HOVER_MS = 150;

/** How long a channel row stays highlighted after a guide search hit moved the grid to it. */
export const HIGHLIGHT_MS = 3000;

/** A search hit the grid is moving to: its channel's row is looked up once the list is loaded. */
interface Reveal {
  key: ItemKey;
  ref: ItemRef;
  /** The hit's channel number: `paged.locate` finds the row in a few reads with it (LV-2). */
  number: number | undefined;
  /** Display time of the hit's start; the keyboard cursor lands on it. */
  time: number;
  channelName: string;
  /** The group the list must show before the lookup (undefined: all channels). */
  categoryId: string | undefined;
  /** Opening on the playing channel (LG-01): no toast when it is not in the list. */
  quiet?: boolean;
}

/**
 * How long scrolling must pause before the URL follows the browser's native position.
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
const NO_REFS: ItemRef[] = [];
/** The args of a disabled `catalog.item` query (nothing playing). */
const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };

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

/** Each refs array's grid key hash, with the window it was for. */
const gridHashes = new WeakMap<readonly ItemRef[], { from: string; to: string; hash: string }>();

/**
 * TanStack's own hash of a {@link gridArgs} key, so prefetches and readers share the entry, worked
 * out once per refs array and window (P2-GUIDE-6). The page renders on every scroll frame and
 * looks its chunks up four times in each render: hashing 40 refs per lookup showed in a fling's profile.
 */
function gridKeyHash(key: QueryKey): string {
  const args = key[1] as Partial<ReturnType<typeof gridArgs>> | null | undefined;
  if (!args?.refs || args.from === undefined || args.to === undefined) return hashKey(key);
  const hit = gridHashes.get(args.refs);
  if (hit && hit.from === args.from && hit.to === args.to) return hit.hash;
  const hash = hashKey(key);
  gridHashes.set(args.refs, { from: args.from, to: args.to, hash });
  return hash;
}

const refKeySets = new WeakMap<readonly ItemRef[], ReadonlySet<ItemKey>>();
/** The item keys of a chunk's refs, made once per refs array. */
function refKeys(refs: readonly ItemRef[]): ReadonlySet<ItemKey> {
  let keys = refKeySets.get(refs);
  if (!keys) {
    keys = new Set(refs.map(itemKey));
    refKeySets.set(refs, keys);
  }
  return keys;
}

/** The length of the window the guide last laid out this session (0 until one was): it follows the page width. */
let lastWindowMs = 0;

/**
 * The first chunk's `epg.grid` for a guide about to open at `params` on these rows (its first
 * channel page), with the arguments the page will ask with once laid out, if it lays out as wide
 * as last time. The boot and navigation prefetch call it (`setGuideGridPrefetch`), so on a return
 * to the guide the grid loads with the channels instead of after the page has rendered and
 * measured itself.
 */
function prefetchFirstChunk(refs: ItemRef[], params: URLSearchParams, settings: Settings | undefined): void {
  if (lastWindowMs <= 0) return;
  const start = guideDataStart(parseWindowAt(params.get('at')) ?? defaultStart(Date.now()));
  const offsetMs = displayPrefsOf(settings).epgOffsetMinutes * MINUTE;
  const args = gridArgs(refs.slice(0, GRID_CHUNK), new Date(start - offsetMs).toISOString(), new Date(start + lastWindowMs - offsetMs).toISOString());
  void appQueryClient.prefetchQuery({ queryKey: rpcKey('epg.grid', args), queryFn: () => rpcRaw('epg.grid', args), staleTime: GRID_STALE_MS });
}
setGuideGridPrefetch(prefetchFirstChunk);

/** A window `[from, to)` an answer of the grid is for. */
type Span = readonly [number, number];

/** Multi-channel guide: virtualized channel rows x 30-minute columns over a window of at least 6 h that fills the page width. */
export function EpgGridPage() {
  const { t, i18n } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const now = useNow(30_000);
  const prefs = useDisplayPrefs();
  const wide = useMediaQuery('(min-width: 1024px)');
  // Phones: a logo-and-number column, so the track shows more than one slot beside it.
  const compact = !useMediaQuery(`(min-width: ${GUIDE_BAR_STACK_PX}px)`);
  // LG-18: the column, the rows and the ruler follow the UI scale (and compact density tightens
  // the rows), like Live's list: at 125 % the old fixed 56 px rows clipped their two lines.
  const channelCol = useScaledPx(compact ? GRID_CHANNEL_COMPACT : wide ? 220 : 168);
  const rowH = useRowHeight(GRID_ROW, GRID_ROW_SPACING);
  const headerH = useScaledPx(HEADER_H);
  const rtl = useIsRtl();
  // The time scale: the zoom step's px per 30-minute slot (toolbar buttons, Ctrl+scroll).
  const [zoom, setZoom] = useState(storedGuideZoom);
  const slotPx = GUIDE_ZOOM_SLOT_PX[zoom] ?? GRID_SLOT_PX;
  const pxPerMin = slotPx / GRID_SLOT_MIN;
  const queryClient = useQueryClient();
  const [prefetchVersion, setPrefetchVersion] = useState(0);
  // Reminders, recordings, rules and recording support load with the page (L2-guide-library-15).
  const schedule = useScheduleIndex();
  usePrefetchSchedule();

  const sources = useRpcQuery('sources.list', undefined);
  // The no-source state stays while its add dialog is open: the new source is listed before its
  // import runs, and the grid taking over then would close the dialog mid-import.
  const adding = useNoSourcesAdding();
  // LG-11: the guide is for live channels; a source with only films and series is not offered.
  // (An older core or a test without counts keeps every source.)
  const liveSources = useMemo(() => sources.data?.filter((s) => s.channelCount !== 0), [sources.data]);
  const sourceId = params.get('source') ?? defaultGuideSource(liveSources) ?? '';
  useEffect(() => rememberGuideSource(sourceId), [sourceId]);
  const categoryId = params.get('category') ?? undefined;
  // Favorites or a custom list instead of a group (`view`); its channels of this source only.
  const viewParam = params.get('view');
  const view = useMemo(() => parseGuideView(viewParam), [viewParam]);
  const lists = useRpcQuery('lists.list', undefined, { staleTime: 60_000 });
  const source = sources.data?.find((s) => s.id === sourceId);
  const kind: SourceKind | undefined = source?.kind;
  const categories = useRpcQuery('catalog.categories', guideCategoriesArgs(sourceId), { enabled: !!sourceId });

  // ---- the window ----------------------------------------------------------
  // The browser owns the visible time through scrollLeft. Explicit jumps add a URL history entry;
  // scrolling updates the URL only after it settles. Without `at` the guide opens at now and
  // follows it until the user moves the viewport.
  const atParam = parseWindowAt(params.get('at'));
  const [winAt, setWinAt] = useState(atParam);
  const [nowStart, setNowStart] = useState(() => defaultStart(Date.now()));
  // This anchor changes only for an explicit jump outside the canvas. URL updates from scrolling
  // and guide data responses cannot move the native track underneath an ongoing gesture.
  const [trackBase, setTrackBase] = useState(atParam ?? nowStart);
  const [requestedView, setRequestedView] = useState<{ id: number; time: number; live: boolean } | null>(null);
  const requestId = useRef(0);
  const viewAtRef = useRef(atParam ?? nowStart);
  const manualView = useRef(false);
  const navigationAt = useRef(atParam ?? nowStart);
  // A URL change that is not the echo of a write (back, forward, a link) moves the window.
  const [urlSeen, setUrlSeen] = useState(atParam);
  const urlOwner = useRef(Math.random().toString(36).slice(2));
  if (atParam !== urlSeen) {
    // The router may commit replaces out of order. Navigation state identifies writes made by
    // this page; POP still restores the time even when it returns to one of our own entries.
    const ownWrite = navigationType !== 'POP' &&
      (location.state as { guideUrlOwner?: string } | null)?.guideUrlOwner === urlOwner.current;
    setUrlSeen(atParam);
    if (!ownWrite) {
      const target = atParam ?? defaultStart(Date.now());
      setWinAt(atParam);
      manualView.current = false;
      navigationAt.current = target;
      if (target < trackBase - GRID_TRACK_BEFORE + 6 * HOUR || target > trackBase + GRID_TRACK_AFTER - 6 * HOUR) setTrackBase(target);
      setRequestedView({ id: ++requestId.current, time: target, live: atParam === null });
    }
  }
  const baseStart = winAt ?? nowStart;
  const [measurePage, pageWidth, pageMeasured] = useElementWidth();
  const baseWindowMs = gridWindowFor(pageWidth, channelCol, slotPx);
  const start = trackBase - GRID_TRACK_BEFORE;
  const end = trackBase + GRID_TRACK_AFTER;
  const [shownTime, setShownTime] = useState<Span>([baseStart, baseStart + baseWindowMs]);
  const [renderWindow, setRenderWindow] = useState(() => nextGuideRenderWindow(baseStart, baseStart + baseWindowMs));
  const renderWindowRef = useRef(renderWindow);
  const renderWindowGeometry = useRef<{ width: number; pxPerMin: number; channelCol: number } | null>(null);
  // Every row, slot and marker uses one fixed position on the native horizontal track.
  // Data may change while scrolling, but neither the track width nor its origin changes.
  const origin = start;
  const trackWidth = ((end - start) / MINUTE) * pxPerMin;
  // A rolling 24-hour programme slice extends at least six hours beyond each viewport edge.
  // It advances only every six hours, and never changes the native track's geometry.
  const viewportMs = ((Math.max(0, pageWidth - channelCol) / pxPerMin) * MINUTE);
  const dataWindowMs = guideDataLength(viewportMs);
  useEffect(() => {
    if (pageMeasured) lastWindowMs = dataWindowMs;
  }, [pageMeasured, dataWindowMs]);
  const wantedDataStart = guideDataStart(shownTime[0]);
  const wantedDataEnd = wantedDataStart + dataWindowMs;
  const horizontalScrolling = useRef(false);
  const [bufferStart, setBufferStart] = useState(wantedDataStart);
  const dataStart = bufferStart;
  const dataEnd = dataStart + dataWindowMs;
  useEffect(() => {
    if (wantedDataStart === dataStart) return;
    // Replenish with six hours of lead time. New offscreen chunks share a frame budget;
    // waiting until the last hour would force them all to mount when fast scrolling arrives.
    if (!horizontalScrolling.current || shownTime[0] < dataStart + GRID_DATA_BEFORE || shownTime[1] > dataEnd - GRID_DATA_BEFORE) {
      setBufferStart(wantedDataStart);
    }
  }, [shownTime, wantedDataStart, dataStart, dataEnd]);

  // A view pages nothing from the source: the source's own list stays idle meanwhile.
  const sourcePaged = usePagedChannels({ sourceId: view ? '' : sourceId, categoryId, withExtras: false });
  const viewPaged = useGuideViewChannels(view, sourceId);
  const paged = viewPaged ?? sourcePaged;
  const count = paged.total ?? 0;
  // The Live TV quality filter applies here too; a guide it empties says so (Live sets it).
  const quality = useLiveQuality();

  // ---- what plays, the genre filter, the preview band ----------------------------
  // Subscribe to the source itself: switching catch-up programmes on one channel must update its cell.
  const playingSource = usePlayerStore((s) => s.source);
  const playingRef = playingSource?.ref;
  const playingKey = playingRef && playingRef.contentType === 'live' ? itemKey(playingRef) : null;
  // Its catalog row says whether a group on screen holds it and gives "Go to playing" its number,
  // so the row is found in a few page reads (a view knows its entries itself).
  const playingHere = !!playingKey && playingRef?.sourceId === sourceId;
  const playingItem = useRpcQuery('catalog.item', { ref: playingRef ?? NO_REF }, { enabled: playingHere && !view, staleTime: 5 * 60_000 });
  const playingChannel = playingHere && playingItem.data && 'isRadio' in playingItem.data ? (playingItem.data as Channel) : undefined;
  // CB-GUIDE-GENRE: the genre the cells are filtered to, remembered between visits.
  const [genreFilter, setGenreFilterState] = useState<Genre | null>(storedGenreFilter);
  // What the filter did, for screen readers: the cells only dim, which they do not see. The count
  // is of the window's programmes in the rows whose guide is in.
  const [genreNote, setGenreNote] = useState('');
  const setGenreFilter = useStable((g: Genre | null) => {
    storeGenreFilter(g);
    setGenreFilterState(g);
    if (!g) {
      setGenreNote(tg('genreFilterOff'));
      return;
    }
    // Only rows in memory can have programmes: walking every row of a 50k-channel guide probed
    // the query cache for each one outside the loaded pages, about 150 ms inside the click.
    let matching = 0;
    for (const { index } of paged.loaded) {
      for (const p of windowPrograms(index)) if (genreOf(p.category) === g) matching++;
    }
    setGenreNote(tg('genreFilterOn', { genre: tg(`genre_${g}`), count: matching }));
  });
  // The cells name their genre (CB-GUIDE-GENRE), so a filtered guide reads as it looks.
  const genreNames = useMemo(() => Object.fromEntries(GENRES.map((g) => [g, tg(`genre_${g}`)])) as Record<Genre, string>, [tg]);
  const rowLabels = useMemo<GuideRowLabels>(
    () => ({
      onNow: t('onNow'),
      archive: t('archive'),
      playingNow: t('playingNow'),
      noGuideShort: t('noGuideShort'),
      playChannel: (name) => t('playChannel', { name }),
    }),
    [t],
  );
  // CB-GUIDE-PREVIEW: from md up, on a window tall enough to keep a useful grid under the band.
  // Until the user opens or hides it, it is open only from 1000 px tall: on a laptop's 900 it
  // cost the grid three or four rows.
  const bandWide = useMediaQuery('(min-width: 768px)');
  const bandTall = useMediaQuery('(min-height: 700px)');
  const bandRoomy = useMediaQuery('(min-height: 1000px)');
  const bandFits = bandWide && bandTall;
  const [previewChoice, setPreviewChoice] = useState(storedPreviewOpen);
  const previewOpen = previewChoice ?? bandRoomy;
  const togglePreview = useStable(() => {
    storePreviewOpen(!previewOpen);
    setPreviewChoice(!previewOpen);
  });
  const showPreview = bandFits && previewOpen;

  // ---- virtual rows + chunked grid data --------------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useListVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 6,
    scrollPaddingStart: headerH,
    initialRect: { width: 1200, height: 720 },
  });
  // A new scale or density: drop the cached row sizes so every row takes the new height.
  const measuredRow = useRef(rowH);
  useLayoutEffect(() => {
    if (measuredRow.current === rowH) return;
    measuredRow.current = rowH;
    virtualizer.measure();
  }, [rowH, virtualizer]);
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

  // A view (favorites, a list) knows each row's ref before its channel arrives: its chunk is
  // asked once with every ref, not again as each batch of `catalog.item` answers lands. A chunk's
  // refs stay the same array while its rows hold the same refs, so its keys hash once, and a
  // render reads them once: during a fling every row outside the observed pages looks its page up
  // in the query cache, hashing that page's key, on each read (P2-GUIDE-6).
  const chunkRefsSeen = useRef(new Map<number, ItemRef[]>());
  const chunkRefsRead = new Map<number, ItemRef[]>();
  const chunkRefs = (c: number) => {
    const read = chunkRefsRead.get(c);
    if (read) return read;
    const refs: ItemRef[] = [];
    for (let i = c * GRID_CHUNK; i < Math.min(count, (c + 1) * GRID_CHUNK); i++) {
      const ref = paged.refAt ? paged.refAt(i) : paged.getChannel(i)?.ref;
      if (ref) refs.push(ref);
    }
    const seen = chunkRefsSeen.current.get(c);
    const out = seen && seen.length === refs.length && seen.every((r, i) => r === refs[i]) ? seen : refs;
    chunkRefsSeen.current.set(c, out);
    chunkRefsRead.set(c, out);
    return out;
  };
  const chunkCached = (c: number) => {
    const refs = chunkRefs(c);
    return refs.length > 0 && queryClient.getQueryCache().get(gridKeyHash(rpcKey('epg.grid', gridArgs(refs, fromIso, toIso))))?.state.data !== undefined;
  };
  // The chunks on screen, and the ones asked for: those follow once the visible chunk settles.
  const viewA = Math.floor(first / GRID_CHUNK);
  const viewB = Math.floor(last / GRID_CHUNK);
  const listKey = `${sourceId}|${categoryId ?? ''}|${viewParam ?? ''}`;
  const [settled, setSettled] = useState({ key: listKey, a: viewA, b: viewB });
  const atRest = settled.key === listKey && settled.a === viewA && settled.b === viewB;
  const { a: chunkA, b: chunkB } = shownChunks({ a: viewA, b: viewB }, settled, atRest || settled.key !== listKey, chunkCached);
  const lastChunkMove = useRef(0);
  /** The last vertical scroll event: when, where, and how fast (px/ms) since the one before. */
  const vScroll = useRef({ t: Number.NEGATIVE_INFINITY, y: 0, v: Number.POSITIVE_INFINITY });
  const verticalIdleTimer = useRef(0);
  const [verticalIdleVersion, setVerticalIdleVersion] = useState(0);
  useEffect(() => () => window.clearTimeout(verticalIdleTimer.current), []);
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
  const refsB = chunkB !== chunkA ? chunkRefs(chunkB) : NO_REFS;
  // The previous answer stays while the next chunk or window loads (keepPrevious): rows it
  // covers keep their programmes and the no-guide notice does not blink. Rows it does not
  // cover show as loading (see `programsFor`). Nothing is asked before the page is measured: the
  // first measurement sets the window's length (L2-perf-desktop-12).
  const gridA = useRpcQuery('epg.grid', gridArgs(refsA, fromIso, toIso), { enabled: pageMeasured && refsA.length > 0, staleTime: GRID_STALE_MS, gcTime: GRID_CACHE_MS, keepPrevious: true, queryKeyHashFn: gridKeyHash });
  const gridB = useRpcQuery('epg.grid', gridArgs(refsB, fromIso, toIso), { enabled: pageMeasured && refsB.length > 0, staleTime: GRID_STALE_MS, gcTime: GRID_CACHE_MS, keepPrevious: true, queryKeyHashFn: gridKeyHash });
  const keysA = refKeys(refsA);
  const keysB = refKeys(refsB);

  // At rest, the chunks above and below are fetched ahead, so the next rows arrive drawn.
  const prefetchChunk = useStable((c: number) => {
    if (c < 0 || c * GRID_CHUNK >= count) return;
    const refs = chunkRefs(c);
    // A chunk whose channels are not all loaded yet would be asked again once they are.
    if (refs.length < Math.min(GRID_CHUNK, count - c * GRID_CHUNK)) return;
    const args = gridArgs(refs, fromIso, toIso);
    void queryClient.prefetchQuery({ queryKey: rpcKey('epg.grid', args), queryFn: () => rpcRaw('epg.grid', args), staleTime: GRID_STALE_MS, gcTime: GRID_CACHE_MS });
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

  // Per-channel provider requests follow the visible rows once they hold still: a fling would
  // otherwise queue calls for rows it has already passed (LV-4).
  const rowsShown = vItems.length > 0;
  const [shortRows, setShortRows] = useState({ first, last, shown: rowsShown });
  useEffect(() => {
    if (shortRows.first === first && shortRows.last === last && shortRows.shown === rowsShown) return;
    // The first rows on screen ask at once; later moves wait for the rows to hold still.
    if (!shortRows.shown) return setShortRows({ first, last, shown: rowsShown });
    const id = window.setTimeout(() => setShortRows({ first, last, shown: rowsShown }), SHORT_EPG_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [first, last, rowsShown, shortRows]);

  // Stalker: the portal's own guide for the visible rows, laid over the XMLTV grid. Archive
  // channels also get the archived past of the window (`from`), so earlier rows and catch-up
  // work without XMLTV; the others keep the plain airing-onwards answer.
  const isStalker = kind === 'stalker';
  const { getChannel } = paged;
  const [plainRefs, archiveRefs] = useMemo(() => {
    const plain: ItemRef[] = [];
    const archive: ItemRef[] = [];
    if (!isStalker) return [plain, archive];
    for (let i = shortRows.first; i <= shortRows.last; i++) {
      const ch = getChannel(i);
      if (ch) (ch.archive?.enabled ? archive : plain).push(ch.ref);
    }
    return [plain, archive];
  }, [isStalker, shortRows, getChannel]);
  const portalLimit = stalkerGridLimit(dataEnd - dataStart);
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
  // A fast fling may outrun the exact six-hour slice while its RPC is still pending. Any
  // cached slice for these exact channel chunks that covers the visible viewport can supply
  // the cells meanwhile. The cache search runs once per render, not once per row.
  const outerShift = dataWindowMs - GRID_DATA_STEP;
  const refSignatures = new Set([refsA, refsB].filter((refs) => refs.length > 0).map((refs) => refs.map(itemKey).join('|')));
  const cachedAnswers = (gridsLoaded ? [] : queryClient.getQueriesData<Record<ItemKey, EpgProgram[]>>({ queryKey: ['epg.grid'] }))
    .flatMap(([key, data]) => {
      const args = key[1] as ReturnType<typeof gridArgs> | undefined;
      if (!data || !args || !refSignatures.has(args.refs.map(itemKey).join('|')) || args.withDescription !== false) return [];
      const span = [Date.parse(args.from) + offsetMs, Date.parse(args.to) + offsetMs] as Span;
      // Different EPG offsets can leave answers for the same refs in the cache. Only a slice
      // aligned with this view's six-hour grid belongs to its current offset.
      return span[1] - span[0] === dataWindowMs && (span[0] - dataStart) % GRID_DATA_STEP === 0 &&
        span[0] <= shownTime[0] && span[1] >= shownTime[1] ? [{ data, span }] : [];
    })
    .sort((a, b) => Math.abs(a.span[0] - dataStart) - Math.abs(b.span[0] - dataStart));
  // A fast scroll can land before its full 40-channel / 24-hour answer is ready. Ask only for
  // the rows actually on screen and the nearby hours, so those tiles do not wait behind the
  // full slice. The short idle delay avoids issuing a request for every position in a fling.
  const visibleTop = virtualizer.scrollOffset ?? 0;
  // The virtualizer already observes this size. Reading clientHeight during React renders can
  // force layout of newly mounted rows in the middle of a vertical scroll.
  const visibleBottom = visibleTop + (virtualizer.scrollRect?.height || 720);
  const visibleRefs = vItems
    .filter((v) => v.start + v.size >= visibleTop && v.start <= visibleBottom)
    .map((v) => paged.getChannel(v.index)?.ref)
    .filter((ref): ref is ItemRef => !!ref);
  const missingVisible = visibleRefs.some((ref) => {
    const k = itemKey(ref);
    const current = answers.some(({ q, span }) =>
      !!q.data && !!span && span[0] <= shownTime[0] && span[1] >= shownTime[1] && Object.prototype.hasOwnProperty.call(q.data, k));
    return !current && !cachedAnswers.some(({ data }) => Object.prototype.hasOwnProperty.call(data, k));
  });
  const quickStart = Math.floor(shownTime[0] / GRID_EXTEND) * GRID_EXTEND - GRID_EXTEND;
  const quickEnd = Math.ceil(shownTime[1] / GRID_EXTEND) * GRID_EXTEND + GRID_EXTEND;
  const quickKey = `${listKey}|${quickStart}|${quickEnd}|${visibleRefs.map(itemKey).join('|')}`;
  const [quickRequest, setQuickRequest] = useState<{ key: string; start: number; end: number; refs: ItemRef[] } | null>(null);
  useEffect(() => {
    if (!pageMeasured || !missingVisible || visibleRefs.length === 0) return;
    const id = window.setTimeout(() => setQuickRequest({ key: quickKey, start: quickStart, end: quickEnd, refs: visibleRefs }), GRID_SCROLL_IDLE_MS);
    return () => window.clearTimeout(id);
  }, [pageMeasured, quickKey, missingVisible]); // eslint-disable-line react-hooks/exhaustive-deps
  const quickCurrent = quickRequest?.key === quickKey;
  const quickArgs = gridArgs(
    quickRequest?.refs ?? [],
    new Date((quickRequest?.start ?? quickStart) - offsetMs).toISOString(),
    new Date((quickRequest?.end ?? quickEnd) - offsetMs).toISOString(),
  );
  const quickGrid = useRpcQuery('epg.grid', quickArgs, {
    enabled: pageMeasured && quickCurrent && missingVisible,
    staleTime: GRID_STALE_MS,
    gcTime: GRID_CACHE_MS,
    keepPrevious: true,
  });
  // A small move can change the request's bucket or visible row set while its previous answer
  // still covers the screen. Retain that answer, with its actual query span, until replaced.
  const quickSpan = useRef<Span | null>(null);
  if (quickGrid.data && !quickGrid.isPlaceholderData) quickSpan.current = [Date.parse(quickArgs.from), Date.parse(quickArgs.to)];
  /**
   * A row's XMLTV programmes, and whether they are the answer for the window on screen (`fresh`).
   * While that answer loads, the row keeps what an answer for an overlapping window said (the
   * window before a move, or the placeholder standing in): the same arrays, so a memoised row
   * holds still through a window move. undefined while loading, [] when the guide has none.
   */
  const gridEntry = (k: ItemKey): { list: EpgProgram[] | undefined; fresh: boolean } => {
    for (const { q, keys, span } of answers) {
      if (!q.data || !span || !(span[0] < shownTime[1] && span[1] > shownTime[0])) continue;
      const list = q.data[k];
      const own = !q.isPlaceholderData;
      if (own && span[0] === dataStart && span[1] === dataEnd && (list || keys.has(k))) return { list: list ?? NO_PROGRAMS, fresh: true };
    }
    // A rolling query's previous answer often still covers the entire screen. Keep its
    // existing tiles until the replacement arrives, instead of switching to a distant
    // prefetched slice and rebuilding the row twice for one navigation.
    for (const { q, span } of answers) {
      if (q.data && span && span[0] <= shownTime[0] && span[1] >= shownTime[1] && Object.prototype.hasOwnProperty.call(q.data, k)) {
        return { list: q.data[k] ?? NO_PROGRAMS, fresh: false };
      }
    }
    for (const { data } of cachedAnswers) {
      if (Object.prototype.hasOwnProperty.call(data, k)) return { list: data[k] ?? NO_PROGRAMS, fresh: true };
    }
    if (quickGrid.data && quickSpan.current && quickSpan.current[0] + offsetMs <= shownTime[0] && quickSpan.current[1] + offsetMs >= shownTime[1] &&
        Object.prototype.hasOwnProperty.call(quickGrid.data, k)) {
      return { list: quickGrid.data[k] ?? NO_PROGRAMS, fresh: false };
    }
    for (const { q, keys, span } of answers) {
      if (!q.data || !span || !(span[0] < shownTime[1] && span[1] > shownTime[0])) continue;
      if (q.data[k]) return { list: q.data[k], fresh: false };
      if (!q.isPlaceholderData && keys.has(k)) return { list: NO_PROGRAMS, fresh: false };
    }
    return { list: undefined, fresh: false };
  };
  const gridList = (k: ItemKey): EpgProgram[] | undefined => gridEntry(k).list;
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
  }, [shortEpgOn, shortRows, getChannel, gridA.data, gridB.data, gridA.isPlaceholderData, gridB.isPlaceholderData, quickGrid.data, shownTime, dataStart, dataEnd, prefetchVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const shortFor = useShortEpgPreviews(sourceId, shortEpgOn, shortRefs, now);
  const hasShortData = shortRefs.some((r) => (shortFor(r)?.length ?? 0) > 0);
  // Xtream's simple data table can reach days before the bulk XMLTV download. Warm visible rows
  // when XMLTV has a gap within the six-hour scroll buffer, before a horizontal move exposes it.
  // A vertical fling still drops queued offscreen calls; at most two are in flight.
  const xtreamOn = kind === 'xtream';
  const xtreamRefs = useMemo(() => {
    const out: ItemRef[] = [];
    if (!xtreamOn || !pageMeasured || dataStart !== wantedDataStart || dataEnd !== wantedDataEnd ||
        shortRows.first !== first || shortRows.last !== last) return out;
    const probeStart = Math.max(dataStart, shownTime[0] - GRID_DATA_BEFORE) - offsetMs;
    const probeEnd = Math.min(dataEnd, shownTime[1] + GRID_DATA_BEFORE) - offsetMs;
    // This endpoint is the archive table; a future-only window gains nothing from it.
    if (probeStart >= now) return out;
    for (let i = shortRows.first; i <= shortRows.last; i++) {
      const ch = getChannel(i);
      if (!ch) continue;
      const entry = gridEntry(itemKey(ch.ref));
      if (entry.fresh && hasGuideGap(entry.list ?? NO_PROGRAMS, probeStart, probeEnd)) out.push(ch.ref);
    }
    return out;
    // gridEntry reads the two grid answers and their windows.
  }, [xtreamOn, pageMeasured, dataStart, dataEnd, wantedDataStart, wantedDataEnd, shortRows, first, last, shownTime, offsetMs, now, getChannel,
    gridA.data, gridB.data, gridA.isPlaceholderData, gridB.isPlaceholderData, prefetchVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const xtreamFor = useXtreamGridPrograms(sourceId, xtreamOn, xtreamRefs, now);
  const hasXtreamData = xtreamRefs.some((ref) => {
    const programs = xtreamFor(ref);
    return !!programs && hasProgramInRange(programs, shownTime[0] - offsetMs, shownTime[1] - offsetMs);
  });
  // Each row's display list is kept while its sources are the same objects, so a memoised row
  // sees the same array from render to render (L2-perf-ui-1).
  const programsCache = useRef(new Map<ItemKey, { list?: EpgProgram[]; portal?: EpgProgram[]; xtream?: EpgProgram[]; short?: readonly EpgProgram[]; offset: number; start: number; end: number; out: EpgProgram[] | undefined }>());
  const programsFor = (ch: Channel | undefined): EpgProgram[] | undefined => {
    if (!ch) return undefined;
    const k = itemKey(ch.ref);
    const list = gridList(k);
    const portal = isStalker ? (ch.archive?.enabled ? archivePortal : plainPortal).get(ch.ref) : undefined;
    const xtream = xtreamFor(ch.ref);
    // guide: an empty XMLTV row takes the provider's short guide.
    const short = !(portal && portal.length > 0) && shortEpgOn && list?.length === 0 ? shortFor(ch.ref) : undefined;
    const offset = prefs.epgOffsetMinutes;
    const tableStart = xtream?.length ? dataStart : 0;
    const tableEnd = xtream?.length ? dataEnd : 0;
    const cache = programsCache.current;
    const hit = cache.get(k);
    if (hit && hit.list === list && hit.portal === portal && hit.xtream === xtream && hit.short === short && hit.offset === offset && hit.start === tableStart && hit.end === tableEnd) return hit.out;
    let out: EpgProgram[] | undefined;
    // The portal's programmes are the provider's guide (no series rules, no guide search).
    if (portal && portal.length > 0) out = shiftPrograms(mergePrograms(markFromProvider(portal), list ?? []), offset);
    else if (xtream && xtream.length > 0) {
      // The table may contain weeks of listings. Select only the rolling data window;
      // programme groups prepare its new edges without changing the native track.
      const provider = markFromProvider(programsInRange(xtream, dataStart - offsetMs, dataEnd - offsetMs));
      out = shiftPrograms(mergePrograms(list ?? [], short?.length ? mergePrograms(provider, short) : provider), offset);
    }
    else if (short && short.length > 0) out = shiftPrograms([...short], offset);
    else if (list) out = list.length === 0 ? NO_PROGRAMS : shiftPrograms([...list].sort((a, b) => ms(a.start) - ms(b.start)), offset);
    if (cache.size >= PROGRAMS_CACHE_MAX) cache.clear();
    cache.set(k, { list, portal, xtream, short, offset, start: tableStart, end: tableEnd, out });
    return out;
  };
  const gridError = gridA.error ?? gridB.error;
  // Guides hold programmes, yet none of these channels matched one: the way out is matching a
  // channel to its guide channel, not adding another XMLTV address.
  const guides = useRpcQuery('epg.sources', undefined, { staleTime: 60_000 });
  const guidesLoaded = !!guides.data?.some((g) => g.enabled && g.programCount > 0);
  // A moved window can briefly hold the previous empty XMLTV answer while its new one loads.
  // Xtream also has per-channel table/short-guide work in flight. Neither is proof that the
  // visible time is empty until every row and requested provider answer has settled.
  const xtreamGuideSettled = !xtreamOn || (
    pageMeasured && dataStart === wantedDataStart && dataEnd === wantedDataEnd &&
    shortRows.first === first && shortRows.last === last &&
    vItems.every((v) => {
      const ch = getChannel(v.index);
      return !!ch && gridEntry(itemKey(ch.ref)).fresh;
    }) &&
    xtreamRefs.every((ref) => xtreamFor(ref) !== undefined) &&
    shortRefs.every((ref) => shortFor(ref) !== undefined)
  );
  const noEpgAnywhere =
    !isStalker &&
    gridsLoaded &&
    xtreamGuideSettled &&
    !hasShortData && // guide
    !hasXtreamData &&
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
    setParams(next, { replace, state: { guideUrlOwner: urlOwner.current } });
  };
  /** Explicit navigation can re-centre the fixed canvas, but a wheel gesture never does. */
  const requestView = (time: number, live: boolean) => {
    const recenter = time < start + 6 * HOUR || time > end - 6 * HOUR;
    const root = scroller.current;
    // An existing native canvas can move in the input handler. Waiting for a React commit
    // made the scroll compete with router updates and programme-buffer replacement.
    if (!recenter && root && laidRoot.current === root && laidTrack.current === trackBase && laidPx.current === pxPerMin && laidRtl.current === rtl) {
      const target = live ? time + nowScroll(now, time, pxPerMin, (viewWidth.current || pageWidth) - channelCol) / pxPerMin * MINUTE : time;
      moveViewTo(target, root, false, true);
    } else {
      if (recenter) setTrackBase(time);
      setRequestedView({ id: ++requestId.current, time, live });
    }
  };
  /** Moves the window to `at` (floored to its slot), with a new history entry. `category: null` also shows all channels. */
  const goTo = useStable((at: number, opts: { category?: null } = {}) => {
    const slot = floorLocal(at, GRID_SLOT_MIN);
    startRef.current = slot - GRID_TRACK_BEFORE;
    navigationAt.current = slot;
    setWinAt(slot);
    requestView(slot, false);
    writeUrl((p) => {
      if (opts.category === null) {
        p.delete('category');
        p.delete('view');
        p.delete('focus');
      }
    }, slot, false);
  });
  /** Keep the URL near the visible time without making router renders part of a wheel gesture. */
  const settleScrollUrl = (time: number) => {
    const slot = floorLocal(time, GRID_SLOT_MIN);
    navigationAt.current = slot;
    window.clearTimeout(urlTimer.current);
    const base = latestParams.current.toString();
    urlTimer.current = window.setTimeout(() => {
      if (latestParams.current.toString() === base) writeUrl(() => undefined, slot, true);
    }, GRID_URL_SETTLE_MS);
  };
  const shift = useStable((delta: number) => goTo(navigationAt.current + delta));
  // A calendar day, not 24 h: across a DST change the window keeps its wall-clock time.
  const shiftDay = useStable((days: number) => goTo(addLocalDays(navigationAt.current, days)));
  const toNow = useStable(() => {
    const s = defaultStart(Date.now());
    manualView.current = false;
    setNowStart(s);
    startRef.current = s - GRID_TRACK_BEFORE;
    navigationAt.current = s;
    setWinAt(null);
    requestView(s, true);
    window.clearTimeout(urlTimer.current);
    if (latestParams.current.has('at')) writeUrl(() => undefined, null, false);
  });
  // Back to an entry without `at` (or a link without it): the window follows now again.
  const followsNow = winAt === null && !manualView.current;
  useEffect(() => {
    if (followsNow) setNowStart(defaultStart(Date.now()));
  }, [followsNow]);
  const setQuery = useStable((key: string, value: string | undefined) => {
    writeUrl(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        // `focus` (LG-01) opened the guide at a channel of the list it came with: another source,
        // group or view starts at its top, and must not jump back to that channel (or to a channel
        // of another source with the same id).
        p.delete('focus');
        if (key === 'source') p.delete('category');
        // A group and a view replace each other; a view stays on another source.
        if (key === 'category') p.delete('view');
        if (key === 'view') p.delete('category');
      },
      manualView.current ? floorLocal(viewAtRef.current, GRID_SLOT_MIN) : winAt === null ? null : navigationAt.current,
      true,
    );
  });

  // ---- keyboard cursor ------------------------------------------------------
  const [cursor, setCursor] = useState<{ row: number; time: number }>({ row: 0, time: now });
  const focusPending = useRef(false);
  const windowPrograms = (row: number) => (programsFor(paged.getChannel(row)) ?? []).filter((p) => ms(p.end) > dataStart && ms(p.start) < dataEnd);
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
    return !!ch && dataStart === wantedDataStart && dataEnd === wantedDataEnd && (gridEntry(itemKey(ch.ref)).fresh || !!gridError);
  };

  // Key repeat can outrun renders: keys read the cursor from here, not from a stale render.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** The element in the grid that last had focus, to notice when a re-render removes it. */
  const lastFocused = useRef<HTMLElement | null>(null);
  /** The cell the cursor is on; null while its row's guide for this window is still loading. */
  const cursorElement = (row: number, time: number) => {
    const p = cursorProgram(row, time);
    // A programme already in the overlapping cached slice remains valid while the next slice
    // loads. Only an absent programme needs to wait for the new answer.
    if (!p && !rowReady(row)) return null;
    const sel = p ? `[data-cell-row="${row}"][data-start="${p.start}"]` : `[data-channel-row="${row}"]`;
    return scroller.current?.querySelector<HTMLElement>(sel) ?? null;
  };

  // The browser owns horizontal scrolling. This canvas never changes width during a gesture,
  // and scroll events only observe its position for the toolbar and rolling guide queries.
  const gridMounted = !paged.error && !paged.isLoading && !!sourceId && count > 0;
  const stickyTitles = useRef(createStickyTitleManager());
  const clockPosition = ((now - origin) / MINUTE) * pxPerMin;
  const clockPositionRef = useRef(clockPosition);
  clockPositionRef.current = clockPosition;
  useLayoutEffect(() => {
    if (scroller.current) updateGuideClock(scroller.current, clockPosition);
  }, [clockPosition, gridMounted]);
  const [hydration] = useState(createGuideHydrator);
  const wheelScroller = useRef(createGuideWheelScroller());
  const viewWidth = useRef(0);
  const scrollX = useRef(0);
  const observedScrollX = useRef(0);
  const nativeScrollSnapshot = useRef<{ root: HTMLElement; x: number; y: number } | null>(null);
  const scrollFrame = useRef(0);
  const viewportPublishAt = useRef(0);
  const viewportTimer = useRef(0);
  const horizontalIdleTimer = useRef(0);
  const programmaticX = useRef<number | null>(null);
  const laidRoot = useRef<HTMLElement | null>(null);
  const laidTrack = useRef(trackBase);
  const laidPx = useRef(pxPerMin);
  const laidRtl = useRef(rtl);
  const laidRequest = useRef(0);
  const laidWidth = useRef(false);
  const publishHydrationViewport = useStable((root: HTMLElement, x: number, width: number, knownY?: number) => {
    const y = knownY ?? root.scrollTop;
    const height = virtualizer.scrollRect?.height || 720;
    hydration.setViewport({
      left: x,
      right: x + Math.max(0, width - channelCol),
      firstRow: Math.max(0, Math.floor(y / rowH)),
      lastRow: Math.min(count - 1, Math.floor((y + height - headerH - 1) / rowH)),
    });
  });
  useLayoutEffect(() => {
    const root = scroller.current;
    if (root) publishHydrationViewport(root, scrollX.current, viewWidth.current || pageWidth);
  }, [gridMounted, virtualizer.scrollRect?.height, rowH, headerH, count, publishHydrationViewport, pageWidth]);
  const publishViewport = useStable((root: HTMLElement, immediate = false, fromFrame = false, known?: { x: number; y: number }) => {
    const width = viewWidth.current || root.clientWidth || pageWidth;
    viewWidth.current = width;
    const max = Math.max(0, channelCol + trackWidth - width);
    // Native scroll events already read both offsets before changing any styles. Reuse that
    // snapshot through the animation frame rather than forcing layout after our own writes.
    // Idle and resize callers omit it to observe native motion whose event has not arrived.
    const x = Math.min(max, known?.x ?? scrollStart(root, rtl));
    const y = known?.y ?? root.scrollTop;
    nativeScrollSnapshot.current = { root, x, y };
    scrollX.current = x;
    publishHydrationViewport(root, x, width, y);
    const time = start + x / pxPerMin * MINUTE;
    viewAtRef.current = time;
    root.dataset.viewAt = String(time);
    const visibleMs = width > channelCol ? (width - channelCol) / pxPerMin * MINUTE : baseWindowMs;
    // Replace the initial planning span on measurement, and recenter after a resize or zoom.
    // Ordinary scrolls reuse the same window until they enter its guard band.
    const geometry = renderWindowGeometry.current;
    const sameGeometry = geometry?.width === width && geometry.pxPerMin === pxPerMin && geometry.channelCol === channelCol;
    const nextRenderWindow = nextGuideRenderWindow(time, time + visibleMs,
      sameGeometry ? renderWindowRef.current : undefined);
    if (width > channelCol && !sameGeometry) renderWindowGeometry.current = { width, pxPerMin, channelCol };
    if (nextRenderWindow !== renderWindowRef.current) {
      renderWindowRef.current = nextRenderWindow;
      setRenderWindow(nextRenderWindow);
    }
    const publish = () => {
      const visibleWidth = width > channelCol ? width : channelCol + baseWindowMs / MINUTE * pxPerMin;
      const next = visibleGuideTime(start, x, visibleWidth, channelCol, pxPerMin, end);
      stickyTitles.current.update(x);
      const crossing = guideDataStart(next[0]) !== guideDataStart(shownTime[0]);
      const elapsed = performance.now() - viewportPublishAt.current;
      if (immediate || crossing || elapsed >= GRID_VIEWPORT_PUBLISH_MS) {
        window.clearTimeout(viewportTimer.current);
        viewportTimer.current = 0;
        viewportPublishAt.current = performance.now();
        setShownTime((prev) => prev[0] === next[0] && prev[1] === next[1] ? prev : next);
      } else if (!viewportTimer.current) {
        viewportTimer.current = window.setTimeout(() => {
          viewportTimer.current = 0;
          const latest = nativeScrollSnapshot.current;
          publishViewport(root, true, false, latest?.root === root ? latest : undefined);
        }, GRID_VIEWPORT_PUBLISH_MS - elapsed);
      }
    };
    if (immediate) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = 0;
      publish();
    } else if (fromFrame) {
      publish();
    } else if (!scrollFrame.current) {
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = 0;
        const latest = nativeScrollSnapshot.current;
        publishViewport(root, false, true, latest?.root === root ? latest : undefined);
      });
    }
    return { x, time };
  });
  const observeHorizontalInput = useStable((markGesture: boolean = true) => {
    // Mark continuous motion for diagnostics. CSS sticky keeps clipped titles in place.
    // This marker has no CSS dependents: ancestor hover rules made every tile restyle here.
    if (markGesture && scroller.current && scroller.current.dataset.guideScrolling === undefined) scroller.current.dataset.guideScrolling = '';
    horizontalScrolling.current = true;
    window.clearTimeout(horizontalIdleTimer.current);
    horizontalIdleTimer.current = window.setTimeout(() => {
      // Read the final native offset even if its scroll event has not yet been delivered.
      if (scroller.current) publishViewport(scroller.current, true);
      horizontalScrolling.current = false;
      if (scroller.current) delete scroller.current.dataset.guideScrolling;
      setBufferStart(guideDataStart(viewAtRef.current));
    }, GRID_HORIZONTAL_IDLE_MS);
  });
  useEffect(() => () => {
    cancelAnimationFrame(scrollFrame.current);
    window.clearTimeout(viewportTimer.current);
    window.clearTimeout(horizontalIdleTimer.current);
    hydration.reset();
  }, []);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // The grid's client width can also change when a channel filter removes its scrollbar.
      const width = root.clientWidth || pageWidth;
      if (width === viewWidth.current) return;
      viewWidth.current = width;
      publishViewport(root, true);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [gridMounted, pageWidth, publishViewport]);
  const moveViewTo = useStable((time: number, root: HTMLElement, updateUrl = true, deferBuffer = false) => {
    if (!Number.isFinite(time)) return;
    const y = root.scrollTop;
    const width = viewWidth.current || root.clientWidth || pageWidth;
    viewWidth.current = width;
    const max = Math.max(0, channelCol + trackWidth - width);
    const x = Math.max(0, Math.min(max, (time - start) / MINUTE * pxPerMin));
    wheelScroller.current.cancel(root);
    // A button jump moves the native viewport immediately. The buffer effect and shared
    // hydration queue prepare its surrounding hours without replacing overlapping tiles.
    // Update sticky title eligibility immediately for jumps, or once per frame for gestures.
    if (deferBuffer) observeHorizontalInput(false);
    else {
      window.clearTimeout(horizontalIdleTimer.current);
      horizontalScrolling.current = false;
      delete root.dataset.guideScrolling;
      setBufferStart(guideDataStart(time));
    }
    programmaticX.current = x;
    observedScrollX.current = x;
    root.scrollLeft = scrollLeftFor(x, rtl);
    publishViewport(root, true, false, { x, y });
    if (updateUrl) {
      manualView.current = true;
      settleScrollUrl(viewAtRef.current);
    }
  });
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) {
      laidRoot.current = null;
      return;
    }
    viewWidth.current = root.clientWidth || pageWidth;
    const first = laidRoot.current !== root;
    const trackChanged = laidTrack.current !== trackBase;
    const scaleChanged = laidPx.current !== pxPerMin || laidRtl.current !== rtl;
    const jump = requestedView && requestedView.id !== laidRequest.current ? requestedView : null;
    const firstWidth = !laidWidth.current && root.clientWidth > 0;
    laidRoot.current = root;
    laidTrack.current = trackBase;
    laidPx.current = pxPerMin;
    laidRtl.current = rtl;
    if (jump) laidRequest.current = jump.id;
    if (root.clientWidth > 0) laidWidth.current = true;
    if (jump) {
      const time = jump.live
        ? jump.time + nowScroll(now, jump.time, pxPerMin, root.clientWidth - channelCol) / pxPerMin * MINUTE
        : jump.time;
      moveViewTo(time, root, false, true);
    } else if (first && viewAtRef.current === baseStart && winAt === null) {
      // The first live view places now inside the track; later remounts keep their last time.
      const time = baseStart + nowScroll(now, baseStart, pxPerMin, root.clientWidth - channelCol) / pxPerMin * MINUTE;
      moveViewTo(time, root, false);
    } else if (first || trackChanged || scaleChanged || firstWidth) {
      // Zoom, direction and a deliberate re-centre preserve the time at the viewport edge.
      moveViewTo(viewAtRef.current, root, false);
    }
  }, [trackBase, requestedView, gridMounted, pageWidth, channelCol, pxPerMin, rtl]);

  // ---- zoom -----------------------------------------------------------------
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomBy = useStable((delta: number) => {
    const next = clampGuideZoom(zoomRef.current + delta);
    if (next === zoomRef.current) return;
    zoomRef.current = next;
    storeGuideZoom(next);
    setZoom(next);
  });
  const lastWheelZoom = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        wheelScroller.current.cancel(root);
        if (e.deltaY === 0) return;
        e.preventDefault();
        const at = performance.now();
        if (at - lastWheelZoom.current >= WHEEL_ZOOM_MS) {
          lastWheelZoom.current = at;
          zoomBy(e.deltaY < 0 ? 1 : -1);
        }
      } else {
        if (e.deltaX !== 0 || (e.shiftKey && e.deltaY !== 0)) {
          observeHorizontalInput();
          // User scrolling takes precedence over a pending keyboard focus reveal, even if a
          // guide answer renders before the browser delivers its next scroll event.
          manualView.current = true;
          focusPending.current = false;
        }
        // Some systems have already put Shift-wheel on deltaX; others leave it on deltaY.
        // Larger wheel steps need motion between events, not one instantaneous jump per notch.
        const raw = e.deltaX || e.deltaY;
        const step = isWheelStep(raw, e.deltaMode);
        if (e.shiftKey && raw !== 0 && (e.deltaX === 0 || step)) {
          e.preventDefault();
          const page = e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? (viewWidth.current || root.clientWidth || pageWidth) : 0;
          const delta = wheelDeltaPx(raw, e.deltaMode, page);
          const max = Math.max(0, channelCol + trackWidth - (viewWidth.current || root.clientWidth || pageWidth));
          wheelScroller.current.move(root, delta, max, rtl, step && guideWheelMotionAllowed());
        } else {
          // Trackpad/native wheel input takes over immediately from any unfinished wheel step.
          wheelScroller.current.cancel(root);
        }
      }
    };
    const cancelWheel = () => wheelScroller.current.cancel(root);
    const settleWheel = () => wheelScroller.current.settled(root);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) cancelWheel();
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('pointerdown', cancelWheel, { passive: true });
    root.addEventListener('touchstart', cancelWheel, { passive: true });
    root.addEventListener('keydown', onKey);
    root.addEventListener('scrollend', settleWheel);
    return () => {
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('pointerdown', cancelWheel);
      root.removeEventListener('touchstart', cancelWheel);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('scrollend', settleWheel);
      cancelWheel();
    };
  }, [gridMounted, zoomBy, rtl, observeHorizontalInput, channelCol, trackWidth, pageWidth]);
  useEffect(() => {
    const root = scroller.current;
    if (root) return attachGuideDragPan(root);
  }, [gridMounted]);

  /** Put a time measured from the fixed track origin at the visible edge. */
  const scrollTrackTo = (root: HTMLElement, x: number) => {
    moveViewTo(start + x / pxPerMin * MINUTE, root);
  };

  // Focus never sits on a cell that is about to unmount: while the cursor's row is off screen or
  // still loading, the grid itself holds focus (and takes the keys); the cell gets it once rendered.
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const focused = document.activeElement;
    if (lastFocused.current && !lastFocused.current.isConnected && (focused === document.body || focused === null)) {
      lastFocused.current = null;
      // A rolling data slice may remove the focused programme after a native wheel gesture.
      // Keep keyboard focus on the grid without revealing that old programme again.
      if (!manualView.current) focusPending.current = true;
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
    const left = ((ms(p.start) - start) / MINUTE) * pxPerMin;
    const right = ((ms(p.end) - start) / MINUTE) * pxPerMin;
    const x = ((viewAtRef.current - start) / MINUTE) * pxPerMin;
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
  const [rowMenu, setRowMenu] = useState<{ pos: { x: number; y: number }; channel: Channel; programme?: EpgProgram } | null>(null);
  const [programmeLink, setProgrammeLink] = useState<string | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  // "Match guide channel" from the row menu and the no-match notice, as on the Live page.
  const [mapping, setMapping] = useState<Channel | null>(null);
  const closeMapping = useCallback(() => setMapping(null), []);
  const toggleFavorite = useStable(async (channel: Channel, wasFavorite: boolean) => {
    const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
    try {
      const res = await rpc('favorites.toggle', {
        ref: channel.ref,
        snapshot: { title: channel.name, subtitle: channel.categoryName, posterUrl: channel.logoUrl, contentType: channel.ref.contentType },
      });
      await invalidate('favorites.');
      toast({ title: res.isFavorite ? t('favoriteAdded', { name }) : t('favoriteRemoved', { name }), variant: 'success' });
    } catch (err) {
      toast({ title: wasFavorite ? t('favoriteRemoveFailed') : t('favoriteAddFailed'), description: errorDescription(err), variant: 'error' });
    }
  });
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
    // (it just crossed the queried slice): which programme comes next is not known yet, and a
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
      // The focus effect brings the next or previous programme into view.
      case 'later': {
        const nextT = cur ? ms(cur.end) : time + GRID_SLOT_MIN * MINUTE;
        time = nextT;
        break;
      }
      case 'earlier': {
        const prevT = cur ? ms(cur.start) - 1 : time - GRID_SLOT_MIN * MINUTE;
        time = prevT;
        break;
      }
      case 'Home':
        // Home: back to now on this row; Ctrl+Home also goes to the first channel.
        if (e.ctrlKey || e.metaKey) row = 0;
        toNow();
        time = Date.now();
        break;
      case 'End': {
        // End: the last programme of this row in the visible time range.
        if (e.ctrlKey || e.metaKey) row = count - 1;
        const last = windowPrograms(row).filter((p) => ms(p.start) < shownTime[1] && ms(p.end) > shownTime[0]).at(-1);
        time = last ? Math.max(ms(last.start), shownTime[0]) : shownTime[1] - 1;
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    cursorRef.current = { row, time };
    focusPending.current = true;
    virtualizer.scrollToIndex(row, { align: 'auto' });
    // A keyboard target beyond the mounted time window has no cell for the focus effect to
    // measure. Move the viewport first so that the target mounts in the same update.
    if ((time < renderWindowRef.current[0] || time >= renderWindowRef.current[1] ||
      time < dataStart || time >= dataEnd) && scroller.current) {
      const view = (viewWidth.current || scroller.current.clientWidth) - channelCol;
      scrollTrackTo(scroller.current, ((time - start) / MINUTE) * pxPerMin - Math.max(0, view / 3));
    }
    // A row that isn't rendered yet (or still loading) has no cell to take focus: the grid holds it.
    if (!cursorElement(row, time)) scroller.current?.focus({ preventScroll: true });
    setCursor({ row, time });
    // Fetch beside the current slice before the next press crosses it.
    const shown = windowPrograms(row);
    const at = programIndexAt(shown, time);
    if (at >= 0 && at >= shown.length - 2) prefetchWindow(GRID_DATA_STEP);
    if (at >= 0 && at <= 1) prefetchWindow(-GRID_DATA_STEP);
  };

  /** Fill the query cache without changing the displayed slice or rebuilding programme rows. */
  const prefetchSlice = useStable((s: number) => {
    const e = s + dataWindowMs;
    if (!pageMeasured || (s === dataStart && e === dataEnd)) return;
    const from = new Date(s - offsetMs).toISOString();
    const to = new Date(e - offsetMs).toISOString();
    for (const refs of [refsA, refsB]) {
      if (refs.length === 0) continue;
      const args = gridArgs(refs, from, to);
      void queryClient.prefetchQuery({ queryKey: rpcKey('epg.grid', args), queryFn: () => rpcRaw('epg.grid', args), staleTime: GRID_STALE_MS, gcTime: GRID_CACHE_MS })
        .then(() => setPrefetchVersion((v) => v + 1));
    }
  });
  /** Keyboard moves can request a slice before their destination becomes visible. */
  const prefetchWindow = useStable((delta: number) => prefetchSlice(guideDataStart(shownTime[0] + delta)));
  const prefetchRefsKey = [...refsA, ...refsB].map(itemKey).join('|');
  const horizontalPrefetchTimer = useRef(0);
  // The displayed answer takes priority. One outer slice per direction covers a long fling,
  // with only six hours of overlap instead of repeatedly fetching nearly identical 24h slices.
  useEffect(() => {
    if (!atRest || !gridsLoaded || dataStart !== wantedDataStart || dataEnd !== wantedDataEnd) return;
    // Vertical flings change the channel chunks repeatedly. Wait until those rows have held
    // still before warming distant times for them; otherwise each passed chunk costs two RPCs.
    const verticalIdleMs = performance.now() - vScroll.current.t;
    const delay = Math.max(500, 1000 - verticalIdleMs);
    const id = window.setTimeout(() => {
      horizontalPrefetchTimer.current = 0;
      prefetchSlice(dataStart - outerShift);
      prefetchSlice(dataStart + outerShift);
    }, delay);
    horizontalPrefetchTimer.current = id;
    return () => {
      window.clearTimeout(id);
      if (horizontalPrefetchTimer.current === id) horizontalPrefetchTimer.current = 0;
    };
  }, [atRest, gridsLoaded, dataStart, dataEnd, wantedDataStart, wantedDataEnd, outerShift, prefetchRefsKey, prefetchSlice, verticalIdleVersion]);
  // Both axes scroll natively. Only the vertical axis changes which channel rows are mounted.
  const onGridScroll = (el: HTMLDivElement) => {
    const nativeX = scrollStart(el, rtl);
    const y = el.scrollTop;
    // Width is observed at layout/resize, never measured in the wheel or scroll hot path.
    const x = Math.min(Math.max(0, channelCol + trackWidth - (viewWidth.current || pageWidth)), nativeX);
    nativeScrollSnapshot.current = { root: el, x, y };
    // Idle and resize observations can precede delivery of a scroll event. Track delivered
    // events separately so that those observations cannot make a gesture look idle.
    if (x !== observedScrollX.current) {
      observedScrollX.current = x;
      const programmatic = programmaticX.current !== null && Math.abs(x - programmaticX.current) < 1;
      programmaticX.current = null;
      if (!programmatic) observeHorizontalInput();
      publishViewport(el, false, false, { x, y });
      if (!programmatic) {
        manualView.current = true;
        focusPending.current = false;
        settleScrollUrl(start + x / pxPerMin * MINUTE);
      }
    }
    const vs = vScroll.current;
    if (y !== vs.y) {
      publishHydrationViewport(el, x, viewWidth.current || pageWidth, y);
      window.clearTimeout(horizontalPrefetchTimer.current);
      horizontalPrefetchTimer.current = 0;
      window.clearTimeout(verticalIdleTimer.current);
      verticalIdleTimer.current = window.setTimeout(() => setVerticalIdleVersion((v) => v + 1), 600);
      const t = performance.now();
      vs.v = Math.abs(y - vs.y) / Math.max(1, t - vs.t);
      vs.t = t;
      vs.y = y;
    }
  };

  // ---- guide search and jump (Run 2 C5) ----------------------------------------
  const [jumpOpen, setJumpOpen] = useState(false);
  const openJump = useCallback(() => setJumpOpen(true), []);
  const closeJump = useCallback(() => setJumpOpen(false), []);
  // The guide's search field, in the header's search slot (GuideHeaderSearch).
  const searchRef = useRef<HTMLInputElement>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [highlight, setHighlight] = useState<ItemKey | null>(null);
  const guideArea = tg('shortcutArea');
  useShortcut(
    '/',
    (e) => {
      e.preventDefault();
      // On a phone the header's field is folded into an icon; focus unfolds it.
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
    // A view (favorites, a list) may leave the channel out: the hit opens in all channels.
    const group = view ? undefined : groupForHit(categoryId, hit);
    goTo(time, { category: group === categoryId && !view ? undefined : null });
    setHighlight(null);
    setReveal({ key: itemKey(hit.ref), ref: hit.ref, number: hit.channelNumber, time, channelName: displayChannelName(hit.channelName, prefs.stripCountryPrefix), categoryId: group });
  });

  // A programme opened from the global search or the palette (`guideHitLink`): the URL already
  // holds its source and window, and its row is found like a hit of the search panel. Once per
  // history entry, so a re-render does not move the cursor back to it.
  const handledHit = useRef<string | null>(null);
  useEffect(() => {
    if (!isGuideHitState(location.state) || handledHit.current === location.key) return;
    handledHit.current = location.key;
    const hit = location.state.guideHit;
    if (hit.ref.sourceId !== sourceId) return;
    setHighlight(null);
    setReveal({ key: itemKey(hit.ref), ref: hit.ref, number: hit.channelNumber, time: ms(hit.program.start), channelName: displayChannelName(hit.channelName, prefs.stripCountryPrefix), categoryId });
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // LG-01: Live's guide link names the channel playing there (`focus`): the guide opens at its row,
  // on now, once per link. Its number lets the paged list find the row in a few reads. Picking
  // another source, group or view takes `focus` out of the address (setQuery).
  // A link is its source and channel, and it counts as handled once the channel is found: a lookup
  // cut short (the address changed under it, or React ran the effect twice) or failed is made again
  // when the address changes. An address without `focus` ends the link, so a later link to the same
  // channel opens there too.
  const focusParam = params.get('focus');
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusParam) {
      handledFocus.current = null;
      return;
    }
    if (!sourceId) return;
    const link = `${sourceId}|${focusParam}`;
    if (handledFocus.current === link) return;
    const ref: ItemRef = { sourceId, contentType: 'live', itemId: focusParam };
    let cancelled = false;
    rpc('catalog.item', { ref })
      .then((item) => {
        if (cancelled) return;
        handledFocus.current = link;
        if (!item || !('isRadio' in item)) return;
        const ch = item as Channel;
        setReveal({ key: itemKey(ref), ref, number: ch.number, time: Date.now(), channelName: displayChannelName(ch.name, prefs.stripCountryPrefix), categoryId, quiet: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [focusParam, sourceId, categoryId, viewParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // LG-01: a typed channel number moves the cursor to that channel's row, at the cursor's time, as
  // number keys tune on Live. A channel outside the group or view on screen opens in all channels.
  const [osd, setOsd] = useState<ZapFeedback | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (osdTimer.current) clearTimeout(osdTimer.current);
  }, []);
  const jumpToNumber = useStable(async (n: number) => {
    if (osdTimer.current) clearTimeout(osdTimer.current);
    setOsd(null);
    const missing = () => {
      setOsd({ kind: 'missing', number: n });
      osdTimer.current = setTimeout(() => setOsd(null), 2000);
    };
    try {
      const ch = await rpc('catalog.channelByNumber', { sourceId, number: n, contentType: 'live' });
      if (!ch) return missing();
      const time = cursorRef.current.time ?? Date.now();
      const key = itemKey(ch.ref);
      // A view knows every entry, not only the rows fetched near the screen (favorite #50 is in it).
      const inView = view ? paged.indexOf?.(ch.ref) !== undefined : !categoryId || ch.categoryId === categoryId;
      if (!inView) goTo(time, { category: null });
      setHighlight(null);
      setReveal({ key, ref: ch.ref, number: ch.number, time, channelName: displayChannelName(ch.name, prefs.stripCountryPrefix), categoryId: inView ? categoryId : undefined });
    } catch {
      missing();
    }
  });
  const digits = useDigitEntry((n) => void jumpToNumber(n));
  useEffect(() => {
    if (!digits.buffer) return;
    if (osdTimer.current) clearTimeout(osdTimer.current);
    setOsd({ kind: 'typing', digits: digits.buffer });
  }, [digits.buffer]);
  useShortcut(
    'digit',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !sourceId) return;
      digits.push(e.key);
    },
    { description: tg('shortcutDigits'), area: guideArea },
  );

  // Once the list the hit needs is on screen, find the channel's row, scroll to it, put the
  // keyboard cursor on the programme and highlight the row for a moment.
  const listReady = !!sourceId && !paged.isLoading && !paged.refreshing && !paged.error;
  useEffect(() => {
    if (!reveal || !listReady || (!view && categoryId !== reveal.categoryId)) return;
    let cancelled = false;
    const known = paged.loaded.find((l) => itemKey(l.channel.ref) === reveal.key)?.index;
    if (view) {
      // A view (favorites, a list) knows all its entries: the channel is in it or not. Favorites
      // fetch their channels near the rows on screen only, so the row comes from the entry list.
      setReveal(null);
      const index = known ?? paged.indexOf?.(reveal.ref);
      if (index === undefined) return;
      virtualizer.scrollToIndex(index, { align: 'center' });
      cursorRef.current = { row: index, time: reveal.time };
      setCursor({ row: index, time: reveal.time });
      focusPending.current = true;
      scroller.current?.focus({ preventScroll: true });
      return;
    }
    // LV-2: the channel number narrows the search to a few page reads; the sequential scan (to the
    // end of the list) is left for a list whose numbers are missing or out of order.
    const scan = () =>
      findChannelIndex((offset, limit) => rpc('catalog.channels', { sourceId, categoryId, query: { offset, limit } }), reveal.key, () => cancelled);
    const lookup =
      known !== undefined
        ? Promise.resolve(known)
        : (paged.locate?.(reveal.ref, reveal.number) ?? Promise.resolve(undefined)).then((index) => (index !== undefined ? index : cancelled ? null : scan()));
    lookup
      .then((index) => {
        if (cancelled) return;
        setReveal(null);
        if (index === null || index === undefined) {
          if (!reveal.quiet) toast({ title: tg('hitNotFound', { channel: reveal.channelName }) });
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
        if (!reveal.quiet) toast({ title: tg('hitNotFound', { channel: reveal.channelName }), description: errorDescription(err), variant: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `paged.loaded` is read once the list is ready; later page loads must not start another lookup.
  }, [reveal, listReady, sourceId, categoryId, view]); // eslint-disable-line react-hooks/exhaustive-deps
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
      toast({ title: t('playFailed', { name: displayChannelName(channel.name, prefs.stripCountryPrefix) }), description: errorDescription(err), variant: 'error' }),
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
      toast({ title: t('catchupFailed'), description: errorDescription(err), variant: 'error' }),
    );
  };

  // What the memoised rows do: one stable object, each entry reading the latest render.
  const openCell = useStable((row: number, channel: Channel, program: EpgProgram, el: HTMLElement) => {
    setCursor({ row, time: ms(program.start) });
    invoker.current = el;
    setSelection({ channel, program, anchor: el });
  });
  const focusCell = useStable((row: number, program: EpgProgram) =>
    setCursor((c) => (c.row === row && c.time >= ms(program.start) && c.time < ms(program.end) ? c : { row, time: ms(program.start) })),
  );
  const rowMenuAt = useStable((channel: Channel, x: number, y: number, programme?: EpgProgram) => setRowMenu({ pos: { x, y }, channel, programme }));
  const trackTitles = useCallback((row: HTMLElement) => {
    updateGuideClock(row, clockPositionRef.current);
    return stickyTitles.current.register(row, scrollX.current);
  }, []);
  const pressCell = useStable((channel: Channel, program: EpgProgram) => prefetchProgramDescription(queryClient, channel.ref, program, offsetMs));
  // The preview band follows the pointer after it rests a moment (a sweep across the grid does
  // not re-render the band per cell), and goes back to the keyboard cursor when it leaves.
  const [hovered, setHovered] = useState<{ channel: Channel; program: EpgProgram } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const hoverCell = useStable((_row: number, channel: Channel, program: EpgProgram | undefined) => {
    if (!showPreview) return;
    window.clearTimeout(hoverTimer.current);
    const publish = () => {
      if (horizontalScrolling.current) hoverTimer.current = window.setTimeout(publish, PREVIEW_HOVER_MS);
      else setHovered(program ? { channel, program } : null);
    };
    hoverTimer.current = window.setTimeout(publish, PREVIEW_HOVER_MS);
  });
  // The band keeps a hovered programme while the pointer is on it. The way from a cell up to the
  // band's Watch, Record or Remind leaves the grid, and the band used to go back to the cursor's
  // programme on the way, so those buttons acted on another programme than the one just shown.
  const holdHover = useStable(() => window.clearTimeout(hoverTimer.current));
  const releaseHover = useStable(() => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(null), PREVIEW_HOVER_MS);
  });
  const rowHandlers = useMemo<GuideRowHandlers>(
    () => ({ play: playLive, open: openCell, focusCell, menu: rowMenuAt, trackTitles, press: pressCell, hover: hoverCell, hydration }),
    [playLive, openCell, focusCell, rowMenuAt, trackTitles, pressCell, hoverCell, hydration],
  );

  // ---- render ---------------------------------------------------------------
  // Give the ruler the same six-hour buffers as the programme slice. Keeping days of sticky
  // labels offscreen still adds compositor work, even after programme titles are ordinary text.
  // Local half hours preserve ticks in time zones whose offset includes fractional hours.
  const rulerStart = Math.max(start, floorLocal(dataStart, GRID_SLOT_MIN));
  const rulerEnd = Math.min(end, floorLocal(dataEnd, GRID_SLOT_MIN) + GRID_SLOT_MIN * MINUTE);
  const slots = useMemo(() => {
    const out: number[] = [];
    for (let s = rulerStart; s < rulerEnd; s += GRID_SLOT_MIN * MINUTE) out.push(s);
    return out;
  }, [rulerStart, rulerEnd]);
  const labels = useMemo(() => slotLabels(slots, i18n.language), [slots, i18n.language]);
  const nowInWindow = now >= start && now < end;
  const nowInViewport = now >= shownTime[0] && now < shownTime[1];
  const nowX = ((now - start) / MINUTE) * pxPerMin;

  const bar = guideBarLayout(pageWidth);
  // LG-01: "Go to playing" while the playing channel's row is in this list but off screen. Only
  // then: offered for a channel of another group, a press read every page of this one for nothing.
  const playingRow = playingKey ? (paged.loaded.find((l) => itemKey(l.channel.ref) === playingKey)?.index ?? (playingRef ? paged.indexOf?.(playingRef) : undefined)) : undefined;
  const playingOnScreen = playingRow !== undefined && playingRow >= first && playingRow <= last;
  const playingInList = playingHere && (view ? playingRow !== undefined : !!playingChannel && (!categoryId || playingChannel.categoryId === categoryId));
  const goToPlaying =
    playingKey && playingRef && playingInList && !playingOnScreen
      ? () => {
          setReveal({ key: playingKey, ref: playingRef, number: playingChannel?.number, time: Date.now(), channelName: '', categoryId, quiet: true });
          if (playingRow !== undefined) virtualizer.scrollToIndex(playingRow, { align: 'center' });
        }
      : undefined;
  // A phone's genre filter and Go to playing are header actions, so the toolbar is one row.
  const goToPlayingStable = useStable(() => goToPlaying?.());
  const canGoToPlaying = !!goToPlaying;
  const phoneActions = useMemo(
    () => (bar === 'phone' ? <GuidePhoneActions genre={genreFilter} onGenre={setGenreFilter} onGoToPlaying={canGoToPlaying ? goToPlayingStable : undefined} /> : undefined),
    [bar, genreFilter, setGenreFilter, canGoToPlaying, goToPlayingStable],
  );

  // The shell header title is a <p>; the page owns its single h1 (same text as the header title).
  // GuideHeaderSearch sets the header (and its search field, when there is anything to search).
  // The subtitle names the source only when there are several to tell apart, as Movies, Series
  // and Live TV do; with one source its name told the user nothing.
  const heading = (
    <>
      <h1 className="sr-only">{t('guide')}</h1>
      <GuideHeaderSearch
        title={t('guide')}
        subtitle={(sources.data?.length ?? 0) > 1 ? source?.name : undefined}
        inputRef={searchRef}
        sourceId={sourceId}
        disabled={!sourceId}
        field={!sources.error && !(sources.data && sources.data.length === 0)}
        actions={phoneActions}
        offsetMinutes={prefs.epgOffsetMinutes}
        now={now}
        stripCountryPrefix={prefs.stripCountryPrefix}
        onSelect={selectHit}
        onWatch={watchHit}
      />
    </>
  );
  if (sources.error) {
    return (
      <>
        {heading}
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      </>
    );
  }
  if ((sources.data && sources.data.length === 0) || adding) {
    return (
      <>
      {heading}
      <NoSourcesState icon={<CalendarClock />} title={t('guideNoSources')} description={t('guideNoSourcesHint')} stay />
      </>
    );
  }

  const cursorProg = cursorProgram(cursor.row, cursor.time);
  const cursorStart = cursorProg?.start ?? '';
  const lang = i18n.language;
  // The band describes the hovered cell, else the open popover's, else the keyboard cursor's.
  const previewSubject = hovered ?? (selection ? { channel: selection.channel, program: selection.program } : null) ?? (paged.getChannel(cursor.row) && cursorProg ? { channel: paged.getChannel(cursor.row)!, program: cursorProg } : null);

  return (
    // data-guide-search-bounds (SEARCH_BOUNDS_ATTR): the search panel stays inside the page, clear of the rail.
    <div ref={measurePage} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg" data-testid="epg-grid-page" data-guide-bar={bar} data-guide-search-bounds="">
      {heading}
      <span role="status" className="sr-only" data-testid="guide-genre-note">
        {genreNote}
      </span>
      <GuideToolbar
        sources={liveSources && source && !liveSources.includes(source) ? [...liveSources, source] : liveSources}
        sourceId={sourceId}
        categories={categories.data}
        categoryId={categoryId}
        view={view}
        lists={lists.data}
        bar={bar}
        start={shownTime[0]}
        end={shownTime[1]}
        nowInWindow={nowInViewport}
        now={now}
        onQuery={setQuery}
        onShift={shift}
        onShiftDay={shiftDay}
        onNow={toNow}
        onJump={openJump}
        zoom={zoom}
        onZoom={zoomBy}
        genre={genreFilter}
        onGenre={setGenreFilter}
        previewOpen={bandFits ? previewOpen : undefined}
        onTogglePreview={togglePreview}
        onGoToPlaying={goToPlaying}
      />
      {showPreview && sourceId ? (
        <GuidePreview
          channel={previewSubject?.channel}
          program={previewSubject?.program}
          next={previewSubject ? nextProgram(programsFor(previewSubject.channel), previewSubject.program) : undefined}
          now={now}
          kind={previewSubject ? ownKind(previewSubject.channel) : undefined}
          stripPrefix={prefs.stripCountryPrefix}
          offsetMs={offsetMs}
          onWatch={playLive}
          onCatchup={catchup}
          onPointerEnter={holdHover}
          onPointerLeave={releaseHover}
        />
      ) : null}
      <MemoJumpToDialog open={jumpOpen} onClose={closeJump} start={shownTime[0]} now={now} onJump={goTo} onNow={toNow} />

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
      ) : count === 0 && quality.filtering && source?.channelCount !== 0 ? (
        <QualityEmptyState quality={quality} />
      ) : count === 0 && view ? (
        <EmptyState
          icon={<Tv className="size-8" />}
          title={tg(view.kind === 'favorites' ? 'viewFavoritesEmpty' : 'viewListEmpty')}
          description={tg('viewEmptyHint')}
          action={
            <Button variant="secondary" size="sm" onClick={() => setQuery('view', undefined)}>
              {t('allChannels')}
            </Button>
          }
        />
      ) : count === 0 && source?.channelCount === 0 ? (
        // LG-11: a source with films and series only: say so, and offer one that has channels.
        <EmptyState
          icon={<Tv className="size-8" />}
          title={tg('noLiveChannels')}
          description={tg('noLiveChannelsHint')}
          action={
            liveSources?.[0] ? (
              <Button variant="primary" size="sm" onClick={() => setQuery('source', liveSources[0]!.id)}>
                {tg('openSourceGuide', { name: liveSources[0].name })}
              </Button>
            ) : undefined
          }
        />
      ) : count === 0 ? (
        <EmptyState icon={<Tv className="size-8" />} title={t('noChannels')} description={t('noChannelsHint')} />
      ) : (
        // The grid with the no-guide notice floating over its foot: the notice comes and goes as
        // chunks load without moving the grid (L1-perf-1).
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* LG-01: the number being typed, over the grid's top end. */}
          <DigitOsd state={osd} />
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
            data-view-at={viewAtRef.current}
            // The ring shows only once the grid has held focus for 150 ms: the brief holds of a
            // window shift (16-98 ms) would otherwise flash a frame around the whole grid. It goes
            // at once when a cell takes focus (no delay out of the focused state).
            className="relative min-h-0 flex-1 cursor-grab overflow-auto overscroll-x-none overscroll-y-contain outline-none transition-shadow duration-0 focus-visible:ring-2 focus-visible:ring-focus focus-visible:delay-150"
            style={{ overflowAnchor: 'none' }}
          >
            <div
              // Sized from its style, so a row added or removed by a scroll is laid out in here
              // without the page's flex layout around the grid running again (P2-GUIDE-3).
              className="[contain:size_layout]"
              style={
                {
                  width: channelCol + trackWidth,
                  height: virtualizer.getTotalSize() + headerH,
                  position: 'relative',
                  '--grid-total-width': `${channelCol + trackWidth}px`,
                  '--grid-track-width': `${trackWidth}px`,
                } as CSSProperties
              }
            >
              <GuideHeader
                height={headerH}
                slots={slots}
                labels={labels}
                start={start}
                channelCol={channelCol}
                trackWidth={trackWidth}
                slotPx={slotPx}
                compact={compact}
                nowLabel={nowInWindow ? formatClock(now, lang) : undefined}
                nowX={nowX}
                rtl={rtl}
              />

              {nowInWindow ? (
                // Under the sticky channel column (z-10) and time header (z-20), and under the cells:
                // drawn before the rows, it shows only in the gutters between them, and the opaque
                // airing cell carries its stub at the foot, so it never strikes through a title or
                // a time (L3-visual-3). Its head is the time pill in the ruler (GuideHeader), LG-18.
                <div
                  aria-hidden
                  data-testid="epg-now-line"
                  className="pointer-events-none absolute w-0.5 bg-live"
                  style={{ ...inlineStart(channelCol + nowX - 1, rtl), top: headerH, height: virtualizer.getTotalSize() }}
                />
              ) : null}

              {/* The rows wait for the page's width, measured as this commit attaches the page
                  (useElementWidth) and rendered before the first paint: the window's length follows
                  the width, so rows rendered before it were laid out twice, inside the measurement's
                  forced layout and again at the width it found (P2-GUIDE-2). */}
              {pageMeasured && vItems.map((v) => {
                const ch = paged.getChannel(v.index);
                const programs = programsFor(ch);
                const playing = !!ch && playingKey === itemKey(ch.ref);
                const playingProgramStart = playing
                  ? playingSource?.isLive
                    ? programs?.find((p) => ms(p.start) <= now && now < ms(p.end))?.start
                    : playingSource?.catchupProgramStart
                  : undefined;
                return (
                  <GuideRow
                    key={v.key}
                    index={v.index}
                    top={headerH + v.start}
                    height={rowH}
                    channel={ch}
                    programs={programs}
                    origin={origin}
                    renderWindow={renderWindow}
                    now={now}
                    pxPerMin={pxPerMin}
                    channelCol={channelCol}
                    compact={compact}
                    rtl={rtl}
                    kind={kind}
                    highlighted={!!ch && highlight === itemKey(ch.ref)}
                    playing={playing}
                    playingProgramStart={playingProgramStart}
                    genreFilter={genreFilter}
                    genreNames={genreNames}
                    labels={rowLabels}
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
          {noEpgAnywhere && nowInViewport && !guidesLoaded ? (
            // LG-10: no guide at all. A proper empty state over the (quiet, flat) rows, not a pill
            // cut short at the foot of a wall of empty cells; the channels stay under it.
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg/60 p-4 pt-12">
              <div
                data-testid="guide-no-data"
                role="status"
                className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-edge bg-surface px-6 py-7 text-center shadow-3 motion-safe:animate-pop-in"
              >
                <span aria-hidden className="inline-flex size-12 items-center justify-center rounded-full bg-surface-3 text-fg-muted">
                  <CalendarClock size={24} />
                </span>
                <h2 className="text-title-sm text-fg">{tg('noGuideTitle')}</h2>
                <p className="text-body-sm text-fg-muted">{t('guideNoData')}</p>
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  <Link to="/settings/epg" className={buttonClass('primary', 'sm')}>
                    {tg('addGuide')}
                  </Link>
                  <Link to={`/s/${encodeURIComponent(sourceId)}/live`} className={buttonClass('secondary', 'sm')}>
                    {tg('watchChannels')}
                  </Link>
                </div>
              </div>
            </div>
          ) : noEpgAnywhere ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
              <div
                data-testid="guide-no-data"
                className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-2 text-sm text-fg-muted shadow-2 motion-safe:animate-fade-in"
              >
                {/* Away from now, an empty window is past the guide's end, not a missing guide (L4-live-1). */}
                <span className="min-w-0">{nowInViewport ? t(guidesLoaded ? 'guideNoMatch' : 'guideNoData') : t('guideNoDataHere')}</span>
                {nowInViewport && guidesLoaded ? (
                  // The cursor row's channel (the first one until the keys moved it).
                  <button
                    type="button"
                    className={cn(TEXT_LINK, 'shrink-0')}
                    data-testid="guide-no-match-map"
                    onClick={() => setMapping(paged.getChannel(cursor.row) ?? paged.getChannel(first) ?? null)}
                  >
                    {t('mapEpg')}
                  </button>
                ) : nowInViewport ? (
                  <Link to="/settings/epg" className={cn(TEXT_LINK, 'shrink-0')}>
                    {t('epgSettings')}
                  </Link>
                ) : (
                  <button type="button" className={cn(TEXT_LINK, 'shrink-0')} onClick={toNow}>
                    {t('guideBackToNow')}
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {rowMenu ? (
        <GuideRowMenu
          menu={rowMenu}
          source={rowMenu.channel.ref.sourceId === source?.id ? source : undefined}
          // The grid shows the channel's programmes anyway; the header names the airing one.
          nowTitle={programsFor(rowMenu.channel)?.find((p) => ms(p.start) <= now && ms(p.end) > now)?.title}
          programme={rowMenu.programme}
          now={now}
          onProgrammeLink={setProgrammeLink}
          onPlay={playLive}
          onMapGuide={setMapping}
          onToggleFavorite={toggleFavorite}
          onClose={closeRowMenu}
        />
      ) : null}
      <MemoMappingDialog channel={mapping} onClose={closeMapping} />
      <Dialog open={programmeLink !== null} onClose={() => setProgrammeLink(null)} title={t('copyUrl')} size="lg">
        <p className="mb-2 text-sm text-fg-muted">Select the stream address and copy it manually.</p>
        <input
          type="text"
          readOnly
          value={programmeLink ?? ''}
          aria-label={t('copyUrl')}
          data-autofocus
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-md border border-edge bg-bg px-3 py-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
        <div className="mt-3 flex justify-end">
          <Button onClick={() => setProgrammeLink(null)}>{t('close')}</Button>
        </div>
      </Dialog>

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
const MemoMappingDialog = memo(EpgMappingDialog);

/**
 * Whether the now pill (its text `pill`, centred on `nowX`) covers a ruler label (its text
 * `label`, starting at `labelX` with the label's 8 px of padding), from the text lengths at the
 * ruler's 12 px: a short "5:30" 80 px after the slot line stays, a "12:30 PM" the pill lands on goes.
 */
export function rulerLabelCovered(nowX: number, pill: string, labelX: number, label: string): boolean {
  // Barlow Semi Condensed is about 0.5 em a character plus the pill's 6 px padding a side; Inter
  // tabular figures about 0.6 em. A few px of margin round both.
  const half = (pill.length * 6 + 12) / 2 + 2;
  const labelEnd = labelX + 8 + label.length * 7.2 + 4;
  return nowX - half < labelEnd && nowX + half > labelX;
}

/** The time header: the channel column's corner and a label per 30-minute slot. */
const GuideHeader = memo(function GuideHeader({
  height,
  slots,
  labels,
  start,
  channelCol,
  trackWidth,
  slotPx,
  compact,
  nowLabel,
  nowX,
  rtl,
}: {
  height: number;
  slots: readonly number[];
  labels: readonly string[];
  start: number;
  channelCol: number;
  trackWidth: number;
  /** Px per 30-minute slot at the zoom step. */
  slotPx: number;
  compact: boolean;
  /** The current time, when now is in the window: the now line's head in the ruler (LG-18). */
  nowLabel?: string;
  /** px from the track's inline start to now. */
  nowX: number;
  rtl: boolean;
}) {
  const { t } = useTranslation('live');
  return (
    <div role="row" className="sticky top-0 z-20 border-b border-divider bg-surface" style={{ height, width: channelCol + trackWidth }}>
      {nowLabel ? (
        // The now line's labelled head: it used to be a dot the ruler painted over. Under the
        // sticky channel column (z-10 here) when the track is scrolled past now.
        <span
          aria-hidden
          data-testid="epg-now-pill"
          // Over the slot labels (it covers the one it lands on), under the sticky corner (z-10).
          className="pointer-events-none absolute top-1/2 z-[6] -translate-x-1/2 -translate-y-1/2 rounded-full bg-live-solid px-1.5 py-px font-numeric text-xs leading-4 whitespace-nowrap tabular-nums text-white shadow-1 rtl:translate-x-1/2"
          style={inlineStart(channelCol + nowX, rtl)}
        >
          {nowLabel}
        </span>
      ) : null}
      <div role="columnheader" className="sticky start-0 z-10 flex h-full items-center border-e border-divider bg-surface px-3 text-xs text-fg-subtle" style={{ width: channelCol }}>
        <span className={compact ? 'sr-only' : undefined}>{t('channels')}</span>
      </div>
      {/* Slot keys keep nearby ruler labels stable as the visible time changes. */}
      {slots.map((slot, i) => {
        // The now pill stands on the ruler: a label it would cover, even in part, steps aside.
        const slotX = ((slot - start) / (GRID_SLOT_MIN * MINUTE)) * slotPx;
        const covered = !!nowLabel && rulerLabelCovered(nowX, nowLabel, slotX, labels[i] ?? '');
        return (
          <div role="columnheader" key={slot} data-slot={slot} className="absolute top-0 flex h-full items-center border-s border-divider text-xs tabular-nums text-fg-muted" style={{ ...inlineStart(channelCol + slotX, rtl), width: slotPx }}>
            {/* Sticky past the channel column: the slot the window starts in keeps its time in
                view while the column covers its start, so the left of the grid is never unlabelled. */}
            <span className={cn('sticky px-2 whitespace-nowrap', covered && 'invisible')} style={{ insetInlineStart: channelCol }} data-testid="ruler-label">
              {labels[i]}
            </span>
          </div>
        );
      })}
    </div>
  );
});

/** Marks the group select's view entries (favorites, a list) apart from the source's group ids. */
const VIEW_OPTION = '@view:';

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
  view,
  lists,
  bar,
  start,
  end,
  nowInWindow,
  now,
  onQuery,
  onShift,
  onShiftDay,
  onNow,
  onJump,
  zoom,
  onZoom,
  genre,
  onGenre,
  previewOpen,
  onTogglePreview,
  onGoToPlaying,
}: {
  sources: readonly { id: string; name: string; channelCount?: number }[] | undefined;
  sourceId: string;
  categories: readonly { id: string; name: string; itemCount?: number; hidden?: boolean }[] | undefined;
  categoryId: string | undefined;
  view: GuideView | undefined;
  lists: readonly { id: string; name: string }[] | undefined;
  bar: 'full' | 'stacked' | 'phone';
  start: number;
  end: number;
  nowInWindow: boolean;
  /** For the phone's day label ("Today"). */
  now: number;
  onQuery(key: string, value: string | undefined): void;
  onShift(delta: number): void;
  onShiftDay(days: number): void;
  onNow(): void;
  onJump(): void;
  /** The time scale's step (GUIDE_ZOOM_SLOT_PX). */
  zoom: number;
  onZoom(delta: 1 | -1): void;
  /** CB-GUIDE-GENRE: the genre the cells are filtered to. */
  genre: Genre | null;
  onGenre(genre: Genre | null): void;
  /** The preview band's state; undefined where the band does not fit (no toggle then). */
  previewOpen?: boolean;
  onTogglePreview(): void;
  /** Scrolls to the playing channel's row; undefined while it is on screen or not in this list. */
  onGoToPlaying?: () => void;
}) {
  const { t, i18n } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const lang = i18n.language;
  // LG-11: the source and the group or view are pickers with sections, counts and a filter, not
  // OS dropdowns holding hundreds of groups with the lists mixed in.
  const sourceSections: PickerSection[] = useMemo(
    () => [{ id: 'sources', options: (sources ?? []).map((s) => ({ value: s.id, label: s.name, count: s.channelCount })) }],
    [sources],
  );
  // All channels, then the views (favorites, each custom list), then the source's groups.
  const groupSections: PickerSection[] = useMemo(
    () => [
      { id: 'all', options: [{ value: '', label: t('allChannels'), icon: <LayoutList size={14} /> }] },
      {
        id: 'views',
        heading: t('pickerViews'),
        options: [
          { value: `${VIEW_OPTION}${guideViewParam({ kind: 'favorites' })}`, label: tg('viewFavorites'), icon: <Heart size={14} /> },
          ...(lists ?? []).map((l) => ({
            value: `${VIEW_OPTION}${guideViewParam({ kind: 'list', id: l.id })}`,
            label: tg('viewList', { name: l.name }),
            icon: <ListVideo size={14} />,
          })),
        ],
      },
      {
        id: 'groups',
        heading: t('groups'),
        options: (categories ?? []).filter((c) => !c.hidden).map((c) => ({ value: c.id, label: c.name, count: c.itemCount })),
      },
    ],
    [categories, lists, t, tg],
  );
  const stacked = bar !== 'full';
  const phone = bar === 'phone';
  // One source with channels and it is on show (most accounts): a picker with one entry chose
  // nothing and took a phone's row from the group picker. The header names the source. While
  // the list loads the picker holds its place, so the toolbar does not shift for two sources.
  const sourcePicker = !sources || sources.length > 1 || (sources[0] !== undefined && sources[0].id !== sourceId);
  const oneRow = phone && !sourcePicker;
  // Wider pages: a picker starts at 9rem and grows to 12rem with the room the time controls leave.
  // At a fixed 12rem the 44 px touch controls of a 1024 px tablet wrapped onto a row of their own.
  const pickerWidth = 'min-w-0 max-w-48 grow basis-36';
  const range = formatTimeRange(start, end, lang);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-surface px-3 py-2">
      {/* A phone with a source to choose puts the two pickers side by side on a row of their own,
          of equal width. With one source the group picker shares the time controls' row when the
          group's name fits beside them, so a single row of controls leads the grid; the search is
          the header's field, and the genre filter and Go to playing are header actions
          (GuidePhoneActions). */}
      <div className={phone && sourcePicker ? 'grid w-full grid-cols-2 items-center gap-2' : 'contents'}>
        {sourcePicker ? (
          <ScopePicker
            label={t('guideSource')}
            value={sourceId}
            sections={sourceSections}
            onChange={(v) => onQuery('source', v)}
            filterLabel={t('filterSources')}
            className={phone ? 'h-9' : pickerWidth}
            testId="guide-source"
          />
        ) : null}
        <ScopePicker
          label={t('guideGroup')}
          value={view ? `${VIEW_OPTION}${guideViewParam(view)}` : (categoryId ?? '')}
          sections={groupSections}
          onChange={(v) => (v.startsWith(VIEW_OPTION) ? onQuery('view', v.slice(VIEW_OPTION.length)) : onQuery('category', v || undefined))}
          // Sharing a phone's row with the time controls, the picker is never narrower than the
          // group's name (fit-content, at most the row): a name that does not fit beside them pushes
          // them onto a row of their own rather than being cut ("US| SPORTS …" read as "US| SPORTS").
          // A name longer than the row wraps onto a second line. The group's name gets the icon's room.
          className={phone ? (sourcePicker ? 'h-9' : 'h-auto min-h-9 w-auto min-w-fit grow py-1') : pickerWidth}
          optionIcon={!oneRow}
          wrapLabel={oneRow}
          testId="guide-group"
        />
      </div>
      {/* Narrow pages give the time controls a full row; the window label takes what the buttons leave.
          On a phone's one row they take what the group picker leaves (nearly all of the free room
          goes to them, so the picker stays at its name's width), and a row of their own when they
          wrap under a long group name. */}
      <div
        className={oneRow ? 'flex min-w-0 grow-[999] items-center gap-1' : stacked ? 'flex w-full min-w-0 items-center gap-1' : 'ms-auto flex max-w-full items-center gap-1'}
        role="group"
        aria-label={t('guideTime')}
        data-testid="guide-time"
      >
        {bar !== 'phone' ? (
          <IconButton size="sm" icon={<ChevronsLeft className="size-4 rtl:rotate-180" />} onClick={() => onShiftDay(-1)} label={t('previousDay')} />
        ) : null}
        <IconButton size="sm" icon={<ChevronLeft className="size-4 rtl:rotate-180" />} onClick={() => onShift(-3 * HOUR)} label={t('earlier')} />
        {/* The window's span; pressing it opens Jump to date and time (`t`). The text is the same in
            wide and stacked layouts (day, space, times; stacked, the day sits small over the times). */}
        {oneRow ? (
          <GuideWindowDay start={start} end={end} now={now} lang={lang} onJump={onJump} />
        ) : (
          <Tooltip content={tg('jumpTitle')} shortcut="t" describe={false}>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={onJump}
              data-testid="guide-window"
              className={cn(
                'inline-flex h-8 items-center justify-center rounded-md px-2 tabular-nums text-fg outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus motion-safe:transition-colors',
                stacked ? 'min-w-0 flex-1 bg-surface-2 hover:bg-surface-3' : 'w-80 min-w-0 gap-1.5 text-sm whitespace-nowrap hover:bg-surface-2',
              )}
            >
              {stacked ? null : <CalendarClock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
              <span aria-live="polite" className={stacked ? 'flex max-w-full min-w-0 flex-col items-center leading-tight' : 'min-w-0 truncate'}>
                <span className={stacked ? 'max-w-full truncate text-[calc(11rem/15)] text-fg-muted' : undefined}>{formatDay(start, lang)}</span>{' '}
                <span className={stacked ? 'max-w-full truncate text-[calc(13rem/15)] font-medium' : undefined}>{range}</span>
              </span>
              <span className="sr-only">, {tg('jumpTitle')}</span>
            </button>
          </Tooltip>
        )}
        <IconButton size="sm" icon={<ChevronRight className="size-4 rtl:rotate-180" />} onClick={() => onShift(3 * HOUR)} label={t('later')} />
        {bar !== 'phone' ? (
          <IconButton size="sm" icon={<ChevronsRight className="size-4 rtl:rotate-180" />} onClick={() => onShiftDay(1)} label={t('nextDay')} />
        ) : null}
        <Button size="sm" variant={nowInWindow ? 'ghost' : 'primary'} className="shrink-0" onClick={onNow}>
          {t('jumpToNow')}
        </Button>
        {/* The time scale (Ctrl+scroll over the grid too); a phone keeps its row for the times. */}
        {bar !== 'phone' ? (
          // One − / + control for the time scale.
          <div role="group" aria-label={tg('zoom')} className="flex items-center rounded-md border border-edge bg-surface-2 p-0.5">
            <IconButton size="sm" icon={<ZoomOut className="size-4" />} disabled={zoom <= 0} onClick={() => onZoom(-1)} label={tg('zoomOut')} data-testid="guide-zoom-out" className="h-7 w-7" />
            <IconButton size="sm" icon={<ZoomIn className="size-4" />} disabled={zoom >= GUIDE_ZOOM_SLOT_PX.length - 1} onClick={() => onZoom(1)} label={tg('zoomIn')} data-testid="guide-zoom-in" className="h-7 w-7" />
          </div>
        ) : null}
      </div>
      {/* CB-GUIDE-GENRE: filter chips, one per bucket, with the bucket's stripe colour. One at a
          time, like Channels DVR's; a chosen chip is inverted, never amber. */}
      {phone ? null : (
        <div className="flex w-full min-w-0 items-center gap-1.5" data-testid="guide-genres">
          {/* A row too narrow for every chip scrolls, its end fading out so a chip cut at the edge reads as more to come. */}
          <div
            role="group"
            aria-label={tg('genreFilter')}
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [scrollbar-width:none] rtl:[mask-image:linear-gradient(to_left,#000_calc(100%-1.5rem),transparent)]"
          >
            {GENRES.map((g) => {
              const on = genre === g;
              return (
                <FilterChip key={g} pressed={on} dot={genreColor(g)} onClick={() => onGenre(on ? null : g)}>
                  {tg(`genre_${g}`)}
                </FilterChip>
              );
            })}
          </div>
          {onGoToPlaying ? (
            <Button size="sm" variant="ghost" icon={<LocateFixed className="size-4" />} onClick={onGoToPlaying} className="shrink-0" data-testid="guide-go-to-playing">
              <span className="max-sm:sr-only">{tg('goToPlaying')}</span>
            </Button>
          ) : null}
          {previewOpen !== undefined ? (
            // The label says what a press does, so no state as well: "Hide preview, pressed"
            // contradicted itself.
            <IconButton
              size="sm"
              label={previewOpen ? tg('hidePreview') : tg('showPreview')}
              icon={previewOpen ? <PanelTopClose className="size-4" /> : <PanelTopOpen className="size-4" />}
              onClick={onTogglePreview}
              className="shrink-0"
              data-testid="guide-preview-toggle"
            />
          ) : null}
        </div>
      )}
    </div>
  );
});


/**
 * The window label on a phone's one-row toolbar; pressing it opens Jump to date and time (`t`).
 * Its narrowest width is the widest of "Yesterday", "Today", "Tomorrow" and the day it shows
 * (hidden copies under it), and that is what the toolbar counts when it decides whether the time
 * controls fit beside the group picker. So stepping across midnight neither moves the picker or
 * the buttons nor sends the time controls to another row. Sharing the row, it shows the day alone
 * (the ruler right under it has the times) and reads out the date and times after it. On a row of
 * its own, under a group name too long to share the row, it has the room for the date over the
 * times, as the stacked layout shows them.
 */
const GuideWindowDay = memo(function GuideWindowDay({
  start,
  end,
  now,
  lang,
  onJump,
}: {
  start: number;
  end: number;
  now: number;
  lang: string;
  onJump(): void;
}) {
  const { t: tg } = useTranslation('guide');
  const day = shortDay(start, now, lang);
  const date = formatDay(start, lang);
  const range = formatTimeRange(start, end, lang);
  const sizes = [...new Set([relativeDay(-1, lang), relativeDay(0, lang), relativeDay(1, lang), day])];
  return (
    <span className="grid min-w-0 grow">
      {sizes.map((text) => (
        <span key={text} aria-hidden className="invisible col-start-1 row-start-1 truncate px-2.5 text-sm font-medium">
          {text}
        </span>
      ))}
      <Tooltip content={tg('jumpTitle')} shortcut="t" describe={false}>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={onJump}
          data-testid="guide-window"
          className={cn(
            '@container col-start-1 row-start-1 inline-flex h-8 min-w-0 items-center justify-center rounded-md bg-surface-2 px-2.5 tabular-nums text-fg outline-none hover:bg-surface-3 active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus motion-safe:transition-colors',
            TOUCH_TARGET,
          )}
        >
          <span aria-live="polite" className="flex max-w-full min-w-0 justify-center">
            {/* The visible day leads the spoken name, so "Today" is what voice control hears it called. */}
            <span className="truncate text-sm font-medium @min-[11rem]:hidden">
              {day}
              <span className="sr-only">
                , {date} {range}
              </span>
            </span>
            <span className="hidden max-w-full min-w-0 flex-col items-center leading-tight @min-[11rem]:flex">
              <span className="max-w-full truncate text-[calc(11rem/15)] text-fg-muted">{date}</span>{' '}
              <span className="max-w-full truncate text-[calc(13rem/15)] font-medium">{range}</span>
            </span>
          </span>
          <span className="sr-only">, {tg('jumpTitle')}</span>
        </button>
      </Tooltip>
    </span>
  );
});

/**
 * A phone's header actions on the guide (round 4): the genre filter as a picker, inverted while a
 * genre is chosen as a chosen chip is, and Go to playing while the playing row is off screen. In
 * the header they leave the toolbar a single row for the group and the time.
 */
const GuidePhoneActions = memo(function GuidePhoneActions({
  genre,
  onGenre,
  onGoToPlaying,
}: {
  genre: Genre | null;
  onGenre(genre: Genre | null): void;
  onGoToPlaying?: () => void;
}) {
  const { t: tg } = useTranslation('guide');
  const genreSections = useMemo(
    (): PickerSection[] => [
      { id: 'all', options: [{ value: '', label: tg('allGenres') }] },
      {
        id: 'genres',
        options: GENRES.map((g) => ({ value: g, label: tg(`genre_${g}`), icon: <span className="size-2 rounded-full" style={{ background: genreColor(g) }} /> })),
      },
    ],
    [tg],
  );
  return (
    <>
      {onGoToPlaying ? <IconButton label={tg('goToPlaying')} icon={<LocateFixed size={18} />} onClick={onGoToPlaying} className="shrink-0" data-testid="guide-go-to-playing" /> : null}
      <ScopePicker
        label={tg('genreFilter')}
        value={genre ?? ''}
        sections={genreSections}
        onChange={(v) => onGenre((v || null) as Genre | null)}
        triggerIcon={<ListFilter size={18} />}
        // At rest it sits borderless among the header's icon buttons; a chosen genre inverts it.
        className={genre ? undefined : 'border-transparent bg-transparent hover:bg-hover'}
        testId="guide-genre-picker"
      />
    </>
  );
});

/**
 * A channel row's menu (right click on the row, the context-menu key / Shift+F10 in the grid, or
 * a long press): Live's own menu (LG-13), headed by the channel and what is on (LG-16). Mounted
 * only while open, so the guide asks for favorite, list, edit and lock state on demand. F2 and
 * Shift+Delete belong to the Live list; the guide does not bind them, so no key hints here.
 */
function GuideRowMenu({
  menu,
  source,
  nowTitle,
  programme,
  now,
  onProgrammeLink,
  onPlay,
  onMapGuide,
  onToggleFavorite,
  onClose,
}: {
  menu: { pos: { x: number; y: number }; channel: Channel; programme?: EpgProgram };
  source: Source | undefined;
  nowTitle: string | undefined;
  programme?: EpgProgram;
  now: number;
  onProgrammeLink(url: string): void;
  onPlay(channel: Channel): void;
  onMapGuide(channel: Channel): void;
  onToggleFavorite(channel: Channel, wasFavorite: boolean): void;
  onClose(): void;
}) {
  const { stripCountryPrefix } = useDisplayPrefs();
  const ch = menu.channel;
  const name = displayChannelName(ch.name, stripCountryPrefix);
  const favorites = useRpcQuery('favorites.contains', { refs: [ch.ref] });
  const favorite = favorites.data ? favorites.data.some((r) => sameRef(r, ch.ref)) : undefined;
  const items = useChannelMenuItems(ch, { source, favorite, onPlay, onToggleFavorite, onMapGuide, programme, now, onProgrammeLink });
  return <ContextMenu pos={menu.pos} items={items} header={channelMenuHeader(ch, name, nowTitle)} label={name} onClose={onClose} />;
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
  const navigate = useNavigate(); // guide: "Browse catch-up"
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

  // Portaled, as the kit's Dialog is: rendered in the page, the mini player (later in the DOM at
  // the same z-index) painted over it, and its scrim left the mini player bright.
  return createPortal(
    <>
      {/* The sheet's scrim: pressing it is a press outside, which closes the sheet. */}
      {sheet ? <div aria-hidden data-scrim="" className="fixed inset-0 z-50 bg-scrim motion-safe:animate-fade-in" /> : null}
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
            ? 'fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-xl border-t border-edge bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-fg shadow-3 motion-safe:animate-sheet-in'
            : 'fixed z-50 w-[min(360px,calc(100vw-16px))] rounded-lg border border-edge bg-surface p-4 text-fg shadow-2'
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
          <button type="button" aria-label={t('close')} onClick={onClose} className="rounded-md p-1 text-fg-muted hover:bg-hover">
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
    </>,
    portalContainer(),
  );
}

/** Whether `cell` still shows in the grid's track: below the time header and clear of the channel column. */
function cellInView(cell: HTMLElement, grid: HTMLElement, channelCol: number, rtl: boolean): boolean {
  const box = grid.getBoundingClientRect();
  if (!(box.width > 0)) return true; // not laid out (tests): nothing to measure against
  const a = cell.getBoundingClientRect();
  const left = rtl ? box.left : box.left + channelCol;
  const right = rtl ? box.right - channelCol : box.right;
  // The ruler's height as drawn (it follows the UI scale).
  const header = grid.querySelector<HTMLElement>('[role="row"]')?.getBoundingClientRect().height || HEADER_H;
  return a.right > left && a.left < right && a.bottom > box.top + header && a.top < box.bottom;
}
