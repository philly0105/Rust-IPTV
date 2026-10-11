import {
  CalendarClock,
  Copy,
  ExternalLink,
  Link2,
  ListTree,
  Play,
  Radio as RadioIcon,
  Search,
  Star,
  Tv,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { sameRef, type Channel, type ContentType, type EpgNowNext, type ItemRef } from '@/api/types';

import { Button, EmptyState, ErrorState, IconButton, Skeleton, useToast } from '@/ui';
import { PlayerStage, RadioPlayer, useChannelZap, usePlayerStore } from '@/features/player';
import { registerCommands, useShell, useShortcut } from '@/shell';
import { useDebounced } from '../hooks/useDebounced';
import { useDigitEntry } from '../hooks/useDigitEntry';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useNow } from '../hooks/useNow';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { usePortalEpg } from '../hooks/usePortalEpg';
import { useRemoteBridge } from '../hooks/useRemoteBridge';
import { displayChannelName } from '../lib/channelName';
import { nowNextFrom, preferNowNext } from '../lib/epgMerge';
import { MINUTE } from '../lib/epgTime';
import { playChannel, resolveChannelSource } from '../lib/playback';
import { PREVIEW_FETCH_SIZE } from '../lib/stalkerPreviewQueue';
import { CategorySidebar } from './CategorySidebar';
import { ChannelList } from './ChannelList';
import { ChannelLogo } from './ChannelLogo';
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
  const debouncedSearch = useDebounced(search.trim(), 250);
  useEffect(() => setSearch(''), [sourceId, categoryId]);

  const kind = source.data?.kind;
  const paged = usePagedChannels({
    sourceId,
    categoryId,
    search: debouncedSearch,
    radio: isRadio,
    now,
    stalkerEpg: kind === 'stalker',
    epgOffsetMinutes: prefs.epgOffsetMinutes,
  });

  // ---- playback -----------------------------------------------------------
  const playerSource = usePlayerStore((s) => s.source);
  const playingRef =
    playerSource?.ref && playerSource.ref.sourceId === sourceId && (playerSource.ref.contentType === 'live' || playerSource.ref.contentType === 'radio')
      ? playerSource.ref
      : undefined;
  const playingItem = useRpcQuery('catalog.item', { ref: playingRef ?? EMPTY_REF }, { enabled: !!playingRef, staleTime: 5 * 60_000 });
  const playingChannel = playingRef ? (playingItem.data as Channel | undefined) : undefined;
  const [activeChannel, setActiveChannel] = useState<Channel | undefined>(undefined);
  const ribbonChannel = playingChannel ?? activeChannel;
  const watchingLive = !!playerSource?.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
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
  // Unshifted programmes: the one shown as airing is the one airing at `now - offset`.
  const currentNowNext = playingRef
    ? preferNowNext(
        kind === 'stalker' ? nowNextFrom(playingPortalEpg.data, now - offset * MINUTE) : undefined,
        playingNowNext.data ? Object.values(playingNowNext.data)[0] : undefined,
      )
    : undefined;

  useEffect(() => {
    if (sourceId) usePlayerStore.setState({ zapContext: { sourceId, categoryId } });
  }, [sourceId, categoryId]);

  const zap = useChannelZap();

  const play = useCallback(
    (channel: Channel, nn?: EpgNowNext) => {
      if (!kind) return;
      const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
      playChannel(channel, kind, nn?.now?.title, name).catch((err: unknown) =>
        toast({ title: t('playFailed', { name }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
      );
    },
    [kind, prefs.stripCountryPrefix, t, toast],
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

  const [manageOpen, setManageOpen] = useState(false);
  const [mapping, setMapping] = useState<Channel | null>(null);
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; channel: Channel } | null>(null);

  const shortcutArea = t('shortcutArea');
  useShortcut('mod+b', (e) => {
    e.preventDefault();
    toggleSidebar();
  }, { description: t('shortcutToggleSidebar'), area: shortcutArea });
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
  }, [title, subtitle, guideHref]);
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
  const toggleFavorite = useCallback(
    async (channel: Channel, wasFavorite: boolean) => {
      try {
        const res = await rpc('favorites.toggle', {
          ref: channel.ref,
          snapshot: { title: channel.name, subtitle: channel.categoryName, posterUrl: channel.logoUrl, contentType: channel.ref.contentType },
        });
        await invalidate('favorites.');
        const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
        toast({ title: res.isFavorite ? t('favoriteAdded', { name }) : t('favoriteRemoved', { name }), variant: 'success' });
      } catch (err) {
        toast({
          title: wasFavorite ? t('favoriteRemoveFailed') : t('favoriteAddFailed'),
          description: err instanceof Error ? err.message : undefined,
          variant: 'error',
        });
      }
    },
    [t, toast, prefs.stripCountryPrefix],
  );
  const onToggleFavorite = useCallback((c: Channel, fav: boolean) => void toggleFavorite(c, fav), [toggleFavorite]);
  const onContextMenu = useCallback((pos: { x: number; y: number }, channel: Channel) => setMenu({ pos, channel }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

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
      { id: 'mpv', label: t('playIn', { player: 'MPV' }), icon: <ExternalLink className="size-4" />, onSelect: () => void external('mpv')() },
      { id: 'vlc', label: t('playIn', { player: 'VLC' }), icon: <ExternalLink className="size-4" />, onSelect: () => void external('vlc')() },
      {
        id: 'fav',
        label: t('toggleFavorite'),
        icon: <Star className="size-4" />,
        onSelect: () => void toggleFavorite(ch, false),
      },
      {
        id: 'copy',
        label: t('copyUrl'),
        icon: <Copy className="size-4" />,
        onSelect: async () => {
          try {
            const s = await resolveChannelSource(ch, src);
            await navigator.clipboard.writeText(s.url);
            toast({ title: t('urlCopied'), variant: 'success' });
          } catch (err) {
            toast({ title: t('copyFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
          }
        },
      },
      { id: 'epg', label: t('mapEpg'), icon: <Link2 className="size-4" />, onSelect: () => setMapping(ch) },
    ];
  }, [menu, source.data, play, prefs.stripCountryPrefix, t, toast, toggleFavorite]);

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
      <div className="flex flex-col gap-3 p-3" aria-busy="true" aria-label={t('loadingChannels')}>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-9" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-2.5 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (listEmpty && debouncedSearch) {
    listBody = (
      <EmptyState
        icon={<Search className="size-6" />}
        title={t('noSearchResults', { query: debouncedSearch })}
        description={category ? t('noSearchResultsInGroup', { group: category.name }) : undefined}
        action={
          <Button size="sm" onClick={() => setSearch('')}>
            {t('clearSearch')}
          </Button>
        }
      />
    );
  } else if (listEmpty && categoryId) {
    listBody = <EmptyState icon={<ListTree className="size-6" />} title={t('emptyGroup')} />;
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
          <Link to="/sources" className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">
            {t('openSources')}
          </Link>
        }
      />
    );
  } else {
    listBody = (
      <ChannelList
        paged={paged}
        resetKey={`${sourceId}|${categoryId ?? ''}|${debouncedSearch}`}
        playingRef={playingRef}
        openOnDoubleClick={settings.data?.openStreamOnDoubleClick ?? false}
        now={now}
        compact={false}
        sourceKind={kind}
        onPlay={play}
        onToggleFavorite={onToggleFavorite}
        onContextMenu={onContextMenu}
        onActiveChange={setActiveChannel}
      />
    );
  }

  const sidebarVisible = wide && !collapsed;

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-bg" data-testid={isRadio ? 'radio-page' : 'live-page'}>
      {heading}
      {/* groups: column on wide screens, drawer below 1024 px */}
      {sidebarVisible ? (
        <aside className="flex w-60 shrink-0 flex-col border-e border-border bg-surface">{sidebar}</aside>
      ) : null}
      {!wide && drawerOpen ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" aria-hidden onClick={() => setDrawerOpen(false)} />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t('groups')}
            onKeyDown={(e) => e.key === 'Escape' && setDrawerOpen(false)}
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col border-e border-border bg-surface shadow-2"
          >
            {sidebar}
          </aside>
        </>
      ) : null}

      {/* channel list */}
      <section
        aria-label={isRadio ? t('stations') : t('channels')}
        className="flex w-[clamp(272px,34vw,400px)] shrink-0 flex-col border-e border-border bg-surface"
      >
        <div className="flex items-center gap-1 border-b border-border px-2 py-2">
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
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  document.querySelector<HTMLButtonElement>('[data-testid="channel-list"] [data-row-index][tabindex="0"]')?.focus();
                }
              }}
              placeholder={category ? t('searchInGroup', { group: category.name }) : t('searchChannels')}
              aria-label={t('searchChannels')}
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
            />
            {search ? (
              <button type="button" aria-label={t('clearSearch')} onClick={() => setSearch('')} className="text-fg-subtle hover:text-fg">
                <X className="size-3.5" />
              </button>
            ) : null}
          </label>
        </div>
        <div className="flex items-baseline justify-between px-3 pt-2 pb-1 text-xs text-fg-subtle">
          <span className="truncate">{subtitle}</span>
          <span className="tabular-nums" aria-live="polite">
            {paged.total !== undefined ? t('channelCount', { count: paged.total, formatted: fmt.format(paged.total) }) : ''}
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
              sourceKind={kind}
              watchingLive={watchingLive}
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
