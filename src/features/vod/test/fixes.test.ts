import { describe, expect, it } from 'vitest';

import type { Download } from '@/api/types';
import { buildLibrary, parseEpisodeCode, seriesTitle } from '@/features/library/lib/myvideos';

import { cleanEpisodeTitle, downloadFileName, episodeSubtitle } from '../lib/format';
import { isCachedStalkerSeries } from '../lib/search';

describe('episodeSubtitle', () => {
  it('writes S01E02 · Title', () => {
    expect(episodeSubtitle(1, 2, 'Half Loop')).toBe('S01E02 · Half Loop');
    expect(episodeSubtitle(12, 104, '  Pilot ')).toBe('S12E104 · Pilot');
  });

  it('falls back to the bare code when the title is empty or only repeats the code', () => {
    expect(episodeSubtitle(1, 2, '')).toBe('S01E02');
    expect(episodeSubtitle(1, 2, undefined)).toBe('S01E02');
    expect(episodeSubtitle(1, 2, 's01e02')).toBe('S01E02');
  });

  it('round-trips through the library parser (My Videos grouping)', () => {
    expect(parseEpisodeCode(episodeSubtitle(1, 2, 'Half Loop'))).toEqual({ season: 1, episode: 2, rest: 'Half Loop' });
    const dl = (id: number, episodeId: string, subtitle: string): Download => ({
      id,
      ref: { sourceId: 's', contentType: 'series', itemId: '7' },
      episodeId,
      title: 'Severance',
      subtitle,
      url: 'http://x/y.mp4',
      status: 'completed',
      bytesDownloaded: 1,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      completedAt: `2026-10-0${id}T00:00:00Z`,
      fileAvailable: true,
      positionSeconds: 0,
    });
    const a = dl(1, 'e2', episodeSubtitle(1, 2, 'Half Loop'));
    const b = dl(2, 'e1', episodeSubtitle(1, 1, 'Good News About Hell'));
    expect(seriesTitle([a, b])).toBe('Severance');
    expect(seriesTitle([a])).toBe('Severance');
    const lib = buildLibrary([a, b]);
    expect(lib).toHaveLength(1);
    expect(JSON.stringify(lib[0])).toContain('Half Loop');
  });
});

describe('downloadFileName', () => {
  it('names episodes Series - S01E02 - Title.ext and movies Title.ext', () => {
    expect(downloadFileName('Severance', 'S01E02 · Half Loop', 'mkv')).toBe('Severance - S01E02 - Half Loop.mkv');
    expect(downloadFileName('Heat', undefined, '.mp4')).toBe('Heat.mp4');
    expect(downloadFileName('Heat', undefined, undefined)).toBe('Heat.mp4');
    expect(downloadFileName('Heat', '', '')).toBe('Heat.mp4');
  });
});

describe('isCachedStalkerSeries', () => {
  const seriesRow = { ref: { sourceId: 'p', contentType: 'series', itemId: '42' }, title: 'Show' };
  const movieRow = { ref: { sourceId: 'p', contentType: 'movie', itemId: '43' }, title: 'Film' };

  it('finds a VOD-as-series row in cached pages and rail arrays', () => {
    expect(isCachedStalkerSeries([{ items: [movieRow, seriesRow], total: 2 }], 'p', '42')).toBe(true);
    expect(isCachedStalkerSeries([[seriesRow]], 'p', '42')).toBe(true);
  });

  it('ignores movies, other sources, and junk', () => {
    expect(isCachedStalkerSeries([{ items: [movieRow] }], 'p', '43')).toBe(false);
    expect(isCachedStalkerSeries([{ items: [seriesRow] }], 'other', '42')).toBe(false);
    expect(isCachedStalkerSeries([undefined, null, 3, { items: 'x' }, [null]], 'p', '42')).toBe(false);
  });
});

describe('cleanEpisodeTitle', () => {
  it('strips the panel wrapper around an Xtream episode title', () => {
    expect(cleanEpisodeTitle('Captain Kindling - S01E02 - Last Call', 'Captain Kindling', 1, 2)).toBe('Last Call');
    expect(episodeSubtitle(1, 2, 'Captain Kindling - S01E02 - Last Call', 'Captain Kindling')).toBe('S01E02 · Last Call');
    expect(cleanEpisodeTitle('S01E02 - Last Call', undefined, 1, 2)).toBe('Last Call');
    expect(cleanEpisodeTitle('Last Call (1x02)', undefined, 1, 2)).toBe('Last Call (1x02)');
    expect(cleanEpisodeTitle('Last Call 1x02', undefined, 1, 2)).toBe('Last Call');
  });

  it('keeps real titles that merely start like the series or carry other numbers', () => {
    expect(cleanEpisodeTitle('Lost Souls', 'Lost', 1, 1)).toBe('Lost Souls');
    expect(cleanEpisodeTitle('Episode 2', 'Show', 1, 2)).toBe('Episode 2');
    expect(cleanEpisodeTitle('S01E12 - Twelve', undefined, 1, 1)).toBe('S01E12 - Twelve');
    expect(cleanEpisodeTitle('Show (US) - S02E03', 'Show (US)', 2, 3)).toBe('');
    expect(cleanEpisodeTitle('Show', 'show', 1, 1)).toBe('');
  });
});
