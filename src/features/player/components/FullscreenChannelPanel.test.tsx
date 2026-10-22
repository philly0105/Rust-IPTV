import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
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

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { __resetZapBannerForTests } = await import('../zapBanner');
const { FullscreenChannelPanel } = await import('./FullscreenChannelPanel');

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

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
  rpcMock.calls.filter((c) => c.cmd === 'catalog.channels').map((c) => (c.args as { query: { offset: number } }).query.offset / 100);

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
    // Its number put it on page 2 at once: no walk through the pages before it.
    expect(pagesAsked()).not.toContain(1);
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

describe('fullscreen channel panel button', () => {
  // The other tests leave the panel open (resetMedia keeps channelPanelOpen).
  beforeEach(() => act(() => useMediaStore.setState({ channelPanelOpen: false })));
  const button = () => screen.getByRole('button', { name: 'Open channel list' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const panel = (chromeVisible: boolean) => (
    <QueryClientProvider client={client}>
      <FullscreenChannelPanel available chromeVisible={chromeVisible} />
    </QueryClientProvider>
  );

  it('opens the panel, shows with the controls and names the C key', async () => {
    play(5);
    const { rerender } = render(panel(false));
    // Hidden with the controls, it lets the pointer through to the video.
    expect(button().className).toContain('opacity-0');
    expect(button().className).toContain('pointer-events-none');
    rerender(panel(true));
    expect(button().className).not.toContain('opacity-0');
    expect(button().getAttribute('aria-keyshortcuts')).toBe('C');
    fireEvent.click(button());
    expect(useMediaStore.getState().channelPanelOpen).toBe(true);
    // Open, the panel has its own close button; the opener goes.
    expect(screen.queryByRole('button', { name: 'Open channel list' })).toBeNull();
    await waitFor(() => expect(focusedName()).toContain('Channel 5'));
  });

  it('gives way to the stream info panel on the same edge', async () => {
    const { useStreamInfoStore } = await import('../streamInfo');
    play(5);
    act(() => useStreamInfoStore.setState({ open: true }));
    render(panel(true));
    expect(screen.queryByRole('button', { name: 'Open channel list' })).toBeNull();
    act(() => useStreamInfoStore.setState({ open: false }));
    expect(button()).toBeTruthy();
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
