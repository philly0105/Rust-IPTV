// Loop 1 VOD fixes: series and episode watched marks stay in step (L1-vod-1), one named watched
// toast per series (L1-vod-14), a fresh visit opens the Resume season (L1-vod-11), a Back control
// for the detail page, in the shell header (L1-vod-2), and a designed state for a removed source (L1-vod-13).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, PlaybackPosition, SeriesDetail, VodDetail } from '@/api/types';
import { useShellStore } from '@/shell';
import { BackButton, useToastStore } from '@/ui';

import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { VodLandingPage } from '../pages/VodLandingPage';
import { forgetSpots, rememberSeason } from '../hooks/useScrollMemory';
import { seriesWatchedWrite } from '../lib/seriesWatched';
import { currentLocation, i18n, installDomStubs, makeSource, openHeroMenu, renderAt, settings } from './harness';

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

const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const sref: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const ep = (id: string, season: number, episode: number) => ({ id, seriesRef: sref, season, episode, title: `Episode ${season}.${episode}` });
const seriesDetail: SeriesDetail = {
  item: { ref: sref, title: 'Severance', categoryId: 'c1' },
  seasons: [
    { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
    { number: 2, episodes: [ep('e21', 2, 1)] },
  ],
  cast: [],
  backdrops: [],
  providerDetailsUnavailable: false,
};
const movieDetail: VodDetail = { item: { ref: mref, title: 'Dune: Part Two', categoryId: 'c1' }, cast: [], backdrops: [], providerDetailsUnavailable: false };
const pos = (episodeId: string | undefined, watched: boolean): PlaybackPosition => ({
  ref: sref,
  ...(episodeId ? { episodeId } : {}),
  positionSeconds: watched ? 3000 : 0,
  durationSeconds: 3000,
  updatedAt: '2026-10-10T00:00:00Z',
  watched,
});

const seriesRoute = [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }];
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['xtream.vodDetail'] = () => movieDetail;
  h['xtream.seriesDetail'] = () => seriesDetail;
  h['userstate.setWatched'] = () => null;
  useToastStore.setState({ toasts: [] });
  localStorage.clear();
});
afterEach(() => cleanup());

describe('seriesWatchedWrite (L1-vod-1)', () => {
  const all = ['e11', 'e12', 'e21'];
  it('marking the series marks every unwatched episode; unmarking clears the watched ones', () => {
    expect(seriesWatchedWrite(all, [pos('e11', true)], { watched: true })).toEqual({ watched: true, episodeIds: ['e12', 'e21'], series: true });
    expect(seriesWatchedWrite(all, [pos(undefined, true), pos('e11', true), pos('e12', true)], { watched: false })).toEqual({
      watched: false,
      episodeIds: ['e11', 'e12'],
      series: true,
    });
  });
  it('the last unwatched episode also marks the series; unmarking one clears the series mark', () => {
    expect(seriesWatchedWrite(all, [pos('e11', true), pos('e12', true)], { episodeIds: ['e21'], watched: true }).series).toBe(true);
    expect(seriesWatchedWrite(all, [pos('e11', true)], { episodeIds: ['e21'], watched: true }).series).toBe(false);
    expect(seriesWatchedWrite(all, [pos(undefined, true), pos('e11', true)], { episodeIds: ['e11'], watched: false }).series).toBe(true);
    expect(seriesWatchedWrite(all, [pos('e11', true)], { episodeIds: ['e11'], watched: false }).series).toBe(false);
  });
});

describe('SeriesDetailPage watched marks (L1-vod-1, L1-vod-14)', () => {
  it('Mark series watched also marks every episode, and names the series in one toast', async () => {
    rpcMock.handlers['positions.forSeries'] = () => [pos('e11', true)];
    renderAt('/s/src1/series/s1', seriesRoute);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark series watched' }));
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(3));
    expect(callsOf('userstate.setWatched')).toEqual([
      { ref: sref, episodeId: 'e12', watched: true },
      { ref: sref, episodeId: 'e21', watched: true },
      { ref: sref, watched: true },
    ]);
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Severance marked watched']));
  });

  it('marking seasons one after another keeps one toast, naming the season', async () => {
    renderAt('/s/src1/series/s1', seriesRoute);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark season watched' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: /Season 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark season watched' }));
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Season 2 marked watched']));
  });

  it('unmarking an episode of a watched series clears the series mark', async () => {
    rpcMock.handlers['positions.forSeries'] = () => [pos(undefined, true), pos('e11', true), pos('e12', true), pos('e21', true)];
    renderAt('/s/src1/series/s1', seriesRoute);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for S01E01' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark S01E01 as unwatched' }));
    await waitFor(() => expect(callsOf('userstate.setWatched')).toHaveLength(2));
    expect(callsOf('userstate.setWatched')).toEqual([
      { ref: sref, episodeId: 'e11', watched: false },
      { ref: sref, watched: false },
    ]);
  });
});

