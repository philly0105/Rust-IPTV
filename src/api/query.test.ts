import { describe, expect, it } from 'vitest';

import { invalidationPrefixes } from './query';

describe('event invalidation', () => {
  it('maps core events to query prefixes', () => {
    expect(invalidationPrefixes({ type: 'epg.changed' })).toEqual(['epg.']);
    expect(invalidationPrefixes({ type: 'sources.changed' })).toEqual(['catalog.', 'sources.']);
    expect(invalidationPrefixes({ type: 'downloads.update' })).toEqual(['downloads.', 'myvideos.']);
    expect(invalidationPrefixes({ type: 'settings.changed' })).toEqual(['settings.']);
    expect(invalidationPrefixes({ type: 'epg.progress' })).toEqual([]);
  });

  it('only invalidates on a finished import', () => {
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'parsing' } })).toEqual([]);
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'done' } })).toEqual(['catalog.', 'sources.']);
  });

  it('merges caller prefixes without duplicates', () => {
    expect(invalidationPrefixes({ type: 'sources.changed' }, { 'sources.changed': ['sources.', 'favorites.'] })).toEqual([
      'catalog.',
      'sources.',
      'favorites.',
    ]);
  });
});
