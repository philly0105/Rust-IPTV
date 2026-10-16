/**
 * Adapter to the player's stream lookup (read only, `src/features/player/store.ts`): a tile's
 * channel becomes a playable source exactly the way the main player resolves it (Xtream and
 * Stalker URLs from the core, M3U URLs with the playlist's and the channel's headers), but
 * nothing touches the main player's state.
 */

import type { PlayerSource } from '@/api/types';
import { resolveSource, sourceKindOf } from '@/features/player/store';

import type { MultiviewChannelInput } from './types';

export async function resolveTileSource(ch: MultiviewChannelInput): Promise<PlayerSource> {
  const sourceKind = await sourceKindOf(ch.ref.sourceId);
  return resolveSource({ ref: ch.ref, title: ch.title, isLive: true, sourceKind });
}
