import { AlertTriangle, ChevronRight, Lock, PictureInPicture2, Play, RotateCcw, RotateCw, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { cursorInViewport } from '@/api/window';
import { intlLocale } from '@/lib/intl';

import { cn } from '../cn';
import { bindInputModality, focusFromPointer, focusIfPlayerOwnsFocus, focusIsLost, formatTime, pressKeepsFocus, SEEK_STEP_JL } from '../format';
import { showOsd, UP_NEXT_SECONDS, useMediaStore } from '../media';
import { consumeMenuDismiss } from '../menuDismiss';
import { exitPip, usePipStore } from '../pip';
import {
  cancelUpNext,
  DOUBLE_CLICK_MS,
  MIN_RESUME_SECONDS,
  playUpNextNow,
  replay,
  selectEnded,
  setPaused,
  usePlayerStore,
} from '../store';
import { useStreamInfoStore } from '../streamInfo';
import { hideZapBanner } from '../zapBanner';
import { useRetryWhenOnline, useStreamError } from '../useStreamError';
import { BarReadout, Controls, CtlButton, InlineSpinner, retryPlayback } from './Controls';
import { ErrorActions } from './ErrorActions';
import { glassButton } from './glassButton';
import { InlinePlayer } from './InlinePlayer';
import { FullscreenChannelPanel, LiveProgrammeLine, RadioPlayer, SleepPrompt, StreamInfoPanel, TitleLogo, VideoContextMenu, ZapBanner } from './lazyParts';
import { MpvSurface } from './MpvSurface';
import { ReconnectNotice, useReconnectLabel } from './ReconnectNotice';
import { SHORT_PLAYER_PX, useNarrow, useSmallPlayer } from './useNarrow';
import { useZapBannerShown, useZapHover } from './zapHooks';

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

/** Space between the zap banner and a readout moved below it, px. */
const OSD_BANNER_GAP = 8;

/**
 * The readout's top (px in the surface) while the zap banner sits over its column, else
 * undefined (its usual place). Both use the surface's top corners, and in a small player the
 * banner spans the width. Follows the banner as it mounts (a lazy part) and as it or the
 * surface resizes. Layout boxes, not client rects: both pop in with a transform.
 */
function useTopClearOfZapBanner(ref: RefObject<HTMLElement | null>): number | undefined {
  // The unmute prompt (`data-osd-clear`) sits in the readout's corner too while it is up.
  const bannerShown = useZapBannerShown();
  const promptShown = useUnmutePromptShown();
  const shown = bannerShown || promptShown;
  const [top, setTop] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!shown || !el || !host) {
      setTop(undefined);
      return;
    }
    let watched: HTMLElement[] = [];
    const measure = (): void => {
      const above = Array.from(host.querySelectorAll<HTMLElement>('[data-zap-banner], [data-osd-clear]'));
      for (const w of watched) if (!above.includes(w)) resizes?.unobserve(w);
      for (const a of above) if (!watched.includes(a)) resizes?.observe(a);
      watched = above;
      // Only the readout's top moves, so its sides tell whether the two share a column.
      let clear: number | undefined;
      for (const banner of above) {
        const crosses = el.offsetLeft < banner.offsetLeft + banner.offsetWidth && banner.offsetLeft < el.offsetLeft + el.offsetWidth;
        if (crosses) clear = Math.max(clear ?? 0, banner.offsetTop + banner.offsetHeight + OSD_BANNER_GAP);
      }
      setTop(clear);
    };
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resizes?.observe(host);
    const mounts = new MutationObserver(measure);
    mounts.observe(host, { childList: true });
    measure();
    return () => {
      mounts.disconnect();
      resizes?.disconnect();
    };
  }, [ref, shown]);
  return top;
}

/** Big tuner readout after a zap or volume change. */
function Osd() {
  const osd = useMediaStore((s) => s.osd);
  if (!osd) return null;
  return <OsdReadout key={osd.key} primary={osd.primary} secondary={osd.secondary} locked={!!osd.locked} />;
}

