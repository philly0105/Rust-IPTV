import { AlertTriangle, PictureInPicture2, Play, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cursorInViewport } from '@/api/window';

import { cn } from '../cn';
import { bindInputModality, focusFromPointer, focusIfPlayerOwnsFocus, focusIsLost, formatTime } from '../format';
import { showOsd, UP_NEXT_SECONDS, useMediaStore } from '../media';
import { exitPip, usePipStore } from '../pip';
import {
  cancelUpNext,
  DOUBLE_CLICK_MS,
  MIN_RESUME_SECONDS,
  playUpNextNow,
  replay,
  retryResolve,
  selectEnded,
  setPaused,
  usePlayerStore,
} from '../store';
import { useRetryWhenOnline, useStreamError } from '../useStreamError';
import { BarReadout, Controls, CtlButton, InlineSpinner } from './Controls';
import { FullscreenChannelPanel } from './FullscreenChannelPanel';
import { InlinePlayer } from './InlinePlayer';
import { MpvSurface } from './MpvSurface';
import { RadioPlayer } from './RadioPlayer';

const HIDE_AFTER_MS = 2600;
/** How often fullscreen mpv checks whether the mouse moved over the native video window. */
const CURSOR_POLL_MS = 200;

/**
 * Keeps the chrome pinned while *keyboard* focus is inside it. Focus left on a button by a
 * mouse click does not pin, or the controls would never hide again after one click.
 */
function useKeyboardFocusPin(): {
  pinned: boolean;
  onFocus(e: FocusEvent<HTMLElement>): void;
  onBlur(e: FocusEvent<HTMLElement>): void;
} {
  const [pinned, setPinned] = useState(false);
  useEffect(() => bindInputModality(), []);
  return {
    pinned,
    onFocus: (e) => {
      // The root itself takes focus only as a fallback; that is not a control in use.
      setPinned(e.target !== e.currentTarget && !focusFromPointer());
    },
    onBlur: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPinned(false);
    },
  };
}

/** Big tuner readout after a zap or volume change. */
function Osd() {
  const osd = useMediaStore((s) => s.osd);
  if (!osd) return null;
  return (
    <div
      key={osd.key}
      aria-live="polite"
      className="player-osd pointer-events-none absolute top-5 end-6 z-20 text-end text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.8)]"
    >
      <div className={cn('font-display leading-none tabular-nums', /^\d+$/.test(osd.primary) ? 'text-6xl text-accent-hover' : 'text-2xl')}>
        {osd.primary}
      </div>
      {osd.secondary && <div className="mt-1 max-w-[50vw] truncate text-lg">{osd.secondary}</div>}
    </div>
  );
}

/**
 * "Next episode" card with a 10 s countdown; Play now or Cancel.
 * `strip` lays it out in flow (embedded mpv: nothing may float over the native window).
 */
