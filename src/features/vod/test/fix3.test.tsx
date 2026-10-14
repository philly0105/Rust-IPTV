import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, Page, PageQuery, SeriesDetail, TmdbMovie, TmdbTv, VodDetail, VodItem } from '@/api/types';

import { CategoryGridPage } from '../pages/CategoryGridPage';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { isResumable, progressFraction } from '../lib/format';
import { resumeTarget } from '../lib/merge';
import { effectiveMinRating, filterByRating } from '../lib/paging';
import { forgetSpots } from '../hooks/useScrollMemory';
import { currentLocation, installDomStubs, makeSource, renderAt, settings } from './harness';

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
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const notFound = (message: string) => () => {
  throw { code: 'not_found', message };
};
const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const sref: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const ep = (id: string, season: number, episode: number) => ({ id, seriesRef: sref, season, episode, title: `Episode ${season}.${episode}` });
const movieDetail = (patch: Partial<VodItem> = {}, flags: Partial<VodDetail> = {}): VodDetail => ({
  item: { ref: mref, title: 'Dune: Part Two', categoryId: 'c1', ...patch },
  cast: [],
  backdrops: [],
  providerDetailsUnavailable: false,
  ...flags,
});
const seriesDetail = (seasons: SeriesDetail['seasons'] = [{ number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] }]): SeriesDetail => ({
  item: { ref: sref, title: 'Severance', categoryId: 'c1' },
  seasons,
  cast: [],
  backdrops: [],
  providerDetailsUnavailable: false,
});
const tmdbTv: TmdbTv = {
  tmdbId: 95396,
  mediaType: 'tv',
  title: 'Severance',
  genres: [],
  cast: [],
  crew: [],
  creators: ['Dan Erickson'],
  seasons: [],
  similar: [],
};

const movieRoute = [
  { path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> },
  { path: '/s/:sourceId/series/:itemId', element: <div data-testid="series-page" /> },
];
const seriesRoute = [
  { path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> },
  { path: '/s/:sourceId/movie/:itemId', element: <div data-testid="movie-page" /> },
];
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

function useKind(kind: 'xtream' | 'stalker' | 'm3u') {
  const src = makeSource('src1', kind, 'Alpha IPTV');
  rpcMock.handlers['sources.get'] = () => src;
  rpcMock.handlers['sources.list'] = () => [src];
}

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  useKind('xtream');
  h['settings.get'] = () => settings({ tmdb: { enabled: true, apiKey: 'k' } });
  // Parental controls off: detail pages open without a lock check (C2).
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['xtream.vodDetail'] = () => movieDetail();
  h['xtream.seriesDetail'] = () => seriesDetail();
  h['tmdb.movie'] = () => null;
  h['tmdb.tv'] = () => null;
  h['tmdb.similar'] = () => [];
  h['tmdb.season'] = () => null;
  localStorage.clear();
});
afterEach(() => cleanup());

describe('U4-fix3: a cold link of the wrong kind redirects', () => {
  it('movie route with a series id goes to the series page (catalog lookup)', async () => {
    rpcMock.handlers['xtream.vodDetail'] = notFound('This movie is no longer offered by the provider.');
    rpcMock.handlers['catalog.item'] = (a) => {
      const ref = (a as { ref: ItemRef }).ref;
      if (ref.contentType !== 'series') throw { code: 'not_found', message: 'nope' };
      return { ref, title: 'Black Harbor', categoryId: 'c1' };
    };
    renderAt('/s/src1/movie/m7', movieRoute);
    await screen.findByTestId('series-page');
    expect(currentLocation).toBe('/s/src1/series/m7');
    expect(screen.queryByText('This movie is no longer offered by the provider.')).toBeNull();
  });

  it('series route with a movie id goes to the movie page', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = notFound('This series is no longer offered by the provider.');
    rpcMock.handlers['catalog.item'] = (a) => {
      const ref = (a as { ref: ItemRef }).ref;
      if (ref.contentType !== 'movie') throw { code: 'not_found', message: 'nope' };
      return { ref, title: 'Dune', categoryId: 'c1' };
    };
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByTestId('movie-page');
    expect(currentLocation).toBe('/s/src1/movie/s1');
  });

  it('a Stalker VOD-as-series id with nothing cached is found through stalker.seriesDetail', async () => {
    useKind('stalker');
    rpcMock.handlers['stalker.vodDetail'] = notFound('This title is no longer listed by the portal.');
    rpcMock.handlers['stalker.seriesDetail'] = () => seriesDetail();
    renderAt('/s/src1/movie/7001', movieRoute);
    await screen.findByTestId('series-page');
    expect(currentLocation).toBe('/s/src1/series/7001');
    expect(callsOf('stalker.seriesDetail')[0]!.args).toEqual({ ref: { sourceId: 'src1', contentType: 'series', itemId: '7001' } });
  });

  it('keeps the not-found page when the id is neither kind', async () => {
    rpcMock.handlers['xtream.vodDetail'] = notFound('This movie is no longer offered by the provider.');
    rpcMock.handlers['catalog.item'] = notFound('catalog item not found');
    renderAt('/s/src1/movie/m7', movieRoute);
    await screen.findByText('This movie is no longer offered by the provider.');
  });
});

