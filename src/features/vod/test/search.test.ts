import { describe, expect, it } from 'vitest';

import type { CatalogSearchResult } from '@/api/rpc';
import type { Source } from '@/api/types';

import { targetIndex } from '../lib/gridNav';
import {
  detailHref,
  groupSearchResults,
  narrowsQuery,
  normalizeQuery,
  previewGroups,
  previewMatches,
  searchTerms,
  sourceFacets,
  splitStalkerResults,
  type SearchGroup,
} from '../lib/search';

const src = (id: string, name: string, kind: Source['kind']) => ({ id, name, kind }) as Source;
const sources = [src('a', 'Alpha IPTV', 'xtream'), src('b', 'Beta Portal', 'stalker')];

const result: CatalogSearchResult = {
  live: [{ ref: { sourceId: 'a', contentType: 'live', itemId: 'c1' }, name: 'Dune TV', number: 101, categoryId: 'g', categoryName: 'Movies', isRadio: false }],
  movies: [
    { ref: { sourceId: 'a', contentType: 'movie', itemId: 'm1' }, title: 'Dune', year: 2021, categoryId: 'x' },
    { ref: { sourceId: 'b', contentType: 'movie', itemId: 'm9' }, title: 'Dune', year: 1984, categoryId: 'x' },
  ],
  series: [],
};

describe('groupSearchResults', () => {
  it('groups movies, series, live in display order with source names and drops empty groups', () => {
    const groups = groupSearchResults({ result, sources });
    expect(groups.map((g) => g.kind)).toEqual(['movies', 'live']);
    expect(groups[0]!.hits.map((h) => [h.title, h.meta, h.sourceName, h.href])).toEqual([
      ['Dune', '2021', 'Alpha IPTV', '/s/a/movie/m1'],
      ['Dune', '1984', 'Beta Portal', '/s/b/movie/m9'],
    ]);
    const live = groups[1]!.hits[0]!;
    expect(live.href).toBeUndefined();
    expect(live.meta).toBe('101  Movies');
    expect(live.sourceKind).toBe('xtream');
  });

  it('merges stalker portal results and de-duplicates by ref', () => {
    const groups = groupSearchResults({
      result,
      sources,
      extraMovies: [result.movies[1]!],
      extraSeries: [{ ref: { sourceId: 'b', contentType: 'series', itemId: 's1' }, title: 'Dune: Prophecy', categoryId: 'y' }],
    });
    expect(groups.map((g) => [g.kind, g.hits.length])).toEqual([
      ['movies', 2],
      ['series', 1],
      ['live', 1],
    ]);
  });

  it('filters to one source and builds facets by count', () => {
    expect(groupSearchResults({ result, sources, sourceFilter: 'b' }).flatMap((g) => g.hits.map((h) => h.sourceId))).toEqual(['b']);
    expect(sourceFacets(groupSearchResults({ result, sources }))).toEqual([
      { sourceId: 'a', sourceName: 'Alpha IPTV', count: 2, partial: false },
      { sourceId: 'b', sourceName: 'Beta Portal', count: 1, partial: false },
    ]);
  });

  it('marks only the sources that contribute to a capped type as partial (R6-r2 F3)', () => {
    // Channels hit the cap; only source a has channels.
    const facets = sourceFacets(groupSearchResults({ result, sources }), { live: true, movies: false, series: false });
    expect(facets.map((f) => [f.sourceId, f.partial])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    const all = sourceFacets(groupSearchResults({ result, sources }), { live: false, movies: true, series: false });
    expect(all.every((f) => f.partial)).toBe(true);
  });

  it('falls back to the source id when the source is unknown', () => {
    expect(groupSearchResults({ result, sources: [] })[0]!.hits[0]!.sourceName).toBe('a');
  });
});

describe('search helpers', () => {
  it('normalizes queries and enforces the minimum length', () => {
    expect(normalizeQuery('  dune   part ')).toBe('dune part');
    expect(normalizeQuery('d')).toBe('');
    expect(normalizeQuery(null)).toBe('');
  });

  it('splits stalker pages by content type and links details', () => {
    const split = splitStalkerResults([
      { ref: { sourceId: 'b', contentType: 'series', itemId: '1' }, title: 'S', categoryId: 'c' },
      { ref: { sourceId: 'b', contentType: 'movie', itemId: '2' }, title: 'M', categoryId: 'c' },
    ]);
    expect([split.movies.length, split.series.length]).toEqual([1, 1]);
    expect(detailHref({ sourceId: 'a b', contentType: 'series', itemId: '1/2' })).toBe('/s/a%20b/series/1%2F2');
  });
});

describe('grid keyboard targets', () => {
  it('moves by cell, row, page, and clamps at the ends', () => {
    expect(targetIndex('ArrowRight', 0, 5, 12)).toBe(1);
    expect(targetIndex('ArrowLeft', 0, 5, 12)).toBeNull();
    expect(targetIndex('ArrowDown', 3, 5, 12)).toBe(8);
    expect(targetIndex('ArrowDown', 9, 5, 12)).toBe(11);
    expect(targetIndex('ArrowUp', 2, 5, 12)).toBe(0);
    expect(targetIndex('PageDown', 0, 5, 40, 3)).toBe(15);
    expect(targetIndex('End', 0, 5, 12)).toBe(11);
    expect(targetIndex('Home', 4, 5, 12)).toBe(0);
    expect(targetIndex('Enter', 4, 5, 12)).toBeNull();
    expect(targetIndex('ArrowRight', 0, 5, 0)).toBeNull();
  });
});

describe('L3-vod-5: narrowing the results on screen to a longer query', () => {
  it('splits terms where the core does and folds case and accents', () => {
    expect(searchTerms('Spider-Man: Café  2')).toEqual(['spider', 'man', 'cafe', '2']);
  });

  it('narrows only when the new query extends the answered one', () => {
    expect(narrowsQuery('the', 'th')).toBe(true);
    expect(narrowsQuery('black h', 'black')).toBe(true);
    expect(narrowsQuery('Black Harbor', 'black')).toBe(true);
    expect(narrowsQuery('th', 'the')).toBe(false);
    expect(narrowsQuery('the', 'the')).toBe(false);
    expect(narrowsQuery('blue', '')).toBe(false);
    expect(narrowsQuery('bla', 'blu')).toBe(false);
  });

  it('matches like the core word-prefix search: every term starts a word', () => {
    expect(previewMatches('Black Harbor (2024)', searchTerms('black har'))).toBe(true);
    expect(previewMatches('Black Harbor', searchTerms('harbor bl'))).toBe(true);
    expect(previewMatches('Northbound', searchTerms('bound'))).toBe(false);
    expect(previewMatches('Café Society', searchTerms('cafe'))).toBe(true);
    expect(previewMatches('Anything', [])).toBe(false);
  });

  it('keeps the old results whole when nothing would be left, instead of an empty list', () => {
    const hit = (title: string) => ({ key: title, title }) as SearchGroup['hits'][number];
    const groups: SearchGroup[] = [
      { kind: 'movies', hits: [hit('The Rover'), hit('Thunder Road')] },
      { kind: 'live', hits: [hit('Thai TV')] },
    ];
    expect(previewGroups(groups, searchTerms('the'))).toEqual([{ kind: 'movies', hits: [hit('The Rover')] }]);
    expect(previewGroups(groups, searchTerms('zzz'))).toBe(groups);
  });
});
