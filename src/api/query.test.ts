import { describe, expect, it } from 'vitest';

import { invalidationPrefixes } from './query';

describe('event invalidation', () => {
  it('maps core events to query prefixes', () => {
    expect(invalidationPrefixes({ type: 'epg.changed' })).toEqual(['epg.']);
    expect(invalidationPrefixes({ type: 'sources.changed' })).toEqual(['catalog.', 'sources.', 'lists.']);
    expect(invalidationPrefixes({ type: 'downloads.update' })).toEqual(['downloads.', 'myvideos.']);
    expect(invalidationPrefixes({ type: 'settings.changed' })).toEqual(['settings.']);
    expect(invalidationPrefixes({ type: 'epg.progress' })).toEqual([]);
  });

  it('maps the Run 2 events (C10)', () => {
    expect(invalidationPrefixes({ type: 'lists.changed', payload: {} })).toEqual(['lists.']);
    expect(invalidationPrefixes({ type: 'channels.changed', payload: { sourceId: 's1' } })).toEqual([
      'catalog.',
      'channels.',
      'lists.',
      'favorites.',
      'recent.',
      'epg.search',
    ]);
    // `recordings.rules` shares the prefix.
    expect(invalidationPrefixes({ type: 'recordings.update' })).toEqual(['recordings.']);
  });

  it('only invalidates on a finished import', () => {
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'parsing' } })).toEqual([]);
    expect(invalidationPrefixes({ type: 'import.progress', payload: { phase: 'done' } })).toEqual(['catalog.', 'sources.', 'lists.']);
  });

  it('merges caller prefixes without duplicates', () => {
    expect(invalidationPrefixes({ type: 'sources.changed' }, { 'sources.changed': ['sources.', 'favorites.'] })).toEqual([
      'catalog.',
      'sources.',
      'lists.',
      'favorites.',
    ]);
  });
});