/** `locked`: a zap passing a channel parental controls lock; a lock stands before its number. */
function OsdReadout({ primary, secondary, locked = false }: { primary: string; secondary?: string | undefined; locked?: boolean }) {
  const { t } = useTranslation('player');
  const ref = useRef<HTMLDivElement>(null);
  const digits = /^\d+$/.test(primary);
  const top = useTopClearOfZapBanner(ref);
  return (
    <div
      ref={ref}
      aria-live="polite"
      // Within the player, whatever its size: long lines (file names, reasons) wrap, never clip.
      className="player-osd player-chrome pointer-events-none absolute top-5 end-6 z-20 max-w-[min(40rem,calc(100%-3rem))] text-end [overflow-wrap:anywhere] [text-shadow:0_2px_12px_rgb(0_0_0/0.8)]"
      style={top === undefined ? undefined : { top }}
    >
      <div
        className={cn(
          'font-numeric leading-none tabular-nums',
          digits ? 'text-6xl text-accent-hover' : 'text-2xl',
          locked && 'flex items-center justify-end gap-3',
        )}
      >
        {locked && (
          <span data-testid="osd-locked" className="contents">
            <Lock aria-hidden className={cn('shrink-0', digits ? 'size-9' : 'size-5')} strokeWidth={2.25} />
            <span className="sr-only">{t('zapLocked')}</span>
          </span>
        )}
        {primary}
      </div>
      {secondary && <div className="mt-1 line-clamp-2 text-title-sm">{secondary}</div>}
    </div>
  );
}

/**
 * "Next episode" card with a 10 s countdown; Play now or Cancel.
 * `strip` lays it out in flow (embedded mpv: nothing may float over the native window).
 */
