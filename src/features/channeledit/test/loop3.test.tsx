// Campaign loop 3 (live channels): an unhide puts the row back in the cached
// lists at once (L3-live-8), F2 and Shift+Delete ask for the focused row when
// the key is pressed (L3-live-6), and the dialogs' code can be fetched ahead
// of the first open so it renders without a suspended frame (L3-live-6).
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { Channel, Page } from '@/api/types';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useToastStore } from '@/ui';

import { ChannelEditDialogHost, useChannelEditShortcuts } from '..';
import { hideChannel, unhideChannel, type T } from '../actions';
import { lazyDialog } from '../DialogHost';
import { __resetHiddenPlaces } from '../edits';
import { useRenameStore } from '../store';
import { core, fail, i18n, installDomStubs, makeChannel, renderUi } from './harness';

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
const chs = Array.from({ length: 6 }, (_, i) => ({ ...makeChannel(`c${i}`, `Channel ${i}`), number: (i + 1) * 10 }));
const one = chs[1]!;

const pageKey = (offset: number, extra: Record<string, unknown> = {}) =>
  rpcKey('catalog.channels', { sourceId: 'src1', ...extra, query: { offset, limit: 3 } });
const pageOf = (offset: number): Page<Channel> => ({ items: chs.slice(offset, offset + 3), total: chs.length, offset, limit: 3 });
const cached = (key: ReturnType<typeof pageKey>) => queryClient.getQueryData<Page<Channel>>(key)!;
const names = (key: ReturnType<typeof pageKey>) => cached(key).items.map((c) => c.name);

beforeAll(installDomStubs);
beforeEach(() => {
  core.reset();
  core.add(...chs);
  queryClient.clear();
  __resetHiddenPlaces();
  useToastStore.setState({ toasts: [] });
  useRenameStore.setState({ request: null });
  shortcutRegistry.reset();
  queryClient.setQueryData(pageKey(0), pageOf(0));
  queryClient.setQueryData(pageKey(3), pageOf(3));
});
afterEach(cleanup);

describe('optimistic unhide (L3-live-8)', () => {
  it('puts the row back where this window hid it before the core answers, and counts one more', async () => {
    await hideChannel({ ref: one.ref, name: one.name }, t);
    // The refresh after the hide would refetch; the test keeps the patched pages.
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: [chs[0]!, chs[2]!], total: 5 });
    queryClient.setQueryData(pageKey(3), { ...pageOf(3), offset: 2, total: 5 });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    core.override('channels.setHidden', async (a) => {
      await gate;
      return core.base('channels.setHidden')(a);
    });
    const done = unhideChannel({ ref: one.ref, name: one.name }, t);
    await Promise.resolve();
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 1', 'Channel 2']);
    expect(cached(pageKey(0)).total).toBe(6);
    expect(cached(pageKey(3))).toMatchObject({ offset: 3, total: 6 });
    release();
    await expect(done).resolves.toBe(true);
  });

  it('places a channel hidden in another session by its number, from its cached item', async () => {
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: [chs[0]!, chs[2]!], total: 5 });
    queryClient.setQueryData(pageKey(3), { ...pageOf(3), offset: 2, total: 5 });
    queryClient.setQueryData(rpcKey('catalog.item', { ref: one.ref }), one);
    core.seed(one.ref, { hidden: true });
    const done = unhideChannel({ ref: one.ref, name: one.name }, t);
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 1', 'Channel 2']);
    await expect(done).resolves.toBe(true);
  });

  it('leaves a search and another group alone', async () => {
    const searchKey = rpcKey('catalog.channels', { sourceId: 'src1', query: { offset: 0, limit: 3, search: 'Channel' } });
    const sport = pageKey(0, { categoryId: 'sport' });
    queryClient.setQueryData(searchKey, { items: [chs[0]!], total: 1, offset: 0, limit: 3 });
    queryClient.setQueryData(sport, { items: [], total: 0, offset: 0, limit: 3 });
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: [chs[0]!, chs[2]!], total: 5 });
    queryClient.setQueryData(rpcKey('catalog.item', { ref: one.ref }), one);
    const done = unhideChannel({ ref: one.ref, name: one.name }, t);
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 1', 'Channel 2']);
    expect(queryClient.getQueryData<Page<Channel>>(searchKey)!.total).toBe(1);
    expect(queryClient.getQueryData<Page<Channel>>(sport)!.total).toBe(0);
    await done;
  });

  it('takes the row out again when the core refuses', async () => {
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: [chs[0]!, chs[2]!], total: 5 });
    queryClient.setQueryData(rpcKey('catalog.item', { ref: one.ref }), one);
    core.override('channels.setHidden', () => fail('invalid', 'refs must hold 1 to 500 items.'));
    await expect(unhideChannel({ ref: one.ref, name: one.name }, t)).resolves.toBe(false);
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 2']);
    expect(cached(pageKey(0)).total).toBe(5);
  });

  it('takes the row out again when the provider has dropped the channel', async () => {
    await hideChannel({ ref: one.ref, name: one.name }, t);
    queryClient.setQueryData(pageKey(0), { ...pageOf(0), items: [chs[0]!, chs[2]!], total: 5 });
    queryClient.removeQueries({ queryKey: rpcKey('catalog.item', { ref: one.ref }) });
    core.drop(one.ref);
    await expect(unhideChannel({ ref: one.ref, name: one.name }, t)).resolves.toBe(true);
    expect(names(pageKey(0))).toEqual(['Channel 0', 'Channel 2']);
    expect(useToastStore.getState().toasts.at(-1)?.variant).toBe('info');
  });
});

function Keys({ focused }: { focused: () => Channel | undefined }) {
  useChannelEditShortcuts(focused);
  return <ChannelEditDialogHost />;
}

describe('F2 asks for the focused row at key time (L3-live-6)', () => {
  it('stays bound and renames whatever row the resolver answers when the key comes', () => {
    let row: Channel | undefined;
    renderUi(<Keys focused={() => row} />, queryClient);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })));
    expect(useRenameStore.getState().request).toBeNull();

    // Focus came back without a focus event the page could track (a dialog handing it back).
    row = chs[2];
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })));
    expect(useRenameStore.getState().request?.channel.ref).toEqual(chs[2]!.ref);
    // The dialog's edits are on their way beside its code.
    expect(core.callsOf('channels.edits')).toContainEqual({ sourceId: 'src1' });
  });
});

describe('lazyDialog preload (L3-live-6)', () => {
  it('renders in the same commit once preloaded, with no suspended frame', async () => {
    let loads = 0;
    const Dialog = lazyDialog<{ onClose: () => void }>(async () => {
      loads++;
      return () => <p>dialog body</p>;
    });
    await Dialog.preload();
    await Dialog.preload();
    expect(loads).toBe(1);
    render(
      <Suspense fallback={<p>waiting</p>}>
        <Dialog onClose={() => undefined} />
      </Suspense>,
    );
    expect(screen.getByText('dialog body')).toBeTruthy();
    expect(screen.queryByText('waiting')).toBeNull();
  });

  it('forgets a failed preload, so the open tries again', async () => {
    let loads = 0;
    const Dialog = lazyDialog<{ onClose: () => void }>(async () => {
      loads++;
      if (loads === 1) throw new Error('offline');
      return () => <p>second try</p>;
    });
    await Dialog.preload();
    await Dialog.preload();
    expect(loads).toBe(2);
    render(<Dialog onClose={() => undefined} />);
    expect(screen.getByText('second try')).toBeTruthy();
  });
});
