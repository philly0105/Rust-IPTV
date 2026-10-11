/**
 * Media engines for inline playback. One engine per (element, source) pair:
 * hls.js for `hls`, shaka for `dash`, mpegts.js for raw MPEG-TS (`.ts`, `video/mp2t`)
 * when Media Source Extensions exist, the element itself for other `direct`/`file`.
 * hls.js, shaka and mpegts.js are code-split; a direct mp4 never loads any of them.
 */

import type { PlayerSource } from '@/api/types';

export interface TrackOption {
  id: string;
  label: string;
  selected: boolean;
}

export interface EngineTracks {
  /** Video renditions; only reported when there is more than one. `auto` is implied. */
  qualities: TrackOption[];
  qualityAuto: boolean;
  audio: TrackOption[];
  text: TrackOption[];
}

export interface EngineError {
  message: string;
  fatal: boolean;
  /** Network or media error class, for the error overlay copy. */
  kind: 'network' | 'media' | 'unsupported' | 'other';
}

export interface EngineCallbacks {
  onTracks(tracks: EngineTracks): void;
  onError(err: EngineError): void;
}

export interface Engine {
  /** Which library drives the element. Only `native` errors surface through the element's `error` event. */
  readonly kind: 'native' | 'hls' | 'dash' | 'mpegts';
  setQuality(id: string | 'auto'): void;
  setAudio(id: string): void;
  /** `null` turns captions off. */
  setText(id: string | null): void;
  /** Recover after a non-fatal stall: hls.js `recoverMediaError`/`startLoad`. */
  recover(): void;
  destroy(): void;
}

export const EMPTY_TRACKS: EngineTracks = { qualities: [], qualityAuto: true, audio: [], text: [] };

/** Returned when the caller gave up while a library was loading: it must not touch the element. */
const NOOP_ENGINE: Engine = { kind: 'native', setQuality() {}, setAudio() {}, setText() {}, recover() {}, destroy() {} };

/** "1080p", a 16:9 projection from width, else the bitrate. Collisions get a bitrate suffix. */
export function qualityLabels(levels: { height?: number; width?: number; bitrate?: number }[]): string[] {
  const base = levels.map((l) => {
    if (l.height) return `${l.height}p`;
    if (l.width) return `${Math.round((l.width * 9) / 16)}p`;
    if (l.bitrate) return formatBitrate(l.bitrate);
    return '?';
  });
  return base.map((label, i) => {
    const dup = base.filter((b) => b === label).length > 1;
    const br = levels[i]?.bitrate;
    return dup && br ? `${label} (${formatBitrate(br)})` : label;
  });
}

export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

function langLabel(lang: string | undefined, name: string | undefined, fallback: string): string {
  if (name && name.trim()) return name;
  if (lang) {
    try {
      const dn = new Intl.DisplayNames(undefined, { type: 'language' });
      return dn.of(lang) ?? lang;
    } catch {
      return lang;
    }
  }
  return fallback;
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

/**
 * When the playlist goes through the same-origin `/api/proxy`, every follow-up
 * request (keys, absolute segment URLs the proxy did not rewrite) must go through it too,
 * or the browser hits the upstream without the source headers.
 */
export function proxyRewrite(source: PlayerSource, loadUrl: string): ((url: string) => string) | null {
  if (!loadUrl.startsWith('/api/proxy')) return null;
  const sourceId = source.ref?.sourceId;
  return (url: string) => {
    if (isSameOrigin(url)) return url;
    const params = new URLSearchParams({ url });
    if (sourceId) params.set('sourceId', sourceId);
    return `/api/proxy?${params.toString()}`;
  };
}

// ---------------------------------------------------------------------------
// Native element
// ---------------------------------------------------------------------------

/** Which engine last attached to an element; a stale native engine must not reset it on destroy. */
const nativeOwner = new WeakMap<HTMLMediaElement, object>();

function nativeEngine(el: HTMLMediaElement, url: string, cb: EngineCallbacks): Engine {
  const owner = {};
  nativeOwner.set(el, owner);
  el.src = url;
  const emitTracks = (): void => {
    const audio: TrackOption[] = [];
    const audioTracks = (el as HTMLMediaElement & { audioTracks?: ArrayLike<{ id: string; label: string; language: string; enabled: boolean }> }).audioTracks;
    if (audioTracks && audioTracks.length > 1) {
      for (let i = 0; i < audioTracks.length; i++) {
        const t = audioTracks[i];
        if (t) audio.push({ id: String(i), label: langLabel(t.language, t.label, `Audio ${i + 1}`), selected: t.enabled });
      }
    }
    const text: TrackOption[] = [];
    for (let i = 0; i < el.textTracks.length; i++) {
      const t = el.textTracks[i];
      if (t && (t.kind === 'subtitles' || t.kind === 'captions')) {
        text.push({ id: String(i), label: langLabel(t.language, t.label, `Subtitle ${i + 1}`), selected: t.mode === 'showing' });
      }
    }
    cb.onTracks({ qualities: [], qualityAuto: true, audio, text });
  };
  el.addEventListener('loadedmetadata', emitTracks);
  el.textTracks.addEventListener?.('addtrack', emitTracks);
  return {
    kind: 'native',
    setQuality() {},
    setAudio(id) {
      const tracks = (el as HTMLMediaElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }).audioTracks;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t) t.enabled = String(i) === id;
      }
      emitTracks();
    },
    setText(id) {
      for (let i = 0; i < el.textTracks.length; i++) {
        const t = el.textTracks[i];
        if (t) t.mode = String(i) === id ? 'showing' : 'disabled';
      }
      emitTracks();
    },
    recover() {
      const t = el.currentTime;
      el.load();
      if (t > 0) el.currentTime = t;
      void el.play().catch(() => undefined);
    },
    destroy() {
      el.removeEventListener('loadedmetadata', emitTracks);
      el.textTracks.removeEventListener?.('addtrack', emitTracks);
      if (nativeOwner.get(el) !== owner) return;
      nativeOwner.delete(el);
      el.removeAttribute('src');
      el.load();
    },
  };
}