describe('U4-fix3: TMDB key status on the similar rail', () => {
  it('shows a setup hint and no TMDB notice when no key resolves', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { enabled: true } });
    rpcMock.handlers['tmdb.testKey'] = () => ({ ok: false, message: 'No API key found. Paste one here, or put TMDB_API_KEY=<key> in a .env file.' });
    renderAt('/s/src1/movie/m7', movieRoute);
    await screen.findByText('Add a TMDB key in Settings > Metadata.');
    expect(screen.getByRole('link', { name: 'Add a TMDB key' }).getAttribute('href')).toBe('/settings/metadata');
    expect(screen.queryByText('TMDB has no similar titles for this one.')).toBeNull();
    expect(screen.queryByTestId('tmdb-attribution')).toBeNull();
    expect(callsOf('tmdb.testKey')[0]!.args).toEqual({ apiKey: '' });
  });

  it('does not probe when settings hold a key, and hides the notice when TMDB found nothing', async () => {
    renderAt('/s/src1/movie/m7', movieRoute);
    await screen.findByText('TMDB has no similar titles for this one.');
    expect(screen.queryByTestId('tmdb-attribution')).toBeNull();
    expect(callsOf('tmdb.testKey')).toHaveLength(0);
  });

  it('a .env key (testKey ok) keeps the normal rail', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { enabled: true } });
    rpcMock.handlers['tmdb.testKey'] = () => ({ ok: true });
    rpcMock.handlers['tmdb.movie'] = (): TmdbMovie => ({
      tmdbId: 1,
      mediaType: 'movie',
      title: 'Dune: Part Two',
      genres: [],
      cast: [],
      crew: [],
      similar: [{ tmdbId: 2, mediaType: 'movie', title: 'Dune' }],
    });
    renderAt('/s/src1/movie/m7', movieRoute);
    await screen.findByTestId('tmdb-attribution');
    expect(screen.queryByTestId('vod-tmdb-key-missing')).toBeNull();
  });
});

describe('U4-fix3: detail hero', () => {
  it('uses the base title with the year as its own chip', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => movieDetail({ title: 'Black Harbor (2026)', titleBase: 'Black Harbor', year: 2026 });
    renderAt('/s/src1/movie/m7', movieRoute);
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Black Harbor' });
    expect(h1.textContent).toBe('Black Harbor');
    expect(screen.queryByText('Black Harbor (2026)')).toBeNull();
    expect(screen.getByText('2026')).toBeTruthy();
  });

  it('labels a TV creator "Created by" and a movie director "Director"', async () => {
    rpcMock.handlers['tmdb.tv'] = () => tmdbTv;
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByText('Dan Erickson');
    expect(screen.getByText('Created by')).toBeTruthy();
    expect(screen.queryByText('Director')).toBeNull();
    cleanup();

    rpcMock.handlers['xtream.vodDetail'] = () => movieDetail({}, { director: 'Denis Villeneuve' });
    renderAt('/s/src1/movie/m7', movieRoute);
    await screen.findByText('Denis Villeneuve');
    expect(screen.getByText('Director')).toBeTruthy();
  });

  it('falls back to the TMDB poster when the provider poster fails', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => movieDetail({ posterUrl: 'http://provider/bad.jpg' });
    rpcMock.handlers['tmdb.movie'] = (): TmdbMovie => ({
      tmdbId: 1,
      mediaType: 'movie',
      title: 'Dune: Part Two',
      posterUrl: 'http://tmdb/poster.jpg',
      genres: [],
      cast: [],
      crew: [],
      similar: [],
    });
    renderAt('/s/src1/movie/m7', movieRoute);
    const frame = await screen.findByTestId('vod-detail-poster');
    await waitFor(() => expect(within(frame).getByRole('img').getAttribute('src')).toBe('http://provider/bad.jpg'));
    fireEvent.error(within(frame).getByRole('img'));
    await waitFor(() => expect(within(frame).getByRole('img').getAttribute('src')).toBe('http://tmdb/poster.jpg'));
  });

  it('renders the row with an inline notice when provider details are unavailable', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => movieDetail({}, { providerDetailsUnavailable: true, providerError: 'timeout' });
    renderAt('/s/src1/movie/m7', movieRoute);
    const notice = await screen.findByText('Provider details are unavailable right now. Play still works.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });
});

