// The Sports matching hooks against a mocked core: the channel index (sports groups paged whole, hidden and
// other groups skipped, network searches classified and deduplicated, 'catalog.' keys), the guide window
// (chunked refs, the EPG offset both ways), and useGameStreams end to end with the bounded fallback search.
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, EpgProgram, ItemRef, Source } from '@/api/types';

import type { Game, GameTeam, League } from '../lib/types';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const { queryClient, invalidate } = await import('@/api/query');
const { itemKey } = await import('@/api/types');
const { NETWORKS } = await import('../lib/names');
const { etDate } = await import('../lib/espn');
const { toIndexed, useChannelIndex, INDEX_PAGE_LIMIT, NETWORK_SEARCH_LIMIT } = await import('../hooks/useChannelIndex');
const { useGuideWindow, GRID_CHUNK } = await import('../hooks/useGuideWindow');
const { useGameStreams, fallbackQuery, FALLBACK_CONCURRENCY, FALLBACK_LIMIT } = await import('../hooks/useGameStreams');

// ---------------------------------------------------------------------------
// rpc recorder

type Handler = (args: never) => unknown;
const handlers: Record<string, Handler> = {};
const calls: { cmd: string; args: unknown }[] = [];
rpcMock.current = {
  call: async (cmd, args) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args as never);
  },
};
const callsOf = <T,>(cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args as T);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
});

afterEach(() => {
  cleanup();
  for (const k of Object.keys(handlers)) delete handlers[k];
  calls.length = 0;
});

// ---------------------------------------------------------------------------
// data

const SOURCES = [
  { id: 's1', kind: 'xtream', name: 'Home' },
  { id: 's2', kind: 'm3u', name: 'Backup' },
] as Source[];

const ref = (sourceId: string, itemId: string): ItemRef => ({ sourceId, contentType: 'live', itemId });
const ch = (sourceId: string, itemId: string, name: string, over: Partial<Channel> = {}): Channel => ({
  ref: ref(sourceId, itemId),
  name,
  categoryId: 'c',
  categoryName: 'Sports',
  isRadio: false,
  ...over,
});
const cat = (id: string, name: string, itemCount: number, hidden = false): Category => ({
  id,
  sourceId: 's',
  contentType: 'live',
  name,
  hidden,
  itemCount,
  position: 0,
});

interface ChannelsArgs {
  sourceId: string;
  categoryId: string;
  query: { offset: number; limit: number };
}
interface SearchArgs {
  query: string;
  contentTypes: string[];
  limit: number;
}
interface GridArgs {
  refs: ItemRef[];
  from: string;
  to: string;
  withDescription: boolean;
}

/** Answers `catalog.channels` from per-group lists, a page at a time. */
function pages(groups: Record<string, Channel[]>) {
  return (a: ChannelsArgs) => {
    const all = groups[`${a.sourceId}/${a.categoryId}`] ?? [];
    return { items: all.slice(a.query.offset, a.query.offset + a.query.limit), total: all.length, offset: a.query.offset, limit: a.query.limit };
  };
}

function team(abbreviation: string, location: string, name: string): GameTeam {
  return {
    id: abbreviation,
    abbreviation,
    displayName: `${location} ${name}`,
    shortDisplayName: name,
    name,
    location,
    logo: null,
    color: null,
    score: null,
    winner: null,
    record: null,
    rank: null,
  };
}

function game(league: League, away: GameTeam, home: GameTeam, startMs: number, over: Partial<Game> = {}): Game {
  return {
    key: `${league}:${away.abbreviation}-${home.abbreviation}`,
    id: `${away.abbreviation}-${home.abbreviation}`,
    league,
    etDate: etDate(startMs),
    startMs,
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
    home,
    away,
    neutralSite: false,
    venue: null,
    note: null,
    seriesSummary: null,
    broadcasts: [],
    gamecastUrl: null,
    ...over,
  };
}

