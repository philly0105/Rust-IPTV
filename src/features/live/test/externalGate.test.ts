import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel } from '@/api/types';

// C2: a channel opened outside the built-in player (Play in MPV/VLC, Copy stream address) goes
// through the same parental gate as inline playback. A refused gate resolves nothing.

const mocks = vi.hoisted(() => ({
  allow: true,
  gateCalls: [] as unknown[][],
  rpcCalls: [] as { cmd: string; args: unknown }[],
}));

vi.mock('@/features/parental/gate', () => ({
  ensureUnlocked: async (items: unknown[]) => {
    mocks.gateCalls.push(items);
    return mocks.allow;
  },
}));
vi.mock('@/api/transport', () => ({
  rpc: async (cmd: string, args?: unknown) => {
    mocks.rpcCalls.push({ cmd, args });
    if (cmd === 'xtream.streamUrl') return { url: 'http://cdn/live/1.m3u8', kind: 'hls' };
    throw new Error(`unmocked rpc ${cmd}`);
  },
}));
vi.mock('@/features/player', () => ({ playItem: vi.fn(), playSource: vi.fn() }));

const { openChannelSource } = await import('../lib/playback');

const channel: Channel = {
  ref: { sourceId: 'src1', contentType: 'live', itemId: '1' },
  name: 'UK | News 1',
  categoryId: 'news',
  url: 'http://127.0.0.1:9/live/1.m3u8',
} as Channel;

beforeEach(() => {
  mocks.allow = true;
  mocks.gateCalls.length = 0;
  mocks.rpcCalls.length = 0;
});

describe('openChannelSource (external player, copy link)', () => {
  it('asks the gate with the channel, its group and its display name before resolving', async () => {
    const s = await openChannelSource(channel, { kind: 'm3u' }, 'News 1');
    expect(mocks.gateCalls).toEqual([[{ ref: channel.ref, categoryId: 'news', title: 'News 1' }]]);
    expect(s?.url).toBe('http://127.0.0.1:9/live/1.m3u8');
    expect(s?.title).toBe('News 1');
  });

  it('resolves nothing (no stream address request) when the PIN prompt is cancelled', async () => {
    mocks.allow = false;
    expect(await openChannelSource(channel, { kind: 'xtream' }, 'News 1')).toBeNull();
    expect(mocks.gateCalls).toHaveLength(1);
    // The provider's stream address (with the login in it) is never fetched for a refused channel.
    expect(mocks.rpcCalls).toEqual([]);
  });

  it('resolves through the provider once allowed', async () => {
    const s = await openChannelSource(channel, { kind: 'xtream' }, 'News 1');
    expect(mocks.rpcCalls.map((c) => c.cmd)).toEqual(['xtream.streamUrl']);
    expect(s?.url).toBe('http://cdn/live/1.m3u8');
  });
});