describe('U4-fix3: empty seasons hint by source kind', () => {
  it('Xtream says the provider sent no seasons; M3U keeps the playlist wording', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = () => seriesDetail([]);
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByText('The provider sent no seasons for this series. Refresh the source, or check back later.');
    cleanup();

    useKind('m3u');
    rpcMock.handlers['catalog.item'] = () => seriesDetail([]).item;
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByText(/M3U playlists carry no episode lists/);
  });
});

describe('U4-fix3: watched state', () => {
  it('format helpers treat a watched row as finished', () => {
    const watched = { positionSeconds: 30, durationSeconds: 3000, watched: true };
    expect(isResumable(watched)).toBe(false);
    expect(progressFraction(watched)).toBe(1);
    const order = [ep('e11', 1, 1), ep('e12', 1, 2)];
    expect(resumeTarget(order, [{ ref: sref, episodeId: 'e11', positionSeconds: 30, durationSeconds: 3000, updatedAt: '2026-10-10T00:00:00Z', watched: true }])).toEqual({
      episode: order[1],
      resume: false,
    });
  });

  it('marks a movie watched, and a watched movie offers Play and "Mark as unwatched"', async () => {
    rpcMock.handlers['userstate.setWatched'] = () => null;
    renderAt('/s/src1/movie/m7', movieRoute);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as watched' }));
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(1));
    expect(callsOf('userstate.setWatched')[0]!.args).toEqual({ ref: mref, watched: true });
    cleanup();

    // Marked (or finished) with a known duration, the core stores the position at the end.
    rpcMock.handlers['positions.get'] = () => ({ ref: mref, positionSeconds: 9960, durationSeconds: 9960, updatedAt: '2026-10-10T00:00:00Z', watched: true });
    renderAt('/s/src1/movie/m7', movieRoute);
    expect(await screen.findByRole('button', { name: 'Mark as unwatched' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
  });

  it('a watched movie replayed part-way offers Resume there and keeps its watched mark', async () => {
    // Run 2: a partial replay of a watched movie keeps the flag and stores the replay position.
    rpcMock.handlers['positions.get'] = () => ({ ref: mref, positionSeconds: 4980, durationSeconds: 9960, updatedAt: '2026-10-10T00:00:00Z', watched: true });
    renderAt('/s/src1/movie/m7', movieRoute);
    expect(await screen.findByRole('button', { name: 'Mark as unwatched' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Resume/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeTruthy();
  });

  it('isResumable: a watched movie resumes only between 5 % and 95 %; a watched episode never does', () => {
    const movie = (positionSeconds: number, durationSeconds?: number) => ({ ref: mref, positionSeconds, durationSeconds, watched: true });
    expect(isResumable(movie(4980, 9960))).toBe(true);
    expect(isResumable(movie(498, 9960))).toBe(true); // exactly 5 %
    expect(isResumable(movie(497, 9960))).toBe(false); // a few minutes into a rewatch is not worth a resume
    expect(isResumable(movie(9462, 9960))).toBe(false); // 95 %: finished again
    expect(isResumable(movie(4980))).toBe(false); // no duration: no share to check, the mark wins
    expect(isResumable({ ref: sref, episodeId: 'e11', positionSeconds: 1500, durationSeconds: 3000, watched: true })).toBe(false);
    expect(isResumable({ ref: sref, positionSeconds: 1500, durationSeconds: 3000, watched: true })).toBe(false);
  });

  it('checks watched episodes, marks one from its row menu, and marks a season', async () => {
    rpcMock.handlers['userstate.setWatched'] = () => null;
    rpcMock.handlers['positions.forSeries'] = () => [
      { ref: sref, episodeId: 'e11', positionSeconds: 3000, durationSeconds: 3000, updatedAt: '2026-10-10T00:00:00Z', watched: true },
    ];
    renderAt('/s/src1/series/s1', seriesRoute);
    expect(await screen.findByRole('button', { name: 'Play S01E01 Episode 1.1, Watched' })).toBeTruthy();
    expect(screen.getAllByTestId('episode-watched')).toHaveLength(1);
    // Play starts after the watched episode.
    expect(screen.getByRole('button', { name: 'Play S01E02' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for S01E02' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark S01E02 as watched' }));
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(1));
    expect(callsOf('userstate.setWatched')[0]!.args).toEqual({ ref: sref, episodeId: 'e12', watched: true });

    fireEvent.click(screen.getByRole('button', { name: 'Mark season watched' }));
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(3));
    expect(callsOf('userstate.setWatched').slice(1).map((c) => (c.args as { episodeId: string }).episodeId)).toEqual(['e11', 'e12']);
  });
});

describe('U4-fix3: minimum rating filter', () => {
  const TOTAL = 150;
  const rated = (i: number): VodItem => ({
    ref: { sourceId: 'src1', contentType: 'movie', itemId: `r${i}` },
    title: `Rated ${i}`,
    categoryId: 'c1',
    ...(i % 3 === 0 ? {} : { rating: i % 3 === 1 ? 8.1 : 5 }),
  });
  beforeEach(() => {
    rpcMock.handlers['catalog.categories'] = () => [];
    // Mirrors the core: `minRating` filters in SQLite and `total` counts the filtered set.
    const pageOfRated = (a: unknown): Page<VodItem> => {
      const { query: q, minRating } = a as { query: PageQuery; minRating?: number };
      const all = Array.from({ length: TOTAL }, (_, i) => rated(i)).filter((i) => !minRating || (i.rating ?? -1) >= minRating);
      return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit };
    };
    rpcMock.handlers['catalog.movies'] = pageOfRated;
    // Stalker pages straight from the portal, which ignores ratings.
    rpcMock.handlers['stalker.movies'] = (a) => pageOfRated({ query: (a as { query: PageQuery }).query });
  });
  const gridRoute = [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }];

  it('filterByRating hides unrated and low-rated items; effectiveMinRating honours the URL switch', () => {
    expect(filterByRating([rated(0), rated(1), rated(2)], 7).map((i) => i.title)).toEqual(['Rated 1']);
    expect(filterByRating([rated(0), rated(2)], 0)).toHaveLength(2);
    expect(effectiveMinRating(7, new URLSearchParams())).toBe(7);
    expect(effectiveMinRating(7, new URLSearchParams('ratings=all'))).toBe(0);
    expect(effectiveMinRating(undefined, new URLSearchParams())).toBe(0);
    expect(effectiveMinRating(42, new URLSearchParams())).toBe(10);
  });

  it('hides titles below settings.vodMinRating, notes it, and clears it', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ vodMinRating: 7 });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Rated 1');
    expect(screen.queryByText('Rated 2')).toBeNull();
    expect(screen.queryByText('Rated 3')).toBeNull();
    const note = screen.getByTestId('vod-rating-filter');
    expect(note.textContent).toContain('Showing titles rated 7.0 or higher');
    // The core filters (50 of 150 pass): one request, exact count from the first page.
    await waitFor(() => expect(within(screen.getByTestId('vod-grid-movie')).getByText('50')).toBeTruthy());
    const movieCalls = callsOf('catalog.movies');
    expect(movieCalls).toHaveLength(1);
    expect(movieCalls[0]!.args).toMatchObject({ sourceId: 'src1', minRating: 7, query: { offset: 0 } });

    fireEvent.click(within(note).getByRole('button', { name: 'Show all ratings' }));
    await screen.findByText('Rated 2');
    expect(currentLocation).toBe('/s/src1/movies/c/all?ratings=all');
    expect(screen.getByRole('button', { name: 'Show only titles rated 7.0 or higher' })).toBeTruthy();
  });

  it('shows the rating empty state after one request when nothing qualifies', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ vodMinRating: 9.6 });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('No titles here are rated 9.6 or higher');
    expect(callsOf('catalog.movies')).toHaveLength(1);
  });

  it('Stalker portals cannot filter, so the grid filters loaded pages and never sends minRating', async () => {
    useKind('stalker');
    rpcMock.handlers['settings.get'] = () => settings({ vodMinRating: 7 });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Rated 1');
    expect(screen.queryByText('Rated 2')).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId('vod-grid-movie')).getByText('50')).toBeTruthy());
    expect(callsOf('stalker.movies').every((c) => !('minRating' in (c.args as object)))).toBe(true);
  });

  it('shows no note and pages sparsely when the minimum is 0', async () => {
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Rated 2');
    expect(screen.queryByTestId('vod-rating-filter')).toBeNull();
  });
});

describe('English only on Stalker grids', () => {
  // Even items are tagged French; the portal pages them unfiltered.
  const item = (i: number): VodItem => ({
    ref: { sourceId: 'src1', contentType: 'movie', itemId: `l${i}` },
    title: i % 2 === 0 ? `FR - Film ${i}` : `Film ${i}`,
    categoryId: 'c1',
  });
  beforeEach(() => {
    useKind('stalker');
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['stalker.movies'] = (a) => {
      const q = (a as { query: PageQuery }).query;
      const all = Array.from({ length: 60 }, (_, i) => item(i));
      return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit };
    };
  });
  const gridRoute = [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }];

  it('filters loaded pages when the setting is on', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ englishOnly: true });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Film 1');
    expect(screen.queryByText('FR - Film 0')).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId('vod-grid-movie')).getByText('30')).toBeTruthy());
  });

  it('shows everything when the setting is off', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ englishOnly: false });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('FR - Film 0');
  });
});
