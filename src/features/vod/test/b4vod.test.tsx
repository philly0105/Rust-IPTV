/**
 * B4-vod (run tsrust-iptv-20261012-0414): episode queue for auto-advance,
 * series "start over", persisted scroll memory, search partial errors and
 * resume progress, landing filter empty state, untitled episode artwork.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Episode, ItemRef, PlaybackPosition, PlayerSource, SeriesDetail, VodItem } from '@/api/types';

import { forgetSpots, recallSeason, recallSpot, reloadSpotsForTests, rememberSeason, rememberSpot, SCROLL_STORAGE_KEY, useScrollMemory } from '../hooks/useScrollMemory';
import {
  REFRESH_LEAD_SECONDS,
  episodeQueueActive,
  placeholderFor,
  previousEpisodes,
  queueEpisodes,
  queueSeriesFrom,
  resolveQueue,
  startEpisodeQueue,
  stopEpisodeQueue,
  type EpisodeQueueContext,
} from '../lib/episodeQueue';
import { SearchPage } from '../pages/SearchPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { VodLandingPage } from '../pages/VodLandingPage';
import { installDomStubs, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const sref: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const ep = (id: string, season: number, episode: number, title = `Episode ${season}.${episode}`): Episode => ({ id, seriesRef: sref, season, episode, title });
/** S1: 3 episodes, S2: 2, S3: 1, specials: 1 (play order puts specials last). */
const ORDER: Episode[] = [ep('e11', 1, 1), ep('e12', 1, 2), ep('e13', 1, 3), ep('e21', 2, 1), ep('e22', 2, 2), ep('e31', 3, 1), ep('e01', 0, 1)];

function streamUrl(a: unknown): PlayerSource {
  const { episodeId } = a as { episodeId: string };
  return { url: `http://x/series/${episodeId}.mkv`, kind: 'direct', title: 'Severance', ref: sref, episodeId, isLive: false, isRadio: false };
}

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
type QueueEntry = { episodeId?: string; url: string; resumeSeconds?: number };
const queueOf = () => usePlayerStore.getState().queue as QueueEntry[];
const queueIds = () => queueOf().map((q) => q.episodeId);

function resetHandlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  // Parental controls off: detail pages open without a lock check (C2).
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['positions.remove'] = () => null;
  h['positions.continueWatching'] = () => [];
  h['xtream.streamUrl'] = streamUrl;
  h['stalker.streamUrl'] = streamUrl;
}

beforeAll(installDomStubs);
beforeEach(() => {
  resetHandlers();
  stopEpisodeQueue();
  forgetSpots();
  played.length = 0;
  usePlayerStore.setState({ source: undefined, status: 'idle', mode: 'inline', positionSeconds: 0, durationSeconds: undefined, queue: [] });
});
afterEach(() => {
  cleanup();
  stopEpisodeQueue();
});

function ctxFor(kind: 'xtream' | 'stalker', positions?: Map<string, PlaybackPosition>): EpisodeQueueContext {
  const ctx: EpisodeQueueContext = { ref: sref, sourceKind: kind, title: 'Severance', order: ORDER };
  if (positions) ctx.positions = positions;
  return ctx;
}

function playing(episodeId: string, extra: { positionSeconds?: number; durationSeconds?: number } = {}) {
  usePlayerStore.setState({ source: { ref: sref, episodeId }, status: 'playing', positionSeconds: 0, ...extra });
}

describe('B4-vod-D1: queueEpisodes (rest of the season, then the next season)', () => {
  it('takes the rest of the season and the whole next season', () => {
    expect(queueEpisodes(ORDER, 'e12').map((e) => e.id)).toEqual(['e13', 'e21', 'e22']);
  });
  it('from the last episode of a season, queues the next season only', () => {
    expect(queueEpisodes(ORDER, 'e13').map((e) => e.id)).toEqual(['e21', 'e22']);
  });
  it('never runs from a regular season into the specials', () => {
    expect(queueEpisodes(ORDER, 'e31')).toEqual([]);
  });
  it('respects a lookahead limit and unknown ids', () => {
    expect(queueEpisodes(ORDER, 'e11', 1).map((e) => e.id)).toEqual(['e12']);
    expect(queueEpisodes(ORDER, 'nope')).toEqual([]);
  });
});