function UpNextCard({ variant = 'overlay', compact = false, short = false }: { variant?: 'overlay' | 'strip'; compact?: boolean; short?: boolean }) {
  const { t } = useTranslation('player');
  const upNext = useMediaStore((s) => s.upNext);
  // Clear of the bar, which is taller in fullscreen.
  const fullscreen = usePlayerStore((s) => s.isFullscreen);
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
  // An episode's own line ("S01E02 · Low Tide") leads, the series name follows as a quieter one.
  const episode = upNext.source.subtitle;
  const series = episode ? upNext.source.title : undefined;
  const lead = episode ?? upNext.source.title;
  const name = series ? `${lead} · ${series}` : lead;
  // The mini player is too narrow for the card: a bar across its bottom edge instead. A short
  // player (a phone's 16:9) has no height for it above the bar: the strip's one line, across the top.
  const tight = compact && variant === 'overlay';
  const topStrip = short && !compact && variant === 'overlay';
  const inline = variant === 'strip' || topStrip;
  return (
    <div
      role="status"
      data-mpv-reserved=""
      data-testid="up-next"
      aria-label={t('nextEpisode')}
      className={cn(
        'player-glass-strong overflow-hidden text-on-glass',
        tight
          ? 'absolute inset-x-0 bottom-0 z-30 border-t'
          : topStrip
            ? 'absolute inset-x-0 top-0 z-30 border-b motion-safe:animate-fade-in'
            : variant === 'overlay'
              ? cn(
                  'player-glass-edge glass-blur absolute z-30 w-72 max-w-[calc(100%-2rem)] rounded-lg border motion-safe:animate-pop-in',
                  fullscreen ? 'end-10 bottom-44' : 'end-4 bottom-28',
                )
              : 'shrink-0 border-t',
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
      <div className={variant === 'overlay' && !tight && !topStrip ? 'p-3.5' : 'flex items-center gap-3 px-3 py-2'}>
        <div className="min-w-0 flex-1">
          <p className="text-caption text-on-glass-muted tabular-nums">{t('nextEpisodeIn', { count: left })}</p>
          {!tight && !inline && (
            <>
              <p data-testid="up-next-title" className="mt-1 truncate text-body font-medium" title={name}>
                {lead}
              </p>
              {series && (
                <p data-testid="up-next-series" className="player-on-glass-muted truncate text-body-sm">
                  {series}
                </p>
              )}
            </>
          )}
          {inline && (
            <p className="mt-0.5 truncate" title={name}>
              <span data-testid="up-next-title" className="text-body-sm font-medium">
                {lead}
              </span>
              {series && (
                <span data-testid="up-next-series" className="player-on-glass-muted ms-2 text-body-sm">
                  {series}
                </span>
              )}
            </p>
          )}
        </div>
        <div className={cn('flex shrink-0 gap-2', !tight && !inline && 'mt-3')}>
          <button
            ref={playNowRef}
            type="button"
            onClick={playUpNextNow}
            title={tight ? name : undefined}
            className={glassButton('primary', tight || inline ? 'xs' : 'sm')}
          >
            <Play className="fill-current" aria-hidden />
            {t('playNow')}
          </button>
          <button type="button" onClick={cancelUpNext} className={glassButton('ghost', tight || inline ? 'xs' : 'sm')}>
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Over the DOM video once a VOD item finished: one big replay button (the controls stay usable).
 * Under the title bar, and centred in the room above the control bar; a short player (a phone's
 * 16:9) gets the small disc without its label, which the bar's own Replay already names.
 */
function EndedOverlay({ compact, short = false }: { compact: boolean; short?: boolean }) {
  const { t } = useTranslation('player');
  const ended = usePlayerStore(selectEnded);
  const upNext = useMediaStore((s) => s.upNext);
  const fullscreen = usePlayerStore((s) => s.isFullscreen);
  if (!ended || upNext) return null;
  const small = compact || short;
  return (
    <div
      data-testid="ended-overlay"
      className={cn(
        'absolute inset-0 z-[8] flex items-center justify-center bg-black/55 motion-safe:animate-fade-in',
        compact ? 'pb-8' : short ? 'pb-12' : fullscreen ? 'pb-36' : 'pb-20',
      )}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={replay}
        aria-label={t('replay')}
        className="player-chrome group flex flex-col items-center gap-2 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-glass-strong ring-1 ring-white/20 group-hover:bg-accent-solid group-hover:text-accent-solid-fg group-hover:ring-transparent group-active:bg-accent-solid-pressed motion-safe:transition-colors',
            small ? 'size-11' : fullscreen ? 'size-20' : 'size-16',
          )}
        >
          <RotateCcw className={small ? 'size-5' : fullscreen ? 'size-9' : 'size-7'} aria-hidden />
        </span>
        {!small && <span className="text-body-sm font-medium [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">{t('replay')}</span>}
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
    <span data-testid="mpv-buffering" className="inline-flex items-center gap-1.5 text-on-glass-muted">
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
  const source = usePlayerStore((s) => s.source);
  const ended = usePlayerStore(selectEnded);
  const upNext = useMediaStore((s) => s.upNext);
  const mpv = useMediaStore((s) => s.mpv);
  const retryRef = useRef<HTMLButtonElement>(null);
  const buffering = useMpvBuffering();
  const reconnecting = useReconnectLabel(); // failover:
  const isError = status === 'error';
  const view = useStreamError(null);
  useRetryWhenOnline(isError ? view.cls : 'generic', retryPlayback);
  useEffect(() => {
    if (isError) focusIfPlayerOwnsFocus(retryRef.current);
  }, [isError]);

  if (upNext && status !== 'error') return <UpNextCard variant="strip" />;

  const strip = 'player-glass-strong flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-body-sm text-on-glass';
  if (status === 'error') {
    return (
      <div role="alert" data-mpv-reserved="" data-error-class={view.cls} className={cn(strip, 'flex-wrap')}>
        <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
        {/* What happened and what to do first; the hover also has mpv's own reason. */}
        <span className="min-w-0 flex-1 truncate" title={`${view.title}. ${view.hint}${error ? `\n${error}` : ''}`}>
          <span className="font-medium">{view.title}</span>
          {!compact && <span className="ms-2 text-on-glass-muted">{view.hint}</span>}
        </span>
        {!compact && error && (
          // mpv's own reason (often a bare "HTTP 404" or "loading failed"), as InlinePlayer's
          // overlay keeps it: closed until asked for, then on a row of its own under the strip.
          <details className="group shrink-0 text-caption text-on-glass-muted open:order-last open:basis-full">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm select-none hover:text-on-glass focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform rtl:-scale-x-100 ltr:group-open:rotate-90 rtl:group-open:-rotate-90 motion-reduce:transition-none" aria-hidden />
              {t('errorDetails')}
            </summary>
            <p data-testid="mpv-error-detail" className="mt-1 ps-4.5 pb-0.5 font-mono break-all select-all">
              {error}
            </p>
          </details>
        )}
        <ErrorActions
          view={view}
          source={source}
          onRetry={retryPlayback}
          size="xs"
          max={compact ? 1 : 2}
          primaryRef={retryRef}
          className="flex shrink-0 flex-wrap items-center gap-2"
        >
          {!compact && (
            <button
              type="button"
              onClick={() => usePlayerStore.setState({ mode: 'inline', status: 'loading', error: undefined })}
              className={glassButton('secondary', 'xs')}
            >
              {t('useBuiltInPlayer')}
            </button>
          )}
        </ErrorActions>
      </div>
    );
  }
  if (ended) {
    return (
      <div role="status" data-mpv-reserved="" className={strip}>
        <span className="min-w-0 flex-1 truncate text-on-glass-muted">{t('playbackFinished')}</span>
        <button type="button" onClick={replay} className={glassButton('primary', 'xs')}>
          <RotateCcw aria-hidden />
          {t('replay')}
        </button>
      </div>
    );
  }
  // failover: smart reconnect / failover progress replaces the plain loading line.
  if (reconnecting && status === 'loading') {
    return (
      <div role="status" aria-live="polite" data-mpv-reserved="" data-testid="reconnect-notice" className={cn(strip, 'text-on-glass-muted')}>
        <InlineSpinner />
        <span className="min-w-0 truncate">{reconnecting}</span>
      </div>
    );
  }
  // Also right after Retry, while mpv still reports the failed load as loaded.
  if (mpv?.attached && status === 'loading') {
    return (
      <div role="status" aria-live="polite" data-mpv-reserved="" className={cn(strip, 'text-on-glass-muted')}>
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  }, []);
  const smallPlayer = useSmallPlayer(rootEl);
  const overlay = (isFullscreen || pip) && !compact;
  const small = compact || pip;
  const focusPin = useKeyboardFocusPin();
  const buffering = useMpvBuffering();
  /** Whether focus was last inside the player, and on which control (`data-ctl`). */
  const focusInside = useRef(false);
  const lastCtl = useRef<string | null>(null);
  const statsOpen = useStreamInfoStore((x) => x.open);

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
  // The PiP bar's title, while it is drawn (hiding it sends no pointerleave).
  const titleHover = useZapHover(overlay && pip && chromeShown && !buffering);

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
    // After a pointer press the player itself takes it, never the control last used from the
    // keyboard: the next Space must be play/pause (PL-SPACE-CLICKED-CONTROL).
    const ctl = lastCtl.current && !focusFromPointer() ? root.querySelector<HTMLElement>(`[data-ctl="${lastCtl.current}"]`) : null;
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
      ref={setRoot}
      tabIndex={-1}
      data-testid="mpv-player"
      data-player-focus=""
      className={cn('relative h-full w-full bg-black outline-none', !overlay && 'flex flex-col')}
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
      {/* Over the video; cut out of the native window while open. Below the PiP bar in PiP. */}
      <StreamInfoPanel className={cn(pip ? 'start-2 top-11 max-h-[calc(100%-3.5rem)]' : 'start-3 top-3 max-h-[calc(100%-5rem)]', small && 'w-56')} />
      {/*
        Zap banner (C5): over the picture's top corner, cut out of the native video while up. The
        mini player says it in its header instead; a small player gets the one-line chip.
      */}
      {!compact && (
        <ZapBanner
          compact={pip}
          chip={smallPlayer && !pip}
          className={pip ? 'inset-x-2 top-11' : smallPlayer ? 'inset-x-2 top-2' : cn('top-3 sm:top-4', statsOpen ? 'end-3 sm:end-4' : 'start-3 sm:start-4')}
        />
      )}
      {/* Sleep timer's last-minute prompt where toasts cannot be seen (fullscreen, PiP). */}
      {overlay && <SleepPrompt small={small} className={pip ? 'bottom-14' : 'bottom-28'} />}
      {overlay ? (
        chromeShown && (
          <>
            {pip && (
              // Borderless window: this strip moves it, and holds the way back to the full app.
              <div
                data-mpv-reserved=""
                data-tauri-drag-region=""
                data-testid="pip-bar"
                className="player-glass-strong absolute inset-x-0 top-0 z-10 flex h-10 items-center gap-0.5 border-b ps-3 pe-1"
                {...barEvents}
              >
                {/* The PiP bar has no room for a readout of its own: volume and seek feedback replace the title briefly. */}
                <BarReadout
                  dragRegion
                  className="me-0 flex-1 font-sans text-caption font-medium"
                  fallback={
                    buffering ? (
                      <BufferingLabel />
                    ) : (
                      <span data-tauri-drag-region="" title={title} {...titleHover}>
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

/** The unmute prompt is up: the browser muted a start it would not allow with sound. */
function useUnmutePromptShown(): boolean {
  const autoMuted = useMediaStore((s) => !!s.autoMuted);
  const muted = usePlayerStore((s) => s.muted);
  return autoMuted && muted;
}

/**
 * "Tap to unmute" (PL-MUTED-AUTOPLAY). A browser that refuses sound without a gesture (a reload
 * restoring playback, a reopened app) gets the stream started muted instead of paused; the bar
 * hides after a few seconds, so moving pictures with no sound and no reason were all there was.
 * The one call to action over the picture until sound is back; any volume change clears it.
 */
function UnmutePrompt({ compact }: { compact: boolean }) {
  const { t } = useTranslation('player');
  const shown = useUnmutePromptShown();
  if (!shown) return null;
  return (
    <button
      type="button"
      data-testid="unmute-prompt"
      // The readout (OSD) moves below this while both are up.
      data-osd-clear=""
      onMouseDown={pressKeepsFocus}
      onClick={(e) => {
        e.stopPropagation();
        usePlayerStore.getState().toggleMute();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        'absolute z-[25] inline-flex items-center rounded-full bg-accent-solid font-medium text-accent-solid-fg shadow-2 hover:bg-accent-solid-hover active:bg-accent-solid-pressed motion-safe:animate-pop-in',
        compact ? 'end-2 top-2 gap-1.5 px-2.5 py-1 text-caption' : 'end-3 top-3 gap-2 px-3.5 py-2 text-body-sm sm:end-4 sm:top-4 pointer-coarse:min-h-11',
      )}
    >
      <VolumeX aria-hidden className={compact ? 'size-3.5' : 'size-4'} />
      {/* The words for the pointer in use; the hidden one is not part of the name. */}
      <span className="pointer-coarse:hidden">{t('clickToUnmute')}</span>
      <span className="hidden pointer-coarse:inline">{t('tapToUnmute')}</span>
    </button>
  );
}

/** Taps further apart than this are not a double tap (touch only; the mouse has dblclick). */
export const DOUBLE_TAP_MS = 300;

/** The side of the picture a tap landed on: -1 the left third, 1 the right third, 0 the middle (RTL as drawn). */
function tapSide(e: MouseEvent, el: HTMLElement | null): -1 | 0 | 1 {
  const r = el?.getBoundingClientRect();
  if (!r || r.width <= 0) return 0;
  const x = (e.clientX - r.left) / r.width;
  return x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0;
}

/** The picture can be stepped 10 s: VOD with a length, or live inside a rewind window. */
function canTapSeek(): boolean {
  const { source, durationSeconds } = usePlayerStore.getState();
  if (!source || source.isRadio) return false;
  if (!source.isLive) return !!durationSeconds;
  const w = useMediaStore.getState().seekable;
  return !!w && w.end - w.start >= 30;
}

/**
 * Where a double tap seeked: a soft half-disc on that side with the seconds it moved, gone after
 * a moment (YouTube's ripple). Still under reduced motion: it only fades.
 */
function TapSeekRipple({ side, seconds, onDone }: { side: -1 | 1; seconds: number; onDone(): void }) {
  const { i18n } = useTranslation('player');
  useEffect(() => {
    const id = setTimeout(onDone, 650);
    return () => clearTimeout(id);
  }, [onDone]);
  const amount = new Intl.NumberFormat(intlLocale(i18n.language), { style: 'unit', unit: 'second', unitDisplay: 'short' }).format(seconds);
  const Icon = side < 0 ? RotateCcw : RotateCw;
  return (
    <div
      aria-hidden
      data-testid="tap-seek"
      data-side={side < 0 ? 'back' : 'forward'}
      className={cn(
        'pointer-events-none absolute inset-y-0 z-[6] flex w-1/3 items-center justify-center bg-white/10 motion-safe:animate-fade-in',
        side < 0 ? 'left-0 rounded-r-[50%]' : 'right-0 rounded-l-[50%]',
      )}
    >
      <span className="player-chrome flex flex-col items-center gap-1 font-numeric text-body-sm tabular-nums [text-shadow:0_1px_3px_rgb(0_0_0/0.7)]">
        <Icon className="size-6" />
        {side < 0 ? `−${amount}` : `+${amount}`}
      </span>
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
  const statsOpen = useStreamInfoStore((s) => s.open);
  const pip = usePipStore((s) => s.active);
  const zapShown = useZapBannerShown();
  const [idle, setIdle] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [onBar, setOnBar] = useState(false);
  /** The video's own right-click menu (PL-NATIVE-CONTEXT-MENU), where it was opened. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);
  const focusPin = useKeyboardFocusPin();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClick = useRef<{ at: number; wasPaused: boolean } | null>(null);
  /** The press behind the coming click was a touch: whether the chrome showed before it. */
  const touchPress = useRef<{ chromeWasVisible: boolean } | null>(null);
  /** The last touch tap, for a double tap on the left or right third (PL-TOUCH-ERGONOMICS). */
  const lastTap = useRef<{ at: number; side: -1 | 0 | 1; chromeWasVisible: boolean } | null>(null);
  const [ripple, setRipple] = useState<{ side: -1 | 1; seconds: number; key: number } | null>(null);
  const endRipple = useCallback(() => setRipple(null), []);
  /** Until then a dblclick only ends what its clicks did (a menu closed, a double tap seeked): no fullscreen. */
  const swallowDoubleUntil = useRef(0);
  /** A click on an ended item: the replay waits out the double-click time (C6). */
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  }, []);
  const smallPlayer = useSmallPlayer(rootEl);
  /** Short (any width): a stream error packs into the room the bar leaves, over the title. */
  const shortPlayer = useNarrow(rootEl, Number.POSITIVE_INFINITY, SHORT_PLAYER_PX);
  const shortError = shortPlayer && !compact && status === 'error';
  const endedNow = usePlayerStore(selectEnded);
  const upNextShown = useMediaStore((s) => !!s.upNext);

  const playing = status === 'playing';
  // A small player has no room for both the zap chip and the bar: after a zap the chip shows alone
  // (unless the bar is in use, or playback paused or ended), the new channel's tuning included.
  // The bar comes back when the chip goes, the stream fails, or the pointer moves over the
  // picture, which takes the chip down (see `onPointerActivity`).
  const zapChip = smallPlayer && !compact && !pip && zapShown;
  const inUse = menuOpen || focusPin.pinned || onBar || panelOpen;
  const chromeVisible = inUse || (zapChip ? !playing && status !== 'loading' : !idle || !playing);
  // The title takes the pointer only while the chrome shows it.
  const titleHover = useZapHover(chromeVisible);

  const poke = (): void => {
    setIdle(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIdle(true), HIDE_AFTER_MS);
  };
  /**
   * The pointer moved or pressed over the player: the bar comes back. While the zap chip holds it
   * down, the chip steps aside for it (the title above the bar names the channel), unless the
   * pointer is on the chip itself, which keeps it up.
   */
  const onPointerActivity = (e: PointerEvent): void => {
    if (zapChip && !chromeVisible && !(e.target instanceof Element && e.target.closest('[data-zap-banner]'))) hideZapBanner();
    poke();
  };

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (replayTimer.current) clearTimeout(replayTimer.current);
      replayTimer.current = null;
    };
  }, [source?.url]);

  // A menu or the channel history opening takes the zap banner down: they share the picture's top
  // corners in a short stage, and the banner only repeats what the title bar says.
  useEffect(() => {
    if (menuOpen) hideZapBanner();
  }, [menuOpen]);

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
      <div className="player-stage-dark relative h-full w-full">
        <RadioPlayer variant={compact ? 'bar' : 'stage'} />
        <InlinePlayer as="audio" className="pointer-events-none absolute! inset-0 bg-transparent!" />
      </div>
    );
  }

  if (mode === 'embedded-mpv') {
    return <MpvPlayer compact={compact} />;
  }

  if (mode === 'external') return null;

  /**
   * A touch tap shows the controls (the next tap hides them) and never pauses: play and pause are
   * on the bar. A second tap on the left or right third within `DOUBLE_TAP_MS` steps 10 s back or
   * ahead instead, and puts the controls back as they were before the first one; more taps keep
   * stepping.
   */
  const onTouchTap = (e: MouseEvent, touch: { chromeWasVisible: boolean }): void => {
    lastClick.current = null;
    const now = Date.now();
    const side = tapSide(e, rootRef.current);
    const before = lastTap.current;
    if (side !== 0 && before && before.side === side && now - before.at < DOUBLE_TAP_MS && canTapSeek()) {
      lastTap.current = { ...before, at: now };
      swallowDoubleUntil.current = now + DOUBLE_CLICK_MS;
      usePlayerStore.getState().seekBy(side * SEEK_STEP_JL);
      setRipple((r) => ({ side, seconds: (r && r.side === side ? r.seconds : 0) + SEEK_STEP_JL, key: now }));
      if (!before.chromeWasVisible && playing) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setIdle(true);
      } else poke();
      return;
    }
    lastTap.current = { at: now, side, chromeWasVisible: touch.chromeWasVisible };
    // The second tap of a double tap in the middle: the dblclick that follows goes fullscreen.
    if (e.detail > 1) return;
    if (touch.chromeWasVisible && playing) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setIdle(true);
    } else poke();
  };

  // A click toggles pause at once; the double click that follows puts the play state back and
  // toggles fullscreen (C6). Waiting out the double-click time instead made clicks feel slow,
  // and any wait shorter than the system's (500 ms on Windows) both paused and went fullscreen.
  const onSurfaceClick = (e: MouseEvent): void => {
    const touch = touchPress.current;
    touchPress.current = null;
    // The press only closed a menu (PL-MENU-OUTSIDE-CLICK): nothing else happens, and the
    // double click it may start does not go fullscreen.
    if (consumeMenuDismiss(e.target)) {
      lastClick.current = null;
      lastTap.current = null;
      swallowDoubleUntil.current = Date.now() + DOUBLE_CLICK_MS;
      return;
    }
    if (touch) {
      onTouchTap(e, touch);
      return;
    }
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
    if (Date.now() < swallowDoubleUntil.current) return;
    if (replayTimer.current) clearTimeout(replayTimer.current);
    replayTimer.current = null;
    const lc = lastClick.current;
    lastClick.current = null;
    if (lc && Date.now() - lc.at < DOUBLE_CLICK_MS) setPaused(lc.wasPaused);
    usePlayerStore.getState().toggleFullscreen();
  };

  // The title bar fades with the chrome; the zap banner takes its corner while it is up (it says
  // all the title says), and a short player's stream error starts up there. A short player's end
  // of item (Up next across the top, the replay disc in the middle) has the height to itself too.
  const titleHidden = !chromeVisible || zapShown || shortError || (shortPlayer && (endedNow || upNextShown));
  const liveRef = source.isLive ? source.ref : undefined;

  return (
    <div
      ref={setRoot}
      // The player itself holds focus after a pointer press on a control (PL-SPACE-CLICKED-CONTROL):
      // a target with no role, so Space is play/pause there and the player's keys stay live.
      tabIndex={-1}
      data-player-focus=""
      className="relative h-full w-full overflow-hidden bg-black outline-none select-none"
      onPointerMove={onPointerActivity}
      onPointerDown={(e) => {
        // Read before the press brings the chrome up (onPointerActivity).
        touchPress.current = e.pointerType === 'touch' ? { chromeWasVisible: chromeVisible } : null;
        onPointerActivity(e);
      }}
      onFocus={(e) => {
        focusPin.onFocus(e);
        poke();
      }}
      onBlur={focusPin.onBlur}
      onPointerLeave={() => {
        setOnBar(false);
        if (playing) setIdle(true);
      }}
      // The player's own menu instead of the page's (Back, Reload, Save as), as embedded mpv has.
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      <InlinePlayer as="video" compact={compact} short={shortPlayer} />
      {/* Click surface sits above the video so clicks never reach native controls. */}
      <div className="absolute inset-0 z-[5]" onClick={onSurfaceClick} onDoubleClick={onSurfaceDouble} aria-hidden />
      {ripple && <TapSeekRipple key={ripple.key} side={ripple.side} seconds={ripple.seconds} onDone={endRipple} />}
      {(status === 'loading' || (waiting && playing)) && <Tuning label={status === 'loading' ? t('loading') : t('buffering')} />}
      {/* failover: smart reconnect / failover progress under the dial. */}
      <ReconnectNotice compact={compact} />

      {!compact && (
        <div
          data-testid="player-titlebar"
          className={cn(
            'player-chrome player-scrim-top pointer-events-none absolute inset-x-0 top-0 z-10 motion-safe:transition-opacity motion-safe:duration-(--duration-base)',
            // Fullscreen: further in from the edges and larger, like the bar.
            isFullscreen ? 'px-4 pt-4 pb-20 sm:px-10 sm:pt-8' : 'px-4 pt-3 pb-14 sm:px-5 sm:pt-4',
            titleHidden && 'opacity-0',
          )}
        >
          <div className={cn('flex min-w-0 items-center', isFullscreen ? 'gap-4' : 'gap-3')}>
            {/* The channel's logo where the LIVE pill was: the bar's badge is the one live mark (PL-DUPLICATE-CHROME). */}
            {liveRef && <TitleLogo channel={liveRef} posterUrl={source.posterUrl} big={isFullscreen} />}
            <div className="min-w-0 flex-1">
              {/*
                Hovering the channel title brings up the zap banner (live TV) and, like the bar,
                keeps the chrome up. It sits above the click layer, so it passes clicks on to it;
                hidden chrome lets the pointer through to the video.
              */}
              <h2
                data-testid="player-title"
                dir="auto"
                className={cn(
                  'w-fit max-w-full truncate [text-shadow:0_1px_3px_rgb(0_0_0/0.5)]',
                  isFullscreen ? 'text-title' : 'text-title-sm',
                  chromeVisible && 'pointer-events-auto',
                )}
                onClick={onSurfaceClick}
                onDoubleClick={onSurfaceDouble}
                onPointerEnter={() => {
                  setOnBar(true);
                  titleHover.onPointerEnter();
                }}
                onPointerLeave={() => {
                  setOnBar(false);
                  titleHover.onPointerLeave();
                }}
              >
                {source.title}
              </h2>
              {/* What airs now, kept current while the channel plays (PL-STALE-PROGRAMME); an episode's line for VOD. */}
              {liveRef ? (
                <LiveProgrammeLine channel={liveRef} fallback={source.subtitle} />
              ) : (
                source.subtitle && (
                  <p dir="auto" data-testid="player-subtitle" className="mt-0.5 truncate text-body-sm text-on-glass-muted">
                    {source.subtitle}
                  </p>
                )
              )}
            </div>
          </div>
        </div>
      )}

      <Osd />
      <UnmutePrompt compact={compact} />
      <StreamInfoPanel className={compact ? 'start-2 top-2 max-h-[calc(100%-4rem)] w-56' : 'start-4 top-16 max-h-[calc(100%-9rem)]'} />
      {/*
        Zap banner (C5): the title's corner, or the far one while the channel list or stream info
        holds it. The mini player says it in its header instead; a small player gets the
        one-line chip.
      */}
      {!compact && (
        <ZapBanner
          compact={pip}
          chip={smallPlayer && !pip}
          className={
            pip || smallPlayer ? 'inset-x-2 top-2' : cn('top-3 sm:top-4', panelOpen || statsOpen ? 'end-3 sm:end-4' : 'start-3 sm:start-4')
          }
        />
      )}
      {/* Sleep timer's last-minute prompt where toasts cannot be seen (fullscreen, PiP). */}
      {!compact && <SleepPrompt small={pip} className={pip ? 'bottom-16' : isFullscreen ? 'bottom-44' : 'bottom-32'} />}
      <EndedOverlay compact={compact} short={shortPlayer} />
      <UpNextCard compact={compact} short={shortPlayer} />

      <div
        data-testid="overlay-chrome"
        // Only the bar's pane takes the pointer (Controls): the scrim above it lets it through.
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
        // Resting the pointer on the bar (volume slider, time, a held scrub) keeps it up.
        onPointerEnter={() => setOnBar(true)}
        onPointerLeave={() => setOnBar(false)}
      >
        <Controls variant="overlay" visible={chromeVisible} compact={compact} onMenuOpenChange={setMenuOpen} />
      </div>

      <FullscreenChannelPanel available={channelPanelAvailable && isFullscreen && !compact} chromeVisible={chromeVisible} />
      {menuAt && <VideoContextMenu at={menuAt} onClose={closeMenu} />}
    </div>
  );
}
