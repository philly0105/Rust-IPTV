// "Manage lists" and "Edit channels" (contract C3): inline rename, reorder
// with Alt+Arrow keys (focus stays on the moved row), Show on Home, delete
// with Undo that brings the list back with its channels, Home rail and place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { ListsDialogHost } = await import('../host');
// Load the lazy dialogs up front so a busy run doesn't outlast findBy's timeout.
await Promise.all([import('../dialogs/ManageListsDialog'), import('../dialogs/EditItemsDialog')]);
const { openEditListItems, openManageLists } = await import('../store');

const BBC = h.channel('1', 'BBC One');
const CNN = h.channel('2', 'CNN', { sourceId: 'src2' });
const ARTE = h.channel('3', 'Arte');
const GONE = h.channel('9', 'Old Sports');

function seed() {
  return h.installCore(rpc, [
    h.coreList('L1', 'Sports', [BBC, CNN]),
    h.coreList('L2', 'Kids', [ARTE, CNN], { onDashboard: true }),
    h.coreList('L3', 'News', [BBC]),
  ]);
}

async function openManage(focusId?: string) {
  render(
    <h.Providers>
      <ListsDialogHost />
    </h.Providers>,
  );
  act(() => openManageLists(focusId));
  const dialog = await screen.findByTestId('manage-lists-dialog');
  await within(dialog).findByTestId('manage-lists');
  return dialog;
}
const rowNames = (dialog: HTMLElement) =>
  within(within(dialog).getByTestId('manage-lists'))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-sort-part="name"] span')?.textContent ?? (li.querySelector('input') as HTMLInputElement | null)?.value);
const row = (dialog: HTMLElement, key: string) => within(dialog).getByTestId('manage-lists').querySelector<HTMLElement>(`[data-sort-key="${key}"]`)!;
const refIds = (refs: ItemRef[]) => refs.map((r) => r.itemId);

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
});
afterEach(cleanup);

