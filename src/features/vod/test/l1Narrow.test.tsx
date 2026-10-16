import { act, cleanup, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { gridLayout } from '@/ui';

import { VodFilterBar } from '../components/VodFilterBar';
import { COVER_WIDTH, NARROW_COVER_WIDTH, useCoverWidth } from '../hooks/useCoverWidth';
import { installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ facets: undefined as undefined | (() => unknown) }));

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  // The facets stay pending unless a test answers them.
  const call = (cmd: string) => (cmd === 'catalog.yearFacets' && rpcMock.facets ? Promise.resolve(rpcMock.facets()) : new Promise(() => undefined));
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  rpcMock.facets = undefined;
  vi.restoreAllMocks();
});

/** A matchMedia that reports a phone-width screen, with a way to rotate it. */
function phoneScreen(initial: boolean) {
  const listeners = new Set<() => void>();
  const state = { matches: initial };
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query.includes('max-width') ? state.matches : false;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }) as unknown as MediaQueryList,
  );
  return (next: boolean) => {
    state.matches = next;
    listeners.forEach((fn) => fn());
  };
}

describe('poster columns at phone width (L1-vod-4, L1-visual-19)', () => {
  it('every cover size shrinks to the narrow minimum on a phone-width screen', () => {
    phoneScreen(true);
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(renderHook(() => useCoverWidth(size)).result.current).toBe(NARROW_COVER_WIDTH);
    }
  });

  it('keeps the chosen size on a wider screen and follows a resize', () => {
    const rotate = phoneScreen(false);
    const { result } = renderHook(() => useCoverWidth('large'));
    expect(result.current).toBe(COVER_WIDTH.large);
    act(() => rotate(true));
    expect(result.current).toBe(NARROW_COVER_WIDTH);
  });

  it('fits three posters a row in a 390px grid', () => {
    // L2-vod-7: 390 minus the 72px rail and the page padding is 286px (275px beside a thin
    // desktop scrollbar). Loop 1 counted without the rail and the grid showed two a row.
    expect(gridLayout(286, NARROW_COVER_WIDTH, 16).columns).toBe(3);
    expect(gridLayout(275, NARROW_COVER_WIDTH, 16).columns).toBe(3);
    expect(gridLayout(358, NARROW_COVER_WIDTH, 16).columns).toBe(3);
    // Before: one poster a row.
    expect(gridLayout(358, COVER_WIDTH.large, 16).columns).toBe(1);
    expect(gridLayout(286, COVER_WIDTH.medium, 16).columns).toBe(1);
  });
});

describe('year chips while the facets load (L1-vod-12)', () => {
  const bar = (sourceId: string, yearsLikely: boolean) => [
    {
      path: '/',
      element: (
        <VodFilterBar
          sourceId={sourceId}
          kind="movie"
          categoryId="all"
          stalker={false}
          yearsLikely={yearsLikely}
          range={{}}
          onRangeChange={() => undefined}
          hideWatched={false}
          onHideWatchedChange={() => undefined}
        />
      ),
    },
  ];

  it('reserves no year row on an M3U source, whose titles rarely carry years', () => {
    renderAt('/', bar('m3u-1', false));
    expect(screen.queryByTestId('vod-year-filter')).toBeNull();
  });

  it('shows placeholder chips while an Xtream source loads', () => {
    renderAt('/', bar('xt-1', true));
    expect(screen.getByTestId('vod-year-filter')).toBeTruthy();
  });

  it('reserves the row for an M3U source that showed years before', async () => {
    rpcMock.facets = () => [{ year: 1999, count: 3 }];
    renderAt('/', bar('m3u-years', false));
    await screen.findByRole('button', { name: /1990s/ });
    cleanup();
    rpcMock.facets = undefined;
    renderAt('/', bar('m3u-years', false));
    expect(screen.getByTestId('vod-year-filter')).toBeTruthy();
  });
});
