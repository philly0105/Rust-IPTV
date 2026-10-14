/**
 * My List (contract C3): a watchlist of movies and series.
 *
 * - `MyListButton`: the add/remove toggle for poster corners
 *   (`variant="icon"`) and detail pages (`variant="button"`, the default).
 * - `MyListRail`: the dashboard rail; renders nothing when switched off in
 *   Settings (`dashboardRails.myList`) or when the list is empty.
 * - `myListRoutes`: `/my-list`, the full page.
 * - `useInMyList`: which of some refs are saved, as `itemKey` strings.
 * - `useMyListMenuItem`: the same toggle as a context-menu action.
 *
 * Every piece reads one shared `watchlist.list` query, so a change anywhere
 * shows everywhere; `watchlist.changed` keeps other windows in step.
 */

export { MyListButton } from './components/MyListButton';
export type { MyListButtonProps } from './components/MyListButton';
export { MyListRail, MY_LIST_RAIL_LIMIT } from './components/MyListRail';
export type { MyListRailProps } from './components/MyListRail';
export { myListRoutes } from './routes';
export { useInMyList, useMyList } from './hooks/useMyList';
export { useMyListToggle } from './hooks/useMyListToggle';
export { useMyListMenuItem } from './hooks/useMyListMenuItem';
export { MY_LIST_PATH } from './paths';
export { canSave } from './lib/list';
