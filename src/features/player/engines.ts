/**
 * Media engines for inline playback. One engine per (element, source) pair:
 * hls.js for `hls`, shaka for `dash`, mpegts.js for raw MPEG-TS (`.ts`, `video/mp2t`)
 * when Media Source Extensions exist, the element itself for other `direct`/`file`.
 * hls.js, shaka and mpegts.js are code-split; a direct mp4 never loads any of them.
 */

// The ESM build of hls.js only starts its transmuxing worker from a script URL; without one it
// demuxes every fragment on the UI thread.
import hlsWorkerUrl from 'hls.js/dist/hls.worker.js?url';
import i18next from 'i18next';

import type { MpvStats, PlayerSource } from '@/api/types';
import { intlLocale } from '@/lib/intl';

import { hideDrawnTracks, isExternalTrack, isShownTrack, releaseTrack } from './subtitles/tracks';

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
  /**
   * Seconds to add to `el.currentTime` (and buffered/seekable ranges) for display, and to
   * subtract when seeking. Non-zero only after mpegts.js reconnected a live stream: the new
   * pipeline restarts the element clock at 0, the shown position must not jump back.
   */
  timeOffset?(): number;
  /** What the library knows about the stream now (stream info overlay); the element adds the rest. */
  stats?(): Partial<MpvStats>;
  /**
   * Media bytes received so far, counting what has arrived of segments still downloading (hls.js
   * only). The live stall check reads it: a stream whose next segment is still coming in is slow,
   * not dead (`reconnect.ts`).
   */
  bytesLoaded?(): number;
  /**
   * The element took over after mpegts.js found no MPEG-TS in an extensionless live stream
   * (`createEngine`): an element error then is not worth another try through mpegts.js.
   */
  readonly fellBack?: boolean;
  destroy(): void;
}

/**
 * Buffer settings. `tile`: a multi-view tile, which can't seek and plays small, so it keeps
 * only a few seconds behind the playhead and hls.js picks no rendition above the tile's size.
 */
export type EngineProfile = 'main' | 'tile';

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

const bitrateFormats = new Map<string, Intl.NumberFormat>();

/**
 * A bitrate in the app's language (PL-COPY-I18N): "4.5 Mb/s", de "4,5 Mbit/s". Megabits with one
 * decimal from 1 Mb/s, whole kilobits below.
 */
export function formatBitrate(bps: number): string {
  const mega = bps >= 1_000_000;
  const locale = intlLocale(i18next.language);
  const key = `${locale}|${mega}`;
  let fmt = bitrateFormats.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: mega ? 'megabit-per-second' : 'kilobit-per-second',
      unitDisplay: 'short',
      maximumFractionDigits: mega ? 1 : 0,
      minimumFractionDigits: mega ? 1 : 0,
    });
    bitrateFormats.set(key, fmt);
  }
  return fmt.format(mega ? bps / 1_000_000 : Math.round(bps / 1000));
}

/** "Audio 2", "Subtitle 1" for a track with neither a name nor a language, in the app's language. */
function trackFallback(kind: 'audio' | 'text', index: number): string {
  return i18next.t(kind === 'audio' ? 'audioFallback' : 'subtitleFallback', { ns: 'player', index });
}

const trackNames = new Map<string, Intl.DisplayNames>();

/**
 * A track's language code as a name in the app's language ("German", de "Deutsch"),
 * not the OS's. The code itself when `Intl` doesn't know it.
 */
export function trackLanguageName(lang: string): string {
  const locale = intlLocale(i18next.language);
  try {
    let dn = trackNames.get(locale);
    if (!dn) {
      dn = new Intl.DisplayNames(locale, { type: 'language' });
      trackNames.set(locale, dn);
    }
    return dn.of(lang) ?? lang;
  } catch {
    return lang;
  }
}

function langLabel(lang: string | undefined, name: string | undefined, fallback: string): string {
  if (name && name.trim()) return name;
  if (lang) return trackLanguageName(lang);
  return fallback;
}

/** A proxied load URL split into the proxy route it went through and the upstream it wraps. */
export interface ProxyRoute {
  /** The route as the load URL wrote it: web `/api/proxy`, desktop `http://127.0.0.1:<port>/<token>/api/proxy`. */
  base: string;
  /** Origin and path of the route, for recognising URLs already routed through it. */
  origin: string;
  path: string;
  /** Absolute upstream URL of the manifest/playlist. */
  upstream: string;
  /** Every other query param of the load URL (`sourceId`, `ua`, `referer`, `origin`). */
  params: URLSearchParams;
}

