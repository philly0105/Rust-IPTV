import { describe, expect, it } from 'vitest';

import type { Season, SeriesDetail, TmdbMovie, TmdbSeason, TmdbTv, VodDetail } from '@/api/types';

import {
  episodeOrder,
  isGenericEpisodeTitle,
  resumeTarget,
  mergeMovieDetail,
  mergeSeasonEpisodes,
  mergeSeriesDetail,
  nextEpisode,
  sortSeasons,
  youtubeKey,
} from '../lib/merge';


const ref = { sourceId: 's1', contentType: 'movie' as const, itemId: '7' };

const provider: VodDetail = {
  item: { ref, title: 'Dune: Part Two', titleBase: 'Dune Part Two', categoryId: 'c', posterUrl: 'http://p/poster.jpg', rating: 0, containerExtension: 'mkv' },
  cast: [{ name: 'Timothee Chalamet' }],
  providerDetailsUnavailable: false,
  backdrops: ['http://p/bd1.jpg'],
};

const tmdb: TmdbMovie = {
  tmdbId: 693134,
  mediaType: 'movie',
  title: 'Dune: Part Two (TMDB)',
  year: 2024,
  posterUrl: 'http://t/poster.jpg',
  backdropUrl: 'http://t/bd.jpg',
  rating: 8.234,
  overview: 'Paul Atreides unites with the Fremen.',
  runtime: 166,
  genres: ['Science Fiction'],
  cast: [{ id: 1190668, name: 'Timothee Chalamet', role: 'Paul', profileUrl: 'http://t/tc.jpg' }],
  crew: [],
  director: 'Denis Villeneuve',
  trailerYoutubeKey: 'Way9Dexny3w',
  similar: [{ tmdbId: 438631, mediaType: 'movie', title: 'Dune' }],
};

describe('mergeMovieDetail', () => {
  it('keeps provider identity and fills empty editorial fields from TMDB', () => {
    const m = mergeMovieDetail(provider, tmdb);
    expect(m.title).toBe('Dune: Part Two');
    expect(m.posterUrl).toBe('http://p/poster.jpg');
    expect(m.year).toBe(2024);
    expect(m.rating).toBe(8.2);
    expect(m.plot).toBe('Paul Atreides unites with the Fremen.');
    expect(m.genres).toEqual(['Science Fiction']);
    expect(m.director).toBe('Denis Villeneuve');
    expect(m.durationSeconds).toBe(166 * 60);
    expect(m.trailerKey).toBe('Way9Dexny3w');
    expect(m.tmdbId).toBe(693134);
    expect(m.backdrops).toEqual(['http://p/bd1.jpg', 'http://t/bd.jpg']);
    expect(m.backdropUrl).toBe('http://p/bd1.jpg');
    expect(m.similar).toHaveLength(1);
    expect(m.enriched).toBe(true);
  });

  it('replaces an id-less provider cast with the TMDB cast so chips can link', () => {
    expect(mergeMovieDetail(provider, tmdb).cast[0]?.id).toBe(1190668);
    const withIds: VodDetail = { ...provider, cast: [{ id: 5, name: 'Provider Person' }] };
    expect(mergeMovieDetail(withIds, tmdb).cast).toEqual([{ id: 5, name: 'Provider Person' }]);
  });

  it('lets provider values win when present', () => {
    const rich: VodDetail = {
      ...provider,
      item: { ...provider.item, year: 2023, rating: 7.04, plot: 'Provider plot', genres: ['Drama'], durationSeconds: 600 },
      director: 'Someone',
      trailerUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    };
    expect(mergeMovieDetail(rich, tmdb)).toMatchObject({
      year: 2023,
      rating: 7,
      plot: 'Provider plot',
      genres: ['Drama'],
      durationSeconds: 600,
      director: 'Someone',
      trailerKey: 'abcdefghijk',
    });
  });

  it('works without TMDB', () => {
    const m = mergeMovieDetail(provider, null);
    expect(m.enriched).toBe(false);
    expect(m.rating).toBeUndefined();
    expect(m.cast).toEqual(provider.cast);
    expect(m.similar).toEqual([]);
  });
});

describe('mergeSeriesDetail', () => {
  it('uses creators as director and carries the TMDB status', () => {
    const detail: SeriesDetail = {
      item: { ref: { ...ref, contentType: 'series' }, title: 'Severance', categoryId: 'c' },
      seasons: [],
      cast: [],
      providerDetailsUnavailable: false,
      backdrops: [],
    };
    const tv: TmdbTv = {
      tmdbId: 95396,
      mediaType: 'tv',
      title: 'Severance',
      genres: ['Drama'],
      cast: [],
      crew: [],
      creators: ['Dan Erickson'],
      seasons: [],
      similar: [],
      status: 'Returning Series',
    };
    const m = mergeSeriesDetail(detail, tv);
    expect(m.director).toBe('Dan Erickson');
    expect(m.status).toBe('Returning Series');
    expect(m.genres).toEqual(['Drama']);
  });
});