const CELTICS = team('BOS', 'Boston', 'Celtics');
const KNICKS = team('NY', 'New York', 'Knicks');
const YANKEES = team('NYY', 'New York', 'Yankees');
const RED_SOX = team('BOS', 'Boston', 'Red Sox');
const STEELERS = team('PIT', 'Pittsburgh', 'Steelers');
const BUCS = team('TB', 'Tampa Bay', 'Buccaneers');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------

describe('useChannelIndex', () => {
  const sportsGroup = Array.from({ length: 2500 }, (_, i) => ch('s1', `g${i}`, `US| SPORTS ${i}`));

  function serve() {
    handlers['sources.list'] = () => SOURCES;
    handlers['catalog.categories'] = (a: { sourceId: string }) =>
      a.sourceId === 's1'
        ? [cat('c1', 'US| SPORTS', 2500), cat('c2', 'NBA League Pass', 5, true), cat('c3', 'US| ENTERTAINMENT', 100), cat('c4', 'PPV EVENTS', 0)]
        : [cat('d1', 'NFL Sunday Ticket', 3)];
    handlers['catalog.channels'] = pages({
      's1/c1': sportsGroup,
      's2/d1': [ch('s2', 't1', 'NFL Sunday Ticket 1'), ch('s2', 't2', 'NFL Sunday Ticket 2'), ch('s2', 't3', 'NFL Sunday Ticket 3')],
    });
    let inFlight = 0;
    const peak = { value: 0 };
    handlers['catalog.search'] = async (a: SearchArgs) => {
      inFlight += 1;
      peak.value = Math.max(peak.value, inFlight);
      await tick(1);
      inFlight -= 1;
      const live: Channel[] =
        a.query === 'ESPN'
          ? [
              ch('s1', 'e1', 'ESPN HD'),
              ch('s2', 'e2', 'ESPNews'),
              ch('s1', 'e3', 'ESPN+ 12 | Texas vs Georgia'),
              ch('s1', 'e4', 'ESPN Classic'),
              ch('s1', 'e5', 'ESPN Radio', { isRadio: true }),
              // An event channel named after its network: kept, but not as ESPN.
              ch('s1', 'e6', 'ESPN | Knicks @ Celtics'),
              // Brazil's ESPN, by its own tag or its group's: not the US network.
              ch('s1', 'e7', 'BR: ESPN'),
              ch('s1', 'e8', 'ESPN', { categoryName: 'LATAM| DEPORTES' }),
              // Also in the sports group: listed once, as a group row.
              ch('s1', 'g0', 'US| SPORTS 0'),
            ]
          : a.query === 'FOX'
            ? [ch('s2', 'f1', 'Fox News'), ch('s2', 'f2', 'FOX 5 New York')]
            : a.query === 'USA Network'
              ? [ch('s1', 'u1', 'USA')]
              : [];
      return { live, movies: [], series: [] };
    };
    return peak;
  }

  it('pages the visible sports groups whole and skips hidden, other and empty groups', async () => {
    serve();
    const { result } = renderHook(() => useChannelIndex(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(callsOf('catalog.categories')).toEqual([
      { sourceId: 's1', contentType: 'live', includeHidden: true },
      { sourceId: 's2', contentType: 'live', includeHidden: true },
    ]);
    // Sources load side by side; each source's pages run in order.
    const pagesOf = (sourceId: string) =>
      callsOf<ChannelsArgs>('catalog.channels')
        .filter((a) => a.sourceId === sourceId)
        .map((a) => [a.categoryId, a.query.offset, a.query.limit]);
    expect(pagesOf('s1')).toEqual([
      ['c1', 0, INDEX_PAGE_LIMIT],
      ['c1', 1000, INDEX_PAGE_LIMIT],
      ['c1', 2000, INDEX_PAGE_LIMIT],
    ]);
    expect(pagesOf('s2')).toEqual([['d1', 0, INDEX_PAGE_LIMIT]]);
    const rows = result.current.channels;
    expect(rows.filter((r) => r.fromSportsGroup)).toHaveLength(2503);
    expect(result.current.error).toBeNull();
  });

  describe('a source with many sports groups', () => {
    // Sizes in rows: 2500 is three pages, 0 is skipped.
    const sizes = [2500, 3, 1200, 0, 5, 7, 1, 2, 4];
    const groups = Object.fromEntries(
      sizes.map((n, g) => [`s1/c${g}`, Array.from({ length: n }, (_, i) => ch('s1', `c${g}-${i}`, `US| SPORTS ${g}-${i}`))]),
    );

    function serveMany(fail?: string) {
      handlers['sources.list'] = () => [SOURCES[0]];
      handlers['catalog.categories'] = () => sizes.map((n, g) => cat(`c${g}`, `SPORTS ${g}`, n));
      handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
      const serveGroup = pages(groups);
      const open = new Map<string, number>();
      const stats = { inFlight: 0, peak: 0, overlap: false };
      handlers['catalog.channels'] = async (a: ChannelsArgs) => {
        if (a.categoryId === fail) throw new Error('db');
        stats.inFlight += 1;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        // A group's pages are never in flight together.
        if (open.get(a.categoryId)) stats.overlap = true;
        open.set(a.categoryId, 1);
        await tick(5);
        open.set(a.categoryId, 0);
        stats.inFlight -= 1;
        return serveGroup(a);
      };
      return stats;
    }

    it('reads four groups at once, each group’s pages in order, and lists the rows in the groups’ order', async () => {
      const stats = serveMany();
      const { result } = renderHook(() => useChannelIndex(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(stats.peak).toBe(4);
      expect(stats.overlap).toBe(false);
      const asked = callsOf<ChannelsArgs>('catalog.channels');
      for (const [g, n] of sizes.entries()) {
        const offsets = asked.filter((a) => a.categoryId === `c${g}`).map((a) => a.query.offset);
        expect(offsets, `c${g}`).toEqual(n === 0 ? [] : Array.from({ length: Math.ceil(n / INDEX_PAGE_LIMIT) }, (_, p) => p * INDEX_PAGE_LIMIT));
      }
      const names = result.current.channels.map((r) => r.channel.name);
      expect(names).toEqual(sizes.flatMap((_, g) => groups[`s1/c${g}`]!.map((c) => c.name)));
    });

    it('stops reading the source’s other groups after a failed page', async () => {
      serveMany('c1');
      const { result } = renderHook(() => useChannelIndex(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeInstanceOf(Error);
      await tick(30);
      // c0, c1, c2 and c4 started (c3 is empty); once c1 failed, no group after them and no further page of
      // c0 was asked.
      const asked = callsOf<ChannelsArgs>('catalog.channels');
      expect([...new Set(asked.map((a) => a.categoryId))].sort()).toEqual(['c0', 'c1', 'c2', 'c4']);
      expect(asked.filter((a) => a.categoryId === 'c0').map((a) => a.query.offset)).toEqual([0]);
    });
  });

  it('searches each network once, keeps real network channels and lists every channel once', async () => {
    const peak = serve();
    const { result } = renderHook(() => useChannelIndex(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const searches = callsOf<SearchArgs>('catalog.search');
    expect(searches.map((s) => s.query).sort()).toEqual([...new Set(NETWORKS.map((n) => n.search))].sort());
    for (const s of searches) expect(s).toMatchObject({ contentTypes: ['live'], limit: NETWORK_SEARCH_LIMIT });
    expect(peak.value).toBeLessThanOrEqual(3);

    const found = result.current.channels.filter((r) => !r.fromSportsGroup).map((r) => [r.channel.name, r.network, r.sourceName, r.sourceKind]);
    // Group rows first, then each source's network rows; ESPN Classic, Fox News, a bare USA, radio and the
    // feeds from abroad are dropped.
    expect(found).toEqual([
      ['ESPN HD', 'espn', 'Home', 'xtream'],
      ['ESPN+ 12 | Texas vs Georgia', 'espn-plus', 'Home', 'xtream'],
      ['ESPN | Knicks @ Celtics', null, 'Home', 'xtream'],
      ['ESPNews', 'espnews', 'Backup', 'm3u'],
      ['FOX 5 New York', 'fox', 'Backup', 'm3u'],
    ]);
    expect(result.current.channels.every((r) => !r.foreign)).toBe(true);
    const keys = result.current.channels.map((r) => itemKey(r.channel.ref));
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.current.channels.find((r) => r.channel.ref.itemId === 'g0')?.fromSportsGroup).toBe(true);
    expect(result.current.channels.at(-1)?.channel.name).toBe('FOX 5 New York');
  });

  it("keys its queries under 'catalog.' so catalog changes rebuild it", async () => {
    serve();
    const { result } = renderHook(() => useChannelIndex(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const heads = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey[0] as string)
      .filter((h) => h.includes('sports'));
    expect(heads.sort()).toEqual(['catalog.sportsGroups', 'catalog.sportsGroups', 'catalog.sportsNetworks']);
    const before = callsOf('catalog.channels').length;
    handlers['catalog.channels'] = pages({ 's1/c1': [ch('s1', 'n1', 'NBA League Pass 01: Celtics vs Knicks')], 's2/d1': [] });
    await invalidate('catalog.');
    await waitFor(() => expect(result.current.channels.some((r) => r.channel.name.startsWith('NBA League Pass 01'))).toBe(true));
    expect(callsOf('catalog.channels').length).toBeGreaterThan(before);
  });

  it('asks nothing while disabled', async () => {
    serve();
    const { result } = renderHook(() => useChannelIndex(false), { wrapper });
    await tick(20);
    expect(result.current.loading).toBe(false);
    expect(callsOf('catalog.categories')).toEqual([]);
    expect(callsOf('catalog.search')).toEqual([]);
  });
});

describe('useGuideWindow', () => {
  const source = { id: 's1', kind: 'xtream', name: 'Home' } as const;
  const index = Array.from({ length: 1200 }, (_, i) => toIndexed(ch('s1', `c${i}`, `Channel ${i}`), source, true));

  it('asks epg.grid in chunks, in raw guide time, and shifts the answer to display time', async () => {
    handlers['settings.get'] = () => ({ epgOffsetMinutes: 60 });
    handlers['epg.grid'] = (a: GridArgs) => {
      const first = a.refs[0]!;
      const out: Record<string, EpgProgram[]> = {
        [itemKey(first)]: [{ channelId: first.itemId, title: 'Knicks at Celtics', start: '2026-10-23T22:00:00Z', end: '2026-10-24T00:30:00Z' }],
      };
      if (a.refs[1]) out[itemKey(a.refs[1])] = [];
      return out;
    };
    const from = Date.parse('2026-10-23T22:40Z');
    const to = Date.parse('2026-10-24T03:10Z');
    const { result } = renderHook(() => useGuideWindow(index, from, to, true), { wrapper });
    await waitFor(() => expect(result.current.programs.size).toBe(3));
    expect(result.current.loading).toBe(false);
    const asked = callsOf<GridArgs>('epg.grid');
    expect(asked.map((a) => a.refs.length)).toEqual([GRID_CHUNK, GRID_CHUNK, 200]);
    for (const a of asked) {
      // Snapped out to the half hour (22:30 .. 03:30 display), then moved back by the hour of offset.
      expect(a).toMatchObject({ from: '2026-10-23T21:30:00.000Z', to: '2026-10-24T02:30:00.000Z', withDescription: true });
    }
    const p = result.current.programs.get(itemKey(index[0]!.channel.ref))!;
    expect(p[0]).toMatchObject({ start: '2026-10-23T23:00:00.000Z', end: '2026-10-24T01:30:00.000Z' });
    // Channels answered with no programmes stay out of the map.
    expect(result.current.programs.has(itemKey(index[1]!.channel.ref))).toBe(false);
  });

  it('asks every copy of a channel, since a copy may have its own guide mapping or shift', async () => {
    handlers['settings.get'] = () => ({ epgOffsetMinutes: 0 });
    const show = { channelId: 'espn.us', title: 'Knicks at Celtics', start: '2026-10-23T23:00:00Z', end: '2026-10-24T01:30:00Z' };
    // Same source, group, guide id and words: the core still resolves each ref on its own. 'b' was mapped by
    // hand to another guide channel and 'c' has its own shift of an hour.
    const answers: Record<string, EpgProgram> = {
      a: show,
      b: { ...show, channelId: 'espn2.us', title: 'Heat at Magic' },
      c: { ...show, start: '2026-10-24T00:00:00Z', end: '2026-10-24T02:30:00Z' },
    };
    handlers['epg.grid'] = (a: GridArgs) => Object.fromEntries(a.refs.map((r) => [itemKey(r), [answers[r.itemId]!]]));
    const row = (id: string, name: string) => toIndexed(ch('s1', id, name, { epgChannelId: 'espn.us' }), source, true);
    const channels = [row('a', 'US| ESPN HD'), row('b', 'US| ESPN FHD'), row('c', 'ESPN Backup 2')];
    const { result } = renderHook(() => useGuideWindow(channels, Date.parse('2026-10-23T22:30Z'), Date.parse('2026-10-24T03:30Z'), true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.programs.size).toBe(channels.length));
    expect(callsOf<GridArgs>('epg.grid').flatMap((a) => a.refs.map((r) => r.itemId))).toEqual(['a', 'b', 'c']);
    for (const c of channels) {
      expect(result.current.programs.get(itemKey(c.channel.ref)), c.channel.name).toEqual([answers[c.channel.ref.itemId]]);
    }
  });

  it('holds the programmes back until every chunk has answered', async () => {
    handlers['settings.get'] = () => ({ epgOffsetMinutes: 0 });
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    handlers['epg.grid'] = async (a: GridArgs) => {
      if (a.refs[0]!.itemId !== 'c0') await late;
      const first = a.refs[0]!;
      return { [itemKey(first)]: [{ channelId: first.itemId, title: 'Knicks at Celtics', start: '2026-10-23T23:00:00Z', end: '2026-10-24T01:30:00Z' }] };
    };
    const { result } = renderHook(() => useGuideWindow(index, Date.parse('2026-10-23T22:30Z'), Date.parse('2026-10-24T03:30Z'), true), { wrapper });
    await waitFor(() => expect(callsOf('epg.grid')).toHaveLength(3));
    await tick(20);
    expect(result.current.loading).toBe(true);
    expect(result.current.programs.size).toBe(0);
    release();
    await waitFor(() => expect(result.current.programs.size).toBe(3));
    expect(result.current.loading).toBe(false);
  });

  it('asks nothing while disabled', async () => {
    handlers['settings.get'] = () => ({ epgOffsetMinutes: 0 });
    renderHook(() => useGuideWindow(index, Date.now(), Date.now() + HOUR, false), { wrapper });
    await tick(20);
    expect(callsOf('epg.grid')).toEqual([]);
  });
});

describe('useGameStreams', () => {
  function serve(groupChannels: Channel[], opts: { offset?: number; guide?: (a: GridArgs) => Record<string, EpgProgram[]>; search?: (a: SearchArgs) => Channel[] | Promise<Channel[]> } = {}) {
    handlers['sources.list'] = () => [SOURCES[0]];
    handlers['settings.get'] = () => ({ epgOffsetMinutes: opts.offset ?? 0 });
    handlers['catalog.categories'] = () => [cat('c1', 'USA SPORTS', groupChannels.length)];
    handlers['catalog.channels'] = pages({ 's1/c1': groupChannels });
    handlers['epg.grid'] = (a: GridArgs) => opts.guide?.(a) ?? {};
    handlers['catalog.search'] = async (a: SearchArgs) => ({
      live: a.limit === FALLBACK_LIMIT && opts.search ? await opts.search(a) : [],
      movies: [],
      series: [],
    });
  }

  it('joins the index, the guide (with the EPG offset) and the games', async () => {
    const now = Date.now();
    const nba = game('nba', KNICKS, CELTICS, now - 30 * MINUTE, { state: 'in', phase: 'live' });
    const nfl = game('nfl', STEELERS, BUCS, now + 26 * HOUR);
    const event = ch('s1', 'lp5', 'NBA League Pass 05: Boston Celtics vs New York Knicks');
    const slot = ch('s1', 'st3', 'NFL Sunday Ticket 3');
    const other = ch('s1', 'x', 'NBA TV');
    // The guide runs an hour slow (offset 60): its raw times are an hour before the kickoff.
    const raw = (t: number) => new Date(t - HOUR).toISOString();
    serve([event, slot, other], {
      offset: 60,
      guide: () => ({
        [itemKey(slot.ref)]: [{ channelId: 'st3', title: 'NFL Football', start: raw(nfl.startMs), end: raw(nfl.startMs + 3 * HOUR), description: 'Steelers at Buccaneers.' }],
      }),
    });
    const games = [nba, nfl];
    const { result } = renderHook(() => useGameStreams(games), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.streams.get(nba.key)!.map((m) => [m.channel.name, m.reason])).toEqual([
      ['NBA League Pass 05: Boston Celtics vs New York Knicks', 'event'],
    ]);
    const [m] = result.current.streams.get(nfl.key)!;
    expect(m).toMatchObject({ reason: 'guide', regional: false, channel: { name: 'NFL Sunday Ticket 3' } });
    expect(m!.program!.start).toBe(new Date(nfl.startMs).toISOString());
    // One guide request for the union window of both games, all refs at once.
    expect(callsOf<GridArgs>('epg.grid')).toHaveLength(1);
    expect(callsOf<GridArgs>('epg.grid')[0]!.refs).toHaveLength(3);
    // Every game found something: no fallback search.
    expect(callsOf<SearchArgs>('catalog.search').filter((s) => s.limit === FALLBACK_LIMIT)).toEqual([]);
  });

  it('searches team names for live or imminent games with no stream, and verifies the hits', async () => {
    const now = Date.now();
    const live = game('mlb', YANKEES, RED_SOX, now - 20 * MINUTE, { state: 'in', phase: 'live' });
    const soon = game('nba', KNICKS, CELTICS, now + 2 * HOUR);
    const later = game('nfl', STEELERS, BUCS, now + 5 * HOUR);
    const done = game('nba', team('MIA', 'Miami', 'Heat'), team('MIN', 'Minnesota', 'Timberwolves'), now - 4 * HOUR, { state: 'post', phase: 'final' });
    serve([ch('s1', 'n1', 'NBA TV')], {
      search: (a) =>
        a.query === 'Yankees'
          ? [ch('s1', 'y1', 'USA | MLB 07: Yankees x Red Sox'), ch('s1', 'y2', 'Yankees Classics'), ch('s9', 'y3', 'MLB 07: Yankees x Red Sox')]
          : a.query === 'Sox'
            ? [ch('s1', 'y1', 'USA | MLB 07: Yankees x Red Sox'), ch('s1', 'w1', 'White Sox vs Tigers')]
            : [],
    });
    const games = [live, soon, later, done];
    const { result } = renderHook(() => useGameStreams(games), { wrapper });
    await waitFor(() => expect(result.current.streams.get(live.key)?.length).toBe(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fallbackQuery(RED_SOX, 'mlb')).toBe('Sox');
    const asked = callsOf<SearchArgs>('catalog.search').filter((s) => s.limit === FALLBACK_LIMIT);
    expect(asked.map((s) => s.query).sort()).toEqual(['Celtics', 'Knicks', 'Sox', 'Yankees']);
    for (const s of asked) expect(s.contentTypes).toEqual(['live']);
    // Verified, deduplicated, and only from a visible source.
    expect(result.current.streams.get(live.key)!.map((m) => [m.channel.name, m.reason, m.sourceName])).toEqual([
      ['USA | MLB 07: Yankees x Red Sox', 'event', 'Home'],
    ]);
    expect(result.current.streams.get(soon.key)).toEqual([]);
    expect(result.current.streams.get(later.key)).toEqual([]);
    expect(result.current.streams.get(done.key)).toEqual([]);
  });

  it('gives an event name without a date to the current game, not the next one of the series', async () => {
    const now = Date.now();
    const rays = team('TB', 'Tampa Bay', 'Rays');
    const brewers = team('MIL', 'Milwaukee', 'Brewers');
    const tonight = game('mlb', rays, brewers, now + 2 * HOUR);
    const tomorrow = { ...game('mlb', rays, brewers, now + 26 * HOUR), key: 'mlb:TB-MIL-2', id: 'TB-MIL-2' };
    serve([ch('s1', 'ev', 'MLB 04: Rays @ Brewers')]);
    const games = [tonight, tomorrow];
    const { result } = renderHook(() => useGameStreams(games), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.streams.get(tonight.key)!.map((m) => [m.channel.name, m.reason])).toEqual([['MLB 04: Rays @ Brewers', 'event']]);
    expect(result.current.streams.get(tomorrow.key)).toEqual([]);
  });

  it('keeps last night’s final on its undated event channel the next morning', async () => {
    const now = Date.now();
    const lastNight = game('nba', KNICKS, CELTICS, now - 15 * HOUR, { state: 'post', phase: 'final' });
    serve([ch('s1', 'ev', 'NBA League Pass 05: Knicks @ Celtics')]);
    const games = [lastNight];
    const { result } = renderHook(() => useGameStreams(games), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.streams.get(lastNight.key)!.map((m) => [m.channel.name, m.reason])).toEqual([
      ['NBA League Pass 05: Knicks @ Celtics', 'event'],
    ]);
  });

  it(`runs at most ${FALLBACK_CONCURRENCY} fallback searches at once`, async () => {
    const now = Date.now();
    const teams = ['Hawks', 'Bulls', 'Nets', 'Suns', 'Kings', 'Magic'].map((n, i) => team(`T${i}`, `City${i}`, n));
    const games = [0, 2, 4].map((i) => game('nba', teams[i]!, teams[i + 1]!, now - 10 * MINUTE, { state: 'in', phase: 'live' }));
    let inFlight = 0;
    let peak = 0;
    serve([ch('s1', 'n1', 'NBA TV')], {
      search: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick(5);
        inFlight -= 1;
        return [];
      },
    });
    const { result } = renderHook(() => useGameStreams(games), { wrapper });
    await waitFor(() => expect(callsOf<SearchArgs>('catalog.search').filter((s) => s.limit === FALLBACK_LIMIT)).toHaveLength(6));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(peak).toBe(FALLBACK_CONCURRENCY);
  });

  it('asks nothing for no games or while disabled', async () => {
    serve([]);
    renderHook(() => useGameStreams([]), { wrapper });
    renderHook(() => useGameStreams([game('nba', KNICKS, CELTICS, Date.now())], false), { wrapper });
    await tick(20);
    expect(calls.filter((c) => c.cmd !== 'sources.list' && c.cmd !== 'settings.get')).toEqual([]);
  });
});
