/**
 * RPC transport (SPEC C1). Desktop: Tauri `invoke('rpc')`. Web: `POST /api/rpc/{cmd}`.
 * This layer never retries; TanStack Query decides (see query.ts).
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import { desktopAppInfo } from './bootInfo';
import { notifyServerAnswered } from './reachability';
import type { RpcMap } from './rpc';
import type { PlayerSource, RpcErrorCode, RpcErrorPayload, SourceRunErrorDetails } from './types';

export type RpcName = keyof RpcMap;
export type RpcArgs<K extends RpcName> = RpcMap[K]['args'];
export type RpcResult<K extends RpcName> = RpcMap[K]['result'];

/**
 * Every `RpcErrorCode`. `satisfies` makes the compiler reject this object when the union gains
 * or loses a code, so a new core code is never turned into an "Unknown error" here.
 */
const ERROR_CODE_SET = {
  not_found: true,
  invalid: true,
  network: true,
  auth: true,
  timeout: true,
  io: true,
  db: true,
  unsupported: true,
  conflict: true,
  internal: true,
  engine_missing: true,
  server: true,
} as const satisfies Record<RpcErrorCode, true>;

/** All RPC error codes the core can send (C12). */
export const RPC_ERROR_CODES = Object.keys(ERROR_CODE_SET) as RpcErrorCode[];

function isErrorCode(v: unknown): v is RpcErrorCode {
  return typeof v === 'string' && Object.hasOwn(ERROR_CODE_SET, v);
}

function isErrorPayload(v: unknown): v is RpcErrorPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isErrorCode(o.code) && typeof o.message === 'string';
}

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: RpcErrorCode, message: string, retryable = code === 'network' || code === 'timeout', details?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }

  /** Normalizes anything thrown by invoke/fetch/JSON into an RpcError. */
  static from(err: unknown, fallbackCode: RpcErrorCode = 'internal'): RpcError {
    if (err instanceof RpcError) return err;
    if (isErrorPayload(err)) {
      return new RpcError(err.code, err.message, err.retryable ?? undefined, err.details);
    }
    if (typeof err === 'string') {
      // Tauri rejections may arrive as a JSON string.
      try {
        const parsed: unknown = JSON.parse(err);
        if (isErrorPayload(parsed)) return RpcError.from(parsed);
      } catch {
        // not JSON
      }
      return new RpcError(fallbackCode, err);
    }
    if (err instanceof Error) return new RpcError(fallbackCode, err.message);
    return new RpcError(fallbackCode, 'Unknown error');
  }
}

/** The typed `details` of a rejected source import or refresh, when it has any (C8). */
export function sourceRunDetails(err: unknown): SourceRunErrorDetails | undefined {
  const d = err instanceof RpcError ? err.details : isErrorPayload(err) ? err.details : undefined;
  if (typeof d !== 'object' || d === null) return undefined;
  const o = d as Record<string, unknown>;
  const out: SourceRunErrorDetails = {};
  if (typeof o.sourceId === 'string') out.sourceId = o.sourceId;
  if (o.cancelled === true) out.cancelled = true;
  return out;
}

/** True when a rejected `sources.add` / `sources.refresh` was cancelled, not failed (`details.cancelled`, C8). */
export function isCancelledRun(err: unknown): boolean {
  return sourceRunDetails(err)?.cancelled === true;
}

/**
 * True when `catalog.item` answered `not_found` because parental Hide mode
 * locks the item (`details.parentalLocked`), not because the provider dropped
 * it. The item is still in the catalog.
 */
export function isParentalLocked(err: unknown): boolean {
  const d = err instanceof RpcError ? err.details : isErrorPayload(err) ? err.details : undefined;
  return typeof d === 'object' && d !== null && (d as Record<string, unknown>).parentalLocked === true;
}

/** True inside the Tauri webview. */
export const isDesktop: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const API_BASE = '/api';

/** The rejection for a call whose signal was aborted: the signal's reason, as `fetch` rejects. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function callDesktop(cmd: string, args: unknown, opts?: CallOptions): Promise<unknown> {
  if (opts?.signal?.aborted) throw abortReason(opts.signal);
  try {
    return await invoke('rpc', { cmd, args: args ?? null });
  } catch (err) {
    throw RpcError.from(err);
  }
}

/** Per-call transport options. */
export interface CallOptions {
  /**
   * Web only: send with `keepalive`, so a call made while the page unloads
   * (a `pagehide` flush) is not cancelled by the navigation. Small bodies only
   * (64 kB across all keepalive requests in flight).
   */
  keepalive?: boolean;
  /**
   * Cancels the call (TanStack Query passes one to every `queryFn`). Web: the request is aborted,
   * so a refetch that an invalidation replaced stops transferring. Desktop: a call not yet sent
   * is skipped; one already sent runs to the end. Either way the call rejects with the signal's
   * reason (an `AbortError`), not an RpcError.
   */
  signal?: AbortSignal;
}

