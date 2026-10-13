import {
  CalendarClock,
  Copy,
  ExternalLink,
  History,
  Link2,
  ListTree,
  Play,
  Radio as RadioIcon,
  Search,
  Star,
  Tv,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, sameRef, type Channel, type ContentType, type EpgNowNext, type ItemKey, type ItemRef } from '@/api/types';

import { Button, buttonClass, EmptyState, ErrorState, IconButton, useToast } from '@/ui';
import { PlayerStage, RadioPlayer, useChannelZap, usePlayerStore } from '@/features/player';
import { canShareSource, isShareableUrl } from '@/features/player/shareable';
import { registerCommands, useShell, useShortcut } from '@/shell';
import { useDigitEntry } from '../hooks/useDigitEntry';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useNow } from '../hooks/useNow';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { usePortalEpg } from '../hooks/usePortalEpg';
import { useRemoteBridge } from '../hooks/useRemoteBridge';
import { useShortEpg, useShortEpgEnabled } from '../hooks/useShortEpg';
import { displayChannelName } from '../lib/channelName';
import { nowNextFrom, preferNowNext } from '../lib/epgMerge';
import { MINUTE } from '../lib/epgTime';
import { playChannel, resolveChannelSource } from '../lib/playback';
import { needsFallback } from '../lib/shortEpg';
import { archivePath, canBrowseArchive } from '../lib/archive';
import { PREVIEW_FETCH_SIZE } from '../lib/stalkerPreviewQueue';
import { CategorySidebar } from './CategorySidebar';
import { ChannelList } from './ChannelList';
import { ChannelLogo } from './ChannelLogo';
import { CHANNEL_ROW_HEIGHT, RowSkeleton } from './ChannelRow';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { DigitOsd, type ZapFeedback } from './DigitOsd';
import { EpgMappingDialog } from './EpgMappingDialog';
import { EpgRibbon } from './EpgRibbon';
import { ManageCategoriesDialog } from './ManageCategoriesDialog';

const SIDEBAR_KEY = 'live.sidebarCollapsed';
const EMPTY_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };

