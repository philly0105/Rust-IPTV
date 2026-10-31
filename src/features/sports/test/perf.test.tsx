// The Sports page on a big account (test/slate.ts: 8,000 channels in 40 sports groups, 12 programmes each
// with 300-character descriptions, a 60-game Saturday slate). Prints what the page costs: describing the
// index rows, the matching pass, the index and guide reads against a mocked core with fixed latencies and
// 8 connections, the epg.grid calls and answer bytes, the peak of calls in flight, the longest stretch the
// main thread was held, and a league switch. Checks that the candidate filter finds what a scan over every
// channel finds, that a guide prepared for the games' teams matches as one read whole, that the page keeps
// to its read limit, and that a league switch asks the guide nothing again. With node --expose-gc
// (NODE_OPTIONS), it also prints the heap the prepared guide holds.
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef } from '@/api/types';

import type { Game, League } from '../lib/types';
import cfb from './fixtures/cfb.json';
import mlb from './fixtures/mlb.json';
import nba from './fixtures/nba.json';
import nfl from './fixtures/nfl.json';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const { queryClient } = await import('@/api/query');
const { itemKey } = await import('@/api/types');
const { firstWordsOf, matchGame, matchGameScanForTests, prepareMatch, programmeWordsKeptForTests, sharedNetworks } = await import('../lib/match');
const { useGameStreams } = await import('../hooks/useGameStreams');
const { NETWORK_SEARCH_LIMIT, toIndexed } = await import('../hooks/useChannelIndex');
const { etDate, normalizeScoreboard } = await import('../lib/espn');
const { PAGE_READS } = await import('../hooks/sportsRead');
const { NETWORKS } = await import('../lib/names');
const slate = await import('./slate');

