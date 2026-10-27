/**
 * Test harness for the stats page: an i18n instance with the real English
 * strings, an RPC recorder, a builder for `stats.summary` results, and a
 * router render that exposes the current URL.
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
import type { ItemRef, Source, WatchStats, WatchStatsDay, WatchStatsTop } from '@/api/types';
import common from '@/i18n/en/common.json';
import stats from '@/i18n/en/stats.json';
// The shared no-source state (sources feature) draws its actions in its own namespace.
import sources from '@/i18n/en/sources.json';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useShellStore } from '@/shell/store';
import { useToastStore } from '@/ui';

import { localDay } from '../reporter';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['stats', 'common', 'sources'],
  defaultNS: 'stats',
  resources: { en: { stats, common, sources } },
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

export const SOURCES: Partial<Source>[] = [{ id: 'src1', kind: 'xtream', name: 'Home portal' }];

/** `count` local days ending today, oldest first, `YYYY-MM-DD`. */
export function lastDays(count: number, today = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i), 12);
    return localDay(d);
  });
}

/**
 * A `stats.summary` result for `count` days ending today. `per` maps a
 * days-ago offset (0 = today) to live and VOD seconds.
 */
export function summary(
  count: 7 | 30,
  per: Record<number, { live?: number; vod?: number }> = {},
  top: { channels?: WatchStatsTop[]; titles?: WatchStatsTop[] } = {},
): WatchStats {
  const days: WatchStatsDay[] = lastDays(count).map((day, i) => {
    const p = per[count - 1 - i] ?? {};
    const live = p.live ?? 0;
    const vod = p.vod ?? 0;
    return { day, seconds: live + vod, liveSeconds: live, vodSeconds: vod };
  });
  return {
    days,
    totalSeconds: days.reduce((n, d) => n + d.seconds, 0),
    topChannels: top.channels ?? [],
    topTitles: top.titles ?? [],
  };
}

export const ref = (contentType: ItemRef['contentType'], itemId: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType, itemId });

export function topItem(r: ItemRef, title: string, seconds: number, extra: Partial<WatchStatsTop> = {}): WatchStatsTop {
  return { ref: r, title, seconds, sourceName: 'Home portal', ...extra };
}

export function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}

export function installDomStubs(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

/** Clears the shared state a test may leave behind. */
export function resetShared(): void {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  useToastStore.setState({ toasts: [] });
  shortcutRegistry.reset();
  useShellStore.setState({ header: null, headerOwner: null });
}

/** The current URL (path + search). */
export const location = { current: '' };
function LocationProbe() {
  const loc = useLocation();
  location.current = `${loc.pathname}${loc.search}`;
  return null;
}

export function renderAt(path: string, routes: { path: string; element: ReactNode }[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
            <Route path="*" element={<p data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
