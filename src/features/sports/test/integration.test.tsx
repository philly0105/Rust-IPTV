// The /sports page with its real hooks and actions: ESPN answers (NBA fixture events moved to a fixed
// Thursday) come through a stubbed fetch, and the channel index, the guide window, matching, playback
// (playChannel, playCatchup) and recording (useScheduleActions) run as shipped against a mocked core.
// Only the player engine is faked. The page test mocks the game and stream hooks; this one checks the
// lanes' pieces fit together, and that every request the page makes is one the test answers.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, EpgProgram, ItemKey, ItemRef } from '@/api/types';

import nba from './fixtures/nba.json';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

/** The engine side of the player: what playChannel and playCatchup handed it. */
const engine = vi.hoisted(() => ({
  items: [] as { ref: ItemRef; title?: string; subtitle?: string }[],
  sources: [] as { url: string; title?: string; subtitle?: string }[],
}));
vi.mock('@/features/player', async () => {
  const { usePlayerStore } = await import('@/features/player/store');
  return {
    playItem: async (args: { ref: ItemRef; title?: string; subtitle?: string }) => {
      engine.items.push(args);
      usePlayerStore.setState({ source: { ref: args.ref } as never });
    },
    playSource: async (src: { url: string; title?: string; subtitle?: string }) => {
      engine.sources.push(src);
    },
  };
});

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { SportsPage } = await import('../pages/SportsPage');
const { scoreboardUrl } = await import('../lib/espn');
const { usePlayerStore } = await import('@/features/player/store');
const { itemKey } = await import('@/api/types');

const at = (iso: string) => Date.parse(iso);
/** Thursday 2026-10-22, noon Eastern. */
const NOON = at('2026-10-22T16:00Z');
const TODAY = '2026-10-22';
const YESTERDAY = '2026-10-21';

/** A fixture event, deep-copied, moved to `date` and given a live or final status. */
function event(id: string, date: string, status?: 'live' | 'final') {
  const e = structuredClone(nba.events.find((x) => x.id === id)) as Record<string, unknown>;
  const c = (e.competitions as Record<string, unknown>[])[0]!;
  e.date = c.date = date;
  if (status === 'live') c.status = { displayClock: '5:12', period: 3, type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, shortDetail: '5:12 - 3rd' } };
  if (status === 'final') c.status = { displayClock: '0:00', period: 4, type: { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: 'Final' } };
  return e;
}

// Timberwolves at Heat on ESPN, live since 11:20 ET; Cavaliers at 76ers on ESPN, over (8:00 ET);
// Knicks at Celtics on Prime Video only, 7:30 PM ET.
const LIVE = 'nba:401909091';
const FINAL = 'nba:401909093';
const LATER = 'nba:401909095';
const BOARD = {
  events: [
    event('401909093', '2026-10-22T12:00Z', 'final'),
    event('401909091', '2026-10-22T15:20Z', 'live'),
    event('401909095', '2026-10-22T23:30Z'),
  ],
};

const ref = (itemId: string): ItemRef => ({ sourceId: 'src1', contentType: 'live', itemId });
const ESPN: Channel = { ref: ref('10'), name: 'US| ESPN HD', categoryId: 'ent', categoryName: 'USA Entertainment', isRadio: false, archive: { enabled: true, durationHours: 72 } };
const NEWS: Channel = { ref: ref('11'), name: 'US| ESPNews', categoryId: 'ent', categoryName: 'USA Entertainment', isRadio: false };
const WOLVES: Channel = { ref: ref('20'), name: 'NBA 05: Timberwolves vs Heat', categoryId: 'nba-ev', categoryName: 'USA | NBA EVENTS', isRadio: false };
const KNICKS: Channel = { ref: ref('21'), name: 'NBA 07: New York Knicks @ Boston Celtics', categoryId: 'nba-ev', categoryName: 'USA | NBA EVENTS', isRadio: false };
const ALL = [ESPN, NEWS, WOLVES, KNICKS];

const cat = (id: string, name: string, itemCount: number): Category => ({ id, sourceId: 'src1', contentType: 'live', name, hidden: false, itemCount, position: 0 });
const CATEGORIES = [cat('ent', 'USA Entertainment', 2), cat('nba-ev', 'USA | NBA EVENTS', 2)];

/** ESPN's guide: the live game's broadcast, named only in the description. */
const ESPN_GUIDE: EpgProgram = {
  channelId: '10',
  start: '2026-10-22T15:00:00Z',
  end: '2026-10-22T17:30:00Z',
  title: 'NBA Basketball',
  description: 'Minnesota Timberwolves at Miami Heat. From Kaseya Center.',
};

const fetchMock = vi.fn(async (url: string) => {
  const today = url.includes(`dates=${TODAY.replaceAll('-', '')}`);
  const body = today && url.includes('/basketball/nba/') ? BOARD : { events: [] };
  return { ok: true, status: 200, json: async () => structuredClone(body) } as unknown as Response;
});

const unhandled: string[] = [];

