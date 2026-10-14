import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient as appQueryClient } from '@/api/query';
import type { ItemRef, Page, PageQuery, SeriesDetail, VodItem } from '@/api/types';

import { PosterCard, posterCardLabel } from '../components/PosterCard';
import { fadeMask, hiddenEdges, wheelShift } from '../hooks/useEdgeFades';
import { forgetSpots } from '../hooks/useScrollMemory';
import { buildPageRequest, readGridParams, type GridQueryInput } from '../lib/paging';
import { COMPLETE_RATIO, finishesTitle, invalidateWatched } from '../lib/watchedQueries';
import {
  STALKER_DECADES,
  decadeChips,
  decadeRange,
  decadesFromFacets,
  filterByYear,
  rangeDecade,
  readYearRange,
  writeYearRange,
  yearOptions,
} from '../lib/years';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { currentLocation, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
const gridRoute = [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }];

/** 40 movies, years 1985..2024 (one per year); every fifth has no year. */
const TOTAL = 40;
const film = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` },
  title: `Film ${i}`,
  categoryId: 'c1',
  ...(i % 5 === 4 ? {} : { year: 1985 + i }),
});
const ALL = Array.from({ length: TOTAL }, (_, i) => film(i));
let watchedIds = new Set<string>();

function handlers(kind: 'xtream' | 'stalker' = 'xtream', patch: Parameters<typeof settings>[0] = {}) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', kind, 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['settings.get'] = () => settings(patch);
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['watchlist.list'] = () => [];
  // Like the core, hideWatched counts only the titles the grid keeps.
  h['catalog.yearFacets'] = (a) => {
    const { hideWatched } = a as { hideWatched?: boolean };
    const counts = new Map<number, number>();
    for (const f of ALL) if (f.year && !(hideWatched && watchedIds.has(f.ref.itemId))) counts.set(f.year, (counts.get(f.year) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([year, count]) => ({ year, count }));
  };
  // Mirrors the core: year bounds and hideWatched filter in SQLite and `total` counts the filtered set.
  h['catalog.movies'] = (a) => {
    const { query: q, yearFrom, yearTo, hideWatched } = a as { query: PageQuery; yearFrom?: number; yearTo?: number; hideWatched?: boolean };
    const all = ALL.filter((f) => {
      if ((yearFrom !== undefined || yearTo !== undefined) && f.year === undefined) return false;
      if (yearFrom !== undefined && f.year! < yearFrom) return false;
      if (yearTo !== undefined && f.year! > yearTo) return false;
      return !(hideWatched && watchedIds.has(f.ref.itemId));
    });
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
  // The portal ignores every filter.
  h['stalker.movies'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    return { items: ALL.slice(q.offset, q.offset + q.limit), total: ALL.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
  h['positions.watchedContains'] = (a) => (a as { refs: ItemRef[] }).refs.filter((r) => watchedIds.has(r.itemId));
  h['settings.update'] = (a) => settings({ ...patch, ...(a as { patch: object }).patch });
}

beforeAll(installDomStubs);
beforeEach(() => {
  watchedIds = new Set();
  handlers();
  forgetSpots();
  localStorage.clear();
});
afterEach(() => cleanup());

describe('year range in the URL (yf / yt)', () => {
  it('readGridParams reads valid years, swaps a reversed pair and drops junk', () => {
    expect(readGridParams(new URLSearchParams('yf=1990&yt=1999'))).toMatchObject({ yearFrom: 1990, yearTo: 1999 });
    expect(readGridParams(new URLSearchParams('yf=2005&yt=1995'))).toMatchObject({ yearFrom: 1995, yearTo: 2005 });
    expect(readGridParams(new URLSearchParams('yf=1990'))).toMatchObject({ yearFrom: 1990 });
    expect(readGridParams(new URLSearchParams('yf=1990')).yearTo).toBeUndefined();
    for (const junk of ['yf=abc', 'yf=1899', 'yt=2101', 'yf=19900', 'yf=-1990', 'yf=1990.5', 'yf=']) {
      const p = readGridParams(new URLSearchParams(junk));
      expect(p.yearFrom, junk).toBeUndefined();
      expect(p.yearTo, junk).toBeUndefined();
    }
    // Without years the result is unchanged from Run 1.
    expect(readGridParams(new URLSearchParams('sort=name'))).toEqual({ sort: 'name', dir: 'asc', search: '' });
  });

  it('writeYearRange sets and clears both params and keeps the rest', () => {
    const next = writeYearRange(new URLSearchParams('sort=name&q=x'), { from: 1980, to: 1989 });
    expect(next.toString()).toBe('sort=name&q=x&yf=1980&yt=1989');
    expect(readYearRange(next)).toEqual({ from: 1980, to: 1989 });
    expect(writeYearRange(next, {}).toString()).toBe('sort=name&q=x');
    expect(writeYearRange(next, { to: 1970 }).toString()).toBe('sort=name&q=x&yt=1970');
  });

  it('buildPageRequest sends year bounds and hideWatched to the core only', () => {
    const input: GridQueryInput = { sourceKind: 'xtream', kind: 'movie', sourceId: 's', sort: 'added', dir: 'desc', yearFrom: 1990, yearTo: 1999, hideWatched: true };
    expect(buildPageRequest(input, 0).args).toMatchObject({ yearFrom: 1990, yearTo: 1999, hideWatched: true });
    const plain = buildPageRequest({ ...input, yearFrom: undefined, yearTo: undefined, hideWatched: false }, 0).args;
    expect('yearFrom' in plain || 'yearTo' in plain || 'hideWatched' in plain).toBe(false);
    const stalker = buildPageRequest({ ...input, sourceKind: 'stalker' }, 0);
    expect(stalker.cmd).toBe('stalker.movies');
    expect('yearFrom' in stalker.args || 'yearTo' in stalker.args || 'hideWatched' in stalker.args).toBe(false);
  });
});

describe('decade chips', () => {
  it('decadesFromFacets sums years per decade, newest first, and skips junk years', () => {
    const chips = decadesFromFacets([
      { year: 2024, count: 3 },
      { year: 2021, count: 2 },
      { year: 1999, count: 4 },
      { year: 1990, count: 1 },
      { year: 1875, count: 9 },
      { year: 1985, count: 0 },
    ]);
    expect(chips).toEqual([
      { decade: 2020, count: 5 },
      { decade: 1990, count: 5 },
    ]);
  });

  it('Stalker gets the fixed 2020s..1950s chips; other sources only the decades they have', () => {
    expect(decadeChips(true, undefined).map((c) => c.decade)).toEqual([2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950]);
    expect(decadeChips(true, [{ year: 1931, count: 1 }]).map((c) => c.decade)).toEqual([...STALKER_DECADES]);
    expect(decadeChips(false, [{ year: 1931, count: 2 }])).toEqual([{ decade: 1930, count: 2 }]);
    expect(decadeChips(false, [])).toEqual([]);
    expect(rangeDecade({ from: 1990, to: 1999 })).toBe(1990);
    expect(rangeDecade({ from: 1991, to: 1999 })).toBeUndefined();
    expect(yearOptions(true, undefined, new Date('2026-10-14T00:00:00Z'))[0]).toBe(2026);
    expect(yearOptions(true, undefined, new Date('2026-10-14T00:00:00Z')).at(-1)).toBe(1950);
  });

  it('shows facet decades with counts; a chip filters in the core and writes yf/yt', async () => {
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Film 0');
    const group = await screen.findByRole('group', { name: 'Year' });
    // 1985..2024 minus the yearless fifth: 1980s (1985-1988 kept: 4), 1990s 8, 2000s 8, 2010s 8, 2020s 4.
    await waitFor(() => expect(within(group).getByRole('button', { name: '1990s, 8 titles' })).toBeTruthy());
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All years', '2020s', '2010s', '2000s', '1990s', '1980s']);
    expect(callsOf('catalog.yearFacets')[0]!.args).toEqual({ sourceId: 'src1', contentType: 'movie' });
    expect(within(group).getByRole('button', { name: 'All years' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(group).getByRole('button', { name: '1990s, 8 titles' }));
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies/c/all?yf=1990&yt=1999'));
    await screen.findByText('Film 5');
    expect(screen.queryByText('Film 0')).toBeNull();
    expect(callsOf('catalog.movies').at(-1)!.args).toMatchObject({ yearFrom: 1990, yearTo: 1999 });
    expect(within(screen.getByTestId('vod-grid-movie')).getByText('8')).toBeTruthy();
    expect(within(group).getByRole('button', { name: '1990s, 8 titles' }).getAttribute('aria-pressed')).toBe('true');
    expect((within(screen.getByRole('group', { name: 'Year range' })).getByRole('combobox', { name: 'From' }) as HTMLSelectElement).value).toBe('1990');

    // The active chip toggles the filter off.
    fireEvent.click(within(group).getByRole('button', { name: '1990s, 8 titles' }));
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies/c/all'));
  });

  it('the From/To selects set an exact range and a reversed pick is swapped', async () => {
    renderAt('/s/src1/movies/c/all?yf=2000', gridRoute);
    const group = await screen.findByRole('group', { name: 'Year range' });
    await waitFor(() => expect((within(group).getByRole('combobox', { name: 'From' }) as HTMLSelectElement).value).toBe('2000'));
    fireEvent.change(within(group).getByRole('combobox', { name: 'To' }), { target: { value: '1995' } });
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies/c/all?yf=1995&yt=2000'));
    expect(callsOf('catalog.movies').at(-1)!.args).toMatchObject({ yearFrom: 1995, yearTo: 2000 });
  });

  it('shows the year empty state and clears the range from it', async () => {
    renderAt('/s/src1/movies/c/all?yf=1900&yt=1909', gridRoute);
    await screen.findByText('No titles from these years');
    fireEvent.click(within(screen.getByTestId('vod-grid-movie')).getAllByRole('button', { name: 'All years' }).at(-1)!);
    await screen.findByText('Film 0');
    expect(currentLocation).toBe('/s/src1/movies/c/all');
  });

  it('falls back to fixed decades without counts when the facets fail', async () => {
    rpcMock.handlers['catalog.yearFacets'] = () => {
      throw new Error('boom');
    };
    renderAt('/s/src1/movies/c/all', gridRoute);
    const group = await screen.findByRole('group', { name: 'Year' });
    await waitFor(() => expect(within(group).getByRole('button', { name: '1950s' })).toBeTruthy());
  });
});

describe('Stalker client filter', () => {
  it('filterByYear keeps titles inside the range and drops those without a year', () => {
    expect(filterByYear(ALL, { from: 1990, to: 1994 }).map((f) => f.year)).toEqual([1990, 1991, 1992, 1993]);
    expect(filterByYear(ALL, { to: 1987 }).map((f) => f.year)).toEqual([1985, 1986, 1987]);
    expect(filterByYear(ALL, {})).toHaveLength(TOTAL);
  });

  it('filters loaded portal pages by year with fixed chips, never sending year bounds', async () => {
    handlers('stalker');
    renderAt('/s/src1/movies/c/all?yf=1990&yt=1999', gridRoute);
    await screen.findByText('Film 5');
    expect(screen.queryByText('Film 0')).toBeNull();
    expect(screen.queryByText('Film 9')).toBeNull(); // no year
    await waitFor(() => expect(within(screen.getByTestId('vod-grid-movie')).getByText('8')).toBeTruthy());
    const group = screen.getByRole('group', { name: 'Year' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All years', ...STALKER_DECADES.map((d) => `${d}s`)]);
    expect(callsOf('catalog.yearFacets')).toHaveLength(0);
    expect(callsOf('stalker.movies').every((c) => !('yearFrom' in (c.args as object)) && !('yearTo' in (c.args as object)))).toBe(true);
  });

  it('hides watched titles on loaded pages once the lookup answers', async () => {
    watchedIds = new Set(['f1', 'f2']);
    handlers('stalker', { vodHideWatched: true });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Film 0');
    expect(screen.queryByText('Film 1')).toBeNull();
    expect(screen.queryByText('Film 2')).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId('vod-grid-movie')).getByText(String(TOTAL - 2))).toBeTruthy());
    expect(callsOf('stalker.movies').every((c) => !('hideWatched' in (c.args as object)))).toBe(true);
  });
});

describe('watched tick and Hide watched', () => {
  it('PosterCard draws the tick and says "Watched" in its name', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <PosterCard title="Black Harbor" href="/x" year={2026} rating={8.2} watched />
          <PosterCard title="Quiet Shore" href="/y" year={2025} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    const watched = screen.getByRole('link', { name: 'Black Harbor (2026), rated 8.2 of 10, Watched' });
    expect(watched.querySelector('[data-testid="poster-watched"]')).toBeTruthy();
    const plain = screen.getByRole('link', { name: 'Quiet Shore (2025)' });
    expect(plain.querySelector('[data-testid="poster-watched"]')).toBeNull();
    expect(
      posterCardLabel({ title: 'A', watchedLabel: 'Watched', progressLabel: '40% watched', ratedLabel: (r) => r }),
    ).toBe('A, Watched, 40% watched');
  });

  it('asks positions.watchedContains once per loaded page and ticks the watched posters', async () => {
    watchedIds = new Set(['f3']);
    renderAt('/s/src1/movies/c/all', gridRoute);
    await waitFor(() => expect(screen.getByRole('group', { name: /^Film 3 \(1988\), Watched$/ })).toBeTruthy());
    expect(screen.getByRole('group', { name: /^Film 2 \(1987\)$/ })).toBeTruthy();
    const lookups = callsOf('positions.watchedContains');
    expect(lookups).toHaveLength(1);
    expect((lookups[0]!.args as { refs: ItemRef[] }).refs.map((r) => r.itemId)).toEqual(ALL.map((f) => f.ref.itemId));
  });

  it('the Hide watched switch writes the setting and the core filters', async () => {
    watchedIds = new Set(['f0']);
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Film 0');
    const toggle = screen.getByRole('switch', { name: 'Hide watched' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(callsOf('settings.update')).toHaveLength(1));
    expect(callsOf('settings.update')[0]!.args).toEqual({ patch: { vodHideWatched: true } });
    await waitFor(() => expect(callsOf('catalog.movies').at(-1)!.args).toMatchObject({ hideWatched: true }));
    await waitFor(() => expect(screen.queryByText('Film 0')).toBeNull());
    expect(screen.getByText('Film 1')).toBeTruthy();
  });

  it('says so when everything is watched and offers to show them', async () => {
    watchedIds = new Set(ALL.map((f) => f.ref.itemId));
    handlers('xtream', { vodHideWatched: true });
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('You have watched everything here');
    fireEvent.click(screen.getByRole('button', { name: 'Show watched' }));
    await waitFor(() => expect(callsOf('settings.update')[0]!.args).toEqual({ patch: { vodHideWatched: false } }));
  });

  it('W toggles watched on the title under the cursor; Shift+W toggles Hide watched', async () => {
    watchedIds = new Set(['f1']);
    rpcMock.handlers['positions.get'] = () => null;
    rpcMock.handlers['userstate.setWatched'] = (a) => {
      const { ref, watched } = a as { ref: ItemRef; watched: boolean };
      if (watched) watchedIds.add(ref.itemId);
      else watchedIds.delete(ref.itemId);
      return null;
    };
    renderAt('/s/src1/movies/c/all', gridRoute);
    await screen.findByText('Film 0');
    const grid = screen.getByTestId('vod-grid');
    grid.focus();
    // The first arrow puts the cursor on the first poster.
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'w' });
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(1));
    expect(callsOf('userstate.setWatched')[0]!.args).toEqual({ ref: film(0).ref, watched: true });
    await waitFor(() => expect(screen.getByRole('group', { name: /^Film 0 \(1985\), Watched$/ })).toBeTruthy());

    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'w' });
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(2));
    expect(callsOf('userstate.setWatched')[1]!.args).toEqual({ ref: film(1).ref, watched: false });

    fireEvent.keyDown(grid, { key: 'W', shiftKey: true });
    await waitFor(() => expect(callsOf('settings.update')[0]!.args).toEqual({ patch: { vodHideWatched: true } }));
  });
});

describe('Mark series watched', () => {
  it('marks the series as a whole (no episode id) and reflects the item-level row', async () => {
    const sref = { sourceId: 'src1', contentType: 'series' as const, itemId: 's1' };
    let seriesRow = false;
    rpcMock.handlers['xtream.seriesDetail'] = (): SeriesDetail => ({
      item: { ref: sref, title: 'Severance', categoryId: 'c1' },
      seasons: [{ number: 1, episodes: [{ id: 'e11', seriesRef: sref, season: 1, episode: 1, title: 'Good News' }] }],
      cast: [],
      providerDetailsUnavailable: false,
      backdrops: [],
    });
    rpcMock.handlers['positions.forSeries'] = () =>
      seriesRow ? [{ ref: sref, positionSeconds: 0, updatedAt: '2026-10-10T00:00:00Z', watched: true }] : [];
    rpcMock.handlers['positions.get'] = () => null;
    rpcMock.handlers['favorites.contains'] = () => [];
    rpcMock.handlers['downloads.list'] = () => [];
    rpcMock.handlers['tmdb.tv'] = () => null;
    rpcMock.handlers['userstate.setWatched'] = (a) => {
      seriesRow = (a as { watched: boolean }).watched;
      return null;
    };
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark series watched' }));
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(1));
    expect(callsOf('userstate.setWatched')[0]!.args).toEqual({ ref: sref, watched: true });
    await screen.findByRole('button', { name: 'Mark series unwatched' });
  });
});

describe('review fixes (Run 2 R1)', () => {
  it('the 2100s chip stops at 2100, so it reads back as pressed and a second click clears it', async () => {
    expect(decadeRange(2100)).toEqual({ from: 2100, to: 2100 });
    expect(decadeRange(1990)).toEqual({ from: 1990, to: 1999 });
    expect(rangeDecade({ from: 2100, to: 2100 })).toBe(2100);
    expect(rangeDecade({ from: 2090, to: 2099 })).toBe(2090);
    expect(rangeDecade({ from: 2100 })).toBeUndefined();
    // The URL round trip a chip click makes.
    expect(rangeDecade(readYearRange(writeYearRange(new URLSearchParams(), decadeRange(2100))))).toBe(2100);

    rpcMock.handlers['catalog.yearFacets'] = () => [
      { year: 2100, count: 1 },
      { year: 1999, count: 2 },
    ];
    renderAt('/s/src1/movies/c/all', gridRoute);
    const group = await screen.findByRole('group', { name: 'Year' });
    fireEvent.click(await within(group).findByRole('button', { name: '2100s, 1 title' }));
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies/c/all?yf=2100&yt=2100'));
    await waitFor(() => expect(within(group).getByRole('button', { name: '2100s, 1 title' }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(within(group).getByRole('button', { name: '2100s, 1 title' }));
    await waitFor(() => expect(currentLocation).toBe('/s/src1/movies/c/all'));
  });

  it('with Hide watched on, the facets are asked with hideWatched and the counts and meters match the grid', async () => {
    // f5 and f6 are 1990 and 1991: the 1990s hold 8 titles, 6 of them unwatched.
    watchedIds = new Set(['f5', 'f6']);
    handlers('xtream', { vodHideWatched: true });
    renderAt('/s/src1/movies/c/all', gridRoute);
    const group = await screen.findByRole('group', { name: 'Year' });
    await waitFor(() => expect(within(group).getByRole('button', { name: '1990s, 6 titles' })).toBeTruthy());
    expect(callsOf('catalog.yearFacets').at(-1)!.args).toEqual({ sourceId: 'src1', contentType: 'movie', hideWatched: true });
    expect(within(group).getByRole('button', { name: '2000s, 8 titles' })).toBeTruthy();
    expect(within(group).getAllByTestId('decade-meter')).toHaveLength(5);
  });

  it('flipping Hide watched asks the facets again and the counts follow', async () => {
    watchedIds = new Set(['f5', 'f6']);
    renderAt('/s/src1/movies/c/all', gridRoute);
    const group = await screen.findByRole('group', { name: 'Year' });
    await waitFor(() => expect(within(group).getByRole('button', { name: '1990s, 8 titles' })).toBeTruthy());
    expect(callsOf('catalog.yearFacets').every((c) => !('hideWatched' in (c.args as object)))).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: 'Hide watched' }));
    await waitFor(() => expect(within(group).getByRole('button', { name: '1990s, 6 titles' })).toBeTruthy());
    expect(callsOf('catalog.yearFacets').at(-1)!.args).toEqual({ sourceId: 'src1', contentType: 'movie', hideWatched: true });
    expect(within(group).getAllByTestId('decade-meter')).toHaveLength(5);
  });

  it('only the chips scroll: From/To and Hide watched sit outside the chip row', async () => {
    renderAt('/s/src1/movies/c/all', gridRoute);
    const chipRow = await screen.findByRole('group', { name: 'Year' });
    await waitFor(() => expect(within(chipRow).getByRole('button', { name: '1990s, 8 titles' })).toBeTruthy());
    expect(chipRow.className).toContain('overflow-x-auto');
    expect(within(chipRow).queryByRole('combobox')).toBeNull();
    const range = screen.getByRole('group', { name: 'Year range' });
    expect(chipRow.contains(range)).toBe(false);
    expect(within(range).getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual(['From', 'To']);
    expect(chipRow.contains(screen.getByRole('switch', { name: 'Hide watched' }))).toBe(false);
  });

  describe('chip row edge fades', () => {
    const box = (scrollLeft: number, rtl = false) => ({ scrollLeft, scrollWidth: 900, clientWidth: 300, rtl });
    const fits = { scrollLeft: 0, scrollWidth: 300, clientWidth: 300, rtl: false };
    const wheel = (deltaY: number, extra: Partial<{ deltaX: number; deltaMode: number; ctrlKey: boolean }> = {}) => ({
      deltaX: 0,
      deltaY,
      deltaMode: 0,
      ctrlKey: false,
      ...extra,
    });

    it('fades the edges that hide chips, in LTR and RTL', () => {
      expect(hiddenEdges(fits)).toEqual({ left: false, right: false });
      expect(hiddenEdges(box(0))).toEqual({ left: false, right: true });
      expect(hiddenEdges(box(300))).toEqual({ left: true, right: true });
      expect(hiddenEdges(box(600))).toEqual({ left: true, right: false });
      expect(hiddenEdges(box(599.5))).toEqual({ left: true, right: false });
      // RTL rows start at the right: scrollLeft 0, going negative toward the end.
      expect(hiddenEdges(box(0, true))).toEqual({ left: true, right: false });
      expect(hiddenEdges(box(-600, true))).toEqual({ left: false, right: true });
      expect(fadeMask({ left: false, right: false })).toBeUndefined();
      expect(fadeMask({ left: false, right: true })).toBe('linear-gradient(to right, #000 0, #000 calc(100% - 2rem), transparent 100%)');
      expect(fadeMask({ left: true, right: true })).toBe(
        'linear-gradient(to right, transparent 0, #000 2rem, #000 calc(100% - 2rem), transparent 100%)',
      );
    });

    it('a vertical wheel moves the row toward its end and leaves the page alone at the ends', () => {
      expect(wheelShift(box(0), wheel(100))).toBe(100);
      expect(wheelShift(box(0), wheel(-100))).toBe(0);
      expect(wheelShift(box(600), wheel(100))).toBe(0);
      expect(wheelShift(box(300), wheel(3, { deltaMode: 1 }))).toBe(48);
      expect(wheelShift(box(300), wheel(100, { ctrlKey: true }))).toBe(0);
      expect(wheelShift(box(300), wheel(10, { deltaX: 80 }))).toBe(0);
      expect(wheelShift(fits, wheel(100))).toBe(0);
      // RTL: down moves left, toward the end, which is a negative scrollLeft step.
      expect(wheelShift(box(0, true), wheel(100))).toBe(-100);
      expect(wheelShift(box(-600, true), wheel(100))).toBe(0);
    });
  });

  describe('watched refresh after a finishing save', () => {
    it('finishesTitle follows the core ratio', () => {
      expect(COMPLETE_RATIO).toBe(0.95);
      expect(finishesTitle(95, 100)).toBe(true);
      expect(finishesTitle(94, 100)).toBe(false);
      expect(finishesTitle(10, undefined)).toBe(false);
      expect(finishesTitle(10, 0)).toBe(false);
    });

    it('invalidateWatched marks ticks, user state, My List and Hide watched pages and facets stale, nothing else', async () => {
      const qc = new QueryClient();
      const keys: unknown[][] = [
        ['positions.watchedContains', { refs: [] }],
        ['positions.continueWatching', null],
        ['userstate.positions', null],
        ['watchlist.list', {}],
        ['catalog.movies', { sourceId: 's', hideWatched: true }],
        ['catalog.series', { sourceId: 's', hideWatched: true }],
        ['catalog.movies', { sourceId: 's' }],
        ['catalog.yearFacets', { sourceId: 's' }],
        ['catalog.yearFacets', { sourceId: 's', contentType: 'movie', hideWatched: true }],
        ['favorites.list', null],
      ];
      for (const k of keys) qc.setQueryData(k, 1);
      await invalidateWatched(qc);
      expect(keys.map((k) => qc.getQueryState(k)!.isInvalidated)).toEqual([true, true, true, true, true, true, false, false, true, false]);
    });

    it('without a client it reaches the app client, the one the player store can use', async () => {
      const key = ['positions.watchedContains', { refs: [film(0).ref] }];
      appQueryClient.setQueryData(key, []);
      await invalidateWatched();
      expect(appQueryClient.getQueryState(key)!.isInvalidated).toBe(true);
      appQueryClient.removeQueries({ queryKey: key });
    });
  });
});