/** The proxy route of `loadUrl` (`proxiedUrl(source)`), or null when it loads directly. */
export function proxyRoute(loadUrl: string): ProxyRoute | null {
  let u: URL;
  try {
    u = new URL(loadUrl, window.location.href);
  } catch {
    return null;
  }
  const upstream = u.searchParams.get('url');
  if (!u.pathname.endsWith('/api/proxy') || !upstream || !/^https?:/i.test(upstream)) return null;
  const params = new URLSearchParams(u.search);
  params.delete('url');
  const base = /^[a-z][a-z0-9+.-]*:/i.test(loadUrl) ? `${u.origin}${u.pathname}` : u.pathname;
  return { base, origin: u.origin, path: u.pathname, upstream, params };
}

/** The upstream URL a request to `route` wraps; any other URL is returned as is. */
export function unproxiedUrl(route: ProxyRoute, url: string): string {
  try {
    const u = new URL(url, `${route.origin}${route.path}`);
    if (u.origin !== route.origin || u.pathname !== route.path) return url;
    return u.searchParams.get('url') ?? url;
  } catch {
    return url;
  }
}

/**
 * When the manifest/playlist goes through the media proxy (web `/api/proxy` or the desktop
 * loopback `/<token>/api/proxy`), every follow-up request (segments, keys, absolute URLs the
 * server did not rewrite) must go through the same route with the same header params, or the
 * browser hits the upstream without them. URLs already on the route and the app's own URLs pass
 * through. A relative URI an engine resolved against the proxy URL (`/api/init.mp4`) is resolved
 * against the upstream manifest URL instead.
 */
