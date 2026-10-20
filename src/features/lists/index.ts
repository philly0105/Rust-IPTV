/**
 * Custom channel lists (Run 2 contract C3, UI).
 *
 * - `listsRoutes`: `/lists` (opens the first list, or offers "Create list")
 *   and `/lists/:listId` (the list in the Live layout, zapping within it).
 * - `ListsSidebarSection`: the Live sidebar's "Lists" group with counts,
 *   New list and Manage lists.
 * - `useAddToListMenuItem`: "Add to list…" for a channel's menu.
 * - `useAddToListShortcut`: `l` on a focused channel row opens the picker.
 * - `ListsDialogHost`: renders the picker, New list, Manage lists and Edit
 *   channels dialogs; mount it once inside the router.
 * - `CustomListRails`: one Home rail per list with Show on Home.
 *
 * Every module exported here is light: pages, dialogs and the rails' cards
 * load as their own chunks. The shell can still deep-import `./host`,
 * `./rails` and `./hooks/useAddToList` to keep its entry chunk minimal.
 */

export { listsRoutes } from './routes';
export { ListsSidebarSection } from './components/ListsSidebarSection';
export type { ListsSidebarSectionProps } from './components/ListsSidebarSection';
export { useAddToListMenuItem, useAddToListShortcut } from './hooks/useAddToList';
export { ListsDialogHost } from './host';
export { CustomListRails } from './rails';
export { openAddChannels, openAddGroupToList, openCreateList, openListPicker, openManageLists } from './store';
export type { GroupTarget } from './store';
export { LISTS_PATH, listPath } from './paths';
