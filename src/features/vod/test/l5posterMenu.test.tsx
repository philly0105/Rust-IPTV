/**
 * L4-vod-4: a poster's menu in the movie grid plays the title and marks it watched or unwatched,
 * besides opening its details and My List.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, ItemRef, Page, PageQuery, PlaybackPosition, VodItem } from '@/api/types';

import { forgetSpots } from '../hooks/useScrollMemory';
import { PosterRail } from '../components/PosterRail';
import { sectionlessCategoryName } from '../lib/categoryName';
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
let continuing: PlaybackPosition[] = [];

beforeAll(installDomStubs);
beforeEach(() => {
  watchedIds = new Set();
  continuing = [];
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
  h['positions.continueWatching'] = () => continuing;
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

describe('audit 11-16: the poster menu names its title, resumes, and opens from rails', () => {
  it('names the title in its header and says Resume for a started movie', async () => {
    continuing = [
      { ref: film(4).ref, positionSeconds: 600, durationSeconds: 5400, watched: false, updatedAt: '2026-10-10T20:00:00Z', snapshot: { title: 'Film 4', contentType: 'movie' } },
    ];
    renderAt('/s/src1/movies/c/c1', gridRoute);
    await screen.findByRole('group', { name: /^Film 4 \(.*watched/ });
    const menu = await openMenu(/^Film 4 \(/);
    expect(within(menu).getByTestId('context-menu-header').textContent).toContain('Film 4');
    expect(within(menu).getByRole('menuitem', { name: i18n.t('vod:resume') })).toBeTruthy();
  });

  it('a rail with a menu opens it from a card and keeps the browser menu away', () => {
    const menu = vi.fn();
    renderAt('/', [
      {
        path: '/',
        element: (
          <PosterRail<VodItem>
            title="Rail"
            items={ALL.slice(0, 3)}
            menu={menu}
            render={(item, i, rail) => (
              <a href="#x" data-grid-index={i} tabIndex={rail.tabIndex}>
                {item.title}
              </a>
            )}
          />
        ),
      },
    ]);
    const ev = fireEvent.contextMenu(screen.getByText('Film 1'), { clientX: 40, clientY: 50 });
    expect(ev).toBe(false);
    expect(menu).toHaveBeenCalledWith(ALL[1], 1, { x: 40, y: 50 });
  });

  it('drops a leading section word from category names, and only that', () => {
    expect(sectionlessCategoryName('Movies | Action', 'movie')).toBe('Action');
    expect(sectionlessCategoryName('VOD: EN | Horror 4K', 'movie')).toBe('EN | Horror 4K');
    expect(sectionlessCategoryName('Series - Drama', 'series')).toBe('Drama');
    expect(sectionlessCategoryName('EN | Movies', 'movie')).toBe('EN | Movies');
    expect(sectionlessCategoryName('Movies |', 'movie')).toBe('Movies |');
    expect(sectionlessCategoryName('Moviestar | Hits', 'movie')).toBe('Moviestar | Hits');
    expect(sectionlessCategoryName('Series | Drama', 'movie')).toBe('Series | Drama');
  });

  it('picks another category from the grid without going back, replacing the grid in history', async () => {
    const two: Category[] = [...cats, { id: 'c2', sourceId: 'src1', contentType: 'movie', name: 'Movies | Comedy', hidden: false, itemCount: 4, position: 1 }];
    rpcMock.handlers['catalog.categories'] = () => two;
    renderAt('/s/src1/movies/c/c1', gridRoute);
    fireEvent.click(await screen.findByTestId('vod-category-picker'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /Action/ }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(dialog).getByRole('link', { name: /^Comedy/ }));
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'catalog.movies' && (c.args as { categoryId?: string }).categoryId === 'c2')).toBe(true));
  });
});
