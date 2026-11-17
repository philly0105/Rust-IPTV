/**
 * Round 2 of the UI audit (lane vod2): the landing's language picker (realdata-14), one error for a
 * failing catalog (states-feedback-05), the category rails' language badges (realdata-22).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, VodItem } from '@/api/types';
import { SkeletonGrid } from '@/ui';

import { forgetSpots } from '../hooks/useScrollMemory';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
import { installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

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

const NAMES = ['EN | ACTION', 'EN | COMEDY', 'NETFLIX MOVIES', 'FR | CINÉMA', 'FR | ACTION', 'EN | DRAMA'];
const cats: Category[] = NAMES.map((name, i) => ({ id: `c${i}`, sourceId: 'src1', contentType: 'movie', name, hidden: false, itemCount: 40, position: i }));
const movie = (id: string, categoryName?: string): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: id },
  title: `Movie ${id}`,
  categoryId: 'c0',
  ...(categoryName ? { categoryName } : {}),
  year: 2020,
});
const landing = [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }];
const chipNames = () => screen.getAllByTestId('vod-category-chip').map((c) => c.textContent);

beforeAll(installDomStubs);
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  forgetSpots();
  localStorage.clear();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => makeSource('src1', 'm3u', 'Alpha IPTV');
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [];
  h['catalog.movies'] = (a) => {
    const id = (a as { categoryId?: string }).categoryId ?? 'all';
    const name = cats.find((c) => c.id === id)?.name;
    return { items: Array.from({ length: 3 }, (_, i) => movie(`${id}-${i}`, name)), total: 3, offset: 0, limit: 60 };
  };
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('realdata-14: the landing picks a language for its categories', () => {
  it('narrows the chips, the rails and the index to the tag, untagged categories after it, and remembers the pick', async () => {
    localStorage.setItem(CATEGORY_INDEX_KEY, '1');
    renderAt('/s/src1/movies', landing);
    await waitFor(() => expect(chipNames()).toEqual(NAMES));
    // One picker by the chips and one by the index's filter.
    const pickers = screen.getAllByRole('combobox', { name: 'Language' });
    expect(pickers).toHaveLength(2);
    // Each tag names its language, as the posters do (w-realdata-11).
    expect([...(pickers[0] as HTMLSelectElement).options].map((o) => o.text)).toEqual(['All languages', 'EN · English · 3 categories', 'FR · French · 2 categories']);

    fireEvent.change(pickers[0]!, { target: { value: 'FR' } });
    await waitFor(() => expect(chipNames()).toEqual(['FR | CINÉMA', 'FR | ACTION', 'NETFLIX MOVIES']));
    expect(screen.queryByRole('heading', { name: /EN \| ACTION/ })).toBeNull();
    expect(await screen.findByRole('heading', { name: /FR \| CINÉMA/ })).toBeTruthy();
    const index = await screen.findByRole('list', { name: 'Categories' });
    expect(within(index).queryByText('EN | COMEDY')).toBeNull();
    expect(within(index).getByText('NETFLIX MOVIES')).toBeTruthy();
    // Both pickers show the pick, which reads as the tag alone.
    for (const p of screen.getAllByRole('combobox', { name: 'Language' })) expect((p as HTMLSelectElement).selectedOptions[0]?.text).toBe('FR');

    cleanup();
    renderAt('/s/src1/movies', landing);
    await waitFor(() => expect(chipNames()).toEqual(['FR | CINÉMA', 'FR | ACTION', 'NETFLIX MOVIES']));
  }, 20_000);

  it('has no picker when the categories carry no language tags', async () => {
    rpcMock.handlers['catalog.categories'] = () => cats.map((c, i) => ({ ...c, name: `Category ${i}` }));
    renderAt('/s/src1/movies', landing);
    await screen.findAllByTestId('vod-category-chip');
    expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
  }, 20_000);
});

describe('states-feedback-05: a failing catalog draws one error', () => {
  it('shows one error with one Try again in place of every rail, and the retry brings the page back', async () => {
    let fail = true;
    const broken = (ok: () => unknown) => () => {
      if (fail) throw { code: 'db', message: 'database is locked' };
      return ok();
    };
    const h = rpcMock.handlers;
    h['catalog.categories'] = broken(() => cats);
    h['catalog.recentlyAdded'] = broken(() => [movie('r1')]);
    const movies = h['catalog.movies']!;
    h['catalog.movies'] = broken(() => movies({}));
    renderAt('/s/src1/movies', landing);
    await screen.findByText("Couldn't load these titles");
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Recently added' })).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(chipNames()).toEqual(NAMES));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Recently added' })).toBeTruthy();
  }, 20_000);

  it('keeps a rail of its own error when only that rail fails', async () => {
    rpcMock.handlers['catalog.recentlyAdded'] = () => {
      throw { code: 'timeout', message: 'timed out' };
    };
    renderAt('/s/src1/movies', landing);
    await waitFor(() => expect(chipNames()).toEqual(NAMES));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recently added' })).toBeTruthy();
    expect(screen.queryByText("Couldn't load these titles")).toBeNull();
  }, 20_000);
});

describe('realdata-22: a category rail leaves out the language its name already says', () => {
  it('drops the badge and caption word in "FR | CINÉMA" and keeps them in Recently added', async () => {
    rpcMock.handlers['catalog.recentlyAdded'] = () => [{ ...movie('r1', 'FR | CINÉMA'), title: 'Movie r1' }];
    renderAt('/s/src1/movies', landing);
    // The rail's placeholder gives way to the rail as it mounts.
    const link = await waitFor(() => within(screen.getByRole('heading', { name: /FR \| CINÉMA/ }).closest('section')!).getByRole('link', { name: /^Movie c3-0/ }), { timeout: 8000 });
    expect(link.getAttribute('aria-label')).not.toMatch(/French/);
    expect(within(link).queryByText('FR')).toBeNull();
    const recent = screen.getByRole('heading', { name: 'Recently added' }).closest('section')!;
    expect(within(recent).getByRole('link', { name: /^Movie r1.*French/ })).toBeTruthy();
  }, 20_000);
});

describe('the category grid skeleton', () => {
  it("gives each card the grid's caption height, so the rows stay put when the posters arrive", () => {
    const { container } = render(<SkeletonGrid count={2} captionHeight={62} />);
    const captions = container.querySelectorAll<HTMLElement>('[role="status"] > div > div:nth-child(2)');
    expect([...captions].map((c) => c.style.height)).toEqual(['62px', '62px']);
  });
});
