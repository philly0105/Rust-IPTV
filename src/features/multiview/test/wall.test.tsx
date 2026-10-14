/**
 * The page with real tiles: each tile runs its own `useTilePlayback` against a fake engine.
 * Covers sound (exactly one unmuted tile), failure isolation, keyboard, parental locks, the
 * connection-limit banner, and the empty and no-source states.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { PlayerSource } from '@/api/types';

import { MultiviewPage } from '../components/MultiviewPage';
import { useMultiviewAudio, useMultiviewStore } from '../store';
import type { MultiviewChannelInput } from '../types';
import { channel, input, installMediaStubs, renderWithApp, resetWall, source } from './harness';

// ---------------------------------------------------------------------------
// Module seams
// ---------------------------------------------------------------------------

interface EngineCallbacks {
  onError(e: { fatal: boolean; kind: string; message: string }): void;
}
interface FakeEngine {
  url: string;
  el: HTMLVideoElement;
  cb: EngineCallbacks;
  destroy: Mock;
}

const h = vi.hoisted(() => {
  return {
    rpc: (_cmd: string, _args: unknown): unknown => undefined,
    engines: [] as FakeEngine[],
    failUrls: new Set<string>(),
    rejectIds: new Set<string>(),
    ensureUnlocked: undefined as unknown,
    requestPin: undefined as unknown,
  };
});

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpcRaw: (cmd: string, args?: unknown) => Promise.resolve().then(() => h.rpc(cmd, args)),
  rpc: (cmd: string, args?: unknown) => Promise.resolve().then(() => h.rpc(cmd, args)),
  proxiedUrl: (s: PlayerSource) => s.url,
}));

vi.mock('@/api/events', async (orig) => ({
  ...(await orig<typeof import('@/api/events')>()),
  onAppEvent: () => () => undefined,
}));

vi.mock('@/shell', async () => {
  const s = await import('@/shell/shortcuts');
  return { useShortcut: s.useShortcut, useShellHeader: () => undefined };
});

vi.mock('@/features/player', async () => {
  const { create } = await import('zustand');
  const usePlayerStore = create<{ source: unknown; mode: string; stop(): void }>((set) => ({
    source: null,
    mode: 'html5',
    stop: () => set({ source: null }),
  }));
  return { usePlayerStore };
});

vi.mock('../parentalGate', () => ({
  ensureUnlocked: (...a: unknown[]) => (h.ensureUnlocked as (...x: unknown[]) => Promise<boolean>)(...a),
  requestPin: (...a: unknown[]) => (h.requestPin as (...x: unknown[]) => Promise<boolean>)(...a),
}));

vi.mock('../stream', () => ({
  resolveTileSource: async (ch: MultiviewChannelInput): Promise<PlayerSource> => {
    if (h.rejectIds.has(ch.ref.itemId)) throw Object.assign(new Error('Stream lookup failed'), { code: 'upstream' });
    return { url: `http://mock/${ch.ref.itemId}.m3u8`, kind: 'hls', title: ch.title, isLive: true, isRadio: false };
  },
}));

vi.mock('../engine', async () => {
  const { vi: v } = await import('vitest');
  return {
    createEngine: async (el: HTMLVideoElement, src: PlayerSource, _url: string, cb: EngineCallbacks) => {
      const engine = { kind: 'hls', destroy: v.fn() };
      h.engines.push({ url: src.url, el, cb, destroy: engine.destroy });
      if (h.failUrls.has(src.url)) queueMicrotask(() => cb.onError({ fatal: true, kind: 'network', message: 'HTTP 404 Not Found' }));
      return engine;
    },
    fetchFailureReason: async () => null,
    looksLikeMpegTs: () => false,
    mseSupported: () => true,
    withReason: (m: string) => m,
    worthSniffingAsMpegTs: () => false,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const calls: { cmd: string; args: unknown }[] = [];

function defaultHandlers(): Record<string, Handler> {
  return {
    'sources.list': () => [source('src1', 'xtream', 'Demo TV'), source('m3u1', 'm3u', 'Playlist')],
    'account.status': () => ({ maxConnections: 2, activeCons: 0, checkedAt: '2026-10-13T00:00:00Z' }),
    'epg.nowNext': () => ({}),
    'parental.status': () => ({ enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false }),
    'parental.check': () => [],
    'recent.list': () => [],
    'favorites.list': () => [],
    'catalog.channels': () => ({ items: [1, 2, 3, 4, 5, 6].map((i) => channel(i, 'm3u1')), total: 6 }),
    'catalog.search': () => ({ live: [], movies: [], series: [] }),
  };
}

function seed(ids: number[], sourceId = 'm3u1', audio = 0): void {
  const tiles = ids.map((i) => ({ ...input(i, sourceId), key: `k${i}` }));
  useMultiviewStore.setState({ tiles, layout: '2x2', audioKey: tiles[audio]?.key ?? null });
}

const tileEl = (i: number) => document.querySelector<HTMLElement>(`[data-tile-key="k${i}"]`)!;
const videoOf = (i: number) => tileEl(i).querySelector('video')!;
const mainOf = (i: number) => within(tileEl(i)).getByTestId('multiview-tile-main');
const unmuted = () => [...document.querySelectorAll('video')].filter((v) => !v.muted);
const engineFor = (i: number) => h.engines.filter((e) => e.url === `http://mock/c${i}.m3u8`);

async function playAll(ids: number[]): Promise<void> {
  await waitFor(() => expect(ids.every((i) => engineFor(i).length > 0)).toBe(true));
  act(() => {
    for (const i of ids) videoOf(i).dispatchEvent(new Event('playing'));
  });
}

function renderPage() {
  return renderWithApp(<MultiviewPage />);
}

beforeAll(() => installMediaStubs());

beforeEach(() => {
  resetWall();
  h.engines.length = 0;
  h.failUrls.clear();
  h.rejectIds.clear();
  calls.length = 0;
  handlers = defaultHandlers();
  h.rpc = (cmd, args) => {
    calls.push({ cmd, args });
    const fn = handlers[cmd];
    if (!fn) throw new Error(`unexpected rpc ${cmd}`);
    return fn((args ?? {}) as Record<string, unknown>);
  };
  h.ensureUnlocked = vi.fn(async () => true);
  h.requestPin = vi.fn(async () => true);
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

describe('sound: exactly one tile is unmuted', () => {
  it('plays every tile and unmutes only the tile with sound', async () => {
    seed([1, 2, 3, 4]);
    renderPage();
    await playAll([1, 2, 3, 4]);
    for (const i of [1, 2, 3, 4]) expect(tileEl(i).dataset['phase']).toBe('playing');
    expect(unmuted()).toEqual([videoOf(1)]);
    expect(tileEl(1).dataset['sound']).toBe('true');
    expect(within(tileEl(1)).getByTestId('multiview-tally')).toBeTruthy();
  });

  it('gives the sound to the clicked tile', async () => {
    seed([1, 2, 3]);
    renderPage();
    await playAll([1, 2, 3]);
    fireEvent.click(mainOf(3));
    expect(useMultiviewStore.getState().audioKey).toBe('k3');
    expect(unmuted()).toEqual([videoOf(3)]);
    expect(mainOf(3).getAttribute('aria-pressed')).toBe('true');
    expect(mainOf(1).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('multiview-announcer').textContent).toBe('Sound: Channel 3');
  });

  it('moves the sound with the number keys', async () => {
    seed([1, 2, 3]);
    renderPage();
    await playAll([1, 2, 3]);
    fireEvent.keyDown(window, { key: '2' });
    expect(unmuted()).toEqual([videoOf(2)]);
    // A number with no tile does nothing.
    fireEvent.keyDown(window, { key: '4' });
    expect(useMultiviewStore.getState().audioKey).toBe('k2');
  });

  it('mutes the whole wall with M and the toolbar, and a click on a tile unmutes it', async () => {
    seed([1, 2]);
    renderPage();
    await playAll([1, 2]);
    fireEvent.keyDown(window, { key: 'm' });
    expect(unmuted()).toEqual([]);
    expect(screen.getByTestId('multiview-mute').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('multiview-mute'));
    expect(unmuted()).toEqual([videoOf(1)]);
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.click(mainOf(2));
    expect(useMultiviewAudio.getState().muted).toBe(false);
    expect(unmuted()).toEqual([videoOf(2)]);
  });

  it('applies the wall volume to the tile with sound', async () => {
    seed([1, 2]);
    renderPage();
    await playAll([1, 2]);
    fireEvent.change(screen.getByTestId('multiview-volume'), { target: { value: '40' } });
    expect(videoOf(1).volume).toBeCloseTo(0.4);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('failure isolation', () => {
  it('a broken stream shows its own error while the others keep playing', async () => {
    h.failUrls.add('http://mock/c2.m3u8');
    seed([1, 2, 3, 4]);
    renderPage();
    await waitFor(() => expect(within(tileEl(2)).getByTestId('multiview-tile-error')).toBeTruthy());
    await playAll([1, 3, 4]);
    for (const i of [1, 3, 4]) {
      expect(tileEl(i).dataset['phase']).toBe('playing');
      expect(engineFor(i)[0]!.destroy).not.toHaveBeenCalled();
    }
    expect(tileEl(2).dataset['phase']).toBe('error');
    expect(engineFor(2)[0]!.destroy).toHaveBeenCalled();
    expect(within(tileEl(2)).getByRole('alert').textContent).toMatch(/\S/);
    // The sound stays on tile 1, which plays.
    expect(unmuted()).toEqual([videoOf(1)]);
  });

  it('retry rebuilds only the failed tile', async () => {
    h.failUrls.add('http://mock/c2.m3u8');
    seed([1, 2, 3]);
    renderPage();
    await waitFor(() => expect(within(tileEl(2)).getByTestId('multiview-tile-retry')).toBeTruthy());
    await playAll([1, 3]);
    h.failUrls.clear();
    fireEvent.click(within(tileEl(2)).getByTestId('multiview-tile-retry'));
    await waitFor(() => expect(engineFor(2)).toHaveLength(2));
    expect(engineFor(1)).toHaveLength(1);
    expect(engineFor(3)).toHaveLength(1);
    act(() => void videoOf(2).dispatchEvent(new Event('playing')));
    expect(tileEl(2).dataset['phase']).toBe('playing');
    expect(engineFor(1)[0]!.destroy).not.toHaveBeenCalled();
  });

  it('a stream lookup that fails stops only that tile', async () => {
    h.rejectIds.add('c3');
    seed([1, 2, 3]);
    renderPage();
    await waitFor(() => expect(within(tileEl(3)).getByTestId('multiview-tile-error')).toBeTruthy());
    await playAll([1, 2]);
    expect(engineFor(3)).toHaveLength(0);
    expect(tileEl(1).dataset['phase']).toBe('playing');
  });

  it('closing a tile leaves the others playing on the same engines', async () => {
    seed([1, 2, 3]);
    renderPage();
    await playAll([1, 2, 3]);
    fireEvent.click(within(tileEl(2)).getByTestId('multiview-tile-close'));
    expect(useMultiviewStore.getState().tiles.map((t) => t.key)).toEqual(['k1', 'k3']);
    expect(engineFor(2)[0]!.destroy).toHaveBeenCalled();
    expect(engineFor(1)[0]!.destroy).not.toHaveBeenCalled();
    expect(engineFor(3)[0]!.destroy).not.toHaveBeenCalled();
    expect(engineFor(3)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

describe('keyboard', () => {
  /** jsdom has no layout: lay the four slots out as a 2x2 grid. */
  function layOut(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-slot-focus]')) {
      const i = Number(el.dataset['slotFocus']);
      const left = (i % 2) * 104;
      const top = Math.floor(i / 2) * 60;
      el.getBoundingClientRect = () => ({ left, top, width: 100, height: 56, right: left + 100, bottom: top + 56, x: left, y: top, toJSON: () => ({}) });
    }
  }

  it('arrow keys move focus by position, including onto a free slot', async () => {
    seed([1, 2, 3]);
    renderPage();
    await playAll([1, 2, 3]);
    layOut();
    mainOf(1).focus();
    fireEvent.keyDown(mainOf(1), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(mainOf(2));
    fireEvent.keyDown(mainOf(2), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('multiview-empty-slot'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(mainOf(3));
    fireEvent.keyDown(mainOf(3), { key: 'Home' });
    expect(document.activeElement).toBe(mainOf(1));
  });

  it('Delete closes the focused tile, with undo', async () => {
    seed([1, 2, 3]);
    renderPage();
    await playAll([1, 2, 3]);
    mainOf(2).focus();
    fireEvent.keyDown(mainOf(2), { key: 'Delete' });
    expect(useMultiviewStore.getState().tiles.map((t) => t.key)).toEqual(['k1', 'k3']);
    expect(screen.getByTestId('multiview-announcer').textContent).toBe('Closed Channel 2');
  });

  it('S then S swaps two tiles; Escape cancels', async () => {
    seed([1, 2, 3]);
    renderPage();
    await playAll([1, 2, 3]);
    fireEvent.keyDown(mainOf(1), { key: 's' });
    expect(mainOf(3).getAttribute('aria-label')).toBe('Swap with Channel 3 in slot 3');
    fireEvent.keyDown(mainOf(3), { key: 'Escape' });
    expect(mainOf(3).getAttribute('aria-label')).toBe('Play sound from Channel 3');
    fireEvent.keyDown(mainOf(1), { key: 's' });
    fireEvent.click(mainOf(3));
    expect(useMultiviewStore.getState().tiles.map((t) => t.key)).toEqual(['k3', 'k2', 'k1']);
    // The engines follow their channels: nothing was rebuilt by the swap.
    expect(engineFor(1)).toHaveLength(1);
    expect(engineFor(3)).toHaveLength(1);
  });

  it('R opens the picker to replace the focused tile', async () => {
    seed([1, 2]);
    renderPage();
    await playAll([1, 2]);
    fireEvent.keyDown(mainOf(2), { key: 'r' });
    expect(await screen.findByRole('dialog', { name: 'Replace the channel in slot 2' })).toBeTruthy();
  });

  it('L cycles the layouts that hold the tiles', async () => {
    seed([1, 2, 3]);
    renderPage();
    fireEvent.keyDown(window, { key: 'l' });
    expect(useMultiviewStore.getState().layout).toBe('1+3');
    fireEvent.keyDown(window, { key: 'l' });
    expect(useMultiviewStore.getState().layout).toBe('2x2');
  });
});

// ---------------------------------------------------------------------------
// Parental locks
// ---------------------------------------------------------------------------

describe('parental locks', () => {
  const locked = (mode: 'ask' | 'hide') => {
    handlers['parental.status'] = () => ({ enabled: true, mode, autoAdult: false, unlockMinutes: 15, unlocked: false });
    handlers['parental.check'] = (args) => {
      const items = args['items'] as { ref: { itemId: string } }[];
      return items.filter((i) => i.ref.itemId === 'c2').map((i) => i.ref);
    };
  };

  it('keeps a locked tile dark (no stream) while the others play', async () => {
    locked('ask');
    seed([1, 2, 3]);
    renderPage();
    expect(await within(tileEl(2)).findByTestId('multiview-tile-locked')).toBeTruthy();
    await playAll([1, 3]);
    expect(engineFor(2)).toHaveLength(0);
    fireEvent.click(within(tileEl(2)).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(h.ensureUnlocked).toHaveBeenCalledWith([expect.objectContaining({ ref: input(2, 'm3u1').ref, title: 'Channel 2' })]));
  });

  it('asks for the session PIN in hide mode', async () => {
    locked('hide');
    seed([1, 2]);
    renderPage();
    expect(await within(tileEl(2)).findByText('Hidden by parental controls')).toBeTruthy();
    fireEvent.click(within(tileEl(2)).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(h.requestPin).toHaveBeenCalled());
    expect(h.ensureUnlocked).not.toHaveBeenCalled();
  });

  it('fails closed when the lock check fails, and retries on request', async () => {
    handlers['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false });
    let fail = true;
    handlers['parental.check'] = () => {
      if (fail) throw new Error('check failed');
      return [];
    };
    seed([1]);
    renderPage();
    expect(await within(tileEl(1)).findByTestId('multiview-tile-lock-error')).toBeTruthy();
    expect(engineFor(1)).toHaveLength(0);
    fail = false;
    fireEvent.click(within(tileEl(1)).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(engineFor(1)).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------
// Connection limit
// ---------------------------------------------------------------------------

describe('connection limit', () => {
  it('warns when tiles of one account outnumber its connections', async () => {
    seed([1, 2, 3], 'src1');
    renderPage();
    const banner = await screen.findByTestId('multiview-limit-banner');
    expect(banner.textContent).toContain('Demo TV allows 2 streams at a time and the wall uses 3');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('multiview-limit-banner')).toBeNull();
  });

  it('stays quiet within the limit, and asks only Xtream accounts', async () => {
    useMultiviewStore.setState({
      tiles: [
        { ...input(1, 'src1'), key: 'k1' },
        { ...input(2, 'src1'), key: 'k2' },
        { ...input(3, 'm3u1'), key: 'k3' },
      ],
      layout: '2x2',
      audioKey: 'k1',
    });
    renderPage();
    await waitFor(() => expect(calls.some((c) => c.cmd === 'account.status')).toBe(true));
    expect(calls.filter((c) => c.cmd === 'account.status').map((c) => c.args)).toEqual([{ sourceId: 'src1' }]);
    expect(screen.queryByTestId('multiview-limit-banner')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty and no-source states, adding
// ---------------------------------------------------------------------------

describe('empty wall', () => {
  it('explains multi-view, offers layouts and the picker', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Watch up to four channels at once' })).toBeTruthy();
    expect(screen.getAllByTestId('multiview-empty-slot')).toHaveLength(4);
    fireEvent.click(screen.getByTestId('multiview-empty-layout-1x2'));
    expect(useMultiviewStore.getState().layout).toBe('1x2');
    expect(screen.getAllByTestId('multiview-empty-slot')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('multiview-pick'));
    expect(await screen.findByRole('dialog', { name: 'Add channels' })).toBeTruthy();
  });

  it('adds channels from the picker through the parental gate', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('multiview-pick'));
    const rows = await screen.findAllByTestId('multiview-picker-row');
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(useMultiviewStore.getState().tiles).toHaveLength(1));
    expect(h.ensureUnlocked).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByTestId('multiview-picker-row')[1]!);
    await waitFor(() => expect(useMultiviewStore.getState().tiles).toHaveLength(2));
    expect(useMultiviewStore.getState().tiles.map((t) => t.title)).toEqual(['Channel 1', 'Channel 2']);
  });

  it('adds nothing when the PIN prompt is cancelled', async () => {
    h.ensureUnlocked = vi.fn(async () => false);
    renderPage();
    fireEvent.click(await screen.findByTestId('multiview-pick'));
    fireEvent.click((await screen.findAllByTestId('multiview-picker-row'))[0]!);
    await waitFor(() => expect(h.ensureUnlocked).toHaveBeenCalled());
    expect(useMultiviewStore.getState().tiles).toHaveLength(0);
  });

  it('points to Sources when there is none', async () => {
    handlers['sources.list'] = () => [];
    renderPage();
    expect(await screen.findByText('No sources yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a source' }).getAttribute('href')).toBe('/sources');
  });

  it('shows the sources error with a retry', async () => {
    handlers['sources.list'] = () => {
      throw new Error('down');
    };
    renderPage();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('marks a tile whose source was removed', async () => {
    seed([1], 'gone');
    renderPage();
    expect(await within(tileEl(1)).findByTestId('multiview-tile-missing')).toBeTruthy();
    expect(engineFor(1)).toHaveLength(0);
  });
});
