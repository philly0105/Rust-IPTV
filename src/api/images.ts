/**
 * Image URLs through the core's disk image cache (Run 3 contract C3,
 * docs/architecture/image-cache.md).
 *
 * Posters, logos and backdrops load from `GET <base>/img?url=<absolute url>&sourceId=<id>`:
 * - server mode: `/api/img` on the app's own origin;
 * - desktop: the loopback proxy (`app.info.proxyBase`, `.../api/proxy`) with
 *   `/proxy` swapped for `/img`. Until that base is known (or when the proxy
 *   did not start) desktop returns the original URL, which loads directly.
 *
 * Only remote http(s) artwork is rewritten. data:, blob: and asset: URLs,
 * relative paths, Tauri's own `*.localhost` hosts and anything already on the
 * app's origin or the loopback proxy stay as they are.
 *
 * The cache route can fail where the provider would not (an old server
 * without the route, a guard refusal), so callers fall back to the original
 * URL once before giving up: `imageCandidates` lists both, in that order.
 * A URL that failed is remembered for a few minutes (`markImageFailed`), so a
 * remounted row skips it instead of asking the cache and the provider again.
 *
 * Cache responses are kept by the browser for a week. Clearing the cache bumps
 * a generation (`bumpImageCacheGeneration`) that every later cache URL
 * carries as `gen=<n>`, so this browser asks the emptied cache again instead
 * of reusing its own copies. The route ignores the parameter.
 *
 * This module deliberately does not import `./transport`: dozens of tests mock
 * that module with partial factories, and every poster on screen goes through
 * here.
 */

import { desktopAppInfo } from './bootInfo';

/** The server-mode cache route. */
export const WEB_IMAGE_ROUTE = '/api/img';

const isDesktopWindow: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Desktop: `<proxy origin>/<token>/api/img`, once known. */
let desktopImageBase: string | null = null;

/**
 * Sets the desktop cache base from `app.info.proxyBase` (`.../api/proxy`).
 * Null, or a base of any other shape, turns the rewrite off (original URLs).
 * Exported for tests and for a caller that already holds `app.info`.
 */
export function setDesktopImageBase(proxyBase: string | null | undefined): void {
  desktopImageBase = typeof proxyBase === 'string' && /\/proxy\/?$/.test(proxyBase) ? proxyBase.replace(/\/proxy\/?$/, '/img') : null;
}

/** Settles once the launch's one `app.info` request (bootInfo.ts) answered or failed; already settled on the web. */
const baseSettled: Promise<void> = desktopAppInfo.then((info) => {
  if (isDesktopWindow) setDesktopImageBase(info?.proxyBase);
});

/**
 * Resolves once the desktop cache base is known (or its request failed), and
 * at the latest after `timeoutMs`; at once on the web. Bootstrap awaits it
 * next to the locale, so the first artwork on screen already loads through
 * the cache. A picture keeps the URL it started with (`useImageChain`), so
 * one that mounted earlier loads directly until it remounts.
 */
