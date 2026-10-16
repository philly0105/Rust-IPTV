/**
 * One tile's playback: its own source lookup, its own engine on its own <video>, its own
 * state. Nothing here is shared between tiles, so a tile that fails (lookup refused, engine
 * error, element error, start or stall timeout, stream end) stops only itself and shows
 * why; the others keep playing. Retry rebuilds only this tile.
 *
 * Sound: the element is muted unless this tile has the wall's sound. Browsers refuse sound
 * before the first user gesture on the page (a reload straight into the wall): the tile then
 * plays muted, reports `soundBlocked`, and turns its sound on at the next click or key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { itemKey, type PlayerSource } from '@/api/types';
import { proxiedUrl } from '@/api/transport';
import { rpcErrorCode } from '@/features/player/errors';

import {
  createEngine,
  fetchFailureReason,
  looksLikeMpegTs,
  mseSupported,
  withReason,
  worthSniffingAsMpegTs,
  type Engine,
} from './engine';
import type { TileFault } from './errors';
import { resolveTileSource } from './stream';
import type { MultiviewChannelInput } from './types';

/** A stream that has not shown a frame by then counts as failed. */
export const START_TIMEOUT_MS = 25_000;
/** A playing stream that waits for data this long counts as failed. */
export const STALL_TIMEOUT_MS = 30_000;
/**
 * Tiles that start together (the wall opening, a parental check answering) start this far
 * apart, in slot order: each engine's parse and media attach gets its own frames instead of
 * all of them landing in one long task.
 */
export const TILE_START_STAGGER_MS = 32;

export type TilePhase = 'locked' | 'resolving' | 'loading' | 'playing' | 'error';

export interface TilePlaybackState {
  phase: TilePhase;
  fault: TileFault | null;
  /** Playing, but waiting for data. */
  buffering: boolean;
  /** This tile should have sound but the browser wants a gesture first. */
  soundBlocked: boolean;
}

export interface TilePlaybackOptions {
  /** This tile has the wall's sound (and the wall is not muted). */
  audible: boolean;
  /** 0..1, applied while audible. */
  volume: number;
  /** Parental controls lock the channel: no lookup, no engine. */
  locked: boolean;
  /** Wait this long before the first start (see TILE_START_STAGGER_MS); retries start at once. */
  startDelayMs?: number;
}

export interface TilePlayback extends TilePlaybackState {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  retry(): void;
  /** Call from a user gesture on the tile: turns blocked sound on. */
  unblockSound(): void;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Playback failed';
}

