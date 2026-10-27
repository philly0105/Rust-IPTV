/**
 * EpgGridPage review round 1 fixes: the toolbar at narrow page widths (the time controls on a
 * row of their own, the window label stacked, the day buttons dropped on a phone, Now kept), and
 * the channel row menu (C2): right click or the context-menu key / Shift+F10 opens the Live page's
 * channel entries, including Rename and Hide.
 */
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, Page, PageQuery } from '@/api/types';
import { registerRenameHost, useRenameStore } from '@/features/channeledit/store';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage } from '../../components/EpgGridPage';
import { preloadScopePickerList } from '../../components/ScopePicker';
import { formatClockBare, formatDay } from '../../lib/epgTime';
import { createRpcMock, installDomStubs, makeChannel, renderGuide, settings } from './harness';

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

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [cat('g1', 'News', CHANNELS.length)];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: Channel['ref'][] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, []]));
  h['epg.sources'] = () => [{ url: 'http://x/epg.xml', status: 'ok', programCount: 100, channelCount: 10, enabled: true, origin: 'settings' }];
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

/** jsdom has no layout: give the guide page a width (the rest keep jsdom's empty boxes). */
function pageWidth(width: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'epg-grid-page' ? new DOMRect(72, 0, width, 844) : original.call(this);
  });
}

async function openGuide(at = defaultStart(Date.now())) {
  renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
  await screen.findByText('Channel 0');
  return at;
}

describe('the toolbar at narrow widths', () => {
  it('a phone-width page (390 px beside the rail) keeps Now and the window label, and drops the day buttons', async () => {
    pageWidth(318);
    const at = await openGuide();
    expect(screen.getByTestId('epg-grid-page').dataset.guideBar).toBe('phone');
    const time = screen.getByTestId('guide-time');
    // Its own full-width row, not pushed to the end of the search row.
    expect(time.className).toContain('w-full');
    expect(time.className).not.toContain('ms-auto');
    expect(within(time).queryByRole('button', { name: 'Previous day' })).toBeNull();
    expect(within(time).queryByRole('button', { name: 'Next day' })).toBeNull();
    expect(within(time).getByRole('button', { name: '3 hours earlier' })).toBeTruthy();
    expect(within(time).getByRole('button', { name: '3 hours later' })).toBeTruthy();
    const now = within(time).getByRole('button', { name: 'Now' });
    expect(now.className).toContain('shrink-0');
    // The label grows into the row and truncates its lines instead of overflowing an h-8 box;
    // what it says (and announces) is unchanged.
    const label = screen.getByTestId('guide-window');
    expect(label.className).toContain('flex-1');
    expect(label.className).toContain('min-w-0');
    // The window's start (its AM/PM named once, at the range's end, when both ends share it).
    expect(label.textContent).toContain(`${formatDay(at, 'en')} ${formatClockBare(at, 'en')}`);
    expect(label.querySelectorAll('.truncate')).toHaveLength(2);
    // Every day is still reachable: the label opens Jump to date and time.
    fireEvent.click(label);
    expect(await screen.findByTestId('guide-jump')).toBeTruthy();
  });

  it('a phone folds the search into a button on the pickers row, which unfolds over the row and folds back once empty', async () => {
    pageWidth(318);
    await openGuide();
    // Two rows of controls before the grid, not three: no field of its own.
    expect(screen.queryByRole('searchbox', { name: 'Search the guide' })).toBeNull();
    const toggle = screen.getByTestId('guide-search-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Search the guide');
    expect(toggle.closest('.grid')).toBe(screen.getByTestId('guide-group').closest('.grid'));
    fireEvent.click(toggle);
    const field = await screen.findByRole('searchbox', { name: 'Search the guide' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByTestId('guide-search-unfolded').className).toContain('absolute');
    // Escape in the empty field folds it back, and focus returns to the button.
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('searchbox', { name: 'Search the guide' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('guide-search-toggle')));
  });

  it('shows the source picker only when there is another source to choose', async () => {
    await preloadScopePickerList();
    pageWidth(318);
    await openGuide();
    // One source with channels, on show: no picker of one entry; the group picker takes the phone's row.
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    expect(screen.getByTestId('guide-group').closest('.grid')!.className).toContain('grid-cols-[1fr_auto]');
    cleanup();

    const src = (id: string, name: string) => ({ id, kind: 'm3u', name, channelCount: CHANNELS.length, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
    rpc.handlers['sources.list'] = () => [src('src1', 'Demo'), src('src2', 'Second')];
    // A second spy over the first would call itself.
    vi.restoreAllMocks();
    pageWidth(318);
    await openGuide();
    const picker = screen.getByRole('combobox', { name: 'Source' });
    expect(picker.textContent).toBe('Demo');
    expect(picker.closest('.grid')!.className).toContain('grid-cols-[1fr_1fr_auto]');
    fireEvent.click(picker);
    expect(await screen.findByRole('option', { name: /^Second/ })).toBeTruthy();
  });

  it("the genre chips' row fades out at its end, so a chip cut at the edge reads as more to come", async () => {
    pageWidth(560);
    await openGuide();
    const chips = within(screen.getByTestId('guide-genres')).getByRole('group');
    expect(chips.className).toContain('overflow-x-auto');
    expect(chips.className).toContain('[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]');
  });

  it('a phone puts the genre filter on the time row as a picker, so two rows of controls lead the grid (review round 2)', async () => {
    await preloadScopePickerList();
    localStorage.removeItem('guide.genreFilter');
    pageWidth(318);
    await openGuide();
    // No row of chips: the picker ends the time row.
    expect(screen.queryByTestId('guide-genres')).toBeNull();
    const time = screen.getByTestId('guide-time');
    const picker = within(time).getByRole('combobox', { name: 'Filter by genre' });
    expect(picker.textContent).toBe('All genres');
    expect(picker.className).not.toContain('bg-fg');
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'Sports' }));
    // Chosen: the trigger names the genre and is inverted, as a chosen chip is.
    await waitFor(() => expect(within(time).getByRole('combobox', { name: 'Filter by genre' }).textContent).toBe('Sports'));
    expect(within(time).getByRole('combobox', { name: 'Filter by genre' }).className).toContain('bg-fg');
    expect(localStorage.getItem('guide.genreFilter')).toBe('sports');
    fireEvent.click(within(time).getByRole('combobox', { name: 'Filter by genre' }));
    fireEvent.click(await screen.findByRole('option', { name: 'All genres' }));
    await waitFor(() => expect(localStorage.getItem('guide.genreFilter')).toBeNull());
  });

  it('a narrow page stacks the controls but keeps the day buttons', async () => {
    pageWidth(560);
    await openGuide();
    expect(screen.getByTestId('epg-grid-page').dataset.guideBar).toBe('stacked');
    const time = screen.getByTestId('guide-time');
    expect(within(time).getByRole('button', { name: 'Previous day' })).toBeTruthy();
    expect(within(time).getByRole('button', { name: 'Next day' })).toBeTruthy();
    expect(within(time).getByRole('button', { name: 'Now' })).toBeTruthy();
  });

  it('a wide page keeps the one-row toolbar', async () => {
    pageWidth(1208);
    await openGuide();
    expect(screen.getByTestId('epg-grid-page').dataset.guideBar).toBe('full');
    const time = screen.getByTestId('guide-time');
    expect(time.className).toContain('ms-auto');
    expect(screen.getByTestId('guide-window').className).toContain('whitespace-nowrap');
    expect(within(time).getByRole('button', { name: 'Next day' })).toBeTruthy();
  });
});

