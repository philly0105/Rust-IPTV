/**
 * P2-RAILS-4: the Movies landing mounts its chips and rails without reading layout. Its viewport
 * height (the open category index's floor, IDX-3) was read right after the commit; it now comes from
 * a ResizeObserver, whose callback follows the browser's layout. With the rails' edges (P2-RAILS-1)
 * and the chips' fades (P2-RAILS-3) read the same way, nothing on the landing forces a layout before
 * the browser's own: the first read in the commit used to pay for the whole new page.
 *
 * jsdom has no layout: `layOut()` (fakeResizeObservers) stands in for the browser's.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, PlaybackPosition, VodItem } from '@/api/types';

import { useClientHeight } from '../hooks/useContainerColumns';
import { forgetSpots } from '../hooks/useScrollMemory';
import { VodLandingPage } from '../pages/VodLandingPage';
import { fakeResizeObservers, installDomStubs, makeSource, renderAt, settings, spyLayoutReads } from './harness';

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

let observers: ReturnType<typeof fakeResizeObservers>;
beforeAll(installDomStubs);
beforeEach(() => {
  observers = fakeResizeObservers();
});
afterEach(() => {
  cleanup();
  observers.restore();
});

function Viewport() {
  const ref = useRef<HTMLDivElement>(null);
  const height = useClientHeight(ref);
  return (
    <div ref={ref} data-testid="viewport">
      {height}
    </div>
  );
}

describe('P2-RAILS-4: the viewport height comes from the observer', () => {
  it('reads no clientHeight while it mounts', async () => {
    const reads = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(640);
    render(<Viewport />);
    await act(async () => undefined);
    expect(reads).not.toHaveBeenCalled();
    expect(screen.getByTestId('viewport').textContent).toBe('0');
    act(() => observers.layOut());
    expect(screen.getByTestId('viewport').textContent).toBe('640');
  });
});

const cats: Category[] = Array.from({ length: 4 }, (_, i) => ({
  id: `c${i}`,
  sourceId: 'src1',
  contentType: 'movie',
  name: `Category ${i}`,
  hidden: false,
  itemCount: 40,
  position: i,
}));
const movie = (id: string): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: id }, title: `Movie ${id}`, categoryId: 'c0', year: 2020 });
const started: PlaybackPosition = {
  ref: { sourceId: 'src1', contentType: 'movie', itemId: 'p1' },
  positionSeconds: 600,
  durationSeconds: 5400,
  watched: false,
  updatedAt: '2026-10-10T20:00:00Z',
  snapshot: { title: 'Started', contentType: 'movie' },
};

/** Every rail counts as near the screen at once, so the category rails mount with their cards. */
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

describe('P2-RAILS-4: the Movies landing', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    forgetSpots();
    localStorage.clear();
    const h = rpcMock.handlers;
    for (const k of Object.keys(h)) delete h[k];
    h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
    h['settings.get'] = () => settings({});
    h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    h['parental.locks'] = () => [];
    h['catalog.categories'] = () => cats;
    h['catalog.recentlyAdded'] = () => Array.from({ length: 24 }, (_, i) => movie(`r${i}`));
    h['catalog.movies'] = (a) => {
      const id = (a as { categoryId?: string }).categoryId ?? 'top';
      return { items: Array.from({ length: 30 }, (_, i) => movie(`${id}-${i}`)), total: 40, offset: 0, limit: 60 };
    };
    h['positions.continueWatching'] = () => [started];
    h['positions.watchedContains'] = () => [];
    h['watchlist.list'] = () => [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts its chips and rails without reading layout', async () => {
    const reads = spyLayoutReads();
    renderAt('/s/src1/movies', [{ path: '/s/:sourceId/movies', element: <VodLandingPage kind="movie" /> }]);
    await screen.findAllByTestId('vod-category-chip');
    await screen.findByRole('heading', { name: /Category 3/ });
    await waitFor(() => expect(document.querySelectorAll('[data-testid="vod-landing-movie"] a[href*="/movie/"]').length).toBeGreaterThan(100));
    expect(reads.count()).toBe(0);
    // Recently added, Top rated and the category rails are wider than the window: step buttons from the start.
    expect(screen.getAllByRole('button', { name: 'Scroll forward' }).length).toBeGreaterThanOrEqual(6);
  });
});
