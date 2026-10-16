import { AlertTriangle, ChevronRight, Copy, ExternalLink, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { proxiedUrl, isDesktop, rpc } from '@/api/transport';
import { itemKey, type PlayerSource } from '@/api/types';

import { QUARTER_BLUR, useImageChain } from '@/ui/image';
import { useToast } from '@/ui/Toast';
import { cn } from '../cn';
import {
  createEngine,
  EMPTY_TRACKS,
  fetchFailureStatus,
  looksLikeMpegTs,
  mseSupported,
  withReason,
  worthSniffingAsMpegTs,
  type Engine,
  type EngineError,
  type EngineTracks,
} from '../engines';
import { afterPaint } from '../enginePreload';
import { NO_VIDEO_MESSAGE } from '../errors';
import { useAlternatesStore } from '../failover';
import { bindInlineExtras } from '../inlineExtras';
import { focusIfPlayerOwnsFocus, safeImageUrl } from '../format';
import { noteEngineError, tryAnotherSource, useReconnectStore } from '../reconnect';
import { canShareSource } from '../shareable';
import { setMediaCommands, useMediaStore, type TimeRange } from '../media';
import {
  handleEnded,
  reportProgress,
  reportStatus,
  reportVolume,
  retryResolve,
  setController,
  usePlayerStore,
} from '../store';
import { clearExternal, selectText, setInlineSubtitleTarget, withExternal } from '../subtitles/tracks';
import { usePlayerSettings } from '../useSettings';
import { useRetryWhenOnline, useStreamError } from '../useStreamError';

/** Stable identity for "the same media": a source swap with the same url keeps the engine. */
function mediaKey(s: PlayerSource | undefined): string {
  return s ? `${s.kind}|${s.url}` : '';
}

/**
 * How long hls.js, shaka or mpegts.js get to report an element error themselves. When the element
 * rejects the media outright (no track it can decode), mpegts.js says nothing at all.
 */
export const ENGINE_ERROR_GRACE_MS = 1_000;

/** The longest a zap keeps the last channel's frame up while the next one connects. */
export const ZAP_HOLD_MAX_MS = 6000;

/**
 * Keeps the last frame of a live channel on `hold` (a canvas over the video) while the next live
 * channel's engine replaces it: tearing the old engine down empties the element, and the new
 * stream's first frame comes 150-200 ms later, so a zap would otherwise flash black. True when
 * a frame was held. Drawing a cross-origin frame only taints the canvas; it is never read back.
 */
export function holdLastFrame(el: HTMLVideoElement, hold: HTMLCanvasElement): boolean {
  if (el.readyState < 2 || !el.videoWidth || !el.videoHeight || el.error) return false;
  try {
    hold.width = el.videoWidth;
    hold.height = el.videoHeight;
    hold.getContext('2d')?.drawImage(el, 0, 0, hold.width, hold.height);
  } catch {
    hold.width = 0;
    return false;
  }
  hold.hidden = false;
  return true;
}

/** Takes the held frame down (and frees its pixels). */
export function releaseHeldFrame(hold: HTMLCanvasElement | null): void {
  if (!hold || hold.hidden) return;
  hold.hidden = true;
  hold.width = 0;
  hold.height = 0;
}

function rangesOf(tr: TimeRanges, offset = 0): TimeRange[] {
  const out: TimeRange[] = [];
  for (let i = 0; i < tr.length; i++) out.push({ start: tr.start(i) + offset, end: tr.end(i) + offset });
  return out;
}

export interface InlinePlayerProps {
  /** Audio element for radio; video otherwise. */
  as?: 'video' | 'audio';
  className?: string;
  /** Mini player: the error state keeps to a headline and Retry. */
  compact?: boolean;
  /** A short player (a phone's 16:9, a docked stage): the error state packs into the room the bar leaves. */
  short?: boolean;
}

/**
 * The media element plus its engine. Reports progress/status into the store and
 * registers itself as the store's PlaybackController. Chrome is rendered by the caller.
 */
export function InlinePlayer({ as = 'video', className, compact = false, short = false }: InlinePlayerProps) {
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  const error = usePlayerStore((s) => s.error);
  const settings = usePlayerSettings();
  // The VOD poster (C3): through the image cache, then its own URL once. It is the video's
  // poster and, with ambient mode on, the soft colour field behind the picture.
  const art = useImageChain([as === 'video' && source && !source.isLive ? safeImageUrl(source.posterUrl) : undefined], source?.ref?.sourceId);
  const elRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  /** Subtitles drawn by the player over the video (subtitles/inline.ts). */
  const subsRef = useRef<HTMLDivElement>(null);
  /** The last channel's frame, up while a zap connects the next one (`holdLastFrame`). */
  const holdRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [errorKind, setErrorKind] = useState<EngineError['kind'] | null>(null);
  /** Media key that the element rejected and that now goes through mpegts.js instead. */
  const sniffedRef = useRef<string | null>(null);
  const key = mediaKey(source);
  const captionsDefault = settings?.showCaptions ?? false;
  /** The engine's own tracks; the store gets them with any loaded subtitle files added (C6). */
  const engineTracks = useRef<EngineTracks>(EMPTY_TRACKS);
  const publishTracks = useCallback((tracks?: EngineTracks) => {
    if (tracks) engineTracks.current = tracks;
    const el = elRef.current;
    useMediaStore.setState({ tracks: el ? withExternal(el, engineTracks.current) : engineTracks.current });
  }, []);

  /**
   * Fatal error: report it. Smart reconnect and failover (`reconnect.ts`) take it from there and
   * either recover quietly or leave the overlay up.
   */
  // failover: the recovery module owns retries and switching; it needs the engine's error kind.
  const failRef = useRef<(src: PlayerSource, err: EngineError) => void>(() => undefined);
  /** Failures reported so far: an element error the engine already answered is not reported twice. */
  const failCount = useRef(0);
  failRef.current = (_src, err) => {
    failCount.current++;
    setErrorKind(err.kind);
    noteEngineError(err.kind);
    reportStatus('error', err.message);
  };

  // Engine lifecycle: one per media url (and per retry).
  useEffect(() => {
    const el = elRef.current;
    const src = usePlayerStore.getState().source;
    // A new item (or none) must not inherit the last engine's error class.
    setErrorKind(null);
    if (!el || !src || !src.url) return;
    let disposed = false;
    const abort = new AbortController();
    // A held frame from the last channel stays until this stream draws its own first frame.
    const hold = holdRef.current;
    let stopWatching: () => void = () => undefined;
    if (hold && !hold.hidden && el instanceof HTMLVideoElement) {
      let live = true;
      const release = (): void => {
        if (!live) return;
        stopWatching();
        releaseHeldFrame(hold);
      };
      // The frame is decoded at loadeddata; the next video frame callback is when it is on screen.
      const onData = (): void => {
        if (typeof el.requestVideoFrameCallback === 'function') el.requestVideoFrameCallback(() => release());
        else release();
      };
      const timer = setTimeout(release, ZAP_HOLD_MAX_MS);
      el.addEventListener('loadeddata', onData);
      stopWatching = () => {
        live = false;
        clearTimeout(timer);
        el.removeEventListener('loadeddata', onData);
      };
    }
    useMediaStore.setState({ buffered: [], seekable: undefined, waiting: true });
    publishTracks(EMPTY_TRACKS);
    const loadUrl = proxiedUrl(src);

    const onFatal = (err: EngineError): void => {
      if (disposed) return;
      stopWatching();
      releaseHeldFrame(hold);
      failRef.current(src, err);
    };

    // The engine starts once the tuned state (title, banner, loading dial) has painted: a click
    // whose stream resolves from cache must not carry engine setup inside its own frame.
    const forceMpegts = sniffedRef.current === mediaKey(src);
    const start = (): Promise<Engine> =>
      createEngine(
        el,
        src,
        loadUrl,
        {
          onTracks: (tracks) => {
            if (!disposed) publishTracks(tracks);
          },
          onError: onFatal,
        },
        { captions: captionsDefault, signal: abort.signal, forceMpegts },
      );
    let cancelStart: () => void = () => undefined;
    void new Promise<Engine>((resolve, reject) => {
      cancelStart = afterPaint(() => {
        if (disposed) return;
        start().then(resolve, reject);
      });
    }).then((engine) => {
      if (disposed) {
        engine.destroy();
        return;
      }
      engineRef.current = engine;
      el.playbackRate = 1;
      el.play().catch((err: unknown) => {
        if (disposed) return;
        // Autoplay without a gesture (reload restore): retry muted rather than sit paused.
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          el.muted = true;
          usePlayerStore.setState({ muted: true });
          el.play().catch(() => reportStatus('paused'));
        }
      });
    });

    // Direct/file resume: hls/dash take startPosition in the engine.
    const onMeta = (): void => {
      const s = usePlayerStore.getState().source;
      if (s && !s.isLive && s.resumeSeconds && (s.kind === 'direct' || s.kind === 'file')) {
        if (el.duration && s.resumeSeconds < el.duration - 2) el.currentTime = s.resumeSeconds;
      }
    };
    el.addEventListener('loadedmetadata', onMeta, { once: true });

    return () => {
      disposed = true;
      cancelStart();
      abort.abort();
      el.removeEventListener('loadedmetadata', onMeta);
      stopWatching();
      // A zap from one live channel to another: keep this channel's frame up until the next one
      // draws (the engine below empties the element); a frame still held from the zap before
      // (this channel never drew) stays. A retry, a stop or a move to VOD lets it go.
      const next = usePlayerStore.getState().source;
      const zap = !!hold && el instanceof HTMLVideoElement && src.isLive && !!next?.isLive && !!next.url && mediaKey(next) !== mediaKey(src);
      if (!zap) releaseHeldFrame(hold);
      else if (hold.hidden) holdLastFrame(el, hold);
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // The engine is rebuilt only when the media itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryNonce]);

  // Subtitle files belong to one item: a new one empties and hides them (C6).
  useEffect(() => {
    const el = elRef.current;
    return () => {
      if (el) clearExternal(el);
    };
  }, [key]);

  // Media element -> store.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let lastBufferedAt = 0;
    const isLive = (): boolean => !!usePlayerStore.getState().source?.isLive;
    /** Non-zero after an mpegts.js live reconnect restarted the element clock. */
    const offset = (): number => engineRef.current?.timeOffset?.() ?? 0;
    const onTime = (): void => {
      const dur = Number.isFinite(el.duration) && !isLive() ? el.duration : undefined;
      const off = offset();
      reportProgress(el.currentTime + off, dur);
      const now = performance.now();
      if (now - lastBufferedAt > 1000) {
        lastBufferedAt = now;
        const seek = el.seekable.length
          ? { start: el.seekable.start(0) + off, end: el.seekable.end(el.seekable.length - 1) + off }
          : undefined;
        useMediaStore.setState({ buffered: rangesOf(el.buffered, off), seekable: isLive() ? seek : undefined });
      }
    };
    const onPlaying = (): void => {
      useMediaStore.setState({ waiting: false });
      reportStatus('playing');
    };
    const onPause = (): void => {
      // The element pauses itself when it rejects the media: that is a failure, not a pause.
      if (!el.ended && !el.error) reportStatus('paused');
    };
    const onWaiting = (): void => useMediaStore.setState({ waiting: true });
    const onVolume = (): void => reportVolume(el.volume, el.muted);
    const onRate = (): void => useMediaStore.setState({ rate: el.playbackRate });
    const onEnded = (): void => {
      if (!isLive()) handleEnded();
    };
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const onError = (): void => {
      const s = usePlayerStore.getState().source;
      if (!s || !el.error) return;
      const code = el.error.code;
      const engineKind = engineRef.current?.kind;
      if (engineKind ? engineKind !== 'native' : s.kind === 'hls' || s.kind === 'dash' || looksLikeMpegTs(s)) {
        // hls.js, shaka and mpegts.js report their own failures, and may recover from this one.
        // When they stay quiet and the element still holds the error, say so: never a black
        // frame and a Play button.
        if (graceTimer) clearTimeout(graceTimer);
        const reported = failCount.current;
        graceTimer = setTimeout(() => {
          graceTimer = null;
          const cur = usePlayerStore.getState();
          if (cur.source !== s || !el.error || cur.status === 'error' || failCount.current !== reported) return;
          const kind = code === 2 ? 'network' : code === 3 ? 'media' : 'unsupported';
          failRef.current(s, { kind, fatal: true, message: code === 4 ? NO_VIDEO_MESSAGE : el.error.message || `Media error ${code}` });
        }, ENGINE_ERROR_GRACE_MS);
        return;
      }
      // An extensionless stream the element cannot play is often raw MPEG-TS: one retry through mpegts.js.
      const k = mediaKey(s);
      if (code === 4 && sniffedRef.current !== k && mseSupported() && worthSniffingAsMpegTs(s)) {
        sniffedRef.current = k;
        setRetryNonce((n) => n + 1);
        return;
      }
      const kind = code === 2 ? 'network' : code === 4 ? 'unsupported' : 'media';
      const message = el.error.message || `Media error ${code}`;
      if (code !== 2 && code !== 4) {
        failRef.current(s, { kind, fatal: true, message });
        return;
      }
      // The element hides HTTP status and body: when our own server (proxy guard, files, a status
      // relayed from the provider) refused the request, its answer replaces the generic media error.
      void fetchFailureStatus(proxiedUrl(s)).then((r) => {
        if (usePlayerStore.getState().source !== s) return;
        if (!r) {
          failRef.current(s, { kind, fatal: true, message });
          return;
        }
        const refused = r.reason ? withReason(message, r.reason, r.status) : `${message} (HTTP ${r.status})`;
        failRef.current(s, { kind: 'network', fatal: true, message: refused });
      });
    };
    const onEnterPip = (): void => useMediaStore.setState({ inPip: true });
    const onLeavePip = (): void => useMediaStore.setState({ inPip: false });

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('durationchange', onTime);
    el.addEventListener('progress', onTime);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('pause', onPause);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('volumechange', onVolume);
    el.addEventListener('ratechange', onRate);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.addEventListener('enterpictureinpicture', onEnterPip);
    el.addEventListener('leavepictureinpicture', onLeavePip);

    const unController = setController({
      play: () => void el.play().catch(() => undefined),
      pause: () => el.pause(),
      seekTo: (s) => {
        if (Number.isFinite(s)) el.currentTime = Math.max(0, s - offset());
      },
      setVolume: (v) => {
        el.volume = v;
      },
      setMuted: (m) => {
        el.muted = m;
      },
    });
    const canPip = as === 'video' && typeof document !== 'undefined' && !!document.pictureInPictureEnabled;
    useMediaStore.setState({ canPip });
    const unCommands = setMediaCommands({
      setQuality: (id) => engineRef.current?.setQuality(id),
      setAudio: (id) => engineRef.current?.setAudio(id),
      // Engine tracks and loaded subtitle files (`ext:<n>`) alike.
      setText: (id) => {
        selectText(el, engineRef.current, id);
        publishTracks();
        useMediaStore.setState({ captionsOn: id !== null });
      },
      setRate: (r) => {
        el.playbackRate = r;
      },
      togglePip: () => {
        if (!canPip) return;
        if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
        else void (el as HTMLVideoElement).requestPictureInPicture().catch(() => undefined);
      },
      retry: () => setRetryNonce((n) => n + 1),
    });
    // Subtitle delay (Sync menu) and the stream info overlay.
    const unExtras = bindInlineExtras(el, () => engineRef.current);
    // Subtitle files load into this element; the player draws every subtitle track itself, in
    // the user's style and position (C6). Video only.
    let unTarget: () => void = () => undefined;
    let unCues: () => void = () => undefined;
    let unmounted = false;
    const subs = subsRef.current;
    if (as === 'video') {
      unTarget = setInlineSubtitleTarget({ el, engine: () => engineRef.current, publish: () => publishTracks() });
      if (subs) {
        void import('../subtitles/inline')
          .then((m) => {
            if (!unmounted) unCues = m.bindSubtitleOverlay(el, subs);
          })
          .catch(() => undefined);
      }
    }

    return () => {
      if (graceTimer) clearTimeout(graceTimer);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('durationchange', onTime);
      el.removeEventListener('progress', onTime);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('volumechange', onVolume);
      el.removeEventListener('ratechange', onRate);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.removeEventListener('enterpictureinpicture', onEnterPip);
      el.removeEventListener('leavepictureinpicture', onLeavePip);
      unController();
      unCommands();
      unExtras();
      unmounted = true;
      unCues();
      unTarget();
      if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => undefined);
    };
  }, [as]);

  const retry = useCallback(() => {
    // No media yet (the stream URL lookup failed): look it up again instead of reloading nothing.
    if (retryResolve()) return;
    reportStatus('loading');
    setRetryNonce((n) => n + 1);
  }, []);

  const ambient = !!settings?.playerAmbientMode;
  const Tag = as;

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-black', className)}>
      {art.url && (
        // Ambient: a quarter-size copy scaled up under a small blur (C5), never a full-size blur.
        // Without ambient mode it stays hidden and only tells `art` when the poster fails to load.
        <img
          src={art.url}
          alt=""
          aria-hidden
          onError={art.onError}
          className={ambient ? cn('pointer-events-none opacity-45 saturate-150', QUARTER_BLUR) : 'hidden'}
        />
      )}
      <Tag
        ref={elRef}
        playsInline
        preload="auto"
        className={cn('relative h-full w-full object-contain', as === 'audio' && 'hidden')}
        poster={art.url}
        // Found by the screenshot code (C6), which draws this frame on a canvas.
        data-player-video={as === 'video' ? '' : undefined}
      />
      {as === 'video' && (
        <canvas ref={holdRef} data-zap-hold="" hidden aria-hidden className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
      )}
      {as === 'video' && <div ref={subsRef} data-subtitle-overlay aria-hidden className="player-subs" />}
      {status === 'loading' && <ConnectingNotice source={source} compact={compact} />}
      {status === 'error' && (
        <ErrorOverlay
          message={error}
          kind={errorKind}
          source={source}
          onRetry={retry}
          openExternalAvailable={isDesktop}
          compact={compact}
          tight={short}
        />
      )}
    </div>
  );
}

