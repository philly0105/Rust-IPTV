/** Where the multi-view page lives (a child of the shell layout route `/`). */
export const MULTIVIEW_PATH = '/multiview';

/** Route state for `/multiview`: the key of a tile to focus on arrival (a tile just added from a menu). */
export interface MultiviewLocationState {
  focusTile?: string;
}

/** The tile key to focus from a location's state, if it carries one. */
export function focusTileOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const key = (state as MultiviewLocationState).focusTile;
  return typeof key === 'string' && key ? key : undefined;
}
