import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { isDesktop, rpc } from '@/api/transport';
import type { Bounds, MpvState, MpvTrack } from '@/api/types';

import { useToast } from '@/ui/Toast';
import { cn } from '../cn';
import type { EngineTracks, TrackOption } from '../engines';
import { modalOpen } from '../format';
import { setMediaCommands, useMediaStore } from '../media';
import { measureMpvBounds, measureMpvLayout } from '../mpvBounds';
import { exitPip, togglePip, usePipStore } from '../pip';
import {
  ENDED_EPSILON,
  handleEnded,
  reportFullscreen,
  reportProgress,
  reportStatus,
  reportVolume,
  setController,
  usePlayerStore,
} from '../store';

/** Off-screen bounds while a modal dialog needs the whole window (the native surface paints above the DOM). */
export const HIDDEN_BOUNDS: Bounds = { x: -16000, y: -16000, width: 16, height: 16 };

/**
 * The rectangle for the native window: the surface minus anything the player reserves for
 * DOM chrome (controls, notices, menus), clipped to its scroll containers and the viewport.
 * Hidden off screen when a modal is open or nothing of the surface is visible.
 */
export function surfaceBounds(el: Element): Bounds {
  if (modalOpen() || el.getClientRects().length === 0) return HIDDEN_BOUNDS;
  return measureMpvBounds(el) ?? HIDDEN_BOUNDS;
}

/**
 * One token per attach. A stale attach (StrictMode's first run, a quick remount) that
 * resolves after a newer one started must not detach: there is one mpv session per window,
 * and that detach would kill the newer one.
 */
let attachSeq = 0;

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

  // Attach once per mount; detach on unmount.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    const session = ++attachSeq;
    /** False until `mpv.attach` resolved and its state was applied: earlier events describe a session not yet configured. */
    let ready = false;
    let unController: () => void = () => undefined;
    let lastSent: Bounds | null = null;
    let lastHoles = '[]';
    let raf = 0;

    const send = (): void => {
      raf = 0;
      if (disposed || !ref.current) return;
      // Fullscreen chrome over the video is cut out of the native window (holes) instead of shrinking it.
      const layout = modalOpen() || ref.current.getClientRects().length === 0 ? null : measureMpvLayout(ref.current);
      const b = layout?.bounds ?? HIDDEN_BOUNDS;
      const holes = layout?.bounds ? layout.holes : [];
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
    // Moves without resize (layout shifts, the mini player being dragged) and dialogs opening.
    const poll = setInterval(schedule, 400);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ['aria-modal', 'open'] });
    // Toasts come and go inside their own portal: re-measure as soon as one appears or leaves.
    const toastViewport = document.querySelector('[data-toast-viewport]');
    if (toastViewport) mo.observe(toastViewport, { childList: true, subtree: true });
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
    const unClick = onAppEvent('mpv.click', () => {
      if (disposed || !ready) return;
      lastClick = { at: Date.now(), wasPaused: useMediaStore.getState().mpv?.paused ?? false };
      usePlayerStore.getState().togglePlay();
    });
    const unDouble = onAppEvent('mpv.dblclick', () => {
      if (disposed || !ready) return;
      if (lastClick && Date.now() - lastClick.at < 1000) {
        void rpc('mpv.setProperty', { name: 'pause', value: lastClick.wasPaused }).catch(() => undefined);
      }
      lastClick = null;
      if (usePipStore.getState().active) void exitPip();
      else usePlayerStore.getState().toggleFullscreen();
    });

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
      reportProgress(st.timePos, src?.isLive ? undefined : st.duration);
      // The attach reply may predate the volume/mute we sent with it; the store keeps the saved values.
      if (!initial) reportVolume(st.volume / 100, st.muted);
      if (st.error) reportStatus('error', st.error);
      else if (st.loaded) reportStatus(st.paused ? 'paused' : 'playing');
      // keep-open pauses at EOF instead of ending: treat "paused at the end" as ended, once.
      const atEnd = !!st.duration && st.timePos >= st.duration - ENDED_EPSILON && st.paused;
      const wasAtEnd = !!prev?.duration && prev.timePos >= prev.duration - ENDED_EPSILON && prev.paused;
      if (src && !src.isLive && atEnd && !wasAtEnd) handleEnded();
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
        const src = usePlayerStore.getState().source;
        if (src) void rpc('mpv.load', { source: src }).catch(() => undefined);
      },
    });
    // Window picture-in-picture (the native video cannot use the browser's).
    useMediaStore.setState({ canPip: isDesktop });

    const initial = surfaceBounds(el);
    const { volume, muted } = usePlayerStore.getState();
    // The session starts at the saved volume instead of mpv's 100 %.
    rpc('mpv.attach', { bounds: initial, volume: Math.round(volume * 100), muted })
      .then((st) => {
        if (disposed) {
          // Unmounted while attaching: make sure the session goes, unless a newer attach owns it.
          if (session === attachSeq) void rpc('mpv.detach').catch(() => undefined);
          return;
        }
        lastSent = initial;
        applyState(st, true);
        ready = true;
        // Only now can property writes reach mpv (before attach they fail with "not attached").
        unController = setController({
          play: () => void rpc('mpv.setProperty', { name: 'pause', value: false }).catch(() => undefined),
          pause: () => void rpc('mpv.setProperty', { name: 'pause', value: true }).catch(() => undefined),
          seekTo: (s) => void rpc('mpv.command', { cmd: ['seek', s, 'absolute'] }).catch(() => undefined),
          setVolume: (v) => void rpc('mpv.setProperty', { name: 'volume', value: Math.round(v * 100) }).catch(() => undefined),
          setMuted: (m) => void rpc('mpv.setProperty', { name: 'mute', value: m }).catch(() => undefined),
        });
        setAttached(true);
        schedule();
      })
      .catch((err: unknown) => {
        if (disposed) return;
        // Unsupported platform or mpv missing: fall back to the built-in player.
        toast({
          title: t('mpvFailed'),
          description: `${t('mpvUnavailable')}${err instanceof Error && err.message ? ` (${err.message})` : ''}`,
          variant: 'error',
        });
        usePlayerStore.setState({ mode: 'inline', status: 'loading', error: undefined });
      });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      clearInterval(poll);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('fullscreenchange', schedule);
      dpr.removeEventListener('change', onDpr);
      unState();
      unClick();
      unDouble();
      unController();
      unCommands();
      useMediaStore.setState({ mpv: undefined, recordStartedAt: undefined });
      if (session === attachSeq) void rpc('mpv.detach').catch(() => undefined);
    };
    // Attach once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load (or reload) the current source into the attached session.
  const loadKey = source ? `${source.url}|${source.episodeId ?? ''}` : '';
  useEffect(() => {
    if (!attached || !loadKey) return;
    const src = usePlayerStore.getState().source;
    if (!src) return;
    rpc('mpv.load', { source: src }).catch((err: unknown) => {
      reportStatus('error', err instanceof Error ? err.message : String(err));
    });
  }, [attached, loadKey]);

  // mpv fullscreen is the DOM host's fullscreen; mirror it for completeness.
  useEffect(() => {
    const on = (): void => reportFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  return (
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
  );
}
