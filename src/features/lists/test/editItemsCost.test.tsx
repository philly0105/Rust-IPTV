// Edit channels on a list at the 2,000-channel cap (LV-6b): a move re-renders the rows it
// changes, not every row, both for the optimistic update and for the refetch that
// `lists.changed` brings.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rpcKey } from '@/api/query';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
/** Every channel logo the dialog rendered, by channel name: one per row render. */
const logos = vi.hoisted(() => [] as string[]);
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('../deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deps')>()),
  ChannelLogo: ({ name }: { name: string }) => {
    logos.push(name);
    return null;
  },
}));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { ListsDialogHost } = await import('../host');
await import('../dialogs/EditItemsDialog');
const { openEditListItems } = await import('../store');
const { queryClient } = await import('@/api/query');

const COUNT = 2000;
const CHANNELS = Array.from({ length: COUNT }, (_, i) => h.channel(String(i), `Ch ${i}`));

vi.setConfig({ testTimeout: 60_000 });
beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  logos.length = 0;
  h.installCore(rpc, [h.coreList('L1', 'Big', CHANNELS)]);
});
afterEach(cleanup);

async function openEdit() {
  render(
    <h.Providers>
      <ListsDialogHost />
    </h.Providers>,
  );
  const t0 = performance.now();
  act(() => openEditListItems('L1', { fromManage: false }));
  const dialog = await screen.findByTestId('edit-list-dialog');
  const list = await within(dialog).findByTestId('edit-list-items', {}, { timeout: 15_000 });
  return { dialog, list, ms: performance.now() - t0 };
}

const rows = (list: HTMLElement) => [...list.querySelectorAll('li')];
const names = (list: HTMLElement) => rows(list).map((li) => li.querySelector('.font-medium')?.textContent);
/** What `lists.changed` does after a write: the list's entries are fetched again. */
const refetch = () => act(() => queryClient.invalidateQueries({ queryKey: rpcKey('lists.items', { id: 'L1' }) }));

describe('Edit channels at 2,000 channels (LV-6b)', () => {
  it('a move re-renders only the rows it swaps', async () => {
    const { list, ms } = await openEdit();
    const mounted = rows(list).length;
    const mountRenders = logos.length;

    logos.length = 0;
    const grip = within(list).getByRole('button', { name: 'Move Ch 1' });
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(names(list).slice(0, 3)).toEqual(['Ch 0', 'Ch 2', 'Ch 1']));
    await waitFor(() => expect(rpc.callsOf('lists.reorderItems')).toHaveLength(1));
    await refetch();
    const moveRenders = logos.length;
    expect(document.activeElement).toBe(within(list).getByRole('button', { name: 'Move Ch 1' }));

    logos.length = 0;
    fireEvent.click(within(list).getByRole('button', { name: 'Remove Ch 0' }));
    await waitFor(() => expect(names(list)[0]).toBe('Ch 2'));
    await waitFor(() => expect(rpc.callsOf('lists.removeItems')).toHaveLength(1));
    await refetch();
    const removeRenders = logos.length;

    console.log(
      `[measure LV-6b] ${COUNT} entries: mount ${ms.toFixed(0)} ms, ${mounted} rows mounted, ${mountRenders} row renders; ` +
        `Alt+ArrowDown ${moveRenders} row renders, removal ${removeRenders} row renders (optimistic + refetch)`,
    );
    // The two rows that swapped.
    expect(moveRenders).toBeLessThanOrEqual(4);
  });
});