/** The browser has seen a gesture on this page (sound may start); unknown counts as yes. */
function hadGesture(): boolean {
  const ua = (typeof navigator !== 'undefined' ? (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation : undefined);
  return ua ? ua.hasBeenActive : true;
}

const INITIAL: TilePlaybackState = { phase: 'resolving', fault: null, buffering: false, soundBlocked: false };

export function useTilePlayback(ch: MultiviewChannelInput, opts: TilePlaybackOptions): TilePlayback {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<TilePlaybackState>(() => (opts.locked ? { ...INITIAL, phase: 'locked' } : INITIAL));
  /** Stream url the element rejected that now goes through mpegts.js. */
  const sniffedRef = useRef<string | null>(null);
  /** Sound was refused for lack of a gesture; the element plays muted until one comes. */
  const blockedRef = useRef(false);
  const audibleRef = useRef(opts.audible);
  audibleRef.current = opts.audible;
  const volumeRef = useRef(opts.volume);
  volumeRef.current = opts.volume;
  const key = itemKey(ch.ref);
  const chRef = useRef(ch);
  chRef.current = ch;
  const startDelayRef = useRef(opts.startDelayMs ?? 0);
  startDelayRef.current = opts.startDelayMs ?? 0;
  /** The engine has been asked for once: later builds (retry, unlock, replace) skip the stagger. */
  const startedRef = useRef(false);

  const startPlay = useCallback((el: HTMLVideoElement, isCurrent: () => boolean) => {
    // Sound refused earlier, but the page has had a gesture since (a click on Retry is one):
    // try with sound again instead of carrying the muted fallback into the new stream.
    if (blockedRef.current && hadGesture()) blockedRef.current = false;
    el.volume = volumeRef.current;
    el.muted = !audibleRef.current || blockedRef.current;
    // Still no gesture (a retry on its own, when the network came back): the tile plays muted
    // and asks for a click again, rather than playing silently with no hint.
    if (blockedRef.current && audibleRef.current) setState((s) => (s.soundBlocked ? s : { ...s, soundBlocked: true }));
    el.play().catch((err: unknown) => {
      if (!isCurrent()) return;
      // No gesture yet: play muted rather than sit still, and ask for a click.
      if (err instanceof DOMException && err.name === 'NotAllowedError' && !el.muted) {
        blockedRef.current = true;
        el.muted = true;
        setState((s) => ({ ...s, soundBlocked: true }));
        el.play().catch(() => undefined);
      }
    });
  }, []);

  // Engine lifecycle: one per channel, per retry, per lock change.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (opts.locked) {
      setState({ phase: 'locked', fault: null, buffering: false, soundBlocked: false });
      return;
    }
    let disposed = false;
    let failed = false;
    let source: PlayerSource | null = null;
    const abort = new AbortController();
    const isCurrent = (): boolean => !disposed && !failed;
    setState(INITIAL);

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let beginTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      clearTimeout(startTimer);
      clearTimeout(stallTimer);
    };

    const release = (): void => {
      engineRef.current?.destroy();
      engineRef.current = null;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // Detached or never loaded.
      }
    };

    const fail = (fault: TileFault): void => {
      if (!isCurrent()) return;
      failed = true;
      clearTimers();
      release();
      setState({ phase: 'error', fault, buffering: false, soundBlocked: false });
    };

    startTimer = setTimeout(() => fail({ code: 'timeout', message: 'The stream did not start in time' }), START_TIMEOUT_MS);

    const onPlaying = (): void => {
      if (!isCurrent()) return;
      clearTimers();
      setState((s) => (s.phase === 'playing' && !s.buffering ? s : { ...s, phase: 'playing', buffering: false }));
    };
    const onWaiting = (): void => {
      if (!isCurrent()) return;
      setState((s) => (s.phase === 'playing' && !s.buffering ? { ...s, buffering: true } : s));
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail({ code: 'timeout', message: 'The stream stopped sending data' }), STALL_TIMEOUT_MS);
    };
    const onProgress = (): void => {
      if (!isCurrent()) return;
      clearTimeout(stallTimer);
      setState((s) => (s.buffering ? { ...s, buffering: false } : s));
    };
    const onEnded = (): void => fail({ kind: 'network', message: 'The stream ended' });
    const onError = (): void => {
      // Native element errors only: hls.js, shaka and mpegts.js report through onError.
      const s = source;
      if (!isCurrent() || !s || !el.error) return;
      const engineKind = engineRef.current?.kind;
      if (engineKind ? engineKind !== 'native' : s.kind === 'hls' || s.kind === 'dash' || looksLikeMpegTs(s)) return;
      const code = el.error.code;
      const kind = code === 2 ? 'network' : code === 4 ? 'unsupported' : 'media';
      const message = el.error.message || `Media error ${code}`;
      if (code !== 2 && code !== 4) {
        fail({ kind, message });
        return;
      }
      // An extensionless stream the element cannot play is often raw MPEG-TS: one retry through mpegts.js.
      const sniff = code === 4 && sniffedRef.current !== s.url && mseSupported() && worthSniffingAsMpegTs(s);
      // The element hides the HTTP status and reports a refusal (a 503, a 404) as code 4 too; our own
      // server's answer says why. A refusal fails now instead of going through mpegts.js, which would
      // only be refused again. A 2xx answer, or none to read, still gets the mpegts.js retry.
      void fetchFailureReason(proxiedUrl(s)).then((r) => {
        if (!isCurrent()) return;
        if (r) {
          fail({ kind: 'network', message: withReason(message, r.reason, r.status) });
          return;
        }
        if (!sniff) {
          fail({ kind, message });
          return;
        }
        sniffedRef.current = s.url;
        failed = true;
        setNonce((n) => n + 1);
      });
    };

    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('timeupdate', onProgress);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);

    const begin = (): void => {
      startedRef.current = true;
      resolveTileSource(chRef.current)
        .then(async (src) => {
          if (!isCurrent()) return;
          source = src;
          setState((s) => (s.phase === 'resolving' ? { ...s, phase: 'loading' } : s));
          const engine = await createEngine(
            el,
            src,
            proxiedUrl(src),
            {
              onTracks: () => undefined,
              onError: (err) => {
                if (err.fatal) fail({ kind: err.kind, message: err.message });
              },
            },
            { captions: false, signal: abort.signal, forceMpegts: sniffedRef.current === src.url },
          );
          if (!isCurrent()) {
            engine.destroy();
            return;
          }
          engineRef.current = engine;
          startPlay(el, isCurrent);
        })
        .catch((err: unknown) => {
          const code = rpcErrorCode(err);
          fail(code ? { code, message: errorText(err) } : { message: errorText(err) });
        });
    };
    const delay = startedRef.current ? 0 : startDelayRef.current;
    if (delay > 0) beginTimer = setTimeout(begin, delay);
    else begin();

    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(beginTimer);
      clearTimers();
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('timeupdate', onProgress);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      release();
    };
    // The engine is rebuilt only when the channel, the lock or the retry count changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, opts.locked]);

  // Sound and volume follow the wall without touching the engine.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = Math.min(1, Math.max(0, opts.volume));
    if (!opts.audible) {
      el.muted = true;
      setState((s) => (s.soundBlocked ? { ...s, soundBlocked: false } : s));
      return;
    }
    if (blockedRef.current && !hadGesture()) {
      setState((s) => (s.soundBlocked ? s : { ...s, soundBlocked: true }));
      return;
    }
    blockedRef.current = false;
    el.muted = false;
    setState((s) => (s.soundBlocked ? { ...s, soundBlocked: false } : s));
    // A live tile never stays paused because its sound changed.
    if (el.paused && engineRef.current) el.play().catch(() => undefined);
  }, [opts.audible, opts.volume]);

  const unblockSound = useCallback(() => {
    const el = videoRef.current;
    if (!el || !blockedRef.current) return;
    blockedRef.current = false;
    setState((s) => (s.soundBlocked ? { ...s, soundBlocked: false } : s));
    if (!audibleRef.current) return;
    el.muted = false;
    if (el.paused && engineRef.current) el.play().catch(() => undefined);
  }, []);

  // Blocked sound comes on with the first gesture anywhere on the page.
  useEffect(() => {
    if (!state.soundBlocked) return;
    const onGesture = (): void => {
      // The gesture's activation is in place once the event dispatches.
      queueMicrotask(unblockSound);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    return () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    };
  }, [state.soundBlocked, unblockSound]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, videoRef, retry, unblockSound };
}
