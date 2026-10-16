/**
 * `ListsDialogHost`: renders the lists dialog that is open (see `store.ts`).
 * Mounted once by the shell. Import it from `@/features/lists/host` rather
 * than the barrel: this module and the store are all the shell's entry chunk
 * pays for; each dialog is its own chunk, fetched on first open.
 */

import { lazy, Suspense } from 'react';

import { closeListsDialog, useListsDialogs } from './store';

const PickerDialog = lazy(async () => ({ default: (await import('./dialogs/PickerDialog')).PickerDialog }));
const CreateListDialog = lazy(async () => ({ default: (await import('./dialogs/CreateListDialog')).CreateListDialog }));
const ManageListsDialog = lazy(async () => ({ default: (await import('./dialogs/ManageListsDialog')).ManageListsDialog }));
const EditItemsDialog = lazy(async () => ({ default: (await import('./dialogs/EditItemsDialog')).EditItemsDialog }));

export function ListsDialogHost() {
  const dialog = useListsDialogs((s) => s.dialog);
  const seq = useListsDialogs((s) => s.seq);
  if (!dialog) return <></>;
  let body;
  switch (dialog.kind) {
    case 'picker':
      body = <PickerDialog key={seq} channel={dialog.channel} onClose={closeListsDialog} />;
      break;
    case 'create':
      body = <CreateListDialog key={seq} channel={dialog.channel} openAfter={dialog.openAfter} onClose={closeListsDialog} />;
      break;
    case 'manage':
      body = <ManageListsDialog key={seq} focusId={dialog.focusId} onClose={closeListsDialog} />;
      break;
    case 'items':
      body = <EditItemsDialog key={seq} listId={dialog.listId} fromManage={dialog.fromManage} onClose={closeListsDialog} />;
      break;
  }
  return <Suspense fallback={null}>{body}</Suspense>;
}
