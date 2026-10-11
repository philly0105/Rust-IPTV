/**
 * RPC transport (SPEC C1). Desktop: Tauri `invoke('rpc')`. Web: `POST /api/rpc/{cmd}`.
 * This layer never retries; TanStack Query decides (see query.ts).
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import type { RpcMap } from './rpc';
import type { PlayerSource, RpcErrorCode, RpcErrorPayload } from './types';

export type RpcName = keyof RpcMap;
export type RpcArgs<K extends RpcName> = RpcMap[K]['args'];
export type RpcResult<K extends RpcName> = RpcMap[K]['result'];

const ERROR_CODES: readonly RpcErrorCode[] = [
  'not_found',
  'invalid',
  'network',
  'auth',
  'timeout',
  'io',
  'db',
  'unsupported',
  'conflict',
  'internal',
];

function isErrorPayload(v: unknown): v is RpcErrorPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(o.code) &&
    typeof o.message === 'string'
  );
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

/** True inside the Tauri webview. */
export const isDesktop: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const API_BASE = '/api';

async function callDesktop(cmd: string, args: unknown): Promise<unknown> {
  try {
    return await invoke('rpc', { cmd, args: args ?? null });
  } catch (err) {
    throw RpcError.from(err);
  }
}

async function callWeb(cmd: string, args: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/rpc/${encodeURIComponent(cmd)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? null),
    });
  } catch (err) {
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
export function rpcRaw(cmd: string, args?: unknown): Promise<unknown> {
  return isDesktop ? callDesktop(cmd, args) : callWeb(cmd, args);
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
 * (`app.info.proxyBase`), fetched once at startup. Null until known or when
 * the proxy could not start.
 */
let desktopProxyBase: string | null = null;

/** Sets the desktop proxy base (exported for tests). */
export function setDesktopProxyBase(base: string | null): void {
  desktopProxyBase = base;
}

if (isDesktop) {
  callDesktop('app.info', null)
    .then((info) => {
      const base = (info as { proxyBase?: unknown } | null)?.proxyBase;
      setDesktopProxyBase(typeof base === 'string' && base ? base : null);
    })
    .catch(() => undefined);
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
 * Desktop: a local `file` path goes through the asset protocol; an http(s)
 * stream that needs request headers goes through the loopback proxy
 * (`app.info.proxyBase`), everything else loads directly.
 * Web: through `/api/proxy` when source headers are needed or the page would block mixed content.
 */
export function proxiedUrl(source: PlayerSource): string {
  const { url } = source;
  if (isDesktop) {
    if (source.kind === 'file' && !/^(https?|asset):/i.test(url)) return convertFileSrc(url);
    if (desktopProxyBase && /^https?:/i.test(url) && (hasHeaders(source) || isMixedContent(url))) {
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
