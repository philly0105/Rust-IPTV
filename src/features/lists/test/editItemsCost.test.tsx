// Edit channels on a list at the 2,000-channel cap (LV-6b): the dialog mounts the rows on screen,
// not all of them, and a move or a removal re-renders the rows it changes, not every row, both
// for the optimistic update and for the refetch that `lists.changed` brings.
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
  const ms = performance.now() - t0;
  // The virtualizer reads the scroller's size after the first commit and mounts the rest of the screen.
  await act(() => new Promise((r) => setTimeout(r, 50)));
  return { dialog, list, ms };
}

const rows = (list: HTMLElement) => [...list.querySelectorAll('li')];
const names = (list: HTMLElement) => rows(list).map((li) => li.querySelector('.font-medium')?.textContent);
/** What `lists.changed` does after a write: the list's entries are fetched again. */
const refetch = () => act(() => queryClient.invalidateQueries({ queryKey: rpcKey('lists.items', { id: 'L1' }) }));

describe('Edit channels at 2,000 channels (LV-6b)', () => {
  it('mounts the rows on screen, and a move or a removal re-renders only the rows it changes', async () => {
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
    expect(mounted).toBeLessThan(60);
    // The two rows that swapped.
    expect(moveRenders).toBeLessThanOrEqual(4);
    // The rows on screen below the removed one move up a place, once for the removal and once for
    // the refetch's new positions; nothing off screen renders.
    expect(removeRenders).toBeLessThanOrEqual(2 * mounted);
  });
});

describe('Edit channels as a virtual list (LV-6b)', () => {
  /** jsdom has no layout and does not scroll: the list's scroller gets a size, moves and says so, as a browser's does. */
  function scrollable(list: HTMLElement) {
    const scroller = list.parentElement!;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (y: number) => {
        top = y;
      },
    });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => scroller.offsetHeight });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => Number.parseFloat(list.style.height) });
    // A browser fires the scroll event later, never inside scrollTo (which can run in a commit).
    scroller.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
      setTimeout(() => scroller.dispatchEvent(new Event('scroll')));
    }) as typeof scroller.scrollTo;
    return async (y: number) => {
      scroller.scrollTo({ top: y });
      await act(() => new Promise((r) => setTimeout(r, 0)));
    };
  }
  const grip = (list: HTMLElement, i: number) => within(list).queryByRole('button', { name: `Move Ch ${i}` });

  it('tells screen readers where each mounted row sits in the whole list', async () => {
    const { list } = await openEdit();
    const third = rows(list)[2]!;
    expect(third.getAttribute('aria-setsize')).toBe(String(COUNT));
    expect(third.getAttribute('aria-posinset')).toBe('3');
  });

  it('arrow keys scroll the next row in and focus it, and Alt+ArrowDown keeps focus on a row it moves off screen', async () => {
    const { list } = await openEdit();
    scrollable(list);
    const lastMounted = rows(list).length - 1;
    expect(grip(list, lastMounted + 1)).toBeNull();

    act(() => grip(list, lastMounted)!.focus());
    fireEvent.keyDown(grip(list, lastMounted)!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(grip(list, lastMounted + 1)));

    const below = lastMounted + 1;
    for (let step = 1; step <= 12; step++) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', altKey: true });
      await waitFor(() => expect(grip(list, below)?.closest('li')?.getAttribute('aria-posinset')).toBe(String(below + step + 1)));
      await waitFor(() => expect(document.activeElement).toBe(grip(list, below)));
    }
    // Twelve places further down, past every row that was mounted.
    const order = rpc.callsOf('lists.reorderItems').at(-1) as { refs: { itemId: string }[] };
    expect(order.refs.findIndex((r) => r.itemId === String(below))).toBe(below + 12);
  });

  it('keeps the dragged row mounted while the list scrolls away from it, and lets it go when the drag ends', async () => {
    const { list } = await openEdit();
    const scrollTo = scrollable(list);
    fireEvent.dragStart(grip(list, 0)!, { dataTransfer: { effectAllowed: '', setData: () => undefined } });
    await scrollTo(46 * 500);
    await waitFor(() => expect(grip(list, 500)).not.toBeNull());
    expect(grip(list, 0)).not.toBeNull();
    fireEvent.dragEnd(grip(list, 0)!);
    await waitFor(() => expect(grip(list, 0)).toBeNull());
  });

  it('keeps the row with focus mounted while the list scrolls away from it, so Escape still closes the dialog', async () => {
    const { dialog, list } = await openEdit();
    const scrollTo = scrollable(list);
    const remove = within(list).getByRole('button', { name: 'Remove Ch 0' });
    act(() => remove.focus());
    // End, or the wheel, past the overscan: unmounted, the row would drop focus to <body>, where
    // the dialog's own key handling no longer hears Escape or Tab.
    await scrollTo(46 * 1990);
    await waitFor(() => expect(grip(list, 1999)).not.toBeNull());
    expect(grip(list, 1)).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('edit-list-dialog')).toBeNull());
  });

  it('lets the row go once focus has left the list', async () => {
    const { dialog, list } = await openEdit();
    const scrollTo = scrollable(list);
    act(() => within(list).getByRole('button', { name: 'Remove Ch 0' }).focus());
    act(() => within(dialog).getByRole('button', { name: 'Done' }).focus());
    await scrollTo(46 * 1990);
    await waitFor(() => expect(grip(list, 1999)).not.toBeNull());
    expect(grip(list, 0)).toBeNull();
  });
});
