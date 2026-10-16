// Optimistic edits and one refresh per write (L2-live-11): a rename shows in
// the cached rows before the core answers, a hide takes the row out of the
// cached pages, both go back when the core refuses, and the queries are
// refreshed once: by the core's `channels.changed` when the event connection
// is open, here only when that event does not come or there is no connection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { Channel, Page } from '@/api/types';
import { useToastStore } from '@/ui';

import { hideChannel, renameChannel, resetName, type T } from '../actions';
import { EDIT_EVENT_WAIT_MS } from '../edits';
import { core, events, fail, i18n, makeChannel } from './harness';

vi.mock('@/api/transport', async (orig) => {
  const actual = await orig<typeof import('@/api/transport')>();
  const { core } = await import('./harness');
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await core.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', async () => (await import('./harness')).eventsMock);

const t = i18n.getFixedT('en', 'channels') as unknown as T;
const chs = Array.from({ length: 6 }, (_, i) => makeChannel(`c${i}`, `Channel ${i}`));
const bbc = chs[1]!;

const pageKey = (offset: number, extra: Record<string, unknown> = {}) =>
  rpcKey('catalog.channels', { sourceId: 'src1', ...extra, query: { offset, limit: 3 } });
const pageOf = (offset: number): Page<Channel> => ({ items: chs.slice(offset, offset + 3), total: chs.length, offset, limit: 3 });
const cached = (key: ReturnType<typeof pageKey>) => queryClient.getQueryData<Page<Channel>>(key)!;
const names = (key: ReturnType<typeof pageKey>) => cached(key).items.map((c) => c.name);
const invalidated = (key: ReturnType<typeof pageKey>) => queryClient.getQueryState(key)?.isInvalidated ?? false;

/** A command that answers when the test says so. */
function deferred(cmd: string) {
  let release!: (fn: () => unknown) => void;
  const gate = new Promise<() => unknown>((r) => (release = r));
  core.override(cmd, async () => (await gate)());
  return { release };
}

beforeEach(() => {
  core.reset();
  core.add(...chs);
  events.reset();
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
  queryClient.setQueryData(pageKey(0), pageOf(0));
  queryClient.setQueryData(pageKey(3), pageOf(3));
  queryClient.setQueryData(rpcKey('catalog.item', { ref: bbc.ref }), bbc);
});
afterEach(() => vi.useRealTimers());

describe('optimistic rename', () => {
  it('shows the new name in cached rows and the item before the core answers', async () => {
    const rename = deferred('channels.rename');
    const done = renameChannel(bbc.ref, 'My News');
    expect(names(pageKey(0))).toEqual(['Channel 0', 'My News', 'Channel 2']);
    expect(queryClient.getQueryData<Channel>(rpcKey('catalog.item', { ref: bbc.ref }))!.name).toBe('My News');
    // The other page does not hold the channel and is left alone.
    expect(names(pageKey(3))).toEqual(['Channel 3', 'Channel 4', 'Channel 5']);
    rename.release(() => core.base('channels.rename')({ ref: bbc.ref, name: 'My News' }));
    await done;
    expect(core.nameOf(bbc.ref)).toBe('My News');
  });

  it('puts the old name back when the core refuses', async () => {
    core.override('channels.rename', () => fail('invalid', 'name must be 1 to 120 characters.'));
    await expect(renameChannel(bbc.ref, 'x'.repeat(130))).rejects.toMatchObject({ code: 'invalid' });
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 1', 'Channel 2']);
    expect(queryClient.getQueryData<Channel>(rpcKey('catalog.item', { ref: bbc.ref }))!.name).toBe('Channel 1');
  });

  it('a reset shows the provider name when it is known, and patches nothing otherwise', async () => {
    core.seed(bbc.ref, { name: 'My News', originalName: 'Channel 1' });
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: pageOf(0).items.map((c) => (c === bbc ? { ...c, name: 'My News' } : c)) });
    const rename = deferred('channels.rename');
    const done = resetName(bbc.ref, core.edits.get('src1|live|c1')!, 'Channel 1', t);
    expect(names(pageKey(0))[1]).toBe('Channel 1');
    rename.release(() => core.base('channels.rename')({ ref: bbc.ref, name: null }));
    await expect(done).resolves.toBe(true);

    // Without the provider's name there is nothing certain to show: the row waits for the refresh.
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: pageOf(0).items.map((c) => (c === bbc ? { ...c, name: 'My News' } : c)) });
    const again = deferred('channels.rename');
    const plain = renameChannel(bbc.ref, null);
    expect(names(pageKey(0))[1]).toBe('My News');
    again.release(() => null);
    await plain;
  });
});