function UpNextCard({ variant = 'overlay', compact = false }: { variant?: 'overlay' | 'strip'; compact?: boolean }) {
  const { t } = useTranslation('player');
  const upNext = useMediaStore((s) => s.upNext);
  const [now, setNow] = useState(() => Date.now());
  // Display only: the store's timer advances at zero (see `playUpNextNow` / the up-next timer).
  useEffect(() => {
    if (!upNext) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [upNext]);
  // Play now takes focus only when the player has it: an episode ending in the mini player
  // must not pull focus out of the list the user is browsing.
  const playNowRef = useRef<HTMLButtonElement>(null);
  const hasUpNext = !!upNext;
  useEffect(() => {
    if (hasUpNext) focusIfPlayerOwnsFocus(playNowRef.current);
  }, [hasUpNext]);
  if (!upNext) return null;
  const left = Math.max(0, Math.ceil((upNext.deadline - now) / 1000));
  const progress = Math.min(1, Math.max(0, 1 - left / UP_NEXT_SECONDS));
  const name = `${upNext.source.subtitle ? `${upNext.source.subtitle} ` : ''}${upNext.source.title}`;
  // The mini player is too narrow for the card: a bar across its bottom edge instead.
  const tight = compact && variant === 'overlay';
  return (
    <div
      role="status"
      data-mpv-reserved=""
      data-testid="up-next"
      aria-label={t('nextEpisode')}
      className={cn(
        'overflow-hidden text-white',
        tight
          ? 'absolute inset-x-0 bottom-0 z-30 bg-[rgb(9_13_21/0.94)]'
          : variant === 'overlay'
            ? 'absolute end-4 bottom-24 z-30 w-72 max-w-[calc(100%-2rem)] rounded-lg border border-white/10 bg-[rgb(9_13_21/0.94)] shadow-2 motion-safe:animate-pop-in'
            : 'shrink-0 border-t border-white/10 bg-[#070b12]',
      )}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelUpNext();
        }
      }}
    >
      <div className="h-0.5 bg-white/10">
        <div className="h-full bg-accent motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${progress * 100}%` }} />
      </div>
      <div className={variant === 'overlay' && !tight ? 'p-3' : 'flex items-center gap-2 px-3 py-2'}>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-white/70">{t('nextEpisodeIn', { count: left })}</p>
          {!tight && (
            <p className="mt-0.5 truncate font-display text-base" title={name}>
              {name}
            </p>
          )}
        </div>
        <div className={cn('flex shrink-0 gap-2', variant === 'overlay' && !tight && 'mt-3')}>
          <button
            ref={playNowRef}
            type="button"
            onClick={playUpNextNow}
            title={tight ? name : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md bg-accent font-medium text-accent-fg hover:bg-accent-hover',
              tight ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            )}
          >
            <Play className={cn('fill-current', tight ? 'size-3.5' : 'size-4')} aria-hidden />
            {t('playNow')}
          </button>
          <button
            type="button"
            onClick={cancelUpNext}
            className={cn('rounded-md text-white/80 hover:bg-white/10', tight ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm')}
          >
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Over the DOM video once a VOD item finished: one big replay button (the controls stay usable). */
function EndedOverlay({ compact }: { compact: boolean }) {
  const { t } = useTranslation('player');
  const ended = usePlayerStore(selectEnded);
  const upNext = useMediaStore((s) => s.upNext);
  if (!ended || upNext) return null;
  return (
    <div
      className="absolute inset-0 z-[15] flex items-center justify-center bg-black/55 motion-safe:animate-fade-in"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={replay}
        aria-label={t('replay')}
        className="group flex flex-col items-center gap-2 rounded-lg p-2 text-white focus-visible:outline-2 focus-visible:outline-white dark:focus-visible:outline-accent"
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-white/12 ring-1 ring-white/25 group-hover:bg-accent group-hover:text-accent-fg group-hover:ring-transparent motion-safe:transition-colors',
            compact ? 'size-11' : 'size-16',
          )}
        >
          <RotateCcw className={compact ? 'size-5' : 'size-7'} aria-hidden />
        </span>
        {!compact && <span className="text-sm font-medium">{t('replay')}</span>}
      </button>
    </div>
  );
}

/**
 * Embedded mpv notices (error, up next, finished, starting) as an in-flow strip between the
 * native surface and the control bar. Marked `data-mpv-reserved`, so the bounds sent to mpv
 * exclude it even if a layout change ever pushed it over the surface.
 */
/** "Buffering" with the bar-sized spinner: embedded mpv stalled mid-stream. */
function BufferingLabel() {
  const { t } = useTranslation('player');
  return (
    <span data-testid="mpv-buffering" className="inline-flex items-center gap-1.5 text-white/80">
      <InlineSpinner />
      {t('buffering')}
    </span>
  );
}

