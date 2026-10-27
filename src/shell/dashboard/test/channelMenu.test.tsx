/**
 * Run 2 C2/C3 (wiring-r1 F8): the dashboard's live and radio cards open the
 * channel menu on right click, the context-menu key and Shift+F10, with Play,
 * Add to multi-view, Add to list…, Rename… and Hide, as in Live's menu.
 */

import { configure, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FavoriteEntry, RecentEntry } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from '../../test/harness';

// The whole shell renders here, with Home and its lazy overlays (palette, shortcut help): a cold
// first render under a loaded full-suite run can pass the 1 s default.
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
  PlayerDock: () => <div data-testid="player-dock" />,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');
const { queryClient } = await import('@/api/query');

/** A source's pages: where a live card's Play lands. */
function SourcePage() {
  return <Page>{`source page ${useLocation().pathname}`}</Page>;
}

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [...shellRoutes, { path: 's/:sourceId/*', element: <SourcePage /> }],
    },
  ];
}

const newsRef = { sourceId: 's1', contentType: 'live' as const, itemId: 'c1' };
const radioRef = { sourceId: 's1', contentType: 'radio' as const, itemId: 'r1' };

function dashboard() {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' })];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['positions.continueWatching'] = () => [];
  h['favorites.list'] = (): FavoriteEntry[] => [
    { ref: newsRef, addedAt: '2026-10-12T00:00:00Z', position: 0, snapshot: { title: 'News 24', subtitle: 'News', contentType: 'live' } },
  ];
  h['recent.list'] = (): RecentEntry[] => [{ ref: radioRef, viewedAt: '2026-10-12T00:00:00Z', snapshot: { title: 'Jazz FM', contentType: 'radio' } }];
  h['catalog.recentlyAdded'] = () => [];
  h['epg.nowNext'] = () => ({});
  h['watchlist.list'] = () => [];
  h['lists.list'] = () => [];
  h['channels.edits'] = () => [];
  h['channels.setHidden'] = () => null;
}

async function newsCard() {
  const rail = await screen.findByTestId('dashboard-rail-live-favorites');
  return within(rail).findByRole('button', { name: 'Play News 24' });
}

/** Item labels without the key hints (aria-hidden, out of the accessible name). */
const itemNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((b) => {
      const copy = b.cloneNode(true) as HTMLElement;
      for (const n of copy.querySelectorAll('[aria-hidden]')) n.remove();
      return copy.textContent;
    });

beforeAll(installDomStubs);
beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  playerMock.playItem.mockClear();
  dashboard();
});
afterEach(cleanup);

describe('dashboard channel card menu', () => {
  it('right click opens the channel menu with the Live entries, and Hide hides the channel', async () => {
    renderRoutes(routes(), '/dashboard');
    const card = await newsCard();
    fireEvent.contextMenu(card, { clientX: 40, clientY: 60 });

    const menu = await screen.findByRole('menu', { name: 'News 24' });
    await waitFor(() => expect(itemNames(menu)).toContain('Hide channel'));
    expect(itemNames(menu)).toEqual(['Play', 'Add to multi-view', 'Add to list…', 'Rename…', 'Hide channel']);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Play' }));

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Hide channel/ }));
    await waitFor(() => expect(rpcMock.calls.filter((c) => c.cmd === 'channels.setHidden').map((c) => c.args)).toEqual([{ refs: [newsRef], hidden: true }]));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Shift+F10 and the context-menu key open it from the keyboard; Escape returns focus and Play plays in Live TV', async () => {
    renderRoutes(routes(), '/dashboard');
    const card = await newsCard();
    card.focus();
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    let menu = await screen.findByRole('menu', { name: 'News 24' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(card);

    fireEvent.keyDown(card, { key: 'ContextMenu' });
    menu = await screen.findByRole('menu', { name: 'News 24' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Play' }));
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledTimes(1));
    expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: newsRef, title: 'News 24', isLive: true }));
    // As the card itself: the channel's Live TV opens, whose stage takes the player.
    expect(await screen.findByText('source page /s/s1/live')).toBeTruthy();
  });

  it('a live card plays its channel and opens Live TV in one press, not the mini player over Home', async () => {
    renderRoutes(routes(), '/dashboard');
    fireEvent.click(await newsCard());
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: newsRef, isLive: true })));
    expect(await screen.findByText('source page /s/s1/live')).toBeTruthy();
  });

  it('a radio card plays the station in the dock and stays on Home', async () => {
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recent-live');
    fireEvent.click(await within(rail).findByRole('button', { name: 'Play Jazz FM' }));
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: radioRef, isRadio: true })));
    expect(screen.getByTestId('dashboard-rail-recent-live')).toBeTruthy();
    expect(screen.queryByText(/^source page/)).toBeNull();
  });

  it('a radio card gets the station entries and no multi-view', async () => {
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-recent-live');
    const card = await within(rail).findByRole('button', { name: 'Play Jazz FM' });
    fireEvent.contextMenu(card, { clientX: 40, clientY: 60 });
    const menu = await screen.findByRole('menu', { name: 'Jazz FM' });
    await waitFor(() => expect(itemNames(menu)).toContain('Hide station'));
    expect(itemNames(menu)).not.toContain('Add to multi-view');
    expect(itemNames(menu)).toContain('Add to list…');
  });
});

describe('dashboard channel card menu, parental locks (XB2-31)', () => {
  it("looks up a favourite's group, so a channel in a locked group says 'Locked with its group'", async () => {
    const h = rpcMock.handlers;
    h['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    h['parental.locks'] = () => [{ sourceId: 's1', contentType: 'live', kind: 'category', targetId: 'g-news', name: 'News', createdAt: '2026-10-15T00:00:00Z' }];
    h['catalog.item'] = () => ({ ref: newsRef, name: 'News 24', categoryId: 'g-news', categoryName: 'News', isRadio: false });
    renderRoutes(routes(), '/dashboard');
    const card = await newsCard();
    fireEvent.contextMenu(card, { clientX: 40, clientY: 60 });
    const menu = await screen.findByRole('menu', { name: 'News 24' });
    const entry = await within(menu).findByRole<HTMLButtonElement>('menuitem', { name: 'Locked with its group' });
    expect(entry.disabled).toBe(true);
    expect(within(menu).queryByRole('menuitem', { name: 'Lock channel' })).toBeNull();
    expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.item').map((c) => c.args)).toEqual([{ ref: newsRef }]);
  });

  it('does not look the channel up while parental controls are off', async () => {
    renderRoutes(routes(), '/dashboard');
    const card = await newsCard();
    fireEvent.contextMenu(card, { clientX: 40, clientY: 60 });
    const menu = await screen.findByRole('menu', { name: 'News 24' });
    await waitFor(() => expect(itemNames(menu)).toContain('Hide channel'));
    expect(rpcMock.calls.some((c) => c.cmd === 'catalog.item')).toBe(false);
  });
});
