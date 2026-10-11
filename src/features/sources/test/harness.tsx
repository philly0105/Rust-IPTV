/**
 * Test helpers for the sources and settings slices. Pair with:
 *
 *   vi.mock('@/api/transport', async (orig) => ({
 *     ...(await orig<typeof import('@/api/transport')>()),
 *     rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
 *     isDesktop: false,
 *   }));
 */

import '@/i18n';

import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';

import { queryClient } from '@/api/query';
import { DEFAULT_SETTINGS, type Settings, type Source } from '@/api/types';

type Handler = (args: unknown) => unknown;

/** Fake rpc: tests set `handlers[cmd]`; unmocked commands reject. */
export const rpcMock = {
  handlers: {} as Record<string, Handler>,
  calls: [] as { cmd: string; args: unknown }[],
  async call(cmd: string, args?: unknown): Promise<unknown> {
    rpcMock.calls.push({ cmd, args });
    const h = rpcMock.handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  },
  callsOf(cmd: string): unknown[] {
    return rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  },
  reset() {
    for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
    rpcMock.calls.length = 0;
  },
};

/** A promise that never settles, for loading states. */
export const pending = (): Promise<never> => new Promise<never>(() => undefined);

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

export function makeSource(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    kind: 'm3u',
    name: `Source ${id}`,
    position: 0,
    autoRefresh: false,
    createdAt: '2026-10-01T00:00:00Z',
    lastRefreshAt: '2026-10-10T00:00:00Z',
    channelCount: 120,
    movieCount: 0,
    seriesCount: 0,
    m3u: { origin: 'url', url: 'http://lists.example.com/tv.m3u' },
    epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] },
    ...over,
  } as Source;
}

export function installDomStubs(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

export function renderAt(routes: RouteObject[], path: string) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}