describe('manage lists', () => {
  it('lists every list in order with its channel count and the 50-list budget', async () => {
    seed();
    const dialog = await openManage();
    expect(within(dialog).getByRole('heading', { name: 'Manage lists' })).toBeTruthy();
    expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']);
    expect(within(row(dialog, 'L1')).getByText('2 channels')).toBeTruthy();
    expect(within(row(dialog, 'L3')).getByText('1 channel')).toBeTruthy();
    expect(within(dialog).getByText('3 of 50 lists')).toBeTruthy();
    expect(within(row(dialog, 'L2')).getByRole('button', { name: 'Show Kids on Home' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(row(dialog, 'L1')).getByRole('button', { name: 'Show Sports on Home' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('starts on the list it was opened for', async () => {
    seed();
    const dialog = await openManage('L3');
    await waitFor(() => expect(document.activeElement).toBe(row(dialog, 'L3').querySelector('[data-sort-part="name"]')));
  });

  describe('rename', () => {
    it('saves the new name, says so, and returns focus to Rename', async () => {
      const core = seed();
      const dialog = await openManage();
      fireEvent.click(within(row(dialog, 'L1')).getByRole('button', { name: 'Rename Sports' }));
      const input = within(row(dialog, 'L1')).getByRole('textbox', { name: 'Rename Sports' }) as HTMLInputElement;
      expect(input.value).toBe('Sports');
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: '  Football ' } });
      fireEvent.click(within(row(dialog, 'L1')).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(rpc.callsOf('lists.update')).toEqual([{ id: 'L1', name: 'Football' }]));
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Football', 'Kids', 'News']));
      expect(core.lists[0]!.name).toBe('Football');
      expect(h.lastToast()?.title).toBe('Renamed to Football');
      await waitFor(() => expect(document.activeElement).toBe(within(row(dialog, 'L1')).getByRole('button', { name: 'Rename Football' })));
    });

    it('refuses an empty or taken name without asking the core', async () => {
      seed();
      const dialog = await openManage();
      fireEvent.click(within(row(dialog, 'L1')).getByRole('button', { name: 'Rename Sports' }));
      const input = within(row(dialog, 'L1')).getByRole('textbox', { name: 'Rename Sports' });
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.submit(input.closest('form')!);
      expect(within(row(dialog, 'L1')).getByRole('alert').textContent).toBe('Enter a name.');
      fireEvent.change(input, { target: { value: 'KIDS' } });
      expect(within(row(dialog, 'L1')).queryByRole('alert')).toBeNull();
      fireEvent.submit(input.closest('form')!);
      expect(within(row(dialog, 'L1')).getByRole('alert').textContent).toBe('A list with this name already exists.');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(rpc.callsOf('lists.update')).toEqual([]);
    });

    it('Escape cancels the rename only, not the dialog', async () => {
      seed();
      const dialog = await openManage();
      fireEvent.click(within(row(dialog, 'L2')).getByRole('button', { name: 'Rename Kids' }));
      const input = within(row(dialog, 'L2')).getByRole('textbox', { name: 'Rename Kids' });
      fireEvent.change(input, { target: { value: 'Children' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.getByTestId('manage-lists-dialog')).toBe(dialog);
      expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']);
      expect(document.activeElement).toBe(within(row(dialog, 'L2')).getByRole('button', { name: 'Rename Kids' }));
      expect(rpc.callsOf('lists.update')).toEqual([]);
    });

    it('puts the old name back when the core refuses', async () => {
      const core = seed();
      const dialog = await openManage();
      core.fail['lists.update'] = 'db';
      fireEvent.click(within(row(dialog, 'L3')).getByRole('button', { name: 'Rename News' }));
      const input = within(row(dialog, 'L3')).getByRole('textbox', { name: 'Rename News' });
      fireEvent.change(input, { target: { value: 'Headlines' } });
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't rename News"));
      // Still editing, so the user can try again.
      expect((within(row(dialog, 'L3')).getByRole('textbox') as HTMLInputElement).value).toBe('Headlines');
      expect(core.lists[2]!.name).toBe('News');
    });
  });

  describe('reorder by keyboard', () => {
    it('Alt+ArrowDown on the grip moves the list, saves the order and keeps focus on it', async () => {
      const core = seed();
      const dialog = await openManage();
      const grip = within(row(dialog, 'L1')).getByRole('button', { name: 'Move Sports' });
      grip.focus();
      fireEvent.keyDown(grip, { key: 'ArrowDown', altKey: true });

      await waitFor(() => expect(rowNames(dialog)).toEqual(['Kids', 'Sports', 'News']));
      await waitFor(() => expect(rpc.callsOf('lists.reorder')).toEqual([{ ids: ['L2', 'L1', 'L3'] }]));
      expect(document.activeElement).toBe(within(row(dialog, 'L1')).getByRole('button', { name: 'Move Sports' }));
      expect(within(dialog).getByText('Sports moved to position 2 of 3')).toBeTruthy();
      await waitFor(() => expect(core.lists.map((l) => l.id)).toEqual(['L2', 'L1', 'L3']));
    });

    it('a burst of moves reaches the core in order; Alt+ArrowUp works from any control in the row', async () => {
      const core = seed();
      const dialog = await openManage();
      const del = within(row(dialog, 'L1')).getByRole('button', { name: 'Delete Sports' });
      del.focus();
      fireEvent.keyDown(del, { key: 'ArrowDown', altKey: true });
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Kids', 'Sports', 'News']));
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', altKey: true });
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Kids', 'News', 'Sports']));
      expect(document.activeElement).toBe(within(row(dialog, 'L1')).getByRole('button', { name: 'Delete Sports' }));
      // At the bottom already: nothing to do.
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', altKey: true });
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', altKey: true });
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Kids', 'Sports', 'News']));
      await waitFor(() =>
        expect(rpc.callsOf('lists.reorder')).toEqual([{ ids: ['L2', 'L1', 'L3'] }, { ids: ['L2', 'L3', 'L1'] }, { ids: ['L2', 'L1', 'L3'] }]),
      );
      await waitFor(() => expect(core.lists.map((l) => l.id)).toEqual(['L2', 'L1', 'L3']));
    });

    it('plain arrows move focus between rows without reordering', async () => {
      seed();
      const dialog = await openManage();
      const grip = within(row(dialog, 'L1')).getByRole('button', { name: 'Move Sports' });
      grip.focus();
      fireEvent.keyDown(grip, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(within(row(dialog, 'L2')).getByRole('button', { name: 'Move Kids' }));
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(grip);
      expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']);
      expect(rpc.callsOf('lists.reorder')).toEqual([]);
    });

    it('rolls the order back when the core refuses', async () => {
      const core = seed();
      const dialog = await openManage();
      core.fail['lists.reorder'] = 'db';
      const grip = within(row(dialog, 'L3')).getByRole('button', { name: 'Move News' });
      fireEvent.keyDown(grip, { key: 'ArrowUp', altKey: true });
      await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't save the new order"));
      expect(rpc.callsOf('lists.reorder')).toEqual([{ ids: ['L1', 'L3', 'L2'] }]);
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']));
    });
  });

  describe('delete with Undo', () => {
    it('deletes at once; Undo brings the list back with its channels, Home rail and place', async () => {
      const core = seed();
      const dialog = await openManage();
      fireEvent.click(within(row(dialog, 'L2')).getByRole('button', { name: 'Delete Kids' }));

      await waitFor(() => expect(rpc.callsOf('lists.remove')).toEqual([{ id: 'L2' }]));
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports', 'News']));
      expect(core.lists.map((l) => l.id)).toEqual(['L1', 'L3']);
      // Focus moves to the next row's Delete, not out of the dialog.
      await waitFor(() => expect(document.activeElement).toBe(within(row(dialog, 'L3')).getByRole('button', { name: 'Delete News' })));
      const toast = h.lastToast()!;
      expect(toast.title).toBe('Deleted Kids');
      expect(toast.action?.label).toBe('Undo');

      act(() => toast.action!.onClick());
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']));
      const created = rpc.callsOf('lists.create') as { name: string; items: { ref: ItemRef }[] }[];
      expect(created.map((c) => c.name)).toEqual(['Kids']);
      expect(refIds(created[0]!.items.map((i) => i.ref))).toEqual(['3', '2']);
      expect(rpc.callsOf('lists.update')).toEqual([{ id: 'new1', onDashboard: true }]);
      expect(rpc.callsOf('lists.reorder')).toEqual([{ ids: ['L1', 'new1', 'L3'] }]);
      expect(core.lists.map((l) => [l.name, l.onDashboard, l.items.map((i) => i.ref.itemId)])).toEqual([
        ['Sports', false, ['1', '2']],
        ['Kids', true, ['3', '2']],
        ['News', false, ['1']],
      ]);
    });

    it('Undo of the last list needs no reorder', async () => {
      const core = seed();
      const dialog = await openManage();
      fireEvent.click(within(row(dialog, 'L3')).getByRole('button', { name: 'Delete News' }));
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports', 'Kids']));
      act(() => h.lastToast()!.action!.onClick());
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']));
      expect(rpc.callsOf('lists.update')).toEqual([]);
      expect(rpc.callsOf('lists.reorder')).toEqual([]);
      expect(core.lists.map((l) => l.name)).toEqual(['Sports', 'Kids', 'News']);
    });

    it('keeps the list and says so when the core refuses', async () => {
      const core = seed();
      const dialog = await openManage();
      core.fail['lists.remove'] = 'db';
      fireEvent.click(within(row(dialog, 'L1')).getByRole('button', { name: 'Delete Sports' }));
      await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't delete Sports"));
      await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports', 'Kids', 'News']));
    });

    it('reports an Undo the core refuses (name taken meanwhile)', async () => {
      const core = seed();
      const dialog = await openManage();
      fireEvent.click(within(row(dialog, 'L1')).getByRole('button', { name: 'Delete Sports' }));
      await waitFor(() => expect(h.lastToast()?.title).toBe('Deleted Sports'));
      core.lists.push(h.coreList('L7', 'Sports', []));
      act(() => h.lastToast()!.action!.onClick());
      await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't restore Sports"));
      expect(h.lastToast()?.description).toBe('A list with this name already exists.');
      void dialog;
    });
  });

  it('Show on Home toggles the rail', async () => {
    const core = seed();
    const dialog = await openManage();
    fireEvent.click(within(row(dialog, 'L1')).getByRole('button', { name: 'Show Sports on Home' }));
    await waitFor(() => expect(rpc.callsOf('lists.update')).toEqual([{ id: 'L1', onDashboard: true }]));
    expect(within(row(dialog, 'L1')).getByRole('button', { name: 'Show Sports on Home' }).getAttribute('aria-pressed')).toBe('true');
    expect(core.lists[0]!.onDashboard).toBe(true);
  });

  it('with no lists, shows the empty state and the New list field', async () => {
    h.installCore(rpc, []);
    render(
      <h.Providers>
        <ListsDialogHost />
      </h.Providers>,
    );
    act(() => openManageLists());
    const dialog = await screen.findByTestId('manage-lists-dialog');
    await waitFor(() => expect(within(dialog).getByText('No lists yet')).toBeTruthy());
    expect(within(dialog).getByLabelText('New list name').hasAttribute('data-autofocus')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('New list name'), { target: { value: 'Sports' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(rpc.callsOf('lists.create')).toEqual([{ name: 'Sports' }]));
    await waitFor(() => expect(rowNames(dialog)).toEqual(['Sports']));
  });
});

describe('edit channels', () => {
  async function openEdit(listId: string, fromManage = false) {
    render(
      <h.Providers>
        <ListsDialogHost />
      </h.Providers>,
    );
    act(() => openEditListItems(listId, { fromManage }));
    const dialog = await screen.findByTestId('edit-list-dialog');
    await within(dialog).findByTestId('edit-list-items');
    return dialog;
  }
  const entryNames = (dialog: HTMLElement) =>
    within(within(dialog).getByTestId('edit-list-items'))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.font-medium')?.textContent);

  it('shows every channel in order, dropped ones greyed with a note', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN], { dropped: [GONE] })]);
    const dialog = await openEdit('L1');
    expect(within(dialog).getByRole('heading', { name: 'Edit Sports' })).toBeTruthy();
    expect(entryNames(dialog)).toEqual(['BBC One', 'CNN', 'Old Sports']);
    expect(within(dialog).getByText('Backup list')).toBeTruthy();
    expect(within(dialog).getByText('No longer offered')).toBeTruthy();
  });

  it('Alt+ArrowUp reorders channels and saves the full order', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE])]);
    const dialog = await openEdit('L1');
    const grip = within(dialog).getByRole('button', { name: 'Move Arte' });
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(entryNames(dialog)).toEqual(['BBC One', 'Arte', 'CNN']));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Move Arte' }));
    await waitFor(() => expect((rpc.callsOf('lists.reorderItems') as { id: string; refs: ItemRef[] }[]).map((c) => [c.id, refIds(c.refs)])).toEqual([['L1', ['1', '3', '2']]]));
    await waitFor(() => expect(core.lists[0]!.items.map((i) => i.ref.itemId)).toEqual(['1', '3', '2']));
  });

  it('Remove takes a channel out; Undo puts it back in its place', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN, ARTE])]);
    const dialog = await openEdit('L1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove CNN' }));
    await waitFor(() => expect(entryNames(dialog)).toEqual(['BBC One', 'Arte']));
    await waitFor(() => expect(rpc.callsOf('lists.removeItems')).toEqual([{ id: 'L1', refs: [CNN.ref] }]));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Remove Arte' })));
    await waitFor(() => expect(h.lastToast()?.title).toBe('Removed CNN from Sports'));

    act(() => h.lastToast()!.action!.onClick());
    await waitFor(() => expect(core.lists[0]!.items.map((i) => i.ref.itemId)).toEqual(['1', '2', '3']));
    await waitFor(() => expect(entryNames(dialog)).toEqual(['BBC One', 'CNN', 'Arte']));
  });

  it('opened from Manage, it offers a way back', async () => {
    seed();
    const dialog = await openEdit('L2', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'All lists' }));
    const manage = await screen.findByTestId('manage-lists-dialog');
    await waitFor(() => expect(document.activeElement).toBe(row(manage, 'L2').querySelector('[data-sort-part="name"]')));
  });
});
