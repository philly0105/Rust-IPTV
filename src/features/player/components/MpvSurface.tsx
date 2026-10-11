import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { rpc } from '@/api/transport';
import type { Bounds, MpvState, MpvTrack } from '@/api/types';

import { useToast } from '../_shim';
import { cn } from '../cn';
import type { EngineTracks, TrackOption } from '../engines';
import { modalOpen } from '../format';
import { setMediaCommands, useMediaStore } from '../media';
import { measureMpvBounds } from '../mpvBounds';
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
    let lastSent: Bounds | null = null;
    let raf = 0;

    const send = (): void => {
      raf = 0;
      if (disposed || !ref.current) return;
      const b = surfaceBounds(ref.current);
      if (boundsEqual(lastSent, b)) return;
      lastSent = b;
      rpc('mpv.setBounds', { bounds: b }).catch(() => undefined);
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
      if (disposed) return;
      applyState(st);
    });

    const applyState = (st: MpvState): void => {
      const prev = useMediaStore.getState().mpv;
      useMediaStore.setState({
        mpv: st,
        tracks: mpvTracks(st, { audio: (i) => t('audioFallback', { index: i }), sub: (i) => t('subtitleFallback', { index: i }) }),
        captionsOn: st.tracks.some((x) => x.type === 'sub' && x.selected),
        waiting: !st.loaded,
      });
      const src = usePlayerStore.getState().source;
      reportProgress(st.timePos, src?.isLive ? undefined : st.duration);
      reportVolume(st.volume / 100, st.muted);
      if (st.error) reportStatus('error', st.error);
      else if (st.loaded) reportStatus(st.paused ? 'paused' : 'playing');
      // keep-open pauses at EOF instead of ending: treat "paused at the end" as ended, once.
      const atEnd = !!st.duration && st.timePos >= st.duration - ENDED_EPSILON && st.paused;
      const wasAtEnd = !!prev?.duration && prev.timePos >= prev.duration - ENDED_EPSILON && prev.paused;
      if (src && !src.isLive && atEnd && !wasAtEnd) handleEnded();
    };

    const unController = setController({
      play: () => void rpc('mpv.setProperty', { name: 'pause', value: false }).catch(() => undefined),
      pause: () => void rpc('mpv.setProperty', { name: 'pause', value: true }).catch(() => undefined),
      seekTo: (s) => void rpc('mpv.command', { cmd: ['seek', s, 'absolute'] }).catch(() => undefined),
      setVolume: (v) => void rpc('mpv.setProperty', { name: 'volume', value: Math.round(v * 100) }).catch(() => undefined),
      setMuted: (m) => void rpc('mpv.setProperty', { name: 'mute', value: m }).catch(() => undefined),
    });
    const unCommands = setMediaCommands({
      setQuality: () => undefined,
      setAudio: (id) => void rpc('mpv.setProperty', { name: 'aid', value: Number(id) }).catch(() => undefined),
      setText: (id) => void rpc('mpv.setProperty', { name: 'sid', value: id === null ? 'no' : Number(id) }).catch(() => undefined),
      setRate: (r) => {
        useMediaStore.setState({ rate: r });
        void rpc('mpv.setProperty', { name: 'speed', value: r }).catch(() => undefined);
      },
      togglePip: () => undefined,
      retry: () => {
        const src = usePlayerStore.getState().source;
        if (src) void rpc('mpv.load', { source: src }).catch(() => undefined);
      },
    });
    useMediaStore.setState({ canPip: false });

    const initial = surfaceBounds(el);
    rpc('mpv.attach', { bounds: initial })
      .then((st) => {
        if (disposed) {
          void rpc('mpv.detach').catch(() => undefined);
          return;
        }
        lastSent = initial;
        applyState(st);
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
      unController();
      unCommands();
      useMediaStore.setState({ mpv: undefined });
      void rpc('mpv.detach').catch(() => undefined);
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
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70" aria-live="polite">
          {t('mpvLoading')}
        </div>
      )}
    </div>
  );
}
