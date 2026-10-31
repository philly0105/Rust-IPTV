import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { CHANNEL_PAGE_SIZE, channelPageArgs } from '@/api/bootPrefetch';
import { rpcKey } from '@/api/query';
import { DEFAULT_SETTINGS, type Channel, type ItemRef } from '@/api/types';
import { MAX_ACTIVE, resetImageGate } from '@/ui/imageGate';

// L3-player-6: the fullscreen channel panel opens on the playing channel and walks by keyboard.

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  return { handlers, calls };
});

vi.mock('@/api/transport', () => {
  const call = async (cmd: string, args?: unknown) => {
    rpcMock.calls.push({ cmd, args });
    // Playing a channel asks for more than the panel does: those answers are empty.
    return rpcMock.handlers[cmd]?.(args);
  };
  class RpcError extends Error {}
  return { rpc: call, rpcRaw: call, RpcError, isDesktop: false, proxiedUrl: (s: { url: string }) => s.url };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// Unchanged; each call is one row's name rendering, so the calls count row renders.
vi.mock('@/features/live/components/ChannelLogo', async (orig) => {
  const real = await orig<typeof import('@/features/live/components/ChannelLogo')>();
  return { ...real, ChannelName: vi.fn(real.ChannelName) };
});

const { usePlayerStore, __resetPlayerForTests, setSettingsCache } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { __resetZapBannerForTests } = await import('../zapBanner');
const { FullscreenChannelPanel } = await import('./FullscreenChannelPanel');
const { ChannelName } = await import('@/features/live/components/ChannelLogo');

const COUNT = 300;
const channel = (i: number): Channel => ({
  ref: { sourceId: 's1', contentType: 'live', itemId: `c${i}` },
  name: `Channel ${i}`,
  number: i + 1,
  categoryId: 'g',
  categoryName: 'G',
  logoUrl: `http://logo.test/c${i}.png`,
  isRadio: false,
});

function play(i: number) {
  act(() =>
    usePlayerStore.setState({
      source: { url: 'http://h/live.m3u8', kind: 'hls', title: `Channel ${i}`, isLive: true, isRadio: false, ref: channel(i).ref },
      mode: 'inline',
      status: 'playing',
    }),
  );
}

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  render(
    <QueryClientProvider client={client}>
      <FullscreenChannelPanel available />
    </QueryClientProvider>,
  );
  act(() => useMediaStore.setState({ channelPanelOpen: true }));
}

const focusedName = () => (document.activeElement?.getAttribute('role') === 'option' ? document.activeElement.textContent : document.activeElement?.tagName);
const list = () => screen.getByRole('listbox');
const search = () => screen.getByRole('searchbox');
const pagesAsked = () =>
  rpcMock.calls.filter((c) => c.cmd === 'catalog.channels').map((c) => (c.args as { query: { offset: number } }).query.offset / CHANNEL_PAGE_SIZE);

// jsdom has no layout: a 520 px list (ten rows) that really scrolls.
const restore: (() => void)[] = [];
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const box = (prop: 'offsetHeight' | 'offsetWidth' | 'clientHeight' | 'scrollHeight', value: number) => {
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    restore.push(() => (before ? Object.defineProperty(HTMLElement.prototype, prop, before) : delete (HTMLElement.prototype as never)[prop]));
  };
  box('offsetHeight', 520);
  box('offsetWidth', 360);
  box('clientHeight', 520);
  box('scrollHeight', COUNT * 52);
  const tops = new WeakMap<Element, number>();
  const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      tops.set(this, v);
    },
  });
  restore.push(() => top && Object.defineProperty(Element.prototype, 'scrollTop', top));
  const scrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
    // As a browser: a scroll to where it already is fires nothing.
    if (typeof opts !== 'object' || opts.top === undefined || opts.top === this.scrollTop) return;
    this.scrollTop = opts.top;
    this.dispatchEvent(new Event('scroll'));
  } as typeof Element.prototype.scrollTo;
  restore.push(() => (Element.prototype.scrollTo = scrollTo));
});
afterAll(() => restore.forEach((r) => r()));

