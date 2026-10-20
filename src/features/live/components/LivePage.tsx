import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, History, ListPlus, ListTree, Lock, Radio as RadioIcon, Search, Star, Tv } from 'lucide-react';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { categoriesArgs } from '@/api/bootPrefetch';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import {
  itemKey,
  sameRef,
  type Category,
  type Channel,
  type ContentType,
  type EpgNowNext,
  type ItemKey,
  type ItemRef,
  type PlayerSource,
} from '@/api/types';

import { Button, buttonClass, EmptyState, ErrorState, IconButton, SearchInput, useRowHeight, useToast, errorDescription } from '@/ui';
import { PlayerStage, useChannelZap, usePlayerStore } from '@/features/player';
import { canZap, isPendingZap } from '@/features/player/store';
import { hideZapBanner } from '@/features/player/zapBanner';
import { preloadChannelEditDialogs, useChannelEditShortcuts, useHiddenChannelCount } from '@/features/channeledit';
import { ListsSidebarSection, openAddGroupToList, useAddToListShortcut } from '@/features/lists';
import { requestPin } from '@/features/parental/gate';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { applyStatus, hidesContent, useParentalStatus } from '@/features/parental/status';
import { registerCommands, useShell, useShortcut } from '@/shell';
import { intlLocale } from '@/lib/intl';
import { channelMenuHeader, useChannelMenuItems } from '../hooks/useChannelMenuItems';
import { useDigitEntry } from '../hooks/useDigitEntry';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useLastChannel } from '../hooks/useLastChannel';
import { LIVE_VIEW_ID, liveViewOf, useLiveViewChannels } from '../hooks/useLiveViewChannels';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useNow } from '../hooks/useNow';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { useParentalLocks } from '../hooks/useParentalLocks';
import { STALKER_RIBBON_LIMIT } from '../hooks/useChannelPrograms';
import { usePortalEpg } from '../hooks/usePortalEpg';
import { useRemoteBridge } from '../hooks/useRemoteBridge';
import { useShortEpg, useShortEpgEnabled } from '../hooks/useShortEpg';
import { displayChannelName } from '../lib/channelName';
import { nowNextFrom, preferNowNext } from '../lib/epgMerge';
import { MINUTE } from '../lib/epgTime';
import { playChannel } from '../lib/playback';
import { needsFallback } from '../lib/shortEpg';
import { rememberGuideSource } from '../guide/lastSource';
import { CategorySidebar } from './CategorySidebar';
import { ChannelList } from './ChannelList';
import { CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, RowSkeleton } from './ChannelRow';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { DigitOsd, type ZapFeedback } from './DigitOsd';
import { EpgMappingDialog } from './EpgMappingDialog';
import { EpgRibbon } from './EpgRibbon';
import { HiddenChannelsButton } from './HiddenChannelsButton';
import { LiveStageColumn } from './LiveStageColumn';
import { ManageCategoriesDialog } from './ManageCategoriesDialog';
import { StageIdle } from './StageIdle';

const SIDEBAR_KEY = 'live.sidebarCollapsed';
const EMPTY_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/**
 * Typing pauses this long before the list searches. `catalog.channels` answers a 20k list in
 * 5-17 ms, so the wait is almost all of the time to results: short, and the old rows stay up
 * meanwhile (keepPrevious), so typing never flashes a skeleton (L2-live-2).
 */
export const SEARCH_DEBOUNCE_MS = 90;

/** The index of the channel row `el` is in, if any. */
function rowIndexOf(el: EventTarget | null): number | null {
  const row = el instanceof Element ? el.closest<HTMLElement>('[data-testid="channel-list"] [data-row-index]') : null;
  const i = row ? Number(row.dataset.rowIndex) : NaN;
  return Number.isInteger(i) ? i : null;
}

/** The ref of `source` when it is a live channel or station of `sourceId`. */
function liveRefOn(source: PlayerSource | undefined, sourceId: string): ItemRef | undefined {
  const ref = source?.ref;
  return ref && ref.sourceId === sourceId && (ref.contentType === 'live' || ref.contentType === 'radio') ? ref : undefined;
}

/**
 * The groups the sidebar lists, taken from the `includeHidden` answer so the page asks once, not
 * twice for the same rows (L3-perf-desktop-7). It matches `catalog.categories` without
 * `includeHidden`: no hidden groups, and no groups that hidden channels left empty (C2). The core
 * marks those with `emptiedByEdits`, so a group the provider ships empty still shows. An older core
 * does not send the flag; then, while the source has hidden channels, every group with no channels
 * is left out.
 */
export function shownGroups(all: readonly Category[], channelsHidden: boolean): Category[] {
  return all.filter((c) => !c.hidden && !(c.emptiedByEdits ?? (channelsHidden && c.itemCount === 0)));
}

const MemoRibbon = memo(EpgRibbon);
const MemoSidebar = memo(CategorySidebar);
const MemoManageDialog = memo(ManageCategoriesDialog);
const MemoMappingDialog = memo(EpgMappingDialog);
const MemoContextMenu = memo(ContextMenu);

