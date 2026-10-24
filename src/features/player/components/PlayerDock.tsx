import { GripHorizontal, Maximize2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router';

import '../player.css';

import { PHONE_QUERY } from '@/shell/navigation';
import { useMediaQuery } from '@/shell/useMediaQuery';
import { IconButton } from '@/ui/Button';
import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { bindExternalEvents } from '../external';
import { bindPlaybackReport } from '../playbackReport';
import { bindRecovery } from '../reconnect';
import { useMediaStore } from '../media';
import { bindLiveProgramme } from '../nowNext';
import { bindRemote } from '../remote';
import { bindParentalGuard } from '../parentalGuard';
import { lockLandscapeForVideo, unlockOrientation } from '../fullscreen';
import { exitPip, usePipStore } from '../pip';
import { expandPath, noteStageShown, setRehome, useStageTarget } from '../stage';
import { flushProgress, replay, reportFullscreen, selectEnded, usePlayerStore } from '../store';
import { usePlaybackShortcuts } from '../usePlaybackShortcuts';
import { bindSettingsEvents, usePlayerSettings } from '../useSettings';
import { retryPlayback } from './Controls';
import { PlayerSurface } from './PlayerSurface';
import { SleepTimerHost, ZapHeaderLine } from './lazyParts';
import { useZapBannerShown, useZapHover } from './zapHooks';

const POS_KEY = 'player.mini.pos';
const MARGIN = 16;
/**
 * A phone's mini player bar (below sm, over the tab bar): its height, in rem against the 15 px
 * root like the tab bar's, so it follows the UI scale and not density. While it shows,
 * `--player-bar-inset` on <html> holds it, for the page to keep its last row clear of it.
 */
export const PLAYER_BAR_HEIGHT = 'calc(64rem / 15)';
/** A finger moved this far before the bar follows it down (px), and this far closes it. */
const SWIPE_SLOP_PX = 8;
const SWIPE_CLOSE_PX = 32;

/**
 * The mini frame's offset from the inline-end edge (right in LTR, left in RTL) and the bottom.
 * Logical, so in Arabic it docks bottom-left, away from the rail on the right.
 */
interface MiniPos {
  end: number;
  bottom: number;
}

function readPos(): MiniPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      // `right` is the name builds before the logical dock saved the same offset under.
      const p = JSON.parse(raw) as Partial<MiniPos> & { right?: unknown };
      const end = typeof p.end === 'number' ? p.end : p.right;
      if (typeof end === 'number' && typeof p.bottom === 'number') return { end, bottom: p.bottom };
    }
  } catch {
    // default
  }
  return { end: MARGIN, bottom: MARGIN };
}

/** A probe as tall as the shell's bottom inset, measured instead of parsed (it may be a calc with env()). */
let insetProbe: HTMLDivElement | null = null;

/**
 * The height the shell keeps clear at the bottom of the window (a phone's tab bar and the home
 * indicator), in px: `--shell-bottom-inset`, 0 where the shell sets none. The mini frame's
 * `bottom` offset counts from above it.
 */
export function shellBottomInset(): number {
  if (typeof document === 'undefined') return 0;
  if (!insetProbe?.isConnected) {
    insetProbe = document.createElement('div');
    insetProbe.setAttribute('aria-hidden', 'true');
    insetProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;height:var(--shell-bottom-inset,0px)';
    document.body.appendChild(insetProbe);
  }
  return insetProbe.offsetHeight;
}

function clampPos(p: MiniPos, w: number, h: number): MiniPos {
  const maxEnd = Math.max(MARGIN, window.innerWidth - w - MARGIN);
  const maxBottom = Math.max(MARGIN, window.innerHeight - shellBottomInset() - h - MARGIN);
  return { end: Math.min(maxEnd, Math.max(MARGIN, p.end)), bottom: Math.min(maxBottom, Math.max(MARGIN, p.bottom)) };
}

