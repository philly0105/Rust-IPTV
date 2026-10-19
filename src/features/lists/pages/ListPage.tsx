/**
 * `/lists/:listId`: a custom list laid out like Live. Lists on the side (a
 * drawer below 1024 px), the list's channels in the Live `ChannelList`, and
 * the player with the guide ribbon. Playing a row zaps within the list.
 * Channels the provider dropped sit under the list, greyed, with Remove.
 */

import { ListOrdered, ListPlus, ListTree, ListVideo, Play, Settings2, Star, Trash2, Tv, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, sameRef, type Channel, type CustomListEntry, type EpgNowNext, type ItemKey, type SourceKind } from '@/api/types';
import { registerCommands } from '@/shell/commands';
import { useChannelEditMenuItems, useChannelEditShortcuts } from '@/features/channeledit';
import { EpgMappingDialog } from '@/features/live/components/EpgMappingDialog';
import { EpgRibbon } from '@/features/live/components/EpgRibbon';

import {
  Button,
  CHANNEL_ROW_HEIGHT,
  CHANNEL_ROW_SPACING,
  ChannelList,
  ChannelLogo,
  ContextMenu,
  EmptyState,
  canZap,
  ErrorState,
  IconButton,
  PlayerStage,
  RowSkeleton,
  buttonClass,
  cn,
  displayChannelName,
  useDisplayPrefs,
  useMediaQuery,
  useNow,
  usePlayerStore,
  useRowHeight,
  useShell,
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
import { openEditListItems, openListPicker, openManageLists } from '../store';

const SIDEBAR_KEY = 'lists.sidebarCollapsed';

export function ListPage() {
  const { t, i18n } = useTranslation('lists');
  const { t: tl } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
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
  const settings = useRpcQuery('settings.get', undefined, { staleTime: 60_000 });
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
  const ribbonChannel = playingChannel ?? activeChannel;
  const ribbonKind: SourceKind | undefined = ribbonChannel ? sourceById.get(ribbonChannel.ref.sourceId)?.kind : undefined;
  const watchingLive = !!playerSource?.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
  const watchingArchive = !!playerSource && !playerSource.isLive && !!ribbonChannel && sameRef(playerSource.ref, ribbonChannel.ref);
  const [mapping, setMapping] = useState<Channel | null>(null);

  const play = useCallback(
    (channel: Channel, nn?: EpgNowNext) => {
      const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
      playFromList(channel, listId, nn?.now?.title, name).catch((err: unknown) =>
        toast({ title: tl('playFailed', { name }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
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

  // `l` on a focused row: the picker for that row's channel.
  useAddToListShortcut(activeChannel, paged.getChannel);
  // C2 (wired by I): F2 / Shift+Delete on the row that has DOM focus, as on the Live page.
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const rowIndexOf = (el: EventTarget | null): number | null => {
    const row = el instanceof Element ? el.closest<HTMLElement>('[data-testid="channel-list"] [data-row-index]') : null;
    const i = row ? Number(row.dataset.rowIndex) : NaN;
    return Number.isInteger(i) ? i : null;
  };
  useChannelEditShortcuts(focusedRow !== null ? (paged.getChannel(focusedRow) ?? activeChannel) : undefined);

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
        toast({ title: wasFavorite ? tl('favoriteRemoveFailed') : tl('favoriteAddFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
      } finally {
        favInFlight.current.delete(key);
        setOverride(key, undefined);
      }
    },
    [prefs.stripCountryPrefix, setOverride, tl, toast],
  );
  const onToggleFavorite = useCallback((c: Channel, fav: boolean) => void toggleFavorite(c, fav), [toggleFavorite]);

  // ---- row menu -----------------------------------------------------------
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; channel: Channel; favorite: boolean } | null>(null);
  const onContextMenu = useCallback((pos: { x: number; y: number }, channel: Channel, favorite: boolean) => setMenu({ pos, channel, favorite }), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const entryOf = useCallback((c: Channel) => paged.entries?.find((e) => sameRef(e.ref, c.ref)), [paged.entries]);
  // C2 (wired by I): Rename / Reset name / Hide, as in Live's channel menu.
  const editItems = useChannelEditMenuItems(menu?.channel ?? null);
  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    const ch = menu.channel;
    const name = displayChannelName(ch.name, prefs.stripCountryPrefix);
    const entry = entryOf(ch);
    return [
      { id: 'play', label: tl('play'), icon: <Play className="size-4" />, onSelect: () => play(ch, paged.getNowNext(paged.channels.indexOf(ch))) },
      {
        id: 'favorite',
        label: menu.favorite ? tl('removeFavorite') : tl('addFavorite'),
        icon: <Star className="size-4" fill={menu.favorite ? 'currentColor' : 'none'} />,
        onSelect: () => void toggleFavorite(ch, menu.favorite),
      },
      { id: 'lists', label: t('addToList'), icon: <ListPlus className="size-4" />, onSelect: () => openListPicker(ch) },
      ...editItems,
      ...(list && entry
        ? [{ id: 'remove', label: t('removeFromList'), icon: <X className="size-4" />, onSelect: () => actions.removeEntries(list, [entry], name) }]
        : []),
    ];
  }, [menu, prefs.stripCountryPrefix, entryOf, t, tl, play, paged, toggleFavorite, list, actions, editItems]);

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
        // there, since the channels bar right below has the same button, and Manage lists is a bare icon.
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
          <Button
            variant="ghost"
            size="sm"
            icon={<Settings2 className="size-4" />}
            onClick={() => openManageLists(list.id)}
            title={t('manageLists')}
            className="max-sm:w-8 max-sm:px-0"
          >
            <span className="max-sm:sr-only">{t('manageLists')}</span>
          </Button>
        </div>
      ) : undefined,
    });
  }, [title, subtitle, list?.id, i18n.language]);

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
  const sidebarVisible = wide && !collapsed;
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
          // Live TV, where L adds a channel (the hint above). Not `/`: it restores the saved screen, this one.
          <Link
            to={firstSource ? `/s/${encodeURIComponent(firstSource.id)}/live` : '/dashboard'}
            className={buttonClass('secondary', 'sm')}
            data-testid="list-browse-channels"
          >
            {t('browseChannels')}
          </Link>
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
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-bg md:flex-row" data-testid="list-page">
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
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col border-e border-border bg-surface shadow-2"
          >
            {sidebar}
          </aside>
        </>
      ) : null}

      {/* channels: beside the stage from 768 px, under it on a phone */}
      <section
        aria-label={tl('channels')}
        onFocus={(e) => setFocusedRow(rowIndexOf(e.target))}
        onBlur={(e) => {
          if (rowIndexOf(e.relatedTarget) === null) setFocusedRow(null);
        }}
        className="flex min-h-0 w-full flex-1 flex-col border-divider bg-surface md:w-[clamp(272px,34vw,400px)] md:flex-none md:shrink-0 md:border-e"
      >
        <div className="flex items-center gap-2 border-b border-divider px-2 py-2">
          <IconButton
            size="sm"
            label={sidebarVisible || drawerOpen ? t('hideLists') : t('showLists')}
            aria-expanded={sidebarVisible || drawerOpen}
            icon={<ListTree className="size-4" />}
            onClick={toggleSidebar}
          />
          <p dir="auto" className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
            {list?.name ?? ''}
          </p>
          {list ? (
            <IconButton size="sm" label={t('editChannels')} icon={<ListOrdered className="size-4" />} onClick={() => openEditListItems(list.id)} />
          ) : null}
        </div>
        {composition.length > 1 ? (
          // Where the list's channels come from: one chip per source.
          <ul aria-label={t('sourcesLabel')} className="flex flex-wrap gap-1.5 border-b border-divider px-3 py-2" data-testid="list-sources">
            {composition.map((s) => (
              <li key={s.id} className="flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pe-2.5 ps-2 text-xs text-fg-muted">
                <span dir="auto" className="truncate">
                  {s.name}
                </span>
                <span className="tabular-nums text-fg-subtle">{fmt.format(s.count)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {listBody}
        {list && paged.unavailable.length > 0 ? (
          <UnavailableEntries
            entries={paged.unavailable}
            strip={prefs.stripCountryPrefix}
            onRemove={(entries, label) => actions.removeEntries(list, entries, label)}
          />
        ) : null}
      </section>

      {/* stage: on top on a phone, as wide as the screen. With nothing playing a phone gets a slim
          prompt above the channels instead of a black 16:9 box, and an empty list (nothing to pick)
          no stage at all; from 768 px the stage stays (L3-visual-5, as Live's L2-visual-13). */}
      <section
        aria-label={tl('stage')}
        className={cn('order-first flex min-w-0 shrink-0 flex-col md:order-none md:flex-1', !stageBusy && listEmpty && 'max-md:hidden')}
        data-testid="list-stage-section"
      >
        <div
          data-testid="list-stage"
          data-idle={stageBusy ? undefined : ''}
          className={cn(
            'relative min-h-0 bg-black md:aspect-auto md:flex-1',
            stageBusy ? 'aspect-video' : 'max-md:h-14 max-md:border-b max-md:border-divider max-md:bg-surface-2',
          )}
        >
          <PlayerStage className={stageBusy ? 'h-full w-full' : 'h-full w-full max-md:bg-transparent'}>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-white/70 max-md:flex-row max-md:justify-start max-md:gap-3 max-md:px-4 max-md:text-start max-md:text-fg-muted">
              <Tv className="size-8 max-md:size-5 max-md:shrink-0" aria-hidden />
              <div className="flex min-w-0 flex-col gap-2 max-md:gap-0">
                <p className="text-sm max-md:truncate max-md:font-medium max-md:text-fg">{tl('stageIdle')}</p>
                <p className="text-xs text-white/50 max-md:truncate max-md:text-fg-subtle">{t('stageIdleHint')}</p>
              </div>
            </div>
          </PlayerStage>
        </div>
        {/* On a phone the ribbon comes with a channel playing, as on Live; until then the channels start
            near the top, and nothing shifts when the list arrives (L3-visual-4). While something plays
            and the list loads it holds its place, so the channels don't jump down when the first one
            arrives (L2-vod-5); with no channel of a list known to be empty it is only an empty state,
            which would push the list's own empty state and dropped channels below the fold. */}
        <div className={cn('contents', (!stageBusy || (!ribbonChannel && listEmpty)) && 'max-md:hidden')} data-testid="list-ribbon">
          <EpgRibbon
            channel={ribbonChannel}
            sourceKind={ribbonKind}
            watchingLive={watchingLive}
            watchingArchive={watchingArchive}
            onPlayLive={(c) => play(c)}
            onMapEpg={setMapping}
            guideHref={ribbonChannel ? `/epg?source=${encodeURIComponent(ribbonChannel.ref.sourceId)}` : undefined}
          />
        </div>
      </section>

      <ContextMenu pos={menu?.pos ?? null} items={menuItems} label={displayChannelName(menu?.channel.name, prefs.stripCountryPrefix)} onClose={closeMenu} />
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
  const fmt = new Intl.NumberFormat(i18n.language);
  return (
    <details className="group shrink-0 border-t border-divider bg-surface" data-testid="list-unavailable">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
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
