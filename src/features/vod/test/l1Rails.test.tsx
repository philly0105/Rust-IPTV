/**
 * L1-vod-5: a poster rail is one Tab stop (roving tabindex): arrows move along it and S toggles
 * My List on the focused card. L1-vod-6: watched ticks on search results, and a watched title
 * shows its tick instead of a progress bar.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, TmdbBrief, VodItem } from '@/api/types';

import { CORNER_TOUCH_INERT, myListTarget, PosterCard } from '../components/PosterCard';
import { PosterRail } from '../components/PosterRail';
import { TmdbRail } from '../components/TmdbRail';
import { SearchPage } from '../pages/SearchPage';
import { forgetSpots } from '../hooks/useScrollMemory';
import { installDomStubs, makeSource, renderAt, settings } from './harness';

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
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const movie = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` },
  title: `Rail Movie ${i}`,
  year: 2020,
  categoryId: 'c1',
});
const movies = [movie(0), movie(1), movie(2), movie(3)];

/** Elements a Tab press can land on inside `root` (what the browser's sequential focus order visits). */
function tabbable(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

/** A catalog rail wired as VodLandingPage's "Recently added" should be (rail.tabIndex + myList). */
function CatalogRail() {
  return (
    <>
      <button type="button">before</button>
      <PosterRail<VodItem>
        title="Recently added"
        items={movies}
        myList={myListTarget}
        render={(item, i, rail) => (
          <PosterCard index={i} tabIndex={rail.tabIndex} title={item.title} href={`/m/${item.ref.itemId}`} myList={myListTarget(item)} />
        )}
      />
      <button type="button">after</button>
    </>
  );
}

beforeAll(installDomStubs);
beforeEach(async () => {
  forgetSpots();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['watchlist.list'] = () => [];
  // The My List toggle reads the app-wide list cache (the harness renders with its own client).
  const { queryClient } = await import('@/api/query');
  queryClient.setQueryData(['watchlist.list', {}], []);
});
afterEach(() => cleanup());

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

describe('L1-vod-5: a poster rail is one Tab stop', () => {
  it('puts one Tab stop in the rail: card links rove and the My List corners are out of the Tab order', async () => {
    renderAt('/', [{ path: '/', element: <CatalogRail /> }]);
    const list = await screen.findByRole('list');
    const stops = tabbable(list);
    // One stop for the whole rail (it was two per poster: the link and its corner button).
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute('aria-label')).toMatch(/^Rail Movie 0/);
    // Tab from "before" enters the rail on that card; the next stop after it is "after", outside the rail.
    const order = tabbable(document.body);
    const at = order.indexOf(stops[0]!);
    expect(order[at - 1]!.textContent).toBe('before');
    expect(order[at + 1]!.textContent).toBe('after');
    // The corner buttons are still there for the pointer, just not Tab stops.
    const corners = within(list).getAllByRole('button');
    expect(corners).toHaveLength(movies.length);
    for (const b of corners) expect(b.tabIndex).toBe(-1);
    // Hidden until hover, a corner takes no taps on a screen without hover: a tap on the poster's
    // corner opens the title instead of silently saving it.
    for (const b of corners) expect(b.className.split(/\s+/)).toContain(CORNER_TOUCH_INERT);
  });

  it('moves with the arrow keys and keeps the Tab stop on the card last focused', async () => {
    renderAt('/', [{ path: '/', element: <CatalogRail /> }]);
    const list = await screen.findByRole('list');
    const link = (i: number) => within(list).getByRole('link', { name: new RegExp(`^Rail Movie ${i}`) });
    act(() => link(0).focus());
    fireEvent.keyDown(link(0), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link(1));
    fireEvent.keyDown(link(1), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link(2));
    // Coming back by Tab lands on the card you left.
    await waitFor(() => expect(link(2).tabIndex).toBe(0));
    expect(tabbable(list)).toEqual([link(2)]);
    fireEvent.keyDown(link(2), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(link(1));
  });

  it('S on a focused card toggles My List for that title', async () => {
    const toggles: { ref: ItemRef }[] = [];
    rpcMock.handlers['watchlist.toggle'] = (a) => {
      toggles.push(a as { ref: ItemRef });
      return { inList: true };
    };
    renderAt('/', [{ path: '/', element: <CatalogRail /> }]);
    const list = await screen.findByRole('list');
    const link = (i: number) => within(list).getByRole('link', { name: new RegExp(`^Rail Movie ${i}`) });
    act(() => link(0).focus());
    fireEvent.keyDown(link(0), { key: 'ArrowRight' });
    fireEvent.keyDown(link(1), { key: 's' });
    await waitFor(() => expect(toggles).toHaveLength(1));
    expect(toggles[0]!.ref.itemId).toBe('m1');
    // Off the rail, S does nothing here.
    act(() => screen.getByRole('button', { name: 'after' }).focus());
    fireEvent.keyDown(screen.getByRole('button', { name: 'after' }), { key: 's' });
    await new Promise((r) => setTimeout(r, 20));
    expect(toggles).toHaveLength(1);
  });

  it('a TMDB rail (similar, known for) is one Tab stop too', async () => {
    const briefs: TmdbBrief[] = [0, 1, 2].map((i) => ({ tmdbId: i + 1, mediaType: 'movie', title: `Known ${i}` }) as TmdbBrief);
    renderAt('/', [{ path: '/', element: <TmdbRail title="Known for" items={briefs} sourceId="src1" /> }]);
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('link')).toHaveLength(3);
    expect(tabbable(list)).toHaveLength(1);
  });
});

