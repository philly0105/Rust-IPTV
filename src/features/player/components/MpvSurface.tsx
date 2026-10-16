import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { isDesktop, rpc } from '@/api/transport';
import { itemKey, type Bounds, type MpvState, type MpvTrack, type PlayerSource } from '@/api/types';

import { useToast } from '@/ui/Toast';
import { cn } from '../cn';
import type { EngineTracks, TrackOption } from '../engines';
import { classifyStreamError, rpcErrorCode } from '../errors';
import { useAlternatesStore } from '../failover';
import { setMediaCommands, useMediaStore } from '../media';
import { bindMpvExtras, sendSubtitleStyle } from '../mpvExtras';
import { useStreamInfoStore } from '../streamInfo';
import { LAYOUT_WATCH_SELECTOR, measureMpvLayout, OVERLAY_SELECTOR } from '../mpvBounds';
import { aspectFromVideoParams, exitPip, refreshPipAspect, setPipAspectSource, togglePip, usePipStore } from '../pip';
import { tryAnotherSource, useReconnectStore } from '../reconnect';
import {
  DOUBLE_CLICK_MS,
  ENDED_EPSILON,
  handleEnded,
  reportFullscreen,
  reportProgress,
  reportStatus,
  reportVolume,
  selectEnded,
  setController,
  usePlayerStore,
} from '../store';
import { stepVolume } from '../usePlaybackShortcuts';
import { usePlayerSettings } from '../useSettings';
import { VideoContextMenu } from './lazyParts';

/** Off-screen bounds while a modal dialog covers most of the video (the native surface paints above the DOM). */
export const HIDDEN_BOUNDS: Bounds = { x: -16000, y: -16000, width: 16, height: 16 };

/**
 * The rectangle for the native window: the surface minus anything the player reserves for
 * DOM chrome (controls, notices), clipped to its scroll containers and the viewport, with
 * floating overlays (menus, tooltips, dialogs) as holes. Hidden off screen when a modal
 * covers most of it or nothing of the surface is visible.
 */
export function surfaceLayout(el: Element): { bounds: Bounds; holes: Bounds[] } {
  const layout = el.getClientRects().length === 0 ? null : measureMpvLayout(el);
  return layout?.bounds ? { bounds: layout.bounds, holes: layout.holes } : { bounds: HIDDEN_BOUNDS, holes: [] };
}

/**
 * The rectangle `mpv.attach` opens the window at. Attach carries no holes, so a window that
 * needs some (a menu or dialog over the video) starts hidden; the first layout pass after the
 * attach shows it with them.
 */
export function surfaceBounds(el: Element): Bounds {
  const { bounds, holes } = surfaceLayout(el);
  return holes.length > 0 ? HIDDEN_BOUNDS : bounds;
}

/** A node that may hold or be layout chrome (a menu, a dialog, a toast) came or went. */
function touchesNode(n: Node): boolean {
  return n instanceof Element && (n.matches(LAYOUT_WATCH_SELECTOR) || n.querySelector(LAYOUT_WATCH_SELECTOR) !== null);
}

/** The mutation can move the native window's rectangle or holes. */
function touchesLayout(r: MutationRecord): boolean {
  if (r.type === 'attributes') return true;
  for (const n of Array.from(r.addedNodes)) if (touchesNode(n)) return true;
  for (const n of Array.from(r.removedNodes)) if (touchesNode(n)) return true;
  return false;
}

/**
 * One token per attach. A stale attach (StrictMode's first run, a quick remount) that
 * resolves after a newer one started must not detach: there is one mpv session per window,
 * and that detach would kill the newer one.
 */
let attachSeq = 0;

/** Most notches one wheel event may move the volume (a flung free-spinning wheel). */
const MAX_WHEEL_NOTCHES = 4;