export function LivePage({ mode = 'live' }: { mode?: 'live' | 'radio' }) {
  const { t, i18n } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const { toast } = useToast();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const sourceId = params.sourceId ?? '';
  const isRadio = mode === 'radio';
  const routeCategory = (isRadio ? searchParams.get('category') : params.categoryId) ?? undefined;
  // LG-12: Favorites and Recently watched are pinned groups with their own ids in the route.
  const liveView = liveViewOf(routeCategory);
  const categoryId = liveView ? undefined : routeCategory;
  const contentType: ContentType = isRadio ? 'radio' : 'live';
  const now = useNow(30_000);
  const prefs = useDisplayPrefs();

  // ---- data ---------------------------------------------------------------
  const source = useRpcQuery('sources.get', { id: sourceId }, { enabled: !!sourceId });
  const settings = useRpcQuery('settings.get', undefined);
  const allCategories = useRpcQuery('catalog.categories', categoriesArgs(sourceId, contentType), { enabled: !!sourceId });
  // The query behind "Hidden channels (n)" below the groups: no request of its own.
  const channelsHidden = (useHiddenChannelCount(sourceId) ?? 0) > 0;
  const groups = useMemo(
    () => (allCategories.data ? shownGroups(allCategories.data, channelsHidden) : undefined),
    [allCategories.data, channelsHidden],
  );
  const hiddenCount = useMemo(() => (allCategories.data ?? []).filter((c) => c.hidden).length, [allCategories.data]);
  const category = useMemo(() => groups?.find((c) => c.id === categoryId), [groups, categoryId]);

  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Typing is debounced; Enter or clearing commits at once, so Enter lands in the new list, not the old one.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const value = search.trim();
    const timer = setTimeout(() => setDebouncedSearch(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const commitSearch = useCallback((raw: string) => setDebouncedSearch(raw.trim()), []);
  const clearSearch = useCallback(() => {
    setSearch('');
    setDebouncedSearch('');
  }, []);
  useEffect(() => clearSearch(), [sourceId, routeCategory, clearSearch]);
  // The rail's TV guide link opens the guide on the source browsed here (L4-live-2).
  useEffect(() => rememberGuideSource(sourceId), [sourceId]);
  /** Focus the list cursor once the committed search's rows are on screen. */
  const focusListPending = useRef(false);

  const kind = source.data?.kind;
  // guide: Xtream channels without XMLTV show the panel's short EPG.
  const shortEpgOn = useShortEpgEnabled(kind);
  const groupPaged = usePagedChannels({
    // A pinned view lists its own channels: the source's pages are not asked for.
    sourceId: liveView ? '' : sourceId,
    categoryId,
    search: debouncedSearch,
    radio: isRadio,
    now,
    stalkerEpg: kind === 'stalker',
    shortEpg: shortEpgOn,
    epgOffsetMinutes: prefs.epgOffsetMinutes,
  });
  const viewPaged = useLiveViewChannels(liveView, { sourceId, contentType, search: debouncedSearch, now, epgOffsetMinutes: prefs.epgOffsetMinutes });
  const paged = viewPaged ?? groupPaged;
  // The loading skeleton matches the list's rows at the current scale and density.
  const rowHeight = useRowHeight(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING);
  useEffect(() => {
    if (!focusListPending.current || paged.isLoading || paged.refreshing) return;
    focusListPending.current = false;
    document.querySelector<HTMLButtonElement>('[data-testid="channel-list"] [data-row-index][tabindex="0"]')?.focus();
  });

  // ---- playback -----------------------------------------------------------
  const playerSource = usePlayerStore((s) => s.source);
  // PageUp/PageDown are channel up/down while a live channel plays in the app (the playback shortcuts' rule).
  const zapKeys = usePlayerStore((s) => !!s.source && s.mode !== 'external' && canZap(s));
  const stageBusy = !!playerSource;
  // The list marks and follows every channel a zap passes: the row moves with each press.
  const playingRef = liveRefOn(playerSource, sourceId);
  // A zap burst puts up a placeholder per press and tunes only the channel it stops on. The playing
  // channel's details (catalog row, guide, ribbon) follow the settled source, so a burst of eight
  // presses fetches one channel's details, not eight (L3-live-7). Meanwhile the ribbon keeps what it showed.
  const [detailSource, setDetailSource] = useState(() => (isPendingZap(playerSource) ? undefined : playerSource));
  if (detailSource !== playerSource && !isPendingZap(playerSource)) setDetailSource(playerSource);
  const detailRef = liveRefOn(detailSource, sourceId);
  const playingItem = useRpcQuery('catalog.item', { ref: detailRef ?? EMPTY_REF }, { enabled: !!detailRef, staleTime: 5 * 60_000 });
  const playingChannel = detailRef ? (playingItem.data as Channel | undefined) : undefined;
  // The number finds the playing row outside the loaded pages; mid-burst the details are the previous channel's.
  const playingNumber = playingChannel && playingRef && sameRef(playingChannel.ref, playingRef) ? playingChannel.number : undefined;
  // ChannelList reports the cursor only once it settles, so a held arrow key doesn't fetch a
  // guide (and flash a skeleton) for every channel passed on the way. The report belongs to the
  // list it came from: once the list changes (search, group, source) or is replaced by a loading,
  // empty or error state, the old cursor channel no longer drives the ribbon.
  const listKey = `${contentType}|${sourceId}|${routeCategory ?? ''}|${debouncedSearch}`;
  const listShown = !paged.error && !paged.isLoading && paged.total !== 0;
  const [reported, setReported] = useState<{ key: string; channel: Channel | undefined }>({ key: '', channel: undefined });
  const listKeyRef = useRef(listKey);
  listKeyRef.current = listKey;
  const onActiveChange = useCallback((channel: Channel | undefined) => setReported({ key: listKeyRef.current, channel }), []);
  const activeChannel =
    listShown && reported.key === listKey && reported.channel?.ref.sourceId === sourceId ? reported.channel : undefined;
  const ribbonChannel = playingChannel ?? activeChannel;
  // C3 `l`: add the focused row to a list.
  useAddToListShortcut(activeChannel, paged.getChannel);
  // C2 F2 / Shift+Delete: rename / hide the row that has focus when the key is pressed. It is read
  // then, not tracked from focus events: focus that a dialog hands back on close fires none
  // (L3-live-2), and nothing re-renders as focus moves (L2-perf-ui-8).
  const getChannel = paged.getChannel;
  const focusedRowChannel = useCallback(() => {
    const i = rowIndexOf(document.activeElement);
    return i === null ? undefined : getChannel(i);
  }, [getChannel]);
  useChannelEditShortcuts(listShown ? focusedRowChannel : undefined);
  // The rename and hidden-channels dialogs' code, fetched while the page idles: their first open
  // waited 330-360 ms on it with nothing on screen (L3-live-6).
  useEffect(() => {
    const warm = () => void preloadChannelEditDialogs();
    if (typeof requestIdleCallback === 'function') {
      const h = requestIdleCallback(warm, { timeout: 3000 });
      return () => cancelIdleCallback(h);
    }
    const h = setTimeout(warm, 1000);
    return () => clearTimeout(h);
  }, []);
  const watchingLive = !!detailSource?.isLive && !!ribbonChannel && sameRef(detailSource.ref, ribbonChannel.ref);
  const watchingArchive = !!detailSource && !detailSource.isLive && !!ribbonChannel && sameRef(detailSource.ref, ribbonChannel.ref);
  // The guide ribbon follows a tune in a background render: the click's own commit (row marked,
  // player up) paints first, and the ribbon's programmes come right after (L1-live-20).
  const ribbon = useDeferredValue(
    useMemo(() => ({ channel: ribbonChannel, watchingLive, watchingArchive }), [ribbonChannel, watchingLive, watchingArchive]),
  );
  const offset = prefs.epgOffsetMinutes;
  const playingNowNext = useRpcQuery(
    'epg.nowNext',
    offset ? { refs: detailRef ? [detailRef] : [], offsetMinutes: offset } : { refs: detailRef ? [detailRef] : [] },
    { enabled: !!detailRef, staleTime: 60_000 },
  );
  // The ribbon's own request for the channel (its archive past aside), so a tune asks the portal
  // once, not once for now/next and again for the ribbon (LV-8).
  const playingPortalEpg = usePortalEpg(
    { ref: detailRef ?? EMPTY_REF, limit: STALKER_RIBBON_LIMIT },
    { enabled: !!detailRef && kind === 'stalker', staleTime: 60_000 },
  );
  const playingXmltv = playingNowNext.data ? Object.values(playingNowNext.data)[0] : undefined;
  // guide: the panel's short EPG once XMLTV answered without anything airing.
  const playingShortEpg = useShortEpg(detailRef, shortEpgOn && !!playingNowNext.data && needsFallback(playingXmltv));
  // Unshifted programmes: the one shown as airing is the one airing at `now - offset`.
  const currentNowNext = detailRef
    ? preferNowNext(
        kind === 'stalker' ? nowNextFrom(playingPortalEpg.data, now - offset * MINUTE) : undefined,
        preferNowNext(playingXmltv, nowNextFrom(playingShortEpg, now - offset * MINUTE)),
      )
    : undefined;

  useEffect(() => {
    // A pinned view zaps through the source; playing from Favorites then walks the favorites (below).
    // Recently watched only marks the context, so the mini player's Expand comes back to it.
    if (sourceId)
      usePlayerStore.setState({ zapContext: categoryId ? { sourceId, categoryId } : liveView === 'recent' ? { sourceId, view: 'recent' } : { sourceId } });
  }, [sourceId, categoryId, liveView]);

  const zap = useChannelZap();
  const queryClient = useQueryClient();

  const play = useCallback(
    (channel: Channel, nn?: EpgNowNext) => {
      // `kind` is the loaded source's: never pair it with a channel of another source (a ribbon or
      // row left over from before a source switch would be played as the wrong kind).
      if (!kind || source.data?.id !== channel.ref.sourceId) return;
      const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
      // The row is what `catalog.item` answers for it: the playing channel's lookup above (and the
      // player's) finds it instead of asking the catalog again (XB2-12).
      const itemQuery = rpcKey('catalog.item', { ref: channel.ref });
      if (queryClient.getQueryData(itemQuery) === undefined) queryClient.setQueryData(itemQuery, channel);
      playChannel(channel, kind, nn?.now?.title, name)
        .then(() => {
          // LG-12: from Favorites, channel up and down walk the favorites in their order, as on the
          // Favorites page (library/lib/open.ts).
          if (liveView === 'favorites' && sameRef(usePlayerStore.getState().source?.ref, channel.ref)) {
            usePlayerStore.setState({ zapContext: { sourceId: channel.ref.sourceId, favorites: { sourceId: channel.ref.sourceId } } });
          }
        })
        .catch((err: unknown) => toast({ title: t('playFailed', { name }), description: errorDescription(err), variant: 'error' }));
    },
    [kind, source.data?.id, prefs.stripCountryPrefix, t, toast, queryClient, liveView],
  );

  // ---- number entry -------------------------------------------------------
  const [osd, setOsd] = useState<ZapFeedback | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashOsd = useCallback((s: ZapFeedback, ms = 2000) => {
    if (osdTimer.current) clearTimeout(osdTimer.current);
    hideZapBanner();
    setOsd(s);
    osdTimer.current = setTimeout(() => setOsd(null), ms);
  }, []);
  useEffect(() => () => {
    if (osdTimer.current) clearTimeout(osdTimer.current);
  }, []);

  const selectNumber = useCallback(
    async (n: number) => {
      try {
        // The number belongs to the list on screen: radio numbers never zap to the live channel with that number.
        const ch = await rpc('catalog.channelByNumber', { sourceId, number: n, contentType: isRadio ? 'radio' : 'live' });
        if (ch) {
          // The zap banner (or the radio stage) names the channel it tuned to: the number readout just goes.
          if (osdTimer.current) clearTimeout(osdTimer.current);
          setOsd(null);
          play(ch);
        } else {
          flashOsd({ kind: 'missing', number: n });
        }
      } catch (err) {
        flashOsd({ kind: 'missing', number: n });
        toast({ title: t('zapFailed'), description: errorDescription(err), variant: 'error' });
      }
    },
    [sourceId, isRadio, flashOsd, play, t, toast],
  );
  // The highest channel number, asked once digits are typed: a number that no longer number can
  // extend commits at once instead of waiting out the pause (L2-live-7).
  const [digitsUsed, setDigitsUsed] = useState(false);
  const topNumber = useRpcQuery(
    'catalog.channels',
    { sourceId, radio: isRadio || undefined, query: { offset: 0, limit: 1, sort: 'number', dir: 'desc' } },
    { enabled: !!sourceId && digitsUsed, staleTime: 5 * 60_000 },
  );
  const maxNumber = topNumber.data ? (topNumber.data.items[0]?.number ?? 0) : undefined;
  // Digits typed hard on the heels of a number that committed early belong to it. Together they pass
  // the highest number, so the readout says no channel has it instead of starting a new number (L3-live-9).
  const digits = useDigitEntry((n) => void selectNumber(n), undefined, maxNumber, (n) => flashOsd({ kind: 'missing', number: n }));
  useEffect(() => {
    if (digits.buffer) {
      if (osdTimer.current) clearTimeout(osdTimer.current);
      // The readout owns the picture's top while you type; the zap that follows brings the banner back.
      hideZapBanner();
      setOsd({ kind: 'typing', digits: digits.buffer });
    }
  }, [digits.buffer]);

  // ---- sidebar ------------------------------------------------------------
  const wide = useMediaQuery('(min-width: 1024px)');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleSidebar = useCallback(() => {
    if (!wide) {
      setDrawerOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1');
      } catch {
        // storage unavailable
      }
      return !c;
    });
  }, [wide]);
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);
  // The drawer is a modal dialog: focus moves in when it opens and back to where it came from when it closes.
  const drawerRef = useRef<HTMLElement>(null);
  const drawerReturn = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    drawerReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.querySelector<HTMLElement>('input, a[href], button:not([disabled])')?.focus();
    return () => {
      const back = drawerReturn.current;
      drawerReturn.current = null;
      if (back?.isConnected) back.focus();
    };
  }, [drawerOpen]);
  const onDrawerKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDrawerOpen(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>('input, a[href], button:not([disabled])') ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const [manageOpen, setManageOpen] = useState(false);
  const openManage = useCallback(() => setManageOpen(true), []);
  const closeManage = useCallback(() => setManageOpen(false), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const [mapping, setMapping] = useState<Channel | null>(null);
  const closeMapping = useCallback(() => setMapping(null), []);
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; channel: Channel; favorite: boolean; nowTitle?: string } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ pos: { x: number; y: number }; category: Category } | null>(null);

  const shortcutArea = t('shortcutArea');
  useShortcut('mod+b', (e) => {
    e.preventDefault();
    toggleSidebar();
  }, { description: t('shortcutToggleSidebar'), area: shortcutArea });
  useShortcut('/', (e) => {
    e.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  }, { description: t('shortcutFocusSearch'), area: shortcutArea });
  useShortcut('digit', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    setDigitsUsed(true);
    digits.push(e.key);
  }, { description: t('shortcutDigits'), area: shortcutArea });

  // LG-01: the guide opens on this group, at the channel playing here (or the list's cursor).
  const guideFocus = playingRef?.itemId ?? activeChannel?.ref.itemId;
  const guideHref = isRadio
    ? guideLink(sourceId)
    : liveView === 'favorites'
      ? `${guideLink(sourceId, undefined, guideFocus)}&view=favorites`
      : guideLink(sourceId, categoryId, guideFocus);
  useEffect(
    () =>
      registerCommands([
        { id: 'live.toggleSidebar', title: t('shortcutToggleSidebar'), group: shortcutArea, shortcut: 'mod+b', run: toggleSidebar },
        { id: 'live.manageGroups', title: t('manageCategories'), group: shortcutArea, keywords: ['hide', 'categories'], run: () => setManageOpen(true) },
      ]),
    [t, shortcutArea, toggleSidebar],
  );

  // ---- header -------------------------------------------------------------
  const shell = useShell();
  const title = source.data?.name ?? '';
  const subtitle =
    liveView === 'favorites'
      ? t('favoritesGroup')
      : liveView === 'recent'
        ? t('recentGroup')
        : (category?.name ?? (isRadio ? t('allStations') : t('allChannels')));
  const countText = paged.total !== undefined ? t(isRadio ? 'stationCount' : 'channelCount', { count: paged.total, formatted: fmt.format(paged.total) }) : '';
  // The group and its count once, in the header: the list no longer repeats them over its rows.
  const headerSubtitle = countText ? t('groupWithCount', { group: subtitle, count: countText }) : subtitle;
  useEffect(() => {
    if (!title) return;
    shell.setHeader({
      title,
      subtitle: headerSubtitle,
      actions: (
        <Link
          to={guideHref}
          aria-label={t('openGuide')}
          className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          <CalendarClock className="size-4" aria-hidden />
          {/* Icon only on a phone, so the label does not squeeze the page title. */}
          <span className="max-sm:sr-only">{t('openGuide')}</span>
        </Link>
      ),
    });
  }, [title, headerSubtitle, guideHref, i18n.language]);
  useEffect(() => () => shell.setHeader({ title: '' }), []);

  // ---- remote control -----------------------------------------------------
  const selectRef = useCallback(
    async (ref: ItemRef) => {
      try {
        const ch = (await rpc('catalog.item', { ref })) as Channel;
        play(ch);
      } catch {
        // unknown id: ignore
      }
    },
    [play],
  );
  useRemoteBridge({
    sourceId,
    sourceName: source.data?.name,
    up: zap.up,
    down: zap.down,
    selectNumber: (n) => void selectNumber(n),
    selectRef: (r) => void selectRef(r),
    current: playingChannel,
    currentName: playingChannel ? displayChannelName(playingChannel.name, prefs.stripCountryPrefix) : undefined,
    currentNowNext,
  });

  // ---- favorites & menu -----------------------------------------------------
  // The star flips at once; the core's answer (or a failure) settles it. One toggle per channel is
  // in flight at a time, so a double click cannot add and remove in a race.
  const [favOverrides, setFavOverrides] = useState<ReadonlyMap<ItemKey, boolean>>(() => new Map());
  const favInFlight = useRef(new Set<ItemKey>());
  const setOverride = useCallback((key: ItemKey, value: boolean | undefined) => {
    setFavOverrides((prev) => {
      const next = new Map(prev);
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }, []);
  const toggleFavorite = useCallback(
    async (channel: Channel, wasFavorite: boolean) => {
      const key = itemKey(channel.ref);
      if (favInFlight.current.has(key)) return;
      favInFlight.current.add(key);
      setOverride(key, !wasFavorite);
      try {
        const res = await rpc('favorites.toggle', {
          ref: channel.ref,
          snapshot: { title: channel.name, subtitle: channel.categoryName, posterUrl: channel.logoUrl, contentType: channel.ref.contentType },
        });
        setOverride(key, res.isFavorite);
        await invalidate('favorites.');
        const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
        toast({ title: res.isFavorite ? t('favoriteAdded', { name }) : t('favoriteRemoved', { name }), variant: 'success' });
      } catch (err) {
        toast({
          title: wasFavorite ? t('favoriteRemoveFailed') : t('favoriteAddFailed'),
          description: errorDescription(err),
          variant: 'error',
        });
      } finally {
        favInFlight.current.delete(key);
        // The refetched `favorites.contains` is the truth from here on.
        setOverride(key, undefined);
      }
    },
    [t, toast, prefs.stripCountryPrefix, setOverride],
  );
  const onToggleFavorite = useCallback((c: Channel, fav: boolean) => void toggleFavorite(c, fav), [toggleFavorite]);
  // The menu's header says what is on: the row's own now/next, read when the menu opens.
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const onContextMenu = useCallback((pos: { x: number; y: number }, channel: Channel, favorite: boolean) => {
    const p = pagedRef.current;
    const at = p.loaded.find((l) => sameRef(l.channel.ref, channel.ref))?.index;
    setMenu({ pos, channel, favorite, nowTitle: at === undefined ? undefined : p.getNowNext(at)?.now?.title });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const navigate = useNavigate();
  const menuChannel = menu?.channel ?? null;
  // LG-13: the menu every channel row has (Live, lists, the guide), in three sections.
  const menuItems = useChannelMenuItems(menuChannel, {
    source: source.data,
    favorite: menu?.favorite,
    onPlay: play,
    onToggleFavorite: onToggleFavorite,
    onMapGuide: setMapping,
    editHints: true,
  });
  const groupLockItems = useLockMenuItems(
    groupMenu
      ? { sourceId, contentType, kind: 'category', targetId: groupMenu.category.id, name: groupMenu.category.name }
      : null,
  );
  // Ask mode: what will ask for the PIN carries a lock in the groups and the list (C2).
  const locks = useParentalLocks(sourceId, contentType);
  // A locked channel's programme stays back until the PIN, in the menu as in its row (C2).
  const menuHeader = menu
    ? channelMenuHeader(menu.channel, displayChannelName(menu.channel.name, prefs.stripCountryPrefix), locks.channelLocked(menu.channel) ? undefined : menu.nowTitle)
    : undefined;
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  const openGroupMenu = useCallback((pos: { x: number; y: number }, category: Category) => setGroupMenu({ pos, category }), []);
  // LG-13: every group has a menu: add the whole group to a list, open it in the guide, and (C2) lock it.
  const groupMenuItems: MenuEntry[] = useMemo(() => {
    if (!groupMenu) return [];
    const c = groupMenu.category;
    return [
      {
        id: 'group-add-to-list',
        label: t('addGroupToList'),
        icon: <ListPlus className="size-4" />,
        disabled: c.itemCount === 0,
        onSelect: () => openAddGroupToList({ sourceId, contentType, categoryId: c.id, name: c.name, count: c.itemCount }),
      },
      ...(isRadio
        ? []
        : [{ id: 'group-guide', label: t('openGroupInGuide'), icon: <CalendarClock className="size-4" />, onSelect: () => void navigate(guideLink(sourceId, c.id)) }]),
      { id: 'sep-lock', type: 'separator' as const },
      ...groupLockItems,
    ];
  }, [groupMenu, groupLockItems, sourceId, contentType, isRadio, navigate, t]);

  // LG-12: Favorites and Recently watched sit above All channels (one array, so the memoised sidebar stays put).
  const pinnedViews = useMemo(
    () => [
      { id: LIVE_VIEW_ID.favorites, label: t('favoritesGroup'), icon: <Star size={14} /> },
      { id: LIVE_VIEW_ID.recent, label: t('recentGroup'), icon: <History size={14} /> },
    ],
    [t],
  );

  const hrefForCategory = useCallback(
    (cid?: string) =>
      isRadio
        ? `/s/${encodeURIComponent(sourceId)}/radio${cid ? `?category=${encodeURIComponent(cid)}` : ''}`
        : `/s/${encodeURIComponent(sourceId)}/live${cid ? `/${encodeURIComponent(cid)}` : ''}`,
    [isRadio, sourceId],
  );
  const refetchCategories = allCategories.refetch;
  const retryCategories = useCallback(() => void refetchCategories(), [refetchCategories]);
  const onPlayLive = useCallback((c: Channel) => play(c), [play]);

  // Parental Hide mode can leave a source's list empty: say so, and offer the PIN, rather than
  // pointing at Sources as if the source were broken (L2-settings-4).
  const parentalStatus = useParentalStatus().data;
  const parentalHiding = !!parentalStatus && hidesContent(parentalStatus);
  const sourceCount = source.data ? (isRadio ? (source.data.radioCount ?? 0) : source.data.channelCount) : 0;
  const unlockParental = useCallback(() => {
    void requestPin({
      title: t('parentalUnlockTitle'),
      description: t('parentalUnlockBody'),
      confirmLabel: t('parentalUnlock'),
      submit: async (pin) => {
        applyStatus(await rpc('parental.unlock', { pin }));
      },
    });
  }, [t]);

  // ---- idle stage ---------------------------------------------------------
  const selectRefPlay = useCallback((ref: ItemRef) => void selectRef(ref), [selectRef]);
  // CB-AUTOPLAY-LAST without autoplay: the stage offers the channel last watched on this source.
  const last = useLastChannel({
    contentType,
    sourceId,
    accept: (r) => r.sourceId === sourceId,
    enabled: !!sourceId && !stageBusy,
    epgOffsetMinutes: prefs.epgOffsetMinutes,
  });
  const lastChannel = last?.channel;
  // Radio's idle stage, with no station to resume, offers the list's first stations as tiles.
  const loadedRows = paged.loaded;
  const firstStations = useMemo(() => (isRadio ? loadedRows.slice(0, 12).map((l) => l.channel) : undefined), [isRadio, loadedRows]);
  const idle = (
    <StageIdle
      kind={isRadio ? 'radio' : 'live'}
      last={lastChannel ? { channel: lastChannel, nowNext: last?.nowNext } : undefined}
      now={now}
      stripPrefix={prefs.stripCountryPrefix}
      epgOffsetMinutes={prefs.epgOffsetMinutes}
      onResume={onPlayLive}
      // Radio's stage has room below Resume: the other stations played lately, one press each.
      recent={isRadio ? last?.others : undefined}
      stations={isRadio && !lastChannel ? firstStations : undefined}
      onPlayRef={selectRefPlay}
    />
  );

  // ---- render -------------------------------------------------------------
  // The shell header title is a <p>; the page owns its single h1 (same text as the header title).
  const heading = <h1 className="sr-only">{title || (isRadio ? t('stations') : t('channels'))}</h1>;
  if (source.error) {
    return (
      <div className="flex h-full items-center justify-center">
        {heading}
        <ErrorState error={source.error} onRetry={() => void source.refetch()} />
      </div>
    );
  }

  const hrefFor = hrefForCategory;

  // Run 2: the Lists group above the groups (C3), and the source's hidden channels below them (C2).
  const sidebar = (
    <>
      <ListsSidebarSection onNavigate={closeDrawer} />
      <div className="flex min-h-0 flex-1 flex-col">
        <MemoSidebar
          categories={groups}
          hiddenCount={hiddenCount}
          isLoading={allCategories.isLoading}
          error={allCategories.error}
          onRetry={retryCategories}
          activeId={routeCategory}
          hrefFor={hrefFor}
          pinned={pinnedViews}
          onManage={openManage}
          onNavigate={closeDrawer}
          totalLabel={isRadio ? t('allStations') : t('allChannels')}
          onGroupMenu={openGroupMenu}
          isLocked={locks.categoryLocked}
        />
      </div>
      <HiddenChannelsButton sourceId={sourceId} />
    </>
  );

  const listEmpty = paged.total === 0;
  let listBody;
  if (paged.error) {
    listBody = <ErrorState error={paged.error} onRetry={paged.retry} />;
  } else if (paged.isLoading) {
    listBody = (
      <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-busy="true" aria-label={t('loadingChannels')} data-testid="channel-list-loading">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="border-b border-divider" style={{ height: rowHeight }}>
            <RowSkeleton pulse />
          </div>
        ))}
      </div>
    );
  } else if (listEmpty && debouncedSearch) {
    listBody = (
      <EmptyState
        icon={<Search className="size-6" />}
        title={t(isRadio ? 'noStationSearchResults' : 'noSearchResults', { query: debouncedSearch })}
        description={category ? t('noSearchResultsInGroup', { group: category.name }) : undefined}
        action={
          <Button size="sm" onClick={clearSearch}>
            {t('clearSearch')}
          </Button>
        }
      />
    );
  } else if (listEmpty && liveView) {
    listBody = (
      <EmptyState
        icon={liveView === 'favorites' ? <Star className="size-6" /> : <History className="size-6" />}
        title={liveView === 'favorites' ? t(isRadio ? 'favoritesEmptyStations' : 'favoritesEmpty') : t('recentEmpty')}
        description={liveView === 'favorites' ? t('favoritesEmptyHint') : t('recentEmptyHint')}
        action={
          <Link to={hrefFor(undefined)} className={buttonClass('secondary', 'sm')}>
            {isRadio ? t('allStations') : t('allChannels')}
          </Link>
        }
      />
    );
  } else if (listEmpty && categoryId) {
    listBody = (
      <EmptyState
        icon={<ListTree className="size-6" />}
        title={t('emptyGroup')}
        action={
          <Link
            to={hrefFor(undefined)}
            className={buttonClass('secondary', 'sm')}
          >
            {isRadio ? t('allStations') : t('allChannels')}
          </Link>
        }
      />
    );
  } else if (listEmpty && hiddenCount > 0) {
    listBody = (
      <EmptyState
        icon={<ListTree className="size-6" />}
        title={t('allGroupsHidden')}
        action={
          <Button size="sm" onClick={openManage}>
            {t('showGroups')}
          </Button>
        }
      />
    );
  } else if (listEmpty && parentalHiding && (sourceCount > 0 || (allCategories.data?.length ?? 0) > 0)) {
    listBody = (
      <EmptyState
        icon={<Lock className="size-6" />}
        title={t(isRadio ? 'parentalHiddenStations' : 'parentalHiddenChannels')}
        description={t('parentalHiddenHint')}
        action={
          <Button size="sm" icon={<Lock className="size-3.5" />} onClick={unlockParental} data-testid="live-parental-unlock">
            {t('parentalUnlock')}
          </Button>
        }
      />
    );
  } else if (listEmpty) {
    listBody = (
      <EmptyState
        icon={isRadio ? <RadioIcon className="size-6" /> : <Tv className="size-6" />}
        title={isRadio ? t('noStations') : t('noChannels')}
        description={t('noChannelsHint')}
        action={
          <Link to="/sources" className={buttonClass('primary', 'sm')}>
            {t('openSources')}
          </Link>
        }
      />
    );
  } else {
    listBody = (
      <ChannelList
        paged={paged}
        resetKey={listKey}
        playingRef={playingRef}
        playingNumber={playingNumber}
        zapKeys={zapKeys}
        openOnDoubleClick={settings.data?.openStreamOnDoubleClick ?? false}
        now={now}
        compact={false}
        station={isRadio}
        sourceKind={kind}
        onPlay={play}
        onToggleFavorite={onToggleFavorite}
        onContextMenu={onContextMenu}
        favoriteOverrides={favOverrides}
        onActiveChange={onActiveChange}
        locks={locks}
      />
    );
  }

  const sidebarVisible = wide && !collapsed;

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-bg md:flex-row" data-testid={isRadio ? 'radio-page' : 'live-page'}>
      {heading}
      {/* groups: column on wide screens, drawer below 1024 px */}
      {sidebarVisible ? (
        <aside className="flex w-60 shrink-0 flex-col border-e border-divider bg-surface">{sidebar}</aside>
      ) : null}
      {!wide && drawerOpen ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" aria-hidden onClick={() => setDrawerOpen(false)} />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('groups')}
            data-testid="groups-drawer"
            onKeyDown={onDrawerKeyDown}
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col border-e border-edge bg-surface shadow-2"
          >
            {sidebar}
          </aside>
        </>
      ) : null}

      {/* channel list: beside the stage from 768 px, under it on a phone */}
      <section
        aria-label={isRadio ? t('stations') : t('channels')}
        className="flex min-h-0 w-full flex-1 flex-col border-divider bg-surface md:w-[clamp(272px,34vw,400px)] md:min-w-60 md:flex-initial md:border-e"
      >
        <div className="flex items-center gap-1 border-b border-divider px-2 py-2">
          <IconButton
            size="sm"
            label={sidebarVisible || drawerOpen ? t('hideGroups') : t('showGroupsPanel')}
            aria-expanded={sidebarVisible || drawerOpen}
            icon={<ListTree className="size-4" />}
            onClick={toggleSidebar}
          />
          <SearchInput
            size="sm"
            className="min-w-0 flex-1"
            value={search}
            // Clearing (the clear button) commits at once, like Escape.
            onChange={(v) => (v === '' ? clearSearch() : setSearch(v))}
            onKeyDown={(e) => {
              const toList = () =>
                document.querySelector<HTMLButtonElement>('[data-testid="channel-list"] [data-row-index][tabindex="0"]')?.focus();
              if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
                e.preventDefault();
                if (search.trim() !== debouncedSearch) {
                  // The typed query has not reached the list yet: run it now, focus its first row when it lands.
                  commitSearch(search);
                  focusListPending.current = true;
                } else toList();
              } else if (e.key === 'Escape') {
                // First Escape clears the query, the second hands focus back to the list.
                e.preventDefault();
                e.stopPropagation();
                if (search) clearSearch();
                else toList();
              }
            }}
            ref={searchRef}
            placeholder={category ? t('searchInGroup', { group: category.name }) : t(isRadio ? 'searchStations' : 'searchChannels')}
            label={t(isRadio ? 'searchStations' : 'searchChannels')}
          />
        </div>
        {/* The count is in the header; screen readers hear it change as a search narrows the list. */}
        <p className="sr-only" aria-live="polite">
          {countText}
        </p>
        {listBody}
      </section>

      {isRadio ? (
        <section aria-label={t('stage')} className="order-first flex min-w-0 shrink-0 flex-col md:order-none md:min-w-[min(300px,40%)] md:flex-1">
          <RadioStage idle={idle} />
          <DigitOsd state={osd} />
        </section>
      ) : (
        <LiveStageColumn
          label={t('stage')}
          busy={stageBusy}
          idle={idle}
          overlay={<DigitOsd state={osd} />}
          stageTestId="live-stage"
          ribbonOnPhone={stageBusy}
          ribbon={
            <MemoRibbon
              channel={ribbon.channel}
              sourceKind={ribbon.channel && source.data?.id === ribbon.channel.ref.sourceId ? kind : undefined}
              watchingLive={ribbon.watchingLive}
              watchingArchive={ribbon.watchingArchive}
              onPlayLive={onPlayLive}
              onMapEpg={setMapping}
              guideHref={guideHref}
              details
            />
          }
        />
      )}

      <MemoContextMenu
        pos={menu?.pos ?? null}
        items={menuItems}
        header={menuHeader}
        label={displayChannelName(menu?.channel.name, prefs.stripCountryPrefix)}
        onClose={closeMenu}
      />
      <MemoContextMenu pos={groupMenu?.pos ?? null} items={groupMenuItems} label={groupMenu?.category.name ?? ''} onClose={closeGroupMenu} />
      <MemoManageDialog open={manageOpen} onClose={closeManage} sourceId={sourceId} contentType={contentType} />
      <MemoMappingDialog channel={mapping} onClose={closeMapping} />
    </div>
  );
}

