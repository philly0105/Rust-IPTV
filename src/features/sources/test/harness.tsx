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
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';

import { queryClient } from '@/api/query';
import { DEFAULT_SETTINGS, type Settings, type Source } from '@/api/types';
import { useShellStore } from '@/shell/store';

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

/**
 * Resolves `lazy` route modules up front, so a test's first render is the
 * page itself (loading states included) rather than the router's pending tick.
 */
export async function eagerRoutes(routes: RouteObject[]): Promise<RouteObject[]> {
  return Promise.all(
    routes.map(async ({ lazy, ...route }) =>
      typeof lazy === 'function' ? ({ ...route, ...(await lazy()) } as RouteObject) : ({ ...route, lazy } as RouteObject),
    ),
  );
}

/**
 * Picks an action from a source card's More menu ("Remove", "Subscription details",
 * "Hidden and renamed channels"). The card's first card when none is given.
 */
export function chooseCardAction(name: string | RegExp, card: HTMLElement = screen.getAllByTestId('source-card')[0]!): void {
  fireEvent.click(within(card).getByRole('button', { name: /^More actions for/ }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

/**
 * Closes the Add or Edit source dialog the way a user who typed details does: the close
 * request (Cancel, Escape, the X) asks "Discard changes?" first (SS-1), and Discard closes it.
 */
export function confirmDiscard(): void {
  fireEvent.click(screen.getByTestId('discard-confirm'));
}

/** The page's header actions, which the shell would draw; tests render pages without the shell. */
function HeaderActions() {
  const actions = useShellStore((s) => s.header?.actions);
  return actions ? <div data-testid="test-header-actions">{actions}</div> : null;
}

/** `headerActions`: also draw the actions the page puts in the shell header (a phone's Sources page). */
export function renderAt(routes: RouteObject[], path: string, opts: { headerActions?: boolean } = {}) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {opts.headerActions ? <HeaderActions /> : null}
    </QueryClientProvider>,
  );
  return { ...view, router };
}