/**
 * +1 when the inline-end edge is on the right (LTR), -1 when it is on the left (RTL). The frame
 * takes its direction from <html dir>, which the language setting sets (i18n `syncDocument`).
 */
function endSide(): number {
  return document.documentElement.dir === 'rtl' ? -1 : 1;
}

/**
 * Moves the player host node. A DOM move blurs whatever was focused inside it (the PiP or
 * expand button the user just pressed), so focus is put back on the same element afterwards.
 */
export function moveKeepingFocus(host: HTMLElement, target: Element): void {
  const active = document.activeElement;
  const had = active instanceof HTMLElement && host.contains(active) ? active : null;
  target.appendChild(host);
  if (had && document.activeElement !== had && had.isConnected) had.focus({ preventScroll: true });
}

interface ExpandProps {
  label: string;
  /** The phone bar's: a button over the whole bar (under its other buttons), so a tap anywhere expands. */
  stretched?: boolean;
}

function ExpandButton(props: ExpandProps) {
  const inRouter = useInRouterContext();
  return inRouter ? <RouterExpand {...props} /> : <ExpandBase {...props} onExpand={() => usePlayerStore.getState().toggleFullscreen()} />;
}

function RouterExpand(props: ExpandProps) {
  const navigate = useNavigate();
  return (
    <ExpandBase
      {...props}
      onExpand={() => {
        const { source, zapContext } = usePlayerStore.getState();
        const path = expandPath(source, zapContext);
        if (path) navigate(path);
        else usePlayerStore.getState().toggleFullscreen();
      }}
    />
  );
}

/** The mini header's round buttons: 28 px, 40 px under a coarse pointer (PL-TOUCH-ERGONOMICS). */
const MINI_BUTTON =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg active:bg-active pointer-coarse:size-10';

