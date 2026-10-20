/**
 * Loop 3 dashboard: the hero skeleton is the hero's own dark glass in every theme (L3-visual-8),
 * and cut-off card text shows in full on hover (L3-visual-12).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { ItemRef, PlaybackPosition } from '@/api/types';

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
const { HERO_FRAME, HeroSkeleton } = await import('../HeroSkeleton');
const { buildHeroSlides } = await import('../heroSlides');
const { ChannelCard, PosterCard, SourceCard } = await import('../cards');

function wrap(node: React.ReactNode) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const rail = { 'data-rail-card': '', tabIndex: 0 } as never;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
});
afterEach(() => cleanup());

describe('hero skeleton on glass (L3-visual-8)', () => {
  it('the skeleton and the loaded hero share the dark glass frame', () => {
    expect(HERO_FRAME).toContain('bg-glass-strong');
    expect(HERO_FRAME).not.toMatch(/\bbg-surface\b/);
    wrap(<HeroSkeleton />);
    const skeleton = screen.getByTestId('hero-skeleton');
    for (const c of HERO_FRAME.split(' ')) expect(skeleton.classList.contains(c), c).toBe(true);
    // Its bars read glass tints, not the page's light surfaces.
    expect(skeleton.className).toContain('[--color-surface-2:color-mix(in_srgb,var(--color-on-glass)');
    cleanup();

    const ref: ItemRef = { sourceId: 's1', contentType: 'movie', itemId: '7' };
    const pos = { ref, positionSeconds: 1200, durationSeconds: 4800, updatedAt: '2026-10-10T20:00:00Z', watched: false, snapshot: { title: 'The Long Signal' } } as PlaybackPosition;
    wrap(<HeroCarousel slides={buildHeroSlides([pos], [])} sourceName={() => 'Home'} canPlay={() => true} onPlay={vi.fn()} />);
    const hero = screen.getByTestId('dashboard-hero');
    for (const c of HERO_FRAME.split(' ')) expect(hero.classList.contains(c), c).toBe(true);
  });
});

describe('full text on hover (L3-visual-12)', () => {
  it('poster, channel and source cards title their truncated lines', () => {
    wrap(
      <>
        <PosterCard rail={rail} title="A Remarkably Long Movie Title That Will Not Fit" subtitle="2026 · Drama, Mystery, Thriller" to="/s/s1/movies/1" />
        <ChannelCard rail={rail} name="Harbor News International HD" now="The Evening Bulletin With Extended Weather" sourceName="Night Portal" onPlay={vi.fn()} ariaLabel="Play" />
        <SourceCard rail={rail} source={makeSource('s9', { name: 'A Provider Name Long Enough To Truncate' })} />
      </>,
    );
    for (const text of [
      'A Remarkably Long Movie Title That Will Not Fit',
      '2026 · Drama, Mystery, Thriller',
      'Harbor News International HD',
      'The Evening Bulletin With Extended Weather',
      'A Provider Name Long Enough To Truncate',
    ]) {
      const el = screen.getByText(text);
      expect(el.getAttribute('title'), text).toBe(text);
    }
    expect(screen.getByTestId('source-card-caption').getAttribute('title')).toBeTruthy();
  });
});