export function proxyRewrite(loadUrl: string): ((url: string) => string) | null {
  const route = proxyRoute(loadUrl);
  if (!route) return null;
  const dir = route.path.slice(0, -'proxy'.length); // `/api/` or `/<token>/api/`
  const wrap = (target: string): string => {
    const params = new URLSearchParams({ url: target });
    for (const [k, v] of route.params) params.append(k, v);
    return `${route.base}?${params.toString()}`;
  };
  return (url: string) => {
    let u: URL;
    try {
      // Root-relative means our own server (the HLS rewriter emits `/api/proxy?...`); other relative URIs are the manifest's.
      u = new URL(url, url.startsWith('/') ? `${route.origin}${route.path}` : route.upstream);
    } catch {
      return url;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    const appOrigin = window.location.origin;
    if (u.origin === route.origin) {
      if (u.pathname === route.path) return url;
      const appRoute = u.origin === appOrigin && u.pathname.startsWith('/api/files/');
      if (u.pathname.startsWith(dir) && !appRoute) {
        return wrap(new URL(`${u.pathname.slice(dir.length)}${u.search}`, route.upstream).href);
      }
    }
    if (u.origin === appOrigin) return url;
    return wrap(u.href);
  };
}

// ---------------------------------------------------------------------------
// Server/proxy failure reasons
// ---------------------------------------------------------------------------

/** Longest server reason shown in the error overlay. */
const MAX_REASON = 300;

/**
 * A URL answered by our own server: the web `/api/...` routes (proxy, files) or the
 * desktop loopback proxy (`http://127.0.0.1:<port>/<token>/api/proxy`). Their non-2xx bodies
 * carry a readable reason (an RpcError JSON or plain text); upstream bodies do not.
 */
export function isOwnServerUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    if (u.pathname.endsWith('/api/proxy')) return true; // web route, or desktop `/<token>/api/proxy`
    return u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** The reason in a non-2xx body: an RpcError's `message`, else the trimmed text. Null when empty or HTML. */
export function reasonFromBody(body: unknown): string | null {
  let text: string | null = null;
  if (typeof body === 'string') text = body;
  // Tag check rather than instanceof: worker and test realms have their own ArrayBuffer.
  else if (Object.prototype.toString.call(body) === '[object ArrayBuffer]' || ArrayBuffer.isView(body)) {
    try {
      text = new TextDecoder().decode(body as ArrayBuffer | ArrayBufferView);
    } catch {
      text = null;
    }
  }
  text = text?.trim() ?? '';
  if (!text || /^<(!doctype|html)/i.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      text = (parsed as { message: string }).message.trim();
    }
  } catch {
    // plain text
  }
  if (!text) return null;
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

/** The body of a failed XMLHttpRequest (hls.js `networkDetails`), when it is readable. */
function xhrBody(details: unknown): unknown {
  if (typeof XMLHttpRequest === 'undefined' || !(details instanceof XMLHttpRequest)) return undefined;
  try {
    return details.responseType === '' || details.responseType === 'text' ? details.responseText : details.response;
  } catch {
    return undefined;
  }
}

/** `<reason> (HTTP <status>)`, or the engine's own message when the server gave no reason. */
export function withReason(fallback: string, reason: string | null, status?: number): string {
  if (!reason) return fallback;
  return status && status > 0 ? `${reason} (HTTP ${status})` : reason;
}

/**
 * Asks our own server why `url` failed: one GET, and the body text of a non-2xx answer.
 * Engines that hide response bodies (mpegts.js, the media element, hls.js binary loads) use it.
 * Never contacts anything but our own server; null on 2xx, network failure or timeout.
 */
export async function fetchFailureReason(url: string): Promise<{ status: number; reason: string } | null> {
  const r = await fetchFailureStatus(url);
  return r?.reason ? { status: r.status, reason: r.reason } : null;
}

/**
 * `fetchFailureReason` that also answers without a reason: the status of a non-2xx answer from
 * our own server, and its reason when the body has one. Null on 2xx, failure, timeout, or any
 * URL that is not our own server's.
 */
export async function fetchFailureStatus(url: string): Promise<{ status: number; reason: string | null } | null> {
  if (!isOwnServerUrl(url)) return null;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    return { status: res.status, reason: reasonFromBody(await res.text()) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Native element
// ---------------------------------------------------------------------------

/** Which engine last attached to an element; a stale native engine must not reset it on destroy. */
const nativeOwner = new WeakMap<HTMLMediaElement, object>();

/** Paths of the desktop loopback proxy that answer the app's window with CORS. */
const LOOPBACK_MEDIA_PATH = /^\/[^/]+\/api\/(proxy|(files|recordings)\/[^/]+\/[^/]+)$/;

/**
 * The CORS mode the element loads `url` in. Without one, a frame from another origin taints a
 * canvas and a screenshot of it is refused (C6), so the app's own cross-origin routes, which
 * answer with CORS for the app's window, load as `anonymous`:
 * - Tauri's asset protocol (`http://asset.localhost/...`, `asset://localhost/...`): downloads
 *   and recordings on the desktop when the loopback proxy is not running;
 * - the desktop loopback media proxy (`http://127.0.0.1:<port>/<token>/api/proxy`) and its
 *   local file routes (`.../api/recordings/{id}/{name}`, `.../api/files/{id}/{name}`).
 *
 * Anything else gets null. A third-party server without CORS refuses a CORS request outright,
 * so a direct stream keeps the plain load: it plays, and only a screenshot of it is refused.
 * Same-origin URLs (server mode's `/api/proxy` and `/api/files`) are readable either way.
 */
export function mediaCrossOrigin(url: string): 'anonymous' | null {
  let u: URL;
  try {
    u = new URL(url, window.location.href);
  } catch {
    return null;
  }
  if (u.origin === window.location.origin) return null;
  if (u.protocol === 'asset:' || u.hostname === 'asset.localhost') return 'anonymous';
  if (u.hostname === '127.0.0.1' && LOOPBACK_MEDIA_PATH.test(u.pathname)) return 'anonymous';
  return null;
}

/**
 * The element plays `url` itself. `wantCaptions` (settings.showCaptions) turns the first subtitle
 * track the stream brings on once it appears, unless one is already on; a choice in the menu wins.
 */
function nativeEngine(el: HTMLMediaElement, url: string, cb: EngineCallbacks, wantCaptions = false): Engine {
  const owner = {};
  let autoCaptions = wantCaptions;
  nativeOwner.set(el, owner);
  // Before `src`: the mode is fixed when the load starts.
  const cors = mediaCrossOrigin(url);
  if (cors) el.crossOrigin = cors;
  else el.removeAttribute('crossorigin');
  el.src = url;
  const emitTracks = (): void => {
    const audio: TrackOption[] = [];
    const audioTracks = (el as HTMLMediaElement & { audioTracks?: ArrayLike<{ id: string; label: string; language: string; enabled: boolean }> }).audioTracks;
    if (audioTracks && audioTracks.length > 1) {
      for (let i = 0; i < audioTracks.length; i++) {
        const t = audioTracks[i];
        if (t) audio.push({ id: String(i), label: langLabel(t.language, t.label, trackFallback('audio', i + 1)), selected: t.enabled });
      }
    }
    const text: TrackOption[] = [];
    for (let i = 0; i < el.textTracks.length; i++) {
      const t = el.textTracks[i];
      // Loaded subtitle files are listed by the player as `ext:<n>` (subtitles/tracks.ts).
      if (t && !isExternalTrack(t) && (t.kind === 'subtitles' || t.kind === 'captions')) {
        // A track the player draws itself is `hidden` while on screen (subtitles/inline.ts).
        text.push({ id: String(i), label: langLabel(t.language, t.label, trackFallback('text', i + 1)), selected: isShownTrack(t) });
      }
    }
    const first = text[0];
    if (autoCaptions && first) {
      autoCaptions = false;
      const track = el.textTracks[Number(first.id)];
      if (track && !text.some((o) => o.selected)) {
        track.mode = 'showing';
        first.selected = true;
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
      autoCaptions = false;
      for (let i = 0; i < el.textTracks.length; i++) {
        const t = el.textTracks[i];
        if (!t) continue;
        if (String(i) === id) {
          t.mode = 'showing';
        } else {
          releaseTrack(t);
          t.mode = 'disabled';
        }
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
      el.removeAttribute('crossorigin');
      el.load();
    },
  };
}

// ---------------------------------------------------------------------------
// hls.js
// ---------------------------------------------------------------------------

/**
 * The main player's last hls.js bandwidth estimate (bits/s). Each zap builds a new `Hls`, which
 * would otherwise start every multi-rendition stream from hls.js's 500 kbps default.
 */
let hlsBandwidth: number | undefined;

/** Test hook: forget the carried bandwidth estimate. */
export function resetHlsBandwidth(): void {
  hlsBandwidth = undefined;
}

async function hlsEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  url: string,
  cb: EngineCallbacks,
  wantCaptions: boolean,
  profile: EngineProfile,
  signal?: AbortSignal,
): Promise<Engine> {
  const { default: Hls } = await import('hls.js');
  // A superseded engine attaching late would detach the newer engine's MediaSource on destroy.
  if (signal?.aborted) return NOOP_ENGINE;
  nativeOwner.set(el, {});
  if (!Hls.isSupported()) {
    // Safari / platforms with native HLS.
    if (el.canPlayType('application/vnd.apple.mpegurl')) return nativeEngine(el, url, cb, wantCaptions);
    cb.onError({ message: 'HLS is not supported in this browser', fatal: true, kind: 'unsupported' });
    return nativeEngine(el, url, cb);
  }
  const rewrite = proxyRewrite(url);
  const tile = profile === 'tile';
  const hls = new Hls({
    enableWorker: true,
    workerPath: hlsWorkerUrl,
    lowLatencyMode: false,
    backBufferLength: tile ? 5 : source.isLive ? 30 : 90,
    // A tile never seeks back, and fetching the top rendition for a 640x360 slot wastes bandwidth.
    ...(tile ? { maxBufferLength: 10, capLevelToPlayerSize: true } : {}),
    // A movie or episode keeps a minute ahead instead of 30 s (hls.js's 60 MB cap still applies),
    // so a slow patch on the provider's side drains the buffer instead of stopping the picture.
    ...(!tile && !source.isLive ? { maxBufferLength: 60 } : {}),
    // Undefined would replace hls.js's default, so the key is only there with a value.
    ...(hlsBandwidth ? { abrEwmaDefaultEstimate: hlsBandwidth } : {}),
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
    // Segments reach the transmuxer as they download (fetch streams, in 128 KB chunks) instead
    // of whole: a live tune shows its first frame after the first GOP of the segment, not after
    // all 6-10 s of it. The fetch loader never calls xhrSetup, so the rewrite goes through
    // fetchSetup too; xhrSetup stays for a browser without fetch streams, where hls.js keeps XHR.
    progressive: true,
    fetchSetup: rewrite ? (context: { url: string }, init: RequestInit) => new Request(rewrite(context.url), init) : undefined,
    xhrSetup: rewrite
      ? (xhr: XMLHttpRequest, reqUrl: string) => {
          const target = rewrite(reqUrl);
          if (target !== reqUrl) xhr.open('GET', target, true);
        }
      : undefined,
  });

  let manualLevel = -1;
  // Subtitles on: hls.subtitleDisplay turns false when the overlay hides the track it draws.
  let textOn = wantCaptions;
  let mediaRecoveries = 0;
  let destroyed = false;
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
            label: langLabel(t.lang, t.name, trackFallback('audio', i + 1)),
            selected: hls.audioTrack === i,
          }))
        : [];
    const text: TrackOption[] = hls.subtitleTracks.map((t, i) => ({
      id: String(i),
      label: langLabel(t.lang, t.name, trackFallback('text', i + 1)),
      selected: textOn && hls.subtitleTrack === i,
    }));
    cb.onTracks({ qualities, qualityAuto: manualLevel < 0, audio, text });
  };

  // Media bytes received (`bytesLoaded`). Each loader's stats object is counted once, by how far
  // it grew since last read: hls.js gives a retried segment a fresh one, and a sum over the
  // segments would then drop, where the stall check looks for growth.
  let loadedBytes = 0;
  const counted = new WeakMap<object, number>();
  /** The segment loading now, per playlist type (main, audio, subtitle). */
  const loading = new Map<string, { stats: { loaded: number } }>();
  const count = (frag: { stats: { loaded: number } }): void => {
    const before = counted.get(frag.stats) ?? 0;
    if (frag.stats.loaded <= before) return;
    loadedBytes += frag.stats.loaded - before;
    counted.set(frag.stats, frag.stats.loaded);
  };
  hls.on(Hls.Events.FRAG_LOADING, (_evt, data) => {
    // The one it replaces was aborted; what it got still came in.
    const before = loading.get(data.frag.type);
    if (before) count(before);
    // The fragment, not its stats: hls.js swaps in the loader's stats when the request starts,
    // which can be after this event (an init segment, a key first).
    loading.set(data.frag.type, data.frag);
  });
  hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
    count(data.frag);
    if (loading.get(data.frag.type) === data.frag) loading.delete(data.frag.type);
  });
  hls.on(Hls.Events.MANIFEST_PARSED, emit);
  hls.on(Hls.Events.LEVELS_UPDATED, emit);
  hls.on(Hls.Events.LEVEL_SWITCHED, emit);
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, emit);
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, emit);
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
    // A new track group starts hidden once the overlay has hidden the last one (subtitleDisplay
    // false): turn subtitles back on so the overlay takes the new track over.
    if (textOn && !hls.subtitleDisplay) hls.subtitleDisplay = true;
    emit();
  });
  hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, emit);
  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
      mediaRecoveries++;
      hls.recoverMediaError();
      return;
    }
    const kind = data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'media' : 'other';
    const code = data.response?.code ?? 0;
    const fallback = `${data.details}${code ? ` (HTTP ${code})` : ''}`;
    const report = (message: string): void => {
      if (!destroyed) cb.onError({ message, fatal: true, kind });
    };
    // A refusal from our own server (proxy SSRF guard, upstream 4xx relayed) says why in its body.
    const rawUrl = data.url ?? data.response?.url ?? data.context?.url ?? url;
    const failedUrl = rewrite ? rewrite(rawUrl) : rawUrl;
    if (kind === 'network' && code >= 400 && isOwnServerUrl(failedUrl)) {
      const inline = reasonFromBody(xhrBody(data.networkDetails) ?? data.response?.data);
      if (inline) {
        report(withReason(fallback, inline, code));
        return;
      }
      void fetchFailureReason(failedUrl).then((r) => report(withReason(fallback, r?.reason ?? null, r?.status ?? code)));
      return;
    }
    report(fallback);
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
      textOn = id !== null;
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
    bytesLoaded() {
      for (const frag of loading.values()) count(frag);
      return loadedBytes;
    },
    stats() {
      const level = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel];
      const out: Partial<MpvStats> = {};
      if (level?.videoCodec) out.videoCodec = level.videoCodec;
      if (level?.audioCodec) out.audioCodec = level.audioCodec;
      if (level?.width && level.height) {
        out.width = level.width;
        out.height = level.height;
      }
      if (level?.frameRate) out.fps = level.frameRate;
      if (level?.bitrate) out.videoBitrate = level.bitrate;
      const channels = Number.parseInt(hls.audioTracks[hls.audioTrack]?.channels ?? '', 10);
      if (channels > 0) out.audioChannels = channels;
      return out;
    },
    destroy() {
      destroyed = true;
      // Tiles share the link four ways: only the main player's estimate is carried.
      const bw = hls.bandwidthEstimate;
      if (!tile && Number.isFinite(bw) && bw > 0) hlsBandwidth = bw;
      hls.destroy();
      el.removeAttribute('src');
    },
  };
}