// ---------------------------------------------------------------------------
// hls.js
// ---------------------------------------------------------------------------

async function hlsEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  url: string,
  cb: EngineCallbacks,
  wantCaptions: boolean,
  signal?: AbortSignal,
): Promise<Engine> {
  const { default: Hls } = await import('hls.js');
  // A superseded engine attaching late would detach the newer engine's MediaSource on destroy.
  if (signal?.aborted) return NOOP_ENGINE;
  nativeOwner.set(el, {});
  if (!Hls.isSupported()) {
    // Safari / platforms with native HLS.
    if (el.canPlayType('application/vnd.apple.mpegurl')) return nativeEngine(el, url, cb);
    cb.onError({ message: 'HLS is not supported in this browser', fatal: true, kind: 'unsupported' });
    return nativeEngine(el, url, cb);
  }
  const rewrite = proxyRewrite(source, url);
  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: source.isLive ? 30 : 90,
    startPosition: !source.isLive && source.resumeSeconds ? source.resumeSeconds : -1,
    // Bounded retries with backoff, then a fatal error the overlay can act on.
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 60_000,
        timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000 },
        errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 8000 },
      },
    },
    renderTextTracksNatively: true,
    xhrSetup: rewrite
      ? (xhr: XMLHttpRequest, reqUrl: string) => {
          const target = rewrite(reqUrl);
          if (target !== reqUrl) xhr.open('GET', target, true);
        }
      : undefined,
  });

  let manualLevel = -1;
  let mediaRecoveries = 0;
  const emit = (): void => {
    const levels = hls.levels ?? [];
    const labels = qualityLabels(levels.map((l) => ({ height: l.height, width: l.width, bitrate: l.bitrate })));
    const qualities: TrackOption[] =
      levels.length > 1
        ? levels.map((_, i) => ({ id: String(i), label: labels[i] ?? String(i), selected: manualLevel === i }))
        : [];
    const audio: TrackOption[] =
      hls.audioTracks.length > 1
        ? hls.audioTracks.map((t, i) => ({
            id: String(i),
            label: langLabel(t.lang, t.name, `Audio ${i + 1}`),
            selected: hls.audioTrack === i,
          }))
        : [];
    const text: TrackOption[] = hls.subtitleTracks.map((t, i) => ({
      id: String(i),
      label: langLabel(t.lang, t.name, `Subtitle ${i + 1}`),
      selected: hls.subtitleDisplay && hls.subtitleTrack === i,
    }));
    cb.onTracks({ qualities, qualityAuto: manualLevel < 0, audio, text });
  };

  hls.on(Hls.Events.MANIFEST_PARSED, emit);
  hls.on(Hls.Events.LEVELS_UPDATED, emit);
  hls.on(Hls.Events.LEVEL_SWITCHED, emit);
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, emit);
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, emit);
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, emit);
  hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, emit);
  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
      mediaRecoveries++;
      hls.recoverMediaError();
      return;
    }
    const kind = data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'media' : 'other';
    const status = data.response?.code ? ` (HTTP ${data.response.code})` : '';
    cb.onError({ message: `${data.details}${status}`, fatal: true, kind });
  });

  hls.subtitleDisplay = wantCaptions;
  hls.loadSource(url);
  hls.attachMedia(el);

  return {
    kind: 'hls',
    setQuality(id) {
      manualLevel = id === 'auto' ? -1 : Number(id);
      // nextLevel switches at the next fragment without flushing the buffer.
      hls.nextLevel = manualLevel;
      emit();
    },
    setAudio(id) {
      hls.audioTrack = Number(id);
    },
    setText(id) {
      if (id === null) {
        hls.subtitleDisplay = false;
        hls.subtitleTrack = -1;
      } else {
        hls.subtitleDisplay = true;
        hls.subtitleTrack = Number(id);
      }
      emit();
    },
    recover() {
      mediaRecoveries = 0;
      hls.startLoad();
      hls.recoverMediaError();
    },
    destroy() {
      hls.destroy();
      el.removeAttribute('src');
    },
  };
}