/** Embedded mpv has the stream loaded but is waiting for data (paused-for-cache). */
function useMpvBuffering(): boolean {
  const status = usePlayerStore((s) => s.status);
  return useMediaStore((s) => !!s.mpv?.loaded && !!s.mpv.buffering) && (status === 'playing' || status === 'paused');
}

function MpvNotices({ compact, overlay = false }: { compact: boolean; overlay?: boolean }) {
  const { t } = useTranslation('player');
  const status = usePlayerStore((s) => s.status);
  const error = usePlayerStore((s) => s.error);
  const ended = usePlayerStore(selectEnded);
  const upNext = useMediaStore((s) => s.upNext);
  const mpv = useMediaStore((s) => s.mpv);
  const retryRef = useRef<HTMLButtonElement>(null);
  const buffering = useMpvBuffering();
  const isError = status === 'error';
  const view = useStreamError(null);
  const retry = useCallback((): void => {
    if (retryResolve()) return;
    usePlayerStore.setState({ status: 'loading', error: undefined });
    useMediaStore.getState().commands?.retry();
  }, []);
  useRetryWhenOnline(isError ? view.cls : 'generic', retry);
  useEffect(() => {
    if (isError) focusIfPlayerOwnsFocus(retryRef.current);
  }, [isError]);

  if (upNext && status !== 'error') return <UpNextCard variant="strip" />;

  const strip = 'flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#070b12] px-3 py-1.5 text-sm text-white';
  if (status === 'error') {
    return (
      <div role="alert" data-mpv-reserved="" data-error-class={view.cls} className={strip}>
        <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
        {/* What happened first, then mpv's own reason (often a bare "HTTP 404" or "loading failed"); the hover says what to do. */}
        <span className="min-w-0 flex-1 truncate" title={`${view.title}. ${view.hint}${error ? `\n${error}` : ''}`}>
          <span className="font-medium">{view.title}</span>
          <span data-testid="mpv-error-detail" className="ms-2 text-white/70">
            {compact ? '' : (error ?? view.hint)}
          </span>
        </span>
        <button
          ref={retryRef}
          type="button"
          data-ctl="retry"
          onClick={retry}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {t('retry')}
        </button>
        {!compact && (
          <button
            type="button"
            onClick={() => usePlayerStore.setState({ mode: 'inline', status: 'loading', error: undefined })}
            className="shrink-0 rounded-md border border-white/25 px-2.5 py-1 text-xs hover:bg-white/10"
          >
            {t('useBuiltInPlayer')}
          </button>
        )}
      </div>
    );
  }
  if (ended) {
    return (
      <div role="status" data-mpv-reserved="" className={strip}>
        <span className="min-w-0 flex-1 truncate text-white/70">{t('playbackFinished')}</span>
        <button
          type="button"
          onClick={replay}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {t('replay')}
        </button>
      </div>
    );
  }
  // Also right after Retry, while mpv still reports the failed load as loaded.
  if (mpv?.attached && status === 'loading') {
    return (
      <div role="status" aria-live="polite" data-mpv-reserved="" className={cn(strip, 'text-white/70')}>
        {t('mpvLoading')}
      </div>
    );
  }
  // Docked: a strip like the loading one. Fullscreen and PiP show it in the bar readout instead.
  if (buffering && !overlay) {
    return (
      <div role="status" aria-live="polite" data-mpv-reserved="" className={strip}>
        <BufferingLabel />
      </div>
    );
  }
  return null;
}