describe('B4-vod-D1: resolveQueue', () => {
  it('stops at the first episode that fails, so the queue never skips one', async () => {
    rpcMock.handlers['xtream.streamUrl'] = (a) => {
      if ((a as { episodeId: string }).episodeId === 'e21') throw new Error('gone');
      return streamUrl(a);
    };
    const out = await resolveQueue(ctxFor('xtream'), queueEpisodes(ORDER, 'e11'));
    expect(out.map((s) => s.episodeId)).toEqual(['e12', 'e13']);
  });

  it('titles entries like the page and carries a saved position as resumeSeconds', async () => {
    const positions = new Map<string, PlaybackPosition>([
      ['e12', { ref: sref, episodeId: 'e12', positionSeconds: 300, durationSeconds: 3000, updatedAt: '2026-10-10T00:00:00Z', watched: false }],
    ]);
    const [first] = await resolveQueue(ctxFor('xtream', positions), [ORDER[1]!]);
    expect(first).toMatchObject({ title: 'Severance', subtitle: 'S01E02 · Episode 1.2', episodeId: 'e12', resumeSeconds: 300, isLive: false });
  });
});

describe('B4-vod-D1/D2: startEpisodeQueue follows the player', () => {
  it('sets the queue to the earlier episodes, the current one, the rest of the season and the next season', async () => {
    playing('e12');
    await startEpisodeQueue(ctxFor('xtream'), 'e12');
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e21', 'e22']);
  });

  it('is a no-op when the player is on something else (playback failed)', async () => {
    usePlayerStore.setState({ source: { ref: { ...sref, itemId: 'other' } }, status: 'error' });
    await startEpisodeQueue(ctxFor('xtream'), 'e12');
    expect(queueIds()).toEqual([]);
    expect(episodeQueueActive()).toBe(false);
  });

  it('extends the queue when the player auto-advances into the next season', async () => {
    playing('e13');
    await startEpisodeQueue(ctxFor('xtream'), 'e13');
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e21', 'e22']);
    act(() => playing('e22'));
    await waitFor(() => expect(queueIds()).toEqual(['e21', 'e22', 'e31']));
  });

  it('stalker: resolves one ahead and refreshes it shortly before the episode ends', async () => {
    let n = 0;
    rpcMock.handlers['stalker.streamUrl'] = (a) => ({ ...streamUrl(a), url: `http://portal/${(a as { episodeId: string }).episodeId}?token=${++n}` });
    playing('e11', { durationSeconds: 3000 });
    await startEpisodeQueue(ctxFor('stalker'), 'e11');
    expect(queueIds()).toEqual(['e11', 'e12']);
    const before = queueOf()[1]!.url;
    act(() => usePlayerStore.setState({ positionSeconds: 3000 - REFRESH_LEAD_SECONDS + 5 }));
    await waitFor(() => expect(queueOf()[1]!.url).not.toBe(before));
    // Once per episode.
    const count = callsOf('stalker.streamUrl').length;
    act(() => usePlayerStore.setState({ positionSeconds: 2990 }));
    await Promise.resolve();
    expect(callsOf('stalker.streamUrl')).toHaveLength(count);
  });

  it('lets go when something else plays', async () => {
    playing('e11');
    await startEpisodeQueue(ctxFor('xtream'), 'e11');
    expect(episodeQueueActive()).toBe(true);
    act(() => usePlayerStore.setState({ source: { ref: { sourceId: 'src1', contentType: 'movie', itemId: 'm1' } } }));
    expect(episodeQueueActive()).toBe(false);
  });

  it('queueSeriesFrom loads the episodes itself (continue watching entry point)', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = (): SeriesDetail => ({
      item: { ref: sref, title: 'Severance', categoryId: 'c' },
      seasons: [
        { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
        { number: 2, episodes: [ep('e21', 2, 1)] },
      ],
      cast: [],
      backdrops: [],
      providerDetailsUnavailable: false,
    });
    playing('e11');
    await queueSeriesFrom({ ref: sref, sourceKind: 'xtream', title: 'Severance', episodeId: 'e11' });
    expect(queueIds()).toEqual(['e11', 'e12', 'e21']);
  });
});

