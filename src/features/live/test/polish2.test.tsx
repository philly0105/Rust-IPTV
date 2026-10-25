/**
 * B3-live, run 20261012: favorites from the list, context menu, group sidebar keyboard and
 * aria-current, drawer focus, search commit on Enter, logo slots, now/next refresh, the
 * group dialog keeping edits, language switch in headers, and a 50k-channel budget.
 * Renders through the app's own query client so `invalidate` (used by the views) reaches it.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { joinList } from '@/shell/dashboard/cards';
import type { Category, Channel, EpgNowNext, Page, PageQuery } from '@/api/types';

import { CategorySidebar } from '../components/CategorySidebar';
import { ACTIVE_SETTLE_MS, ChannelList, resetChannelListMemory } from '../components/ChannelList';
import { CHANNEL_ROW_HEIGHT, ChannelRow } from '../components/ChannelRow';
import { ChannelLogo } from '../components/ChannelLogo';
import { EpgGridPage } from '../components/EpgGridPage';
import { EpgMappingDialog } from '../components/EpgMappingDialog';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage } from '../components/LivePage';
import { cellTextPadPx } from '../guide/GuideRow';
import { ManageCategoriesDialog } from '../components/ManageCategoriesDialog';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { addLocalDays, cellTextMaxPx, floorTo, MINUTE } from '../lib/epgTime';
import { resetStalkerPreviewSources } from '../lib/stalkerPreviewQueue';
import { i18n, installDomStubs, makeChannel, program, settings } from './harness';

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

// Server mode unless a test switches it: external players exist only in the desktop app.
const desktop = vi.hoisted(() => ({ value: false }));
vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return desktop.value;
  },
  // `from` for the error toasts' errorDescription (@/ui), which normalizes what was thrown.
  RpcError: class RpcError extends Error {
    static from(e: unknown) {
      return e instanceof Error ? e : new Error(String(e));
    }
  },
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

function renderIn(path: string, routes: { path: string; element: ReactNode }[]) {
  resetStalkerPreviewSources();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const LIVE = [{ path: '/s/:sourceId/live', element: <LivePage /> }];
const RADIO = [{ path: '/s/:sourceId/radio', element: <LivePage mode="radio" /> }];

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    const needle = q.search?.toLowerCase();
    const hits = needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all;
    return { items: hits.slice(q.offset, q.offset + q.limit), total: hits.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

const cat = (i: number, extra: Partial<Category> = {}): Category => ({
  id: `g${i}`,
  sourceId: 'src1',
  contentType: 'live',
  name: `Group ${i}`,
  hidden: false,
  itemCount: 1,
  position: i,
  ...extra,
});

function baseHandlers(total = 200) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  // C2: controls off unless a test turns them on (the external player and copy link ask the gate).
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [cat(1, { name: 'News', itemCount: total })];
  h['catalog.channels'] = serve(Array.from({ length: total }, (_, i) => makeChannel(i)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
}

const list = () => screen.getByTestId('channel-list');
const rowButton = (i: number) => document.querySelector<HTMLButtonElement>(`[data-testid="channel-list"] [data-row-index="${i}"]`);
const rowStar = (i: number) => rowButton(i)!.parentElement!.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
const calls = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
const toasts = () => (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[1]));

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  baseHandlers();
  resetChannelListMemory();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('favorites from the list', () => {
  it('"s" flips the star at once, sends one toggle for a double press, and Ctrl+S is left alone', async () => {
    let resolve!: (v: { isFavorite: boolean }) => void;
    rpcMock.handlers['favorites.toggle'] = () => new Promise((r) => (resolve = r));
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 's', ctrlKey: true });
    fireEvent.keyDown(document.activeElement!, { key: 's', altKey: true });
    expect(calls('favorites.toggle')).toHaveLength(0);

    fireEvent.keyDown(document.activeElement!, { key: 's' });
    await waitFor(() => expect(rowStar(0).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.keyDown(document.activeElement!, { key: 's' });
    fireEvent.click(rowStar(0));
    expect(calls('favorites.toggle')).toHaveLength(1);

    rpcMock.handlers['favorites.contains'] = () => [makeChannel(0).ref];
    await act(async () => resolve({ isFavorite: true }));
    await waitFor(() => expect(toasts()).toContain('Added Channel 0 to favorites'));
    expect(rowStar(0).getAttribute('aria-pressed')).toBe('true');
  });

  it('a failed toggle puts the star back and says what failed', async () => {
    rpcMock.handlers['favorites.toggle'] = () => Promise.reject(new Error('disk full'));
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    fireEvent.click(rowStar(1));
    await waitFor(() => expect(toasts()).toContain('Could not add the favorite'));
    await waitFor(() => expect(rowStar(1).getAttribute('aria-pressed')).toBe('false'));
  });

  it('a held Enter plays once, not once per key repeat', async () => {
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', repeat: true });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', repeat: true });
    await waitFor(() => expect(fakes.recorded.playItem).toHaveLength(1));
  });
});

describe('context menu', () => {
  it('names the favorite action by the row state and reports a failed removal as a removal', async () => {
    rpcMock.handlers['favorites.contains'] = () => [makeChannel(2).ref];
    rpcMock.handlers['favorites.toggle'] = () => Promise.reject(new Error('nope'));
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 2');
    await waitFor(() => expect(rowStar(2).getAttribute('aria-pressed')).toBe('true'));

    fireEvent.contextMenu(rowButton(2)!.parentElement!, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Add or remove favorite' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from favorites' }));
    await waitFor(() => expect(toasts()).toContain('Could not remove the favorite'));

    fireEvent.contextMenu(rowButton(3)!.parentElement!, { clientX: 40, clientY: 40 });
    expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Add to favorites' })).toBeTruthy();
  });

  it('right-click focuses the row, so Escape in the menu returns there', async () => {
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 4');
    screen.getByRole('searchbox', { name: 'Search channels' }).focus();
    fireEvent.contextMenu(rowButton(4)!.parentElement!, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(within(menu).getAllByRole('menuitem')[0]!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(rowButton(4));
  });
});

describe('search', () => {
  it('Enter before the debounce runs the typed query and lands on its first row', async () => {
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    // The cursor sits on row 5 of the full list; the search result has one row.
    rowButton(0)!.focus();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(rowButton(5)));
    const box = screen.getByRole('searchbox', { name: 'Search channels' });
    box.focus();
    fireEvent.change(box, { target: { value: 'Channel 150' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('1 channel');
    await waitFor(() => expect(document.activeElement).toBe(rowButton(0)));
    expect(rowButton(0)!.textContent).toContain('Channel 150');
  });

  it('typing on after an Enter keeps the committed results instead of flashing the full list', async () => {
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    const box = screen.getByRole('searchbox', { name: 'Search channels' });
    fireEvent.change(box, { target: { value: 'Channel 15' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('11 channels');
    const searches = () => calls('catalog.channels').map((c) => (c.args as { query: PageQuery }).query.search);
    const before = searches().length;
    fireEvent.change(box, { target: { value: 'Channel 150' } });
    await screen.findByText('1 channel');
    expect(searches().slice(before)).not.toContain(undefined);
  });
});

describe('radio', () => {
  it('speaks of stations, and only the open group carries aria-current', async () => {
    rpcMock.handlers['catalog.categories'] = () => [cat(1, { name: 'Pop', contentType: 'radio' }), cat(2, { name: 'Jazz', contentType: 'radio' })];
    rpcMock.handlers['catalog.channels'] = serve([{ ...makeChannel(0), isRadio: true, name: 'Classic FM' }]);
    renderIn('/s/src1/radio?category=g2', RADIO);
    // The row, and its tile on the idle stage's station shelf.
    await within(await screen.findByTestId('channel-list')).findByText('Classic FM');
    expect(screen.getByRole('searchbox', { name: 'Search stations' })).toBeTruthy();
    expect(screen.getByText('1 station')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Groups' });
    await within(nav).findByText('Jazz');
    const current = [...nav.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent);
    expect(current).toEqual([expect.stringContaining('Jazz')]);
  });
});

describe('groups sidebar', () => {
  const sidebar = (cats: Category[], activeId?: string) => (
    <CategorySidebar
      categories={cats}
      hiddenCount={0}
      isLoading={false}
      error={null}
      onRetry={() => undefined}
      activeId={activeId}
      hrefFor={(id) => `/s/src1/live${id ? `/${id}` : ''}`}
      onManage={() => undefined}
      totalLabel="All channels"
    />
  );
  const cats = Array.from({ length: 2000 }, (_, i) => cat(i));

  it('arrow keys move between groups with one tab stop; Home goes to All channels', () => {
    renderIn('/', [{ path: '/', element: sidebar(cats) }]);
    const links = () => [...document.querySelectorAll<HTMLElement>('[data-cat-index]')];
    expect(links().filter((l) => l.tabIndex === 0 && l.dataset.catIndex !== 'all')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Filter groups' }), { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Group 0');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Group 2');
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('Group 1');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement?.textContent).toContain('All channels');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Group 0');
  });

  it('the open group is rendered and is the tab stop even 1500 rows down', async () => {
    renderIn('/', [{ path: '/', element: sidebar(cats, 'g1500') }]);
    const el = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[aria-current="page"]');
      expect(found?.textContent).toContain('Group 1500');
      return found!;
    });
    expect(el.tabIndex).toBe(0);
  });

  it('a playlist that tags its groups by country gets a region picker, kept per source', () => {
    const tagged = ['US| SPORT ᴴᴰ', 'US| NEWS', 'US| NFL PPV', 'UK| SPORT', 'UK| NEWS', 'DE| SPORT', 'Sports misc'].map((name, i) => cat(i, { name }));
    const withScope = (activeId?: string) => (
      <CategorySidebar
        categories={tagged}
        hiddenCount={0}
        isLoading={false}
        error={null}
        onRetry={() => undefined}
        activeId={activeId}
        hrefFor={(id) => `/s/src1/live${id ? `/${id}` : ''}`}
        onManage={() => undefined}
        totalLabel="All channels"
        regionScope="src1:live"
      />
    );
    // A row reads its name, then its channel count.
    const names = () =>
      [...document.querySelectorAll<HTMLElement>('[data-cat-index]')].map((l) => l.textContent?.replace(/\d+$/, '')).filter((n) => n?.includes('|'));
    renderIn('/', [{ path: '/', element: withScope() }]);
    const picker = screen.getByRole('combobox', { name: 'Region' }) as HTMLSelectElement;
    // Most groups first; a tag on one group only (DE) is not offered.
    expect([...picker.options].map((o) => o.textContent)).toEqual(['All regions', 'US · 3', 'UK · 2']);
    fireEvent.change(picker, { target: { value: 'UK' } });
    expect(names()).toEqual(['UK| SPORT', 'UK| NEWS']);
    expect(localStorage.getItem('tsrust.liveRegion:src1:live')).toBe('UK');
    // The filter works inside the region.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter groups' }), { target: { value: 'news' } });
    expect(names()).toEqual(['UK| NEWS']);
    cleanup();

    // Kept for the source; the open group stays listed outside the region.
    renderIn('/', [{ path: '/', element: withScope('g0') }]);
    expect((screen.getByRole('combobox', { name: 'Region' }) as HTMLSelectElement).value).toBe('UK');
    expect(names()).toEqual(['US| SPORT ᴴᴰ', 'UK| SPORT', 'UK| NEWS']);
    localStorage.removeItem('tsrust.liveRegion:src1:live');
    cleanup();

    // Mostly untagged groups: no picker.
    renderIn('/', [{ path: '/', element: sidebar(cats) }]);
    expect(screen.queryByRole('combobox', { name: 'Region' })).toBeNull();
  });

  it('the filter ignores accents and case', () => {
    renderIn('/', [{ path: '/', element: sidebar([cat(1, { name: 'España' }), cat(2, { name: 'Ελλάδα' }), cat(3, { name: 'France' })]) }]);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter groups' }), { target: { value: 'ESPANA' } });
    expect(screen.getByText('España')).toBeTruthy();
    expect(screen.queryByText('France')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter groups' }), { target: { value: 'ελλαδα' } });
    expect(screen.getByText('Ελλάδα')).toBeTruthy();
  });
});

describe('groups drawer below 1024 px', () => {
  it('moves focus in on open, traps Tab, and gives focus back to the toggle on Escape', async () => {
    const narrow = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList,
    );
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    const toggle = screen.getByRole('button', { name: 'Show groups' });
    toggle.focus();
    fireEvent.click(toggle);
    const drawer = await screen.findByTestId('groups-drawer');
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    const focusables = [...drawer.querySelectorAll<HTMLElement>('input, a[href], button:not([disabled])')];
    focusables.at(-1)!.focus();
    fireEvent.keyDown(focusables.at(-1)!, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('groups-drawer')).toBeNull());
    expect(document.activeElement).toBe(toggle);
    narrow.mockRestore();
  });
});

describe('channel logos in reused rows', () => {
  it('a broken logo does not stick to the slot when the row shows another channel', () => {
    const { rerender, container } = render(<ChannelLogo src="https://x/broken.png" name="Alpha One" />);
    // Run 3 C3: the cache route fails first, then the original address is tried once, then the
    // cache route again.
    fireEvent.error(container.querySelector('img')!);
    fireEvent.error(container.querySelector('img')!);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('AO');
    rerender(<ChannelLogo src="https://x/good.png" name="Beta" />);
    // The next channel starts its own chain from the top: the cache route first, resized to the
    // logo's 36 px (the 64 px bucket at 1x, L3-serve-ui-4).
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/img?url=${encodeURIComponent('https://x/good.png')}&w=64`);
  });

  it('logos load at low priority, so the guide RPCs are not queued behind them (XB2-10)', () => {
    const { container } = render(<ChannelLogo src="https://x/logo.png" name="Alpha" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('fetchpriority')).toBe('low');
  });

  it('initials keep whole characters (emoji, astral letters)', () => {
    const { container } = render(<ChannelLogo name="🎵 Music" />);
    expect(container.textContent).toBe('🎵M');
    const { container: c2 } = render(<ChannelLogo name="𝔸𝔹ℂ" />);
    expect(Array.from(c2.textContent ?? '')).toHaveLength(2);
    expect(c2.textContent).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
  });
});

describe('now/next freshness', () => {
  it('asks again once the programme after a gap has started, and only once per clock tick', async () => {
    const t0 = Date.now();
    const answer: Record<string, EpgNowNext> = { 'src1|live|c0': { next: program('Late film', t0 - 60_000, t0 + 3_600_000) } };
    rpcMock.handlers['epg.nowNext'] = () => answer;
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(calls('epg.nowNext').length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(calls('epg.nowNext').length).toBeLessThanOrEqual(3);
  });

  it('a programme with unreadable times shows the group, not a "since 1970" airing bar', async () => {
    rpcMock.handlers['epg.nowNext'] = () => ({ 'src1|live|c0': { now: { channelId: 'c', title: 'Ghost', start: 'garbage', end: new Date(Date.now() + 60_000).toISOString() } } });
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Ghost')).toBeNull();
    expect(rowButton(0)!.textContent).toContain('News');
  });
});

describe('group visibility dialog', () => {
  it('a background refetch keeps the boxes you changed', async () => {
    rpcMock.handlers['catalog.categories'] = () => [cat(1), cat(2)];
    renderIn('/', [{ path: '/', element: <ManageCategoriesDialog open onClose={() => undefined} sourceId="src1" contentType="live" /> }]);
    const box = (name: string) => screen.getByText(name).closest('label')!.querySelector('input')!;
    await screen.findByText('Group 1');
    fireEvent.click(box('Group 1'));
    expect(box('Group 1').checked).toBe(false);
    rpcMock.handlers['catalog.categories'] = () => [cat(1), cat(2), cat(3)];
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await screen.findByText('Group 3');
    expect(box('Group 1').checked).toBe(false);
    expect(box('Group 3').checked).toBe(true);
  });
});

describe('language switch', () => {
  it('the guide page header follows the new language', async () => {
    i18n.addResourceBundle('de', 'live', { guide: 'Programmführer' }, true, true);
    renderIn('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    await waitFor(() => expect(fakes.lastHeader()).toMatchObject({ title: 'TV guide', subtitle: 'Demo portal' }));
    await screen.findByText('Channel 0');
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    await waitFor(() => expect(fakes.lastHeader()?.title).toBe('Programmführer'));
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });
});

describe('ribbon list view across days', () => {
  it('marks the first programme of each local day with its date', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ epgViewMode: 'list' });
    // Pinned clock: 22:00 local, so tomorrow's first programme is inside the ribbon's 12 h window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 12, 22, 0));
    const now = Date.now();
    const m = new Date(2026, 9, 13, 0, 0).getTime();
    rpcMock.handlers['epg.programs'] = () => [
      program('Today', now - 30 * 60_000, now + 30 * 60_000),
      program('Before midnight', m - 60 * 60_000, m),
      program('After midnight', m, m + 60 * 60_000),
    ];
    renderIn('/', [
      {
        path: '/',
        element: <EpgRibbon channel={makeChannel(5)} sourceKind="xtream" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} />,
      },
    ]);
    await screen.findByText('After midnight');
    const days = screen.getAllByTestId('ribbon-list-day');
    expect(days).toHaveLength(1);
    expect(days[0]!.closest('button')!.textContent).toContain('After midnight');
  });
});

describe('Live list: 50k channels (SC: every list stays fast at 50k)', () => {
  // No wall-clock budget: jsdom on a shared, busy machine is too noisy for one. O(n) work shows up
  // as an unbounded DOM or as whole-list queries, which are asserted instead.
  const N = 50_000;

  it('renders, jumps to the end and back, and searches a 50k list with a bounded DOM', async () => {
    const all = Array.from({ length: N }, (_, i) => ({ ...makeChannel(i), name: `${['BBC', 'Sky', 'CNN', 'ESPN', 'قناة'][i % 5]} ${i}` }));
    rpcMock.handlers['catalog.channels'] = serve(all);
    rpcMock.handlers['catalog.categories'] = () => [cat(1, { name: 'All', itemCount: N })];

    renderIn('/s/src1/live', LIVE);
    await screen.findByText('BBC 0');
    expect(screen.getByText('50,000 channels')).toBeTruthy();
    expect(list().querySelectorAll('[role="listitem"]').length).toBeLessThan(60);

    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    Object.defineProperty(list(), 'scrollTop', { configurable: true, value: N * CHANNEL_ROW_HEIGHT - 800, writable: true });
    fireEvent.scroll(list());
    await waitFor(() => expect(rowButton(N - 1)?.textContent ?? '').toContain(`قناة ${N - 1}`));
    expect(list().querySelectorAll('[role="listitem"]').length).toBeLessThan(60);
    // Only the pages around the viewport were asked for.
    for (const c of calls('catalog.channels')) expect((c.args as { query: PageQuery }).query.limit).toBeLessThanOrEqual(120);
    expect(calls('catalog.channels').length).toBeLessThan(12);

    // 50 PageUps (key repeat): the DOM stays bounded and nothing asks for more than a page.
    for (let i = 0; i < 50; i++) fireEvent.keyDown(document.activeElement!, { key: 'PageUp' });
    expect(list().querySelectorAll('[role="listitem"]').length).toBeLessThan(60);
    for (const c of calls('catalog.channels')) expect((c.args as { query: PageQuery }).query.limit).toBeLessThanOrEqual(120);

    const box = screen.getByRole('searchbox', { name: 'Search channels' });
    for (const v of ['ق', 'قن', 'قناة', 'قناة 4999']) fireEvent.change(box, { target: { value: v } });
    const expected = all.filter((c) => c.name.includes('قناة 4999')).length;
    await screen.findByText(`${expected} channels`, undefined, { timeout: 10_000 });
    const searched = calls('catalog.channels')
      .map((c) => (c.args as { query: PageQuery }).query.search)
      .filter(Boolean);
    expect(new Set(searched)).toEqual(new Set(['قناة 4999']));
  });
});

// ---------------------------------------------------------------------------
// Review round 1

describe('ribbon with a guide time offset', () => {
  const HOUR = 60 * MINUTE;
  /** A guide that only answers for the window it is asked about, like the core. */
  const windowed = (all: ReturnType<typeof program>[]) => (a: unknown) => {
    const { from, to } = a as { from: string; to: string };
    return all.filter((p) => Date.parse(p.end) > Date.parse(from) && Date.parse(p.start) < Date.parse(to));
  };
  const ribbon = () => (
    <EpgRibbon channel={makeChannel(5)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} />
  );

  it('+300 min: asks for the window that lands on screen, so the airing show is in the ribbon', async () => {
    const now = Date.now();
    rpcMock.handlers['settings.get'] = () => settings({ epgOffsetMinutes: 300 });
    // Guide time 5 h ago: shown as airing now once shifted by +300.
    rpcMock.handlers['epg.programs'] = windowed([program('Politics Live', now - 5 * HOUR - 20 * MINUTE, now - 5 * HOUR + 33 * MINUTE)]);
    renderIn('/', [{ path: '/', element: ribbon() }]);
    await screen.findByTestId('ribbon-remaining');
    expect(screen.getAllByText('Politics Live').length).toBeGreaterThan(0);
    const asked = calls('epg.programs').at(-1)!.args as { from: string };
    expect(Date.parse(asked.from)).toBe(floorTo(now, 15 * MINUTE) - 3 * HOUR - 300 * MINUTE);
  });

  it('-720 min: future programmes are fetched and shown', async () => {
    const now = Date.now();
    rpcMock.handlers['settings.get'] = () => settings({ epgOffsetMinutes: -720 });
    rpcMock.handlers['epg.programs'] = windowed([
      program('Airing', now + 12 * HOUR - 10 * MINUTE, now + 12 * HOUR + 20 * MINUTE),
      program('Later tonight', now + 12 * HOUR + 2 * HOUR, now + 12 * HOUR + 3 * HOUR),
    ]);
    renderIn('/', [{ path: '/', element: ribbon() }]);
    await waitFor(() => expect(document.querySelector('button[data-when="future"]')).toBeTruthy());
    expect(document.querySelector('button[data-when="now"]')?.getAttribute('aria-label')).toContain('Airing');
  });
});

