/**
 * VOD-DETAIL-PLACEHOLDER: an Xtream movie or series opened from a grid, a rail or search shows
 * its hero from the catalog row the list already holds while the provider answers get_vod_info /
 * get_series_info.
 *
 * - Movies: the hero and an enabled Play at once; the "provider details unavailable" notice and
 *   the TMDB lookup wait for the real answer (it may bring the tmdbId, so an early lookup would be
 *   a second one).
 * - Series: the hero at once; Play and the episodes wait for the seasons.
 * - Stalker keeps waiting for its details: the parental gate needs the title's category from them.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type ItemRef, type Page, type SeriesDetail, type SeriesItem, type VodDetail, type VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { buildPageRequest } from '../lib/paging';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { i18n, installDomStubs, makeSource, played, settings, usePlayerStore } from './harness';

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

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const movieRef: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const seriesRef: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const movieRow: VodItem = { ref: movieRef, title: 'Dune: Part Two (2024)', titleBase: 'Dune: Part Two', year: 2024, rating: 8.3, categoryId: 'c1', containerExtension: 'mkv' };
const seriesRow: SeriesItem = { ref: seriesRef, title: 'Severance', year: 2022, categoryId: 'c1' };

/** A provider answer the test hands out when it wants to. */
function later<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

function handlers(kind: 'xtream' | 'stalker' = 'xtream') {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', kind, 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings({ tmdb: { ...DEFAULT_SETTINGS.tmdb, enabled: true, apiKey: 'k' } });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => [];
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['sourcePins.get'] = () => null;
  h['watchlist.list'] = () => [];
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['tmdb.movie'] = () => null;
  h['tmdb.tv'] = () => null;
  h['tmdb.similar'] = () => [];
}

let client: QueryClient;

/** The grid page that linked to the title, as the cache holds it. */
function seedGrid(kind: 'movie' | 'series', row: VodItem | SeriesItem, sourceKind: 'xtream' | 'stalker' = 'xtream') {
  const req = buildPageRequest({ sourceKind, kind, sourceId: 'src1', categoryId: 'c1', sort: 'added', dir: 'desc' }, 0);
  client.setQueryData<Page<VodItem | SeriesItem>>([req.cmd, req.args], { items: [row], total: 1, offset: 0, limit: 60 });
}