const log = (line: string) => console.log(`[sports perf] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (n: number) => `${Math.round(n)} ms`;

/** The heap in use after a full collection, in MB; null unless node runs with --expose-gc. */
function heapMb(): number | null {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return null;
  gc();
  return process.memoryUsage().heapUsed / 1e6;
}

/** The longest gap between timer callbacks while `run` goes: how long the main thread was held at once. */
async function longestBlock<T>(run: () => Promise<T>): Promise<{ value: T; longest: number }> {
  let longest = 0;
  let last = performance.now();
  let on = true;
  const beat = () => {
    const t = performance.now();
    longest = Math.max(longest, t - last);
    last = t;
    if (on) setTimeout(beat, 0);
  };
  setTimeout(beat, 0);
  let value: T;
  try {
    value = await run();
  } finally {
    on = false;
  }
  await sleep(1);
  return { value, longest: Math.max(longest, performance.now() - last) };
}

describe('matching a 60-game slate against 8,000 channels', () => {
  it('describes the index rows', () => {
    // Fresh rows, as a refetch that moved them hands over: none is described yet.
    const rows = slate.SLATE_CHANNEL_LIST.map((c) => ({ ...c }));
    const t = performance.now();
    for (const c of rows) toIndexed(c, slate.SLATE_SOURCE, true);
    log(`index: ${rows.length} rows described in ${ms(performance.now() - t)}`);
  });

  it('prepares in slices, then checks each game against its candidates only, with the same result as a full scan', async () => {
    const index = slate.slateIndex();
    const programs = slate.slateProgrammes();
    // What useGameStreams prepares with: its games' teams' first words, and the networks they share.
    const words = new Set(firstWordsOf(slate.SLATE));
    const shared = sharedNetworks(slate.SLATE);
    const matchAll = (map: typeof programs) => slate.SLATE.map((g) => matchGame(g, index, map, slate.SATURDAY_NOW, shared.get(g.key)));
    const heapBefore = heapMb();
    let t = performance.now();
    const { longest } = await longestBlock(() => prepareMatch(index, programs, undefined, words));
    const prepareMs = performance.now() - t;
    const heapPrepared = heapMb();
    t = performance.now();
    const first = matchAll(programs);
    const firstMs = performance.now() - t;
    const heapMatched = heapMb();
    t = performance.now();
    const again = matchAll(programs);
    const againMs = performance.now() - t;
    t = performance.now();
    const scan = slate.SLATE.map((g) => matchGameScanForTests(g, index, programs, slate.SATURDAY_NOW, shared.get(g.key)));
    const scanMs = performance.now() - t;
    expect(first).toEqual(scan);
    expect(again).toEqual(scan);
    // The same games over the same guide as fresh objects, unprepared: every programme read whole.
    expect(matchAll(slate.slateProgrammes())).toEqual(first);
    const all = [...programs.values()].flat();
    const kept = all.filter(programmeWordsKeptForTests).length;
    const reasons = scan.flat().reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.reason]: (acc[m.reason] ?? 0) + 1 }), {});
    const heap =
      heapBefore === null ? '' : `; heap +${Math.round(heapPrepared! - heapBefore)} MB prepared, +${Math.round(heapMatched! - heapBefore)} MB matched`;
    log(
      `matching: prepare ${ms(prepareMs)} (longest block ${ms(longest)}), first pass ${ms(firstMs)}, again ${ms(againMs)}; ` +
        `full scan ${ms(scanMs)}; matches ${JSON.stringify(reasons)}; every word kept of ${kept} of ${all.length} programmes${heap}`,
    );
    expect(kept).toBeLessThan(all.length / 50);
  }, 120_000);

  it('matches the ESPN fixtures’ games over a guide prepared for them, or for other games, as over one read whole', async () => {
    // Every league's fixture games, moved onto the slate's day so the guide and the undated event names reach them.
    const DAY = 24 * 60 * 60_000;
    const target = Date.parse('2026-10-24T20:00:00Z');
    const fixtures = ([['nfl', nfl], ['nba', nba], ['mlb', mlb], ['cfb', cfb]] as [League, unknown][]).flatMap(([league, json]) =>
      normalizeScoreboard(league, json).map((g) => {
        const startMs = g.startMs + Math.round((target - g.startMs) / DAY) * DAY;
        return { ...g, key: `fixture-${g.key}`, startMs, etDate: etDate(startMs) };
      }),
    );
    const games = [...slate.SLATE, ...fixtures];
    const index = slate.slateIndex();
    const shared = sharedNetworks(games);
    const matchAll = (map: ReturnType<typeof slate.slateProgrammes>) => games.map((g) => matchGame(g, index, map, slate.SATURDAY_NOW, shared.get(g.key)));
    const whole = matchAll(slate.slateProgrammes());
    for (const words of [firstWordsOf(games), firstWordsOf(slate.SLATE)]) {
      const programs = slate.slateProgrammes();
      await prepareMatch(index, programs, undefined, new Set(words));
      expect(matchAll(programs)).toEqual(whole);
    }
    expect(whole.flat().filter((m) => m.reason === 'guide').length).toBeGreaterThan(400);
  }, 120_000);
});

describe('the page’s reads on a big account', () => {
  const LATENCY: Record<string, number> = { 'catalog.channels': 10, 'catalog.search': 15, 'epg.grid': 150 };
  const CONNECTIONS = 8;

  let busy = 0;
  const queue: (() => void)[] = [];
  /** The core: at most 8 calls at once (its database connections), first come first served. */
  async function core<T>(latency: number, work: () => T): Promise<{ value: T; waited: number }> {
    const t = performance.now();
    if (busy < CONNECTIONS) busy++;
    else await new Promise<void>((r) => queue.push(r));
    const waited = performance.now() - t;
    try {
      await sleep(latency);
      return { value: work(), waited };
    } finally {
      const next = queue.shift();
      if (next) next();
      else busy--;
    }
  }

  /** Like the core: every word of the query is a word prefix of the name. Answered ahead (the core's work). */
  const searches = new Map<string, Channel[]>();
  function search(query: string, limit: number): Channel[] {
    const key = `${query}|${limit}`;
    let hits = searches.get(key);
    if (!hits) {
      const words = query.toLowerCase().split(/\s+/);
      hits = slate.SLATE_CHANNEL_LIST.filter((ch) => {
        const parts = ch.name.toLowerCase().split(/[^a-z0-9+]+/);
        return words.every((w) => parts.some((n) => n.startsWith(w)));
      }).slice(0, limit);
      searches.set(key, hits);
    }
    return hits;
  }

  let guideJson: string[] = [];
  let bareJson: string[] = [];

  const stats = { inFlight: 0, peak: 0, gridInFlight: 0, gridPeak: 0, gridCalls: 0, gridBytes: 0, gridBytesBare: 0 };
  /** When the last answer of each command came back before the guide was asked. */
  const lastAnswer: Record<string, number> = {};
  let firstGrid = 0;
  let lastGrid = 0;
  let probeWait = -1;

  function answer(cmd: string, args: unknown): unknown {
    switch (cmd) {
      case 'sources.list':
        return [slate.SLATE_SOURCE];
      case 'settings.get':
        return { epgOffsetMinutes: 0 };
      case 'catalog.categories':
        return slate.slateCategories();
      case 'catalog.channels': {
        // Fresh rows, as a parsed answer is: the page describes each of them (the matching test above described
        // the slate's own objects).
        const a = args as { categoryId: string; query: { offset: number; limit: number } };
        const all = slate.SLATE_CHANNEL_LIST.filter((c) => c.categoryId === a.categoryId);
        const items = all.slice(a.query.offset, a.query.offset + a.query.limit).map((c) => ({ ...c }));
        return { items, total: all.length, offset: a.query.offset, limit: a.query.limit };
      }
      case 'catalog.search': {
        const a = args as { query: string; limit: number };
        return { live: search(a.query, a.limit), movies: [], series: [] };
      }
      case 'epg.grid': {
        // Every programme of the slate is inside the slate's window, so the answer is each ref's whole guide,
        // serialized ahead (the core's work) and parsed here, as the transport hands it over.
        const a = args as { refs: ItemRef[] };
        const parts = a.refs.map((ref) => `${JSON.stringify(itemKey(ref))}:${guideJson[slate.positionOf(ref.itemId)]!}`);
        const json = `{${parts.join(',')}}`;
        stats.gridBytes += json.length;
        stats.gridBytesBare += a.refs.reduce((n, ref) => {
          const i = slate.positionOf(ref.itemId);
          return n - guideJson[i]!.length + bareJson[i]!.length;
        }, json.length);
        return JSON.parse(json);
      }
      default:
        throw new Error(`unmocked rpc ${cmd}`);
    }
  }

  beforeAll(() => {
    for (const query of new Set(NETWORKS.map((n) => n.search))) search(query, NETWORK_SEARCH_LIMIT);
    guideJson = slate.SLATE_CHANNEL_LIST.map((_, i) => JSON.stringify(slate.programmesOf(i)));
    bareJson = slate.SLATE_CHANNEL_LIST.map((_, i) => JSON.stringify(slate.programmesOf(i).map(({ description: _d, ...rest }) => rest)));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(slate.SATURDAY_NOW);
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    rpcMock.current = {
      call: async (cmd, args) => {
        const latency = LATENCY[cmd] ?? 0;
        if (latency === 0) return answer(cmd, args);
        const grid = cmd === 'epg.grid';
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        if (grid) {
          stats.gridCalls++;
          stats.gridInFlight++;
          stats.gridPeak = Math.max(stats.gridPeak, stats.gridInFlight);
          if (firstGrid === 0) {
            firstGrid = performance.now();
            // A Live page read made while the guide loads: how long it waits for a connection.
            setTimeout(() => void core(5, () => null).then((r) => (probeWait = r.waited)), 20);
          }
        }
        try {
          return (await core(latency, () => answer(cmd, args))).value;
        } finally {
          stats.inFlight--;
          if (firstGrid === 0) lastAnswer[cmd] = performance.now();
          if (grid) {
            stats.gridInFlight--;
            lastGrid = performance.now();
          }
        }
      },
    };
  });
  afterEach(cleanup);
  afterAll(() => {
    vi.useRealTimers();
    queryClient.clear();
  });

  it('loads the index, the guide and the matches', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const games = slate.SLATE;
    const t0 = performance.now();
    const { value: result, longest } = await longestBlock(async () => {
      const { result } = renderHook(() => useGameStreams(games), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 120_000, interval: 5 });
      return result;
    });
    const settled = performance.now() - t0;
    const matched = games.filter((g) => (result.current.streams.get(g.key)?.length ?? 0) > 0).length;
    log(
      `reads: groups ${ms(lastAnswer['catalog.channels']! - t0)}, network searches ${ms(lastAnswer['catalog.search']! - t0)}, ` +
        `index ${ms(firstGrid - t0)}, guide ${ms(lastGrid - firstGrid)}, settled ${ms(settled)}; ` +
        `epg.grid ${stats.gridCalls} calls, ${(stats.gridBytes / 1e6).toFixed(1)} MB (${(stats.gridBytesBare / 1e6).toFixed(1)} MB without descriptions); ` +
        `peak in flight ${stats.peak} (epg.grid ${stats.gridPeak}); a read made during the guide waited ${ms(probeWait)}; ` +
        `longest main-thread block ${ms(longest)}; ${matched}/${games.length} games with streams`,
    );
    expect(matched).toBeGreaterThan(0);
    expect(stats.peak).toBeLessThanOrEqual(PAGE_READS);
  }, 180_000);

  it('switches league without asking or preparing the guide again once it covers every league', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const nba: readonly Game[] = slate.SLATE.filter((g) => g.league === 'nba');
    const all = slate.SLATE;
    /** From the NBA's games to every game: the epg.grid calls the switch makes and how long `loading` holds after it. */
    async function switchCost(window: (games: readonly Game[]) => readonly Game[]) {
      queryClient.removeQueries({ queryKey: ['epg.grid'] });
      const { result, rerender } = renderHook(({ games }) => useGameStreams(games, true, window(games)), { wrapper, initialProps: { games: nba } });
      await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 120_000, interval: 5 });
      const calls = stats.gridCalls;
      const t = performance.now();
      rerender({ games: all });
      const loadingAfter = result.current.loading;
      await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 120_000, interval: 5 });
      const cost = { calls: stats.gridCalls - calls, ms: performance.now() - t, loadingAfter };
      cleanup();
      return cost;
    }
    // The window of the games on screen only, as a remembered league opens.
    const narrow = await switchCost((games) => games);
    // Every league's games, as after a league switch or with All on show.
    const wide = await switchCost(() => all);
    log(
      `league switch, NBA to All: window of the league ${narrow.calls} epg.grid calls, loading ${ms(narrow.ms)}; ` +
        `window of every league ${wide.calls} calls, loading ${ms(wide.ms)}`,
    );
    expect(narrow.calls).toBeGreaterThan(0);
    expect(wide).toMatchObject({ calls: 0, loadingAfter: false });
  }, 180_000);
});
