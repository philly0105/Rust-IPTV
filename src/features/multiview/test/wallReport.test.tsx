/**
 * The wall's `downloads.playback` report (DL-INT-4): one entry per tile that plays, one report
 * for tiles that start together, renewed while any play, cleared when the wall goes; a tile that
 * loads from the provider directly waits for the core's answer before it asks for the stream.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';

import type { MultiviewChannelInput } from '../types';
import { useTilePlayback } from '../useTilePlayback';
import { WALL_RENEW_MS, WALL_REPORT_WAIT_MS } from '../wallReport';
import { input, installMediaStubs } from './harness';

const h = vi.hoisted(() => ({
  /** Tiles load from the provider (no proxy). */
  direct: false,
  /** Reports wait for `answer()` instead of being answered at once. */
  hold: false,
  answer: () => undefined as void,
  reports: [] as string[][],
  created: [] as string[],
}));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: { sourceIds: string[] }) => {
    if (cmd !== 'downloads.playback') return Promise.resolve(undefined);
    h.reports.push(args?.sourceIds ?? []);
    if (!h.hold) return Promise.resolve(undefined);
    return new Promise((resolve) => (h.answer = () => resolve(undefined)));
  },
  proxiedUrl: (s: PlayerSource) => (h.direct ? s.url : `/api/proxy?url=${encodeURIComponent(s.url)}`),
}));

vi.mock('../stream', () => ({
  resolveTileSource: async (ch: MultiviewChannelInput): Promise<PlayerSource> =>
    ({ url: `http://provider/live/${ch.ref.itemId}.m3u8`, kind: 'hls', title: ch.title, isLive: true, isRadio: false }) as PlayerSource,
}));

vi.mock('../engine', () => ({
  createEngine: async (_el: HTMLVideoElement, src: PlayerSource) => {
    h.created.push(src.url);
    return { kind: 'hls', destroy: () => undefined };
  },
  fetchFailureReason: async () => null,
  looksLikeMpegTs: () => false,
  mseSupported: () => true,
  withReason: (m: string) => m,
  worthSniffingAsMpegTs: () => false,
}));

function Tile({ ch, locked = false }: { ch: MultiviewChannelInput; locked?: boolean }) {
  const p = useTilePlayback(ch, { audible: false, volume: 1, locked });
  return <video ref={p.videoRef} />;
}

function Wall({ tiles, locked = [] }: { tiles: MultiviewChannelInput[]; locked?: string[] }) {
  return (
    <>
      {tiles.map((ch) => (
        <Tile key={ch.ref.itemId} ch={ch} locked={locked.includes(ch.ref.itemId)} />
      ))}
    </>
  );
}

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** Every tile shows its first frame (no start timeout fails it meanwhile). */
const playAll = () => act(() => document.querySelectorAll('video').forEach((v) => v.dispatchEvent(new Event('playing'))));

beforeAll(() => installMediaStubs());
beforeEach(() => {
  vi.useFakeTimers();
  h.direct = false;
  h.hold = false;
  h.reports.length = 0;
  h.created.length = 0;
});
afterEach(async () => {
  cleanup();
  // The report that clears the wall goes out after the tiles are gone.
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

describe("the wall's playback report", () => {
  it('names every playing tile once per tile, renews, and clears when the wall goes', async () => {
    const [a1, a2, b3] = [input(1, 'a'), input(2, 'a'), input(3, 'b')];
    const { rerender, unmount } = render(<Wall tiles={[a1, a2, b3]} />);
    await settle();
    playAll();
    // Tiles that start together: one report, two connections on a.
    expect(h.reports).toEqual([['a', 'a', 'b']]);
    rerender(<Wall tiles={[a1, b3]} />);
    await settle();
    expect(h.reports.at(-1)).toEqual(['a', 'b']);
    await settle(WALL_RENEW_MS);
    expect(h.reports).toHaveLength(3);
    expect(h.reports.at(-1)).toEqual(['a', 'b']);
    // A locked tile requests no stream.
    rerender(<Wall tiles={[a1, b3]} locked={['c3']} />);
    await settle();
    expect(h.reports.at(-1)).toEqual(['a']);
    unmount();
    await settle();
    expect(h.reports.at(-1)).toEqual([]);
    const sent = h.reports.length;
    await settle(WALL_RENEW_MS * 3);
    expect(h.reports).toHaveLength(sent);
  });

  it('holds a tile that loads from the provider directly until the core answered', async () => {
    h.direct = true;
    h.hold = true;
    render(<Wall tiles={[input(1, 'a')]} />);
    await settle(100);
    expect(h.reports).toEqual([['a']]);
    expect(h.created).toEqual([]);
    h.answer();
    await settle();
    expect(h.created).toEqual(['http://provider/live/c1.m3u8']);
  });

  it('waits for a core that never answers no longer than the cap', async () => {
    h.direct = true;
    h.hold = true;
    render(<Wall tiles={[input(1, 'a')]} />);
    await settle(WALL_REPORT_WAIT_MS - 10);
    expect(h.created).toEqual([]);
    await settle(10);
    expect(h.created).toHaveLength(1);
  });

  it('lets a tile through the media proxy start at once', async () => {
    h.hold = true;
    render(<Wall tiles={[input(1, 'a')]} />);
    await settle();
    expect(h.reports).toEqual([['a']]);
    expect(h.created).toHaveLength(1);
  });
});
