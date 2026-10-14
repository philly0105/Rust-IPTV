/**
 * Multi-view types (contract C4). The wall holds 2 to 4 live channels; each tile plays
 * through the built-in web engines on its own, never through the main player or mpv.
 */

import type { ItemRef } from '@/api/types';

/** What a caller hands over to put a channel on the wall. */
export interface MultiviewChannelInput {
  ref: ItemRef;
  title: string;
  logo?: string;
  number?: number;
  categoryId?: string;
}

/** `1x2`: two side by side. `2x2`: a grid of four. `1+3`: one large and three small. */
export type MultiviewLayout = '1x2' | '2x2' | '1+3';

/** A channel on the wall. `key` is stable for the tile's life (replace keeps it). */
export interface MultiviewTile extends MultiviewChannelInput {
  key: string;
}

export type MultiviewAddResult = 'added' | 'duplicate' | 'full';

/** The persisted wall (C4 store shape). */
export interface MultiviewState {
  /** At most four, in slot order. */
  tiles: MultiviewTile[];
  layout: MultiviewLayout;
  /** The one tile with sound; null only when the wall is empty. */
  audioKey: string | null;
  add(ch: MultiviewChannelInput): MultiviewAddResult;
  remove(key: string): void;
  replace(key: string, ch: MultiviewChannelInput): void;
  swap(a: string, b: string): void;
  setAudio(key: string): void;
  setLayout(l: MultiviewLayout): void;
  clear(): void;
}