describe('B4-vod-D12: earlier episodes are in the queue, so Prev works', () => {
  it('previousEpisodes: the earlier episodes of the season, else the previous season’s last', () => {
    expect(previousEpisodes(ORDER, 'e11')).toEqual([]);
    expect(previousEpisodes(ORDER, 'e13').map((e) => e.id)).toEqual(['e11', 'e12']);
    expect(previousEpisodes(ORDER, 'e21').map((e) => e.id)).toEqual(['e13']);
    // Specials never step back into a regular season (nor the reverse).
    expect(previousEpisodes(ORDER, 'e01')).toEqual([]);
    expect(previousEpisodes(ORDER, 'nope')).toEqual([]);
  });

  it('earlier entries are URL-less placeholders the player resolves on Prev', async () => {
    const ph = placeholderFor(ctxFor('xtream'), ORDER[0]!);
    expect(ph).toMatchObject({ url: '', ref: sref, episodeId: 'e11', title: 'Severance', subtitle: 'S01E01 · Episode 1.1', isLive: false });
    playing('e12');
    await startEpisodeQueue(ctxFor('xtream'), 'e12');
    const q = queueOf();
    expect(q[0]).toMatchObject({ episodeId: 'e11', url: '' });
    expect(q[1]!.url).not.toBe('');
    // Only the current and upcoming episodes were resolved.
    expect(callsOf('xtream.streamUrl').map((c) => (c.args as { episodeId: string }).episodeId)).not.toContain('e11');
  });

  it('from the first episode of a season, Prev goes to the previous season’s last', async () => {
    playing('e21');
    await startEpisodeQueue(ctxFor('xtream'), 'e21');
    expect(queueIds()).toEqual(['e13', 'e21', 'e22', 'e31']);
  });
});

describe('SeriesDetailPage (B4-vod-D1, D3, D4, D10)', () => {
  const detail = (): SeriesDetail => ({
    item: { ref: sref, title: 'Severance', categoryId: 'c1' },
    seasons: [
      { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2), ep('e13', 1, 3)] },
      { number: 2, episodes: [ep('e21', 2, 1)] },
    ],
    cast: [],
    providerDetailsUnavailable: false,
    backdrops: [],
  });
  const route = [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }];

  beforeEach(() => {
    rpcMock.handlers['xtream.seriesDetail'] = detail;
    rpcMock.handlers['tmdb.tv'] = () => null;
    rpcMock.handlers['positions.forSeries'] = () => [
      { ref: sref, episodeId: 'e12', positionSeconds: 600, durationSeconds: 3000, updatedAt: '2026-10-10T00:00:00Z', watched: false },
    ];
  });

  it('D1: playing an episode hands the player the rest of the season and the next one', async () => {
    renderAt('/s/src1/series/s1', route);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume S01E02' }));
    await waitFor(() => expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e21']));
  });

  it('D3: a resumable episode also offers "Start over", which plays from 0 and keeps the saved row', async () => {
    renderAt('/s/src1/series/s1', route);
    fireEvent.click(await screen.findByRole('button', { name: 'Start S01E02 over' }));
    await waitFor(() => expect(played).toHaveLength(1));
    // VL-start-over-unwatches: removing the row first also dropped its watched mark.
    expect(callsOf('positions.remove')).toHaveLength(0);
    expect(played[0]).toMatchObject({ episodeId: 'e12', fromStart: true });
  });

  it('D4: no second "next episode" countdown when the player queue already has the next episode', async () => {
    renderAt('/s/src1/series/s1', route);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume S01E02' }));
    await waitFor(() => expect(queueIds()).toContain('e13'));
    act(() => usePlayerStore.setState({ status: 'paused', positionSeconds: 3000, durationSeconds: 3000 }));
    await screen.findByRole('button', { name: 'Close player' });
    expect(screen.queryByText(/Next episode in/)).toBeNull();
    // Without a queue (it could not be built), the page's own card still offers the next episode.
    act(() => usePlayerStore.setState({ queue: [] }));
    expect(await screen.findByText(/Next episode in/)).toBeTruthy();
  });

  it('D10: an untitled episode falls back to its code on the artwork tile', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = () => ({ ...detail(), seasons: [{ number: 1, episodes: [ep('e11', 1, 1, '')] }] });
    renderAt('/s/src1/series/s1', route);
    const list = await screen.findByRole('list', { name: 'Episodes' });
    expect(await within(list).findByText('S0')).toBeTruthy(); // initials of "S01E01"
  });
});

