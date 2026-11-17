/**
 * UI audit 2026-11-16 round 2, Live lane: Hidden channels with the pinned views (walkthrough-09),
 * and a list that opens on the channel playing when it started elsewhere (the mini player's Expand).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { Channel, ItemRef } from '@/api/types';

import { CategorySidebar } from '../components/CategorySidebar';
import { ChannelList, resetChannelListMemory } from '../components/ChannelList';
import { HiddenChannelsButton } from '../components/HiddenChannelsButton';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { i18n, installDomStubs, makeChannel, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  return { handlers, call: async (cmd: string, args?: unknown) => handlers[cmd]!(args) };
});
vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

beforeAll(() => installDomStubs());
beforeEach(() => {
  rpcMock.handlers['settings.get'] = () => settings();
  resetChannelListMemory();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
});
afterEach(cleanup);

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Hidden channels (walkthrough-09)', () => {
  it('sits with the pinned views above All channels, not under the last group', async () => {
    rpcMock.handlers['channels.edits'] = () => [
      { ref: makeChannel(3).ref, hidden: true },
      { ref: makeChannel(4).ref, hidden: true },
    ];
    const groups = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, sourceId: 'src1', contentType: 'live' as const, name: `Group ${i}`, hidden: false, itemCount: 3, position: i }));
    wrap(
      <CategorySidebar
        categories={groups}
        hiddenCount={0}
        isLoading={false}
        error={null}
        onRetry={() => undefined}
        hrefFor={(id) => `/s/src1/live${id ? `/${id}` : ''}`}
        onManage={() => undefined}
        totalLabel="All channels"
        pinned={[
          { id: '@favorites', label: 'Favorites', icon: null },
          { id: '@recent', label: 'Recently watched', icon: null },
        ]}
        afterPinned={(height) => <HiddenChannelsButton sourceId="src1" height={height} />}
      />,
    );
    const button = await screen.findByTestId('hidden-channels-button');
    expect(button.textContent).toMatch(/2$/);
    const recent = screen.getByRole('link', { name: 'Recently watched' });
    const all = screen.getByRole('link', { name: /All channels/ });
    const groupList = screen.getByTestId('group-list');
    // Recently watched, Hidden channels, All channels, then the groups.
    expect(recent.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(groupList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not there while nothing is hidden', async () => {
    rpcMock.handlers['channels.edits'] = () => [];
    wrap(<HiddenChannelsButton sourceId="src1" height={36} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('hidden-channels-button')).toBeNull();
  });
});

describe('a list opened while a channel plays', () => {
  const channels: Channel[] = Array.from({ length: 12 }, (_, i) => makeChannel(i));
  const paged: PagedChannels = {
    total: channels.length,
    getChannel: (i) => channels[i],
    getNowNext: () => undefined,
    isFavorite: () => false,
    setVisibleRange: () => undefined,
    isLoading: false,
    refreshing: false,
    error: null,
    retry: () => undefined,
    loaded: channels.map((channel, index) => ({ index, channel })),
    pageSize: 120,
    guideUnavailable: false,
    retryGuide: () => undefined,
  };
  const open = (playingRef: ItemRef | undefined, moves = 0) => {
    const view = wrap(
      <ChannelList
        paged={paged}
        resetKey="live|src1|g1|"
        playingRef={playingRef}
        openOnDoubleClick={false}
        now={Date.now()}
        onPlay={() => undefined}
        onToggleFavorite={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
    // `moves` rows down, as the keyboard moves the cursor.
    for (let i = 0; i < moves; i++) {
      const row = document.querySelector<HTMLButtonElement>('[data-row-index][tabindex="0"]')!;
      row.focus();
      fireEvent.keyDown(row, { key: 'ArrowDown' });
    }
    return view;
  };
  const cursorRow = () => document.querySelector('[data-row-index][tabindex="0"]')?.getAttribute('data-row-index');

  it('marks the playing channel when it started elsewhere (Expand), not the row remembered from before', () => {
    // Left with the cursor on row 2 and nothing playing.
    open(undefined, 2).unmount();
    // Back through the mini player's Expand with channel 7 playing.
    open(channels[7]!.ref);
    expect(cursorRow()).toBe('7');
  });

  it('keeps the remembered row when the same channel plays as when the list was left', () => {
    // Opened on the playing row 7, then two rows down while it plays.
    open(channels[7]!.ref, 2).unmount();
    open(channels[7]!.ref);
    expect(cursorRow()).toBe('9');
  });
});
