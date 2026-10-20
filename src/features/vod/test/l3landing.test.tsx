/**
 * L3-app-4 and L3-perf-desktop-7: the VOD landing counts what the user can open (the shown
 * categories, after parental Hide mode), not the raw import, and asks for the categories once.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Source } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { CATEGORY_INDEX_KEY, VodLandingPage } from '../pages/VodLandingPage';
import { i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

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

const cat = (id: string, name: string, itemCount: number, hidden = false, position = 0): Category => ({
  id,
  sourceId: 'src1',
  contentType: 'movie',
  name,
  hidden,
  itemCount,
  position,
});

let source: Source;
// What the core answers with includeHidden: hidden categories marked, parental Hide already applied.
let cats: Category[];

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  // The counts under test sit in the category index, behind "Browse all categories" (VL-landing-index).
  localStorage.setItem(CATEGORY_INDEX_KEY, '1');
  rpcMock.calls.length = 0;
  source = makeSource('src1', 'xtream', 'Alpha IPTV'); // movieCount 5000: the raw import
  cats = [cat('c1', 'Action', 12), cat('c2', 'Drama', 30, false, 1), cat('c3', 'Late night', 400, true, 2)];
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => source;
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: true, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () => [];
  h['catalog.categories'] = () => cats;
  h['catalog.recentlyAdded'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
});
afterEach(() => cleanup());

const landing = () => renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);

describe('L3-app-4: the landing counts the titles the user can open', () => {
  it('sums the shown categories, leaving out hidden ones and the raw import count', async () => {
    landing();
    expect(await screen.findByText('Alpha IPTV · 42 titles')).toBeTruthy();
    expect(screen.queryByText(/5,000/)).toBeNull();
    const all = screen.getByRole('link', { name: new RegExp(i18n.t('vod:allMovies')) });
    expect(within(all).getByText('42')).toBeTruthy();
    // The hidden category is not listed, only counted on Manage.
    expect(screen.queryByRole('link', { name: /Late night/ })).toBeNull();
    expect(screen.getByRole('button', { name: i18n.t('vod:manageCategoriesHidden', { count: 1 }) })).toBeTruthy();
  });

  it('shows no count when every category is hidden (no "5,000 titles" over an empty index)', async () => {
    cats = cats.map((c) => ({ ...c, hidden: true }));
    landing();
    expect(await screen.findByRole('button', { name: i18n.t('vod:manageCategoriesHidden', { count: 3 }) })).toBeTruthy();
    expect(screen.getByText('Alpha IPTV')).toBeTruthy();
    expect(screen.queryByText(/titles/)).toBeNull();
  });

  it('falls back to the source count on a Stalker portal whose categories carry no counts', async () => {
    source = makeSource('src1', 'stalker', 'Portal');
    cats = [cat('c1', 'Action', 0), cat('c2', 'Drama', 0, false, 1)];
    landing();
    expect(await screen.findByText('Portal · 5,000 titles')).toBeTruthy();
  });
});

describe('L3-perf-desktop-7: one categories request', () => {
  it('reads the shown and the hidden categories from a single catalog.categories call', async () => {
    landing();
    await screen.findByRole('link', { name: /Action/ });
    await new Promise((r) => setTimeout(r, 30));
    const calls = rpcMock.calls.filter((c) => c.cmd === 'catalog.categories');
    expect(calls).toEqual([{ cmd: 'catalog.categories', args: { sourceId: 'src1', contentType: 'movie', includeHidden: true } }]);
  });
});
