// useGames: one ESPN query per league and Eastern day on the app's query client, polled by what the
// day holds (dayPolicy), paused while the document is hidden and stopped on unmount, retried on its
// own, failing rather than pausing while offline, and keeping the last good games on failure. fetch
// is stubbed; fake timers drive the clock.
import { act, cleanup, renderHook } from '@testing-library/react';
import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';

import { dayPolicy, FUTURE_POLL_MS, LIVE_POLL_MS, sportsKey, TODAY_POLL_MS, useLiveGames, useSportsDay } from '../hooks/useGames';
import { scoreboardUrl } from '../lib/espn';
import type { Game, League } from '../lib/types';
import nba from './fixtures/nba.json';
import nfl from './fixtures/nfl.json';

const at = (iso: string) => Date.parse(iso);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Thursday 2026-10-22, noon Eastern. */
const NOON = at('2026-10-22T16:00Z');

type Body = unknown;
type Route = Body | Error | (() => Body | Error);

let routes: Map<string, Route>;
const fetchMock = vi.fn(async (url: string) => {
  const r = routes.get(url);
  if (r === undefined) throw new Error(`unexpected request ${url}`);
  const body = typeof r === 'function' ? (r as () => Body | Error)() : r;
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, json: async () => structuredClone(body) } as unknown as Response;
});

function serve(league: League, day: string, route: Route) {
  routes.set(scoreboardUrl(league, day), route);
}

function callsTo(league: League, day: string): number {
  const url = scoreboardUrl(league, day);
  return fetchMock.mock.calls.filter(([u]) => u === url).length;
}

const board = (...events: unknown[]) => ({ events });

/** A fixture event, deep-copied, optionally moved to another start and made live or final. */
function event(json: { events: unknown[] }, id: string, patch: { date?: string; status?: 'live' | 'final' } = {}) {
  const e = structuredClone(json.events.find((x) => (x as { id: string }).id === id)) as Record<string, unknown>;
  const c = (e.competitions as Record<string, unknown>[])[0]!;
  if (patch.date) e.date = c.date = patch.date;
  if (patch.status === 'live') c.status = { displayClock: '5:12', period: 3, type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false } };
  if (patch.status === 'final') c.status = { displayClock: '0:00', period: 4, type: { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: 'Final' } };
  return e;
}

// NBA 401909093 is Cavaliers at 76ers, 7 PM ET on 2026-10-22; 401909835 a final from 2026-10-21.
const tonight = () => event(nba, '401909093');
const liveTonight = () => event(nba, '401909093', { status: 'live' });
const finalTonight = () => event(nba, '401909093', { status: 'final' });

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

