/**
 * A tile on the player's real engines, mpegts.js faked: who decides when a live stream ends.
 * A live MPEG-TS connection the panel closes ends the element, and the mpegts.js engine
 * reconnects it (players.md); the tile fails only when the engine reports its restarts ran out.
 * Under Auto, every Xtream channel on an MSE browser plays this way (seam-1).
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';
import { TS_MAX_RESTARTS, tsRestartDelay } from '@/features/player/engines';

import type { MultiviewChannelInput } from '../types';
import { useTilePlayback, type TilePlaybackOptions } from '../useTilePlayback';
import { input, installMediaStubs } from './harness';

const h = vi.hoisted(() => ({
  /** The URL each mpegts.js player was created for. */
  created: [] as string[],
  /** What the channel resolves to. */
  url: 'http://panel/live/u/p/1.ts',
}));

vi.mock('mpegts.js', () => {
  class FakeTsPlayer {
    constructor(source: { url: string }) {
      h.created.push(source.url);
    }
    on(): void {}
    attachMediaElement(): void {}
    detachMediaElement(): void {}
    load(): void {}
    unload(): void {}
    destroy(): void {}
  }
  return {
    default: {
      isSupported: () => true,
      getFeatureList: () => ({ mseLivePlayback: true }),
      createPlayer: (source: { url: string }) => new FakeTsPlayer(source),
      LoggingControl: { applyConfig() {} },
      Events: { ERROR: 'error', LOADING_COMPLETE: 'loading_complete' },
      ErrorTypes: { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError' },
      ErrorDetails: {},
    },
  };
});

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  proxiedUrl: (s: PlayerSource) => s.url,
}));

vi.mock('../stream', () => ({
  resolveTileSource: async (ch: MultiviewChannelInput): Promise<PlayerSource> =>
    ({ url: h.url, kind: 'direct', title: ch.title, isLive: true, isRadio: false }) as PlayerSource,
}));

function Probe({ ch, opts }: { ch: MultiviewChannelInput; opts: TilePlaybackOptions }) {
  const p = useTilePlayback(ch, opts);
  return (
    <div data-testid="tile" data-phase={p.phase} data-message={p.fault?.message ?? ''}>
      <video ref={p.videoRef} />
    </div>
  );
}

const OPTS: TilePlaybackOptions = { audible: false, volume: 1, locked: false };
const tile = () => screen.getByTestId('tile');
const fire = (type: string): void => act(() => void tile().querySelector('video')!.dispatchEvent(new Event(type)));

beforeAll(() => {
  installMediaStubs();
  (window as unknown as { MediaSource?: unknown }).MediaSource = function MediaSource() {};
});
beforeEach(() => {
  h.created.length = 0;
  h.url = 'http://panel/live/u/p/1.ts';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the end of a live stream on a tile (seam-1)', () => {
  it('a live MPEG-TS connection that closes is reconnected by the engine; the tile fails once its restarts run out', async () => {
    render(<Probe ch={input(1)} opts={OPTS} />);
    await waitFor(() => expect(h.created).toHaveLength(1));
    // The engine is handed to the tile a few microtasks after its player is created.
    await act(async () => undefined);
    vi.useFakeTimers();
    fire('playing');
    expect(tile().dataset['phase']).toBe('playing');

    // The panel ended the response: mpegts.js ends the MediaSource, the element its playback.
    fire('ended');
    await act(async () => void (await vi.advanceTimersByTimeAsync(tsRestartDelay(1))));
    expect(h.created).toEqual([h.url, h.url]);
    expect(tile().dataset['phase']).toBe('playing');

    for (let i = 2; i <= TS_MAX_RESTARTS; i++) {
      fire('ended');
      await act(async () => void (await vi.advanceTimersByTimeAsync(tsRestartDelay(i))));
    }
    expect(h.created).toHaveLength(TS_MAX_RESTARTS + 1);
    expect(tile().dataset['phase']).toBe('playing');
    fire('ended');
    expect(tile().dataset['phase']).toBe('error');
    expect(tile().dataset['message']).toBe('The live stream closed the connection');
  });

  it('a live stream on the element that ends fails the tile at once: nothing would reconnect it', async () => {
    h.url = 'http://panel/live/1.mp4';
    render(<Probe ch={input(2)} opts={OPTS} />);
    await waitFor(() => expect(tile().dataset['phase']).toBe('loading'));
    fire('playing');
    fire('ended');
    expect(tile().dataset['phase']).toBe('error');
    expect(tile().dataset['message']).toBe('The stream ended');
    expect(h.created).toEqual([]);
  });
});
