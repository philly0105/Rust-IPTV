/**
 * Audit batch 5 (feature lane): the guide's row menu gets "Match guide channel" and a favorite
 * toggle (F-GUIDE-MENU), the no-data notice points at matching once guides are loaded
 * (F-GUIDE-NOMATCH), the time scale zooms with buttons and Ctrl+scroll, the group select shows
 * favorites or a custom list (F-GUIDE-CONVENIENCES), and a programme opened from outside the guide
 * lands on its row (F-SEARCH-PROGRAMMES).
 */
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, CustomListEntry, FavoriteEntry, ItemRef, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, WHEEL_ZOOM_MS } from '../../components/EpgGridPage';
import { guideHitLink } from '../programmeSearch';
import { GUIDE_ZOOM_SLOT_PX } from '../zoom';
import { createRpcMock, hit, installDomStubs, makeChannel, renderGuide, router, settings } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined, getConnectionState: () => 'closed' }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const CHANNELS = Array.from({ length: 40 }, (_, i) => makeChannel(i));
const cat = (id: string, name: string, itemCount: number): Category => ({ id, sourceId: 'src1', contentType: 'live', name, hidden: false, itemCount, position: 0 });
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  localStorage.clear();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [cat('g1', 'News', CHANNELS.length)];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [key(r), []]));
  h['epg.sources'] = () => [{ url: 'http://x/epg.xml', status: 'ok', programCount: 100, channelCount: 10, enabled: true, origin: 'settings' }];
  h['epg.search'] = () => [];
  h['epg.resolve'] = () => ({ via: 'none' });
  h['epg.channelsSearch'] = () => [];
  h['lists.list'] = () => [{ id: 'l1', name: 'Picks', position: 0, onDashboard: false, itemCount: 3, createdAt: '', updatedAt: '' }];
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

async function openGuide(query = '') {
  renderGuide({ path: `/epg?source=src1&at=${defaultStart(Date.now())}${query}`, routes: GRID });
  await screen.findByTestId('epg-grid');
}

describe('the row menu (F-GUIDE-MENU)', () => {
  const menu = () => screen.getByRole('menu');
  const item = (name: string) => within(menu()).getByRole('menuitem', { name });

  it('adds the row’s channel to favorites, and says so', async () => {
    rpc.handlers['favorites.contains'] = () => [];
    rpc.handlers['favorites.toggle'] = () => ({ isFavorite: true });
    await openGuide();
    fireEvent.contextMenu(await screen.findByText('Channel 2'));
    await waitFor(() => expect(item('Add to favorites').hasAttribute('disabled')).toBe(false));
    fireEvent.click(item('Add to favorites'));
    await waitFor(() => expect(rpc.of('favorites.toggle')).toHaveLength(1));
    expect(rpc.of('favorites.toggle')[0]).toMatchObject({ ref: CHANNELS[2]!.ref, snapshot: { title: 'Channel 2', contentType: 'live' } });
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Added Channel 2 to favorites'));
  });

  it('offers removal for a favorite, and opens guide matching for the row’s channel', async () => {
    rpc.handlers['favorites.contains'] = (a) => (a as { refs: ItemRef[] }).refs;
    await openGuide();
    fireEvent.contextMenu(await screen.findByText('Channel 3'));
    expect(await within(menu()).findByRole('menuitem', { name: 'Remove from favorites' })).toBeTruthy();
    fireEvent.click(item('Match guide channel'));
    expect(await screen.findByRole('dialog', { name: 'Guide data for Channel 3' })).toBeTruthy();
    expect(rpc.of('epg.resolve')).toContainEqual({ ref: CHANNELS[3]!.ref });
  });
});

describe('the no-data notice (F-GUIDE-NOMATCH)', () => {
  it('with guides loaded and no channel matching, points at matching instead of adding an address', async () => {
    await openGuide();
    const notice = await screen.findByTestId('guide-no-data');
    expect(notice.textContent).toContain('None of these channels matches a loaded guide');
    expect(within(notice).queryByRole('link', { name: 'EPG settings' })).toBeNull();
    fireEvent.click(within(notice).getByTestId('guide-no-match-map'));
    expect(await screen.findByRole('dialog', { name: 'Guide data for Channel 0' })).toBeTruthy();
  });

  it('without any guide programmes, still asks for an XMLTV address', async () => {
    rpc.handlers['epg.sources'] = () => [{ url: 'http://x/epg.xml', status: 'ok', programCount: 0, channelCount: 0, enabled: true, origin: 'settings' }];
    await openGuide();
    const notice = await screen.findByTestId('guide-no-data');
    await waitFor(() => expect(notice.textContent).toContain('Add an XMLTV address'));
    expect(within(notice).getByRole('link', { name: 'EPG settings' })).toBeTruthy();
  });
});

