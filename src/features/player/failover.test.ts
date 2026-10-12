import { describe, expect, it, vi } from 'vitest';

import type { PlayerSource, SourceKind } from '@/api/types';

const kinds: Record<string, SourceKind> = { st: 'stalker', xt: 'xtream', m: 'm3u' };
const rpcMock = vi.fn(async (name: string, args?: unknown): Promise<unknown> => {
  if (name === 'settings.get') return { vodAutoFailover: true };
  if (name === 'sources.get') {
    const kind = kinds[(args as { id: string }).id];
    if (!kind) throw Object.assign(new Error('no such source'), { code: 'not_found' });
    return { id: (args as { id: string }).id, kind, name: 'S' };
  }
  if (name === 'catalog.sameTitle') return [];
  throw new Error(`unmocked rpc ${name}`);
});

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { tryFailover } = await import('./failover');

const movie = (sourceId: string, itemId: string): PlayerSource => ({
  url: `http://h/movie/${itemId}.mp4`,
  kind: 'direct',
  title: 'Movie',
  isLive: false,
  isRadio: false,
  ref: { sourceId, contentType: 'movie', itemId },
});

const sameTitleCalls = (): number => rpcMock.mock.calls.filter(([name]) => name === 'catalog.sameTitle').length;

describe('tryFailover', () => {
  it('does not ask the catalog for a Stalker movie (not in the local catalog: the core answers not_found)', async () => {
    const before = sameTitleCalls();
    await expect(tryFailover(movie('st', '1'))).resolves.toBeNull();
    expect(sameTitleCalls()).toBe(before);
  });

  it('does not ask when the source kind cannot be looked up', async () => {
    const before = sameTitleCalls();
    await expect(tryFailover(movie('gone', '2'))).resolves.toBeNull();
    expect(sameTitleCalls()).toBe(before);
  });

  it.each(['xt', 'm'])('asks for a movie on a known %s source', async (sourceId) => {
    const before = sameTitleCalls();
    await tryFailover(movie(sourceId, '3'));
    expect(sameTitleCalls()).toBe(before + 1);
  });
});
