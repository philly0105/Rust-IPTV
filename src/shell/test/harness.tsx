import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';

import { queryClient } from '@/api/query';
import { DEFAULT_SETTINGS, type Settings, type Source } from '@/api/types';

/** Shared fake rpc. Tests set `handlers[cmd]`; unmocked commands reject. */
export const rpcMock = {
  handlers: {} as Record<string, (args: unknown) => unknown>,
  calls: [] as { cmd: string; args: unknown }[],
  async call(cmd: string, args?: unknown): Promise<unknown> {
    rpcMock.calls.push({ cmd, args });
    const h = rpcMock.handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  },
  reset() {
    for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
    rpcMock.calls.length = 0;
  },
};

export const playerMock = {
  playItem: vi.fn(async () => {}),
};

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

export function makeSource(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    kind: 'xtream',
    name: `Source ${id}`,
    position: 0,
    autoRefresh: false,
    createdAt: '2026-10-01T00:00:00Z',
    channelCount: 120,
    movieCount: 40,
    seriesCount: 0,
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
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  Element.prototype.scrollBy ??= function scrollBy() {};
}

export function renderRoutes(routes: RouteObject[], path: string) {
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

export function Page({ children }: { children?: ReactNode }) {
  return <div data-testid="page">{children}</div>;
}
