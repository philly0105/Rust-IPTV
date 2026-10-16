// L1-vod-8: a channel move that reaches the core after a Remove landed must not roll back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { saveEntryOrder } = await import('../hooks/useListActions');
const { RpcError } = await import('@/api/transport');

const BBC = h.channel('1', 'BBC One');
const CNN = h.channel('2', 'CNN', { sourceId: 'src2' });
const ARTE = h.channel('3', 'Arte');
const ids = (refs: readonly ItemRef[]) => refs.map((r) => r.itemId);

beforeEach(() => {
  rpc.reset();
  h.resetShared();
});
afterEach(() => vi.restoreAllMocks());

describe('saveEntryOrder', () => {
  it('drops a channel a Remove already took out and saves the rest of the move', async () => {
    // The move was made while CNN was still listed; its Remove reached the core first.
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, ARTE])]);
    await saveEntryOrder('L1', [ARTE.ref, CNN.ref, BBC.ref]);
    expect(core.lists[0]!.items.map((i) => i.ref.itemId)).toEqual(['3', '1']);
    expect((rpc.callsOf('lists.reorderItems') as { refs: ItemRef[] }[]).map((c) => ids(c.refs))).toEqual([
      ['3', '2', '1'],
      ['3', '1'],
    ]);
  });

  it('sends the order once when the core takes it', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE])]);
    await saveEntryOrder('L1', [ARTE.ref, BBC.ref, CNN.ref]);
    expect(core.lists[0]!.items.map((i) => i.ref.itemId)).toEqual(['3', '1', '2']);
    expect(rpc.callsOf('lists.reorderItems')).toHaveLength(1);
    expect(rpc.callsOf('lists.items')).toHaveLength(0);
  });

  it('still fails when every channel is in the list (a real refusal), and on other errors', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN])]);
    rpc.handlers['lists.reorderItems'] = () => {
      throw new RpcError('invalid', 'refs[1] repeats a channel');
    };
    await expect(saveEntryOrder('L1', [BBC.ref, CNN.ref])).rejects.toThrow('repeats a channel');

    rpc.handlers['lists.reorderItems'] = () => {
      throw new RpcError('db', 'disk full');
    };
    await expect(saveEntryOrder('L1', [BBC.ref, CNN.ref])).rejects.toThrow('disk full');
    expect(rpc.callsOf('lists.items')).toHaveLength(1);
  });
});
