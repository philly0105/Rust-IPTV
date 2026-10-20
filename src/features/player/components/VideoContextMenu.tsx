import { Camera, ChevronLeft, Copy, Maximize, Minimize, Pause, PictureInPicture2, Play } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useToast } from '@/ui/Toast';
import { useMediaStore } from '../media';
import { noteMenuDismissed } from '../menuDismiss';
import { takeScreenshot } from '../screenshot';
import { usePipStore } from '../pip';
import { canShareSource } from '../shareable';
import { knownSourceKind, usePlayerStore } from '../store';
import { toggleStreamInfo, useStreamInfoStore } from '../streamInfo';
import { MenuAction, MenuChoice, MenuRow, MenuSeparator, MenuToggle, PictureRows, SpeedRows, usePictureSummary } from './Controls';
import { SleepMenu, SleepRowValue } from './SleepTimer';
import { SubtitleStyleMenu, SubtitleTrackMenu } from './SubtitleMenu';
import { SyncRows, useSyncAvailable, useSyncSummary } from './SyncMenu';

/** Gap kept between the menu and the window edges, in CSS px. */
const EDGE = 8;

type View = 'root' | 'audio' | 'text' | 'style' | 'sync' | 'sleep' | 'picture' | 'speed';

/**
 * Where the menu mounts. Inside the player it would stay in the stage's stacking context, under
 * the page strips that follow it (the guide strip below the video); in the body it paints above
 * them. In fullscreen and PiP only the layer the player fills is visible, so it goes there.
 */
function menuLayer(): Element {
  return document.fullscreenElement ?? document.querySelector('[data-pip-layer]:not([hidden])') ?? document.body;
}

/**
 * The right-click menu of the video, opened at `at` (CSS px in the viewport): embedded mpv's, and
 * the built-in player's in place of the browser's page menu (PL-NATIVE-CONTEXT-MENU). The same
 * rows for both engines, Picture and (for VOD) Speed included. Over mpv the native window paints
 * above the DOM, so the surface cuts this menu out of the video while it is open (it carries
 * `data-mpv-overlay`). Portalled (`menuLayer`) so no page strip paints over it. Closes on a pick,
 * Escape, a click elsewhere or a resize; `onClose` must be stable (it is an effect dependency).
 * A click elsewhere is noted (`noteMenuDismissed`), so the built-in player's click on the
 * picture that follows only closes it.
 */
