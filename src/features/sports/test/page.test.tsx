// The /sports page: the league tabs with their counts and the Eastern day strip in the URL, the team
// search and the "With streams" filter, Live now ahead of any day and the day's Upcoming and Final
// games, game cards in every state, the matched stream rows with their reason and the action the
// game's phase allows (Watch, Replay, Record), Show all, and the loading, empty, error and no-source states.
// The game and stream hooks and the player are mocked; nothing here reaches ESPN or the core.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Game, League } from '../lib/types';
import type { StreamMatch } from '../lib/match';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
// Multi-view's parental gate lets every channel up here; the gate has tests of its own.
vi.mock('@/features/multiview/parentalGate', () => ({ ensureUnlocked: async () => true, requestPin: async () => true }));

/** What the mocked hooks answer, and what the page asked them for. */
const data = vi.hoisted(() => ({
  days: {} as Record<string, unknown[]>,
  loading: false,
  error: null as unknown,
  refetches: 0,
  live: [] as unknown[],
  streams: new Map<string, unknown[]>(),
  streamsLoading: false,
  dayCalls: [] as { day: string; leagues: string[] }[],
  liveCalls: [] as string[][],
  streamCalls: [] as { keys: string[]; enabled: boolean }[],
  /** One stable answer per (day, leagues), as React Query's combine gives. */
  cache: new Map<string, unknown>(),
}));
vi.mock('../hooks/useGames', () => ({
  useSportsDay: (day: string, leagues: readonly string[]) => {
    data.dayCalls.push({ day, leagues: [...leagues] });
    const id = `day|${day}|${leagues.join()}`;
    if (!data.cache.has(id)) {
      const games = ((data.days[day] ?? []) as { league: string }[]).filter((g) => leagues.includes(g.league));
      data.cache.set(id, { games, loading: data.loading, error: data.error, refetch: () => void data.refetches++ });
    }
    return data.cache.get(id);
  },
  useLiveGames: (leagues: readonly string[]) => {
    data.liveCalls.push([...leagues]);
    const id = `live|${leagues.join()}`;
    if (!data.cache.has(id)) data.cache.set(id, { games: (data.live as { league: string }[]).filter((g) => leagues.includes(g.league)), loading: false });
    return data.cache.get(id);
  },
}));
vi.mock('../hooks/useGameStreams', () => ({
  useGameStreams: (games: readonly { key: string }[], enabled = true) => {
    data.streamCalls.push({ keys: games.map((g) => g.key), enabled });
    return enabled ? { streams: data.streams, loading: data.streamsLoading } : { streams: new Map(), loading: false };
  },
}));

const player = vi.hoisted(() => ({
  played: [] as { channel: unknown; kind: string; nowTitle?: string; displayName?: string }[],
  catchups: [] as { channel: unknown; kind: string; program: { start: string; end: string; title: string }; displayName?: string }[],
  fail: null as Error | null,
  state: {} as { source?: { ref: unknown }; zapContext?: unknown },
}));
vi.mock('@/features/live/lib/playback', () => ({
  playChannel: async (channel: { ref: unknown }, kind: string, nowTitle?: string, displayName?: string) => {
    if (player.fail) throw player.fail;
    player.played.push({ channel, kind, nowTitle, displayName });
    player.state.source = { ref: channel.ref };
  },
  playCatchup: async (channel: unknown, kind: string, program: { start: string; end: string; title: string }, _now?: number, displayName?: string) => {
    if (player.fail) throw player.fail;
    player.catchups.push({ channel, kind, program, displayName });
  },
}));
vi.mock('@/features/player/store', () => ({
  usePlayerStore: {
    getState: () => player.state,
    setState: (patch: object) => Object.assign(player.state, patch),
  },
}));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { SportsPage } = await import('../pages/SportsPage');
const { useShellStore } = await import('@/shell/store');
const { etDate, etDays, TYPICAL_LENGTH_MS } = await import('../lib/espn');
const { formatClock } = await import('@/features/live/lib/epgTime');
const { pickDay } = await import('../paths');
const { gameProgram, streamAction } = await import('../components/StreamList');
const { forgetFollowedTeamsForTests } = await import('../hooks/useFollowedTeams');
const { useMultiviewStore } = await import('@/features/multiview/store');
const { invalidate } = await import('@/api/query');
const { handleImportEvent, resetProgressForTests } = await import('@/features/sources/lib/progress');

const today = () => etDate(Date.now());
/** The Today tab, named with its date ("Today Oct 25"). */
const TODAY = /^Today /;
const ALL: League[] = ['nfl', 'cfb', 'nba', 'mlb'];

function open(path = '/sports') {
  return h.renderAt(path, [{ path: '/sports', element: <SportsPage /> }]);
}

/** Renders and waits for the sources, so the stream lists are on. */
async function openReady(path?: string) {
  const view = open(path);
  await waitFor(() => expect(data.streamCalls.at(-1)?.enabled).toBe(true));
  return view;
}

function setDay(games: Game[], day = today()) {
  data.days[day] = games;
}

function setStreams(game: Game, list: StreamMatch[]) {
  data.streams.set(game.key, list);
}

function card(game: Game): HTMLElement {
  const el = screen.getAllByTestId('sports-game').find((c) => c.getAttribute('data-game') === game.key);
  if (!el) throw new Error(`no card for ${game.key}`);
  return el;
}

const ESPN = h.channel('1', 'US| ESPN HD');
const EVENT = h.channel('2', 'NBA 05: Celtics vs Knicks', { categoryId: 'nba-events' });
const MSG = h.channel('3', 'MSG');

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  data.days = {};
  data.loading = false;
  data.error = null;
  data.refetches = 0;
  data.live = [];
  data.streams = new Map();
  data.streamsLoading = false;
  data.dayCalls.length = 0;
  data.liveCalls.length = 0;
  data.streamCalls.length = 0;
  data.cache.clear();
  player.played.length = 0;
  player.catchups.length = 0;
  player.fail = null;
  player.state = {};
  localStorage.removeItem('tsrust.sportsTeams');
  localStorage.removeItem('tsrust.sportsMyTeamsOnly');
  localStorage.removeItem('tsrust.sportsStreamsOnly');
  localStorage.removeItem('tsrust.sportsLeague');
  forgetFollowedTeamsForTests();
  useMultiviewStore.setState({ tiles: [] });
  rpc.handlers['sources.list'] = () => h.SOURCES;
  rpc.handlers['settings.get'] = () => ({ stripCountryPrefix: true });
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true });
  rpc.handlers['reminders.list'] = () => [];
  rpc.handlers['recordings.list'] = () => [];
  rpc.handlers['recordings.rules'] = () => [];
});
afterEach(() => {
  cleanup();
});