describe('optimistic hide', () => {
  it('takes the row out at once, closes the gap in the next page and counts one less', async () => {
    const hide = deferred('channels.setHidden');
    const done = hideChannel({ ref: bbc.ref, name: 'Channel 1' }, t);
    await Promise.resolve();
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 2']);
    expect(cached(pageKey(0)).total).toBe(5);
    // Index 2 now reads the next page's first row (Channel 3), as after the refetch.
    expect(cached(pageKey(3))).toMatchObject({ offset: 2, total: 5 });
    hide.release(() => null);
    await expect(done).resolves.toBe(true);
  });

  it('leaves lists whose cached pages do not hold the channel', async () => {
    queryClient.setQueryData(pageKey(0, { categoryId: 'sport' }), { items: [chs[4]!], total: 1, offset: 0, limit: 3 });
    await hideChannel({ ref: bbc.ref, name: 'Channel 1' }, t);
    expect(cached(pageKey(0, { categoryId: 'sport' }))).toMatchObject({ total: 1, offset: 0 });
  });

  it('brings the row back when the core refuses', async () => {
    core.override('channels.setHidden', () => fail('not_found', 'channel c1 not found in source src1; refresh the source'));
    await expect(hideChannel({ ref: bbc.ref, name: 'Channel 1' }, t)).resolves.toBe(false);
    expect(cached(pageKey(0))).toEqual(pageOf(0));
    expect(cached(pageKey(3))).toEqual(pageOf(3));
    expect(useToastStore.getState().toasts.at(-1)?.variant).toBe('error');
  });
});

describe('one refresh per write', () => {
  it('without an event connection the write refreshes its queries at once', async () => {
    await renameChannel(bbc.ref, 'My News');
    expect(invalidated(pageKey(3))).toBe(true);
  });

  it('with the connection open, an arriving channels.changed does the refresh and the write skips its own', async () => {
    vi.useFakeTimers();
    events.state = 'open';
    core.override('channels.rename', (args) => {
      const row = core.base('channels.rename')(args);
      // The core emits the event after the write; the app's event binding refreshes for it.
      events.emit('channels.changed', { sourceId: 'src1' });
      return row;
    });
    await renameChannel(bbc.ref, 'My News');
    await vi.advanceTimersByTimeAsync(EDIT_EVENT_WAIT_MS * 2);
    expect(invalidated(pageKey(3))).toBe(false);
    expect(events.handlers.get('channels.changed')?.size ?? 0).toBe(0);
  });

  it('with the connection open but no event in time, the write refreshes after the wait', async () => {
    vi.useFakeTimers();
    events.state = 'open';
    await hideChannel({ ref: bbc.ref, name: 'Channel 1' }, t);
    await vi.advanceTimersByTimeAsync(EDIT_EVENT_WAIT_MS - 50);
    expect(invalidated(pageKey(3))).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(invalidated(pageKey(3))).toBe(true);
    expect(events.handlers.get('channels.changed')?.size ?? 0).toBe(0);
  });

  it('a refused write neither refreshes nor keeps listening', async () => {
    events.state = 'open';
    core.override('channels.rename', () => fail('invalid', 'bad'));
    await expect(renameChannel(bbc.ref, 'x')).rejects.toBeTruthy();
    expect(events.handlers.get('channels.changed')?.size ?? 0).toBe(0);
    expect(invalidated(pageKey(3))).toBe(false);
  });
});
