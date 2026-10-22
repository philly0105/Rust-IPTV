/**
 * VOD-LANDING-RENDERS: what an update on the Movies landing re-renders.
 *
 * - A keystroke in the category index's filter re-renders the index only, not the rails' cards.
 *
 * Counts the poster cards' renders through a memoized wrapper of the real card, so a card counts
 * when its props changed, which is what the real (memoized) card renders for.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Page, PlaybackPosition, VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
import { i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});
const counts = vi.hoisted(() => ({ cards: 0 }));

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
    PosterCard: memo((p: Parameters<typeof real.PosterCard>[0]) => (counts.cards++, createElement(real.PosterCard, p))),
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
const continuing: PlaybackPosition[] = Array.from({ length: 5 }, (_, i) => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `p${i}` },
  positionSeconds: 600,
  durationSeconds: 5400,
  watched: false,
  updatedAt: '2026-10-10T20:00:00Z',
  snapshot: { title: `Started ${i}`, contentType: 'movie' },
}));

beforeAll(installDomStubs);
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  forgetSpots();
  localStorage.clear();
  localStorage.setItem(CATEGORY_INDEX_KEY, '1');
  counts.cards = 0;
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

async function openLanding() {
  renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
  // Continue 5, Recently added 24, Top rated 20 and 12 category rails of 20.
  expect(await screen.findByText('c11 movie 19', {}, { timeout: 5000 })).toBeTruthy();
  await settle();
}

describe('VOD-LANDING-RENDERS', () => {
  it('typing in the category filter re-renders no poster card', async () => {
    await openLanding();
    const before = counts.cards;
    const field = screen.getByPlaceholderText(i18n.t('vod:filterCategories'));
    const word = 'netflix';
    for (let i = 1; i <= word.length; i++) {
      fireEvent.change(field, { target: { value: word.slice(0, i) } });
      await settle();
    }
    expect(screen.getAllByRole('link', { name: /NETFLIX/ }).length).toBeGreaterThan(0);
    const typed = counts.cards - before;
    console.info(`[VOD-LANDING-RENDERS] typing "${word}": ${typed} card renders`);
    expect(typed).toBe(0);
  });
});