describe('episodes', () => {
  const sref = { sourceId: 's1', contentType: 'series' as const, itemId: '9' };
  const ep = (id: string, season: number, episode: number, title: string) => ({ id, seriesRef: sref, season, episode, title });
  const seasons: Season[] = [
    { number: 0, episodes: [ep('sp1', 0, 1, 'Special')] },
    { number: 2, episodes: [ep('b2', 2, 2, 'B2'), ep('b1', 2, 1, 'B1')] },
    { number: 1, episodes: [ep('a1', 1, 1, 'Episode 1'), ep('a2', 1, 2, 'Real title')] },
  ];

  it('sorts seasons with specials last and episodes by number', () => {
    expect(sortSeasons(seasons).map((s) => s.number)).toEqual([1, 2, 0]);
    expect(episodeOrder(seasons).map((e) => e.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'sp1']);
    expect(nextEpisode(seasons, 'a2')?.id).toBe('b1');
    expect(nextEpisode(seasons, 'sp1')).toBeUndefined();
  });

  it('fills generic titles, plots, stills, and runtimes from the TMDB season', () => {
    const tmdbSeason: TmdbSeason = {
      number: 1,
      name: 'Season 1',
      episodes: [
        { number: 1, name: 'Good News About Hell', overview: 'Mark is promoted.', stillUrl: 'http://t/e1.jpg', runtime: 57 },
        { number: 2, name: 'Half Loop', overview: 'Helly tries to leave.' },
      ],
    };
    const merged = mergeSeasonEpisodes(sortSeasons(seasons)[0]!, tmdbSeason);
    expect(merged[0]).toMatchObject({ id: 'a1', title: 'Good News About Hell', plot: 'Mark is promoted.', posterUrl: 'http://t/e1.jpg', durationSeconds: 57 * 60 });
    expect(merged[1]).toMatchObject({ id: 'a2', title: 'Real title', plot: 'Helly tries to leave.' });
    expect(isGenericEpisodeTitle('S01E03')).toBe(true);
    expect(isGenericEpisodeTitle('Ep. 4')).toBe(true);
    expect(isGenericEpisodeTitle('The Grim Barbarity')).toBe(false);
  });

  it('picks the resume target from series positions', () => {
    const order = episodeOrder(seasons);
    const pos = (episodeId: string, positionSeconds: number, updatedAt: string) => ({ ref: sref, episodeId, positionSeconds, durationSeconds: 1000, updatedAt, watched: false });
    expect(resumeTarget(order, [])).toEqual({ episode: order[0], resume: false });
    expect(resumeTarget(order, [pos('a2', 300, '2026-10-02'), pos('a1', 990, '2026-10-01')])).toEqual({ episode: order[1], resume: true });
    // latest one finished: start the next
    expect(resumeTarget(order, [pos('a2', 990, '2026-10-03'), pos('a1', 300, '2026-10-01')])).toEqual({ episode: order[2], resume: false });
    expect(resumeTarget([], [])).toBeUndefined();
  });

  it('replays a barely-started episode from the start (R2-r3 F2)', () => {
    const order = episodeOrder(seasons); // a1 a2 b1 b2 sp1
    const pos = (episodeId: string, positionSeconds: number, updatedAt: string, watched = false) => ({ ref: sref, episodeId, positionSeconds, durationSeconds: 1500, updatedAt, watched });
    // Played S01E01 for 4 s (at or under MIN_RESUME_SECONDS): Play S01E01 again, not S01E02.
    expect(resumeTarget(order, [pos('a1', 4, '2026-10-11')])).toEqual({ episode: order[0], resume: false });
    // Same after an earlier finished episode.
    expect(resumeTarget(order, [pos('a1', 1500, '2026-10-10', true), pos('a2', 3, '2026-10-11')])).toEqual({ episode: order[1], resume: false });
    // At 0 s too.
    expect(resumeTarget(order, [pos('b1', 0, '2026-10-11')])).toEqual({ episode: order[2], resume: false });
    // Past the resume window still moves on.
    expect(resumeTarget(order, [pos('a1', 1490, '2026-10-11')])).toEqual({ episode: order[1], resume: false });
  });

  it('skips episodes already marked watched (R2-r2 F3)', () => {
    const order = episodeOrder(seasons); // a1 a2 b1 b2 sp1
    const w = (episodeId: string, updatedAt: string) => ({ ref: sref, episodeId, positionSeconds: 1000, durationSeconds: 1000, updatedAt, watched: true });
    // "Mark season watched" on season 1, with E1 written last: start S02E01, not S01E02.
    expect(resumeTarget(order, [w('a2', '2026-10-11T15:16:37.504Z'), w('a1', '2026-10-11T15:16:37.505Z')])).toEqual({ episode: order[2], resume: false });
    // Walks past every watched episode after the latest finished one.
    expect(resumeTarget(order, [w('a1', '2026-10-03'), w('a2', '2026-10-01'), w('b1', '2026-10-02')])).toEqual({ episode: order[3], resume: false });
    // Latest finished is the last episode: the first unwatched one overall.
    expect(resumeTarget(order, [w('sp1', '2026-10-05'), w('a1', '2026-10-01')])).toEqual({ episode: order[1], resume: false });
    // Everything watched: back to the first episode.
    const all = order.map((e, i) => w(e.id, `2026-10-0${i + 1}`));
    expect(resumeTarget(order, all)).toEqual({ episode: order[0], resume: false });
  });

  it('extracts YouTube keys from common URL shapes', () => {
    expect(youtubeKey('https://youtu.be/Way9Dexny3w')).toBe('Way9Dexny3w');
    expect(youtubeKey('https://www.youtube.com/embed/Way9Dexny3w?x=1')).toBe('Way9Dexny3w');
    expect(youtubeKey('Way9Dexny3w')).toBe('Way9Dexny3w');
    expect(youtubeKey('http://example.com/t.mp4')).toBeUndefined();
  });
});
