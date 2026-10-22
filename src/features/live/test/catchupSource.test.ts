import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram } from '@/api/types';

// What `catchupSource` hands the built-in player for seeking an archive (players.md, Seeking in
// MPEG-TS): the programme's length only where the archive ends with it, and the window to ask
// for again from a later minute only where the portal can do that (Xtream).

const calls = vi.hoisted(() => [] as { cmd: string; args: unknown }[]);
vi.mock('@/api/transport', () => ({
  rpc: async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (cmd === 'xtream.catchupUrl' || cmd === 'stalker.catchupUrl') {
      return { url: 'http://portal/archive.ts', kind: 'direct', title: 'Channel', isLive: false, isRadio: false };
    }
    if (cmd === 'sources.get') return { id: 's1', m3u: {} };
    throw new Error(`unmocked rpc ${cmd}`);
  },
}));
vi.mock('@/features/player', () => ({ playItem: vi.fn(), playSource: vi.fn() }));

const { catchupSource } = await import('../lib/playback');

const ref = { sourceId: 's1', contentType: 'live' as const, itemId: '10' };
// 30 minutes, watched an hour after it ended.
const program = { start: '2026-10-22T18:00:00Z', end: '2026-10-22T18:30:00Z', title: 'News' } as EpgProgram;
const NOW = Date.parse('2026-10-22T19:30:00Z');
const channel = (extra: Partial<Channel> = {}): Channel => ({ ref, name: 'Channel', ...extra }) as Channel;
const m3u = (url: string, catchup: Channel['catchup']): Channel => channel({ url, archive: { enabled: true, durationHours: 24 }, catchup });

beforeEach(() => {
  calls.length = 0;
});

describe('catchupSource for the built-in player (PL-2)', () => {
  it('Xtream: the length and the window to ask for again from a later minute', async () => {
    const src = await catchupSource(channel(), 'xtream', program, NOW);
    expect(src.durationSeconds).toBe(1800);
    expect(src.catchup).toEqual({ start: program.start, durationMinutes: 30 });
    expect(calls[0]).toEqual({ cmd: 'xtream.catchupUrl', args: { ref, start: program.start, durationMinutes: 30 } });
  });

  it("Stalker: the length only, since its link names a whole programme and can't start later", async () => {
    const src = await catchupSource(channel(), 'stalker', program, NOW);
    expect(src.durationSeconds).toBe(1800);
    expect(src.catchup).toBeUndefined();
  });

  it.each([
    ['an Xtream-style path', m3u('http://host:8080/live/u/p/101.ts', { type: 'xc' })],
    ['a template with an end', m3u('http://host/live/ch1.ts', { type: 'default', source: 'http://arc/x.ts?start={utc}&end={utcend}' })],
    ["Flussonic's HLS form", m3u('http://fl.example/ch1/index.m3u8', { type: 'flussonic' })],
  ])('M3U archive that ends with the programme (%s): the length, no window', async (_name, ch) => {
    const src = await catchupSource(ch, 'm3u', program, NOW);
    expect(src.durationSeconds).toBe(1800);
    expect(src.catchup).toBeUndefined();
  });

  it.each([
    ['shift', m3u('http://host/live/ch1.ts', { type: 'shift' })],
    ['a template without an end', m3u('http://host/live/ch1.ts', { type: 'default', source: 'http://arc/x.ts?start={utc}' })],
    ["Flussonic's MPEG-TS form", m3u('http://fl.example/ch1/mpegts', { type: 'flussonic' })],
  ])('M3U archive that plays on into the next programmes (%s): no length', async (_name, ch) => {
    const src = await catchupSource(ch, 'm3u', program, NOW);
    expect(src.url).toMatch(/^http:/);
    expect(src.durationSeconds).toBeUndefined();
    expect(src.catchup).toBeUndefined();
  });
});
