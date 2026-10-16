/**
 * Pure model for the offline library (/my-videos). Completed downloads become
 * movie cards; episodes of the same series (same `ref`) collapse into one
 * series card with a season/episode list.
 */

import { itemKey, type Download, type RecordingFile } from '@/api/types';

export interface EpisodeEntry {
  download: Download;
  season?: number;
  episode?: number;
  /** Episode name without the series title, e.g. "Pilot". May be empty. */
  name: string;
  missing: boolean;
}

export interface MovieEntry {
  kind: 'movie';
  key: string;
  title: string;
  posterUrl?: string;
  download: Download;
  missing: boolean;
  completedAt: string;
}

export interface SeriesEntry {
  kind: 'series';
  key: string;
  title: string;
  posterUrl?: string;
  /** Sorted by season, then episode, then completion time. */
  episodes: EpisodeEntry[];
  /** Most recently completed episode; its id addresses the series detail page. */
  latest: Download;
  missingCount: number;
  completedAt: string;
}

export type LibraryEntry = MovieEntry | SeriesEntry;

/** A file in the recordings folder, shown in the All grid beside downloads. */
export interface RecordingEntry {
  kind: 'recording';
  key: string;
  title: string;
  file: RecordingFile;
  missing: boolean;
  completedAt: string;
}

/** What the My Videos grid shows: downloads, and in All and Missing, recordings too. */
export type GridEntry = LibraryEntry | RecordingEntry;

export type LibraryFilter = 'all' | 'movies' | 'series' | 'missing';

const CODE_PATTERNS: readonly RegExp[] = [
  /\bS(\d{1,3})\s*[.\-_ ]?\s*E(\d{1,4})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bseason\s*(\d{1,3})\D{1,12}?episode\s*(\d{1,4})\b/i,
];

/** Extracts season and episode numbers from a label such as "S01E03 Pilot" or "1x03". */
export function parseEpisodeCode(text: string | undefined): { season: number; episode: number; rest: string } | undefined {
  if (!text) return undefined;
  for (const re of CODE_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1] && m[2]) {
      const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/^[\s\-–—:·|.,]+|[\s\-–—:·|.,]+$/g, '');
      return { season: Number(m[1]), episode: Number(m[2]), rest };
    }
  }
  return undefined;
}

export function isEpisode(d: Download): boolean {
  return d.episodeId != null || d.ref.contentType === 'series';
}

export function isMissing(d: Download): boolean {
  return d.fileAvailable === false;
}

function completedAtOf(d: Download): string {
  return d.completedAt ?? d.updatedAt;
}

/**
 * Picks the series name for a group. With several members, the string every
 * member shares (title or subtitle) is the series name. With one member, a
 * subtitle that carries the episode code means the title is the series name.
 */
export function seriesTitle(members: readonly Download[]): string {
  const first = members[0];
  if (!first) return '';
  if (members.length > 1) {
    for (const candidate of [first.title, first.subtitle]) {
      if (candidate && members.every((m) => m.title === candidate || m.subtitle === candidate)) return candidate;
    }
  }
  if (!first.subtitle || parseEpisodeCode(first.subtitle)) return first.title;
  if (parseEpisodeCode(first.title)) return first.subtitle;
  return first.title;
}

function toEpisode(d: Download, series: string): EpisodeEntry {
  const other = d.title === series ? d.subtitle : d.subtitle === series ? d.title : [d.title, d.subtitle].filter(Boolean).join(' ');
  const parsed = parseEpisodeCode(other) ?? parseEpisodeCode(d.title) ?? parseEpisodeCode(d.subtitle);
  const entry: EpisodeEntry = { download: d, name: '', missing: isMissing(d) };
  if (parsed) {
    entry.season = parsed.season;
    entry.episode = parsed.episode;
    const fromOther = other ? parseEpisodeCode(other) : undefined;
    entry.name = fromOther ? fromOther.rest : (other ?? '');
  } else {
    entry.name = other ?? '';
  }
  return entry;
}

function compareEpisodes(a: EpisodeEntry, b: EpisodeEntry): number {
  const sa = a.season ?? Number.MAX_SAFE_INTEGER;
  const sb = b.season ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  const ea = a.episode ?? Number.MAX_SAFE_INTEGER;
  const eb = b.episode ?? Number.MAX_SAFE_INTEGER;
  if (ea !== eb) return ea - eb;
  return completedAtOf(a.download).localeCompare(completedAtOf(b.download)) || a.download.id - b.download.id;
}