/** Radio's stage: the station's player while one plays, else the shared idle stage. */
function RadioStage({ idle }: { idle: ReactNode }) {
  const playingRadio = usePlayerStore((st) => !!st.source?.isRadio);
  return (
    <div className="relative flex min-h-14 flex-1 flex-col bg-black max-md:min-h-0 md:min-h-0" data-testid="radio-stage">
      {playingRadio ? (
        // The running player moves into this slot (the dock draws the station's stage view and owns
        // the audio), so the page shows one player, not this one plus the floating mini dock. On a
        // phone the slot is 14rem: under 420 px tall the station's view lays out in two rows (the
        // artwork beside the name, the controls under them; RadioPlayer SHORT_STAGE_PX), which fit
        // in it and leave the station list the rest of the screen.
        <PlayerStage className="min-h-56 flex-1 md:min-h-0" />
      ) : (
        <div className="relative flex-1 max-md:h-14 max-md:border-b max-md:border-divider max-md:bg-surface-2">{idle}</div>
      )}
    </div>
  );
}

/** The guide's address for a source, opened on a group at a channel's row (LG-01). */
export function guideLink(sourceId: string, categoryId?: string, focusItemId?: string): string {
  const q = new URLSearchParams({ source: sourceId });
  if (categoryId) q.set('category', categoryId);
  if (focusItemId) q.set('focus', focusItemId);
  return `/epg?${q.toString()}`;
}