/** Loading indicator: a slowly sweeping dial arc, still under reduced motion. */
function Tuning({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" role="status" aria-label={label}>
      <svg viewBox="0 0 48 48" className="size-12 text-accent motion-safe:animate-spin" style={{ animationDuration: '1.4s' }} aria-hidden>
        <circle cx="24" cy="24" r="20" fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth="3" />
        <path d="M24 4 a20 20 0 0 1 20 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/**
 * Embedded mpv with its chrome. Docked: the native window on top, every bit of DOM chrome
 * in reserved strips below it. Fullscreen and picture-in-picture: the video fills the screen
 * (or the shrunken window) and the notices and controls float over its bottom edge (cut out
 * of the native window as holes by `measureMpvLayout`). They hide after a few seconds and
 * come back only when the mouse moves over the video or a key is pressed, staying while the
 * pointer is on the bar, a menu is open, or playback is not running. The surface stays the
 * first child in every layout, so switching never remounts it (that would restart mpv).
 */
function MpvPlayer({ compact }: { compact: boolean }) {
  const { t } = useTranslation('player');
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const status = usePlayerStore((s) => s.status);
  const title = usePlayerStore((s) => s.source?.title);
  const pip = usePipStore((s) => s.active);
  const [idle, setIdle] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [onBar, setOnBar] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const overlay = (isFullscreen || pip) && !compact;
  const small = compact || pip;
  const focusPin = useKeyboardFocusPin();
  const buffering = useMpvBuffering();
  /** Whether focus was last inside the player, and on which control (`data-ctl`). */
  const focusInside = useRef(false);
  const lastCtl = useRef<string | null>(null);

  const poke = useCallback((): void => {
    setIdle(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIdle(true), HIDE_AFTER_MS);
  }, []);

  // The native window swallows mouse moves over the video, so the cursor is polled instead;
  // only movement inside the player counts (not on another monitor or over another app).
  useEffect(() => {
    if (!overlay) return;
    poke();
    let last: string | undefined;
    let stopped = false;
    const id = setInterval(() => {
      void cursorInViewport().then((p) => {
        const root = rootRef.current;
        if (stopped || !p || !root) return;
        const key = `${p.x},${p.y}`;
        const moved = last !== undefined && key !== last;
        last = key;
        if (!moved) return;
        const r = root.getBoundingClientRect();
        if (p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom) poke();
      });
    }, CURSOR_POLL_MS);
    window.addEventListener('keydown', poke);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener('keydown', poke);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [overlay, poke]);

  // A stall keeps the chrome up, like a pause: its readout is the only sign of it over the video.
  const chromeShown = !overlay || !idle || onBar || menuOpen || focusPin.pinned || buffering || status !== 'playing';

  // Switching between docked, fullscreen and PiP layouts re-renders the chrome, and hiding it
  // unmounts it: a focused control disappears and focus falls to <body>. Put it back on the
  // same control when it still exists, else on the player itself, so keys keep working.
  const layoutKey = `${overlay}|${pip}|${chromeShown}`;
  const prevLayout = useRef(layoutKey);
  useEffect(() => {
    if (prevLayout.current === layoutKey) return;
    const layoutChanged = prevLayout.current.split('|').slice(0, 2).join('|') !== layoutKey.split('|').slice(0, 2).join('|');
    prevLayout.current = layoutKey;
    const root = rootRef.current;
    if (!root || !focusIsLost() || (!focusInside.current && !layoutChanged)) return;
    const ctl = lastCtl.current ? root.querySelector<HTMLElement>(`[data-ctl="${lastCtl.current}"]`) : null;
    (ctl ?? root).focus({ preventScroll: true });
  }, [layoutKey]);
  const barEvents = {
    onPointerEnter: () => setOnBar(true),
    onPointerLeave: () => {
      setOnBar(false);
      poke();
    },
    onPointerMove: poke,
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="mpv-player"
      className={cn('h-full w-full bg-black outline-none', overlay ? 'relative' : 'flex flex-col')}
      onFocus={(e) => {
        focusInside.current = true;
        if (e.target !== e.currentTarget) lastCtl.current = e.target.closest('[data-ctl]')?.getAttribute('data-ctl') ?? null;
        focusPin.onFocus(e);
      }}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !e.currentTarget.contains(to)) focusInside.current = false;
        focusPin.onBlur(e);
      }}
    >
      <MpvSurface className={overlay ? 'absolute! inset-0' : 'min-h-0 flex-1'} />
      {overlay ? (
        chromeShown && (
          <>
            {pip && (
              // Borderless window: this strip moves it, and holds the way back to the full app.
              <div
                data-mpv-reserved=""
                data-tauri-drag-region=""
                data-testid="pip-bar"
                className="absolute inset-x-0 top-0 z-10 flex h-9 items-center gap-0.5 bg-[#070b12] ps-3 pe-1 text-white"
                {...barEvents}
              >
                {/* The PiP bar has no room for a readout of its own: volume and seek feedback replace the title briefly. */}
                <BarReadout
                  dragRegion
                  className="me-0 flex-1 text-xs font-medium"
                  fallback={
                    buffering ? (
                      <BufferingLabel />
                    ) : (
                      <span data-tauri-drag-region="" title={title}>
                        {title}
                      </span>
                    )
                  }
                />
                <CtlButton id="pip-exit" shortcut="exitPip" label={t('exitPip')} onClick={() => void exitPip()} className="size-8 [&_svg]:size-4">
                  <PictureInPicture2 />
                </CtlButton>
                <CtlButton
                  id="pip-close"
                  label={t('close')}
                  onClick={() => {
                    usePlayerStore.getState().stop();
                    void exitPip();
                  }}
                  className="size-8 [&_svg]:size-4"
                >
                  <X />
                </CtlButton>
              </div>
            )}
            <div data-testid="mpv-overlay-chrome" className="absolute inset-x-0 bottom-0 z-10" {...barEvents}>
              <MpvNotices compact={small} overlay />
              <Controls
                variant="dock"
                visible
                compact={small}
                onMenuOpenChange={setMenuOpen}
                readoutIdle={buffering ? <BufferingLabel /> : undefined}
              />
            </div>
          </>
        )
      ) : (
        <>
          <MpvNotices compact={compact} />
          <Controls variant="dock" visible compact={compact} onMenuOpenChange={setMenuOpen} />
        </>
      )}
    </div>
  );
}

