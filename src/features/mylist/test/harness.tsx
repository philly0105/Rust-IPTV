/**
 * Test harness for My List: an i18n instance with the real English strings,
 * an RPC recorder, a miniature of the core's watchlist (the same ordering and
 * validation rules as crates/iptv-core/src/watchlist), and a router render
 * that exposes the current URL.
 *
 * Test files mock `@/api/transport` (rpc only, the real RpcError stays) and
 * `@/api/events`, then import this module dynamically so it sees the mocks.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { queryClient } from '@/api/query';
import { RpcError } from '@/api/transport';
import { DEFAULT_SETTINGS, sameRef, type ItemRef, type ItemSnapshot, type Settings, type Source, type WatchlistEntry } from '@/api/types';
import common from '@/i18n/en/common.json';
import mylist from '@/i18n/en/mylist.json';
// The shared no-source state (sources feature) draws its actions in its own namespace.
import sources from '@/i18n/en/sources.json';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useShellStore } from '@/shell/store';
import { useToastStore } from '@/ui';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['mylist', 'common', 'sources'],
  defaultNS: 'mylist',
  resources: { en: { mylist, common, sources } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

/** Records every rpc call; handlers are set per test. */
export function createRpcMock() {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  const reset = () => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    calls.length = 0;
  };
  const callsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  return { handlers, calls, call, reset, callsOf };
}
export type RpcMock = ReturnType<typeof createRpcMock>;

export const movie = (itemId: string, title = `Movie ${itemId}`, sourceId = 'src1'): ItemRef & { title: string } => ({
  sourceId,
  contentType: 'movie',
  itemId,
  title,
});

export function entry(
  ref: ItemRef,
  title: string,
  opts: { addedAt?: string; watched?: boolean; subtitle?: string } = {},
): WatchlistEntry {
  const snapshot: ItemSnapshot = { title, contentType: ref.contentType, ...(opts.subtitle ? { subtitle: opts.subtitle } : {}) };
  return { ref, snapshot, addedAt: opts.addedAt ?? '2026-10-01T10:00:00.000Z', watched: opts.watched ?? false };
}

export const ref = (contentType: 'movie' | 'series' | 'live', itemId: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType, itemId });

export const SOURCES: Partial<Source>[] = [
  { id: 'src1', kind: 'xtream', name: 'Home portal', movieCount: 120, seriesCount: 30 },
  { id: 'src2', kind: 'm3u', name: 'Backup list', movieCount: 8, seriesCount: 0 },
];

/**
 * The core's watchlist in miniature. `entries` is the list in the user's
 * order (what `watchlist.list` returns). `fail` makes the next call of a
 * command throw the given RpcError code once.
 */
export function installCore(rpc: RpcMock, initial: WatchlistEntry[] = [], settings: Partial<Settings> = {}) {
  const core = {
    entries: [...initial],
    fail: {} as Record<string, RpcError['code']>,
    now: '2026-10-13T09:00:00.000Z',
  };
  const guard = (cmd: string) => {
    const code = core.fail[cmd];
    if (code) {
      delete core.fail[cmd];
      throw new RpcError(code, `${cmd} refused`);
    }
  };
  rpc.handlers['watchlist.list'] = (raw) => {
    guard('watchlist.list');
    const a = (raw ?? {}) as { sourceId?: string; contentType?: string };
    return core.entries
      .filter((e) => (!a.sourceId || e.ref.sourceId === a.sourceId) && (!a.contentType || e.ref.contentType === a.contentType))
      .map((e) => ({ ...e, snapshot: { ...e.snapshot } }));
  };
  rpc.handlers['watchlist.toggle'] = (raw) => {
    guard('watchlist.toggle');
    const a = raw as { ref: ItemRef; snapshot: ItemSnapshot };
    if (a.ref.contentType !== 'movie' && a.ref.contentType !== 'series') throw new RpcError('invalid', 'only movies and series');
    if (core.entries.some((e) => sameRef(e.ref, a.ref))) {
      core.entries = core.entries.filter((e) => !sameRef(e.ref, a.ref));
      return { inList: false };
    }
    core.entries = [{ ref: a.ref, snapshot: { ...a.snapshot, contentType: a.ref.contentType }, addedAt: core.now, watched: false }, ...core.entries];
    return { inList: true };
  };
  rpc.handlers['watchlist.contains'] = (raw) => {
    guard('watchlist.contains');
    const a = raw as { refs: ItemRef[] };
    return a.refs.filter((r) => core.entries.some((e) => sameRef(e.ref, r)));
  };
  rpc.handlers['watchlist.remove'] = (raw) => {
    guard('watchlist.remove');
    const a = raw as { ref: ItemRef };
    core.entries = core.entries.filter((e) => !sameRef(e.ref, a.ref));
  };
  rpc.handlers['watchlist.reorder'] = (raw) => {
    guard('watchlist.reorder');
    const a = raw as { refs: ItemRef[] };
    // The core's rule: listed refs fill the slots they held before, in the
    // given order; unlisted entries stay where they are. Refs not in the list
    // are ignored and a ref listed twice keeps its first place.
    const listed: WatchlistEntry[] = [];
    for (const r of a.refs) {
      const e = core.entries.find((x) => sameRef(x.ref, r));
      if (e && !listed.includes(e)) listed.push(e);
    }
    let next = 0;
    core.entries = core.entries.map((e) => (listed.includes(e) ? listed[next++]! : e));
  };
  rpc.handlers['settings.get'] = () => ({ ...DEFAULT_SETTINGS, ...settings });
  rpc.handlers['sources.list'] = () => SOURCES;
  return core;
}

/** Titles in the core's order. */
export const titles = (list: readonly WatchlistEntry[]) => list.map((e) => e.snapshot.title);

export function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}

/** jsdom has no layout: give virtualizers a desktop-sized box. */
export function installDomStubs(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (s: string) => s.replace(/["\\]/g, '\\$&');
}

/** Clears the shared state a test may leave behind. */
export function resetShared(): void {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  useToastStore.setState({ toasts: [] });
  shortcutRegistry.reset();
  useShellStore.setState({ header: null, headerOwner: null });
}

/** The current URL (path + search), for tests that check navigation and URL state. */
export const location = { current: '' };
function LocationProbe() {
  const loc = useLocation();
  location.current = `${loc.pathname}${loc.search}`;
  return null;
}

export function Providers({ children, path = '/' }: { children: ReactNode; path?: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          {children}
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

export function renderAt(path: string, routes: { path: string; element: ReactNode }[]) {
  return render(
    <Providers path={path}>
      <Routes>
        {routes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<p data-testid="elsewhere" />} />
      </Routes>
    </Providers>,
  );
}
