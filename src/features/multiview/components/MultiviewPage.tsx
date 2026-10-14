import { LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';

import { gateItem } from '../addChannel';
import { buttonClass, cn, EmptyState, ensureUnlocked, ErrorState, requestPin, Skeleton, toast, useShellHeader, useShortcut } from '../deps';
import { capacityOf, MAX_TILES, nextLayout, slotClass, WALL_BASE, WALL_CLASSES } from '../layout';
import { reinsertTile, restoreClearedWall, snapshotWall, useMultiviewAudio, useMultiviewStore } from '../store';
import type { MultiviewLayout, MultiviewTile } from '../types';
import { focusTileOf } from '../paths';
import { useMainPlayerHandoff } from '../useMainPlayerHandoff';
import { overLimit, useNowPlaying, useParentalState, useSourceLoads, useSources } from '../useWallData';
import { focusSlot, useWallKeyboard } from '../useWallKeyboard';
import { useWallFullscreen } from '../useWallFullscreen';
import { LimitBanners, loadKey, MainPlayingBanner } from './Banners';
import { ChannelPicker, type PickerMode } from './ChannelPicker';
import { EmptyIntro } from './EmptyIntro';
import { LAYOUT_LABEL_KEYS, WallToolbar } from './WallToolbar';
import { Wall } from './Wall';

/** Full screen: the toolbar fades after this long without pointer or key activity. */
export const CHROME_IDLE_MS = 2_500;

const ADD: PickerMode = { kind: 'add' };

/** Full-screen chrome that gets out of the way: shown on activity, hidden when idle unless held. */
function useIdleChrome(active: boolean) {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);

  const poke = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!held.current) setVisible(false);
    }, CHROME_IDLE_MS);
  }, []);

  useEffect(() => {
    if (active) poke();
    else {
      clearTimeout(timer.current);
      held.current = false;
      setVisible(true);
    }
    return () => clearTimeout(timer.current);
  }, [active, poke]);

  const hold = useCallback((on: boolean) => {
    held.current = on;
    if (on) setVisible(true);
  }, []);

  return { visible: !active || visible, poke, hold };
}

