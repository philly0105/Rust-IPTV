/**
 * continue-removal-loses-focus: Remove and Mark watched in a Continue watching card's menu take
 * the card away while it holds focus (the menu hands focus back to it on close). Focus used to
 * drop to <body>, so the next Tab started again at the top of the page. It now goes to the card
 * that took the removed one's place, the one before it at the end of the rail, and the page's
 * main region when the rail goes with its last card.
 */

import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackPosition } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from '../../test/harness';

configure({ asyncUtilTimeout: 4000 });

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
  getConnectionState: () => 'closed',
}));
vi.mock('@/features/player', () => ({
  playItem: (...a: unknown[]) => (playerMock.playItem as (...x: unknown[]) => Promise<void>)(...a),
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');
const { queryClient } = await import('@/api/query');
const { useConnectionStore } = await import('../../connection');
const { DashboardRail } = await import('../DashboardRail');
const { useToastStore } = await import('@/ui');

const routes = () => [
  {
    path: '/',
    element: <ShellLayout />,
    children: [...shellRoutes, { path: 's/:sourceId/*', element: <Page>source page</Page> }],
  },
];

const ref = (itemId: string) => ({ sourceId: 's1', contentType: 'movie' as const, itemId });
const position = (itemId: string, title: string, minutesAgo: number): PlaybackPosition => ({
  ref: ref(itemId),
  positionSeconds: 1200,
  durationSeconds: 4800,
  updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  watched: false,
  snapshot: { title, contentType: 'movie' },
});

/** Home with three titles to resume; Remove and Mark watched take a title off the list. */
function home() {
  let rows = [position('a', 'Alpha Signal', 1), position('b', 'Bravo Harbor', 2), position('c', 'Charlie Coast', 3)];
  const drop = (itemId: string) => {
    rows = rows.filter((r) => r.ref.itemId !== itemId);
    return null;
  };
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = () => rows;
  h['positions.remove'] = (a) => drop((a as { ref: { itemId: string } }).ref.itemId);
  h['userstate.setWatched'] = (a) => drop((a as { ref: { itemId: string } }).ref.itemId);
  h['userstate.watchedFor'] = () => [];
  h['favorites.list'] = () => [];
  h['recent.list'] = () => [];
  h['catalog.recentlyAdded'] = () => [];
  h['catalog.channels'] = () => ({ items: [], total: 0 });
  h['epg.nowNext'] = () => ({});
  h['watchlist.list'] = () => [];
  h['lists.list'] = () => [];
  h['catalog.item'] = () => null;
}

/** Opens the card's menu from the keyboard (Shift+F10) and picks `action`. */
async function choose(card: HTMLElement, action: string) {
  act(() => card.focus());
  fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
  const menu = await screen.findByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name: action }));
  // The menu gave focus back to the card before the title went.
  expect(document.activeElement).toBe(card);
}

beforeAll(installDomStubs);
beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useConnectionStore.setState({ offline: false, backOnline: false });
});
afterEach(cleanup);

describe('Continue watching keeps focus when a card goes', () => {
  it('Remove hands focus to the next card, Mark watched on the last card to the one before, the empty rail to main', async () => {
    home();
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-continue-watching');
    const card = (name: string) => within(rail).getByRole('button', { name: `Resume ${name}` });
    await within(rail).findByRole('button', { name: 'Resume Charlie Coast' });

    await choose(card('Bravo Harbor'), 'Remove from continue watching');
    await waitFor(() => expect(within(rail).queryByRole('button', { name: 'Resume Bravo Harbor' })).toBeNull());
    expect(document.activeElement).toBe(card('Charlie Coast'));

    await choose(card('Charlie Coast'), 'Mark as watched');
    await waitFor(() => expect(within(rail).queryByRole('button', { name: 'Resume Charlie Coast' })).toBeNull());
    expect(document.activeElement).toBe(card('Alpha Signal'));

    await choose(card('Alpha Signal'), 'Remove from continue watching');
    await waitFor(() => expect(screen.queryByTestId('dashboard-rail-continue-watching')).toBeNull());
    expect(document.activeElement).toBe(document.getElementById('main'));
  });
});

describe('DashboardRail: a focused card that goes', () => {
  type Item = { id: string };
  function Harness({ initial }: { initial: string[] }) {
    const [items, setItems] = useState<Item[]>(initial.map((id) => ({ id })));
    return (
      <main id="main" tabIndex={-1}>
        <button type="button" data-testid="elsewhere">
          Elsewhere
        </button>
        <input aria-label="drop" data-testid="drop" onChange={(e) => setItems((xs) => xs.filter((x) => x.id !== e.target.value))} />
        <DashboardRail<Item>
          id="t"
          title="Test"
          items={items}
          getKey={(x) => x.id}
          cardWidth={200}
          skeletonAspect={1}
          renderCard={(x, rail) => (
            <div>
              <button type="button" {...rail}>
                {`Card ${x.id}`}
              </button>
              <button type="button" tabIndex={rail.tabIndex}>{`Menu ${x.id}`}</button>
            </div>
          )}
        />
      </main>
    );
  }
  const drop = (id: string) => fireEvent.change(screen.getByTestId('drop'), { target: { value: id } });

  it('from its menu button, focus goes to the card in its place', () => {
    render(<Harness initial={['1', '2', '3']} />);
    act(() => screen.getByRole('button', { name: 'Menu 2' }).focus());
    // The removal arrives while focus is still in the card (a refetch, a toast's Undo elsewhere).
    act(() => drop('2'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Card 3' }));
  });

  it('leaves focus alone when it is not in the card that went', () => {
    render(<Harness initial={['1', '2', '3']} />);
    act(() => screen.getByRole('button', { name: 'Card 2' }).focus());
    act(() => screen.getByTestId('elsewhere').focus());
    act(() => drop('2'));
    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
    // Another card going does not pull focus either.
    act(() => screen.getByRole('button', { name: 'Card 3' }).focus());
    act(() => drop('1'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Card 3' }));
  });
});