/** The mpv executable is missing (C12 `engine_missing`, or its message before the core sends that code). */
function engineMissing(err: unknown): boolean {
  return classifyStreamError({ code: rpcErrorCode(err), message: err instanceof Error ? err.message : String(err) }) === 'engineMissing';
}

/** Identifies one item for mpv; '' for a placeholder without a stream URL (nothing to load). */
export function mpvLoadKey(s: Pick<PlayerSource, 'url' | 'episodeId'>): string {
  return s.url ? `${s.url}|${s.episodeId ?? ''}` : '';
}

export function boundsEqual(a: Bounds | null, b: Bounds): boolean {
  return !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function trackLabel(t: MpvTrack, fallback: string): string {
  const lang = t.lang ? (() => {
    try {
      return new Intl.DisplayNames(undefined, { type: 'language' }).of(t.lang) ?? t.lang;
    } catch {
      return t.lang;
    }
  })() : undefined;
  if (t.title && lang) return `${t.title} (${lang})`;
  return t.title ?? lang ?? fallback;
}

export function mpvTracks(state: MpvState, fallbacks: { audio(i: number): string; sub(i: number): string }): EngineTracks {
  const audio: TrackOption[] = state.tracks
    .filter((t) => t.type === 'audio')
    .map((t, i) => ({ id: String(t.id), label: trackLabel(t, fallbacks.audio(i + 1)), selected: t.selected }));
  const text: TrackOption[] = state.tracks
    .filter((t) => t.type === 'sub')
    .map((t, i) => ({ id: String(t.id), label: trackLabel(t, fallbacks.sub(i + 1)), selected: t.selected }));
  return { qualities: [], qualityAuto: true, audio: audio.length > 1 ? audio : [], text };
}

/**
 * Embedded mpv: a black placeholder whose screen rectangle drives a native child window.
 * Bounds follow resize, scroll, window resize, DPR changes and modal dialogs.
 * Controls and notices are rendered by the caller as DOM strips *outside* this element, and
 * `surfaceBounds` cuts any chrome that still overlaps it out of the native rectangle.
 */
export function MpvSurface({ className }: { className?: string }) {
  const { t } = useTranslation('player');
  const { toast } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const source = usePlayerStore((s) => s.source);
  const [attached, setAttached] = useState(false);
  /** Bumped per successful attach (first start and every restart after a crash): the load effect reloads. */
  const [sessionNonce, setSessionNonce] = useState(0);
  /** Bumped by Retry on a live session: reload the same item. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * The item whose `mpv.load` mpv has accepted. Until it matches the store's current item,
   * mpv's state still describes the previous file (or a failed load being retried), and its
   * position, pause and end must not be credited to the new item.
   */
  const loadedKey = useRef<string | null>(null);
  /** Where the video's context menu is open (viewport CSS px), or null. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = useRef(false);
  /** Re-measures the native window (set while attached): the open menu is cut out of the video. */
  const remeasure = useRef<() => void>(() => undefined);
  const closeMenu = useCallback(() => setMenuAt(null), []);
  /** mpv cannot run here: say so, play in the built-in player, and offer the way back. */
  const fallBack = useRef<(reason: string) => void>(() => undefined);
  fallBack.current = (reason: string): void => {
    toast({
      title: t('mpvFailed'),
      description: `${t('mpvUnavailable')}${reason ? ` (${reason})` : ''}`,
      variant: 'error',
      action: {
        label: t('mpvTryAgain'),
        onClick: () => {
          if (usePlayerStore.getState().source) usePlayerStore.setState({ mode: 'embedded-mpv', status: 'loading', error: undefined });
        },
      },
    });
    useMediaStore.setState({ errorCode: undefined });
    usePlayerStore.setState({ mode: 'inline', status: 'loading', error: undefined });
  };

  // Attach once per mount (again after a crash, from Retry); detach on unmount.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let session = 0;
    /** False until `mpv.attach` resolved and its state was applied: earlier events describe a session not yet configured. */
    let ready = false;
    let unController: () => void = () => undefined;
    let unExtras: () => void = () => undefined;
    let lastSent: Bounds | null = null;
    let lastHoles = '[]';
    let raf = 0;

    const send = (): void => {
      raf = 0;
      if (disposed || !ref.current) return;
      // Menus, tooltips and dialogs over the video (and fullscreen chrome) are cut out of the
      // native window as holes instead of shrinking or hiding it.
      const { bounds: b, holes } = surfaceLayout(ref.current);
      const holesKey = JSON.stringify(holes);
      if (boundsEqual(lastSent, b) && holesKey === lastHoles) return;
      lastSent = b;
      lastHoles = holesKey;
      rpc('mpv.setBounds', { bounds: b, holes }).catch(() => undefined);
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(send);
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('fullscreenchange', schedule);
    // Moves without resize (layout shifts, the mini player being dragged).
    const poll = setInterval(schedule, 400);
    // Menus, tooltips, dialogs and toasts appear anywhere (portals, the live row menu in the
    // page): re-measure in the next frame when one comes or goes, and only then, so list
    // scrolling and other DOM churn cost a selector match per added node.
    const mo = new MutationObserver((records) => {
      if (records.some(touchesLayout)) schedule();
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'open', 'hidden', 'role'] });
    // A popover that pops in (or the tour card that glides) settles at its final rect: measure it again then.
    const onSettle = (e: Event): void => {
      if (e.target instanceof Element && e.target.closest(OVERLAY_SELECTOR)) schedule();
    };
    document.addEventListener('animationend', onSettle, true);
    document.addEventListener('transitionend', onSettle, true);
    let dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = (): void => {
      dpr.removeEventListener('change', onDpr);
      dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dpr.addEventListener('change', onDpr);
      lastSent = null;
      schedule();
    };
    dpr.addEventListener('change', onDpr);

    const unState = onAppEvent('mpv.state', (st) => {
      if (disposed || !ready) return;
      applyState(st);
    });
    // Clicks on the native video window. A click toggles pause at once; the double click that
    // follows puts the play state back and toggles fullscreen (or leaves PiP).
    let lastClick: { at: number; wasPaused: boolean } | null = null;
    /** The double click that follows a click which only closed the menu does nothing either. */
    let swallowDoubleUntil = 0;
    /** A click on an ended item replays only once it is known not to start a double click (C6). */
    let replayTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelReplay = (): void => {
      if (replayTimer) clearTimeout(replayTimer);
      replayTimer = null;
    };
    const unClick = onAppEvent('mpv.click', () => {
      if (disposed || !ready) return;
      // A click on the video while its menu is open only closes the menu.
      if (menuOpen.current) {
        lastClick = null;
        swallowDoubleUntil = Date.now() + DOUBLE_CLICK_MS;
        setMenuAt(null);
        return;
      }
      const st = usePlayerStore.getState();
      if (selectEnded(st)) {
        // Replaying seeks to 0 and drops Up next, which a double click could not undo.
        lastClick = null;
        cancelReplay();
        const src = st.source;
        replayTimer = setTimeout(() => {
          replayTimer = null;
          const now = usePlayerStore.getState();
          if (!disposed && now.source === src && selectEnded(now)) now.togglePlay();
        }, DOUBLE_CLICK_MS);
        return;
      }
      lastClick = { at: Date.now(), wasPaused: useMediaStore.getState().mpv?.paused ?? false };
      st.togglePlay();
    });
    const unDouble = onAppEvent('mpv.dblclick', () => {
      if (disposed || !ready || Date.now() < swallowDoubleUntil) return;
      cancelReplay();
      if (lastClick && Date.now() - lastClick.at < DOUBLE_CLICK_MS) {
        void rpc('mpv.setProperty', { name: 'pause', value: lastClick.wasPaused }).catch(() => undefined);
      }
      lastClick = null;
      if (usePipStore.getState().active) void exitPip();
      else usePlayerStore.getState().toggleFullscreen();
    });
    // The wheel over the native video steps the volume like the arrow keys, with the same readout.
    const unWheel = onAppEvent('mpv.wheel', ({ delta }) => {
      if (disposed || !ready || !Number.isFinite(delta) || delta === 0) return;
      stepVolume(Math.max(-MAX_WHEEL_NOTCHES, Math.min(MAX_WHEEL_NOTCHES, delta)), t);
    });
    const unMenu = onAppEvent('mpv.contextmenu', ({ x, y }) => {
      if (disposed || !ready || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (!usePlayerStore.getState().source) return;
      setMenuAt({ x, y });
    });
    // PiP opens in the video's shape (mpv's display size, 16:9 when it has none yet).
    const unAspect = setPipAspectSource(async () =>
      ready ? aspectFromVideoParams(await rpc('mpv.command', { cmd: ['get_property', 'video-params'] })) : undefined,
    );
    remeasure.current = () => {
      lastSent = null;
      schedule();
    };
    /** The item whose video shape PiP last followed (a zap in PiP reshapes the window once). */
    let aspectFollowed: string | null = null;

    const applyState = (st: MpvState, initial = false): void => {
      const prev = useMediaStore.getState().mpv;
      useMediaStore.setState({
        mpv: st,
        tracks: mpvTracks(st, { audio: (i) => t('audioFallback', { index: i }), sub: (i) => t('subtitleFallback', { index: i }) }),
        captionsOn: st.tracks.some((x) => x.type === 'sub' && x.selected),
        // Mid-stream stalls (mpv's paused-for-cache) count as waiting too.
        waiting: !st.loaded || !!st.buffering,
        seekable: st.seekable,
        recordStartedAt: st.recording ? (prev?.recording ? useMediaStore.getState().recordStartedAt : undefined) ?? Date.now() : undefined,
      });
      const src = usePlayerStore.getState().source;
      // The attach reply may predate the volume/mute we sent with it; the store keeps the saved values.
      if (!initial) reportVolume(st.volume / 100, st.muted);
      // mpv died: always surface it, whatever item it was loading.
      if (!st.attached && st.error) {
        reportStatus('error', st.error);
        return;
      }
      if (!src || loadedKey.current === null || loadedKey.current !== mpvLoadKey(src)) return;
      reportProgress(st.timePos, src.isLive ? undefined : st.duration);
      if (st.error) reportStatus('error', st.error);
      else if (st.loaded) reportStatus(st.paused ? 'paused' : 'playing');
      // The first frame of a new item is up: in PiP, the window follows its shape.
      if (st.loaded && st.timePos > 0 && aspectFollowed !== loadedKey.current) {
        aspectFollowed = loadedKey.current;
        void refreshPipAspect();
      }
      // keep-open pauses at EOF instead of ending: treat "paused at the end" as ended, once.
      const atEnd = !!st.duration && st.timePos >= st.duration - ENDED_EPSILON && st.paused;
      const wasAtEnd = !!prev?.duration && prev.timePos >= prev.duration - ENDED_EPSILON && prev.paused;
      if (!src.isLive && atEnd && !wasAtEnd) handleEnded();
    };

    const unCommands = setMediaCommands({
      setQuality: () => undefined,
      setAudio: (id) => void rpc('mpv.setProperty', { name: 'aid', value: Number(id) }).catch(() => undefined),
      setText: (id) => void rpc('mpv.setProperty', { name: 'sid', value: id === null ? 'no' : Number(id) }).catch(() => undefined),
      setRate: (r) => {
        useMediaStore.setState({ rate: r });
        void rpc('mpv.setProperty', { name: 'speed', value: r }).catch(() => undefined);
      },
      togglePip: () => void togglePip(),
      retry: () => {
        // The process is gone (crash, killed): start a new session; the load follows the attach.
        if (useMediaStore.getState().mpv?.attached === false) {
          attach(true);
          return;
        }
        setReloadNonce((n) => n + 1);
      },
    });
    // Window picture-in-picture (the native video cannot use the browser's).
    useMediaStore.setState({ canPip: isDesktop });

    /** `restart`: after a crash, from Retry. A failure then stays in the player as an error with Retry. */
    function attach(restart: boolean): void {
      const mine = ++attachSeq;
      session = mine;
      ready = false;
      loadedKey.current = null;
      if (restart) {
        setAttached(false);
        lastSent = null;
        lastHoles = '[]';
      }
      const initial = surfaceBounds(el!);
      const { volume, muted } = usePlayerStore.getState();
      // The session starts at the saved volume instead of mpv's 100 %.
      rpc('mpv.attach', { bounds: initial, volume: Math.round(volume * 100), muted })
        .then((st) => {
          if (disposed) {
            // Unmounted while attaching: make sure the session goes, unless a newer attach owns it.
            if (mine === attachSeq) void rpc('mpv.detach').catch(() => undefined);
            return;
          }
          if (mine !== session) return;
          lastSent = initial;
          applyState(st, true);
          ready = true;
          // Only now can property writes reach mpv (before attach they fail with "not attached").
          unController();
          unController = setController({
            play: () => void rpc('mpv.setProperty', { name: 'pause', value: false }).catch(() => undefined),
            pause: () => void rpc('mpv.setProperty', { name: 'pause', value: true }).catch(() => undefined),
            seekTo: (s) => void rpc('mpv.command', { cmd: ['seek', s, 'absolute'] }).catch(() => undefined),
            setVolume: (v) => void rpc('mpv.setProperty', { name: 'volume', value: Math.round(v * 100) }).catch(() => undefined),
            setMuted: (m) => void rpc('mpv.setProperty', { name: 'mute', value: m }).catch(() => undefined),
          });
          unExtras();
          unExtras = bindMpvExtras();
          setAttached(true);
          setSessionNonce((n) => n + 1);
          schedule();
        })
        .catch((err: unknown) => {
          if (disposed || mine !== session) return;
          const reason = err instanceof Error && err.message ? err.message : '';
          if (restart && !engineMissing(err)) {
            // The strip keeps Retry and "Use the built-in player"; the reason says what is wrong.
            setAttached(true);
            useMediaStore.setState({ errorCode: rpcErrorCode(err) });
            reportStatus('error', reason || t('mpvFailed'));
            return;
          }
          // Unsupported platform or mpv missing: fall back to the built-in player, and offer the way back.
          fallBack.current(reason);
        });
    }
    attach(false);

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      clearInterval(poll);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('fullscreenchange', schedule);
      document.removeEventListener('animationend', onSettle, true);
      document.removeEventListener('transitionend', onSettle, true);
      dpr.removeEventListener('change', onDpr);
      unState();
      unClick();
      cancelReplay();
      unDouble();
      unWheel();
      unMenu();
      unAspect();
      remeasure.current = () => undefined;
      unController();
      unExtras();
      unCommands();
      useMediaStore.setState({ mpv: undefined, recordStartedAt: undefined });
      if (session === attachSeq) void rpc('mpv.detach').catch(() => undefined);
    };
    // Attach once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load (or reload) the current source into the attached session.
  const loadKey = source ? mpvLoadKey(source) : '';
  const hasSource = !!source;
  useEffect(() => {
    if (sessionNonce === 0 || !hasSource) return;
    const src = usePlayerStore.getState().source;
    if (!src) return;
    if (!loadKey) {
      // A placeholder (the stream URL could not be resolved): nothing to load, stop the old item.
      loadedKey.current = '';
      void rpc('mpv.setProperty', { name: 'pause', value: true }).catch(() => undefined);
      return;
    }
    let stale = false;
    loadedKey.current = null;
    rpc('mpv.load', { source: src })
      .then(() => {
        if (stale) return;
        loadedKey.current = loadKey;
        // The subtitle look again for the new file (C6).
        void sendSubtitleStyle();
      })
      .catch((err: unknown) => {
        if (stale) return;
        if (engineMissing(err)) {
          fallBack.current(err instanceof Error ? err.message : '');
          return;
        }
        loadedKey.current = loadKey;
        useMediaStore.setState({ errorCode: rpcErrorCode(err) });
        reportStatus('error', err instanceof Error ? err.message : String(err));
      });
    return () => {
      stale = true;
    };
  }, [sessionNonce, loadKey, reloadNonce, hasSource]);

  // Cut the menu out of the video as it opens, give the video back as it closes.
  useEffect(() => {
    menuOpen.current = menuAt !== null;
    remeasure.current();
  }, [menuAt]);
  // The stream info panel over the video is cut out of it as it opens and given back as it closes.
  const statsOpen = useStreamInfoStore((s) => s.open);
  useEffect(() => remeasure.current(), [statsOpen]);
  // A new item (or none) closes the menu of the old one.
  useEffect(() => setMenuAt(null), [loadKey, hasSource]);

  // mpv fullscreen is the DOM host's fullscreen; mirror it for completeness.
  useEffect(() => {
    const on = (): void => reportFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  return (
    <>
    <div ref={ref} data-mpv-surface="" className={cn('relative h-full w-full bg-black', className)}>
      {/* Only before the native window exists: once attached it paints over this element. */}
      {!attached && (
        <div
          role="status"
          aria-live="polite"
          data-testid="mpv-connecting"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/70"
        >
          <svg viewBox="0 0 48 48" className="size-10 text-accent motion-safe:animate-spin" style={{ animationDuration: '1.4s' }} aria-hidden>
            <circle cx="24" cy="24" r="20" fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth="3" />
            <path d="M24 4 a20 20 0 0 1 20 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          {t('mpvConnecting')}
        </div>
      )}
    </div>
    {/* A sibling, not a child: the surface's own content is never cut out of the native window. */}
    <MpvConnectingNotice source={source} />
    {menuAt && <VideoContextMenu at={menuAt} onClose={closeMenu} />}
    </>
  );
}

/**
 * A slow start (`reconnect.ts` phase `connecting`) over the native video: "Still connecting",
 * and another copy of a live channel right away. The pill is a `data-mpv-overlay` hole, so it
 * shows through the native window, which is black until the stream starts.
 */
function MpvConnectingNotice({ source }: { source: PlayerSource | null | undefined }) {
  const { t } = useTranslation('player');
  const settings = usePlayerSettings();
  const connecting = useReconnectStore((s) => s.phase === 'connecting');
  const key = source?.isLive && source.ref ? itemKey(source.ref) : undefined;
  const alternates = useAlternatesStore((s) => s.status === 'ready' && !!key && s.forKey === key && !!s.data?.alternates.length);
  const [busy, setBusy] = useState(false);
  if (!connecting || !source?.url) return null;
  const offerSwitch = alternates && settings?.liveFailover !== false;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex justify-center pt-12">
      <p
        role="status"
        aria-live="polite"
        data-mpv-overlay=""
        data-testid="connecting-notice"
        className={cn('player-glass-strong inline-flex max-w-[90%] items-center gap-2 rounded-full border py-1 text-sm', offerSwitch ? 'pr-1 pl-3' : 'px-3')}
      >
        <span className="truncate">{t('stillConnecting')}</span>
        {offerSwitch && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setBusy(true);
              void tryAnotherSource().finally(() => setBusy(false));
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="pointer-events-auto shrink-0 rounded-full bg-white/12 px-2.5 py-0.5 font-medium hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/70 disabled:opacity-60"
          >
            {t('tryAnotherSource')}
          </button>
        )}
      </p>
    </div>
  );
}