beforeEach(() => {
  __resetPlayerForTests();
  __resetZapBannerForTests();
  resetMedia();
  for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
  rpcMock.calls.length = 0;
  rpcMock.handlers['catalog.channels'] = (a) => {
    const { offset, limit } = (a as { query: { offset: number; limit: number } }).query;
    const items = Array.from({ length: Math.max(0, Math.min(limit, COUNT - offset)) }, (_, k) => channel(offset + k));
    return { items, total: COUNT, offset, limit };
  };
  rpcMock.handlers['catalog.item'] = (a) => channel(Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
  rpcMock.handlers['settings.get'] = () => DEFAULT_SETTINGS;
  rpcMock.handlers['sources.get'] = () => ({ id: 's1', kind: 'm3u', name: 'Panel' });
  rpcMock.handlers['epg.nowNext'] = () => ({});
  rpcMock.handlers['parental.status'] = () => ({ enabled: false, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
});
afterEach(cleanup);

describe('fullscreen channel panel keyboard (L3-player-6)', () => {
  it('opens on the playing channel: its row is in view and has focus', async () => {
    play(250);
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 250'));
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0');
    // Centred in the list, not at the top.
    expect(list().scrollTop).toBeGreaterThan(200 * 52);
    // Its number put it on page 2 at once: no walk through the pages before it (page 1 comes
    // after, for the rows drawn above it).
    expect(pagesAsked().slice(0, 2)).toEqual([0, 2]);
  });

  it('arrows, Page Up/Down, Home and End walk the rows; Up from the top goes to the search field and Down comes back', async () => {
    play(5);
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(focusedName()).toContain('Channel 6'));
    fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
    await waitFor(() => expect(focusedName()).toContain('Channel 15'));
    fireEvent.keyDown(document.activeElement!, { key: 'PageUp' });
    await waitFor(() => expect(focusedName()).toContain('Channel 6'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await waitFor(() => expect(focusedName()).toContain('Channel 299'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect(focusedName()).toContain('Channel 0'));
    // One roving tab stop.
    expect(screen.getAllByRole('option').filter((o) => o.tabIndex === 0)).toHaveLength(1);

    const up = fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(up).toBe(false);
    expect(document.activeElement).toBe(search());
    const down = fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(down).toBe(false);
    await waitFor(() => expect(focusedName()).toContain('Channel 0'));
  });

  it('typing on a row goes to the search field', async () => {
    play(5);
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(document.activeElement).toBe(search());
  });

  it('a channel not in the list leaves focus on the search field, as before', async () => {
    rpcMock.handlers['catalog.item'] = () => ({ ...channel(0), ref: { sourceId: 's1', contentType: 'live', itemId: 'other' }, number: 1000 });
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://h/x.m3u8', kind: 'hls', title: 'Other', isLive: true, isRadio: false, ref: { sourceId: 's1', contentType: 'live', itemId: 'other' } },
        mode: 'inline',
        status: 'playing',
      }),
    );
    mount();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    // Down from the search field enters the list at the first row in view.
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    await waitFor(() => expect(focusedName()).toContain('Channel 0'));
  });

  it('a channel with no logo shows its coloured monogram, as the Live list does, not a blank tile', async () => {
    const base = rpcMock.handlers['catalog.channels']!;
    rpcMock.handlers['catalog.channels'] = (a) => {
      const page = base(a) as { items: Channel[] };
      return { ...page, items: page.items.map((c) => ({ ...c, logoUrl: null })) };
    };
    play(5);
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    const current = screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')!;
    const tile = current.querySelector('[data-monogram]') as HTMLElement;
    expect(tile.textContent).toBe('C5');
    expect(tile.style.background).toContain('linear-gradient');
    expect(current.querySelector('img')).toBeNull();
  });

  it('a row scrolled into view waits for the scroll to rest before its logo loads (L3-serve-ui-11)', async () => {
    play(5);
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    const row = (i: number) => screen.getAllByRole('option').find((o) => o.textContent?.includes(`Channel ${i}`) && !o.textContent.includes(`Channel ${i}0`));
    // At rest the rows in view show their logos.
    await waitFor(() => expect(row(5)?.querySelector('img')).toBeTruthy());
    // A fling: the rows it brings in hold their logos back, the ones still on screen keep theirs.
    act(() => {
      list().scrollTop = 40 * 52;
      fireEvent.scroll(list());
    });
    expect(row(45)).toBeTruthy();
    expect(row(45)?.querySelector('img')).toBeNull();
    await waitFor(() => expect(row(45)?.querySelector('img')).toBeTruthy());
  });

  it(`logos go through the shared image gate: at most ${MAX_ACTIVE} requests at a time in server mode (L3-player-ui-x6)`, async () => {
    // An observer that never reports: every row counts as in view, so only the cap holds them back.
    class SilentObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return [];
      }
    }
    resetImageGate();
    vi.stubGlobal('IntersectionObserver', SilentObserver);
    try {
      play(5);
      mount();
      await waitFor(() => expect(focusedName()).toContain('Channel 5'));
      const logos = () => Array.from(document.querySelectorAll('[role="option"] img'));
      await waitFor(() => expect(logos().filter((i) => i.hasAttribute('src')).length).toBe(MAX_ACTIVE));
      // The rest wait their turn, with no address of their own yet.
      expect(logos().length).toBeGreaterThan(MAX_ACTIVE);
      expect(logos().every((i) => !i.hasAttribute('src') || i.getAttribute('src')!.startsWith('/api/img?'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      resetImageGate();
    }
  });

  it('Enter in a search plays its first result', async () => {
    play(5);
    rpcMock.handlers['catalog.channels'] = (a) => {
      const { offset, limit, search: q } = (a as { query: { offset: number; limit: number; search?: string } }).query;
      if (q) return { items: [channel(42)], total: 1, offset, limit };
      const items = Array.from({ length: Math.max(0, Math.min(limit, COUNT - offset)) }, (_, k) => channel(offset + k));
      return { items, total: COUNT, offset, limit };
    };
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    fireEvent.change(search(), { target: { value: '42' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Channel 42')]));
    fireEvent.keyDown(search(), { key: 'Enter' });
    await waitFor(() => expect(usePlayerStore.getState().source?.ref?.itemId).toBe('c42'));
  });
});

describe('fullscreen channel panel openers', () => {
  // The other tests leave the panel open (resetMedia keeps channelPanelOpen).
  beforeEach(() => act(() => useMediaStore.setState({ channelPanelOpen: false })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  it('draws no floating button of its own (the control bar has it); a tap on the start edge still opens it', async () => {
    play(5);
    render(
      <QueryClientProvider client={client}>
        <FullscreenChannelPanel available />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Open channel list' })).toBeNull();
    const edge = document.querySelector<HTMLElement>('div[aria-hidden].start-0.w-3');
    expect(edge).toBeTruthy();
    fireEvent.click(edge!);
    expect(useMediaStore.getState().channelPanelOpen).toBe(true);
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
  });
});

describe('fullscreen channel panel empty states (PL-COPY-I18N)', () => {
  it('a search that finds nothing names what it looked for; an empty group says so plainly', async () => {
    play(5);
    // An empty group, and nothing for any search.
    rpcMock.handlers['catalog.channels'] = (a) => {
      const { offset, limit } = (a as { query: { offset: number; limit: number } }).query;
      return { items: [], total: 0, offset, limit };
    };
    mount();
    expect(await screen.findByText('No channels to show')).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(await screen.findByText('No channels match “zzz”')).toBeTruthy();
  });
});

describe('fullscreen channel panel names (round 5)', () => {
  beforeEach(() => {
    const base = rpcMock.handlers['catalog.channels']!;
    rpcMock.handlers['catalog.channels'] = (a) => {
      const page = base(a) as { items: Channel[] };
      return { ...page, items: page.items.map((c) => ({ ...c, name: `US| ${c.name}` })) };
    };
  });
  afterEach(() => setSettingsCache(null));

  it('draws the country tag after the name, quiet on the glass, as the channel lists do', async () => {
    play(3);
    mount();
    await waitFor(() => expect(screen.getAllByTestId('channel-name-tag').length).toBeGreaterThan(0));
    const tag = screen.getAllByTestId('channel-name-tag')[0]!;
    expect(tag.textContent).toBe('US');
    expect(tag.previousElementSibling!.textContent).toMatch(/^Channel \d+$/);
    expect(tag.className).toContain('text-on-glass-muted');
    // The option is still named by the provider's name.
    expect(tag.closest('[role=option]')!.textContent).toContain('US| Channel');
  });

  it('leaves the tag out with "Hide country tags" on', async () => {
    setSettingsCache({ ...DEFAULT_SETTINGS, stripCountryPrefix: true });
    play(3);
    mount();
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('channel-name-tag')).toEqual([]);
    expect(screen.getAllByRole('option')[0]!.textContent).not.toContain('US|');
  });
});

describe('fullscreen channel panel paging (F2-1)', () => {
  /** The app's timings for these reads (query.ts C4 table): a page stays cached across opens. */
  const appClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2 * 60_000, gcTime: 10 * 60_000 } } });
  const asked = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
  const rest = () => act(async () => void (await new Promise((r) => setTimeout(r, 250))));

  it("reads Live's pages under Live's keys: a page the Live list holds opens with no request", async () => {
    const client = appClient();
    const args = channelPageArgs({ sourceId: 's1' }, 0);
    client.setQueryData(rpcKey('catalog.channels', args), rpcMock.handlers['catalog.channels']!(args));
    play(5);
    mount(client);
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    expect(asked('catalog.channels')).toEqual([]);
    // No star in the panel: no favourite flags either.
    expect(asked('favorites.contains')).toEqual([]);
  });

  it('a scrollbar drag reads the pages it rests on, in playlist order, not one per page it passes', async () => {
    const total = 60 * CHANNEL_PAGE_SIZE;
    rpcMock.handlers['catalog.channels'] = (a) => {
      const { offset, limit } = (a as { query: { offset: number; limit: number } }).query;
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, k) => channel(offset + k));
      return { items, total, offset, limit };
    };
    play(5);
    mount(appClient());
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    const pagesBefore = asked('catalog.channels').length;
    const guideBefore = asked('epg.nowNext').length;
    // Thirty frames of a drag towards the end, a page and a half a frame, each frame committed.
    for (let k = 1; k <= 30; k++) {
      act(() => {
        list().scrollTop = k * 180 * 52;
        fireEvent.scroll(list());
      });
    }
    await waitFor(() => expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Channel 5402'))).toBe(true));
    const reads = asked('catalog.channels').slice(pagesBefore);
    // The page pair the drag stopped on (44 and 45), not the 45 pages it passed: the old panel read each.
    expect(reads.length).toBeLessThanOrEqual(2);
    for (const r of reads) {
      const { offset } = (r.args as { query: { offset: number } }).query;
      // Live's arguments exactly: no number sort, which no index covers.
      expect(r.args).toEqual(channelPageArgs({ sourceId: 's1' }, offset / CHANNEL_PAGE_SIZE));
    }
    expect(asked('epg.nowNext').length - guideBefore).toBeLessThanOrEqual(2);
  });

  it('the guide lines come with the pages: one epg.nowNext for a page, however the rows in view move', async () => {
    play(5);
    mount(appClient());
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    await waitFor(() => expect(asked('epg.nowNext')).toHaveLength(1));
    for (let k = 1; k <= 8; k++) {
      act(() => {
        list().scrollTop = k * 10 * 52;
        fireEvent.scroll(list());
      });
    }
    await rest();
    // The old panel asked again for each 20-row window the view moved into.
    expect(asked('epg.nowNext')).toHaveLength(1);
    expect((asked('epg.nowNext')[0]!.args as { refs: ItemRef[] }).refs).toHaveLength(CHANNEL_PAGE_SIZE);
  });

  it('opening it again asks nothing the last open read, and nothing while it is closed', async () => {
    play(5);
    mount(appClient());
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    await rest();
    const reads = rpcMock.calls.length;
    act(() => useMediaStore.setState({ channelPanelOpen: false }));
    // It slides out with its rows on.
    expect(screen.getAllByRole('option', { hidden: true }).length).toBeGreaterThan(0);
    await rest();
    expect(rpcMock.calls.length).toBe(reads);
    act(() => useMediaStore.setState({ channelPanelOpen: true }));
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    await rest();
    expect(rpcMock.calls.slice(reads).map((c) => c.cmd)).toEqual([]);
  });

  it('rows are memoized: a keystroke in the search field re-renders none of them', async () => {
    play(5);
    mount();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
    await rest();
    vi.mocked(ChannelName).mockClear();
    fireEvent.change(search(), { target: { value: 'x' } });
    expect((search() as HTMLInputElement).value).toBe('x');
    expect(ChannelName).not.toHaveBeenCalled();
  });
});
