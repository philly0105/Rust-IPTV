/**
 * Field-level merge of TMDB metadata over provider detail data.
 *
 * Rules (pure, nothing mutated):
 * - The provider always wins for identity and stream data: title, ref,
 *   container, episode ids, season and episode numbering.
 * - TMDB fills editorial fields only when the provider left them empty:
 *   plot, genres, rating, year, poster, director, trailer, runtime.
 * - Backdrops: provider artwork first, TMDB backdrop appended, de-duplicated.
 * - Cast: provider casts carry no TMDB person ids in practice, so they cannot
 *   link to actor pages. When the provider cast has no ids and TMDB has a
 *   cast, the TMDB cast (ids and photos) replaces it; a provider cast with
 *   ids is kept.
 * - Similar titles come from TMDB only.
 */

import type {
  Episode,
  Person,
  PlaybackPosition,
  Season,
  SeriesDetail,
  TmdbBrief,
  TmdbMovie,
  TmdbSeason,
  TmdbTv,
  VodDetail,
} from '@/api/types';

import { MIN_RESUME_SECONDS } from '@/features/player/store';

import { isResumable, isWatched } from './format';
import { itemLanguage, type ItemLanguage } from './language';

export interface DetailModel {
  title: string;
  /** Title without the year/tags the provider appends ("Black Harbor" for "Black Harbor (2026)"); the year shows as its own chip. */
  titleBase?: string;
  /** Audio language from the provider title or category. */
  language?: ItemLanguage;
  mediaType: 'movie' | 'tv';
  year?: number;
  rating?: number;
  plot?: string;
  genres: string[];
  posterUrl?: string;
  /** TMDB poster to try when the provider poster fails to load. */
  posterFallbackUrl?: string;
  backdropUrl?: string;
  backdrops: string[];
  cast: Person[];
  director?: string;
  /** YouTube video key, when a trailer is known. */
  trailerKey?: string;
  /** Provider trailer that is not a YouTube link (opened as is). */
  trailerUrl?: string;
  durationSeconds?: number;
  tmdbId?: number;
  similar: TmdbBrief[];
  /** TMDB series status, for example "Returning Series". */
  status?: string;
  /** True when any TMDB data took part in the merge. */
  enriched: boolean;
}

function isBlank(v: string | undefined | null): v is undefined | null {
  return v === undefined || v === null || v.trim() === '';
}

function firstText(...vals: (string | undefined | null)[]): string | undefined {
  for (const v of vals) if (!isBlank(v)) return v.trim();
  return undefined;
}

function positive(v: number | undefined | null): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function roundRating(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 10) / 10;
}

