/**
 * P2-HOME-3: what the hero re-renders. Its slide bodies are memoized with stable props, and the
 * first slide's backdrop counts as seen from the start, so mounting renders each body once, and a
 * hover, the next backdrop's mount on idle or a turn re-render only the bodies whose `active`
 * changes. Each body draws one MetaLine, which counts its renders here.
 *
 * P2-HOME-5: only a continue slide reads its catalog item; a new arrival's body and backdrop
 * mounted a disabled query each, which still built and cached a query.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { installDomStubs, rpcMock } from '../../test/harness';

const counts = vi.hoisted(() => ({ bodies: 0 }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/ui', async (orig) => {
  const real = await orig<typeof import('@/ui')>();
  const { createElement } = await import('react');
  return {
    ...real,
    MetaLine: (p: Parameters<typeof real.MetaLine>[0]) => (counts.bodies++, createElement(real.MetaLine, p)),
  };
});

const { queryClient } = await import('@/api/query');
const { HeroCarousel } = await import('../HeroCarousel');
type HeroSlide = import('../heroSlides').HeroSlide;

const slide = (id: string, over: Partial<HeroSlide> = {}): HeroSlide => ({
  key: `s1|movie|${id}`,
  kind: 'new',
  ref: { sourceId: 's1', contentType: 'movie', itemId: id },
  title: `Title ${id}`,
  ...over,
});
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => slide(id));
const sourceName = () => 'Home IPTV';
const canPlay = () => true;
const onPlay = () => undefined;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  counts.bodies = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('P2-HOME-3: the hero re-renders only the slides that change', () => {
  it('mounts each body once, and a hover, the idle backdrop and a turn leave the others alone', () => {
    queryClient.clear();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HeroCarousel slides={SIX} sourceName={sourceName} canPlay={canPlay} onPlay={onPlay} dwellMs={60_000} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(counts.bodies).toBe(6);

    // The next slide's backdrop mounts once the page is idle (whenIdle).
    act(() => void vi.advanceTimersByTime(2_000));
    expect(document.querySelector('[data-hero-backdrop="s1|movie|b"]')).not.toBeNull();
    expect(counts.bodies).toBe(6);

    const hero = screen.getByTestId('dashboard-hero');
    fireEvent.pointerEnter(hero);
    expect(hero.dataset['rotating']).toBeUndefined();
    fireEvent.pointerLeave(hero);
    expect(counts.bodies).toBe(6);

    // A turn: the slide that leaves and the one that comes.
    fireEvent.click(screen.getByRole('tab', { name: 'Title c' }));
    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.getByRole('tab', { selected: true }).getAttribute('aria-label')).toBe('Title c');
    expect(counts.bodies).toBe(8);
  });
});

describe('P2-HOME-5: only a continue slide reads its catalog item', () => {
  it('builds a catalog item query for a continue slide only', async () => {
    rpcMock.handlers['catalog.item'] = () => ({ ref: { sourceId: 's1', contentType: 'movie', itemId: 'r' }, title: 'Resumed', titleBase: 'Resumed' });
    queryClient.clear();
    const slides = [slide('r', { key: 's1|movie|r|', kind: 'continue' }), ...SIX.slice(1)];
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HeroCarousel slides={slides} sourceName={sourceName} canPlay={canPlay} onPlay={onPlay} dwellMs={60_000} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
    const items = queryClient.getQueryCache().findAll({ queryKey: ['catalog.item'] });
    expect(items.map((q) => q.queryKey)).toEqual([['catalog.item', { ref: slides[0]!.ref }]]);
    expect(screen.getByRole('heading', { name: 'Resumed' })).toBeTruthy();
  });
});
