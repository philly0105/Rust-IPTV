/**
 * The guide page's render costs (P2-GUIDE): grid keys hashed once per chunk and window.
 */
import { act, cleanup, configure, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_CHUNK, GRID_ROW } from '../../components/EpgGridPage';
import { HOUR } from '../../lib/epgTime';
import { createRpcMock, installDomStubs, makeChannel, program, renderGuide, settings } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

let channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

/** Hour-long programmes from 6 h before `at` to 12 h after it. */
function hourly(at: number) {
  return (a: unknown) =>
    Object.fromEntries(
      (a as { refs: Channel['ref'][] }).refs.map((r) => [key(r), Array.from({ length: 18 }, (_, k) => program(`${r.itemId} P${k - 6}`, at + (k - 6) * HOUR, at + (k - 5) * HOUR))]),
    );
}

// jsdom keeps scroll offsets at 0: record what is written, so scrolls can be driven.
const scrolls = new WeakMap<Element, number>();
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrolls.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrolls.set(this, v);
    },
  });
});
afterAll(() => {
  if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
});
beforeEach(() => {
  channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: channels.slice(q.offset, q.offset + q.limit), total: channels.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = hourly(defaultStart(Date.now()));
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const GRID = [{ path: '/epg', element: <EpgGridPage /> }];

describe('grid keys (P2-GUIDE-6)', () => {
  it('a vertical scroll frame inside the chunks on screen hashes no grid key', async () => {
    channels = Array.from({ length: 3 * GRID_CHUNK }, (_, i) => makeChannel(i));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    // Past the prefetch of the chunk below.
    await new Promise((r) => setTimeout(r, 300));
    const grid = screen.getByTestId('epg-grid');
    const stringify = vi.spyOn(JSON, 'stringify');
    for (const y of [GRID_ROW, 2 * GRID_ROW, 3 * GRID_ROW]) {
      act(() => {
        grid.scrollTop = y;
        fireEvent.scroll(grid);
      });
    }
    const gridKeys = stringify.mock.calls.filter(([v]) => Array.isArray(v) && v[0] === 'epg.grid');
    stringify.mockRestore();
    expect(screen.getByRole('button', { name: /^c4 P0,/ })).toBeTruthy();
    expect(gridKeys).toEqual([]);
  });
});
