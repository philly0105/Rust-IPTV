/**
 * Product redesign, stage 2 (movies, series, search): search opens on Top results when the answer
 * spans types, folding the same title from several sources into one card; the TMDB offer at the
 * end of a detail page while TMDB is off, gone for good once dismissed; and a downloaded episode
 * says so in its row.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Download, Episode, ItemRef, SeriesItem, Source, VodDetail, VodItem } from '@/api/types';
import { useToastStore } from '@/ui';

import { EpisodeList } from '../components/detail/EpisodeList';
import { TMDB_PROMO_KEY } from '../components/detail/TmdbPromo';
import { forgetSpots } from '../hooks/useScrollMemory';
import { groupDuplicateHits, groupSearchResults } from '../lib/search';
import { resetRecentSearchCache } from '../lib/recentSearches';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SearchPage } from '../pages/SearchPage';
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

const vod = (sourceId: string, i: number, title: string, year = 2024): VodItem => ({ ref: { sourceId, contentType: 'movie', itemId: `m${i}` }, title, titleBase: title, year, categoryId: 'c1' });
const show = (sourceId: string, i: number, title: string): SeriesItem => ({ ref: { sourceId, contentType: 'series', itemId: `s${i}` }, title, year: 2012, categoryId: 'c1' });
const channel = (sourceId: string, i: number, name: string): Channel =>
  ({ ref: { sourceId, contentType: 'live', itemId: `c${i}` }, name, number: i, categoryId: 'news', isRadio: false }) as Channel;

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  resetRecentSearchCache();
  rpcMock.calls.length = 0;
  useToastStore.setState({ toasts: [] });
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const a = makeSource('src1', 'xtream', 'Northwind');
  const b = makeSource('src2', 'm3u', 'Harbor Lights');
  h['sources.get'] = (args) => ((args as { id: string }).id === 'src2' ? b : a);
  h['sources.list'] = () => [a, b];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
  h['epg.search'] = () => [];
});
afterEach(cleanup);
afterAll(() => localStorage.clear());

describe('groupDuplicateHits', () => {
  const sources = [
    { id: 'src1', name: 'Northwind', kind: 'xtream' },
    { id: 'src2', name: 'Harbor Lights', kind: 'm3u' },
  ] as Source[];
  const hits = (movies: VodItem[]) => groupSearchResults({ result: { live: [], movies, series: [] }, sources })[0]!.hits;

  it('folds one title from two sources, keeping the first as the lead', () => {
    const folded = groupDuplicateHits(hits([vod('src1', 1, 'Glass Harbor Blues'), vod('src2', 2, 'Glass  Harbor Blues!'), vod('src1', 3, 'Other')]));
    expect(folded.map((g) => [g.hit.title, g.others.map((o) => o.sourceId)])).toEqual([
      ['Glass Harbor Blues', ['src2']],
      ['Other', []],
    ]);
  });

  it('keeps two copies in one source apart, and different years apart', () => {
    const folded = groupDuplicateHits(hits([vod('src1', 1, 'Heat', 1995), vod('src1', 2, 'Heat', 1995), vod('src2', 3, 'Heat', 1986)]));
    expect(folded).toHaveLength(3);
    expect(folded.every((g) => g.others.length === 0)).toBe(true);
  });
});

describe('Top results', () => {
  beforeEach(() => {
    rpcMock.handlers['catalog.search'] = () => ({
      live: [channel('src1', 1, 'Harbor News')],
      movies: [vod('src1', 1, 'Glass Harbor Blues'), vod('src2', 2, 'Glass Harbor Blues')],
      series: [show('src1', 1, 'Harbor Nine')],
    });
  });

  it('opens on a slice of every type, with the duplicate film as one card naming its sources', async () => {
    renderAt('/search?q=harbor', [{ path: '/search', element: <SearchPage /> }]);
    expect((await screen.findByRole('tab', { name: 'Top results' })).getAttribute('aria-selected')).toBe('true');
    const top = await screen.findByTestId('search-top');
    const films = within(top).getAllByRole('link', { name: /^Glass Harbor Blues/ });
    expect(films).toHaveLength(1);
    expect(films[0]!.getAttribute('aria-label')).toContain('2 sources');
    expect(within(top).getByRole('link', { name: /^Harbor Nine/ })).toBeTruthy();
    expect(within(top).getByRole('button', { name: /Harbor News/ })).toBeTruthy();
    // See all opens the type's own tab, as a link (new tab, the URL keeps the query).
    const seeAll = within(top).getAllByRole('link', { name: /See all/ });
    expect(seeAll[0]!.getAttribute('href')).toBe('/search?q=harbor&type=movies');
  });

  it('keeps every copy in the type tab, each with its source', async () => {
    renderAt('/search?q=harbor&type=movies', [{ path: '/search', element: <SearchPage /> }]);
    const grid = await screen.findByTestId('vod-search-movies');
    expect(within(grid).getAllByRole('link', { name: /^Glass Harbor Blues/ })).toHaveLength(2);
    expect(screen.queryByTestId('search-top')).toBeNull();
  });

  it('skips Top results when everything is one type', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [vod('src1', 1, 'Glass Harbor Blues')], series: [] });
    renderAt('/search?q=glass', [{ path: '/search', element: <SearchPage /> }]);
    expect(await screen.findByTestId('vod-search-movies')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Top results' })).toBeNull();
    expect(currentLocation).toBe('/search?q=glass');
  });
});

describe('TMDB offer on a detail page (VL-detail-empty-no-tmdb)', () => {
  const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
  const detail: VodDetail = { item: { ref: mref, title: 'Dune', categoryId: 'c1', added: '2026-10-01T00:00:00Z' }, cast: [], backdrops: [], providerDetailsUnavailable: false };
  const route = [
    { path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> },
    { path: '/settings/metadata', element: <p>metadata settings</p> },
  ];
  beforeEach(() => {
    const h = rpcMock.handlers;
    h['xtream.vodDetail'] = () => detail;
    h['favorites.contains'] = () => [];
    h['downloads.list'] = () => [];
    h['catalog.sameTitle'] = () => [];
    h['positions.get'] = () => null;
    h['catalog.categories'] = () => [];
    h['catalog.movies'] = () => ({ items: [], total: 0, offset: 0, limit: 60 });
  });

  it('offers TMDB once, at the end of the page, and stays away once dismissed', async () => {
    renderAt('/s/src1/movie/m7', route);
    const promo = await screen.findByTestId('vod-tmdb-promo');
    expect(within(promo).getByRole('link', { name: 'Turn it on in Settings' }).getAttribute('href')).toBe('/settings/metadata');
    fireEvent.click(within(promo).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('vod-tmdb-promo')).toBeNull());
    expect(localStorage.getItem(TMDB_PROMO_KEY)).toBe('1');
    cleanup();
    renderAt('/s/src1/movie/m7', route);
    await screen.findByTestId('vod-hero-actions');
    expect(screen.queryByTestId('vod-tmdb-promo')).toBeNull();
  });

  it('is not offered when TMDB is on', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ tmdb: { enabled: true, apiKey: 'k', language: 'en' } } as never);
    rpcMock.handlers['tmdb.movie'] = () => null;
    rpcMock.handlers['tmdb.find'] = () => null;
    renderAt('/s/src1/movie/m7', route);
    await screen.findByTestId('vod-hero-actions');
    expect(screen.queryByTestId('vod-tmdb-promo')).toBeNull();
  });
});

describe('a downloaded episode says so in its row (VL-offline-play, per episode)', () => {
  const ep = (n: number): Episode => ({ id: `e${n}`, seriesRef: { sourceId: 's1', contentType: 'series', itemId: 'show' }, season: 1, episode: n, title: `Episode ${n}`, durationSeconds: 2520 });
  const done: Download = {
    id: 9,
    ref: { sourceId: 's1', contentType: 'series', itemId: 'show' },
    episodeId: 'e2',
    title: 'Show',
    url: 'http://x',
    status: 'completed',
    bytesDownloaded: 1,
    totalBytes: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    fileAvailable: true,
    positionSeconds: 0,
  };

  function Harness({ onPlay }: { onPlay: (e: Episode) => void }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    return (
      <div ref={scrollRef}>
        <EpisodeList
          episodes={[ep(1), ep(2)]}
          positions={new Map()}
          downloads={new Map([['e2', done]])}
          onPlay={onPlay}
          canDownload
          pendingDownload={null}
          onDownload={() => undefined}
          scrollRef={scrollRef}
        />
      </div>
    );
  }

  it('marks the downloaded episode and names it for screen readers; the facts are one line', async () => {
    const played: string[] = [];
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <Harness onPlay={(e) => played.push(e.id)} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    const rows = await screen.findAllByTestId('episode-row');
    expect(within(rows[0]!).queryByTestId('episode-offline')).toBeNull();
    expect(within(rows[1]!).getByTestId('episode-offline').textContent).toBe('Downloaded');
    const play = within(rows[1]!).getByRole('button', { name: /^Play S01E02 Episode 2, Downloaded$/ });
    fireEvent.click(play);
    expect(played).toEqual(['e2']);
    // Code, runtime and state share one separated line (MetaLine), not a runtime pushed to the far end.
    expect(within(rows[0]!).getByText('42m').closest('p, span')!.className).not.toContain('ms-auto');
  });
});