/** The page while the sources list loads with nothing on the wall: the frames, without text. */
function WallSkeleton({ layout }: { layout: MultiviewLayout }) {
  return (
    <div aria-hidden className="flex min-h-0 flex-1 flex-col" data-testid="multiview-loading">
      <div className="flex flex-col gap-3 border-b border-divider bg-surface px-4 py-5 sm:px-6">
        <Skeleton className="h-6 w-72 max-w-full" />
        <Skeleton className="h-4 w-[28rem] max-w-full" />
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-y-auto p-1 [container-type:size] @2xl:p-2">
        <div className={cn(WALL_BASE, WALL_CLASSES['2x2'])}>
          {Array.from({ length: capacityOf(layout === '1x2' ? '1x2' : '2x2') }, (_, i) => (
            <Skeleton key={i} className={cn('rounded-sm', slotClass('2x2', i))} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * `/multiview`: two to four live channels at once, laid out like a broadcast monitor wall.
 *
 * Pieces: the toolbar (layout, add, the wall's sound, full screen, clear), banners (accounts
 * over their connection limit, the main player playing), the wall (Wall and Tile), the
 * channel picker. An empty wall shows what multi-view does above its free frames.
 *
 * Sound: exactly one tile holds it (the store's `audioKey`); clicking a tile or pressing its
 * number moves it there. The wall's mute silences all of them; the main player playing does
 * too, until the user stops it.
 */
export function MultiviewPage() {
  const { t } = useTranslation(['multiview', 'common']);
  const tiles = useMultiviewStore((s) => s.tiles);
  const layout = useMultiviewStore((s) => s.layout);
  const audioKey = useMultiviewStore((s) => s.audioKey);
  const muted = useMultiviewAudio((s) => s.muted);
  const volume = useMultiviewAudio((s) => s.volume);

  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [swapFrom, setSwapFrom] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const count = tiles.length;
  const { active: fsActive, supported: fsSupported, toggle: fsToggle, exit: fsExit } = useWallFullscreen(stageRef);
  const chrome = useIdleChrome(fsActive);
  const { mainPlaying, stopMain } = useMainPlayerHandoff(count > 0);
  const sources = useSources();
  const loads = useSourceLoads(tiles, sources.byId);
  const over = useMemo(() => overLimit(loads), [loads]);
  const overSet = useMemo(() => new Set(over.map((l) => l.sourceId)), [over]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const shownOver = over.filter((l) => !dismissed.has(loadKey(l)));
  const missingSources = useMemo(
    () => (sources.loaded ? new Set(tiles.map((x) => x.ref.sourceId).filter((id) => !sources.byId.has(id))) : new Set<string>()),
    [sources.loaded, sources.byId, tiles],
  );
  const programmes = useNowPlaying(tiles);
  const parental = useParentalState();
  const soundSlot = tiles.findIndex((x) => x.key === audioKey);
  const silent = muted || mainPlaying;

  const title = t('title');
  const subtitle = count > 0 ? t('subtitle', { n: count, max: MAX_TILES }) : undefined;
  useShellHeader(subtitle ? { title, subtitle } : { title }, [title, subtitle]);

  // A swap whose tile went away (closed, cleared, replaced from elsewhere) ends.
  useEffect(() => {
    if (swapFrom && !tiles.some((x) => x.key === swapFrom)) setSwapFrom(null);
  }, [tiles, swapFrom]);
  // An empty wall has nothing to show full screen.
  useEffect(() => {
    if (count === 0 && fsActive) void fsExit();
  }, [count, fsActive, fsExit]);
  // Arriving from "Add to multi-view": focus lands on the tile just added, not on the page body.
  const location = useLocation();
  useEffect(() => {
    const key = focusTileOf(location.state);
    if (!key) return;
    const index = useMultiviewStore.getState().tiles.findIndex((x) => x.key === key);
    if (index >= 0) focusSlot(wallRef.current, index);
  }, [location.key, location.state]);

  const nameOf = useCallback((key: string) => useMultiviewStore.getState().tiles.find((x) => x.key === key)?.title ?? '', []);

  const openPicker = useCallback(
    (mode: PickerMode) => {
      // Dialogs render outside the wall; full screen would hide them.
      if (fsActive) void fsExit();
      setSwapFrom(null);
      setPicker(mode);
    },
    [fsActive, fsExit],
  );

  const listen = useCallback(
    (key: string) => {
      const s = useMultiviewStore.getState();
      if (!s.tiles.some((x) => x.key === key)) return;
      s.setAudio(key);
      // Choosing a tile to hear is a request to hear it.
      if (useMultiviewAudio.getState().muted) useMultiviewAudio.getState().setMuted(false);
      setAnnouncement(t('announceSound', { name: nameOf(key) }));
    },
    [nameOf, t],
  );

  const close = useCallback(
    (key: string) => {
      const s = useMultiviewStore.getState();
      const index = s.tiles.findIndex((x) => x.key === key);
      const tile = s.tiles[index];
      if (!tile) return;
      const hadSound = s.audioKey === key;
      s.remove(key);
      setAnnouncement(t('announceClosed', { name: tile.title }));
      // Focus stays where the tile was: the next tile, or the free frame now there.
      if (useMultiviewStore.getState().tiles.length > 0) focusSlot(wallRef.current, index);
      toast({
        id: `multiview-closed-${key}`,
        title: t('toastClosed', { name: tile.title }),
        action: {
          label: t('undo'),
          onClick: () => {
            if (!reinsertTile(tile, index, hadSound)) toast({ title: t('toastUndoFull') });
          },
        },
      });
    },
    [t],
  );

  const clear = useCallback(() => {
    const before = snapshotWall();
    if (before.tiles.length === 0) return;
    useMultiviewStore.getState().clear();
    setAnnouncement(t('announceCleared'));
    toast({
      id: 'multiview-cleared',
      title: t('toastCleared'),
      action: { label: t('undo'), onClick: () => restoreClearedWall(before) },
    });
  }, [t]);

  const swapStart = useCallback(
    (key: string) => {
      setSwapFrom(key);
      setAnnouncement(t('announceSwapStart', { name: nameOf(key) }));
    },
    [nameOf, t],
  );
  const swapCancel = useCallback(() => {
    setSwapFrom(null);
    setAnnouncement(t('announceSwapCancelled'));
  }, [t]);
  const swapWith = useCallback(
    (from: string, to: string) => {
      const s = useMultiviewStore.getState();
      const target = s.tiles.findIndex((x) => x.key === to);
      if (from === to || target < 0) return;
      s.swap(from, to);
      setSwapFrom(null);
      setAnnouncement(t('announceSwapped', { a: nameOf(from), b: nameOf(to) }));
      // Focus follows the moved tile to its new slot.
      focusSlot(wallRef.current, target);
    },
    [nameOf, t],
  );
  const swapTarget = useCallback(
    (to: string) => {
      if (swapFrom) swapWith(swapFrom, to);
    },
    [swapFrom, swapWith],
  );

  const replace = useCallback((key: string) => openPicker({ kind: 'replace', key }), [openPicker]);

  const unlock = useCallback(
    (tile: MultiviewTile) => {
      if (fsActive) void fsExit();
      if (parental.mode === 'hide') {
        // Hide mode has no gate (the core hides locked channels): unlocking is the session's PIN.
        void requestPin({
          title: t('unlockTitle'),
          description: t('unlockBody', { name: tile.title }),
          confirmLabel: t('unlock'),
          submit: async (pin) => {
            await rpc('parental.unlock', { pin });
          },
        }).then((ok) => ok && void invalidate('parental.'));
        return;
      }
      void ensureUnlocked([{ ...gateItem(tile), title: tile.title }]).then((ok) => ok && void invalidate('parental.'));
    },
    [fsActive, fsExit, parental.mode, t],
  );

  const setLayout = useCallback(
    (l: MultiviewLayout) => {
      const s = useMultiviewStore.getState();
      if (l === s.layout) return;
      s.setLayout(l);
      if (useMultiviewStore.getState().layout === l) setAnnouncement(t('announceLayout', { layout: t(LAYOUT_LABEL_KEYS[l]) }));
    },
    [t],
  );

  const toggleMute = useCallback(() => {
    const a = useMultiviewAudio.getState();
    a.toggleMuted();
    setAnnouncement(a.muted ? t('announceUnmuted') : t('announceMuted'));
  }, [t]);

  const onWallKeyDown = useWallKeyboard({
    wallRef,
    tiles,
    swapFrom,
    onClose: close,
    onReplace: replace,
    onSwapStart: swapStart,
    onSwapTarget: swapTarget,
    onSwapCancel: swapCancel,
  });

  // Page-wide keys. Keys that act on the focused slot live on the wall (useWallKeyboard).
  const area = t('shortcutArea');
  const hasTiles = count > 0;
  useShortcut(
    'digit',
    (e) => {
      const n = Number(e.key);
      const tile = useMultiviewStore.getState().tiles[n - 1];
      if (tile) listen(tile.key);
    },
    { description: t('shortcutSound'), area, enabled: hasTiles },
  );
  useShortcut('f', fsToggle, { description: t('shortcutFullscreen'), area, enabled: hasTiles && fsSupported });
  useShortcut('m', toggleMute, { description: t('shortcutMute'), area, enabled: hasTiles });
  useShortcut(
    'l',
    () => {
      const s = useMultiviewStore.getState();
      setLayout(nextLayout(s.layout, s.tiles.length));
    },
    { description: t('shortcutLayout'), area },
  );
  useShortcut('a', () => openPicker(ADD), { description: t('shortcutAdd'), area, enabled: count < MAX_TILES && picker === null });
  useShortcut('escape', swapCancel, { description: t('shortcutSwapCancel'), area, enabled: swapFrom !== null });

  const onOverlayFocus = () => chrome.hold(true);
  const onOverlayBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (overlayRef.current?.contains(e.relatedTarget as Node | null)) return;
    chrome.hold(false);
    chrome.poke();
  };

  const toolbar = (overlay: boolean) => (
    <WallToolbar
      layout={layout}
      count={count}
      soundSlot={soundSlot}
      muted={muted}
      volume={volume}
      fullscreen={fsActive}
      fullscreenSupported={fsSupported}
      overlay={overlay}
      onLayout={setLayout}
      onAdd={() => openPicker(ADD)}
      onToggleMute={toggleMute}
      onVolume={(v) => useMultiviewAudio.getState().setVolume(v)}
      onToggleFullscreen={fsToggle}
      onClear={clear}
    />
  );

  const showBanners = shownOver.length > 0 || mainPlaying;
  const banners = (
    <div className={cn('flex flex-col gap-2', !fsActive && showBanners && 'px-3 pt-3 sm:px-4')} data-testid="multiview-banners">
      {mainPlaying ? <MainPlayingBanner onStop={stopMain} /> : null}
      <LimitBanners over={shownOver} onDismiss={(l) => setDismissed((d) => new Set(d).add(loadKey(l)))} />
    </div>
  );

  const wall = (
    <Wall
      ref={wallRef}
      tiles={tiles}
      layout={layout}
      audioKey={audioKey}
      silent={silent}
      volume={volume}
      parentalActive={parental.active}
      parentalMode={parental.mode}
      overLimitSources={overSet}
      missingSources={missingSources}
      programmes={programmes}
      swapFrom={swapFrom}
      onAdd={() => openPicker(ADD)}
      onListen={listen}
      onClose={close}
      onReplace={replace}
      onSwapStart={swapStart}
      onSwapTarget={swapTarget}
      onSwapCancel={swapCancel}
      onUnlock={unlock}
      onDropTile={swapWith}
      onKeyDown={onWallKeyDown}
    />
  );

  let body;
  if (count === 0 && !sources.loaded && !sources.error) {
    body = <WallSkeleton layout={layout} />;
  } else if (count === 0 && sources.error) {
    body = <ErrorState error={sources.error} onRetry={sources.refetch} />;
  } else if (count === 0 && sources.byId.size === 0) {
    body = (
      <EmptyState
        icon={<LayoutGrid aria-hidden size={28} />}
        title={t('noSourcesTitle')}
        description={t('noSources')}
        action={
          <Link to="/sources" className={buttonClass('primary')}>
            {t('noSourcesAction')}
          </Link>
        }
      />
    );
  } else {
    body = (
      <>
        {count === 0 ? <EmptyIntro layout={layout} onLayout={setLayout} onPick={() => openPicker(ADD)} /> : null}
        <div
          ref={stageRef}
          data-testid="multiview-stage"
          data-fullscreen={fsActive ? 'true' : 'false'}
          onPointerMove={fsActive ? chrome.poke : undefined}
          onPointerDown={fsActive ? chrome.poke : undefined}
          onKeyDownCapture={fsActive ? chrome.poke : undefined}
          className={cn('relative flex min-h-0 flex-1 flex-col', fsActive ? 'bg-black' : 'bg-bg', fsActive && !chrome.visible && 'cursor-none')}
        >
          {count > 0 && !fsActive ? toolbar(false) : null}
          {!fsActive ? banners : null}
          <div className={cn('relative flex min-h-0 flex-1 overflow-y-auto [container-type:size]', fsActive ? 'p-0' : 'p-1 @2xl:p-2')}>{wall}</div>
          {fsActive ? (
            <div
              ref={overlayRef}
              onFocus={onOverlayFocus}
              onBlur={onOverlayBlur}
              onPointerEnter={() => chrome.hold(true)}
              onPointerLeave={() => {
                chrome.hold(false);
                chrome.poke();
              }}
              data-testid="multiview-overlay"
              className={cn(
                'absolute inset-x-2 top-2 z-50 flex flex-col gap-2 sm:inset-x-4 sm:top-4',
                'motion-safe:transition-opacity motion-safe:duration-200',
                chrome.visible ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              {toolbar(true)}
              {banners}
            </div>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="multiview-page">
      <h1 className="sr-only">{title}</h1>
      <p role="status" aria-live="polite" className="sr-only" data-testid="multiview-announcer">
        {announcement}
      </p>
      {body}
      <ChannelPicker open={picker !== null} mode={picker ?? ADD} onClose={() => setPicker(null)} />
    </div>
  );
}
