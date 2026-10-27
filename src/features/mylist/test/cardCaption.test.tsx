/**
 * My List's grid captions its posters as the VOD grids and rails do: the title gets two lines
 * before it is cut, and the row height the grid reserves holds both and the line of facts, so a
 * narrow phone column shows "The Clubhouse" rather than "The Clubh…". The caption is text, so the
 * caption box and the reserved row grow with the UI scale: in a fixed 56 px box, 125 % cut the
 * title's second line in half on top of the facts line.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { WatchlistEntry } from '@/api/types';
import { setUiScaleState } from '@/ui/scale';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { CARD_CAPTION_HEIGHT, MyListCard } = await import('../components/MyListCard');
const { MyListPage } = await import('../pages/MyListPage');
const { VIEW_KEY } = await import('../lib/view');

const entry: WatchlistEntry = {
  ref: { sourceId: 's1', contentType: 'series', itemId: 'x1' },
  snapshot: { title: 'The Clubhouse', contentType: 'series' },
  addedAt: '2026-10-01T00:00:00Z',
  watched: false,
} as WatchlistEntry;

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  localStorage.removeItem(VIEW_KEY);
});
afterEach(() => {
  cleanup();
  setUiScaleState(1, 'comfortable');
});

describe('My List card captions', () => {
  it('lets the title take two lines, with the whole title as a tooltip', () => {
    render(<MyListCard entry={entry} busy={false} onRemove={() => {}} />);
    const title = screen.getByTestId('mylist-title');
    const cls = title.className.split(/\s+/);
    expect(cls).toContain('line-clamp-2');
    expect(cls).not.toContain('truncate');
    expect(title.getAttribute('title')).toBe('The Clubhouse');
    // The facts line stays one line under it.
    expect(title.nextElementSibling!.className.split(/\s+/)).toContain('truncate');
  });

  it('reserves room for two title lines (20 px each), the facts line (16 px) and the 8 px gap', () => {
    expect(CARD_CAPTION_HEIGHT).toBeGreaterThanOrEqual(2 * 20 + 16 + 8);
    render(<MyListCard entry={entry} busy={false} onRemove={() => {}} />);
    const caption = screen.getByTestId('mylist-title').parentElement!;
    // The box grows with the UI scale, as the rem-based text in it does.
    expect(caption.getAttribute('style')).toContain(`calc(${CARD_CAPTION_HEIGHT - 8}px * var(--ui-scale, 1))`);
  });

  it('at 125 % UI scale, the grid reserves the scaled lines: two 25 px title lines, a 20 px facts line and the gap', async () => {
    // jsdom has no layout: a 600 px wide grid, two columns at this scale.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
    try {
      setUiScaleState(1.25, 'comfortable');
      rpc.handlers['positions.get'] = () => null;
      rpc.handlers['positions.forSeries'] = () => [];
      rpc.handlers['positions.continueWatching'] = () => [];
      h.installCore(rpc, [entry, { ...entry, ref: { ...entry.ref, itemId: 'x2' }, snapshot: { title: 'North of Nowhere', contentType: 'movie' } }]);
      h.renderAt('/my-list', [{ path: '/my-list', element: <MyListPage /> }]);
      const grid = await screen.findByTestId('mylist-list');
      await waitFor(() => expect(within(grid).getAllByTestId('mylist-card')).toHaveLength(2));
      const row = within(grid).getAllByRole('listitem')[0]!.parentElement!;
      const columns = Number(/repeat\((\d+),/.exec(row.style.gridTemplateColumns)![1]);
      const gap = Number.parseFloat(row.style.columnGap);
      const cardWidth = (600 - gap * (columns - 1)) / columns;
      // The row is the 2:3 poster and the caption; what is left under the poster is the caption's room.
      const caption = Number.parseFloat(row.style.height) - cardWidth * 1.5;
      expect(caption).toBeGreaterThanOrEqual(2 * 25 + 20 + 8);
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });
});