/** Builds the library from `myvideos.list`. Newest completion first. Non-completed rows are ignored. */
export function buildLibrary(downloads: readonly Download[]): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  const groups = new Map<string, Download[]>();
  for (const d of downloads) {
    if (d.status !== 'completed') continue;
    if (isEpisode(d)) {
      const key = itemKey(d.ref);
      const list = groups.get(key);
      if (list) list.push(d);
      else groups.set(key, [d]);
    } else {
      const movie: MovieEntry = {
        kind: 'movie',
        key: `m-${d.id}`,
        title: d.title,
        download: d,
        missing: isMissing(d),
        completedAt: completedAtOf(d),
      };
      if (d.posterUrl) movie.posterUrl = d.posterUrl;
      entries.push(movie);
    }
  }
  for (const [key, members] of groups) {
    const title = seriesTitle(members);
    const episodes = members.map((m) => toEpisode(m, title)).sort(compareEpisodes);
    let latest = members[0] as Download;
    for (const m of members) if (completedAtOf(m) > completedAtOf(latest)) latest = m;
    const series: SeriesEntry = {
      kind: 'series',
      key: `s-${key}`,
      title,
      episodes,
      latest,
      missingCount: episodes.filter((e) => e.missing).length,
      completedAt: completedAtOf(latest),
    };
    const poster = latest.posterUrl ?? members.find((m) => m.posterUrl)?.posterUrl;
    if (poster) series.posterUrl = poster;
    entries.push(series);
  }
  entries.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.key.localeCompare(b.key));
  return entries;
}

/** A recording file as a grid entry: the programme title leads, as in the Recordings list. */
export function recordingEntry(f: RecordingFile): RecordingEntry {
  return { kind: 'recording', key: `r-${f.id}`, title: f.title ?? f.channelName ?? f.fileName, file: f, missing: !f.fileAvailable, completedAt: f.date };
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Downloads and recordings in one list, newest first. Both inputs are already newest first. */
export function withRecordings(library: readonly LibraryEntry[], files: readonly RecordingFile[]): GridEntry[] {
  if (files.length === 0) return [...library];
  const all: GridEntry[] = [...library, ...files.map(recordingEntry)];
  return all.sort((a, b) => timeOf(b.completedAt) - timeOf(a.completedAt) || a.key.localeCompare(b.key));
}

/** Whether an entry has a file that is gone from disk (a series counts when any episode is). */
export function hasMissing(e: GridEntry): boolean {
  return e.kind === 'series' ? e.missingCount > 0 : e.missing;
}

/** Applies the type chip and the search term. Recordings only pass All and Missing. */
export function filterLibrary<E extends GridEntry>(entries: readonly E[], filter: LibraryFilter, search: string): E[] {
  const q = search.trim().toLocaleLowerCase();
  return entries.filter((e) => {
    if (filter === 'movies' && e.kind !== 'movie') return false;
    if (filter === 'series' && e.kind !== 'series') return false;
    if (filter === 'missing' && !hasMissing(e)) return false;
    if (!q) return true;
    if (e.title.toLocaleLowerCase().includes(q)) return true;
    if (e.kind === 'recording') return [e.file.channelName, e.file.fileName].some((s) => s?.toLocaleLowerCase().includes(q));
    return e.kind === 'series' && e.episodes.some((ep) => ep.name.toLocaleLowerCase().includes(q));
  });
}

/** The download id a library entry's detail page is opened with. */
export function entryTargetId(e: LibraryEntry): number {
  return e.kind === 'movie' ? e.download.id : e.latest.id;
}

/** Finds the library entry that owns a download id (movie or any episode of a series). */
export function findEntry(entries: readonly LibraryEntry[], id: number): LibraryEntry | undefined {
  return entries.find((e) => (e.kind === 'movie' ? e.download.id === id : e.episodes.some((ep) => ep.download.id === id)));
}

export interface SeasonGroup {
  /** Undefined for episodes whose season could not be read. */
  season?: number;
  episodes: EpisodeEntry[];
}

/** Groups sorted episodes by season. */
export function groupBySeason(episodes: readonly EpisodeEntry[]): SeasonGroup[] {
  const out: SeasonGroup[] = [];
  for (const ep of episodes) {
    const last = out[out.length - 1];
    if (last && last.season === ep.season) last.episodes.push(ep);
    else {
      const g: SeasonGroup = { episodes: [ep] };
      if (ep.season !== undefined) g.season = ep.season;
      out.push(g);
    }
  }
  return out;
}

/** Total bytes on disk for available files. */
export function librarySize(downloads: readonly Download[]): number {
  let n = 0;
  for (const d of downloads) if (d.status === 'completed' && !isMissing(d)) n += d.totalBytes ?? d.bytesDownloaded;
  return n;
}

/** Resume point unless the item is effectively finished (>= 95 %). */
export function resumePoint(d: Download, durationSeconds?: number): number | undefined {
  if (!d.positionSeconds || d.positionSeconds < 5) return undefined;
  if (durationSeconds && d.positionSeconds >= durationSeconds * 0.95) return undefined;
  return d.positionSeconds;
}
