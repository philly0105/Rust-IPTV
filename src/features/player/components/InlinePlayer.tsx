import { AlertTriangle, Copy, ExternalLink, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { proxiedUrl, isDesktop, rpc } from '@/api/transport';
import type { PlayerSource } from '@/api/types';

import { useToast } from '../_shim';
import { cn } from '../cn';
import {
  createEngine,
  EMPTY_TRACKS,
  looksLikeMpegTs,
  mseSupported,
  worthSniffingAsMpegTs,
  type Engine,
  type EngineError,
} from '../engines';
import { tryFailover } from '../failover';
import { safeImageUrl } from '../format';
import { setMediaCommands, useMediaStore, type TimeRange } from '../media';
import {
  handleEnded,
  reportProgress,
  reportStatus,
  reportVolume,
  setController,
  usePlayerStore,
} from '../store';
import { usePlayerSettings } from '../useSettings';

/** Stable identity for "the same media": a source swap with the same url keeps the engine. */
function mediaKey(s: PlayerSource | undefined): string {
  return s ? `${s.kind}|${s.url}` : '';
}

function rangesOf(tr: TimeRanges): TimeRange[] {
  const out: TimeRange[] = [];
  for (let i = 0; i < tr.length; i++) out.push({ start: tr.start(i), end: tr.end(i) });
  return out;
}

export interface InlinePlayerProps {
  /** Audio element for radio; video otherwise. */
  as?: 'video' | 'audio';
  className?: string;
}

/**
 * The media element plus its engine. Reports progress/status into the store and
 * registers itself as the store's PlaybackController. Chrome is rendered by the caller.
 */
export function InlinePlayer({ as = 'video', className }: InlinePlayerProps) {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  const error = usePlayerStore((s) => s.error);
  const settings = usePlayerSettings();
  const { toast } = useToast();
  const elRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [errorKind, setErrorKind] = useState<EngineError['kind'] | null>(null);
  /** Media key that the element rejected and that now goes through mpegts.js instead. */
  const sniffedRef = useRef<string | null>(null);
  const key = mediaKey(source);
  const captionsDefault = settings?.showCaptions ?? false;

  /** Fatal error: show the overlay, then try one automatic switch to the same title elsewhere. */
  const failRef = useRef<(src: PlayerSource, err: EngineError) => void>(() => undefined);
  failRef.current = (src, err) => {
    setErrorKind(err.kind);
    reportStatus('error', err.message);
    void tryFailover(src).then((res) => {
      if (!res) return;
      toast({
        title: t('failoverSwitched'),
        description: t('failoverSwitchedDetail', { title: src.title, source: res.sourceName }),
        variant: 'info',
        action: { label: t('undo'), onClick: res.undo },
      });
    });
  };

  // Engine lifecycle: one per media url (and per retry).
  useEffect(() => {
    const el = elRef.current;
    const src = usePlayerStore.getState().source;
    if (!el || !src || !src.url) return;
    let disposed = false;
    const abort = new AbortController();
    setErrorKind(null);
    useMediaStore.setState({ tracks: EMPTY_TRACKS, buffered: [], seekable: undefined, waiting: true });
    const loadUrl = proxiedUrl(src);

    const onFatal = (err: EngineError): void => {
      if (!disposed) failRef.current(src, err);
    };

    void createEngine(
      el,
      src,
      loadUrl,
      {
        onTracks: (tracks) => {
          if (!disposed) useMediaStore.setState({ tracks });
        },
        onError: onFatal,
      },
      { captions: captionsDefault, signal: abort.signal, forceMpegts: sniffedRef.current === mediaKey(src) },
    ).then((engine) => {
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
      abort.abort();
      el.removeEventListener('loadedmetadata', onMeta);
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // The engine is rebuilt only when the media itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryNonce]);

  // Media element -> store.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let lastBufferedAt = 0;
    const isLive = (): boolean => !!usePlayerStore.getState().source?.isLive;
    const onTime = (): void => {
      const dur = Number.isFinite(el.duration) && !isLive() ? el.duration : undefined;
      reportProgress(el.currentTime, dur);
      const now = performance.now();
      if (now - lastBufferedAt > 1000) {
        lastBufferedAt = now;
        const seek = el.seekable.length ? { start: el.seekable.start(0), end: el.seekable.end(el.seekable.length - 1) } : undefined;
        useMediaStore.setState({ buffered: rangesOf(el.buffered), seekable: isLive() ? seek : undefined });
      }
    };
    const onPlaying = (): void => {
      useMediaStore.setState({ waiting: false });
      reportStatus('playing');
    };
    const onPause = (): void => {
      if (!el.ended) reportStatus('paused');
    };
    const onWaiting = (): void => useMediaStore.setState({ waiting: true });
    const onVolume = (): void => reportVolume(el.volume, el.muted);
    const onRate = (): void => useMediaStore.setState({ rate: el.playbackRate });
    const onEnded = (): void => {
      if (!isLive()) handleEnded();
    };
    const onError = (): void => {
      // Native element errors only: hls.js, shaka and mpegts.js report their own.
      const s = usePlayerStore.getState().source;
      if (!s || !el.error) return;
      const engineKind = engineRef.current?.kind;
      if (engineKind ? engineKind !== 'native' : s.kind === 'hls' || s.kind === 'dash' || looksLikeMpegTs(s)) return;
      const code = el.error.code;
      // An extensionless stream the element cannot play is often raw MPEG-TS: one retry through mpegts.js.
      const k = mediaKey(s);
      if (code === 4 && sniffedRef.current !== k && mseSupported() && worthSniffingAsMpegTs(s)) {
        sniffedRef.current = k;
        setRetryNonce((n) => n + 1);
        return;
      }
      const kind = code === 2 ? 'network' : code === 4 ? 'unsupported' : 'media';
      failRef.current(s, { kind, fatal: true, message: el.error.message || `Media error ${code}` });
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
        if (Number.isFinite(s)) el.currentTime = s;
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
      setText: (id) => {
        engineRef.current?.setText(id);
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

    return () => {
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
      if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => undefined);
    };
  }, [as]);

  const retry = useCallback(() => {
    reportStatus('loading');
    setRetryNonce((n) => n + 1);
  }, []);

  const ambient = settings?.playerAmbientMode && source && !source.isLive && as === 'video' ? safeImageUrl(source.posterUrl) : undefined;
  const Tag = as;

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-black', className)}>
      {ambient && (
        <img
          src={ambient}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-45 blur-3xl saturate-150"
        />
      )}
      <Tag
        ref={elRef}
        playsInline
        preload="auto"
        className={cn('relative h-full w-full object-contain', as === 'audio' && 'hidden')}
        poster={as === 'video' && source && !source.isLive ? safeImageUrl(source.posterUrl) : undefined}
      />
      {status === 'error' && (
        <ErrorOverlay
          message={error}
          kind={errorKind}
          source={source}
          onRetry={retry}
          openExternalAvailable={isDesktop}
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
}: {
  message?: string;
  kind: EngineError['kind'] | null;
  source?: PlayerSource;
  onRetry(): void;
  openExternalAvailable: boolean;
}) {
  const { t } = useTranslation('player');
  const { toast } = useToast();
  // Raw TS only fails for lack of MSE when mpegts.js could not run at all.
  const isRawTs = !!source && looksLikeMpegTs(source) && !mseSupported();
  const hint = isRawTs
    ? t('errorTsLive')
    : kind === 'network'
      ? t('errorNetwork')
      : kind === 'media'
        ? t('errorMedia')
        : kind === 'unsupported'
          ? t('errorUnsupported')
          : t('errorGeneric');

  /** Browser mode cannot launch players: hand the user the link for VLC or MPV instead. */
  const copyLink = async (): Promise<void> => {
    if (!source) return;
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

  return (
    <div
      role="alert"
      className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-6 text-white"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="flex max-w-md flex-col items-start gap-3">
        <AlertTriangle className="size-7 text-warning" aria-hidden />
        <h2 className="font-display text-lg">{t('errorTitle')}</h2>
        <p className="text-sm text-white/80">{hint}</p>
        {message && <p className="font-mono text-xs break-all text-white/70">{message}</p>}
        <div className="mt-1 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            <RotateCcw className="size-4" aria-hidden />
            {t('retry')}
          </button>
          {!openExternalAvailable && source && /^https?:/i.test(source.url) && (
            <button
              type="button"
              onClick={() => void copyLink()}
              className="inline-flex items-center gap-2 rounded-md border border-white/25 px-3 py-1.5 text-sm hover:bg-white/10"
            >
              <Copy className="size-4" aria-hidden />
              {t('copyStreamLink')}
            </button>
          )}
          {openExternalAvailable && (
            <>
              <button
                type="button"
                onClick={() => void openExternal('mpv')}
                className="inline-flex items-center gap-2 rounded-md border border-white/25 px-3 py-1.5 text-sm hover:bg-white/10"
              >
                <ExternalLink className="size-4" aria-hidden />
                {t('openInMpv')}
              </button>
              <button
                type="button"
                onClick={() => void openExternal('vlc')}
                className="inline-flex items-center gap-2 rounded-md border border-white/25 px-3 py-1.5 text-sm hover:bg-white/10"
              >
                <ExternalLink className="size-4" aria-hidden />
                {t('openInVlc')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