// ---------------------------------------------------------------------------
// shaka (DASH)
// ---------------------------------------------------------------------------

interface ShakaErrorLike {
  severity?: number;
  code?: number;
  category?: number;
  data?: unknown[];
}

/**
 * shaka's `destroy()` is async and clears the element's `src` when it is done. The next engine on
 * the element waits for it (`createEngine`), at most SHAKA_TEARDOWN_WAIT_MS, or shaka would empty
 * the element under it.
 */
const shakaTeardowns = new WeakMap<HTMLMediaElement, Promise<void>>();
export const SHAKA_TEARDOWN_WAIT_MS = 300;

/** Resolves when shaka has let go of `el`, or after SHAKA_TEARDOWN_WAIT_MS; at once when it never held it. */
function shakaReleased(el: HTMLMediaElement): Promise<void> | null {
  const pending = shakaTeardowns.get(el);
  if (!pending) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHAKA_TEARDOWN_WAIT_MS);
  });
  return Promise.race([pending, cap]).finally(() => clearTimeout(timer));
}

/** shaka BAD_HTTP_STATUS (1001) carries `[uri, status, responseText, ...]`: the reason from our own server. */
function shakaHttpFailure(err: ShakaErrorLike | undefined): { status: number; reason: string } | null {
  if (err?.code !== 1001 || !Array.isArray(err.data)) return null;
  const [uri, status, body] = err.data;
  if (typeof uri !== 'string' || typeof status !== 'number' || !isOwnServerUrl(uri)) return null;
  const reason = reasonFromBody(body);
  return reason ? { status, reason } : null;
}

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
  // Subtitles on. The overlay hides the track it draws, which shaka reads as "text not visible";
  // alwaysStreamText keeps the cues coming anyway (subtitles/inline.ts).
  let textOn = false;
  player.configure({
    streaming: {
      alwaysStreamText: true,
      retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, timeout: 20_000 },
    },
    manifest: { retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, timeout: 20_000 } },
  });
  // ClearKey from the channel's #KODIPROP licence (clearKey.ts): the keys, or a licence server.
  if (source.drm?.clearKeys) player.configure({ drm: { clearKeys: source.drm.clearKeys } });
  else if (source.drm?.licenseServer) player.configure({ drm: { servers: { 'org.w3.clearkey': source.drm.licenseServer } } });
  const route = proxyRoute(url);
  const rewrite = proxyRewrite(url);
  if (route && rewrite) {
    const net = player.getNetworkingEngine();
    net?.registerRequestFilter((type, request) => {
      // A ClearKey licence request is a POST, which the media proxy (GET only) cannot carry.
      if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) return;
      request.uris = request.uris.map(rewrite);
    });
    // The DASH parser resolves BaseURL/SegmentTemplate against the manifest response URI; make
    // that the upstream URL, so `chunk-1.m4s` and `../x` resolve there, then go through the proxy.
    net?.registerResponseFilter((type, response) => {
      if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) response.uri = unproxiedUrl(route, response.uri);
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
    const visible = textOn;
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
    const detail = (e as unknown as { detail?: ShakaErrorLike }).detail;
    const fatal = detail?.severity === shaka.util.Error.Severity.CRITICAL;
    if (!fatal) return;
    const kind = detail?.category === shaka.util.Error.Category.NETWORK ? 'network' : 'media';
    const http = shakaHttpFailure(detail);
    cb.onError({ message: withReason(`Shaka error ${detail?.code ?? ''}`.trim(), http?.reason ?? null, http?.status), fatal: true, kind });
  });

  await player.attach(el as HTMLMediaElement);
  try {
    await player.load(url, !source.isLive && source.resumeSeconds ? source.resumeSeconds : null);
    if (wantCaptions) {
      textOn = true;
      await player.setTextTrackVisibility(true);
    }
    emit();
  } catch (err) {
    if (!destroyed) {
      const code = (err as ShakaErrorLike).code;
      const http = shakaHttpFailure(err as ShakaErrorLike);
      const fallback = `Could not load the DASH manifest${code ? ` (${code})` : ''}`;
      cb.onError({ message: withReason(fallback, http?.reason ?? null, http?.status), fatal: true, kind: 'network' });
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
      textOn = id !== null;
      if (id === null) {
        void player.setTextTrackVisibility(false);
        // Off only hides shaka's track, and a hidden track is the one the overlay draws.
        hideDrawnTracks(el);
      } else {
        const t = player.getTextTracks().find((x) => String(x.id) === id);
        if (t) player.selectTextTrack(t);
        void player.setTextTrackVisibility(true);
      }
      emit();
    },
    recover() {
      void player.retryStreaming();
    },
    stats() {
      const active = player.getVariantTracks().find((v) => v.active);
      const st = player.getStats();
      const out: Partial<MpvStats> = {};
      if (active?.videoCodec) out.videoCodec = active.videoCodec;
      if (active?.audioCodec) out.audioCodec = active.audioCodec;
      if (active?.frameRate) out.fps = active.frameRate;
      if (active?.channelsCount) out.audioChannels = active.channelsCount;
      if (active?.videoBandwidth) out.videoBitrate = active.videoBandwidth;
      else if (st.streamBandwidth > 0) out.videoBitrate = st.streamBandwidth;
      if (active?.audioBandwidth) out.audioBitrate = active.audioBandwidth;
      if (Number.isFinite(st.droppedFrames) && st.droppedFrames >= 0) out.droppedFrames = st.droppedFrames;
      return out;
    },
    destroy() {
      destroyed = true;
      const done = player.destroy().catch(() => undefined);
      shakaTeardowns.set(el, done);
      void done.then(() => {
        if (shakaTeardowns.get(el) === done) shakaTeardowns.delete(el);
      });
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

/**
 * A live TV stream (not radio) whose URL names no container (`/live/u/p/123`). Most of them
 * serve raw MPEG-TS, which Chromium's element can't play: they start in mpegts.js
 * (`createEngine`), and what each source's host turned out to serve is remembered.
 */
export function isUnlabelledLive(source: Pick<PlayerSource, 'kind' | 'url' | 'isLive' | 'isRadio'>): boolean {
  return source.isLive && !source.isRadio && worthSniffingAsMpegTs(source);
}

/** What an unlabelled live stream from a source's host played in: mpegts.js or the element. */
export type LiveFormat = 'ts' | 'native';

/** localStorage: `{ "<sourceId>|<host>": "ts" | "native" }`, most recent last. */
export const LIVE_FORMATS_KEY = 'player.liveFormats';
/** Hosts remembered; the oldest go first. */
const LIVE_FORMATS_MAX = 200;

type LiveFormatSource = Pick<PlayerSource, 'kind' | 'url' | 'isLive' | 'isRadio' | 'ref'>;

function liveFormatKey(source: LiveFormatSource): string | null {
  if (!isUnlabelledLive(source)) return null;
  try {
    return `${source.ref?.sourceId ?? ''}|${new URL(source.url).host}`;
  } catch {
    return null;
  }
}

function readLiveFormats(): Record<string, LiveFormat> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LIVE_FORMATS_KEY) ?? '{}');
    const out: Record<string, LiveFormat> = {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed)) if (v === 'ts' || v === 'native') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** What this source's host served last time, if this is an unlabelled live stream. */
