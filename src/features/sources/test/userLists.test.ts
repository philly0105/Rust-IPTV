import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { ItemRef } from '@/api/types';

import { dropSourcesFromLists } from '../lib/userLists';

const ref = (sourceId: string, itemId: string): ItemRef => ({ sourceId, contentType: 'movie', itemId });
const entry = (sourceId: string, itemId: string) => ({ ref: ref(sourceId, itemId), snapshot: { title: itemId, contentType: 'movie' } });

describe('dropSourcesFromLists', () => {
  it("takes a removed source's titles out of every cached user list at once", () => {
    const qc = new QueryClient();
    qc.setQueryData(['watchlist.list', {}], [entry('a', '1'), entry('gone', '2'), entry('a', '3')]);
    qc.setQueryData(['watchlist.list', { contentType: 'movie' }], [entry('gone', '2')]);
    qc.setQueryData(['favorites.list', {}], [entry('gone', '4')]);
    qc.setQueryData(['recent.list', { limit: 20 }], [entry('a', '5'), entry('gone', '6')]);
    qc.setQueryData(['positions.continueWatching', { limit: 20 }], [{ ref: ref('gone', '7'), positionSeconds: 10 }]);
    const untouched = [entry('a', '8')];
    qc.setQueryData(['favorites.list', { sourceId: 'a' }], untouched);

    dropSourcesFromLists(qc, ['gone']);

    const ids = (key: unknown[]) => (qc.getQueryData<{ ref: ItemRef }[]>(key) ?? []).map((e) => e.ref.itemId);
    expect(ids(['watchlist.list', {}])).toEqual(['1', '3']);
    expect(ids(['watchlist.list', { contentType: 'movie' }])).toEqual([]);
    expect(ids(['favorites.list', {}])).toEqual([]);
    expect(ids(['recent.list', { limit: 20 }])).toEqual(['5']);
    expect(ids(['positions.continueWatching', { limit: 20 }])).toEqual([]);
    // A list with nothing to drop keeps its identity (no needless re-render).
    expect(qc.getQueryData(['favorites.list', { sourceId: 'a' }])).toBe(untouched);
  });

  it('handles several sources (Remove all) and lists that are not loaded', () => {
    const qc = new QueryClient();
    qc.setQueryData(['watchlist.list', {}], [entry('x', '1'), entry('y', '2'), entry('z', '3')]);
    dropSourcesFromLists(qc, ['x', 'y']);
    expect((qc.getQueryData<{ ref: ItemRef }[]>(['watchlist.list', {}]) ?? []).map((e) => e.ref.sourceId)).toEqual(['z']);
    expect(qc.getQueryData(['favorites.list', {}])).toBeUndefined();
  });
});
