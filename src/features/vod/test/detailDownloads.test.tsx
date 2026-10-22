/**
 * DL-7: a movie or series page shows its running download's progress from the live
 * `downloads.progress` samples, so a transfer neither refetches `downloads.list` twice a second
 * nor re-renders the whole page; only the control that draws the progress re-renders.
 *
 * Page renders are counted through AboutSection, which the detail pages render with new props on
 * every render of their own.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { DEFAULT_SETTINGS, type Download, type ItemRef, type SeriesDetail, type VodDetail } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { i18n, installDomStubs, makeSource, settings } from './harness';

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
const events = vi.hoisted(() => new Map<string, Set<(p: unknown) => void>>());
const counts = vi.hoisted(() => ({ page: 0 }));

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, handler: (p: unknown) => void) => {
    const set = events.get(type) ?? new Set();
    events.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);
vi.mock('../components/detail/AboutSection', async (orig) => {
  const real = await orig<typeof import('../components/detail/AboutSection')>();
  const { createElement } = await import('react');
  return { ...real, AboutSection: (p: Parameters<typeof real.AboutSection>[0]) => (counts.page++, createElement(real.AboutSection, p)) };
});

const emit = (type: string, payload: unknown) => events.get(type)?.forEach((h) => h(payload));
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

const movieRef: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const seriesRef: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const TOTAL = 1000;
/** What the core has saved of the transfer: it writes the row's bytes as they come in. */
let persisted = 0;

function running(id: number, ref: ItemRef, episodeId?: string): Download {
  const d: Download = {
    id,
    ref,
    title: 'T',
    url: 'http://x/v.mkv',
    status: 'downloading',
    bytesDownloaded: persisted,
    totalBytes: TOTAL,
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
    positionSeconds: 0,
  };
  if (episodeId) d.episodeId = episodeId;
  return d;
}

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  counts.page = 0;
  persisted = 0;
  forgetSpots();
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings({ tmdb: { ...DEFAULT_SETTINGS.tmdb, enabled: false } });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => [];
  h['favorites.contains'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['sourcePins.get'] = () => null;
  h['watchlist.list'] = () => [];
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['xtream.vodDetail'] = (): VodDetail => ({ item: { ref: movieRef, title: 'Dune', categoryId: 'c1' }, cast: [], backdrops: [], providerDetailsUnavailable: false });
  h['xtream.seriesDetail'] = (): SeriesDetail => ({
    item: { ref: seriesRef, title: 'Severance', categoryId: 'c1' },
    seasons: [{ number: 1, episodes: [{ id: 'e11', seriesRef, season: 1, episode: 1, title: 'Pilot' }] }],
    cast: [],
    backdrops: [],
    providerDetailsUnavailable: false,
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

// The app's client: the page's event handling invalidates through it.
function open(path: string) {
  render(
    <QueryClientProvider client={queryClient}>
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

/** Progress for download `id` every 250 ms for 2 s (8 events, up to 80 %), as the core sends it at 4/s. */
async function transfer(id: number, label: string) {
  await new Promise((r) => setTimeout(r, 100));
  const before = { list: callsOf('downloads.list').length, page: counts.page };
  for (let i = 1; i <= 8; i++) {
    await act(async () => {
      persisted = i * 100;
      emit('downloads.progress', { id, bytesDownloaded: persisted, totalBytes: TOTAL, bytesPerSecond: 400 });
      await new Promise((r) => setTimeout(r, 250));
    });
  }
  await act(async () => new Promise((r) => setTimeout(r, 600)));
  const list = callsOf('downloads.list').length - before.list;
  const page = counts.page - before.page;
  console.info(`[DL-7] ${label}: 8 progress events in 2 s -> ${list} downloads.list calls, ${page} page renders`);
  return { list, page };
}

describe('DL-7: a running download on its detail page', () => {
  it('moves the movie hero ring from the live samples, without refetching the list or re-rendering the page', async () => {
    rpcMock.handlers['downloads.list'] = () => [running(1, movieRef)];
    open('/s/src1/movie/m7');
    await screen.findByRole('link', { name: i18n.t('vod:downloadingPercent', { percent: 0 }) });
    const { list, page } = await transfer(1, 'movie');
    expect(screen.getByRole('link', { name: i18n.t('vod:downloadingPercent', { percent: 80 }) })).toBeTruthy();
    expect(list).toBe(0);
    expect(page).toBe(0);
  }, 10_000);

  it("moves an episode row's percent the same way", async () => {
    rpcMock.handlers['downloads.list'] = () => [running(2, seriesRef, 'e11')];
    open('/s/src1/series/s1');
    await screen.findByRole('link', { name: `${i18n.t('vod:downloadingPercent', { percent: 0 })} S01E01 Pilot` });
    const { list, page } = await transfer(2, 'series');
    await waitFor(() => expect(screen.getByRole('link', { name: `${i18n.t('vod:downloadingPercent', { percent: 80 })} S01E01 Pilot` })).toBeTruthy());
    expect(list).toBe(0);
    expect(page).toBe(0);
  }, 10_000);
});