export function liveFormatFor(source: LiveFormatSource): LiveFormat | undefined {
  const key = liveFormatKey(source);
  return key ? readLiveFormats()[key] : undefined;
}

/** An unlabelled live stream played in `format`: the next one from its source's host starts there. */
export function rememberLiveFormat(source: LiveFormatSource, format: LiveFormat): void {
  const key = liveFormatKey(source);
  if (!key) return;
  const all = readLiveFormats();
  if (all[key] === format) return;
  delete all[key];
  all[key] = format;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - LIVE_FORMATS_MAX))) delete all[old];
  try {
    localStorage.setItem(LIVE_FORMATS_KEY, JSON.stringify(all));
  } catch {
    // storage full or blocked: the next zap probes again
  }
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
  profile: EngineProfile,
  signal?: AbortSignal,
  /** Called instead of `cb.onError` when the stream turns out not to be MPEG-TS before any media played. */
  onNotTs?: () => void,
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
  /** The stream produced media once: only then is a dropped connection restarted here. */
  let hadMedia = false;
  /** Handed to `onNotTs`: whatever this pipeline reports after that is moot. */
  let handedOff = false;
  /** Live only: element time lost to reconnects, so the displayed position keeps running. */
  let offset = 0;
  /** Set by a reconnect until the new pipeline has media: the displayed position to continue from. */
  let anchor: number | null = null;

  const config: Parameters<typeof mpegts.createPlayer>[1] = {
    enableWorker: true,
    // Live: low-latency reads. No latency chasing: servers that burst their buffer on connect
    // (or serve a whole loop at once) would be skipped to the last seconds, then end and reconnect.
    enableStashBuffer: !isLive,
    liveBufferLatencyChasing: false,
    // Hours-long sessions must not sit at the SourceBuffer quota. A tile never seeks back.
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: profile === 'tile' ? 10 : 60,
    autoCleanupMinBackwardDuration: profile === 'tile' ? 5 : 30,
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
      if (player !== p || destroyed || handedOff) return;
      const http = info?.code && info.code > 0 ? ` (HTTP ${info.code})` : '';
      const message = `${detail || type}${http}`;
      if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
        // An HTTP answer (404, 503, ...) is the provider's verdict: it goes up at once, and the
        // player's reconnect decides whether a retry is worth it (`reconnect.ts`, one layer
        // owning retries). Restarts here are for a stream that played and then dropped.
        if (info?.code && info.code > 0) {
          const status = info.code;
          // mpegts.js drops the body; our own server (proxy guard, relayed status) is asked once for the reason.
          if (isOwnServerUrl(absolute)) {
            void fetchFailureReason(absolute).then((r) => {
              if (player === p) fail({ message: withReason(message, r?.reason ?? null, r?.status ?? status), fatal: true, kind: 'network' });
            });
          } else fail({ message, fatal: true, kind: 'network' });
        } else if (hadMedia) restart({ message, fatal: true, kind: 'network' });
        else fail({ message, fatal: true, kind: 'network' });
        return;
      }
      if (type === mpegts.ErrorTypes.MEDIA_ERROR) {
        const notTs = detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED || detail === mpegts.ErrorDetails.MEDIA_FORMAT_ERROR;
        if (notTs && !hadMedia && onNotTs) {
          handedOff = true;
          onNotTs();
          return;
        }
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
    // Remember where the display stood; the first media time of the new pipeline is rebased onto it.
    if (isLive && anchor === null) anchor = offset + (Number.isFinite(el.currentTime) ? el.currentTime : 0);
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
  /** The new pipeline produced media: fix the offset so its clock continues from the anchor. */
  const rebase = (): void => {
    if (anchor === null || player === null || el.readyState < 1 || restartTimer) return;
    offset = anchor - el.currentTime;
    anchor = null;
  };
  // Listener order does not matter: until rebased, `timeOffset()` holds the display at the anchor.
  const onData = (): void => {
    if (!hadMedia) rememberLiveFormat(source, 'ts');
    hadMedia = true;
  };
  el.addEventListener('timeupdate', rebase);
  el.addEventListener('loadedmetadata', rebase);
  el.addEventListener('timeupdate', markStable);
  el.addEventListener('loadeddata', onData);
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
    stats() {
      const info = (player as { mediaInfo?: Record<string, unknown> } | null)?.mediaInfo;
      const out: Partial<MpvStats> = {};
      if (!info) return out;
      const num = (k: string): number | undefined => {
        const v = info[k];
        return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
      };
      const vCodec = info['videoCodec'];
      if (typeof vCodec === 'string' && vCodec) out.videoCodec = vCodec;
      const aCodec = info['audioCodec'];
      if (typeof aCodec === 'string' && aCodec) out.audioCodec = aCodec;
      const fps = num('fps');
      if (fps) out.fps = fps;
      const channels = num('audioChannelCount');
      if (channels) out.audioChannels = channels;
      // mpegts.js reports data rates in kbit/s.
      const vRate = num('videoDataRate');
      if (vRate) out.videoBitrate = vRate * 1000;
      const aRate = num('audioDataRate');
      if (aRate) out.audioBitrate = aRate * 1000;
      return out;
    },
    timeOffset() {
      // While reconnecting the display holds at the anchor whatever the element reports.
      return anchor !== null ? anchor - (Number.isFinite(el.currentTime) ? el.currentTime : 0) : offset;
    },
    destroy() {
      destroyed = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (stableTimer) clearTimeout(stableTimer);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('timeupdate', markStable);
      el.removeEventListener('timeupdate', rebase);
      el.removeEventListener('loadedmetadata', rebase);
      el.removeEventListener('loadeddata', onData);
      if (player) teardown(player);
      player = null;
      el.removeAttribute('src');
    },
  };
}