describe('B4-vod-D8: scroll memory survives a restart and StrictMode', () => {
  it('persists spots and season picks to localStorage and reads them back', () => {
    rememberSpot('/s/src1/movies/c/all', { scrollTop: 1234, index: 42 });
    rememberSeason('src1|s1', 3);
    reloadSpotsForTests();
    expect(localStorage.getItem(SCROLL_STORAGE_KEY)).toContain('1234');
    expect(recallSpot('/s/src1/movies/c/all')).toEqual({ scrollTop: 1234, index: 42 });
    expect(recallSeason('src1|s1')).toBe(3);
  });

  it('ignores malformed entries in storage', () => {
    localStorage.setItem(SCROLL_STORAGE_KEY, '{"spots":[["a",{"scrollTop":"x"}],["b",{"scrollTop":5}],7],"seasons":"no"}');
    reloadSpotsForTests(false);
    expect(recallSpot('a')).toBeUndefined();
    expect(recallSpot('b')).toEqual({ scrollTop: 5 });
    localStorage.setItem(SCROLL_STORAGE_KEY, 'not json');
    reloadSpotsForTests(false);
    expect(recallSpot('b')).toBeUndefined();
  });

  it('under StrictMode, onRestored still runs after the double mount', async () => {
    rememberSpot('k', { scrollTop: 300, index: 2 });
    const onRestored = vi.fn();
    function Probe() {
      useScrollMemory({ key: 'k', getScroller: () => document.getElementById('scroller'), ready: true, onRestored });
      return null;
    }
    render(
      <StrictMode>
        <div id="scroller" />
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });
});

describe('SearchPage (B4-vod-D5, D6, D7, D9)', () => {
  const movie = (i: number): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` }, title: `Movie ${i}`, categoryId: 'c1' });

  it('D9: says so when the portal search failed while library results are shown', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('src1', 'xtream', 'Alpha'), makeSource('src2', 'stalker', 'Beta')];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1)], series: [] });
    let fail = true;
    rpcMock.handlers['stalker.search'] = () => {
      if (fail) throw new Error('portal timeout');
      return { items: [], total: 0, offset: 0, limit: 14 };
    };
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
    const notice = await screen.findByTestId('vod-search-partial-error');
    expect(within(notice).getByText('Some results could not be loaded.')).toBeTruthy();
    fail = false;
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByTestId('vod-search-partial-error')).toBeNull());
  });

  it('D6 + D7: posters carry resume progress, and an unknown cover size falls back to medium', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ coverSize: 'huge' as never });
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1), movie(2)], series: [] });
    rpcMock.handlers['positions.continueWatching'] = () => [
      { ref: movie(1).ref, positionSeconds: 900, durationSeconds: 3600, updatedAt: '2026-10-10T00:00:00Z', watched: false },
    ];
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
    const grid = await screen.findByTestId('vod-search-movies');
    expect(await within(grid).findByRole('link', { name: 'Movie 1, 25% watched' })).toBeTruthy();
    expect(within(grid).getByRole('link', { name: 'Movie 2' })).toBeTruthy();
    expect(Number(grid.getAttribute('data-columns'))).toBeGreaterThan(0);
  });

  it('L4-vod-3: posters show the rating chip, as the category grid does', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [{ ...movie(1), rating: 8.2 }, movie(2)], series: [] });
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
    const grid = await screen.findByTestId('vod-search-movies');
    expect(await within(grid).findByRole('link', { name: 'Movie 1, rated 8.2 of 10' })).toBeTruthy();
    expect(within(grid).getByRole('link', { name: 'Movie 2' })).toBeTruthy();
  });

  it('D5: back from a title, the results scroll to where they were', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1)], series: [] });
    rememberSpot('/search?q=movie', { scrollTop: 640 });
    renderAt('/search?q=movie', [{ path: '/search', element: <SearchPage /> }]);
    const root = await screen.findByTestId('vod-search');
    await screen.findByTestId('vod-search-movies');
    await waitFor(() => expect(root.scrollTop).toBe(640));
  });
});

describe('VodLandingPage (B4-vod-D11)', () => {
  it('a category filter with no match offers to clear it', async () => {
    const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: 3, position: 0 } as Category];
    rpcMock.handlers['catalog.categories'] = () => cats;
    rpcMock.handlers['catalog.recentlyAdded'] = () => [];
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    await screen.findByRole('link', { name: /Action/ });
    fireEvent.change(screen.getByPlaceholderText('Filter categories'), { target: { value: 'zzz' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filter' }));
    expect(await screen.findByRole('link', { name: /Action/ })).toBeTruthy();
  });
});

describe('B4-vod-D13: the detail page and the player agree the series ends before the specials', () => {
  it('nextEpisode never runs from a regular season into season 0', async () => {
    const { nextEpisode } = await import('../lib/merge');
    const seasons = [
      { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
      { number: 0, episodes: [ep('e01', 0, 1), ep('e02', 0, 2)] },
      { number: 2, episodes: [ep('e21', 2, 1)] },
    ];
    expect(nextEpisode(seasons, 'e12')?.id).toBe('e21');
    expect(nextEpisode(seasons, 'e21')).toBeUndefined();
    expect(queueEpisodes(ORDER, 'e31')).toEqual([]);
    // Inside the specials, they still run on.
    expect(nextEpisode(seasons, 'e01')?.id).toBe('e02');
  });
});

describe('B4-vod-D14: "Resume" uses the player\'s own resume threshold', () => {
  it('isResumable agrees with MIN_RESUME_SECONDS', async () => {
    const { isResumable } = await import('../lib/format');
    const { MIN_RESUME_SECONDS } = await import('@/features/player/store');
    const at = (positionSeconds: number) => ({ positionSeconds, durationSeconds: 3000, watched: false });
    expect(isResumable(at(8))).toBe(true);
    expect(isResumable(at(MIN_RESUME_SECONDS + 1))).toBe(true);
    expect(isResumable(at(MIN_RESUME_SECONDS))).toBe(false);
    expect(isResumable(at(2))).toBe(false);
  });
});

describe('B4-vod-D15: the Up next rail follows the same specials rule', () => {
  it('upcoming() stops before season 0 after a regular season', async () => {
    const { upcoming } = await import('../components/detail/UpNext');
    expect(upcoming(ORDER, 'e22').map((e) => e.id)).toEqual(['e31']);
    expect(upcoming(ORDER, 'e31')).toEqual([]);
    expect(upcoming(ORDER, 'e11', 2).map((e) => e.id)).toEqual(['e12', 'e13']);
    // Inside the specials, and with nothing playing, the order is unchanged.
    const withSpecials = [...ORDER, ep('e02', 0, 2)];
    expect(upcoming(withSpecials, 'e01').map((e) => e.id)).toEqual(['e02']);
    expect(upcoming(ORDER, undefined)).toHaveLength(ORDER.length);
  });
});
