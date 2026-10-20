import { afterEach, describe, expect, it } from 'vitest';

import type { PlayerSource } from '@/api/types';

import { expandPath, pushStageTarget } from './stage';

function live(sourceId: string, itemId: string, contentType: 'live' | 'radio' = 'live'): PlayerSource {
  return { url: 'http://h/s.m3u8', kind: 'hls', title: 'News', isLive: true, isRadio: contentType === 'radio', ref: { sourceId, contentType, itemId } };
}

describe('expandPath (LG-05: the mini player opens the playing channel, not the last stage page)', () => {
  let pop: (() => void) | null = null;
  afterEach(() => {
    pop?.();
    pop = null;
    window.history.replaceState(null, '', '/');
  });

  /** A stage last shown on `path`, as a page with a <PlayerStage /> leaves it. */
  function stageOn(path: string): void {
    window.history.replaceState(null, '', path);
    pop = pushStageTarget(document.createElement('div'));
  }

  it("opens the channel's own source, not the Live page of the source browsed before", () => {
    stageOn('/s/A/live/sports');
    expect(expandPath(live('B', '7'), { sourceId: 'B' })).toBe('/s/B/live');
    // A group remembered for another source does not carry over.
    expect(expandPath(live('B', '7'), { sourceId: 'A', categoryId: 'sports' })).toBe('/s/B/live');
  });

  it('keeps the group, the list and the Favorites view the channel was played from', () => {
    expect(expandPath(live('A', '7'), { sourceId: 'A', categoryId: 'news 1' })).toBe('/s/A/live/news%201');
    expect(expandPath(live('A', '7'), { sourceId: 'A', listId: 'list-7' })).toBe('/lists/list-7');
    expect(expandPath(live('A', '7'), { sourceId: 'A', favorites: {} })).toBe('/s/A/live/%40favorites');
    expect(expandPath(live('A', '7'), { sourceId: 'A', categoryId: '@recent' })).toBe('/s/A/live/%40recent');
  });

  it('opens a radio station on the Radio page', () => {
    expect(expandPath(live('A', '9', 'radio'), { sourceId: 'A', categoryId: 'jazz' })).toBe('/s/A/radio?category=jazz');
    expect(expandPath(live('A', '9', 'radio'), undefined)).toBe('/s/A/radio');
  });

  it('goes back to the last stage page for anything that is not a live channel', () => {
    stageOn('/s/A/movie/42');
    const movie: PlayerSource = { url: 'http://h/m.mp4', kind: 'direct', title: 'Film', isLive: false, isRadio: false, ref: { sourceId: 'A', contentType: 'movie', itemId: '42' } };
    expect(expandPath(movie, { sourceId: 'A' })).toBe('/s/A/movie/42');
    // Catch-up plays a live channel's ref as a recording: its archive page showed the stage.
    stageOn('/live/archive/A/7');
    expect(expandPath({ ...live('A', '7'), isLive: false }, { sourceId: 'A' })).toBe('/live/archive/A/7');
  });
});
