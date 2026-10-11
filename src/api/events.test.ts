import { afterEach, describe, expect, it, vi } from 'vitest';

import { onAnyAppEvent } from './events';
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
});