// ---------------------------------------------------------------------------
// shaka (DASH)
// ---------------------------------------------------------------------------

async function shakaEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  url: string,
  cb: EngineCallbacks,
  wantCaptions: boolean,
  signal?: AbortSignal,
): Promise<Engine> {
  const { default: shaka } = await import('shaka-player');
  if (signal?.aborted) return NOOP_ENGINE;
  nativeOwner.set(el, {});
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    cb.onError({ message: 'DASH is not supported in this browser', fatal: true, kind: 'unsupported' });
    return nativeEngine(el, url, cb);
  }
  const player = new shaka.Player();
  let destroyed = false;
  let manual = false;
  player.configure({
    streaming: { retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, timeout: 20_000 } },
    manifest: { retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, timeout: 20_000 } },
  });
  const rewrite = proxyRewrite(source, url);
  if (rewrite) {
    player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
      request.uris = request.uris.map(rewrite);
    });
  }

  const emit = (): void => {
    if (destroyed) return;
    const variants = player.getVariantTracks();
    const active = variants.find((v) => v.active);
    // Quality options pinned to the active audio stream so picking a quality never switches audio.
    const pinned = variants
      .filter((v) => (active?.audioId != null ? v.audioId === active.audioId : v.language === active?.language))
      .sort((a, b) => (a.height ?? 0) - (b.height ?? 0) || a.bandwidth - b.bandwidth);
    const labels = qualityLabels(pinned.map((v) => ({ height: v.height ?? undefined, width: v.width ?? undefined, bitrate: v.bandwidth })));
    const qualities: TrackOption[] =
      pinned.length > 1 ? pinned.map((v, i) => ({ id: String(v.id), label: labels[i] ?? String(v.id), selected: manual && v.active })) : [];
    const langs = player.getAudioLanguagesAndRoles();
    const audio: TrackOption[] =
      langs.length > 1
        ? langs.map((l) => ({
            id: `${l.language}|${l.role}`,
            label: langLabel(l.language, l.label ?? undefined, l.language),
            selected: active?.language === l.language && (!l.role || active?.roles.includes(l.role)),
          }))
        : [];
    const visible = player.isTextTrackVisible();
    const text: TrackOption[] = player.getTextTracks().map((t) => ({
      id: String(t.id),
      label: langLabel(t.language, t.label ?? undefined, t.language),
      selected: visible && t.active,
    }));
    cb.onTracks({ qualities, qualityAuto: !manual, audio, text });
  };

  player.addEventListener('trackschanged', emit);
  player.addEventListener('variantchanged', emit);
  player.addEventListener('adaptation', emit);
  player.addEventListener('texttrackvisibility', emit);
  player.addEventListener('error', (e) => {
    const detail = (e as unknown as { detail?: { severity?: number; code?: number; category?: number } }).detail;
    const fatal = detail?.severity === shaka.util.Error.Severity.CRITICAL;
    if (!fatal) return;
    const kind = detail?.category === shaka.util.Error.Category.NETWORK ? 'network' : 'media';
    cb.onError({ message: `Shaka error ${detail?.code ?? ''}`.trim(), fatal: true, kind });
  });

  await player.attach(el as HTMLMediaElement);
  try {
    await player.load(url, !source.isLive && source.resumeSeconds ? source.resumeSeconds : null);
    if (wantCaptions) await player.setTextTrackVisibility(true);
    emit();
  } catch (err) {
    if (!destroyed) {
      const code = (err as { code?: number }).code;
      cb.onError({ message: `Could not load the DASH manifest${code ? ` (${code})` : ''}`, fatal: true, kind: 'network' });
    }
  }

  return {
    kind: 'dash',
    setQuality(id) {
      if (id === 'auto') {
        manual = false;
        player.configure({ abr: { enabled: true } });
      } else {
        const track = player.getVariantTracks().find((v) => String(v.id) === id);
        if (!track) return;
        manual = true;
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(track, true);
      }
      emit();
    },
    setAudio(id) {
      const [lang = '', role = ''] = id.split('|');
      player.selectAudioLanguage(lang, role || undefined);
    },
    setText(id) {
      if (id === null) {
        void player.setTextTrackVisibility(false);
      } else {
        const t = player.getTextTracks().find((x) => String(x.id) === id);
        if (t) player.selectTextTrack(t);
        void player.setTextTrackVisibility(true);
      }
    },
    recover() {
      void player.retryStreaming();
    },
    destroy() {
      destroyed = true;
      void player.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// mpegts.js (raw MPEG-TS over HTTP)
// ---------------------------------------------------------------------------

const TS_PATH = /\.(ts|mts|m2ts|trp)$/i;
const TS_QUERY = /[?&](output|extension|container|type)=(ts|mpegts|mp2t)(&|$)/i;
/** Containers the element plays (or rejects) on its own; never sniffed as MPEG-TS. */
const KNOWN_NON_TS = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mp3|m4a|aac|ogg|oga|opus|flac|wav|m3u8?|mpd)$/i;

function urlPath(url: string): string {
  return url.split(/[?#]/)[0] ?? '';
}

/** A `direct`/`file` source whose URL says MPEG-TS (`.ts`, `?output=ts`). */
export function looksLikeMpegTs(source: Pick<PlayerSource, 'kind' | 'url'>): boolean {
  if (source.kind !== 'direct' && source.kind !== 'file') return false;
  return TS_PATH.test(urlPath(source.url)) || TS_QUERY.test(source.url);
}

/**
 * After the element rejected a `direct` source as unsupported: is one more try through
 * mpegts.js worth it? Extensionless IPTV URLs (`/live/u/p/123`) usually serve `video/mp2t`.
 */
export function worthSniffingAsMpegTs(source: Pick<PlayerSource, 'kind' | 'url'>): boolean {
  if (source.kind !== 'direct' && source.kind !== 'file') return false;
  if (looksLikeMpegTs(source)) return false;
  return !KNOWN_NON_TS.test(urlPath(source.url));
}

/** Media Source Extensions, which mpegts.js needs to feed the element. */
export function mseSupported(): boolean {
  return typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window);
}

/** Live restarts (stream closed, network drop) allowed before the error surfaces. */
export const TS_MAX_RESTARTS = 4;
/** Playback this long without trouble refills the restart budget. */
export const TS_STABLE_MS = 20_000;

/** Backoff before restart `n` (1-based): 0.5 s, 1 s, 2 s, 4 s, capped at 8 s. */
export function tsRestartDelay(n: number): number {
  return Math.min(8000, 500 * 2 ** Math.max(0, n - 1));
}

const CLOSED_LIVE: EngineError = { message: 'The live stream closed the connection', fatal: true, kind: 'network' };

async function mpegtsEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  url: string,
  cb: EngineCallbacks,
  signal?: AbortSignal,
): Promise<Engine> {
  const { default: mpegts } = await import('mpegts.js');
  // A superseded engine attaching late would steal the element from the newer one.
  if (signal?.aborted) return NOOP_ENGINE;
  if (!mpegts.isSupported() || (source.isLive && !mpegts.getFeatureList().mseLivePlayback)) {
    // No MSE here: the element gets one honest try; its error names the external players.
    return nativeEngine(el, url, cb);
  }
  try {
    mpegts.LoggingControl.applyConfig({ enableVerbose: false, enableDebug: false, enableInfo: false, enableWarn: false });
  } catch {
    // builds without LoggingControl
  }
  nativeOwner.set(el, {});
  cb.onTracks(EMPTY_TRACKS);

  type TsPlayer = ReturnType<typeof mpegts.createPlayer>;
  const absolute = new URL(url, window.location.href).href;
  const isLive = source.isLive;
  let player: TsPlayer | null = null;
  let destroyed = false;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let loadComplete = false;

  const config: Parameters<typeof mpegts.createPlayer>[1] = {
    enableWorker: true,
    // Live: low-latency reads. No latency chasing: servers that burst their buffer on connect
    // (or serve a whole loop at once) would be skipped to the last seconds, then end and reconnect.
    enableStashBuffer: !isLive,
    liveBufferLatencyChasing: false,
    // Hours-long sessions must not sit at the SourceBuffer quota.
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 60,
    autoCleanupMinBackwardDuration: 30,
    lazyLoad: !isLive,
    lazyLoadMaxDuration: 60,
    reuseRedirectedURL: true,
  };

  /** Real playback progress (not loader stats): after TS_STABLE_MS of it the restart budget refills. */
  const markStable = (): void => {
    if (stableTimer || destroyed || el.paused) return;
    stableTimer = setTimeout(() => {
      stableTimer = null;
      restarts = 0;
    }, TS_STABLE_MS);
  };

  const teardown = (p: TsPlayer): void => {
    try {
      p.unload();
      p.detachMediaElement();
      p.destroy();
    } catch {
      // already torn down
    }
  };

  const fail = (err: EngineError): void => {
    if (!destroyed) cb.onError(err);
  };

  const start = (): void => {
    loadComplete = false;
    const p = mpegts.createPlayer({ type: 'mpegts', isLive, url: absolute, cors: true }, config);
    player = p;
    p.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number; msg?: string }) => {
      if (player !== p || destroyed) return;
      const http = info?.code && info.code > 0 ? ` (HTTP ${info.code})` : '';
      const message = `${detail || type}${http}`;
      if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
        // A 4xx will not fix itself; anything else gets bounded restarts.
        if (info?.code && info.code >= 400 && info.code < 500) fail({ message, fatal: true, kind: 'network' });
        else restart({ message, fatal: true, kind: 'network' });
        return;
      }
      if (type === mpegts.ErrorTypes.MEDIA_ERROR) {
        const unsupported =
          detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED || detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED;
        fail({ message, fatal: true, kind: unsupported ? 'unsupported' : 'media' });
        return;
      }
      fail({ message, fatal: true, kind: 'other' });
    });
    p.on(mpegts.Events.LOADING_COMPLETE, () => {
      if (player === p) loadComplete = true;
    });
    p.attachMediaElement(el);
    p.load();
  };

  /** Rebuild the pipeline on the same element: a closed live connection or a dropped network. */
  function restart(reason: EngineError): void {
    if (destroyed || restartTimer) return;
    if (restarts >= TS_MAX_RESTARTS) {
      fail(reason);
      return;
    }
    restarts++;
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (destroyed) return;
      if (player) teardown(player);
      start();
      void el.play().catch(() => undefined);
    }, tsRestartDelay(restarts));
  }

  // A live TS connection that closes plays out its buffer and then ends or stalls: reconnect.
  const onEnded = (): void => {
    if (isLive) restart(CLOSED_LIVE);
  };
  const onWaiting = (): void => {
    if (isLive && loadComplete) restart(CLOSED_LIVE);
  };
  el.addEventListener('ended', onEnded);
  el.addEventListener('waiting', onWaiting);
  el.addEventListener('timeupdate', markStable);
  start();

  return {
    kind: 'mpegts',
    setQuality() {},
    setAudio() {},
    setText() {},
    recover() {
      restarts = 0;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      restart({ message: 'Recovery failed', fatal: true, kind: 'other' });
    },
    destroy() {
      destroyed = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (stableTimer) clearTimeout(stableTimer);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('timeupdate', markStable);
      if (player) teardown(player);
      player = null;
      el.removeAttribute('src');
    },
  };
}

/**
 * Attach the right engine. `loadUrl` is `proxiedUrl(source)`.
 * Resume for direct/file (including MPEG-TS VOD) is applied by the caller on `loadedmetadata`.
 * `forceMpegts` is set after the element rejected an extensionless direct stream.
 */
export async function createEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  loadUrl: string,
  cb: EngineCallbacks,
  opts: { captions: boolean; signal?: AbortSignal; forceMpegts?: boolean },
): Promise<Engine> {
  switch (source.kind) {
    case 'hls':
      return hlsEngine(el, source, loadUrl, cb, opts.captions, opts.signal);
    case 'dash':
      return shakaEngine(el, source, loadUrl, cb, opts.captions, opts.signal);
    default:
      if ((opts.forceMpegts || looksLikeMpegTs(source)) && mseSupported()) {
        return mpegtsEngine(el, source, loadUrl, cb, opts.signal);
      }
      return nativeEngine(el, loadUrl, cb);
  }
}
