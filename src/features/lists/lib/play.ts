import type { Channel } from '@/api/types';

import { playChannel, sourceKindOf, usePlayerStore } from '../deps';

/** Plays `channel` (C3: through Live's `playChannel`), then makes zapping walk `listId`. */
export async function playFromList(channel: Channel, listId: string, nowTitle: string | undefined, name: string): Promise<void> {
  const kind = await sourceKindOf(channel.ref.sourceId);
  await playChannel(channel, kind, nowTitle, name);
  usePlayerStore.setState({ zapContext: { sourceId: channel.ref.sourceId, listId } });
}