describe('sports page', () => {
  it('sets the header, keeps one h1 and asks for today in every league', async () => {
    setDay([h.game('1')]);
    open();
    await screen.findByTestId('sports-game');
    expect(useShellStore.getState().header?.title).toBe('Sports');
    expect(screen.getByRole('heading', { level: 1, name: 'Sports' })).toBeTruthy();
    expect(data.dayCalls.at(-1)).toEqual({ day: today(), leagues: ALL });
    expect(data.liveCalls.at(-1)).toEqual(ALL);
  });

  it('shows two weeks of Eastern days around today and keeps the picked day in the URL', async () => {
    const days = etDays(Date.now(), 7, 7);
    const tomorrow = days[8]!;
    setDay([h.game('1')]);
    setDay([h.game('2', { startMs: Date.now() + 26 * h.HOUR, etDate: tomorrow })], tomorrow);
    open();
    const strip = screen.getByRole('tablist', { name: 'Day' });
    const tabs = within(strip).getAllByRole('tab');
    expect(tabs).toHaveLength(15);
    expect(tabs.slice(6, 9).map((t) => t.textContent?.split(' ')[0])).toEqual(['Yesterday', 'Today', 'Tomorrow']);
    // Two short lines a tab, the relative day or weekday over the date, read as one name.
    expect(tabs[7]!.textContent).toMatch(/^Today \w{3} \d{1,2}$/);
    expect(screen.getByRole('tab', { name: TODAY }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sports-day-panel').getAttribute('aria-labelledby')).toBe(`sports-day-tab-${today()}`);

    fireEvent.click(screen.getByRole('tab', { name: /^Tomorrow / }));
    await waitFor(() => expect(h.location.current).toBe(`/sports?day=${tomorrow}`));
    expect(data.dayCalls.at(-1)).toEqual({ day: tomorrow, leagues: ALL });
    await waitFor(() => expect(card(data.days[tomorrow]![0] as Game)).toBeTruthy());

    // Today is the default and leaves the parameter out.
    fireEvent.click(screen.getByRole('tab', { name: TODAY }));
    await waitFor(() => expect(h.location.current).toBe('/sports'));
  });

  it('reopens a day picked in this run, and today for one from an earlier run or outside the window', async () => {
    const days = etDays(Date.now(), 7, 7);
    const dayTab = () => screen.getByRole('tablist', { name: 'Day' }).querySelectorAll('[role="tab"]')[1]!;
    // Startup restored lastRoute from an earlier run (picked on Monday, opened on Wednesday): today.
    open(`/sports?day=${days[1]}`);
    expect(screen.getByRole('tab', { name: TODAY }).getAttribute('aria-selected')).toBe('true');
    expect(data.dayCalls.at(-1)?.day).toBe(today());

    // Picking that day now works, even though the URL already names it.
    fireEvent.click(dayTab());
    await waitFor(() => expect(dayTab().getAttribute('aria-selected')).toBe('true'));
    expect(data.dayCalls.at(-1)?.day).toBe(days[1]);
    cleanup();

    // Later in the same run (back to the page, or Back in history) the day holds.
    open(`/sports?day=${days[1]}`);
    expect(dayTab().getAttribute('aria-selected')).toBe('true');
    expect(data.dayCalls.at(-1)?.day).toBe(days[1]);
    cleanup();

    pickDay('2020-01-01');
    open('/sports?day=2020-01-01');
    expect(screen.getByRole('tab', { name: TODAY }).getAttribute('aria-selected')).toBe('true');
    expect(data.dayCalls.at(-1)?.day).toBe(today());
  });

  it('filters by league from the tabs and the URL, each tab counting its games of the day', async () => {
    const nfl = h.game('2', { league: 'nfl', home: h.team('CHI', 'Chicago Bears'), away: h.team('NE', 'New England Patriots') });
    setDay([h.game('1'), nfl]);
    data.live = [h.liveGame('9', { league: 'mlb', etDate: today() })];
    await openReady();
    expect(screen.getAllByTestId('sports-game')).toHaveLength(3);
    const pills = within(screen.getByTestId('sports-leagues')).getAllByRole('tab');
    // The day's games per league (the live game is from the live list, not the day), and a dot where a game is on.
    // College football carries a short name for phones, hidden from the tab's name.
    expect(pills.map((p) => p.textContent)).toEqual(['All 2, Live now', 'NFL 1', 'NCAAFCollege Football 0', 'NBA 1', 'MLB 0, Live now']);
    expect(screen.getByRole('tab', { name: 'College Football 0' })).toBeTruthy();
    expect(within(pills[4]!).getByTestId('sports-league-live')).toBeTruthy();
    expect(within(pills[1]!).queryByTestId('sports-league-live')).toBeNull();
    // Wider than a phone in most languages, and pill tabs scroll with no visible cue: the row wraps.
    expect(within(screen.getByTestId('sports-leagues')).getByRole('tablist').className).toContain('flex-wrap');
    // Every league is on show: each card names its own.
    expect(within(card(nfl)).getByTestId('sports-game-league').textContent).toBe('NFL');

    fireEvent.click(screen.getByRole('tab', { name: /^NBA / }));
    await waitFor(() => expect(h.location.current).toBe('/sports?league=nba'));
    // Every league's day is still read (the tabs count them); the league only filters what shows and what is matched.
    expect(data.dayCalls.at(-1)).toEqual({ day: today(), leagues: ALL });
    expect(data.liveCalls.at(-1)).toEqual(ALL);
    await waitFor(() => expect(screen.getAllByTestId('sports-game')).toHaveLength(1));
    expect(screen.getByTestId('sports-game').getAttribute('data-game')).toBe('nba:1');
    expect(screen.queryByTestId('sports-game-league')).toBeNull();
    expect(data.streamCalls.at(-2)).toEqual({ keys: ['nba:1'], enabled: true });

    fireEvent.click(screen.getByRole('tab', { name: /^All / }));
    await waitFor(() => expect(h.location.current).toBe('/sports'));
    cleanup();

    // The league picked last opens when the URL names none (the rail's link), and All forgets it.
    localStorage.setItem('tsrust.sportsLeague', 'nba');
    open();
    expect(screen.getByRole('tab', { name: /^NBA / }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: /^NFL / }));
    await waitFor(() => expect(h.location.current).toBe('/sports?league=nfl'));
    expect(localStorage.getItem('tsrust.sportsLeague')).toBe('nfl');
    fireEvent.click(screen.getByRole('tab', { name: /^All / }));
    await waitFor(() => expect(h.location.current).toBe('/sports'));
    expect(screen.getByRole('tab', { name: /^All / }).getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem('tsrust.sportsLeague')).toBeNull();
    cleanup();

    open('/sports?league=cricket');
    expect(screen.getByRole('tab', { name: /^All / }).getAttribute('aria-selected')).toBe('true');
    expect(data.dayCalls.at(-1)?.leagues).toEqual(ALL);
  });

  it('leads with Live now whatever day is picked', async () => {
    const days = etDays(Date.now(), 7, 7);
    const lastWeek = days[0]!;
    const playing = h.liveGame('9');
    data.live = [playing];
    setDay([h.finalGame('5', { startMs: Date.now() - 6 * 24 * h.HOUR, etDate: lastWeek })], lastWeek);
    pickDay(lastWeek);
    await openReady(`/sports?day=${lastWeek}`);
    const live = await screen.findByTestId('sports-live');
    expect(within(live).getByRole('heading', { level: 2 }).textContent).toBe('Live now1');
    expect(within(live).getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'))).toEqual(['nba:9']);
    // It comes before the day's games.
    const panel = screen.getByTestId('sports-day-panel');
    expect(live.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The live game is not in that day's list, so it gets a match pass of its own.
    expect(data.streamCalls.at(-1)).toEqual({ keys: ['nba:9'], enabled: true });
    expect(data.streamCalls.at(-2)).toEqual({ keys: ['nba:5'], enabled: true });
    cleanup();

    data.live = [];
    data.cache.clear();
    await openReady(`/sports?day=${lastWeek}`);
    await screen.findByTestId('sports-game');
    expect(screen.queryByTestId('sports-live')).toBeNull();
  });

  it('draws a live game with the LIVE mark, ESPN clock and scores', async () => {
    const g = h.liveGame('1', { seriesSummary: 'BOS leads series 2-1', broadcasts: [{ name: 'ESPN', market: 'national', kind: 'tv' }, { name: 'MSG', market: 'home', kind: 'tv' }, { name: 'ESPN', market: 'away', kind: 'tv' }], gamecastUrl: 'https://www.espn.com/nba/game/_/gameId/1' });
    setDay([g]);
    open();
    const c = card(g);
    expect(c.getAttribute('data-phase')).toBe('live');
    expect(within(c).getByText('Live')).toBeTruthy();
    expect(within(c).getByTestId('sports-clock').textContent).toBe('Q3 5:42');
    expect(within(c).getAllByTestId('sports-score').map((s) => s.textContent)).toEqual(['78', '71']);
    const teams = within(c).getAllByTestId('sports-team');
    expect(teams.map((t) => t.textContent)).toEqual(['Boston Celtics4-278', 'New York Knicks3-371']);
    expect(teams[0]!.querySelector('img')!.getAttribute('alt')).toBe('');
    expect(within(c).getByRole('heading', { level: 3 }).textContent).toBe('Boston Celtics at New York Knicks');
    expect(within(c).getByTestId('sports-notes').textContent).toBe('BOS leads series 2-1');
    // One mention per network, whatever markets it is listed under.
    expect(within(c).getByTestId('sports-networks').textContent).toBe('ESPN · MSG');
    // The card's menu follows either team and opens ESPN's Gamecast.
    fireEvent.click(within(c).getByRole('button', { name: 'More for Boston Celtics at New York Knicks' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Follow Boston Celtics', 'Follow New York Knicks', 'Gamecast']);
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(items[2]!);
    expect(opened).toHaveBeenCalledWith('https://www.espn.com/nba/game/_/gameId/1', '_blank', 'noopener');
    opened.mockRestore();
    cleanup();
    // A live football game's down and distance leads the notes.
    const nfl = h.liveGame('3', { league: 'nfl', situation: '2nd & 7 at NO 35', home: h.team('NO', 'New Orleans Saints'), away: h.team('PIT', 'Pittsburgh Steelers') });
    setDay([nfl]);
    data.cache.clear();
    open();
    expect(within(card(nfl)).getByTestId('sports-notes').textContent).toBe('2nd & 7 at NO 35');
  });

  it("puts a live game's best stream on the multi-view wall from its menu", async () => {
    const g = h.liveGame('1');
    const later = h.game('2', { league: 'nfl', startMs: Date.now() + 2 * h.HOUR, home: h.team('CHI', 'Chicago Bears'), away: h.team('NE', 'New England Patriots') });
    setDay([g, later]);
    setStreams(g, [h.match(EVENT, { reason: 'event' }), h.match(ESPN)]);
    setStreams(later, [h.match(ESPN)]);
    await openReady();
    fireEvent.click(within(card(g)).getByRole('button', { name: 'More for Boston Celtics at New York Knicks' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Add to multi-view', 'Follow Boston Celtics', 'Follow New York Knicks']);
    fireEvent.click(items[0]!);
    await waitFor(() => expect(useMultiviewStore.getState().tiles.map((t) => t.title)).toEqual(['NBA 05: Celtics vs Knicks']));
    expect(useMultiviewStore.getState().tiles[0]!.ref).toEqual(EVENT.ref);
    await waitFor(() => expect(h.lastToast()?.title).toBe('Added NBA 05: Celtics vs Knicks to multi-view'));
    // Two hours before the start there is nothing to put up yet.
    fireEvent.click(within(card(later)).getByRole('button', { name: 'More for New England Patriots at Chicago Bears' }));
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Follow New England Patriots', 'Follow Chicago Bears']));
  });

  it('follows a team from a card, stars it everywhere, and "My teams" keeps only its games', async () => {
    const celtics = h.game('1');
    const bears = h.game('2', { league: 'nfl', home: h.team('CHI', 'Chicago Bears'), away: h.team('NE', 'New England Patriots') });
    setDay([celtics, bears]);
    await openReady();
    // Nothing followed yet: no chip.
    expect(screen.queryByTestId('sports-my-teams')).toBeNull();
    fireEvent.click(within(card(celtics)).getByRole('button', { name: 'More for Boston Celtics at New York Knicks' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Follow Boston Celtics' }));
    await waitFor(() => expect(within(card(celtics)).getAllByTestId('sports-team-followed')).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('tsrust.sportsTeams') ?? '[]')).toEqual(['nba:BOS']);
    const chip = screen.getByTestId('sports-my-teams');
    expect(chip.textContent).toBe('My teams1');
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'))).toEqual(['nba:1']));
    expect(localStorage.getItem('tsrust.sportsMyTeamsOnly')).toBe('1');

    // Unfollowing the last team takes the chip away, and its filter with it.
    fireEvent.click(within(card(celtics)).getByRole('button', { name: 'More for Boston Celtics at New York Knicks' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop following Boston Celtics' }));
    await waitFor(() => expect(screen.getAllByTestId('sports-game')).toHaveLength(2));
    expect(screen.queryByTestId('sports-my-teams')).toBeNull();
    // The filter is off again, so the next team followed hides nothing until it is pressed.
    expect(localStorage.getItem('tsrust.sportsMyTeamsOnly')).toBe('0');
    fireEvent.click(within(card(bears)).getByRole('button', { name: 'More for New England Patriots at Chicago Bears' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Follow Chicago Bears' }));
    await waitFor(() => expect(screen.getByTestId('sports-my-teams').getAttribute('aria-pressed')).toBe('false'));
    expect(screen.getAllByTestId('sports-game')).toHaveLength(2);
  });

  it('draws finals, start times, TBD and postponed games', async () => {
    const start = Date.now() + 2 * h.HOUR;
    const final = h.finalGame('1');
    const overtime = h.finalGame('2', { shortDetail: 'Final/OT' });
    const later = h.game('3', { startMs: start });
    const tbd = h.game('4', { league: 'cfb', timeValid: false, home: h.team('UGA', 'Georgia Bulldogs', { rank: 5 }), away: h.team('ALA', 'Alabama Crimson Tide') });
    const flex = h.game('5', { league: 'cfb', timeNote: 'FLEX: 3:30 - 4:30pm OR 6 - 8pm ET start' });
    const postponed = h.game('6', { league: 'mlb', state: 'post', phase: 'postponed', note: 'Rain - Makeup date April 30' });
    const canceled = h.game('7', { league: 'mlb', state: 'post', phase: 'canceled' });
    setDay([final, overtime, later, tbd, flex, postponed, canceled]);
    setStreams(postponed, [h.match(ESPN)]);
    open();

    expect(within(card(final)).getByText('Final')).toBeTruthy();
    // The loser's name and score are muted.
    expect(within(card(final)).getAllByTestId('sports-score')[1]!.className).toContain('text-fg-muted');
    expect(within(card(overtime)).getByText('Final/OT')).toBeTruthy();
    expect(card(later).textContent).toContain(formatClock(start, 'en'));
    // The start time keeps its line beside a long network list ("8:00" never wraps over "PM").
    const at = within(card(later)).getByTestId('sports-start');
    expect(at.textContent).toContain(formatClock(start, 'en'));
    expect(at.className).toContain('whitespace-nowrap');
    expect(at.className).toContain('shrink-0');
    expect(within(card(tbd)).getByText('TBD')).toBeTruthy();
    expect(within(card(tbd)).getByText('Ranked 5')).toBeTruthy();
    expect(within(card(flex)).getByText('TBD')).toBeTruthy();
    expect(within(card(flex)).getByTestId('sports-notes').textContent).toBe('FLEX: 3:30 - 4:30pm OR 6 - 8pm ET start');
    expect(within(card(postponed)).getByTestId('sports-phase-badge').textContent).toBe('Postponed');
    expect(within(card(postponed)).getByTestId('sports-notes').textContent).toBe('Rain - Makeup date April 30');
    expect(within(card(canceled)).getByTestId('sports-phase-badge').textContent).toBe('Canceled');
    // Nothing airs for a postponed game: no stream list.
    expect(within(card(postponed)).queryByTestId('sports-streams')).toBeNull();
    expect(within(card(postponed)).queryByTestId('sports-no-streams')).toBeNull();
  });

  it('lines the cards of a row up: each spans four shared rows, streams in the last', async () => {
    const plain = h.game('1', { startMs: Date.now() + 2 * h.HOUR });
    const noted = h.game('2', { startMs: Date.now() + 2 * h.HOUR, note: 'NBA Cup' });
    setDay([plain, noted]);
    setStreams(plain, [h.match(ESPN)]);
    setStreams(noted, [h.match(ESPN)]);
    await openReady();
    // The grid stretches its items (no items-start), and each card is a subgrid of four of its rows.
    expect(screen.getAllByTestId('sports-grid')[0]!.className).not.toContain('items-start');
    for (const g of [plain, noted]) {
      expect(card(g).className).toContain('row-span-4');
      expect(card(g).className).toContain('grid-rows-subgrid');
      // The streams sit in the fourth track whether or not the card has notes, so they share a line.
      expect(within(card(g)).getByTestId('sports-streams').closest('.row-start-4')).toBeTruthy();
    }
    expect(within(card(noted)).getByTestId('sports-notes').className).toContain('row-start-3');
  });

  it('pins the toolbar on a tablet or desktop window that is tall enough, and keeps focused controls clear of it', async () => {
    const g = h.game('1', { startMs: Date.now() + 2 * h.HOUR });
    setDay([g]);
    setStreams(g, [h.match(ESPN)]);
    await openReady();
    const pinned = '[@media(min-width:48rem)_and_(min-height:40rem)]';
    const toolbar = screen.getByTestId('sports-toolbar').className.split(' ');
    expect(toolbar).toEqual(expect.arrayContaining([`${pinned}:sticky`, `${pinned}:top-0`, 'bg-bg', 'z-10']));
    // Not pinned on a phone: no bare sticky.
    expect(toolbar).not.toContain('sticky');
    expect(screen.getByTestId('sports-grid').className).toContain(`${pinned}:[&_button]:scroll-mt-32`);
  });

  it('keeps the toolbar to two rows on a phone, the filter chips at the end of the day strip', async () => {
    const g = h.game('1', { startMs: Date.now() + 2 * h.HOUR });
    setDay([g]);
    setStreams(g, [h.match(ESPN)]);
    localStorage.setItem('tsrust.sportsTeams', JSON.stringify(['nba:BOS']));
    await openReady();
    // jsdom applies no media queries, so this reads the classes that lay the toolbar out: a grid on a
    // phone (the first row's box steps aside), the stacked rows from sm up.
    const classes = (el: HTMLElement) => el.className.split(' ');
    const toolbar = screen.getByTestId('sports-toolbar');
    expect(classes(toolbar)).toEqual(expect.arrayContaining(['grid', 'grid-cols-[minmax(0,1fr)_auto]', 'sm:flex', 'sm:flex-col']));
    expect(classes(screen.getByTestId('sports-leagues'))).toContain('max-sm:col-span-2');
    // The league pills share the phone's row out between them.
    expect(classes(within(screen.getByTestId('sports-leagues')).getByRole('tablist'))).toContain('max-sm:[&>button]:grow');
    const filters = screen.getByTestId('sports-filters');
    expect(classes(filters)).toEqual(expect.arrayContaining(['max-sm:col-start-2', 'max-sm:row-start-2']));
    expect(classes(screen.getByTestId('sports-days'))).toEqual(expect.arrayContaining(['max-sm:col-start-1', 'max-sm:row-start-2']));
    expect(filters.parentElement?.className.split(' ')).toContain('contents');
    // There a chip is its icon and count; the label is hidden, not gone, so the chip keeps its name.
    for (const [id, label] of [
      ['sports-my-teams', 'My teams'],
      ['sports-streams-only', 'With streams'],
    ] as const) {
      const chip = within(filters).getByTestId(id);
      expect(chip.querySelector('svg')).toBeTruthy();
      expect(classes(within(chip).getByText(label))).toContain('max-sm:sr-only');
      expect(screen.getByRole('button', { name: new RegExp(`^${label} ?\\d+$`) })).toBe(chip);
    }
  });

  it('goes back to the top when the pinned toolbar changes the day, the league or a filter', async () => {
    const days = etDays(Date.now(), 7, 7);
    const g = h.game('1', { startMs: Date.now() + 2 * h.HOUR });
    setDay([g]);
    setDay([h.game('2', { startMs: Date.now() + 26 * h.HOUR, etDate: days[8] })], days[8]);
    setStreams(g, [h.match(ESPN)]);
    localStorage.setItem('tsrust.sportsTeams', JSON.stringify(['nba:BOS']));
    // The shell's outlet is the page's scroller. jsdom lays nothing out, so the toolbar's top is on
    // the scroller's, as when it is pinned.
    h.renderAt('/sports', [{ path: '/sports', element: <main id="main"><SportsPage /></main> }]);
    await waitFor(() => expect(data.streamCalls.at(-1)?.enabled).toBe(true));
    const main = document.getElementById('main')!;
    const press = (el: HTMLElement) => {
      main.scrollTop = 600;
      fireEvent.click(el);
      return main.scrollTop;
    };
    expect(press(screen.getByRole('tab', { name: /^Tomorrow / }))).toBe(0);
    await waitFor(() => expect(h.location.current).toBe(`/sports?day=${days[8]}`));
    expect(press(screen.getByRole('tab', { name: /^NBA / }))).toBe(0);
    expect(press(screen.getByTestId('sports-streams-only'))).toBe(0);
    expect(press(screen.getByTestId('sports-my-teams'))).toBe(0);

    // Not pinned (the toolbar below the scroller's top, scrolled only part way to it): the page stays.
    const toolbar = screen.getByTestId('sports-toolbar');
    vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({ top: 8 } as DOMRect);
    expect(press(screen.getByRole('tab', { name: TODAY }))).toBe(600);
    await waitFor(() => expect(h.location.current).toBe('/sports?league=nba'));
  });

  it('splits the day into Live now, Upcoming and Final, so no game shows twice', async () => {
    const early = h.finalGame('1');
    const playing = h.liveGame('2');
    const later = h.game('3', { startMs: Date.now() + 2 * h.HOUR });
    const kickoff = h.game('4', { league: 'nfl' });
    const rained = h.game('5', { league: 'mlb', state: 'post', phase: 'postponed', startMs: Date.now() - 8 * h.HOUR });
    setDay([early, playing, later, kickoff, rained]);
    // The live list holds the day's live game too.
    data.live = [playing];
    setStreams(playing, [h.match(ESPN)]);
    setStreams(kickoff, [h.match(ESPN)]);
    await openReady();
    const ids = (id: string) => within(screen.getByTestId(`sports-${id}`)).getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'));
    const heading = (id: string) => within(screen.getByTestId(`sports-${id}`)).getByRole('heading', { level: 2 }).textContent;
    expect(ids('live')).toEqual(['nba:2']);
    expect(heading('live')).toBe('Live now1');
    // By start, whatever the league.
    expect(ids('upcoming')).toEqual(['nfl:4', 'nba:3']);
    expect(heading('upcoming')).toBe('Upcoming2');
    // A postponed game is over for the page, after the finals.
    expect(ids('final')).toEqual(['nba:1', 'mlb:5']);
    expect(heading('final')).toBe('Final2');
    expect(screen.getAllByTestId('sports-game')).toHaveLength(5);
    // "With streams" counts the games a channel was found for.
    expect(within(screen.getByTestId('sports-streams-only')).getByText('2')).toBeTruthy();
  });

  it('narrows every section to the teams or networks the header search names', async () => {
    const celtics = h.liveGame('1');
    const bears = h.game('2', { league: 'nfl', home: h.team('CHI', 'Chicago Bears'), away: h.team('NE', 'New England Patriots'), broadcasts: [{ name: 'CBS', market: 'national', kind: 'tv' }] });
    setDay([celtics, bears]);
    await openReady();
    const search = useShellStore.getState().header?.search;
    expect(search?.placeholder).toBe('Search teams');
    act(() => search!.onChange('new eng'));
    await waitFor(() => expect(screen.getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'))).toEqual(['nfl:2']));
    act(() => useShellStore.getState().header!.search!.onChange('cbs'));
    await waitFor(() => expect(screen.getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'))).toEqual(['nfl:2']));
    // The search only hides cards: the streams are still matched for the whole league.
    expect(data.streamCalls.at(-2)?.keys).toEqual(['nba:1', 'nfl:2']);
    act(() => useShellStore.getState().header!.search!.onChange('lakers'));
    await screen.findByText('No games match');
    fireEvent.click(screen.getByTestId('sports-clear-filters'));
    await waitFor(() => expect(screen.getAllByTestId('sports-game')).toHaveLength(2));
    expect(useShellStore.getState().header?.search?.value).toBe('');
  });

  it('says the filters hide every game of the day even while Live now shows another day\'s game', async () => {
    const tomorrow = etDays(Date.now(), 7, 7)[8]!;
    data.live = [h.liveGame('9')];
    setDay([h.game('2', { league: 'nfl', startMs: Date.now() + 26 * h.HOUR, etDate: tomorrow, home: h.team('CHI', 'Chicago Bears'), away: h.team('NE', 'New England Patriots') })], tomorrow);
    pickDay(tomorrow);
    await openReady(`/sports?day=${tomorrow}&league=nba`);
    expect(within(screen.getByTestId('sports-live')).getAllByTestId('sports-game')).toHaveLength(1);
    expect(within(screen.getByTestId('sports-day-panel')).getByText('No games match')).toBeTruthy();
    expect(screen.getByTestId('sports-clear-filters')).toBeTruthy();
  });

  it('hides the games no stream was found for while "With streams" is on, and remembers it', async () => {
    const found = h.game('1');
    const missing = h.game('2', { league: 'nfl', home: h.team('CHI', 'Chicago Bears'), away: h.team('NE', 'New England Patriots') });
    setDay([found, missing]);
    setStreams(found, [h.match(ESPN)]);
    await openReady();
    const chip = screen.getByTestId('sports-streams-only');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByTestId('sports-game')).toHaveLength(2);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getAllByTestId('sports-game').map((c) => c.getAttribute('data-game'))).toEqual(['nba:1']));
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('tsrust.sportsStreamsOnly')).toBe('1');
    cleanup();

    // Kept for the next visit; while matching runs nothing is hidden for want of a stream.
    data.streamsLoading = true;
    await openReady();
    expect(screen.getByTestId('sports-streams-only').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByTestId('sports-game')).toHaveLength(2);
  });

  it('lists matched streams with their reason, the best one first', async () => {
    const g = h.liveGame('1');
    const fourth = h.channel('4', 'NBA League Pass 1');
    const fifth = h.channel('5', 'NBA League Pass 2');
    setDay([g]);
    setStreams(g, [
      h.match(EVENT, { reason: 'guide', program: { channelId: '2', start: new Date(g.startMs - 10 * h.MINUTE).toISOString(), end: new Date(g.startMs + 2 * h.HOUR).toISOString(), title: 'NBA Basketball' } }),
      h.match(ESPN, { reason: 'event' }),
      h.match(MSG, { regional: true }),
      h.match(fourth),
      h.match(fifth),
    ]);
    await openReady();
    const c = card(g);
    const list = within(c).getByRole('list', { name: 'Streams for Boston Celtics at New York Knicks' });
    let rows = within(list).getAllByTestId('sports-stream');
    // One row a card until Show all, a small "+4" at the end of that row's metadata rather than a row of its own.
    expect(rows.map((r) => r.getAttribute('data-reason'))).toEqual(['guide']);
    const more = within(rows[0]!).getByRole('button', { name: 'Show all 5 streams' });
    expect(more.textContent).toBe('+4');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    // Its 44 px hit area is for touch only: for a mouse it stays on the chip, off the name above it.
    const hit = more.className.split(' ');
    expect(hit).toEqual(expect.arrayContaining(['pointer-coarse:after:absolute', 'pointer-coarse:after:-inset-y-3']));
    expect(hit.filter((c) => c.startsWith('after:'))).toEqual([]);
    fireEvent.click(more);
    rows = within(list).getAllByTestId('sports-stream');
    // The toggle stays put in the first row, so the same press closes the list again.
    expect(within(rows[0]!).getByTestId('sports-show-all').getAttribute('aria-expanded')).toBe('true');
    expect(rows.map((r) => r.getAttribute('data-reason'))).toEqual(['guide', 'event', 'network', 'network', 'network']);
    expect(within(rows[0]!).getByText('In guide')).toBeTruthy();
    // The reason is quiet text, not a badge: only the regional warning is one.
    expect(within(rows[0]!).getByTestId('sports-reason').getAttribute('class')).toBeNull();
    expect(within(rows[1]!).getByText('Event channel')).toBeTruthy();
    expect(within(rows[2]!).getByText('Network')).toBeTruthy();
    expect(within(rows[2]!).getByTestId('sports-regional').textContent).toBe('Regional');
    expect(within(rows[2]!).getByTestId('sports-regional').getAttribute('title')).toBe('This channel may show a different regional game.');
    expect(within(rows[0]!).queryByTestId('sports-regional')).toBeNull();
    // The strip setting is on: "US| ESPN HD" shows as "ESPN HD". One source: no source names.
    expect(within(rows[1]!).getByText('ESPN HD')).toBeTruthy();
    expect(within(c).queryByTestId('sports-stream-source')).toBeNull();

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByTestId('sports-stream')).toHaveLength(1);
    expect(within(list).getByRole('button', { name: 'Show all 5 streams' })).toBeTruthy();
    // A live game shows no start time, so its broadcast's slot says when it runs.
    expect(within(list).getByTestId('sports-stream-slot').textContent).toMatch(/\d.*–.*\d/);
  });

  it("leaves out a guide slot that starts with an upcoming game, and keeps one that starts before it", async () => {
    const at = Date.now() + 2 * h.HOUR;
    const sameStart = h.game('1', { startMs: at });
    const earlier = h.game('2', { startMs: at, home: h.team('CHI', 'Chicago Bulls'), away: h.team('MIA', 'Miami Heat') });
    const slot = (start: number) => ({ channelId: '2', start: new Date(start).toISOString(), end: new Date(at + 3 * h.HOUR).toISOString(), title: 'NBA Basketball' });
    setDay([sameStart, earlier]);
    setStreams(sameStart, [h.match(EVENT, { reason: 'guide', program: slot(at) })]);
    setStreams(earlier, [h.match(EVENT, { reason: 'guide', program: slot(at - 30 * h.MINUTE) })]);
    await openReady();
    // The start time is on the card's first line already: the slot would only say it again.
    expect(within(card(sameStart)).getByTestId('sports-start')).toBeTruthy();
    expect(within(card(sameStart)).getByText('In guide')).toBeTruthy();
    expect(within(card(sameStart)).queryByTestId('sports-stream-slot')).toBeNull();
    // Coverage that starts half an hour early is news.
    expect(within(card(earlier)).getByTestId('sports-stream-slot').textContent).toMatch(/\d.*–.*\d/);
  });

  it('names the source of each stream when there are several', async () => {
    rpc.handlers['sources.list'] = () => h.TWO_SOURCES;
    const g = h.liveGame('1');
    setDay([g]);
    setStreams(g, [h.match(ESPN), h.match(h.channel('7', 'ESPN', { ref: { sourceId: 'src2', contentType: 'live', itemId: '7' } }), { sourceId: 'src2', sourceKind: 'm3u', sourceName: 'Backup list' })]);
    open();
    fireEvent.click(await within(card(g)).findByRole('button', { name: 'Show all 2 streams' }));
    await waitFor(() => expect(within(card(g)).getAllByTestId('sports-stream-source').map((s) => s.textContent)).toEqual(['Home portal', 'Backup list']));
  });

  it('watches a live game, then zaps through the channel group', async () => {
    const g = h.liveGame('1');
    setDay([g]);
    setStreams(g, [h.match(EVENT, { reason: 'event' })]);
    await openReady();
    fireEvent.click(within(card(g)).getByRole('button', { name: 'Watch Boston Celtics at New York Knicks on NBA 05: Celtics vs Knicks' }));
    await waitFor(() => expect(player.played).toHaveLength(1));
    expect(player.played[0]).toEqual({ channel: EVENT, kind: 'xtream', nowTitle: 'Boston Celtics at New York Knicks', displayName: 'NBA 05: Celtics vs Knicks' });
    await waitFor(() => expect(player.state.zapContext).toEqual({ sourceId: 'src1', categoryId: 'nba-events' }));
  });

  it('offers Watch from 15 minutes before the start, and says when playback fails', async () => {
    const soon = h.game('1', { startMs: Date.now() + 10 * h.MINUTE });
    const later = h.game('2', { startMs: Date.now() + 40 * h.MINUTE });
    setDay([soon, later]);
    setStreams(soon, [h.match(ESPN)]);
    setStreams(later, [h.match(ESPN)]);
    rpc.handlers['recordings.capabilities'] = () => ({ supported: false });
    player.fail = new Error('Stream offline');
    await openReady();
    expect(within(card(later)).queryByTestId('sports-watch')).toBeNull();
    // With nothing to do yet, the best row says when Watch comes.
    const from = within(card(later)).getByTestId('sports-watch-from');
    const at = formatClock(later.startMs - 15 * h.MINUTE, 'en');
    // A clock and the time on screen, nothing that looks like a button; the sentence is what it reads and its tooltip.
    expect(from.getAttribute('title')).toBe(`Watch from ${at}`);
    expect(within(from).getByText(`Watch from ${at}`).className).toContain('sr-only');
    expect(from.querySelector('svg')?.getAttribute('class')).toContain('lucide-clock');
    expect(within(card(soon)).queryByTestId('sports-watch-from')).toBeNull();
    fireEvent.click(within(card(soon)).getByTestId('sports-watch'));
    await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't play ESPN HD"));
    expect(h.lastToast()?.variant).toBe('error');
    // A failed play leaves the zap context alone.
    expect(player.state.zapContext).toBeUndefined();
  });

  it('replays a final game from a channel archive, and offers nothing without one', async () => {
    const g = h.finalGame('1');
    const archived = h.channel('8', 'ESPN 2', { archive: { enabled: true, durationHours: 72 } });
    const short = h.channel('9', 'ESPN U', { archive: { enabled: true, durationHours: 2 } });
    setDay([g]);
    setStreams(g, [h.match(archived), h.match(short), h.match(ESPN)]);
    await openReady();
    const c = card(g);
    expect(within(c).getAllByTestId('sports-replay')).toHaveLength(1);
    expect(within(c).queryByTestId('sports-watch')).toBeNull();
    expect(within(c).queryByTestId('sports-record')).toBeNull();
    fireEvent.click(within(c).getByRole('button', { name: 'Replay Boston Celtics at New York Knicks from ESPN 2' }));
    await waitFor(() => expect(player.catchups).toHaveLength(1));
    // No guide programme: ten minutes before the start to an hour past the league's typical length,
    // so overtime is not cut off.
    expect(player.catchups[0]!.program).toMatchObject({
      start: new Date(g.startMs - 10 * h.MINUTE).toISOString(),
      end: new Date(g.startMs + TYPICAL_LENGTH_MS.nba + h.HOUR).toISOString(),
      title: 'Boston Celtics at New York Knicks',
    });
    expect(player.catchups[0]!.displayName).toBe('ESPN 2');
  });

  it('replays a game that ended minutes ago only up to now', async () => {
    // Started three hours ago: an hour past the typical length is still ahead.
    const g = h.finalGame('1', { startMs: Date.now() - 3 * h.HOUR });
    const archived = h.channel('8', 'ESPN 2', { archive: { enabled: true, durationHours: 72 } });
    setDay([g]);
    setStreams(g, [h.match(archived)]);
    const before = Date.now();
    await openReady();
    fireEvent.click(within(card(g)).getByTestId('sports-replay'));
    await waitFor(() => expect(player.catchups).toHaveLength(1));
    const end = Date.parse(player.catchups[0]!.program.end);
    expect(player.catchups[0]!.program.start).toBe(new Date(g.startMs - 10 * h.MINUTE).toISOString());
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(Date.now());
  });

  it("puts the rows that can act first: a final game's one archived copy is not hidden behind Show all", async () => {
    const g = h.finalGame('1');
    const guide = { start: new Date(g.startMs - 10 * h.MINUTE).toISOString(), end: new Date(g.startMs + 3 * h.HOUR).toISOString(), title: 'NBA Basketball' };
    const copies = ['1', '2', '3'].map((id) => h.channel(`a${id}`, `ESPN ${id}`));
    const archived = h.channel('b1', 'ESPN', { ref: { sourceId: 'src2', contentType: 'live', itemId: 'b1' }, archive: { enabled: true, durationHours: 72 } });
    setDay([g]);
    setStreams(g, [
      ...copies.map((c) => h.match(c, { reason: 'guide', program: { ...guide, channelId: c.ref.itemId } })),
      h.match(archived, { sourceId: 'src2', sourceName: 'Backup list' }),
    ]);
    await openReady();
    const c = card(g);
    const names = () => within(c).getAllByTestId('sports-stream').map((r) => r.querySelector('span[dir="auto"]')?.textContent);
    // The one row shown is the one that can act.
    expect(names()).toEqual(['ESPN']);
    expect(within(c).getAllByTestId('sports-replay')).toHaveLength(1);
    expect(within(within(c).getAllByTestId('sports-stream')[0]!).getByTestId('sports-replay')).toBeTruthy();
    // The rest keep matchGame's order.
    fireEvent.click(within(c).getByRole('button', { name: 'Show all 4 streams' }));
    expect(names()).toEqual(['ESPN', 'ESPN 1', 'ESPN 2', 'ESPN 3']);
  });

  it('replays the matched guide programme when there is one', async () => {
    const g = h.finalGame('1');
    const archived = h.channel('8', 'ESPN 2', { archive: { enabled: true } });
    const program = { channelId: '8', start: new Date(g.startMs - 30 * h.MINUTE).toISOString(), end: new Date(g.startMs + 3 * h.HOUR).toISOString(), title: 'NBA Basketball' };
    setDay([g]);
    setStreams(g, [h.match(archived, { reason: 'guide', program })]);
    player.fail = new Error('gone');
    await openReady();
    fireEvent.click(within(card(g)).getByTestId('sports-replay'));
    await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't open the replay. The provider may not keep it any more."));
    player.fail = null;
    fireEvent.click(within(card(g)).getByTestId('sports-replay'));
    await waitFor(() => expect(player.catchups).toHaveLength(1));
    // The guide slot ends at the typical length; the replay runs an hour past it, as without a guide.
    expect(player.catchups[0]!.program).toMatchObject({
      start: program.start,
      end: new Date(g.startMs + TYPICAL_LENGTH_MS.nba + h.HOUR).toISOString(),
      title: 'Boston Celtics at New York Knicks',
    });
  });

  it('records a later game where recording works', async () => {
    const tomorrow = etDays(Date.now(), 7, 7)[8]!;
    const g = h.game('1', { startMs: Date.now() + 26 * h.HOUR, etDate: tomorrow });
    const tbd = h.game('2', { startMs: Date.now() + 26 * h.HOUR, etDate: tomorrow, timeValid: false });
    setDay([g, tbd], tomorrow);
    pickDay(tomorrow);
    setStreams(g, [h.match(ESPN)]);
    setStreams(tbd, [h.match(ESPN)]);
    rpc.handlers['recordings.schedule'] = (args) => ({ recording: { id: 'r1', status: 'scheduled', start: (args as { start: string }).start } });
    await openReady(`/sports?day=${tomorrow}`);
    // No real start time and no guide programme: nothing to record yet.
    expect(within(card(tbd)).queryByTestId('sports-record')).toBeNull();
    const button = await within(card(g)).findByRole('button', { name: 'Record Boston Celtics at New York Knicks on ESPN HD' });
    expect(within(card(g)).queryByTestId('sports-watch')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(rpc.callsOf('recordings.schedule')).toHaveLength(1));
    expect(rpc.callsOf('recordings.schedule')[0]).toEqual({
      ref: ESPN.ref,
      channelName: 'ESPN HD',
      title: 'Boston Celtics at New York Knicks',
      start: new Date(g.startMs - 10 * h.MINUTE).toISOString(),
      end: new Date(g.startMs + TYPICAL_LENGTH_MS.nba + h.HOUR).toISOString(),
    });
    await waitFor(() => expect(h.lastToast()?.variant).toBe('success'));
  });

  it('marks a game already set to record, and hides Record where recording is unsupported', async () => {
    const tomorrow = etDays(Date.now(), 7, 7)[8]!;
    const g = h.game('1', { startMs: Date.now() + 26 * h.HOUR, etDate: tomorrow });
    setDay([g], tomorrow);
    pickDay(tomorrow);
    setStreams(g, [h.match(ESPN), h.match(MSG)]);
    rpc.handlers['recordings.list'] = () => [
      { id: 'r1', kind: 'programme', status: 'scheduled', ref: ESPN.ref, start: new Date(g.startMs - 10 * h.MINUTE).toISOString(), end: new Date(g.startMs + 3 * h.HOUR).toISOString(), channelName: 'ESPN' },
    ];
    await openReady(`/sports?day=${tomorrow}`);
    fireEvent.click(await within(card(g)).findByRole('button', { name: 'Show all 2 streams' }));
    await waitFor(() => expect(within(card(g)).getAllByTestId('sports-recording-set')).toHaveLength(1));
    expect(within(card(g)).getAllByTestId('sports-record')).toHaveLength(1);
    cleanup();

    h.resetShared();
    rpc.handlers['recordings.capabilities'] = () => ({ supported: false });
    await openReady(`/sports?day=${tomorrow}`);
    await screen.findByTestId('sports-game');
    // Give the capabilities answer time to land; Record never appears.
    await waitFor(() => expect(rpc.callsOf('recordings.capabilities').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('sports-record')).toBeNull();
  });

  it('says when no stream was found, and that the quality filter may be why', async () => {
    const g = h.liveGame('1');
    setDay([g]);
    await openReady();
    expect(within(card(g)).getByTestId('sports-no-streams').textContent).toBe('No stream found');
    cleanup();

    h.resetShared();
    rpc.handlers['settings.get'] = () => ({ liveMinQuality: 'hd' });
    await openReady();
    await waitFor(() => expect(within(card(g)).getByTestId('sports-quality-note').textContent).toBe(' The Live TV quality filter may be hiding channels.'));
  });

  it('says streams are being looked for while matching runs', async () => {
    const g = h.liveGame('1');
    setDay([g]);
    data.streamsLoading = true;
    await openReady();
    await waitFor(() => expect(within(card(g)).getByTestId('sports-streams-loading').textContent).toBe('Looking for streams…'));
    expect(within(screen.getByTestId('sports-live')).getByRole('heading', { level: 2 }).textContent).toBe('Live now1');
    // Nothing is counted as having a stream until matching is done.
    expect(within(screen.getByTestId('sports-streams-only')).queryByText('0')).toBeNull();
  });

  it('shows a skeleton while the day loads', () => {
    data.loading = true;
    open();
    expect(screen.getByRole('status', { name: 'Loading games' })).toBeTruthy();
  });

  it('says when a day has no games', () => {
    open();
    expect(screen.getByText('No games on this day')).toBeTruthy();
    expect(screen.getByText('Pick another day or league.')).toBeTruthy();
  });

  it('shows ESPN failures with a retry, and keeps the games it has', async () => {
    data.error = new Error('ESPN nba scoreboard answered HTTP 503');
    open();
    expect(screen.getByRole('heading', { name: "Couldn't load scores" })).toBeTruthy();
    expect(screen.getByText("ESPN's scoreboard didn't answer. Check your internet connection and try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(data.refetches).toBe(1);
    cleanup();

    data.cache.clear();
    setDay([h.game('1')]);
    open();
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load scores");
    expect(screen.getAllByTestId('sports-game')).toHaveLength(1);
  });

  it('with no source, offers adding one in place and lists the games without streams', async () => {
    rpc.handlers['sources.list'] = () => [];
    const g = h.liveGame('1');
    setDay([g]);
    open();
    const add = await screen.findByTestId('sports-add-source');
    expect(add.tagName).toBe('BUTTON');
    expect(screen.getByText('No sources yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import a backup' }).getAttribute('href')).toBe('/settings/backup');
    expect(within(card(g)).queryByTestId('sports-no-streams')).toBeNull();
    expect(within(card(g)).queryByTestId('sports-streams-loading')).toBeNull();
    expect(data.streamCalls.at(-1)?.enabled).toBe(false);
  });

  it('keeps the add dialog through the new source being listed mid-import, then stays and fills in', async () => {
    resetProgressForTests();
    let listed: unknown[] = [];
    rpc.handlers['sources.list'] = () => listed;
    const created = {
      id: 'new1',
      kind: 'm3u',
      name: 'Huge list',
      position: 0,
      autoRefresh: false,
      channelCount: 1200,
      movieCount: 0,
      seriesCount: 0,
      m3u: { origin: 'url', url: 'http://lists.example.com/huge.m3u' },
      epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] },
    };
    let finish: (s: unknown) => void = () => undefined;
    rpc.handlers['sources.add'] = () => new Promise((resolve) => (finish = resolve));
    setDay([h.liveGame('1')]);
    open();
    fireEvent.click(await screen.findByTestId('sports-add-source'));
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('tab', { name: 'M3U playlist' }));
    fireEvent.change(within(dlg).getByLabelText(/^Name/, { selector: 'input' }), { target: { value: 'Huge list' } });
    fireEvent.change(within(dlg).getByLabelText(/^Playlist URL/, { selector: 'input' }), { target: { value: 'http://lists.example.com/huge.m3u' } });
    fireEvent.click(within(dlg).getByTestId('add-source-submit'));
    await waitFor(() => expect(rpc.callsOf('sources.add')).toHaveLength(1));
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'parsing', done: 1200 }));
    await within(dlg).findByTestId('import-cancel');

    // The core lists the new source before its import runs: the banner and its dialog stay.
    listed = [created];
    const listCalls = rpc.callsOf('sources.list').length;
    await act(async () => {
      await invalidate('sources.');
    });
    await waitFor(() => expect(rpc.callsOf('sources.list').length).toBeGreaterThan(listCalls));
    expect(screen.getByRole('dialog')).toBe(dlg);
    expect(within(dlg).getByTestId('import-cancel')).toBeTruthy();
    expect(screen.getByTestId('sports-no-sources')).toBeTruthy();

    // The import finishes: Sports stays put, the banner goes and the games get their streams.
    await act(async () => finish(created));
    await waitFor(() => expect(screen.queryByTestId('sports-no-sources')).toBeNull());
    expect(h.location.current).toBe('/sports');
    await waitFor(() => expect(data.streamCalls.at(-1)?.enabled).toBe(true));
    resetProgressForTests();
  });
});

describe('the programme a replay or recording covers', () => {
  const title = 'Boston Celtics at New York Knicks';
  const iso = (t: number) => new Date(t).toISOString();
  const archived = h.channel('8', 'ESPN 2', { archive: { enabled: true, durationHours: 72 } });

  it('keeps a guide slot that ends after the game window: the longer of the two wins', () => {
    const g = h.finalGame('1', { startMs: Date.now() - 6 * h.HOUR });
    // The window ends at start + 3 h 30 (NBA); this slot runs to start + 4 h.
    const slot = { channelId: '8', start: iso(g.startMs - 30 * h.MINUTE), end: iso(g.startMs + 4 * h.HOUR), title: 'NBA Basketball' };
    expect(gameProgram(g, h.match(archived, { reason: 'guide', program: slot }), title)).toEqual({ ...slot, title });
  });

  it('leaves the guide slot alone for a game with no real start, and has nothing without a guide', () => {
    const slot = { channelId: '1', start: iso(Date.now() + h.HOUR), end: iso(Date.now() + 4 * h.HOUR), title: 'College Football' };
    const tbd = h.game('2', { league: 'cfb', timeValid: false });
    const flex = h.game('3', { league: 'cfb', timeNote: 'FLEX: 3:30 - 4:30pm OR 6 - 8pm ET start' });
    for (const g of [tbd, flex]) {
      // The window of a TBD game runs to 4 AM the next day; stretching the slot to it would balloon the recording.
      expect(gameProgram(g, h.match(ESPN, { reason: 'guide', program: slot }), title)).toEqual({ ...slot, title });
      expect(gameProgram(g, h.match(ESPN), title)).toBeNull();
    }
  });

  it('replays a guide slot that is still running only up to now, and offers nothing without an archive', () => {
    const now = Date.now();
    const g = h.finalGame('4', { startMs: now - 2 * h.HOUR });
    const slot = { channelId: '8', start: iso(g.startMs - 30 * h.MINUTE), end: iso(now + 2 * h.HOUR), title: 'NBA Basketball' };
    expect(streamAction(g, h.match(archived, { reason: 'guide', program: slot }), now, true, title)).toEqual({ kind: 'replay', program: { ...slot, title, end: iso(now) } });
    expect(streamAction(g, h.match(ESPN), now, true, title)).toBeNull();
  });
});