describe('SeriesDetailPage season on entry (L1-vod-11)', () => {
  it('a fresh visit opens the Resume season; Back (POP) keeps the season you picked', async () => {
    rememberSeason('src1|s1', 2);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={['/start']}>
            <Routes>
              <Route path="/start" element={<Link to="/s/src1/series/s1">open</Link>} />
              <Route path="/s/:sourceId/series/:itemId" element={<SeriesDetailPage />} />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'open' }));
    // Play points at S01E01, so Season 1 is the one shown.
    expect(await screen.findByRole('button', { name: 'Play S01E01' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Season 1/ }).getAttribute('aria-selected')).toBe('true');
    cleanup();

    // A first render in a MemoryRouter is a POP, like Back.
    renderAt('/s/src1/series/s1', seriesRoute);
    await screen.findByRole('button', { name: 'Play S01E01' });
    expect(screen.getByRole('tab', { name: /Season 2/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Detail Back control (L1-vod-2)', () => {
  /** The shell header's Back, as the page publishes it (the header itself is tested in the shell). */
  function HeaderBack() {
    const back = useShellStore((s) => s.header?.back);
    return back ? <BackButton onClick={back.onClick} label={back.label} /> : null;
  }

  function renderMovie(entries: string[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
            <Routes>
              <Route path="/s/:sourceId/movie/:itemId" element={<MovieDetailPage />} />
              <Route path="/s/:sourceId/movies" element={<div data-testid="landing" />} />
              <Route path="/s/:sourceId/movies/c/:categoryId" element={<div data-testid="grid" />} />
            </Routes>
            <HeaderBack />
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  it('goes back to the grid you came from', async () => {
    renderMovie(['/s/src1/movies/c/c1', '/s/src1/movie/m7']);
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('grid')).toBeTruthy();
  });

  it('opened cold, it goes to the movies landing', async () => {
    renderAt('/s/src1/movie/m7', [
      {
        path: '/s/:sourceId/movie/:itemId',
        element: (
          <>
            <MovieDetailPage />
            <HeaderBack />
          </>
        ),
      },
      { path: '/s/:sourceId/movies', element: <div data-testid="landing" /> },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('landing')).toBeTruthy();
    expect(currentLocation).toBe('/s/src1/movies');
  });
});

describe('Base titles (L1-visual-6)', () => {
  it('the header title and the favorites snapshot use the base title, with the year as the subtitle', async () => {
    rpcMock.handlers['xtream.vodDetail'] = (): VodDetail => ({
      ...movieDetail,
      item: { ref: mref, title: 'Black Harbor (2026)', titleBase: 'Black Harbor', year: 2026, categoryId: 'c1' },
    });
    rpcMock.handlers['favorites.toggle'] = () => ({ isFavorite: true });
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('heading', { name: 'Black Harbor', level: 1 });
    // Favorites wait in the hero's More menu (VL-hero-actions).
    fireEvent.click(within(await openHeroMenu()).getByRole('menuitem', { name: 'Add to favorites' }));
    await waitFor(() => expect(callsOf('favorites.toggle')).toHaveLength(1));
    expect((callsOf('favorites.toggle')[0] as { snapshot: unknown }).snapshot).toEqual({
      title: 'Black Harbor',
      subtitle: '2026',
      contentType: 'movie',
    });
    expect(screen.queryByText('Black Harbor (2026)')).toBeNull();
  });
});

describe('Removed source (L1-vod-13)', () => {
  it('the movies landing and a detail page say the source was removed, with no Try again', async () => {
    rpcMock.handlers['sources.get'] = () => {
      throw { code: 'not_found', message: 'source nope not found' };
    };
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['catalog.movies'] = () => ({ items: [], total: 0, offset: 0, limit: 24 });
    renderAt('/s/nope/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    expect(await screen.findByText('This source was removed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open sources' }).getAttribute('href')).toBe('/sources');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText(/source nope not found/)).toBeNull();
    cleanup();

    renderAt('/s/nope/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    expect(await screen.findByText('This source was removed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
