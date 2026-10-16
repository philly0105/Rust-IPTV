import { beforeEach, describe, expect, it, vi } from 'vitest';

import { itemKey, type ItemRef, type PlayerSource } from '@/api/types';

vi.mock('@/api/transport', () => ({
  rpc: async (name: string) => {
    throw new Error(`unmocked rpc ${name}`);
  },
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePlayerStore } = await import('./store');
const { HISTORY_LIMIT, __resetHistoryForTests, currentLiveKey, previousEntry, setHistoryOpen, useHistoryStore, withVisit } = await import('./history');

const ref = (id: number, contentType: ItemRef['contentType'] = 'live'): ItemRef => ({ sourceId: 's1', contentType, itemId: String(id) });

function live(id: number, extra: Partial<PlayerSource> = {}): PlayerSource {
  return { url: `http://h/live/${id}.m3u8`, kind: 'hls', title: `Channel ${id}`, isLive: true, isRadio: false, ref: ref(id), ...extra };
}

describe('channel history', () => {
  beforeEach(() => {
    usePlayerStore.setState({ source: undefined });
    __resetHistoryForTests();
  });

  it('keeps the most recent first, without duplicates, capped at the limit', () => {
    let entries = withVisit([], live(1));
    entries = withVisit(entries, live(2));
    entries = withVisit(entries, live(1));
    expect(entries.map((e) => e.ref.itemId)).toEqual(['1', '2']);
    for (let i = 3; i < 20; i++) entries = withVisit(entries, live(i));
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0]!.ref.itemId).toBe('19');
  });

  it('ignores VOD and sources without a ref', () => {
    const movie: PlayerSource = { url: 'http://h/m.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false, ref: ref(9, 'movie') };
    expect(withVisit([], movie)).toEqual([]);
    expect(withVisit([], live(1, { ref: undefined }))).toEqual([]);
  });

  it('keeps a known logo when a later visit has none', () => {
    const entries = withVisit(withVisit([], live(1, { posterUrl: 'http://h/logo.png' })), live(1));
    expect(entries[0]!.posterUrl).toBe('http://h/logo.png');
  });

  it('goes back to the most recent channel that is not playing now', () => {
    const entries = withVisit(withVisit(withVisit([], live(1)), live(2)), live(3));
    expect(previousEntry(entries, itemKey(ref(3)))?.ref.itemId).toBe('2');
    expect(previousEntry(entries.slice(0, 1), itemKey(ref(3)))).toBeUndefined();
    expect(previousEntry([], undefined)).toBeUndefined();
  });

  it('records each live channel the player starts', () => {
    usePlayerStore.setState({ source: live(1) });
    usePlayerStore.setState({ source: live(2) });
    usePlayerStore.setState({ source: { url: 'http://h/m.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false, ref: ref(9, 'movie') } });
    usePlayerStore.setState({ source: live(1) });
    expect(useHistoryStore.getState().entries.map((e) => e.ref.itemId)).toEqual(['1', '2']);
    expect(currentLiveKey()).toBe(itemKey(ref(1)));
  });

  it('closes the popover when live TV gives way to radio or nothing', () => {
    usePlayerStore.setState({ source: live(1), mode: 'inline' });
    setHistoryOpen(true);
    usePlayerStore.setState({ source: live(2, { isRadio: true }), mode: 'radio' });
    expect(useHistoryStore.getState().open).toBe(false);
    usePlayerStore.setState({ source: live(1), mode: 'inline' });
    setHistoryOpen(true);
    usePlayerStore.setState({ source: undefined });
    expect(useHistoryStore.getState().open).toBe(false);
  });

  it('a visit can stand in for another copy of the same channel', () => {
    const entries = withVisit(withVisit(withVisit([], live(9)), live(1)), live(2), itemKey(ref(1)));
    expect(entries.map((e) => e.ref.itemId)).toEqual(['2', '9']);
  });
});