async function callWeb(cmd: string, args: unknown, opts?: CallOptions): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/rpc/${encodeURIComponent(cmd)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? null),
      ...(opts?.keepalive ? { keepalive: true } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts?.signal?.aborted) throw abortReason(opts.signal);
    const message = err instanceof Error ? err.message : 'Network request failed';
    // `details.transport` tells the UI the app's own server is unreachable (not a provider error).
    throw new RpcError('network', `Cannot reach the server: ${message}`, true, { transport: 'unreachable' });
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      if (res.ok) throw new RpcError('internal', `Invalid JSON from ${cmd}`);
      body = text;
    }
  }
  // A success or one of our own error payloads proves the server is up (a proxy's 502 does not).
  if (res.ok || isErrorPayload(body)) notifyServerAnswered();

  if (!res.ok) {
    if (isErrorPayload(body)) throw RpcError.from(body);
    const code: RpcErrorCode =
      res.status === 404 ? 'not_found' : res.status === 504 ? 'timeout' : res.status >= 502 ? 'network' : 'internal';
    const message = typeof body === 'string' && body ? body : `HTTP ${res.status} ${res.statusText}`.trim();
    throw new RpcError(code, message);
  }
  return body;
}

/** Untyped call; prefer `rpc()`. */
export function rpcRaw(cmd: string, args?: unknown, opts?: CallOptions): Promise<unknown> {
  return isDesktop ? callDesktop(cmd, args, opts) : callWeb(cmd, args, opts);
}

export function rpc<K extends RpcName>(
  cmd: K,
  ...args: RpcArgs<K> extends void ? [] : [RpcArgs<K>]
): Promise<RpcResult<K>> {
  return rpcRaw(cmd, args[0]) as Promise<RpcResult<K>>;
}

function isMixedContent(url: string): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http:');
}

function hasHeaders(source: PlayerSource): boolean {
  const h = source.headers;
  return !!h && Object.values(h).some((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Desktop: base of the loopback media proxy inside the Tauri process
 * (`app.info.proxyBase`, from the launch's one `app.info` request in
 * bootInfo.ts). Null until known or when the proxy could not start.
 */
let desktopProxyBase: string | null = null;

/** Sets the desktop proxy base (exported for tests). */
export function setDesktopProxyBase(base: string | null): void {
  desktopProxyBase = base;
}

if (isDesktop) {
  void desktopAppInfo.then((info) => {
    const base = info?.proxyBase;
    setDesktopProxyBase(typeof base === 'string' && base ? base : null);
  });
}

/**
 * True for URLs the desktop webview must load itself: Tauri's own
 * `*.localhost` hosts (asset files, IPC) and the loopback proxy's own URLs.
 */
function desktopLoadsDirect(url: string, proxyBase: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.localhost') || u.origin === new URL(proxyBase).origin;
  } catch {
    return true;
  }
}

/** Query string for a proxy request: the target plus the per-item header overrides. */
function proxyParams(source: PlayerSource, url: string): URLSearchParams {
  const params = new URLSearchParams({ url });
  if (source.ref?.sourceId) params.set('sourceId', source.ref.sourceId);
  const h = source.headers;
  if (h?.userAgent) params.set('ua', h.userAgent);
  if (h?.referrer) params.set('referer', h.referrer);
  if (h?.origin) params.set('origin', h.origin);
  return params;
}

/**
 * URL a player element should load.
 * Desktop: a local `file` path goes through the asset protocol; every remote
 * http(s) stream goes through the loopback proxy (`app.info.proxyBase`), so
 * the source's request headers apply and a provider that sends no CORS
 * headers still plays in the inline player (hls.js, mpegts.js and shaka
 * fetch cross-origin from `http://tauri.localhost`). Until the proxy base is
 * known, or when the proxy did not start, streams load directly.
 * Web: through `/api/proxy` when source headers are needed or the page would block mixed content.
 */
export function proxiedUrl(source: PlayerSource): string {
  const { url } = source;
  if (isDesktop) {
    if (source.kind === 'file' && !/^(https?|asset):/i.test(url)) return convertFileSrc(url);
    if (desktopProxyBase && /^https?:/i.test(url) && !desktopLoadsDirect(url, desktopProxyBase)) {
      return `${desktopProxyBase}?${proxyParams(source, url).toString()}`;
    }
    return url;
  }
  if (!/^https?:/i.test(url)) return url; // relative (/api/files/..) or blob/data
  if (!hasHeaders(source) && !isMixedContent(url)) return url;
  const params = new URLSearchParams({ url });
  if (source.ref?.sourceId) params.set('sourceId', source.ref.sourceId);
  // Explicit headers (source-level merged with per-channel) override the server's stored ones.
  const h = source.headers;
  if (h?.userAgent) params.set('ua', h.userAgent);
  if (h?.referrer) params.set('referer', h.referrer);
  if (h?.origin) params.set('origin', h.origin);
  return `${API_BASE}/proxy?${params.toString()}`;
}