beforeAll(() => {
  h.installDomStubs();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
  vi.stubGlobal('fetch', fetchMock);
  h.resetShared();
  const on = rpc.handlers;
  on['sources.list'] = () => h.SOURCES;
  on['settings.get'] = () => ({ stripCountryPrefix: true, epgOffsetMinutes: 0 });
  on['recordings.capabilities'] = () => ({ supported: true });
  on['reminders.list'] = () => [];
  on['recordings.list'] = () => [];
  on['recordings.rules'] = () => [];
  on['catalog.categories'] = () => CATEGORIES;
  on['catalog.channels'] = (a) => {
    const { categoryId, query } = a as { categoryId: string; query: { offset: number; limit: number } };
    const items = ALL.filter((c) => c.categoryId === categoryId);
    return { items: items.slice(query.offset, query.offset + query.limit), total: items.length, offset: query.offset, limit: query.limit };
  };
  // Like the core: every word of the query is a word prefix of the name.
  on['catalog.search'] = (a) => {
    const words = (a as { query: string }).query.toLowerCase().split(/\s+/);
    const hit = (c: Channel) => words.every((w) => c.name.toLowerCase().split(/[^a-z0-9+]+/).some((n) => n.startsWith(w)));
    return { live: ALL.filter(hit), movies: [], series: [] };
  };
  on['epg.grid'] = (a) => {
    const refs = (a as { refs: ItemRef[] }).refs;
    const out: Record<ItemKey, EpgProgram[]> = {};
    if (refs.some((r) => r.itemId === ESPN.ref.itemId)) out[itemKey(ESPN.ref)] = [ESPN_GUIDE];
    return out;
  };
  on['xtream.catchupUrl'] = () => ({ url: 'http://portal.test/timeshift/10.ts', kind: 'mpegts', title: 'ESPN' });
  on['recordings.schedule'] = (a) => ({ recording: { id: 'r1', status: 'scheduled', start: (a as { start: string }).start }, warning: null });
  const call = rpc.call;
  rpcMock.current = {
    call: (cmd, args) => {
      if (!rpc.handlers[cmd]) unhandled.push(cmd);
      return call(cmd, args);
    },
  };
});
afterEach(() => cleanup());
afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rpcMock.current = rpc;
});

function card(key: string, within_: HTMLElement = document.body): HTMLElement {
  const el = within(within_).getAllByTestId('sports-game').find((c) => c.getAttribute('data-game') === key);
  if (!el) throw new Error(`no card for ${key}`);
  return el;
}

function rows(el: HTMLElement) {
  return within(el)
    .getAllByTestId('sports-stream')
    .map((r) => `${r.getAttribute('data-reason')} ${r.querySelector('span[dir="auto"]')?.textContent}`);
}

describe('sports page with its real hooks', () => {
  it('matches, plays, replays and records from ESPN data and the channel list', async () => {
    h.renderAt('/sports', [{ path: '/sports', element: <SportsPage /> }]);

    const live = await screen.findByTestId('sports-live');
    // The guide names the game on ESPN; the event channel names both teams; ESPNews carries nothing.
    await waitFor(() => expect(rows(card(LIVE, live))).toEqual(['guide ESPN HD', 'event NBA 05: Timberwolves vs Heat']));
    expect(within(card(LIVE, live)).getByTestId('sports-clock').textContent).toBe('5:12 - 3rd');

    const day = screen.getByTestId('sports-day-panel');
    expect(within(day).getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'))).toEqual([LIVE, FINAL, LATER]);
    expect(within(screen.getByTestId('sports-league-nba')).getByRole('heading', { level: 2 }).textContent).toBe('NBA3 games, 3 with streams');
    // Over, on ESPN only: the network channel, whose archive holds it.
    expect(rows(card(FINAL, day))).toEqual(['network ESPN HD']);
    // Prime Video is a package, so only the event channel counts.
    expect(rows(card(LATER, day))).toEqual(['event NBA 07: New York Knicks @ Boston Celtics']);

    // Watch: Live's playChannel, then channel up and down walk the event channel's group.
    const watch = within(card(LIVE, live)).getByRole('button', { name: 'Watch Minnesota Timberwolves at Miami Heat on NBA 05: Timberwolves vs Heat' });
    fireEvent.click(watch);
    await waitFor(() => expect(engine.items).toHaveLength(1));
    expect(engine.items[0]).toMatchObject({ ref: WOLVES.ref, title: 'NBA 05: Timberwolves vs Heat', subtitle: 'Minnesota Timberwolves at Miami Heat' });
    await waitFor(() => expect(usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src1', categoryId: 'nba-ev' }));

    // Replay: the portal's timeshift link from 10 minutes before the start to an hour past the
    // typical length (12:00Z + 2 h 30 + 1 h), so a game that ran long is not cut off.
    fireEvent.click(within(card(FINAL, day)).getByTestId('sports-replay'));
    await waitFor(() => expect(engine.sources).toHaveLength(1));
    expect(rpc.callsOf('xtream.catchupUrl')).toEqual([{ ref: ESPN.ref, start: '2026-10-22T11:50:00.000Z', durationMinutes: 220 }]);
    expect(engine.sources[0]).toMatchObject({ url: 'http://portal.test/timeshift/10.ts', title: 'ESPN HD', subtitle: 'Cleveland Cavaliers at Philadelphia 76ers' });

    // Record: the recording module's schedule call, titled with the game, to the same generous end.
    fireEvent.click(within(card(LATER, day)).getByTestId('sports-record'));
    await waitFor(() => expect(rpc.callsOf('recordings.schedule')).toHaveLength(1));
    expect(rpc.callsOf('recordings.schedule')[0]).toEqual({
      ref: KNICKS.ref,
      channelName: 'NBA 07: New York Knicks @ Boston Celtics',
      title: 'New York Knicks at Boston Celtics',
      start: '2026-10-22T23:20:00.000Z',
      end: '2026-10-23T03:00:00.000Z',
    });

    // ESPN only: each league's today and yesterday (Live now), today shared with the day view.
    const urls = new Set(fetchMock.mock.calls.map(([u]) => u));
    const leagues = ['nfl', 'cfb', 'nba', 'mlb'] as const;
    expect(urls).toEqual(new Set(leagues.flatMap((l) => [scoreboardUrl(l, TODAY), scoreboardUrl(l, YESTERDAY)])));
    expect(unhandled).toEqual([]);
  });
});