function dedupe(urls: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (isBlank(u)) continue;
    const t = u.trim();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Extracts a YouTube video key from a bare key or any common YouTube URL shape. */
export function youtubeKey(input: string | undefined | null): string | undefined {
  if (isBlank(input)) return undefined;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/i.exec(s);
  return m?.[1];
}

function trailerParts(providerTrailer: string | undefined, tmdbKey: string | undefined): { trailerKey?: string; trailerUrl?: string } {
  const providerKey = youtubeKey(providerTrailer);
  if (providerKey) return { trailerKey: providerKey };
  if (!isBlank(tmdbKey)) return { trailerKey: tmdbKey.trim() };
  if (!isBlank(providerTrailer) && /^https?:\/\//i.test(providerTrailer.trim())) {
    return { trailerUrl: providerTrailer.trim() };
  }
  return {};
}

function mergeCast(provider: Person[], tmdb: Person[] | undefined): Person[] {
  const providerHasIds = provider.some((p) => typeof p.id === 'number');
  if (providerHasIds || !tmdb || tmdb.length === 0) return provider;
  return tmdb;
}

interface CommonInput {
  title: string;
  titleBase?: string;
  categoryName?: string | undefined;
  mediaType: 'movie' | 'tv';
  year?: number;
  rating?: number;
  plot?: string;
  genres?: string[];
  posterUrl?: string;
  backdropUrl?: string;
  backdrops: string[];
  cast: Person[];
  director?: string;
  trailerUrl?: string;
  durationSeconds?: number;
  tmdbId?: number;
}

function mergeCommon(
  p: CommonInput,
  t: TmdbMovie | TmdbTv | null | undefined,
  tmdbDirector: string | undefined,
  tmdbRuntimeMinutes: number | undefined,
): DetailModel {
  const backdrops = dedupe([p.backdropUrl, ...p.backdrops, t?.backdropUrl]);
  const providerGenres = (p.genres ?? []).filter((g) => !isBlank(g));
  const model: DetailModel = {
    title: p.title,
    mediaType: p.mediaType,
    genres: providerGenres.length > 0 ? providerGenres : (t?.genres ?? []),
    backdrops,
    cast: mergeCast(p.cast, t?.cast),
    similar: t?.similar ?? [],
    enriched: !!t,
    ...trailerParts(p.trailerUrl, t?.trailerYoutubeKey),
  };
  const year = positive(p.year) ?? positive(t?.year);
  if (year !== undefined) model.year = year;
  const rating = roundRating(positive(p.rating) ?? positive(t?.rating));
  if (rating !== undefined) model.rating = rating;
  const plot = firstText(p.plot, t?.overview);
  if (plot !== undefined) model.plot = plot;
  const poster = firstText(p.posterUrl, t?.posterUrl);
  if (poster !== undefined) model.posterUrl = poster;
  const tmdbPoster = firstText(t?.posterUrl);
  if (tmdbPoster !== undefined && tmdbPoster !== poster) model.posterFallbackUrl = tmdbPoster;
  const titleBase = firstText(p.titleBase);
  if (titleBase !== undefined) model.titleBase = titleBase;
  const language = itemLanguage(p.title, p.categoryName);
  if (language) model.language = language;
  if (backdrops[0] !== undefined) model.backdropUrl = backdrops[0];
  const director = firstText(p.director, tmdbDirector);
  if (director !== undefined) model.director = director;
  const runtime = positive(tmdbRuntimeMinutes);
  const duration = positive(p.durationSeconds) ?? (runtime !== undefined ? runtime * 60 : undefined);
  if (duration !== undefined) model.durationSeconds = duration;
  const tmdbId = t?.tmdbId ?? p.tmdbId;
  if (tmdbId !== undefined) model.tmdbId = tmdbId;
  return model;
}

export function mergeMovieDetail(detail: VodDetail, tmdb?: TmdbMovie | null): DetailModel {
  const { item } = detail;
  return mergeCommon(
    {
      title: item.title,
      titleBase: item.titleBase,
      categoryName: item.categoryName,
      year: item.year,
      rating: item.rating,
      plot: item.plot,
      genres: item.genres,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      backdrops: detail.backdrops,
      cast: detail.cast,
      director: detail.director,
      trailerUrl: detail.trailerUrl,
      durationSeconds: item.durationSeconds,
      tmdbId: item.tmdbId,
      mediaType: 'movie',
    },
    tmdb,
    tmdb?.director,
    tmdb?.runtime,
  );
}

export function mergeSeriesDetail(detail: SeriesDetail, tmdb?: TmdbTv | null): DetailModel {
  const { item } = detail;
  const creators = tmdb?.creators.filter((c) => !isBlank(c)).join(', ');
  const model = mergeCommon(
    {
      title: item.title,
      titleBase: item.titleBase,
      categoryName: item.categoryName,
      year: item.year,
      rating: item.rating,
      plot: item.plot,
      genres: item.genres,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      backdrops: detail.backdrops,
      cast: detail.cast,
      director: detail.director,
      trailerUrl: detail.trailerUrl,
      tmdbId: item.tmdbId,
      mediaType: 'tv',
    },
    tmdb,
    creators || undefined,
    undefined,
  );
  if (tmdb?.status) model.status = tmdb.status;
  return model;
}

const GENERIC_EPISODE_TITLE = /^\s*(?:(?:episode|ep\.?|e)\s*\d+|s\d+\s*e\d+|\d+)\s*$/i;

/** True when an episode title carries no information beyond its number. */
export function isGenericEpisodeTitle(title: string | undefined): boolean {
  return isBlank(title) || GENERIC_EPISODE_TITLE.test(title);
}

/** Fills episode stills, overviews, runtimes, and generic titles from a TMDB season. */
export function mergeSeasonEpisodes(season: Season, tmdbSeason?: TmdbSeason | null): Episode[] {
  if (!tmdbSeason || tmdbSeason.episodes.length === 0) return season.episodes;
  const byNumber = new Map(tmdbSeason.episodes.map((e) => [e.number, e]));
  return season.episodes.map((ep) => {
    const t = byNumber.get(ep.episode);
    if (!t) return ep;
    const out: Episode = { ...ep };
    if (isGenericEpisodeTitle(ep.title) && !isBlank(t.name)) out.title = t.name.trim();
    if (isBlank(ep.plot) && !isBlank(t.overview)) out.plot = t.overview.trim();
    if (isBlank(ep.posterUrl) && !isBlank(t.stillUrl)) out.posterUrl = t.stillUrl;
    const runtime = positive(t.runtime);
    if (positive(ep.durationSeconds) === undefined && runtime !== undefined) out.durationSeconds = runtime * 60;
    return out;
  });
}

/** Seasons ascending with episodes by number; season 0 (specials) last. */
export function sortSeasons(seasons: Season[]): Season[] {
  const rank = (n: number) => (n <= 0 ? Number.MAX_SAFE_INTEGER : n);
  return [...seasons]
    .sort((a, b) => rank(a.number) - rank(b.number))
    .map((s) => ({ ...s, episodes: [...s.episodes].sort((a, b) => a.episode - b.episode) }));
}

/** Flattens seasons into play order (up-next rail and autoplay). */
export function episodeOrder(seasons: Season[]): Episode[] {
  return sortSeasons(seasons).flatMap((s) => s.episodes);
}

/**
 * The episode after `episodeId` in play order, if any. Same rule as the
 * player queue (`queueEpisodes`): a regular season never runs on into the
 * specials (season 0, sorted last).
 */
export function nextEpisode(seasons: Season[], episodeId: string | undefined): Episode | undefined {
  if (!episodeId) return undefined;
  const order = episodeOrder(seasons);
  const i = order.findIndex((e) => e.id === episodeId);
  const current = order[i];
  const next = i >= 0 ? order[i + 1] : undefined;
  if (!current || !next) return undefined;
  if (next.season <= 0 && current.season > 0) return undefined;
  return next;
}

/**
 * The episode Previous goes back to, mirroring the player queue (`previousEpisodes` in
 * episodeQueue.ts): the one before in the same season, else the previous season's last.
 * Specials (season 0, sorted last) never lead back into a regular season, or the reverse.
 */
export function previousEpisode(seasons: Season[], episodeId: string | undefined): Episode | undefined {
  if (!episodeId) return undefined;
  const order = episodeOrder(seasons);
  const i = order.findIndex((e) => e.id === episodeId);
  const current = order[i];
  const before = i > 0 ? order[i - 1] : undefined;
  if (!current || !before) return undefined;
  if ((before.season > 0) !== (current.season > 0)) return undefined;
  return before;
}

/**
 * Where "Play" should start: the most recent unfinished episode (from the
 * start when it ran under `MIN_RESUME_SECONDS`); else, after the most recent finished one, the
 * first episode not marked watched; else
 * the first unwatched episode of the series; else the first episode.
 */
export function resumeTarget(order: Episode[], positions: PlaybackPosition[]): { episode: Episode; resume: boolean } | undefined {
  if (order.length === 0) return undefined;
  const watched = new Set(positions.filter(isWatched).map((p) => p.episodeId));
  const firstUnwatchedFrom = (start: number) => order.slice(start).find((e) => !watched.has(e.id));
  const latest = [...positions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest?.episodeId) {
    const i = order.findIndex((e) => e.id === latest.episodeId);
    const ep = order[i];
    if (ep) {
      if (isResumable(latest)) return { episode: ep, resume: true };
      // Not resumable: finished (watched, or past the resume window) moves on; barely started (under `MIN_RESUME_SECONDS`) replays it.
      const finished = isWatched(latest) || latest.positionSeconds > MIN_RESUME_SECONDS;
      const after = firstUnwatchedFrom(finished ? i + 1 : i);
      if (after) return { episode: after, resume: false };
    }
  }
  return { episode: firstUnwatchedFrom(0) ?? order[0]!, resume: false };
}
