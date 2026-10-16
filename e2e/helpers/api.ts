import type { APIRequestContext } from '@playwright/test';

import type { AppInfo, FavoriteEntry, Settings, Source } from '../../src/api/types';
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

/**
 * Run 3 C7: marks the first-run tour as done and the running version as seen, so neither the tour
 * nor What's new opens over the pages a spec tests. `settings.reset` keeps both markers, so once
 * per data dir is enough; the fixtures do it for every worker (e2e/onboarding.spec.ts sets its own).
 */
export async function markOnboardingSeen(request: APIRequestContext): Promise<void> {
  const { version } = await rpc<AppInfo>(request, 'app.info');
  await rpc<Settings>(request, 'settings.update', { patch: { tourCompleted: true, lastSeenVersion: version } });
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

/**
 * Adds a source over rpc (fast path for specs that do not test the add flow). Reuses a working one
 * with the same name, else the one that already uses this mock address: `sources.add` refuses a
 * second source on one address (409, `details.existingSourceId`). A reused source is renamed to
 * `name`; one whose import failed is removed and added again.
 */
export async function ensureSource(request: APIRequestContext, kind: SourceKindName, name: string): Promise<Source> {
  const existing = (await listSources(request)).find((s) => s.name === name && s.kind === kind && !s.lastError);
  if (existing) return existing;
  try {
    return await rpc<Source>(request, 'sources.add', addArgs(kind, name));
  } catch (err) {
    const id = existingSourceId(err);
    const same = id ? (await listSources(request)).find((s) => s.id === id) : undefined;
    if (!same) throw err;
    if (same.lastError) {
      await rpc(request, 'sources.remove', { id: same.id });
      return rpc<Source>(request, 'sources.add', addArgs(kind, name));
    }
    return same.name === name ? same : rpc<Source>(request, 'sources.update', { id: same.id, patch: { name } });
  }
}

/** The source a refused duplicate `sources.add` names (409 with `details.existingSourceId`). */
function existingSourceId(err: unknown): string | undefined {
  if (!(err instanceof RpcCallError) || err.status !== 409) return undefined;
  try {
    const id = (JSON.parse(err.body) as { details?: { existingSourceId?: unknown } }).details?.existingSourceId;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

export function favorites(request: APIRequestContext): Promise<FavoriteEntry[]> {
  return rpc<FavoriteEntry[]>(request, 'favorites.list', {});
}