describe('ribbon live button', () => {
  it('says "Watch live" when nothing plays, "Back to live" only while a catch-up of the channel plays', async () => {
    rpcMock.handlers['epg.programs'] = () => [program('Show', Date.now() - 10 * MINUTE, Date.now() + 10 * MINUTE)];
    renderIn('/s/src1/live', LIVE);
    const btn = await screen.findByTestId('ribbon-back-to-live');
    // With nothing playing it also names the channel it starts (the ribbon follows the cursor).
    expect(btn.getAttribute('aria-label')).toBe('Watch live, Channel 0');
    cleanup();
    // A catch-up of channel 0 is playing (not live): the button takes you back to live.
    fakes.usePlayerStore.setState({
      source: { url: 'x', kind: 'hls', title: 'Channel 0', ref: makeChannel(0).ref, isLive: false, isRadio: false },
    } as never);
    renderIn('/s/src1/live', LIVE);
    await waitFor(() => expect(screen.getByTestId('ribbon-back-to-live').getAttribute('aria-label')).toBe('Back to live'));
  });
});

describe('channel row in RTL', () => {
  // LG-03 took the next programme off the rows (the stage column's Up next has it); the airing
  // programme's line is built the same way and keeps what this protected.
  it('truncates only the programme title, in its own direction, with the time left outside it', () => {
    const now = Date.now();
    const nn: EpgNowNext = {
      now: program('World News Today', now - 10 * MINUTE, now + 20 * MINUTE),
      next: program('الأخبار', now + 20 * MINUTE, now + 80 * MINUTE),
    };
    render(
      <I18nextProvider i18n={i18n}>
        <div dir="rtl">
          <ChannelRow
            index={0}
            channel={{ ...makeChannel(4), name: 'BBC World' }}
            nowNext={nn}
            favorite={false}
            playing={false}
            active
            now={now}
            onActivate={() => undefined}
            onToggleFavorite={() => undefined}
            onContextMenu={() => undefined}
          />
        </div>
      </I18nextProvider>,
    );
    const title = screen.getByTestId('row-now-title');
    expect(title.textContent).toBe('World News Today');
    expect(title.getAttribute('dir')).toBe('auto');
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('min-w-0');
    // The time left is a sibling, not inside the truncating span.
    const line = screen.getByTestId('row-now');
    expect(line.className).not.toContain('truncate');
    expect(line.textContent).not.toBe(title.textContent);
    expect(screen.getByText('BBC World').getAttribute('dir')).toBe('auto');
    // Three lines: no next-programme line.
    expect(screen.queryByText('الأخبار')).toBeNull();
  });
});

