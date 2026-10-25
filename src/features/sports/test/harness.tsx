/**
 * Test harness for the sports page: an i18n instance with the real English strings, an RPC
 * recorder, builders for games, channels and matched streams, and a router render that exposes
 * the current URL.
 *
 * Page tests mock `@/api/transport` (rpc only, the real RpcError stays), `@/api/events`, the game
 * and stream hooks and the player, then import this module dynamically so it sees the mocks.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { queryClient } from '@/api/query';
import type { Channel, Source } from '@/api/types';
import common from '@/i18n/en/common.json';
import live from '@/i18n/en/live.json';
import multiview from '@/i18n/en/multiview.json';
import sports from '@/i18n/en/sports.json';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useShellStore } from '@/shell/store';
import { useToastStore } from '@/ui';

import { etDate } from '../lib/espn';
import type { StreamMatch } from '../lib/match';
import type { Game, GameTeam } from '../lib/types';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['sports', 'common', 'live', 'multiview'],
  defaultNS: 'sports',
  resources: { en: { sports, common, live, multiview } },
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
export const TWO_SOURCES: Partial<Source>[] = [...SOURCES, { id: 'src2', kind: 'm3u', name: 'Backup list' }];

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export function team(abbreviation: string, displayName: string, over: Partial<GameTeam> = {}): GameTeam {
  const words = displayName.split(' ');
  return {
    id: abbreviation,
    abbreviation,
    displayName,
    shortDisplayName: words.at(-1) ?? displayName,
    name: words.at(-1) ?? displayName,
    location: words.slice(0, -1).join(' '),
    logo: `https://a.espncdn.com/i/teamlogos/${abbreviation.toLowerCase()}.png`,
    color: null,
    score: null,
    winner: null,
    record: null,
    rank: null,
    ...over,
  };
}

export const CELTICS = team('BOS', 'Boston Celtics', { record: '4-2' });
export const KNICKS = team('NY', 'New York Knicks', { record: '3-3' });

/**
 * A game, scheduled an hour from now on today's Eastern date unless `over` says otherwise. Celtics
 * at Knicks by default; `key` and `etDate` follow `league`, `id` and `startMs`.
 */
export function game(id: string, over: Partial<Game> = {}): Game {
  const league = over.league ?? 'nba';
  const startMs = over.startMs ?? Date.now() + HOUR;
  return {
    id,
    league,
    startMs,
    etDate: etDate(startMs),
    timeValid: true,
    timeNote: null,
    state: 'pre',
    phase: 'scheduled',
    detail: '',
    shortDetail: '',
    period: 0,
    displayClock: '0:00',
    seasonType: 2,
    week: null,
    home: KNICKS,
    away: CELTICS,
    neutralSite: false,
    venue: null,
    note: null,
    seriesSummary: null,
    broadcasts: [],
    gamecastUrl: null,
    ...over,
    key: `${league}:${id}`,
  };
}

/** A game in progress: started 40 minutes ago, Q3 with scores. */
export function liveGame(id: string, over: Partial<Game> = {}): Game {
  return game(id, {
    startMs: Date.now() - 40 * MINUTE,
    state: 'in',
    phase: 'live',
    period: 3,
    displayClock: '5:42',
    shortDetail: 'Q3 5:42',
    home: { ...KNICKS, score: 71 },
    away: { ...CELTICS, score: 78 },
    ...over,
  });
}

/** A finished game: started five hours ago, Celtics won. */
export function finalGame(id: string, over: Partial<Game> = {}): Game {
  return game(id, {
    startMs: Date.now() - 5 * HOUR,
    state: 'post',
    phase: 'final',
    shortDetail: 'Final',
    home: { ...KNICKS, score: 101, winner: false },
    away: { ...CELTICS, score: 110, winner: true },
    ...over,
  });
}

export function channel(itemId: string, name: string, over: Partial<Channel> = {}): Channel {
  return { ref: { sourceId: 'src1', contentType: 'live', itemId }, name, categoryId: 'sports', categoryName: 'USA Sports', isRadio: false, ...over };
}

export function match(ch: Channel, over: Partial<StreamMatch> = {}): StreamMatch {
  return { channel: ch, sourceId: ch.ref.sourceId, sourceKind: 'xtream', sourceName: 'Home portal', reason: 'network', regional: false, program: null, ...over };
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