describe('L1-vod-6: watched ticks', () => {
  it('a watched title shows its tick and no progress bar', async () => {
    renderAt('/', [
      {
        path: '/',
        element: (
          <>
            <PosterCard title="Seen" href="/a" progress={0.4} watched />
            <PosterCard title="Halfway" href="/b" progress={0.4} />
          </>
        ),
      },
    ]);
    const seen = await screen.findByRole('link', { name: /^Seen/ });
    expect(within(seen).getByTestId('poster-watched')).toBeTruthy();
    // hidden: true, so a drawn-only bar would still be found.
    expect(within(seen).queryByRole('progressbar', { hidden: true })).toBeNull();
    expect(seen.getAttribute('aria-label')).not.toMatch(/40%/);
    const halfway = screen.getByRole('link', { name: /^Halfway/ });
    // The bar is drawn only: the link's name already says how far (round 2, aria-progressbar-name).
    expect(halfway.getAttribute('aria-label')).toMatch(/40%/);
    expect(within(halfway).getByRole('progressbar', { hidden: true }).getAttribute('aria-hidden')).toBe('true');
    expect(within(halfway).queryByTestId('poster-watched')).toBeNull();
  });

  it('search results tick the watched titles', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1), movie(2)], series: [] });
    rpcMock.handlers['positions.watchedContains'] = (a) => (a as { refs: ItemRef[] }).refs.filter((r) => r.itemId === 'm2');
    renderAt('/search?q=rail', [{ path: '/search', element: <SearchPage /> }]);
    const watched = await screen.findByRole('link', { name: /^Rail Movie 2/ });
    await waitFor(() => expect(within(watched).getByTestId('poster-watched')).toBeTruthy());
    expect(within(screen.getByRole('link', { name: /^Rail Movie 1/ })).queryByTestId('poster-watched')).toBeNull();
    expect(callsOf('positions.watchedContains').length).toBeGreaterThan(0);
  });
});

describe('L1-vod-13 (search): a removed source', () => {
  it('scoped search says the source was removed, with no Retry', async () => {
    rpcMock.handlers['sources.get'] = () => {
      throw { code: 'not_found', message: 'no such source' };
    };
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderAt('/s/gone/search?q=rail', [{ path: '/s/:sourceId/search', element: <SearchPage scoped /> }]);
    expect(await screen.findByText('This source was removed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
