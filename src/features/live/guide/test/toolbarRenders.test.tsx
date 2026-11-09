/**
 * The guide toolbar during a scroll: only the window label follows the visible time. The pickers,
 * genre chips and buttons around it stay as they are, so a pan or a Shift+wheel does not render
 * the whole toolbar on every frame. Genre chip renders are counted through a wrapped FilterChip.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';

import { defaultStart, EpgGridPage } from '../../components/EpgGridPage';
import { HOUR } from '../../lib/epgTime';
import { createRpcMock, installDomStubs, makeChannel, program, renderGuide, settings } from './harness';

const chipRenders = vi.hoisted(() => ({ n: 0 }));
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
vi.mock('@/ui', async (orig) => {
  const ui = await orig<typeof import('@/ui')>();
  const Chip = ui.FilterChip;
  return {
    ...ui,
    FilterChip: (props: Parameters<typeof Chip>[0]) => {
      chipRenders.n++;
      return <Chip {...props} />;
    },
  };
});

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));

// jsdom keeps scroll offsets at 0: record what is written, so a scroll can be driven.
const lefts = new WeakMap<Element, number>();
const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');

beforeAll(() => {
  installDomStubs();
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      return lefts.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      lefts.set(this, v);
    },
  });
});
afterAll(() => {
  if (original) Object.defineProperty(Element.prototype, 'scrollLeft', original);
});
beforeEach(() => {
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
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
  chipRenders.n = 0;
});
afterEach(cleanup);

describe('the guide toolbar during a scroll', () => {
  it('updates the window label without rendering the genre chips again', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = (a) =>
      Object.fromEntries(
        (a as { refs: Channel['ref'][] }).refs.map((r) => {
          const list: EpgProgram[] = [];
          for (let k = -12; k < 18; k++) list.push(program(`${r.itemId} P${k}`, at + k * HOUR, at + (k + 1) * HOUR));
          return [key(r), list];
        }),
      );
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: [{ path: '/epg', element: <EpgGridPage /> }] });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const label = screen.getByTestId('guide-window');
    const before = label.textContent;
    expect(chipRenders.n).toBeGreaterThan(0);
    chipRenders.n = 0;
    const grid = screen.getByTestId('epg-grid');
    // Earlier by a few minutes per frame: now stays in view, so only the label has news.
    for (let i = 0; i < 3; i++) {
      act(() => {
        grid.scrollLeft -= 40;
        fireEvent.scroll(grid);
      });
      await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    }
    await waitFor(() => expect(screen.getByTestId('guide-window').textContent).not.toBe(before));
    expect(chipRenders.n).toBe(0);
  });
});