function ErrorOverlay({
  message,
  kind,
  source,
  onRetry,
  openExternalAvailable,
  compact,
  tight,
}: {
  message?: string;
  kind: EngineError['kind'] | null;
  source?: PlayerSource;
  onRetry(): void;
  openExternalAvailable: boolean;
  compact: boolean;
  /** Short player: one-line headline, two lines of hint, small buttons, the details in the headline's tooltip. */
  tight: boolean;
}) {
  const { t } = useTranslation('player');
  const { toast } = useToast();
  const retryRef = useRef<HTMLButtonElement>(null);
  const view = useStreamError(kind);
  useRetryWhenOnline(view.cls, onRetry);
  // Keyboard users land on Retry instead of hunting for it (only when the player has focus).
  useEffect(() => focusIfPlayerOwnsFocus(retryRef.current), []);
  // Raw TS only fails for lack of MSE when mpegts.js could not run at all.
  const isRawTs = !!source && looksLikeMpegTs(source) && !mseSupported();
  const hint = isRawTs ? t('errorTsLive') : view.hint;
  const hasMedia = !!source?.url;

  if (compact) {
    return (
      <div
        role="alert"
        data-error-class={view.cls}
        className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/80 p-3 text-center text-white"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <p className="flex max-w-full items-center gap-1.5 text-sm font-medium" title={message ? `${view.title}: ${message}` : hint}>
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
          <span className="truncate">{view.title}</span>
        </p>
        <button
          ref={retryRef}
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {t('retry')}
        </button>
      </div>
    );
  }

  /** Browser mode cannot launch players: hand the user the link for VLC or MPV instead. */
  const copyLink = async (): Promise<void> => {
    if (!source || !canShareSource(source)) return;
    try {
      await navigator.clipboard.writeText(source.url);
      toast({ title: t('streamLinkCopied'), description: t('streamLinkCopiedHint'), variant: 'success' });
    } catch {
      toast({ title: t('streamLinkCopyFailed'), variant: 'error' });
    }
  };

  const openExternal = async (player: 'mpv' | 'vlc'): Promise<void> => {
    if (!source) return;
    try {
      await rpc('player.openExternal', { player, source });
      usePlayerStore.getState().stop();
    } catch (err) {
      toast({
        title: t('externalFailed'),
        description: `${err instanceof Error ? err.message : ''} ${t('externalFailedHint')}`.trim(),
        variant: 'error',
      });
    }
  };

  // Buttons and their icons, smaller in a short player.
  const action = tight ? 'gap-1.5 px-2.5 py-1 text-xs' : 'gap-2 px-3 py-1.5 text-sm';
  const actionIcon = tight ? 'size-3.5' : 'size-4';

  return (
    // Bottom room for the control bar, which stays up over an error and paints above this. Top
    // room for the player's title bar (a short player hides that title instead), and m-auto
    // centering: what does not fit scrolls from its top instead of pushing up under the title.
    <div
      role="alert"
      data-error-class={view.cls}
      data-tight={tight || undefined}
      className={cn(
        'pointer-events-auto absolute inset-0 z-20 flex overflow-y-auto bg-black/80 text-white',
        tight ? 'px-4 pt-3 pb-14' : 'px-6 pt-14 pb-16',
      )}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={cn('m-auto flex max-w-md flex-col items-start', tight ? 'gap-1.5' : 'gap-3')}>
        {tight ? (
          <h2 className="flex max-w-full items-center gap-2 font-display text-sm" title={message ? `${view.title}: ${message}` : undefined}>
            <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
            <span className="truncate">{view.title}</span>
          </h2>
        ) : (
          <>
            <AlertTriangle className="size-7 text-warning" aria-hidden />
            <h2 className="font-display text-lg">{view.title}</h2>
          </>
        )}
        <p className={cn('text-white/80', tight ? 'line-clamp-2 text-xs' : 'text-sm')}>{hint}</p>
        {message && !tight && (
          // What the engine said, for a bug report or a provider ticket: out of the way until asked for.
          <details className="group w-full text-xs text-white/60">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm select-none hover:text-white/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
              {t('errorDetails')}
            </summary>
            <p className="mt-1.5 pl-4.5 font-mono break-all select-all">{message}</p>
          </details>
        )}
        <div className="mt-1 flex flex-wrap gap-2">
          <button
            ref={retryRef}
            type="button"
            onClick={onRetry}
            className={cn('inline-flex items-center rounded-md bg-accent font-medium text-accent-fg hover:bg-accent-hover', action)}
          >
            <RotateCcw className={actionIcon} aria-hidden />
            {t('retry')}
          </button>
          {!openExternalAvailable && hasMedia && source && canShareSource(source) && (
            <button
              type="button"
              onClick={() => void copyLink()}
              className={cn('inline-flex items-center rounded-md border border-white/25 hover:bg-white/10', action)}
            >
              <Copy className={actionIcon} aria-hidden />
              {t('copyStreamLink')}
            </button>
          )}
          {openExternalAvailable && hasMedia && (
            <>
              <button
                type="button"
                onClick={() => void openExternal('mpv')}
                className={cn('inline-flex items-center rounded-md border border-white/25 hover:bg-white/10', action)}
              >
                <ExternalLink className={actionIcon} aria-hidden />
                {t('openInMpv')}
              </button>
              <button
                type="button"
                onClick={() => void openExternal('vlc')}
                className={cn('inline-flex items-center rounded-md border border-white/25 hover:bg-white/10', action)}
              >
                <ExternalLink className={actionIcon} aria-hidden />
                {t('openInVlc')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A start that takes longer than usual (`reconnect.ts` SLOW_START_MS): say it is still coming,
 * under the loading dial, and offer another copy of a live channel right away instead of making
 * the user wait out the start timeout.
 */
function ConnectingNotice({ source, compact }: { source?: PlayerSource | undefined; compact: boolean }) {
  const { t } = useTranslation('player');
  const settings = usePlayerSettings();
  const connecting = useReconnectStore((s) => s.phase === 'connecting');
  const key = source?.isLive && source.ref ? itemKey(source.ref) : undefined;
  const alternates = useAlternatesStore((s) => s.status === 'ready' && !!key && s.forKey === key && !!s.data?.alternates.length);
  const [busy, setBusy] = useState(false);
  if (!connecting || !source?.url) return null;
  const offerSwitch = !compact && alternates && settings?.liveFailover !== false;
  const onSwitch = (): void => {
    setBusy(true);
    void tryAnotherSource().finally(() => setBusy(false));
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex justify-center pt-12">
      <p
        role="status"
        aria-live="polite"
        data-testid="connecting-notice"
        className={cn(
          'player-glass-strong inline-flex max-w-[90%] items-center gap-2 rounded-full border py-1',
          offerSwitch ? 'pr-1 pl-3' : 'px-3',
          compact ? 'text-xs' : 'text-sm',
        )}
      >
        <span className="truncate">{t('stillConnecting')}</span>
        {offerSwitch && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onSwitch();
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
