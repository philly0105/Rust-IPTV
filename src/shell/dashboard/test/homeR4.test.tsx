/**
 * Round 4 of the UI refine pass on Home: channel cards without a logo show a logo-sized mark
 * instead of a full-frame colour block.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { installDomStubs, rpcMock } from '../../test/harness';

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
const { ChannelCard, OnNowCard } = await import('../cards');

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
beforeEach(() => rpcMock.reset());
afterEach(() => cleanup());

describe('a channel without a logo (round 4)', () => {
  it('shows its initials as a logo-sized mark in the middle of the card, not a full-frame block', () => {
    wrap(
      <>
        <ChannelCard rail={rail} name="US| ESPN HD" now="NFL Live" nowProgress={0.4} onPlay={vi.fn()} ariaLabel="Play ESPN" />
        <OnNowCard rail={rail} programme="MLB Tonight" channelName="US| MLB Network HD" progress={0.2} sourceId="s1" ariaLabel="Play MLB" onPlay={vi.fn()} />
      </>,
    );
    for (const name of ['Play ESPN', 'Play MLB']) {
      const card = screen.getByRole('button', { name });
      const mark = card.querySelector<HTMLElement>('[data-poster-fallback]')!;
      expect(mark.textContent, name).toMatch(/^(ES|MN)$/);
      // The frame centres the tile at a fixed logo size, rounded like an app icon, with no type glyph.
      const frame = mark.parentElement!.className;
      for (const c of ['[&>[data-poster-fallback]]:m-auto', '[&>[data-poster-fallback]]:size-16', '[&>[data-poster-fallback]]:rounded-[22%]', '[&>[data-poster-fallback]>svg]:hidden']) {
        expect(frame, `${name}: ${c}`).toContain(c);
      }
      // The channel's glow on the card's own surface shows around it.
      expect(frame).toContain('bg-transparent');
    }
  });
});
