import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { DEFAULT_SETTINGS, itemKey, type Channel, type ItemRef } from '@/api/types';

// Guide slice: the fullscreen channel panel's now line and "Browse archive".

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  return { handlers, calls };
});

vi.mock('@/api/transport', () => {
  const call = async (cmd: string, args?: unknown) => {
    rpcMock.calls.push({ cmd, args });
    const h = rpcMock.handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { rpc: call, rpcRaw: call, isDesktop: false, proxiedUrl: (s: { url: string }) => s.url };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { FullscreenChannelPanel } = await import('./FullscreenChannelPanel');
const { ChannelHistory } = await import('./ChannelHistory');
const { useHistoryStore } = await import('../history');

const channel = (i: number, archive = i === 0): Channel => ({
  ref: { sourceId: 's1', contentType: 'live', itemId: `c${i}` },
  name: `Channel ${i}`,
  number: i + 1,
  categoryId: 'g',
  categoryName: 'G',
  isRadio: false,
  ...(archive ? { archive: { enabled: true, durationHours: 24 } } : {}),
});
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/watch']}>
        <Routes>
          <Route path="/watch" element={<FullscreenChannelPanel available />} />
          <Route path="/live/archive/:sourceId/:channelId" element={<p>archive route</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// jsdom has no layout: give the virtualizer a box so it renders rows.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 360 });
});

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
  rpcMock.calls.length = 0;
  const now = Date.now();
  const p = (title: string) => ({ channelId: 'x', title, start: new Date(now - 600_000).toISOString(), end: new Date(now + 600_000).toISOString() });
  rpcMock.handlers['catalog.channels'] = () => ({ items: [0, 1, 2].map((i) => channel(i)), total: 3, offset: 0, limit: 100 });
  rpcMock.handlers['settings.get'] = () => DEFAULT_SETTINGS;
  rpcMock.handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream', name: 'Panel' });
  rpcMock.handlers['epg.nowNext'] = () => ({ [key(channel(0).ref)]: { now: p('Xml news') } });
  rpcMock.handlers['epg.shortEpg'] = (a) => ((a as { ref: ItemRef }).ref.itemId === 'c1' ? [p('Provider film')] : []);
  rpcMock.handlers['catalog.item'] = () => channel(0);
  act(() =>
    usePlayerStore.setState({
      source: { url: 'http://h/live.m3u8', kind: 'hls', title: 'Channel 0', isLive: true, isRadio: false, ref: channel(0).ref },
      mode: 'inline',
      status: 'playing',
    }),
  );
});
afterEach(cleanup);

describe('fullscreen channel panel guide', () => {
  it('shows what is on now: XMLTV first, the provider short guide where XMLTV has nothing', async () => {
    mount();
    act(() => useMediaStore.setState({ channelPanelOpen: true }));
    await waitFor(() => expect(screen.getAllByTestId('panel-now').map((n) => n.textContent)).toEqual(['Xml news', 'Provider film']));
    // Only the rows XMLTV left empty went to the provider.
    const asked = rpcMock.calls.filter((c) => c.cmd === 'epg.shortEpg').map((c) => (c.args as { ref: ItemRef }).ref.itemId);
    expect(asked.sort()).toEqual(['c1', 'c2']);
    // Titles only (L3-serve-ui-9): no programme descriptions over the wire.
    const guide = rpcMock.calls.filter((c) => c.cmd === 'epg.nowNext');
    expect(guide.length).toBeGreaterThan(0);
    for (const c of guide) expect(c.args).toMatchObject({ withDescription: false });
  });

  it('opens the archive of the playing channel and closes the panel', async () => {
    mount();
    act(() => useMediaStore.setState({ channelPanelOpen: true }));
    fireEvent.click(await screen.findByTestId('panel-browse-archive'));
    expect(await screen.findByText('archive route')).toBeTruthy();
    expect(useMediaStore.getState().channelPanelOpen).toBe(false);
  });

  it('the channel history asks the guide for titles only (L3-serve-ui-9)', async () => {
    act(() => useHistoryStore.setState({ entries: [{ key: itemKey(channel(1).ref), ref: channel(1).ref, title: 'Channel 1', isRadio: false }], open: true }));
    render(<ChannelHistory />);
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'epg.nowNext' && (c.args as { refs: ItemRef[] }).refs[0]?.itemId === 'c1')).toBe(true));
    const asked = rpcMock.calls.find((c) => c.cmd === 'epg.nowNext' && (c.args as { refs: ItemRef[] }).refs[0]?.itemId === 'c1');
    expect(asked?.args).toMatchObject({ withDescription: false });
    act(() => useHistoryStore.setState({ entries: [], open: false }));
  });

  it('has no archive action for a channel without one', async () => {
    rpcMock.handlers['catalog.item'] = () => channel(1);
    mount();
    act(() => useMediaStore.setState({ channelPanelOpen: true }));
    await screen.findAllByTestId('panel-now');
    expect(screen.queryByTestId('panel-browse-archive')).toBeNull();
  });
});
