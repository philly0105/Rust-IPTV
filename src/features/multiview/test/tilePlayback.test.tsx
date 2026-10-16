/**
 * One tile's playback hook on its own: how an element error that hides a refusal is told
 * apart from a stream worth retrying through mpegts.js (L2-live-8), and the staggered first
 * start of tiles that mount together (L2-live-13).
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';

import type { MultiviewChannelInput } from '../types';
import { useTilePlayback, type TilePlaybackOptions } from '../useTilePlayback';
import { input, installMediaStubs } from './harness';

const h = vi.hoisted(() => ({
  created: [] as { url: string; forceMpegts: boolean }[],
  probe: null as { status: number; reason: string } | null,
  probes: [] as string[],
  resolved: [] as string[],
}));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  proxiedUrl: (s: PlayerSource) => `/api/proxy?url=${encodeURIComponent(s.url)}`,
}));

vi.mock('../stream', () => ({
  resolveTileSource: async (ch: MultiviewChannelInput): Promise<PlayerSource> => {
    h.resolved.push(ch.ref.itemId);
    // Extensionless: the element tries it first, mpegts.js is the fallback.
    return { url: `http://provider/live/${ch.ref.itemId}`, kind: 'direct', title: ch.title, isLive: true, isRadio: false } as PlayerSource;
  },
}));

vi.mock('../engine', () => ({
  createEngine: async (_el: HTMLVideoElement, src: PlayerSource, _url: string, _cb: unknown, opts: { forceMpegts?: boolean }) => {
    h.created.push({ url: src.url, forceMpegts: !!opts.forceMpegts });
    return { kind: opts.forceMpegts ? 'mpegts' : 'native', destroy: () => undefined };
  },
  fetchFailureReason: async (url: string) => {
    h.probes.push(url);
    return h.probe;
  },
  looksLikeMpegTs: () => false,
  mseSupported: () => true,
  withReason: (fallback: string, reason: string | null, status?: number) => (reason ? (status ? `${reason} (HTTP ${status})` : reason) : fallback),
  worthSniffingAsMpegTs: () => true,
}));

function Probe({ ch, opts }: { ch: MultiviewChannelInput; opts: TilePlaybackOptions }) {
  const p = useTilePlayback(ch, opts);
  return (
    <div data-testid="tile" data-phase={p.phase} data-message={p.fault?.message ?? ''}>
      <video ref={p.videoRef} />
      <button type="button" onClick={p.retry}>
        retry
      </button>
    </div>
  );
}

const OPTS: TilePlaybackOptions = { audible: false, volume: 1, locked: false };
const tile = () => screen.getByTestId('tile');

/** The element gives up on the stream the way a browser reports a 503: code 4. */
function elementRefuses(): void {
  const video = tile().querySelector('video')!;
  Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' } });
  act(() => void video.dispatchEvent(new Event('error')));
}

beforeAll(() => installMediaStubs());
beforeEach(() => {
  h.created.length = 0;
  h.probes.length = 0;
  h.resolved.length = 0;
  h.probe = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('element errors that hide the HTTP status (L2-live-8)', () => {
  it('a stream our server says was refused (503) fails at once with the reason, without mpegts.js', async () => {
    h.probe = { status: 503, reason: 'Service Unavailable' };
    render(<Probe ch={input(1)} opts={OPTS} />);
    await waitFor(() => expect(h.created).toHaveLength(1));
    elementRefuses();
    await waitFor(() => expect(tile().dataset['phase']).toBe('error'));
    expect(tile().dataset['message']).toBe('Service Unavailable (HTTP 503)');
    expect(h.probes).toEqual(['/api/proxy?url=http%3A%2F%2Fprovider%2Flive%2Fc1']);
    // No second engine: mpegts.js would only be refused again.
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(h.created).toEqual([{ url: 'http://provider/live/c1', forceMpegts: false }]);
  });

  it('a stream the server answered (2xx) or could not explain gets one retry through mpegts.js', async () => {
    h.probe = null;
    render(<Probe ch={input(2)} opts={OPTS} />);
    await waitFor(() => expect(h.created).toHaveLength(1));
    elementRefuses();
    await waitFor(() => expect(h.created).toHaveLength(2));
    expect(h.created[1]).toEqual({ url: 'http://provider/live/c2', forceMpegts: true });
    expect(tile().dataset['phase']).not.toBe('error');
  });
});

describe('staggered first start (L2-live-13)', () => {
  it('waits its delay before the lookup and engine, and a retry starts at once', async () => {
    vi.useFakeTimers();
    render(<Probe ch={input(3)} opts={{ ...OPTS, startDelayMs: 64 }} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(60)));
    expect(h.resolved).toEqual([]);
    expect(tile().dataset['phase']).toBe('resolving');
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(h.resolved).toEqual(['c3']);
    expect(h.created).toHaveLength(1);

    act(() => screen.getByRole('button', { name: 'retry' }).click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(h.resolved).toEqual(['c3', 'c3']);
  });

  it('starts at once without a delay (the first slot)', async () => {
    render(<Probe ch={input(4)} opts={{ ...OPTS, startDelayMs: 0 }} />);
    await waitFor(() => expect(h.created).toHaveLength(1));
    expect(h.resolved).toEqual(['c4']);
  });
});