describe('the channel row menu (C2)', () => {
  const menu = () => screen.getByRole('menu');
  const item = (name: string) => within(menu()).getByRole('menuitem', { name });

  it('right click on a row offers play, multi-view, lists, rename and hide, with no key hints the guide does not bind', async () => {
    await openGuide();
    fireEvent.contextMenu(screen.getByText('Channel 2'));
    expect(menu().getAttribute('aria-label')).toBe('Channel 2');
    for (const name of ['Play', 'Add to multi-view', 'Add to list…', 'Rename…', 'Hide channel']) expect(item(name)).toBeTruthy();
    expect(menu().textContent).not.toContain('F2');
    expect(menu().textContent).not.toMatch(/Shift/i);
  });

  it('Rename… opens the rename dialog for that row’s channel', async () => {
    const unregister = registerRenameHost();
    try {
      await openGuide();
      fireEvent.contextMenu(screen.getByText('Channel 3'));
      fireEvent.click(item('Rename…'));
      expect(useRenameStore.getState().request?.channel.ref).toEqual(CHANNELS[3]!.ref);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      unregister();
    }
  });

  it('Hide channel hides that row’s channel through channels.setHidden', async () => {
    rpc.handlers['channels.setHidden'] = () => null;
    await openGuide();
    fireEvent.contextMenu(screen.getByText('Channel 4'));
    fireEvent.click(item('Hide channel'));
    await waitFor(() => expect(rpc.of('channels.setHidden')).toEqual([{ refs: [CHANNELS[4]!.ref], hidden: true }]));
  });

  it('the context-menu key and Shift+F10 open the cursor row’s menu from the keyboard; Escape closes it', async () => {
    await openGuide();
    const grid = screen.getByTestId('epg-grid');
    fireEvent.keyDown(grid, { key: 'ContextMenu' });
    expect(menu().getAttribute('aria-label')).toBe('Channel 0');
    expect(item('Rename…')).toBeTruthy();
    fireEvent.keyDown(menu(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
    expect(menu().getAttribute('aria-label')).toBe('Channel 1');
  });
});
