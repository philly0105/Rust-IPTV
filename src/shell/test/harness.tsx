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

/**
 * A ResizeObserver the test drives (P2-RAILS-2): the rail reveals its active link from the
 * observer's first callback, after the browser's layout, and jsdom never lays out. `layOut()`
 * stands in for that layout and delivers each watched element's first callback, as an observer
 * reports a new target once and then only when its size changes. Install before rendering;
 * `restore()` puts the previous global back.
 */
export function fakeResizeObservers(): { layOut: () => void; restore: () => void } {
  const original = globalThis.ResizeObserver;
  // Each target and whether its first callback has gone out.
  type Live = { cb: ResizeObserverCallback; targets: Map<Element, boolean>; observer: ResizeObserver };
  const live = new Set<Live>();
  globalThis.ResizeObserver = class {
    private readonly live: Live;
    constructor(cb: ResizeObserverCallback) {
      this.live = { cb, targets: new Map(), observer: this as unknown as ResizeObserver };
      live.add(this.live);
    }
    observe(el: Element) {
      this.live.targets.set(el, false);
    }
    unobserve(el: Element) {
      this.live.targets.delete(el);
    }
    disconnect() {
      this.live.targets.clear();
      live.delete(this.live);
    }
  } as unknown as typeof ResizeObserver;
  return {
    layOut: () => {
      for (const o of [...live]) {
        const fresh = [...o.targets].filter(([, reported]) => !reported).map(([target]) => target);
        for (const target of fresh) o.targets.set(target, true);
        if (fresh.length > 0) o.cb(fresh.map((target) => ({ target }) as ResizeObserverEntry), o.observer);
      }
    },
    restore: () => {
      globalThis.ResizeObserver = original;
    },
  };
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
