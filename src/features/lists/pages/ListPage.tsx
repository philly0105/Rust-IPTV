/**
 * `/lists/:listId`: a custom list laid out like Live. Lists on the side (a
 * drawer on a page under 66rem), the list's channels in the Live `ChannelList`, and
 * the player with the guide ribbon. Playing a row zaps within the list.
 * Channels the provider dropped sit under the list, greyed, with Remove.
 */

import { ListOrdered, ListTree, ListVideo, Plus, Settings2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, sameRef, type Channel, type CustomListEntry, type EpgNowNext, type ItemKey, type SourceKind } from '@/api/types';
import { registerCommands } from '@/shell/commands';
import { useChannelEditShortcuts } from '@/features/channeledit';
import { EpgMappingDialog } from '@/features/live/components/EpgMappingDialog';
import { EpgRibbon } from '@/features/live/components/EpgRibbon';
import { LiveStageColumn } from '@/features/live/components/LiveStageColumn';
import { StageIdle } from '@/features/live/components/StageIdle';
import { useFitsWidth } from '@/features/live/hooks/useFitsWidth';
import { useLastChannel } from '@/features/live/hooks/useLastChannel';
import { useListEngaged } from '@/features/live/hooks/useListEngaged';
import { intlLocale } from '@/lib/intl';

import {
  Button,
  CHANNEL_ROW_HEIGHT,
  CHANNEL_ROW_SPACING,
  ChannelList,
  ChannelLogo,
  ContextMenu,
  EmptyState,
  canZap,
  channelMenuHeader,
  ErrorState,
  IconButton,
  PlayerStage,
  QualityFilterNote,
  RowSkeleton,
  SourceMonogram,
  buttonClass,
  cn,
  displayChannelName,
  errorDescription,
  useDisplayPrefs,
  useMediaQuery,
  useLiveQuality,
  useNow,
  usePlayerStore,
  useRowHeight,
  useShell,
  useChannelMenuItems,
  useToast,
  useVisibleSources,
  type MenuItem,
} from '../deps';
import { ListsSidebarSection } from '../components/ListsSidebarSection';
import { playFromList } from '../lib/play';
import { useAddToListShortcut } from '../hooks/useAddToList';
import { useListActions } from '../hooks/useListActions';
import { useListChannels } from '../hooks/useListChannels';
import { useListLocks } from '../hooks/useListLocks';
import { useLists } from '../hooks/useLists';
import { LISTS_PATH } from '../paths';
import { openAddChannels, openEditListItems, openManageLists } from '../store';

const SIDEBAR_KEY = 'lists.sidebarCollapsed';
/**
 * The page width, in rem, under which the lists leave their column for the drawer: Live TV's rule
 * for its groups (GROUPS_COLUMN_MIN_REM), since this page has the same three columns beside the
 * rail. Below it, beside the expanded rail in a 1024 px window, the stage ran off the page's end
 * and cut its idle card, Resume and the ribbon's view toggle. Not imported from LivePage, which
 * would pull Live's page into this chunk.
 */
const LISTS_COLUMN_MIN_REM = 66;

/** The index of the channel row `el` is in, if any. */
function rowIndexOf(el: EventTarget | null): number | null {
  const row = el instanceof Element ? el.closest<HTMLElement>('[data-testid="channel-list"] [data-row-index]') : null;
  const i = row ? Number(row.dataset.rowIndex) : NaN;
  return Number.isInteger(i) ? i : null;
}

