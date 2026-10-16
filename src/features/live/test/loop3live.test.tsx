/**
 * Campaign loop 3 (live channels): PageUp/PageDown zap while a live channel plays and the list
 * keeps Shift+Page for paging (L3-player-1), focus that left the list is not pulled back into it
 * (L3-player-1), a zap burst asks details only for the channel it settles on (L3-live-7), a
 * number longer than any channel never tunes its tail (L3-live-9) and the groups come from one
 * `catalog.categories` call (L3-perf-desktop-7). List logos ask for a resized copy
 * (L3-serve-ui-4) and start through the image fetch gate (L3-live-ch-x3).
 */
import { act, cleanup, configure, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, Page, PageQuery } from '@/api/types';
import { imageGateStats, pageIsScrolling, resetImageGate } from '@/ui/imageGate';

import { ChannelList, resetChannelListMemory } from '../components/ChannelList';
import { ChannelLogo } from '../components/ChannelLogo';
import { LivePage, shownGroups } from '../components/LivePage';
import { DIGIT_COMMIT_MS, useDigitEntry } from '../hooks/useDigitEntry';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { installDomStubs, makeChannel, renderAt, settings } from './harness';

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
/** Sources the test marks as a zap's placeholder (the player store's own set is private). */
const pendingZaps = vi.hoisted(() => new WeakSet<object>());

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
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
vi.mock('@/features/player/store', async (orig) => ({
  ...(await orig<object>()),
  isPendingZap: (s: object | undefined) => !!s && pendingZaps.has(s),
}));

const fakes = await import('./fakes');

const ROUTE = [{ path: '/s/:sourceId/live', element: <LivePage /> }];
const TOTAL = 40;

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

const group = (id: string, patch: Partial<Category> = {}): Category =>
  ({ id, sourceId: 'src1', contentType: 'live', name: id, hidden: false, itemCount: 10, position: 0, ...patch }) as Category;

beforeAll(() => {
  configure({ asyncUtilTimeout: 3000 });
  installDomStubs();
});
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({
    id: 'src1',
    kind: 'xtream',
    name: 'Demo portal',
    channelCount: TOTAL,
    movieCount: 0,
    seriesCount: 0,
    epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] },
  });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [group('g1', { name: 'News', itemCount: TOTAL }), group('g2', { name: 'Sport', hidden: true })];
  h['catalog.channels'] = serve(Array.from({ length: TOTAL }, (_, i) => makeChannel(i)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['channels.edits'] = () => [];
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined, mode: 'inline' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const rowButton = (i: number) => document.querySelector<HTMLButtonElement>(`button[data-row-index="${i}"]`);
const live = (i: number) => ({ url: '', kind: 'hls' as const, title: `Channel ${i}`, ref: makeChannel(i).ref, isLive: true, isRadio: false });
function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(e));
  return e;
}

describe('PageUp and PageDown zap while a live channel plays (L3-player-1)', () => {
  it('the list leaves plain PageDown to the playback shortcuts and pages on Shift+PageDown', async () => {
    fakes.usePlayerStore.setState({ source: live(0) });
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(rowButton(0)?.getAttribute('aria-current')).toBe('true'));
    act(() => rowButton(0)!.focus());

    const zap = key(rowButton(0)!, { key: 'PageDown' });
    expect(zap.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rowButton(0));

    const paged = key(rowButton(0)!, { key: 'PageDown', shiftKey: true });
    expect(paged.defaultPrevented).toBe(true);
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).not.toBe('0'));
  });

  it('with nothing playing, PageDown pages the list as before', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    act(() => rowButton(0)!.focus());
    const e = key(rowButton(0)!, { key: 'PageDown' });
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).not.toBe('0'));
  });

  it('a video that is not live keeps PageDown for the list', async () => {
    fakes.usePlayerStore.setState({ source: { ...live(0), isLive: false, ref: { sourceId: 'src1', contentType: 'movie', itemId: 'm1' } } });
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    act(() => rowButton(0)!.focus());
    expect(key(rowButton(0)!, { key: 'PageDown' }).defaultPrevented).toBe(true);
  });
});

