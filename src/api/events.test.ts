import { afterEach, describe, expect, it, vi } from 'vitest';

import { onAnyAppEvent } from './events';
import { notifyServerAnswered } from './reachability';
import type { AppEvent } from './types';

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: MessageEvent) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close(): void {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.all = [];
});

describe('web event socket', () => {
  it('reports a reconnect as events.lagged so every query refetches', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const seen: AppEvent[] = [];
    const stop = onAnyAppEvent((e) => seen.push(e));

    FakeSocket.all[0]!.onopen?.();
    expect(seen).toEqual([]); // the first open is not a reconnect

    FakeSocket.all[0]!.onclose?.();
    vi.advanceTimersByTime(20_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.onopen?.();
    expect(seen.map((e) => e.type)).toEqual(['events.lagged']);

    stop();
  });

  it('refetches everything when a page opened while the server was down finally connects', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const seen: AppEvent[] = [];
    const stop = onAnyAppEvent((e) => seen.push(e));

    // Never connected: the first attempts fail (the server is restarting).
    FakeSocket.all[0]!.onclose?.();
    vi.advanceTimersByTime(5_000);
    FakeSocket.all[1]!.onclose?.();
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.onopen?.();
    expect(seen.map((e) => e.type)).toEqual(['events.lagged']);

    stop();
  });

  it('caps the reconnect wait at about 5 s', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const stop = onAnyAppEvent(() => undefined);
    for (let i = 0; i < 8; i++) {
      FakeSocket.all.at(-1)!.onclose?.();
      vi.advanceTimersByTime(5_200);
      expect(FakeSocket.all).toHaveLength(i + 2);
    }
    stop();
  });

  it.each([
    ['focus', () => window.dispatchEvent(new Event('focus'))],
    ['online', () => window.dispatchEvent(new Event('online'))],
    ['a server answer', () => notifyServerAnswered()],
  ])('skips the backoff wait on %s', (_name, nudge) => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const stop = onAnyAppEvent(() => undefined);
    for (let i = 0; i < 4; i++) {
      FakeSocket.all.at(-1)!.onclose?.();
      vi.advanceTimersByTime(5_200);
    }
    FakeSocket.all.at(-1)!.onclose?.();
    const before = FakeSocket.all.length;
    nudge();
    expect(FakeSocket.all).toHaveLength(before + 1);
    // Only while waiting: a nudge during the new attempt opens no second socket.
    nudge();
    expect(FakeSocket.all).toHaveLength(before + 1);
    stop();
  });

  it('asks /api/health every second during a long backoff and reconnects once it answers (L3-app-10)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    let up = false;
    const fetchMock = vi.fn(async () => ({ ok: up }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const seen: AppEvent[] = [];
    const stop = onAnyAppEvent((e) => seen.push(e));
    FakeSocket.all[0]!.onopen?.();
    // An outage: three failed attempts push the backoff to 2-2.6 s.
    for (let i = 0; i < 3; i++) {
      FakeSocket.all.at(-1)!.onclose?.();
      if (i < 2) await vi.advanceTimersByTimeAsync(1_400);
    }
    const before = FakeSocket.all.length;
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
    expect(FakeSocket.all).toHaveLength(before); // still down: keep waiting
    up = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(before + 1); // about 2 s, not the rest of the backoff
    FakeSocket.all.at(-1)!.onopen?.();
    expect(seen.map((e) => e.type)).toEqual(['events.lagged']);
    // Open again: no more polling.
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    stop();
  });

  it('stops listening for nudges once nobody is subscribed', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const stop = onAnyAppEvent(() => undefined);
    FakeSocket.all[0]!.onclose?.();
    stop();
    window.dispatchEvent(new Event('focus'));
    notifyServerAnswered();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