export function ListPage() {
  const { t, i18n } = useTranslation('lists');
  const { t: tl } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const { toast } = useToast();
  const listId = useParams().listId ?? '';
  const now = useNow(30_000);
  const prefs = useDisplayPrefs();
  const lists = useLists();
  const list = lists.data?.find((l) => l.id === listId);
  const paged = useListChannels(listId, { now, epgOffsetMinutes: prefs.epgOffsetMinutes });
  // C2: Ask mode marks locked channels and keeps their programme titles back, as on Live.
  const locks = useListLocks(paged.channels);
  const actions = useListActions();
  const settings = useRpcQuery('settings.get', undefined);
  // The Live TV quality filter leaves out the channels it hides: an empty list may be its doing.
  const quality = useLiveQuality();
  const sources = useVisibleSources();
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  const firstSource = sources.data?.[0];
  const rowHeight = useRowHeight(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING);

  // ---- playback -----------------------------------------------------------
  const playerSource = usePlayerStore((s) => s.source);
  // PageUp/PageDown zap while a live channel plays in the app, from a list row too, as on Live (L3-live-ch-x2).
  const zapKeys = usePlayerStore((s) => !!s.source && s.mode !== 'external' && canZap(s));
  const inList = useMemo(() => new Set<ItemKey>(paged.channels.map((c) => itemKey(c.ref))), [paged.channels]);
  const playingRef =
    playerSource?.ref && (playerSource.ref.contentType === 'live' || playerSource.ref.contentType === 'radio') && inList.has(itemKey(playerSource.ref))
      ? playerSource.ref
      : undefined;
  const playingChannel = playingRef ? paged.channels.find((c) => sameRef(c.ref, playingRef)) : undefined;
  const [reported, setReported] = useState<{ key: string; channel: Channel | undefined }>({ key: '', channel: undefined });
  const onActiveChange = useCallback((channel: Channel | undefined) => setReported({ key: listId, channel }), [listId]);
  const activeChannel = reported.key === listId && reported.channel && inList.has(itemKey(reported.channel.ref)) ? reported.channel : undefined;
  const [mapping, setMapping] = useState<Channel | null>(null);

  const play = useCallback(
    (channel: Channel, nn?: EpgNowNext) => {
      const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
      playFromList(channel, listId, nn?.now?.title, name).catch((err: unknown) =>
        toast({ title: tl('playFailed', { name }), description: errorDescription(err), variant: 'error' }),
      );
    },
    [listId, prefs.stripCountryPrefix, tl, toast],
  );

  // The player keeps zapping within this list while its channel plays from here.
  // Only once the rows are this list's own: right after a switch they are still
  // the previous list's, and its playing channel may not be in this one.
  const rowsAreThisList = paged.rowsListId === listId;
  // Anything playing fills the stage (a phone shows it at 16:9 only then).
  const stageBusy = !!playerSource;
  // Nothing to pick: this list's own rows say so once they are in; before that the lists
  // query's count does, from the first frame when it is cached.
  const listEmpty = rowsAreThisList ? paged.total === 0 : list?.itemCount === 0;
  useEffect(() => {
    if (!rowsAreThisList) return;
    const ctx = usePlayerStore.getState().zapContext;
    const src = usePlayerStore.getState().source?.ref;
    if (src && listId && inList.has(itemKey(src)) && ctx?.listId !== listId) {
      usePlayerStore.setState({ zapContext: { sourceId: src.sourceId, listId } });
    }
  }, [listId, inList, rowsAreThisList]);

  // CB-AUTOPLAY-LAST: the idle stage offers the channel of this list watched last.
  const last = useLastChannel({
    contentType: 'live',
    accept: (r) => inList.has(itemKey(r)),
    enabled: !stageBusy && rowsAreThisList && inList.size > 0,
    epgOffsetMinutes: prefs.epgOffsetMinutes,
  });
  // While nothing plays, the idle card and the ribbon under it describe one channel: the one last
  // watched, until the user moves into the list; from then on the list's cursor row (as on Live).
  const [listEngaged, onListFocus] = useListEngaged(listId);
  const cursorChannel = listEngaged ? activeChannel : undefined;
  const cursorIndex = cursorChannel ? paged.loaded.find((l) => sameRef(l.channel.ref, cursorChannel.ref))?.index : undefined;
  const idleCard = cursorChannel
    ? { channel: cursorChannel, nowNext: cursorIndex === undefined ? undefined : paged.getNowNext(cursorIndex) }
    : last?.channel
      ? { channel: last.channel, nowNext: last.nowNext }
      : undefined;
  const idleChannel = stageBusy ? undefined : idleCard?.channel;
  const ribbonChannel = playingChannel ?? idleChannel ?? activeChannel;
  const ribbonKind: SourceKind | undefined = ribbonChannel ? sourceById.get(ribbonChannel.ref.sourceId)?.kind : undefined;
  const watchingLive = !!playerSource?.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
  const watchingArchive = !!playerSource && !playerSource.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
  // The idle card's button starts the channel the ribbon describes: the ribbon leaves out its own.
  const stageOffersChannel = !!idleChannel && !!ribbonChannel && sameRef(idleChannel.ref, ribbonChannel.ref);

  // `l` on a focused row: the picker for that row's channel.
  useAddToListShortcut(activeChannel, paged.getChannel);
  // C2 (wired by I): F2 / Shift+Delete on the row that has DOM focus, as on the Live page. The row
  // is read when the key is pressed, not tracked from focus events: tracking it re-rendered the
  // page, its ribbon and the unavailable entries on every arrow key (LV-5).
  const { getChannel } = paged;
  const focusedRowChannel = useCallback(() => {
    const i = rowIndexOf(document.activeElement);
    return i === null ? undefined : (getChannel(i) ?? activeChannel);
  }, [getChannel, activeChannel]);
  useChannelEditShortcuts(rowsAreThisList && !!paged.total ? focusedRowChannel : undefined);

  // ---- favorites ----------------------------------------------------------
  const [favOverrides, setFavOverrides] = useState<ReadonlyMap<ItemKey, boolean>>(() => new Map());
  const favInFlight = useRef(new Set<string>());
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
      const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
      try {
        const res = await rpc('favorites.toggle', {
          ref: channel.ref,
          snapshot: { title: channel.name, subtitle: channel.categoryName, posterUrl: channel.logoUrl, contentType: channel.ref.contentType },
        });
        setOverride(key, res.isFavorite);
        await invalidate('favorites.');
        toast({ title: res.isFavorite ? tl('favoriteAdded', { name }) : tl('favoriteRemoved', { name }), variant: 'success' });
      } catch (err) {
        toast({ title: wasFavorite ? tl('favoriteRemoveFailed') : tl('favoriteAddFailed'), description: errorDescription(err), variant: 'error' });
      } finally {
        favInFlight.current.delete(key);
        setOverride(key, undefined);
      }
    },
    [prefs.stripCountryPrefix, setOverride, tl, toast],
  );
  const onToggleFavorite = useCallback((c: Channel, fav: boolean) => void toggleFavorite(c, fav), [toggleFavorite]);

  // ---- row menu -----------------------------------------------------------
  // LG-13: Live's own channel menu (catch-up, external players, multi-view, guide matching), with
  // "Remove from list" among the Organize entries.
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; channel: Channel; favorite: boolean } | null>(null);
  const onContextMenu = useCallback((pos: { x: number; y: number }, channel: Channel, favorite: boolean) => setMenu({ pos, channel, favorite }), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const entryOf = useCallback((c: Channel) => paged.entries?.find((e) => sameRef(e.ref, c.ref)), [paged.entries]);
  const playRow = useCallback((ch: Channel) => play(ch, paged.getNowNext(paged.channels.indexOf(ch))), [play, paged]);
  const removeItem = useMemo((): MenuItem[] => {
    const entry = menu ? entryOf(menu.channel) : undefined;
    if (!menu || !list || !entry) return [];
    const name = displayChannelName(menu.channel.name, prefs.stripCountryPrefix);
    return [{ id: 'remove', label: t('removeFromList'), icon: <X className="size-4" />, onSelect: () => actions.removeEntries(list, [entry], name) }];
  }, [menu, list, entryOf, prefs.stripCountryPrefix, t, actions]);
  const menuItems = useChannelMenuItems(menu?.channel ?? null, {
    source: menu ? sourceById.get(menu.channel.ref.sourceId) : undefined,
    favorite: menu?.favorite,
    onPlay: playRow,
    onToggleFavorite,
    onMapGuide: setMapping,
    organize: removeItem,
    editHints: true,
  });
  const menuHeader = useMemo(() => {
    if (!menu) return undefined;
    const ch = menu.channel;
    // C2: a locked channel's programme stays back until the PIN, in the menu as in its row.
    const nowTitle = locks.channelLocked(ch) ? undefined : paged.getNowNext(paged.channels.indexOf(ch))?.now?.title;
    return channelMenuHeader(ch, displayChannelName(ch.name, prefs.stripCountryPrefix), nowTitle);
  }, [menu, locks, paged, prefs.stripCountryPrefix]);

  // ---- sidebar ------------------------------------------------------------
  // The lists are a column only where the page has room for it beside the channels and the stage;
  // on a narrower window, or a page under LISTS_COLUMN_MIN_REM, they open as a drawer from the bar.
  const pageRef = useRef<HTMLDivElement>(null);
  const roomForLists = useFitsWidth(pageRef, LISTS_COLUMN_MIN_REM);
  const wide = useMediaQuery('(min-width: 1024px)') && roomForLists;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const toggleSidebar = useCallback(() => {
    if (!wide) {
      drawerOpener.current = document.activeElement as HTMLElement | null;
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
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    drawerOpener.current?.focus();
  }, []);
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);
  useEffect(() => {
    if (drawerOpen) drawerRef.current?.querySelector<HTMLElement>('a[tabindex="0"], button')?.focus();
  }, [drawerOpen]);
  const onDrawerKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDrawer();
      return;
    }
    if (e.key !== 'Tab' || !drawerRef.current) return;
    const items = [...drawerRef.current.querySelectorAll<HTMLElement>('a[href]:not([tabindex="-1"]), button:not([disabled])')];
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

  // ---- header and commands ------------------------------------------------
  const shell = useShell();
  const sidebarVisible = wide && !collapsed;
  const title = list?.name ?? t('title');
  const composition = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of paged.channels) counts.set(c.ref.sourceId, (counts.get(c.ref.sourceId) ?? 0) + 1);
    return [...counts.entries()].map(([id, count]) => ({ id, count, name: sourceById.get(id)?.name ?? t('unknownSource') }));
  }, [paged.channels, sourceById, t]);
  // The sidebar counts every channel in the list; once this list's rows are in,
  // the header splits off the dropped ones so the two always add up.
  const playable = rowsAreThisList ? paged.total : undefined;
  const dropped = rowsAreThisList ? paged.unavailable.length : 0;
  const countText = (n: number) => t('channelCount', { count: n, formatted: fmt.format(n) });
  const subtitle = !list
    ? undefined
    : playable === undefined
      ? countText(list.itemCount)
      : dropped > 0
        ? t('countWithUnavailable', { channels: countText(playable), unavailable: t('unavailableCount', { count: dropped, formatted: fmt.format(dropped) }) })
        : countText(playable);
  useEffect(() => {
    shell.setHeader({
      title,
      ...(subtitle ? { subtitle } : {}),
      actions: list ? (
        // On a phone the list's name needs the room (L3-app-pages-x1): Edit channels leaves the header
        // there, since the channels bar right below has the same button.
        // Manage lists is also the lists column's gear: while the column is on screen the header
        // leaves it out, so it shows once; folded away or in the drawer, the header keeps it. Folded
        // away on a wide page it keeps its label. With the lists in the drawer (a page under 66rem,
        // a phone included) it is a bare gear, so the list's channel count keeps its room beside the
        // title, as Live TV's does at the same width.
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={<ListOrdered className="size-4" />}
            onClick={() => openEditListItems(list.id)}
            title={t('editChannels')}
            className="max-sm:hidden"
          >
            {t('editChannels')}
          </Button>
          {sidebarVisible ? null : wide ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Settings2 className="size-4" />}
              onClick={() => openManageLists(list.id)}
              title={t('manageLists')}
            >
              {t('manageLists')}
            </Button>
          ) : (
            <IconButton size="sm" label={t('manageLists')} icon={<Settings2 className="size-4" />} onClick={() => openManageLists(list.id)} />
          )}
        </div>
      ) : undefined,
    });
  }, [title, subtitle, list?.id, sidebarVisible, wide, i18n.language]);

  useEffect(
    () =>
      registerCommands([
        { id: 'lists.toggleSidebar', title: t('toggleSidebar'), group: t('title'), run: toggleSidebar },
        ...(list
          ? [
              { id: 'lists.editChannels', title: t('editTitle', { list: list.name }), group: t('title'), run: () => openEditListItems(list.id) },
            ]
          : []),
      ]),
    [t, toggleSidebar, list],
  );

  // ---- body ---------------------------------------------------------------
  const sidebar = <ListsSidebarSection variant="page" activeListId={listId} onNavigate={() => setDrawerOpen(false)} />;
  const listGone = lists.isSuccess && !list;

  let listBody;
  if (listGone) {
    listBody = (
      <EmptyState
        icon={<ListVideo className="size-6" />}
        title={t('notFoundTitle')}
        description={t('notFoundHint')}
        action={
          <Link to={LISTS_PATH} className={buttonClass('secondary', 'sm')}>
            {t('openLists')}
          </Link>
        }
      />
    );
  } else if (paged.error || lists.error) {
    listBody = (
      <ErrorState
        error={paged.error ?? lists.error}
        title={t('itemsLoadFailed')}
        hint={t('localDataHint')}
        onRetry={() => {
          paged.retry();
          void lists.refetch();
        }}
      />
    );
  } else if (paged.isLoading || !lists.data) {
    listBody = (
      <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-busy="true" aria-label={t('loadingChannels')} data-testid="channel-list-loading">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="border-b border-divider" style={{ height: rowHeight }}>
            <RowSkeleton pulse />
          </div>
        ))}
      </div>
    );
  } else if (paged.total === 0) {
    listBody = (
      <EmptyState
        icon={<ListVideo className="size-6" />}
        title={paged.unavailable.length > 0 ? t('allUnavailableTitle') : t('listEmptyTitle')}
        description={t('listEmptyHint')}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {list ? (
              <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => openAddChannels(list.id)}>
                {t('addChannels')}
              </Button>
            ) : null}
            {/* Live TV, where L adds a channel (the hint above). Not `/`: it restores the saved screen, this one. */}
            <Link
              to={firstSource ? `/s/${encodeURIComponent(firstSource.id)}/live` : '/dashboard'}
              className={buttonClass('secondary', 'sm')}
              data-testid="list-browse-channels"
            >
              {t('browseChannels')}
            </Link>
            <QualityFilterNote quality={quality} />
          </div>
        }
      />
    );
  } else {
    listBody = (
      <ChannelList
        paged={paged}
        resetKey={`list|${listId}`}
        playingRef={playingRef}
        openOnDoubleClick={settings.data?.openStreamOnDoubleClick ?? false}
        now={now}
        compact={false}
        onPlay={play}
        onToggleFavorite={onToggleFavorite}
        onContextMenu={onContextMenu}
        favoriteOverrides={favOverrides}
        onActiveChange={onActiveChange}
        locks={locks}
        zapKeys={zapKeys}
      />
    );
  }

  return (
    <div ref={pageRef} className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-bg md:flex-row" data-testid="list-page">
      <h1 className="sr-only">{title}</h1>
      {sidebarVisible ? <aside className="flex w-60 shrink-0 flex-col border-e border-divider bg-surface">{sidebar}</aside> : null}
      {!wide && drawerOpen ? (
        <>
          <div data-scrim="" className="fixed inset-0 z-40 bg-scrim" aria-hidden onClick={closeDrawer} />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('title')}
            data-testid="lists-drawer"
            onKeyDown={onDrawerKeyDown}
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col border-e border-edge bg-surface shadow-2"
          >
            {sidebar}
          </aside>
        </>
      ) : null}

      {/* channels: beside the stage from 768 px, under it on a phone. A share of the page with
          Live's bounds, so the two pages leave the stage the same room at every width. */}
      <section
        aria-label={tl('channels')}
        className="flex min-h-0 w-full flex-1 flex-col border-divider bg-surface md:w-[clamp(300px,32%,400px)] md:min-w-60 md:flex-initial md:border-e"
        onFocus={onListFocus}
      >
        {/* The list's name is in the header (and on its sidebar row): the bar holds the tools. */}
        <div className="flex items-center gap-2 border-b border-divider px-2 py-2">
          <IconButton
            size="sm"
            label={sidebarVisible || drawerOpen ? t('hideLists') : t('showLists')}
            aria-expanded={sidebarVisible || drawerOpen}
            icon={<ListTree className="size-4" />}
            onClick={toggleSidebar}
          />
          {composition.length > 1 ? (
            // Where the list's channels come from: each source's monogram (the rail's mark) with its
            // count, so every source fits beside the tools; the name is spoken and shows on hover.
            <ul aria-label={t('sourcesLabel')} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1" data-testid="list-sources">
              {composition.map((s) => (
                <li key={s.id} title={`${s.name} · ${fmt.format(s.count)}`} className="flex shrink-0 items-center gap-1.5 text-caption text-fg-muted">
                  <SourceMonogram name={s.name} className="size-5 rounded-xs text-2xs" />
                  <span dir="auto" className="sr-only">
                    {s.name}
                  </span>
                  <span className="tabular-nums">{fmt.format(s.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="flex-1" />
          )}
          {list ? (
            <>
              {/* LG-13: the list grows from here too, not only from Live's menus. */}
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus className="size-4" />}
                onClick={() => openAddChannels(list.id)}
                className="shrink-0 max-sm:w-8 max-sm:px-0"
                data-testid="list-add-channels"
              >
                <span className="max-sm:sr-only">{t('addChannels')}</span>
              </Button>
              {/* From sm up Edit channels is in the header; a phone's header has no room for it. */}
              <IconButton size="sm" label={t('editChannels')} icon={<ListOrdered className="size-4" />} onClick={() => openEditListItems(list.id)} className="sm:hidden" />
            </>
          ) : null}
        </div>
        {listBody}
        {list && paged.unavailable.length > 0 ? (
          <UnavailableEntries
            entries={paged.unavailable}
            strip={prefs.stripCountryPrefix}
            onRemove={(entries, label) => actions.removeEntries(list, entries, label)}
          />
        ) : null}
      </section>

      {/* The stage column Live uses (LG-07). With nothing playing a phone gets a slim prompt above
          the channels instead of a black 16:9 box, and an empty list (nothing to pick) no stage at
          all (L3-visual-5, as Live's L2-visual-13). On a phone the ribbon comes with a channel
          playing, as on Live; until then the channels start near the top, and nothing shifts when
          the list arrives (L3-visual-4). While something plays and the list loads it holds its
          place, so the channels don't jump down when the first one arrives (L2-vod-5); with no
          channel of a list known to be empty it is only an empty state, which would push the
          list's own empty state and dropped channels below the fold. */}
      <LiveStageColumn
        Stage={PlayerStage}
        label={tl('stage')}
        busy={stageBusy}
        hiddenOnPhone={listEmpty}
        sectionTestId="list-stage-section"
        stageTestId="list-stage"
        ribbonTestId="list-ribbon"
        ribbonOnPhone={stageBusy && !(!ribbonChannel && listEmpty)}
        idle={
          <StageIdle
            kind="live"
            last={idleCard}
            highlighted={!!cursorChannel}
            locked={locks.channelLocked(idleCard?.channel)}
            now={now}
            stripPrefix={prefs.stripCountryPrefix}
            epgOffsetMinutes={prefs.epgOffsetMinutes}
            hint={t('stageIdleHint')}
            onResume={(c) => play(c)}
          />
        }
        ribbon={
          <EpgRibbon
            channel={ribbonChannel}
            sourceKind={ribbonKind}
            watchingLive={watchingLive}
            watchingArchive={watchingArchive}
            stageOffersChannel={stageOffersChannel}
            onPlayLive={(c) => play(c)}
            onMapEpg={setMapping}
            guideHref={ribbonChannel ? `/epg?${new URLSearchParams({ source: ribbonChannel.ref.sourceId, view: `list:${listId}`, focus: ribbonChannel.ref.itemId }).toString()}` : undefined}
            details
          />
        }
      />

      <ContextMenu
        pos={menu?.pos ?? null}
        items={menuItems}
        header={menuHeader}
        label={displayChannelName(menu?.channel.name, prefs.stripCountryPrefix)}
        onClose={closeMenu}
      />
      <EpgMappingDialog channel={mapping} onClose={() => setMapping(null)} />
    </div>
  );
}

/** Channels the provider dropped: greyed, with Remove each and Remove all. */
function UnavailableEntries({
  entries,
  strip,
  onRemove,
}: {
  entries: CustomListEntry[];
  strip: boolean;
  onRemove(entries: CustomListEntry[], label: string): void;
}) {
  const { t, i18n } = useTranslation('lists');
  const fmt = new Intl.NumberFormat(intlLocale(i18n.language));
  return (
    <details className="group shrink-0 border-t border-divider bg-surface" data-testid="list-unavailable">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{t('unavailableHeading')}</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 tabular-nums">{fmt.format(entries.length)}</span>
      </summary>
      <div className="max-h-56 overflow-y-auto px-2 pb-2">
        <p className="px-1 pb-2 text-xs text-fg-subtle">{t('unavailableHint')}</p>
        <ul className="flex flex-col">
          {entries.map((e) => {
            const name = displayChannelName(e.snapshot.title, strip);
            return (
              <li key={itemKey(e.ref)} className="flex items-center gap-2 rounded-md px-1 py-1 text-fg-subtle">
                <span className="opacity-60 grayscale">
                  <ChannelLogo src={e.snapshot.posterUrl} name={name} size={28} sourceId={e.ref.sourceId} />
                </span>
                <span dir="auto" className="min-w-0 flex-1 truncate text-sm line-through decoration-fg-subtle/50">
                  {name}
                </span>
                <IconButton size="sm" variant="ghost" label={t('removeNamed', { name })} icon={<Trash2 className="size-4" />} onClick={() => onRemove([e], name)} />
              </li>
            );
          })}
        </ul>
        {entries.length > 1 ? (
          <Button
            size="sm"
            variant="secondary"
            className={cn('mt-2 w-full')}
            onClick={() => onRemove(entries, t('unavailableCount', { count: entries.length, formatted: fmt.format(entries.length) }))}
          >
            {t('removeAll')}
          </Button>
        ) : null}
      </div>
    </details>
  );
}
