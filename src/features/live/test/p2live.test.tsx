/**
 * Second performance pass on Live's cold open (P2-LIVE-3, P2-LIVE-4): what a screen of channel
 * rows and the page cost before the user does anything. And what the list still shows the same
 * way (P2-LIVE-5).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { categoriesArgs } from '@/api/bootPrefetch';
import { queryClient, rpcKey } from '@/api/query';
import type { Channel, EpgNowNext, Page, PageQuery } from '@/api/types';

import { ChannelList, resetChannelListMemory } from '../components/ChannelList';
import { LivePage } from '../components/LivePage';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { MINUTE } from '../lib/epgTime';
import { i18n, installDomStubs, makeChannel, program, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const TOTAL = 200;

// The Live page's first mount takes 4 to 6 s of jsdom on a loaded 2-CPU runner.
vi.setConfig({ testTimeout: 20_000 });
beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['settings.get'] = () => settings();
  h['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => makeChannel(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.nowNext'] = () => ({});
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  resetChannelListMemory();
});

function wrap(ui: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>
    </QueryClientProvider>
  );
}

describe('channel rows (P2-LIVE-3)', () => {
  const now = Date.now();
  // Every row has a programme on, as on a source with a guide.
  const airing: EpgNowNext = { now: program('News at noon', now - 10 * MINUTE, now + 20 * MINUTE) };
  const paged: PagedChannels = {
    total: TOTAL,
    getChannel: (i) => (i >= 0 && i < TOTAL ? makeChannel(i) : undefined),
    getNowNext: () => airing,
    isFavorite: () => false,
    setVisibleRange: () => undefined,
    isLoading: false,
    refreshing: false,
    error: null,
    retry: () => undefined,
    loaded: [],
    pageSize: 120,
    guideUnavailable: false,
    retryGuide: () => undefined,
  };
  const list = (at: number) => (
    <ChannelList
      paged={paged}
      resetKey="k"
      openOnDoubleClick={false}
      now={at}
      onPlay={() => undefined}
      onToggleFavorite={() => undefined}
      onContextMenu={() => undefined}
    />
  );

  it('a screen of rows asks i18next to listen once, not once per row', () => {
    const on = vi.spyOn(i18n, 'on');
    render(wrap(list(now)));
    const rows = screen.getAllByRole('listitem').length;
    expect(rows).toBeGreaterThanOrEqual(12);
    // The list's own useTranslation; each row's subscribed too.
    expect(on.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('reads the words every row shares once, not on every row and render', () => {
    const t = vi.spyOn(i18n, 't');
    const view = render(wrap(list(now)));
    const rows = screen.getAllByRole('listitem').length;
    // Each row still names its own programme ("Now: …"); the favourite, menu, archive and time-left
    // texts are the same on every row.
    expect(t.mock.calls.length).toBeLessThan(rows * 2);
    t.mockClear();
    view.rerender(wrap(list(now + MINUTE)));
    expect(t.mock.calls.length).toBeLessThan(rows * 2);
  });
});

describe('Live page dialogs (P2-LIVE-4)', () => {
  const groupsQuery = () => queryClient.getQueryCache().find({ queryKey: rpcKey('catalog.categories', categoriesArgs('src1', 'live')) });

  it('the groups dialog mounts on its first open and stays mounted once closed', async () => {
    render(
      wrap(
        <MemoryRouter initialEntries={['/s/src1/live']}>
          <Routes>
            <Route path="/s/:sourceId/live" element={<LivePage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await screen.findByText('Channel 0');
    // Only the page reads the groups; a closed dialog read them too.
    expect(groupsQuery()?.getObserversCount()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Manage visible groups' }));
    await screen.findByRole('dialog', { name: 'Manage visible groups' });
    expect(groupsQuery()?.getObserversCount()).toBe(2);
    await act(async () => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Kept for its exit and the next opening.
    expect(groupsQuery()?.getObserversCount()).toBe(2);
  });
});

describe('opening on the playing channel (P2-LIVE-5)', () => {
  it('the list is on the playing row, within its own height, when the mount commit ends', () => {
    const height = 600;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(100_000);
    const scrolls: number[] = [];
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(((arg?: ScrollToOptions) => {
      if (typeof arg === 'object') scrolls.push(arg.top ?? Number.NaN);
    }) as never);
    // A window taller than the list, whose size stands in for the list's until it is laid out.
    const own = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1080 });
    try {
      let atCommit: number[] = [];
      // Its layout effects run after the list's, in the commit that mounts both: what the first
      // paint shows.
      function AfterList() {
        useLayoutEffect(() => {
          atCommit = [...scrolls];
        }, []);
        return null;
      }
      const paged: PagedChannels = {
        total: TOTAL,
        getChannel: (i) => (i >= 0 && i < TOTAL ? makeChannel(i) : undefined),
        getNowNext: () => undefined,
        isFavorite: () => false,
        setVisibleRange: () => undefined,
        isLoading: false,
        refreshing: false,
        error: null,
        retry: () => undefined,
        loaded: Array.from({ length: 120 }, (_, i) => ({ index: i, channel: makeChannel(i) })),
        pageSize: 120,
        guideUnavailable: false,
        retryGuide: () => undefined,
      };
      render(
        wrap(
          <>
            <ChannelList
              paged={paged}
              resetKey="opening"
              playingRef={makeChannel(15).ref}
              openOnDoubleClick={false}
              now={Date.now()}
              onPlay={() => undefined}
              onToggleFavorite={() => undefined}
              onContextMenu={() => undefined}
            />
            <AfterList />
          </>,
        ),
      );
      const row = parseFloat(screen.getAllByRole('listitem')[0]!.style.height);
      // Row 15's bottom on the list's bottom edge. Aligned against the window's 1080 px, the row
      // sat 480 px under it; from a passive effect, the list painted its top first.
      const target = 16 * row - height;
      expect(atCommit).toEqual([target]);
      expect(scrolls[scrolls.length - 1]).toBe(target);
    } finally {
      if (own) Object.defineProperty(window, 'innerHeight', own);
    }
  });
});