describe('Live list: fast keys on 50k channels', () => {
  it('no keystroke is lost and nothing loops when arrows and PageDown arrive faster than renders', async () => {
    const N = 50_000;
    rpcMock.handlers['catalog.channels'] = serve(Array.from({ length: N }, (_, i) => makeChannel(i)));
    rpcMock.handlers['catalog.categories'] = () => [cat(1, { name: 'All', itemCount: N })];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    const page = Math.max(1, Math.floor(list().clientHeight / CHANNEL_ROW_HEIGHT) - 1);
    // Dispatched back to back, outside act: React has not re-rendered between these.
    const send = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    // Kept inside the rows jsdom renders (it does not scroll): 10 down, 2 pages down.
    for (let i = 0; i < 10; i++) send('ArrowDown');
    for (let i = 0; i < 2; i++) send('PageDown');
    const expected = 10 + 2 * page;
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe(String(expected)));
    const loops = errors.mock.calls.filter((c) => /Maximum update depth|#185/.test(String(c[0])));
    expect(loops).toEqual([]);
  });
});

describe('guide grid', () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it('the day buttons move a calendar day: the window keeps its wall-clock time across the DST change', async () => {
    process.env.TZ = 'Europe/London';
    vi.useFakeTimers({ toFake: ['Date'] });
    // Saturday evening before the clocks go back (Sun 25 Oct 2026, 02:00 BST -> 01:00 GMT).
    vi.setSystemTime(new Date(2026, 9, 24, 20, 10));
    rpcMock.handlers['epg.grid'] = () => ({});
    renderIn('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    await screen.findByText('Channel 0');
    const froms = () => calls('epg.grid').map((c) => Date.parse((c.args as { from: string }).from));
    await waitFor(() => expect(froms().length).toBeGreaterThan(0));
    const first = froms().at(-1)!;
    expect(new Date(first).getHours()).toBe(19);
    expect(new Date(first).getMinutes()).toBe(30);

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(froms().at(-1)).not.toBe(first));
    const next = froms().at(-1)!;
    expect(next).toBe(addLocalDays(first, 1));
    expect(new Date(next).getHours()).toBe(19);
    expect(next - first).toBe(25 * 60 * MINUTE);

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    await waitFor(() => expect(froms().at(-1)).toBe(addLocalDays(first, -1)));
    expect(new Date(froms().at(-1)!).getHours()).toBe(19);
  });

  it('a show that began before the visible edge keeps its title on screen, and the filters are the kit Select', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = (a) =>
      Object.fromEntries(
        (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs.map((r) => [
          `${r.sourceId}|${r.contentType}|${r.itemId}`,
          [program('Breakfast Briefing', now - 3 * 60 * MINUTE, now + 30 * MINUTE)],
        ]),
      );
    renderIn('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cells = await screen.findAllByRole('button', { name: /Breakfast Briefing/ });
    const cell = cells[0]!;
    const text = within(cell).getByTestId('cell-text');
    // The title sticks at the visible edge (position: sticky, L3-perf-ui-4), narrowed to the
    // part of the cell that is on screen so it ends in an ellipsis there.
    expect(text.className).toContain('sticky');
    expect(parseFloat(text.style.maxWidth)).toBeGreaterThan(0);
    // The source picker (LG-11): same accessible name, with a chevron like the kit Select's.
    const source = screen.getByRole('combobox', { name: 'Source' });
    expect(source.querySelector('svg.lucide-chevron-down')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Review round 2

describe('Live list: keys survive row recycling (round 2)', () => {
  const fakePaged = (total: number): PagedChannels => ({
    total,
    getChannel: (i) => (i >= 0 && i < total ? makeChannel(i) : undefined),
    getNowNext: () => undefined,
    isFavorite: () => false,
    setVisibleRange: () => undefined,
    isLoading: false,
    refreshing: false,
    error: null,
    retry: () => undefined,
    loaded: [],
    pageSize: 120,
    guideUnavailable: false,
    retryGuide: () => undefined,
  });

  it('the parent hears about the cursor once, after it settles, not once per key', async () => {
    const onActiveChange = vi.fn();
    const paged = fakePaged(200);
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <ChannelList
            paged={paged}
            resetKey="k"
            openOnDoubleClick={false}
            now={Date.now()}
            onPlay={() => undefined}
            onToggleFavorite={() => undefined}
            onContextMenu={() => undefined}
            onActiveChange={onActiveChange}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    rowButton(0)!.focus();
    const send = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) {
      send('ArrowDown');
      await act(async () => undefined); // let each key commit, like a real key repeat
    }
    // Each key committed, but none of them told the parent (a parent update per key was #185).
    expect(document.activeElement?.getAttribute('data-row-index')).toBe('10');
    expect(onActiveChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onActiveChange).toHaveBeenCalledTimes(1));
    expect((onActiveChange.mock.calls[0]![0] as Channel).name).toBe('Channel 10');
    await new Promise((r) => setTimeout(r, ACTIVE_SETTLE_MS + 50));
    expect(onActiveChange).toHaveBeenCalledTimes(1);
  });

  it('a key onto a row that is still loading keeps focus in the list, and focus lands on the row once it loads', async () => {
    const all = Array.from({ length: 200 }, (_, i) => makeChannel(i));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const page = serve(all);
    // The second page (rows 120-199) answers only when released.
    rpcMock.handlers['catalog.channels'] = async (a) => {
      if ((a as { query: PageQuery }).query.offset >= 120) await gate;
      return page(a);
    };
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    // Row 199 has no button yet: the list holds focus instead of <body>, and still takes keys.
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(list());
    Object.defineProperty(list(), 'scrollTop', { configurable: true, value: 200 * CHANNEL_ROW_HEIGHT - 800, writable: true });
    fireEvent.scroll(list());
    await waitFor(() => expect(calls('catalog.channels').some((c) => (c.args as { query: PageQuery }).query.offset === 120)).toBe(true));
    expect(document.activeElement).toBe(list());
    release();
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe('198'));
  });
});

describe('guide grid (round 2)', () => {
  const grid = () => screen.getByTestId('epg-grid');

  it('cell text padding follows the scroll: past the channel column, never past the cell', () => {
    // A cell 100 px into the track, 300 px wide: text starts at left + 10, so it is padded by scroll - 102,
    // and keeps at least 48 px of text (300 - 20 - 48 = 232 max).
    expect(cellTextPadPx(200, 100, 300)).toBe(98);
    expect(cellTextPadPx(1000, 100, 300)).toBe(232);
    // A cell too narrow to keep 48 px is never padded.
    expect(cellTextPadPx(500, 0, 60)).toBe(0);
  });

  it('the grid fits the clipped cell to its inline-start scroll distance, in LTR and RTL, with no inherited variable', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = (a) =>
      Object.fromEntries(
        (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs.map((r) => [
          `${r.sourceId}|${r.contentType}|${r.itemId}`,
          [program('Breakfast Briefing', now - 3 * 60 * MINUTE, now + 30 * MINUTE)],
        ]),
      );
    renderIn('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cells = await screen.findAllByRole('button', { name: /Breakfast Briefing/ });
    const text = within(cells[0]!).getByTestId('cell-text');
    // Sticky again (L3-perf-ui-4): padding the text moved it in layout, a shift on every scroll
    // frame. The text is capped instead, so the sticky text has room to move inside its cell.
    expect(text.className).toContain('sticky');
    // RTL scrollers report negative scrollLeft: the cap follows the distance from the inline start.
    Object.defineProperty(grid(), 'scrollLeft', { configurable: true, value: -420, writable: true });
    fireEvent.scroll(grid());
    expect(text.style.maxWidth).toBe(`${cellTextMaxPx(420, Number(text.dataset.padLeft), Number(text.dataset.padWidth))}px`);
    expect(text.style.paddingInlineStart).toBe('');
    // Cells are fitted one by one: the grid publishes no variable every cell would inherit (L2-guide-library-2).
    expect(grid().style.getPropertyValue('--grid-scroll')).toBe('');
  });

  it('PageDown onto a row that is not rendered yet keeps focus on the grid, then lands on the row', async () => {
    rpcMock.handlers['epg.grid'] = () => ({});
    renderIn('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    await screen.findByText('Channel 0');
    const first = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="epg-grid"] [data-channel-row="0"]');
      expect(el).toBeTruthy();
      return el!;
    });
    first.focus();
    const send = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    // Back to back, outside act: four PageDowns to row 32, past the rows jsdom renders.
    for (let i = 0; i < 4; i++) send('PageDown');
    await waitFor(() => expect(document.activeElement).toBe(grid()));
    expect(document.querySelector('[data-testid="epg-grid"] [data-channel-row="32"]')).toBeNull();
    // Keys still land while the grid holds focus.
    send('PageDown');
    expect(document.activeElement).toBe(grid());
    Object.defineProperty(grid(), 'scrollTop', { configurable: true, value: 36 * 56, writable: true });
    fireEvent.scroll(grid());
    await waitFor(() => expect(document.activeElement?.getAttribute('data-channel-row')).toBe('40'));
  });

  it('the programme popover joins channel and time with the locale separator, not a middle dot', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = (a) =>
      Object.fromEntries(
        (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs.map((r) => [
          `${r.sourceId}|${r.contentType}|${r.itemId}`,
          [program('Breakfast Briefing', now - 10 * MINUTE, now + 30 * MINUTE)],
        ]),
      );
    renderIn('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cells = await screen.findAllByRole('button', { name: /Breakfast Briefing/ });
    fireEvent.click(cells[0]!);
    const pop = await screen.findByTestId('program-popover');
    expect(pop.textContent).not.toContain('·');
    // joinList: each part bidi-isolated, joined by the locale's separator (", " in English).
    expect(pop.querySelector('p')!.textContent).toMatch(/^⁨Channel 0⁩, ⁨.+⁩$/);
  });
});

describe('epg mapping dialog (round 2)', () => {
  it('joins guide channel id and host with the locale separator, not a middle dot', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [
      { channelId: 'bbc.one.uk', displayName: 'BBC One', epgUrl: 'http://guide.example.com/xmltv.xml' },
    ];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'none' });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <EpgMappingDialog channel={makeChannel(1)} onClose={() => undefined} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const name = await screen.findByText('BBC One');
    const meta = name.nextElementSibling!;
    expect(meta.textContent).toBe(joinList(['bbc.one.uk', 'guide.example.com'], 'en'));
    expect(meta.textContent).not.toContain('·');
  });
});

