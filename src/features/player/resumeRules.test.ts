import { describe, expect, it } from 'vitest';

import type { ItemRef } from '@/api/types';

import { isPastEnd, isWatchedReplay, MIN_RESUME_SECONDS } from './resumeRules';

const movie: ItemRef = { sourceId: 's1', contentType: 'movie', itemId: '7' };
const series: ItemRef = { sourceId: 's1', contentType: 'series', itemId: '9' };

describe('resume rules', () => {
  it('counts a position from 95 % of the duration as the end', () => {
    expect(isPastEnd(94, 100)).toBe(false);
    expect(isPastEnd(95, 100)).toBe(true);
    expect(isPastEnd(500, undefined)).toBe(false);
  });

  it("treats a watched movie's replay between 5 % and 95 % as a resume point", () => {
    const row = { positionSeconds: 0, durationSeconds: 1000, watched: true, ref: movie };
    expect(isWatchedReplay({ ...row, positionSeconds: 49 })).toBe(false);
    expect(isWatchedReplay({ ...row, positionSeconds: 50 })).toBe(true);
    expect(isWatchedReplay({ ...row, positionSeconds: 949 })).toBe(true);
    expect(isWatchedReplay({ ...row, positionSeconds: 950 })).toBe(false);
    expect(isWatchedReplay({ ...row, positionSeconds: 500, watched: false })).toBe(false);
    expect(isWatchedReplay({ ...row, positionSeconds: 500, durationSeconds: 0 })).toBe(false);
  });

  it('never treats an episode or a series row as a replay', () => {
    const row = { positionSeconds: 500, durationSeconds: 1000, watched: true };
    expect(isWatchedReplay({ ...row, ref: series, episodeId: 'e1' })).toBe(false);
    expect(isWatchedReplay({ ...row, ref: series })).toBe(false);
  });

  it('is what the player store uses and re-exports', async () => {
    const store = await import('./store');
    expect(store.isWatchedReplay).toBe(isWatchedReplay);
    expect(store.MIN_RESUME_SECONDS).toBe(MIN_RESUME_SECONDS);
    expect(MIN_RESUME_SECONDS).toBe(5);
  });
});