/**
 * An unlabelled live stream (`isUnlabelledLive`): mpegts.js first, which knows from the first
 * chunk whether the data is MPEG-TS. When it is not, and nothing has played yet, the element gets
 * the stream instead, once. Either outcome is remembered for the source's host.
 */
async function tsFirstEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  url: string,
  cb: EngineCallbacks,
  profile: EngineProfile,
  signal?: AbortSignal,
  /** The fallback's native element turns the first caption track on, as `nativeEngine` does. */
  wantCaptions = false,
): Promise<Engine> {
  let destroyed = false;
  let fellBack = false;
  let current: Engine = NOOP_ENGINE;
  const onNativeData = (): void => rememberLiveFormat(source, 'native');
  const fallBack = (): void => {
    if (destroyed || fellBack) return;
    fellBack = true;
    current.destroy();
    el.addEventListener('loadeddata', onNativeData, { once: true });
    current = nativeEngine(el, url, cb, wantCaptions);
    // A new `src` pauses the element.
    void el.play().catch(() => undefined);
  };
  // Out of mpegts.js's own error dispatch before its player is torn down.
  current = await mpegtsEngine(el, source, url, cb, profile, signal, () => queueMicrotask(fallBack));
  if (current === NOOP_ENGINE) return current;
  return {
    get kind() {
      return current.kind;
    },
    get fellBack() {
      return fellBack;
    },
    setQuality: (id) => current.setQuality(id),
    setAudio: (id) => current.setAudio(id),
    setText: (id) => current.setText(id),
    recover: () => current.recover(),
    timeOffset: () => current.timeOffset?.() ?? 0,
    stats: () => current.stats?.() ?? {},
    destroy() {
      destroyed = true;
      el.removeEventListener('loadeddata', onNativeData);
      current.destroy();
    },
  };
}