describe('epg mapping dialog: the channel\'s own time shift', () => {
  it('shows the saved shift, refuses a bad one, and saves a new one (blank clears it)', async () => {
    rpcMock.handlers['epg.channelsSearch'] = () => [];
    rpcMock.handlers['epg.resolve'] = () => ({ via: 'item', epgChannelId: 'one.uk', shiftMinutes: 60 });
    rpcMock.handlers['epg.setChannelShift'] = () => null;
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <EpgMappingDialog channel={makeChannel(1)} onClose={() => undefined} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const input = await screen.findByTestId('epg-mapping-shift');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('60'));
    const save = screen.getByRole('button', { name: 'Save shift' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(screen.getByRole('alert').textContent).toContain('-720 and 720');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(rpcMock.calls).toContainEqual({ cmd: 'epg.setChannelShift', args: { ref: makeChannel(1).ref, minutes: null } }),
    );
  });
});

describe('Live context menu: Copy stream address (round 2)', () => {
  const openMenu = async (row: number) => {
    // The row, not its text: once the cursor settles on the row, the guide ribbon shows the same name.
    await waitFor(() => expect(rowButton(row)).toBeTruthy());
    fireEvent.contextMenu(rowButton(row)!.parentElement!, { clientX: 40, clientY: 40 });
    return screen.findByRole('menu');
  };
  const asM3u = (url: (i: number) => string) => {
    rpcMock.handlers['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Playlist', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
    rpcMock.handlers['catalog.channels'] = serve(Array.from({ length: 50 }, (_, i) => ({ ...makeChannel(i), url: url(i) })));
  };

  it('is not offered for an Xtream source: its stream links carry the username and password', async () => {
    rpcMock.handlers['catalog.channels'] = serve(
      Array.from({ length: 50 }, (_, i) => ({ ...makeChannel(i), url: `http://panel.example.com:8080/live/alice/s3cret/${100 + i}.ts` })),
    );
    renderIn('/s/src1/live', LIVE);
    const menu = await openMenu(2);
    expect(within(menu).getByRole('menuitem', { name: 'Match guide channel' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Copy stream address' })).toBeNull();
  });

  it('is not offered for a playlist link with a login in it', async () => {
    asM3u((i) => `http://iptv.example.com/get/bob/hunter2/${200 + i}`);
    renderIn('/s/src1/live', LIVE);
    const menu = await openMenu(3);
    expect(within(menu).queryByRole('menuitem', { name: 'Copy stream address' })).toBeNull();
  });

  it('copies a plain playlist link', async () => {
    asM3u((i) => `https://cdn.example.com/hls/channel${i}.m3u8`);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderIn('/s/src1/live', LIVE);
    const menu = await openMenu(4);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy stream address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://cdn.example.com/hls/channel4.m3u8'));
  });

  it('asks the parental gate first: a locked channel (Ask mode) is neither copied nor opened externally', async () => {
    asM3u((i) => `https://cdn.example.com/hls/channel${i}.m3u8`);
    rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpcMock.handlers['parental.check'] = (a) => (a as { items: { ref: unknown }[] }).items.map((i) => i.ref);
    rpcMock.handlers['player.openExternal'] = () => ({ pid: 1 });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderIn('/s/src1/live', LIVE);
    let menu = await openMenu(4);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy stream address' }));
    // No PIN dialog host is mounted here, so the gate refuses (as a cancelled PIN prompt does).
    await waitFor(() => expect(calls('parental.check')).toHaveLength(1));
    expect(calls('parental.check')[0]!.args).toEqual({ items: [{ ref: makeChannel(4).ref, categoryId: 'g1' }] });
    desktop.value = true;
    try {
      menu = await openMenu(4);
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Play in MPV' }));
      await waitFor(() => expect(calls('parental.check')).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 50));
      expect(writeText).not.toHaveBeenCalled();
      expect(calls('player.openExternal')).toHaveLength(0);
    } finally {
      desktop.value = false;
    }
  });

  it('offers Play in MPV and VLC only in the desktop app (L1-visual-9)', async () => {
    asM3u((i) => `https://cdn.example.com/hls/channel${i}.m3u8`);
    renderIn('/s/src1/live', LIVE);
    const menu = await openMenu(4);
    // Server mode: the core answers `unsupported` for external players, so they are not offered.
    expect(within(menu).queryByRole('menuitem', { name: 'Play in MPV' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Play in VLC' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Play' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Review round 3

describe('guide ribbon follows the list it came from (round 3)', () => {
  const askedRibbonFor = () => calls('epg.programs').map((c) => (c.args as { ref: { sourceId: string; itemId: string } }).ref);
  const restOn = async (row: number) => {
    rowButton(0)!.focus();
    for (let i = 0; i < row; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(askedRibbonFor().some((r) => r.itemId === `c${row}`)).toBe(true));
    // The idle card and the ribbon follow the cursor together; the card's Play starts it, so the
    // ribbon leaves its own Watch live out.
    await waitFor(() => expect(screen.getByTestId('ribbon-header').textContent).toContain(`Channel ${row}`));
    expect(screen.getByTestId('stage-idle-caption').textContent).toBe('Highlighted');
    expect(screen.getByTestId('stage-resume').textContent).toContain(`Play Channel ${row}`);
    expect(screen.queryByTestId('ribbon-back-to-live')).toBeNull();
  };

  it('a search with no results clears the ribbon instead of keeping the old channel and its Watch live', async () => {
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 2');
    await restOn(2);
    const box = screen.getByRole('searchbox', { name: 'Search channels' });
    fireEvent.change(box, { target: { value: 'zzzznomatch' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('No channels match "zzzznomatch"');
    expect(screen.queryByTestId('ribbon-back-to-live')).toBeNull();
    expect(screen.getByText('Pick a channel to see what is on')).toBeTruthy();
  });

  it('a source switch drops the old ribbon at once, and Watch live then plays the new source with its own kind', async () => {
    const h = rpcMock.handlers;
    h['sources.get'] = (a) => {
      const id = (a as { id: string }).id;
      return { id, kind: id === 'src2' ? 'm3u' : 'xtream', name: id, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };
    };
    const lists = {
      src1: Array.from({ length: 30 }, (_, i) => makeChannel(i)),
      src2: Array.from({ length: 30 }, (_, i) => ({ ...makeChannel(i, 'src2'), name: `Second ${i}`, url: `https://cdn.example.com/${i}.m3u8` })),
    };
    h['catalog.channels'] = (a) => serve(lists[(a as { sourceId: 'src1' | 'src2' }).sourceId])(a);
    let go: (to: string) => void = () => undefined;
    function Nav() {
      go = useNavigate();
      return null;
    }
    renderIn('/s/src1/live', [{ path: '/s/:sourceId/live', element: (<><Nav /><LivePage /></>) }]);
    await screen.findByText('Channel 2');
    await restOn(2);

    act(() => go('/s/src2/live'));
    // Same render as the switch: no channel of src1 is left for Watch live to play as an M3U item.
    expect(screen.queryByTestId('ribbon-back-to-live')).toBeNull();
    await screen.findByText('Second 0');
    fireEvent.click(await screen.findByTestId('ribbon-back-to-live'));
    await waitFor(() => expect(fakes.recorded.playItem.length).toBe(1));
    const played = fakes.recorded.playItem[0]!;
    expect(played.ref.sourceId).toBe('src2');
    expect(played.sourceKind).toBe('m3u');
  });
});

describe('list click: the row goes to the player (XB2-12)', () => {
  it('passes the channel row, url included, and sends no catalog.item for the playing channel', async () => {
    rpcMock.handlers['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Playlist', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
    rpcMock.handlers['catalog.channels'] = serve(Array.from({ length: 30 }, (_, i) => ({ ...makeChannel(i), url: `https://cdn.example.com/${i}.m3u8` })));
    renderIn('/s/src1/live', LIVE);
    await screen.findByText('Channel 3');
    fireEvent.click(rowButton(3)!);
    await waitFor(() => expect(fakes.recorded.playItem).toHaveLength(1));
    const played = fakes.recorded.playItem[0]!;
    // resolveSource plays an M3U channel from this row instead of asking the catalog for it.
    expect(played.channel).toMatchObject({ ref: makeChannel(3).ref, url: 'https://cdn.example.com/3.m3u8' });
    // The page's playing-channel lookup finds the row in the cache.
    await waitFor(() => expect(fakes.usePlayerStore.getState().source?.ref).toEqual(makeChannel(3).ref));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(calls('catalog.item')).toHaveLength(0);
  });
});