/**
 * Lets fetches, React Query's notifications and React's renders run. Steps of 1 ms, not 0: the fake
 * clock gives a zero-delay timer set during a tick 1 ms, and React Query batches through those.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOON);
  routes = new Map();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useSportsDay', () => {
  it('fetches the day once per league and merges the games by start', async () => {
    serve('nba', '2026-10-22', board(tonight()));
    serve('nfl', '2026-10-22', board(event(nfl, '401873010')));
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nfl', 'nba']), { wrapper });
    expect(result.current.loading).toBe(true);
    expect(result.current.games).toEqual([]);
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    // 7 PM ET basketball before 8:15 PM ET football.
    expect(result.current.games.map((g) => g.key)).toEqual(['nba:401909093', 'nfl:401873010']);
    expect(callsTo('nba', '2026-10-22')).toBe(1);
    expect(callsTo('nfl', '2026-10-22')).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sportsKey('nba', '2026-10-22')).toEqual(['sports.espn', 'nba', '2026-10-22']);
    expect(queryClient.getQueryData<Game[]>(sportsKey('nfl', '2026-10-22'))?.[0]?.id).toBe('401873010');
  });

  it('polls every 30 s while a game is live, and every 5 min once it is over', async () => {
    let live = true;
    serve('nba', '2026-10-22', () => board(live ? liveTonight() : finalTonight()));
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    expect(result.current.games[0]?.phase).toBe('live');
    await advance(LIVE_POLL_MS - SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(1);
    await advance(SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(2);
    live = false;
    await advance(LIVE_POLL_MS);
    expect(callsTo('nba', '2026-10-22')).toBe(3);
    expect(result.current.games[0]?.phase).toBe('final');
    // Today with nothing live: back to 5 minutes.
    await advance(TODAY_POLL_MS - SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(3);
    await advance(SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(4);
  });

  it('polls today every 5 min while the games are hours away', async () => {
    serve('nba', '2026-10-22', board(tonight()));
    renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    await advance(LIVE_POLL_MS * 2);
    expect(callsTo('nba', '2026-10-22')).toBe(1);
    await advance(TODAY_POLL_MS - LIVE_POLL_MS * 2);
    expect(callsTo('nba', '2026-10-22')).toBe(2);
  });

  it('speeds up to 30 s ten minutes before a start', async () => {
    vi.setSystemTime(at('2026-10-22T22:45Z')); // 15 min before the 7 PM tip
    serve('nba', '2026-10-22', board(tonight()));
    renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    // 5 min later (one 5 min poll) the game is 10 min away; from then on every 30 s.
    await advance(TODAY_POLL_MS);
    expect(callsTo('nba', '2026-10-22')).toBe(2);
    await advance(LIVE_POLL_MS);
    expect(callsTo('nba', '2026-10-22')).toBe(3);
  });

  it('never refetches a finished past day, even after a remount', async () => {
    serve('nba', '2026-10-21', board(event(nba, '401909835'), event(nba, '401909091')));
    const first = renderHook(() => useSportsDay('2026-10-21', ['nba']), { wrapper });
    await settle();
    expect(first.result.current.games).toHaveLength(2);
    await advance(2 * HOUR);
    expect(callsTo('nba', '2026-10-21')).toBe(1);
    first.unmount();
    const second = renderHook(() => useSportsDay('2026-10-21', ['nba']), { wrapper });
    await settle();
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.games).toHaveLength(2);
    // Showing the window again does not refetch it either.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();
    expect(callsTo('nba', '2026-10-21')).toBe(1);
  });

  it('keeps polling yesterday while a game there runs past midnight', async () => {
    vi.setSystemTime(at('2026-10-22T04:30Z')); // 12:30 AM ET on the 22nd
    let live = true;
    serve('nba', '2026-10-21', () => board(event(nba, '401909835', { date: '2026-10-22T02:00Z', status: live ? 'live' : 'final' })));
    const { result } = renderHook(() => useSportsDay('2026-10-21', ['nba']), { wrapper });
    await settle();
    expect(result.current.games[0]?.state).toBe('in');
    live = false;
    await advance(LIVE_POLL_MS);
    expect(callsTo('nba', '2026-10-21')).toBe(2);
    expect(result.current.games[0]?.state).toBe('post');
    // Over now, so the day is settled.
    await advance(HOUR);
    expect(callsTo('nba', '2026-10-21')).toBe(2);
  });

  it('polls future days hourly', async () => {
    serve('nba', '2026-10-24', board(event(nba, '401909851')));
    renderHook(() => useSportsDay('2026-10-24', ['nba']), { wrapper });
    await settle();
    await advance(FUTURE_POLL_MS - MINUTE);
    expect(callsTo('nba', '2026-10-24')).toBe(1);
    await advance(MINUTE);
    expect(callsTo('nba', '2026-10-24')).toBe(2);
  });

  it('pauses while the document is hidden and catches up when it shows', async () => {
    serve('nba', '2026-10-22', () => board(liveTonight()));
    renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    act(() => focusManager.setFocused(false));
    await advance(3 * LIVE_POLL_MS);
    expect(callsTo('nba', '2026-10-22')).toBe(1);
    act(() => focusManager.setFocused(true));
    await settle();
    expect(callsTo('nba', '2026-10-22')).toBe(2);
    await advance(LIVE_POLL_MS);
    expect(callsTo('nba', '2026-10-22')).toBe(3);
  });

  it('stops polling when the page unmounts', async () => {
    serve('nba', '2026-10-22', () => board(liveTonight()));
    const { unmount } = renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    unmount();
    await advance(10 * MINUTE);
    expect(callsTo('nba', '2026-10-22')).toBe(1);
  });

  it('retries a failure twice with backoff, though the app retries only RPC errors', async () => {
    let n = 0;
    serve('nba', '2026-10-22', () => (++n <= 2 ? new TypeError('Failed to fetch') : board(tonight())));
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    expect(n).toBe(1);
    expect(result.current.loading).toBe(true);
    await advance(SECOND);
    expect(n).toBe(2);
    await advance(2 * SECOND);
    expect(n).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.games).toHaveLength(1);
  });

  it('reports the error after the retries, and refetch tries again', async () => {
    let down = true;
    serve('nba', '2026-10-22', () => (down ? new Error('HTTP 503') : board(tonight())));
    serve('nfl', '2026-10-22', board(event(nfl, '401873010')));
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nfl', 'nba']), { wrapper });
    await settle();
    await advance(3 * SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    // The league that answered still shows.
    expect(result.current.games.map((g) => g.key)).toEqual(['nfl:401873010']);
    down = false;
    act(() => result.current.refetch());
    await settle();
    expect(result.current.error).toBeNull();
    expect(result.current.games.map((g) => g.key)).toEqual(['nba:401909093', 'nfl:401873010']);
  });

  it('keeps the last games when a refetch fails', async () => {
    let down = false;
    serve('nba', '2026-10-22', () => (down ? new Error('HTTP 500') : board(liveTonight())));
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    down = true;
    await advance(LIVE_POLL_MS);
    await advance(3 * SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(4);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.loading).toBe(false);
    expect(result.current.games.map((g) => g.key)).toEqual(['nba:401909093']);
    // Still live in the cache, so it keeps polling and recovers.
    down = false;
    await advance(LIVE_POLL_MS);
    expect(result.current.error).toBeNull();
  });

  // The webview fired 'offline'. Under React Query's default network mode the fetch would pause, and a
  // day with nothing cached would stay loading, with no error, for as long as the machine is offline.
  it('fails an offline fetch instead of pausing it, and refetches as soon as the network is back', async () => {
    let offline = true;
    serve('nba', '2026-10-22', () => (offline ? new TypeError('Failed to fetch') : board(tonight())));
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    expect(callsTo('nba', '2026-10-22')).toBe(1);
    await advance(3 * SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeInstanceOf(TypeError);
    expect(result.current.games).toEqual([]);
    // Back online: refetched at once, not at the next 5 min poll.
    offline = false;
    act(() => onlineManager.setOnline(true));
    await settle();
    expect(callsTo('nba', '2026-10-22')).toBe(4);
    expect(result.current.error).toBeNull();
    expect(result.current.games.map((g) => g.key)).toEqual(['nba:401909093']);
  });

  it('keeps the games and reports the error when a poll runs offline, then refetches on reconnect', async () => {
    let offline = false;
    serve('nba', '2026-10-22', () => (offline ? new TypeError('Failed to fetch') : board(tonight())));
    const { result } = renderHook(() => useSportsDay('2026-10-22', ['nba']), { wrapper });
    await settle();
    offline = true;
    onlineManager.setOnline(false);
    await advance(TODAY_POLL_MS);
    await advance(3 * SECOND);
    expect(callsTo('nba', '2026-10-22')).toBe(4);
    expect(result.current.error).toBeInstanceOf(TypeError);
    expect(result.current.games.map((g) => g.key)).toEqual(['nba:401909093']);
    offline = false;
    act(() => onlineManager.setOnline(true));
    await settle();
    expect(callsTo('nba', '2026-10-22')).toBe(5);
    expect(result.current.error).toBeNull();
  });

  it('reads a newly selected day without showing the old one', async () => {
    serve('nba', '2026-10-22', board(tonight()));
    serve('nba', '2026-10-24', board(event(nba, '401909851')));
    const { result, rerender } = renderHook(({ day }) => useSportsDay(day, ['nba']), { wrapper, initialProps: { day: '2026-10-22' } });
    await settle();
    rerender({ day: '2026-10-24' });
    expect(result.current.loading).toBe(true);
    expect(result.current.games).toEqual([]);
    await settle();
    expect(result.current.games.map((g) => g.id)).toEqual(['401909851']);
  });
});

describe('useLiveGames', () => {
  it("lists games in progress from today's and yesterday's buckets, by league", async () => {
    vi.setSystemTime(at('2026-10-22T04:30Z')); // 12:30 AM ET
    serve('nba', '2026-10-21', board(event(nba, '401909835', { date: '2026-10-22T02:00Z', status: 'live' }), event(nba, '401909091')));
    serve('nba', '2026-10-22', board(tonight()));
    serve('nfl', '2026-10-21', board());
    serve('nfl', '2026-10-22', board(event(nfl, '401873010', { date: '2026-10-22T04:00Z', status: 'live' })));
    const { result } = renderHook(() => useLiveGames(['nba', 'nfl']), { wrapper });
    expect(result.current.loading).toBe(true);
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.games.map((g) => g.key)).toEqual(['nfl:401873010', 'nba:401909835']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('shares its requests with the day view', async () => {
    serve('nba', '2026-10-21', board());
    serve('nba', '2026-10-22', board(liveTonight()));
    renderHook(
      () => {
        useSportsDay('2026-10-22', ['nba']);
        return useLiveGames(['nba']);
      },
      { wrapper },
    );
    await settle();
    expect(callsTo('nba', '2026-10-22')).toBe(1);
    await advance(LIVE_POLL_MS);
    expect(callsTo('nba', '2026-10-22')).toBe(2);
  });

  it('moves on to the new Eastern day at midnight', async () => {
    vi.setSystemTime(at('2026-10-23T03:59:30Z')); // 11:59:30 PM ET on the 22nd
    for (const day of ['2026-10-21', '2026-10-22', '2026-10-23']) serve('mlb', day, board());
    renderHook(() => useLiveGames(['mlb']), { wrapper });
    await settle();
    expect(callsTo('mlb', '2026-10-21')).toBe(1);
    expect(callsTo('mlb', '2026-10-23')).toBe(0);
    await advance(MINUTE);
    expect(callsTo('mlb', '2026-10-23')).toBe(1);
  });
});

describe('dayPolicy', () => {
  const now = NOON;
  const g = (state: Game['state'], startMs: number, timeValid = true) => ({ state, startMs, timeValid }) as Game;
  const live = { staleTime: LIVE_POLL_MS, refetchInterval: LIVE_POLL_MS };
  const today = { staleTime: TODAY_POLL_MS, refetchInterval: TODAY_POLL_MS };
  const future = { staleTime: FUTURE_POLL_MS, refetchInterval: FUTURE_POLL_MS };
  const settled = { staleTime: Infinity, refetchInterval: false };

  it('goes by the date before the first answer', () => {
    expect(dayPolicy('2026-10-21', undefined, now)).toEqual(today);
    expect(dayPolicy('2026-10-22', undefined, now)).toEqual(today);
    expect(dayPolicy('2026-10-23', undefined, now)).toEqual(future);
  });

  it('settles a past day only when every game is over', () => {
    expect(dayPolicy('2026-10-21', [g('post', now - 20 * HOUR), g('post', now - 18 * HOUR)], now)).toEqual(settled);
    expect(dayPolicy('2026-10-15', [], now)).toEqual(settled);
    expect(dayPolicy('2026-10-21', [g('post', now - 20 * HOUR), g('pre', now - 14 * HOUR)], now)).toEqual(today);
    expect(dayPolicy('2026-10-22', [g('post', now - 2 * HOUR)], now)).toEqual(today);
  });

  it('polls fast on any day with a live game', () => {
    expect(dayPolicy('2026-10-21', [g('post', now - 20 * HOUR), g('in', now - 13 * HOUR)], now)).toEqual(live);
    expect(dayPolicy('2026-10-22', [g('in', now - HOUR)], now)).toEqual(live);
  });

  it('polls fast from 10 min before a timed start until 3 h after it', () => {
    expect(dayPolicy('2026-10-22', [g('pre', now + 11 * MINUTE)], now)).toEqual(today);
    expect(dayPolicy('2026-10-22', [g('pre', now + 10 * MINUTE)], now)).toEqual(live);
    expect(dayPolicy('2026-10-22', [g('pre', now - 2 * HOUR)], now)).toEqual(live);
    expect(dayPolicy('2026-10-22', [g('pre', now - 4 * HOUR)], now)).toEqual(today);
    // A TBD slot sits at midnight Eastern all day; it is not about to start.
    expect(dayPolicy('2026-10-22', [g('pre', at('2026-10-22T04:00Z'), false)], now)).toEqual(today);
  });

  it('turns over at midnight Eastern, also on the 25 h day', () => {
    const over = [g('post', at('2026-11-01T20:00Z'))];
    expect(dayPolicy('2026-11-01', over, at('2026-11-02T04:59Z'))).toEqual(today);
    expect(dayPolicy('2026-11-01', over, at('2026-11-02T05:00Z'))).toEqual(settled);
    expect(dayPolicy('2026-11-02', undefined, at('2026-11-02T04:59Z'))).toEqual(future);
  });
});