export interface PlayerSurfaceProps {
  compact: boolean;
  channelPanelAvailable: boolean;
}

/** Everything inside the dock's host node: the media surface for the current mode plus its chrome. */
export function PlayerSurface({ compact, channelPanelAvailable }: PlayerSurfaceProps) {
  const { t } = useTranslation('player');
  const mode = usePlayerStore((s) => s.mode);
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const waiting = useMediaStore((s) => s.waiting);
  const panelOpen = useMediaStore((s) => s.channelPanelOpen);
  const [idle, setIdle] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [onBar, setOnBar] = useState(false);
  const focusPin = useKeyboardFocusPin();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClick = useRef<{ at: number; wasPaused: boolean } | null>(null);
  /** A click on an ended item: the replay waits out the double-click time (C6). */
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const playing = status === 'playing';
  const chromeVisible = !idle || !playing || menuOpen || focusPin.pinned || onBar || panelOpen;

  const poke = (): void => {
    setIdle(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIdle(true), HIDE_AFTER_MS);
  };

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (replayTimer.current) clearTimeout(replayTimer.current);
      replayTimer.current = null;
    };
  }, [source?.url]);

  // Expose the idle state for cursor hiding in fullscreen (player.css).
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>('[data-player-host]');
    if (host) host.dataset['idle'] = String(!chromeVisible);
  }, [chromeVisible]);

  // Resume notice for VOD.
  const resumedFrom = source?.resumeSeconds;
  useEffect(() => {
    if (resumedFrom && resumedFrom > MIN_RESUME_SECONDS && !compact) {
      showOsd(t('resumedAt', { time: formatTime(resumedFrom) }));
    }
    // Only when a new item starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.url]);

  if (!source) return null;

  if (mode === 'radio') {
    return (
      <div className="relative h-full w-full bg-[#070b12]">
        <RadioPlayer variant={compact ? 'bar' : 'stage'} />
        <InlinePlayer as="audio" className="pointer-events-none absolute! inset-0 bg-transparent!" />
      </div>
    );
  }

  if (mode === 'embedded-mpv') {
    return <MpvPlayer compact={compact} />;
  }

  if (mode === 'external') return null;

  // A click toggles pause at once; the double click that follows puts the play state back and
  // toggles fullscreen (C6). Waiting out the double-click time instead made clicks feel slow,
  // and any wait shorter than the system's (500 ms on Windows) both paused and went fullscreen.
  const onSurfaceClick = (e: MouseEvent): void => {
    if (e.detail > 1) return;
    const st = usePlayerStore.getState();
    if (selectEnded(st)) {
      // Replaying cannot be undone (it seeks to 0 and drops Up next), so it waits until the
      // click is known not to start a double click.
      lastClick.current = null;
      if (replayTimer.current) clearTimeout(replayTimer.current);
      const src = st.source;
      replayTimer.current = setTimeout(() => {
        replayTimer.current = null;
        const now = usePlayerStore.getState();
        if (now.source === src && selectEnded(now)) now.togglePlay();
      }, DOUBLE_CLICK_MS);
      return;
    }
    lastClick.current = { at: Date.now(), wasPaused: st.status !== 'playing' && st.status !== 'loading' };
    st.togglePlay();
  };
  const onSurfaceDouble = (): void => {
    if (replayTimer.current) clearTimeout(replayTimer.current);
    replayTimer.current = null;
    const lc = lastClick.current;
    lastClick.current = null;
    if (lc && Date.now() - lc.at < DOUBLE_CLICK_MS) setPaused(lc.wasPaused);
    usePlayerStore.getState().toggleFullscreen();
  };

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full overflow-hidden bg-black select-none"
      onPointerMove={poke}
      onPointerDown={poke}
      onFocus={(e) => {
        focusPin.onFocus(e);
        poke();
      }}
      onBlur={focusPin.onBlur}
      onPointerLeave={() => {
        setOnBar(false);
        if (playing) setIdle(true);
      }}
    >
      <InlinePlayer as="video" compact={compact} />
      {/* Click surface sits above the video so clicks never reach native controls. */}
      <div className="absolute inset-0 z-[5]" onClick={onSurfaceClick} onDoubleClick={onSurfaceDouble} aria-hidden />
      {(status === 'loading' || (waiting && playing)) && <Tuning label={status === 'loading' ? t('loading') : t('buffering')} />}

      {!compact && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/75 to-transparent px-4 pt-3 pb-10 text-white motion-safe:transition-opacity motion-safe:duration-200',
            !chromeVisible && 'opacity-0',
          )}
        >
          <div className="flex items-center gap-2">
            {source.isLive && (
              <span className="inline-flex items-center gap-1 rounded-sm bg-live px-1.5 py-px font-display text-[11px] font-semibold text-white dark:text-bg">
                {t('live')}
              </span>
            )}
            <h2 className="truncate font-display text-base sm:text-lg">{source.title}</h2>
          </div>
          {source.subtitle && <p className="truncate text-sm text-white/70">{source.subtitle}</p>}
        </div>
      )}

      <Osd />
      <EndedOverlay compact={compact} />
      <UpNextCard compact={compact} />

      <div
        data-testid="overlay-chrome"
        className="absolute inset-x-0 bottom-0 z-20"
        // Resting the pointer on the bar (volume slider, time, a held scrub) keeps it up.
        onPointerEnter={() => setOnBar(true)}
        onPointerLeave={() => setOnBar(false)}
      >
        <Controls variant="overlay" visible={chromeVisible} compact={compact} onMenuOpenChange={setMenuOpen} />
      </div>

      <FullscreenChannelPanel available={channelPanelAvailable && isFullscreen && !compact} />
    </div>
  );
}
