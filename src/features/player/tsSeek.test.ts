import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';

const rpcMock = vi.fn();
vi.mock('@/api/transport', () => ({
  rpc: (...args: unknown[]) => rpcMock(...args),
  proxiedUrl: (s: PlayerSource) => `/api/proxy?url=${encodeURIComponent(s.url)}`,
}));

const { tsSeekerFor } = await import('./tsSeek');

function vod(url: string, extra: Partial<PlayerSource> = {}): PlayerSource {
  return { url, kind: 'file', title: 'Rec', isLive: false, isRadio: false, ...extra };
}

const signal = new AbortController().signal;

beforeEach(() => {
  rpcMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('seeking Xtream catch-up by asking from a later minute (PL-2)', () => {
  const ref = { sourceId: 'x', contentType: 'live' as const, itemId: '10' };
  const archive = (extra: Partial<PlayerSource> = {}): PlayerSource =>
    vod('http://p/timeshift/u/p/90/2026-10-22:18-00/10.ts', {
      kind: 'direct',
      ref,
      durationSeconds: 5400,
      catchup: { start: '2026-10-22T18:00:00Z', durationMinutes: 90 },
      ...extra,
    });

  it('asks for the archive from the target minute with what is left of the programme', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T21:00:00Z'));
    rpcMock.mockResolvedValue({ url: 'http://p/timeshift/u/p/70/2026-10-22:18-20/10.ts', kind: 'direct', title: 'x', isLive: false, isRadio: false });
    const seeker = tsSeekerFor(archive(), '/api/proxy?url=first')!;
    expect(seeker.duration()).toBe(5400);

    const plan = await seeker.startAt(20 * 60 + 34, signal);
    expect(rpcMock).toHaveBeenCalledWith('xtream.catchupUrl', { ref, start: '2026-10-22T18:20:00.000Z', durationMinutes: 70 });
    expect(plan).toEqual({ url: `/api/proxy?url=${encodeURIComponent('http://p/timeshift/u/p/70/2026-10-22:18-20/10.ts')}`, at: 1200 });

    // The first minute is the link already playing.
    rpcMock.mockClear();
    expect(await seeker.startAt(42, signal)).toEqual({ url: '/api/proxy?url=first', at: 0 });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a programme still on air restarts at its last aired minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T18:30:30Z'));
    rpcMock.mockResolvedValue({ url: 'http://p/x.ts', kind: 'direct', title: 'x', isLive: false, isRadio: false });
    const plan = await tsSeekerFor(archive(), '/api/proxy?url=first')!.startAt(60 * 60, signal);
    expect(rpcMock).toHaveBeenCalledWith('xtream.catchupUrl', expect.objectContaining({ start: '2026-10-22T18:29:00.000Z', durationMinutes: 61 }));
    expect(plan?.at).toBe(29 * 60);
  });

  it('a failed lookup is an error for the engine to report', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T21:00:00Z'));
    rpcMock.mockRejectedValue(new Error('panel down'));
    await expect(tsSeekerFor(archive(), '/api/proxy?url=first')!.startAt(1800, signal)).rejects.toThrow('panel down');
  });
});
