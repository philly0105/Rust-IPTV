/**
 * VOD-LANDING-RENDERS: what an update on the Movies landing re-renders.
 *
 * - A keystroke in the category index's filter re-renders the index only, not the rails' cards.
 * - A query answer (a rail's page, the watched lookup, the resume positions) re-renders the cards
 *   it changed, not every mounted rail's.
 *
 * Counts the poster cards' renders through a memoized wrapper of the real card, so a card counts
 * when its props changed, which is what the real (memoized) card renders for.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rpcKey } from '@/api/query';
import type { Category, Page, PlaybackPosition, VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
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

/** Every rail counts as near the screen at once. */
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

const CATEGORIES = 444;
const cats: Category[] = Array.from({ length: CATEGORIES }, (_, i) => ({
  id: `c${i}`,
  sourceId: 'src1',
  contentType: 'movie',
  // A few providers' groups carry the word the test types.
  name: i % 100 === 7 ? `NETFLIX ${i}` : `Category ${i}`,
  hidden: false,
  itemCount: 500,
  position: i,
}));
const movie = (id: string, title: string): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: id }, title, categoryId: 'c0', year: 2020, rating: 7 });
const page = (prefix: string): Page<VodItem> => ({
  items: Array.from({ length: 60 }, (_, i) => movie(`${prefix}-${i}`, `${prefix} movie ${i}`)),
  total: 500,
  offset: 0,
  limit: 60,
});
const started = (itemId: string, title: string): PlaybackPosition => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId },
  positionSeconds: 600,
  durationSeconds: 5400,
  watched: false,
  updatedAt: '2026-10-10T20:00:00Z',
  snapshot: { title, contentType: 'movie' },
});
const continuing = Array.from({ length: 5 }, (_, i) => started(`p${i}`, `Started ${i}`));
const total = () => [...counts.cards.values()].reduce((a, b) => a + b, 0);

beforeAll(installDomStubs);
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  forgetSpots();
  localStorage.clear();
  localStorage.setItem(CATEGORY_INDEX_KEY, '1');
  counts.cards.clear();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => page('recent').items.slice(0, 24);
  h['catalog.movies'] = (a) => page((a as { categoryId?: string }).categoryId ?? 'top');
  h['positions.continueWatching'] = () => continuing;
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  });

let client: QueryClient;

async function openLanding() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/s/src1/movies']}>
          <Routes>
            <Route path="/s/:sourceId/movies" element={<VodLandingPage kind="movie" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  // Continue 5, Recently added 24, Top rated 20 and 12 category rails of 20.
  expect(await screen.findByText('c11 movie 19', {}, { timeout: 5000 })).toBeTruthy();
  await settle();
}

describe('VOD-LANDING-RENDERS', () => {
  it('a cold landing draws each card about once, not once per query answer', async () => {
    await openLanding();
    const cards = 5 + 24 + 20 + 12 * 20;
    console.info(`[VOD-LANDING-RENDERS] cold landing: ${total()} card renders for ${cards} cards`);
    expect(total()).toBeLessThanOrEqual(cards * 1.25);
  });

  it('a new resume answer re-renders the card it moves and the Continue watching rail only', async () => {
    await openLanding();
    const before = new Map(counts.cards);
    await act(async () => {
      client.setQueryData(rpcKey('positions.continueWatching', { limit: 500 }), [started('c3-5', 'Resumed film'), ...continuing]);
    });
    await settle();
    const delta = total() - [...before.values()].reduce((a, b) => a + b, 0);
    console.info(`[VOD-LANDING-RENDERS] one resume answer: ${delta} card renders`);
    // The rail card gets its progress bar, and its neighbours stay as they were. Continue watching
    // gains a card and draws its six (twice: the rail measures its new length).
    expect(counts.cards.get('c3 movie 5')).toBe(before.get('c3 movie 5')! + 1);
    expect(counts.cards.get('c3 movie 4')).toBe(before.get('c3 movie 4'));
    expect(counts.cards.get('Resumed film')).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(1 + 6 * 2);
  });

  it('typing in the category filter re-renders no poster card', async () => {
    await openLanding();
    const before = total();
    const field = screen.getByPlaceholderText(i18n.t('vod:filterCategories'));
    const word = 'netflix';
    for (let i = 1; i <= word.length; i++) {
      fireEvent.change(field, { target: { value: word.slice(0, i) } });
      await settle();
    }
    expect(screen.getAllByRole('link', { name: /NETFLIX/ }).length).toBeGreaterThan(0);
    const typed = total() - before;
    console.info(`[VOD-LANDING-RENDERS] typing "${word}": ${typed} card renders`);
    expect(typed).toBe(0);
  });
});