describe('zoom (F-GUIDE-CONVENIENCES)', () => {
  const slotWidth = () => (screen.getAllByRole('columnheader')[1] as HTMLElement).style.width;

  it('steps the time scale with the buttons, keeps the step, and zooms with Ctrl+scroll', async () => {
    await openGuide();
    expect(slotWidth()).toBe(`${GUIDE_ZOOM_SLOT_PX[2]}px`);
    fireEvent.click(screen.getByTestId('guide-zoom-in'));
    expect(slotWidth()).toBe(`${GUIDE_ZOOM_SLOT_PX[3]}px`);
    expect(localStorage.getItem('tsrust.guideZoom')).toBe('3');
    fireEvent.click(screen.getByTestId('guide-zoom-in'));
    expect(screen.getByTestId('guide-zoom-in').hasAttribute('disabled')).toBe(true);

    // Ctrl+scroll down zooms out; a burst of wheel events moves one step.
    const grid = screen.getByTestId('epg-grid');
    const wheel = () => {
      const e = new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
      act(() => void grid.dispatchEvent(e));
      return e;
    };
    expect(wheel().defaultPrevented).toBe(true);
    wheel();
    expect(slotWidth()).toBe(`${GUIDE_ZOOM_SLOT_PX[3]}px`);
    await new Promise((r) => setTimeout(r, WHEEL_ZOOM_MS + 20));
    wheel();
    expect(slotWidth()).toBe(`${GUIDE_ZOOM_SLOT_PX[2]}px`);
    // A plain wheel scrolls, as before.
    const plain = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    grid.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);

    // The next visit opens at the step kept.
    cleanup();
    await openGuide();
    expect(slotWidth()).toBe(`${GUIDE_ZOOM_SLOT_PX[2]}px`);
  });
});

describe('favorites and list views (F-GUIDE-CONVENIENCES)', () => {
  const group = () => screen.getByRole('combobox', { name: 'Group' }) as HTMLSelectElement;
  const fav = (ch: Channel, position: number): FavoriteEntry => ({ ref: ch.ref, position, addedAt: '2026-01-01T00:00:00Z', snapshot: { title: ch.name, contentType: 'live' } });
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-channel-row]')].map((el) => el.textContent ?? '');

  it('the group select shows the source’s favorites in favorites order', async () => {
    rpc.handlers['favorites.list'] = () => [fav(CHANNELS[5]!, 1), fav(CHANNELS[7]!, 0), { ...fav(CHANNELS[9]!, 2), ref: { sourceId: 'src1', contentType: 'radio', itemId: 'r9' } }];
    rpc.handlers['catalog.item'] = (a) => CHANNELS.find((c) => c.ref.itemId === (a as { ref: ItemRef }).ref.itemId)!;
    await openGuide();
    expect([...group().options].map((o) => o.text).slice(0, 3)).toEqual(['All channels', 'Favorites', 'List: Picks']);
    fireEvent.change(group(), { target: { value: '@view:favorites' } });
    await waitFor(() => expect(router.location?.search).toContain('view=favorites'));
    expect(rpc.of('favorites.list')).toContainEqual({ sourceId: 'src1' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(rows()[0]).toContain('Channel 7'));
    expect(rows()[1]).toContain('Channel 5');
    expect(group().value).toBe('@view:favorites');

    // A group replaces the view.
    fireEvent.change(group(), { target: { value: 'g1' } });
    await waitFor(() => expect(router.location?.search).toContain('category=g1'));
    expect(router.location?.search).not.toContain('view=');
  });

  it('a custom list shows its live channels of this source, in list order; an empty one says so', async () => {
    const entry = (ch: Channel, position: number): CustomListEntry => ({ ref: ch.ref, snapshot: { title: ch.name, contentType: 'live' }, channel: ch, available: true, position, addedAt: '' });
    const elsewhere = makeChannel(1, 'src2');
    rpc.handlers['lists.items'] = () => [entry(CHANNELS[12]!, 0), entry(elsewhere, 1), { ...entry(CHANNELS[3]!, 2), available: false }, entry(CHANNELS[4]!, 3)];
    await openGuide('&view=list:l1');
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toContain('Channel 12');
    expect(rows()[1]).toContain('Channel 4');
    expect(rpc.of('lists.items')).toEqual([{ id: 'l1' }]);
    // The view pages nothing from the source.
    expect(rpc.of('catalog.channels')).toHaveLength(0);

    cleanup();
    rpc.handlers['lists.items'] = () => [entry(elsewhere, 0)];
    renderGuide({ path: `/epg?source=src1&view=list:l1`, routes: GRID });
    expect(await screen.findByText('No channels from this source in this list')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All channels' }));
    await waitFor(() => expect(router.location?.search).not.toContain('view='));
    expect(await screen.findByText('Channel 0')).toBeTruthy();
  });
});

describe('a programme opened from the global search or the palette (F-SEARCH-PROGRAMMES)', () => {
  it('moves the cursor to the programme’s row and marks it', async () => {
    await openGuide();
    const start = Date.now() + 3_600_000;
    const link = guideHitLink(hit('Late news', start, start + 1_800_000, { ref: CHANNELS[6]!.ref, channelName: 'Channel 6' }));
    expect(link.to).toBe(`/epg?source=src1&at=${start}`);
    act(() => void router.navigate!(link.to, { state: link.state }));
    await waitFor(() => expect(document.querySelector('[data-channel-row="6"]')?.hasAttribute('data-highlighted')).toBe(true));
  });
});
