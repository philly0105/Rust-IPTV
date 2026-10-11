import type { APIRequestContext } from '@playwright/test';

import type { FavoriteEntry, Settings, Source } from '../../src/api/types';
import { M3U_URL, MOCK, SERVER, STALKER, XTREAM } from './env';

/** Thrown when `POST /api/rpc/{cmd}` answers with a non-2xx status (body is the RpcError JSON). */
export class RpcCallError extends Error {
  constructor(
    readonly cmd: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`rpc ${cmd} -> HTTP ${status}: ${body}`);
  }
}

/** Shortcut for the C1/C12 HTTP transport: `POST /api/rpc/{cmd}` with the args as JSON body. */
export async function rpc<T = unknown>(request: APIRequestContext, cmd: string, args?: unknown): Promise<T> {
  const res = await request.post(`${SERVER}/api/rpc/${cmd}`, {
    data: args === undefined ? undefined : JSON.stringify(args),
    headers: { 'content-type': 'application/json' },
    timeout: 90_000,
  });
  const text = await res.text();
  if (!res.ok()) throw new RpcCallError(cmd, res.status(), text);
  return (text ? JSON.parse(text) : null) as T;
}

/** Resets mock-side state (stalker token generation, flaky downloads, request stats). */
export async function resetMock(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${MOCK}/__mock/reset`);
  if (!res.ok()) throw new Error(`mock reset failed: HTTP ${res.status()}`);
}

export function listSources(request: APIRequestContext): Promise<Source[]> {
  return rpc<Source[]>(request, 'sources.list');
}

/** Removes every source so a spec starts from the same state as a fresh data dir. */
export async function removeAllSources(request: APIRequestContext): Promise<void> {
  for (const s of await listSources(request)) {
    await rpc(request, 'sources.remove', { id: s.id });
  }
}

/** Fresh-install state: no sources, default settings, mock reset. */
export async function resetApp(request: APIRequestContext): Promise<void> {
  await resetMock(request);
  await removeAllSources(request);
  await rpc<Settings>(request, 'settings.reset');
}

export type SourceKindName = 'm3u' | 'xtream' | 'stalker';

/** sources.add args for each mock portal. */
export function addArgs(kind: SourceKindName, name: string): Record<string, unknown> {
  switch (kind) {
    case 'm3u':
      return { kind, name, m3u: { origin: 'url', url: M3U_URL, headers: {} } };
    case 'xtream':
      return { kind, name, xtream: { ...XTREAM } };
    case 'stalker':
      return { kind, name, stalker: { ...STALKER, isFullPortal: false, headers: {} } };
  }
}

/** Adds a source over rpc (fast path for specs that do not test the add flow). Reuses one with the same name. */
export async function ensureSource(request: APIRequestContext, kind: SourceKindName, name: string): Promise<Source> {
  const existing = (await listSources(request)).find((s) => s.name === name && s.kind === kind && !s.lastError);
  if (existing) return existing;
  return rpc<Source>(request, 'sources.add', addArgs(kind, name));
}

export function favorites(request: APIRequestContext): Promise<FavoriteEntry[]> {
  return rpc<FavoriteEntry[]>(request, 'favorites.list', {});
}