describe('focus that left the list stays out (L3-player-1)', () => {
  const channels = Array.from({ length: 30 }, (_, i) => makeChannel(i));
  function Harness({ gone }: { gone: boolean }) {
    const [paged] = useState<PagedChannels>(() => ({
      total: channels.length,
      getChannel: (i) => channels[i],
      getNowNext: () => undefined,
      isFavorite: () => false,
      setVisibleRange: () => undefined,
      isLoading: false,
      refreshing: false,
      error: undefined,
      retry: () => undefined,
      loaded: channels.map((channel, index) => ({ index, channel })),
      pageSize: 120,
      guideUnavailable: false,
      retryGuide: () => undefined,
    }));
    // A reload that takes row 0 away (its page refetching, the row a skeleton meanwhile).
    const view: PagedChannels = gone ? { ...paged, getChannel: (i) => (i === 0 ? undefined : channels[i]) } : paged;
    return (
      <ChannelList
        paged={view}
        resetKey="all"
        openOnDoubleClick={false}
        now={0}
        onPlay={() => undefined}
        onToggleFavorite={() => undefined}
        onContextMenu={() => undefined}
      />
    );
  }
  const mount = () => {
    let setGone!: (g: boolean) => void;
    function Toggle() {
      const [gone, set] = useState(false);
      setGone = set;
      return <Harness gone={gone} />;
    }
    renderAt('/', [{ path: '/', element: <Toggle /> }]);
    return (g: boolean) => act(() => setGone(g));
  };

  it('a focused row that goes away hands focus to the list', async () => {
    const setGone = mount();
    await waitFor(() => expect(rowButton(0)).not.toBeNull());
    act(() => rowButton(0)!.focus());
    setGone(true);
    expect(rowButton(0)).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('channel-list'));
  });

  it('a row that lost focus to the page before it went away does not pull focus back in', async () => {
    const setGone = mount();
    await waitFor(() => expect(rowButton(0)).not.toBeNull());
    act(() => rowButton(0)!.focus());
    // A click on the stage or the page: focus leaves the list.
    act(() => rowButton(0)!.blur());
    expect(document.activeElement).toBe(document.body);
    setGone(true);
    expect(rowButton(0)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('a zap burst asks details only for the channel it settles on (L3-live-7)', () => {
  it('skips the placeholders a burst shows and asks for the settled channel', async () => {
    fakes.usePlayerStore.setState({ source: live(1) });
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    const itemCalls = () => callsOf('catalog.item').map((a) => (a as { ref: { itemId: string } }).ref.itemId);
    const singleNowNext = () =>
      callsOf('epg.nowNext')
        .map((a) => (a as { refs: { itemId: string }[] }).refs)
        .filter((r) => r.length === 1)
        .map((r) => r[0]!.itemId);
    await waitFor(() => expect(itemCalls()).toContain('c1'));

    for (const i of [5, 6, 7]) {
      const placeholder = { ...live(i), kind: 'direct' as const };
      pendingZaps.add(placeholder);
      act(() => fakes.usePlayerStore.setState({ source: placeholder }));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(itemCalls().filter((id) => ['c5', 'c6', 'c7'].includes(id))).toEqual([]);
    expect(singleNowNext().filter((id) => ['c5', 'c6', 'c7'].includes(id))).toEqual([]);

    act(() => fakes.usePlayerStore.setState({ source: live(7) }));
    await waitFor(() => expect(itemCalls()).toContain('c7'));
    expect(itemCalls().filter((id) => id === 'c5' || id === 'c6')).toEqual([]);
  });
});

describe('a number longer than any channel (L3-live-9)', () => {
  it('99999 on a source up to 20000 commits 9999 once and reports the fifth digit, never tuning 9', () => {
    vi.useFakeTimers();
    const commits: number[] = [];
    const overflow: number[] = [];
    const { result } = renderHook(() =>
      useDigitEntry(
        (n) => commits.push(n),
        undefined,
        20_000,
        (n) => overflow.push(n),
      ),
    );
    for (const d of '99999') act(() => result.current.push(d));
    act(() => void vi.advanceTimersByTime(DIGIT_COMMIT_MS * 2));
    expect(commits).toEqual([9999]);
    expect(overflow).toEqual([99999]);

    // After a pause the next digits are a new number.
    for (const d of '12') act(() => result.current.push(d));
    act(() => void vi.advanceTimersByTime(DIGIT_COMMIT_MS));
    expect(commits).toEqual([9999, 12]);
  });
});

describe('groups from one catalog.categories call (L3-perf-desktop-7)', () => {
  it('asks once, with the hidden groups, and leaves those out of the sidebar', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await screen.findAllByText('News');
    expect(callsOf('catalog.categories')).toEqual([{ sourceId: 'src1', contentType: 'live', includeHidden: true }]);
    expect(screen.queryByText('Sport')).toBeNull();
  });

  it('shownGroups on an older core (no emptiedByEdits) drops hidden groups, and empty ones only while channels are hidden', () => {
    const all = [group('a'), group('b', { hidden: true }), group('c', { itemCount: 0 })];
    expect(shownGroups(all, false).map((g) => g.id)).toEqual(['a', 'c']);
    expect(shownGroups(all, true).map((g) => g.id)).toEqual(['a']);
  });

  it('shownGroups follows emptiedByEdits: a group the provider ships empty stays, one emptied by edits goes', () => {
    const all = [
      group('a', { emptiedByEdits: false }),
      group('b', { hidden: true, emptiedByEdits: false }),
      group('shipsEmpty', { itemCount: 0, emptiedByEdits: false }),
      group('emptied', { itemCount: 0, emptiedByEdits: true }),
    ];
    expect(shownGroups(all, true).map((g) => g.id)).toEqual(['a', 'shipsEmpty']);
    // The flag wins over the local guess either way.
    expect(shownGroups(all, false).map((g) => g.id)).toEqual(['a', 'shipsEmpty']);
    // A hidden group stays out even when the core also says edits emptied it.
    expect(shownGroups([group('h', { hidden: true, itemCount: 0, emptiedByEdits: true })], true)).toEqual([]);
  });
});

describe('list logos (L3-serve-ui-4)', () => {
  const url = (src: string, w: number) => `/api/img?url=${encodeURIComponent(src)}&w=${w}`;

  it('ask the cache for a copy the size they are drawn at', () => {
    const { container, rerender } = render(<ChannelLogo src="https://x/a.png" name="Alpha" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url('https://x/a.png', 64));
    rerender(<ChannelLogo src="https://x/a.png" name="Alpha" size={72} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url('https://x/a.png', 96));
  });

  it('a channel without a logo shows its letters at once', () => {
    const { container } = render(<ChannelLogo name="Alpha One" />);
    expect(container.textContent).toBe('AO');
  });
});

describe('list logos start through the image fetch gate (L3-live-ch-x3)', () => {
  const url = (src: string) => `/api/img?url=${encodeURIComponent(src)}&w=64`;
  const scroll = () => document.dispatchEvent(new Event('scroll'));
  class FakeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const g = globalThis as { IntersectionObserver?: unknown };
  beforeEach(() => {
    g.IntersectionObserver = FakeObserver;
    resetImageGate();
    pageIsScrolling(); // the gate's scroll listener
  });
  afterEach(() => {
    delete g.IntersectionObserver;
    resetImageGate();
  });

  it('a logo that mounts mid-scroll shows the plate and starts once the scroll rests; one showing stays', async () => {
    scroll();
    const { container, rerender } = render(<ChannelLogo src="https://x/a.png" name="Alpha" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull();
    // The plate alone: no letters flashing before the logo.
    expect(container.textContent).toBe('');
    await waitFor(() => expect(img.getAttribute('src')).toBe(url('https://x/a.png')));
    act(() => void img.dispatchEvent(new Event('load')));

    // Scrolling again: the logo on screen keeps its picture, on the same element.
    scroll();
    rerender(<ChannelLogo src="https://x/a.png" name="Alpha" />);
    expect(container.querySelector('img')).toBe(img);
    expect(img.getAttribute('src')).toBe(url('https://x/a.png'));

    // The reused row shows another channel mid-scroll: a new element waits; the old picture is gone.
    rerender(<ChannelLogo src="https://x/b.png" name="Beta" />);
    const next = container.querySelector('img')!;
    expect(next).not.toBe(img);
    expect(next.getAttribute('src')).toBeNull();
    await waitFor(() => expect(next.getAttribute('src')).toBe(url('https://x/b.png')));
  });

  it('a row that goes while its logo waits leaves the queue', () => {
    scroll();
    const { unmount } = render(<ChannelLogo src="https://x/c.png" name="Gamma" />);
    expect(imageGateStats().pending).toBe(1);
    unmount();
    expect(imageGateStats().pending).toBe(0);
  });
});
