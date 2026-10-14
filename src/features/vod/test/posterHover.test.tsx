import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

import { installDomStubs } from './harness';

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: async () => [],
  rpcRaw: async () => [],
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const { PosterCard } = await import('../components/PosterCard');

const ref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm1' };

beforeAll(installDomStubs);
afterEach(() => cleanup());

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <PosterCard title="Snow" href="/m/1" myList={{ itemRef: ref, snapshot: { title: 'Snow', contentType: 'movie' } }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('poster with a My List toggle: one hover for the card and its toggle', () => {
  it('lifts the art from the wrapper, and the toggle layer with it', () => {
    renderCard();
    const link = screen.getByRole('link');
    const wrapper = link.parentElement!;
    expect(wrapper.className).toContain('group/poster');
    // The art answers the wrapper's hover, so moving onto the toggle (outside the link) keeps it lifted.
    const art = link.firstElementChild!;
    expect(art.className).toContain('group-hover/poster:-translate-y-0.5');
    expect(art.className).toContain('group-hover/poster:ring-fg-subtle');
    // The toggle's layer takes the same lift, so the two move together.
    const layer = screen.getByTestId('mylist-button').parentElement!;
    expect(layer.className).toContain('motion-safe:group-hover/poster:-translate-y-0.5');
  });
});