function ExpandBase({ label, onExpand, stretched = false }: ExpandProps & { onExpand(): void }) {
  if (stretched) {
    return (
      <Tooltip content={label} describe={false}>
        {/* A press here may start a swipe down, so it reaches the bar (no stopPropagation). */}
        <button type="button" aria-label={label} onClick={onExpand} className="absolute inset-0 cursor-pointer -outline-offset-2" />
      </Tooltip>
    );
  }
  return (
    <Tooltip content={label} describe={false}>
      <button type="button" aria-label={label} onClick={onExpand} onPointerDown={(e) => e.stopPropagation()} className={MINI_BUTTON}>
        <Maximize2 className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

/**
 * The phone bar's play button: play or pause, Replay at the end of an item, Retry after a
 * failure (the thumbnail is too small for the error panel). Its own component, so status
 * changes do not re-render the dock.
 */
function BarPlayButton() {
  const { t } = useTranslation('player');
  const status = usePlayerStore((s) => s.status);
  const ended = usePlayerStore(selectEnded);
  const className = 'relative';
  if (ended) return <IconButton label={t('replay')} icon={<RotateCcw size={18} aria-hidden />} onClick={replay} className={className} />;
  if (status === 'error') return <IconButton label={t('retry')} icon={<RotateCcw size={18} aria-hidden />} onClick={retryPlayback} className={className} />;
  const playing = status === 'playing' || status === 'loading';
  return (
    <IconButton
      label={playing ? t('pause') : t('play')}
      icon={playing ? <Pause size={18} className="fill-current" aria-hidden /> : <Play size={18} className="fill-current" aria-hidden />}
      onClick={() => usePlayerStore.getState().togglePlay()}
      className={className}
    />
  );
}

/** The phone bar's second line: what airs or the episode, or what the player is doing when that matters more. */
function BarStatusLine({ subtitle }: { subtitle: string | undefined }) {
  const { t } = useTranslation('player');
  const status = usePlayerStore((s) => s.status);
  const ended = usePlayerStore(selectEnded);
  const text = status === 'error' ? t('errorTitle') : status === 'loading' ? t('loading') : ended ? t('playbackFinished') : subtitle;
  if (!text) return null;
  // dir="auto" truncates a Latin programme at its own end; text-match-parent keeps it on the name's side in RTL.
  return (
    <p
      dir="auto"
      data-testid="mini-bar-status"
      className={cn('truncate text-caption text-match-parent', status === 'error' ? 'text-danger' : 'text-fg-muted')}
    >
      {text}
    </p>
  );
}

/**
 * Rendered once by the shell. Owns one persistent host node for the player and moves it
 * (DOM move, no remount) into the mounted <PlayerStage /> or into the floating mini frame.
 * Also binds playback shortcuts, remote control, external-player events and unload flushes.
 * Memoized (performance audit SH-1): the shell's own re-renders pass it by.
 */
export const PlayerDock = memo(function PlayerDock() {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const mode = usePlayerStore((s) => s.mode);
  const dock = usePlayerStore((s) => s.dock);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const isWindowFilled = usePlayerStore((s) => s.isWindowFilled);
  const zapContext = usePlayerStore((s) => s.zapContext);
  const pip = usePipStore((s) => s.active);
  const settings = usePlayerSettings();
  const stageTarget = useStageTarget();
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.dataset['playerHost'] = '';
    el.className = 'absolute inset-0 z-10 bg-black';
    return el;
  });
  const miniSlotRef = useRef<HTMLDivElement>(null);
  const pipSlotRef = useRef<HTMLDivElement>(null);
  const windowSlotRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MiniPos>(readPos);

  const visible = !!source && mode !== 'external';
  const inStage = visible && dock === 'stage' && !!stageTarget;
  const inMini = visible && !inStage && !isWindowFilled && dock !== 'hidden';
  // Below sm (the shell's tab bar shows) the mini player is a full-width bar docked above the tab
  // bar, not a floating window over the page: a phone's floating frame covered the content column
  // and cut the name to a few letters.
  const bar = useMediaQuery(PHONE_QUERY);
  const barShown = inMini && bar;
  // Hovering the mini player's channel title brings up the zap banner over its video; leaving the
  // mini player (no pointerleave comes then) lets go of that hold.
  const titleHover = useZapHover(inMini);
  // A zap in the mini player: its header gains the number and what airs now (no banner over the
  // small picture, which would repeat the name the header already shows).
  const zapShown = useZapBannerShown();
  const miniZap = inMini && zapShown && mode !== 'radio';
  const channelPanelAvailable = !!source?.isLive && (settings?.fullscreenChannelPanel ?? true) && !!(zapContext ?? source?.ref);

  usePlaybackShortcuts({ channelPanelAvailable });
  // Subtitle look (C6): player.css reads these variables in `video::cue`. The mapping loads
  // on its own, outside the entry chunk; until then `video::cue` uses its fallbacks.
  useEffect(() => {
    if (!settings) return;
    let live = true;
    void import('../subtitles/style').then(({ cueCssVars, styleFromSettings }) => {
      if (!live) return;
      for (const [name, value] of Object.entries(cueCssVars(styleFromSettings(settings)))) host.style.setProperty(name, value);
    });
    return () => {
      live = false;
    };
  }, [host, settings]);

  // One-time global bindings.
  useEffect(() => {
    bindSettingsEvents();
    bindExternalEvents();
    return bindRemote();
  }, []);

  // failover: smart reconnect and live failover follow the player from here.
  useEffect(() => bindRecovery(), []);
  // downloads: the core leaves playback the connections its account allows.
  useEffect(() => bindPlaybackReport(), []);
  // A live channel's subtitle follows what airs (title bar, system media controls).
  useEffect(() => bindLiveProgramme(), []);
  // Parental controls locking again re-check what plays (Ask: PIN prompt; Hide: stop).
  useEffect(() => bindParentalGuard(), []);

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Synchronous move out of a stage that is about to unmount.
  useEffect(() => {
    setRehome((removed, next) => {
      if (host.parentNode !== removed) return;
      const target = next ?? miniSlotRef.current;
      if (target) moveKeepingFocus(host, target);
    });
    return () => setRehome(null);
  }, [host]);

  // Place the host node: the picture-in-picture layer wins over the stage and the mini frame.
  const inPip = pip && visible;
  const inWindowFill = isWindowFilled && visible && !inPip;
  useLayoutEffect(() => {
    const target = inPip ? pipSlotRef.current : inWindowFill ? windowSlotRef.current : inStage ? stageTarget : miniSlotRef.current;
    if (target && host.parentNode !== target) moveKeepingFocus(host, target);
  }, [inPip, inWindowFill, inStage, stageTarget, host]);
  // The page showing this stream in its stage: Expand comes back to it for a stream with no page of its own.
  const sourceUrl = source?.url;
  useLayoutEffect(() => {
    if (inStage && sourceUrl) noteStageShown(sourceUrl);
  }, [inStage, stageTarget, sourceUrl]);

  // Nothing left to show in the small window: give the app its window back.
  useEffect(() => {
    if (pip && !visible) void exitPip();
  }, [pip, visible]);

  useEffect(
    () => () => {
      host.remove();
    },
    [host],
  );

  // Store fullscreen flag <-> DOM fullscreen of the host (which outlives engine remounts).
  useEffect(() => {
    if (isFullscreen && document.fullscreenElement !== host) {
      host.requestFullscreen?.().then(
        () => lockLandscapeForVideo(usePlayerStore.getState().mode),
        () => reportFullscreen(false),
      );
    } else if (!isFullscreen && document.fullscreenElement === host) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [isFullscreen, host]);
  useEffect(() => {
    const on = (): void => {
      const fs = document.fullscreenElement === host;
      reportFullscreen(fs);
      if (!fs) {
        useMediaStore.setState({ channelPanelOpen: false });
        unlockOrientation();
      }
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [host]);

  // Keep the mini frame on screen when the window shrinks.
  useEffect(() => {
    const onResize = (): void => {
      const el = miniRef.current;
      // The phone bar spans the window: the floating frame's offset is kept for wider windows.
      if (!el || el.dataset['layout'] === 'bar') return;
      setPos((p) => clampPos(p, el.offsetWidth, el.offsetHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const drag = useRef<{ x: number; y: number; start: MiniPos } | null>(null);
  const onDragStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, start: pos };
    },
    [pos],
  );
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const el = miniRef.current;
    if (!d || !el) return;
    setPos(
      clampPos(
        { end: d.start.end - endSide() * (e.clientX - d.x), bottom: d.start.bottom - (e.clientY - d.y) },
        el.offsetWidth,
        el.offsetHeight,
      ),
    );
  };
  const onDragEnd = (): void => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      // ignore
    }
  };
  const nudge = (dx: number, dy: number): void => {
    const el = miniRef.current;
    if (!el) return;
    const next = clampPos({ end: pos.end - endSide() * dx, bottom: pos.bottom - dy }, el.offsetWidth, el.offsetHeight);
    setPos(next);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  // The bar covers the bottom of the page: its height, for the shell to keep the page's end clear.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.style.setProperty('--player-bar-inset', barShown ? PLAYER_BAR_HEIGHT : '0px');
    return () => {
      html.style.removeProperty('--player-bar-inset');
    };
  }, [barShown]);

  /**
   * Swiping the phone bar down closes the player, as on a phone's own media bars. The bar follows
   * the finger (written to its style, so the dock does not re-render per move) and springs back
   * when let go early. A press that turned into a swipe is no tap: the pointer is captured, so
   * the click lands on the bar and not on Expand under the finger.
   */
  const swipe = useRef<{ id: number; y: number; dy: number; moving: boolean } | null>(null);
  const setSwipeOffset = (dy: number): void => {
    const el = miniRef.current;
    if (!el) return;
    el.style.transform = dy ? `translateY(${dy}px)` : '';
    el.style.opacity = dy ? String(Math.max(0.3, 1 - dy / (2 * el.offsetHeight))) : '';
    el.style.transition = dy ? 'none' : '';
  };
  const onSwipeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!bar || e.button !== 0) return;
    swipe.current = { id: e.pointerId, y: e.clientY, dy: 0, moving: false };
  };
  const onSwipeMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const sw = swipe.current;
    if (!sw || sw.id !== e.pointerId) return;
    sw.dy = Math.max(0, e.clientY - sw.y);
    if (!sw.moving && sw.dy > SWIPE_SLOP_PX) {
      sw.moving = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (sw.moving) setSwipeOffset(sw.dy);
  };
  const onSwipeEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const sw = swipe.current;
    if (!sw || sw.id !== e.pointerId) return;
    swipe.current = null;
    if (!sw.moving) return;
    setSwipeOffset(0);
    if (e.type === 'pointerup' && sw.dy >= SWIPE_CLOSE_PX) usePlayerStore.getState().stop();
  };

  const isRadio = mode === 'radio';

  return (
    <>
      {/* Fullscreen from the mini frame fills the screen: full controls, not the mini bar. */}
      {createPortal(
        <PlayerSurface compact={inMini && !isFullscreen && !inWindowFill && !inPip} thumb={barShown && !isFullscreen && !inWindowFill && !inPip} channelPanelAvailable={channelPanelAvailable} />,
        host,
      )}
      {/* Sleep timer (C5): the one-minute warning toast. */}
      <SleepTimerHost />
      <div
        ref={miniRef}
        role="region"
        aria-label={t('nowPlaying')}
        // Toasts lift above the docked mini player instead of covering its controls (ui/Toast.tsx).
        data-toast-avoid=""
        // Focus in here gives Space, the arrows and Page Up/Down to the player (playerOwnsPageKeys).
        data-player-mini=""
        data-layout={bar ? 'bar' : 'frame'}
        hidden={!inMini}
        className={cn(
          // z-[35]: over the page and its own raised bits (z-30 at most), under what a page opens
          // over itself, its scrims (z-40) and its menus, drawers and sheets (z-50), so a context
          // menu or the guide's programme sheet is never hidden behind the mini player and a scrim
          // dims it with the page. The kit's portaled menus, dialogs, tooltips and toasts are higher still.
          'fixed z-[35] bg-surface',
          bar
            ? // touch-none: a finger on the bar swipes it, it does not pan the page.
              'inset-x-0 flex touch-none items-center gap-3 border-t border-divider ps-2 pe-1 select-none motion-safe:transition-[transform,opacity] motion-safe:duration-(--duration-fast)'
            : cn(
                'flex flex-col overflow-hidden rounded-lg border border-edge shadow-2',
                // Below sm the bar takes over; the frame's own phone width (under half the screen,
                // 190 px at least) stays for a browser that cannot tell (no matchMedia).
                isRadio ? 'w-[min(420px,calc(100vw-32px))]' : 'w-[max(190px,45vw)] sm:w-[clamp(280px,26vw,440px)]',
              ),
          inMini && (bar ? 'motion-safe:animate-sheet-in' : 'motion-safe:animate-pop-in'),
        )}
        // The floating frame sits above the shell's bottom inset (a phone's tab bar) wherever it was
        // dragged; the bar right on it.
        style={
          bar
            ? { bottom: 'var(--shell-bottom-inset, 0px)', height: PLAYER_BAR_HEIGHT }
            : { insetInlineEnd: pos.end, bottom: `calc(${pos.bottom}px + var(--shell-bottom-inset, 0px))` }
        }
        onPointerDown={onSwipeStart}
        onPointerMove={onSwipeMove}
        onPointerUp={onSwipeEnd}
        onPointerCancel={onSwipeEnd}
      >
        {!bar && (
          <div
            // touch-none: a finger on the header drags the frame instead of scrolling the page.
            className="flex h-10 shrink-0 cursor-grab touch-none items-center gap-1.5 border-b border-divider ps-1.5 pe-1 active:cursor-grabbing pointer-coarse:h-11 pointer-coarse:ps-3"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          >
            <Tooltip content={t('dragToMove')} describe={false}>
              <button
                type="button"
                aria-label={t('dragToMove')}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 64 : 16;
                  const map: Record<string, [number, number]> = {
                    ArrowLeft: [-step, 0],
                    ArrowRight: [step, 0],
                    ArrowUp: [0, -step],
                    ArrowDown: [0, step],
                  };
                  const d = map[e.key];
                  if (!d) return;
                  e.preventDefault();
                  e.stopPropagation();
                  nudge(d[0], d[1]);
                }}
                // A finger drags the header itself; the grip is the keyboard's (arrow keys).
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg pointer-coarse:hidden"
              >
                <GripHorizontal className="size-4" aria-hidden />
              </button>
            </Tooltip>
            {source?.isLive && <span className="size-1.5 shrink-0 rounded-full bg-live" aria-hidden />}
            <span
              className="flex min-w-0 flex-1 text-body-sm font-medium text-fg"
              title={source?.title}
              onPointerEnter={titleHover.onPointerEnter}
              onPointerLeave={titleHover.onPointerLeave}
            >
              {miniZap && source ? <ZapHeaderLine title={source.title} /> : <span className="min-w-0 truncate">{source?.title}</span>}
            </span>
            <ExpandButton label={t('expand')} />
            <Tooltip content={t('close')} describe={false}>
              <button
                type="button"
                aria-label={t('close')}
                onClick={() => usePlayerStore.getState().stop()}
                onPointerDown={(e) => e.stopPropagation()}
                className={MINI_BUTTON}
              >
                <X className="size-4" aria-hidden />
              </button>
            </Tooltip>
          </div>
        )}
        {/* The host's slot: the same element in both layouts, so a rotation never takes the player out of the page. */}
        <div
          ref={miniSlotRef}
          className={cn(
            'relative bg-black',
            bar
              ? // A 16:9 thumbnail (a station's square art). isolate: the host's z-index stays inside, under Expand.
                cn('isolate h-[calc(54rem/15)] shrink-0 overflow-hidden rounded-sm', isRadio ? 'aspect-square' : 'aspect-video')
              : isRadio
                ? 'h-16'
                : mode === 'embedded-mpv'
                  ? 'aspect-[16/11]'
                  : 'aspect-video',
          )}
        />
        {bar && (
          <>
            <ExpandButton label={t('expand')} stretched />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-fg">
                {source?.isLive && <span className="size-1.5 shrink-0 rounded-full bg-live" aria-hidden />}
                {miniZap && source ? (
                  <ZapHeaderLine title={source.title} />
                ) : (
                  <span dir="auto" className="min-w-0 truncate">
                    {source?.title}
                  </span>
                )}
              </p>
              <BarStatusLine subtitle={source?.subtitle} />
            </div>
            <div className="flex shrink-0 items-center">
              <BarPlayButton />
              <IconButton label={t('close')} icon={<X size={18} aria-hidden />} onClick={() => usePlayerStore.getState().stop()} className="relative" />
            </div>
          </>
        )}
      </div>
      {/* Picture-in-picture: the player covers the whole (shrunken, borderless) window. */}
      <div ref={pipSlotRef} data-pip-layer="" hidden={!inPip} className="fixed inset-0 z-[2147483000] bg-black" />
      {/* Window fill stays inside the normal app window; menus and dialogs can still appear over it. */}
      <div ref={windowSlotRef} data-player-window-layer="" hidden={!inWindowFill} className="fixed inset-0 z-[45] bg-black" />
    </>
  );
});
