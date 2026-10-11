import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};

vi.mock('@/api/transport', () => ({
  rpc: async (name: string, args?: unknown) => {
    const h = handlers[name];
    if (!h) throw new Error(`unmocked rpc ${name}`);
    return h(args);
  },
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { resolveSource } = await import('./store');

const ref: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '101' };
const args = { ref, title: 'BBC One', isLive: true, sourceKind: 'm3u' } as const;

function item(headers?: Record<string, string>) {
  return {
    ref,
    name: 'BBC One',
    categoryId: 'g',
    categoryName: 'UK',
    isRadio: false,
    url: 'http://m/one.m3u8',
    ...(headers ? { headers } : {}),
  };
}

function source(headers: Record<string, string>) {
  return { id: 's1', kind: 'm3u', m3u: { origin: 'url', url: 'http://m/list.m3u', headers } };
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
});

describe('resolveSource per-channel headers (m3u)', () => {
  it('merges channel headers over the playlist headers, field by field', async () => {
    handlers['catalog.item'] = () => item({ userAgent: 'VLC/3.0', referrer: 'http://chan.example/' });
    handlers['sources.get'] = () => source({ userAgent: 'Playlist/1', origin: 'http://pl.example' });
    const out = await resolveSource(args);
    expect(out.headers).toEqual({
      userAgent: 'VLC/3.0',
      referrer: 'http://chan.example/',
      origin: 'http://pl.example',
    });
  });

  it('uses channel headers when the playlist has none', async () => {
    handlers['catalog.item'] = () => item({ referrer: 'http://chan.example/' });
    handlers['sources.get'] = () => source({});
    const out = await resolveSource(args);
    expect(out.headers).toEqual({ referrer: 'http://chan.example/' });
  });

  it('keeps the playlist headers when the channel has none, and omits empty ones', async () => {
    handlers['catalog.item'] = () => item();
    handlers['sources.get'] = () => source({ userAgent: 'Playlist/1', referrer: '' });
    expect((await resolveSource(args)).headers).toEqual({ userAgent: 'Playlist/1' });

    handlers['sources.get'] = () => source({});
    expect((await resolveSource(args)).headers).toBeUndefined();
  });

  it('still applies channel headers when the source lookup fails', async () => {
    handlers['catalog.item'] = () => item({ userAgent: 'VLC/3.0' });
    handlers['sources.get'] = () => {
      throw new Error('gone');
    };
    expect((await resolveSource(args)).headers).toEqual({ userAgent: 'VLC/3.0' });
  });
});
