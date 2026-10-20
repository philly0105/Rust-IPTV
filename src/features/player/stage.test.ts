import { afterEach, describe, expect, it } from 'vitest';

import type { PlayerSource } from '@/api/types';

import { expandPath, noteStageShown, pushStageTarget } from './stage';

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
  });

  it('goes back to Recently watched, which LivePage marks on the context without a group', () => {
    // What LivePage sets on /s/A/live/@recent: no categoryId, so zapping still walks the source.
    expect(expandPath(live('A', '7'), { sourceId: 'A', view: 'recent' })).toBe('/s/A/live/%40recent');
    expect(expandPath(live('A', '9', 'radio'), { sourceId: 'A', view: 'recent' })).toBe('/s/A/radio?category=%40recent');
    // Another source's view does not carry over, as a group does not.
    expect(expandPath(live('B', '7'), { sourceId: 'A', view: 'recent' })).toBe('/s/B/live');
  });

  it('opens a radio station on the Radio page', () => {
    expect(expandPath(live('A', '9', 'radio'), { sourceId: 'A', categoryId: 'jazz' })).toBe('/s/A/radio?category=jazz');
    expect(expandPath(live('A', '9', 'radio'), undefined)).toBe('/s/A/radio');
  });

  it("opens a movie's or an episode's own detail page, not the last stage page (another title's or the guide's)", () => {
    const movie = (itemId: string): PlayerSource => ({
      url: `http://h/m${itemId}.mp4`,
      kind: 'direct',
      title: 'Film',
      isLive: false,
      isRadio: false,
      ref: { sourceId: 'A', contentType: 'movie', itemId },
    });
    // The Copper Meridian (20000) played on its page, then Harbor Nine (31) resumed from Home.
    stageOn('/s/A/movie/20000');
    noteStageShown(movie('20000').url);
    expect(expandPath(movie('31'), { sourceId: 'A' })).toBe('/s/A/movie/31');
    // The movie moved into the guide's preview band: Expand still opens its own page.
    stageOn('/epg');
    noteStageShown(movie('20000').url);
    expect(expandPath(movie('20000'), { sourceId: 'A' })).toBe('/s/A/movie/20000');
    // An episode carries its series' ref; a download carries its title's.
    const episode: PlayerSource = { ...movie('7'), episodeId: 'e3', ref: { sourceId: 'A b', contentType: 'series', itemId: '7' } };
    expect(expandPath(episode, undefined)).toBe('/s/A%20b/series/7');
  });

  it("opens catch-up on its channel's archive page", () => {
    stageOn('/epg');
    noteStageShown('http://h/s.m3u8');
    expect(expandPath({ ...live('A', '7'), isLive: false }, { sourceId: 'A' })).toBe('/live/archive/A/7');
  });

  it('brings a stream without a ref back to the page that showed it in a stage, and only that stream', () => {
    const file = (url: string): PlayerSource => ({ url, kind: 'file', title: 'Recording', isLive: false, isRadio: false });
    expect(expandPath(file('file:///rec-1.ts'), undefined)).toBeNull();
    stageOn('/my-videos');
    noteStageShown('file:///rec-1.ts');
    expect(expandPath(file('file:///rec-1.ts'), undefined)).toBe('/my-videos');
    // Another stream started from a page with no stage: nothing to go back to (Expand goes fullscreen).
    expect(expandPath(file('file:///rec-2.ts'), undefined)).toBeNull();
    expect(expandPath(undefined, undefined)).toBeNull();
  });

  it("keeps the first page that showed a stream with no ref, not the guide's preview band it moved into later", () => {
    const file: PlayerSource = { url: 'file:///rec-3.ts', kind: 'file', title: 'Recording', isLive: false, isRadio: false };
    stageOn('/my-videos/3');
    noteStageShown(file.url);
    pop?.();
    stageOn('/epg');
    noteStageShown(file.url);
    expect(expandPath(file, undefined)).toBe('/my-videos/3');
  });
});
