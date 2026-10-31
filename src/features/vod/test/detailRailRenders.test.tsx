/**
 * F4-6: a detail page's "More in <category>" rail keeps its cards while the page re-renders.
 *
 * The page re-renders for each answer after the hero is up (TMDB, other sources, the category
 * name, the position, favorites, downloads). It handed the rail an inline grid input and an inline
 * card renderer that built new My List and prefetch targets per card, so every one of those
 * renders re-rendered all 20 cards. The rail is memoized now and the page's props for it are
 * stable, so each card renders once.
 *
 * Counts the poster cards' renders through a memoized wrapper of the real card, as
 * landingRenders.test.tsx does, so a card counts when its props changed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type ItemRef, type Page, type SeriesItem, type VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { i18n, installDomStubs, makeSource, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});
const counts = vi.hoisted(() => ({ cards: new Map<string, number>() }));

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);
vi.mock('../components/PosterCard', async (orig) => {
  const real = await orig<typeof import('../components/PosterCard')>();
  const { createElement, memo } = await import('react');
  return {
    ...real,
    PosterCard: memo((p: Parameters<typeof real.PosterCard>[0]) => (counts.cards.set(p.title, (counts.cards.get(p.title) ?? 0) + 1), createElement(real.PosterCard, p))),
  };
});

/** The rail counts as near the screen at once, as it is under a hero within the 600 px margin. */
class EagerObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const RAIL = 20;
const movieRef: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const seriesRef: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const movieRow: VodItem = { ref: movieRef, title: 'Dune: Part Two', year: 2024, categoryId: 'c1' };
const seriesRow: SeriesItem = { ref: seriesRef, title: 'Severance', year: 2022, categoryId: 'c1' };
const railRows = (kind: 'movie' | 'series'): (VodItem | SeriesItem)[] =>
  Array.from({ length: RAIL + 1 }, (_, i) => ({ ref: { sourceId: 'src1', contentType: kind, itemId: `r${i}` }, title: `Rail ${kind} ${i}`, categoryId: 'c1', year: 2020 }));

/** Answers after `ms`, so each lands in a render of its own once the rail is up. */
const after = <T,>(ms: number, value: T) => () => new Promise<T>((r) => setTimeout(() => r(value), ms));

function handlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings({ tmdb: { ...DEFAULT_SETTINGS.tmdb, enabled: true, apiKey: 'k' } });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['watchlist.list'] = () => [];
  h['downloads.list'] = () => [];
  h['sourcePins.get'] = () => null;
  h['tmdb.similar'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['xtream.vodDetail'] = () => ({ item: movieRow, cast: [], backdrops: [], providerDetailsUnavailable: false });
  h['xtream.seriesDetail'] = () => ({ item: seriesRow, seasons: [], cast: [], backdrops: [], providerDetailsUnavailable: false });
  h['catalog.movies'] = () => ({ items: railRows('movie'), total: RAIL + 1, offset: 0, limit: 60 }) satisfies Page<VodItem | SeriesItem>;
  h['catalog.series'] = () => ({ items: railRows('series'), total: RAIL + 1, offset: 0, limit: 60 }) satisfies Page<VodItem | SeriesItem>;
  // The answers that re-render the page after the rail is up, one at a time.
  h['catalog.categories'] = after(40, [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Sci-Fi', hidden: false, itemCount: 21, position: 0 }]);
  h['catalog.sameTitle'] = after(80, []);
  h['positions.get'] = after(120, null);
  h['positions.forSeries'] = after(120, []);
  h['favorites.contains'] = after(160, []);
  h['tmdb.movie'] = after(200, null);
  h['tmdb.tv'] = after(200, null);
}

let client: QueryClient;

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

const railCardRenders = (kind: 'movie' | 'series') => [...counts.cards].filter(([title]) => title.startsWith(`Rail ${kind} `));

beforeAll(() => {
  installDomStubs();
  vi.stubGlobal('IntersectionObserver', EagerObserver);
});
beforeEach(() => {
  handlers();
  forgetSpots();
  counts.cards.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe('F4-6: the "More in" rail across a detail page\'s later answers', () => {
  it.each(['movie', 'series'] as const)('draws each %s rail card once', async (kind) => {
    open(kind === 'movie' ? '/s/src1/movie/m7' : '/s/src1/series/s1');
    await screen.findByText(`Rail ${kind} 0`);
    // The category name renames the rail; then the rest of the answers land.
    await screen.findByText(i18n.t('vod:moreInCategory', { category: 'Sci-Fi' }));
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    await waitFor(() => expect(railCardRenders(kind)).toHaveLength(RAIL));
    const renders = railCardRenders(kind).reduce((n, [, c]) => n + c, 0);
    console.info(`[F4-6] ${kind} detail: ${renders} renders for ${RAIL} "More in" cards`);
    expect(renders).toBe(RAIL);
  });
});
