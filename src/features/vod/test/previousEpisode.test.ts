import { describe, expect, it } from 'vitest';

import type { Episode, Season } from '@/api/types';

import { previousEpisode } from '../lib/merge';

const seriesRef = { sourceId: 's1', contentType: 'series' as const, itemId: '301' };
const ep = (id: string, season: number, episode: number): Episode => ({ id, seriesRef, season, episode, title: id });

// Out of order on purpose: previousEpisode follows the sorted order, specials last.
const seasons: Season[] = [
  { number: 0, episodes: [ep('sp1', 0, 1), ep('sp2', 0, 2)] },
  { number: 2, episodes: [ep('b2', 2, 2), ep('b1', 2, 1)] },
  { number: 1, episodes: [ep('a1', 1, 1), ep('a2', 1, 2)] },
];

describe('previousEpisode', () => {
  it('goes back within a season and across to the previous season', () => {
    expect(previousEpisode(seasons, 'a2')?.id).toBe('a1');
    expect(previousEpisode(seasons, 'b1')?.id).toBe('a2');
    expect(previousEpisode(seasons, 'b2')?.id).toBe('b1');
  });

  it('has nothing before the first episode or for an unknown id', () => {
    expect(previousEpisode(seasons, 'a1')).toBeUndefined();
    expect(previousEpisode(seasons, 'zz')).toBeUndefined();
    expect(previousEpisode(seasons, undefined)).toBeUndefined();
  });

  it('never crosses between specials and regular seasons', () => {
    expect(previousEpisode(seasons, 'sp1')).toBeUndefined();
    expect(previousEpisode(seasons, 'sp2')?.id).toBe('sp1');
  });
});
