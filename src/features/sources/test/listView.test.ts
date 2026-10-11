import { describe, expect, it } from 'vitest';

import type { Source } from '@/api/types';

import { DEFAULT_VIEW, VIEW_STORAGE_KEY, applyView, isManualView, loadView, saveView } from '../lib/listView';

const src = (id: string, over: Partial<Source>): Source => ({ id, kind: 'm3u', name: id, createdAt: '2026-01-01T00:00:00Z', ...over }) as Source;

const list = [
  src('a', { name: 'Item 10', kind: 'stalker', createdAt: '2026-02-01T00:00:00Z', lastRefreshAt: '2026-10-01T00:00:00Z' }),
  src('b', { name: 'item 9', kind: 'm3u', createdAt: '2026-03-01T00:00:00Z' }),
  src('c', { name: 'Alpha', kind: 'xtream', createdAt: '2026-01-01T00:00:00Z', lastRefreshAt: '2026-10-05T00:00:00Z', lastError: 'x' }),
];
const ids = (l: Source[]) => l.map((s) => s.id);

describe('applyView', () => {
  it('keeps stored order for the manual view', () => {
    expect(ids(applyView(list, DEFAULT_VIEW))).toEqual(['a', 'b', 'c']);
  });
  it('sorts by name with numeric collation', () => {
    expect(ids(applyView(list, { ...DEFAULT_VIEW, sort: 'name' }))).toEqual(['c', 'b', 'a']);
  });
  it('sorts by kind, added (newest first), refreshed (never last)', () => {
    expect(ids(applyView(list, { ...DEFAULT_VIEW, sort: 'kind' }))).toEqual(['b', 'c', 'a']);
    expect(ids(applyView(list, { ...DEFAULT_VIEW, sort: 'added' }))).toEqual(['b', 'a', 'c']);
    expect(ids(applyView(list, { ...DEFAULT_VIEW, sort: 'refreshed' }))).toEqual(['c', 'a', 'b']);
  });
  it('filters by kind and status without mutating the input', () => {
    expect(ids(applyView(list, { ...DEFAULT_VIEW, status: 'error' }))).toEqual(['c']);
    expect(ids(applyView(list, { ...DEFAULT_VIEW, status: 'ok', kind: 'm3u' }))).toEqual(['b']);
    expect(ids(list)).toEqual(['a', 'b', 'c']);
  });
});

describe('view persistence', () => {
  it('round-trips and rejects unknown values', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveView({ sort: 'added', kind: 'xtream', status: 'error' }, storage);
    expect(loadView(storage)).toEqual({ sort: 'added', kind: 'xtream', status: 'error' });
    store.set(VIEW_STORAGE_KEY, JSON.stringify({ sort: 'bogus', kind: 3 }));
    expect(loadView(storage)).toEqual(DEFAULT_VIEW);
    store.set(VIEW_STORAGE_KEY, '{not json');
    expect(loadView(storage)).toEqual(DEFAULT_VIEW);
  });
  it('treats only the unsorted, unfiltered view as reorderable', () => {
    expect(isManualView(DEFAULT_VIEW)).toBe(true);
    expect(isManualView({ ...DEFAULT_VIEW, kind: 'm3u' })).toBe(false);
  });
});
