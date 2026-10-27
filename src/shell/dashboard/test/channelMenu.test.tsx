/**
 * Run 2 C2/C3 (wiring-r1 F8): the dashboard's live and radio cards open the
 * channel menu on right click, the context-menu key and Shift+F10, with Play,
 * Add to multi-view, Add to list…, Rename… and Hide, as in Live's menu.
 */

import { act, configure, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { itemKey, type Channel, type CustomList, type CustomListEntry, type EpgNowNext, type FavoriteEntry, type RecentEntry } from '@/api/types';

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
  // A list rail's play sets the list's zapping on the store once the channel plays.
  usePlayerStore: { setState: () => undefined },
}));

const { ShellLayout } = await import('../../ShellLayout');
const { shellRoutes } = await import('../../routes');
const { queryClient } = await import('@/api/query');
const { ChannelCard, SourceKindContext } = await import('../cards');
const { useToastStore } = await import('@/ui');

/** Clicks on the source page's row, which sits where a card was: the second click of a double click must not land here. */
const rowClicks = { count: 0 };

/** A source's pages: where a live card's Play lands, with a row under the pointer. */
function SourcePage() {
  return (
    <Page>
      <p>{`source page ${useLocation().pathname}`}</p>
      <button type="button" onClick={() => rowClicks.count++}>
        Row
      </button>
    </Page>
  );
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
const sportRef = { sourceId: 's1', contentType: 'live' as const, itemId: 'c2' };
const sport: Channel = { ref: sportRef, name: 'Sport 1', categoryId: 'g-sport', categoryName: 'Sport', isRadio: false };

/** Now ± 30 minutes, so the programme is on air whatever the clock says. */
function onAir(title: string): EpgNowNext {
  const now = Date.now();
  return { now: { channelId: title, title, start: new Date(now - 30 * 60_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString() } };
}

/** `channel` on air in On now: the source's own channels fill it (News 24 has the favourites rail). */
function onNowHome(channel: Channel = sport) {
  const h = rpcMock.handlers;
  h['catalog.channels'] = () => ({ items: [channel], total: 1 });
  h['epg.nowNext'] = () => ({ [itemKey(channel.ref)]: onAir('Match Day') });
}

async function onNowCard(name = 'Sport 1') {
  const rail = await screen.findByTestId('dashboard-rail-on-now');
  return within(rail).findByRole('button', { name: new RegExp(`Play ${name}`) });
}

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
  rowClicks.count = 0;
  useToastStore.setState({ toasts: [] });
  dashboard();
});
afterEach(() => {
  cleanup();
  // A card that opened Live TV keeps eating the rest of its double click for half a second: spend
  // that on the window, not on the next test's first click.
  fireEvent.click(window);
  fireEvent.dblClick(window);
});

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

  it('Shift+F10 and the context-menu key open it from the keyboard; Escape returns focus and Play plays', async () => {
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
    // A favourite's card passes no page to open: it plays in the mini player over Home.
    expect(document.activeElement).toBe(card);
    expect(screen.queryByText(/^source page/)).toBeNull();
  });

  it('an On now card plays its channel and opens Live TV in one press, not the mini player over Home', async () => {
    onNowHome();
    renderRoutes(routes(), '/dashboard');
    fireEvent.click(await onNowCard());
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: sportRef, isLive: true })));
    expect(await screen.findByText('source page /s/s1/live')).toBeTruthy();
  });

  it("an On now card's menu Play opens Live TV as the card does", async () => {
    onNowHome();
    renderRoutes(routes(), '/dashboard');
    fireEvent.contextMenu(await onNowCard(), { clientX: 40, clientY: 60 });
    const menu = await screen.findByRole('menu', { name: 'Sport 1' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Play' }));
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: sportRef, isLive: true })));
    expect(await screen.findByText('source page /s/s1/live')).toBeTruthy();
  });

  it('the second click of a double click lands nowhere on the Live TV the first one opened', async () => {
    onNowHome();
    renderRoutes(routes(), '/dashboard');
    fireEvent.click(await onNowCard(), { detail: 1 });
    await screen.findByText('source page /s/s1/live');
    // The rest of the double click reaches what Live TV drew under the pointer.
    const row = screen.getByRole('button', { name: 'Row' });
    fireEvent.click(row, { detail: 2 });
    fireEvent.dblClick(row, { detail: 2 });
    expect(rowClicks.count).toBe(0);
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledTimes(1));
    expect(screen.getByText('source page /s/s1/live')).toBeTruthy();
    // Only for the double-click time: a click after it is the user's own.
    await act(() => new Promise((r) => setTimeout(r, 600)));
    fireEvent.click(row, { detail: 1 });
    expect(rowClicks.count).toBe(1);
    expect(playerMock.playItem).toHaveBeenCalledTimes(1);
  });

  it('a card of a source Home no longer lists says the source is gone and stays on Home', async () => {
    onNowHome({ ...sport, ref: { ...sportRef, sourceId: 'gone' } });
    renderRoutes(routes(), '/dashboard');
    fireEvent.click(await onNowCard());
    expect(await screen.findByText('That source is gone')).toBeTruthy();
    expect(playerMock.playItem).not.toHaveBeenCalled();
    expect(screen.getByTestId('dashboard-rail-on-now')).toBeTruthy();
    expect(screen.queryByText(/^source page/)).toBeNull();
  });

  it("a list's rail plays its channel in the mini player and stays on Home, where zapping walks the list", async () => {
    const h = rpcMock.handlers;
    const list: CustomList = { id: 'L1', name: 'Game day', position: 0, onDashboard: true, itemCount: 1, createdAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T09:00:00Z' };
    const entry: CustomListEntry = { ref: sportRef, snapshot: { title: 'Sport 1', contentType: 'live' }, channel: sport, available: true, position: 0, addedAt: '2026-10-13T09:00:00Z' };
    h['lists.list'] = () => [list];
    h['lists.items'] = () => [entry];
    h['sources.get'] = () => makeSource('s1', { name: 'Night Portal' });
    renderRoutes(routes(), '/dashboard');
    const rail = await screen.findByTestId('dashboard-rail-list-L1');
    fireEvent.click(await within(rail).findByRole('button', { name: 'Play Sport 1' }));
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: sportRef, isLive: true })));
    expect(screen.getByTestId('dashboard-rail-list-L1')).toBeTruthy();
    expect(screen.queryByText(/^source page/)).toBeNull();
  });

  it('a channel card opens the page its rail gives it, such as a list page', async () => {
    const onPlay = vi.fn();
    const card = (
      <SourceKindContext.Provider value={new Map([['s1', 'xtream']])}>
        <ChannelCard rail={{ tabIndex: 0, 'data-rail-card': '' }} name="Sport 1" ariaLabel="Play Sport 1" channel={sport} onPlay={onPlay} watchPath="/lists/L1" />
      </SourceKindContext.Provider>
    );
    function ListProbe() {
      return <p>{`list page ${useLocation().pathname}`}</p>;
    }
    renderRoutes(
      [
        { path: '/dashboard', element: card },
        { path: '/lists/:listId', element: <ListProbe /> },
      ],
      '/dashboard',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play Sport 1' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('list page /lists/L1')).toBeTruthy();
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
