import { describe, expect, it } from 'vitest';

import {
  CATALOG_PAGE_SIZE,
  STALKER_PAGE_SIZE,
  buildPageRequest,
  defaultDir,
  pageOf,
  readGridParams,
  type GridQueryInput,
} from '../lib/paging';

const base: GridQueryInput = { sourceKind: 'xtream', kind: 'movie', sourceId: 'src1', categoryId: '12', sort: 'added', dir: 'desc' };

describe('buildPageRequest', () => {
  it('pages xtream and m3u through catalog.movies / catalog.series with the catalog page size', () => {
    expect(buildPageRequest(base, 0)).toEqual({
      cmd: 'catalog.movies',
      args: { sourceId: 'src1', categoryId: '12', query: { offset: 0, limit: CATALOG_PAGE_SIZE, sort: 'added', dir: 'desc' } },
    });
    const m3u = buildPageRequest({ ...base, sourceKind: 'm3u', kind: 'series' }, 3);
    expect(m3u.cmd).toBe('catalog.series');
    expect(m3u.args.query.offset).toBe(3 * CATALOG_PAGE_SIZE);
  });

  it('pages stalker through stalker.movies / stalker.series in whole portal pages', () => {
    const movies = buildPageRequest({ ...base, sourceKind: 'stalker' }, 2);
    expect(movies.cmd).toBe('stalker.movies');
    expect(movies.args.query).toMatchObject({ offset: 2 * STALKER_PAGE_SIZE, limit: STALKER_PAGE_SIZE });
    expect(STALKER_PAGE_SIZE % 14).toBe(0);
    expect(buildPageRequest({ ...base, sourceKind: 'stalker', kind: 'series' }, 0).cmd).toBe('stalker.series');
  });

  it('omits the category for "all" and trims search, dropping it when blank', () => {
    const all = buildPageRequest({ ...base, categoryId: 'all', search: '  dune ' }, 0);
    expect(all.args).not.toHaveProperty('categoryId');
    expect(all.args.query.search).toBe('dune');
    const blank = buildPageRequest({ ...base, search: '   ' }, 0);
    expect(blank.args.query).not.toHaveProperty('search');
  });

  it('passes sort and direction through and clamps negative pages', () => {
    const r = buildPageRequest({ ...base, sort: 'name', dir: 'asc' }, -4);
    expect(r.args.query).toMatchObject({ offset: 0, sort: 'name', dir: 'asc' });
  });
});

describe('grid params', () => {
  it('maps indices to pages', () => {
    expect(pageOf(0, 60)).toBe(0);
    expect(pageOf(59, 60)).toBe(0);
    expect(pageOf(60, 60)).toBe(1);
    expect(pageOf(-1, 42)).toBe(0);
  });

  it('reads sort, dir, and q from the URL with defaults for junk', () => {
    expect(readGridParams(new URLSearchParams(''))).toEqual({ sort: 'added', dir: 'desc', search: '' });
    expect(readGridParams(new URLSearchParams('sort=name'))).toEqual({ sort: 'name', dir: 'asc', search: '' });
    expect(readGridParams(new URLSearchParams('sort=bogus&dir=up&q=x'))).toEqual({ sort: 'added', dir: 'desc', search: 'x' });
    expect(readGridParams(new URLSearchParams('sort=rating&dir=asc'))).toEqual({ sort: 'rating', dir: 'asc', search: '' });
    expect(defaultDir('year')).toBe('desc');
  });
});
