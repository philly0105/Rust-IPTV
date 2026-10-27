/**
 * Round 5 of the UI refine pass: Home's channel cards name a channel as Live TV's list does, the
 * provider's country tag after the name and quiet ("CBS HD" then "US" for "US| CBS HD"), the
 * provider's name kept for tooltips and screen readers, and no tag with the setting that hides them.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { Channel } from '@/api/types';

import { installDomStubs, rpcMock, settings } from '../../test/harness';

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
const { ChannelCard, OnNowCard, joinList } = await import('../cards');

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
const cbs = { ref: { sourceId: 's1', contentType: 'live', itemId: '6' }, name: 'US| CBS HD', number: 6 } as Channel;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
});
afterEach(() => cleanup());

/** What a card draws as its channel's name: the name part and the quiet tag, in order. */
function drawn(card: HTMLElement): string[] {
  const tag = card.querySelector('[data-testid=channel-name-tag]');
  return tag ? [tag.previousElementSibling!.textContent!, tag.textContent!] : [];
}

describe("Home's channel cards name a channel as Live TV does", () => {
  it('a channel card puts the country tag after the name, quiet, and keeps the provider name for tooltips and screen readers', async () => {
    wrap(<ChannelCard rail={rail} name="US| ESPN HD" now="NFL Live" onPlay={vi.fn()} ariaLabel="Play US| ESPN HD" channel={cbs} />);
    const card = screen.getByRole('button', { name: 'Play US| ESPN HD' });
    await waitFor(() => expect(drawn(card)).toEqual(['ESPN HD', 'US']));
    const tag = card.querySelector('[data-testid=channel-name-tag]')!;
    expect(tag.className).toContain('text-fg-subtle');
    expect(tag.parentElement!.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('[title="US| ESPN HD"]')!.querySelector('.sr-only')!.textContent).toBe('US| ESPN HD');
  });

  it('an On now card draws the channel line the same way, the source after it as written', async () => {
    const joined = joinList([cbs.name, 'Northwind Premium'], 'en');
    wrap(
      <>
        <OnNowCard rail={rail} programme="NFL Live" channelName={cbs.name} left="41 minutes left" sourceId="s1" ariaLabel="Play one" onPlay={vi.fn()} channel={cbs} />
        <OnNowCard rail={rail} programme="NFL Live" channelName={joined} sourceId="s1" ariaLabel="Play two" onPlay={vi.fn()} channel={cbs} />
      </>,
    );
    const one = screen.getByRole('button', { name: 'Play one' });
    await waitFor(() => expect(drawn(one)).toEqual(['CBS HD', 'US']));
    expect(one.textContent).toContain('41 minutes left');
    const two = screen.getByRole('button', { name: 'Play two' });
    expect(drawn(two)).toEqual(['CBS HD', 'US']);
    const line = two.querySelector<HTMLElement>(`[title="${joined}"]`)!;
    expect(line.lastElementChild!.textContent).toContain('Northwind Premium');
    expect(line.lastElementChild!.textContent).not.toContain('CBS');
  });

  it('with "Hide country tags" on, the cards leave the tag out', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ stripCountryPrefix: true });
    wrap(
      <>
        <ChannelCard rail={rail} name="US| ESPN HD" onPlay={vi.fn()} ariaLabel="Play ESPN" />
        <OnNowCard rail={rail} programme="NFL Live" channelName={cbs.name} sourceId="s1" ariaLabel="Play CBS" onPlay={vi.fn()} channel={cbs} />
      </>,
    );
    const espn = screen.getByRole('button', { name: 'Play ESPN' });
    await waitFor(() => expect(espn.querySelector('[title="US| ESPN HD"]')!.textContent).toBe('ESPN HD'));
    expect(espn.querySelector('[data-testid=channel-name-tag]')).toBeNull();
    const card = screen.getByRole('button', { name: 'Play CBS' });
    expect(card.querySelector('[data-testid=channel-name-tag]')).toBeNull();
    expect(card.textContent).toContain('CBS HD');
    expect(card.textContent).not.toContain('US|');
  });
});
