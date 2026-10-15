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
 *
 * This module deliberately does not import `./transport`: dozens of tests mock
 * that module with partial factories, and every poster on screen goes through
 * here.
 */

import { invoke } from '@tauri-apps/api/core';

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

if (isDesktopWindow) {
  invoke('rpc', { cmd: 'app.info', args: null })
    .then((info) => setDesktopImageBase((info as { proxyBase?: unknown } | null)?.proxyBase as string | null | undefined))
    .catch(() => undefined);
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
 * http(s) URL -> cache route URL; data:, blob:, asset: and relative URLs unchanged. Desktop uses the same base as
 * proxiedUrl (desktopProxyBase with /proxy -> /img) and returns the original URL until it is known; web uses '/api/img'.
 */
export function imageUrl(src: string | null | undefined, sourceId?: string): string | undefined {
  if (!src) return undefined;
  const trimmed = src.trim();
  if (!trimmed) return undefined;
  const base = imageCacheBase();
  if (!base || !cacheable(trimmed)) return src;
  const params = new URLSearchParams({ url: trimmed });
  if (sourceId) params.set('sourceId', sourceId);
  return `${base}?${params.toString()}`;
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
export function imageCandidates(sources: readonly (string | null | undefined)[], sourceId?: string): string[] {
  return imageAttempts(sources, sourceId).map((a) => a.url);
}

/** One URL to try and the source picture it stands for (the cache URL and the original share a source). */
export interface ImageAttempt {
  url: string;
  source: string;
}

/** `imageCandidates` with the source each URL belongs to, so a caller can style a stand-in differently. */
export function imageAttempts(sources: readonly (string | null | undefined)[], sourceId?: string): ImageAttempt[] {
  const out: ImageAttempt[] = [];
  for (const s of sources) {
    const original = s?.trim();
    if (!original) continue;
    for (const url of [imageUrl(original, sourceId), original]) {
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
export function preloadImage(src: string | null | undefined, sourceId?: string): string | undefined {
  const url = imageUrl(src, sourceId);
  if (!url || warmed.has(url) || typeof Image === 'undefined') return url;
  if (warmed.size >= WARMED_MAX) warmed.clear();
  warmed.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
  img.src = url;
  // Decode off the main thread now; a failure only means the visible <img> tries again.
  img.decode?.().catch(() => undefined);
  return url;
}
