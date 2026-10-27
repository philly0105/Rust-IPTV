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

import { defaultStart, EpgGridPage, shortDay } from '../../components/EpgGridPage';
import { preloadScopePickerList } from '../../components/ScopePicker';
import { formatClockBare, formatDay } from '../../lib/epgTime';
import { HeaderSlot, lastHeader } from '../../test/fakes';
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

const GRID = [
  {
    path: '/epg',
    element: (
      <>
        <HeaderSlot />
        <EpgGridPage />
      </>
    ),
  },
];

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
  it('a phone-width page (390 px beside the rail) is one row: the group picker, the time steps, the day and Now (round 4)', async () => {
    pageWidth(318);
    const at = await openGuide();
    expect(screen.getByTestId('epg-grid-page').dataset.guideBar).toBe('phone');
    const time = screen.getByTestId('guide-time');
    // Beside the group picker on one row: the time controls take the room the picker leaves, and
    // a row of their own when they wrap.
    expect(time.className.split(' ')).toEqual(expect.arrayContaining(['grow-[999]', 'min-w-0']));
    expect(time.className).not.toContain('w-full');
    // The pickers' wrapper is `contents`, so the group picker and the time controls share the toolbar's row.
    expect(screen.getByTestId('guide-group').parentElement!.className).toBe('contents');
    expect(screen.getByTestId('guide-group').parentElement!.parentElement).toBe(time.parentElement);
    expect(time.parentElement!.className).toContain('flex-wrap');
    expect(within(time).queryByRole('button', { name: 'Previous day' })).toBeNull();
    expect(within(time).queryByRole('button', { name: 'Next day' })).toBeNull();
    expect(within(time).getByRole('button', { name: '3 hours earlier' })).toBeTruthy();
    expect(within(time).getByRole('button', { name: '3 hours later' })).toBeTruthy();
    const now = within(time).getByRole('button', { name: 'Now' });
    expect(now.className).toContain('shrink-0');
    // The group's name gets the room of its icon.
    expect(screen.getByTestId('guide-group').querySelector('svg:not(.lucide-chevron-down)')).toBeNull();
    // The label names the day ("Today"); the times are on the ruler right under it. The visible
    // day leads its accessible name (WCAG 2.5.3), then the date and times are read out.
    const label = screen.getByTestId('guide-window');
    const dayText = shortDay(at, Date.now(), 'en');
    const day = [...label.querySelectorAll('span')].find((s) => s.firstChild?.nodeType === Node.TEXT_NODE && s.firstChild.textContent === dayText)!;
    expect(day).toBeTruthy();
    expect(day.closest('[aria-hidden]')).toBeNull();
    expect(day.querySelector('.sr-only')!.textContent).toContain(formatClockBare(at, 'en'));
    expect(screen.getByRole('button', { name: new RegExp(`^${dayText}, ${formatDay(at, 'en')} ${formatClockBare(at, 'en')}`) })).toBe(label);
    // The window's start (its AM/PM named once, at the range's end, when both ends share it).
    expect(label.textContent).toContain(`${formatDay(at, 'en')} ${formatClockBare(at, 'en')}`);
    // On a row of its own (the label is a size container) the date shows over the times instead.
    expect(label.className).toContain('@container');
    expect(day.className).toContain('@min-[11rem]:hidden');
    const both = [...label.querySelectorAll('span')].find((s) => s.className.includes('@min-[11rem]:flex'))!;
    expect(both.textContent!.startsWith(`${formatDay(at, 'en')} ${formatClockBare(at, 'en')}`)).toBe(true);
    // Every day is still reachable: the label opens Jump to date and time.
    fireEvent.click(label);
    expect(await screen.findByTestId('guide-jump')).toBeTruthy();
  });

  it("a phone's group name is never cut: the picker is as wide as the name, and a long name pushes the time controls onto a row of their own (round 4)", async () => {
    rpc.handlers['catalog.categories'] = () => [cat('g1', 'US| SPORTS', 20), cat('g2', 'US| SPORTS BACKUP', 20)];
    pageWidth(318);
    renderGuide({ path: `/epg?source=src1&category=g2&at=${defaultStart(Date.now())}`, routes: GRID });
    await screen.findByText('Channel 0');
    const group = screen.getByTestId('guide-group');
    await waitFor(() => expect(group.textContent).toBe('US| SPORTS BACKUP'));
    // fit-content (at most the row) and no flex-basis of 0: the toolbar's flex-wrap moves the time
    // controls under a name that does not fit beside them, instead of shrinking the name.
    expect(group.className.split(' ')).toEqual(expect.arrayContaining(['min-w-fit', 'w-auto', 'grow', 'h-auto']));
    expect(group.className).not.toMatch(/(^| )(flex-1|min-w-0|min-w-24)( |$)/);
    // A name longer than the row wraps onto a second line rather than ending in an ellipsis.
    const name = within(group).getByText('US| SPORTS BACKUP');
    expect(name.className).not.toContain('truncate');
    expect(name.className.split(' ')).toEqual(expect.arrayContaining(['line-clamp-2', 'break-words']));
    // Wider layouts keep their one-line, cut-to-fit trigger.
    cleanup();
    vi.restoreAllMocks();
    pageWidth(1208);
    renderGuide({ path: `/epg?source=src1&category=g2&at=${defaultStart(Date.now())}`, routes: GRID });
    await screen.findByText('Channel 0');
    await waitFor(() => expect(within(screen.getByTestId('guide-group')).getByText('US| SPORTS BACKUP').className).toContain('truncate'));
  });

  it("the guide's search is the header's field at every width, so the toolbar has no search control (round 4)", async () => {
    for (const width of [318, 560, 1208]) {
      vi.restoreAllMocks();
      pageWidth(width);
      await openGuide();
      const toolbar = screen.getByTestId('guide-time').parentElement!;
      expect(within(toolbar).queryByRole('searchbox')).toBeNull();
      expect(within(toolbar).queryByRole('button', { name: 'Search the guide' })).toBeNull();
      const field = within(screen.getByTestId('shell-header')).getByRole('searchbox', { name: 'Search the guide' });
      expect(field.getAttribute('placeholder')).toBe('Search guide');
      // `/` still reaches it (on a phone the header's folded field unfolds as it takes focus).
      fireEvent.keyDown(document.body, { key: '/' });
      expect(document.activeElement).toBe(field);
      cleanup();
    }
  });

  it('with no sources the header still names the guide, with no field to search', async () => {
    rpc.handlers['sources.list'] = () => [];
    renderGuide({ path: '/epg', routes: GRID });
    await screen.findByText('No sources yet');
    await waitFor(() => expect(lastHeader()).toMatchObject({ title: 'TV guide' }));
    expect(lastHeader()!.search).toBeUndefined();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it("a phone's day label says Today, Tomorrow or Yesterday, else the month and day", () => {
    const now = new Date(2026, 9, 27, 10, 40).getTime();
    expect(shortDay(now - 30 * 60_000, now, 'en')).toBe('Today');
    expect(shortDay(now + 24 * 3_600_000, now, 'en')).toBe('Tomorrow');
    expect(shortDay(now - 24 * 3_600_000, now, 'en')).toBe('Yesterday');
    // No wider than those words, so the label keeps its width a day further on.
    expect(shortDay(now + 3 * 24 * 3_600_000, now, 'en')).toBe('Oct 30');
    expect(shortDay(now - 2 * 24 * 3_600_000, now, 'en')).toBe('Oct 25');
    expect(shortDay(now, now, 'de')).toBe('Heute');
  });

  it("a phone's day label is as wide as the widest of Yesterday, Today, Tomorrow, so neither the picker nor the buttons move at midnight (round 4)", async () => {
    pageWidth(318);
    await openGuide();
    const label = screen.getByTestId('guide-window');
    // Hidden copies of each day name share the label's grid cell; the widest sets its width.
    const sizes = [...label.parentElement!.querySelectorAll(':scope > [aria-hidden]')].map((s) => s.textContent);
    expect(sizes).toEqual(expect.arrayContaining(['Yesterday', 'Today', 'Tomorrow']));
    expect(label.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['grid', 'grow']));
  });

  it('shows the source picker only when there is another source to choose', async () => {
    await preloadScopePickerList();
    pageWidth(318);
    await openGuide();
    // One source with channels, on show: no picker of one entry; the group picker shares the time row.
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    expect(screen.getByTestId('guide-group').closest('.grid')).toBeNull();
    cleanup();

    const src = (id: string, name: string) => ({ id, kind: 'm3u', name, channelCount: CHANNELS.length, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
    rpc.handlers['sources.list'] = () => [src('src1', 'Demo'), src('src2', 'Second')];
    // A second spy over the first would call itself.
    vi.restoreAllMocks();
    pageWidth(318);
    await openGuide();
    const picker = screen.getByRole('combobox', { name: 'Source' });
    expect(picker.textContent).toBe('Demo');
    // Two pickers keep a row of their own, side by side, over a full row of time controls.
    expect(picker.closest('.grid')!.className).toContain('grid-cols-2');
    expect(screen.getByTestId('guide-time').className).toContain('w-full');
    // That row has the room for the date over the times, so the label shows both, not "Today" alone.
    const at = defaultStart(Date.now());
    const label = screen.getByTestId('guide-window');
    expect(label.textContent!.startsWith(`${formatDay(at, 'en')} ${formatClockBare(at, 'en')}`)).toBe(true);
    expect(label.textContent).toMatch(/, Jump to date and time$/);
    expect(label.textContent).not.toContain(shortDay(at, Date.now(), 'en'));
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

  it("a phone's genre filter is a picker among the header's actions, so one row of controls leads the grid (round 4)", async () => {
    await preloadScopePickerList();
    localStorage.removeItem('guide.genreFilter');
    pageWidth(318);
    await openGuide();
    // No row of chips, and nothing of the genre filter in the toolbar.
    expect(screen.queryByTestId('guide-genres')).toBeNull();
    expect(within(screen.getByTestId('guide-time').parentElement!).queryByRole('combobox', { name: 'Filter by genre' })).toBeNull();
    const time = await screen.findByTestId('header-actions');
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
    // The group picker starts at 9rem and grows to 12rem with the room the time controls leave,
    // so a touch tablet's 44 px time controls stay on its row instead of wrapping onto their own.
    const group = screen.getByTestId('guide-group');
    expect(group.className.split(' ')).toEqual(expect.arrayContaining(['basis-36', 'grow', 'max-w-48', 'min-w-0']));
    expect(group.className.split(' ')).not.toContain('w-48');
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