/**
 * Attach the right engine. `loadUrl` is `proxiedUrl(source)`.
 * Resume for direct/file (including MPEG-TS VOD) is applied by the caller on `loadedmetadata`.
 * `forceMpegts` is set after the element rejected an extensionless direct stream.
 * `profile` defaults to the main player's buffers.
 */
export async function createEngine(
  el: HTMLMediaElement,
  source: PlayerSource,
  loadUrl: string,
  cb: EngineCallbacks,
  opts: { captions: boolean; signal?: AbortSignal; forceMpegts?: boolean; profile?: EngineProfile },
): Promise<Engine> {
  const profile = opts.profile ?? 'main';
  const released = shakaReleased(el);
  if (released) {
    await released;
    if (opts.signal?.aborted) return NOOP_ENGINE;
  }
  switch (source.kind) {
    case 'hls':
      return hlsEngine(el, source, loadUrl, cb, opts.captions, profile, opts.signal);
    case 'dash':
      return shakaEngine(el, source, loadUrl, cb, opts.captions, opts.signal);
    default:
      if (!mseSupported()) return nativeEngine(el, loadUrl, cb, opts.captions);
      if (opts.forceMpegts || looksLikeMpegTs(source)) return mpegtsEngine(el, source, loadUrl, cb, profile, opts.signal);
      // The element would download until FFmpeg's probe gives up on raw MPEG-TS, then error.
      if (isUnlabelledLive(source) && liveFormatFor(source) !== 'native') return tsFirstEngine(el, source, loadUrl, cb, profile, opts.signal, opts.captions);
      return nativeEngine(el, loadUrl, cb, opts.captions);
  }
}
