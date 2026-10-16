/**
 * Multi-view (contract C4): two to four live channels at once on one wall.
 *
 * - `useMultiviewStore`: the wall (tiles, layout, the tile with sound), persisted to
 *   localStorage `tsrust.multiview`.
 * - `useMultiviewMenuItem`: "Add to multi-view" for channel context menus.
 * - `multiviewRoutes`: `/multiview`, the page (lazy).
 * - `addToWall`: the same add from code (parental gate included); `wallAccepts` says whether
 *   a channel can go up at all (live TV only).
 *
 * Tiles play through the built-in web engines, each on its own, never through the main
 * player or mpv. See docs/architecture/multiview.md.
 */

export type { MultiviewAddResult, MultiviewChannelInput, MultiviewLayout, MultiviewState, MultiviewTile } from './types';
export { useMultiviewStore } from './store';
export { useMultiviewMenuItem } from './useMultiviewMenuItem';
export { multiviewRoutes } from './routes';
export { MULTIVIEW_PATH } from './paths';
export { addToWall, wallAccepts } from './addChannel';
export type { AddOutcome } from './addChannel';
export { MAX_TILES } from './layout';
