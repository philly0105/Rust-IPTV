/**
 * The Live redesign (stage 2): one channel menu with a header and sections for every channel row
 * (LG-13, LG-16), the group menu with "Add all to list…" (LG-13), Favorites and Recently watched
 * pinned above the groups (LG-12), the scope picker (LG-11), station rows and recent stations on
 * Radio, and the menu's tidy rules and type-ahead.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery } from '@/api/types';
import { useListsDialogs } from '@/features/lists/store';

import { resetChannelListMemory } from '../components/ChannelList';
import { ChannelRow } from '../components/ChannelRow';
import { ContextMenu, tidyEntries, type MenuEntry } from '../components/ContextMenu';
import { LivePage } from '../components/LivePage';
import { preloadScopePickerList, ScopePicker } from '../components/ScopePicker';
import { StageIdle } from '../components/StageIdle';
import { LONG_PRESS_MS } from '../hooks/useLongPress';
import { liveViewOf } from '../hooks/useLiveViewChannels';
import { HOUR, MINUTE } from '../lib/epgTime';
import { i18n, installDomStubs, makeChannel, program, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');
const CHANNELS = Array.from({ length: 20 }, (_, i) => makeChannel(i));

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}
const calls = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const LIVE = [{ path: '/s/:sourceId/live/:categoryId?', element: <LivePage /> }];

vi.setConfig({ testTimeout: 15_000 });
beforeAll(() => {
  configure({ asyncUtilTimeout: 4000 });
  installDomStubs();
});
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', channelCount: 20, movieCount: 0, seriesCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 20, position: 0 }];
  h['catalog.channels'] = serve(CHANNELS);
  const now = Date.now();
  h['epg.nowNext'] = (a) =>
    Object.fromEntries(
      (a as { refs: Channel['ref'][] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, { now: program(`${r.itemId} show`, now - 10 * MINUTE, now + 20 * MINUTE) }]),
    );
  h['epg.programs'] = () => [];
  h['favorites.contains'] = () => [];
  h['favorites.list'] = () => [];
  h['recent.list'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
  h['catalog.items'] = (a) => (a as { refs: Channel['ref'][] }).refs.map((r) => ({ item: makeChannel(Number(r.itemId.slice(1))) }));
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined } as never);
  useListsDialogs.setState({ dialog: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the menu (LG-16)', () => {
  const item = (id: string) => ({ id, label: id, onSelect: vi.fn() });
  const sep = (id: string): MenuEntry => ({ id, type: 'separator' });

  it('folds empty sections: no rule at either end, never two in a row', () => {
    const out = tidyEntries([sep('a'), item('Play'), sep('b'), sep('c'), item('Rename'), sep('d')]);
    expect(out.map((e) => e.id)).toEqual(['Play', 'b', 'Rename']);
    expect(tidyEntries([sep('a'), sep('b')])).toEqual([]);
  });

  it('draws a header, rules between sections, and a letter moves to the next item that starts with it', () => {
    render(
      <ContextMenu
        pos={{ x: 10, y: 10 }}
        label="Channel 1"
        header={{ title: 'Channel 1', subtitle: 'Morning News' }}
        items={[item('Play'), sep('s1'), item('Add to list…'), item('Add to multi-view'), sep('s2'), item('Rename…')]}
        onClose={() => undefined}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'Channel 1' });
    const header = within(menu).getByTestId('context-menu-header');
    expect(header.textContent).toBe('Channel 1Morning News');
    // The header's own rule plus the two section rules.
    expect(within(menu).getAllByRole('separator')).toHaveLength(3);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Play' }));
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Add to list…' }));
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Add to multi-view' }));
  });
});

describe("Live's channel menu (LG-13)", () => {
  it('a row opens the shared menu: the channel and what is on, then Watch, Organize and Channel', async () => {
    renderAt('/s/src1/live', LIVE);
    const row = (await screen.findByText('Channel 2')).closest('[data-row-index]')!.parentElement!;
    await screen.findByText('c2 show');
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole('menu', { name: 'Channel 2' });
    expect(within(menu).getByTestId('context-menu-header').textContent).toContain('c2 show');
    const names = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '—' : el.textContent));
    // The header's rule, Play, then a rule before Organize (favorite, multi-view, lists) and one before Channel.
    expect(names[0]).toBe('—');
    expect(names[1]).toBe('Play');
    const organize = names.indexOf('Add to favorites');
    expect(names[organize - 1]).toBe('—');
    // (This harness loads only the live strings: multi-view's and lists' entries show their keys.)
    expect(names.slice(organize, organize + 3)).toEqual(['Add to favorites', 'menuAdd', 'addToList']);
    expect(names[organize + 3]).toBe('—');
    expect(names).toContain('Match guide channel');
  });

  it('every group has a menu: add the whole group to a list, or open it in the guide', async () => {
    renderAt('/s/src1/live', LIVE);
    const group = await screen.findByRole('link', { name: /^News/ });
    fireEvent.contextMenu(group, { clientX: 20, clientY: 20 });
    const menu = await screen.findByRole('menu', { name: 'News' });
    expect(within(menu).getByRole('menuitem', { name: 'Open in TV guide' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add all to list…' }));
    expect(useListsDialogs.getState().dialog).toEqual({
      kind: 'group',
      group: { sourceId: 'src1', contentType: 'live', categoryId: 'g1', name: 'News', count: 20 },
    });
  });

  it('a touch screen reaches the group menu by a long press or its ⋮ button; the link itself only navigates', async () => {
    renderAt('/s/src1/live', LIVE);
    const group = await screen.findByRole('link', { name: /^News/ });
    // The link navigates: no popup is announced on it. The ⋮ beside it (touch only) has the menu.
    expect(group.hasAttribute('aria-haspopup')).toBe(false);
    const button = screen.getByRole('button', { name: 'Group options' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.className).toContain('pointer-coarse:inline-flex');
    fireEvent.click(button);
    expect(await screen.findByRole('menu', { name: 'News' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'News' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'News' })).toBeNull());

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.pointerDown(group, { pointerType: 'touch', isPrimary: true, clientX: 30, clientY: 40 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.pointerUp(group);
    vi.useRealTimers();
    expect(await screen.findByRole('menu', { name: 'News' })).toBeTruthy();
  });
});

describe('Favorites and Recently watched (LG-12)', () => {
  it('route ids name the pinned views, nothing else', () => {
    expect(liveViewOf('@favorites')).toBe('favorites');
    expect(liveViewOf('@recent')).toBe('recent');
    expect(liveViewOf('g1')).toBeUndefined();
    expect(liveViewOf(undefined)).toBeUndefined();
  });

  it('sit above All channels, and Favorites lists the favorites with what is on, in their order', async () => {
    const fav = (i: number, position: number) => ({ ref: makeChannel(i).ref, position, addedAt: '', snapshot: { title: `Channel ${i}`, contentType: 'live' } });
    rpcMock.handlers['favorites.list'] = () => [fav(9, 1), fav(4, 0), { ...fav(3, 2), ref: { sourceId: 'src1', contentType: 'radio', itemId: 'r3' } }];
    renderAt('/s/src1/live/@favorites', LIVE);
    const nav = await screen.findByRole('navigation', { name: 'Groups' });
    await waitFor(() => expect(within(nav).getAllByRole('link').map((a) => a.textContent).slice(0, 3)).toEqual(['Favorites', 'Recently watched', 'All channels20']));
    expect(within(nav).getByRole('link', { name: 'Favorites' }).getAttribute('aria-current')).toBe('page');

    await screen.findByText('Channel 4');
    const rows = [...document.querySelectorAll('[data-testid="channel-list"] [data-row-index]')].map((el) => el.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Channel 4');
    expect(rows[1]).toContain('Channel 9');
    expect(await screen.findByText('c4 show')).toBeTruthy();
    // The view pages nothing from the source.
    expect(calls('catalog.channels')).toHaveLength(0);
    await waitFor(() => expect(fakes.lastHeader()?.subtitle).toBe('Favorites · 2 channels'));
  });

  it('Recently watched with nothing watched says so', async () => {
    renderAt('/s/src1/live/@recent', LIVE);
    expect(await screen.findByText('Nothing watched yet')).toBeTruthy();
    expect(calls('recent.list')).toContainEqual({ sourceId: 'src1', limit: 100 });
  });

  it("Recently watched marks the zap context for the mini player's Expand, with no group to zap through", async () => {
    renderAt('/s/src1/live/@recent', LIVE);
    await screen.findByText('Nothing watched yet');
    // '@recent' as a categoryId would reach catalog.neighbors and break channel up and down.
    expect(fakes.usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src1', view: 'recent' });
  });
});

describe('the scope picker (LG-11)', () => {
  // The popover's list is its own chunk (SH-10); with it in, the picker opens it at once.
  beforeAll(() => preloadScopePickerList());
  const sections = [
    { id: 'all', options: [{ value: '', label: 'All channels' }] },
    { id: 'groups', heading: 'Groups', options: Array.from({ length: 12 }, (_, i) => ({ value: `g${i}`, label: `Group ${i}`, count: i })) },
  ];

  it('opens from the keyboard on the current choice, filters, and Enter picks', () => {
    const onChange = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ScopePicker label="Group" value="g2" sections={sections} onChange={onChange} />
      </I18nextProvider>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Group' });
    expect(trigger.textContent).toBe('Group 2');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // Twelve groups: a filter field, with focus in it.
    const filter = screen.getByRole('combobox', { name: 'Filter groups' });
    expect(document.activeElement).toBe(filter);
    expect(screen.getByRole('option', { name: /^Group 2/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.change(filter, { target: { value: '11' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Group 1111']);
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('g11');
    expect(document.activeElement).toBe(trigger);
  });

  it('on All channels (an empty value) the arrows still move and Enter picks', () => {
    const onChange = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ScopePicker label="Group" value="" sections={sections} onChange={onChange} />
      </I18nextProvider>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Group' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('option', { name: /^All channels/ }).getAttribute('aria-selected')).toBe('true');
    const filter = screen.getByRole('combobox', { name: 'Filter groups' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-value')).toBe('g1');
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('g1');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // Back to All channels from the keyboard: the empty value is picked as `''`.
    onChange.mockClear();
    cleanup();
    render(
      <I18nextProvider i18n={i18n}>
        <ScopePicker label="Group" value="g3" sections={sections} onChange={onChange} />
      </I18nextProvider>,
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Group' }), { key: 'Enter' });
    const field = screen.getByRole('combobox', { name: 'Filter groups' });
    fireEvent.keyDown(field, { key: 'ArrowUp', metaKey: true });
    expect(screen.getByRole('option', { name: /^All channels/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('on a touch screen it opens without focusing the filter, and its options are touch sized', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as never,
    );
    render(
      <I18nextProvider i18n={i18n}>
        <ScopePicker label="Group" value="" sections={sections} onChange={() => undefined} />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    const list = screen.getByRole('listbox');
    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(screen.getByRole('combobox', { name: 'Filter groups' }));
    for (const o of screen.getAllByRole('option')) expect(o.className).toContain('pointer-coarse:min-h-');
    vi.restoreAllMocks();
  });

  it('Escape clears the filter first, then closes and gives focus back', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ScopePicker label="Group" value="" sections={sections} onChange={() => undefined} />
      </I18nextProvider>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Group' });
    fireEvent.click(trigger);
    const filter = screen.getByRole('combobox', { name: 'Filter groups' });
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.getAllByRole('option')).toHaveLength(13);
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Radio', () => {
  it('station rows keep the show on one line with a larger logo and no progress bar', () => {
    const now = Date.now();
    render(
      <I18nextProvider i18n={i18n}>
        <ChannelRow
          index={0}
          channel={{ ...makeChannel(0), isRadio: true }}
          nowNext={{ now: program('Morning Mix', now - 10 * MINUTE, now + HOUR) }}
          favorite={false}
          playing={false}
          active={false}
          station
          now={now}
          onActivate={() => undefined}
          onToggleFavorite={() => undefined}
          onContextMenu={() => undefined}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('Morning Mix')).toBeTruthy();
    expect(screen.queryByTestId('channel-progress')).toBeNull();
  });

  it("the idle stage offers the other stations played lately, one press each", () => {
    const onPlayRef = vi.fn();
    const entry = (i: number) => ({ ref: { sourceId: 'src1', contentType: 'radio' as const, itemId: `r${i}` }, viewedAt: '', snapshot: { title: `Station ${i}`, contentType: 'radio' as const } });
    render(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="radio" now={Date.now()} last={{ channel: { ...makeChannel(1), isRadio: true } }} onResume={() => undefined} recent={[entry(2), entry(3)]} onPlayRef={onPlayRef} />
      </I18nextProvider>,
    );
    const shelf = screen.getByTestId('stage-recent');
    expect(within(shelf).getByRole('heading', { name: 'Played lately' })).toBeTruthy();
    fireEvent.click(within(shelf).getByRole('button', { name: 'Play Station 3' }));
    expect(onPlayRef).toHaveBeenCalledWith(entry(3).ref);
  });
});

describe('Live stays on its feet with the pinned views', () => {
  it('a typed search narrows Favorites by name', async () => {
    const fav = (i: number, position: number) => ({ ref: makeChannel(i).ref, position, addedAt: '', snapshot: { title: `Channel ${i}`, contentType: 'live' } });
    rpcMock.handlers['favorites.list'] = () => [fav(4, 0), fav(12, 1)];
    renderAt('/s/src1/live/@favorites', LIVE);
    await screen.findByText('Channel 12');
    const search = screen.getByRole('searchbox', { name: 'Search channels' });
    act(() => {
      fireEvent.change(search, { target: { value: '12' } });
    });
    await waitFor(() => expect(screen.queryByText('Channel 4')).toBeNull());
    expect(screen.getByText('Channel 12')).toBeTruthy();
  });
});