export function LivePage({ mode = 'live' }: { mode?: 'live' | 'radio' }) {
  const { t, i18n } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const { toast } = useToast();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const sourceId = params.sourceId ?? '';
  const isRadio = mode === 'radio';
  const categoryId = (isRadio ? searchParams.get('category') : params.categoryId) ?? undefined;
  const contentType: ContentType = isRadio ? 'radio' : 'live';
  const now = useNow(30_000);
  const prefs = useDisplayPrefs();

  // ---- data ---------------------------------------------------------------
  const source = useRpcQuery('sources.get', { id: sourceId }, { enabled: !!sourceId });
  const settings = useRpcQuery('settings.get', undefined, { staleTime: 60_000 });
  const categories = useRpcQuery('catalog.categories', { sourceId, contentType }, { enabled: !!sourceId });
  const allCategories = useRpcQuery('catalog.categories', { sourceId, contentType, includeHidden: true }, { enabled: !!sourceId });
  const hiddenCount = useMemo(() => (allCategories.data ?? []).filter((c) => c.hidden).length, [allCategories.data]);
  const category = useMemo(() => categories.data?.find((c) => c.id === categoryId), [categories.data, categoryId]);

  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Typing is debounced; Enter or clearing commits at once, so Enter lands in the new list, not the old one.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const value = search.trim();
    const timer = setTimeout(() => setDebouncedSearch(value), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const commitSearch = useCallback((raw: string) => setDebouncedSearch(raw.trim()), []);
  const clearSearch = useCallback(() => {
    setSearch('');
    setDebouncedSearch('');
  }, []);
  useEffect(() => clearSearch(), [sourceId, categoryId, clearSearch]);
  /** Focus the list cursor once the committed search's rows are on screen. */
  const focusListPending = useRef(false);

  const kind = source.data?.kind;
  // guide: Xtream channels without XMLTV show the panel's short EPG.
  const shortEpgOn = useShortEpgEnabled(kind);
  const paged = usePagedChannels({
    sourceId,
    categoryId,
    search: debouncedSearch,
    radio: isRadio,
    now,
    stalkerEpg: kind === 'stalker',
    shortEpg: shortEpgOn,
    epgOffsetMinutes: prefs.epgOffsetMinutes,
  });
  useEffect(() => {
    if (!focusListPending.current || paged.isLoading || paged.refreshing) return;
    focusListPending.current = false;
    document.querySelector<HTMLButtonElement>('[data-testid="channel-list"] [data-row-index][tabindex="0"]')?.focus();
  });

  // ---- playback -----------------------------------------------------------
  const playerSource = usePlayerStore((s) => s.source);
  const playingRef =
    playerSource?.ref && playerSource.ref.sourceId === sourceId && (playerSource.ref.contentType === 'live' || playerSource.ref.contentType === 'radio')
      ? playerSource.ref
      : undefined;
  const playingItem = useRpcQuery('catalog.item', { ref: playingRef ?? EMPTY_REF }, { enabled: !!playingRef, staleTime: 5 * 60_000 });
  const playingChannel = playingRef ? (playingItem.data as Channel | undefined) : undefined;
  // ChannelList reports the cursor only once it settles, so a held arrow key doesn't fetch a
  // guide (and flash a skeleton) for every channel passed on the way. The report belongs to the
  // list it came from: once the list changes (search, group, source) or is replaced by a loading,
  // empty or error state, the old cursor channel no longer drives the ribbon.
  const listKey = `${contentType}|${sourceId}|${categoryId ?? ''}|${debouncedSearch}`;
  const listShown = !paged.error && !paged.isLoading && paged.total !== 0;
  const [reported, setReported] = useState<{ key: string; channel: Channel | undefined }>({ key: '', channel: undefined });
  const listKeyRef = useRef(listKey);
  listKeyRef.current = listKey;
  const onActiveChange = useCallback((channel: Channel | undefined) => setReported({ key: listKeyRef.current, channel }), []);
  const activeChannel =
    listShown && reported.key === listKey && reported.channel?.ref.sourceId === sourceId ? reported.channel : undefined;
  const ribbonChannel = playingChannel ?? activeChannel;
  const watchingLive = !!playerSource?.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
  const watchingArchive = !!playerSource && !playerSource.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
  const offset = prefs.epgOffsetMinutes;
  const playingNowNext = useRpcQuery(
    'epg.nowNext',
    offset ? { refs: playingRef ? [playingRef] : [], offsetMinutes: offset } : { refs: playingRef ? [playingRef] : [] },
    { enabled: !!playingRef, staleTime: 60_000 },
  );
  const playingPortalEpg = usePortalEpg(
    { ref: playingRef ?? EMPTY_REF, limit: PREVIEW_FETCH_SIZE },
    { enabled: !!playingRef && kind === 'stalker', staleTime: 60_000 },
  );
  const playingXmltv = playingNowNext.data ? Object.values(playingNowNext.data)[0] : undefined;
  // guide: the panel's short EPG once XMLTV answered without anything airing.
  const playingShortEpg = useShortEpg(playingRef, shortEpgOn && !!playingNowNext.data && needsFallback(playingXmltv));
  // Unshifted programmes: the one shown as airing is the one airing at `now - offset`.
  const currentNowNext = playingRef
    ? preferNowNext(
        kind === 'stalker' ? nowNextFrom(playingPortalEpg.data, now - offset * MINUTE) : undefined,
        preferNowNext(playingXmltv, nowNextFrom(playingShortEpg, now - offset * MINUTE)),
      )
    : undefined;

  useEffect(() => {
    if (sourceId) usePlayerStore.setState({ zapContext: { sourceId, categoryId } });
  }, [sourceId, categoryId]);

  const zap = useChannelZap();

  const play = useCallback(
    (channel: Channel, nn?: EpgNowNext) => {
      // `kind` is the loaded source's: never pair it with a channel of another source (a ribbon or
      // row left over from before a source switch would be played as the wrong kind).
      if (!kind || source.data?.id !== channel.ref.sourceId) return;
      const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
      playChannel(channel, kind, nn?.now?.title, name).catch((err: unknown) =>
        toast({ title: t('playFailed', { name }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
      );
    },
    [kind, source.data?.id, prefs.stripCountryPrefix, t, toast],
  );

  // ---- number entry -------------------------------------------------------
  const [osd, setOsd] = useState<ZapFeedback | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashOsd = useCallback((s: ZapFeedback, ms = 2000) => {
    if (osdTimer.current) clearTimeout(osdTimer.current);
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
          flashOsd({ kind: 'found', number: n, name: displayChannelName(ch.name, prefs.stripCountryPrefix) });
          play(ch);
        } else {
          flashOsd({ kind: 'missing', number: n });
        }
      } catch (err) {
        flashOsd({ kind: 'missing', number: n });
        toast({ title: t('zapFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
      }
    },
    [sourceId, isRadio, prefs.stripCountryPrefix, flashOsd, play, t, toast],
  );
  const digits = useDigitEntry((n) => void selectNumber(n));
  useEffect(() => {
    if (digits.buffer) {
      if (osdTimer.current) clearTimeout(osdTimer.current);
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
  const [mapping, setMapping] = useState<Channel | null>(null);
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; channel: Channel; favorite: boolean } | null>(null);

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
    digits.push(e.key);
  }, { description: t('shortcutDigits'), area: shortcutArea });

  const guideHref = `/epg?source=${encodeURIComponent(sourceId)}`;
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
  const subtitle = category?.name ?? (isRadio ? t('allStations') : t('allChannels'));
  useEffect(() => {
    if (!title) return;
    shell.setHeader({
      title,
      subtitle,
      actions: (
        <Link
          to={guideHref}
          className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CalendarClock className="size-4" aria-hidden />
          {t('openGuide')}
        </Link>
      ),
    });
  }, [title, subtitle, guideHref, i18n.language]);
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
          description: err instanceof Error ? err.message : undefined,
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
  const onContextMenu = useCallback(
    (pos: { x: number; y: number }, channel: Channel, favorite: boolean) => setMenu({ pos, channel, favorite }),
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  const navigate = useNavigate();
  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu || !source.data) return [];
    const ch = menu.channel;
    const src = source.data;
    const external = (player: 'mpv' | 'vlc') => async () => {
      try {
        const s = await resolveChannelSource(ch, src, displayChannelName(ch.name, prefs.stripCountryPrefix));
        await rpc('player.openExternal', { player, source: s });
      } catch (err) {
        toast({ title: t('externalFailed', { player: player.toUpperCase() }), description: err instanceof Error ? err.message : undefined, variant: 'error' });
      }
    };
    return [
      { id: 'play', label: t('play'), icon: <Play className="size-4" />, onSelect: () => play(ch) },
      // guide: the channel's catch-up archive browser.
      ...(canBrowseArchive(ch, src.kind)
        ? [{ id: 'archive', label: t('browseArchive'), icon: <History className="size-4" />, onSelect: () => navigate(archivePath(ch.ref)) }]
        : []),
      { id: 'mpv', label: t('playIn', { player: 'MPV' }), icon: <ExternalLink className="size-4" />, onSelect: () => void external('mpv')() },
      { id: 'vlc', label: t('playIn', { player: 'VLC' }), icon: <ExternalLink className="size-4" />, onSelect: () => void external('vlc')() },
      {
        id: 'fav',
        label: menu.favorite ? t('removeFavorite') : t('addFavorite'),
        icon: <Star className="size-4" fill={menu.favorite ? 'currentColor' : 'none'} />,
        onSelect: () => void toggleFavorite(ch, menu.favorite),
      },
      // Xtream and Stalker links carry the login (and so can a playlist link): only a link with no
      // credentials in it is offered, and the resolved link is checked again before it is copied.
      ...(src.kind === 'm3u' && !!ch.url && isShareableUrl(ch.url)
        ? [
            {
              id: 'copy',
              label: t('copyUrl'),
              icon: <Copy className="size-4" />,
              onSelect: async () => {
                try {
                  const s = await resolveChannelSource(ch, src);
                  if (!canShareSource(s, () => src.kind)) {
                    toast({ title: t('copyFailed'), variant: 'error' });
                    return;
                  }
                  await navigator.clipboard.writeText(s.url);
                  toast({ title: t('urlCopied'), variant: 'success' });
                } catch (err) {
                  toast({ title: t('copyFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
                }
              },
            },
          ]
        : []),
      { id: 'epg', label: t('mapEpg'), icon: <Link2 className="size-4" />, onSelect: () => setMapping(ch) },
    ];
  }, [menu, source.data, play, prefs.stripCountryPrefix, t, toast, toggleFavorite, navigate]);

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

  const hrefFor = (cid?: string) =>
    isRadio ? `/s/${encodeURIComponent(sourceId)}/radio${cid ? `?category=${encodeURIComponent(cid)}` : ''}` : `/s/${encodeURIComponent(sourceId)}/live${cid ? `/${encodeURIComponent(cid)}` : ''}`;

  const sidebar = (
    <CategorySidebar
      categories={categories.data}
      hiddenCount={hiddenCount}
      isLoading={categories.isLoading}
      error={categories.error}
      onRetry={() => void categories.refetch()}
      activeId={categoryId}
      hrefFor={hrefFor}
      onManage={() => setManageOpen(true)}
      onNavigate={() => setDrawerOpen(false)}
      totalLabel={isRadio ? t('allStations') : t('allChannels')}
    />
  );

  const listEmpty = paged.total === 0;
  let listBody;
  if (paged.error) {
    listBody = <ErrorState error={paged.error} onRetry={paged.retry} />;
  } else if (paged.isLoading) {
    listBody = (
      <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-busy="true" aria-label={t('loadingChannels')} data-testid="channel-list-loading">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="border-b border-divider" style={{ height: CHANNEL_ROW_HEIGHT }}>
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
          <Button size="sm" onClick={() => setManageOpen(true)}>
            {t('showGroups')}
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
        openOnDoubleClick={settings.data?.openStreamOnDoubleClick ?? false}
        now={now}
        compact={false}
        sourceKind={kind}
        onPlay={play}
        onToggleFavorite={onToggleFavorite}
        onContextMenu={onContextMenu}
        favoriteOverrides={favOverrides}
        onActiveChange={onActiveChange}
      />
    );
  }

  const sidebarVisible = wide && !collapsed;

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-bg" data-testid={isRadio ? 'radio-page' : 'live-page'}>
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
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col border-e border-border bg-surface shadow-2"
          >
            {sidebar}
          </aside>
        </>
      ) : null}

      {/* channel list */}
      <section
        aria-label={isRadio ? t('stations') : t('channels')}
        className="flex w-[clamp(272px,34vw,400px)] shrink-0 flex-col border-e border-divider bg-surface"
      >
        <div className="flex items-center gap-1 border-b border-divider px-2 py-2">
          <IconButton
            size="sm"
            label={sidebarVisible || drawerOpen ? t('hideGroups') : t('showGroupsPanel')}
            aria-expanded={sidebarVisible || drawerOpen}
            icon={<ListTree className="size-4" />}
            onClick={toggleSidebar}
          />
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-sm focus-within:ring-2 focus-within:ring-accent">
            <Search className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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
              aria-label={t(isRadio ? 'searchStations' : 'searchChannels')}
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
            />
            {search ? (
              <button
                type="button"
                aria-label={t('clearSearch')}
                title={t('clearSearch')}
                onClick={() => {
                  clearSearch();
                  searchRef.current?.focus();
                }}
                className="inline-flex size-5 items-center justify-center rounded-sm text-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </label>
        </div>
        <div className="flex items-baseline justify-between px-3 pt-2 pb-1 text-xs text-fg-subtle">
          <span className="truncate">{subtitle}</span>
          <span className="tabular-nums" aria-live="polite">
            {paged.total !== undefined ? t(isRadio ? 'stationCount' : 'channelCount', { count: paged.total, formatted: fmt.format(paged.total) }) : ''}
          </span>
        </div>
        {listBody}
      </section>

      {/* stage */}
      <section aria-label={t('stage')} className="flex min-w-0 flex-1 flex-col">
        {isRadio ? (
          <RadioStage channel={playingChannel} stripPrefix={prefs.stripCountryPrefix} />
        ) : (
          <>
            <div className="relative min-h-0 flex-1 bg-black">
              <PlayerStage className="h-full w-full">
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-white/70">
                  <Tv className="size-8" aria-hidden />
                  <p className="text-sm">{t('stageIdle')}</p>
                  <p className="text-xs text-white/50">{t('stageIdleHint')}</p>
                </div>
              </PlayerStage>
              <DigitOsd state={osd} />
            </div>
            <EpgRibbon
              channel={ribbonChannel}
              sourceKind={ribbonChannel && source.data?.id === ribbonChannel.ref.sourceId ? kind : undefined}
              watchingLive={watchingLive}
              watchingArchive={watchingArchive}
              onPlayLive={(c) => play(c)}
              onMapEpg={setMapping}
              guideHref={guideHref}
            />
          </>
        )}
        {isRadio ? <DigitOsd state={osd} /> : null}
      </section>

      <ContextMenu pos={menu?.pos ?? null} items={menuItems} label={displayChannelName(menu?.channel.name, prefs.stripCountryPrefix)} onClose={closeMenu} />
      <ManageCategoriesDialog open={manageOpen} onClose={() => setManageOpen(false)} sourceId={sourceId} contentType={contentType} />
      <EpgMappingDialog channel={mapping} onClose={() => setMapping(null)} />
    </div>
  );
}

function RadioStage({ channel, stripPrefix }: { channel?: Channel; stripPrefix: boolean }) {
  const { t } = useTranslation('live');
  const source = usePlayerStore((st) => st.source);
  const playingRadio = !!source?.isRadio;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-black" data-testid="radio-stage">
      {playingRadio ? (
        <RadioPlayer variant="stage" className="h-full" />
      ) : (
        <div className="flex flex-1 items-center justify-center bg-surface">
          <EmptyState
            icon={channel ? <ChannelLogo src={channel.logoUrl} name={displayChannelName(channel.name, stripPrefix)} size={72} /> : <RadioIcon className="size-8" />}
            title={t('radioIdle')}
            description={t('radioIdleHint')}
          />
        </div>
      )}
    </div>
  );
}