export function VideoContextMenu({ at, onClose }: { at: { x: number; y: number }; onClose(): void }) {
  const { t } = useTranslation('player');
  const { toast } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>('root');
  const [pos, setPos] = useState(at);
  const status = usePlayerStore((s) => s.status);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const source = usePlayerStore((s) => s.source);
  const tracks = useMediaStore((s) => s.tracks);
  const commands = useMediaStore((s) => s.commands);
  const canPip = useMediaStore((s) => s.canPip);
  const pipActive = usePipStore((s) => s.active);
  const statsOpen = useStreamInfoStore((s) => s.open);
  const syncSummary = useSyncSummary();
  const syncAvailable = useSyncAvailable();
  const pictureValue = usePictureSummary();
  const rate = useMediaStore((s) => s.rate);

  // Open at the click, flipped or pushed back inside the window when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const fit = (p: number, size: number, max: number): number => {
      const v = p + size + EDGE > max ? p - size : p;
      return Math.max(EDGE, Math.min(v, max - size - EDGE));
    };
    setPos({ x: fit(at.x, width, window.innerWidth), y: fit(at.y, height, window.innerHeight) });
  }, [at.x, at.y, view]);

  useEffect(() => {
    // A new view starts at its top (the frame is the same element). The style view has no
    // items: the first enabled item, else Back, so focus stays in the menu.
    const menu = ref.current;
    if (menu) menu.scrollTop = 0;
    (
      menu?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([data-menu-back])') ??
      menu?.querySelector<HTMLElement>('[data-menu-back]')
    )?.focus({ preventScroll: true });
  }, [view]);

  useEffect(() => {
    const menu = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (): void => onClose();
    const onPointer = (e: PointerEvent): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      // A primary press: its click on the picture only closes the menu (a right one opens it again).
      if (!(e.button > 0)) noteMenuDismissed(e.target);
      close();
    };
    // Capture: claims Escape before the shell and the PiP layer see it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      if (previous?.isConnected && menu?.contains(document.activeElement)) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  if (!source) return null;

  const pick = (run: () => void): void => {
    run();
    onClose();
  };

  const copyLink = async (): Promise<void> => {
    onClose();
    try {
      await navigator.clipboard.writeText(source.url);
      toast({ title: t('streamLinkCopied'), description: t('streamLinkCopiedHint'), variant: 'success' });
    } catch {
      toast({ title: t('streamLinkCopyFailed'), variant: 'error' });
    }
  };

  const playing = status === 'playing' || status === 'loading';
  // The style view holds form fields (radio groups, a slider), which a menu may not contain: it is
  // a small dialog in the same frame instead.
  const styleView = view === 'style';
  const back = (
    <button
      type="button"
      role={styleView ? undefined : 'menuitem'}
      data-menu-back
      onClick={() => setView(view === 'style' ? 'text' : 'root')}
      className="mb-1 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-start text-body-sm font-medium text-on-glass hover:bg-white/10"
    >
      <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
      {view === 'audio'
        ? t('audioTrack')
        : view === 'sync'
          ? t('sync')
          : view === 'sleep'
            ? t('sleepTimer')
            : view === 'style'
              ? t('subtitleStyle.menuTitle')
              : view === 'picture'
                ? t('picture')
                : view === 'speed'
                  ? t('speed')
                  : t('subtitles')}
    </button>
  );
  const icon = 'size-4 shrink-0';
  const isVod = !source.isLive && !source.isRadio;

  // `isFullscreen` and `pipActive` re-render the menu when the layer it belongs in changes.
  return createPortal(
    <div
      ref={ref}
      role={styleView ? 'dialog' : 'menu'}
      aria-label={styleView ? t('subtitleStyle.menuTitle') : t('settingsMenu')}
      data-mpv-overlay=""
      data-testid="video-context-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' && view !== 'root') {
          e.preventDefault();
          setView(view === 'style' ? 'text' : 'root');
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input[type="range"]:not(:disabled)') ?? []);
          const i = items.indexOf(document.activeElement as HTMLElement);
          items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        }
      }}
      className="player-glass-strong player-glass-edge glass-blur fixed z-[60] max-h-[min(70vh,420px)] w-64 overflow-y-auto rounded-lg border p-1.5 motion-safe:animate-pop-in"
    >
      {view === 'root' && (
        <>
          <MenuAction
            icon={playing ? <Pause className={icon} aria-hidden /> : <Play className={icon} aria-hidden />}
            label={playing ? t('pause') : t('play')}
            onClick={() => pick(() => usePlayerStore.getState().togglePlay())}
          />
          {!pipActive && (
            <MenuAction
              icon={isFullscreen ? <Minimize className={icon} aria-hidden /> : <Maximize className={icon} aria-hidden />}
              label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
              onClick={() => pick(() => usePlayerStore.getState().toggleFullscreen())}
            />
          )}
          {canPip && commands && (
            <MenuAction
              icon={<PictureInPicture2 className={icon} aria-hidden />}
              label={pipActive ? t('exitPip') : t('pip')}
              onClick={() => pick(() => commands.togglePip())}
            />
          )}
          {tracks.audio.length > 0 && (
            <MenuRow
              label={t('audioTrack')}
              value={tracks.audio.find((a) => a.selected)?.label ?? t('trackDefault')}
              onClick={() => setView('audio')}
            />
          )}
          {/* Always there (C6): a file can be loaded into a stream without subtitles. */}
          <MenuRow label={t('subtitles')} value={tracks.text.find((a) => a.selected)?.label ?? t('off')} onClick={() => setView('text')} />
          {isVod && (
            <MenuRow label={t('speed')} value={rate === 1 ? t('speedNormal') : t('speedValue', { speed: rate })} onClick={() => setView('speed')} />
          )}
          {syncAvailable && <MenuRow label={t('sync')} value={syncSummary} onClick={() => setView('sync')} />}
          <MenuRow label={t('picture')} value={pictureValue} onClick={() => setView('picture')} />
          {/* Sleep timer (C5), as in the options menu. */}
          <MenuRow label={t('sleepTimer')} value={<SleepRowValue />} onClick={() => setView('sleep')} />
          <MenuToggle label={t('streamInfo')} checked={statsOpen} hint="I" onClick={() => pick(() => void toggleStreamInfo())} />
          <MenuSeparator />
          {/* Screenshot (C6): the menu closes first, so it is never in the picture. */}
          <MenuAction icon={<Camera className={icon} aria-hidden />} label={t('screenshot')} shortcut="screenshot" onClick={() => pick(() => void takeScreenshot())} />
          {canShareSource(source, knownSourceKind) && (
            <MenuAction icon={<Copy className={icon} aria-hidden />} label={t('copyStreamLink')} onClick={() => void copyLink()} />
          )}
        </>
      )}
      {view === 'audio' && (
        <>
          {back}
          {tracks.audio.map((a) => (
            <MenuChoice key={a.id} label={a.label} selected={a.selected} onClick={() => pick(() => commands?.setAudio(a.id))} />
          ))}
        </>
      )}
      {view === 'sync' && (
        <>
          {back}
          <SyncRows />
        </>
      )}
      {view === 'picture' && (
        <>
          {back}
          <PictureRows />
        </>
      )}
      {view === 'speed' && (
        <>
          {back}
          <SpeedRows onDone={onClose} />
        </>
      )}
      {view === 'sleep' && (
        <>
          {back}
          <SleepMenu onDone={onClose} />
        </>
      )}
      {view === 'text' && (
        <>
          {back}
          <SubtitleTrackMenu onDone={onClose} onStyle={() => setView('style')} />
        </>
      )}
      {view === 'style' && (
        <>
          {back}
          <SubtitleStyleMenu />
        </>
      )}
    </div>,
    menuLayer(),
  );
}