function open(path: string) {
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/s/:sourceId/movie/:itemId" element={<MovieDetailPage />} />
            <Route path="/s/:sourceId/series/:itemId" element={<SeriesDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeAll(installDomStubs);
beforeEach(() => {
  handlers();
  forgetSpots();
  localStorage.clear();
  played.length = 0;
  usePlayerStore.setState({ source: undefined, status: 'idle', mode: 'inline', positionSeconds: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe('VOD-DETAIL-PLACEHOLDER: movies', () => {
  it('shows the hero and an enabled Play from the grid row before an 800 ms provider answers', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () =>
      new Promise<VodDetail>((r) => setTimeout(() => r({ item: { ...movieRow, plot: 'Paul unites with the Fremen.' }, cast: [], backdrops: [], providerDetailsUnavailable: false }), 800));
    seedGrid('movie', movieRow);
    const t0 = performance.now();
    open('/s/src1/movie/m7');
    await screen.findByRole('heading', { level: 1, name: 'Dune: Part Two' }, { timeout: 3000 });
    const play = await screen.findByRole('button', { name: i18n.t('vod:play') }, { timeout: 3000 });
    const shown = performance.now() - t0;
    console.info(`[VOD-DETAIL-PLACEHOLDER] movie: hero and Play after ${Math.round(shown)} ms (provider answers after 800 ms)`);
    expect((play as HTMLButtonElement).disabled).toBe(false);
    expect(shown).toBeLessThan(600);
    expect(screen.queryByText('Paul unites with the Fremen.')).toBeNull();
    expect(await screen.findByText('Paul unites with the Fremen.', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('plays from the placeholder, and holds the notice and TMDB until the provider answers', async () => {
    const detail = later<VodDetail>();
    rpcMock.handlers['xtream.vodDetail'] = () => detail.promise;
    seedGrid('movie', movieRow);
    open('/s/src1/movie/m7');
    const play = await screen.findByRole('button', { name: i18n.t('vod:play') });
    // The answer may bring a trailer: its place in the action row is held.
    expect(screen.getByTestId('vod-trailer-slot')).toBeTruthy();
    expect(screen.queryByText(i18n.t('vod:providerDetailsUnavailable'))).toBeNull();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(callsOf('tmdb.movie')).toEqual([]);
    fireEvent.click(play);
    await waitFor(() => expect(played).toHaveLength(1));
    expect(played[0]).toMatchObject({ ref: movieRef });
    // Closing the player brings the hero back.
    act(() => usePlayerStore.getState().stop());
    await screen.findByRole('button', { name: i18n.t('vod:play') });

    await act(async () => detail.resolve({ item: { ...movieRow, tmdbId: 693134 }, cast: [], backdrops: [], providerDetailsUnavailable: true }));
    expect(await screen.findByText(i18n.t('vod:providerDetailsUnavailable'))).toBeTruthy();
    // One lookup, with the provider's tmdbId.
    await waitFor(() => expect(callsOf('tmdb.movie')).toHaveLength(1));
    expect(callsOf('tmdb.movie')[0]!.args).toEqual({ title: 'Dune: Part Two', year: 2024, tmdbId: 693134 });
  });

  it('finds the row in Recently added and in search answers too', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => new Promise(() => undefined);
    client.setQueryData(['catalog.recentlyAdded', { sourceId: 'src1', contentType: 'movie', limit: 24 }], [movieRow]);
    open('/s/src1/movie/m7');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dune: Part Two' })).toBeTruthy();
    cleanup();
    client.clear();
    client.setQueryData(['catalog.search', { query: 'dune', limit: 60 }], { live: [], movies: [movieRow], series: [] });
    open('/s/src1/movie/m7');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dune: Part Two' })).toBeTruthy();
  });

  it('still shows the skeleton for a title no list holds', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => new Promise(() => undefined);
    open('/s/src1/movie/m7');
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Dune: Part Two' })).toBeNull();
  });
});

describe('VOD-DETAIL-PLACEHOLDER: series', () => {
  it('paints the hero at once; Play and the episodes wait for the seasons', async () => {
    const detail = later<SeriesDetail>();
    rpcMock.handlers['xtream.seriesDetail'] = () => detail.promise;
    seedGrid('series', seriesRow);
    open('/s/src1/series/s1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Severance' })).toBeTruthy();
    expect((screen.getByRole('button', { name: i18n.t('vod:play') }) as HTMLButtonElement).disabled).toBe(true);
    const episodes = screen.getByRole('region', { name: i18n.t('vod:episodes') });
    expect(within(episodes).getByRole('status')).toBeTruthy();
    expect(screen.queryByText(i18n.t('vod:noEpisodesTitle'))).toBeNull();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(callsOf('tmdb.tv')).toEqual([]);

    const ep = { id: 'e11', seriesRef, season: 1, episode: 1, title: 'Good News About Hell' };
    await act(async () => detail.resolve({ item: seriesRow, seasons: [{ number: 1, episodes: [ep] }], cast: [], backdrops: [], providerDetailsUnavailable: false }));
    const play = await screen.findByRole('button', { name: i18n.t('vod:playEpisode', { code: 'S01E01' }) });
    expect((play as HTMLButtonElement).disabled).toBe(false);
    expect(within(episodes).queryByRole('status')).toBeNull();
    await waitFor(() => expect(callsOf('tmdb.tv')).toHaveLength(1));
  });
});

describe('VOD-DETAIL-PLACEHOLDER: Stalker', () => {
  it('keeps the parental gate waiting for the details, cached row or not', async () => {
    handlers('stalker');
    rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpcMock.handlers['parental.check'] = () => [];
    rpcMock.handlers['stalker.vodDetail'] = () => new Promise(() => undefined);
    seedGrid('movie', movieRow, 'stalker');
    seedGrid('movie', movieRow);
    open('/s/src1/movie/m7');
    expect(await screen.findByRole('status')).toBeTruthy();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole('heading', { level: 1, name: 'Dune: Part Two' })).toBeNull();
    expect(callsOf('parental.check')).toEqual([]);
  });
});