export function imageBaseReady(timeoutMs = 1500): Promise<void> {
  if (!isDesktopWindow) return Promise.resolve();
  return Promise.race([baseSettled, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

const GENERATION_KEY = 'tsrust.imageCacheGen';

function storedGeneration(): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(GENERATION_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Bumped by Clear; 0 (no `gen` parameter) until the cache was first cleared in this browser. */
let generation = storedGeneration();

/** The cache generation cache URLs carry right now (0: none). */
export function imageCacheGeneration(): number {
  return generation;
}

/**
 * Called after the image cache was cleared: later cache URLs carry a new
 * `gen`, so this browser fetches each picture from the emptied cache again
 * (which downloads it anew) instead of showing its own week-old copy.
 * Persisted, and picked up by the app's other tabs.
 */
export function bumpImageCacheGeneration(): number {
  generation = Math.max(generation, storedGeneration()) + 1;
  try {
    globalThis.localStorage?.setItem(GENERATION_KEY, String(generation));
  } catch {
    // Private mode or a full quota: the bump still holds for this session.
  }
  warmed.clear();
  forgetImageFailures();
  return generation;
}

/** How long a failed picture URL is skipped (the core remembers an upstream failure for 10 min). */
export const IMAGE_FAILURE_TTL_MS = 5 * 60_000;
const FAILURES_MAX = 1000;
/** URL -> when it last failed; insertion order is age order, so the oldest entry goes first when full. */
const failedAt = new Map<string, number>();

/** Remembers that `url` failed to load, so a remounted picture skips it for a while. */
export function markImageFailed(url: string): void {
  failedAt.delete(url);
  if (failedAt.size >= FAILURES_MAX) {
    const oldest = failedAt.keys().next().value;
    if (oldest !== undefined) failedAt.delete(oldest);
  }
  failedAt.set(url, Date.now());
}

/** True when `url` failed within the last `IMAGE_FAILURE_TTL_MS`. */
export function imageFailedRecently(url: string): boolean {
  const at = failedAt.get(url);
  if (at === undefined) return false;
  if (Date.now() - at < IMAGE_FAILURE_TTL_MS) return true;
  failedAt.delete(url);
  return false;
}

/** Forgets every remembered failure (back online, cache cleared, tests). */
export function forgetImageFailures(): void {
  failedAt.clear();
}

if (typeof window !== 'undefined') {
  // A failure while offline says nothing about the picture.
  window.addEventListener('online', forgetImageFailures);
  window.addEventListener('storage', (e) => {
    if (e.key === GENERATION_KEY) generation = Math.max(generation, storedGeneration());
  });
}

/** The base the rewrite uses right now: '/api/img' on the web, the loopback route on desktop (null until known). */
export function imageCacheBase(): string | null {
  return isDesktopWindow ? desktopImageBase : WEB_IMAGE_ROUTE;
}

function pageOrigin(): string | null {
  return typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null' ? window.location.origin : null;
}

/** True for an absolute http(s) URL the cache should front. */
function cacheable(src: string): boolean {
  if (!/^https?:\/\//i.test(src)) return false;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  if (!u.hostname) return false;
  // Tauri serves assets and IPC from *.localhost (asset.localhost, ipc.localhost, tauri.localhost).
  if (u.hostname.endsWith('.localhost')) return false;
  // The app's own server (an absolute /api/files URL, a cache URL already) loads as is.
  const origin = pageOrigin();
  if (origin && u.origin === origin) return false;
  if (desktopImageBase && src.startsWith(new URL(desktopImageBase).origin + '/')) return false;
  return true;
}

/**
 * Widths in device px that the image cache resizes artwork to (`w=`, L3-serve). The client rounds a
 * picture's width up to one of them, so a card keeps one URL, and one browser-cache entry, across
 * small layout changes. A core without resizing ignores `w` and sends the full picture.
 */
export const IMAGE_WIDTH_BUCKETS: readonly number[] = [64, 96, 128, 192, 256, 384, 512, 768, 1024];

function pixelRatio(): number {
  const r = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/**
 * The `w` bucket for a picture drawn `cssWidth` CSS px wide on this screen (36 -> 64 at 1x, 96 at
 * 2x; 180 -> 192 at 1x, 384 at 2x). Undefined, meaning full size, without a usable width or when
 * the picture needs more than the largest bucket.
 */
export function imageWidthBucket(cssWidth: number | null | undefined, ratio: number = pixelRatio()): number | undefined {
  if (!cssWidth || !Number.isFinite(cssWidth) || cssWidth <= 0) return undefined;
  const px = Math.ceil(cssWidth * ratio);
  return IMAGE_WIDTH_BUCKETS.find((b) => b >= px);
}

/**
 * http(s) URL -> cache route URL; data:, blob:, asset: and relative URLs unchanged. Desktop uses the same base as
 * proxiedUrl (desktopProxyBase with /proxy -> /img) and returns the original URL until it is known; web uses '/api/img'.
 * `width` (CSS px the picture is drawn at) asks the cache for a resized copy; leave it off for backdrops and heroes.
 */
export function imageUrl(src: string | null | undefined, sourceId?: string, width?: number): string | undefined {
  if (!src) return undefined;
  const trimmed = src.trim();
  if (!trimmed) return undefined;
  const base = imageCacheBase();
  if (!base || !cacheable(trimmed)) return src;
  const params = new URLSearchParams({ url: trimmed });
  if (sourceId) params.set('sourceId', sourceId);
  if (generation > 0) params.set('gen', String(generation));
  const w = imageWidthBucket(width);
  if (w) params.set('w', String(w));
  return `${base}?${params.toString()}`;
}

/**
 * Adds the `w` bucket for `cssWidth` to a cache URL made without one (a poster measures its frame
 * once it is in the page). The result equals `imageUrl(src, sourceId, cssWidth)`. Any other URL,
 * or one that already has a width, is returned as is.
 */
export function sizedImageUrl(url: string, cssWidth: number | null | undefined): string {
  const w = imageWidthBucket(cssWidth);
  if (!w || !isImageCacheUrl(url) || /[?&]w=/.test(url)) return url;
  return `${url}&w=${w}`;
}

/** True when `url` is a cache route URL made by `imageUrl`. */
export function isImageCacheUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(`${WEB_IMAGE_ROUTE}?`)) return true;
  return !!desktopImageBase && url.startsWith(`${desktopImageBase}?`);
}

/**
 * The URLs to try for one picture, best first: for each source in order, its
 * cache URL and then the original (once), duplicates dropped. A poster with a
 * TMDB stand-in passes both: `[provider, tmdb]`.
 */
export function imageCandidates(sources: readonly (string | null | undefined)[], sourceId?: string, width?: number): string[] {
  return imageAttempts(sources, sourceId, width).map((a) => a.url);
}

/** One URL to try and the source picture it stands for (the cache URL and the original share a source). */
export interface ImageAttempt {
  url: string;
  source: string;
}

/**
 * `imageCandidates` with the source each URL belongs to, so a caller can style a stand-in differently.
 * `width` sizes the cache URLs only; the original URL is the provider's picture as it is.
 */
export function imageAttempts(sources: readonly (string | null | undefined)[], sourceId?: string, width?: number): ImageAttempt[] {
  const out: ImageAttempt[] = [];
  for (const s of sources) {
    const original = s?.trim();
    if (!original) continue;
    for (const url of [imageUrl(original, sourceId, width), original]) {
      if (url && !out.some((a) => a.url === url)) out.push({ url, source: original });
    }
  }
  return out;
}

/** Warmed URLs, so an idle preload or a hover prefetch never asks twice in a session. */
const warmed = new Set<string>();
const WARMED_MAX = 500;

/**
 * Starts loading (and decoding) a picture in the background through the cache,
 * at low priority, so it paints at once when it is shown. Once per URL per
 * session; a no-op without `Image` (tests, workers). Returns the URL used.
 */
export function preloadImage(src: string | null | undefined, sourceId?: string, width?: number): string | undefined {
  const url = imageUrl(src, sourceId, width);
  if (!url || warmed.has(url) || typeof Image === 'undefined') return url;
  if (warmed.size >= WARMED_MAX) warmed.clear();
  warmed.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
  // The visible picture then starts at its next attempt instead of asking again.
  img.onerror = () => markImageFailed(url);
  img.src = url;
  // Decode off the main thread now; a failure only means the visible <img> tries again.
  img.decode?.().catch(() => undefined);
  return url;
}
