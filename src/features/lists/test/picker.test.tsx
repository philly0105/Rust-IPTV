// The "Add to list" picker (contract C3): check boxes from lists.containing,
// add/remove at once, inline New list that starts with the channel, and the
// core's limits (2000 channels a list, 50 lists, unique names).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
await Promise.all([import('../dialogs/PickerDialog')]);
const { openListPicker, useListsDialogs } = await import('../store');

const BBC = h.channel('1', 'BBC One', { categoryName: 'UK' });
const CNN = h.channel('2', 'CNN', { sourceId: 'src2' });
const SNAP = { ref: BBC.ref, snapshot: { title: 'BBC One', subtitle: 'UK', contentType: 'live' } };

async function openPicker() {
  render(
    <h.Providers>
      <ListsDialogHost />
    </h.Providers>,
  );
  act(() => openListPicker(BBC));
  const dialog = await screen.findByTestId('list-picker');
  await waitFor(() => expect(within(dialog).queryByRole('status', { busy: true })).toBeNull());
  return dialog;
}
// The check box is labelled by its whole row (name, then count or "Full").
const box = (dialog: HTMLElement, name: string) =>
  within(within(dialog).getByText(name, { selector: 'span' }).closest('label')!).getByRole('checkbox') as HTMLInputElement;

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
});
afterEach(cleanup);

describe('list picker', () => {
  it('shows the channel and checks the lists that already hold it', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC, CNN]), h.coreList('L2', 'Kids', [CNN]), h.coreList('L3', 'News', [BBC])]);
    const dialog = await openPicker();
    expect(within(dialog).getByRole('heading', { name: 'Add to list' })).toBeTruthy();
    expect(within(dialog).getByText('BBC One')).toBeTruthy();
    expect(within(dialog).getByText('UK')).toBeTruthy();
    expect(rpc.callsOf('lists.containing')).toEqual([{ ref: BBC.ref }]);
    expect([box(dialog, 'Sports').checked, box(dialog, 'Kids').checked, box(dialog, 'News').checked]).toEqual([true, false, true]);
    // Item counts beside each name.
    const options = within(dialog).getByTestId('list-picker-options');
    expect(within(options).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Sports2', 'Kids1', 'News1']);
  });

  it('checking adds the channel with its snapshot; unchecking removes it', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [BBC]), h.coreList('L2', 'Kids', [CNN])]);
    const dialog = await openPicker();

    fireEvent.click(box(dialog, 'Kids'));
    expect(box(dialog, 'Kids').checked).toBe(true);
    await waitFor(() => expect(rpc.callsOf('lists.addItems')).toEqual([{ id: 'L2', items: [SNAP] }]));
    await waitFor(() => expect(within(dialog).getByText('Added to Kids')).toBeTruthy());
    expect(core.lists[1]!.items.map((i) => i.ref.itemId)).toEqual(['2', '1']);

    fireEvent.click(box(dialog, 'Sports'));
    await waitFor(() => expect(rpc.callsOf('lists.removeItems')).toEqual([{ id: 'L1', refs: [BBC.ref] }]));
    await waitFor(() => expect(box(dialog, 'Sports').checked).toBe(false));
    expect(within(dialog).getByText('Removed from Sports')).toBeTruthy();
    expect(core.lists[0]!.items).toEqual([]);
  });

  it('puts the box back and says why when the core refuses', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [CNN])]);
    const dialog = await openPicker();
    core.fail['lists.addItems'] = 'db';
    fireEvent.click(box(dialog, 'Sports'));
    await waitFor(() => expect(h.lastToast()?.title).toBe("Couldn't add to Sports"));
    expect(box(dialog, 'Sports').checked).toBe(false);
  });

  it('a list at 2000 channels is shown full and cannot take one more', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => h.channel(`f${i}`, `Ch ${i}`));
    h.installCore(rpc, [h.coreList('L1', 'Huge', many), h.coreList('L2', 'Small', [CNN])]);
    const dialog = await openPicker();
    expect(box(dialog, 'Huge').disabled).toBe(true);
    expect(box(dialog, 'Huge').getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText('Full')).toBeTruthy();
    expect(box(dialog, 'Small').disabled).toBe(false);
  });

  it('New list starts with the channel and is checked at once', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
    const dialog = await openPicker();
    const input = within(dialog).getByLabelText('New list name');
    fireEvent.change(input, { target: { value: '  Evening news  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(rpc.callsOf('lists.create')).toEqual([{ name: 'Evening news', items: [SNAP] }]));
    await waitFor(() => expect(box(dialog, 'Evening news').checked).toBe(true));
    expect((input as HTMLInputElement).value).toBe('');
    expect(core.lists.map((l) => l.name)).toEqual(['Sports', 'Evening news']);
    expect(within(dialog).getByText('Added to Evening news')).toBeTruthy();
  });

  it('checks names before asking the core: empty, too long, already taken', async () => {
    h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
    const dialog = await openPicker();
    const input = within(dialog).getByLabelText('New list name');
    const create = within(dialog).getByRole('button', { name: 'Create' });

    fireEvent.click(create);
    expect(within(dialog).getByRole('alert').textContent).toBe('Enter a name.');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(input, { target: { value: 'x'.repeat(61) } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(create);
    expect(within(dialog).getByRole('alert').textContent).toBe('Use 60 characters or fewer.');

    fireEvent.change(input, { target: { value: 'sports' } });
    fireEvent.click(create);
    expect(within(dialog).getByRole('alert').textContent).toBe('A list with this name already exists.');
    expect(rpc.callsOf('lists.create')).toEqual([]);
  });

  it("shows the core's refusal when another window took the name first", async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
    const dialog = await openPicker();
    core.lists.push(h.coreList('L9', 'Movies', []));
    fireEvent.change(within(dialog).getByLabelText('New list name'), { target: { value: 'Movies' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('A list with this name already exists.'));
  });

  it('at 50 lists the form gives way to a note', async () => {
    h.installCore(
      rpc,
      Array.from({ length: 50 }, (_, i) => h.coreList(`L${i}`, `List ${i}`, [])),
    );
    const dialog = await openPicker();
    expect(within(dialog).queryByLabelText('New list name')).toBeNull();
    expect(within(dialog).getByRole('note').textContent).toBe('You can have up to 50 lists. Delete one first.');
  });

  it('with no lists yet, invites a name and closes with Done', async () => {
    h.installCore(rpc, []);
    const dialog = await openPicker();
    expect(within(dialog).getByText('No lists yet. Name one below.')).toBeTruthy();
    expect(within(dialog).getByLabelText('New list name').hasAttribute('data-autofocus')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('list-picker')).toBeNull());
    expect(useListsDialogs.getState().dialog).toBeNull();
  });

  it('a load failure shows an error with Try again', async () => {
    const core = h.installCore(rpc, [h.coreList('L1', 'Sports', [])]);
    core.fail['lists.list'] = 'db';
    render(
      <h.Providers>
        <ListsDialogHost />
      </h.Providers>,
    );
    act(() => openListPicker(BBC));
    const dialog = await screen.findByTestId('list-picker');
    await waitFor(() => expect(within(dialog).getByText("Couldn't load your lists")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(box(dialog, 'Sports')).toBeTruthy());
  });
});
