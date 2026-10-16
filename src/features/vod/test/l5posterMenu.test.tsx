/**
 * L4-vod-4: a poster's menu in the movie grid plays the title and marks it watched or unwatched,
 * besides opening its details and My List.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, ItemRef, Page, PageQuery, VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { CategoryGridPage } from '../pages/CategoryGridPage';
import { i18n, installDomStubs, makeSource, played, renderAt, settings } from './harness';

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

const gridRoute = [{ path: '/s/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> }];
const TOTAL = 12;
const film = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` },
  title: `Film ${i}`,
  categoryId: 'c1',
  year: 2000 + i,
});
const ALL = Array.from({ length: TOTAL }, (_, i) => film(i));
const cats: Category[] = [{ id: 'c1', sourceId: 'src1', contentType: 'movie', name: 'Action', hidden: false, itemCount: TOTAL, position: 0 }];
let watchedIds = new Set<string>();

beforeAll(installDomStubs);
beforeEach(() => {
  watchedIds = new Set();
  played.length = 0;
  forgetSpots();
  localStorage.clear();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['settings.get'] = () => settings({});
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => cats;
  h['catalog.yearFacets'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['watchlist.list'] = () => [];
  h['positions.watchedContains'] = (a) => (a as { refs: ItemRef[] }).refs.filter((r) => watchedIds.has(r.itemId));
  h['userstate.setWatched'] = (a) => {
    const { ref, watched } = a as { ref: ItemRef; watched: boolean };
    if (watched) watchedIds.add(ref.itemId);
    else watchedIds.delete(ref.itemId);
  };
  h['catalog.movies'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: ALL.slice(q.offset, q.offset + q.limit), total: ALL.length, offset: q.offset, limit: q.limit } satisfies Page<VodItem>;
  };
});
afterEach(() => cleanup());

const openMenu = async (name: RegExp) => {
  fireEvent.contextMenu(await screen.findByRole('group', { name }), { clientX: 30, clientY: 30 });
  return screen.findByRole('menu');
};

describe('L4-vod-4: the grid poster menu plays and marks watched', () => {
  it('lists Play and Mark as watched, and Mark as watched calls the watched toggle', async () => {
    renderAt('/s/src1/movies/c/c1', gridRoute);
    const menu = await openMenu(/^Film 2 \(/);
    expect(within(menu).getByRole('menuitem', { name: i18n.t('vod:play') })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: i18n.t('vod:openDetails') })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: i18n.t('vod:markWatched') }));
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'userstate.setWatched')).toBe(true));
    const set = rpcMock.calls.find((c) => c.cmd === 'userstate.setWatched')!.args as { ref: ItemRef; watched: boolean };
    expect(set.ref.itemId).toBe('f2');
    expect(set.watched).toBe(true);
  });

  it('offers Mark as unwatched for a watched title', async () => {
    watchedIds = new Set(['f3']);
    renderAt('/s/src1/movies/c/c1', gridRoute);
    const menu = await openMenu(/^Film 3 \(/);
    expect(await within(menu).findByRole('menuitem', { name: i18n.t('vod:markUnwatched') })).toBeTruthy();
  });

  it('Play starts playback of the title', async () => {
    renderAt('/s/src1/movies/c/c1', gridRoute);
    const menu = await openMenu(/^Film 1 \(/);
    fireEvent.click(within(menu).getByRole('menuitem', { name: i18n.t('vod:play') }));
    await waitFor(() => expect(played).toHaveLength(1));
    const args = played[0] as { ref: ItemRef; isLive: boolean; sourceKind: string; title: string };
    expect(args.ref.itemId).toBe('f1');
    expect(args.isLive).toBe(false);
    expect(args.sourceKind).toBe('xtream');
    expect(args.title).toBe('Film 1');
  });
});
