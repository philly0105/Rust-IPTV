/** Loop 2 dashboard fixes: base titles on the hero (L2-visual-3), its phone layout (L2-visual-5), and the source card (L2-sources-home-4, -9). */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { ItemRef, PlaybackPosition, Source } from '@/api/types';

import { installDomStubs, makeSource, rpcMock } from '../../test/harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const { queryClient } = await import('@/api/query');
const { HeroCarousel } = await import('../HeroCarousel');
const { buildHeroSlides } = await import('../heroSlides');
const { SourceCard } = await import('../cards');
const { useImportProgressStore } = await import('@/features/sources/lib/progress');

const movie = (id: string): ItemRef => ({ sourceId: 's1', contentType: 'movie', itemId: id });

function position(title: string): PlaybackPosition {
  return { ref: movie('7'), positionSeconds: 1200, durationSeconds: 4800, updatedAt: '2026-10-10T20:00:00Z', watched: false, snapshot: { title } } as PlaybackPosition;
}

function wrap(node: React.ReactNode) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useImportProgressStore.setState({ bySource: {}, cancelling: {} });
});
afterEach(() => cleanup());

// The title rules (the core's title_base) are pinned in src/lib/title.test.ts, with these provider titles among them.
describe('base titles on continue-watching slides', () => {
  it('continue-watching slides drop the provider year from an old snapshot title and keep it as a fact', () => {
    const [s] = buildHeroSlides([position('US The Paper Astronaut (2026)')], []);
    expect(s).toMatchObject({ title: 'US The Paper Astronaut', year: 2026 });
  });
});

describe('hero (L2-visual-3, L2-visual-5)', () => {
  it("the headline is the catalog item's base title, as on the detail page", async () => {
    rpcMock.handlers['catalog.item'] = () => ({ ref: movie('7'), title: '|US| The Paper Astronaut (2026)', titleBase: 'The Paper Astronaut', year: 2026 });
    const slides = buildHeroSlides([position('|US| The Paper Astronaut (2026)')], []);
    wrap(<HeroCarousel slides={slides} sourceName={() => 'Home'} canPlay={() => true} onPlay={vi.fn()} />);
    const heading = await screen.findByRole('heading', { level: 2, name: 'The Paper Astronaut' });
    expect(heading).toBeTruthy();
  });

  it('lays the slides into one shrinkable column, so a phone-width hero never clips its buttons', () => {
    const slides = buildHeroSlides([], [{ ref: movie('1'), title: 'One', posterUrl: 'https://img.test/1.jpg' } as never]);
    wrap(<HeroCarousel slides={slides} sourceName={() => 'Home'} canPlay={() => true} onPlay={vi.fn()} />);
    const body = screen.getByTestId('hero-slide');
    expect(body.className).toContain('min-w-0');
    expect(body.parentElement!.className).toContain('grid-cols-[minmax(0,1fr)]');
    // The button row wraps rather than overflowing.
    expect(screen.getByRole('button', { name: /Play/ }).parentElement!.className).toContain('flex-wrap');
  });
});

describe('source card (L2-sources-home-4, L2-sources-home-9)', () => {
  const rail = { 'data-rail-card': '', tabIndex: 0 } as never;
  const card = (over: Partial<Source> = {}) => wrap(<SourceCard rail={rail} source={makeSource('big', { name: 'Big Xtream', ...over })} />);

  it('groups large counts with the locale formatter', () => {
    card({ channelCount: 19500, movieCount: 60000, seriesCount: 8000 });
    expect(screen.getByTestId('source-card-caption').textContent).toContain('19,500 channels');
    expect(screen.getByTestId('source-card-caption').textContent).toContain('60,000 movies');
  });

  it('shows the running import, not "Nothing imported yet", and goes back to counts once it ends', () => {
    act(() => useImportProgressStore.getState().apply({ sourceId: 'big', phase: 'parsing', done: 50, total: 200 }));
    card({ channelCount: 0, movieCount: 0, seriesCount: 0 });
    expect(screen.getByTestId('source-card-caption').textContent).toBe('⁨Reading the playlist⁩, ⁨25%⁩');
    expect(screen.getByTestId('source-card-progress')).toBeTruthy();
    act(() => useImportProgressStore.getState().apply({ sourceId: 'big', phase: 'fetching', done: 1_050_283 }));
    // Bytes with no total: the phase alone, over an indeterminate bar.
    expect(screen.getByTestId('source-card-caption').textContent).toBe('⁨Downloading⁩');
    act(() => useImportProgressStore.getState().apply({ sourceId: 'big', phase: 'done', done: 0 }));
    expect(screen.getByTestId('source-card-caption').textContent).toBe('Nothing imported yet');
    expect(screen.queryByTestId('source-card-progress')).toBeNull();
  });
});
